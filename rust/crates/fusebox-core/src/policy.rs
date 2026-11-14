//! Policy evaluator — evaluates an ExecRequest against an IntentContract.
//!
//! This module owns the deterministic `policy_dry_run` function, the
//! `request_scope_expansion` approval path, and the intent contract hash.
//!
//! ## Policy rules (evaluated in order)
//!
//! 1. Empty executable → deny `INVALID_EXECUTABLE`
//! 2. Null byte in executable or any argv element → deny `INVALID_PATH`
//! 3. Empty workspace roots and cwd outside roots → deny `CWD_OUTSIDE_WORKSPACE`
//! 4. cwd is not a prefix of any workspace root (or equal) → deny `CWD_OUTSIDE_WORKSPACE`
//! 5. Shell resolver runs on the request; if unsupported in strict mode → deny/escalate
//! 6. Any predicted target is inside a protected root → deny `PROTECTED_ROOT_WRITE`
//! 7. Any predicted target is outside declared write roots (for destructive commands)
//!    → deny/escalate `OUTSIDE_WRITE_ROOT`
//! 8. All checks pass → allow/log based on command class and approval policy

use sha2::{Digest, Sha256};

use crate::contracts::{
    ApprovalPolicy, ExecRequest, IntentContract, PolicyDecision, ResolutionStatus, Verdict,
};
use crate::resolver::{resolve_argv, Confidence, Resolution};

// ── Public entry points ───────────────────────────────────────────────────────

