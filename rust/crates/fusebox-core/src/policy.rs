//! Policy evaluator: pure deterministic `policy_dry_run` function.
//!
//! Evaluates an [`ExecRequest`] against an [`IntentContract`] and returns a
//! [`PolicyDecision`]. No process is spawned, no I/O is performed.
//!
//! Rule evaluation order (first match wins):
//! 1. Empty executable → `deny INVALID_EXECUTABLE`
//! 2. Null byte in executable or any argv → `deny INVALID_PATH`
//! 3. cwd not within any workspace root → `deny CWD_OUTSIDE_WORKSPACE`
//! 4. Resolver returns `Unsupported` → verdict per approval policy
//! 5. Predicted target in protected roots → `deny PROTECTED_ROOT_WRITE`
//! 6. Destructive command target outside write roots → verdict per approval policy
//! 7. All pass → `allow WITHIN_SCOPE`

use sha2::{Digest, Sha256};

use crate::contracts::{
    ApprovalPolicy, ExecRequest, IntentContract, PolicyDecision, ResolutionStatus, Verdict,
};
use crate::resolver::{resolve_argv, Confidence, Resolution};

// ── Public API ────────────────────────────────────────────────────────────────

/// Evaluate a request against a contract and return the policy decision.
///
/// The resolver is run on `request.executable + request.argv` before any
/// policy rule; the result is embedded in the returned decision.
pub fn policy_dry_run(
    request: &ExecRequest,
    contract: &IntentContract,
) -> (PolicyDecision, Resolution) {
    let policy_hash = compute_policy_hash(contract);

    // Rule 1: empty executable.
    if request.executable.is_empty() {
        let res = crate::resolver::unsupported_res(vec![], &request.cwd, "empty executable");
        return (deny("INVALID_EXECUTABLE", false, &policy_hash), res);
    }

    // Rule 2: null bytes.
    if request.executable.contains('\0') || request.argv.iter().any(|a| a.contains('\0')) {
        let res = crate::resolver::unsupported_res(
            build_argv(request),
            &request.cwd,
            "null byte in executable or argv",
        );
        return (deny("INVALID_PATH", false, &policy_hash), res);
    }

    // Rule 3: cwd must be within a workspace root.
    if !is_within_any_root(&request.cwd, &contract.workspace_roots) {
        let res = crate::resolver::unsupported_res(
            build_argv(request),
            &request.cwd,
            "cwd outside workspace roots",
        );
        return (deny("CWD_OUTSIDE_WORKSPACE", false, &policy_hash), res);
    }

    // Run the resolver.
    let full_argv = build_argv(request);
    let resolution = resolve_argv(&full_argv, &request.cwd);

    // Rule 4: unsupported syntax.
    if resolution.confidence == Confidence::Unsupported {
        let verdict = match contract.approval_policy {
            ApprovalPolicy::Deny => Verdict::Deny,
            ApprovalPolicy::Escalate => Verdict::Escalate,
            ApprovalPolicy::Log => Verdict::Unsupported,
        };
        let user_action = matches!(verdict, Verdict::Escalate);
        let decision = PolicyDecision {
            verdict,
            rule_id: Some("unsupported-command".to_string()),
            reason_code: "UNSUPPORTED_COMMAND".to_string(),
            predicted_targets: vec![],
            resolution_status: ResolutionStatus::Unsupported,
            required_backend: None,
            user_action_required: user_action,
            policy_hash,
        };
        return (decision, resolution);
    }

    let predicted_paths: Vec<String> = resolution
        .predicted_targets
        .iter()
        .map(|t| t.path.clone())
        .collect();

    let resolution_status = match resolution.confidence {
        Confidence::Resolved => ResolutionStatus::Resolved,
        Confidence::Partial => ResolutionStatus::Partial,
        Confidence::Unsupported => ResolutionStatus::Unsupported,
    };

    // Rule 5: any predicted target in protected roots.
    if predicted_paths
        .iter()
        .any(|p| is_within_any_root(p, &contract.protected_roots))
    {
        let decision = PolicyDecision {
            verdict: Verdict::Deny,
            rule_id: Some("protected-root".to_string()),
            reason_code: "PROTECTED_ROOT_WRITE".to_string(),
            predicted_targets: predicted_paths,
            resolution_status,
            required_backend: None,
            user_action_required: false,
            policy_hash,
        };
        return (decision, resolution);
    }

    // Rule 6: destructive command targeting outside write roots.
    use crate::resolver::TargetKind;
    let is_destructive = matches!(
        resolution.target_kind,
        TargetKind::Delete | TargetKind::CopyOrMove | TargetKind::Write
    );

    if is_destructive
        && !contract.write_roots.is_empty()
        && predicted_paths
            .iter()
            .any(|p| !is_within_any_root(p, &contract.write_roots))
    {
        let verdict = match contract.approval_policy {
            ApprovalPolicy::Deny => Verdict::Deny,
            ApprovalPolicy::Escalate => Verdict::Escalate,
            ApprovalPolicy::Log => Verdict::Log,
        };
        let user_action = matches!(verdict, Verdict::Escalate);
        let decision = PolicyDecision {
            verdict,
            rule_id: Some("outside-write-root".to_string()),
            reason_code: "OUTSIDE_WRITE_ROOT".to_string(),
            predicted_targets: predicted_paths,
            resolution_status,
            required_backend: None,
            user_action_required: user_action,
            policy_hash,
        };
        return (decision, resolution);
    }

    // Rule 7: all pass.
    let verdict = if resolution.confidence == Confidence::Partial {
        // Partial resolution without a specific rule violation: escalate or log.
        match contract.approval_policy {
            ApprovalPolicy::Deny | ApprovalPolicy::Escalate => Verdict::Escalate,
            ApprovalPolicy::Log => Verdict::Log,
        }
    } else {
        Verdict::Allow
    };

    let user_action = matches!(verdict, Verdict::Escalate);
    let reason_code = if resolution.confidence == Confidence::Partial {
        "PARTIAL_RESOLUTION".to_string()
    } else {
        "WITHIN_SCOPE".to_string()
    };
    let decision = PolicyDecision {
        verdict,
        rule_id: Some("within-scope".to_string()),
        reason_code,
        predicted_targets: predicted_paths,
        resolution_status,
        required_backend: None,
        user_action_required: user_action,
        policy_hash,
    };

    (decision, resolution)
}

