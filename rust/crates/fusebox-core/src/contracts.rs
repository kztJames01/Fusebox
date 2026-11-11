//! Versioned execution contracts: IntentContract, ExecRequest, PolicyDecision.
//!
//! These types are the stable JSON surface between the CLI, the MCP adapter
//! and external callers. Unknown fields are ignored on deserialize
//! (`deny_unknown_fields` is deliberately absent) so older readers can consume
//! newer wire payloads without failing.

use serde::{Deserialize, Serialize};

/// Schema version string used in all contract types.
pub const SCHEMA_VERSION: &str = "1";

// ── IntentContract ────────────────────────────────────────────────────────────

/// A bounded session declaration produced by `fusebox init` and owned by the
/// developer. The agent may propose it; the developer approves and signs it.
///
/// JSON field names are the stable surface; Rust field names follow Rust
/// conventions and map via `rename_all`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentContract {
    /// Always `"1"` for this revision.
    pub schema_version: String,
    /// Opaque session identifier. Callers generate this; Fusebox records it.
    pub session_id: String,
    /// Canonical absolute path(s) that define the project boundary.
    pub workspace_roots: Vec<String>,
    /// Paths where the supervised process may read. Subset of `workspace_roots`
    /// or explicit additions. Empty means no reads are permitted outside
    /// `workspace_roots`.
    #[serde(default)]
    pub read_roots: Vec<String>,
    /// Paths where the supervised process may write.
    #[serde(default)]
    pub write_roots: Vec<String>,
    /// Paths that must never be modified or deleted in this session.
    #[serde(default)]
    pub protected_roots: Vec<String>,
    /// Coarse command-class allowlist (e.g. `["build", "test", "format"]`).
    /// An empty list means no command classes are pre-approved; each execution
    /// is evaluated individually.
    #[serde(default)]
    pub allowed_command_classes: Vec<String>,
    /// Outbound network policy for supervised children.
    pub network_policy: NetworkPolicy,
    /// How the policy reacts to out-of-scope operations.
    pub approval_policy: ApprovalPolicy,
    /// ISO-8601 UTC expiry. `None` means the contract has no hard expiry but
    /// is still bound to the session lifetime.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// SHA-256 hex digest of the canonical JSON serialization of this contract,
    /// excluding the `policyHash` field itself. Set by the writer; verified by
    /// the receipt chain.
    #[serde(default)]
    pub policy_hash: Option<String>,
}

/// Outbound network policy applied to supervised child processes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    /// All outbound connections are denied (default).
    DenyAll,
    /// Only the listed hosts/CIDRs are reachable.
    Allowlist,
    /// Outbound is unrestricted (logging only). Not recommended.
    Allow,
}

/// How the policy engine reacts to an out-of-scope operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// Deny the operation immediately.
    Deny,
    /// Pause and prompt the human for a scoped approval.
    Escalate,
    /// Allow and record for later review.
    Log,
}

// ── ExecRequest ───────────────────────────────────────────────────────────────

/// A single supervised execution request. The caller supplies this; Fusebox
/// validates it against the active `IntentContract` and produces a
/// `PolicyDecision`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    /// Protocol version — always `"1"`.
    pub protocol_version: String,
    /// Unique identifier for this request within the session.
    pub request_id: String,
    /// Session this request belongs to; must match an active `IntentContract`.
    pub session_id: String,
    /// Absolute path to the executable. Never a shell string — use `argv` for
    /// arguments.
    pub executable: String,
    /// Arguments passed to the executable. Must not include the executable
    /// itself (index 0 is the first real argument).
    pub argv: Vec<String>,
    /// Working directory for the child process. Must be within
    /// `workspace_roots`.
    pub cwd: String,
    /// Explicit environment variable allowlist. Only listed variables are
    /// forwarded to the child. Callers must not use this to pass secrets unless
    /// the intent contract explicitly permits it.
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    /// Maximum wall-clock time in milliseconds before the child is killed.
    /// `None` means the session default applies.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Capabilities the caller believes are needed (e.g. `["network_write"]`).
    /// Informational; the policy engine makes the authoritative decision.
    #[serde(default)]
    pub requested_capabilities: Vec<String>,
}

