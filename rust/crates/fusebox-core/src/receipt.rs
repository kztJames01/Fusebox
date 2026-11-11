//! CommandReceipt — the canonical per-execution record appended to the local
//! JSONL journal. Rust is the only writer; TypeScript reads through the CLI.

use serde::{Deserialize, Serialize};

use crate::contracts::{PolicyDecision, SCHEMA_VERSION};

// ── CommandReceipt ────────────────────────────────────────────────────────────

/// One entry in the hash-chained local execution journal.
///
/// The `record_hash` field covers the canonical serialization of all other
/// fields in this record plus `previous_hash`. The `previous_hash` field is
/// empty for the first record. Verifying the chain means recomputing
/// `record_hash` for every record and confirming that each `previous_hash`
/// matches the `record_hash` of the preceding entry.
///
/// A hash chain is tamper-evident, not tamper-proof. An administrator who can
/// rewrite the entire journal can rebuild an internally consistent chain.
/// External signatures are a later option and must not be implied by the
/// local hash alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    /// Always `"1"` for this revision.
    pub schema_version: String,
    /// Unique identifier for this receipt.
    pub receipt_id: String,
    /// Monotonically increasing sequence number within the session journal.
    pub sequence: u64,
    /// ISO-8601 UTC timestamp when the record was written.
    pub recorded_at: String,
    /// Session this execution belongs to.
    pub session_id: String,
    /// Identifier of the originating `ExecRequest`.
    pub request_id: String,
    /// Human-readable summary of what was requested (never contains secrets).
    pub request_summary: RequestSummary,
    /// The policy decision that preceded this execution attempt.
    pub policy_decision: PolicyDecision,
    /// OS-level enforcement details.
    pub enforcement: EnforcementRecord,
    /// How the process terminated (or was denied before starting).
    pub process_outcome: ProcessOutcome,
    /// Digests of bounded stdout/stderr — raw output is excluded by default.
    #[serde(default)]
    pub output_digests: Option<OutputDigests>,
    /// `record_hash` of the preceding receipt, or an empty string for the
    /// first record.
    pub previous_hash: String,
    /// SHA-256 hex digest of the canonical serialization of this record
    /// (excluding this field itself).
    pub record_hash: String,
}

/// Redacted summary of the originating request, safe to include in the journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSummary {
    /// Basename of the executable (e.g. `"cargo"`).
    pub executable_name: String,
    /// Number of arguments (the argv length, not a reproduction of them).
    pub argc: usize,
    /// Working directory at invocation time.
    pub cwd: String,
}

/// Result of applying OS-level confinement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementRecord {
    /// The enforcement backend that was active (e.g. `"landlock"`, `"none"`).
    pub backend: String,
    /// Whether confinement was successfully applied before exec.
    pub applied: bool,
    /// Detected kernel / ABI capability version, if available.
    #[serde(default)]
    pub detected_abi: Option<String>,
    /// Human-readable note about any limitation or partial enforcement.
    #[serde(default)]
    pub note: Option<String>,
}

/// How a supervised execution attempt concluded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutcome {
    /// Terminal state.
    pub state: ProcessState,
    /// Exit code, if the process started and terminated normally.
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// Wall-clock duration in milliseconds, if the process started.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// Signal number if the process was killed by a signal (Unix only).
    #[serde(default)]
    pub signal: Option<i32>,
}

/// Terminal state of a supervised process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    /// The policy denied the operation before any process was started.
    Denied,
    /// The process started successfully.
    Started,
    /// The process completed (exit code may be non-zero).
    Completed,
    /// The process was cancelled by the caller or timed out.
    Cancelled,
    /// The process failed to start (OS error, not a policy denial).
    Failed,
}

/// SHA-256 digests of bounded stdout/stderr captures. Raw bytes are discarded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDigests {
    /// Hex digest of the bounded stdout capture, if any.
    #[serde(default)]
    pub stdout_sha256: Option<String>,
    /// Hex digest of the bounded stderr capture, if any.
    #[serde(default)]
    pub stderr_sha256: Option<String>,
    /// Whether stdout was truncated before hashing.
    #[serde(default)]
    pub stdout_truncated: bool,
    /// Whether stderr was truncated before hashing.
    #[serde(default)]
    pub stderr_truncated: bool,
}

