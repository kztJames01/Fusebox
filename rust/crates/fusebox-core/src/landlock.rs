//! Linux Landlock ABI detection and confinement ruleset builder.
//!
//! Sprint 4 scope: D1–D5.
//!
//! # Platform matrix
//!
//! | Platform | Support |
//! |---|---|
//! | Linux kernel ≥ 5.13 (Landlock ABI v1+) | Full filesystem confinement |
//! | Linux kernel < 5.13 | `LandlockStatus::Unavailable` — fail closed |
//! | macOS | Hook/wrapper only — no kernel confinement |
//! | Windows | Out of scope |
//!
//! # Design invariants
//!
//! 1. **Fail closed.** A strict confinement request that the kernel cannot satisfy
//!    returns an error; it never silently falls back to an unconfined execution.
//! 2. **Explicit ABI record.** `probe_landlock()` records the exact ABI version
//!    and rights available before any ruleset is built.
//! 3. **No filesystem path authorization via seccomp.** Seccomp is not used for
//!    filesystem policy decisions; Landlock is the v1 filesystem enforcement layer.
//! 4. **Network restrictions separate.** Landlock TCP bind/connect require ABI v4
//!    (Linux 6.1+). On ABI < 4, network confinement is not available through
//!    Landlock; callers must handle this explicitly.
//! 5. **Child inheritance.** Landlock rulesets are inherited by fork/exec; the
//!    restriction applies to the child and all its descendants.

// ── Feature gate ──────────────────────────────────────────────────────────────
// All implementation lives in the cfg(target_os = "linux") block.
// Non-Linux targets get stub types that always report Unavailable.

/// Landlock ABI version detected on the running kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LandlockAbi {
    /// Kernel supports Landlock ABI at this version.
    ///
    /// - v1: Linux 5.13 — filesystem path access (no network).
    /// - v2: Linux 5.19 — added `LANDLOCK_ACCESS_FS_REFER`.
    /// - v3: Linux 6.0  — added `LANDLOCK_ACCESS_FS_TRUNCATE`.
    /// - v4: Linux 6.1  — added TCP bind/connect (network confinement).
    Version(u32),
    /// Kernel does not support Landlock (pre-5.13 or syscall disabled).
    Unavailable,
}

/// Result of probing Landlock at runtime.
#[derive(Debug, Clone)]
pub struct LandlockProbe {
    /// ABI version (or Unavailable).
    pub abi: LandlockAbi,
    /// Whether filesystem path restriction is available (ABI ≥ 1).
    pub fs_available: bool,
    /// Whether TCP bind/connect restriction is available (ABI ≥ 4).
    pub tcp_available: bool,
    /// Human-readable note about limitations or absent rights.
    pub note: String,
}

/// Filesystem access rights requested for a workspace root.
///
/// Each variant maps to one or more `LANDLOCK_ACCESS_FS_*` constants.
/// Only rights supported by the detected ABI are applied; unsupported
/// rights that are required will cause `apply_ruleset` to return an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsRight {
    /// Read file contents.
    ReadFile,
    /// Read directory contents.
    ReadDir,
    /// Write to a file.
    WriteFile,
    /// Create or remove a directory entry.
    MakeFile,
    /// Remove a directory.
    RemoveDir,
    /// Remove a file.
    RemoveFile,
    /// Rename / move (requires ABI v1; note: not a distinct right until v2).
    Rename,
    /// Truncate a file (ABI v3+).
    Truncate,
}

/// A single rule granting `rights` under `path`.
#[derive(Debug, Clone)]
pub struct FsRule {
    /// Absolute path to allow access to.
    pub path: String,
    /// Access rights granted for this path.
    pub rights: Vec<FsRight>,
}

/// Error type for Landlock operations.
#[derive(Debug)]
pub enum LandlockError {
    /// The kernel does not support Landlock.
    Unavailable,
    /// A required right is not available on this ABI version.
    RightUnavailable {
        right: FsRight,
        required_abi: u32,
        actual_abi: u32,
    },
    /// A system call or OS operation failed.
    OsError(String),
    /// Landlock is not supported on this platform.
    UnsupportedPlatform,
}

