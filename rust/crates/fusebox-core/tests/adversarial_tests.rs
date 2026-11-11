//! Adversarial verification test suite for framing and stderr relay.
//! Challenging:
//! 1. Chunk fragmentation (byte-by-byte feed)
//! 2. Payloads near 4 MiB frame limit
//! 3. Malformed Content-Length headers (negative, non-numeric, missing separator)
//! 4. Multi-line JSON-RPC payloads in Content-Length vs Newline mode
//! 5. Stderr flooding with 10,000 lines (diagnostic ring buffer cap of 512)
//! 6. Stderr line truncation for lines > 512 bytes
//! 7. Secret redaction on stdout (newline & content-length) and stderr

use fusebox_core::framing::{
    classify_line, decode_content_length_frame, redact_diagnostic, ContentLengthDecodeResult,
    FrameClass, FramingMode, NoiseReason, MAX_DIAGNOSTIC_ENTRIES, MAX_DIAGNOSTIC_ENTRY_BYTES,
    MAX_FRAME_BYTES,
};
use fusebox_core::proxy::{run_proxy, ProxyConfig};
use std::time::Duration;

// ── 1. Chunk Fragmentation: Byte-by-Byte Assembly ────────────────────────────

#[test]
fn test_adversarial_chunk_fragmentation_byte_by_byte() {
    let payload =
        r#"{"jsonrpc":"2.0","id":42,"result":{"verified":true,"data":"fragmentation-test"}}"#;
    let raw_frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    let bytes = raw_frame.as_bytes();

    let mut buffer = Vec::new();
    let mut decoded_frames = Vec::new();

    for (i, &b) in bytes.iter().enumerate() {
        buffer.push(b);
        loop {
            match decode_content_length_frame(&buffer, &[]) {
                ContentLengthDecodeResult::Frame {
                    bytes_consumed,
                    class,
                } => {
                    buffer.drain(..bytes_consumed);
                    decoded_frames.push(class);
                }
                ContentLengthDecodeResult::Noise { bytes_consumed, .. } => {
                    buffer.drain(..bytes_consumed);
                }
                ContentLengthDecodeResult::Incomplete => {
                    if i + 1 < bytes.len() {
                        // While incomplete before the last byte, this must remain incomplete
                    }
                    break;
                }
            }
        }
    }

    assert_eq!(
        decoded_frames.len(),
        1,
        "expected exactly 1 frame assembled from byte-by-byte feed"
    );
    assert_eq!(
        decoded_frames[0],
        FrameClass::Protocol(payload.to_string()),
        "assembled frame content mismatch"
    );
    assert!(
        buffer.is_empty(),
        "buffer should be completely drained after full frame"
    );
}

#[test]
fn test_adversarial_fragmentation_consecutive_frames_with_noise() {
    let p1 = r#"{"jsonrpc":"2.0","id":1,"result":"first"}"#;
    let f1 = format!("Content-Length: {}\r\n\r\n{}", p1.len(), p1);
    let noise = "Stray child stdout log message\n";
    let p2 = r#"{"jsonrpc":"2.0","id":2,"result":"second"}"#;
    let f2 = format!("Content-Length: {}\r\n\r\n{}", p2.len(), p2);

    let stream = format!("{f1}{noise}{f2}");
    let mut buffer = Vec::new();
    let mut frames = Vec::new();
    let mut noises = Vec::new();

    for &b in stream.as_bytes() {
        buffer.push(b);
        loop {
            match decode_content_length_frame(&buffer, &[]) {
                ContentLengthDecodeResult::Frame {
                    bytes_consumed,
                    class,
                } => {
                    buffer.drain(..bytes_consumed);
                    frames.push(class);
                }
                ContentLengthDecodeResult::Noise {
                    bytes_consumed,
                    reason,
                    entry,
                } => {
                    buffer.drain(..bytes_consumed);
                    noises.push((reason, entry));
                }
                ContentLengthDecodeResult::Incomplete => break,
            }
        }
    }

    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], FrameClass::Protocol(p1.to_string()));
    assert_eq!(frames[1], FrameClass::Protocol(p2.to_string()));

    // Verify all noise was routed to diagnostics with MalformedJson
    for (reason, _) in &noises {
        assert_eq!(*reason, NoiseReason::MalformedJson);
    }
    let combined_noise: String = noises.iter().map(|(_, e)| e.as_str()).collect();
    assert!(combined_noise.contains("Stray"));
    assert!(combined_noise.contains("child stdout"));
}

