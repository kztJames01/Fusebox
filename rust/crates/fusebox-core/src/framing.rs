//! JSON-RPC frame validation for the MCP stdio proxy.
//!
//! The MCP stdio transport uses newline-delimited JSON-RPC 2.0. Every complete
//! line received from a child's stdout is validated here before being forwarded
//! to the host. Lines that are not valid JSON-RPC frames are classified as
//! diagnostic noise and routed to stderr; they are **never** forwarded to the
//! host as protocol traffic.
//!
//! # Design constraints
//! - A frame is valid only when it is well-formed JSON **and** passes the
//!   minimum JSON-RPC envelope check (an object with `"jsonrpc": "2.0"` and
//!   either a `"method"` string or an `"id"` + `"result"` / `"error"` pair).
//! - Arbitrary JSON that is not a JSON-RPC envelope is **not** forwarded.
//! - Size limits are enforced before parsing to protect against memory exhaustion.
//! - Diagnostic noise (including the redacted form of lines containing
//!   configured secret patterns) is bounded; overflow is silently dropped.

use serde_json::Value;

/// Maximum byte length of a single frame. Lines exceeding this are classified
/// as oversized noise and are not forwarded or buffered in full.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

/// Maximum number of diagnostic entries retained per proxy session.
pub const MAX_DIAGNOSTIC_ENTRIES: usize = 512;

/// Maximum byte length of one diagnostic entry (after truncation).
pub const MAX_DIAGNOSTIC_ENTRY_BYTES: usize = 512;

/// Supported transport framing modes for MCP stdio proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FramingMode {
    /// Newline-delimited JSON-RPC 2.0 (MCP 2025-03-26 default).
    #[default]
    Newline,
    /// LSP-style Content-Length header framing.
    ContentLength,
}

impl std::str::FromStr for FramingMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "newline" => Ok(FramingMode::Newline),
            "content-length" | "content_length" | "contentlength" => Ok(FramingMode::ContentLength),
            other => Err(format!(
                "unknown framing mode: '{other}' (expected 'newline' or 'content-length')"
            )),
        }
    }
}

/// Result of attempting to decode a Content-Length frame from a byte buffer.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ContentLengthDecodeResult {
    /// A complete frame was decoded.
    /// Returns: (bytes_consumed, FrameClass).
    Frame {
        bytes_consumed: usize,
        class: FrameClass,
    },
    /// Incomplete data; need more bytes from the stream.
    Incomplete,
    /// Preceding noise encountered before header; bytes consumed as noise.
    Noise {
        bytes_consumed: usize,
        reason: NoiseReason,
        entry: String,
    },
}

/// Classification of a line read from a child's stdout.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum FrameClass {
    /// A valid JSON-RPC 2.0 envelope; the contained string should be forwarded.
    Protocol(String),
    /// The line is not a valid JSON-RPC frame; route to diagnostics or drop.
    Noise(NoiseReason),
}

/// Reason a child stdout line was classified as noise.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum NoiseReason {
    /// The line is empty after trimming.
    Empty,
    /// The line is valid JSON but not a JSON-RPC envelope.
    NotJsonRpc,
    /// The line is not valid JSON at all.
    MalformedJson,
    /// The line exceeded the configured byte limit.
    Oversized,
    /// The line contained a configured secret pattern (content redacted).
    ContainsSecret,
}

/// Classify a single line from a child's stdout.
///
/// - `line`: the raw bytes as a string (no trailing newline expected).
/// - `secret_patterns`: a list of byte sequences that must not appear in
///   forwarded or diagnostic content. A line containing any of these patterns
///   is classified as [`NoiseReason::ContainsSecret`].
///
/// The returned [`FrameClass::Protocol`] string is the original `line`,
/// preserved byte-for-byte so the host receives exactly what the child sent.
pub fn classify_line(line: &str, secret_patterns: &[&str]) -> FrameClass {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return FrameClass::Noise(NoiseReason::Empty);
    }

    if trimmed.len() > MAX_FRAME_BYTES {
        return FrameClass::Noise(NoiseReason::Oversized);
    }

    // Secret check before any further processing.
    for pattern in secret_patterns {
        if !pattern.is_empty() && trimmed.contains(*pattern) {
            return FrameClass::Noise(NoiseReason::ContainsSecret);
        }
    }

    // Attempt JSON parse.
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return FrameClass::Noise(NoiseReason::MalformedJson),
    };

    // Validate minimum JSON-RPC 2.0 envelope.
    if is_jsonrpc_envelope(&value) {
        FrameClass::Protocol(line.to_owned())
    } else {
        FrameClass::Noise(NoiseReason::NotJsonRpc)
    }
}

