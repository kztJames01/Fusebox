// Server-rendered HTML for the local review page (F-10 / F-11 / G-4).
//
// Every dynamic value is escaped. Links are absolute paths under the token
// base, and no page references an external origin. Views are pure functions of
// the loaded tickets, cards, context, and graph.
import { DEFAULT_EXPORT_CONTEXT_MAX_TOKENS, estimateTokens } from "../cli/exportContext.js";
import { cardHash, cardsForScope } from "../engine/cards.js";
import { buildQueryPayload, loadExtractsFromCache } from "../engine/contextQuery.js";
import { detectBreakingChanges, loadState } from "../engine/diff.js";
import { buildGraph, renderGraphMermaid } from "../engine/graph.js";
import {
  EMPTY_REVIEW_FILTERS,
  REVIEW_QUEUE_ORDER,
  REVIEW_STATE_LABEL,
  REVIEW_STATE_ORDER,
  filterReviewTickets,
  reviewCategoriesOf,
  reviewCommitCount,
  reviewPriorityOf,
  reviewPrimaryRef,
  sortReviewTickets,
  type ReviewFilters,
  type ReviewPriority,
} from "../engine/reviewModel.js";
import { checklistProgress, readActivity } from "../engine/ticketCommands.js";
import type { AttributionSpan } from "../engine/attribution.js";
import type { Card } from "../types/cards.js";
import type { Ticket, TicketState } from "../types/ticket.js";

export interface PageContext {
  rootDir: string;
  /** `/t/<token>/` */
  base: string;
  allowWrites: boolean;
  tickets: readonly Ticket[];
  cards: readonly Card[];
  attributions?: readonly AttributionSpan[] | undefined;
  projectName: string;
  /** Path of the scan snapshot used by the Context page. */
  jsonPath: string;
  flash?: { text: string; error: boolean } | undefined;
  active: "inbox" | "context" | "board" | "cards" | "graph" | "ticket";
}

export type TicketFilters = ReviewFilters;
export type Priority = ReviewPriority;

export const EMPTY_TICKET_FILTERS = EMPTY_REVIEW_FILTERS;
export const STATE_LABEL = REVIEW_STATE_LABEL;
export const STATE_ORDER = REVIEW_STATE_ORDER;
export const priorityOf = reviewPriorityOf;
export const sortTickets = sortReviewTickets;
export const filterTickets = filterReviewTickets;
const categoriesOf = reviewCategoriesOf;

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const QUEUE_ORDER = REVIEW_QUEUE_ORDER;
const QUEUE_HEADING: Record<TicketState, string> = {
  open: "Open",
  needs_review: "Needs review",
  blocked: "Blocked — needs you",
  done: "Done",
  superseded: "Superseded",
};

function day(iso: string): string {
  return iso.slice(0, 10);
}

function stripBrackets(ref: string): string {
  return ref.replace(/^\[|\]$/g, "");
}

function shortRef(ref: string): string {
  const clean = stripBrackets(ref);
  const slash = clean.lastIndexOf("/");
  return slash >= 0 && !clean.startsWith("test:") && !clean.startsWith("log:")
    ? clean.slice(slash + 1)
    : clean;
}

const primaryRef = reviewPrimaryRef;
const commitCount = reviewCommitCount;

function bar(done: number, total: number, label: string, wide = false): string {
  return `<progress class="bar${wide ? " wide" : ""}" value="${done}" max="${Math.max(total, 1)}" aria-label="${done} of ${total} ${esc(label)} verified">${done}/${total}</progress>`;
}

function formOpen(ctx: PageContext, ticketId: string, action: string): string {
  return `<form method="post" action="${esc(ctx.base)}ticket/${esc(ticketId)}/${action}">`;
}

function approveForms(ctx: PageContext, ticket: Ticket): string {
  if (!ctx.allowWrites) {
    return `<div class="acts"><span class="tag" title="Restart memo-log review with --allow-writes to approve, bounce, or verify items">READ-ONLY · RESTART WITH --ALLOW-WRITES</span><span class="kb-hint">A / B</span></div>`;
  }
  const approveTitle = ticket.state === "open"
    ? "Accept ticket into review (A)"
    : "Approve and mark ticket done (A)";
  const approve = ticket.state === "open" || ticket.state === "needs_review"
    ? `${formOpen(ctx, ticket.id, "approve")}<button class="primary" data-key="a" type="submit" title="${approveTitle}">${ticket.state === "open" ? "Accept for review" : "Approve"}</button></form>`
    : "";
  const bounce = ticket.state === "open" || ticket.state === "needs_review"
    ? `<details class="bounce-pop"><summary class="btn">Bounce back</summary>${formOpen(ctx, ticket.id, "bounce")}<label class="sr-only" for="reason-${esc(ticket.id)}">Bounce reason</label><input type="text" id="reason-${esc(ticket.id)}" name="reason" data-key="b" placeholder="Reason required…" maxlength="500" required><button class="danger sm" type="submit">Confirm bounce</button></form></details>`
    : "";
  const reopen = ticket.state === "blocked" || ticket.state === "done"
    ? `${formOpen(ctx, ticket.id, "reopen")}<button type="submit">Reopen</button></form>`
    : "";
  return `<div class="acts">${approve}${bounce}${reopen}<span class="kb-hint">A / B</span></div>`;
}

