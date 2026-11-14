//! `fusebox init` — create a versioned local intent/policy file.
//!
//! Writes `.fusebox/policy.json` in the requested workspace directory. The
//! file contains an `IntentContract` with sane defaults that the developer
//! then edits to scope permissions appropriately.
//!
//! The policy file is human-editable JSON. On every write the `policyHash`
//! field is recomputed to reflect the current content.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::contracts::{ApprovalPolicy, IntentContract, NetworkPolicy, SCHEMA_VERSION};
use crate::policy::compute_policy_hash;

/// The relative path of the policy file within a workspace directory.
pub const POLICY_FILE_REL: &str = ".fusebox/policy.json";

/// Errors from `fusebox init`.
#[derive(Debug)]
pub enum InitError {
    /// The workspace directory does not exist.
    WorkspaceNotFound(String),
    /// Could not create the `.fusebox/` directory.
    DirCreateFailed(String),
    /// Could not write the policy file.
    WriteFailed(String),
    /// A policy file already exists at the target path.
    AlreadyExists(String),
    /// Could not read an existing policy file for validation.
    ReadFailed(String),
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::WorkspaceNotFound(p) => write!(f, "workspace directory not found: {p}"),
            InitError::DirCreateFailed(e) => write!(f, "failed to create .fusebox/ directory: {e}"),
            InitError::WriteFailed(e) => write!(f, "failed to write policy file: {e}"),
            InitError::AlreadyExists(p) => write!(f, "policy file already exists: {p}"),
            InitError::ReadFailed(e) => write!(f, "failed to read policy file: {e}"),
        }
    }
}

/// Options for `fusebox init`.
#[derive(Debug, Clone)]
pub struct InitOptions {
    /// Absolute path to the workspace directory.
    pub workspace_dir: String,
    /// Session ID to embed in the initial policy.
    pub session_id: String,
    /// If `true`, overwrite an existing policy file instead of erroring.
    pub overwrite: bool,
}

/// Result of a successful `fusebox init`.
#[derive(Debug, Clone)]
pub struct InitResult {
    /// Absolute path to the written policy file.
    pub policy_path: String,
    /// The contract that was written.
    pub contract: IntentContract,
    /// Whether an existing policy was overwritten.
    pub overwritten: bool,
}

/// Create the `.fusebox/policy.json` file in the workspace.
///
/// Default policy:
/// - `workspaceRoots`: the workspace directory itself
/// - `readRoots`: same as workspace
/// - `writeRoots`: workspace directory (developer edits to tighten)
/// - `protectedRoots`: `.fusebox/` directory
/// - `networkPolicy`: `deny_all`
/// - `approvalPolicy`: `deny`
pub fn init(options: &InitOptions) -> Result<InitResult, InitError> {
    let workspace = Path::new(&options.workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err(InitError::WorkspaceNotFound(options.workspace_dir.clone()));
    }

    let fusebox_dir = workspace.join(".fusebox");
    let policy_path = workspace.join(POLICY_FILE_REL);

    if policy_path.exists() && !options.overwrite {
        return Err(InitError::AlreadyExists(
            policy_path.to_string_lossy().to_string(),
        ));
    }

    // Create .fusebox/ directory if absent.
    if !fusebox_dir.exists() {
        std::fs::create_dir_all(&fusebox_dir)
            .map_err(|e| InitError::DirCreateFailed(e.to_string()))?;
    }

    let workspace_root = options.workspace_dir.clone();
    let protected = format!("{}/.fusebox", workspace_root.trim_end_matches('/'));

    let mut contract = IntentContract {
        schema_version: SCHEMA_VERSION.to_string(),
        session_id: options.session_id.clone(),
        workspace_roots: vec![workspace_root.clone()],
        read_roots: vec![workspace_root.clone()],
        write_roots: vec![workspace_root.clone()],
        protected_roots: vec![protected],
        allowed_command_classes: vec![
            "build".to_string(),
            "test".to_string(),
            "format".to_string(),
            "lint".to_string(),
        ],
        network_policy: NetworkPolicy::DenyAll,
        approval_policy: ApprovalPolicy::Deny,
        expires_at: None,
        policy_hash: None,
    };

    // Compute and embed the hash.
    let hash = compute_policy_hash(&contract);
    contract.policy_hash = Some(hash);

    let overwritten = policy_path.exists();
    write_policy_file(&policy_path, &contract)?;

    Ok(InitResult {
        policy_path: policy_path.to_string_lossy().to_string(),
        contract,
        overwritten,
    })
}

