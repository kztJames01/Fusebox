//! Bounded shell pre-resolver for the documented incident command class.
//!
//! Supports: `rm`, `mv`, `cp`, `xargs` (with `dirname`/`basename` only),
//! `dirname`, `basename`.
//! Every unsupported construct returns [`Confidence::Unsupported`], never
//! a false "safe" verdict.
//!
//! Two input forms:
//! - **Argv form** (`resolve_argv`): caller has already split tokens; the
//!   executable is `args[0]`, arguments are `args[1..]`. This is the form
//!   used by `fusebox run`.
//! - **Shell-string form** (`resolve_shell_string`): a raw shell string from a
//!   host hook is tokenised by `shell_tokenize` before resolution. Unknown or
//!   unsupported shell syntax fails closed.

use std::path::{Path, PathBuf};

// ── Public types ──────────────────────────────────────────────────────────────

/// Confidence level of the resolver's path prediction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confidence {
    /// All predicted targets are believed to be accurate.
    Resolved,
    /// Some targets could not be fully resolved (e.g. glob expansion).
    Partial,
    /// The operation syntax is not supported; treat as deny in strict mode.
    Unsupported,
}

/// One predicted filesystem target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredictedTarget {
    /// Normalized absolute path (if resoluble relative to `cwd`).
    pub path: String,
    /// Whether the path involves a glob that was not expanded.
    pub has_glob: bool,
    /// Whether the path had spaces or special quoting that could indicate the
    /// incident class (ambiguous tokenisation by xargs).
    pub has_space_risk: bool,
}

/// The kind of operation the command performs on its targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKind {
    /// The command will delete target(s).
    Delete,
    /// The command will read source(s) and write to a destination.
    CopyOrMove,
    /// The command reads target(s) but does not modify them.
    Read,
    /// The command writes to target(s).
    Write,
    /// Target kind is unknown or mixed.
    Unknown,
}

/// Full resolver output.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// Coarse classification of what the command does to its targets.
    pub command_class: String,
    /// Original tokens supplied to the resolver (after shell-string splitting,
    /// if applicable).
    pub parsed_argv: Vec<String>,
    /// Working directory used for path normalization.
    pub cwd: String,
    /// Predicted filesystem targets.
    pub predicted_targets: Vec<PredictedTarget>,
    /// Operation kind.
    pub target_kind: TargetKind,
    /// Overall confidence.
    pub confidence: Confidence,
    /// Human-readable warnings about uncertain aspects of the resolution.
    pub warnings: Vec<String>,
    /// Whether the command is in the supported grammar.
    pub supported: bool,
    /// Resolver version string.
    pub resolver_version: String,
}

const RESOLVER_VERSION: &str = "1";

// ── Public entry points ───────────────────────────────────────────────────────

/// Resolve a pre-split argv array (as from `fusebox run`).
///
/// `argv[0]` is the executable; `argv[1..]` are the arguments.
/// `cwd` is the working directory used for relative path normalization.
pub fn resolve_argv(argv: &[String], cwd: &str) -> Resolution {
    if argv.is_empty() {
        return unsupported_resolution(vec![], cwd, "empty argv");
    }
    dispatch(&argv[0], &argv[1..], argv.to_vec(), cwd)
}

/// Resolve a raw shell string from a host hook.
///
/// The string is tokenised first; unsupported shell syntax fails closed.
pub fn resolve_shell_string(shell_str: &str, cwd: &str) -> Resolution {
    match shell_tokenize(shell_str) {
        Ok(tokens) if tokens.is_empty() => {
            unsupported_resolution(vec![], cwd, "empty shell string")
        }
        Ok(tokens) => {
            let first = tokens[0].clone();
            let rest: Vec<String> = tokens[1..].to_vec();
            dispatch(&first, &rest, tokens, cwd)
        }
        Err(reason) => unsupported_resolution(vec![], cwd, &reason),
    }
}

// ── Shell tokenizer ───────────────────────────────────────────────────────────