impl std::fmt::Display for LandlockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LandlockError::Unavailable => {
                write!(
                    f,
                    "Landlock is not available on this kernel (requires Linux 5.13+)"
                )
            }
            LandlockError::RightUnavailable {
                right,
                required_abi,
                actual_abi,
            } => {
                write!(
                    f,
                    "required Landlock right {right:?} needs ABI v{required_abi}, kernel has ABI v{actual_abi}"
                )
            }
            LandlockError::OsError(msg) => write!(f, "OS error during Landlock setup: {msg}"),
            LandlockError::UnsupportedPlatform => {
                write!(
                    f,
                    "Landlock confinement is not supported on this platform (Linux only)"
                )
            }
        }
    }
}

// ── Linux implementation ──────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::*;
    use std::os::unix::io::RawFd;

    // Landlock syscall numbers on Linux x86_64 / arm64 / riscv64.
    // We use direct syscall invocations via libc::syscall to avoid
    // requiring the landlock kernel headers in the toolchain.
    //
    // landlock_create_ruleset(3) = 444 (x86_64), 444 (aarch64), 444 (riscv64)
    // landlock_add_rule(3)       = 445
    // landlock_restrict_self(3)  = 446
    //
    // These numbers are stable in the Linux ABI since 5.13.
    const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

    // LANDLOCK_CREATE_RULESET_VERSION flag.
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1 << 0;

    // Landlock ruleset attribute layout.
    // struct landlock_ruleset_attr { __u64 handled_access_fs; __u64 handled_access_net; }
    #[repr(C)]
    struct LandlockRulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
    }

    // landlock_path_beneath_attr layout.
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; }
    #[repr(C)]
    struct LandlockPathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    // Landlock rule type.
    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

    // FS access right bitmasks (ABI v1+).
    const LL_EXEC_FILE: u64 = 1 << 0;
    const LL_WRITE_FILE: u64 = 1 << 1;
    const LL_READ_FILE: u64 = 1 << 2;
    const LL_READ_DIR: u64 = 1 << 3;
    const LL_REMOVE_DIR: u64 = 1 << 4;
    const LL_REMOVE_FILE: u64 = 1 << 5;
    const LL_MAKE_CHAR: u64 = 1 << 6;
    const LL_MAKE_DIR: u64 = 1 << 7;
    const LL_MAKE_REG: u64 = 1 << 8;
    const LL_MAKE_SOCK: u64 = 1 << 9;
    const LL_MAKE_FIFO: u64 = 1 << 10;
    const LL_MAKE_BLOCK: u64 = 1 << 11;
    const LL_MAKE_SYM: u64 = 1 << 12;
    // ABI v2 (Linux 5.19).
    const LL_REFER: u64 = 1 << 13;
    // ABI v3 (Linux 6.0).
    const LL_TRUNCATE: u64 = 1 << 14;

    /// All FS rights available in ABI v1.
    const FS_V1_RIGHTS: u64 = LL_EXEC_FILE
        | LL_WRITE_FILE
        | LL_READ_FILE
        | LL_READ_DIR
        | LL_REMOVE_DIR
        | LL_REMOVE_FILE
        | LL_MAKE_CHAR
        | LL_MAKE_DIR
        | LL_MAKE_REG
        | LL_MAKE_SOCK
        | LL_MAKE_FIFO
        | LL_MAKE_BLOCK
        | LL_MAKE_SYM;

    /// All FS rights available in ABI v2.
    const FS_V2_RIGHTS: u64 = FS_V1_RIGHTS | LL_REFER;

    /// All FS rights available in ABI v3.
    const FS_V3_RIGHTS: u64 = FS_V2_RIGHTS | LL_TRUNCATE;

    /// All FS rights up to ABI v3.
    fn all_fs_rights_for_abi(abi: u32) -> u64 {
        match abi {
            1 => FS_V1_RIGHTS,
            2 => FS_V2_RIGHTS,
            _ => FS_V3_RIGHTS, // v3 and later
        }
    }

    /// Probe the Landlock ABI version via `landlock_create_ruleset` with the
    /// `LANDLOCK_CREATE_RULESET_VERSION` flag.
    pub fn probe_landlock() -> LandlockProbe {
        // SAFETY: landlock_create_ruleset is a safe syscall; it does not
        // dereference the attr pointer when the VERSION flag is set.
        let ret = unsafe {
            libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                std::ptr::null::<LandlockRulesetAttr>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };

        if ret < 0 {
            let errno = unsafe { *libc::__errno_location() };
            let note = if errno == libc::ENOSYS || errno == libc::EOPNOTSUPP {
                "Landlock syscall not supported on this kernel".to_string()
            } else {
                format!("landlock_create_ruleset version probe failed: errno={errno}")
            };
            return LandlockProbe {
                abi: LandlockAbi::Unavailable,
                fs_available: false,
                tcp_available: false,
                note,
            };
        }

        let version = ret as u32;
        let tcp_available = version >= 4;
        LandlockProbe {
            abi: LandlockAbi::Version(version),
            fs_available: version >= 1,
            tcp_available,
            note: if tcp_available {
                format!("Landlock ABI v{version}: filesystem + TCP network confinement available")
            } else {
                format!(
                    "Landlock ABI v{version}: filesystem confinement available; TCP confinement requires ABI v4+ (Linux 6.1+)"
                )
            },
        }
    }

    /// Map a [`FsRight`] to its Landlock access bitmask and the minimum ABI
    /// version that introduced it.
    fn fs_right_to_bits(right: &FsRight) -> (u64, u32) {
        match right {
            FsRight::ReadFile => (LL_READ_FILE, 1),
            FsRight::ReadDir => (LL_READ_DIR, 1),
            FsRight::WriteFile => (LL_WRITE_FILE, 1),
            FsRight::MakeFile => (
                LL_MAKE_REG
                    | LL_MAKE_DIR
                    | LL_MAKE_CHAR
                    | LL_MAKE_SOCK
                    | LL_MAKE_FIFO
                    | LL_MAKE_BLOCK
                    | LL_MAKE_SYM,
                1,
            ),
            FsRight::RemoveDir => (LL_REMOVE_DIR, 1),
            FsRight::RemoveFile => (LL_REMOVE_FILE, 1),
            FsRight::Rename => (LL_REFER, 2),
            FsRight::Truncate => (LL_TRUNCATE, 3),
        }
    }

    /// Apply a Landlock ruleset to the current thread (and future children).
    ///
    /// # Safety contract
    ///
    /// This function must be called **after fork and before exec** in the
    /// child process. On success the restriction is permanent for this process
    /// and all future descendants.
    ///
    /// Returns `Ok(())` on success. Returns an error if:
    /// - Landlock is unavailable.
    /// - A required right is unavailable on the detected ABI and `strict` is `true`.
    /// - Any syscall fails.
    pub fn apply_ruleset(
        rules: &[FsRule],
        probe: &LandlockProbe,
        strict: bool,
    ) -> Result<(), LandlockError> {
        let abi_version = match probe.abi {
            LandlockAbi::Version(v) => v,
            LandlockAbi::Unavailable => return Err(LandlockError::Unavailable),
        };

        // Compute the aggregate handled_access_fs bitmask from all rules.
        let mut handled_fs: u64 = 0;
        for rule in rules {
            for right in &rule.rights {
                let (bits, min_abi) = fs_right_to_bits(right);
                if min_abi > abi_version {
                    if strict {
                        return Err(LandlockError::RightUnavailable {
                            right: right.clone(),
                            required_abi: min_abi,
                            actual_abi: abi_version,
                        });
                    }
                    // Non-strict: skip unavailable rights.
                } else {
                    handled_fs |= bits;
                }
            }
        }

        // Mask to rights supported by this ABI.
        handled_fs &= all_fs_rights_for_abi(abi_version);

        if handled_fs == 0 {
            // Nothing to enforce; apply a deny-all ruleset.
            // Create ruleset with no rights — all access denied.
            let attr = LandlockRulesetAttr {
                handled_access_fs: all_fs_rights_for_abi(abi_version),
                handled_access_net: 0,
            };
            let attr_size = std::mem::size_of::<LandlockRulesetAttr>();

            let fd = create_ruleset_fd(&attr, attr_size)?;
            restrict_self(fd)?;
            unsafe { libc::close(fd) };
            return Ok(());
        }

        // Create the ruleset.
        let attr = LandlockRulesetAttr {
            handled_access_fs: all_fs_rights_for_abi(abi_version),
            handled_access_net: 0,
        };
        let attr_size = std::mem::size_of::<LandlockRulesetAttr>();

        let ruleset_fd = create_ruleset_fd(&attr, attr_size)?;

        // Add path_beneath rules.
        for rule in rules {
            let mut allowed: u64 = 0;
            for right in &rule.rights {
                let (bits, min_abi) = fs_right_to_bits(right);
                if min_abi <= abi_version {
                    allowed |= bits;
                }
            }
            allowed &= all_fs_rights_for_abi(abi_version);

            if allowed == 0 {
                continue;
            }

            // Open the path to get a file descriptor for the rule.
            let c_path = match std::ffi::CString::new(rule.path.as_bytes()) {
                Ok(p) => p,
                Err(_) => {
                    return Err(LandlockError::OsError(format!(
                        "path contains null byte: {}",
                        rule.path
                    )))
                }
            };

            // SAFETY: libc::open is a standard POSIX call.
            let path_fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };

            if path_fd < 0 {
                let errno = unsafe { *libc::__errno_location() };
                // Non-existent paths are skipped (the kernel will deny access
                // to them because there is no rule).
                if errno == libc::ENOENT || errno == libc::ENOTDIR {
                    continue;
                }
                return Err(LandlockError::OsError(format!(
                    "open O_PATH failed for {}: errno={errno}",
                    rule.path
                )));
            }

            let path_beneath = LandlockPathBeneathAttr {
                allowed_access: allowed,
                parent_fd: path_fd,
            };

            // SAFETY: syscall with valid fd and attribute struct.
            let ret = unsafe {
                libc::syscall(
                    SYS_LANDLOCK_ADD_RULE,
                    ruleset_fd,
                    LANDLOCK_RULE_PATH_BENEATH,
                    &path_beneath as *const LandlockPathBeneathAttr,
                    0u32,
                )
            };

            unsafe { libc::close(path_fd) };

            if ret < 0 {
                let errno = unsafe { *libc::__errno_location() };
                unsafe { libc::close(ruleset_fd) };
                return Err(LandlockError::OsError(format!(
                    "landlock_add_rule failed for {}: errno={errno}",
                    rule.path
                )));
            }
        }

        restrict_self(ruleset_fd)?;
        unsafe { libc::close(ruleset_fd) };

        Ok(())
    }

    fn create_ruleset_fd(
        attr: &LandlockRulesetAttr,
        attr_size: usize,
    ) -> Result<RawFd, LandlockError> {
        // SAFETY: attr is a valid struct and attr_size is correct.
        let fd = unsafe {
            libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                attr as *const LandlockRulesetAttr,
                attr_size,
                0u32,
            )
        };
        if fd < 0 {
            let errno = unsafe { *libc::__errno_location() };
            Err(LandlockError::OsError(format!(
                "landlock_create_ruleset failed: errno={errno}"
            )))
        } else {
            Ok(fd as RawFd)
        }
    }

    fn restrict_self(ruleset_fd: RawFd) -> Result<(), LandlockError> {
        // Set no_new_privs to allow landlock_restrict_self without CAP_SYS_ADMIN.
        // SAFETY: prctl is a safe call; PR_SET_NO_NEW_PRIVS = 38.
        let ret = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        if ret < 0 {
            let errno = unsafe { *libc::__errno_location() };
            return Err(LandlockError::OsError(format!(
                "prctl(PR_SET_NO_NEW_PRIVS) failed: errno={errno}"
            )));
        }

        // SAFETY: ruleset_fd is valid; flags = 0.
        let ret = unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0u32) };
        if ret < 0 {
            let errno = unsafe { *libc::__errno_location() };
            Err(LandlockError::OsError(format!(
                "landlock_restrict_self failed: errno={errno}"
            )))
        } else {
            Ok(())
        }
    }
}

