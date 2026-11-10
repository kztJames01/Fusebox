import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import {
  createDefaultConfig,
  loadEffectiveConfig,
  runScanCommand,
  resolveAnalysisEngine,
  CliError,
  ExitCode,
} from "../engine/index.js";
import type { AuditOptions } from "./audit.js";
import type { ParsedFile } from "../parsers/types.js";
import type { ConflictReport } from "../engine/conflicts.js";
import { MEMO_LOG_VERSION } from "../mcp/server.js";
import { formatScanHelp } from "./scanHelp.js";
import { renderCompactHelp, runInteractiveMenu } from "./interactiveMenu.js";
import type { MenuInput } from "./interactiveMenu.js";

// CLI entry point for deterministic project memory generation
// Supports three main operations: init, commits, and scan
type ScanMode = "tech" | "simple" | "dual" | "brief";  // Different scanning strategies
type ScanFormat = "md" | "json" | "both";  // Output formats for scan results

interface InitCommandOptions {
  force?: boolean;
}

interface RawScanCommandOptions {
  mode?: ScanMode;
  out?: string;
  format?: ScanFormat;
  config?: string | true;
}

interface ScanExecutionOptions {
  targetDir: string;
  mode?: ScanMode | undefined;
  out?: string | undefined;
  format?: ScanFormat | undefined;
  config?: string | undefined;
  includeAgentNotes?: boolean | undefined;
  quiet?: boolean | undefined;
  filter?: string | undefined;
  scaffoldDocs?: boolean | undefined;
  mermaid?: boolean | undefined;
  mermaidDepth?: number | undefined;
  checkDocs?: boolean | undefined;
}

interface CommitCommandOptions {
  apply?: boolean;
  dryRun?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;  // Type guard for Record type

const normalizeOptional = <T>(value: T | true | undefined): T | undefined =>
  value === true ? undefined : value;

const parsePositiveInteger = (raw: string, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(
      `${flag} must be a positive integer (received "${raw}").`,
      ExitCode.ConfigError,
    );
  }
  return value;
};

const parseNonNegativeInteger = (raw: string, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(
      `${flag} must be a non-negative integer (received "${raw}").`,
      ExitCode.ConfigError,
    );
  }
  return value;
};

// Convert errors to standardized exit codes for consistent CLI behavior
const toExitCode = (error: unknown): number => {
  if (error instanceof CommanderError) {
    if (
      error.code === "commander.helpDisplayed" || 
      error.code === "commander.version"  
    ) {
      return 0;  // Success exit code for non-error commands
    }
    return typeof error.exitCode === "number" ? error.exitCode : 1;
  }

  if (isRecord(error) && typeof error.exitCode === "number") {
    return error.exitCode; // Use exitCode if available on custom errors
  }

  return 1;  // Default error exit code
};

const printErrorIfNeeded = (error: unknown): void => {
  if (error instanceof CommanderError) {
    return;
  }

  if (error instanceof Error) {
    if (error.message.trim().length > 0) {
      console.error(error.message);
    }
    return;
  }

  console.error("Command failed.");
};

const runCommitsCommand = async (
  targetDir: string,
  options: CommitCommandOptions,
): Promise<void> => {
  const GitService = await import("../engine/git.js").then(m => m.GitService);
  const CommitGrouper = await import("../engine/commit-grouper.js").then(m => m.CommitGrouper);

  const git = new GitService(targetDir);
  if (!(await git.isRepository())) {
    throw new CliError(
      `Not a git repository: ${targetDir}. The commits command needs a git work tree.`,
      ExitCode.ConfigError,
    );
  }
  const changes = await git.getChangedFiles();

  if (changes.length === 0) {
    console.log("No changes detected since HEAD.");
    return;
  }

  const groups = CommitGrouper.groupChanges(changes);
  if (options.apply && options.dryRun) {
    throw new InvalidArgumentError("Use either --apply or --dry-run, not both.");
  }

  const apply = Boolean(options.apply);
  const dryRun = !apply;

  console.log("\nSuggested commit groups:\n");
  for (const group of groups) {
    const msg = CommitGrouper.generateMessage(group);
    const command = git.renderCommitCommand(group.files, msg);

    console.log(`- ${msg}`);
    console.log(`  files: ${group.files.join(", ")}`);
    console.log(`  cmd: ${command}`);

    if (!dryRun) {
      await git.commitFiles(group.files, msg);
      console.log(`  committed: ${msg}`);
    }
  }

  if (dryRun) {
    console.log("\nDry-run mode. Re-run with --apply to execute commits.");
  }
};