// ── PolicyDecision ────────────────────────────────────────────────────────────

/// The deterministic outcome of evaluating an `ExecRequest` against an active
/// `IntentContract`. Produced before any execution attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    /// The authorization verdict.
    pub verdict: Verdict,
    /// Identifier of the policy rule that produced this verdict.
    #[serde(default)]
    pub rule_id: Option<String>,
    /// Machine-readable reason code (e.g. `"OUTSIDE_WRITE_ROOT"`).
    pub reason_code: String,
    /// Predicted filesystem targets the resolver believes will be affected.
    /// May be empty when the resolver returns `unsupported`.
    #[serde(default)]
    pub predicted_targets: Vec<String>,
    /// Whether the resolver could fully evaluate the request.
    pub resolution_status: ResolutionStatus,
    /// Enforcement backend required to honour this verdict on the current OS.
    #[serde(default)]
    pub required_backend: Option<String>,
    /// Whether a human action is needed before the operation may proceed.
    pub user_action_required: bool,
    /// Hash of the `IntentContract` that produced this decision. Recorded in
    /// the receipt to tie the decision to a specific policy snapshot.
    pub policy_hash: String,
}

/// Authorization verdict returned by the policy engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Operation is within scope; proceed.
    Allow,
    /// Operation is within scope; proceed and record for review.
    Log,
    /// Operation is outside scope; pause and prompt the human.
    Escalate,
    /// Operation is denied; do not proceed.
    Deny,
    /// The resolver could not evaluate the request; treat as deny in strict
    /// mode.
    Unsupported,
}