/// Return true when `value` satisfies the minimum JSON-RPC 2.0 envelope:
/// - It is a JSON object.
/// - `"jsonrpc"` is the string `"2.0"`.
/// - It has a `"method"` field (request / notification) **or** an `"id"` field
///   paired with a `"result"` or `"error"` field (response).
///
/// Additional fields are allowed (forward-compatibility). An object that is
/// merely JSON but does not satisfy this contract is **not** forwarded.
fn is_jsonrpc_envelope(value: &Value) -> bool {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };

    // "jsonrpc" must be exactly "2.0".
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }

    // Request or notification: must have a "method" string.
    if obj.get("method").and_then(Value::as_str).is_some() {
        return true;
    }

    // Response: must have "id" AND ("result" OR "error").
    if obj.contains_key("id") && (obj.contains_key("result") || obj.contains_key("error")) {
        return true;
    }

    false
}

/// Produce a redacted diagnostic entry for a noise line, bounded to
/// [`MAX_DIAGNOSTIC_ENTRY_BYTES`].
///
/// The content is truncated rather than omitted so the operator can see
/// approximately what arrived without retaining potentially secret data.
pub fn redact_diagnostic(line: &str, reason: &NoiseReason) -> String {
    let prefix = match reason {
        NoiseReason::Empty => return "[proxy:noise] empty line".to_owned(),
        NoiseReason::Oversized => {
            let preview: String = line.chars().take(64).collect();
            return format!(
                "[proxy:noise] oversized frame ({}B): {}…",
                line.len(),
                preview
            );
        }
        NoiseReason::ContainsSecret => {
            return "[proxy:noise] line redacted (contains secret pattern)".to_owned()
        }
        NoiseReason::MalformedJson => "[proxy:noise] malformed JSON: ",
        NoiseReason::NotJsonRpc => "[proxy:noise] valid JSON but not JSON-RPC: ",
    };

    let content: String = line
        .chars()
        .take(MAX_DIAGNOSTIC_ENTRY_BYTES - prefix.len())
        .collect();
    let truncated = content.len() < line.len();
    if truncated {
        format!("{prefix}{content}…")
    } else {
        format!("{prefix}{content}")
    }
}

/// Find case-insensitive ASCII subslice `b"content-length:"` in `buf`.
fn find_content_length_header(buf: &[u8]) -> Option<usize> {
    let target = b"content-length:";
    if buf.len() < target.len() {
        return None;
    }
    buf.windows(target.len())
        .position(|window| window.eq_ignore_ascii_case(target))
}

/// Find header terminator `\r\n\r\n` or `\n\n`.
/// Returns `Some((terminator_start_idx, terminator_len))`.
fn find_header_terminator(buf: &[u8]) -> Option<(usize, usize)> {
    for i in 0..buf.len() {
        if i + 4 <= buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
            return Some((i, 4));
        }
        if i + 2 <= buf.len() && &buf[i..i + 2] == b"\n\n" {
            return Some((i, 2));
        }
    }
    None
}

