//! Fusebox binary entry point.
//!
//! Subcommand dispatch covers `version`, `capabilities`, `help`, `proxy`,
//! `init`, and `run`.
//!
//! - `proxy`: launch a child MCP server and relay newline-delimited or
//!   Content-Length JSON-RPC frames bidirectionally.
//! - `init`: write a default `.fusebox/policy.json` in the current directory.
//! - `run`: evaluate a command against the policy, apply OS confinement, and
//!   execute with a receipt written to stdout (or the journal).

use std::process::ExitCode;
use std::time::Duration;

use fusebox_core::framing::FramingMode;
use fusebox_core::proxy::{run_proxy, ProxyConfig, ProxyError};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let subcommand = args.get(1).map(String::as_str);

    match subcommand {
        Some("version") | Some("--version") | Some("-V") => {
            print_version();
            ExitCode::SUCCESS
        }
        Some("capabilities") | Some("--capabilities") => {
            print_capabilities();
            ExitCode::SUCCESS
        }
        Some("help") | Some("--help") | Some("-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some("proxy") => run_proxy_command(&args),
        Some("init") => run_init_command(&args),
        Some("run") => run_run_command(&args),
        Some(other) => {
            eprintln!("fusebox: unknown subcommand '{other}'");
            eprintln!("Use 'fusebox --help' to see available commands.");
            ExitCode::from(1)
        }
        None => {
            print_version();
            ExitCode::SUCCESS
        }
    }
}

// ── fusebox init ──────────────────────────────────────────────────────────────

/// Execute `fusebox init [--overwrite] [--workspace <dir>]`.
///
/// Creates `.fusebox/policy.json` with conservative defaults.
fn run_init_command(args: &[String]) -> ExitCode {
    let init_args = &args[2..];

    if init_args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: fusebox init [--overwrite] [--workspace <dir>]");
        println!();
        println!("Creates .fusebox/policy.json in the specified workspace (default: cwd).");
        println!("Flags:");
        println!("  --overwrite     Replace an existing policy file");
        println!("  --workspace     Workspace directory (default: current directory)");
        return ExitCode::SUCCESS;
    }

    let mut overwrite = false;
    let mut workspace: Option<String> = None;
    let mut i = 0;
    while i < init_args.len() {
        match init_args[i].as_str() {
            "--overwrite" => {
                overwrite = true;
                i += 1;
            }
            "--workspace" => {
                if i + 1 >= init_args.len() {
                    eprintln!("fusebox init: missing value for --workspace");
                    return ExitCode::from(1);
                }
                workspace = Some(init_args[i + 1].clone());
                i += 2;
            }
            other => {
                eprintln!("fusebox init: unknown flag '{other}'");
                return ExitCode::from(1);
            }
        }
    }

    let workspace_dir = if let Some(w) = workspace {
        std::path::PathBuf::from(w)
    } else {
        match std::env::current_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("fusebox init: cannot determine working directory: {e}");
                return ExitCode::from(1);
            }
        }
    };

    let contract = fusebox_core::intent_io::default_contract(&workspace_dir);

    match fusebox_core::intent_io::write_policy(&workspace_dir, &contract, overwrite) {
        Ok(path) => {
            let output = serde_json::json!({
                "status": "ok",
                "policy_file": path.display().to_string(),
                "workspace_roots": contract.workspace_roots,
                "network_policy": contract.network_policy,
                "approval_policy": contract.approval_policy,
                "protected_roots": contract.protected_roots,
            });
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(fusebox_core::intent_io::IntentIoError::AlreadyExists(p)) => {
            let output = serde_json::json!({
                "status": "error",
                "code": "ALREADY_EXISTS",
                "message": format!("policy file already exists: {}; use --overwrite to replace it", p.display()),
            });
            eprintln!("{output}");
            ExitCode::from(1)
        }
        Err(e) => {
            let output = serde_json::json!({
                "status": "error",
                "code": "IO_ERROR",
                "message": e.to_string(),
            });
            eprintln!("{output}");
            ExitCode::from(1)
        }
    }
}

// ── fusebox run ───────────────────────────────────────────────────────────────