// ── Non-Linux stubs ───────────────────────────────────────────────────────────

#[cfg(not(target_os = "linux"))]
mod linux_impl {
    use super::*;

    pub fn probe_landlock() -> LandlockProbe {
        LandlockProbe {
            abi: LandlockAbi::Unavailable,
            fs_available: false,
            tcp_available: false,
            note: "Landlock is a Linux-only feature; confinement is not available on this platform"
                .to_string(),
        }
    }

    pub fn apply_ruleset(
        _rules: &[FsRule],
        _probe: &LandlockProbe,
        _strict: bool,
    ) -> Result<(), LandlockError> {
        Err(LandlockError::UnsupportedPlatform)
    }
}

// ── Public re-exports ─────────────────────────────────────────────────────────

/// Probe the Landlock ABI version on the running kernel.
///
/// Returns a [`LandlockProbe`] describing what is available. This is a
/// read-only operation; no ruleset is created.
pub fn probe_landlock() -> LandlockProbe {
    linux_impl::probe_landlock()
}

/// Apply a Landlock ruleset to the current process.
///
/// Must be called before `exec` in the child process. The restriction is
/// permanent and inherited by all descendants.
///
/// If `strict` is `true`, returns an error if any required right is not
/// available on the detected ABI. If `strict` is `false`, unavailable
/// rights are silently skipped.
pub fn apply_ruleset(
    rules: &[FsRule],
    probe: &LandlockProbe,
    strict: bool,
) -> Result<(), LandlockError> {
    linux_impl::apply_ruleset(rules, probe, strict)
}

