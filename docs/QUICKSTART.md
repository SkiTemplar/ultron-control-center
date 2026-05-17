# ULTRON — Quick start (first 5 minutes)

Got the Control Center open. Now what? This is the no-lore tour. Pick a
tab, do the thing, move on. Total time: 5 minutes.

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

## 2. Skills — "is my agent loading anything risky?"

The Skills tab lists every skill across `~/.claude/skills/`, plugins,
and the vault. With strict security mode (default since v15.2.28), a
skill that triggers the prompt-injection scanner shows up under the
orange **Quarantined** filter.

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

## 3. Agents — "what subagents can I delegate to?"

The Agents tab mirrors the Skills flow but for autonomous subagents
under `~/.claude/agents/`. Fresh installs ship **31 agents** — 9 ULTRON
first-party + 22 community (15 generalists + 7 stack-aligned added in
v15.4.5: `cpp-pro`, `graphics-programmer`, `unreal-engine-engineer`,
`unity-engineer`, `devops-engineer`, `database-admin`, `fullstack-developer`).
The catalog at the bottom of the tab exposes **60+ more** from
`cockpit/agent-catalog.json`, taking the total to ~90 available.

- The same security scanner used on Skills runs on every agent
  manifest. Failing agents land under the orange **Quarantined**
  filter. Open one and the **Security panel** lists the PI rule, the
  excerpt and the line number, with the agent body dimmed behind.
- If you trust the source, type a one-line reason and click
  **Allow anyway**. A per-SHA1 waiver is appended to
  `~/.ultron/config/skill-trust.yaml` (same file as skill waivers).
  Editing the agent file invalidates the waiver — by design.
- New community agents you install from the catalog do not become
  searchable from the AI Router until they are embedded. The tab
  has a **Re-index agents** button that calls `embed_agents.py index`
  for you.

**Stuck?** Agent missing from the list? Dashboard → Maintenance →
**Skill registry rebuild** also rescans `~/.claude/agents/`.

---

## 4. Plans — "where was I yesterday?"

Plans are markdown documents under `~/.ultron/cockpit/PLANS.json`. The
tab is a kanban view: backlog → in-progress → blocked → resolved →
archived.

- Drag a plan between columns to update its status.
- The Pending items widget on the Dashboard flags any in-progress plan
  that's been idle for >7 days. Close it or update it.

**Stuck?** Resolved plans visible? Toggle **Show archived** in the
toolbar to see what's already done.

---

## 5. Memory — "what do I know?"

Two things to try:

- **Search box (top)** → BM25 over your vault's FTS5 index. Returns
  ranked snippets with the file path. Click to open.
- **Force graph** → nodes are notes, edges are wikilinks. Drag to nudge,
  scroll to zoom (0.4×–10×), click a node to open the side panel and
  jump to the source file.

**Stuck?** Graph empty? Make sure `~/.ultron-vault/` actually has
markdown files in it. The graph reads the same corpus the brain index
does — run **Maintenance → Vault sync** if your notes feel stale.

---

## 6. Settings → App lifecycle — "how do I update / undo?"

The bottom-right of Settings has an **App lifecycle** tab:

- **Rebuild** → opens a new terminal that runs
  `npm run tauri build` in `~/.ultron/control-center/`. Takes 3-5
  minutes the first time. Relaunch the app after the new binary lands
  in `src-tauri/target/release/bundle/`.
- **Uninstall** → opens a new terminal that runs
  `~/.ultron/uninstall.ps1`. Asks for confirmation before deleting.
  Your Claude Code skills in `~/.claude/skills/` survive — only ULTRON
  data gets removed.

**Stuck?** The uninstaller has a `-DryRun` flag that previews the
removal without touching disk:
```powershell
& C:\Users\USER\.ultron\uninstall.ps1 -DryRun
```

---

## Beyond the first 5 minutes

- **AI Router** (Settings → AI Router): pick which provider answers
  each task (diagnose, news, skill_edit, etc.). Default is Claude for
  everything; switch news to Gemini if you want longer context.
- **Notifications**: the bell icon shows the alerts stream. Click
  **Clear all** to wipe the visible list. Deletion is final — no
  silent backups, no tombstones.
- **News** (opt-in via installer): generates a daily HTML newsletter
  from your vault changes. Off by default — costs Gemini tokens.

---

## When something genuinely breaks

1. Open the Dashboard → run **Full diagnostic**.
2. If a row says red, click any **Auto-fix** the diagnostic suggests.
3. If still red, read the relevant section in
   [`INSTALL.md`](../INSTALL.md#common-failures-and-fixes).
4. If documented fixes don't help, open an issue on
   [GitHub](https://github.com/SkiTemplar/ultron/issues) with the
   diagnostic output pasted in.

That's the whole tour. Everything else is depth — feel free to dig
into [`CHANGELOG.md`](../CHANGELOG.md) for what each release added.
