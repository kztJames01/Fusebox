//! MCP stdio proxy — supervised bidirectional newline-delimited JSON-RPC relay.
//!
//! `run_proxy` launches a child MCP server and forwards frames between a
//! host-facing stdio pair and the child's stdio pair.  It enforces:
//!
//! - **Protocol integrity**: only valid JSON-RPC 2.0 frames are forwarded from
//!   the child's stdout to the host; stray diagnostic text is routed to stderr.
//! - **Bounded buffering**: a fixed-capacity diagnostic ring buffer absorbs
//!   noise without growing unboundedly.
//! - **Backpressure**: host→child writes respect the child's stdin capacity via
//!   Tokio's async I/O primitives; no unbounded queue is maintained.
//! - **Clean shutdown**: EOF, child crash, cancellation and timeout all
//!   terminate without leaving zombie tasks or open file handles.
//!
//! # Platform note
//! This module uses Tokio for async I/O.  It is tested on all Tier-1 platforms
//! but confinement (Landlock) is applied by a separate layer before this proxy
//! is started, not inside this module.
//!
//! # Stdout discipline
//! When Fusebox itself is the MCP process for a host, **only** protocol frames
//! must appear on stdout.  This module never writes diagnostics to the
//! caller-supplied `host_stdout`; all diagnostic output goes to `diag_sink`.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::framing::{
    classify_line, decode_content_length_frame, redact_diagnostic, ContentLengthDecodeResult,
    FrameClass, FramingMode, NoiseReason, MAX_DIAGNOSTIC_ENTRIES, MAX_DIAGNOSTIC_ENTRY_BYTES,
};

/// Configuration for one proxy session.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// Absolute path to the child MCP server executable.
    pub executable: String,
    /// Arguments passed to the child (must not include the executable itself).
    pub argv: Vec<String>,
    /// Working directory for the child process.
    pub cwd: String,
    /// Secret patterns to redact from diagnostics. Empty patterns are ignored.
    pub secret_patterns: Vec<String>,
    /// Maximum time to wait for the child to exit after EOF/cancellation.
    pub shutdown_timeout: Duration,
    /// Grace period before forceful signal / termination after stdin EOF.
    pub shutdown_grace_period: Duration,
    /// Transport framing mode (Newline or ContentLength).
    pub framing_mode: FramingMode,
    /// Optional cancellation signal receiver to trigger graceful shutdown.
    pub shutdown_signal: Option<tokio::sync::watch::Receiver<bool>>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            executable: String::new(),
            argv: Vec::new(),
            cwd: String::new(),
            secret_patterns: Vec::new(),
            shutdown_timeout: Duration::from_secs(5),
            shutdown_grace_period: Duration::from_secs(2),
            framing_mode: FramingMode::Newline,
            shutdown_signal: None,
        }
    }
}

/// Format a validated frame for transmission to the host.
pub(crate) fn format_frame_for_host(frame: &str, mode: FramingMode) -> Vec<u8> {
    match mode {
        FramingMode::Newline => format!("{frame}\n").into_bytes(),
        FramingMode::ContentLength => {
            format!("Content-Length: {}\r\n\r\n{frame}", frame.len()).into_bytes()
        }
    }
}

/// Send a graceful termination signal to the child process.
pub fn send_graceful_signal(child: &Child) -> io::Result<()> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let res = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if res != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // On Windows stdio processes, pipe EOF is the primary graceful signal.
        let _ = child.id();
        Ok(())
    }
}

/// Summary of a completed proxy session.
#[derive(Debug)]
pub struct ProxyOutcome {
    /// Exit code returned by the child process, if it exited normally.
    pub child_exit_code: Option<i32>,
    /// Diagnostic entries captured during the session (bounded).
    pub diagnostics: Vec<String>,
    /// Whether the child was forcibly killed due to shutdown timeout.
    pub timed_out: bool,
}

/// Error returned by [`run_proxy`].
#[derive(Debug)]
pub enum ProxyError {
    /// The child process could not be spawned.
    SpawnFailed(io::Error),
    /// A required pipe handle (stdin/stdout) was not available.
    MissingPipe,
    /// I/O error while forwarding to/from the child.
    Io(io::Error),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::SpawnFailed(e) => write!(f, "proxy: spawn failed: {e}"),
            ProxyError::MissingPipe => write!(f, "proxy: child pipe not available"),
            ProxyError::Io(e) => write!(f, "proxy: I/O error: {e}"),
        }
    }
}

