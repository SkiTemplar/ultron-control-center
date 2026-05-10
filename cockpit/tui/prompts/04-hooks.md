# Botón 4 — Hooks (Dual /high)

```
Ultron, /high /dual --codex — Kirkardo HOOKS Dual.

OBJETIVO:
  Auditar el ciclo de vida completo de hooks de ULTRON según la versión vigente:
  fallos silenciosos, drift entre settings.json y scripts, races, paths frágiles
  y pérdida de observabilidad.

FASE 1 — CLAUDE lee:
  - ~/.claude/settings.json (sección hooks completa)
  - ~/.claude/settings.local.json (overrides locales, si existe)
  - ~/.ultron/hooks/session-init.ps1
  - ~/.ultron/hooks/stop-memory-sync.ps1
  - ~/.claude/skills/ultron/hooks/auto-approve-readonly.py
  - ~/.claude/skills/ultron/hooks/block-dangerous-bash.py
  - ~/.claude/skills/ultron/hooks/routing-telemetry.py
  - ~/.claude/skills/ultron/hooks/track-knowledge-reads.py
  - ~/.claude/skills/ultron/hooks/session-log.py
  - ~/.claude/skills/ultron/hooks/mode-trigger.py
  - ~/.claude/skills/ultron/hooks/README.md
  - ~/.ultron/sessions/<latest>/hook-errors.log (si existe)
  - ~/.ultron/.tmp/current-session.json

FASE 2 — CODEX peer (--sandbox read-only):
  Por cada hook evaluar:
    1. Exit code != 0 sin bloquear sesión.
    2. Race conditions con varias sesiones abiertas.
    3. Paths frágiles o hardcoding innecesario.
    4. Encoding UTF-8 sin mojibake/BOM accidental.
    5. Timeout y coste adecuados por evento.
    6. Drift settings.json ↔ script real.
    7. Cobertura: SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · Stop.
    8. Phase A vs Phase B respetan modo HIGH+.
    9. Observabilidad: logs, errores, session id.

  Codex devuelve por hook:
    - Score 0-10 (correctness · resilience · observability).
    - Issues P0/P1/P2.
    - Patches sugeridos como archivo:línea → cambio.

FASE 3 — INTEGRACIÓN (Claude):
  - Matriz hook × ciclo de vida.
  - Nota Kirkardo HOOKS X/10.
  - TOP 3 FIX con archivo:línea exacta.
  - Hooks faltantes o eventos disponibles sin cobertura útil.
  - Decisión: patch de mantenimiento vs minor si cambia arquitectura.
  - Resumen ejecutivo ≤20 líneas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-hooks-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-hooks-nota-{TODAY}.md (≤20 líneas)
```