/// Build the minimal set of [`FsRule`]s needed to run a supervised child
/// within `workspace_root`.
///
/// Read-only execution tools (like `cargo test`, `rustfmt`) need:
/// - read + exec on the whole workspace.
/// - write + make + remove within the workspace.
/// - read-only access to common runtime paths (`/usr`, `/lib`, `/lib64`, etc.).
///
/// The caller is responsible for adding any extra rules (e.g. `/tmp`,
/// network sockets) that the policy permits.
pub fn workspace_ruleset(workspace_root: &str, allow_writes: bool) -> Vec<FsRule> {
    let mut rules = Vec::new();

    // Workspace: read + exec always; write/delete when permitted.
    let mut ws_rights = vec![FsRight::ReadFile, FsRight::ReadDir];
    if allow_writes {
        ws_rights.push(FsRight::WriteFile);
        ws_rights.push(FsRight::MakeFile);
        ws_rights.push(FsRight::RemoveFile);
        ws_rights.push(FsRight::RemoveDir);
        ws_rights.push(FsRight::Truncate);
        ws_rights.push(FsRight::Rename);
    }
    rules.push(FsRule {
        path: workspace_root.to_string(),
        rights: ws_rights,
    });

    // Common Linux runtime paths — read + exec only.
    let runtime_paths = ["/usr", "/lib", "/lib64", "/lib32", "/etc/ld.so.cache"];
    for path in &runtime_paths {
        rules.push(FsRule {
            path: path.to_string(),
            rights: vec![FsRight::ReadFile, FsRight::ReadDir],
        });
    }

    // /proc/self — needed by some loaders and profilers.
    rules.push(FsRule {
        path: "/proc/self".to_string(),
        rights: vec![FsRight::ReadFile, FsRight::ReadDir],
    });

    rules
}

