export function formatScanHelp(tier: "happy" | "advanced" | "experimental"): string {
  const lines = [
    "Usage: memo-log scan [dir] [options]",
    "",
    "Generate deterministic MEMO_LOG.md + MEMO_LOG.json (defaults: --mode dual --format both).",
    "",
    "Happy path:",
    "  -m, --mode <mode>       dual (default) | tech | simple | brief",
    "  -f, --format <format>   both (default) | md | json",
    "  -w, --watch             live rescan; prompts once to allow file watching",
    "  -q, --quiet             suppress warnings (CI)",
    "  --verbose               print the analysis engine and scan details",
    "  --help-advanced         power-user flags",
    "  --help-experimental     experimental flags",
  ];

  if (tier === "advanced" || tier === "experimental") {
    lines.push(
      "",
      "Power user / CI:",
      "  -o, --out <path>              override a single output file (needs --format md|json)",
      "  -c, --config <path>           non-default .memolog.json",
      "  --include-agent-notes         append unverified AI session notes",
      "  --filter <type>               logic (default) | trivial | all",
      "",
      "Selective context (preferred for AI tools):",
      "  --export-context              write ranked, reference-anchored MEMO_LOG_CONTEXT.json",
      "  --audience <mode>             tech (default) | simple",
      "  --max-tokens <n>              hard context ceiling (default 1000000)",
      "  --export-context-md           also write MEMO_LOG_CONTEXT.md",
      "",
      "Docs & CI:",
      "  --mermaid                     write MEMO_LOG_DEPS.md Mermaid graph",
      "  --mermaid-depth <n>           limit graph to N import hops",
      "  --scaffold-docs               write CHANGELOG/MIGRATION scaffolds on breaking changes",
      "  --check-docs                  fail (exit 5) when changed critical files lack docs",
    );
  }

  if (tier === "experimental") {
    lines.push(
      "",
      "Experimental:",
      "  --infer-runtime     static call graph / API map → MEMO_LOG_INFERENCE.md",
      "  --agent-ui          multi-agent conflict report → MEMO_LOG_CONFLICTS.md",
    );
  }

  lines.push(
    "",
    "Engine limits live in .memolog.json (not flags): maxDepth, timeoutMs, maxFileSizeBytes, trackTypes",
    "Impact ranking weights live in .memolog.json under ranking.weights",
    "Context pack defaults live in .memolog.json under exportContext (defaultMaxTokens, reorder)",
    "Critical docs paths live in .memolog.json under docs.criticalPaths",
    "",
    "Exit codes: 0 success | 2 config | 3 security | 4 runtime | 5 docs check failed",
    "",
  );
  return lines.join("\n");
}

export function printScanHelp(tier: "happy" | "advanced" | "experimental"): void {
  process.stdout.write(formatScanHelp(tier));
}
