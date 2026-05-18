# Skills Manifest Schema — ULTRON v13.7.0 "MANIFEST"

> Architecture unchanged through v15.5.20 — file dated for historical record.

## Purpose

`~/.ultron/skills.manifest.yaml` is the **Single Source of Truth (SSOT)** for all skill
routing metadata in ULTRON. It drives:

- What skills the intent-dispatcher knows about
- Which triggers cause a skill to be suggested
- Which skills are deprecated (excluded from routing)
- Source attribution (who installed/discovered each skill)

The manifest is consumed by `intent-dispatcher.py` via `manifest.cache.json` (a
JSON projection of the YAML, regenerated on every sync).

---

## Lifecycle

```
SKILL.md files          intent-rules.yaml        wellknown list
     |                        |                        |
     v                        v                        v
 auto-discover()         (seed triggers)         hardcoded 22
          \                   |                   /
           \                  v                  /
            +---> skills.manifest.yaml (SSOT) <-+
                          |
                    manifest sync
                          |
                          v
               manifest.cache.json   <--- intent-dispatcher.py reads this
```

1. `ultron manifest sync` (or `ultron sync`) triggers auto-discovery
2. Each `~/.claude/skills/*/SKILL.md` with YAML frontmatter is scanned
3. New skills are appended to `skills.manifest.yaml` with `source: auto-discover`
4. Well-known skills (canonical 22) are always seeded with `source: plugin|persona|built-in`
5. Skills in manifest whose `SKILL.md` no longer exists on disk get `deprecated: true`
6. `manifest.cache.json` is regenerated atomically (tmp-then-rename)
7. `intent-dispatcher.py` reads the cache on next prompt — zero restart needed

---

## Schema Reference

Each entry in `skills.manifest.yaml` is a YAML mapping with these fields:

### Required Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique skill ID (e.g. `superpowers:systematic-debugging`, `windows-admin`) |
| `source` | enum | Origin: `built-in` | `plugin` | `mcp` | `persona` | `hookify` | `auto-discover` |
| `triggers` | list[string] | Keywords/phrases matched by the dispatcher (case-insensitive) |

### Optional Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `tags` | list[string] | `[]` | Semantic tags for filtering (`--source`, `--tags`) |
| `cost_tier` | enum | `medium` | Token cost: `low` | `medium` | `high` | `ultra` |
| `dispatcher_priority` | int 1-5 | `3` | Routing priority (1=highest; wins on tie) |
| `deprecated` | boolean | `false` | Excluded from active routing when `true` |
| `replaces` | list[string] | `[]` | Skill names this entry supersedes |
| `last_used` | string or null | `null` | ISO date of last routing telemetry hit |
| `last_synced` | string | today | ISO date of last sync that touched this entry |
| `description` | string | synthesized | One-line description from SKILL.md or name |
| `kind` | string | — | From SKILL.md frontmatter: `skill`, `persona`, `meta`, etc. |
| `category` | string | — | From SKILL.md frontmatter: `workflow`, `engineering`, etc. |
| `tier` | string | — | From SKILL.md frontmatter: `L1`, `L2`, `L3` |

### Example Entry

```yaml
- name: superpowers:systematic-debugging
  source: plugin
  triggers:
    - bug
    - debug
    - error
    - corrige
  tags:
    - debugging
    - error-recovery
  cost_tier: medium
  dispatcher_priority: 1
  deprecated: false
  replaces: []
  last_used: null
  last_synced: 2026-05-05
  description: Root-cause debugging methodology via systematic 5-step process
```

---

## Cache Contract (dispatcher-facing)

`manifest.cache.json` is the JSON projection consumed by `intent-dispatcher.py`.
**Never remove or rename `id` or `triggers` — they are load-bearing.**

```json
{
  "version": "0.2-S4",
  "generated_ts": "2026-05-05T20:00:00Z",
  "source": "skill_manifest sync",
  "skills": [
    {
      "id": "superpowers:systematic-debugging",
      "triggers": ["bug", "debug", "error", "crash"],
      "description": "Root-cause debugging methodology",
      "deprecated": false,
      "source": "plugin",
      "cost_tier": "medium"
    }
  ]
}
```

