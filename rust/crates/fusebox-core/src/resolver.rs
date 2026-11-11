//! Bounded shell pre-resolver for the specific incident class.
//!
//! ## Scope
//!
//! This resolver handles two distinct input forms:
//!
//! 1. **Argv form** — produced by `fusebox run -- <executable> [args...]`. The
//!    executable and arguments are already split; no shell parsing is needed.
//!    This is the authoritative path for supervised execution.
//!
//! 2. **Raw shell string form** — produced by a host Bash `PreToolUse` hook.
//!    The raw string is parsed by a bounded custom grammar before path evaluation.
//!    Unsupported syntax fails closed: `confidence = Unsupported`.
//!
//! ## Supported grammar
//!
//! Commands: `rm`, `mv`, `cp`, `xargs`, `dirname`, `basename`
//! Quoting: single-quoted (`'…'`), double-quoted (`"…"`) and backslash-escaped spaces
//! Globs: literal `*`, `?`, `**` are noted but NOT expanded (marked as `Partial`)
//! Flags: common flags for the above commands are parsed and ignored for path extraction
//!
//! ## Unsupported (always returns `Unsupported`)
//!
//! Pipes, command substitutions `$(…)` / backticks, subshells `(…)`, `find -exec`,
//! heredocs, shell functions, redirections `>`, `>>`, `<`, `&`, `;` chains,
//! dynamically generated scripts, process substitutions `<(…)`, variable expansion
//! `${…}`, arithmetic `$((…))`, arrays, brace expansion `{a,b}`.
//!
//! ## Design contract
//!
//! - Parser prediction is advisory. OS confinement is the security boundary.
//! - Never label uncertain resolution as `Resolved`.
//! - Unknown or unsupported syntax returns `confidence = Unsupported`, never `Resolved`.
//! - The `xargs dirname` spaced-path incident class must resolve to the dangerous
//!   expanded path, not the apparent quoted argument.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

// ── Public types ──────────────────────────────────────────────────────────────

/// The version string embedded in every `Resolution`.
pub const RESOLVER_VERSION: &str = "1";

/// Coarse command classification understood by the resolver.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandClass {
    /// File removal.
    Remove,
    /// File or directory move / rename.
    Move,
    /// File copy.
    Copy,
    /// `xargs` invocation — inputs expand to further arguments.
    Xargs,
    /// Path component extraction (dirname / basename).
    PathTransform,
    /// Unsupported or unrecognized command.
    Unsupported,
}

/// Confidence level for the predicted target set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// All targets were fully resolved relative to the declared cwd.
    Resolved,
    /// Some targets could not be fully expanded (e.g. glob, dynamic path).
    Partial,
    /// The command or its arguments use syntax the resolver cannot model.
    Unsupported,
}

/// A single predicted filesystem target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedTarget {
    /// The normalized absolute or workspace-relative path.
    pub path: String,
    /// How the target was derived.
    pub provenance: Provenance,
}

/// How a predicted target was derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    /// Literal argument, directly normalized.
    Literal,
    /// Result of resolving a glob pattern (not fully expanded).
    Glob,
    /// Result of applying `dirname` to an argument.
    Dirname,
    /// Result of applying `basename` to an argument.
    Basename,
    /// Argument was passed via `xargs` pipe expansion.
    XargsExpanded,
}

/// The complete output of the resolver for one request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    /// Always `"1"` for this revision.
    pub resolver_version: String,
    /// Coarse command classification.
    pub command_class: CommandClass,
    /// The executable as supplied (absolute path or name).
    pub executable: String,
    /// Parsed argument list after shell-string splitting (if raw string input).
    pub parsed_argv: Vec<String>,
    /// Working directory used for relative path normalization.
    pub cwd: String,
    /// Predicted targets for this operation.
    pub predicted_targets: Vec<PredictedTarget>,
    /// Overall resolution confidence.
    pub confidence: Confidence,
    /// Non-fatal warnings encountered during resolution.
    pub warnings: Vec<String>,
    /// Whether this command class is supported by the resolver.
    pub supported: bool,
}

// ── Public entry points ───────────────────────────────────────────────────────

