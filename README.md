# Fusebox

Agent execution gateway with receipts. Supervised process execution, MCP stdio proxy, intent contracts and a hash-chained local audit ledger.

## What it does

An AI coding agent proposes a command. Fusebox evaluates it against a developer-owned session intent contract, enforces the decision at the OS level, and writes a hash-chained receipt. The developer can inspect what ran, what was denied, and why — without a cloud service.

```
agent proposes rm -rf /project/src/../../etc
         │
         ▼
   IntentContract: write_roots=[/project/src, /project/target]
         │
         ▼
   PolicyDecision: DENY — OUTSIDE_WRITE_ROOT
         │
         ▼
   CommandReceipt: denied, hash-chained, inspectable
```

## Quick start

```bash
# Install (Node.js >= 22.13.0)
npm install -g fusebox

# Initialise a session intent contract in your project
fusebox init

# Run a supervised command
fusebox run -- cargo test

# Inspect the receipt
fusebox why <receipt-id>

# Verify the full receipt chain
fusebox verify
```

Agents connect over MCP. Add to your host configuration (`.mcp.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "fusebox": {
      "command": "npx",
      "args": ["fusebox", "proxy", "--", "/path/to/your-mcp-server"]
    }
  }
}
```

## CLI surface

| Command | Purpose |
|---------|---------|
| `fusebox init` | Create `.fusebox/policy.json` and print host setup instructions |
| `fusebox run -- <cmd> [args...]` | Run a command as a supervised child; return the child's exit status |
| `fusebox proxy -- <mcp-server> [args...]` | Proxy an MCP server over stdio with JSON-RPC framing checks |
| `fusebox policy dry-run <request>` | Evaluate a proposed command without executing it |
| `fusebox receipts [session]` | List local execution receipts |
| `fusebox why <receipt-id>` | Explain one decision and its evidence |
| `fusebox verify [session]` | Verify the receipt chain |

`--json` output is the stable integration surface for agents and SDKs.

## MCP tools

| Tool | Access |
|------|--------|
| `run_supervised` | Execution (must be explicitly enabled) |
| `policy_dry_run` | Read-only evaluation |
| `list_receipts` | Read-only |
| `explain_receipt` | Read-only |
| `verify_session` | Read-only |

The default MCP surface is read-only. Execution tools require explicit local configuration.

## Session intent contract

Before work begins, declare a bounded scope:

```json
{
  "schemaVersion": "1",
  "sessionId": "my-session",
  "workspaceRoots": ["/project"],
  "writeRoots": ["/project/src", "/project/target"],
  "allowedCommandClasses": ["build", "test", "format"],
  "networkPolicy": "deny_all",
  "approvalPolicy": "deny"
}
```

Operations within scope proceed automatically and are recorded. Operations outside scope are denied or escalated to the developer, never silently permitted.

## Receipts

Every supervised execution produces a hash-chained record:

- What was requested (executable, redacted argv, cwd)
- The policy verdict and the rule that produced it
- The OS enforcement backend and its result
- How the process terminated (or that it was denied before starting)
- Bounded stdout/stderr digests — raw output is never stored
- A SHA-256 chain linking every record to the previous one

`fusebox verify` recomputes the chain and reports the first invalid record.

## Non-negotiable principles

1. **The developer owns the policy.** The agent proposes; the developer approves the intent contract.
2. **Execution is explicit.** No command runs unless it goes through the supervised path.
3. **Receipts are local.** Nothing is sent to a cloud service by default.
4. **Deny by default.** Unknown syntax and out-of-scope paths are denied or escalated, never guessed.
5. **Rust is the enforcement authority.** TypeScript handles CLI UX and MCP plumbing; Rust makes authorization decisions and writes receipts.
6. **No secret values in receipts.** `.env` contents, tokens and credentials are never written to the journal.

## Architecture

```
src/            TypeScript CLI, MCP adapter, local receipt viewer
rust/
  crates/
    fusebox-core/   Versioned contracts, receipt types, hash-chain verifier
    fusebox-cli/    Rust binary: run, proxy, receipts, verify
    analysis-core/  Legacy walk/diff/rank (not in enforcement path)
schemas/        JSON Schema for IntentContract, ExecRequest, CommandReceipt
fixtures/       Cross-language test fixtures and adversarial cases
```

The first supported enforcement target is Linux with Landlock. macOS host-hook integration may be demonstrated but is not equivalent kernel-level confinement. Windows is out of scope for the first release.

## Requirements

- Node.js >= 22.13.0
- Rust toolchain (required to build the enforcement core)
- Linux with Landlock (for OS-level confinement; other platforms log-only)

## License

MIT