/// Execute `fusebox run [--allow-escalate] [--no-confinement] -- <executable> [args...]`.
///
/// Loads `.fusebox/policy.json`, evaluates the command against the policy,
/// applies Landlock confinement (Linux only), executes the child, and emits
/// a receipt JSON to stdout.
fn run_run_command(args: &[String]) -> ExitCode {
    // Find `--` separator.
    let sep_pos = args.iter().position(|a| a == "--");
    let (run_flags, child_args): (&[String], &[String]) = match sep_pos {
        Some(pos) => (&args[2..pos], &args[pos + 1..]),
        None => {
            if args.iter().any(|a| a == "--help" || a == "-h") {
                print_run_help();
                return ExitCode::SUCCESS;
            }
            eprintln!("fusebox run: missing '--' separator");
            eprintln!("Usage: fusebox run [flags] -- <executable> [args...]");
            return ExitCode::from(1);
        }
    };

    if run_flags.iter().any(|a| a == "--help" || a == "-h") {
        print_run_help();
        return ExitCode::SUCCESS;
    }

    if child_args.is_empty() {
        eprintln!("fusebox run: no executable specified after '--'");
        return ExitCode::from(1);
    }

    let mut allow_escalate = false;
    let mut no_confinement = false;
    let mut timeout_ms: Option<u64> = None;

    let mut i = 0;
    while i < run_flags.len() {
        match run_flags[i].as_str() {
            "--allow-escalate" => {
                allow_escalate = true;
                i += 1;
            }
            "--no-confinement" => {
                no_confinement = true;
                i += 1;
            }
            "--timeout" => {
                if i + 1 >= run_flags.len() {
                    eprintln!("fusebox run: missing value for --timeout");
                    return ExitCode::from(1);
                }
                match run_flags[i + 1].parse::<u64>() {
                    Ok(ms) => timeout_ms = Some(ms),
                    Err(_) => {
                        eprintln!("fusebox run: invalid milliseconds for --timeout");
                        return ExitCode::from(1);
                    }
                }
                i += 2;
            }
            other => {
                eprintln!("fusebox run: unknown flag '{other}'");
                return ExitCode::from(1);
            }
        }
    }

    let executable = child_args[0].clone();
    let argv: Vec<String> = child_args[1..].to_vec();

    let cwd = match std::env::current_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("fusebox run: cannot determine working directory: {e}");
            return ExitCode::from(1);
        }
    };

    // Load policy.
    let contract = match fusebox_core::intent_io::read_policy(&cwd) {
        Ok(c) => c,
        Err(e) => {
            let output = serde_json::json!({
                "status": "error",
                "code": "POLICY_NOT_FOUND",
                "message": format!("cannot read policy: {e}; run 'fusebox init' first"),
            });
            eprintln!("{output}");
            return ExitCode::from(1);
        }
    };

    // Build exec request.
    let session_id = contract.session_id.clone();
    let request = fusebox_core::contracts::ExecRequest {
        protocol_version: fusebox_core::contracts::SCHEMA_VERSION.to_string(),
        request_id: format!("req-{}", std::process::id()),
        session_id,
        executable: executable.clone(),
        argv: argv.clone(),
        cwd: cwd.to_string_lossy().to_string(),
        env_allowlist: vec![],
        timeout_ms,
        requested_capabilities: vec![],
    };

    // Policy dry-run.
    let (decision, resolution) = fusebox_core::policy::policy_dry_run(&request, &contract);

    use fusebox_core::contracts::Verdict;
    let verdict_ok = matches!(decision.verdict, Verdict::Allow | Verdict::Log)
        || (allow_escalate && matches!(decision.verdict, Verdict::Escalate));

    if !verdict_ok {
        // Emit denied receipt.
        let rec = build_denied_receipt(&request, &decision, &cwd.to_string_lossy());
        let output = serde_json::json!({
            "status": "denied",
            "verdict": decision.verdict,
            "reason_code": decision.reason_code,
            "predicted_targets": decision.predicted_targets,
            "resolution_warnings": resolution.warnings,
            "receipt": rec,
        });
        println!("{output}");
        return ExitCode::from(1);
    }

    // Probe confinement.
    let probe = fusebox_core::landlock::probe_landlock();
    let allow_writes = !contract.write_roots.is_empty();

    // Enforce confinement (Linux only).
    let (confinement_applied, confinement_error) = if no_confinement {
        (false, None)
    } else {
        match probe.abi {
            fusebox_core::landlock::LandlockAbi::Version(_) => {
                let rules = fusebox_core::landlock::workspace_ruleset(
                    contract
                        .workspace_roots
                        .first()
                        .map(String::as_str)
                        .unwrap_or("/"),
                    allow_writes,
                );
                match fusebox_core::landlock::apply_ruleset(&rules, &probe, false) {
                    Ok(()) => (true, None),
                    Err(e) => {
                        // Fail closed: if confinement was expected and fails, deny.
                        eprintln!("fusebox run: confinement failed: {e}");
                        return ExitCode::from(1);
                    }
                }
            }
            fusebox_core::landlock::LandlockAbi::Unavailable => {
                // Not a Linux kernel with Landlock — document but don't block.
                // The execution still proceeds; the receipt records no confinement.
                eprintln!(
                    "fusebox run: [warning] Landlock not available on this kernel; running without filesystem confinement"
                );
                (false, Some("Landlock unavailable".to_string()))
            }
        }
    };

    let enforcement_record = fusebox_core::landlock::make_enforcement_record(
        &probe,
        confinement_applied,
        confinement_error
            .as_deref()
            .map(|e| fusebox_core::landlock::LandlockError::OsError(e.to_string()))
            .as_ref(),
    );

    // Execute the child.
    use std::time::Instant;
    let start = Instant::now();

    let mut cmd = std::process::Command::new(&executable);
    cmd.args(&argv);
    cmd.current_dir(&cwd);
    cmd.env_clear();

    // Allow only explicitly listed env vars.
    for key in &contract.allowed_command_classes {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    let (exit_code, state) = match cmd.status() {
        Ok(status) => {
            let code = status.code().unwrap_or(1);
            (Some(code), fusebox_core::receipt::ProcessState::Completed)
        }
        Err(e) => {
            eprintln!("fusebox run: failed to start child process: {e}");
            (None, fusebox_core::receipt::ProcessState::Failed)
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    // Build and emit receipt.
    use fusebox_core::contracts::SCHEMA_VERSION;
    use fusebox_core::receipt::{CommandReceipt, OutputDigests, ProcessOutcome, RequestSummary};
    use fusebox_core::verify::hash_receipt;

    let receipt_id = format!("rcpt-{}", std::process::id());
    let previous_hash = String::new(); // journal-less single-receipt mode

    let mut receipt = CommandReceipt {
        schema_version: SCHEMA_VERSION.to_string(),
        receipt_id,
        sequence: 0,
        recorded_at: current_timestamp(),
        session_id: request.session_id.clone(),
        request_id: request.request_id.clone(),
        request_summary: RequestSummary {
            executable_name: std::path::Path::new(&executable)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&executable)
                .to_string(),
            argc: argv.len(),
            cwd: cwd.to_string_lossy().to_string(),
        },
        policy_decision: decision.clone(),
        enforcement: enforcement_record,
        process_outcome: ProcessOutcome {
            state: state.clone(),
            exit_code,
            duration_ms: Some(duration_ms),
            signal: None,
        },
        output_digests: Some(OutputDigests {
            stdout_sha256: None,
            stderr_sha256: None,
            stdout_truncated: false,
            stderr_truncated: false,
        }),
        previous_hash,
        record_hash: String::new(),
    };

    receipt.record_hash = match hash_receipt(&receipt) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("fusebox run: failed to hash receipt: {e}");
            "HASH_ERROR".to_string()
        }
    };

    let exit_ok = exit_code.map(|c| c == 0).unwrap_or(false);
    let output = serde_json::json!({
        "status": if exit_ok { "ok" } else { "failed" },
        "verdict": decision.verdict,
        "confinement_applied": confinement_applied,
        "predicted_targets": decision.predicted_targets,
        "resolution_warnings": resolution.warnings,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
        "receipt": receipt,
    });
    println!("{output}");

    match exit_code {
        Some(0) => ExitCode::SUCCESS,
        Some(code) => ExitCode::from(code.clamp(1, 125) as u8),
        None => ExitCode::from(1),
    }
}