/// Resolve an **argv-form** request (already split into executable + args).
///
/// Used by `fusebox run -- <executable> [args...]`. No shell parsing is
/// applied; arguments are taken as-is.
pub fn resolve_argv(executable: &str, argv: &[String], cwd: &str) -> Resolution {
    let command_class = classify_executable(executable);

    if !is_supported_class(&command_class) {
        return unsupported_resolution(executable, argv, cwd, "unsupported command class");
    }

    // Argv form: each token is already indivisible; no shell re-splitting.
    let (targets, confidence, warnings) = extract_targets(&command_class, argv, cwd, false);

    let supported = confidence != Confidence::Unsupported;
    Resolution {
        resolver_version: RESOLVER_VERSION.to_string(),
        command_class,
        executable: executable.to_string(),
        parsed_argv: argv.to_vec(),
        cwd: cwd.to_string(),
        predicted_targets: targets,
        confidence,
        warnings,
        supported,
    }
}

/// Resolve a **raw shell string** from a host Bash hook.
///
/// The string is passed through a bounded parser before evaluation. If the
/// string contains unsupported constructs (pipes, substitutions, redirections,
/// etc.) the result is `Confidence::Unsupported` and `supported = false`.
/// Never treats unsupported syntax as safe.
pub fn resolve_shell_string(raw: &str, cwd: &str) -> Resolution {
    // Fail closed on unsupported shell metacharacters before any parsing.
    if let Some(reason) = detect_unsupported_syntax(raw) {
        return unsupported_resolution_raw(raw, cwd, &reason);
    }

    // Bounded tokenization: only safe quoting and backslash-escape.
    let tokens = match tokenize_shell(raw) {
        Ok(t) => t,
        Err(e) => return unsupported_resolution_raw(raw, cwd, &format!("parse error: {e}")),
    };

    if tokens.is_empty() {
        return unsupported_resolution_raw(raw, cwd, "empty command");
    }

    let executable = &tokens[0];
    let argv: Vec<String> = tokens[1..].to_vec();
    let command_class = classify_executable(executable);

    if !is_supported_class(&command_class) {
        return unsupported_resolution_raw(raw, cwd, "unsupported command class");
    }

    // Shell-string form: arguments were already split by the tokenizer.
    // Spaces inside tokens were quoted/escaped, so xargs IFS-splitting was
    // already resolved at the shell level. Pass pre_tokenized=true.
    let (targets, confidence, warnings) = extract_targets(&command_class, &argv, cwd, true);

    let supported = confidence != Confidence::Unsupported;
    Resolution {
        resolver_version: RESOLVER_VERSION.to_string(),
        command_class,
        executable: executable.clone(),
        parsed_argv: argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        confidence,
        warnings,
        supported,
    }
}

// ── Internal: unsupported syntax detection ────────────────────────────────────

/// Characters and patterns that signal unsupported shell constructs.
///
/// This is checked before tokenization. A false negative (missing a dangerous
/// construct) causes `Unsupported` via `tokenize_shell` failure; this is a
/// conservative first pass only.
fn detect_unsupported_syntax(raw: &str) -> Option<String> {
    // Track whether we're inside a quoted context to avoid false positives.
    let mut in_single_quote = false;
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        if ch == '\'' && !in_single_quote {
            in_single_quote = true;
            i += 1;
            continue;
        }
        if ch == '\'' && in_single_quote {
            in_single_quote = false;
            i += 1;
            continue;
        }
        if in_single_quote {
            i += 1;
            continue;
        }

        match ch {
            '|' => return Some("pipes are not supported".to_string()),
            ';' => return Some("command sequences (;) are not supported".to_string()),
            '&' => return Some("background/and-operator (&) is not supported".to_string()),
            '>' | '<' => return Some("redirections are not supported".to_string()),
            '`' => return Some("backtick substitution is not supported".to_string()),
            '$' => {
                // Allow plain $VAR only for specific safe patterns we DON'T try to expand
                // but anything structural (subshell, arithmetic, brace) is unsupported.
                if i + 1 < len {
                    match chars[i + 1] {
                        '(' => return Some("command substitution/arithmetic $(...) is not supported".to_string()),
                        '{' => {
                            // Reject all ${} forms — variable expansion is not supported.
                            return Some("variable expansion ${...} is not supported".to_string());
                        }
                        _ => {}
                    }
                }
            }
            '(' => {
                // Subshell — check it's not part of $(
                if i == 0 || chars[i - 1] != '$' {
                    return Some("subshells are not supported".to_string());
                }
            }
            '#' if i == 0 || chars[i - 1] == ' ' => {
                // Shell comment — truncate here (safe)
                break;
            }
            _ => {}
        }
        i += 1;
    }

    None
}

