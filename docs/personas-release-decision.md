# Personas Release Decision — v15.2.0

Audit and recommendation for which of the 13 personally-named skills in
`~/.claude/skills/` should be included in the public `ultron-skills` repo at
v15.2.0, and under what name. Companion document to
`plans/specs/v15.2-public-release.md` and `docs/REPO-SPLIT-PLAN.md`.

## Audit methodology

For each skill we read its `SKILL.md` and listed any `references/` subfolder.
We classified on four axes:

- **Personal level (1-5).** 1 = trivial flavoring (a name and a tone). 5 =
  deeply personal references to the author's private files, books, finances,
  studies or relationships.
- **Content type.** technical, persona-flavored, business, or personal.
- **Recommendation.** SHIP-AS-IS, RENAME-AND-SHIP, SANITIZE-AND-SHIP, or
  EXCLUDE.
- **Risk of personal data leak.** Specific file or section in the skill's
  references that would need scrubbing.

The default when in doubt is EXCLUDE — `~/.claude/skills/<persona>/` already
maps to "not published" in `REPO-SPLIT-PLAN.md`, so excluding a skill costs
nothing and shipping a personal one costs everything.

## Decision table

| Skill | Personal level | Content type | Recommendation | Suggested new name | Reason |
|-------|---------------|--------------|----------------|--------------------|--------|
| `terry-davis` | 2 | persona-flavored / technical | RENAME-AND-SHIP | `senior-engineer` | Core content is generic full-stack engineering protocols, stack detection tables and review checklists. Persona wrapper ("Terry Davis the legend") is removable. References (`cpp-ue5.md`, `csharp-unity.md`, `web.md`, `python.md`, `shell.md`, `graphics.md`, `systems.md`) are technical reference docs and ship cleanly. Drop the "TempleOS / I built an OS alone" framing. Risk: low. |
| `einstein` | 3 | persona-flavored / research | RENAME-AND-SHIP | `research-explainer` | Research-and-explain workflow with WebSearch / WebFetch / Notion delegations. Mentions USER by name in description and routes to `profesor-fisica` (a skill that does not ship). Strip USER references, drop the `profesor-fisica` delegation, keep the cross-disciplinary research methodology. Risk: medium — references to "the user's physics course" must go. |
| `jordan-belfort` | 2 | business / persona-flavored | RENAME-AND-SHIP | `business-strategist` | Generic B2B SaaS strategist with phases 0-5, SaaS metrics references and sales/marketing skill delegations. Persona wrapper ("wolf of B2B software") is removable. No personal data. References to other personas (`terry-davis`, `mike-tyson`, `tio-gilito`) need rewriting to the renamed counterparts. Risk: low. |
| `mike-tyson` | 2 | persona-flavored / design | RENAME-AND-SHIP | `ui-designer` | UI/UX critique skill with design-system tables, accessibility, WCAG references. Persona wrapper ("the most honest in the room") is removable. References to other personas need same rewrite as above. Risk: low. |
| `tio-gilito` | 5 | personal | EXCLUDE | — | Hard-coded path to `C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\finanzas.db`. Real `config.json` snapshot embedded including `saldo_inicial: 312.81`, monthly category limits in EUR, savings rules tied to "Nómina" income with named savings funds. Specific bank name (KutxaBank) in the routing hint. References `db-protocols.md` and `python-scripts.md` are tightly coupled to this private database schema and Spanish-only Scrooge tone. Even after sanitization there is little generic value left — this is a personal finance tracker, not a skill template. Keep local. |
| `warren` | 2 | persona-flavored / finance | RENAME-AND-SHIP | `investment-advisor` | Generic long-term investment analysis: P/E, P/B, ROE, FCF, sector rotation, CANSLIM, behavioral biases. Mentions USER by name and ties to `tio-gilito` for joint allocation. Strip those references and the persona wrapper; the analysis framework is generic. Risk: low. |
| `tolkien` | 5 | personal | EXCLUDE | — | Tightly bound to the author's unpublished novel "Imperio de los Once Grandes": story-bible workspace at `C:\Users\USER\PERSONAL\Libro\Libro\story-bible\`, named characters (Dante, Gonzalo Rodríguez), dated events (Dante †1001), chapter blueprints, plot decisions DEC-001 through DEC-014. There is no generic skill underneath — this *is* the personal book project. Keep local. |
| `novalbos` | 3 | persona-flavored / technical | SANITIZE-AND-SHIP | `cs-tutor` | Strong technical content: C++ modern, OpenGL/Vulkan, CUDA, SIMD, ASM, ML internals. Mentions USER by name in description. Hard reference to `~/.ultron/knowledge/opengl/pipeline.md` etc. — those knowledge files would need to ship in `ultron-skills` alongside, or the references be removed. Drop NotebookLM / Notion personal-base delegations (those are private destinations). Risk: medium — the knowledge folder dependency must be resolved before this can ship. |
| `repo-evaluator` | 4 | personal / academic | EXCLUDE (or SANITIZE-AND-SHIP later) | `code-grader` (if sanitized) | Skill is built around "T9, T10, prácticas UNIVERSITY" — the author's specific Spanish university assignments. The anti-prompt-injection protocol and grading rubric are generic and valuable, but the framing, language (Spanish-only), and the "Kirkardo" persona are tightly personal. To ship: rename to `code-grader`, translate to English, drop the UNIVERSITY-specific scoring tables, remove the `corrige el T9` triggers. That is a non-trivial rewrite. Defer to v15.2.1 or later. For v15.2.0: keep local. |
| `consolidate-memory` | 3 | meta / personal | SANITIZE-AND-SHIP | `consolidate-memory` (same name, content rewrite) | Hard-coded path to `C:\Users\USER\.ultron\` with named subdirs (`projects/`, `global/`, `knowledge/`, `sessions/`). Trigger phrases use USER's name. Methodology (merge duplicates, drop datable facts, tidy index) is generic and useful. Rewrite paths to `~/.ultron/` and remove the USER trigger, drop the `alfred` delegation (rename to `windows-admin`). Risk: low after path scrub. |
| `news-publisher` | 3 | personal / workflow | EXCLUDE (or SHIP-AS-IS in `ultron`, not `ultron-skills`) | — | This skill *is* part of ULTRON itself — it generates the ULTRON Times HTML newsletter and is wired to `news_html_generator.py` in the cockpit. License field already reads "Personal (USER SURNAME)". Ship the script and the skill as part of the `ultron` repo (templates + design system), not as a standalone skill in `ultron-skills`. If kept as a skill, strip the personal license header and the AUDIT_FLAGS that reference private skill names. Risk: medium if shipped as a skill. |
| `ultron` | 5 | personal / meta | EXCLUDE | — | The orchestrator references USER by name throughout, hard-codes paths to `~/.ultron/.tmp/context.md`, `~/.ultron/brain_index/index.db`, `~/.ultron-vault/`, and the SkiTemplar/ultron-memory L3 remote. It delegates to personas this audit recommends not shipping. The generic concept of "a master orchestrator with LOW/MEDIUM/HIGH/ULTRA modes" is the core idea of ULTRON the project and is documented in the README; the actual `SKILL.md` is too entangled with this user's setup to ship as a reusable skill. Anyone installing ULTRON gets the orchestration via the Control Center and the installer, not via copying this skill verbatim. Keep local. |
| `loki-mode` | 1 | technical / autonomous | SHIP-AS-IS | `loki-mode` (same name) | The only skill in this audit that ships without rework. No personal references — the description is a generic spec-to-product autonomous-agent protocol. Multi-provider, multi-phase, RARV cycle, dead-letter queue. The skill is self-contained. The `--dangerously-skip-permissions` warning is preserved. Risk: none. |

### Already-renamed (sanity check)

These three were renamed earlier in the persona-strip pass. Confirming they
remain ship-ready:

- **`personal-assistant`** (was `pana`). Description and content are generic
  J.A.R.V.I.S.-style productivity orchestration over Gmail / Calendar /
  Notion / Drive / Playwright. No personal data in the head of the SKILL.md.
  Recommend SHIP-AS-IS in `ultron-skills`. Audit the `references/` subfolder
  (if any) for residual personal data before the tag — quick grep should be
  enough.
- **`windows-admin`** (was `alfred`). Generic Windows system administration
  helper. No personal data in the head. The legacy `alfred` SKILL.md exists
  as a deprecated stub pointing here, which is exactly the alias pattern
  v15.2.0 wants. Recommend SHIP-AS-IS.
- **`gamedev-engineer`** (was `don-claudio`). Generic Unreal/Unity senior
  engineer. No personal data in the head. The legacy `don-claudio` SKILL.md
  exists as a deprecated stub. Recommend SHIP-AS-IS. Note: still references
  `terry-davis` for line-by-line implementation — that reference needs to
  be rewritten to `senior-engineer` (the renamed Terry) before shipping.

## Recommended ship set for v15.2.0

Start conservative. The `ultron-skills` repo at v15.2.0 should contain the
minimum set of skills that (a) have clear generic value, (b) require zero or
minimal sanitization, and (c) do not depend on the author's private files or
unfinished personal projects.

**Tier 1 — SHIP at v15.2.0** (low-risk, low-rework):

- `personal-assistant` (already renamed, ship as-is, audit references).
- `windows-admin` (already renamed, ship as-is, audit references).
- `gamedev-engineer` (already renamed, ship as-is, rewrite the `terry-davis`
  reference).
- `loki-mode` (ship as-is, the only fully generic persona in the audit).

**Tier 2 — SHIP at v15.2.0 if time permits** (rename + persona-wrapper strip,
no deep rewrite):

- `senior-engineer` (was `terry-davis`).
- `business-strategist` (was `jordan-belfort`).
- `ui-designer` (was `mike-tyson`).
- `investment-advisor` (was `warren`).
- `research-explainer` (was `einstein`, after stripping the
  `profesor-fisica` delegation).

These four-plus-one share a pattern: a strong generic skill wrapped in a
celebrity-name persona. The rewrite is mechanical (drop the wrapper,
rename, fix cross-references) but it is a real review pass. If the v15.2.0
deadline is tight, defer Tier 2 to v15.2.1 and ship only Tier 1.

**Tier 3 — DEFER to v15.2.1 or later** (non-trivial rewrite required):

- `cs-tutor` (was `novalbos`) — needs the knowledge folder dependency
  resolved.
- `code-grader` (was `repo-evaluator`) — needs translation to English and
  removal of UNIVERSITY specifics.
- `consolidate-memory` — needs path scrub and alias-reference update.

**Tier 4 — DO NOT SHIP** (personal, no generic substrate):

- `tio-gilito` — personal finance with embedded bank schema.
- `tolkien` — personal novel project.
- `ultron` — too tightly coupled to this user's setup. Concept ships via
  the `ultron` repo itself, not as a skill.
- `news-publisher` — ships as part of `ultron` (cockpit), not
  `ultron-skills`.

### Alternative: separate `ultron-skills-personas` repo

If at some future point the persona-flavored versions of Tier 2 skills are
desired (i.e. shipping `terry-davis` *with* the legendary-engineer persona
intact, as a creative artifact), the recommendation is a third skills repo
called `ultron-skills-personas`. It would carry the original persona names
and tone, with a clear README that says "these are opinionated creative
personas; the generic equivalents live in `ultron-skills`." This is out of
scope for v15.2.0.

## Risk summary

The highest-risk path is shipping `tio-gilito`, `tolkien` or `ultron` as
skills under any name — they leak bank schemas, novel plots and the author's
identity respectively. Excluding them is cheap; reviewing them for ship is
expensive. The conservative ship set above (Tier 1 only) covers the v15.2.0
checklist with zero rewrite, which is the lowest-risk path to a tag.