// ── 2. Large Payloads Near 4 MiB Frame Limit ─────────────────────────────────

#[test]
fn test_adversarial_payload_near_4mib_accepted() {
    // Construct valid JSON-RPC 2.0 payload just under 4 MiB (e.g. 4,000,000 bytes)
    let base = r#"{"jsonrpc":"2.0","id":1,"result":{"data":""#;
    let tail = r#""}}"#;
    let filler_len = 4_000_000 - base.len() - tail.len();
    let filler = "A".repeat(filler_len);
    let payload = format!("{base}{filler}{tail}");
    assert_eq!(payload.len(), 4_000_000);
    assert!(payload.len() < MAX_FRAME_BYTES);

    let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    let res = decode_content_length_frame(frame.as_bytes(), &[]);
    match res {
        ContentLengthDecodeResult::Frame {
            bytes_consumed,
            class,
        } => {
            assert_eq!(bytes_consumed, frame.len());
            assert_eq!(class, FrameClass::Protocol(payload));
        }
        other => panic!("expected Protocol frame for 4,000,000B payload, got {other:?}"),
    }
}

#[test]
fn test_adversarial_payload_at_exact_4mib_limit_accepted() {
    let base = r#"{"jsonrpc":"2.0","id":1,"result":{"data":""#;
    let tail = r#""}}"#;
    let filler_len = MAX_FRAME_BYTES - base.len() - tail.len();
    let filler = "B".repeat(filler_len);
    let payload = format!("{base}{filler}{tail}");
    assert_eq!(payload.len(), MAX_FRAME_BYTES);

    let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    let res = decode_content_length_frame(frame.as_bytes(), &[]);
    match res {
        ContentLengthDecodeResult::Frame {
            bytes_consumed,
            class,
        } => {
            assert_eq!(bytes_consumed, frame.len());
            assert_eq!(class, FrameClass::Protocol(payload));
        }
        other => panic!("expected Protocol frame for exactly 4 MiB payload, got {other:?}"),
    }
}

#[test]
fn test_adversarial_payload_exceeding_4mib_rejected_as_oversized() {
    let oversized_len = MAX_FRAME_BYTES + 1;
    let header = format!("Content-Length: {}\r\n\r\n", oversized_len);
    let res = decode_content_length_frame(header.as_bytes(), &[]);
    match res {
        ContentLengthDecodeResult::Noise {
            bytes_consumed,
            reason,
            entry,
        } => {
            assert_eq!(bytes_consumed, header.len());
            assert_eq!(reason, NoiseReason::Oversized);
            assert!(entry.contains("oversized"));
        }
        other => panic!("expected Oversized Noise for 4MiB+1 payload, got {other:?}"),
    }
}

// ── 3. Malformed Content-Length Headers ───────────────────────────────────────

#[test]
fn test_adversarial_malformed_negative_length() {
    let header = "Content-Length: -100\r\n\r\n";
    let res = decode_content_length_frame(header.as_bytes(), &[]);
    match res {
        ContentLengthDecodeResult::Noise {
            bytes_consumed,
            reason,
            ..
        } => {
            assert_eq!(bytes_consumed, header.len());
            assert_eq!(reason, NoiseReason::MalformedJson);
        }
        other => panic!("expected Noise(MalformedJson) for negative length, got {other:?}"),
    }
}

#[test]
fn test_adversarial_malformed_non_numeric_length() {
    let header = "Content-Length: NaN\r\n\r\n";
    let res = decode_content_length_frame(header.as_bytes(), &[]);
    match res {
        ContentLengthDecodeResult::Noise {
            bytes_consumed,
            reason,
            ..
        } => {
            assert_eq!(bytes_consumed, header.len());
            assert_eq!(reason, NoiseReason::MalformedJson);
        }
        other => panic!("expected Noise(MalformedJson) for non-numeric length, got {other:?}"),
    }
}