fn build_denied_receipt(
    request: &fusebox_core::contracts::ExecRequest,
    decision: &fusebox_core::contracts::PolicyDecision,
    cwd: &str,
) -> serde_json::Value {
    use fusebox_core::receipt::denied_receipt;
    use fusebox_core::verify::hash_receipt;

    let executable_name = std::path::Path::new(&request.executable)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&request.executable)
        .to_string();

    let mut receipt = denied_receipt(
        format!("rcpt-denied-{}", std::process::id()),
        0,
        current_timestamp(),
        request.session_id.clone(),
        request.request_id.clone(),
        executable_name,
        request.argv.len(),
        cwd,
        decision.clone(),
        "",
    );
    receipt.record_hash = hash_receipt(&receipt).unwrap_or_default();
    serde_json::to_value(&receipt).unwrap_or_default()
}

fn current_timestamp() -> String {
    // Produce an ISO-8601-like timestamp without external dependencies.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Format as YYYY-MM-DDTHH:MM:SSZ (approximate — no leap seconds).
    let s = secs;
    let sec = s % 60;
    let min = (s / 60) % 60;
    let hour = (s / 3600) % 24;
    let days_since_epoch = s / 86400;
    // Compute year/month/day from days since 1970-01-01 (Gregorian).
    let (year, month, day) = days_to_ymd(days_since_epoch);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Proleptic Gregorian calendar from days since 1970-01-01.
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn print_run_help() {
    println!("Usage: fusebox run [flags] -- <executable> [args...]");
    println!();
    println!("Evaluate a command against the active policy and execute it supervised.");
    println!("Requires .fusebox/policy.json in the current directory (run 'fusebox init' first).");
    println!();
    println!("Flags:");
    println!("  --allow-escalate    Allow execution when verdict is 'escalate'");
    println!("  --no-confinement    Skip Landlock confinement (for diagnostics only)");
    println!("  --timeout <ms>      Kill child after <ms> milliseconds");
}

// ── fusebox proxy ─────────────────────────────────────────────────────────────

/// Execute `fusebox proxy [--framing <mode>] [--shutdown-timeout <secs>] [--grace-period <secs>] -- <executable> [args...]`.
fn run_proxy_command(args: &[String]) -> ExitCode {
    let sep_pos = args.iter().position(|a| a == "--");
    let (proxy_flags, child_args): (&[String], &[String]) = match sep_pos {
        Some(pos) => (&args[2..pos], &args[pos + 1..]),
        None => {
            if args
                .iter()
                .any(|a| a == "--help" || a == "-h" || a == "help")
            {
                print_help();
                return ExitCode::SUCCESS;
            }
            eprintln!("fusebox proxy: missing '--' separator");
            eprintln!("Usage: fusebox proxy [--framing <mode>] -- <server> [args...]");
            return ExitCode::from(1);
        }
    };

    if proxy_flags
        .iter()
        .any(|a| a == "--help" || a == "-h" || a == "help")
    {
        print_help();
        return ExitCode::SUCCESS;
    }

    if child_args.is_empty() {
        eprintln!("fusebox proxy: no child server specified after '--'");
        eprintln!("Usage: fusebox proxy [--framing <mode>] -- <server> [args...]");
        return ExitCode::from(1);
    }

    let mut framing_mode: Option<FramingMode> = None;
    let mut shutdown_timeout = Duration::from_secs(10);
    let mut shutdown_grace_period = Duration::from_secs(2);

    let mut i = 0;
    while i < proxy_flags.len() {
        match proxy_flags[i].as_str() {
            "--framing" => {
                if i + 1 >= proxy_flags.len() {
                    eprintln!("fusebox proxy: missing value for --framing");
                    return ExitCode::from(1);
                }
                match proxy_flags[i + 1].parse::<FramingMode>() {
                    Ok(m) => framing_mode = Some(m),
                    Err(e) => {
                        eprintln!("fusebox proxy: {e}");
                        return ExitCode::from(1);
                    }
                }
                i += 2;
            }
            "--shutdown-timeout" => {
                if i + 1 >= proxy_flags.len() {
                    eprintln!("fusebox proxy: missing value for --shutdown-timeout");
                    return ExitCode::from(1);
                }
                match proxy_flags[i + 1].parse::<u64>() {
                    Ok(secs) => shutdown_timeout = Duration::from_secs(secs),
                    Err(_) => {
                        eprintln!("fusebox proxy: invalid seconds for --shutdown-timeout");
                        return ExitCode::from(1);
                    }
                }
                i += 2;
            }
            "--grace-period" => {
                if i + 1 >= proxy_flags.len() {
                    eprintln!("fusebox proxy: missing value for --grace-period");
                    return ExitCode::from(1);
                }
                match proxy_flags[i + 1].parse::<u64>() {
                    Ok(secs) => shutdown_grace_period = Duration::from_secs(secs),
                    Err(_) => {
                        eprintln!("fusebox proxy: invalid seconds for --grace-period");
                        return ExitCode::from(1);
                    }
                }
                i += 2;
            }
            other => {
                eprintln!("fusebox proxy: unknown flag '{other}'");
                eprintln!("Usage: fusebox proxy [--framing <newline|content-length>] -- <server> [args...]");
                return ExitCode::from(1);
            }
        }
    }

    let framing_mode = framing_mode.unwrap_or_else(|| {
        if let Ok(env_val) = std::env::var("FUSEBOX_FRAMING") {
            env_val
                .parse::<FramingMode>()
                .unwrap_or(FramingMode::Newline)
        } else {
            FramingMode::Newline
        }
    });

    let executable = child_args[0].clone();
    let argv = child_args[1..].to_vec();

    if executable.is_empty() {
        eprintln!("fusebox proxy: child executable must not be empty");
        return ExitCode::from(1);
    }

    let cwd = match std::env::current_dir() {
        Ok(d) => d.to_string_lossy().to_string(),
        Err(e) => {
            eprintln!("fusebox proxy: cannot determine working directory: {e}");
            return ExitCode::from(1);
        }
    };

    let secret_patterns: Vec<String> = std::env::var("FUSEBOX_SECRET_PATTERNS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("fusebox proxy: failed to build async runtime: {e}");
            return ExitCode::from(1);
        }
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    runtime.spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = sigterm.recv() => {},
                }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = shutdown_tx.send(true);
    });

    let config = ProxyConfig {
        executable,
        argv,
        cwd,
        secret_patterns,
        shutdown_timeout,
        shutdown_grace_period,
        framing_mode,
        shutdown_signal: Some(shutdown_rx),
    };

    let result = runtime.block_on(run_proxy(
        config,
        tokio::io::stdin(),
        tokio::io::stdout(),
        tokio::io::stderr(),
    ));

    match result {
        Ok(outcome) => {
            if outcome.timed_out {
                eprintln!("fusebox proxy: child did not exit within the shutdown timeout; killed");
            }
            match outcome.child_exit_code {
                Some(0) => ExitCode::SUCCESS,
                Some(code) => ExitCode::from(code.clamp(1, 125) as u8),
                None => ExitCode::from(1),
            }
        }
        Err(ProxyError::SpawnFailed(e)) => {
            eprintln!("fusebox proxy: failed to start child: {e}");
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("fusebox proxy: {e}");
            ExitCode::from(1)
        }
    }
}

