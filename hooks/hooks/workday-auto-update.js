#!/usr/bin/env node
// workday-auto-update.js — H32
//
// Scheduled every 15 minutes by the "UltronWorkdayAutoUpdate" Windows task
// (registered via register_workday_autoupdate_task Tauri command).
//
// What it does:
//   1. Locates today's active workday JSON in ~/.ultron/cockpit/workdays/
//   2. Collects git activity (diff --stat + recent commits) for every
//      registered project whose path exists on disk.
//   3. Detects kanban card moves in the last 15 min by comparing updated_at
//      timestamps on cards to now.
//   4. Composes a summary string.
//   5. Appends an "auto_update" context note directly to the workday JSON
//      (no HTTP — works whether or not Control Center is running).
//
// The direct-JSON write uses the same atomic tmp+rename pattern as the
// Rust backend so concurrent writes from Control Center are safe.

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const cp   = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME          = os.homedir();
const ULTRON_ROOT   = path.join(HOME, ".ultron");
const WORKDAYS_DIR  = path.join(ULTRON_ROOT, "cockpit", "workdays");
const PROJECTS_FILE = path.join(ULTRON_ROOT, "cockpit", "projects.json");
const WINDOW_MIN    = 15; // minutes of git history to scan

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function nowIso() {
  return `epoch:${nowEpoch()}`;
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".autoupdate.tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function runGit(cwd, args) {
  try {
    // spawnSync with an argument array — no shell interpolation, safe against
    // paths that contain spaces or shell metacharacters.
    const result = cp.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || result.error) return "";
    return (result.stdout || "").trim();
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 1. Find today's active workday
// ---------------------------------------------------------------------------

function findActiveWorkday() {
  if (!fs.existsSync(WORKDAYS_DIR)) return null;

  const today = todayDate();
  const files = fs.readdirSync(WORKDAYS_DIR).filter(
    (f) => f.startsWith("wd-") && f.endsWith(".json")
  );

  for (const file of files) {
    const filePath = path.join(WORKDAYS_DIR, file);
    try {
      const wd = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (wd.planned_date === today && wd.status === "in_progress") {
        return { wd, filePath };
      }
    } catch (_) {
      // skip corrupt files
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Collect git activity
// ---------------------------------------------------------------------------

function loadProjects() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")) || [];
  } catch (_) {
    return [];
  }
}

function collectGitActivity(projects) {
  const since = `${WINDOW_MIN} minutes ago`;
  let totalFiles = 0;
  const activeProjects = [];

  for (const p of projects) {
    const cwd = p.path;
    if (!cwd || !fs.existsSync(cwd)) continue;

    // Check for recent commits
    const log = runGit(cwd, ["log", `--since=${since}`, "--oneline"]);
    const commitCount = log ? log.split("\n").filter(Boolean).length : 0;

    // Count changed files via diff stat vs HEAD~1 (cheap)
    const stat = runGit(cwd, ["diff", "--stat", "HEAD~1", "--shortstat"]);
    const fileMatch = stat.match(/(\d+)\s+file/);
    const files = fileMatch ? parseInt(fileMatch[1], 10) : 0;

    if (commitCount > 0 || files > 0) {
      totalFiles += files;
      activeProjects.push({
        name: p.name || p.id || cwd,
        commitCount,
        files,
      });
    }
  }

  return { totalFiles, activeProjects };
}

// ---------------------------------------------------------------------------
// 3. Detect recent kanban moves
// ---------------------------------------------------------------------------

function collectKanbanMoves(projects) {
  const cutoff = nowEpoch() - WINDOW_MIN * 60;
  let movedCards = 0;

  for (const p of projects) {
    if (!p.id) continue;
    const kanbanPath = path.join(
      ULTRON_ROOT, "cockpit", "projects", p.id, "kanban.json"
    );
    if (!fs.existsSync(kanbanPath)) continue;
    try {
      const board = JSON.parse(fs.readFileSync(kanbanPath, "utf8"));
      for (const card of board.cards || []) {
        // updated_at is "epoch:NNN"
        const m = (card.updated_at || "").match(/^epoch:(\d+)$/);
        if (m && parseInt(m[1], 10) >= cutoff) {
          movedCards++;
        }
      }
    } catch (_) {
      // skip
    }
  }

  return movedCards;
}

// ---------------------------------------------------------------------------
// 4. Compose summary
// ---------------------------------------------------------------------------

function composeSummary(gitActivity, movedCards) {
  const parts = [];

  if (gitActivity.activeProjects.length > 0) {
    const names = gitActivity.activeProjects.map((p) => p.name).join(", ");
    const commits = gitActivity.activeProjects.reduce(
      (s, p) => s + p.commitCount, 0
    );
    parts.push(
      `${commits} commit(s) en ${gitActivity.activeProjects.length} proyecto(s) (${names}).`
    );
  }

  if (gitActivity.totalFiles > 0) {
    parts.push(`${gitActivity.totalFiles} archivo(s) modificados recientemente.`);
  }

  if (movedCards > 0) {
    parts.push(`${movedCards} card(s) de kanban actualizados.`);
  }

  if (parts.length === 0) {
    return "Sin actividad detectable en los últimos 15 min.";
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// 5. Append auto_update note to workday JSON
// ---------------------------------------------------------------------------

function appendAutoUpdate(filePath, wd, summary, payload) {
  const entry = {
    id: newId("ctx"),
    kind: "auto_update",
    text: payload ? `${summary}\n${JSON.stringify(payload, null, 2)}` : summary,
    source: "scheduler",
    created_at: nowIso(),
  };

  if (!wd.context) wd.context = {};
  if (!wd.context.notes) wd.context.notes = [];
  wd.context.notes.push(entry);

  atomicWrite(filePath, JSON.stringify(wd, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const found = findActiveWorkday();
  if (!found) {
    // No active workday today — nothing to do.
    process.exit(0);
  }

  const { wd, filePath } = found;
  const projects = loadProjects();
  const gitActivity = collectGitActivity(projects);
  const movedCards  = collectKanbanMoves(projects);
  const summary     = composeSummary(gitActivity, movedCards);

  const payload = {
    git_projects: gitActivity.activeProjects,
    kanban_moves: movedCards,
    window_minutes: WINDOW_MIN,
    recorded_at: new Date().toISOString(),
  };

  try {
    appendAutoUpdate(filePath, wd, summary, payload);
    process.stdout.write(`[workday-auto-update] OK: ${summary}\n`);
  } catch (err) {
    process.stderr.write(`[workday-auto-update] write failed: ${err.message}\n`);
    process.exit(1);
  }
}

main();