const NAV: ReadonlyArray<{ id: PageContext["active"]; path: string; label: string }> = [
  { id: "inbox", path: "inbox", label: "Inbox" },
  { id: "board", path: "board", label: "Board" },
  { id: "context", path: "context", label: "Context" },
  { id: "cards", path: "cards", label: "Cards" },
  { id: "graph", path: "graph", label: "Graph" },
];

function pageHeading(kicker: string, title: string, description: string, aside = ""): string {
  return `<header class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1 class="page-title">${esc(title)}</h1><p class="sub">${description}</p></div>${aside}</header>`;
}

export function layout(ctx: PageContext, crumb: string, body: string, search = ""): string {
  const inboxCount = ctx.tickets.filter(
    (ticket) => ticket.state === "open" || ticket.state === "needs_review",
  ).length;
  const nav = NAV.map((item, index) => {
    const current = ctx.active === item.id || (ctx.active === "ticket" && item.id === "inbox");
    const count = item.id === "inbox" ? `<span class="nav-count">${String(inboxCount).padStart(2, "0")}</span>` : "";
    return `<a href="${esc(ctx.base)}${item.path}"${current ? ' aria-current="page"' : ""}><span class="nav-index">0${index + 1}</span><span>${item.label}</span>${count}</a>`;
  }).join("");
  const need = `<span class="need${inboxCount === 0 ? " clear" : ""}">${String(inboxCount).padStart(2, "0")} ${inboxCount === 0 ? "ALL CLEAR" : "NEEDS REVIEW"}</span>`;
  const flash = ctx.flash
    ? `<div class="flash${ctx.flash.error ? " err" : ""}" role="${ctx.flash.error ? "alert" : "status"}">${esc(ctx.flash.text)}</div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0a0c0a"><title>memo-log review · ${esc(ctx.projectName)}</title>
<link rel="stylesheet" href="${esc(ctx.base)}app.css"></head>
<body data-base="${esc(ctx.base)}"><a class="skip" href="#main">Skip to content</a>
<header class="brandbar"><a class="brand" href="${esc(ctx.base)}inbox" aria-label="memo-log review inbox"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>memo-log</span></a><span class="brand-tag">FIELD MANUAL / LOCAL REVIEW</span><div class="brand-right"><span class="local-ready"><i aria-hidden="true"></i>LOCAL / READY</span><span class="mode ${ctx.allowWrites ? "rw" : "ro"}">${ctx.allowWrites ? "WRITES ENABLED" : "READ-ONLY"}</span><button class="help-button" type="button" data-help aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button></div></header>
<div class="app-body"><details class="sidebar" open><summary><span>${esc(ctx.projectName)}</span><span>${esc(crumb)}</span></summary><div class="sidebar-body"><div class="project"><span>PROJECT / LOCAL</span><strong>${esc(ctx.projectName)}</strong></div><form class="global-search" method="get" action="${esc(ctx.base)}board" role="search"><label for="ticket-search">Search tickets</label><div><input id="ticket-search" type="search" name="q" value="${esc(search)}" placeholder="ID, title, path…" maxlength="200"><kbd aria-hidden="true">⌘K</kbd></div></form><nav class="side-nav" aria-label="Views">${nav}</nav><div class="local-card"><div><span>REVIEW BIND</span><strong>127.0.0.1</strong></div><div><span>IDLE TIMEOUT</span><strong>Enabled</strong></div><div><span>NETWORK</span><strong>0 outbound calls</strong></div></div></div></details><div class="main-column"><div class="viewbar"><span class="breadcrumb">${esc(ctx.projectName)} <i>/</i> ${esc(crumb)}</span>${need}</div><main class="content" id="main">${flash}${body}</main></div></div>
<dialog id="help" aria-labelledby="help-title"><div class="dialog-head"><div><p class="eyebrow">LOCAL REVIEW / INPUT</p><h2 id="help-title">Keyboard</h2></div><button type="button" class="btn sm" data-help-close>Close</button></div><div class="shortcut-grid"><p><span><kbd>j</kbd> <kbd>k</kbd></span><span>Move</span></p><p><kbd>enter</kbd><span>Open ticket</span></p><p><kbd>a</kbd><span>Approve / accept</span></p><p><kbd>b</kbd><span>Bounce with reason</span></p><p><kbd>x</kbd><span>Verify selected item</span></p><p><kbd>⌘/Ctrl K</kbd><span>Search tickets</span></p><p><kbd>/</kbd><span>Focus current search</span></p><p><kbd>g</kbd><span>Then i / b / x / c / g for views</span></p><p><kbd>?</kbd><span>Toggle this help</span></p><p><kbd>esc</kbd><span>Close dialog or field</span></p></div></dialog><div id="ui-status" class="sr-only" role="status" aria-live="polite"></div>
<script src="${esc(ctx.base)}app.js"></script>${ctx.active === "graph" ? `<script src="${esc(ctx.base)}mermaid.js"></script>` : ""}</body></html>`;
}