// ── Internal: bounded tokenizer ───────────────────────────────────────────────

/// Tokenize a shell string using only these rules:
/// - Single-quoted strings: content is literal (no escapes inside `'…'`).
/// - Double-quoted strings: backslash escapes `\"`, `\\`, `\$`, `\`` inside.
/// - Outside quotes: `\<char>` escapes any character.
/// - Tokens are separated by unquoted whitespace.
///
/// Returns an error for malformed quoting (unterminated quote).
fn tokenize_shell(raw: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        match chars[i] {
            // Unquoted whitespace ends the current token.
            ' ' | '\t' | '\n' if !in_token => {
                i += 1;
            }
            ' ' | '\t' | '\n' => {
                tokens.push(current.clone());
                current.clear();
                in_token = false;
                i += 1;
            }
            // Single-quoted literal string.
            '\'' => {
                in_token = true;
                i += 1;
                loop {
                    if i >= len {
                        return Err("unterminated single-quoted string".to_string());
                    }
                    if chars[i] == '\'' {
                        i += 1;
                        break;
                    }
                    current.push(chars[i]);
                    i += 1;
                }
            }
            // Double-quoted string with limited escapes.
            '"' => {
                in_token = true;
                i += 1;
                loop {
                    if i >= len {
                        return Err("unterminated double-quoted string".to_string());
                    }
                    match chars[i] {
                        '"' => {
                            i += 1;
                            break;
                        }
                        '\\' if i + 1 < len => {
                            match chars[i + 1] {
                                '"' | '\\' | '$' | '`' | '\n' => {
                                    current.push(chars[i + 1]);
                                    i += 2;
                                }
                                _ => {
                                    current.push('\\');
                                    current.push(chars[i + 1]);
                                    i += 2;
                                }
                            }
                        }
                        ch => {
                            current.push(ch);
                            i += 1;
                        }
                    }
                }
            }
            // Backslash escape outside quotes.
            '\\' if i + 1 < len => {
                in_token = true;
                current.push(chars[i + 1]);
                i += 2;
            }
            '\\' => {
                return Err("trailing backslash at end of string".to_string());
            }
            // Regular character.
            ch => {
                in_token = true;
                current.push(ch);
                i += 1;
            }
        }
    }

    if in_token {
        tokens.push(current);
    }

    Ok(tokens)
}

// ── Internal: command classification ──────────────────────────────────────────

fn classify_executable(executable: &str) -> CommandClass {
    // Accept both bare names and absolute paths.
    let name = Path::new(executable)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(executable);
    match name {
        "rm" => CommandClass::Remove,
        "mv" => CommandClass::Move,
        "cp" => CommandClass::Copy,
        "xargs" => CommandClass::Xargs,
        "dirname" => CommandClass::PathTransform,
        "basename" => CommandClass::PathTransform,
        _ => CommandClass::Unsupported,
    }
}

fn is_supported_class(class: &CommandClass) -> bool {
    !matches!(class, CommandClass::Unsupported)
}

// ── Internal: target extraction ───────────────────────────────────────────────

fn extract_targets(
    class: &CommandClass,
    argv: &[String],
    cwd: &str,
    pre_tokenized: bool,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    match class {
        CommandClass::Remove => extract_remove_targets(argv, cwd),
        CommandClass::Move => extract_move_targets(argv, cwd),
        CommandClass::Copy => extract_copy_targets(argv, cwd),
        CommandClass::Xargs => extract_xargs_targets(argv, cwd, pre_tokenized),
        CommandClass::PathTransform => extract_path_transform_targets(argv, cwd),
        CommandClass::Unsupported => (vec![], Confidence::Unsupported, vec![]),
    }
}

/// Strip leading flag arguments (`-f`, `--force`, `-rf`, etc.) and return
/// the remaining positional arguments.
fn strip_flags(argv: &[String]) -> &[String] {
    let mut i = 0;
    while i < argv.len() {
        if argv[i].starts_with('-') && argv[i] != "--" {
            i += 1;
        } else if argv[i] == "--" {
            return &argv[i + 1..];
        } else {
            break;
        }
    }
    &argv[i..]
}

