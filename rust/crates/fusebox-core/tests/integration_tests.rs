use std::time::Duration;

use fusebox_core::framing::FramingMode;
use fusebox_core::proxy::{run_proxy, ProxyConfig};

#[tokio::test]
async fn test_proxy_integration_stdout_and_stderr_relay() {
    #[cfg(windows)]
    let (executable, argv) = (
        "cmd.exe".to_string(),
        vec![
            "/c".to_string(),
            "echo [{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"status\":\"ok\"}}] & echo [worker] diagnostic log 1>&2".to_string(),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"status\":\"ok\"}}'; echo '[worker] diagnostic log' >&2".to_string(),
        ],
    );

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![],
        shutdown_timeout: Duration::from_secs(5),
        shutdown_grace_period: Duration::from_secs(1),
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();
    assert_eq!(outcome.child_exit_code, Some(0));
    assert!(!outcome.timed_out);

    let diag_str = String::from_utf8_lossy(&diag_sink);
    assert!(diag_str.contains("[child:stderr]"));
    assert!(diag_str.contains("[worker] diagnostic log"));
}

#[tokio::test]
async fn test_proxy_integration_content_length_mode() {
    let payload = r#"{"jsonrpc":"2.0","id":2,"result":{"data":"content-length-test"}}"#;
    let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);

    #[cfg(windows)]
    let bytes_csv = frame
        .as_bytes()
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(",");

    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            format!(
                "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([byte[]]@({bytes_csv}))); [Console]::Error.WriteLine('[worker] cl log')"
            ),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            format!("printf '{frame}'; echo '[worker] cl log' >&2"),
        ],
    );

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![],
        shutdown_timeout: Duration::from_secs(5),
        shutdown_grace_period: Duration::from_secs(1),
        framing_mode: FramingMode::ContentLength,
        shutdown_signal: None,
    };

    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();
    assert_eq!(outcome.child_exit_code, Some(0));
    assert!(!outcome.timed_out);

    let stdout_str = String::from_utf8_lossy(&host_stdout);
    assert!(stdout_str.starts_with("Content-Length: "));
    assert!(stdout_str.contains(payload));
}

#[tokio::test]
async fn test_proxy_integration_stderr_secret_redaction() {
    let secret = "sk-supersecret-token-integration";
    #[cfg(windows)]
    let (executable, argv) = (
        "cmd.exe".to_string(),
        vec!["/c".to_string(), format!("echo secret leak {secret} 1>&2")],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            format!("echo 'secret leak {}' >&2", secret),
        ],
    );

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![secret.to_string()],
        shutdown_timeout: Duration::from_secs(5),
        shutdown_grace_period: Duration::from_secs(1),
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();

    let diag_str = String::from_utf8_lossy(&diag_sink);
    assert!(
        !diag_str.contains(secret),
        "secret must not appear in diag output"
    );
    assert!(diag_str.contains("[child:stderr] line redacted (contains secret pattern)"));
    assert!(!outcome.diagnostics.iter().any(|d| d.contains(secret)));
}

#[tokio::test]
async fn test_proxy_integration_stdin_eof_drain_final_response() {
    let payload = r#"{"jsonrpc":"2.0","id":99,"result":"pong"}"#;
    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            format!(
                "Start-Sleep -Milliseconds 300; [Console]::Out.WriteLine('{payload}'); [Console]::Error.WriteLine('[worker] drained log')"
            ),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            format!("sleep 0.3; echo '{payload}'; echo '[worker] drained log' >&2"),
        ],
    );

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![],
        shutdown_timeout: Duration::from_secs(5),
        shutdown_grace_period: Duration::from_secs(2),
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    // Host stdin closes immediately (EOF)
    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();
    assert_eq!(outcome.child_exit_code, Some(0));
    assert!(!outcome.timed_out);

    let stdout_str = String::from_utf8_lossy(&host_stdout);
    assert!(
        stdout_str.contains(payload),
        "final response must be drained despite host stdin EOF"
    );

    let diag_str = String::from_utf8_lossy(&diag_sink);
    assert!(diag_str.contains("[child:stderr] [worker] drained log"));
}

#[tokio::test]
async fn test_proxy_integration_child_ignoring_stdin_eof_killed_by_timeout() {
    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "Start-Sleep -Seconds 60".to_string(),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec!["-c".to_string(), "sleep 60".to_string()],
    );

    let timeout = Duration::from_millis(600);
    let grace = Duration::from_millis(200);

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![],
        shutdown_timeout: timeout,
        shutdown_grace_period: grace,
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    let start = std::time::Instant::now();
    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    let elapsed = start.elapsed();

    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();
    assert!(
        outcome.timed_out,
        "child should have timed out and been killed"
    );
    assert!(
        elapsed >= timeout && elapsed < Duration::from_secs(4),
        "shutdown must complete near timeout, elapsed was {:?}",
        elapsed
    );
}

#[tokio::test]
async fn test_proxy_integration_shutdown_signal_propagation() {
    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "Start-Sleep -Seconds 60".to_string(),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec!["-c".to_string(), "sleep 60".to_string()],
    );

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let config = ProxyConfig {
        executable,
        argv,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        secret_patterns: vec![],
        shutdown_timeout: Duration::from_millis(800),
        shutdown_grace_period: Duration::from_millis(200),
        framing_mode: FramingMode::Newline,
        shutdown_signal: Some(shutdown_rx),
    };

    // Spawn a background task to trigger the shutdown signal after 100ms
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = shutdown_tx.send(true);
    });

    // Provide a host stdin that does not close on its own (never yields EOF)
    let (host_stdin, _stdin_writer) = tokio::io::duplex(64);
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let start = std::time::Instant::now();
    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    let elapsed = start.elapsed();

    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();
    assert!(
        outcome.timed_out,
        "child should be forcefully killed after signal and timeout"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "signal must terminate proxy promptly, elapsed was {:?}",
        elapsed
    );
}