const KEYS_BAR = `<div class="keys"><span><kbd>j</kbd> <kbd>k</kbd> navigate</span><span><kbd>enter</kbd> open</span><span><kbd>a</kbd> approve</span><span><kbd>b</kbd> bounce</span><span><kbd>x</kbd> verify</span><span><kbd>/</kbd> search</span><span><kbd>?</kbd> help</span></div>`;

function activityLines(rootDir: string, ticketId?: string): readonly string[] {
  const lines = readActivity(rootDir);
  const matched = ticketId === undefined ? lines : lines.filter((line) => line.split("\t")[3] === ticketId);
  return matched.slice(-12).reverse();
}

function renderActivityLines(lines: readonly string[], base: string): string {
  if (lines.length === 0) return `<div class="empty">No activity recorded yet.</div>`;
  return `<div class="activity-list">${lines.map((line) => {
    const [at, actor, action, ticketId, item] = line.split("\t");
    const label = item !== undefined && item.length > 0 ? `${action} ${item}` : action;
    const inner = `<span class="activity-marker" aria-hidden="true"></span><div><span class="key">${esc(ticketId ?? "")}</span><p><strong>${esc(actor ?? "unknown")}</strong> · ${esc(label ?? "")}</p></div><small>${esc(day(at ?? ""))}</small>`;
    return ticketId !== undefined && ticketId.startsWith("T-")
      ? `<a class="activity-item" href="${esc(base)}ticket/${esc(ticketId)}">${inner}</a>`
      : `<div class="activity-item">${inner}</div>`;
  }).join("")}</div>`;
}

function activityRail(ctx: PageContext, ticketId?: string): string {
  const lines = activityLines(ctx.rootDir, ticketId);
  return `<aside class="activity-rail" aria-label="${ticketId === undefined ? "Recent project activity" : "Recent ticket activity"}"><header><span>${ticketId === undefined ? "RECENT ACTIVITY" : "TICKET ACTIVITY"}</span><span class="tag">${lines.length}</span></header>${renderActivityLines(lines, ctx.base)}</aside>`;
}

function railTickets(ctx: PageContext, selected?: Ticket): Ticket[] {
  const sorted = sortTickets(ctx.tickets);
  const inReview = sorted.filter((ticket) => ticket.state === "needs_review");
  const open = sorted.filter((ticket) => ticket.state === "open");
  const blocked = sorted.filter((ticket) => ticket.state === "blocked");
  const rail = [...inReview, ...open, ...blocked];
  if (selected !== undefined && !rail.some((ticket) => ticket.id === selected.id)) rail.push(selected);
  return rail;
}

function railStatusLine(ticket: Ticket): string {
  const progress = checklistProgress(ticket);
  if (ticket.state === "needs_review") return `<span class="rail-meta s-needs_review"><i class="dot s"></i>IN REVIEW · ${progress.done}/${progress.total}</span>`;
  if (ticket.state === "open") return `<span class="rail-meta s-open">OPEN · ${progress.done}/${progress.total}</span>`;
  if (ticket.state === "blocked") return `<span class="rail-meta s-blocked"><i class="dot s"></i>BLOCKED · NEEDS YOU</span>`;
  return `<span class="rail-meta s-done"><i class="dot s"></i>DONE · ${progress.done}/${progress.total}</span>`;
}

function railItem(ctx: PageContext, ticket: Ticket, selected: boolean): string {
  const href = `${ctx.base}ticket/${ticket.id}`;
  const priority = priorityOf(ticket);
  const unit = ticket.groups.length > 0 ? "groups" : "Repo-check items";
  return `<a class="rail-item s-${ticket.state}${selected ? " sel" : ""}" data-row data-href="${esc(href)}" href="${esc(href)}"${selected ? ' aria-current="true"' : ""}><span class="queue-top"><span class="key">${esc(ticket.id)}</span><span class="pri p-${priority}">${priority}</span></span><strong>${esc(ticket.title)}</strong>${ticket.state === "blocked" ? `<span class="queue-reason">${esc(ticket.blockedReason ?? "Reason required")}</span>` : ""}<span class="queue-bottom">${railStatusLine(ticket)}<span class="commit-count">${commitCount(ticket)} commits</span></span><span class="queue-ref"><span>${esc(shortRef(primaryRef(ticket)))}</span>${bar(checklistProgress(ticket).done, checklistProgress(ticket).total, unit)}</span></a>`;
}

function queueGroup(ctx: PageContext, state: TicketState, tickets: readonly Ticket[], selected?: Ticket): string {
  const rows = tickets.filter((ticket) => ticket.state === state);
  if (rows.length === 0) return "";
  return `<section class="queue-group" aria-labelledby="queue-${state}"><h2 id="queue-${state}"><span>${esc(QUEUE_HEADING[state])}</span><span>${rows.length}</span></h2>${rows.map((ticket) => railItem(ctx, ticket, ticket.id === selected?.id)).join("")}</section>`;
}