/// Load and deserialize a policy file. Returns `None` if the file does not
/// exist, or an error if the file is present but invalid.
pub fn load_policy(workspace_dir: &str) -> Result<Option<IntentContract>, InitError> {
    let path = Path::new(workspace_dir).join(POLICY_FILE_REL);
    if !path.exists() {
        return Ok(None);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| InitError::ReadFailed(e.to_string()))?;
    let contract: IntentContract = serde_json::from_str(&content)
        .map_err(|e| InitError::ReadFailed(format!("parse error: {e}")))?;
    Ok(Some(contract))
}

/// Persist an updated policy file. The `policyHash` field is recomputed.
pub fn save_policy(
    workspace_dir: &str,
    contract: &mut IntentContract,
) -> Result<PathBuf, InitError> {
    let path = Path::new(workspace_dir).join(POLICY_FILE_REL);
    let hash = compute_policy_hash(contract);
    contract.policy_hash = Some(hash);
    write_policy_file(&path, contract)?;
    Ok(path)
}

// ── Internal ──────────────────────────────────────────────────────────────────

fn write_policy_file(path: &Path, contract: &IntentContract) -> Result<(), InitError> {
    // Produce a human-readable JSON with a schema version comment preamble.
    // Use a temporary-file + rename for atomic writes.
    let json = serde_json::to_string_pretty(contract)
        .map_err(|e| InitError::WriteFailed(e.to_string()))?;

    let parent = path.parent().unwrap_or(Path::new("."));
    let tmp_path = parent.join(format!(
        ".policy.json.tmp.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));

    std::fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| InitError::WriteFailed(e.to_string()))?;

    std::fs::rename(&tmp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        InitError::WriteFailed(e.to_string())
    })?;

    Ok(())
}