/// Evaluate an `ExecRequest` against an `IntentContract` without executing
/// anything.
///
/// Returns a deterministic `PolicyDecision` and the resolver `Resolution` used
/// to produce it. The `Resolution` is returned separately so the caller can
/// include it in receipts (for provenance) without duplicating data in the
/// `PolicyDecision`.
pub fn policy_dry_run(
    request: &ExecRequest,
    contract: &IntentContract,
) -> (PolicyDecision, Resolution) {
    let policy_hash = compute_policy_hash(contract);

    // Rule 1: Empty executable.
    if request.executable.is_empty() {
        let resolution = Resolution {
            resolver_version: crate::resolver::RESOLVER_VERSION.to_string(),
            command_class: crate::resolver::CommandClass::Unsupported,
            executable: String::new(),
            parsed_argv: request.argv.clone(),
            cwd: request.cwd.clone(),
            predicted_targets: vec![],
            confidence: Confidence::Unsupported,
            warnings: vec!["empty executable".to_string()],
            supported: false,
        };
        return (
            PolicyDecision {
                verdict: Verdict::Deny,
                rule_id: Some("exec-invalid-executable".to_string()),
                reason_code: "INVALID_EXECUTABLE".to_string(),
                predicted_targets: vec![],
                resolution_status: ResolutionStatus::Unsupported,
                required_backend: None,
                user_action_required: false,
                policy_hash,
            },
            resolution,
        );
    }

    // Rule 2: Null bytes.
    if request.executable.contains('\0') || request.argv.iter().any(|a| a.contains('\0')) {
        let resolution = Resolution {
            resolver_version: crate::resolver::RESOLVER_VERSION.to_string(),
            command_class: crate::resolver::CommandClass::Unsupported,
            executable: request.executable.clone(),
            parsed_argv: request.argv.clone(),
            cwd: request.cwd.clone(),
            predicted_targets: vec![],
            confidence: Confidence::Unsupported,
            warnings: vec!["null byte in path argument".to_string()],
            supported: false,
        };
        return (
            PolicyDecision {
                verdict: Verdict::Deny,
                rule_id: Some("exec-invalid-path".to_string()),
                reason_code: "INVALID_PATH".to_string(),
                predicted_targets: vec![],
                resolution_status: ResolutionStatus::Unsupported,
                required_backend: None,
                user_action_required: false,
                policy_hash,
            },
            resolution,
        );
    }

    // Rule 3 & 4: cwd must be inside a workspace root.
    if !cwd_within_workspace(&request.cwd, &contract.workspace_roots) {
        let resolution = Resolution {
            resolver_version: crate::resolver::RESOLVER_VERSION.to_string(),
            command_class: crate::resolver::CommandClass::Unsupported,
            executable: request.executable.clone(),
            parsed_argv: request.argv.clone(),
            cwd: request.cwd.clone(),
            predicted_targets: vec![],
            confidence: Confidence::Unsupported,
            warnings: vec![format!(
                "cwd '{}' is not within any workspace root",
                request.cwd
            )],
            supported: false,
        };
        return (
            PolicyDecision {
                verdict: Verdict::Deny,
                rule_id: Some("exec-cwd-outside-workspace".to_string()),
                reason_code: "CWD_OUTSIDE_WORKSPACE".to_string(),
                predicted_targets: vec![],
                resolution_status: ResolutionStatus::Unsupported,
                required_backend: None,
                user_action_required: false,
                policy_hash,
            },
            resolution,
        );
    }

    // Rule 5: Run the resolver.
    let resolution = resolve_argv(&request.executable, &request.argv, &request.cwd);

    // Unsupported syntax in strict (Deny) policy → deny.
    if resolution.confidence == Confidence::Unsupported && !resolution.supported {
        let verdict = match contract.approval_policy {
            ApprovalPolicy::Deny => Verdict::Deny,
            ApprovalPolicy::Escalate => Verdict::Escalate,
            ApprovalPolicy::Log => Verdict::Unsupported,
        };
        let user_action = matches!(verdict, Verdict::Escalate);
        return (
            PolicyDecision {
                verdict,
                rule_id: Some("exec-unsupported-command".to_string()),
                reason_code: "UNSUPPORTED_COMMAND".to_string(),
                predicted_targets: vec![],
                resolution_status: ResolutionStatus::Unsupported,
                required_backend: None,
                user_action_required: user_action,
                policy_hash,
            },
            resolution,
        );
    }

    let predicted_path_strings: Vec<String> = resolution
        .predicted_targets
        .iter()
        .map(|t| t.path.clone())
        .collect();

    // Rule 6: Protected root write.
    for target_path in &predicted_path_strings {
        if path_within_any(target_path, &contract.protected_roots) {
            return (
                PolicyDecision {
                    verdict: Verdict::Deny,
                    rule_id: Some("exec-protected-root".to_string()),
                    reason_code: "PROTECTED_ROOT_WRITE".to_string(),
                    predicted_targets: predicted_path_strings.clone(),
                    resolution_status: resolution_status_from(&resolution),
                    required_backend: None,
                    user_action_required: false,
                    policy_hash,
                },
                resolution,
            );
        }
    }

    // Rule 7: Destructive commands must stay within write roots.
    if is_destructive_command(&resolution.command_class) && !contract.write_roots.is_empty() {
        for target_path in &predicted_path_strings {
            if !path_within_any(target_path, &contract.write_roots) {
                let verdict = match contract.approval_policy {
                    ApprovalPolicy::Deny => Verdict::Deny,
                    ApprovalPolicy::Escalate => Verdict::Escalate,
                    ApprovalPolicy::Log => Verdict::Log,
                };
                let user_action = matches!(verdict, Verdict::Escalate);
                return (
                    PolicyDecision {
                        verdict,
                        rule_id: Some("exec-outside-write-root".to_string()),
                        reason_code: "OUTSIDE_WRITE_ROOT".to_string(),
                        predicted_targets: predicted_path_strings.clone(),
                        resolution_status: resolution_status_from(&resolution),
                        required_backend: None,
                        user_action_required: user_action,
                        policy_hash,
                    },
                    resolution,
                );
            }
        }
    }

    // Rule 8: All checks pass.
    let resolution_status = resolution_status_from(&resolution);

    // For Partial resolution, escalate or log rather than silently allowing.
    let verdict = if resolution.confidence == Confidence::Partial {
        match contract.approval_policy {
            ApprovalPolicy::Deny => Verdict::Escalate,
            ApprovalPolicy::Escalate => Verdict::Escalate,
            ApprovalPolicy::Log => Verdict::Log,
        }
    } else {
        Verdict::Allow
    };

    let user_action = matches!(verdict, Verdict::Escalate);

    (
        PolicyDecision {
            verdict,
            rule_id: Some("exec-in-scope".to_string()),
            reason_code: if resolution.confidence == Confidence::Partial {
                "PARTIAL_RESOLUTION".to_string()
            } else {
                "WITHIN_SCOPE".to_string()
            },
            predicted_targets: predicted_path_strings,
            resolution_status,
            required_backend: None,
            user_action_required: user_action,
            policy_hash,
        },
        resolution,
    )
}