function attachedContext(ctx: PageContext, ticket: Ticket): string {
  const commits = ticket.artifacts.filter((artifact) => artifact.kind === "commit" && artifact.sha !== undefined);
  const firstPath = ticket.changes[0]?.path;
  const files = ticket.changes.map((change) => `<tr><td class="key">${esc(change.changeType)}</td><td class="mono">${esc(change.path)}</td><td>${esc(change.category)}</td><td class="mono">${change.exportsAdded.length > 0 ? `+${esc(change.exportsAdded.join(", "))}` : ""} ${change.exportsRemoved.length > 0 ? `−${esc(change.exportsRemoved.join(", "))}` : ""}</td></tr>`).join("");
  const scopedCards = cardsForScope(
    ctx.rootDir,
    { ...(firstPath !== undefined ? { file: firstPath } : {}), ticketId: ticket.id },
    5,
  ).filter((card) => card.replacedBy === undefined);
  const cards = scopedCards.map((card) => `<div class="ctx-row"><span class="chip">${esc(card.type)}</span><span>${esc(card.content)}</span><span class="ref">${esc(card.refs[0] ?? "")}</span></div>`).join("");
  const history = [...ticket.stateHistory].reverse().map((event) => `<div class="history-row"><span>${esc(event.actor)} → ${esc(STATE_LABEL[event.state])}</span><small>${esc(day(event.at))}</small></div>`).join("");
  return `<section class="attached" aria-label="Attached context"><div class="section-label">ATTACHED CONTEXT</div><details><summary><span>Files changed</span><span class="faint">${ticket.changes.length}</span></summary><div class="table-wrap"><table><tbody>${files || `<tr><td>No file changes.</td></tr>`}</tbody></table></div></details><details><summary><span>Development / commits</span><span class="faint">${commits.length}</span></summary>${commits.length > 0 ? commits.map((artifact) => `<div class="commit-row"><span class="ref">${esc(String(artifact.sha).slice(0, 7))}</span><span>Linked commit</span></div>`).join("") : `<div class="empty">No commits linked.</div>`}</details><details><summary><span>Cards in scope</span><span class="faint">${scopedCards.length}</span></summary>${cards || `<div class="empty">No cards apply to this ticket.</div>`}</details><details><summary><span>Activity &amp; state history</span><span class="faint">${ticket.stateHistory.length}</span></summary>${renderActivityLines(activityLines(ctx.rootDir, ticket.id), ctx.base)}<div class="history-list">${history || `<div class="empty">No state changes.</div>`}</div></details></section>`;
}

function checklistRow(ctx: PageContext, ticket: Ticket, index: number): string {
  const item = ticket.checklist[index]!;
  const done = item.status === "done";
  const displayRef = shortRef(item.evidence ?? item.ref);
  let right = "";
  if (done) {
    const uncheck = ctx.allowWrites
      ? `<form method="post" action="${esc(ctx.base)}ticket/${esc(ticket.id)}/uncheck" class="inline-form"><input type="hidden" name="item" value="${esc(item.id)}"><button class="ghost" data-key="x" type="submit" title="Uncheck ${esc(item.id)}">Undo</button></form>`
      : "";
    right = `<span class="ev-ref mono" title="Verified evidence: ${esc(item.evidence ?? item.ref)}">${esc(displayRef)}</span>${uncheck}`;
  } else if (ctx.allowWrites) {
    right = `<details class="ev-pop"><summary class="add-ref">ADD REF</summary><form method="post" action="${esc(ctx.base)}ticket/${esc(ticket.id)}/check" class="ev-form"><input type="hidden" name="item" value="${esc(item.id)}"><label class="sr-only" for="evidence-${esc(item.id)}">Evidence for ${esc(item.text)}</label><input id="evidence-${esc(item.id)}" type="text" name="evidence" data-key="x" value="${esc(item.ref)}" placeholder="[file:line] · sha · test:name · log:hash" maxlength="200" required class="ev-input"><button class="primary sm" type="submit">Verify</button></form></details>`;
  } else {
    right = `<span class="add-ref">EVIDENCE REQUIRED</span>`;
  }
  return `<div class="crit${done ? " done" : ""}" tabindex="0" data-row><span class="box" aria-hidden="true">${done ? "✓" : ""}</span><span class="sr-only">${done ? "Verified" : "Pending"}: </span><span class="txt">${esc(item.text)}</span><span class="crit-r">${right}</span></div>`;
}