const buildProgram = (): Command => {
  const program = new Command();

  program
    .name("memo-log")
    .description("Local MCP server and interactive CLI for reference-anchored tickets")
    .version(MEMO_LOG_VERSION, "-v, --version", "Print the memo-log version")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("init")
    .argument("[targetDir]", "Directory to initialize", ".")
    .option("--force", "Overwrite existing config")
    .action(async (targetDir: string, options: InitCommandOptions) => {
      await createDefaultConfig(targetDir, Boolean(options.force));
    });

  program
    .command("commits")
    .argument("[targetDir]", "Directory to analyze", ".")
    .option("--dry-run", "Print commit commands without executing them")
    .option("--apply", "Automatically execute git commit commands")
    .action(runCommitsCommand);

  program
    .command("commit")
    .argument("[targetDir]", "Directory to analyze", ".")
    .option("--dry-run", "Print commit commands without executing them")
    .option("--apply", "Automatically execute git commit commands")
    .action(runCommitsCommand);

  program
    .command("scan")
    .argument("[targetDir]", "Directory to scan", ".")
    .description("Generate MEMO_LOG.md and MEMO_LOG.json")
    .configureHelp({
      formatHelp: () => formatScanHelp("happy"),
    })
    .addOption(new Option("-m, --mode <mode>").choices(["tech", "simple", "dual", "brief"]))
    .addOption(new Option("-f, --format <format>").choices(["md", "json", "both"]).default("both"))
    .option("-w, --watch", "Watch files and rescan (prompts once on first run)")
    .option("-q, --quiet", "Suppress warnings")
    .option("--verbose", "Print the analysis engine and scan details")
    .option("--help-advanced", "Show power-user flags")
    .option("--help-experimental", "Show experimental flags")
    .addOption(new Option("-o, --out <path>", "Override output path (needs --format md or json)").hideHelp())
    .addOption(new Option("-c, --config [path]", "Config file path override").hideHelp())
    .addOption(new Option("--include-agent-notes", "Append unverified agent notes").hideHelp())
    .addOption(new Option("--filter <level>", "Significance filter").choices(["trivial", "logic", "all"]).hideHelp())
    .addOption(new Option("--infer-runtime", "Static runtime inference").hideHelp())
    .addOption(new Option("--agent-ui", "Multi-agent conflict report").hideHelp())
    .addOption(new Option("--export-context", "Write ranked MEMO_LOG_CONTEXT.json for LLM paste").hideHelp())
    .addOption(new Option("--export-context-md", "Also write MEMO_LOG_CONTEXT.md").hideHelp())
    .addOption(new Option("--cards", "Include repo-scoped memory cards in the context pack").hideHelp())
    .addOption(new Option("--audience <mode>", "Context audience: tech or simple").choices(["tech", "simple"]).hideHelp())
    .addOption(new Option("--max-tokens <n>", "Hard token budget for exported context").hideHelp())
    .addOption(new Option("--mermaid", "Write MEMO_LOG_DEPS.md Mermaid dependency graph").hideHelp())
    .addOption(new Option("--mermaid-depth <n>", "Limit Mermaid graph to N import hops").hideHelp())
    .addOption(new Option("--scaffold-docs", "Write CHANGELOG/MIGRATION scaffolds on breaking changes").hideHelp())
    .addOption(new Option("--check-docs", "Fail when changed critical files lack doc comments").hideHelp())
    .addOption(new Option("--confirm", "Script-only watch confirm (no TTY)").hideHelp())
    .addOption(new Option("--max-depth [n]").hideHelp())
    .addOption(new Option("--timeout-ms [n]").hideHelp())
    .addOption(new Option("--max-file-size-bytes [n]").hideHelp())
    .addOption(new Option("--track-types").hideHelp())
    .action(async (targetDir: string, options: RawScanCommandOptions & {
      quiet?: boolean;
      verbose?: boolean;
      includeAgentNotes?: boolean;
      filter?: string;
      watch?: boolean;
      confirm?: boolean;
      inferRuntime?: boolean;
      agentUi?: boolean;
      exportContext?: boolean;
      exportContextMd?: boolean;
      cards?: boolean;
      audience?: "tech" | "simple";
      maxTokens?: string;
      mermaid?: boolean;
      mermaidDepth?: string;
      scaffoldDocs?: boolean;
      checkDocs?: boolean;
      helpAdvanced?: boolean;
      helpExperimental?: boolean;
      maxDepth?: unknown;
      timeoutMs?: unknown;
      maxFileSizeBytes?: unknown;
      trackTypes?: unknown;
    }) => {
      if (options.helpExperimental) {
        process.stdout.write(formatScanHelp("experimental"));
        return;
      }
      if (options.helpAdvanced) {
        process.stdout.write(formatScanHelp("advanced"));
        return;
      }
      if (options.maxDepth !== undefined || options.timeoutMs !== undefined || options.maxFileSizeBytes !== undefined || options.trackTypes) {
        throw new CliError(
          "DEPRECATED FLAG: engine limits are no longer CLI flags. Put maxDepth, timeoutMs, maxFileSizeBytes, and trackTypes in .memolog.json (run `memo-log init <dir>` to create one).",
          ExitCode.ConfigError,
        );
      }

      if (!options.exportContext) {
        if (options.audience !== undefined) {
          throw new CliError(
            "--audience can only be used with --export-context.",
            ExitCode.ConfigError,
          );
        }
        if (options.maxTokens !== undefined) {
          throw new CliError(
            "--max-tokens can only be used with --export-context.",
            ExitCode.ConfigError,
          );
        }
        if (options.exportContextMd === true) {
          throw new CliError(
            "--export-context-md can only be used with --export-context.",
            ExitCode.ConfigError,
          );
        }
      }

      if (options.mermaidDepth !== undefined && options.mermaid !== true) {
        throw new CliError(
          "--mermaid-depth can only be used with --mermaid.",
          ExitCode.ConfigError,
        );
      }

      const exportMaxTokens = options.maxTokens !== undefined
        ? parsePositiveInteger(options.maxTokens, "--max-tokens")
        : undefined;
      const mermaidDepth = options.mermaidDepth !== undefined
        ? parsePositiveInteger(options.mermaidDepth, "--mermaid-depth")
        : undefined;

      const scanOptions: ScanExecutionOptions = { targetDir };
      if (options.mode !== undefined) {
        scanOptions.mode = options.mode;
      }
      if (options.out !== undefined) {
        scanOptions.out = options.out;
      }
      if (options.format !== undefined) {
        scanOptions.format = options.format;
      }

      const config = normalizeOptional(options.config);
      if (config !== undefined) {
        scanOptions.config = config;
      }
      if (options.includeAgentNotes !== undefined) {
        scanOptions.includeAgentNotes = options.includeAgentNotes;
      }
      if (options.quiet !== undefined) {
        scanOptions.quiet = options.quiet;
      }
      if (options.filter !== undefined) {
        scanOptions.filter = options.filter;
      }
      if (options.mermaid === true) {
        scanOptions.mermaid = true;
        if (mermaidDepth !== undefined) {
          scanOptions.mermaidDepth = mermaidDepth;
        }
      }
      if (options.scaffoldDocs === true) {
        scanOptions.scaffoldDocs = true;
      }
      if (options.checkDocs === true) {
        scanOptions.checkDocs = true;
      }

      const effectiveConfig = await loadEffectiveConfig(scanOptions);

      // Confirm watch access before doing any scan work, so non-interactive
      // runs fail fast instead of scanning and then refusing to watch.
      if (options.watch) {
        const { ensureWatchAllowed } = await import("../engine/watchConfirm.js");
        await ensureWatchAllowed(effectiveConfig.rootDir, options.confirm === true, {
          quiet: options.quiet === true,
        });
      }

      const result = await runScanCommand({ ...scanOptions, effectiveConfig });

      if (options.checkDocs === true && result.docsCheck) {
        if (options.quiet) {
          process.stdout.write(`${JSON.stringify(result.docsCheck)}\n`);
        } else {
          const { renderDocsCheck } = await import("../engine/docsCheck.js");
          console.log(renderDocsCheck(result.docsCheck));
        }
        if (!result.docsCheck.ok) {
          throw new CliError("", ExitCode.DocsCheckFailed);
        }
      }

      if (options.inferRuntime) {
        await runRuntimeInference(targetDir, result.snapshot.entries);
      }

      let conflictReport: ConflictReport | null = null;
      if (options.agentUi) {
        conflictReport = await runAgentConflictDetection(targetDir, options.quiet ?? false);
      }

      if (options.exportContext) {
        const { writeExportContext } = await import("./exportContext.js");
        const packCards = options.cards === true
          ? await import("../engine/cards.js").then((mod) =>
              mod.cardsForScope(effectiveConfig.rootDir, {}, 5).map(mod.toPortableCard))
          : [];
        const written = writeExportContext(
          effectiveConfig.rootDir,
          result.jsonPath,
          result.snapshot,
          {
            audience: options.audience ?? "tech",
            maxTokens:
              exportMaxTokens ??
              effectiveConfig.config.exportContext.defaultMaxTokens,
            weights: effectiveConfig.config.ranking.weights,
            diffResult: result.diffResult,
            extracts: result.extracts,
            reorder: effectiveConfig.config.exportContext.reorder,
            ...(conflictReport !== null ? { conflicts: conflictReport.conflicts } : {}),
            ...(packCards.length > 0 ? { cards: packCards } : {}),
            markdown: options.exportContextMd === true,
          },
        );
        if (!options.quiet) {
          console.log(`Export context: ${written.jsonPath}`);
          if (written.markdownPath) {
            console.log(`Export context (markdown): ${written.markdownPath}`);
          }
        }
      }

      if (options.verbose === true) {
        console.log(`Engine: ${result.engine}`);
      }

      if (!options.quiet) {
        console.log(`Scanned ${result.totalFiles} files.`);
        if (result.markdownPath) {
          console.log(`Markdown: ${result.markdownPath}`);
        }
        if (result.jsonPath) {
          console.log(`JSON: ${result.jsonPath}`);
        }
        if (result.dependencyGraph) {
          console.log(`Dependency graph: ${result.dependencyGraph.path}`);
        }
        if (result.scaffolds?.written) {
          console.log(`Scaffolds updated for ${result.breakingChanges.length} breaking change(s).`);
        }
      }

      if (options.watch) {
        const { startWatcher } = await import("../engine/watcher.js");
        const sigOptions = {
          filter: (scanOptions.filter as "trivial" | "logic" | "all") ?? effectiveConfig.config.filter ?? "logic",
          trackTypes: effectiveConfig.config.trackTypes ?? false,
        };
        const controller = startWatcher({
          rootDir: effectiveConfig.rootDir,
          config: effectiveConfig,
          sigOptions,
          quiet: options.quiet ?? false,
          includeAgentNotes: options.includeAgentNotes === true,
        });

        const shutdown = async () => {
          await controller.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        await new Promise<void>(() => {});
      }
    });

  // Audit command — deterministic, Zod-validated, hash-signed export
  program
    .command("audit")
    .argument("[targetDir]", "Directory to audit", ".")
    .addOption(new Option("--format <format>", "Output format").choices(["json", "text"]).default("json"))
    .option("--out <path>", "Write output to file instead of stdout")
    .action(async (targetDir: string, options: { format: "json" | "text"; out?: string }) => {
      const { runAuditCommand } = await import("./audit.js");
      const auditOpts: AuditOptions = { targetDir, format: options.format };
      if (options.out !== undefined) auditOpts.out = options.out;
      await runAuditCommand(auditOpts);
    });

  program
    .command("validate")
    .argument("[file]", "MEMO_LOG.json path to schema-check", "MEMO_LOG.json")
    .action(async (file: string) => {
      const { validateMemoryJsonFile } = await import("../engine/validate.js");
      const snapshot = validateMemoryJsonFile(file);
      process.stdout.write(`OK schema v${snapshot.version} entries=${snapshot.entries.length}\n`);
    });

  program
    .command("index")
    .argument("[targetDir]", "Directory to index", ".")
    .description("Build the local SQLite index (.memo-log/index.sqlite)")
    .option("--since <rev>", "Only report changes since a git revision")
    .option("--rebuild", "Re-read every file instead of trusting size/mtime")
    .option("--conflicts", "Also check open index sessions and cards for conflicts")
    .option("--json", "Machine-readable output")
    .option("-q, --quiet", "Suppress human output")
    .action(async (targetDir: string, options: {
      since?: string;
      rebuild?: boolean;
      conflicts?: boolean;
      json?: boolean;
      quiet?: boolean;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const { TsIndexEngine } = await import("../engine/tsIndexEngine.js");
      const { indexDbPath, openIndexDatabase } = await import("../engine/indexSchema.js");
      const engine = new TsIndexEngine();
      const version = engine.version();
      const changes = await engine.index(loadedConfig.rootDir, {
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.rebuild === true ? { rebuild: true } : {}),
      });

      if (options.conflicts === true) {
        const { detectIndexConflicts, sortConflicts } = await import("../engine/indexConflicts.js");
        const { GitService } = await import("../engine/git.js");
        const { loadCards } = await import("../engine/cards.js");
        const git = new GitService(loadedConfig.rootDir);
        const headSha = await git.getHeadSha();
        const db = await openIndexDatabase(loadedConfig.rootDir);
        try {
          const found = await detectIndexConflicts(db, {
            ...(headSha !== undefined ? { headSha } : {}),
            isAncestor: (ancestor, descendant) => git.isAncestor(ancestor, descendant),
            cards: loadCards(loadedConfig.rootDir),
          });
          changes.conflicts = sortConflicts([...changes.conflicts, ...found]);
        } finally {
          db.close();
        }
      }

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({
          kind: "memo-log-index",
          schema: version.schema,
          engine: version.engine,
          db: indexDbPath(loadedConfig.rootDir),
          ...changes,
        })}\n`);
        return;
      }
      if (options.quiet === true) {
        return;
      }

      const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0 };
      for (const file of changes.files) {
        counts[file.changeType] += 1;
      }
      if (changes.files.length === 0) {
        console.log(`Index up to date: ${indexDbPath(loadedConfig.rootDir)}`);
      } else {
        console.log(
          `Index: ${String(changes.files.length)} file(s) changed (${String(counts.ADDED)} added, ${String(counts.MODIFIED)} modified, ${String(counts.REMOVED)} removed)`,
        );
        console.log(
          `Exports: ${String(changes.exports_added.length)} added, ${String(changes.exports_removed.length)} removed, ${String(changes.exports_changed.length)} changed`,
        );
        console.log(`Index DB: ${indexDbPath(loadedConfig.rootDir)}`);
      }
      for (const conflict of changes.conflicts) {
        console.log(`CONFLICT ${conflict.kind}: ${conflict.detail}`);
      }
      for (const warning of changes.warnings) {
        console.warn(warning);
      }
    });

  program
    .command("changelog")
    .argument("[targetDir]", "Directory to analyze", ".")
    .description("Write CHANGELOG/MIGRATION scaffolds for structural breaking changes")
    .option("--json", "Machine-readable output")
    .option("-q, --quiet", "Suppress human output")
    .action(async (targetDir: string, options: { json?: boolean; quiet?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const { runChangelogCommand } = await import("../engine/changelogCommand.js");
      const result = await runChangelogCommand(loadedConfig);

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({
          breakingChanges: result.breakingChanges,
          written: result.scaffolds.written,
          fingerprint: result.scaffolds.fingerprint,
          changelogPath: result.scaffolds.changelogPath,
          migrationPath: result.scaffolds.migrationPath,
          diffSummary: result.diffSummary,
        })}\n`);
        return;
      }

      if (options.quiet === true) {
        return;
      }

      if (result.breakingChanges.length === 0) {
        console.log("No breaking changes detected.");
        return;
      }
      console.log(`Breaking changes: ${result.breakingChanges.length}`);
      console.log(`CHANGELOG: ${result.scaffolds.changelogPath}`);
      console.log(`Migration guide: ${result.scaffolds.migrationPath}`);
    });

  const session = program
    .command("session")
    .description("Start, end, or inspect a deterministic work session");

  session
    .command("start")
    .argument("[label]", "Optional session label")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--force", "Replace an already-active session")
    .option("--json", "Machine-readable output")
    .action(async (label: string | undefined, options: { dir: string; force?: boolean; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { runSessionStart } = await import("../engine/sessionCommands.js");
      const result = runSessionStart({
        rootDir: loadedConfig.rootDir,
        ...(label !== undefined ? { label } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
      });

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result.session)}\n`);
        return;
      }
      console.log(`Session started: ${result.session.id}${result.session.label ? ` (${result.session.label})` : ""}`);
    });

  session
    .command("end")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (options: { dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { runSessionEnd } = await import("../engine/sessionCommands.js");
      const result = await runSessionEnd({ loadedConfig });

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({
          session: result.session,
          ticket: result.ticket?.ticket,
          diffSummary: result.diffSummary,
          breakingChangeCount: result.breakingChangeCount,
          warnings: result.warnings ?? [],
        })}\n`);
        return;
      }

      if (!result.ticket) {
        console.log(`Session ended: ${result.session.id} (no structural changes)`);
        return;
      }
      console.log(`Session ended: ${result.session.id}`);
      console.log(`Ticket: ${result.ticket.ticket.id}`);
      console.log(`Ticket JSON: ${result.ticket.jsonPath}`);
      console.log(`Ticket Markdown: ${result.ticket.markdownPath}`);
      for (const warning of result.warnings ?? []) console.warn(`Warning: ${warning}`);
    });

  session
    .command("status")
    .argument("[id]", "Session id (defaults to the active session)")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (id: string | undefined, options: { dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { runSessionStatus } = await import("../engine/sessionCommands.js");
      const result = runSessionStatus(loadedConfig.rootDir, id);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (!result.session) {
        console.log("No session found.");
        return;
      }
      console.log(`${result.session.id} [${result.session.status}] started ${result.session.startedAt}`);
      if (result.session.endedAt) {
        console.log(`ended ${result.session.endedAt}`);
      }
      if (result.session.ticketId) {
        console.log(`ticket ${result.session.ticketId}`);
      }
    });

  session
    .command("checkpoint")
    .requiredOption("--agent <id>", "Agent identifier recorded for this span")
    .requiredOption("--path <path>", "Repository-relative file path")
    .requiredOption("--start-line <n>", "1-based inclusive start line")
    .requiredOption("--end-line <n>", "1-based inclusive end line")
    .option("--session <id>", "Session id (defaults to the active session)")
    .option("--model <name>", "Optional model identifier")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .description("Record an explicit attribution span in the local hash chain")
    .action(async (options: { agent: string; path: string; startLine: string; endLine: string; session?: string; model?: string; dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { loadCurrentSession } = await import("../engine/sessions.js");
      const { checkpointAttribution } = await import("../engine/attribution.js");
      const active = loadCurrentSession(loadedConfig.rootDir);
      const sessionId = options.session ?? active?.id;
      if (!sessionId) throw new CliError("No active session. Start one or pass --session <id>.", ExitCode.ConfigError);
      const result = await checkpointAttribution(loadedConfig.rootDir, {
        sessionId,
        agentId: options.agent,
        ...(options.model !== undefined ? { model: options.model } : {}),
        path: options.path,
        startLine: parsePositiveInteger(options.startLine, "--start-line"),
        endLine: parsePositiveInteger(options.endLine, "--end-line"),
      });
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else console.log(`Attribution checkpoint ${result.span.id} recorded (${result.span.path}:${result.span.startLine}-${result.span.endLine}, seq ${result.span.seq}).`);
    });

  session
    .command("attribution")
    .argument("[id]", "Session id (defaults to the active session)")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .description("Inspect attribution coverage and hash-chain status")
    .action(async (id: string | undefined, options: { dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { attributionStatus } = await import("../engine/attribution.js");
      const { loadCurrentSession } = await import("../engine/sessions.js");
      const status = await attributionStatus(loadedConfig.rootDir, id ?? loadCurrentSession(loadedConfig.rootDir)?.id);
      if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
      else {
        console.log(`Attribution spans: ${status.spanCount} (chain ${status.chainValid ? "valid" : "INVALID"})`);
        console.log(`Captured ${status.counts.captured}; survived rewrite ${status.counts.survived_rewrite}; unattributed ${status.counts.unattributed}.`);
      }
    });

  program
    .command("query")
    .argument("[targetDir]", "Directory containing MEMO_LOG.json", ".")
    .description("Ranked, reference-anchored retrieval from MEMO_LOG.json")
    .option("--category <category>", "Filter by category")
    .option("--kind <kind>", "Filter by export kind")
    .option("--file <path>", "Target file for structural dependents/dependencies")
    .option("--structural", "Merge recent diffs, category, and dependency sources")
    .option("--reorder", "Apply LongContextReorder to the final slice")
    .option("--cards", "Include scoped memory cards (F-14)")
    .option("--limit <n>", "Maximum results", "20")
    .option("--audience <mode>", "tech or simple", "tech")
    .option("--json", "Machine-readable output")
    .action(async (targetDir: string, options: {
      category?: string;
      kind?: string;
      file?: string;
      structural?: boolean;
      reorder?: boolean;
      cards?: boolean;
      limit: string;
      audience: "tech" | "simple";
      json?: boolean;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const {
        buildQueryPayload,
        parseAudienceFilter,
        parseCategoryFilter,
        renderQuery,
      } = await import("./query.js");
      const payload = buildQueryPayload({
        rootDir: loadedConfig.rootDir,
        jsonPath: loadedConfig.config.output.json,
        category: parseCategoryFilter(options.category),
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.file !== undefined ? { file: options.file } : {}),
        structural: options.structural === true,
        ...(options.reorder === true ? { reorder: true } : {}),
        includeCards: options.cards === true,
        limit: parsePositiveInteger(options.limit, "--limit"),
        audience: parseAudienceFilter(options.audience),
        weights: loadedConfig.config.ranking.weights,
      });

      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(payload)}\n`
          : `${renderQuery(payload)}\n`,
      );
    });

  program
    .command("tickets")
    .argument("[targetDir]", "Directory containing .memo-log/tickets", ".")
    .description("List deterministic session tickets")
    .option("--state <state>", "open, needs_review, done, or blocked")
    .option("--category <category>", "Filter by change category")
    .option("--recent", "Show the most recent tickets")
    .option("--limit <n>", "Maximum results")
    .option("--board", "Render tickets grouped by state column (board view)")
    .option("--interactive", "Open the local review page (requires a TTY)")
    .option("--json", "Machine-readable output")
    .action(async (targetDir: string, options: {
      state?: string;
      category?: string;
      recent?: boolean;
      limit?: string;
      board?: boolean;
      interactive?: boolean;
      json?: boolean;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const {
        loadTicketList,
        parseCategoryFilter,
        parseTicketStateFilter,
        renderTickets,
        renderTicketsBoard,
      } = await import("./query.js");

      const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const filtered =
        options.state !== undefined ||
        options.category !== undefined ||
        options.limit !== undefined ||
        options.recent === true;
      const { shouldLaunchReview, runReview } = await import("./review.js");
      if (
        options.interactive === true &&
        shouldLaunchReview({
          tty,
          ...(options.json !== undefined ? { json: options.json } : {}),
          filtered,
        })
      ) {
        await runReview({ rootDir: loadedConfig.rootDir, view: "inbox" });
        return;
      }

      const limit = options.limit !== undefined
        ? parsePositiveInteger(options.limit, "--limit")
        : options.recent === true
          ? 5
          : 20;
      const tickets = loadTicketList({
        rootDir: loadedConfig.rootDir,
        state: parseTicketStateFilter(options.state),
        category: parseCategoryFilter(options.category),
        limit,
      });

      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(tickets)}\n`
          : options.board === true
            ? `${renderTicketsBoard(tickets)}\n`
            : `${renderTickets(tickets)}\n`,
      );
    });

  program
    .command("ticket")
    .argument("<id>", "Ticket id, for example T-0123456789ab")
    .argument("[action]", "accept | done | block | bounce | reopen | check | uncheck")
    .argument("[value]", "Block/bounce reason, or checklist item id/index for check/uncheck")
    .argument("[evidence]", "Evidence for check: [file:line], commit sha, test:<name>, or log:<hash>")
    .option("--evidence <ref>", "Evidence for check, same forms as the positional argument")
    .option("--group <group-id>", "Check or uncheck a change group")
    .option("--approve <scope>", "Bulk check groups: all | p2_or_lower")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .description("Print or transition one deterministic ticket")
    .action(async (
      id: string,
      action: string | undefined,
      value: string | undefined,
      evidence: string | undefined,
      options: { dir: string; json?: boolean; evidence?: string; group?: string; approve?: string },
    ) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { loadTicket } = await import("../engine/tickets.js");
      const {
        markChecklistItem,
        parseTicketAction,
        transitionTicket,
      } = await import("../engine/ticketCommands.js");

      if (action === "group") {
        if (!value) throw new CliError(`Usage: memo-log ticket ${id} group <group-id>`, ExitCode.ConfigError);
        const ticket = loadTicket(loadedConfig.rootDir, id);
        if (!ticket) throw new CliError(`Ticket not found: ${id}`, ExitCode.ConfigError);
        const group = ticket.groups.find((candidate) => candidate.id === value || candidate.id === `G:${value.replace(/^G:/, "")}`);
        if (!group) throw new CliError(`Group not found on ticket ${id}: ${value}`, ExitCode.ConfigError);
        const { listAttributionSpans } = await import("../engine/attribution.js");
        const attributions = await listAttributionSpans(loadedConfig.rootDir, ticket.sessionId !== undefined ? { sessionId: ticket.sessionId } : {});
        const expanded = {
          ticketId: ticket.id,
          group,
          attributions: attributions.filter((span) => group.audit.some((ref) => ref.path === span.path && span.startLine <= ref.endLine && span.endLine >= ref.startLine)),
        };
        if (options.json) process.stdout.write(`${JSON.stringify(expanded)}\n`);
        else {
          console.log(`${group.id} ${group.kind} ${group.risk} — ${group.title}`);
          for (const ref of group.audit) console.log(`  ${ref.path}:${ref.startLine}-${ref.endLine}${ref.symbol ? ` ${ref.symbol}` : ""}`);
          for (const span of expanded.attributions) console.log(`  attribution ${span.path}:${span.startLine}-${span.endLine} ${span.agentId} (${span.confidence})`);
        }
        return;
      }

      const ticketAction = action === "check" || action === "uncheck"
        ? undefined
        : parseTicketAction(action);

      if (action === "check" || action === "uncheck") {
        const bulk = options.approve;
        if (bulk !== undefined && bulk !== "all" && bulk !== "p2_or_lower") {
          throw new CliError("--approve must be all or p2_or_lower.", ExitCode.ConfigError);
        }
        if (value === undefined && options.group === undefined && bulk === undefined) {
          throw new CliError(
            `Usage: memo-log ticket ${id} ${action} <item-id|index>${action === "check" ? " <evidence>" : ""}`,
            ExitCode.ConfigError,
          );
        }
        const result = markChecklistItem({
          rootDir: loadedConfig.rootDir,
          ticketId: id,
          item: value ?? "",
          ...(options.group !== undefined ? { groupId: options.group } : {}),
          ...(bulk !== undefined ? { bulk: bulk as "all" | "p2_or_lower" } : {}),
          status: action === "check" ? "done" : "pending",
          evidence: options.evidence ?? evidence,
        });
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }
        console.log(
          result.changed
            ? `${id}: ${result.item.id} → ${result.item.status}`
            : `${id}: ${result.item.id} already ${result.item.status}`,
        );
        return;
      }

      if (ticketAction === undefined) {
        const ticket = loadTicket(loadedConfig.rootDir, id);
        if (!ticket) {
          throw new CliError(`Ticket not found: ${id}`, ExitCode.ConfigError);
        }
        process.stdout.write(`${JSON.stringify(ticket, null, 2)}\n`);
        return;
      }

      if (ticketAction === "block" && (value === undefined || value.trim().length === 0)) {
        throw new CliError(
          `Blocking requires a reason: memo-log ticket ${id} block "reason"`,
          ExitCode.ConfigError,
        );
      }

      const result = transitionTicket({
        rootDir: loadedConfig.rootDir,
        ticketId: id,
        action: ticketAction,
        ...(ticketAction === "block" && value !== undefined ? { reason: value } : {}),
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      console.log(`${id}: ${result.previousState} → ${result.ticket.state}`);
      if (result.ticket.blockedReason !== undefined) {
        console.log(`Blocked reason: ${result.ticket.blockedReason}`);
      }
    });

  program
    .command("claims")
    .command("verify")
    .argument("<file>", "JSON memo-log.claims/v1 bundle")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output (default)")
    .description("Verify claims against a ticket's deterministic groups")
    .action(async (file: string, options: { dir: string }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const fs = await import("node:fs/promises");
      let bundle: unknown;
      try { bundle = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
      catch (error) { throw new CliError(`Cannot read claims bundle: ${error instanceof Error ? error.message : String(error)}`, ExitCode.ConfigError); }
      const { ClaimBundleSchema } = await import("../engine/claimVerification.js");
      const { TypeScriptChangeEngine } = await import("../engine/changeEngine.js");
      const parsed = ClaimBundleSchema.parse(bundle);
      const { loadTicket } = await import("../engine/tickets.js");
      const ticket = loadTicket(loadedConfig.rootDir, parsed.ticketId);
      if (!ticket) throw new CliError(`Ticket not found: ${parsed.ticketId}`, ExitCode.ConfigError);
      process.stdout.write(`${JSON.stringify(new TypeScriptChangeEngine().verifySummary(parsed, ticket))}\n`);
    });

  program
    .command("compliance")
    .argument("[targetDir]", "Directory to inspect", ".")
    .description("Report documentation coverage across critical paths")
    .option("--json", "Machine-readable output")
    .option("--min-coverage <ratio>", "Fail (exit 5) below this 0..1 ratio")
    .option("-q, --quiet", "Suppress human output")
    .action(async (targetDir: string, options: {
      json?: boolean;
      minCoverage?: string;
      quiet?: boolean;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const { collectStructuralScan } = await import("../engine/scan.js");
      const { evaluateCompliance, renderCompliance } = await import("../engine/docsCheck.js");

      const config = loadedConfig.config;
      const scan = await collectStructuralScan(
        loadedConfig.rootDir,
        {
          timeoutMs: config.timeoutMs,
          maxDepth: config.maxDepth,
          maxFileSizeBytes: config.maxFileSizeBytes,
          excludes: [...config.exclude],
        },
        { filter: config.filter, trackTypes: config.trackTypes },
      );
      const result = evaluateCompliance(scan.extracts, {
        criticalPaths: config.docs.criticalPaths,
        requireDocComments: config.docs.requireDocComments,
      });

      let minimum: number | undefined;
      if (options.minCoverage !== undefined) {
        const parsed = Number(options.minCoverage);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new CliError("--min-coverage must be a number between 0 and 1.", ExitCode.ConfigError);
        }
        minimum = parsed;
      }

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (options.quiet !== true) {
        process.stdout.write(`${renderCompliance(result)}\n`);
      }

      if (minimum !== undefined && result.coverage < minimum) {
        throw new CliError(
          `Documentation coverage ${(result.coverage * 100).toFixed(2)}% is below --min-coverage ${(minimum * 100).toFixed(2)}%.`,
          ExitCode.DocsCheckFailed,
        );
      }
    });

  session
    .command("detect")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .description("Detect local AI tool markers (no network, no log reading)")
    .action(async (options: { dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { detectAiTools } = await import("../engine/sessionDetection.js");
      const { loadCurrentSession } = await import("../engine/sessions.js");
      const tools = detectAiTools(loadedConfig.rootDir);
      const session = loadCurrentSession(loadedConfig.rootDir);
      const payload = {
        kind: "memo-log-session-detect",
        schema: 1,
        tools,
        session,
      };
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        return;
      }
      if (tools.length === 0) {
        console.log("No AI tool markers detected. Manual sessions still work.");
        return;
      }
      console.log(`Detected ${tools.length} AI tool marker(s):`);
      for (const tool of tools) {
        console.log(`- ${tool.name} (${tool.id}): ${tool.evidence.join(", ")}`);
        console.log(`  hooks: ${tool.hookSupport === "documented" ? "documented" : "none"} — ${tool.notes}`);
      }
      if (session) {
        console.log(`Current session: ${session.id} [${session.status}]`);
      }
    });

  session
    .command("auto")
    .argument("[label]", "Optional session label")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .description("Start a session only when an AI tool marker exists")
    .action(async (label: string | undefined, options: { dir: string; json?: boolean }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const { runAutoSession } = await import("../engine/sessionDetection.js");
      const result = runAutoSession({
        rootDir: loadedConfig.rootDir,
        ...(label !== undefined ? { label } : {}),
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (result.reason === "started" && result.session) {
        console.log(`Session started: ${result.session.id} (${result.session.label ?? "auto"})`);
        return;
      }
      if (result.reason === "active-session" && result.session) {
        console.log(`Session already active: ${result.session.id}`);
        return;
      }
      console.log("No AI tool markers detected; no session started. Use `memo-log session start` manually.");
    });

  session
    .command("hooks")
    .argument("[tool]", "claude-code, opencode, cursor, or github-copilot", "claude-code")
    .option("--json", "Machine-readable output")
    .description("Print opt-in hook snippets (never writes files)")
    .action(async (tool: string, options: { json?: boolean }) => {
      const { getHookSnippet } = await import("../engine/sessionDetection.js");
      const snippet = getHookSnippet(tool);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(snippet)}\n`);
        return;
      }
      console.log(`Tool: ${snippet.tool}`);
      console.log(`File: ${snippet.file}`);
      console.log(`Notes: ${snippet.notes}`);
      console.log("");
      console.log(snippet.snippet);
    });

  program
    .command("export")
    .argument("[format]", "github or markdown", "github")
    .argument("[targetDir]", "Directory containing .memo-log/tickets", ".")
    .description("Write one-way ticket exports (no network)")
    .option("--state <state>", "open, needs_review, done, or blocked")
    .option("--category <category>", "Filter by change category")
    .option("--out <path>", "Output directory (github) or file (markdown)")
    .option("--json", "Machine-readable output")
    .option("-q, --quiet", "Suppress human output")
    .action(async (format: string, targetDir: string, options: {
      state?: string;
      category?: string;
      out?: string;
      json?: boolean;
      quiet?: boolean;
    }) => {
      if (format !== "github" && format !== "markdown") {
        throw new CliError("export format must be `github` or `markdown`.", ExitCode.ConfigError);
      }
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const { parseCategoryFilter, parseTicketStateFilter } = await import("./query.js");
      const {
        renderGithubExport,
        writeGithubExport,
        writeMarkdownExport,
      } = await import("../engine/ticketExport.js");

      const exportOptions = {
        rootDir: loadedConfig.rootDir,
        state: parseTicketStateFilter(options.state),
        category: parseCategoryFilter(options.category),
        ...(options.out !== undefined ? { outDir: options.out } : {}),
      };

      if (format === "markdown") {
        const path = writeMarkdownExport(exportOptions);
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ kind: "memo-log-markdown-export", schema: 1, path })}\n`);
        } else if (options.quiet !== true) {
          console.log(`Ticket export: ${path}`);
        }
        return;
      }

      const result = writeGithubExport(exportOptions);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ kind: "memo-log-github-export", schema: 1, ...result })}\n`);
        return;
      }
      if (options.quiet !== true) {
        process.stdout.write(`${renderGithubExport(result)}\n`);
      }
    });

  program
    .command("compact")
    .argument("[targetDir]", "Directory containing .memo-log/tickets", ".")
    .description("Archive low-significance done tickets without deleting them")
    .option(
      "--keep-recent <n>",
      "Always keep the N newest tickets",
      "10",
    )
    .option(
      "--min-significance <level>",
      "low, medium, or high (minimum impact to keep)",
      "medium",
    )
    .option("--dry-run", "Show the archive plan without moving files")
    .option("--json", "Machine-readable output")
    .option("-q, --quiet", "Suppress human output")
    .action(async (targetDir: string, options: {
      keepRecent: string;
      minSignificance: string;
      dryRun?: boolean;
      json?: boolean;
      quiet?: boolean;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir });
      const {
        parseCompactSignificance,
        renderCompact,
        runCompact,
      } = await import("./compact.js");

      const result = runCompact({
        rootDir: loadedConfig.rootDir,
        keepRecent: parseNonNegativeInteger(options.keepRecent, "--keep-recent"),
        minSignificance: parseCompactSignificance(options.minSignificance),
        dryRun: options.dryRun === true,
      });

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (options.quiet !== true) {
        process.stdout.write(`${renderCompact(result)}\n`);
      }
    });

  const card = program
    .command("card")
    .description("Typed memory cards: preference, decision, constraint, convention");

  card
    .command("add")
    .requiredOption("--type <type>", "preference | decision | constraint | convention")
    .requiredOption("--content <text>", "Short statement written by you (max 500 chars)")
    .option("--ref <ref...>", "file:line, commit sha, ticket id, or sha256:<hash> (repeatable)")
    .option("--scope <scope>", "repo | folder | ticket", "repo")
    .option("--target <target>", "Folder path (scope folder) or ticket id (scope ticket)")
    .option("--replaces <id>", "Mark an existing card as replaced by this one")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (options: {
      type: string; content: string; ref?: string[]; scope: string; target?: string;
      replaces?: string; dir: string; json?: boolean;
    }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { addCard } = await import("../engine/cards.js");
      const { CardTypeSchema, CardScopeSchema } = await import("../types/cards.js");
      const type = CardTypeSchema.safeParse(options.type);
      const scope = CardScopeSchema.safeParse(options.scope);
      if (!type.success || !scope.success) {
        throw new CliError(
          "--type must be preference|decision|constraint|convention and --scope repo|folder|ticket.",
          ExitCode.ConfigError,
        );
      }
      const created = addCard({
        rootDir: loaded.rootDir,
        type: type.data,
        content: options.content,
        refs: options.ref ?? [],
        scope: scope.data,
        scopeTarget: options.target,
        replaces: options.replaces,
      });
      process.stdout.write(
        options.json === true ? `${JSON.stringify(created)}\n` : `Added ${created.type} card ${created.id}\n`,
      );
    });

  card
    .command("list")
    .option("--type <type>", "Filter by type")
    .option("--scope <scope>", "Filter by scope")
    .option("--all", "Include replaced cards")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Portable JSON with per-card hashes")
    .action(async (options: { type?: string; scope?: string; all?: boolean; dir: string; json?: boolean }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { listCards, renderCardsMarkdown, toPortableCard } = await import("../engine/cards.js");
      const { CardTypeSchema, CardScopeSchema } = await import("../types/cards.js");
      const type = options.type !== undefined ? CardTypeSchema.safeParse(options.type) : undefined;
      const scope = options.scope !== undefined ? CardScopeSchema.safeParse(options.scope) : undefined;
      if ((type && !type.success) || (scope && !scope.success)) {
        throw new CliError("Invalid --type or --scope.", ExitCode.ConfigError);
      }
      const cards = listCards(loaded.rootDir, {
        ...(type?.success ? { type: type.data } : {}),
        ...(scope?.success ? { scope: scope.data } : {}),
        includeReplaced: options.all === true,
      });
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify({ kind: "memo-log-cards", schema: 1, cards: cards.map(toPortableCard) })}\n`
          : `${renderCardsMarkdown(cards)}\n`,
      );
    });

  card
    .command("show")
    .argument("<id>", "Card id, for example C-0123456789ab")
    .option("-C, --dir <path>", "Project directory", ".")
    .action(async (id: string, options: { dir: string }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { getCard, toPortableCard } = await import("../engine/cards.js");
      const found = getCard(loaded.rootDir, id);
      if (!found) {
        throw new CliError(`Card not found: ${id}`, ExitCode.ConfigError);
      }
      process.stdout.write(`${JSON.stringify({ ...found, hash: toPortableCard(found).hash }, null, 2)}\n`);
    });

  const graph = program
    .command("graph")
    .description("Deterministic structural code-memory graph");

  graph
    .command("build")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--force", "Rebuild from scratch instead of incremental reuse")
    .option("--json", "Machine-readable output")
    .action(async (options: { dir: string; force?: boolean; json?: boolean }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { buildGraph } = await import("../engine/graph.js");
      const built = buildGraph({
        rootDir: loaded.rootDir,
        forceFull: options.force === true,
        write: true,
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(built)}\n`);
        return;
      }
      console.log(
        `Graph built: ${built.nodes.length} node(s), ${built.edges.length} edge(s) — hash ${built.integrityHash}`,
      );
    });

  graph
    .command("verify")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (options: { dir: string; json?: boolean }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { verifyGraph } = await import("../engine/graph.js");
      const result = verifyGraph(loaded.rootDir);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.valid) {
        console.log(
          `OK graph verified: ${result.nodeCount} node(s), ${result.edgeCount} edge(s) — hash ${result.rebuiltHash}`,
        );
      }
      if (!result.valid) {
        throw new CliError(
          `Graph verification failed: persisted=${result.persistedHash ?? "none"} rebuilt=${result.rebuiltHash}`,
          ExitCode.RuntimeError,
        );
      }
    });

  graph
    .command("query")
    .argument("<seed>", "Seed file, symbol, ticket, card, or node id")
    .option("--edge-types <types...>", "Filter by edge type(s)")
    .option("--depth <n>", "Traversal depth (1..3)", "2")
    .option("--limit <n>", "Max ranked nodes", "25")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (
      seed: string,
      options: { edgeTypes?: string[]; depth: string; limit: string; dir: string; json?: boolean },
    ) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { queryGraph } = await import("../engine/graph.js");
      const { GraphEdgeTypeSchema } = await import("../types/graph.js");
      const edgeTypes = options.edgeTypes?.map((raw) => {
        const parsed = GraphEdgeTypeSchema.safeParse(raw);
        if (!parsed.success) {
          throw new CliError(`Invalid edge type: ${raw}`, ExitCode.ConfigError);
        }
        return parsed.data;
      });
      const res = queryGraph({
        rootDir: loaded.rootDir,
        seed,
        ...(edgeTypes !== undefined ? { edgeTypes } : {}),
        depth: parsePositiveInteger(options.depth, "--depth"),
        limit: parsePositiveInteger(options.limit, "--limit"),
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(res)}\n`);
        return;
      }
      const lines = [
        `# Graph query: ${res.seed.label} (depth ${res.depth}, hash ${res.integrityHash.slice(0, 12)})`,
        "",
        ...res.nodes.map(
          (r) =>
            `- [${r.node.kind}] \`${r.node.key}\` ${r.node.ref} — score ${r.score.toFixed(4)} (hop=${r.breakdown.hop.toFixed(2)}, edge=${r.breakdown.edgeWeight.toFixed(2)}, rec=${r.breakdown.recency.toFixed(2)}, deg=${r.breakdown.degree.toFixed(2)})`,
        ),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  graph
    .command("path")
    .argument("<from>", "Source node or reference")
    .argument("<to>", "Target node or reference")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (from: string, to: string, options: { dir: string; json?: boolean }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { findGraphPath } = await import("../engine/graph.js");
      const res = findGraphPath({ rootDir: loaded.rootDir, from, to });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(res)}\n`);
        return;
      }
      if (!res.found) {
        console.log(`No path found between ${from} and ${to}.`);
        return;
      }
      console.log(
        `Path (${res.hops} hop(s)): ${res.nodes.map((n) => `${n.kind}:${n.key}`).join(" -> ")}`,
      );
    });

  graph
    .command("pack")
    .argument("<seed>", "Seed file, symbol, ticket, or card")
    .option("--budget <tokens>", "Token budget", "1200")
    .option("--depth <n>", "Traversal depth (1..3)", "2")
    .option("--no-reorder", "Disable LongContextReorder")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--json", "Machine-readable output")
    .action(async (
      seed: string,
      options: { budget: string; depth: string; reorder?: boolean; dir: string; json?: boolean },
    ) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { buildGraphContextPack } = await import("../engine/graph.js");
      const res = buildGraphContextPack({
        rootDir: loaded.rootDir,
        seed,
        budget: parsePositiveInteger(options.budget, "--budget"),
        depth: parsePositiveInteger(options.depth, "--depth"),
        reorder: options.reorder !== false,
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(res)}\n`);
        return;
      }
      console.log(
        `Context pack for ${res.seed.key}: ${res.items.length} item(s), ${res.cards.length} card(s), ${res.usedTokens}/${res.budgetTokens} tokens (${res.droppedCount} cut)`,
      );
    });

  graph
    .command("mermaid")
    .argument("<seed>", "Seed file, symbol, ticket, or card")
    .option("--depth <n>", "1 or 2 hops", "1")
    .option("-C, --dir <path>", "Project directory", ".")
    .action(async (seed: string, options: { depth: string; dir: string }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { renderGraphMermaid } = await import("../engine/graph.js");
      const res = renderGraphMermaid({
        rootDir: loaded.rootDir,
        seed,
        depth: parsePositiveInteger(options.depth, "--depth"),
      });
      process.stdout.write(`${res.mermaid}\n`);
    });

  program
    .command("serve")
    .description("Local write coordinator for ticket changes (loopback or Unix socket only)")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--host <host>", "Loopback host when not using a socket", "127.0.0.1")
    .option("--port <n>", "TCP port (default: random loopback port)")
    .option("--socket <path>", "Unix socket path (preferred; no TCP)")
    .action(async (options: { dir: string; host: string; port?: string; socket?: string }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { startServe } = await import("../engine/serve.js");
      const handle = await startServe({
        rootDir: loaded.rootDir,
        host: options.host,
        ...(options.port !== undefined ? { port: parseNonNegativeInteger(options.port, "--port") } : {}),
        ...(options.socket !== undefined ? { socketPath: options.socket } : {}),
      });
      console.log(`memo-log serve listening on ${handle.address}`);
      console.log("Ticket transitions and checklist updates can be sent as JSON lines. Ctrl+C to stop.");
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void handle.close().then(() => resolve());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  program
    .command("review")
    .description("Open the local review page (inbox, board, context, cards, graph) in your IDE browser")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("-p, --port <port>", "Port to bind on 127.0.0.1 (default: random)")
    .addOption(new Option("--view <view>", "Initial review view").choices(["inbox", "board", "context", "graph"]).default("inbox"))
    .option("--allow-writes", "Enable approve, bounce, and check actions")
    .option("--open", "Open the system browser")
    .option("--no-open", "Do not open a browser")
    .option("--idle-minutes <n>", "Stop after n idle minutes", "30")
    .action(async (options: {
      dir: string;
      port?: string;
      view: "inbox" | "board" | "context" | "graph";
      allowWrites?: boolean;
      open?: boolean;
      idleMinutes: string;
    }) => {
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      const { runReview } = await import("./review.js");
      await runReview({
        rootDir: loaded.rootDir,
        ...(options.port !== undefined ? { port: parseNonNegativeInteger(options.port, "--port") } : {}),
        view: options.view,
        allowWrites: options.allowWrites === true,
        ...(options.open !== undefined ? { open: options.open } : {}),
        idleMinutes: parsePositiveInteger(options.idleMinutes, "--idle-minutes"),
      });
    });

  program
    .command("menu")
    .description("Open the keyboard menu for sessions, queries, and exports")
    .option("-C, --dir <path>", "Project directory", ".")
    .action(async (options: { dir: string }) => {
      if (process.stdin.isTTY !== true) {
        throw new CliError(
          "memo-log menu needs an interactive terminal. Use --json commands for scripts.",
          ExitCode.ConfigError,
        );
      }
      const loaded = await loadEffectiveConfig({ targetDir: options.dir });
      await runInteractiveMenu({
        rootDir: loaded.rootDir,
        input: process.stdin,
        output: process.stdout,
      });
    });

  program
    .command("mcp")
    .description("Run the MCP server (stdio by default; opt-in Streamable HTTP)")
    .option("-C, --dir <path>", "Project directory", ".")
    .option("--allow-writes", "Expose mark_checklist_item (explicit human action only)")
    .addOption(
      new Option("--transport <kind>", "MCP transport")
        .choices(["stdio", "http"])
        .default("stdio"),
    )
    .option("--host <host>", "HTTP bind host (loopback by default)", "127.0.0.1")
    .option("--port <n>", "HTTP port", "7331")
    .option(
      "--token <token>",
      "Bearer token (required for non-loopback HTTP; or MEMOLOG_MCP_TOKEN)",
    )
    .option(
      "--allow-origin <origins>",
      "Comma-separated extra Origin values allowed by HTTP",
    )
    .action(async (options: {
      dir: string;
      allowWrites?: boolean;
      transport: "stdio" | "http";
      host: string;
      port: string;
      token?: string;
      allowOrigin?: string;
    }) => {
      const loadedConfig = await loadEffectiveConfig({ targetDir: options.dir });
      const engine = resolveAnalysisEngine({
        mode: loadedConfig.config.rustCore,
        cwd: loadedConfig.rootDir,
      });

      if (options.transport === "stdio") {
        const { runMcpServer } = await import("../mcp/server.js");
        await runMcpServer({
          rootDir: loadedConfig.rootDir,
          input: process.stdin,
          output: process.stdout,
          allowWrites: options.allowWrites === true,
          engine,
        });
        return;
      }

      const { startMcpHttpServer } = await import("../mcp/http.js");
      const token = options.token ?? process.env["MEMOLOG_MCP_TOKEN"];
      const allowedOrigins = (options.allowOrigin ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

      const handle = await startMcpHttpServer({
        rootDir: loadedConfig.rootDir,
        host: options.host,
        port: parsePositiveInteger(options.port, "--port"),
        allowWrites: options.allowWrites === true,
        engine,
        ...(token !== undefined && token.length > 0 ? { token } : {}),
        ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      });

      // Protocol traffic never touches stdout in HTTP mode, so a single
      // readiness line on stderr is safe and useful for operators.
      console.error(`MCP Streamable HTTP listening on ${handle.url}`);
      if (token === undefined || token.length === 0) {
        console.error("Auth: none (loopback only).");
      } else {
        console.error("Auth: bearer token required.");
      }

      const shutdown = async (): Promise<void> => {
        try {
          await handle.close();
        } finally {
          process.exit(0);
        }
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise<void>(() => {});
    });

  return program;
};

async function runRuntimeInference(
  targetDir: string,
  entries: ReadonlyArray<{ ref?: unknown }>,
): Promise<void> {
  const { inferBatch, renderInferenceMarkdown } = await import("../engine/runtimeInference.js");
  const { parseFile } = await import("../parsers/index.js");
  const { assertPathWithinRoot, normalizeRelativePath, resolveSecureRoot } = await import("../security/pathGuards.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");

  const absoluteTarget = path.resolve(targetDir);
  const secureRoot = await resolveSecureRoot(absoluteTarget);
  const filePaths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.ref !== "string") continue;
    const m = entry.ref.match(/^\[(.+?):\d+/);
    if (!m?.[1]) continue;
    let rel = "";
    try {
      rel = normalizeRelativePath(m[1]);
      if (!rel || rel.includes("..")) continue;
    } catch {
      continue;
    }
    const fp = path.resolve(secureRoot, rel);
    try {
      assertPathWithinRoot(secureRoot, fp);
    } catch {
      continue;
    }
    if (!seen.has(fp)) {
      seen.add(fp);
      filePaths.push(fp);
    }
  }

  const maxInferenceFiles = 50;
  if (filePaths.length > maxInferenceFiles) {
    console.warn(`WARN: INFERENCE_FILE_CAP_APPLIED — omitted ${filePaths.length - maxInferenceFiles} file(s) beyond first ${maxInferenceFiles}.`);
  }

  const pairs: Array<{ parsed: ParsedFile; content: string }> = [];
  for (const fp of filePaths.slice(0, maxInferenceFiles)) {
    try {
      const rel = path.relative(secureRoot, fp);
      const content = await fs.readFile(fp, "utf8");
      const sizeBuf = Buffer.byteLength(content, "utf8");
      const parsed = await parseFile(rel, content, sizeBuf);
      pairs.push({ parsed, content });
    } catch { /* skip unreadable files */ }
  }

  const results = inferBatch(pairs, { timeoutMs: 2000 });
  const md = renderInferenceMarkdown(results);
  const outPath = path.join(secureRoot, "MEMO_LOG_INFERENCE.md");
  const tmpPath = `${outPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, md, "utf8");
    await fs.rename(tmpPath, outPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
  console.log(`Runtime inference written to: ${outPath}`);
}

async function runAgentConflictDetection(
  targetDir: string,
  quiet: boolean,
): Promise<ConflictReport | null> {
  const path = await import("node:path");
  const { runAgentUiWorkflow } = await import("../engine/agentUi.js");

  const absoluteTarget = path.resolve(targetDir);
  const result = await runAgentUiWorkflow(absoluteTarget);

  if (!quiet) {
    for (const warning of result.warnings) {
      console.warn(warning);
    }
    if (!result.previousSnapshotFound) {
      console.log("Agent UI baseline snapshot created. Re-run with --agent-ui after the next scan to detect conflicts.");
      return result.report;
    }
    console.log(`Conflict report written to: ${result.reportPath}`);
    if (result.report === null) {
      console.warn("⚠ Conflict comparison skipped. See warnings above and MEMO_LOG_CONFLICTS.md");
    } else if (result.report.totalConflicts > 0) {
      console.warn(`⚠ ${result.report.totalConflicts} conflict(s) detected. Review MEMO_LOG_CONFLICTS.md`);
    } else {
      console.log("No conflicts detected.");
    }
  }

  return result.report;
}

export interface CliIo {
  input?: MenuInput | undefined;
  output?: NodeJS.WritableStream | undefined;
}

// Entry point for running the CLI
export const runCli = async (argv?: string[], io?: CliIo): Promise<number> => {
  const args = argv ?? process.argv.slice(2);
  if (args.length === 0) {
    const input = io?.input ?? process.stdin;
    const output = io?.output ?? process.stdout;
    if (input.isTTY === true) {
      return runInteractiveMenu({
        rootDir: process.cwd(),
        input,
        ...(io?.output !== undefined ? { output: io.output } : {}),
      });
    }
    output.write(`${renderCompactHelp()}\n`);
    return 0;
  }

  const program = buildProgram();

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error: unknown) {
    const exitCode = toExitCode(error);
    if (exitCode !== 0) {
      printErrorIfNeeded(error);
    }
    return exitCode;
  }
};