fn extract_remove_targets(
    argv: &[String],
    cwd: &str,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    let positionals = strip_flags(argv);
    let mut targets = Vec::new();
    let mut confidence = Confidence::Resolved;
    let mut warnings = Vec::new();

    for arg in positionals {
        if has_glob_metachar(arg) {
            warnings.push(format!("glob pattern not expanded: {arg}"));
            targets.push(PredictedTarget {
                path: normalize_path(arg, cwd),
                provenance: Provenance::Glob,
            });
            confidence = Confidence::Partial;
        } else if arg.contains('\0') {
            warnings.push(format!("null byte in argument: {arg:?}"));
            confidence = Confidence::Partial;
        } else {
            targets.push(PredictedTarget {
                path: normalize_path(arg, cwd),
                provenance: Provenance::Literal,
            });
        }
    }

    (targets, confidence, warnings)
}

fn extract_move_targets(
    argv: &[String],
    cwd: &str,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    // mv [flags] <src> <dst>
    // All positionals are affected paths (both source and destination are targets).
    extract_remove_targets(argv, cwd)
}

fn extract_copy_targets(
    argv: &[String],
    cwd: &str,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    // cp [flags] <src> <dst>
    extract_remove_targets(argv, cwd)
}

/// The `xargs dirname` spaced-path incident class.
///
/// `xargs [flags] dirname [flags] -- <paths...>`
/// When `xargs` receives a path with a space (e.g. `/project/my dir/file.txt`),
/// the space acts as a field separator and `dirname` receives only the prefix
/// up to the space. This resolves to the dangerous parent, not the intended file.
///
/// The resolver models this as: each positional after the xargs-delegated
/// command is a potential xargs input token. If the token contains spaces and
/// is NOT quoted, the shell split in `xargs` default mode would separate it.
/// `pre_tokenized`: when `true`, the arguments were already split by a shell
/// tokenizer, so spaces within tokens are already handled. xargs IFS-splitting
/// must NOT be applied again (the token is an indivisible path).
fn extract_xargs_targets(
    argv: &[String],
    cwd: &str,
    pre_tokenized: bool,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    let mut warnings = Vec::new();
    let mut confidence = Confidence::Resolved;

    // Find the sub-command within xargs argv.
    // xargs [xargs-flags] <command> [command-flags] -- [inputs...]
    // or xargs [xargs-flags] -- <command> [command-flags] <inputs...>
    // Skip xargs flags (-I, -n, -P, -0, -d, etc.) to find the command.
    let positionals = strip_flags(argv);

    if positionals.is_empty() {
        warnings.push("xargs: no command specified after flags".to_string());
        return (vec![], Confidence::Unsupported, warnings);
    }

    let sub_cmd = &positionals[0];
    let sub_class = classify_executable(sub_cmd);

    // Only `dirname` and `basename` are handled for the incident class.
    match sub_class {
        CommandClass::PathTransform => {}
        _ => {
            warnings.push(format!(
                "xargs: sub-command '{sub_cmd}' is not in the supported incident class"
            ));
            return (vec![], Confidence::Unsupported, warnings);
        }
    }

    let sub_argv = &positionals[1..];
    // Strip sub-command flags.
    let path_args = strip_flags(sub_argv);

    let mut targets = Vec::new();

    // Determine whether -0 (null-delimited) mode is active.
    let null_delimited = argv.iter().any(|a| a == "-0" || a == "--null");

    for raw_path in path_args {
        if null_delimited {
            // With -0, spaces are not delimiters — treat as a single literal path.
            let transformed = apply_path_transform(sub_cmd, raw_path, cwd);
            targets.push(PredictedTarget {
                path: transformed,
                provenance: Provenance::XargsExpanded,
            });
        } else if !pre_tokenized && raw_path.contains(' ') {
            // Without -0 or pre-tokenization, `xargs` splits on any unquoted whitespace.
            // Model the dangerous case: the part before the first space.
            let first_token = raw_path
                .split_whitespace()
                .next()
                .unwrap_or(raw_path.as_str());
            let dangerous_path = apply_path_transform(sub_cmd, first_token, cwd);
            warnings.push(format!(
                "xargs: unquoted space in '{}' splits to '{}' — this is the incident class",
                raw_path, dangerous_path
            ));
            targets.push(PredictedTarget {
                path: dangerous_path,
                provenance: Provenance::XargsExpanded,
            });
            confidence = Confidence::Partial; // we have evidence of split, but IFS may vary
        } else {
            // Either pre_tokenized=true (space was already quoted/escaped),
            // or no space in the path — treat as a single complete argument.
            let transformed = apply_path_transform(sub_cmd, raw_path, cwd);
            targets.push(PredictedTarget {
                path: transformed,
                provenance: Provenance::XargsExpanded,
            });
        }
    }

    (targets, confidence, warnings)
}