function detailPane(ctx: PageContext, ticket: Ticket): string {
  const progress = checklistProgress(ticket);
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const grouped = ticket.groups.length > 0;
  const verificationLabel = grouped ? "GROUPS VERIFIED" : "REPO-CHECK";
  const verificationUnit = grouped ? "groups" : "Repo-check items";
  const categories = categoriesOf(ticket);
  const priority = priorityOf(ticket);
  const session = ticket.label ?? ticket.sessionId ?? "No session";
  const ticketAttributions = ticket.sessionId === undefined
    ? []
    : (ctx.attributions ?? []).filter((span) => span.sessionId === ticket.sessionId);
  const groupDetails = ticket.groups.map((group) => {
    const refs = group.audit.map((ref) => `<li><code>${esc(ref.path)}:${ref.startLine}-${ref.endLine}</code>${ref.symbol ? ` · ${esc(ref.symbol)}` : ""}</li>`).join("");
    const spans = ticketAttributions.filter((span) => group.audit.some((ref) => ref.path === span.path && span.startLine <= ref.endLine && span.endLine >= ref.startLine));
    const attributionRows = spans.length > 0
      ? spans.map((span) => `<li><code>${esc(span.path)}:${span.startLine}-${span.endLine}</code> · ${esc(span.agentId)}${span.model ? ` / ${esc(span.model)}` : ""} · ${esc(span.confidence)}</li>`).join("")
      : `<li>unattributed</li>`;
    return `<details class="group-detail"><summary>${esc(group.id)} · ${esc(group.kind)} · ${esc(group.risk)} · ${group.fileCount} files</summary><p>${esc(group.title)}</p><strong>Audit references</strong><ul>${refs || "<li>None</li>"}</ul><strong>Attribution</strong><ul>${attributionRows}</ul></details>`;
  }).join("");
  return `<article class="ticket-detail"><header class="pane-h"><span class="key">${esc(ticket.id)} / ${esc((categories[0] ?? "general").toUpperCase())}</span><span class="state s-${ticket.state}"><i class="dot s"></i>${esc(STATE_LABEL[ticket.state].toUpperCase())}</span></header><h1 class="detail-h1">${esc(ticket.title)}</h1><p class="refline mono">${esc(primaryRef(ticket))}</p>${ticket.blockedReason !== undefined ? `<p class="flash err" role="alert">Blocked: ${esc(ticket.blockedReason)}</p>` : ""}${ticket.staleReason !== undefined ? `<p class="flash" role="status">${esc(ticket.staleReason)}</p>` : ""}<section class="ticket-summary"><div class="section-label">DETERMINISTIC SUMMARY</div><p>${esc(ticket.summary)}</p></section><dl class="ticket-meta"><div><dt>PRIORITY</dt><dd><span class="pri p-${priority}">${priority}</span></dd></div><div><dt>SESSION</dt><dd>${esc(session)}</dd></div><div><dt>CATEGORIES</dt><dd class="chip-row">${categories.length > 0 ? categories.map((category) => `<span class="chip">${esc(category)}</span>`).join("") : `<span class="faint">General</span>`}</dd></div><div><dt>UPDATED</dt><dd class="mono">${esc(day(ticket.updatedAt))}</dd></div></dl><section class="repo-check" aria-label="${esc(verificationUnit)} evidence"><div class="check-h"><span>${verificationLabel} / ${progress.done} OF ${progress.total}</span><span class="pct">${pct}%</span></div>${bar(progress.done, progress.total, verificationUnit, true)}<div class="checklist">${ticket.checklist.map((_, index) => checklistRow(ctx, ticket, index)).join("") || `<div class="empty">No checklist items.</div>`}</div>${groupDetails ? `<section aria-label="Change groups"><div class="section-label">CHANGE GROUPS / AUDIT AND ATTRIBUTION</div>${groupDetails}</section>` : ""}</section>${approveForms(ctx, ticket)}${attachedContext(ctx, ticket)}</article>`;
}

function masterDetail(ctx: PageContext, selected: Ticket | undefined, tickets: readonly Ticket[], ticketActivity = false): string {
  const groups = QUEUE_ORDER.map((state) => queueGroup(ctx, state, tickets, selected)).join("");
  const pane = selected === undefined
    ? `<div class="empty-pane"><p class="eyebrow">INBOX / CLEAR</p><h1 class="detail-h1">All clear</h1><p class="sub">No tickets match this review queue. New tickets appear automatically when an agent session ends.</p></div>`
    : detailPane(ctx, selected);
  return `<div class="inbox-layout"><nav class="ticket-queue rail" aria-label="Tickets">${groups || `<div class="empty">No tickets in queue.</div>`}</nav><section class="pane">${pane}</section>${activityRail(ctx, ticketActivity ? selected?.id : undefined)}</div>`;
}

function ticketFilterForm(ctx: PageContext, filters: TicketFilters, view: "inbox" | "board", visible: number, total: number): string {
  const categories = [...new Set(ctx.tickets.flatMap((ticket) => categoriesOf(ticket)))].sort();
  const active = filters.q.length > 0 || filters.priority.length > 0 || filters.category.length > 0;
  const priorityOptions = ["urgent", "high", "medium", "low"].map((priority) => `<option value="${priority}"${filters.priority === priority ? " selected" : ""}>${priority[0]!.toUpperCase()}${priority.slice(1)}</option>`).join("");
  const categoryOptions = categories.map((category) => `<option value="${esc(category)}"${filters.category === category ? " selected" : ""}>${esc(category)}</option>`).join("");
  return `<form class="filterbar" method="get" action="${esc(ctx.base)}${view}" role="search"><label class="filter-search" for="${view}-q"><span class="sr-only">Search tickets</span><input id="${view}-q" data-search-primary type="search" name="q" value="${esc(filters.q)}" placeholder="Search tickets…" maxlength="200"></label><label><span>Priority</span><select name="priority"><option value="">All priorities</option>${priorityOptions}</select></label><label><span>Category</span><select name="category"><option value="">All categories</option>${categoryOptions}</select></label><button class="primary sm" type="submit">Apply</button>${active ? `<a class="btn sm" href="${esc(ctx.base)}${view}">Clear</a>` : ""}<span class="filter-count">${visible} / ${total} TICKETS</span></form>`;
}

