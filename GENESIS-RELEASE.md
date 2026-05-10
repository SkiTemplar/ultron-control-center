# ULTRON v14.0.0 "GENESIS" — Release Marker

**Tagged:** 2026-05-06
**Predecessor:** v13.7.0 "MANIFEST" (2026-05-05)

## Sprint 5 Closure

The GENESIS release closes Sprint 5 of the v14 overhaul plan
(`~/.ultron/plans/ULTRON-v14-MASTER-DEFINITIVO.md`). Three sub-pilars built and
peer-reviewed:

- **S5-A — MCP Resilience**
  `mcp_health_check.py` · `mcp-resilience.py` hook · `mcp-fallbacks.yaml` ·
  `alerts.write_dedupe` atomic API · 9 MCPs probed in parallel ≤4s.

- **S5-B — Doctor CLI v2**
  `doctor.py` (12 detectors A–M) · `doctor-rules.yaml` · interactive `--fix`
  with TTY gate · `--token-audit --health-check --json --quiet` modes · weekly
  opt-in auto-doctor in `stop-memory-sync.ps1`.

- **S5-C — Security Hardening** *(added on USER's request, not in v4.6 plan)*
  `skill_sync_security.py` (10 prompt-injection rules PI001–PI011) ·
  `skill_provenance.py` with cross-process lock · `hook_input_validator.py`
  with bounded stdin reader · `settings_integrity.py` snapshot+diff ·
  `secrets_scanner.py` · `mcp_allowlist.py` enforcement · `path_traversal_guard.py` ·
  `skill-trust.yaml` per-skill exception mechanism.

## Peer Review

- **S5-A standalone:** 1 round Codex Dual → BLOCK → 5 fixes applied.
- **S5 full A+B+C:** 3 rounds Codex MaxDual.
  - R1: BLOCK → 9 fixes (3 critical + 6 high).
  - R2: BLOCK → 8 fixes (2 critical + 3 high + 3 medium).
  - R3: GREEN after final hook migration.

## E1–E5 Release Gates

| Gate | Result | Evidence |
|---|---|---|
| E1 token overhead ≤1500 tok | PASS (1264) | `doctor --token-audit` after CLAUDE.md trim |
| E2 dispatcher accuracy ≥8/10 | DEFERRED | Manual signal post-tag |
| E3 FTS5 latency <100ms | PASS | `brain_index.py query --mode chunks` p50 3.9 ms |
| E4 MCP 0 hard fails | PASS | 1 degraded (gemini) with fallback message |
| E5 skill auto-register | PASS | `test_registry_sync.py` end-to-end |

## Test Suite

247 tests across 11 files: alerts (21) · mcp_resilience (20) · intent_dispatcher (19) ·
brain_index_chunks (6) · multimodel (6) · skill_manifest (11) · doctor (37) ·
skill_security (32) · settings_integrity (8) · hook_validator (13) · secrets_scanner (12) ·
provenance (8) · path_traversal (7).

## Backups

- `~/.ultron/backups/2026-05-05-pre-S5/` — settings.json, hooks, ultron.ps1, tui.py,
  CLAUDE.md.pre-trim
- All previous sprint backups preserved under `~/.ultron/backups/2026-05-XX-pre-SX/`.

## Next

- ULTRON-GENESIS-CAPABILITIES.md (functional documentation, this directory).
- Cleanup pass via `ultron doctor --fix` (orphans, retention, manifest drift).
- Memorias / knowledge re-index runs automatically on next session-init when
  brain_index is >4h stale.
