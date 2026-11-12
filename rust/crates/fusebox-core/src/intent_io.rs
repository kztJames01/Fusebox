//! Persistent intent contract I/O: read and write `.fusebox/policy.json`.
//!
//! The policy file is written atomically via temp-file + rename to prevent
//! partial writes from corrupting the contract seen by the policy evaluator.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::contracts::IntentContract;
use crate::policy::compute_policy_hash;

/// Error type for intent I/O operations.
#[derive(Debug)]
pub enum IntentIoError {
    /// The policy file already exists and `--overwrite` was not requested.
    AlreadyExists(PathBuf),
    /// A filesystem operation failed.
    Io(std::io::Error),
    /// JSON serialisation or deserialisation failed.
    Json(serde_json::Error),
    /// The policy file was found but its content is not a valid contract.
    InvalidContract(String),
}

impl std::fmt::Display for IntentIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IntentIoError::AlreadyExists(p) => {
                write!(
                    f,
                    "policy file already exists: {}; use --overwrite to replace it",
                    p.display()
                )
            }
            IntentIoError::Io(e) => write!(f, "I/O error: {e}"),
            IntentIoError::Json(e) => write!(f, "JSON error: {e}"),
            IntentIoError::InvalidContract(msg) => write!(f, "invalid contract: {msg}"),
        }
    }
}

impl From<std::io::Error> for IntentIoError {
    fn from(e: std::io::Error) -> Self {
        IntentIoError::Io(e)
    }
}

impl From<serde_json::Error> for IntentIoError {
    fn from(e: serde_json::Error) -> Self {
        IntentIoError::Json(e)
    }
}

/// Default sub-directory and filename for the policy file.
pub const POLICY_DIR: &str = ".fusebox";
pub const POLICY_FILE: &str = "policy.json";

/// Return the canonical path to the policy file under `workspace_dir`.
pub fn policy_file_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(POLICY_DIR).join(POLICY_FILE)
}

/// Write `contract` to `.fusebox/policy.json` under `workspace_dir`.
///
/// The hash is computed and embedded before writing. If `overwrite` is `false`
/// and the file already exists, returns [`IntentIoError::AlreadyExists`].
///
/// The directory is created if it does not exist.
pub fn write_policy(
    workspace_dir: &Path,
    contract: &IntentContract,
    overwrite: bool,
) -> Result<PathBuf, IntentIoError> {
    let dir = workspace_dir.join(POLICY_DIR);
    let file_path = dir.join(POLICY_FILE);

    if !overwrite && file_path.exists() {
        return Err(IntentIoError::AlreadyExists(file_path));
    }

    fs::create_dir_all(&dir)?;

    // Embed the policy hash before writing.
    let mut c = contract.clone();
    c.policy_hash = Some(compute_policy_hash(&c));

    let json = serde_json::to_string_pretty(&c)?;

    // Atomic write via temp file + rename.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp_path = dir.join(format!(".policy.tmp.{nonce}"));

    fs::write(&tmp_path, json.as_bytes())?;
    fs::rename(&tmp_path, &file_path)?;

    Ok(file_path)
}

/// Read the policy file from `.fusebox/policy.json` under `workspace_dir`.
pub fn read_policy(workspace_dir: &Path) -> Result<IntentContract, IntentIoError> {
    let file_path = policy_file_path(workspace_dir);
    let contents = fs::read_to_string(&file_path)?;
    let contract: IntentContract = serde_json::from_str(&contents)
        .map_err(|e| IntentIoError::InvalidContract(e.to_string()))?;
    Ok(contract)
}

/// Build a default `IntentContract` for `workspace_dir` with conservative
/// defaults: no outbound network, deny-on-exception, `.fusebox/` protected.
pub fn default_contract(workspace_dir: &Path) -> IntentContract {
    use crate::contracts::{ApprovalPolicy, NetworkPolicy, SCHEMA_VERSION};
    let ws = workspace_dir.to_string_lossy().to_string();
    let protected = workspace_dir.join(POLICY_DIR).to_string_lossy().to_string();
    let session_id = format!(
        "sess-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    IntentContract {
        schema_version: SCHEMA_VERSION.to_string(),
        session_id,
        workspace_roots: vec![ws.clone()],
        read_roots: vec![ws.clone()],
        write_roots: vec![ws.clone()],
        protected_roots: vec![protected],
        allowed_command_classes: vec![],
        network_policy: NetworkPolicy::DenyAll,
        approval_policy: ApprovalPolicy::Deny,
        expires_at: None,
        policy_hash: None,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or_else(|_| 0);
        let p = std::env::temp_dir().join(format!("fusebox-test-{nonce}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn write_and_read_round_trips() {
        let dir = temp_dir();
        let contract = default_contract(&dir);
        let written_path = write_policy(&dir, &contract, false).unwrap();
        assert!(written_path.exists());

        let loaded = read_policy(&dir).unwrap();
        assert_eq!(loaded.session_id, contract.session_id);
        assert_eq!(loaded.workspace_roots, contract.workspace_roots);
        // Hash is embedded on write.
        assert!(loaded.policy_hash.is_some());
    }

    #[test]
    fn overwrite_guard_prevents_accidental_clobber() {
        let dir = temp_dir();
        let contract = default_contract(&dir);
        write_policy(&dir, &contract, false).unwrap();
        let result = write_policy(&dir, &contract, false);
        assert!(
            matches!(result, Err(IntentIoError::AlreadyExists(_))),
            "second write without --overwrite must fail"
        );
    }

    #[test]
    fn overwrite_flag_allows_second_write() {
        let dir = temp_dir();
        let contract = default_contract(&dir);
        write_policy(&dir, &contract, false).unwrap();
        let result = write_policy(&dir, &contract, true);
        assert!(result.is_ok(), "second write with --overwrite must succeed");
    }

    #[test]
    fn read_missing_file_returns_io_error() {
        let dir = temp_dir();
        let result = read_policy(&dir);
        assert!(matches!(result, Err(IntentIoError::Io(_))));
    }

    #[test]
    fn default_contract_has_fusebox_in_protected_roots() {
        let dir = temp_dir();
        let c = default_contract(&dir);
        assert!(c.protected_roots.iter().any(|p| p.contains(".fusebox")));
    }

    #[test]
    fn written_policy_has_hash_embedded() {
        let dir = temp_dir();
        let contract = default_contract(&dir);
        write_policy(&dir, &contract, false).unwrap();
        let loaded = read_policy(&dir).unwrap();
        let expected = compute_policy_hash(&loaded);
        assert_eq!(loaded.policy_hash.as_deref(), Some(expected.as_str()));
    }
}
