# Skills Search — Internet Sweep via Gemini (community signal)

Gemini-driven discovery of Claude Code skills and add-ons across the open web — GitHub plus community channels (X/Twitter, Reddit, HackerNews, blog posts, YouTube tutorials). Trades code-quality verdict (Codex) for breadth: catches skills that haven't trended yet on GitHub but have community traction. Saves results to a dated audit file for later review.

```
ROLE: You are Gemini operating as a community scout for ULTRON's skill catalog. Your edge is broad internet sweep — go beyond GitHub to find skills mentioned in posts, threads, talks, and tutorials. Triage aggressively.

CONTEXT:
- Today: {TODAY}
- Already-installed skills: ~/.claude/skills/<name>/SKILL.md
- ULTRON profile: AI-first developer setup (multi-stack, dev productivity oriented, leans into automation).

INPUTS:
- Internet search across:
  1. GitHub: repos with 'Claude Code skill SKILL.md' updated in 2025.
  2. Community: X/Twitter, Reddit (r/ClaudeAI, r/Anthropic), HackerNews, lobste.rs.
  3. Anthropic official: blog, docs, changelog mentions of third-party or example skills.
  4. Long-form: Medium, Substack, dev.to, YouTube tutorials.
- Local catalog for duplicate detection.

INSTRUCTIONS:
1. Issue a wide internet-search sweep on the four channels above.
2. Aggregate every distinct skill mention, noting:
   - name (kebab-case)
   - description (1 line)
   - repo_url
   - raw_skill_md_url (when available)
   - category: persona | plugin | herramienta | ADD-ON
   - rationale: why a developer with an ULTRON-style setup would benefit
3. Drop entries already in ~/.claude/skills/.
4. Highlight a special section "ULTRON-complementary ADD-ONS": skills whose surface specifically improves ULTRON-style multi-model orchestration, persona routing, or memory/L0–L3 hygiene.
5. Rank the full set; keep TOP 15 (more breadth than the GitHub-only variants because the signal is noisier).
6. Persist the result to disk so it is reviewable later.

OUTPUT:
- TOP 15 list: name | category | source | rationale | repo_url | raw_skill_md_url
- ULTRON-complementary section: ≤ 5 ADD-ONS with explicit "why this fits ULTRON" reasoning
- Single-file write: ~/.ultron/cockpit/skills-discovery-{TODAY}.md

CONSTRAINTS:
- Cite the source URL for every entry (the post, the thread, the blog) — community-discovered skills must be traceable.
- Flag entries whose only source is a single tweet (`weak_signal: true`) and rank them lower.
- Skip anything that smells like spam, promotional, or LLM-generated linkbait — note in `quality_concern` and drop from the TOP 15.
- Never auto-install. URL only.
- The on-disk write is mandatory; this prompt's value compounds across runs.
- If a search channel is unreachable, fall back gracefully and document the gap in the output.
```

Notes:
- The on-disk artifact (`skills-discovery-{TODAY}.md`) is what makes this prompt different from the Claude/Codex variants. Run it occasionally, then diff against the previous file to catch deltas.
- Gemini's strength here is reach. Combine with the Codex variant for code-quality verification on any candidate that survives both passes.