export function renderInbox(ctx: PageContext, filters: TicketFilters = EMPTY_TICKET_FILTERS): string {
  const queue = railTickets(ctx);
  const filtered = filterTickets(queue, filters);
  const first = filtered[0];
  const heading = pageHeading(
    "HUMAN CHECKPOINT / INBOX",
    "Inbox",
    "Review the evidence. Not the transcript. Every approval stays on this machine.",
    `<span class="page-stat"><strong>${queue.filter((ticket) => ticket.state === "needs_review").length}</strong><span>IN REVIEW</span></span>`,
  );
  return layout(
    { ...ctx, active: "inbox" },
    "INBOX",
    `<div class="inbox-view">${heading}${ticketFilterForm(ctx, filters, "inbox", filtered.length, queue.length)}${masterDetail(ctx, first, filtered)}</div>`,
    filters.q,
  );
}

export function renderTicket(ctx: PageContext, ticket: Ticket): string {
  return layout({ ...ctx, active: "ticket" }, ticket.id, masterDetail(ctx, ticket, railTickets(ctx, ticket), true));
}

function filterTokens(entries: number, payload: unknown): number {
  return entries === 0 ? 0 : estimateTokens(JSON.stringify(payload));
}

export function renderContext(ctx: PageContext, file = ""): string {
  const cleanFile = file.trim();
  const form = `<form method="get" action="${esc(ctx.base)}context" role="search" class="search-form"><label class="sr-only" for="context-file">Scope context to a file</label><input id="context-file" data-search-primary type="search" name="file" value="${esc(cleanFile)}" placeholder="Scope to a file, e.g. src/auth/login.ts  ( / )" maxlength="200"><button class="primary sm" type="submit">Scope context</button>${cleanFile ? `<a class="btn sm" href="${esc(ctx.base)}context">Clear</a>` : ""}</form>`;
  const head = pageHeading(
    "MCP / QUERY_CONTEXT",
    "Context",
    `Exact scoped context pack agents receive from <code>query_context</code>${cleanFile ? ` for <code>${esc(cleanFile)}</code>` : ""}: ranked <code>[file:line]</code> facts, memory cards, and conflicts.`,
    `<span class="state s-done"><i class="dot s"></i>REFERENCE-ONLY</span>`,
  ) + form;

  const extracts = loadExtractsFromCache(ctx.rootDir);
  let entries: Array<{ ref: string; kind: string; category: string; score: number; tech?: string | undefined; simple?: string | undefined }> = [];
  let totalCandidates = 0;
  let ordering = "long-context-reorder";
  let sources = { changed: 0, dependents: 0, dependencies: 0 };
  const scopedCards = cardsForScope(
    ctx.rootDir,
    { ...(cleanFile.length > 0 ? { file: cleanFile } : {}) },
    10,
  ).filter((card) => card.replacedBy === undefined);

  try {
    const payload = buildQueryPayload({
      rootDir: ctx.rootDir,
      jsonPath: ctx.jsonPath,
      structural: cleanFile.length > 0,
      ...(cleanFile.length > 0 ? { file: cleanFile } : {}),
      includeCards: true,
      limit: 20,
    });
    entries = payload.entries;
    totalCandidates = payload.totalCandidates;
    ordering = payload.ordering;
    sources = payload.sources;
  } catch {
    if (extracts.length === 0) {
      return layout({ ...ctx, active: "context" }, "CONTEXT", `<div class="content-pad">${head}<div class="empty">No context snapshot yet. Run <code>memo-log scan .</code> first, or check the file path.</div></div>`);
    }
  }

  if (entries.length === 0 && extracts.length > 0) {
    const fallback = extracts.filter((ext) => cleanFile.length === 0 || ext.file.includes(cleanFile)).flatMap((ext) => ext.exports.map((exp) => ({
      ref: `[${ext.file}:${exp.line}]`,
      kind: exp.kind,
      category: "ast",
      score: 0.75,
      tech: exp.signature ?? `${exp.kind} ${exp.name}`,
    })));
    totalCandidates = fallback.length;
    entries = fallback.slice(0, 20);
  }

  const tokens = filterTokens(entries.length, { entries, cards: scopedCards });
  const maxTokens = DEFAULT_EXPORT_CONTEXT_MAX_TOKENS;
  const budgetPct = Math.min(100, Math.round((tokens / maxTokens) * 100));
  const breaking = detectBreakingChanges(loadState(ctx.rootDir), extracts).filter((item) => cleanFile.length === 0 || item.path.includes(cleanFile));
  const stats = `<div class="ctx-stats"><div><span>RANKED FACTS</span><strong>${entries.length} / ${totalCandidates}</strong></div><div><span>TOKEN BUDGET</span><strong>~${tokens.toLocaleString("en-US")} / ${maxTokens.toLocaleString("en-US")}</strong></div><div><span>ORDERING</span><strong>${esc(ordering)}</strong></div><div><span>CHANGED</span><strong>${sources.changed}</strong></div><div><span>DEPENDENTS / DEPS</span><strong>${sources.dependents} / ${sources.dependencies}</strong></div><div><span>CARDS / CONFLICTS</span><strong>${scopedCards.length} / ${breaking.length}</strong></div></div><div class="check-h"><span>TOKEN BUDGET UTILIZATION · ~${tokens} TOKENS</span><span class="pct">${budgetPct}%</span></div>${bar(Math.max(tokens, 1), maxTokens, "token budget", true)}`;
  const conflictRows = breaking.map((item) => {
    const ref = `[${item.path}:${item.line ?? 1}]`;
    const detail = item.exportName
      ? `${item.kind}: ${item.exportName}${item.previous && item.current ? ` (${item.previous} → ${item.current})` : ""}`
      : item.kind;
    return `<div class="ctx-row conflict"><span class="chip s-blocked"><i class="dot s"></i>${esc(item.kind)}</span><span class="mono">${esc(detail)}</span><span class="ref mla">${esc(ref)}</span></div>`;
  }).join("");
  const rows = entries.map((entry) => {
    const pct = Math.round(entry.score * 100);
    return `<article class="ctx-fact" tabindex="0" data-row><div class="ctx-fact-h"><span class="ref">${esc(entry.ref)}</span><span class="chip">${esc(entry.kind)}</span><span class="faint mono">${esc(entry.category)}</span><span class="pct mla">${pct}% impact</span></div><p class="mono">${esc(entry.tech ?? entry.simple ?? "")}</p></article>`;
  }).join("");
  const cards = scopedCards.map((card) => `<div class="ctx-row"><span class="chip">${esc(card.type)}</span><span>${esc(card.content)}</span><span class="ref mla">${esc(card.refs[0] ?? "")}</span></div>`).join("");
  const body = `<div class="content-pad">${head}${stats}${breaking.length > 0 ? `<section><h2>Conflicts &amp; breaking changes (${breaking.length})</h2>${conflictRows}</section>` : ""}<section><h2>Ranked [file:line] facts (${entries.length})</h2>${rows || `<div class="empty">No facts in this slice.</div>`}</section><section><h2>Scoped memory cards (${scopedCards.length})</h2>${cards || `<div class="empty">No cards in scope.</div>`}</section>${KEYS_BAR}</div>`;
  return layout({ ...ctx, active: "context" }, "CONTEXT", body);
}

