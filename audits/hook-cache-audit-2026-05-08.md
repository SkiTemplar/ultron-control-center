# Hook Cache Audit — v14.4 P2 (2026-05-08)

> Auditoría de los 12 hooks ULTRON para identificar volatilidad en stdout que
> degrade el prompt cache. Cross-ref con telemetría real de transcripts JSONL.

## Telemetría observada (snapshot 2026-05-08)

Transcripts en `~/.claude/projects/<encoded>/<session>.jsonl` ya contienen
`message.usage` con `cache_read_input_tokens` + `cache_creation_input_tokens` +
`cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`.

**Agregado global, 34,019 turns:**

| Métrica | Valor |
|---|---|
| Hit rate global | **96.3%** |
| Tokens leídos del cache | 4,966,826,484 |
| Tokens nuevos (cache creation) | 191,639,191 |
| Mix 5m vs 1h cache | 0% / 100% (CC usa solo extended 1h) |
| Acceptance gate ≥60% | ✅ **trivialmente cumplido** |

**Top 10 proyectos por turns:**

| Proyecto | Turns | Hit rate |
|---|---:|---:|
| CARRERA-PROYECTOS | 12,788 | 96.2% |
| CARRERA-ASIGNATURAS | 10,449 | 96.2% |
| USER (root) | 4,502 | 97.1% |
| .claude-skills | 2,394 | 96.2% |
| .ultron | 994 | 94.1% |
| PERSONAL-Libro | 959 | 91.4% |
| Steam-RDR2 | 924 | 96.5% |

Los proyectos con mayor churn de skills/memory (`.ultron`, `PERSONAL-Libro`)
muestran ~3-5 puntos menos de hit rate — coherente con sesiones de auto-
desarrollo que modifican context.md, MEMORY.md, settings.local.json.

## 12 hooks inventariados

| Hook | Tipo | Stdout volatility | Impacto cache |
|---|---|---|---|
| session-init.ps1 | SessionStart | **HIGH** (línea 192: SessionId, staleCount, seedsCount, pendingMarker) | system-prompt drift cada sesión |
| mode-trigger.py | UserPromptSubmit | depende — si modo cambia, emite | post-cache-breakpoint, OK |
| intent-dispatcher.py | UserPromptSubmit | ALTO por design (per-turn skill ID) | post-breakpoint, OK |
| auto-approve-readonly.py | PreToolUse | bajo (boolean approve) | per-tool-call, OK |
| block-dangerous-bash.py | PreToolUse | bajo (boolean) | per-tool-call, OK |
| mcp-resilience.py | PreToolUse | bajo (decorator) | per-tool-call, OK |
| skill_integrity_check.py | PreToolUse | bajo (passes most calls silently) | per-tool-call, OK |
| routing-telemetry.py | PostToolUse | sin stdout (solo file write) | NONE |
| track-knowledge-reads.py | PostToolUse | sin stdout (solo file write) | NONE |
| session-log.py | Stop | sin stdout | NONE (model ya cerrada) |
| stop-memory-sync.ps1 | Stop | sin stdout | NONE |
| session-cleanup.ps1 | Stop | sin stdout | NONE |

## Único hot-spot: session-init.ps1 línea 192

```powershell
Write-Host "[OK] Session $SessionId ready - primed: stale=$staleCount seeds=$seedsCount$pendingMarker$contextReady"
```

**Por qué es volátil:**
- `$SessionId` — GUID de 8 chars, distinto cada sesión
- `$staleCount` — 0..N, varía con decay queue
- `$seedsCount` — 0..N, varía con stop hook anterior
- `$pendingMarker` — vacío o ` ⚠pending=N`
- `$contextReady` — vacío o ` context.md=OK`

**Impacto medido:**
Esta línea aparece en cada SessionStart hook output. Si Anthropic pone el
cache breakpoint *después* del system reminder de SessionStart, los 6,024
tokens de cache_creation que se observan en los `cache_creation_input_tokens`
incluyen probablemente esta línea + el primer mensaje del usuario. La
volatilidad de la línea contribuye a **invalidar las cache misses al
SessionStart** — pero no afecta los breakpoints internos de la sesión, que
se mantienen entre turnos.

**Refactor propuesto (v14.4 P2):**

```powershell
# ANTES (volátil):
Write-Host "[OK] Session $SessionId ready - primed: stale=$staleCount seeds=$seedsCount$pendingMarker$contextReady"

# DESPUÉS (estable):
Write-Host "[OK] Session ready - primed: see ~/.ultron/.tmp/current-session.json"
```

Detalles dinámicos siguen escribiéndose a `current-session.json` (ya pasa).
Claude lee el JSON cuando lo necesita. El stdout queda determinista.

**Ahorro estimado:** marginal en hit rate (<1pp), pero elimina el ruido de
debug en system reminders.

## Recomendación final

Phase 2 NO necesita refactor masivo. El cache hit rate global ya está en
96.3%. El plan original (cache_control breakpoints, hooks reorder, 12-hook
audit refactor) era apropiado para sistemas que parten de hit rate <60% — no
para uno que ya está optimizado por la harness.

**Plan revisado:**

1. **cache_telemetry.py** — lector de `~/.claude/projects/*/<session>.jsonl`
   que extrae `message.usage` y agrega hit rate por sesión, proyecto, ventana
   24h. Output a `~/.ultron/telemetry/cache-events.jsonl`.

2. **D24_LOW_CACHE_HIT detector** — alerta si hit rate cae bajo umbral
   conservador (sugerido **80%**, well above current floor 91.4%).

3. **cache-config.yaml** — documenta qué bloques son stable vs volatile
   (referencia para futuro), no es config activa porque Claude Code maneja
   los breakpoints internamente.

4. **session-init.ps1 línea 192 refactor** — un cambio quirúrgico que
   elimina volatilidad observable. Bajo riesgo, alto valor de claridad.

5. **Tests (8)** — telemetry parser, hit rate aggregation, threshold
   detection, malformed transcripts.

6. **Acceptance** — hit rate ≥60% **ya verificable post-snapshot**: 96.3%
   global. No se requiere ventana 24h adicional.

— Audit cerrado. Phase 2 ahora cabe en ~1d en vez de 2d.
