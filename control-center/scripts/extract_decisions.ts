#!/usr/bin/env -S deno run --allow-read --allow-write
// ULTRON Control Center — Decision extraction migration script (KIRKARDO 24)
//
// Reads a project's kanban.json, scans cards in Done-ish columns for
// decision heuristics, and writes DecisionRecord entries to
// ~/.ultron/cockpit/projects/<project_id>/decisions.jsonl
//
// Usage (Deno):
//   deno run --allow-read --allow-write scripts/extract_decisions.ts <project_id>
//
// Usage (via invoke from Tauri dev tooling):
//   node --loader ts-node/esm scripts/extract_decisions.ts <project_id>
//
// The script does NOT call the Tauri backend — it writes JSONL directly so it
// can run standalone during a migration batch without the app being open.

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { existsSync } from "https://deno.land/std@0.224.0/fs/mod.ts";

// ---------------------------------------------------------------------------
// Heuristics: card descriptions/titles that signal an archived decision.
// ---------------------------------------------------------------------------
const DECISION_PATTERNS = [
  /decid(?:imos|ido|imos que|ed to)/i,
  /decision:/i,
  /switched?\s+from\b/i,
  /elegimos\b/i,
  /we chose\b/i,
  /approach:/i,
  /agreed to\b/i,
  /going with\b/i,
  /optamos\s+por\b/i,
];

// ---------------------------------------------------------------------------
// Types (subset of Tauri structs)
// ---------------------------------------------------------------------------
interface KanbanCard {
  id: string;
  column_id: string;
  title: string;
  description: string;
  tags: string[];
  created_at: string;
}

interface KanbanColumn {
  id: string;
  name: string;
}

interface KanbanBoard {
  project_id: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

interface DecisionRecord {
  id: string;
  project_id: string;
  decision: string;
  rationale: string;
  alternatives_considered: string[];
  date: string;
  status: "accepted";
  supersedes_id: null;
  context_urls: string[];
  author: null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function homeDir(): string {
  const home =
    Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ??
    Deno.env.get("HOMEDRIVE") + Deno.env.get("HOMEPATH");
  if (!home) throw new Error("Cannot determine HOME directory");
  return home;
}

function isDoneColumn(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("done") || n.includes("complete") || n.includes("completado");
}

function matchesDecisionHeuristic(card: KanbanCard): boolean {
  const haystack = `${card.title}\n${card.description}`.toLowerCase();
  return DECISION_PATTERNS.some((rx) => rx.test(haystack));
}

/** Extract a short decision title (≤80 ch) and rationale from card text. */
function extractFields(card: KanbanCard): { decision: string; rationale: string } {
  // Try to split "Decision: <title>\n<rest>" or fall back to full title.
  const full = `${card.title}\n${card.description}`.trim();
  const decisionLineMatch = full.match(/decision:\s*(.+)/i);
  if (decisionLineMatch) {
    const decision = decisionLineMatch[1].trim().slice(0, 80);
    // Rationale = everything after the decision line.
    const afterLine = full
      .slice(full.indexOf(decisionLineMatch[0]) + decisionLineMatch[0].length)
      .trim();
    const rationale =
      afterLine.length >= 10 ? afterLine.slice(0, 500) : `From card: ${card.title}`;
    return { decision, rationale };
  }

  // Fallback: title is the decision, description (or "Migrated from kanban") is rationale.
  const decision = card.title.slice(0, 80);
  const rationale =
    card.description.trim().length >= 10
      ? card.description.slice(0, 500)
      : `Migrated from kanban card ${card.id}`;
  return { decision, rationale };
}

function newDecisionId(idx: number): string {
  const t = Date.now() * 1000 + idx;
  return `dec-${t}-${idx}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectId = Deno.args[0];
  if (!projectId) {
    console.error("Usage: extract_decisions.ts <project_id>");
    Deno.exit(1);
  }

  const home = homeDir();
  const kanbanPath = join(
    home,
    ".ultron",
    "cockpit",
    "projects",
    projectId,
    "kanban.json",
  );

  if (!existsSync(kanbanPath)) {
    console.error(`kanban.json not found at ${kanbanPath}`);
    Deno.exit(1);
  }

  const raw = await Deno.readTextFile(kanbanPath);
  const board: KanbanBoard = JSON.parse(raw);

  const doneColumnIds = new Set(
    board.columns.filter((c) => isDoneColumn(c.name)).map((c) => c.id),
  );

  if (doneColumnIds.size === 0) {
    console.log("No Done/Complete columns found — nothing to migrate.");
    Deno.exit(0);
  }

  const candidates = board.cards.filter(
    (c) => doneColumnIds.has(c.column_id) && matchesDecisionHeuristic(c),
  );

  console.log(
    `Scanned ${board.cards.length} cards. Found ${candidates.length} candidate(s) in Done columns.`,
  );

  if (candidates.length === 0) {
    console.log("No decision-like cards found. Nothing to extract.");
    Deno.exit(0);
  }

  // Read existing decisions.jsonl to avoid duplicates (keyed by card id in tags).
  const decisionsPath = join(
    home,
    ".ultron",
    "cockpit",
    "projects",
    projectId,
    "decisions.jsonl",
  );

  const existingIds = new Set<string>();
  if (existsSync(decisionsPath)) {
    const existing = await Deno.readTextFile(decisionsPath);
    for (const line of existing.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec: DecisionRecord = JSON.parse(trimmed);
        // Track cards already migrated via their "migrated-from:<card_id>" tag.
        const fromTag = rec.tags.find((t) => t.startsWith("migrated-from:"));
        if (fromTag) existingIds.add(fromTag.replace("migrated-from:", ""));
      } catch {
        // malformed line — skip
      }
    }
  }

  const toWrite: DecisionRecord[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const card = candidates[i];
    if (existingIds.has(card.id)) {
      console.log(`  skip  ${card.title.slice(0, 60)} (already migrated)`);
      continue;
    }

    const { decision, rationale } = extractFields(card);
    const rec: DecisionRecord = {
      id: newDecisionId(i),
      project_id: projectId,
      decision,
      rationale,
      alternatives_considered: [],
      date: card.created_at,
      status: "accepted",
      supersedes_id: null,
      context_urls: [],
      author: null,
      tags: [...card.tags, `migrated-from:${card.id}`],
    };

    toWrite.push(rec);
    console.log(`  + "${decision.slice(0, 60)}"`);
    await sleep(50);
  }

  if (toWrite.length === 0) {
    console.log("All candidates were already migrated. Nothing new to write.");
    Deno.exit(0);
  }

  // Append to decisions.jsonl.
  const appendText = toWrite.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Deno.writeTextFile(decisionsPath, appendText, { append: true });

  console.log(
    `\nDone. Extracted ${toWrite.length} decision(s) → ${decisionsPath}`,
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  Deno.exit(1);
});