export function renderBoard(ctx: PageContext, filters: TicketFilters = EMPTY_TICKET_FILTERS): string {
  const tickets = sortTickets(ctx.tickets);
  const filtered = filterTickets(tickets, filters);
  const heading = pageHeading("TICKET INDEX / BOARD", "Board", "Four real ticket states, calculated directly from disk. Filters never alter the record.", `<span class="page-stat"><strong>${filtered.length}</strong><span>VISIBLE</span></span>`);
  const cols = STATE_ORDER.map((state) => {
    const rows = filtered.filter((ticket) => ticket.state === state);
    const cards = rows.map((ticket) => {
      const progress = checklistProgress(ticket);
      const priority = priorityOf(ticket);
      const href = `${ctx.base}ticket/${ticket.id}`;
      const unit = ticket.groups.length > 0 ? "groups" : "Repo-check items";
      return `<a class="card board-card s-${state}" data-row data-href="${esc(href)}" href="${esc(href)}"><span class="row1"><span class="key">${esc(ticket.id)}</span><span class="when">${esc(day(ticket.updatedAt))}</span></span><strong class="title">${esc(ticket.title)}</strong><span class="meta">${categoriesOf(ticket).map((category) => `<span class="chip">${esc(category)}</span>`).join("")}</span><span class="board-progress">${bar(progress.done, progress.total, unit)}<span class="mono">${progress.done}/${progress.total}</span></span><span class="row1"><span class="pri p-${priority}">${priority}</span><span class="commit-count">${commitCount(ticket)} commits</span></span></a>`;
    }).join("");
    return `<section class="col s-${state}" aria-labelledby="col-${state}"><h2 id="col-${state}"><span><i class="dot s"></i>${esc(STATE_LABEL[state])}</span><span class="n">${rows.length}</span></h2><div class="col-cards">${cards || `<div class="empty">No matching tickets</div>`}</div></section>`;
  }).join("");
  return layout({ ...ctx, active: "board" }, "BOARD", `<div class="content-pad board-page">${heading}${ticketFilterForm(ctx, filters, "board", filtered.length, tickets.length)}<div class="board">${cols}</div>${KEYS_BAR}</div>`, filters.q);
}