/// Parse a Content-Length frame from `buf`.
///
/// Scans for "Content-Length: <len>\r\n" or "\n". Preceding non-header bytes are
/// extracted as diagnostic noise. If the full payload is available, validates
/// JSON-RPC envelope and secret patterns.
pub fn decode_content_length_frame(
    buf: &[u8],
    secret_patterns: &[&str],
) -> ContentLengthDecodeResult {
    if buf.is_empty() {
        return ContentLengthDecodeResult::Incomplete;
    }

    let header_pos = find_content_length_header(buf);

    match header_pos {
        Some(pos) if pos > 0 => {
            // There are bytes preceding the Content-Length header.
            // Slice leading bytes up to pos as diagnostic noise.
            let noise_slice = &buf[..pos];
            let noise_str = String::from_utf8_lossy(noise_slice);
            let entry = redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
            ContentLengthDecodeResult::Noise {
                bytes_consumed: pos,
                reason: NoiseReason::MalformedJson,
                entry,
            }
        }
        None => {
            // Content-Length header was not found in buf.
            // Check if the end of buf could be a prefix of "content-length:"
            let target = b"content-length:";
            let max_prefix_len = target.len().min(buf.len());
            let mut matched_prefix_len = 0;
            for prefix_len in (1..=max_prefix_len).rev() {
                if buf[buf.len() - prefix_len..].eq_ignore_ascii_case(&target[..prefix_len]) {
                    matched_prefix_len = prefix_len;
                    break;
                }
            }

            if matched_prefix_len > 0 {
                // If the entire buffer is just the prefix, wait for more data.
                if buf.len() == matched_prefix_len {
                    return ContentLengthDecodeResult::Incomplete;
                }
                // Preceding bytes before the prefix are noise.
                let noise_bytes = buf.len() - matched_prefix_len;
                let noise_str = String::from_utf8_lossy(&buf[..noise_bytes]);
                let entry = redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
                ContentLengthDecodeResult::Noise {
                    bytes_consumed: noise_bytes,
                    reason: NoiseReason::MalformedJson,
                    entry,
                }
            } else if let Some(nl_pos) = buf.iter().position(|&b| b == b'\n') {
                // No prefix match. Consume up to and including \n as noise.
                let bytes_consumed = nl_pos + 1;
                let noise_str = String::from_utf8_lossy(&buf[..bytes_consumed]);
                let entry = redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
                ContentLengthDecodeResult::Noise {
                    bytes_consumed,
                    reason: NoiseReason::MalformedJson,
                    entry,
                }
            } else if buf.len() >= 512 {
                // Consume 512 bytes as noise to prevent unbounded buffer growth
                let noise_str = String::from_utf8_lossy(&buf[..512]);
                let entry = redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
                ContentLengthDecodeResult::Noise {
                    bytes_consumed: 512,
                    reason: NoiseReason::MalformedJson,
                    entry,
                }
            } else {
                ContentLengthDecodeResult::Incomplete
            }
        }
        Some(0) => {
            // Buffer starts with Content-Length header.
            // Search for header terminator (\r\n\r\n or \n\n).
            let terminator = find_header_terminator(buf);
            let (term_idx, term_len) = match terminator {
                Some(t) => t,
                None => {
                    if buf.len() > 4096 {
                        // Malformed or oversized header without terminator.
                        let noise_str = String::from_utf8_lossy(&buf[..4096]);
                        let entry = redact_diagnostic(&noise_str, &NoiseReason::MalformedJson);
                        return ContentLengthDecodeResult::Noise {
                            bytes_consumed: 4096,
                            reason: NoiseReason::MalformedJson,
                            entry,
                        };
                    }
                    return ContentLengthDecodeResult::Incomplete;
                }
            };

            let header_len = term_idx + term_len;
            let header_text = String::from_utf8_lossy(&buf[..term_idx]);

            // Parse integer content length from header block
            let mut content_length: Option<usize> = None;
            for line in header_text.lines() {
                let trimmed = line.trim();
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    let parts: Vec<&str> = trimmed.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        if let Ok(len) = parts[1].trim().parse::<usize>() {
                            content_length = Some(len);
                            break;
                        }
                    }
                }
            }

            let length = match content_length {
                Some(len) => len,
                None => {
                    // Header terminator found but Content-Length value was invalid or missing
                    let entry = redact_diagnostic(&header_text, &NoiseReason::MalformedJson);
                    return ContentLengthDecodeResult::Noise {
                        bytes_consumed: header_len,
                        reason: NoiseReason::MalformedJson,
                        entry,
                    };
                }
            };

            if length > MAX_FRAME_BYTES {
                let entry = redact_diagnostic(&header_text, &NoiseReason::Oversized);
                return ContentLengthDecodeResult::Noise {
                    bytes_consumed: header_len,
                    reason: NoiseReason::Oversized,
                    entry,
                };
            }

            let total_required = header_len + length;
            if buf.len() < total_required {
                return ContentLengthDecodeResult::Incomplete;
            }

            let payload_bytes = &buf[header_len..total_required];
            let payload_str = match std::str::from_utf8(payload_bytes) {
                Ok(s) => s,
                Err(_) => {
                    return ContentLengthDecodeResult::Frame {
                        bytes_consumed: total_required,
                        class: FrameClass::Noise(NoiseReason::MalformedJson),
                    };
                }
            };

            // Check secret patterns in payload
            for pattern in secret_patterns {
                if !pattern.is_empty() && payload_str.contains(pattern) {
                    return ContentLengthDecodeResult::Frame {
                        bytes_consumed: total_required,
                        class: FrameClass::Noise(NoiseReason::ContainsSecret),
                    };
                }
            }

            // Attempt JSON parse
            let value: Value = match serde_json::from_str(payload_str) {
                Ok(v) => v,
                Err(_) => {
                    return ContentLengthDecodeResult::Frame {
                        bytes_consumed: total_required,
                        class: FrameClass::Noise(NoiseReason::MalformedJson),
                    };
                }
            };

            if is_jsonrpc_envelope(&value) {
                ContentLengthDecodeResult::Frame {
                    bytes_consumed: total_required,
                    class: FrameClass::Protocol(payload_str.to_owned()),
                }
            } else {
                ContentLengthDecodeResult::Frame {
                    bytes_consumed: total_required,
                    class: FrameClass::Noise(NoiseReason::NotJsonRpc),
                }
            }
        }
        Some(_) => unreachable!(),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_line: protocol frames ────────────────────────────────────────

    #[test]
    fn valid_request_is_protocol() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn valid_notification_is_protocol() {
        let line = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn valid_response_with_result_is_protocol() {
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn valid_response_with_error_is_protocol() {
        let line = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"not found"}}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn valid_response_with_null_id_is_protocol() {
        let line = r#"{"jsonrpc":"2.0","id":null,"result":{}}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    // ── classify_line: noise cases ────────────────────────────────────────────

    #[test]
    fn empty_line_is_noise() {
        assert_eq!(
            classify_line("", &[]),
            FrameClass::Noise(NoiseReason::Empty)
        );
    }

    #[test]
    fn whitespace_only_line_is_noise() {
        assert_eq!(
            classify_line("   \t  ", &[]),
            FrameClass::Noise(NoiseReason::Empty)
        );
    }

    #[test]
    fn plain_text_log_line_is_noise() {
        assert_eq!(
            classify_line("Server listening on port 8080", &[]),
            FrameClass::Noise(NoiseReason::MalformedJson)
        );
    }

    #[test]
    fn valid_json_object_without_jsonrpc_field_is_noise() {
        // This is the key safety case: a JSON object from a tool result must not
        // be promoted to a protocol frame simply because it is valid JSON.
        let line = r#"{"some":"data","nested":{"key":"value"}}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Noise(NoiseReason::NotJsonRpc)
        );
    }

    #[test]
    fn json_array_is_noise() {
        assert_eq!(
            classify_line(r#"[1,2,3]"#, &[]),
            FrameClass::Noise(NoiseReason::NotJsonRpc)
        );
    }

    #[test]
    fn json_with_wrong_jsonrpc_version_is_noise() {
        let line = r#"{"jsonrpc":"1.0","id":1,"method":"test"}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Noise(NoiseReason::NotJsonRpc)
        );
    }

    #[test]
    fn json_rpc_response_without_result_or_error_is_noise() {
        // Has "id" but neither "result" nor "error" — not a valid response.
        let line = r#"{"jsonrpc":"2.0","id":1}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Noise(NoiseReason::NotJsonRpc)
        );
    }

    #[test]
    fn partial_json_is_noise() {
        assert_eq!(
            classify_line(r#"{"jsonrpc":"2.0","id":1,"method":"#, &[]),
            FrameClass::Noise(NoiseReason::MalformedJson)
        );
    }

    #[test]
    fn oversized_line_is_noise() {
        let line = "x".repeat(MAX_FRAME_BYTES + 1);
        assert_eq!(
            classify_line(&line, &[]),
            FrameClass::Noise(NoiseReason::Oversized)
        );
    }

    // ── classify_line: secret redaction ──────────────────────────────────────

    #[test]
    fn line_with_secret_pattern_is_noise_contains_secret() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"init","params":{"token":"sk-abc123"}}"#;
        assert_eq!(
            classify_line(line, &["sk-abc123"]),
            FrameClass::Noise(NoiseReason::ContainsSecret)
        );
    }

    #[test]
    fn empty_secret_pattern_does_not_match_everything() {
        // An empty pattern must not trigger on every line.
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(
            classify_line(line, &[""]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn non_matching_secret_pattern_does_not_affect_classification() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(
            classify_line(line, &["sk-nothere"]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    // ── redact_diagnostic ────────────────────────────────────────────────────

    #[test]
    fn redact_empty_line() {
        let diag = redact_diagnostic("", &NoiseReason::Empty);
        assert!(diag.contains("empty"));
    }

    #[test]
    fn redact_secret_line_does_not_include_line_content() {
        let line = "TOKEN=sk-abc123";
        let diag = redact_diagnostic(line, &NoiseReason::ContainsSecret);
        assert!(
            !diag.contains("sk-abc123"),
            "secret must not appear in diagnostic"
        );
        assert!(
            !diag.contains("TOKEN"),
            "line content must not appear in diagnostic"
        );
    }

    #[test]
    fn redact_oversized_shows_only_prefix() {
        let line = "X".repeat(MAX_FRAME_BYTES + 100);
        let diag = redact_diagnostic(&line, &NoiseReason::Oversized);
        assert!(diag.contains("oversized"));
        // The diagnostic must be much shorter than the original line.
        assert!(diag.len() < 200);
    }

    #[test]
    fn redact_malformed_json_is_bounded() {
        let line = "not json at all";
        let diag = redact_diagnostic(line, &NoiseReason::MalformedJson);
        assert!(diag.len() <= MAX_DIAGNOSTIC_ENTRY_BYTES + 64);
        assert!(diag.contains("malformed"));
    }

    #[test]
    fn redact_not_jsonrpc_is_bounded() {
        let line = r#"{"some":"data"}"#;
        let diag = redact_diagnostic(line, &NoiseReason::NotJsonRpc);
        assert!(diag.len() <= MAX_DIAGNOSTIC_ENTRY_BYTES + 64);
        assert!(diag.contains("not JSON-RPC"));
    }

    // ── is_jsonrpc_envelope edge cases ───────────────────────────────────────

    #[test]
    fn json_rpc_request_with_extra_fields_is_protocol() {
        // Forward-compatible: extra fields must not break classification.
        let line = r#"{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{},"_debug":true}"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Protocol(line.to_owned())
        );
    }

    #[test]
    fn json_rpc_batch_array_is_noise() {
        // Batch requests are a JSON array; the framer does not support them.
        let line = r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#;
        assert_eq!(
            classify_line(line, &[]),
            FrameClass::Noise(NoiseReason::NotJsonRpc)
        );
    }

    // ── Content-Length transport framing tests ───────────────────────────────

    #[test]
    fn framing_mode_from_str_and_default() {
        assert_eq!(FramingMode::default(), FramingMode::Newline);
        assert_eq!(
            "newline".parse::<FramingMode>().unwrap(),
            FramingMode::Newline
        );
        assert_eq!(
            "NEWLINE".parse::<FramingMode>().unwrap(),
            FramingMode::Newline
        );
        assert_eq!(
            "content-length".parse::<FramingMode>().unwrap(),
            FramingMode::ContentLength
        );
        assert_eq!(
            "content_length".parse::<FramingMode>().unwrap(),
            FramingMode::ContentLength
        );
        assert_eq!(
            "ContentLength".parse::<FramingMode>().unwrap(),
            FramingMode::ContentLength
        );
        assert!("invalid".parse::<FramingMode>().is_err());
    }

    #[test]
    fn content_length_valid_single_line_frame() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let result = decode_content_length_frame(frame.as_bytes(), &[]);
        assert_eq!(
            result,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame.len(),
                class: FrameClass::Protocol(payload.to_string()),
            }
        );
    }

    #[test]
    fn content_length_valid_multi_line_json_frame() {
        let payload =
            "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 1,\n  \"result\": {\n    \"tools\": []\n  }\n}";
        let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let result = decode_content_length_frame(frame.as_bytes(), &[]);
        assert_eq!(
            result,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame.len(),
                class: FrameClass::Protocol(payload.to_string()),
            }
        );
    }

    #[test]
    fn content_length_with_preceding_diagnostic_noise() {
        let noise = "Server initialized on port 8080\n";
        let payload = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let valid_frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let mut stream = Vec::new();
        stream.extend_from_slice(noise.as_bytes());
        stream.extend_from_slice(valid_frame.as_bytes());

        // Step 1: Preceding noise decoded and consumed
        let res1 = decode_content_length_frame(&stream, &[]);
        match res1 {
            ContentLengthDecodeResult::Noise {
                bytes_consumed,
                reason,
                entry,
            } => {
                assert_eq!(bytes_consumed, noise.len());
                assert_eq!(reason, NoiseReason::MalformedJson);
                assert!(entry.contains("Server initialized"));
            }
            other => panic!("expected Noise, got {:?}", other),
        }

        // Step 2: Next frame decode from remaining buffer succeeds as Protocol
        let res2 = decode_content_length_frame(&stream[noise.len()..], &[]);
        assert_eq!(
            res2,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: valid_frame.len(),
                class: FrameClass::Protocol(payload.to_string()),
            }
        );
    }

    #[test]
    fn content_length_with_interleaved_noise() {
        let payload1 = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let frame1 = format!("Content-Length: {}\r\n\r\n{}", payload1.len(), payload1);
        let noise = "LOG: intermediate debug line\n";
        let payload2 = r#"{"jsonrpc":"2.0","id":2,"result":{}}"#;
        let frame2 = format!("Content-Length: {}\r\n\r\n{}", payload2.len(), payload2);

        let mut stream = Vec::new();
        stream.extend_from_slice(frame1.as_bytes());
        stream.extend_from_slice(noise.as_bytes());
        stream.extend_from_slice(frame2.as_bytes());

        // Frame 1
        let res1 = decode_content_length_frame(&stream, &[]);
        assert_eq!(
            res1,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame1.len(),
                class: FrameClass::Protocol(payload1.to_string()),
            }
        );
        let mut offset = frame1.len();

        // Noise
        let res_noise = decode_content_length_frame(&stream[offset..], &[]);
        match res_noise {
            ContentLengthDecodeResult::Noise {
                bytes_consumed,
                entry,
                ..
            } => {
                assert_eq!(bytes_consumed, noise.len());
                assert!(entry.contains("intermediate debug"));
            }
            other => panic!("expected Noise, got {:?}", other),
        }
        offset += noise.len();

        // Frame 2
        let res2 = decode_content_length_frame(&stream[offset..], &[]);
        assert_eq!(
            res2,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame2.len(),
                class: FrameClass::Protocol(payload2.to_string()),
            }
        );
    }

    #[test]
    fn content_length_secret_redaction() {
        let secret = "sk-supersecret-token";
        let payload =
            format!(r#"{{"jsonrpc":"2.0","id":1,"method":"auth","params":{{"key":"{secret}"}}}}"#);
        let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);

        let result = decode_content_length_frame(frame.as_bytes(), &[secret]);
        assert_eq!(
            result,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame.len(),
                class: FrameClass::Noise(NoiseReason::ContainsSecret),
            }
        );
    }

    #[test]
    fn content_length_oversized_rejection() {
        let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        let result = decode_content_length_frame(header.as_bytes(), &[]);
        match result {
            ContentLengthDecodeResult::Noise {
                bytes_consumed,
                reason,
                entry,
            } => {
                assert_eq!(bytes_consumed, header.len());
                assert_eq!(reason, NoiseReason::Oversized);
                assert!(entry.contains("oversized"));
            }
            other => panic!("expected Noise(Oversized), got {:?}", other),
        }
    }

    #[test]
    fn content_length_malformed_header_handling() {
        let header = "Content-Length: not-a-number\r\n\r\n";
        let result = decode_content_length_frame(header.as_bytes(), &[]);
        match result {
            ContentLengthDecodeResult::Noise {
                bytes_consumed,
                reason,
                ..
            } => {
                assert_eq!(bytes_consumed, header.len());
                assert_eq!(reason, NoiseReason::MalformedJson);
            }
            other => panic!("expected Noise(MalformedJson), got {:?}", other),
        }
    }

    #[test]
    fn content_length_incomplete_header_and_payload() {
        // Incomplete header
        let partial_header = b"Content-Len";
        assert_eq!(
            decode_content_length_frame(partial_header, &[]),
            ContentLengthDecodeResult::Incomplete
        );

        // Header complete, payload incomplete
        let payload = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let full = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let partial_payload = &full.as_bytes()[..full.len() - 5];
        assert_eq!(
            decode_content_length_frame(partial_payload, &[]),
            ContentLengthDecodeResult::Incomplete
        );
    }

    #[test]
    fn content_length_not_jsonrpc_payload() {
        let payload = r#"{"arbitrary":"json","nested":true}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let result = decode_content_length_frame(frame.as_bytes(), &[]);
        assert_eq!(
            result,
            ContentLengthDecodeResult::Frame {
                bytes_consumed: frame.len(),
                class: FrameClass::Noise(NoiseReason::NotJsonRpc),
            }
        );
    }
}
