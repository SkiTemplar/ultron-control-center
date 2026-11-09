# ULTRON — Quick start (first 5 minutes)

Got the Control Center open. Now what? This is the no-lore tour. Pick a
tab, do the thing, move on.

> Paths use `~/.ultron/` form throughout. On Windows that resolves to
> `%USERPROFILE%\.ultron\`; on Linux to `$HOME/.ultron/`. The sidebar groups
> tabs under **Overview** (Dashboard, Usage, AI Router), **System** (System,
> MCPs, Library, Notes, Lab) and **Workspace** (Sessions,
> Projects, plus Finance in local builds), with Notifications and Settings
> anchored in the footer. Skills, Agents and Rules are sub-tabs of
> **Library**. `Ctrl+K` opens the command palette (see
> [`COMMANDS.md`](COMMANDS.md)).

---

## 1. Dashboard — "is anything broken?"

The first tab shows a memory status card (with a link to System), recent
crash events, the pending kanban cards of your projects, the backup status,
recent projects and a to-do side panel.

For a full check, open **System → Diagnostics**. The command palette also has
**Open System Diagnostics** and the maintenance actions (`Maintenance (...)`
entries, listed in [`COMMANDS.md` §2](COMMANDS.md#2-maintenance-commands)).

---

## 2. Library — "what is my agent loading?"

**Library** has eight sub-tabs: Skills, Agents, Rules, Plugins, Hooks,
Catalog, Commands and Tones.

- **Skills**: every skill under `~/.claude/skills/` and from plugins. The
  on/off toggle moves a skill into `~/.claude/skills/_disabled/<name>/`, a
  folder Claude Code does not load. Disabled skills are not injected
  automatically: the lazy dispatcher is not wired as a hook (see
  `cockpit/skill-lazy/README.md`).
- **Agents**: the subagents under `~/.claude/agents/`. A fresh clone does
  **not** ship agent `.md` files; install the ones you want.
- **Hooks**: the Claude Code hooks wired in `~/.claude/settings.json`.
- **Plugins**: installed plugins and their update check.

---

## 3. Projects → Board — "where was I yesterday?"

The per-project kanban lives inside **Projects → Board**. Open a project and
use its board to move cards across columns. The Dashboard card lists the
pending ones across projects. From a terminal:
`node ~/.ultron/scripts/kanban.mjs add <project> todo "Title"`.

---

## 4. Memory — "what did the system learn?"

There is no Memory tab (retired on 2026-10-18). Memory runs through the hooks
and the `ultron-memory` sidecar; the Dashboard card **Sistema de memoria**
shows its health, active items and pending candidates.

- **Inbox**: candidates captured by the hooks (for example the Stop hook,
  through `ultron-memory capture`) before they reach `~/.ultron/brain.db`.
  Secrets and PII are redacted before they land here. Review them with
  `ultron-memory inbox list`, then `inbox approve --id <id>` or
  `inbox reject --id <id>`. Nothing auto-promotes unless you enable
  auto-approve (`ultron-memory inbox auto-approve on`).
- **Recall**: `ultron-memory recall "<query>"` (sparse FTS5 over `brain.db`;
  dense recall over Qdrant is optional, `ULTRON_DENSE=0` turns it off) and
  `ultron-memory trace "<query>"` for the full per-source trace.

**Stuck?** No candidates showing? Capture happens at the end of a turn or
session. Run a Claude Code session with the ULTRON hooks wired in
`~/.claude/settings.json` and run `ultron-memory inbox list` again.

---

## 5. Settings — "how do I update / undo?"

- **Settings → General** holds the app lifecycle panel: autostart, the
  global hotkey, **Rebuild** (rebuilds the Control Center in a new terminal)
  and **Close**.
- **Uninstall**: command palette → **Uninstall ULTRON**, or run the script.
  Your Claude Code skills in `~/.claude/skills/` survive; only ULTRON data is
  removed. Preview first:

```powershell
& $env:USERPROFILE\.ultron\uninstall.ps1 -DryRun
```
```bash
~/.ultron/uninstall.sh --dry-run
```

---

## Beyond the first 5 minutes

- **AI Router** (its own tab, not a Settings section): pick which provider
  answers each zone. Defaults: the code zones start with `codex-cli`; the
  rest use Groq as primary and Gemini cloud as fallback. API keys go in
  **Settings → API Keys** or `~/.ultron/.env`.
- **Notifications**: the bell shows the alerts stream. **Clear all** wipes
  the visible list; deletion is final.

---

## When something genuinely breaks

1. Open **System → Diagnostics**.
2. Read the relevant section in [`INSTALL.md`](../INSTALL.md#3-troubleshooting).
3. If documented fixes don't help, open an issue on
   [GitHub](https://github.com/SkiTemplar/ultron-control-center/issues) with
   the diagnostic output pasted in.

Everything else is depth: see [`CHANGELOG.md`](../CHANGELOG.md) for what each
release added.
