// Ranked query and ticket browsing surfaces.
//
// Payload construction lives in the engine so MCP and the CLI share one
// implementation. This module keeps CLI parsing and human-readable rendering.
import { z } from "zod";

import { CliError, ExitCode } from "../engine/errors.js";
import {
  buildQueryPayload,
  filterTickets,
  loadExtractsFromCache,
  loadTicketList,
  parseFileFilter,
  QueryPayloadSchema,
  QuerySourcesSchema,
  type QueryCommandOptions,
  type QueryPayload,
  type TicketsCommandOptions,
} from "../engine/contextQuery.js";
import { CategorySchema, type Category } from "../types/categories.js";
import {
  TicketSchema,
  TicketStateSchema,
  type Ticket,
  type TicketState,
} from "../types/ticket.js";
import { renderBoardColumns } from "./ticketBrowser.js";

export {
  buildQueryPayload,
  filterTickets,
  loadExtractsFromCache,
  loadTicketList,
  parseFileFilter,
  QueryPayloadSchema,
  QuerySourcesSchema,
};
export type { QueryCommandOptions, QueryPayload, TicketsCommandOptions };

const AudienceSchema = z.enum(["tech", "simple"]);

export function parseAudienceFilter(value: string): "tech" | "simple" {
  const parsed = AudienceSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("--audience must be `tech` or `simple`.", ExitCode.ConfigError);
  }
  return parsed.data;
}

export function parseCategoryFilter(value: string | undefined): Category | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = CategorySchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `--category must be one of: ${CategorySchema.options.join(", ")}.`,
      ExitCode.ConfigError,
    );
  }
  return parsed.data;
}

export function parseTicketStateFilter(value: string | undefined): TicketState | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = TicketStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `--state must be one of: ${TicketStateSchema.options.join(", ")}.`,
      ExitCode.ConfigError,
    );
  }
  return parsed.data;
}

export function renderQuery(payload: QueryPayload): string {
  if (payload.entries.length === 0) {
    return "No reference-anchored entries matched the query.";
  }

  const lines: string[] = [
    `# Query results (${payload.entries.length}/${payload.totalCandidates})`,
  ];
  if (payload.sources.structural) {
    const sources = payload.sources;
    lines.push(
      `Structural sources — changed: ${sources.changed}, same category: ${sources.sameCategory}, dependents: ${sources.dependents}, dependencies: ${sources.dependencies}${
        sources.target !== undefined ? `, target: \`${sources.target}\`` : ""
      }`,
    );
  }
  lines.push("");
  if (payload.cards !== undefined && payload.cards.length > 0) {
    lines.push("## Cards", "");
    for (const card of payload.cards) {
      lines.push(`- **${card.type}** (${card.scope}) ${card.content} ${card.refs.join(" ")} _(hash ${card.hash.slice(0, 12)})_`);
    }
    lines.push("", "## Entries", "");
  }
  for (const entry of payload.entries) {
    const text = entry.tech ?? entry.simple ?? "";
    lines.push(
      `- ${text} ${entry.ref} _(category: ${entry.category}, kind: ${entry.kind}, score: ${entry.score.toFixed(4)})_`,
    );
  }
  return lines.join("\n");
}

export function renderTickets(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) {
    return "No tickets found.";
  }

  const lines: string[] = ["# Tickets", ""];
  for (const ticket of tickets) {
    lines.push(
      `- \`${ticket.id}\` [${ticket.state}] ${ticket.title} — ${ticket.changes.length} change(s), ${ticket.checklist.length} checklist item(s)`,
    );
  }
  return lines.join("\n");
}

export function renderTicket(ticket: Ticket): string {
  return JSON.stringify(TicketSchema.parse(ticket), null, 2);
}

export function renderTicketsBoard(tickets: readonly Ticket[]): string {
  const lines: string[] = ["# Ticket board", "", ...renderBoardColumns(tickets)];
  return lines.join("\n").trimEnd();
}