export function renderCards(ctx: PageContext): string {
  const active = ctx.cards.filter((card) => card.replacedBy === undefined);
  const rows = active.map((card) => `<article class="card memory-card" tabindex="0" data-row><div class="row1"><span class="chip">${esc(card.type)}</span><span class="key">${esc(card.id)}</span><span class="when">${esc(card.scope)}${card.scopeTarget !== undefined ? `:${esc(card.scopeTarget)}` : ""}</span></div><p>${esc(card.content)}</p><div class="meta">${card.refs.map((ref) => `<span class="ref">${esc(ref)}</span>`).join("")}<span class="mono mla" title="${esc(cardHash(card))}">hash ${esc(cardHash(card).slice(0, 12))}</span></div></article>`).join("");
  return layout({ ...ctx, active: "cards" }, "CARDS", `<div class="content-pad">${pageHeading("LOCAL MEMORY / CARDS", "Cards", "Preferences, decisions, constraints, and conventions with mandatory references. Add with <code>memo-log card add</code>.", `<span class="page-stat"><strong>${active.length}</strong><span>ACTIVE</span></span>`)}<div class="memory-list">${rows || `<div class="empty">No cards yet.</div>`}</div></div>`);
}

export function renderGraph(ctx: PageContext, options: { rootDir: string; seed?: string | undefined; depth?: number | undefined }): string {
  const graph = buildGraph({ rootDir: options.rootDir });
  const heading = pageHeading("STRUCTURE / NEIGHBORHOOD", "Graph", "A deterministic 1–2 hop structural neighborhood, rendered locally with explainable ranking.", `<span class="page-stat"><strong>${graph.nodes.length}</strong><span>NODES</span></span>`);
  if (graph.nodes.length === 0) {
    return layout({ ...ctx, active: "graph" }, "GRAPH", `<div class="content-pad">${heading}<div class="empty">No graph nodes yet. Run <code>memo-log scan .</code> first.</div></div>`);
  }
  const defaultSeed = options.seed && options.seed.trim().length > 0
    ? options.seed.trim()
    : (graph.nodes.find((node) => node.kind === "File")?.key ?? graph.nodes[0]!.id);
  const depth = options.depth ?? 1;
  let content = "";
  try {
    const rendered = renderGraphMermaid({ rootDir: options.rootDir, seed: defaultSeed, depth });
    const rows = rendered.query.nodes.map((entry) => {
      const href = `${ctx.base}graph?seed=${encodeURIComponent(entry.node.key)}&depth=${depth}`;
      const b = entry.breakdown;
      return `<tr tabindex="0" data-row data-href="${esc(href)}"><td><span class="chip">${esc(entry.node.kind)}</span></td><td class="mono"><a href="${esc(href)}">${esc(entry.node.label)}</a></td><td class="ref">${esc(entry.node.ref)}</td><td class="key">${entry.hopDistance}</td><td class="mono">${entry.score.toFixed(4)} <span class="faint">(hop ${b.hop.toFixed(2)} · edge ${b.edgeWeight.toFixed(2)} · rec ${b.recency.toFixed(2)} · deg ${b.degree.toFixed(2)})</span></td></tr>`;
    }).join("");
    content = `<div class="graph-box"><div id="mermaid-canvas"></div><details class="mermaid-source"><summary>View Mermaid source</summary><pre class="mermaid-raw" data-mermaid>${esc(rendered.mermaid)}</pre></details></div><section><h2>Ranked neighborhood (${rendered.query.nodes.length} nodes, ${rendered.query.edges.length} edges · hash ${esc(rendered.query.integrityHash.slice(0, 12))})</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Node</th><th>Ref</th><th>Hop</th><th>Score breakdown</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    content = `<div class="flash err" role="alert">${esc(msg)}</div>`;
  }
  const form = `<form method="get" action="${esc(ctx.base)}graph" class="search-form graph-search"><label class="sr-only" for="graph-seed">Graph seed</label><input id="graph-seed" data-search-primary type="search" name="seed" value="${esc(defaultSeed)}" placeholder="Seed file, symbol, ticket, or card…" maxlength="200"><label><span class="sr-only">Hop depth</span><select name="depth" aria-label="Hop depth"><option value="1"${depth === 1 ? " selected" : ""}>1 hop</option><option value="2"${depth === 2 ? " selected" : ""}>2 hops</option></select></label><button class="primary sm" type="submit">Explore</button></form>`;
  return layout({ ...ctx, active: "graph" }, "GRAPH", `<div class="content-pad">${heading}${form}${content}${KEYS_BAR}</div>`);
}

export function renderNotFound(ctx: PageContext, what: string): string {
  return layout({ ...ctx, active: "inbox" }, "NOT FOUND", `<div class="content-pad">${pageHeading("LOCAL REVIEW / 404", "Not found", esc(what))}</div>`);
}

export function renderTokenPrompt(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0a0c0a"><title>memo-log review — token required</title><link rel="stylesheet" href="/app.css"></head><body><header class="brandbar"><span class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>memo-log</span></span><span class="brand-tag">FIELD MANUAL / LOCAL REVIEW</span></header><main class="token-page" id="main">${pageHeading("LOCAL AUTH / TOKEN", "Token required", "Open the tokenized URL printed by <code>memo-log review</code> in your IDE terminal, or paste the one-time token below.")}<form method="get" action="/" class="search-form"><label class="sr-only" for="review-token">One-time token</label><input id="review-token" type="text" name="token" placeholder="one-time token" maxlength="128" required><button class="primary" type="submit">Open review</button></form></main></body></html>`;
}
