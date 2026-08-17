# ULTRON — Quick start (first 5 minutes)

Got the Control Center open. Now what? This is the no-lore tour. Pick a
tab, do the thing, move on. Total time: 5 minutes.

> Paths use `~/.ultron/` form throughout. On Windows that resolves to
> `%USERPROFILE%\.ultron\`; on Linux (supported from v15.5) to
> `$HOME/.ultron/`. The Tauri sidebar groups sections under **Overview**
> (Dashboard, Usage, AI Router), **System** (System, MCPs, Library, Memory,
> Notes, Learn) and **Workspace** (Sessions, Projects), with Notifications
> and Settings anchored in the footer. Skills, Agents and Rules live as
> sub-views inside **Library** (collapsed into one tab since v2.1).

---

## 1. Dashboard — "is anything broken?"

The first tab. Two panels matter on day one:

- **Full diagnostic** → click **Run full diagnostic**. Ten subsystems
  light up (Qdrant, Brain, Vault, Hooks, MCPs, Skills, Cost, Disk,
  Backups). Anything red or orange tells you what to fix next.
- **Pending items** → auto-loaded on mount. Lists open loops (skills
  drift, stale plans, un-acked critical alerts, etc.). Click **Refresh**
  any time.

**Stuck?** If Qdrant is red, click **Maintenance commands →
Restart Qdrant**. The button kills any stale `qdrant.exe` and reboots
the native binary.

---

## 2. Library → Skills — "is my agent loading anything risky?"

Open **Library** and select the **Skills** sub-view. It lists every skill
across `~/.claude/skills/`, plugins, and the vault. With strict security
mode (default since v15.2.28), a skill that triggers the prompt-injection
scanner shows up under the orange **Quarantined** filter.

- Click a quarantined skill → the **Security panel** opens
  automatically. You see each finding (rule, severity, line, excerpt)
  with the SKILL.md dimmed behind.
- If the skill is legit (you trust the source), write a one-line
  reason and click **Allow anyway**. ULTRON appends a per-SHA1 waiver
  to `~/.ultron/config/skill-trust.yaml`. Edit the file and the
  waiver invalidates — by design.

**Stuck?** Skill not in the list at all? Dashboard → Maintenance →
**Skill registry rebuild**. That scans the disk and refreshes
`~/.ultron/skills/registry.json`.

---

## 3. Library → Agents — "what subagents can I delegate to?"

The **Agents** sub-view of **Library** mirrors the Skills flow but for
autonomous subagents under `~/.claude/agents/`. It lists whatever agents
are installed locally and lets you pull more from the bundled catalog
(`cockpit/agent-catalog.json` — ~70 entries spanning the VoltAgent,
wshobson and hesreallyhim community sources) via the **Install from
catalog** button.

> [!NOTE]
> A fresh clone does **not** ship agent `.md` files — the `agents/`
> directory is not tracked in the public repo. After first launch, install
> the agents you want from the catalog (the ULTRON first-party ones —
> `ultron-arch`, `ultron-docs`, `ultron-security`, etc. — plus stack
> specialists like `rust-engineer` or `typescript-pro`).

- The same security scanner used on Skills runs on every agent
  manifest. Failing agents land under the orange **Quarantined**
  filter. Open one and the **Security panel** lists the PI rule, the
  excerpt and the line number, with the agent body dimmed behind.
- If you trust the source, type a one-line reason and click
  **Allow anyway**. A per-SHA1 waiver is appended to
  `~/.ultron/config/skill-trust.yaml` (same file as skill waivers).
  Editing the agent file invalidates the waiver — by design.
- Agents you install from the catalog do not become searchable from the
  AI Router until they are embedded. Run the **Agents re-embed** command
  (command palette, fuzzy `agreem`) to re-vectorize `~/.claude/agents/`
  into the `ultron_catalog` Qdrant collection.

**Stuck?** Agent missing from the list? Dashboard → Maintenance →
**Skill registry rebuild** also rescans `~/.claude/agents/`.

---

## 4. Projects → Board — "where was I yesterday?"

The standalone Plans tab was removed in v2.5; the per-project kanban now
lives inside **Projects → Board**. Plan documents still persist as
markdown under `~/.ultron/plans/`. Open a project and switch to its
**Board** view to move work across columns (backlog through archived).

- Drag a card between columns to update its status.
- The Pending items widget on the Dashboard flags any in-progress item
  that's been idle for >7 days. Close it or update it.

**Stuck?** Don't see finished cards? Toggle **Show archived** in the
board toolbar.

---

## 5. Memory — "what did the system learn?"

The Memory tab surfaces the **candidate inbox**: all facts captured automatically
by the Stop hook (via the LLM extraction engine) before they make it into the
persistent `brain.db`. Two workflows:

- **Approve or Reject** → Click into any candidate. The content (with redaction
  of secrets/PII already applied) appears on the right. Click **Approve** to
  promote it to active memory; click **Reject** to discard it. Approved items
  are written to `~/.ultron/brain.db` with an audit trail.
- **Memory Trace** → The backend memory kernel is SQLite + Qdrant. The UI does
  not expose a force graph (that was an earlier experiment that proved less
  useful than expected). Memory inspection happens via search and via commands,
  not via visual graph navigation.

**Stuck?** No candidates showing? The Stop hook only fires at end-of-session.
Run a Claude Code session (with `~/.claude/settings.json` wired to your
ULTRON hooks), end it cleanly (type `exit` or close the window), and new
captures should appear within 10 seconds.

---

## 6. Settings → App lifecycle — "how do I update / undo?"

The bottom-right of Settings has an **App lifecycle** tab:

- **Rebuild** → opens a new terminal that runs
  `npm run tauri build` in `~/.ultron/control-center/`. Takes 3-5
  minutes the first time. Relaunch the app after the new binary lands
  in `src-tauri/target/release/bundle/` (NSIS / MSI on Windows; `.deb` /
  `.AppImage` on Linux from v15.5+).
- **Uninstall** → opens a new terminal that runs
  `~/.ultron/uninstall.ps1` (Windows) or `~/.ultron/uninstall.sh` (Linux).
  Asks for confirmation before deleting. Your Claude Code skills in
  `~/.claude/skills/` survive — only ULTRON data gets removed.

**Stuck?** The uninstaller has a `--dry-run` flag (`-DryRun` on PowerShell)
that previews the removal without touching disk:
```powershell
& $env:USERPROFILE\.ultron\uninstall.ps1 -DryRun
```
```bash
~/.ultron/uninstall.sh --dry-run
```

---

## Beyond the first 5 minutes

- **AI Router** (Settings → AI Router): pick which provider answers
  each task (diagnose, skill_edit, etc.). Default is Claude for
  everything.
- **Notifications**: the bell icon shows the alerts stream. Click
  **Clear all** to wipe the visible list. Deletion is final — no
  silent backups, no tombstones.

---

## When something genuinely breaks

1. Open the Dashboard → run **Full diagnostic**.
2. If a row says red, click any **Auto-fix** the diagnostic suggests.
3. If still red, read the relevant section in
   [`INSTALL.md`](../INSTALL.md#3-troubleshooting).
4. If documented fixes don't help, open an issue on
   [GitHub](https://github.com/SkiTemplar/ultron-control-center/issues) with the
   diagnostic output pasted in.

That's the whole tour. Everything else is depth — feel free to dig
into [`CHANGELOG.md`](../CHANGELOG.md) for what each release added.
