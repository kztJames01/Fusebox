//! Deterministic analysis hot path (walk, hash, structural diff, impact ranking).
//! This is the legacy analysis path. It is not the execution enforcement core.
//!
//! The binary speaks JSON on stdin/stdout. It performs no network access and
//! never shells out. Operations are intentionally narrow:
//! - `walk`: concurrent directory walk + optional SHA-256 hashes
//! - `structural_diff`: added/removed exports and signature changes
//! - `rank`: deterministic impact ranking
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

const DEFAULT_MAX_DEPTH: usize = 20;
const DEFAULT_MAX_FILE_SIZE_BYTES: u64 = 2 * 1024 * 1024;

fn default_max_depth() -> usize {
    DEFAULT_MAX_DEPTH
}

fn default_max_file_size() -> u64 {
    DEFAULT_MAX_FILE_SIZE_BYTES
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Walk(WalkRequest),
    StructuralDiff(StructuralDiffRequest),
    Rank(RankRequest),
    Version,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkRequest {
    pub root: String,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    #[serde(default = "default_max_file_size")]
    pub max_file_size_bytes: u64,
    #[serde(default)]
    pub hash: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct WalkFile {
    pub path: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

#[derive(Serialize)]
pub struct WalkOutput {
    pub root: String,
    pub files: Vec<WalkFile>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StructuralDiffRequest {
    #[serde(default)]
    pub previous: Option<PreviousState>,
    #[serde(default)]
    pub current: Vec<CurrentFile>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviousState {
    #[serde(default)]
    pub files: BTreeMap<String, PreviousFile>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviousFile {
    #[serde(default)]
    pub exports: BTreeMap<String, PreviousExport>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviousExport {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub line: Option<usize>,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrentFile {
    pub file: String,
    #[serde(default)]
    pub exports: Vec<CurrentExport>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrentExport {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub line: Option<usize>,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralChange {
    pub path: String,
    pub change_type: String,
    pub exports_added: Vec<String>,
    pub exports_removed: Vec<String>,
    pub signatures_changed: Vec<String>,
    pub kinds_changed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakingChange {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralDiffOutput {
    pub changes: Vec<StructuralChange>,
    pub breaking_changes: Vec<BreakingChange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRequest {
    pub entries: Vec<RankEntry>,
    #[serde(default)]
    pub weights: Option<Weights>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RankEntry {
    #[serde(rename = "ref")]
    pub reference: String,
    pub category: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub change_type: Option<String>,
    #[serde(default)]
    pub entries_in_file: usize,
    #[serde(default)]
    pub max_entries_in_file: usize,
    #[serde(default)]
    pub dependent_count: usize,
    #[serde(default)]
    pub max_dependent_count: usize,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Weights {
    #[serde(default = "default_change_size")]
    pub change_size: f64,
    #[serde(default = "default_export_change")]
    pub export_change: f64,
    #[serde(default = "default_category_weight")]
    pub category: f64,
    #[serde(default = "default_recency")]
    pub recency: f64,
    #[serde(default = "default_dependents")]
    pub dependents: f64,
}

fn default_change_size() -> f64 {
    0.2
}
fn default_export_change() -> f64 {
    0.3
}
fn default_category_weight() -> f64 {
    0.25
}
fn default_recency() -> f64 {
    0.15
}
fn default_dependents() -> f64 {
    0.1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedEntry {
    #[serde(rename = "ref")]
    pub reference: String,
    pub score: f64,
    pub category: String,
}

#[derive(Serialize)]
pub struct RankOutput {
    pub ranked: Vec<RankedEntry>,
}

#[derive(Clone)]
struct IgnorePattern {
    negated: bool,
    directory_only: bool,
    anchored: bool,
    pattern: String,
}

struct IgnoreMatcher {
    patterns: Vec<IgnorePattern>,
}

impl IgnoreMatcher {
    fn new(root: &Path, custom: &[String]) -> Self {
        let mut patterns = Vec::new();
        if let Ok(text) = fs::read_to_string(root.join(".gitignore")) {
            for line in text.lines() {
                if let Some(pattern) = parse_pattern(line) {
                    patterns.push(pattern);
                }
            }
        }
        for line in custom {
            if let Some(pattern) = parse_pattern(line) {
                patterns.push(pattern);
            }
        }
        Self { patterns }
    }

    fn is_ignored(&self, relative_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for pattern in &self.patterns {
            if pattern_matches(pattern, relative_path, is_dir) {
                ignored = !pattern.negated;
            }
        }
        ignored
    }
}

fn parse_pattern(raw: &str) -> Option<IgnorePattern> {
    let mut pattern = raw.trim();
    if pattern.is_empty() || pattern.starts_with('#') {
        return None;
    }
    if pattern.ends_with('\\') {
        return None;
    }

    let mut negated = false;
    if let Some(stripped) = pattern.strip_prefix('!') {
        negated = true;
        pattern = stripped;
    }
    if pattern.is_empty() {
        return None;
    }

    let mut anchored = false;
    if let Some(stripped) = pattern.strip_prefix('/') {
        anchored = true;
        pattern = stripped;
    }

    let mut directory_only = false;
    if pattern.ends_with('/') {
        directory_only = true;
        pattern = pattern.trim_end_matches('/');
    }

    let pattern = pattern.trim_start_matches("./").replace('\\', "/");
    if pattern.is_empty() {
        return None;
    }

    Some(IgnorePattern {
        negated,
        directory_only,
        anchored,
        pattern,
    })
}

fn pattern_matches(pattern: &IgnorePattern, relative_path: &str, is_dir: bool) -> bool {
    if pattern.directory_only && !is_dir {
        return false;
    }

    if pattern.pattern.contains('/') {
        if glob_match(&pattern.pattern, relative_path) {
            return true;
        }
        if !pattern.anchored {
            for (index, character) in relative_path.char_indices() {
                if character == '/' && glob_match(&pattern.pattern, &relative_path[index + 1..]) {
                    return true;
                }
            }
        }
        return false;
    }

    relative_path
        .split('/')
        .any(|segment| glob_match(&pattern.pattern, segment))
}

fn glob_match(pattern: &str, text: &str) -> bool {
    glob_match_bytes(pattern.as_bytes(), text.as_bytes())
}

fn glob_match_bytes(pattern: &[u8], text: &[u8]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }

    match pattern[0] {
        b'*' => {
            if pattern.get(1) == Some(&b'*') {
                let rest = &pattern[2..];
                if rest.first() == Some(&b'/') {
                    if glob_match_bytes(&rest[1..], text) {
                        return true;
                    }
                    for index in 0..=text.len() {
                        if (index == 0 || text[index - 1] == b'/')
                            && glob_match_bytes(&rest[1..], &text[index..])
                        {
                            return true;
                        }
                    }
                    false
                } else {
                    for index in 0..=text.len() {
                        if glob_match_bytes(rest, &text[index..]) {
                            return true;
                        }
                    }
                    false
                }
            } else {
                for index in 0..=text.len() {
                    if index > 0 && text[index - 1] == b'/' {
                        break;
                    }
                    if glob_match_bytes(&pattern[1..], &text[index..]) {
                        return true;
                    }
                }
                false
            }
        }
        b'?' => !text.is_empty() && text[0] != b'/' && glob_match_bytes(&pattern[1..], &text[1..]),
        character => {
            !text.is_empty() && text[0] == character && glob_match_bytes(&pattern[1..], &text[1..])
        }
    }
}

fn is_sensitive(relative_path: &str) -> bool {
    let base = relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_lowercase();
    base.starts_with(".env")
        || base.ends_with(".key")
        || base.ends_with(".pem")
        || base == "credentials"
        || base.starts_with("credentials.")
        || base == "secrets"
        || base.starts_with("secrets.")
}

fn is_default_excluded(relative_path: &str) -> bool {
    if is_sensitive(relative_path) {
        return true;
    }

    for segment in relative_path.split('/') {
        if segment.starts_with('.') && segment != "." && segment != ".." {
            return true;
        }
        if matches!(
            segment,
            ".git" | "node_modules" | "dist" | "build" | ".fusebox"
        ) {
            return true;
        }
    }
    false
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn warning(code: &str, message: &str, relative: Option<&str>) -> String {
    match relative {
        Some(path) => format!("{code}: {message} ({path})"),
        None => format!("{code}: {message}"),
    }
}

pub fn walk(request: WalkRequest) -> Result<WalkOutput, String> {
    let root_input = PathBuf::from(&request.root);
    let metadata = fs::symlink_metadata(&root_input)
        .map_err(|error| format!("INVALID_ROOT: {} ({error})", root_input.display()))?;
    if metadata.file_type().is_symlink() {
        return Err("SECURITY: root path must not be a symlink".to_string());
    }
    let root = root_input
        .canonicalize()
        .map_err(|error| format!("INVALID_ROOT: {} ({error})", root_input.display()))?;
    if !root.is_dir() {
        return Err("INVALID_ROOT: root path must be a directory".to_string());
    }

    let matcher = IgnoreMatcher::new(&root, &request.excludes);
    let mut warnings: BTreeSet<String> = BTreeSet::new();
    let mut candidates: Vec<WalkFile> = Vec::new();

    let walker = WalkDir::new(&root)
        .max_depth(request.max_depth.saturating_add(1))
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let relative = relative_path(&root, entry.path());
            if is_default_excluded(&relative) {
                return false;
            }
            !matcher.is_ignored(&relative, entry.file_type().is_dir())
        });

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.insert(warning(
                    "FS_ERROR",
                    &format!("Failed to read directory entry: {error}"),
                    None,
                ));
                continue;
            }
        };

        if entry.depth() == 0 {
            continue;
        }

        let relative = relative_path(&root, entry.path());
        if relative.is_empty() {
            continue;
        }

        if entry.file_type().is_symlink() {
            match entry.path().canonicalize() {
                Ok(target) => {
                    if !target.starts_with(&root) {
                        warnings.insert(warning(
                            "SYMLINK_ESCAPE",
                            "Symlink escapes secure root and was skipped",
                            Some(&relative),
                        ));
                        continue;
                    }
                    match fs::metadata(&target) {
                        Ok(target_metadata) if target_metadata.is_file() => {
                            if target_metadata.len() > request.max_file_size_bytes {
                                warnings.insert(warning(
                                    "SKIPPED_LARGE_FILE",
                                    &format!(
                                        "Skipped file larger than {} bytes",
                                        request.max_file_size_bytes
                                    ),
                                    Some(&relative),
                                ));
                                continue;
                            }
                            candidates.push(WalkFile {
                                path: relative,
                                size: target_metadata.len(),
                                hash: None,
                            });
                        }
                        Ok(_) => {
                            warnings.insert(warning(
                                "SYMLINK_SKIPPED",
                                "Symlink directory was skipped",
                                Some(&relative),
                            ));
                        }
                        Err(error) => {
                            warnings.insert(warning(
                                "PERMISSION_DENIED",
                                &format!("Failed to stat symlink target: {error}"),
                                Some(&relative),
                            ));
                        }
                    }
                }
                Err(error) => {
                    warnings.insert(warning(
                        "FS_ERROR",
                        &format!("Failed to resolve symlink: {error}"),
                        Some(&relative),
                    ));
                }
            }
            continue;
        }

        if entry.file_type().is_dir() {
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        if size > request.max_file_size_bytes {
            warnings.insert(warning(
                "SKIPPED_LARGE_FILE",
                &format!(
                    "Skipped file larger than {} bytes",
                    request.max_file_size_bytes
                ),
                Some(&relative),
            ));
            continue;
        }

        candidates.push(WalkFile {
            path: relative,
            size,
            hash: None,
        });
    }

    candidates.sort_by(|left, right| left.path.cmp(&right.path));

    if request.hash {
        let hashes: Vec<Result<String, String>> = candidates
            .par_iter()
            .map(|file| {
                let absolute = root.join(&file.path);
                let bytes =
                    fs::read(&absolute).map_err(|error| format!("{}: {error}", file.path))?;
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                Ok(format!("{:x}", hasher.finalize()))
            })
            .collect();

        for (file, hash) in candidates.iter_mut().zip(hashes) {
            match hash {
                Ok(value) => file.hash = Some(value),
                Err(error) => {
                    warnings.insert(warning(
                        "PERMISSION_DENIED",
                        &format!("Failed to hash file: {error}"),
                        Some(&file.path),
                    ));
                }
            }
        }
    }

    Ok(WalkOutput {
        root: root.to_string_lossy().replace('\\', "/"),
        files: candidates,
        warnings: warnings.into_iter().collect(),
    })
}

pub fn structural_diff(request: StructuralDiffRequest) -> StructuralDiffOutput {
    let previous = request.previous.unwrap_or_default();
    let mut current: BTreeMap<String, BTreeMap<String, CurrentExport>> = BTreeMap::new();
    for file in request.current {
        let mut exports = BTreeMap::new();
        for export in file.exports {
            exports.insert(export.name.clone(), export);
        }
        current.insert(file.file, exports);
    }

    let mut changes = Vec::new();
    let mut breaking = Vec::new();
    let mut seen_paths = BTreeSet::new();

    for (path, previous_file) in &previous.files {
        seen_paths.insert(path.clone());
        let current_exports = current.get(path);

        let Some(current_exports) = current_exports else {
            changes.push(StructuralChange {
                path: path.clone(),
                change_type: "REMOVED".to_string(),
                exports_added: Vec::new(),
                exports_removed: previous_file.exports.keys().cloned().collect(),
                signatures_changed: Vec::new(),
                kinds_changed: Vec::new(),
            });
            breaking.push(BreakingChange {
                path: path.clone(),
                kind: "FILE_REMOVED".to_string(),
                export_name: None,
                previous: Some(format!("{} export(s)", previous_file.exports.len())),
                current: None,
                line: Some(1),
            });
            continue;
        };

        let mut added = Vec::new();
        let mut removed = Vec::new();
        let mut signatures_changed = Vec::new();
        let mut kinds_changed = Vec::new();

        for name in current_exports.keys() {
            if !previous_file.exports.contains_key(name) {
                added.push(name.clone());
            }
        }

        for (name, previous_export) in &previous_file.exports {
            let Some(current_export) = current_exports.get(name) else {
                removed.push(name.clone());
                breaking.push(BreakingChange {
                    path: path.clone(),
                    kind: "EXPORT_REMOVED".to_string(),
                    export_name: Some(name.clone()),
                    previous: Some(
                        previous_export
                            .signature
                            .clone()
                            .unwrap_or_else(|| previous_export.kind.clone()),
                    ),
                    current: None,
                    line: previous_export.line.or(Some(1)),
                });
                continue;
            };

            if let (Some(previous_signature), Some(current_signature)) =
                (&previous_export.signature, &current_export.signature)
            {
                if previous_signature != current_signature {
                    signatures_changed.push(name.clone());
                    breaking.push(BreakingChange {
                        path: path.clone(),
                        kind: "SIGNATURE_CHANGED".to_string(),
                        export_name: Some(name.clone()),
                        previous: Some(previous_signature.clone()),
                        current: Some(current_signature.clone()),
                        line: current_export.line.or(Some(1)),
                    });
                    continue;
                }
            }

            if previous_export.kind != current_export.kind {
                kinds_changed.push(name.clone());
                breaking.push(BreakingChange {
                    path: path.clone(),
                    kind: "EXPORT_KIND_CHANGED".to_string(),
                    export_name: Some(name.clone()),
                    previous: Some(previous_export.kind.clone()),
                    current: Some(current_export.kind.clone()),
                    line: current_export.line.or(Some(1)),
                });
            }
        }

        if !added.is_empty()
            || !removed.is_empty()
            || !signatures_changed.is_empty()
            || !kinds_changed.is_empty()
        {
            changes.push(StructuralChange {
                path: path.clone(),
                change_type: "MODIFIED".to_string(),
                exports_added: added,
                exports_removed: removed,
                signatures_changed,
                kinds_changed,
            });
        }
    }

    for (path, exports) in &current {
        if seen_paths.contains(path) {
            continue;
        }
        changes.push(StructuralChange {
            path: path.clone(),
            change_type: "ADDED".to_string(),
            exports_added: exports.keys().cloned().collect(),
            exports_removed: Vec::new(),
            signatures_changed: Vec::new(),
            kinds_changed: Vec::new(),
        });
    }

    changes.sort_by(|left, right| left.path.cmp(&right.path));
    breaking.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    StructuralDiffOutput {
        changes,
        breaking_changes: breaking,
    }
}

fn category_priority(category: &str) -> f64 {
    match category {
        "auth" => 100.0,
        "api" => 90.0,
        "components" => 80.0,
        "utils" => 70.0,
        "config" => 60.0,
        "test" => 50.0,
        "styles" => 40.0,
        _ => 0.0,
    }
}

fn kind_weight(kind: &str) -> f64 {
    match kind {
        "function" | "class" => 1.0,
        "default" => 0.8,
        "type" => 0.7,
        "const" => 0.5,
        _ => 0.3,
    }
}

fn recency_factor(change_type: &str) -> f64 {
    match change_type {
        "ADDED" | "MODIFIED" => 1.0,
        "UNTOUCHED" => 0.2,
        "REMOVED" => 0.1,
        _ => 0.5,
    }
}

fn export_change_factor(kind: &str, change_type: &str) -> f64 {
    let base = kind_weight(kind);
    match change_type {
        "ADDED" | "MODIFIED" => base,
        "UNTOUCHED" => base * 0.35,
        _ => base * 0.6,
    }
}

fn clamp01(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else if value >= 1.0 {
        1.0
    } else {
        value
    }
}

fn round_score(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

pub fn rank(request: RankRequest) -> RankOutput {
    let weights = request.weights.unwrap_or(Weights {
        change_size: default_change_size(),
        export_change: default_export_change(),
        category: default_category_weight(),
        recency: default_recency(),
        dependents: default_dependents(),
    });
    let total = weights.change_size
        + weights.export_change
        + weights.category
        + weights.recency
        + weights.dependents;
    let normalized = if total <= 0.0 {
        (0.0, 0.0, 0.0, 0.0, 0.0)
    } else {
        (
            weights.change_size / total,
            weights.export_change / total,
            weights.category / total,
            weights.recency / total,
            weights.dependents / total,
        )
    };

    let mut ranked: Vec<RankedEntry> = request
        .entries
        .into_iter()
        .map(|entry| {
            let kind = entry.kind.clone().unwrap_or_else(|| "other".to_string());
            let change_type = entry
                .change_type
                .clone()
                .unwrap_or_else(|| "UNKNOWN".to_string());
            let change_size = if entry.max_entries_in_file > 0 {
                clamp01(entry.entries_in_file as f64 / entry.max_entries_in_file as f64)
            } else {
                0.0
            };
            let dependents = if entry.max_dependent_count > 0 {
                clamp01(entry.dependent_count as f64 / entry.max_dependent_count as f64)
            } else {
                0.0
            };
            // Round each factor before weighting, matching the TypeScript
            // scoreEntryImpact implementation exactly.
            let score = round_score(
                round_score(change_size) * normalized.0
                    + round_score(export_change_factor(&kind, &change_type)) * normalized.1
                    + round_score(category_priority(&entry.category) / 100.0) * normalized.2
                    + round_score(recency_factor(&change_type)) * normalized.3
                    + round_score(dependents) * normalized.4,
            );
            RankedEntry {
                reference: entry.reference,
                score,
                category: entry.category,
            }
        })
        .collect();

    ranked.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                category_priority(&right.category)
                    .partial_cmp(&category_priority(&left.category))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.reference.cmp(&right.reference))
    });

    RankOutput { ranked }
}

pub fn handle_json(input: &str) -> Result<String, String> {
    let request: Request =
        serde_json::from_str(input).map_err(|error| format!("INVALID_REQUEST: {error}"))?;

    match request {
        Request::Walk(request) => {
            let output = walk(request)?;
            serde_json::to_string(&output).map_err(|error| format!("SERIALIZE_ERROR: {error}"))
        }
        Request::StructuralDiff(request) => {
            let output = structural_diff(request);
            serde_json::to_string(&output).map_err(|error| format!("SERIALIZE_ERROR: {error}"))
        }
        Request::Rank(request) => {
            let output = rank(request);
            serde_json::to_string(&output).map_err(|error| format!("SERIALIZE_ERROR: {error}"))
        }
        Request::Version => Ok(serde_json::json!({
            "name": "analysis-core",
            "version": env!("CARGO_PKG_VERSION"),
            "ops": ["walk", "structural_diff", "rank"],
        })
        .to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn glob_supports_double_star() {
        assert!(glob_match("src/**/*.ts", "src/a/b.ts"));
        assert!(glob_match("src/**/*.ts", "src/a.ts"));
        assert!(!glob_match("src/*.ts", "src/a/b.ts"));
    }

    #[test]
    fn default_excludes_sensitive_paths() {
        assert!(is_default_excluded("node_modules/pkg/index.js"));
        assert!(is_default_excluded(".env.local"));
        assert!(is_default_excluded("src/credentials.json"));
        assert!(!is_default_excluded("src/index.ts"));
    }

    #[test]
    fn structural_diff_detects_signature_changes() {
        let mut previous_files = BTreeMap::new();
        let mut exports = BTreeMap::new();
        exports.insert(
            "login".to_string(),
            PreviousExport {
                kind: "function".to_string(),
                line: Some(3),
                signature: Some("function login(email)".to_string()),
            },
        );
        previous_files.insert("src/auth.ts".to_string(), PreviousFile { exports });

        let output = structural_diff(StructuralDiffRequest {
            previous: Some(PreviousState {
                files: previous_files,
            }),
            current: vec![CurrentFile {
                file: "src/auth.ts".to_string(),
                exports: vec![CurrentExport {
                    name: "login".to_string(),
                    kind: "function".to_string(),
                    line: Some(3),
                    signature: Some("function login(email, password)".to_string()),
                }],
            }],
        });

        assert_eq!(output.breaking_changes.len(), 1);
        assert_eq!(output.breaking_changes[0].kind, "SIGNATURE_CHANGED");
    }

    #[test]
    fn walk_is_deterministic_and_hashes() {
        let root = std::env::temp_dir().join(format!("analysis-core-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        {
            let mut file = fs::File::create(root.join("src/a.ts")).unwrap();
            writeln!(file, "export const a = 1;").unwrap();
        } // file is closed and flushed before walking

        let output = walk(WalkRequest {
            root: root.to_string_lossy().to_string(),
            excludes: vec![],
            max_depth: 5,
            max_file_size_bytes: 1024 * 1024,
            hash: true,
        })
        .unwrap();

        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].path, "src/a.ts");
        assert!(output.files[0].hash.is_some());

        let again = walk(WalkRequest {
            root: root.to_string_lossy().to_string(),
            excludes: vec![],
            max_depth: 5,
            max_file_size_bytes: 1024 * 1024,
            hash: true,
        })
        .unwrap();
        assert_eq!(output.files, again.files);
        let _ = fs::remove_dir_all(&root);
    }
}