// ── Scope-expansion approval path ─────────────────────────────────────────────

/// Result of a scope-expansion request.
#[derive(Debug, Clone, PartialEq)]
pub enum ScopeExpansionResult {
    /// The human approved the expansion; `updated_contract` has the new scope.
    Approved {
        updated_contract: Box<IntentContract>,
        /// New policy hash for the updated contract.
        new_policy_hash: String,
    },
    /// The human rejected or did not respond within the timeout.
    Denied,
}

/// Propose a scope expansion to the human operator.
///
/// This is called when a supervised operation needs a path that is outside the
/// current write roots. The operation is paused until the human approves or
/// rejects through the CLI prompt or local UI.
///
/// In this implementation the approval is modelled as a synchronous function
/// call with a callback (`approval_fn`), which the CLI layer supplies. The
/// callback receives `(requested_path, reason)` and returns `true` for approval.
/// Rejection or any error returns `Denied`.
///
/// On approval, the path is added to `write_roots` and the `policy_hash` is
/// recomputed. The updated contract is returned; the caller must persist it
/// before resuming the paused operation.
pub fn request_scope_expansion(
    contract: &IntentContract,
    requested_path: &str,
    reason: &str,
    approval_fn: impl FnOnce(&str, &str) -> bool,
) -> ScopeExpansionResult {
    if !approval_fn(requested_path, reason) {
        return ScopeExpansionResult::Denied;
    }

    let mut updated = contract.clone();
    if !updated.write_roots.contains(&requested_path.to_string()) {
        updated.write_roots.push(requested_path.to_string());
    }
    let new_policy_hash = compute_policy_hash(&updated);
    updated.policy_hash = Some(new_policy_hash.clone());

    ScopeExpansionResult::Approved {
        updated_contract: Box::new(updated),
        new_policy_hash,
    }
}

// ── Policy hash ───────────────────────────────────────────────────────────────

/// Compute a SHA-256 hex digest of the canonical JSON serialization of the
/// contract, excluding the `policyHash` field itself.
///
/// The hash is deterministic for a given contract state. It is stored in
/// receipts to tie each decision to a specific policy snapshot.
pub fn compute_policy_hash(contract: &IntentContract) -> String {
    let mut c = contract.clone();
    c.policy_hash = None; // exclude the hash field from the input
    let canonical = serde_json::to_string(&c).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Returns `true` if `cwd` is equal to or a child of any of the `roots`.
fn cwd_within_workspace(cwd: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    roots.iter().any(|root| path_is_prefix(root, cwd))
}

/// Returns `true` if `path` is equal to or a child of any of the `roots`.
fn path_within_any(path: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| path_is_prefix(root, path))
}