/// Build a [`CommandReceipt`] for a denied operation (no process started).
///
/// The caller is responsible for supplying the correct `previous_hash` and
/// must call [`crate::verify::hash_receipt`] to fill `record_hash` before
/// writing to the journal.
#[allow(clippy::too_many_arguments)]
pub fn denied_receipt(
    receipt_id: impl Into<String>,
    sequence: u64,
    recorded_at: impl Into<String>,
    session_id: impl Into<String>,
    request_id: impl Into<String>,
    executable_name: impl Into<String>,
    argc: usize,
    cwd: impl Into<String>,
    policy_decision: PolicyDecision,
    previous_hash: impl Into<String>,
) -> CommandReceipt {
    CommandReceipt {
        schema_version: SCHEMA_VERSION.to_string(),
        receipt_id: receipt_id.into(),
        sequence,
        recorded_at: recorded_at.into(),
        session_id: session_id.into(),
        request_id: request_id.into(),
        request_summary: RequestSummary {
            executable_name: executable_name.into(),
            argc,
            cwd: cwd.into(),
        },
        policy_decision,
        enforcement: EnforcementRecord {
            backend: "none".to_string(),
            applied: false,
            detected_abi: None,
            note: Some("denied before exec".to_string()),
        },
        process_outcome: ProcessOutcome {
            state: ProcessState::Denied,
            exit_code: None,
            duration_ms: None,
            signal: None,
        },
        output_digests: None,
        previous_hash: previous_hash.into(),
        record_hash: String::new(), // caller must fill via hash_receipt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{PolicyDecision, ResolutionStatus, Verdict};

    fn test_policy_decision(verdict: Verdict) -> PolicyDecision {
        PolicyDecision {
            verdict,
            rule_id: None,
            reason_code: "TEST".to_string(),
            predicted_targets: vec![],
            resolution_status: ResolutionStatus::Resolved,
            required_backend: None,
            user_action_required: false,
            policy_hash: "deadbeef".to_string(),
        }
    }

    fn minimal_receipt(state: ProcessState) -> CommandReceipt {
        CommandReceipt {
            schema_version: SCHEMA_VERSION.to_string(),
            receipt_id: "rcpt-001".to_string(),
            sequence: 0,
            recorded_at: "2026-11-10T03:00:00Z".to_string(),
            session_id: "sess-001".to_string(),
            request_id: "req-001".to_string(),
            request_summary: RequestSummary {
                executable_name: "cargo".to_string(),
                argc: 1,
                cwd: "/project".to_string(),
            },
            policy_decision: test_policy_decision(Verdict::Allow),
            enforcement: EnforcementRecord {
                backend: "none".to_string(),
                applied: false,
                detected_abi: None,
                note: None,
            },
            process_outcome: ProcessOutcome {
                state,
                exit_code: Some(0),
                duration_ms: Some(100),
                signal: None,
            },
            output_digests: None,
            previous_hash: String::new(),
            record_hash: String::new(),
        }
    }

    #[test]
    fn receipt_round_trips() {
        let r = minimal_receipt(ProcessState::Completed);
        let json = serde_json::to_string(&r).unwrap();
        let decoded: CommandReceipt = serde_json::from_str(&json).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn receipt_missing_schema_version_fails() {
        let json = r#"{
            "receiptId": "r",
            "sequence": 0,
            "recordedAt": "2026-11-10T00:00:00Z",
            "sessionId": "s",
            "requestId": "q",
            "requestSummary": {"executableName": "x", "argc": 0, "cwd": "/"},
            "policyDecision": {
                "verdict": "allow",
                "reasonCode": "OK",
                "resolutionStatus": "resolved",
                "userActionRequired": false,
                "policyHash": "h"
            },
            "enforcement": {"backend": "none", "applied": false},
            "processOutcome": {"state": "completed"},
            "previousHash": "",
            "recordHash": ""
        }"#;
        let result: Result<CommandReceipt, _> = serde_json::from_str(json);
        assert!(result.is_err(), "missing schemaVersion must fail");
    }

    #[test]
    fn receipt_unknown_fields_are_ignored() {
        // A future field in the receipt must not break older readers.
        let base = minimal_receipt(ProcessState::Completed);
        let mut value = serde_json::to_value(&base).unwrap();
        value["futureAuditField"] = serde_json::Value::Bool(true);
        let result: Result<CommandReceipt, _> = serde_json::from_value(value);
        assert!(result.is_ok());
    }

    #[test]
    fn denied_receipt_builder_produces_denied_state() {
        let decision = test_policy_decision(Verdict::Deny);
        let r = denied_receipt(
            "rcpt-002",
            1,
            "2026-11-10T03:01:00Z",
            "sess-001",
            "req-002",
            "rm",
            2,
            "/project",
            decision.clone(),
            "prevhash",
        );
        assert_eq!(r.process_outcome.state, ProcessState::Denied);
        assert_eq!(r.policy_decision.verdict, Verdict::Deny);
        assert_eq!(r.previous_hash, "prevhash");
        // record_hash must be empty until the caller fills it
        assert!(r.record_hash.is_empty());
    }

    #[test]
    fn output_digests_optional_fields_default_to_none() {
        let json = r#"{"stdoutTruncated": false, "stderrTruncated": false}"#;
        let d: OutputDigests = serde_json::from_str(json).unwrap();
        assert!(d.stdout_sha256.is_none());
        assert!(d.stderr_sha256.is_none());
    }

    #[test]
    fn process_state_denied_serializes_as_denied() {
        let s = serde_json::to_string(&ProcessState::Denied).unwrap();
        assert_eq!(s, "\"denied\"");
    }
}
