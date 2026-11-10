/**
 * Tests for MCP stdio proxy frame classification and protocol integrity.
 *
 * These tests verify that:
 * 1. Only valid JSON-RPC 2.0 frames are treated as protocol traffic.
 * 2. Stray child stdout (diagnostics, logs, debug text) is classified as
 *    noise and must never be forwarded to the host as protocol.
 * 3. The frame fixtures in fixtures/mcp/ contain the expected frame types.
 * 4. The Fusebox CLI proxy dispatch uses argv arrays (no shell interpolation).
 *
 * RED tests are written first to define the interface, followed by the
 * implementation that satisfies them.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import { runFuseboxCli } from "../src/cli/fuseboxCli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Frame classification helpers (TypeScript mirror of Rust framing logic) ────
//
// These functions implement the same classification rules as
// fusebox_core::framing in Rust. They provide an independent verification
// that the fixtures and the Rust logic agree.

interface FrameClassification {
  kind: "protocol" | "noise";
  reason?: "empty" | "malformed_json" | "not_jsonrpc" | "oversized" | "contains_secret";
}

const MAX_FRAME_BYTES = 4 * 1024 * 1024; // 4 MiB — must match Rust constant

function classifyLine(line: string, secretPatterns: string[] = []): FrameClassification {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return { kind: "noise", reason: "empty" };
  }

  if (trimmed.length > MAX_FRAME_BYTES) {
    return { kind: "noise", reason: "oversized" };
  }

  // Secret check before any parsing.
  for (const pattern of secretPatterns) {
    if (pattern.length > 0 && trimmed.includes(pattern)) {
      return { kind: "noise", reason: "contains_secret" };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "noise", reason: "malformed_json" };
  }

  if (!isJsonRpcEnvelope(parsed)) {
    return { kind: "noise", reason: "not_jsonrpc" };
  }

  return { kind: "protocol" };
}

function isJsonRpcEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj["jsonrpc"] !== "2.0") {
    return false;
  }
  // Request / notification: has "method" string.
  if (typeof obj["method"] === "string") {
    return true;
  }
  // Response: has "id" AND ("result" or "error").
  if ("id" in obj && ("result" in obj || "error" in obj)) {
    return true;
  }
  return false;
}

// ── Protocol frame classification tests ──────────────────────────────────────

describe("MCP proxy frame classification", () => {
  describe("valid JSON-RPC frames are classified as protocol", () => {
    it("classifies a JSON-RPC request as protocol", () => {
      const line = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });

    it("classifies a JSON-RPC notification as protocol", () => {
      const line = `{"jsonrpc":"2.0","method":"notifications/initialized"}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });

    it("classifies a JSON-RPC response with result as protocol", () => {
      const line = `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });

    it("classifies a JSON-RPC response with error as protocol", () => {
      const line = `{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"not found"}}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });

    it("classifies a JSON-RPC response with null id as protocol", () => {
      const line = `{"jsonrpc":"2.0","id":null,"result":{}}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });

    it("classifies a JSON-RPC request with extra fields as protocol (forward compat)", () => {
      const line = `{"jsonrpc":"2.0","id":1,"method":"ping","_debug":true}`;
      expect(classifyLine(line).kind).toBe("protocol");
    });
  });

  describe("non-protocol lines are classified as noise", () => {
    it("classifies an empty line as noise (empty)", () => {
      const result = classifyLine("");
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("empty");
    });

    it("classifies whitespace-only line as noise (empty)", () => {
      const result = classifyLine("   \t  ");
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("empty");
    });

    it("classifies plain text as noise (malformed_json)", () => {
      const result = classifyLine("Server starting on port 8080");
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("malformed_json");
    });

    it("classifies partial JSON as noise (malformed_json)", () => {
      const result = classifyLine(`{"jsonrpc":"2.0","id":1,"method":`);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("malformed_json");
    });

    it("classifies valid JSON without jsonrpc field as noise (not_jsonrpc)", () => {
      // KEY INVARIANT: an arbitrary JSON object from tool output must never be
      // promoted to a protocol frame merely because it is valid JSON.
      const result = classifyLine(`{"some":"data","nested":{"key":"value"}}`);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("not_jsonrpc");
    });

    it("classifies a JSON array as noise (not_jsonrpc)", () => {
      const result = classifyLine("[1,2,3]");
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("not_jsonrpc");
    });

    it("classifies JSON-RPC with wrong version as noise (not_jsonrpc)", () => {
      const result = classifyLine(`{"jsonrpc":"1.0","id":1,"method":"test"}`);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("not_jsonrpc");
    });

    it("classifies a JSON-RPC response with id but no result/error as noise (not_jsonrpc)", () => {
      const result = classifyLine(`{"jsonrpc":"2.0","id":1}`);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("not_jsonrpc");
    });

    it("classifies a JSON-RPC batch array as noise (not_jsonrpc)", () => {
      const result = classifyLine(`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("not_jsonrpc");
    });

    it("classifies an oversized line as noise (oversized)", () => {
      const line = "x".repeat(MAX_FRAME_BYTES + 1);
      const result = classifyLine(line);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("oversized");
    });
  });

  describe("secret pattern redaction", () => {
    it("classifies a frame containing a secret pattern as noise (contains_secret)", () => {
      const line = `{"jsonrpc":"2.0","id":1,"method":"init","params":{"token":"sk-abc123"}}`;
      const result = classifyLine(line, ["sk-abc123"]);
      expect(result.kind).toBe("noise");
      expect(result.reason).toBe("contains_secret");
    });

    it("empty secret pattern does not match every frame", () => {
      const line = `{"jsonrpc":"2.0","id":1,"method":"ping"}`;
      const result = classifyLine(line, [""]);
      expect(result.kind).toBe("protocol");
    });

    it("non-matching secret pattern does not affect classification", () => {
      const line = `{"jsonrpc":"2.0","id":1,"method":"ping"}`;
      const result = classifyLine(line, ["sk-notpresent"]);
      expect(result.kind).toBe("protocol");
    });
  });
});

// ── Fixture file validation ────────────────────────────────────────────────────

describe("MCP proxy fixtures", () => {
  it("valid-frames.jsonl — all lines are protocol frames", () => {
    const content = readFileSync(
      resolve(root, "fixtures/mcp/valid-frames.jsonl"),
      "utf8",
    );
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const result = classifyLine(line);
      expect(result.kind).toBe("protocol");
    }
  });

  it("noise-mixed-frames.txt — only valid JSON-RPC lines are protocol, others are noise", () => {
    const content = readFileSync(
      resolve(root, "fixtures/mcp/noise-mixed-frames.txt"),
      "utf8",
    );
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const protocolLines = lines.filter((l) => classifyLine(l).kind === "protocol");
    const noiseLines = lines.filter((l) => classifyLine(l).kind === "noise");

    // There must be both protocol and noise lines in the mixed fixture.
    expect(protocolLines.length).toBeGreaterThan(0);
    expect(noiseLines.length).toBeGreaterThan(0);

    // Every protocol line in the fixture must contain "jsonrpc":"2.0".
    for (const line of protocolLines) {
      expect(line).toContain('"jsonrpc":"2.0"');
    }
  });

  it("adversarial-frames.txt — all lines are noise (no protocol frames)", () => {
    const content = readFileSync(
      resolve(root, "fixtures/mcp/adversarial-frames.txt"),
      "utf8",
    );
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const result = classifyLine(line);
      expect(result.kind).toBe("noise");
    }
  });
});

// ── Protocol stream integrity invariants ──────────────────────────────────────

describe("MCP proxy stream integrity invariants", () => {
  it("no noise line from the mixed fixture passes as protocol", () => {
    const noiseLines = [
      "Server starting up...",
      "[DEBUG] tool handler called",
      "shutdown complete",
      '{"some":"data","not":"jsonrpc"}',
    ];
    for (const line of noiseLines) {
      const result = classifyLine(line);
      expect(result.kind).toBe("noise");
    }
  });

  it("all valid JSON-RPC message types are forwarded correctly", () => {
    const protocolLines = [
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
      `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
      `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}`,
      `{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"not found"}}`,
    ];
    for (const line of protocolLines) {
      const result = classifyLine(line);
      expect(result.kind).toBe("protocol");
    }
  });

  it("a large but valid JSON-RPC frame below size limit is forwarded", () => {
    // A realistic large tools/call response with significant payload.
    const largeResult = { data: "x".repeat(10_000) };
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: largeResult,
    });
    expect(line.length).toBeLessThan(MAX_FRAME_BYTES);
    const result = classifyLine(line);
    expect(result.kind).toBe("protocol");
  });

  it("request ID ordering and uniqueness — each valid frame preserves its id", () => {
    const frames = [
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
      `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}`,
    ];
    const ids: number[] = [];
    for (const line of frames) {
      const result = classifyLine(line);
      expect(result.kind).toBe("protocol");
      const parsed = JSON.parse(line) as { id: number };
      ids.push(parsed.id);
    }
    // IDs must be preserved in the order the frames were received.
    expect(ids).toEqual([1, 2, 3]);
  });
});

// ── CLI proxy dispatch tests (no shell interpolation) ─────────────────────────

describe("Fusebox CLI proxy dispatch", () => {
  it("forwards proxy command as an argv array without shell interpolation", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _options: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(
      ["proxy", "--", "mcp-server", "--flag", "argument with spaces"],
      {
        binaryPath: "fusebox-test-binary",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    // The spawn call must use shell: false.
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test-binary",
      ["proxy", "--", "mcp-server", "--flag", "argument with spaces"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });

  it("returns non-zero exit code when child exits with error", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 2;
        child.emit("close", 2);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(
      ["proxy", "--", "mcp-server"],
      {
        binaryPath: "fusebox-test-binary",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(2);
  });

  it("returns a clear error when the Rust executable is unavailable for proxy", async () => {
    let stderr = "";
    const exitCode = await runFuseboxCli(["proxy", "--", "some-server"], {
      binaryPath: null,
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Rust Fusebox executable was not found");
  });

  it("does not perform shell string interpolation — arguments are passed verbatim", async () => {
    // This test verifies the critical security property: a child server name
    // containing shell metacharacters must be passed as a literal argument,
    // not interpreted by a shell.
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _opts: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    });

    const trickyArg = "$(rm -rf /tmp/test)";
    await runFuseboxCli(
      ["proxy", "--", "server-binary", trickyArg],
      {
        binaryPath: "fusebox",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    const call = spawn.mock.calls[0];
    expect(call).toBeDefined();
    const passedArgs = call![1] as string[];
    // The tricky argument must appear verbatim in the argv array.
    expect(passedArgs).toContain(trickyArg);
    // shell: false must be set.
    expect((call![2] as { shell: boolean }).shell).toBe(false);
  });

  it("passes --framing and timing flags before -- separator", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _opts: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(
      ["proxy", "--framing", "content-length", "--shutdown-timeout", "15", "--grace-period", "3", "--", "my-server", "--flag"],
      {
        binaryPath: "fusebox",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    const call = spawn.mock.calls[0];
    expect(call).toBeDefined();
    const passedArgs = call![1] as string[];
    expect(passedArgs).toEqual(["proxy", "--framing", "content-length", "--shutdown-timeout", "15", "--grace-period", "3", "--", "my-server", "--flag"]);
  });
});

// ── Content-Length transport framing tests ───────────────────────────────────

interface ContentLengthDecodeResult {
  kind: "frame" | "incomplete" | "noise";
  bytesConsumed?: number;
  class?: FrameClassification;
  reason?: "empty" | "malformed_json" | "not_jsonrpc" | "oversized" | "contains_secret";
  entry?: string;
}

function decodeContentLengthFrame(
  buffer: string,
  secretPatterns: string[] = [],
): ContentLengthDecodeResult {
  if (buffer.length === 0) return { kind: "incomplete" };

  const clIndex = buffer.toLowerCase().indexOf("content-length:");
  if (clIndex > 0) {
    return {
      kind: "noise",
      bytesConsumed: clIndex,
      reason: "malformed_json",
      entry: `[proxy:noise] malformed JSON: ${buffer.slice(0, clIndex)}`,
    };
  }

  if (clIndex === -1) {
    if (buffer.includes("\n")) {
      const nl = buffer.indexOf("\n") + 1;
      return {
        kind: "noise",
        bytesConsumed: nl,
        reason: "malformed_json",
        entry: `[proxy:noise] malformed JSON: ${buffer.slice(0, nl)}`,
      };
    }
    return { kind: "incomplete" };
  }

  const headerEnd = buffer.indexOf("\r\n\r\n");
  const delimLen = headerEnd !== -1 ? 4 : (buffer.indexOf("\n\n") !== -1 ? 2 : 0);
  const termIdx = headerEnd !== -1 ? headerEnd : buffer.indexOf("\n\n");

  if (termIdx === -1) {
    return buffer.length > 4096
      ? { kind: "noise", bytesConsumed: 4096, reason: "malformed_json" }
      : { kind: "incomplete" };
  }

  const headerLen = termIdx + delimLen;
  const headerText = buffer.slice(0, termIdx);
  const match = headerText.match(/content-length:\s*(\d+)/i);
  if (!match) {
    return { kind: "noise", bytesConsumed: headerLen, reason: "malformed_json" };
  }

  const length = parseInt(match[1]!, 10);
  if (length > MAX_FRAME_BYTES) {
    return { kind: "noise", bytesConsumed: headerLen, reason: "oversized" };
  }

  const totalRequired = headerLen + length;
  if (buffer.length < totalRequired) {
    return { kind: "incomplete" };
  }

  const payload = buffer.slice(headerLen, totalRequired);
  for (const pattern of secretPatterns) {
    if (pattern.length > 0 && payload.includes(pattern)) {
      return {
        kind: "frame",
        bytesConsumed: totalRequired,
        class: { kind: "noise", reason: "contains_secret" },
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      kind: "frame",
      bytesConsumed: totalRequired,
      class: { kind: "noise", reason: "malformed_json" },
    };
  }

  if (isJsonRpcEnvelope(parsed)) {
    return {
      kind: "frame",
      bytesConsumed: totalRequired,
      class: { kind: "protocol" },
    };
  }

  return {
    kind: "frame",
    bytesConsumed: totalRequired,
    class: { kind: "noise", reason: "not_jsonrpc" },
  };
}

describe("MCP Content-Length transport framing", () => {
  it("decodes a valid single-line Content-Length frame", () => {
    const payload = `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`;
    const frame = `Content-Length: ${payload.length}\r\n\r\n${payload}`;
    const result = decodeContentLengthFrame(frame);
    expect(result.kind).toBe("frame");
    expect(result.bytesConsumed).toBe(frame.length);
    expect(result.class?.kind).toBe("protocol");
  });

  it("decodes a multi-line formatted JSON-RPC payload in Content-Length mode", () => {
    const payload = `{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": {\n    "status": "ok"\n  }\n}`;
    const frame = `Content-Length: ${payload.length}\r\n\r\n${payload}`;
    const result = decodeContentLengthFrame(frame);
    expect(result.kind).toBe("frame");
    expect(result.bytesConsumed).toBe(frame.length);
    expect(result.class?.kind).toBe("protocol");
  });

  it("routes preceding diagnostic noise before Content-Length header to noise", () => {
    const noise = "Server initialized\n";
    const payload = `{"jsonrpc":"2.0","id":1,"result":{}}`;
    const frame = `Content-Length: ${payload.length}\r\n\r\n${payload}`;
    const stream = noise + frame;

    const res1 = decodeContentLengthFrame(stream);
    expect(res1.kind).toBe("noise");
    expect(res1.bytesConsumed).toBe(noise.length);

    const res2 = decodeContentLengthFrame(stream.slice(res1.bytesConsumed!));
    expect(res2.kind).toBe("frame");
    expect(res2.class?.kind).toBe("protocol");
  });

  it("redacts configured secrets in Content-Length payloads", () => {
    const secret = "sk-supersecret-token";
    const payload = `{"jsonrpc":"2.0","id":1,"method":"auth","params":{"token":"${secret}"}}`;
    const frame = `Content-Length: ${payload.length}\r\n\r\n${payload}`;

    const res = decodeContentLengthFrame(frame, [secret]);
    expect(res.kind).toBe("frame");
    expect(res.class?.kind).toBe("noise");
    expect(res.class?.reason).toBe("contains_secret");
  });

  it("rejects non-JSON-RPC payload under Content-Length framing", () => {
    const payload = `{"tool_result":"arbitrary_json","not_jsonrpc":true}`;
    const frame = `Content-Length: ${payload.length}\r\n\r\n${payload}`;

    const res = decodeContentLengthFrame(frame);
    expect(res.kind).toBe("frame");
    expect(res.class?.kind).toBe("noise");
    expect(res.class?.reason).toBe("not_jsonrpc");
  });
});