/// Validate a policy JSON value against the schema version; returns an error
/// string if the value is structurally invalid.
pub fn validate_policy_value(value: &Value) -> Result<(), String> {
    let obj = value.as_object().ok_or("policy must be a JSON object")?;

    match obj.get("schemaVersion").and_then(|v| v.as_str()) {
        Some("1") => {}
        Some(v) => return Err(format!("unknown schema version: '{v}'")),
        None => return Err("missing schemaVersion".to_string()),
    }

    if obj
        .get("sessionId")
        .and_then(|v| v.as_str())
        .is_none_or(|s| s.is_empty())
    {
        return Err("sessionId must be a non-empty string".to_string());
    }

    if !obj.get("workspaceRoots").is_some_and(|v| v.is_array()) {
        return Err("workspaceRoots must be an array".to_string());
    }

    let valid_network = ["deny_all", "allowlist", "allow"];
    match obj.get("networkPolicy").and_then(|v| v.as_str()) {
        Some(v) if valid_network.contains(&v) => {}
        Some(v) => return Err(format!("unknown networkPolicy: '{v}'")),
        None => return Err("missing networkPolicy".to_string()),
    }

    let valid_approval = ["deny", "escalate", "log"];
    match obj.get("approvalPolicy").and_then(|v| v.as_str()) {
        Some(v) if valid_approval.contains(&v) => {}
        Some(v) => return Err(format!("unknown approvalPolicy: '{v}'")),
        None => return Err("missing approvalPolicy".to_string()),
    }

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Red-phase: edge cases ─────────────────────────────────────────────────

    #[test]
    fn init_nonexistent_workspace_fails() {
        let opts = InitOptions {
            workspace_dir: "/nonexistent/does/not/exist".to_string(),
            session_id: "s1".to_string(),
            overwrite: false,
        };
        assert!(matches!(init(&opts), Err(InitError::WorkspaceNotFound(_))));
    }

    #[test]
    fn validate_missing_schema_version_fails() {
        let v = serde_json::json!({
            "sessionId": "s",
            "workspaceRoots": [],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        });
        assert!(validate_policy_value(&v).is_err());
    }

    #[test]
    fn validate_wrong_schema_version_fails() {
        let v = serde_json::json!({
            "schemaVersion": "99",
            "sessionId": "s",
            "workspaceRoots": [],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        });
        let err = validate_policy_value(&v).unwrap_err();
        assert!(err.contains("unknown schema version"));
    }

    #[test]
    fn validate_unknown_network_policy_fails() {
        let v = serde_json::json!({
            "schemaVersion": "1",
            "sessionId": "s",
            "workspaceRoots": [],
            "networkPolicy": "unrestricted",
            "approvalPolicy": "deny"
        });
        let err = validate_policy_value(&v).unwrap_err();
        assert!(err.contains("networkPolicy"));
    }

    #[test]
    fn validate_missing_session_id_fails() {
        let v = serde_json::json!({
            "schemaVersion": "1",
            "sessionId": "",
            "workspaceRoots": [],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        });
        assert!(validate_policy_value(&v).is_err());
    }

    // ── Green-phase: valid cases ───────────────────────────────────────────────

    #[test]
    fn init_creates_policy_file_in_tempdir() {
        let dir = std::env::temp_dir().join(format!(
            "fusebox-init-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let opts = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-init-test".to_string(),
            overwrite: false,
        };
        let result = init(&opts).unwrap();

        assert!(Path::new(&result.policy_path).exists());
        assert!(!result.overwritten);
        assert_eq!(result.contract.schema_version, "1");
        assert!(result.contract.policy_hash.is_some());

        // Can load back.
        let loaded = load_policy(&dir.to_string_lossy()).unwrap().unwrap();
        assert_eq!(loaded.session_id, "sess-init-test");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_overwrite_works() {
        let dir = std::env::temp_dir().join(format!(
            "fusebox-init-overwrite-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let opts = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-first".to_string(),
            overwrite: false,
        };
        init(&opts).unwrap();

        let opts2 = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-second".to_string(),
            overwrite: true,
        };
        let result = init(&opts2).unwrap();
        assert!(result.overwritten);
        assert_eq!(result.contract.session_id, "sess-second");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_already_exists_without_overwrite_fails() {
        let dir = std::env::temp_dir().join(format!(
            "fusebox-init-nooverwrite-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let opts = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-a".to_string(),
            overwrite: false,
        };
        init(&opts).unwrap();

        let opts2 = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-b".to_string(),
            overwrite: false,
        };
        assert!(matches!(init(&opts2), Err(InitError::AlreadyExists(_))));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_valid_policy_passes() {
        let v = serde_json::json!({
            "schemaVersion": "1",
            "sessionId": "s",
            "workspaceRoots": ["/project"],
            "networkPolicy": "deny_all",
            "approvalPolicy": "deny"
        });
        assert!(validate_policy_value(&v).is_ok());
    }

    #[test]
    fn policy_hash_is_embedded_and_excludes_itself() {
        let dir = std::env::temp_dir().join(format!(
            "fusebox-init-hash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let opts = InitOptions {
            workspace_dir: dir.to_string_lossy().to_string(),
            session_id: "sess-hash".to_string(),
            overwrite: false,
        };
        let result = init(&opts).unwrap();
        let embedded_hash = result.contract.policy_hash.clone().unwrap();

        // Recomputing the hash on the loaded contract (which has policyHash set)
        // should give the same value since compute_policy_hash excludes the field.
        let recomputed = compute_policy_hash(&result.contract);
        assert_eq!(embedded_hash, recomputed);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