// ── print helpers ─────────────────────────────────────────────────────────────

fn print_version() {
    let output = serde_json::json!({
        "name": "fusebox",
        "version": env!("CARGO_PKG_VERSION"),
        "schema_version": fusebox_core::contracts::SCHEMA_VERSION,
    });
    println!("{output}");
}

fn print_capabilities() {
    let probe = fusebox_core::landlock::probe_landlock();
    let confinement = match probe.abi {
        fusebox_core::landlock::LandlockAbi::Version(v) => format!("landlock-v{v}"),
        fusebox_core::landlock::LandlockAbi::Unavailable => "none".to_string(),
    };
    let output = serde_json::json!({
        "name": "fusebox",
        "version": env!("CARGO_PKG_VERSION"),
        "schema_version": fusebox_core::contracts::SCHEMA_VERSION,
        "capabilities": ["version", "capabilities", "proxy", "init", "run"],
        "confinement": confinement,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });
    println!("{output}");
}

fn print_help() {
    println!("Fusebox — local agent execution gateway");
    println!();
    println!("Usage: fusebox <command> [options]");
    println!();
    println!("Commands:");
    println!("  version         Print version information");
    println!("  capabilities    Print supported capabilities and confinement status");
    println!("  init            Create .fusebox/policy.json in the current workspace");
    println!("  run             Evaluate a command against policy and run it supervised");
    println!("  proxy           Proxy an MCP server over stdio");
    println!("  help, --help    Show this help");
    println!();
    println!("Run 'fusebox <command> --help' for command-specific usage.");
}
