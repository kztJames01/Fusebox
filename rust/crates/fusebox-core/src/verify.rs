//! Hash-chain computation and verification for the receipt journal.
//!
//! The record hash covers the canonical JSON serialization of all fields in
//! the receipt except `record_hash` itself, concatenated with a newline and
//! then the `previous_hash`. This makes the chain tamper-evident: any
//! modification to a record or to the ordering changes all subsequent hashes.

use sha2::{Digest, Sha256};

use crate::receipt::CommandReceipt;

/// Compute the `record_hash` for a receipt whose `record_hash` field is set
/// to an empty string. The caller must have already set `previous_hash`
/// correctly before calling this function.
///
/// The canonical input is:
/// ```text
/// <JSON of receipt with record_hash = ""> LF <previous_hash>
/// ```
///
/// Returns a lowercase hex SHA-256 digest.
pub fn hash_receipt(receipt: &CommandReceipt) -> Result<String, String> {
    // Temporarily zero out record_hash so serialization is deterministic.
    let mut r = receipt.clone();
    r.record_hash = String::new();

    let canonical = serde_json::to_string(&r).map_err(|e| format!("SERIALIZE_ERROR: {e}"))?;

    let input = format!("{canonical}\n{}", receipt.previous_hash);
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

/// Outcome of verifying a receipt chain.
#[derive(Debug, PartialEq)]
pub enum VerifyResult {
    /// Every record in the chain hashes correctly.
    Valid { count: usize },
    /// The record at `index` (0-based) failed the hash check.
    Invalid {
        index: usize,
        receipt_id: String,
        expected: String,
        actual: String,
    },
    /// The chain is empty.
    Empty,
}

/// Verify an ordered slice of receipts as a hash chain.
///
/// - The first record must have `previous_hash == ""`.
/// - Each subsequent record's `previous_hash` must equal the `record_hash` of
///   the preceding record.
/// - Every record's `record_hash` must match the output of [`hash_receipt`].
///
/// Returns [`VerifyResult::Invalid`] for the first failure found.
pub fn verify_chain(receipts: &[CommandReceipt]) -> VerifyResult {
    if receipts.is_empty() {
        return VerifyResult::Empty;
    }

    for (index, receipt) in receipts.iter().enumerate() {
        // Check previous_hash linkage.
        if index == 0 {
            if !receipt.previous_hash.is_empty() {
                return VerifyResult::Invalid {
                    index,
                    receipt_id: receipt.receipt_id.clone(),
                    expected: String::new(),
                    actual: receipt.previous_hash.clone(),
                };
            }
        } else {
            let prev = &receipts[index - 1];
            if receipt.previous_hash != prev.record_hash {
                return VerifyResult::Invalid {
                    index,
                    receipt_id: receipt.receipt_id.clone(),
                    expected: prev.record_hash.clone(),
                    actual: receipt.previous_hash.clone(),
                };
            }
        }

        // Recompute and compare record_hash.
        let expected = match hash_receipt(receipt) {
            Ok(h) => h,
            Err(e) => {
                return VerifyResult::Invalid {
                    index,
                    receipt_id: receipt.receipt_id.clone(),
                    expected: format!("hash_error:{e}"),
                    actual: receipt.record_hash.clone(),
                };
            }
        };

        if expected != receipt.record_hash {
            return VerifyResult::Invalid {
                index,
                receipt_id: receipt.receipt_id.clone(),
                expected,
                actual: receipt.record_hash.clone(),
            };
        }
    }

    VerifyResult::Valid {
        count: receipts.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::SCHEMA_VERSION;
    use crate::contracts::{PolicyDecision, ResolutionStatus, Verdict};
    use crate::receipt::{EnforcementRecord, ProcessOutcome, ProcessState, RequestSummary};

    fn make_receipt(id: &str, seq: u64, previous_hash: &str) -> CommandReceipt {
        let mut r = CommandReceipt {
            schema_version: SCHEMA_VERSION.to_string(),
            receipt_id: id.to_string(),
            sequence: seq,
            recorded_at: "2026-11-10T03:00:00Z".to_string(),
            session_id: "sess-001".to_string(),
            request_id: format!("req-{seq}"),
            request_summary: RequestSummary {
                executable_name: "cargo".to_string(),
                argc: 1,
                cwd: "/project".to_string(),
            },
            policy_decision: PolicyDecision {
                verdict: Verdict::Allow,
                rule_id: None,
                reason_code: "WITHIN_WRITE_ROOT".to_string(),
                predicted_targets: vec![],
                resolution_status: ResolutionStatus::Resolved,
                required_backend: None,
                user_action_required: false,
                policy_hash: "ph".to_string(),
            },
            enforcement: EnforcementRecord {
                backend: "none".to_string(),
                applied: false,
                detected_abi: None,
                note: None,
            },
            process_outcome: ProcessOutcome {
                state: ProcessState::Completed,
                exit_code: Some(0),
                duration_ms: Some(50),
                signal: None,
            },
            output_digests: None,
            previous_hash: previous_hash.to_string(),
            record_hash: String::new(),
        };
        r.record_hash = hash_receipt(&r).unwrap();
        r
    }

    // ── hash_receipt ──────────────────────────────────────────────────────────

    #[test]
    fn hash_receipt_is_deterministic() {
        let r = make_receipt("r1", 0, "");
        let h1 = hash_receipt(&r).unwrap();
        let h2 = hash_receipt(&r).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_receipt_changes_when_field_changes() {
        let r1 = make_receipt("r1", 0, "");
        let mut r2 = r1.clone();
        r2.session_id = "sess-002".to_string();
        // Must recompute record_hash as make_receipt already set it.
        r2.record_hash = hash_receipt(&r2).unwrap();
        assert_ne!(r1.record_hash, r2.record_hash);
    }

    // ── verify_chain — happy paths ────────────────────────────────────────────

    #[test]
    fn empty_chain_returns_empty() {
        assert_eq!(verify_chain(&[]), VerifyResult::Empty);
    }

    #[test]
    fn single_record_chain_passes() {
        let r = make_receipt("r1", 0, "");
        assert_eq!(verify_chain(&[r]), VerifyResult::Valid { count: 1 });
    }

    #[test]
    fn two_record_chain_passes() {
        let r1 = make_receipt("r1", 0, "");
        let r2 = make_receipt("r2", 1, &r1.record_hash);
        assert_eq!(verify_chain(&[r1, r2]), VerifyResult::Valid { count: 2 });
    }

    #[test]
    fn three_record_chain_passes() {
        let r1 = make_receipt("r1", 0, "");
        let r2 = make_receipt("r2", 1, &r1.record_hash);
        let r3 = make_receipt("r3", 2, &r2.record_hash);
        assert_eq!(
            verify_chain(&[r1, r2, r3]),
            VerifyResult::Valid { count: 3 }
        );
    }

    // ── verify_chain — failure cases (the "red" edge cases) ──────────────────

    #[test]
    fn tampered_field_is_detected() {
        let r1 = make_receipt("r1", 0, "");
        let mut r2 = make_receipt("r2", 1, &r1.record_hash);
        // Tamper with a field after the hash was computed.
        r2.session_id = "attacker-controlled".to_string();
        // record_hash now no longer matches the actual content.
        let result = verify_chain(&[r1, r2]);
        assert!(
            matches!(result, VerifyResult::Invalid { index: 1, .. }),
            "tampered record must fail at index 1"
        );
    }

    #[test]
    fn wrong_previous_hash_is_detected() {
        let r1 = make_receipt("r1", 0, "");
        // r2's previous_hash points to a different hash than r1.record_hash.
        let mut r2 = make_receipt("r2", 1, "not-the-right-hash");
        r2.record_hash = hash_receipt(&r2).unwrap();
        let result = verify_chain(&[r1, r2]);
        assert!(
            matches!(result, VerifyResult::Invalid { index: 1, .. }),
            "wrong previous_hash must fail at index 1"
        );
    }

    #[test]
    fn reordered_chain_is_detected() {
        let r1 = make_receipt("r1", 0, "");
        let r2 = make_receipt("r2", 1, &r1.record_hash);
        // Supply in wrong order — r2.previous_hash does not match r2.record_hash.
        let result = verify_chain(&[r2, r1]);
        assert!(
            matches!(result, VerifyResult::Invalid { index: 0, .. }),
            "first record with non-empty previous_hash must fail"
        );
    }

    #[test]
    fn first_record_with_non_empty_previous_hash_fails() {
        // The first record must have previous_hash == "".
        let mut r = make_receipt("r1", 0, "");
        r.previous_hash = "some-hash".to_string();
        r.record_hash = hash_receipt(&r).unwrap();
        let result = verify_chain(&[r]);
        assert!(
            matches!(result, VerifyResult::Invalid { index: 0, .. }),
            "non-empty previous_hash on first record must fail"
        );
    }

    #[test]
    fn missing_middle_record_is_detected() {
        let r1 = make_receipt("r1", 0, "");
        let r2 = make_receipt("r2", 1, &r1.record_hash);
        let r3 = make_receipt("r3", 2, &r2.record_hash);
        // Skip r2 — r3.previous_hash will not match r1.record_hash.
        let result = verify_chain(&[r1, r3]);
        assert!(
            matches!(result, VerifyResult::Invalid { index: 1, .. }),
            "missing middle record must fail at index 1"
        );
    }
}