/// Whether the pre-resolver could fully evaluate the requested operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus {
    /// All predicted targets were resolved.
    Resolved,
    /// Some targets could not be resolved (e.g. glob expansion incomplete).
    Partial,
    /// The operation syntax is not supported by the resolver.
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_intent() -> IntentContract {
        IntentContract {
            schema_version: SCHEMA_VERSION.to_string(),
            session_id: "sess-001".to_string(),
            workspace_roots: vec!["/project".to_string()],
            read_roots: vec![],
            write_roots: vec![],
            protected_roots: vec![],
            allowed_command_classes: vec![],
            network_policy: NetworkPolicy::DenyAll,
            approval_policy: ApprovalPolicy::Deny,
            expires_at: None,
            policy_hash: None,
        }
    }

    fn minimal_request() -> ExecRequest {
        ExecRequest {
            protocol_version: SCHEMA_VERSION.to_string(),
            request_id: "req-001".to_string(),
            session_id: "sess-001".to_string(),
            executable: "/usr/bin/cargo".to_string(),
            argv: vec!["test".to_string()],
            cwd: "/project".to_string(),
            env_allowlist: vec![],
            timeout_ms: None,
            requested_capabilities: vec![],
        }
    }

    // ── IntentContract round-trip ─────────────────────────────────────────────

    #[test]
    fn intent_contract_round_trips() {
        let contract = minimal_intent();
        let json = serde_json::to_string(&contract).unwrap();
        let decoded: IntentContract = serde_json::from_str(&json).unwrap();
        assert_eq!(contract, decoded);
    }

    #[test]
    fn intent_contract_unknown_fields_are_ignored() {
        let json = r#"{
            "schemaVersion": "1",
            "sessionId": "s",
            "workspaceRoots": ["/p"],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny",
            "unknownFutureField": true
        }"#;
        let result: Result<IntentContract, _> = serde_json::from_str(json);
        assert!(result.is_ok(), "unknown fields must not reject the payload");
    }

    #[test]
    fn intent_contract_missing_required_field_fails() {
        // session_id is required — omitting it must fail deserialization.
        let json = r#"{
            "schemaVersion": "1",
            "workspaceRoots": ["/p"],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        }"#;
        let result: Result<IntentContract, _> = serde_json::from_str(json);
        assert!(result.is_err(), "missing sessionId must fail");
    }

    #[test]
    fn intent_contract_empty_workspace_roots_is_valid() {
        // Empty workspace_roots is structurally valid; policy evaluation
        // should deny everything, but the type itself must not reject it.
        let json = r#"{
            "schemaVersion": "1",
            "sessionId": "s",
            "workspaceRoots": [],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        }"#;
        let result: Result<IntentContract, _> = serde_json::from_str(json);
        assert!(result.is_ok());
        let c = result.unwrap();
        assert!(c.workspace_roots.is_empty());
    }

    // ── ExecRequest round-trip ────────────────────────────────────────────────

    #[test]
    fn exec_request_round_trips() {
        let req = minimal_request();
        let json = serde_json::to_string(&req).unwrap();
        let decoded: ExecRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, decoded);
    }

    #[test]
    fn exec_request_unknown_fields_are_ignored() {
        let json = r#"{
            "protocolVersion": "1",
            "requestId": "r",
            "sessionId": "s",
            "executable": "/bin/sh",
            "argv": [],
            "cwd": "/p",
            "futureField": 42
        }"#;
        let result: Result<ExecRequest, _> = serde_json::from_str(json);
        assert!(result.is_ok());
    }

    #[test]
    fn exec_request_missing_executable_fails() {
        let json = r#"{
            "protocolVersion": "1",
            "requestId": "r",
            "sessionId": "s",
            "argv": [],
            "cwd": "/p"
        }"#;
        let result: Result<ExecRequest, _> = serde_json::from_str(json);
        assert!(result.is_err(), "missing executable must fail");
    }

    // ── PolicyDecision round-trip ─────────────────────────────────────────────

    #[test]
    fn policy_decision_round_trips() {
        let decision = PolicyDecision {
            verdict: Verdict::Allow,
            rule_id: Some("in-scope-write".to_string()),
            reason_code: "WITHIN_WRITE_ROOT".to_string(),
            predicted_targets: vec!["/project/src/main.rs".to_string()],
            resolution_status: ResolutionStatus::Resolved,
            required_backend: None,
            user_action_required: false,
            policy_hash: "abc123".to_string(),
        };
        let json = serde_json::to_string(&decision).unwrap();
        let decoded: PolicyDecision = serde_json::from_str(&json).unwrap();
        assert_eq!(decision, decoded);
    }

    #[test]
    fn policy_verdict_deny_serializes_as_deny() {
        let json = serde_json::to_string(&Verdict::Deny).unwrap();
        assert_eq!(json, "\"deny\"");
    }

    #[test]
    fn policy_verdict_unsupported_serializes_correctly() {
        let json = serde_json::to_string(&Verdict::Unsupported).unwrap();
        assert_eq!(json, "\"unsupported\"");
    }

    #[test]
    fn policy_decision_missing_policy_hash_fails() {
        let json = r#"{
            "verdict": "allow",
            "reasonCode": "WITHIN_WRITE_ROOT",
            "resolutionStatus": "resolved",
            "userActionRequired": false
        }"#;
        let result: Result<PolicyDecision, _> = serde_json::from_str(json);
        assert!(result.is_err(), "missing policyHash must fail");
    }

    // ── NetworkPolicy and ApprovalPolicy enums ────────────────────────────────

    #[test]
    fn network_policy_deny_all_round_trips() {
        let json = serde_json::to_string(&NetworkPolicy::DenyAll).unwrap();
        assert_eq!(json, "\"deny_all\"");
        let decoded: NetworkPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, NetworkPolicy::DenyAll);
    }

    #[test]
    fn unknown_network_policy_variant_fails() {
        let result: Result<NetworkPolicy, _> = serde_json::from_str("\"unrestricted\"");
        assert!(result.is_err(), "unknown variant must be rejected");
    }
}