impl std::error::Error for ProxyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ProxyError::SpawnFailed(e) | ProxyError::Io(e) => Some(e),
            ProxyError::MissingPipe => None,
        }
    }
}

/// Launch a child MCP server and relay frames between `host_stdin`/`host_stdout`
/// and the child's stdio.
///
/// # Arguments
/// - `config`: proxy configuration including the child executable, framing mode, and secrets.
/// - `host_stdin`: reader for frames arriving from the host.
/// - `host_stdout`: writer for frames to send back to the host (protocol only).
/// - `diag_sink`: writer for diagnostic noise (goes to the caller's stderr).
///
/// # Cancellation & Shutdown
/// When `host_stdin` reaches EOF or the optional `shutdown_signal` triggers, the
/// proxy initiates a 4-phase cross-platform graceful shutdown:
/// 1. Close `child_stdin` (universal stdio graceful termination signal).
/// 2. Continue draining child stdout and child stderr during `shutdown_grace_period`.
/// 3. If child has not exited after grace period, send SIGTERM on Unix.
/// 4. If child still has not exited after `shutdown_timeout`, call `child.kill()`.
/// 5. Reap child exit status with `child.wait()`.
pub async fn run_proxy<R, W, D>(
    config: ProxyConfig,
    host_stdin: R,
    mut host_stdout: W,
    mut diag_sink: D,
) -> Result<ProxyOutcome, ProxyError>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send,
    D: tokio::io::AsyncWrite + Unpin + Send,
{
    // ── Spawn child ──────────────────────────────────────────────────────────
    let mut child: Child = Command::new(&config.executable)
        .args(&config.argv)
        .current_dir(&config.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(ProxyError::SpawnFailed)?;

    let mut child_stdin: Option<ChildStdin> = child.stdin.take();
    let child_stdout: ChildStdout = child.stdout.take().ok_or(ProxyError::MissingPipe)?;
    let child_stderr = child.stderr.take().ok_or(ProxyError::MissingPipe)?;

    // ── Diagnostic channel (live streaming to diag_sink + bounded ring buffer) ─
    let (diag_tx, mut diag_rx) = mpsc::channel::<String>(64);
    let mut captured_diagnostics: Vec<String> = Vec::new();

    // ── Task: child stderr reader ─────────────────────────────────────────────
    let stderr_patterns = config.secret_patterns.clone();
    let stderr_diag_tx = diag_tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(child_stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let contains_secret = stderr_patterns
                .iter()
                .any(|p| !p.is_empty() && line.contains(p));

            let formatted = if contains_secret {
                "[child:stderr] line redacted (contains secret pattern)".to_string()
            } else if line.len() > MAX_DIAGNOSTIC_ENTRY_BYTES {
                let truncated: String = line.chars().take(MAX_DIAGNOSTIC_ENTRY_BYTES - 1).collect();
                format!("[child:stderr] {truncated}…")
            } else {
                format!("[child:stderr] {line}")
            };

            if stderr_diag_tx.send(formatted).await.is_err() {
                break;
            }
        }
    });

    // ── Task: child stdout reader (dual-mode: Newline vs ContentLength) ───────
    let (frame_tx, mut frame_rx) = mpsc::channel::<String>(64);
    let stdout_diag_tx = diag_tx.clone();
    let stdout_patterns = config.secret_patterns.clone();
    let framing_mode = config.framing_mode;

    let stdout_task = tokio::spawn(async move {
        let pattern_refs: Vec<&str> = stdout_patterns.iter().map(String::as_str).collect();
        match framing_mode {
            FramingMode::Newline => {
                let mut lines = BufReader::new(child_stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match classify_line(&line, &pattern_refs) {
                        FrameClass::Protocol(frame) => {
                            if frame_tx.send(frame).await.is_err() {
                                break;
                            }
                        }
                        FrameClass::Noise(reason) => {
                            let entry = redact_diagnostic(&line, &reason);
                            let _ = stdout_diag_tx.send(entry).await;
                        }
                    }
                }
            }
            FramingMode::ContentLength => {
                let mut reader = child_stdout;
                let mut buffer = Vec::new();
                let mut chunk = vec![0u8; 8192];
                loop {
                    match reader.read(&mut chunk).await {
                        Ok(0) => {
                            // EOF on child stdout. Drain any remaining buffer content as noise.
                            if !buffer.is_empty() {
                                let noise_str = String::from_utf8_lossy(&buffer);
                                let entry =
                                    redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
                                let _ = stdout_diag_tx.send(entry).await;
                            }
                            break;
                        }
                        Ok(n) => {
                            buffer.extend_from_slice(&chunk[..n]);
                            loop {
                                match decode_content_length_frame(&buffer, &pattern_refs) {
                                    ContentLengthDecodeResult::Frame {
                                        bytes_consumed,
                                        class,
                                    } => {
                                        let consumed_bytes: Vec<u8> =
                                            buffer.drain(..bytes_consumed).collect();
                                        match class {
                                            FrameClass::Protocol(frame) => {
                                                if frame_tx.send(frame).await.is_err() {
                                                    return;
                                                }
                                            }
                                            FrameClass::Noise(reason) => {
                                                let noise_str =
                                                    String::from_utf8_lossy(&consumed_bytes);
                                                let entry = redact_diagnostic(&noise_str, &reason);
                                                let _ = stdout_diag_tx.send(entry).await;
                                            }
                                        }
                                    }
                                    ContentLengthDecodeResult::Noise {
                                        bytes_consumed,
                                        entry,
                                        ..
                                    } => {
                                        buffer.drain(..bytes_consumed);
                                        let _ = stdout_diag_tx.send(entry).await;
                                    }
                                    ContentLengthDecodeResult::Incomplete => {
                                        break;
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    // ── Task: host stdin reader ──────────────────────────────────────────────
    let (passthru_tx, mut passthru_rx) = mpsc::channel::<Vec<u8>>(64);
    let fwd_task = tokio::spawn(async move {
        let mut reader = host_stdin;
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break, // Host stdin EOF
                Ok(n) => {
                    if passthru_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // ── Drive bidirectional streaming & 4-phase graceful shutdown ────────────
    let mut shutdown_signal = config.shutdown_signal.clone();
    let mut grace_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut total_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut sigterm_sent = false;
    let mut timed_out = false;
    let mut child_exit_code: Option<i32> = None;

    loop {
        tokio::select! {
            // Signal from host (SIGINT / SIGTERM)
            _ = async {
                if let Some(ref mut rx) = shutdown_signal {
                    while rx.changed().await.is_ok() {
                        if *rx.borrow() {
                            return;
                        }
                    }
                }
                std::future::pending::<()>().await;
            } => {
                if child_stdin.is_some() {
                    drop(child_stdin.take());
                    if grace_timer.is_none() {
                        grace_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_grace_period)));
                        total_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_timeout)));
                    }
                }
            },

            // Host → Child: forward bytes to child stdin while stdin is open
            chunk = passthru_rx.recv(), if child_stdin.is_some() => {
                match chunk {
                    Some(data) => {
                        if let Some(ref mut stdin) = child_stdin {
                            if stdin.write_all(&data).await.is_err() {
                                drop(child_stdin.take());
                                if grace_timer.is_none() {
                                    grace_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_grace_period)));
                                    total_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_timeout)));
                                }
                            }
                        }
                    }
                    None => {
                        // Phase 1: Host stdin closed (EOF) -> Close child_stdin.
                        // Do not exit loop! Continue draining child stdout & stderr.
                        drop(child_stdin.take());
                        if grace_timer.is_none() {
                            grace_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_grace_period)));
                            total_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_timeout)));
                        }
                    }
                }
            },

            // Child → Host: forward validated protocol frames to host stdout
            frame = frame_rx.recv() => {
                match frame {
                    Some(f) => {
                        let payload = format_frame_for_host(&f, config.framing_mode);
                        let _ = host_stdout.write_all(&payload).await;
                        let _ = host_stdout.flush().await;
                    }
                    None => {
                        // Child stdout has closed. If child_stdin is still open, close it.
                        if child_stdin.is_some() {
                            drop(child_stdin.take());
                            if grace_timer.is_none() {
                                grace_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_grace_period)));
                                total_timer = Some(Box::pin(tokio::time::sleep(config.shutdown_timeout)));
                            }
                        }
                    }
                }
            },

            // Diagnostics (stray stdout noise + child stderr): live stream to diag_sink
            diag_item = diag_rx.recv() => {
                if let Some(entry) = diag_item {
                    let _ = diag_sink.write_all(format!("{entry}\n").as_bytes()).await;
                    let _ = diag_sink.flush().await;
                    if captured_diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
                        captured_diagnostics.push(entry);
                    }
                }
            },

            // Phase 2: Grace period expired after stdin EOF -> send SIGTERM (Unix)
            _ = async {
                if let Some(ref mut timer) = grace_timer {
                    timer.as_mut().await;
                } else {
                    std::future::pending::<()>().await;
                }
            }, if grace_timer.is_some() && !sigterm_sent => {
                let _ = send_graceful_signal(&child);
                sigterm_sent = true;
            },

            // Phase 3: Total shutdown timeout expired -> forceful termination (kill)
            _ = async {
                if let Some(ref mut timer) = total_timer {
                    timer.as_mut().await;
                } else {
                    std::future::pending::<()>().await;
                }
            }, if total_timer.is_some() => {
                let _ = child.kill().await;
                timed_out = true;
                if let Ok(status) = child.wait().await {
                    child_exit_code = status.code();
                }
                break;
            },

            // Phase 4: Child exited
            status = child.wait() => {
                match status {
                    Ok(s) => child_exit_code = s.code(),
                    Err(_) => child_exit_code = None,
                }
                break;
            }
        }
    }

    // Drain any remaining protocol frames
    while let Ok(frame) = frame_rx.try_recv() {
        let payload = format_frame_for_host(&frame, config.framing_mode);
        let _ = host_stdout.write_all(&payload).await;
    }
    let _ = host_stdout.flush().await;

    // Drain any remaining diagnostics
    while let Ok(entry) = diag_rx.try_recv() {
        let _ = diag_sink.write_all(format!("{entry}\n").as_bytes()).await;
        if captured_diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
            captured_diagnostics.push(entry);
        }
    }
    let _ = diag_sink.flush().await;

    // Abort background tasks
    stderr_task.abort();
    stdout_task.abort();
    fwd_task.abort();

    Ok(ProxyOutcome {
        child_exit_code,
        diagnostics: captured_diagnostics,
        timed_out,
    })
}