/// Tokenise a shell string using the bounded grammar documented in the
/// resolver-design ADR.
///
/// Returns `Err` for any unsupported shell construct.
pub fn shell_tokenize(input: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            // Fail closed on unsupported constructs.
            '|' => return Err("unsupported: pipe '|'".to_string()),
            ';' => return Err("unsupported: semicolon ';'".to_string()),
            '&' => return Err("unsupported: background/logical '&'".to_string()),
            '`' => return Err("unsupported: backtick command substitution".to_string()),
            '(' | ')' => return Err("unsupported: subshell '(' or ')'".to_string()),
            '<' | '>' => return Err("unsupported: redirection '<' or '>'".to_string()),
            '$' => {
                // Variable expansion or command substitution — fail closed.
                return Err("unsupported: variable/command expansion '$'".to_string());
            }
            '{' => return Err("unsupported: brace expansion '{'".to_string()),
            '#' => {
                // Shell comment — consume rest of line.
                for _ in chars.by_ref() {}
                break;
            }
            '\\' => {
                // Backslash escape outside quotes.
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
                // Trailing backslash: ignore (line continuation not supported).
            }
            '\'' => {
                // Single-quoted string: literal, no escapes.
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => current.push(c),
                        None => return Err("unsupported: unterminated single quote".to_string()),
                    }
                }
            }
            '"' => {
                // Double-quoted string: `\"`, `\\`, `\$`, `` \` `` escapes.
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => {
                            match chars.peek() {
                                Some('"') | Some('\\') | Some('$') | Some('`') => {
                                    current.push(chars.next().unwrap());
                                }
                                _ => {
                                    // Literal backslash.
                                    current.push('\\');
                                }
                            }
                        }
                        Some('$') | Some('`') => {
                            return Err(
                                "unsupported: variable/command expansion inside double quote"
                                    .to_string(),
                            );
                        }
                        Some(c) => current.push(c),
                        None => return Err("unsupported: unterminated double quote".to_string()),
                    }
                }
            }
            ' ' | '\t' | '\n' | '\r' => {
                // Token delimiter.
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(ch);
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
}

// ── Command dispatch ──────────────────────────────────────────────────────────

fn dispatch(executable: &str, args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let cmd_name = Path::new(executable)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(executable);

    match cmd_name {
        "rm" => resolve_rm(args, full_argv, cwd),
        "mv" => resolve_mv(args, full_argv, cwd),
        "cp" => resolve_cp(args, full_argv, cwd),
        "xargs" => resolve_xargs(args, full_argv, cwd),
        "dirname" => resolve_dirname(args, full_argv, cwd),
        "basename" => resolve_basename(args, full_argv, cwd),
        _ => unsupported_resolution(full_argv, cwd, &format!("unsupported command: {cmd_name}")),
    }
}

// ── rm ────────────────────────────────────────────────────────────────────────

