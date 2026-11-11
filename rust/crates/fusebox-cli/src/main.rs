//! Fusebox binary entry point.
//!
//! Subcommand dispatch covers `version`, `capabilities`, `help`, `proxy`,
//! `init`, `run`, and `policy`.

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
        Some("policy") => run_policy_command(&args),
        Some(other) => {
            eprintln!("fusebox: unknown subcommand '{other}'");
            eprintln!("Use 'fusebox --help' for usage information.");
            ExitCode::from(1)
        }
        None => {
            print_version();
            ExitCode::SUCCESS
        }
    }
}

/// Execute `fusebox proxy [--framing <mode>] [--shutdown-timeout <secs>] [--grace-period <secs>] -- <executable> [args...]`.
///
/// Arguments before `--` are treated as proxy flags; the executable and its
/// arguments follow after `--`. Using an explicit `--` separator makes it
/// unambiguous that the remaining tokens belong to the child process, not to Fusebox.
fn run_proxy_command(args: &[String]) -> ExitCode {
    // Find the `--` separator.
    let sep_pos = args.iter().position(|a| a == "--");
    let (proxy_flags, child_args): (&[String], &[String]) = match sep_pos {
        Some(pos) => (&args[2..pos], &args[pos + 1..]),
        None => {
            // If --help or -h was passed anywhere in proxy invocation
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

    // Validate: executable must not be empty.
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

    // Build a Tokio runtime for the async proxy.
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

    // Install host signal interception (Ctrl+C on all platforms, SIGTERM on Unix)
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

fn print_version() {
    let output = serde_json::json!({
        "name": "fusebox",
        "version": env!("CARGO_PKG_VERSION"),
        "schema_version": fusebox_core::contracts::SCHEMA_VERSION,
    });
    println!("{output}");
}

fn print_capabilities() {
    let output = serde_json::json!({
        "name": "fusebox",
        "version": env!("CARGO_PKG_VERSION"),
        "schema_version": fusebox_core::contracts::SCHEMA_VERSION,
        "capabilities": ["version", "capabilities", "proxy", "init", "run", "policy"],
        "planned": ["receipts", "verify"],
    });
    println!("{output}");
}

fn print_help() {
    println!("Fusebox — local agent execution gateway");
    println!();
    println!("Usage: fusebox <command> [options]");
    println!();
    println!("Commands:");
    println!("  init            Initialize a workspace intent/policy file");
    println!("  run             Run a supervised command");
    println!("  proxy           Proxy an MCP server over stdio");
    println!("  policy          Evaluate a policy dry-run");
    println!("  version         Print version information");
    println!("  capabilities    Print supported capabilities");
    println!("  help, --help    Show this help");
    println!();
    println!("Init usage:");
    println!("  fusebox init [--session-id <id>] [--overwrite] [<workspace-dir>]");
    println!();
    println!("Run usage:");
    println!("  fusebox run [--allow-escalate] -- <executable> [args...]");
    println!();
    println!("Policy usage:");
    println!("  fusebox policy dry-run --executable <exe> [--argv <arg>...] [--cwd <dir>]");
    println!("  fusebox policy dry-run --json <request-json>");
    println!();
    println!("Proxy usage:");
    println!("  fusebox proxy [options] -- <server> [args...]");
    println!();
    println!("Proxy options:");
    println!("  --framing <mode>           Framing mode: 'newline' (default) or 'content-length'");
    println!("  --shutdown-timeout <secs>  Total shutdown timeout in seconds (default: 10)");
    println!(
        "  --grace-period <secs>      Grace period after stdin EOF before SIGTERM (default: 2)"
    );
}

// ── fusebox init ──────────────────────────────────────────────────────────────

/// Execute `fusebox init [--session-id <id>] [--overwrite] [<workspace-dir>]`.
fn run_init_command(args: &[String]) -> ExitCode {
    use fusebox_core::init::{init, InitOptions};

    let flags = &args[2..];
    let mut session_id = uuid_v4();
    let mut overwrite = false;
    let mut workspace_dir: Option<String> = None;

    let mut i = 0;
    while i < flags.len() {
        match flags[i].as_str() {
            "--session-id" => {
                if i + 1 >= flags.len() {
                    eprintln!("fusebox init: missing value for --session-id");
                    return ExitCode::from(1);
                }
                session_id = flags[i + 1].clone();
                i += 2;
            }
            "--overwrite" => {
                overwrite = true;
                i += 1;
            }
            "--help" | "-h" => {
                println!("Usage: fusebox init [--session-id <id>] [--overwrite] [<workspace-dir>]");
                return ExitCode::SUCCESS;
            }
            other if !other.starts_with('-') => {
                workspace_dir = Some(other.to_string());
                i += 1;
            }
            other => {
                eprintln!("fusebox init: unknown flag '{other}'");
                return ExitCode::from(1);
            }
        }
    }

    let workspace_dir = workspace_dir.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let options = InitOptions {
        workspace_dir: workspace_dir.clone(),
        session_id,
        overwrite,
    };

    match init(&options) {
        Ok(result) => {
            let output = serde_json::json!({
                "status": "ok",
                "policy_path": result.policy_path,
                "session_id": result.contract.session_id,
                "overwritten": result.overwritten,
                "policy_hash": result.contract.policy_hash,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("fusebox init: {e}");
            ExitCode::from(1)
        }
    }
}

// ── fusebox run ───────────────────────────────────────────────────────────────

/// Execute `fusebox run [--allow-escalate] -- <executable> [args...]`.
fn run_run_command(args: &[String]) -> ExitCode {
    use fusebox_core::contracts::ExecRequest;
    use fusebox_core::init::load_policy;
    use fusebox_core::run::{run, RunConfig};

    // Find `--` separator.
    let sep_pos = args.iter().position(|a| a == "--");
    let (run_flags, child_args): (&[String], &[String]) = match sep_pos {
        Some(pos) => (&args[2..pos], &args[pos + 1..]),
        None => {
            eprintln!("fusebox run: missing '--' separator");
            eprintln!("Usage: fusebox run [--allow-escalate] -- <executable> [args...]");
            return ExitCode::from(1);
        }
    };

    if child_args.is_empty() {
        eprintln!("fusebox run: no executable specified after '--'");
        return ExitCode::from(1);
    }

    let mut allow_escalate = false;
    for flag in run_flags {
        match flag.as_str() {
            "--allow-escalate" => allow_escalate = true,
            "--help" | "-h" => {
                println!("Usage: fusebox run [--allow-escalate] -- <executable> [args...]");
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("fusebox run: unknown flag '{other}'");
                return ExitCode::from(1);
            }
        }
    }

    let executable = child_args[0].clone();
    let argv = child_args[1..].to_vec();

    let cwd = match std::env::current_dir() {
        Ok(d) => d.to_string_lossy().to_string(),
        Err(e) => {
            eprintln!("fusebox run: cannot determine working directory: {e}");
            return ExitCode::from(1);
        }
    };

    // Load the policy from the workspace.
    let contract = match load_policy(&cwd) {
        Ok(Some(c)) => c,
        Ok(None) => {
            eprintln!("fusebox run: no policy file found in '{cwd}/.fusebox/policy.json'");
            eprintln!("Run 'fusebox init' first to create a workspace policy.");
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("fusebox run: failed to load policy: {e}");
            return ExitCode::from(1);
        }
    };

    let request = ExecRequest {
        protocol_version: fusebox_core::contracts::SCHEMA_VERSION.to_string(),
        request_id: uuid_v4(),
        session_id: contract.session_id.clone(),
        executable,
        argv,
        cwd: cwd.clone(),
        env_allowlist: vec![],
        timeout_ms: None,
        requested_capabilities: vec![],
    };

    let config = RunConfig {
        allow_escalate,
        capture_output: false,
        timeout_override: None,
    };

    match run(&request, &contract, uuid_v4(), 0, "", &config) {
        Ok(result) => {
            let output = serde_json::json!({
                "status": "ok",
                "verdict": format!("{:?}", result.policy_decision.verdict).to_lowercase(),
                "receipt_id": result.receipt.receipt_id,
                "exit_code": result.process_outcome.exit_code,
                "duration_ms": result.process_outcome.duration_ms,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
            match result.process_outcome.exit_code {
                Some(0) | None => ExitCode::SUCCESS,
                Some(code) => ExitCode::from(code.clamp(1, 125) as u8),
            }
        }
        Err(fusebox_core::run::RunError::Denied(decision, _resolution)) => {
            let output = serde_json::json!({
                "status": "denied",
                "verdict": "deny",
                "reason_code": decision.reason_code,
                "predicted_targets": decision.predicted_targets,
                "user_action_required": decision.user_action_required,
            });
            eprintln!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("fusebox run: {e}");
            ExitCode::from(1)
        }
    }
}

// ── fusebox policy ────────────────────────────────────────────────────────────

/// Execute `fusebox policy dry-run ...`.
fn run_policy_command(args: &[String]) -> ExitCode {
    let subcommand = args.get(2).map(String::as_str);

    match subcommand {
        Some("dry-run") => run_policy_dry_run_command(&args[3..]),
        Some("--help") | Some("-h") | Some("help") | None => {
            println!("Usage: fusebox policy dry-run --executable <exe> [--argv <arg>...] [--cwd <dir>]");
            println!("       fusebox policy dry-run --json <request-json>");
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("fusebox policy: unknown subcommand '{other}'");
            eprintln!("Use 'fusebox policy dry-run ...' or 'fusebox policy --help'");
            ExitCode::from(1)
        }
    }
}

fn run_policy_dry_run_command(flags: &[String]) -> ExitCode {
    use fusebox_core::contracts::ExecRequest;
    use fusebox_core::init::load_policy;
    use fusebox_core::policy::policy_dry_run;

    let mut executable: Option<String> = None;
    let mut argv: Vec<String> = Vec::new();
    let mut json_input: Option<String> = None;
    let mut cwd_override: Option<String> = None;

    let mut i = 0;
    while i < flags.len() {
        match flags[i].as_str() {
            "--executable" => {
                if i + 1 >= flags.len() {
                    eprintln!("fusebox policy dry-run: missing value for --executable");
                    return ExitCode::from(1);
                }
                executable = Some(flags[i + 1].clone());
                i += 2;
            }
            "--argv" => {
                if i + 1 >= flags.len() {
                    eprintln!("fusebox policy dry-run: missing value for --argv");
                    return ExitCode::from(1);
                }
                argv.push(flags[i + 1].clone());
                i += 2;
            }
            "--cwd" => {
                if i + 1 >= flags.len() {
                    eprintln!("fusebox policy dry-run: missing value for --cwd");
                    return ExitCode::from(1);
                }
                cwd_override = Some(flags[i + 1].clone());
                i += 2;
            }
            "--json" => {
                if i + 1 >= flags.len() {
                    eprintln!("fusebox policy dry-run: missing value for --json");
                    return ExitCode::from(1);
                }
                json_input = Some(flags[i + 1].clone());
                i += 2;
            }
            other => {
                eprintln!("fusebox policy dry-run: unknown flag '{other}'");
                return ExitCode::from(1);
            }
        }
    }

    let cwd = cwd_override.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let contract = match load_policy(&cwd) {
        Ok(Some(c)) => c,
        Ok(None) => {
            eprintln!("fusebox policy: no policy file found in '{cwd}/.fusebox/policy.json'");
            eprintln!("Run 'fusebox init' first.");
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("fusebox policy: failed to load policy: {e}");
            return ExitCode::from(1);
        }
    };

    let request: ExecRequest = if let Some(json) = json_input {
        match serde_json::from_str(&json) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("fusebox policy: failed to parse --json request: {e}");
                return ExitCode::from(1);
            }
        }
    } else {
        match executable {
            None => {
                eprintln!("fusebox policy dry-run: --executable is required");
                return ExitCode::from(1);
            }
            Some(exe) => ExecRequest {
                protocol_version: fusebox_core::contracts::SCHEMA_VERSION.to_string(),
                request_id: uuid_v4(),
                session_id: contract.session_id.clone(),
                executable: exe,
                argv,
                cwd: cwd.clone(),
                env_allowlist: vec![],
                timeout_ms: None,
                requested_capabilities: vec![],
            },
        }
    };

    let (decision, resolution) = policy_dry_run(&request, &contract);

    let output = serde_json::json!({
        "verdict": format!("{:?}", decision.verdict).to_lowercase(),
        "reason_code": decision.reason_code,
        "rule_id": decision.rule_id,
        "predicted_targets": decision.predicted_targets,
        "resolution_status": format!("{:?}", decision.resolution_status).to_lowercase(),
        "user_action_required": decision.user_action_required,
        "policy_hash": decision.policy_hash,
        "resolver": {
            "supported": resolution.supported,
            "confidence": format!("{:?}", resolution.confidence).to_lowercase(),
            "command_class": format!("{:?}", resolution.command_class).to_lowercase(),
            "warnings": resolution.warnings,
        }
    });

    println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());

    // Exit code reflects the verdict: 0 = allow/log, 1 = deny/escalate/unsupported.
    match decision.verdict {
        fusebox_core::contracts::Verdict::Allow | fusebox_core::contracts::Verdict::Log => {
            ExitCode::SUCCESS
        }
        _ => ExitCode::from(1),
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/// Generate a simple pseudo-random session/request ID without external dependencies.
/// Uses process ID, thread ID, and timestamp for reasonable uniqueness on a single machine.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Use u128 throughout to avoid mixed-type arithmetic.
    let t: u128 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    // Mix entropy sources into a hex string formatted as UUID v4 shape.
    let a = (t & 0xFFFF_FFFF) as u32;
    let b = ((t >> 32) & 0xFFFF) as u16;
    let c = (0x4000 | ((t >> 48) & 0x0FFF)) as u16; // version 4
    let d = (0x8000 | ((pid ^ (t >> 60)) & 0x3FFF)) as u16; // variant
    let e = ((t >> 16) ^ (pid * 0x9e37)) & 0xFFFF_FFFF_FFFF;
    format!("{a:08x}-{b:04x}-{c:04x}-{d:04x}-{e:012x}")
}