Extra fields per skill are additive and safe. `deprecated: true` entries are
**excluded** from the cache (they are never routed).

---

## CLI Commands

### `ultron manifest sync`

Auto-discover all `~/.claude/skills/*/SKILL.md` files with frontmatter, seed the
22 well-known skills, and regenerate `manifest.cache.json`.

```
ultron manifest sync
```

Idempotent: re-running produces no duplicates.

### `ultron manifest list`

Show a readable table of all active (non-deprecated) skills.

```
ultron manifest list                          # table of active skills
ultron manifest list --deprecated             # include deprecated
ultron manifest list --source plugin          # filter by source
ultron manifest list --format json            # machine-readable
```

### `ultron manifest validate`

Run JSON Schema 2020-12 validation against `skills.manifest.yaml` and report
drift between the manifest and the disk. **Does NOT auto-fix anything.**

```
ultron manifest validate
```

Exit codes:
- `0` — no schema errors and no drift
- `1` — drift or schema violations found (stderr has details)

Drift A: skills on disk (with `SKILL.md`) but NOT in manifest.
Drift B: manifest entries (non-deprecated, `source: auto-discover`) whose `SKILL.md` no longer exists on disk.

### `ultron manifest add`

Add a skill entry manually (idempotent — second call exits 0 with notice).

```
ultron manifest add my-skill --source plugin
ultron manifest add my-skill --source plugin --triggers "foo,bar,baz" --tags "engineering,tools"
```

### `ultron manifest deprecate`

Mark a skill deprecated. Idempotent — safe to call multiple times.

```
ultron manifest deprecate my-old-skill
```

The entry remains in the YAML (audit trail) but is excluded from `manifest.cache.json`
and therefore from dispatcher routing.

---

## Adding a New Skill Manually

1. Drop the skill folder under `~/.claude/skills/<skill-name>/SKILL.md`
2. Add YAML frontmatter to `SKILL.md`:
   ```yaml
   ---
   name: my-skill
   description: "What this skill does in one sentence"
   kind: skill
   tier: L1
   category: engineering
   last_verified: 2026-05-05
   ---
   ```
3. Run `ultron manifest sync` — it auto-discovers the new entry
4. Verify with `ultron manifest list | grep my-skill`

Or add it manually without frontmatter:
```
ultron manifest add my-skill --source plugin --triggers "keyword1,keyword2"
```

---

## Drift Detection Semantics

`ultron manifest validate` is a **read-only** operation. It reports:

- **Schema violations**: fields with wrong types or invalid enum values
- **Drift A** (new on disk): skills that exist on disk but are absent from the manifest.
  Fix by running `ultron manifest sync`.
- **Drift B** (ghost in manifest): manifest entries with `source: auto-discover` whose
  `SKILL.md` no longer exists. Fix by running `ultron manifest sync` (auto-deprecates them).

Well-known skills (the canonical 22 with `source: plugin|persona|built-in`) are exempt
from Drift B — they may not have a corresponding `~/.claude/skills/` directory.

---

## JSON Schema Location

Schema: `~/.ultron/config/skills-manifest-schema.json`
Standard: JSON Schema 2020-12 (`draft/2020-12`)

Validate manually:
```python
import json, yaml, jsonschema
from pathlib import Path
home = Path.home()
schema = json.load(open(home / ".ultron" / "config" / "skills-manifest-schema.json"))
data = yaml.safe_load(open(home / ".ultron" / "skills.manifest.yaml"))
jsonschema.validate(data, schema)  # raises ValidationError if invalid
```

---

## Telemetry

Every `sync`, `add`, and `deprecate` operation writes a JSONL event to:
`~/.ultron/telemetry/sync-events.jsonl`

Event shape:
```json
{"ts": "2026-05-05T20:00:00", "source": "skill_manifest", "event": "sync",
 "total": 392, "added_wellknown": 22, "added_auto_discover": 370, "auto_deprecated": 0}
```