fn resolve_rm(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let mut targets = Vec::new();
    let mut warnings = Vec::new();
    let mut confidence = Confidence::Resolved;
    let mut skip_next = false;

    let mut i = 0;
    while i < args.len() {
        if skip_next {
            skip_next = false;
            i += 1;
            continue;
        }
        let arg = &args[i];
        if arg == "--" {
            // Everything after -- is a path.
            for path_arg in &args[i + 1..] {
                let t = make_target(path_arg, cwd, &mut warnings, &mut confidence);
                targets.push(t);
            }
            break;
        } else if arg.starts_with('-') {
            // Known flags that take no value.
            // Unknown flags: treat conservatively as positionals only if they
            // look like a path.
        } else {
            let t = make_target(arg, cwd, &mut warnings, &mut confidence);
            targets.push(t);
        }
        i += 1;
    }

    Resolution {
        command_class: "rm".to_string(),
        parsed_argv: full_argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        target_kind: TargetKind::Delete,
        confidence,
        warnings,
        supported: true,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

// ── mv ────────────────────────────────────────────────────────────────────────

fn resolve_mv(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let mut warnings = Vec::new();
    let mut confidence = Confidence::Resolved;

    // Collect positional paths (skip flag tokens).
    let positionals: Vec<&String> = args
        .iter()
        .filter(|a| !a.starts_with('-') || *a == "--")
        .collect();

    // mv <src>... <dst>: all but last are sources, last is destination.
    let mut targets: Vec<PredictedTarget> = positionals
        .iter()
        .map(|p| make_target(p, cwd, &mut warnings, &mut confidence))
        .collect();

    if targets.len() < 2 {
        warnings.push("mv: fewer than 2 path arguments; resolution is incomplete".to_string());
        confidence = Confidence::Partial;
    } else {
        // The last target is the destination.
        if let Some(last) = targets.last_mut() {
            last.has_space_risk = false; // destination always needs explicit check
        }
    }

    Resolution {
        command_class: "mv".to_string(),
        parsed_argv: full_argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        target_kind: TargetKind::CopyOrMove,
        confidence,
        warnings,
        supported: true,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

// ── cp ────────────────────────────────────────────────────────────────────────

fn resolve_cp(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let mut warnings = Vec::new();
    let mut confidence = Confidence::Resolved;

    let positionals: Vec<&String> = args
        .iter()
        .filter(|a| !a.starts_with('-') || *a == "--")
        .collect();

    let targets: Vec<PredictedTarget> = positionals
        .iter()
        .map(|p| make_target(p, cwd, &mut warnings, &mut confidence))
        .collect();

    if targets.len() < 2 {
        warnings.push("cp: fewer than 2 path arguments; resolution is incomplete".to_string());
    }

    Resolution {
        command_class: "cp".to_string(),
        parsed_argv: full_argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        target_kind: TargetKind::CopyOrMove,
        confidence,
        warnings,
        supported: true,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

// ── xargs ─────────────────────────────────────────────────────────────────────

/// xargs support is limited to `xargs dirname` and `xargs basename`.
/// Any other subcommand is unsupported.
fn resolve_xargs(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    // Find the sub-command after flags.
    let subcmd = args.iter().find(|a| !a.starts_with('-'));

    match subcmd.map(String::as_str) {
        Some("dirname") | Some("/usr/bin/dirname") | Some("/bin/dirname") => {
            let mut warnings = vec![
                "xargs dirname: result depends on stdin; path resolution is advisory".to_string(),
            ];
            warnings.push(
                "xargs dirname: paths with spaces are IFS-split by xargs, which may resolve to a broader parent than intended".to_string(),
            );
            Resolution {
                command_class: "xargs_dirname".to_string(),
                parsed_argv: full_argv,
                cwd: cwd.to_string(),
                predicted_targets: vec![],
                target_kind: TargetKind::Read,
                confidence: Confidence::Partial,
                warnings,
                supported: true,
                resolver_version: RESOLVER_VERSION.to_string(),
            }
        }
        Some("basename") | Some("/usr/bin/basename") | Some("/bin/basename") => Resolution {
            command_class: "xargs_basename".to_string(),
            parsed_argv: full_argv,
            cwd: cwd.to_string(),
            predicted_targets: vec![],
            target_kind: TargetKind::Read,
            confidence: Confidence::Partial,
            warnings: vec!["xargs basename: result depends on stdin".to_string()],
            supported: true,
            resolver_version: RESOLVER_VERSION.to_string(),
        },
        Some(other) => unsupported_resolution(
            full_argv,
            cwd,
            &format!("xargs: unsupported sub-command '{other}'"),
        ),
        None => unsupported_resolution(full_argv, cwd, "xargs: no sub-command found"),
    }
}

// ── dirname / basename ────────────────────────────────────────────────────────

fn resolve_dirname(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let mut warnings = Vec::new();
    let mut confidence = Confidence::Resolved;

    let targets: Vec<PredictedTarget> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|p| {
            // dirname of a path: resolve parent.
            let raw_path = normalize_path(p, cwd);
            let parent = Path::new(&raw_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| raw_path.clone());
            let has_space = p.contains(' ');
            if has_space {
                warnings.push(format!(
                    "dirname: path '{p}' contains spaces; verify it was not IFS-split"
                ));
            }
            let has_glob = has_glob_chars(p);
            if has_glob {
                confidence = Confidence::Partial;
            }
            PredictedTarget {
                path: parent,
                has_glob,
                has_space_risk: has_space,
            }
        })
        .collect();

    Resolution {
        command_class: "dirname".to_string(),
        parsed_argv: full_argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        target_kind: TargetKind::Read,
        confidence,
        warnings,
        supported: true,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

fn resolve_basename(args: &[String], full_argv: Vec<String>, cwd: &str) -> Resolution {
    let warnings = Vec::new();
    let mut confidence = Confidence::Resolved;

    let targets: Vec<PredictedTarget> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|p| {
            let has_glob = has_glob_chars(p);
            if has_glob {
                confidence = Confidence::Partial;
            }
            let raw_path = normalize_path(p, cwd);
            let base = Path::new(&raw_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            PredictedTarget {
                path: base,
                has_glob,
                has_space_risk: false,
            }
        })
        .collect();

    Resolution {
        command_class: "basename".to_string(),
        parsed_argv: full_argv,
        cwd: cwd.to_string(),
        predicted_targets: targets,
        target_kind: TargetKind::Read,
        confidence,
        warnings,
        supported: true,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

// ── Path utilities ────────────────────────────────────────────────────────────

fn normalize_path(path: &str, cwd: &str) -> String {
    let p = Path::new(path);
    let joined = if p.is_absolute() {
        path.to_string()
    } else {
        PathBuf::from(cwd).join(path).to_string_lossy().to_string()
    };
    // Normalize to forward slashes for consistency in policy comparisons.
    // The resolver operates on POSIX-style paths; the OS enforcement layer
    // (Landlock) is Linux-only and uses forward slashes natively.
    joined.replace('\\', "/")
}

fn has_glob_chars(s: &str) -> bool {
    s.contains('*') || s.contains('?') || s.contains('[')
}

fn make_target(
    path: &str,
    cwd: &str,
    warnings: &mut Vec<String>,
    confidence: &mut Confidence,
) -> PredictedTarget {
    let has_glob = has_glob_chars(path);
    let has_space = path.contains(' ');
    if has_glob {
        *confidence = Confidence::Partial;
        warnings.push(format!(
            "path '{path}' contains a glob; expansion is not performed"
        ));
    }
    if has_space {
        warnings.push(format!(
            "path '{path}' contains spaces; verify quoting intent"
        ));
    }
    PredictedTarget {
        path: normalize_path(path, cwd),
        has_glob,
        has_space_risk: has_space,
    }
}

/// Public bridge for the policy module to construct unsupported resolutions
/// without re-running the command dispatcher.
pub fn unsupported_res(argv: Vec<String>, cwd: &str, reason: &str) -> Resolution {
    unsupported_resolution(argv, cwd, reason)
}

fn unsupported_resolution(argv: Vec<String>, cwd: &str, reason: &str) -> Resolution {
    Resolution {
        command_class: "unsupported".to_string(),
        parsed_argv: argv,
        cwd: cwd.to_string(),
        predicted_targets: vec![],
        target_kind: TargetKind::Unknown,
        confidence: Confidence::Unsupported,
        warnings: vec![reason.to_string()],
        supported: false,
        resolver_version: RESOLVER_VERSION.to_string(),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ── shell_tokenize ────────────────────────────────────────────────────────

    #[test]
    fn tokenize_simple_rm() {
        let toks = shell_tokenize("rm -rf /tmp/work").unwrap();
        assert_eq!(toks, vec!["rm", "-rf", "/tmp/work"]);
    }

    #[test]
    fn tokenize_single_quoted_path_with_space() {
        let toks = shell_tokenize("rm '/project/my file.txt'").unwrap();
        assert_eq!(toks, vec!["rm", "/project/my file.txt"]);
    }

    #[test]
    fn tokenize_double_quoted_path_with_space() {
        let toks = shell_tokenize(r#"rm "/project/my file.txt""#).unwrap();
        assert_eq!(toks, vec!["rm", "/project/my file.txt"]);
    }

    #[test]
    fn tokenize_backslash_escaped_space() {
        let toks = shell_tokenize(r"rm /project/my\ file.txt").unwrap();
        assert_eq!(toks, vec!["rm", "/project/my file.txt"]);
    }

    #[test]
    fn tokenize_pipe_fails_closed() {
        assert!(shell_tokenize("ls | rm -rf /").is_err());
    }

    #[test]
    fn tokenize_semicolon_fails_closed() {
        assert!(shell_tokenize("echo x; rm -rf /").is_err());
    }

    #[test]
    fn tokenize_variable_expansion_fails_closed() {
        assert!(shell_tokenize("rm $HOME/secret").is_err());
    }

    #[test]
    fn tokenize_command_substitution_fails_closed() {
        assert!(shell_tokenize("rm $(find /)").is_err());
    }

    #[test]
    fn tokenize_subshell_fails_closed() {
        assert!(shell_tokenize("(rm -rf /)").is_err());
    }

    #[test]
    fn tokenize_brace_expansion_fails_closed() {
        assert!(shell_tokenize("rm {a,b}.txt").is_err());
    }

    // ── rm ────────────────────────────────────────────────────────────────────

    #[test]
    fn rm_simple_path() {
        let r = resolve_argv(&args(&["rm", "/tmp/work"]), "/");
        assert_eq!(r.confidence, Confidence::Resolved);
        assert_eq!(r.predicted_targets[0].path, "/tmp/work");
        assert_eq!(r.target_kind, TargetKind::Delete);
    }

    #[test]
    fn rm_glob_yields_partial() {
        let r = resolve_argv(&args(&["rm", "/tmp/*.log"]), "/");
        assert_eq!(r.confidence, Confidence::Partial);
        assert!(r.predicted_targets[0].has_glob);
    }

    #[test]
    fn rm_relative_path_normalized() {
        let r = resolve_argv(&args(&["rm", "subdir/file.txt"]), "/project");
        assert_eq!(r.predicted_targets[0].path, "/project/subdir/file.txt");
    }

    // ── xargs dirname incident class ──────────────────────────────────────────

    #[test]
    fn xargs_dirname_warns_about_space_risk() {
        let r = resolve_argv(&args(&["xargs", "dirname"]), "/project");
        assert_eq!(r.confidence, Confidence::Partial);
        assert!(r.warnings.iter().any(|w| w.contains("spaces")));
        assert!(r.supported);
    }

    #[test]
    fn xargs_unsupported_subcmd_fails_closed() {
        let r = resolve_argv(&args(&["xargs", "rm"]), "/");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn xargs_no_subcmd_fails_closed() {
        let r = resolve_argv(&args(&["xargs"]), "/");
        assert_eq!(r.confidence, Confidence::Unsupported);
    }

    // ── dirname path-expansion incident ──────────────────────────────────────

    #[test]
    fn dirname_spaced_path_warns() {
        let r = resolve_argv(&args(&["dirname", "/project/my file/sub"]), "/");
        assert!(r.warnings.iter().any(|w| w.contains("spaces")));
        assert_eq!(r.predicted_targets[0].path, "/project/my file");
        assert!(r.predicted_targets[0].has_space_risk);
    }

    #[test]
    fn dirname_resolves_parent() {
        let r = resolve_argv(&args(&["dirname", "/a/b/c"]), "/");
        assert_eq!(r.predicted_targets[0].path, "/a/b");
        assert_eq!(r.confidence, Confidence::Resolved);
    }

    // ── unsupported constructs ────────────────────────────────────────────────

    #[test]
    fn unknown_command_is_unsupported() {
        let r = resolve_argv(&args(&["find", "/", "-exec", "rm", "{}", ";"]), "/");
        assert_eq!(r.confidence, Confidence::Unsupported);
        assert!(!r.supported);
    }

    #[test]
    fn shell_string_pipe_is_unsupported() {
        let r = resolve_shell_string("ls /project | xargs rm", "/project");
        assert_eq!(r.confidence, Confidence::Unsupported);
    }

    #[test]
    fn empty_argv_is_unsupported() {
        let r = resolve_argv(&[], "/");
        assert_eq!(r.confidence, Confidence::Unsupported);
    }

    #[test]
    fn shell_string_rm_unquoted_path_with_space_warns() {
        // A path with a space that was NOT quoted — IFS split risk.
        let r = resolve_shell_string("rm /project/my\\ file.txt", "/");
        // After tokenisation: rm "/project/my file.txt" (backslash escape)
        assert_eq!(r.confidence, Confidence::Resolved);
        assert!(r.predicted_targets[0].has_space_risk);
    }
}