/// Returns `true` if `prefix` is a path prefix of `path` (both normalized).
///
/// A prefix matches if `path == prefix` or `path` starts with `prefix/`.
fn path_is_prefix(prefix: &str, path: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    let path = path.trim_end_matches('/');
    if prefix.is_empty() {
        return true;
    }
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn is_destructive_command(class: &crate::resolver::CommandClass) -> bool {
    matches!(
        class,
        crate::resolver::CommandClass::Remove | crate::resolver::CommandClass::Move
    )
}

fn resolution_status_from(resolution: &Resolution) -> ResolutionStatus {
    match resolution.confidence {
        Confidence::Resolved => ResolutionStatus::Resolved,
        Confidence::Partial => ResolutionStatus::Partial,
        Confidence::Unsupported => ResolutionStatus::Unsupported,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{ApprovalPolicy, NetworkPolicy, SCHEMA_VERSION};

    fn base_contract() -> IntentContract {
        IntentContract {
            schema_version: SCHEMA_VERSION.to_string(),
            session_id: "sess-test".to_string(),
            workspace_roots: vec!["/project".to_string()],
            read_roots: vec!["/project".to_string()],
            write_roots: vec!["/project/src".to_string()],
            protected_roots: vec!["/project/.fusebox".to_string()],
            allowed_command_classes: vec!["build".to_string(), "test".to_string()],
            network_policy: NetworkPolicy::DenyAll,
            approval_policy: ApprovalPolicy::Deny,
            expires_at: None,
            policy_hash: None,
        }
    }

    fn request_for(executable: &str, argv: &[&str]) -> ExecRequest {
        crate::contracts::ExecRequest {
            protocol_version: SCHEMA_VERSION.to_string(),
            request_id: "req-test".to_string(),
            session_id: "sess-test".to_string(),
            executable: executable.to_string(),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            cwd: "/project".to_string(),
            env_allowlist: vec![],
            timeout_ms: None,
            requested_capabilities: vec![],
        }
    }

    // ── Red-phase edge cases ──────────────────────────────────────────────────

    #[test]
    fn deny_empty_executable() {
        let (decision, _) = policy_dry_run(&request_for("", &[]), &base_contract());
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "INVALID_EXECUTABLE");
    }

    #[test]
    fn deny_null_byte_in_argv() {
        let (decision, _) = policy_dry_run(
            &request_for("/bin/cat", &["/project/src/main.rs\x00/etc/shadow"]),
            &base_contract(),
        );
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "INVALID_PATH");
    }

    #[test]
    fn deny_cwd_outside_workspace() {
        let mut req = request_for("/usr/bin/cargo", &["test"]);
        req.cwd = "/tmp/attacker".to_string();
        let (decision, _) = policy_dry_run(&req, &base_contract());
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "CWD_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn deny_protected_root_write() {
        let (decision, _) = policy_dry_run(
            &request_for("/bin/rm", &["/project/.fusebox/policy.json"]),
            &base_contract(),
        );
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "PROTECTED_ROOT_WRITE");
    }

    #[test]
    fn deny_outside_write_root() {
        // rm targeting /tmp — outside write roots.
        let mut req = request_for("/bin/rm", &["/tmp/evil"]);
        req.cwd = "/project".to_string();
        let (decision, _) = policy_dry_run(&req, &base_contract());
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "OUTSIDE_WRITE_ROOT");
    }

    #[test]
    fn deny_traversal_resolves_and_is_denied() {
        // Path traversal that escapes the workspace must be denied.
        let (decision, resolution) = policy_dry_run(
            &request_for("/bin/rm", &["-rf", "/project/src/../../etc/passwd"]),
            &base_contract(),
        );
        // Resolved to /etc/passwd — outside write root.
        assert!(resolution
            .predicted_targets
            .iter()
            .any(|t| t.path == "/etc/passwd"));
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "OUTSIDE_WRITE_ROOT");
    }

    #[test]
    fn deny_unsupported_command_in_strict_policy() {
        let (decision, _) =
            policy_dry_run(&request_for("bash", &["-c", "rm -rf /"]), &base_contract());
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "UNSUPPORTED_COMMAND");
    }

    // ── Green-phase allow cases ───────────────────────────────────────────────

    #[test]
    fn allow_rm_within_write_root() {
        let (decision, _) = policy_dry_run(
            &request_for("/bin/rm", &["/project/src/old.rs"]),
            &base_contract(),
        );
        assert_eq!(decision.verdict, Verdict::Allow);
        assert_eq!(decision.reason_code, "WITHIN_SCOPE");
    }

    #[test]
    fn allow_cargo_test_as_unsupported_command_logs() {
        // cargo is not a supported resolver command → UNSUPPORTED_COMMAND.
        // Default approval policy is Deny so this returns Deny.
        let (decision, _) =
            policy_dry_run(&request_for("/usr/bin/cargo", &["test"]), &base_contract());
        // cargo is unsupported, strict policy → Deny
        assert_eq!(decision.verdict, Verdict::Deny);
        assert_eq!(decision.reason_code, "UNSUPPORTED_COMMAND");
    }

    #[test]
    fn allow_unsupported_command_with_log_policy() {
        let mut contract = base_contract();
        contract.approval_policy = ApprovalPolicy::Log;
        let (decision, _) = policy_dry_run(&request_for("/usr/bin/cargo", &["test"]), &contract);
        // Unsupported → Verdict::Unsupported with log policy.
        assert_eq!(decision.verdict, Verdict::Unsupported);
    }

    #[test]
    fn escalate_unsupported_command_with_escalate_policy() {
        let mut contract = base_contract();
        contract.approval_policy = ApprovalPolicy::Escalate;
        let (decision, _) = policy_dry_run(&request_for("/usr/bin/cargo", &["test"]), &contract);
        assert_eq!(decision.verdict, Verdict::Escalate);
        assert!(decision.user_action_required);
    }

    // ── xargs dirname incident class ──────────────────────────────────────────

    #[test]
    fn xargs_dirname_spaced_path_denied_via_policy() {
        // The spaced-path incident: xargs splits the path.
        // Target resolves to /project (the project root itself) — inside
        // workspace but NOT inside write root /project/src → deny.
        let (decision, resolution) = policy_dry_run(
            &request_for("xargs", &["dirname", "/project/src my docs/file.txt"]),
            &base_contract(),
        );
        assert!(resolution.warnings.iter().any(|w| w.contains("splits to")));
        // xargs splits "/project/src my docs/file.txt" → dirname "/project/src" → "/project"
        // /project is NOT a write root (write root is /project/src), so OUTSIDE_WRITE_ROOT.
        assert!(matches!(
            decision.verdict,
            Verdict::Deny | Verdict::Escalate
        ));
    }

    // ── policy hash stability ─────────────────────────────────────────────────

    #[test]
    fn policy_hash_is_deterministic() {
        let c = base_contract();
        let h1 = compute_policy_hash(&c);
        let h2 = compute_policy_hash(&c);
        assert_eq!(h1, h2);
    }

    #[test]
    fn policy_hash_changes_when_contract_changes() {
        let c1 = base_contract();
        let mut c2 = c1.clone();
        c2.write_roots.push("/project/extra".to_string());
        assert_ne!(compute_policy_hash(&c1), compute_policy_hash(&c2));
    }

    #[test]
    fn policy_hash_excludes_policy_hash_field() {
        let mut c1 = base_contract();
        let mut c2 = c1.clone();
        c1.policy_hash = None;
        c2.policy_hash = Some("something".to_string());
        // Both should produce the same hash because policyHash is excluded.
        assert_eq!(compute_policy_hash(&c1), compute_policy_hash(&c2));
    }

    // ── scope expansion ───────────────────────────────────────────────────────

    #[test]
    fn scope_expansion_approval_adds_write_root() {
        let contract = base_contract();
        let result = request_scope_expansion(
            &contract,
            "/project/extra",
            "need to write generated files",
            |_path, _reason| true,
        );
        match result {
            ScopeExpansionResult::Approved {
                updated_contract,
                new_policy_hash,
            } => {
                assert!(updated_contract
                    .write_roots
                    .contains(&"/project/extra".to_string()));
                assert_eq!(updated_contract.policy_hash, Some(new_policy_hash));
            }
            ScopeExpansionResult::Denied => panic!("expected Approved"),
        }
    }

    #[test]
    fn scope_expansion_rejection_stays_denied() {
        let contract = base_contract();
        let result = request_scope_expansion(
            &contract,
            "/project/extra",
            "need to write generated files",
            |_path, _reason| false,
        );
        assert_eq!(result, ScopeExpansionResult::Denied);
    }

    #[test]
    fn scope_expansion_idempotent_for_duplicate_path() {
        let contract = base_contract();
        let result = request_scope_expansion(
            &contract,
            "/project/src", // already in write_roots
            "duplicate",
            |_path, _reason| true,
        );
        match result {
            ScopeExpansionResult::Approved {
                updated_contract, ..
            } => {
                let count = updated_contract
                    .write_roots
                    .iter()
                    .filter(|r| *r == "/project/src")
                    .count();
                assert_eq!(count, 1, "duplicate path must not be added twice");
            }
            ScopeExpansionResult::Denied => panic!("expected Approved"),
        }
    }

    // ── path_is_prefix ────────────────────────────────────────────────────────

    #[test]
    fn path_is_prefix_exact_match() {
        assert!(path_is_prefix("/project", "/project"));
    }

    #[test]
    fn path_is_prefix_child_path() {
        assert!(path_is_prefix("/project", "/project/src/main.rs"));
    }

    #[test]
    fn path_is_prefix_does_not_match_sibling() {
        assert!(!path_is_prefix("/project", "/project2/src"));
    }

    #[test]
    fn path_is_prefix_trailing_slash_normalized() {
        assert!(path_is_prefix("/project/", "/project/src"));
    }
}