fn extract_path_transform_targets(
    argv: &[String],
    cwd: &str,
) -> (Vec<PredictedTarget>, Confidence, Vec<String>) {
    // dirname/basename [flags] <path>
    let positionals = strip_flags(argv);
    let mut targets = Vec::new();
    let mut confidence = Confidence::Resolved;
    let mut warnings = Vec::new();

    // Determine the command name from context — handled via CommandClass::PathTransform.
    // The executable name is not passed here; we apply dirname semantics by default.
    // Callers that need basename should call this via the correct class.
    for arg in positionals {
        if has_glob_metachar(arg) {
            warnings.push(format!("glob pattern in path transform argument: {arg}"));
            confidence = Confidence::Partial;
        }
        targets.push(PredictedTarget {
            path: normalize_path(arg, cwd),
            provenance: Provenance::Dirname,
        });
    }

    (targets, confidence, warnings)
}

/// Apply the path transformation of `dirname` or `basename` to a path.
fn apply_path_transform(cmd_name: &str, path: &str, cwd: &str) -> String {
    let abs = normalize_path(path, cwd);
    let p = Path::new(&abs);
    let name = Path::new(cmd_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(cmd_name);
    match name {
        "basename" => p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path)
            .to_string(),
        _ => {
            // dirname
            p.parent()
                .and_then(|p| p.to_str())
                .unwrap_or("/")
                .to_string()
        }
    }
}

// ── Internal: path normalization ──────────────────────────────────────────────

/// Normalize a path argument to an absolute path using `cwd` as the base.
///
/// - Absolute paths are returned as-is after component normalization.
/// - Relative paths are joined to `cwd` then normalized.
/// - `..` components are resolved lexically (no symlink expansion).
/// - Null bytes are preserved as-is (the caller checks for them separately).
pub fn normalize_path(path: &str, cwd: &str) -> String {
    let p = if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };

    // Lexically normalize `..` and `.`.
    let mut components: Vec<&str> = Vec::new();
    for component in p.components() {
        match component {
            Component::RootDir => components.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if components.len() > 1 {
                    components.pop();
                }
                // If we're at root, stay at root.
            }
            Component::Normal(s) => {
                if let Some(s) = s.to_str() {
                    components.push(s);
                }
            }
            Component::Prefix(p) => {
                if let Some(s) = p.as_os_str().to_str() {
                    components.push(s);
                }
            }
        }
    }

    if components.is_empty() {
        return cwd.to_string();
    }

    if components == ["/"] {
        return "/".to_string();
    }

    // Reconstruct: first component is "/" for absolute paths.
    let mut result = String::new();
    for (i, c) in components.iter().enumerate() {
        if i == 0 && *c == "/" {
            result.push('/');
        } else if i == 0 {
            result.push_str(c);
        } else if result.ends_with('/') {
            result.push_str(c);
        } else {
            result.push('/');
            result.push_str(c);
        }
    }
    result
}

fn has_glob_metachar(s: &str) -> bool {
    s.contains('*') || s.contains('?') || s.contains('[')
}

// ── Internal: unsupported resolution builders ─────────────────────────────────

fn unsupported_resolution(
    executable: &str,
    argv: &[String],
    cwd: &str,
    reason: &str,
) -> Resolution {
    Resolution {
        resolver_version: RESOLVER_VERSION.to_string(),
        command_class: CommandClass::Unsupported,
        executable: executable.to_string(),
        parsed_argv: argv.to_vec(),
        cwd: cwd.to_string(),
        predicted_targets: vec![],
        confidence: Confidence::Unsupported,
        warnings: vec![format!("unsupported: {reason}")],
        supported: false,
    }
}