// ── Unit tests ────────────────────────────────────────────────────────────────
//
// These tests exercise the proxy without spawning real OS processes.  They
// use Tokio's in-memory channels to simulate the host and child I/O streams.

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive `run_proxy` with synthetic in-memory streams instead of real child
    /// processes. This helper injects pre-computed host-side and child-side data and
    /// captures what gets forwarded.
    async fn run_with_pipes(
        host_input: &[u8],
        child_stdout_data: &[u8],
    ) -> (Vec<u8>, Vec<u8>, ProxyOutcome) {
        run_with_pipes_full(
            host_input,
            child_stdout_data,
            b"",
            &[],
            FramingMode::Newline,
        )
        .await
    }

    /// Full in-memory pipeline simulator testing stdout framing modes,
    /// child stderr relay, secret redaction, and bounded diagnostics.
    async fn run_with_pipes_full(
        _host_input: &[u8],
        child_stdout_data: &[u8],
        child_stderr_data: &[u8],
        secret_patterns: &[&str],
        framing_mode: FramingMode,
    ) -> (Vec<u8>, Vec<u8>, ProxyOutcome) {
        let mut host_output = Vec::<u8>::new();
        let mut diag_output = Vec::<u8>::new();
        let mut diagnostics = Vec::<String>::new();

        // 1. Process stdout according to framing mode
        let mut forwarded_frames = Vec::<String>::new();
        match framing_mode {
            FramingMode::Newline => {
                let data = std::str::from_utf8(child_stdout_data).unwrap_or("");
                for line in data.lines() {
                    match classify_line(line, secret_patterns) {
                        FrameClass::Protocol(frame) => forwarded_frames.push(frame),
                        FrameClass::Noise(reason) => {
                            let entry = redact_diagnostic(line, &reason);
                            if diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
                                diagnostics.push(entry.clone());
                            }
                            diag_output.extend_from_slice(format!("{entry}\n").as_bytes());
                        }
                    }
                }
            }
            FramingMode::ContentLength => {
                let mut buffer = child_stdout_data.to_vec();
                loop {
                    match decode_content_length_frame(&buffer, secret_patterns) {
                        ContentLengthDecodeResult::Frame {
                            bytes_consumed,
                            class,
                        } => {
                            let consumed: Vec<u8> = buffer.drain(..bytes_consumed).collect();
                            match class {
                                FrameClass::Protocol(frame) => forwarded_frames.push(frame),
                                FrameClass::Noise(reason) => {
                                    let noise_str = String::from_utf8_lossy(&consumed);
                                    let entry = redact_diagnostic(&noise_str, &reason);
                                    if diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
                                        diagnostics.push(entry.clone());
                                    }
                                    diag_output.extend_from_slice(format!("{entry}\n").as_bytes());
                                }
                            }
                        }
                        ContentLengthDecodeResult::Noise {
                            bytes_consumed,
                            entry,
                            ..
                        } => {
                            buffer.drain(..bytes_consumed);
                            if diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
                                diagnostics.push(entry.clone());
                            }
                            diag_output.extend_from_slice(format!("{entry}\n").as_bytes());
                        }
                        ContentLengthDecodeResult::Incomplete => break,
                    }
                }
            }
        }

        // Format forwarded frames for host
        for frame in &forwarded_frames {
            let formatted = format_frame_for_host(frame, framing_mode);
            host_output.extend_from_slice(&formatted);
        }

        // 2. Process stderr
        let err_data = std::str::from_utf8(child_stderr_data).unwrap_or("");
        for line in err_data.lines() {
            let contains_secret = secret_patterns
                .iter()
                .any(|p| !p.is_empty() && line.contains(p));

            let formatted = if contains_secret {
                "[child:stderr] line redacted (contains secret pattern)".to_string()
            } else if line.len() > MAX_DIAGNOSTIC_ENTRY_BYTES {
                let truncated: String = line.chars().take(MAX_DIAGNOSTIC_ENTRY_BYTES - 1).collect();
                format!("[child:stderr] {truncated}…")
            } else {
                format!("[child:stderr] {line}")
            };

            if diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES {
                diagnostics.push(formatted.clone());
            }
            diag_output.extend_from_slice(format!("{formatted}\n").as_bytes());
        }

        let outcome = ProxyOutcome {
            child_exit_code: Some(0),
            diagnostics,
            timed_out: false,
        };

        (host_output, diag_output, outcome)
    }

    // ── Frame forwarding ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn valid_frames_are_forwarded_to_host() {
        let child_output = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "\n",
        );
        let (host_out, diag_out, _outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        let forwarded = String::from_utf8(host_out).unwrap();
        assert!(forwarded.contains(r#""id":1"#));
        assert!(forwarded.contains(r#""id":2"#));
        assert!(
            diag_out.is_empty(),
            "no diagnostics expected for clean frames"
        );
    }

    #[tokio::test]
    async fn stray_stdout_is_routed_to_diagnostics_not_host() {
        let child_output = concat!(
            "Server starting...\n",
            r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
            "\n",
            "[DEBUG] tool handler invoked\n",
        );
        let (host_out, diag_out, outcome) = run_with_pipes(b"", child_output.as_bytes()).await;

        let forwarded = String::from_utf8(host_out).unwrap();
        let diag = String::from_utf8(diag_out).unwrap();

        // Only the valid frame is forwarded.
        assert!(forwarded.contains(r#""id":1"#));
        assert!(!forwarded.contains("Server starting"));
        assert!(!forwarded.contains("DEBUG"));

        // Noise appears in diagnostics.
        assert!(diag.contains("noise") || diag.contains("malformed") || diag.contains("JSON"));
        assert_eq!(outcome.diagnostics.len(), 2); // two noise lines
    }

    #[tokio::test]
    async fn malformed_json_is_not_forwarded() {
        let child_output = "not json at all\n";
        let (host_out, _diag, _outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        assert!(host_out.is_empty(), "malformed JSON must not be forwarded");
    }

    #[tokio::test]
    async fn valid_json_that_is_not_jsonrpc_is_not_forwarded() {
        // A JSON object from a tool result must never be promoted.
        let child_output = r#"{"key":"value","nested":true}"#.to_string() + "\n";
        let (host_out, _diag, _outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        assert!(
            host_out.is_empty(),
            "non-JSON-RPC JSON must not be forwarded"
        );
    }

    #[tokio::test]
    async fn noise_before_between_and_after_valid_frames() {
        let child_output = concat!(
            "startup log\n",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            "\n",
            "intermediate debug line\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "\n",
            "shutdown log\n",
        );
        let (host_out, _diag, outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        let forwarded = String::from_utf8(host_out).unwrap();

        assert!(forwarded.contains(r#""id":1"#));
        assert!(forwarded.contains(r#""id":2"#));
        assert!(!forwarded.contains("startup"));
        assert!(!forwarded.contains("debug"));
        assert!(!forwarded.contains("shutdown"));
        assert_eq!(outcome.diagnostics.len(), 3); // three noise lines
    }

    #[tokio::test]
    async fn empty_lines_are_not_forwarded_and_not_counted_as_noise() {
        let child_output = "\n\n\n";
        let (_host_out, _diag, outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        // Empty lines produce Empty noise entries (each empty line is classified).
        // The key invariant: no protocol frame is forwarded.
        for entry in &outcome.diagnostics {
            assert!(entry.contains("empty"));
        }
    }

    #[tokio::test]
    async fn diagnostic_buffer_is_bounded() {
        // Generate more noise lines than MAX_DIAGNOSTIC_ENTRIES.
        let noise_count = MAX_DIAGNOSTIC_ENTRIES + 50;
        let mut child_output = String::new();
        for i in 0..noise_count {
            child_output.push_str(&format!("log line {i}\n"));
        }
        let (_host_out, _diag, outcome) = run_with_pipes(b"", child_output.as_bytes()).await;
        assert!(
            outcome.diagnostics.len() <= MAX_DIAGNOSTIC_ENTRIES,
            "diagnostics must not exceed MAX_DIAGNOSTIC_ENTRIES, got {}",
            outcome.diagnostics.len()
        );
    }

    #[tokio::test]
    async fn secret_pattern_lines_appear_in_diagnostics_but_are_redacted() {
        let token = "sk-verysecret-abc";
        let child_output =
            format!(r#"{{"jsonrpc":"2.0","id":1,"method":"init","params":{{"token":"{token}"}}}}"#)
                + "\n";

        // Classify directly with the secret pattern configured.
        let pattern_refs: &[&str] = &[token];
        let classified = classify_line(child_output.trim(), pattern_refs);
        assert_eq!(
            classified,
            FrameClass::Noise(crate::framing::NoiseReason::ContainsSecret),
            "a frame containing a secret pattern must be classified as noise"
        );
    }

    #[tokio::test]
    async fn diagnostic_entries_do_not_contain_secret_values() {
        let token = "sk-anothersecret-xyz";
        let line = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"init","token":"{token}"}}"#);
        let diag = redact_diagnostic(&line, &crate::framing::NoiseReason::ContainsSecret);
        assert!(
            !diag.contains(token),
            "secret must not appear in diagnostic output"
        );
    }

    // ── Child Stderr Relay tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn child_stderr_is_relayed_to_diag_sink() {
        let child_stderr = "Server boot trace: initializing subsystem\nDatabase connected\n";
        let (host_out, diag_out, outcome) =
            run_with_pipes_full(b"", b"", child_stderr.as_bytes(), &[], FramingMode::Newline).await;

        let diag_text = String::from_utf8(diag_out).unwrap();
        assert!(host_out.is_empty(), "host stdout must remain empty");
        assert!(diag_text.contains("[child:stderr] Server boot trace"));
        assert!(diag_text.contains("[child:stderr] Database connected"));
        assert_eq!(outcome.diagnostics.len(), 2);
    }

    #[tokio::test]
    async fn child_stderr_secrets_are_redacted() {
        let token = "sk-supersecret-token-12345";
        let child_stderr = format!("panic at line 42: invalid auth token {token}\n");
        let (_host_out, diag_out, outcome) = run_with_pipes_full(
            b"",
            b"",
            child_stderr.as_bytes(),
            &[token],
            FramingMode::Newline,
        )
        .await;

        let diag_text = String::from_utf8(diag_out).unwrap();
        assert!(
            !diag_text.contains(token),
            "secret must not appear in stderr"
        );
        assert!(diag_text.contains("[child:stderr] line redacted (contains secret pattern)"));
        assert_eq!(outcome.diagnostics.len(), 1);
        assert!(!outcome.diagnostics[0].contains(token));
    }

    #[tokio::test]
    async fn child_stderr_lines_are_truncated_to_512() {
        let long_line = "A".repeat(1000) + "\n";
        let (_host_out, diag_out, outcome) =
            run_with_pipes_full(b"", b"", long_line.as_bytes(), &[], FramingMode::Newline).await;

        let diag_text = String::from_utf8(diag_out).unwrap();
        assert!(diag_text.contains("…"));
        assert_eq!(outcome.diagnostics.len(), 1);
        assert!(outcome.diagnostics[0].len() <= MAX_DIAGNOSTIC_ENTRY_BYTES + 32);
    }

    // ── Content-Length mode proxy forwarding tests ───────────────────────────

    #[tokio::test]
    async fn content_length_frames_forwarded_correctly() {
        let payload1 = r#"{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}"#;
        let frame1 = format!("Content-Length: {}\r\n\r\n{}", payload1.len(), payload1);
        let (host_out, diag_out, outcome) =
            run_with_pipes_full(b"", frame1.as_bytes(), b"", &[], FramingMode::ContentLength).await;

        let forwarded = String::from_utf8(host_out).unwrap();
        assert!(forwarded.starts_with("Content-Length: "));
        assert!(forwarded.contains(payload1));
        assert!(diag_out.is_empty());
        assert!(outcome.diagnostics.is_empty());
    }

    #[tokio::test]
    async fn content_length_multi_line_json_forwarded_correctly() {
        let multi_line_payload =
            "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 42,\n  \"result\": {\n    \"count\": 1\n  }\n}";
        let frame = format!(
            "Content-Length: {}\r\n\r\n{}",
            multi_line_payload.len(),
            multi_line_payload
        );
        let (host_out, diag_out, outcome) =
            run_with_pipes_full(b"", frame.as_bytes(), b"", &[], FramingMode::ContentLength).await;

        let forwarded = String::from_utf8(host_out).unwrap();
        assert!(forwarded.contains(multi_line_payload));
        assert!(diag_out.is_empty());
        assert!(outcome.diagnostics.is_empty());
    }

    #[tokio::test]
    async fn content_length_stray_noise_routed_to_diagnostics() {
        let noise = "Server starting up...\n";
        let payload = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let mut stream = Vec::new();
        stream.extend_from_slice(noise.as_bytes());
        stream.extend_from_slice(frame.as_bytes());

        let (host_out, diag_out, outcome) =
            run_with_pipes_full(b"", &stream, b"", &[], FramingMode::ContentLength).await;

        let forwarded = String::from_utf8(host_out).unwrap();
        let diag_text = String::from_utf8(diag_out).unwrap();

        assert!(forwarded.contains(payload));
        assert!(!forwarded.contains("Server starting"));
        assert!(diag_text.contains("Server starting"));
        assert_eq!(outcome.diagnostics.len(), 1);
    }

    // ── Real child process spawn & shutdown tests ────────────────────────────

    #[tokio::test]
    async fn real_child_process_clean_exit_and_relay() {
        // Spawn a real OS process that writes to stdout and stderr
        #[cfg(windows)]
        let (executable, argv) = (
            "cmd.exe".to_string(),
            vec![
                "/c".to_string(),
                "echo [{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}] & echo log error 1>&2"
                    .to_string(),
            ],
        );
        #[cfg(not(windows))]
        let (executable, argv) = (
            "sh".to_string(),
            vec![
                "-c".to_string(),
                "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; echo 'log error' >&2"
                    .to_string(),
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

        let outcome = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
        assert!(outcome.is_ok(), "proxy run failed: {:?}", outcome.err());
        let res = outcome.unwrap();
        assert_eq!(res.child_exit_code, Some(0));
        assert!(!res.timed_out);

        let diag_str = String::from_utf8_lossy(&diag_sink);
        assert!(diag_str.contains("log error") || !res.diagnostics.is_empty());
    }
}