#[test]
fn test_adversarial_malformed_missing_separator_buffer_limit() {
    // Header without \r\n\r\n or \n\n. When under 4096 bytes, Incomplete.
    let small_garbage = b"Content-Length: 50 missing separator";
    assert_eq!(
        decode_content_length_frame(small_garbage, &[]),
        ContentLengthDecodeResult::Incomplete
    );

    // When exceeding 4096 bytes without terminator, must consume 4096 bytes as Noise to avoid OOM
    let large_garbage = vec![b'A'; 5000];
    let mut prefixed = b"Content-Length: ".to_vec();
    prefixed.extend_from_slice(&large_garbage);
    let res = decode_content_length_frame(&prefixed, &[]);
    match res {
        ContentLengthDecodeResult::Noise {
            bytes_consumed,
            reason,
            ..
        } => {
            assert_eq!(bytes_consumed, 4096);
            assert_eq!(reason, NoiseReason::MalformedJson);
        }
        other => panic!("expected Noise(MalformedJson) for >4096 unclosed header, got {other:?}"),
    }
}

// ── 4. Multi-line JSON-RPC: Content-Length vs Newline Mode ────────────────────

#[test]
fn test_adversarial_multiline_jsonrpc_content_length_vs_newline() {
    let multiline_json = "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 1,\n  \"method\": \"test\"\n}";

    // In Content-Length mode: whole payload parsed together -> Protocol
    let cl_frame = format!(
        "Content-Length: {}\r\n\r\n{}",
        multiline_json.len(),
        multiline_json
    );
    let cl_res = decode_content_length_frame(cl_frame.as_bytes(), &[]);
    assert_eq!(
        cl_res,
        ContentLengthDecodeResult::Frame {
            bytes_consumed: cl_frame.len(),
            class: FrameClass::Protocol(multiline_json.to_string()),
        }
    );

    // In Newline mode: each line tested individually -> NONE are protocol, all are MalformedJson Noise
    for line in multiline_json.lines() {
        let nl_res = classify_line(line, &[]);
        assert_eq!(
            nl_res,
            FrameClass::Noise(NoiseReason::MalformedJson),
            "individual line of multiline JSON must be MalformedJson noise in Newline mode"
        );
    }
}

// ── 5. Stderr Flooding: 10,000 Lines & 512 Ring Buffer Cap ───────────────────

#[tokio::test]
async fn test_adversarial_stderr_flood_10000_lines_ring_buffer_capped() {
    // Generate 10,000 lines
    let line_count = 10_000;
    let mut flood_data = Vec::with_capacity(line_count * 30);
    for i in 0..line_count {
        flood_data.extend_from_slice(format!("diagnostic flood log line {i}\n").as_bytes());
    }

    // Run via run_proxy with an echo script/process or in-memory pipes
    // Here we use run_proxy with cmd.exe / powershell to emit 10,000 stderr lines
    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "1..10000 | ForEach-Object { [Console]::Error.WriteLine(\"stderr-flood-$_\") }"
                .to_string(),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            "i=1; while [ $i -le 10000 ]; do echo \"stderr-flood-$i\" >&2; i=$((i+1)); done"
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
        shutdown_timeout: Duration::from_secs(15),
        shutdown_grace_period: Duration::from_secs(2),
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();

    // Invariant 1: Diagnostics ring buffer retained in outcome is strictly capped at MAX_DIAGNOSTIC_ENTRIES (512)
    assert_eq!(
        outcome.diagnostics.len(),
        MAX_DIAGNOSTIC_ENTRIES,
        "diagnostics vector must be capped at exactly MAX_DIAGNOSTIC_ENTRIES (512)"
    );

    // Invariant 2: Host stdout is completely empty (no stdout protocol produced)
    assert!(host_stdout.is_empty(), "host stdout must be empty");

    // Invariant 3: Live diag_sink received lines beyond 512 (streaming without stalling)
    let diag_str = String::from_utf8_lossy(&diag_sink);
    assert!(
        diag_str.contains("stderr-flood-1"),
        "diag_sink must receive early lines"
    );
    assert!(
        diag_str.contains("stderr-flood-512"),
        "diag_sink must receive middle lines"
    );
    assert!(
        diag_str.contains("stderr-flood-10000"),
        "diag_sink must receive all 10,000 lines streamed live"
    );
}

// ── 6. Stderr Line Truncation (> 512 bytes) ───────────────────────────────────

