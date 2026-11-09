---
name: second-opinion
description: "External LLM code reviews via Codex or Gemini."
---

# Second-Opinion — ULTRON Skill

This is a starter template for the `second-opinion` skill. Edit freely.

## When to use
(Describe the triggers this skill should match. Activate when the user asks
for a second opinion, external review, codex review, gemini review, or
mentions /second-opinion on uncommitted changes, branch diffs, or
specific commits.)

## Workflow
1. (First step — pick the right peer model (Codex for iteration, Gemini for
   long-context / 150+ file reviews).)
2. (Second step — run the review and capture output to a subagent file.)
3. (Final output expectation — concise findings with prioritized actions.)
