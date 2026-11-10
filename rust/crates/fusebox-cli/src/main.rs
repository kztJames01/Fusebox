//! Fusebox binary entry point.
//!
//! Subcommand dispatch covers `version`, `capabilities`, `help`, and `proxy`.
//! The `proxy` command launches a child MCP server and relays newline-delimited
//! or Content-Length JSON-RPC frames bidirectionally, routing stray child stdout
//! to stderr as bounded diagnostics.

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
        Some(other) => {
            eprintln!("fusebox: unknown subcommand '{other}'");
            eprintln!("Use 'fusebox version', 'fusebox capabilities', 'fusebox proxy -- <server> [args...]', or 'fusebox --help'");
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
        "capabilities": ["version", "capabilities", "proxy"],
        "planned": ["run", "receipts", "verify", "policy"],
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
    println!("  capabilities    Print supported capabilities");
    println!("  proxy           Proxy an MCP server over stdio");
    println!("  help, --help    Show this help");
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