#[tokio::test]
async fn test_adversarial_stderr_line_truncation_investigation() {
    let long_line_length = 2000;
    let long_content = "X".repeat(long_line_length);

    #[cfg(windows)]
    let (executable, argv) = (
        "powershell.exe".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-Command".to_string(),
            format!("[Console]::Error.WriteLine('{}')", long_content),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            format!("printf '%s\\n' '{}' >&2", long_content),
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
        shutdown_timeout: Duration::from_secs(10),
        shutdown_grace_period: Duration::from_secs(2),
        framing_mode: FramingMode::Newline,
        shutdown_signal: None,
    };

    let host_stdin = tokio::io::empty();
    let mut host_stdout = Vec::<u8>::new();
    let mut diag_sink = Vec::<u8>::new();

    let result = run_proxy(config, host_stdin, &mut host_stdout, &mut diag_sink).await;
    assert!(result.is_ok(), "proxy run failed: {:?}", result.err());
    let outcome = result.unwrap();

    assert_eq!(outcome.diagnostics.len(), 1);
    let entry = &outcome.diagnostics[0];

    // Truncation check:
    // Implementation uses `line.chars().take(MAX_DIAGNOSTIC_ENTRY_BYTES - 1)` + `…` with `[child:stderr] ` prefix.
    assert!(
        entry.contains("…"),
        "entry must contain truncation ellipsis '…'"
    );
    assert!(
        !entry.contains(&long_content),
        "entry must NOT contain full 2000 character content"
    );
    // Entry length is bounded (529 bytes: 15 prefix + 511 chars + 3 bytes UTF-8 ellipsis)
    assert!(
        entry.len() <= MAX_DIAGNOSTIC_ENTRY_BYTES + 32,
        "entry length {} exceeded bounded threshold {}",
        entry.len(),
        MAX_DIAGNOSTIC_ENTRY_BYTES + 32
    );
}

// ── 7. Secret Redaction on Stdout and Stderr ──────────────────────────────────

#[tokio::test]
async fn test_adversarial_secret_redaction_comprehensive() {
    let secret = "sk-antigravity-topsecret-998877";

    // Subcase 7A: Secret in stdout under Newline mode
    let stdout_secret_line =
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"auth","params":{{"token":"{secret}"}}}}"#);
    let classified = classify_line(&stdout_secret_line, &[secret]);
    assert_eq!(
        classified,
        FrameClass::Noise(NoiseReason::ContainsSecret),
        "secret line must be classified as ContainsSecret noise"
    );
    let redacted_diag = redact_diagnostic(&stdout_secret_line, &NoiseReason::ContainsSecret);
    assert!(
        !redacted_diag.contains(secret),
        "redacted diagnostic must not contain secret"
    );
    assert!(
        !redacted_diag.contains("token"),
        "redacted diagnostic must not leak key names"
    );

    // Subcase 7B: Secret in stdout under Content-Length mode
    let cl_frame = format!(
        "Content-Length: {}\r\n\r\n{}",
        stdout_secret_line.len(),
        stdout_secret_line
    );
    let cl_res = decode_content_length_frame(cl_frame.as_bytes(), &[secret]);
    assert_eq!(
        cl_res,
        ContentLengthDecodeResult::Frame {
            bytes_consumed: cl_frame.len(),
            class: FrameClass::Noise(NoiseReason::ContainsSecret),
        }
    );

    // Subcase 7C: Secret in child stderr stream
    #[cfg(windows)]
    let (executable, argv) = (
        "cmd.exe".to_string(),
        vec![
            "/c".to_string(),
            format!("echo [stderr error: auth failed with {secret}] 1>&2"),
        ],
    );
    #[cfg(not(windows))]
    let (executable, argv) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            format!("echo '[stderr error: auth failed with {}]' >&2", secret),
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

    let diag_sink_str = String::from_utf8_lossy(&diag_sink);
    assert!(
        !diag_sink_str.contains(secret),
        "secret must not appear in diag_sink"
    );
    assert!(
        diag_sink_str.contains("[child:stderr] line redacted (contains secret pattern)"),
        "redaction notice must appear in diag_sink"
    );
    for entry in &outcome.diagnostics {
        assert!(
            !entry.contains(secret),
            "secret must not appear in captured diagnostics"
        );
    }
}