/// Expand the scope of an intent contract by adding a new write root.
///
/// The `approval_fn` callback must return `true` for the expansion to proceed.
/// On approval, the write root is added exactly once, and `policy_hash` is
/// recomputed. Returns the updated contract on success.
pub fn request_scope_expansion(
    contract: &IntentContract,
    path: &str,
    _reason: &str,
    approval_fn: impl FnOnce(&str, &str) -> bool,
) -> Option<IntentContract> {
    if !approval_fn(path, _reason) {
        return None;
    }
    let mut updated = contract.clone();
    if !updated.write_roots.contains(&path.to_string()) {
        updated.write_roots.push(path.to_string());
    }
    updated.policy_hash = Some(compute_policy_hash(&updated));
    Some(updated)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Compute SHA-256 of the canonical JSON of `contract` excluding `policyHash`.
pub fn compute_policy_hash(contract: &IntentContract) -> String {
    let mut c = contract.clone();
    c.policy_hash = None;
    let canonical = serde_json::to_string(&c).expect("IntentContract is always serializable");
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn is_within_any_root(path: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    roots.iter().any(|root| {
        // Normalize: ensure root ends with '/' for prefix check.
        let root_prefix = if root.ends_with('/') {
            root.clone()
        } else {
            format!("{root}/")
        };
        path == root || path.starts_with(&root_prefix)
    })
}

fn build_argv(request: &ExecRequest) -> Vec<String> {
    let mut v = vec![request.executable.clone()];
    v.extend(request.argv.iter().cloned());
    v
}

fn deny(reason_code: &str, user_action: bool, policy_hash: &str) -> PolicyDecision {
    PolicyDecision {
        verdict: Verdict::Deny,
        rule_id: None,
        reason_code: reason_code.to_string(),
        predicted_targets: vec![],
        resolution_status: ResolutionStatus::Unsupported,
        required_backend: None,
        user_action_required: user_action,
        policy_hash: policy_hash.to_string(),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{ApprovalPolicy, NetworkPolicy, SCHEMA_VERSION};

    fn make_contract(write_roots: &[&str], protected_roots: &[&str]) -> IntentContract {
        IntentContract {
            schema_version: SCHEMA_VERSION.to_string(),
            session_id: "sess-test".to_string(),
            workspace_roots: vec!["/project".to_string()],
            read_roots: vec!["/project".to_string()],
            write_roots: write_roots.iter().map(|s| s.to_string()).collect(),
            protected_roots: protected_roots.iter().map(|s| s.to_string()).collect(),
            allowed_command_classes: vec![],
            network_policy: NetworkPolicy::DenyAll,
            approval_policy: ApprovalPolicy::Deny,
            expires_at: None,
            policy_hash: None,
        }
    }

    fn make_request(executable: &str, argv: &[&str]) -> ExecRequest {
        ExecRequest {
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

    #[test]
    fn empty_executable_is_denied() {
        let contract = make_contract(&[], &[]);
        let req = make_request("", &[]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "INVALID_EXECUTABLE");
    }

    #[test]
    fn null_byte_in_executable_is_denied() {
        let contract = make_contract(&[], &[]);
        let mut req = make_request("/bin/rm", &[]);
        req.executable = "/bin/r\0m".to_string();
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "INVALID_PATH");
    }

    #[test]
    fn cwd_outside_workspace_is_denied() {
        let contract = make_contract(&[], &[]);
        let mut req = make_request("/bin/ls", &[]);
        req.cwd = "/home/user".to_string();
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "CWD_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn unsupported_command_with_deny_policy_returns_deny() {
        let contract = make_contract(&["/project"], &[]);
        let req = make_request("find", &["/", "-exec", "rm", "{}", ";"]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "UNSUPPORTED_COMMAND");
    }

    #[test]
    fn unsupported_command_with_escalate_policy_returns_escalate() {
        let mut contract = make_contract(&["/project"], &[]);
        contract.approval_policy = ApprovalPolicy::Escalate;
        let req = make_request("find", &[]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Escalate);
        assert!(dec.user_action_required);
    }

    #[test]
    fn protected_root_write_is_denied() {
        let contract = make_contract(&["/project"], &["/project/.fusebox"]);
        let req = make_request("rm", &["/project/.fusebox/policy.json"]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "PROTECTED_ROOT_WRITE");
    }

    #[test]
    fn write_outside_write_roots_is_denied() {
        // write_roots limits to /project; target is /etc
        let contract = make_contract(&["/project"], &[]);
        let req = make_request("rm", &["/etc/passwd"]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Deny);
        assert_eq!(dec.reason_code, "OUTSIDE_WRITE_ROOT");
    }

    #[test]
    fn in_scope_rm_is_allowed() {
        let contract = make_contract(&["/project"], &[]);
        let req = make_request("rm", &["/project/tmp/build"]);
        let (dec, _) = policy_dry_run(&req, &contract);
        assert_eq!(dec.verdict, Verdict::Allow);
        assert_eq!(dec.reason_code, "WITHIN_SCOPE");
    }

    #[test]
    fn policy_hash_is_embedded_in_decision() {
        let contract = make_contract(&["/project"], &[]);
        let req = make_request("rm", &["/project/file"]);
        let (dec, _) = policy_dry_run(&req, &contract);
        let expected = compute_policy_hash(&contract);
        assert_eq!(dec.policy_hash, expected);
    }

    #[test]
    fn scope_expansion_adds_write_root() {
        let contract = make_contract(&["/project"], &[]);
        let updated = request_scope_expansion(&contract, "/other", "need access", |_, _| true);
        assert!(updated.is_some());
        let c = updated.unwrap();
        assert!(c.write_roots.contains(&"/other".to_string()));
        // Policy hash must be recomputed.
        let expected = compute_policy_hash(&c);
        assert_eq!(c.policy_hash.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn scope_expansion_rejected_by_approval_fn_returns_none() {
        let contract = make_contract(&["/project"], &[]);
        let result = request_scope_expansion(&contract, "/other", "need access", |_, _| false);
        assert!(result.is_none());
    }

    #[test]
    fn scope_expansion_is_idempotent() {
        let contract = make_contract(&["/project"], &[]);
        let updated = request_scope_expansion(&contract, "/project", "already there", |_, _| true);
        assert!(updated.is_some());
        let c = updated.unwrap();
        // /project should appear exactly once.
        assert_eq!(c.write_roots.iter().filter(|p| *p == "/project").count(), 1);
    }
}