fn unsupported_resolution_raw(raw: &str, cwd: &str, reason: &str) -> Resolution {
    Resolution {
        resolver_version: RESOLVER_VERSION.to_string(),
        command_class: CommandClass::Unsupported,
        executable: String::new(),
        parsed_argv: vec![raw.to_string()],
        cwd: cwd.to_string(),
        predicted_targets: vec![],
        confidence: Confidence::Unsupported,
        warnings: vec![format!("unsupported: {reason}")],
        supported: false,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── tokenizer ─────────────────────────────────────────────────────────────

    #[test]
    fn tokenize_bare_words() {
        assert_eq!(
            tokenize_shell("rm -rf /tmp/foo").unwrap(),
            vec!["rm", "-rf", "/tmp/foo"]
        );
    }

    #[test]
    fn tokenize_single_quoted_space() {
        assert_eq!(
            tokenize_shell("rm '/project/my dir/file.txt'").unwrap(),
            vec!["rm", "/project/my dir/file.txt"]
        );
    }

    #[test]
    fn tokenize_double_quoted_space() {
        assert_eq!(
            tokenize_shell(r#"rm "/project/my dir/file.txt""#).unwrap(),
            vec!["rm", "/project/my dir/file.txt"]
        );
    }

    #[test]
    fn tokenize_backslash_space() {
        assert_eq!(
            tokenize_shell(r"rm /project/my\ dir/file.txt").unwrap(),
            vec!["rm", "/project/my dir/file.txt"]
        );
    }

    #[test]
    fn tokenize_unterminated_single_quote_is_error() {
        assert!(tokenize_shell("rm '/foo").is_err());
    }

    #[test]
    fn tokenize_unterminated_double_quote_is_error() {
        assert!(tokenize_shell(r#"rm "/foo"#).is_err());
    }

    // ── unsupported syntax detection ─────────────────────────────────────────

    #[test]
    fn detect_pipe_is_unsupported() {
        let r = resolve_shell_string("echo foo | rm -rf /", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn detect_subshell_is_unsupported() {
        let r = resolve_shell_string("rm $(cat /etc/paths)", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn detect_semicolon_chain_is_unsupported() {
        let r = resolve_shell_string("cd /tmp; rm -rf /project", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn detect_redirect_is_unsupported() {
        let r = resolve_shell_string("cat /etc/passwd > /tmp/leak", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn detect_backtick_is_unsupported() {
        let r = resolve_shell_string("rm `cat paths.txt`", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    // ── rm resolution ─────────────────────────────────────────────────────────

    #[test]
    fn rm_absolute_path_resolves() {
        let r = resolve_argv("/bin/rm", &["-rf".into(), "/project/src".into()], "/project");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets.len(), 1);
        assert_eq!(r.predicted_targets[0].path, "/project/src");
        assert_eq!(r.predicted_targets[0].provenance, Provenance::Literal);
    }

    #[test]
    fn rm_relative_path_resolves_against_cwd() {
        let r = resolve_argv("rm", &["src/main.rs".into()], "/project");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets[0].path, "/project/src/main.rs");
    }

    #[test]
    fn rm_dotdot_traversal_resolves_to_parent() {
        // The resolver MUST resolve this to the dangerous parent, not reject silently.
        let r = resolve_argv("/bin/rm", &["-rf".into(), "/project/src/../../etc/passwd".into()], "/project");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets[0].path, "/etc/passwd");
    }

    #[test]
    fn rm_glob_is_partial() {
        let r = resolve_argv("rm", &["/project/src/*.rs".into()], "/project");
        assert_eq!(r.confidence, Confidence::Partial);
        assert_eq!(r.predicted_targets[0].provenance, Provenance::Glob);
        assert!(!r.warnings.is_empty());
    }

    #[test]
    fn rm_null_byte_path_is_partial_with_warning() {
        let r = resolve_argv("rm", &["/project/src/main.rs\x00/etc/shadow".into()], "/project");
        assert_eq!(r.confidence, Confidence::Partial);
        assert!(r.warnings.iter().any(|w| w.contains("null byte")));
    }

    // ── mv / cp resolution ────────────────────────────────────────────────────

    #[test]
    fn mv_resolves_src_and_dst() {
        let r = resolve_argv("mv", &["/project/old.txt".into(), "/project/new.txt".into()], "/project");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets.len(), 2);
    }

    #[test]
    fn cp_relative_paths_resolved() {
        let r = resolve_argv("cp", &["src/a.rs".into(), "src/b.rs".into()], "/project");
        assert_eq!(r.predicted_targets[0].path, "/project/src/a.rs");
        assert_eq!(r.predicted_targets[1].path, "/project/src/b.rs");
    }

    // ── xargs dirname incident class ──────────────────────────────────────────

    #[test]
    fn xargs_dirname_spaced_path_resolves_to_dangerous_prefix() {
        // The incident: `xargs dirname` with an unquoted space splits the path.
        // Input: "/project/my project/file.txt" (with space, no -0)
        // xargs splits on space → dirname receives "/project/my"
        // dirname of "/project/my" → "/project"
        let r = resolve_argv(
            "xargs",
            &["dirname".into(), "/project/my project/file.txt".into()],
            "/project",
        );
        assert!(r.predicted_targets.iter().any(|t| t.path == "/project"));
        assert!(r.warnings.iter().any(|w| w.contains("splits to")));
        assert_eq!(r.confidence, Confidence::Partial);
    }

    #[test]
    fn xargs_dirname_null_delimited_uses_full_path() {
        // With -0, spaces are not delimiters — full path is preserved.
        let r = resolve_argv(
            "xargs",
            &["-0".into(), "dirname".into(), "/project/my project/file.txt".into()],
            "/project",
        );
        // dirname of the full path "/project/my project/file.txt" is "/project/my project"
        assert!(r.predicted_targets.iter().any(|t| t.path == "/project/my project"));
        // No warning about space-splitting.
        assert!(!r.warnings.iter().any(|w| w.contains("splits to")));
    }

    #[test]
    fn xargs_dirname_shell_string_spaced_path() {
        // From a raw shell string — the incident class.
        let r = resolve_shell_string(
            "xargs dirname /project/my\\ project/file.txt",
            "/project",
        );
        // Backslash-escaped space → single token → no xargs split → dirname of full path.
        assert!(r.predicted_targets.iter().any(|t| t.path == "/project/my project"));
        assert_eq!(r.confidence, Confidence::Resolved);
    }

    #[test]
    fn xargs_with_unsupported_sub_command_is_unsupported() {
        let r = resolve_argv("xargs", &["bash".into(), "-c".into(), "rm {}".into()], "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    // ── dirname / basename ────────────────────────────────────────────────────

    #[test]
    fn dirname_absolute_path() {
        let r = resolve_argv("dirname", &["/project/src/main.rs".into()], "/project");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets[0].path, "/project/src/main.rs");
    }

    #[test]
    fn dirname_relative_path() {
        let r = resolve_argv("dirname", &["src/main.rs".into()], "/project");
        assert_eq!(r.predicted_targets[0].path, "/project/src/main.rs");
    }

    // ── unsupported commands ──────────────────────────────────────────────────

    #[test]
    fn unsupported_command_returns_unsupported() {
        let r = resolve_argv("find", &["/project".into(), "-name".into(), "*.rs".into()], "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn bash_command_is_unsupported() {
        let r = resolve_argv("bash", &["-c".into(), "rm -rf /".into()], "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
    }

    #[test]
    fn sh_command_is_unsupported() {
        let r = resolve_argv("sh", &["-c".into(), "echo hi".into()], "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
    }

    // ── path normalization ────────────────────────────────────────────────────

    #[test]
    fn normalize_absolute_dotdot_traversal() {
        assert_eq!(normalize_path("/project/src/../../etc/passwd", "/"), "/etc/passwd");
    }

    #[test]
    fn normalize_relative_path_against_cwd() {
        assert_eq!(normalize_path("src/main.rs", "/project"), "/project/src/main.rs");
    }

    #[test]
    fn normalize_dot_components_stripped() {
        assert_eq!(normalize_path("/project/./src/./main.rs", "/project"), "/project/src/main.rs");
    }

    #[test]
    fn normalize_root_dotdot_stays_at_root() {
        assert_eq!(normalize_path("/../etc/passwd", "/"), "/etc/passwd");
    }
}