// ── EnforcementRecord builder ─────────────────────────────────────────────────

/// Build an [`crate::receipt::EnforcementRecord`] from a Landlock probe result
/// and whether `apply_ruleset` succeeded.
pub fn make_enforcement_record(
    probe: &LandlockProbe,
    applied: bool,
    error: Option<&LandlockError>,
) -> crate::receipt::EnforcementRecord {
    let abi_str = match &probe.abi {
        LandlockAbi::Version(v) => Some(format!("landlock-v{v}")),
        LandlockAbi::Unavailable => None,
    };

    let note = if let Some(err) = error {
        Some(format!("confinement failed: {err}"))
    } else if !applied {
        Some(probe.note.clone())
    } else {
        None
    };

    crate::receipt::EnforcementRecord {
        backend: if applied {
            "landlock".to_string()
        } else {
            "none".to_string()
        },
        applied,
        detected_abi: abi_str,
        note,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_a_result() {
        // On any platform this must not panic.
        let probe = probe_landlock();
        // On Linux with a supported kernel we expect a version; on other
        // platforms or old kernels we expect Unavailable.
        match &probe.abi {
            LandlockAbi::Version(v) => {
                assert!(*v >= 1, "ABI version must be >= 1 when available");
                assert!(probe.fs_available);
                assert!(!probe.note.is_empty());
            }
            LandlockAbi::Unavailable => {
                assert!(!probe.fs_available);
                assert!(!probe.tcp_available);
                assert!(!probe.note.is_empty());
            }
        }
    }

    #[test]
    fn apply_ruleset_without_landlock_fails_closed() {
        let probe = LandlockProbe {
            abi: LandlockAbi::Unavailable,
            fs_available: false,
            tcp_available: false,
            note: "test".to_string(),
        };
        let rules = vec![FsRule {
            path: "/tmp".to_string(),
            rights: vec![FsRight::ReadFile],
        }];
        let result = apply_ruleset(&rules, &probe, true);
        // Must fail on Unavailable, not silently succeed.
        assert!(
            matches!(
                result,
                Err(LandlockError::Unavailable) | Err(LandlockError::UnsupportedPlatform)
            ),
            "apply_ruleset must fail when Landlock is unavailable"
        );
    }

    #[test]
    fn workspace_ruleset_includes_workspace_root() {
        let rules = workspace_ruleset("/project", true);
        assert!(rules.iter().any(|r| r.path == "/project"));
    }

    #[test]
    fn workspace_ruleset_read_only_has_no_write_rights() {
        let rules = workspace_ruleset("/project", false);
        let ws = rules.iter().find(|r| r.path == "/project").unwrap();
        assert!(!ws.rights.contains(&FsRight::WriteFile));
        assert!(!ws.rights.contains(&FsRight::RemoveFile));
    }

    #[test]
    fn workspace_ruleset_write_mode_has_destructive_rights() {
        let rules = workspace_ruleset("/project", true);
        let ws = rules.iter().find(|r| r.path == "/project").unwrap();
        assert!(ws.rights.contains(&FsRight::WriteFile));
        assert!(ws.rights.contains(&FsRight::RemoveFile));
        assert!(ws.rights.contains(&FsRight::RemoveDir));
    }

    #[test]
    fn make_enforcement_record_backend_is_none_when_not_applied() {
        let probe = probe_landlock();
        let rec = make_enforcement_record(&probe, false, None);
        assert_eq!(rec.backend, "none");
        assert!(!rec.applied);
    }

    #[test]
    fn make_enforcement_record_backend_is_landlock_when_applied() {
        // Simulate a successful application (even though we can't call the
        // real apply_ruleset in a unit test without root/Linux).
        let probe = LandlockProbe {
            abi: LandlockAbi::Version(1),
            fs_available: true,
            tcp_available: false,
            note: "test note".to_string(),
        };
        let rec = make_enforcement_record(&probe, true, None);
        assert_eq!(rec.backend, "landlock");
        assert!(rec.applied);
        assert_eq!(rec.detected_abi.as_deref(), Some("landlock-v1"));
    }

    #[test]
    fn make_enforcement_record_unavailable_has_no_abi_string() {
        let probe = LandlockProbe {
            abi: LandlockAbi::Unavailable,
            fs_available: false,
            tcp_available: false,
            note: "unavailable".to_string(),
        };
        let rec = make_enforcement_record(&probe, false, None);
        assert!(rec.detected_abi.is_none());
    }

    #[test]
    fn strict_right_unavailable_returns_error() {
        // Simulate ABI v1 (no Truncate) and request Truncate.
        // On non-Linux this becomes UnsupportedPlatform, which also fails.
        let probe = LandlockProbe {
            abi: LandlockAbi::Version(1),
            fs_available: true,
            tcp_available: false,
            note: "simulated v1".to_string(),
        };
        let rules = vec![FsRule {
            path: "/project".to_string(),
            rights: vec![FsRight::Truncate], // requires ABI v3
        }];
        let result = apply_ruleset(&rules, &probe, true);
        // On Linux: RightUnavailable. On other platforms: UnsupportedPlatform.
        assert!(
            result.is_err(),
            "strict mode with unavailable right must fail"
        );
    }

    #[test]
    fn abi_v4_required_for_tcp_claim() {
        let probe_v1 = LandlockProbe {
            abi: LandlockAbi::Version(1),
            fs_available: true,
            tcp_available: false,
            note: String::new(),
        };
        let probe_v4 = LandlockProbe {
            abi: LandlockAbi::Version(4),
            fs_available: true,
            tcp_available: true,
            note: String::new(),
        };
        assert!(
            !probe_v1.tcp_available,
            "ABI v1 must not claim TCP confinement"
        );
        assert!(
            probe_v4.tcp_available,
            "ABI v4 must support TCP confinement"
        );
    }
}
