---
title: ULTRON — Macro Roadmap v15
status: ACTIVE
schema_version: 4
authors: USER + Claude (Opus 4.7)
fuente_unica: PLANS.json — administrar con `ultron plans <cmd>`
specs_directorio: specs/
---

# ULTRON — Macro Roadmap v15

> **REDEFINIDO 2026-05-11 (USER):** el orden de ejecución cambia.
> El **`v15.0-installer`** se RETRASA hasta que el sistema esté pulido
> (priority p3, `deferred_reason` documentada en PLANS.json). Es trabajo de
> distribución para terceros y va al final del ciclo v15.
>
> La **web (`v15.6-web-refresh`)** se mueve AL FRENTE — no es un showcase
> público sino un **dashboard personal de progreso** auto-actualizable
> desde el cockpit. Junto con `arranque-ligero` y `memoria-qdrant`
> (ambos p1) forma el camino al "sistema pulido" antes del installer.
>
> **Decisión USER 2026-05-11 (delegada a Claude):** los slugs/tags
> permanecen estables (`v15.0-installer`, `v15.6-web-refresh`, etc.). NO se
> renumera. Razón: estabilidad para `ultron verify`, referencias en specs y
> changelog se mantienen, reversibilidad si cambia la prioridad otra vez.
> **El orden de ejecución vive en `priority:` y `deferred_reason:` de
> `PLANS.json`, NO en el número de version.** Esta nota es la fuente de
> verdad sobre por qué v15.0 va al final aunque se llame v15.0.

## Propósito

Documento maestro del macro plan v15. Define las **8 sub-versiones** que
componen la generación v15 de ULTRON, su contexto técnico, sus criterios de
aceptación y su orden de ejecución. Es la entrada única para arrancar
cualquier sprint de esta generación.

Este documento NO contiene código. NO contiene métricas de sesiones de
trabajo. Es un **plan ejecutable** que describe qué hay que construir y por qué.

---

# I · CONTEXTO

## I.1 Fundamentos heredados de v14

Antes de v15, el sistema cuenta con las siguientes capas operativas:

| Capa | Componente | Función |
|---|---|---|
| L0 | `~/.ultron/.tmp/context.md` | Pinned context ≤400 tokens, primer al arrancar sesión |
| L1 | `~/.ultron/brain_index/index.db` | FTS5 SQLite, ~700 notas indexadas |
| L2 | `~/.ultron-vault/` | Vault Markdown, ~290 notas curadas |
| L3 | github SkiTemplar/ultron-memory | Remoto, sincronización via Stop hook |
| Vector | Qdrant Docker (localhost:6333) | `ultron_vault` + `ultron_skills`, 768d MPNet |
| Backup | `D:\USER\BACKUP\` | Mirror semanal robocopy /MIR · domingos login + 35 min |
| Hooks | settings.json | 12 hooks: SessionStart, UserPromptSubmit×3, PreToolUse×4, PostToolUse×3, Stop×3 |
| Skills | `~/.claude/skills/` + manifest | 14 personas L1 + plugins L2 |
| Routing | `intent-dispatcher.py` | 56 reglas YAML + ZTMSI fallback (FTS5+Qdrant) |
| Security | `skill_sync_security.py` | Reglas PI001-PI013 prompt-injection |
| Constitution | `~/.ultron/config/constitution.json` | 14 personas con safety_gates |
| Plans | `~/.ultron/plans/PLANS.json` + `ultron plans` CLI | Sistema de gestión de tareas |
| Test suite | `pytest tests/` | ~1000 tests cubriendo cockpit + hooks + routing + security |

## I.2 Filosofía v15 (3 reglas inalterables)

1. **No custom ML training** — modelos pre-entrenados aplicados quirúrgicamente.
2. **No auto-laundering** — todo merge/deploy/install requiere gate humano.
3. **Atomic + backup-before-destroy** — toda operación riesgosa tiene rollback.

## I.3 Restricciones de scope

- Sistema **personal**, no SaaS. No precios, no commerce, no multi-tenant.
- Stack del usuario: Windows 11, PowerShell 5.1+7, Python 3.13 (uv), Node 20+,
  Docker Desktop, Tailscale.
- Open-source MIT como default; cada release con human-gate de USER.

---

# II · LAS 8 SUB-VERSIONES

| Sub | Nombre | Effort | Bloque | Dependencias | Prioridad real |
|---|---|---|---|---|---|
| **v14.9** | Structure migration (prerequisito) | 2-3 h | A | — | ✅ resolved 2026-05-10 |
| ~~v15.0~~ | ~~GitHub Release + Installer~~ → **DEFERIDO** | 10-14 h | C (era A) | sistema pulido | **p3 deferred** (era p1) |
| **v15.6** | Web Showcase Refresh → **Dashboard personal** (auto-update) | 6-10 h | A | v14.9 | **p1 — siguiente** |
| **v15.0b** | **Memory & Context Overhaul** — skill-vault (380→46) + Qdrant + registro unificado + MCP audit + OSINT | 20-30 h | A | + `memoria-qdrant` | ✅ **resolved 2026-05-12** |
| ~~`arranque-ligero`~~ | ~~Reducir overhead 6k→2k~~ → **absorbido en v15.0b** | — | — | — | deferred (superseded) |
| `skill-registry-finish` | Remate WS6: migrar consumers al registro v2 · brain_index↔vault · osint diff · trim CLAUDE.md | 4-6 h | A | v15.0b | p2 — polish |
| `memoria-qdrant` | Pipeline embedding + recall semántico — **verificado vivo** (ultron_vault 308 + ultron_skills 429 pts; hooks Stop→embed_* y auto-recall operativos) | 6-8 h | A | — | mayormente hecho (queda RRF híbrido + auto-mejora) |
| **v15.0.1** | **Dual Mode v2** — adoptar `codex-plugin-cc` + Gemini CLI vía suscripción (sin API key) | 8-12 h | A | — | **p1 — antes de v15.1** |
| **v15.1** | Bus Foundation | 32-40 h | B | v14.9 + v15.0b (token diet) | p1 |
| **v15.2** | Supervisor Daemon | 24-32 h | B | v15.1 | p1 |
| **v15.3** | Pipeline DAG | 24-32 h | B | v15.2 | p2 |
| **v15.4** | Overnight Loop | 16-24 h | B | v15.2, v15.3 | p2 |
| **v15.5** | Mobile Remote (PWA) | 40-56 h | B | v15.2 (MVP-29h posible antes que v15.3-v15.4) | p2 |
| **v15.7** | Anti-Hallucination Layer | 12-18 h | C | v15.1 (helpful, no blocking) | p2 |

**Total estimado:** 166-229 h (~21-29 días calendar a 8h/día).

---

## v14.9 · STRUCTURE MIGRATION (prerequisito v15)

### Definición
Migrar `scripts/`, `tests/`, `hooks/`, `.venv/` desde `~/.claude/skills/ultron/`
a `~/.ultron/`, dejando `.claude/skills/ultron/` como **pure skill definition**
(SKILL.md + mode-*.md + protocols.md + memory.md + references/ + agents/).

### Por qué
- `~/.claude/` es territorio del framework Claude Code; ULTRON contamina ese
  espacio con código operativo que no debería vivir ahí.
- v15.0 INSTALLER no puede empaquetar limpiamente mientras esto esté mezclado.
- Aclara la división: skill = definición declarativa; tooling = state mutable.

### Layout final
```
~/.claude/skills/ultron/         ~5 MB — pure skill definition
  SKILL.md, mode-*.md, protocols.md, memory.md, CLAUDE.md
  references/, agents/

~/.ultron/                        state + tooling + state mutable
  scripts/cockpit/                ← MOVIDO
  scripts/hooks/                  ← MOVIDO
  scripts/alerts/, scripts/backup/  ← ya estaban
  tests/                          ← MOVIDO
  .venv/                          ← REGENERADO con uv sync
  cockpit/, brain_index/, plans/, sessions/, ...  ← ya estaban

~/.ultron-vault/                  unchanged — knowledge L2
```

### Fases (orden estricto, no paralelizar)

| Fase | Duración | Acción |
|---|---|---|
| 0 — Pre-flight | 15 min | tar.gz backup completo · `pytest -q` baseline · `doctor.py --json` snapshot |
| 1 — Cleanup low-risk | 10 min | Archivar `hookify-rules/`, `memory/L1/`, `alerts/archive/` empties |
| 2 — Move scripts/tests/hooks | 30 min | `mv` paths uno a uno · git rm en repo skill · git add en repo .ultron |
| 3 — Path rewrites | 30 min | `grep -rl '\.claude/skills/ultron/scripts'` y reemplazar a `~/.ultron/scripts` |
| 4 — Regenerar venv | 10 min | `cd ~/.ultron && uv sync` |
| 5 — Verify | 30 min | `pytest -q` debe seguir verde · `ultron health` OK · TUI arranca |

### Acceptance criteria
- [ ] `~/.claude/skills/ultron/` contiene SOLO archivos `.md` y `references/`, `agents/`
- [ ] `pytest -q` mantiene mismo número de tests passing
- [ ] `ultron health` y `ultron doctor --quiet --json` exit 0
- [ ] Hooks en `settings.json` apuntan a las nuevas rutas
- [ ] Sesión Claude Code arranca sin errores

### Riesgos
| Risk | Mitigación |
|---|---|
| Hooks rompen al cambiar paths | Buscar+reemplazar global pre-mv, validar `settings.json` con jq |
| `uv sync` recrea venv mal | Tener tar.gz pre-fase para rollback total |
| Tests asumen rutas absolutas | `pytest --collect-only` antes y después; reparar imports tocados |

### Spec completa
`~/.ultron/plans/2026-05-09-v14.9-STRUCTURE.md`

---

## v15.0 · GITHUB RELEASE + INSTALLER

### Definición
Empaquetar ULTRON para que un tercero clone el repositorio público y ejecute
un instalador interactivo en su máquina (Windows / macOS / Linux) y obtenga
el sistema funcional sin pasos manuales.

### Por qué
- Forzar la sanitización de paths absolutos hardcodeados (`C:\Users\USER`)
  y secrets que hoy están dispersos por el repo.
- Establecer un contrato claro de qué partes son obligatorias vs opcionales
  (skills, hooks, MCPs).
- Convertir un proyecto personal en código distribuible sin re-escribirlo.

### Componentes
1. **Branding**: README.md raíz, LICENSE MIT, CONTRIBUTING.md
2. **Sanitizer** (`scripts/cockpit/sanitize_for_release.py`): grep recursivo
   de paths absolutos, secrets API keys, OAuth tokens, frontmatter con datos
   personales. Reemplaza por `$USERPROFILE` / `~`.
3. **Installer scripts**: `install.ps1` (Windows) + `install.sh` (Unix) con
   menú interactivo y modos `--minimal`, `--full`, `--profile=team`, `--custom`.
4. **Pre-checks**: Python 3.13+, uv, git, node (para MCPs).
5. **Smoke test post-install**: `ultron status`, `ultron health`, `ultron skills
   manifest status`. Si falla → `~/.ultron/logs/install.log` + mensaje claro.

### Fases

| Fase | Duración | Entregable |
|---|---|---|
| 0 — Branding | 1-2 h | README, LICENSE, landing GitHub Pages markdown |
| 1 — Sanitizer | 2-3 h | Script + corpus tests + reporte de paths sensibles |
| 2 — Install scripts | 3-4 h | `install.ps1` + `install.sh` con menú |
| 3 — Modos opcionales | 2-3 h | `--minimal` / `--full` / `--profile` / `--custom` |
| 4 — Smoke test | 1 h | Post-install verifica sistema arranca |
| 5 — Release | 1 h | git tag v15.0.0 + GitHub Releases + changelog público |

### Acceptance criteria
- [ ] Clone limpio en VM Windows fresca → `install.ps1` → `ultron tui` arranca
  sin tocar nada manualmente
- [ ] Sanitizer no deja paths a `C:\Users\<persona>` ni secrets en el repo
- [ ] `gitleaks` pass sobre el repo público
- [ ] Modo `--minimal` instala SOLO el cockpit base
- [ ] Modo `--full` instala todo: 14 personas + MCPs + hooks + scheduler
- [ ] README explica los 3 modos en <2 min de lectura
- [ ] Tests CI matrix `windows-latest` + `ubuntu-latest` + `macos-latest`

### Decisiones a tomar antes de ship

| ID | Decisión | Default propuesto |
|---|---|---|
| D-15-1 | Repo público vs privado | Public + MIT |
| D-15-2 | Apellido USER en commits | Sí (es público en GitHub igual) |
| D-15-3 | Aceptar PRs externos | Sí, con CONTRIBUTING.md |

### Riesgos
| Risk | Mitigación |
|---|---|
| Sanitizer no detecta path edge-case | Test corpus con todos los formatos: `C:\\Users\\X`, `~/`, `$env:USERPROFILE`, `%USERPROFILE%` |
| MCPs piden API keys → onboarding hostil | Skip por default; menú custom marca como opcional |
| Repo público filtra info personal en git history | `git filter-repo` previo al primer push |
| User instala sobre `~/.ultron` con datos previos | Detección + offer migrate / abort / overwrite |

### Spec completa
`~/.ultron/plans/specs/v15.0-installer.md`

---

## v15.0b · TOKEN DIET (arranque ligero — versión correcta)

### Definición
Reducir el overhead fijo de contexto de una sesión ULTRON de **~56k tokens** a **<22k**, atacando la causa raíz: las **380 skills** en `~/.claude/skills/` aportan **33.8k tokens** de metadata cargada en *cada* sesión (comportamiento de plataforma — los hooks no lo pueden evitar).

### Por qué
- El item antiguo `arranque-ligero` apuntaba a ~6k (SKILL.md+CLAUDE.md+MEMORY.md) — 5× más pequeño que el problema real. Queda **superseded** por este.
- Bloquea la sensación de "sistema pulido" y encarece toda interacción. Va **antes de v15.1-bus** porque el bus multiplica sesiones → multiplica el coste fijo.

### Componentes
1. **Skill-vault** — ~40-50 skills activas (código + investigación/académicas + finanzas + personas ULTRON + superpowers core); el resto → `~/.ultron/skill-vault/`, indexadas en Qdrant (`ultron_skills`), restore on-demand.
2. **Router Qdrant** — si la query no matchea skill activa, busca en `ultron_skills` y surfacea la vaulteada relevante.
3. **Telemetría** — `routing-telemetry.py` extendido: usage_count por skill → `ultron skills stats` (cold/hot) + `merge-candidates` (similitud embedding > 0.92).
4. **MCP token audit** — medir coste de los 12 servers; aplicar disabled-registered o `ultron mcp enable/disable`.
5. **Quick wins** — SessionStart deja de inyectar el cuerpo de `using-superpowers`; trim CLAUDE.md global / SYSTEM-MAP / MEMORY.md; auditar agentes de plugins (pr-review-toolkit ×6, feature-dev ×3).

### Acceptance criteria
- `~/.claude/skills/` ≤50 carpetas; medidor Skills <8k; overhead fijo total <22k.
- `ultron skills search "<tema>"` + `restore <name>` funcionan.
- `ultron skills stats` con usage_count real del hook.
- MCP: coste medido + mejor opción aplicada.

### Spec completa
`~/.ultron/plans/specs/v15.0b-token-diet.md`

---

## v15.0.1 · DUAL MODE v2 (codex-plugin-cc + Gemini CLI)

### Definición
Modernizar el sistema multi-modelo peer. Adoptar el plugin oficial `openai/codex-plugin-cc` (marzo 2026) en lugar del plumbing casero (`shared-duet.ps1`), y pasar Gemini a CLI-vía-suscripción con output a archivo, eliminando `GEMINI_API_KEY`.

### Por qué
- El Dual actual vuelca el output de Codex como resultado de Bash → contamina el contexto principal. El plugin usa background jobs + subagente `codex:codex-rescue` → la salida queda fuera de tu ventana.
- Auth Codex pasa a ser tu suscripción ChatGPT (no API key). Gemini igual: CLI con OAuth, sin API key, output a `.md` legible.
- Va **antes de v15.1-bus**: el bus multiplica sesiones que usan Dual; mejor tener el plumbing limpio antes.

### Componentes
1. Instalar `codex-plugin-cc` (USER ejecuta los `/plugin …`); `~/.codex/config.toml` con `model`+`model_reasoning_effort` pin; review-gate desactivado.
2. Mapear `/minidual`→`/codex:review`, `/dual`→`/codex:adversarial-review` acotado, `/maxdual`→ + `/codex:rescue` con confirmación. Mantener: LOW prohíbe Dual, Codex read-only salvo rescue, Claude escribe.
3. `gemini-peer.ps1`: `gemini -m <Pro> -p "...; escribe en <ruta>.md"` → Claude `Read`. Quitar `GEMINI_API_KEY` de `settings.json`.
4. Seguridad: `--ignore-user-config` ya no aplica → auditar `config.toml` como vector; repos untrusted por defecto.
5. Doc: reescribir `references/dual-mode-protocol.md` + `CLAUDE.md` § Dual; deprecar `.ps1` caseros.
6. Sincronizar todo (registry_sync, version_propagate, SYSTEM-MAP, context_primer, verify, changelog, commit).

### Acceptance criteria
- `/codex:review` funciona desde suscripción; `/dual` lanza el plugin por debajo respetando rounds y la regla LOW.
- `gemini-peer.ps1` deja output en `.md`; `GEMINI_API_KEY` eliminado.
- Review-gate sin bucle infinito; doc reescrita; `.ps1` deprecados; `ultron verify` OK.

### Spec completa
`~/.ultron/plans/specs/v15.0.1-dual-mode-v2.md`

---

## v15.1 · BUS FOUNDATION

### Definición
Sistema nervioso que permite a varias sesiones Claude Code hablar entre sí.
Implementa un **MCP server local** (`ultron-bus`) que expone tools para que
cada sesión registre su existencia, mande mensajes a otras y reciba el inbox
al arrancar.

### Por qué
Hoy el usuario tiene múltiples procesos Claude activos pero son **silos**:
ninguna sesión sabe que otra existe ni puede pasarle resultados. Sin esta
capa, `v15.2 SUPERVISOR`, `v15.3 PIPELINE`, `v15.4 OVERNIGHT` y `v15.5 MOBILE`
no son posibles.

### Arquitectura
```
              ┌───────────────────────────────────┐
              │   ultron-bus  (MCP server local) │
              │   - mailbox:  ~/.ultron/bus/      │
              │   - registry: sessions.json       │
              │   - heartbeat:  every 30 s        │
              └────────┬─────────────┬────────────┘
                       │             │
        ┌──────────────┴──┐       ┌──┴──────────────┐
        │  Sesión A       │       │  Sesión B       │
        │  hook:          │       │  hook:          │
        │   SessionStart  │       │   SessionStart  │
        │   → register    │       │   → register    │
        │   Stop          │       │   Stop          │
        │   → flush msgs  │       │   → flush msgs  │
        └─────────────────┘       └─────────────────┘
```

### Componentes (en orden de implementación)

1. **Schema y storage** (4 h)
   - `~/.ultron/bus/sessions.json` — registry: `{session_id, pid, started_at, current_skill, last_heartbeat, status}`
   - `~/.ultron/bus/<session_id>/inbox.jsonl` — append-only mensajes recibidos
   - `~/.ultron/bus/<session_id>/outbox.jsonl` — append-only mensajes enviados
   - Format mensaje: `{id, ts, from, to, kind, content, ttl}`

2. **File locks** (2 h)
   - Reusar patrón `_FileLock` de `pending_actions.py` para `sessions.json`
   - Escritura atómica con tmp+rename

3. **Hooks ext** (4 h)
   - `register_session.py` (SessionStart) — añade entrada al registry
   - `flush_outbox.py` (Stop) — marca status=closed, opcionalmente envía notificación
   - `heartbeat.py` (UserPromptSubmit) — actualiza `last_heartbeat` con throttle 30s
   - `prune_dead_sessions.py` (Stop) — quita del registry sesiones sin heartbeat >5min

4. **MCP server** (12-16 h)
   - Python stdio, paquete `~/.ultron/mcps/ultron-bus/`
   - Tools expuestas:
     - `bus.list_sessions()` → array de sesiones live
     - `bus.send(target_id, kind, content, ttl?)` → enqueue a inbox de target
     - `bus.read(my_id, since_ts?)` → lee mensajes propios desde N
     - `bus.subscribe(pattern)` → mark interest in topic (futuro)
   - Inscribir en `settings.json` mcpServers

5. **TTL + dedup** (3 h)
   - TTL default 1h. Cron del bus pruna mensajes expirados cada 10 min
   - Dedup por `content_hash` en ventana de 5 min (evita loops infinitos)

6. **Tests** (5-7 h)
   - `tests/test_bus_mailbox.py` — atomic writes, lock, dedup, TTL
   - `tests/test_bus_mcp_tools.py` — stdio handshake + cada tool
   - `tests/test_bus_hooks_e2e.py` — SessionStart→register→message→Stop→close

7. **Documentación + UX** (2 h)
   - Sección bus en SKILL.md ULTRON
   - Comando `ultron bus status` (lista live + inbox preview)

### Acceptance criteria
- [ ] Dos sesiones Claude Code pueden enviarse mensajes en <1s
- [ ] Sesión muerta se pruna del registry en <5 min
- [ ] Mensaje con TTL expirado no se entrega
- [ ] Mensaje duplicado en ventana corta se descarta
- [ ] Test e2e cubre el flujo register→send→read→close
- [ ] Hooks SessionStart/Stop ejecutan en <50 ms (asyncRewake patrón)

### Riesgos
| Risk | Mitigación |
|---|---|
| Race en `sessions.json` con N sesiones simultáneas | File lock + tests con threading |
| Mensajes infinitos entre sesiones (loop) | TTL + dedup hash + max 10 mensajes por ventana de 1 min |
| Hooks bloqueantes ralentizan startup | Async fire-and-forget; deadline 50ms |
| Prompt injection cross-session | Inbox messages tratados como DATOS, no instrucciones (guard-rail global ya cubre) |
| BOM en sessions.json (PowerShell) | utf-8-sig tolerante (lección aprendida en hardening) |

---

## v15.2 · SUPERVISOR DAEMON

### Definición
Daemon long-running que lee `~/.ultron/queue.jsonl` y lanza sesiones Claude
Code mediante `claude -p "<prompt>"` con captura de stdout/stderr a logs.

### Por qué
Petición explícita: *"Lanzar instancias de Claude Code en el portátil con
acceso a todas las skills"*. El supervisor es el ejecutor que materializa
las tareas encoladas.

### Componentes

1. **Queue schema** (1 h)
   - `~/.ultron/queue.jsonl` append-only
   - Entry: `{task_id, prompt, priority, max_tokens, depends_on?, requested_by, requested_at, status}`
   - Status: `pending` → `running` → `done` | `failed` | `cancelled`

2. **MVP daemon** (6-8 h)
   - Polling de queue cada 5 s
   - Lanza `claude -p "<prompt>"` un task a la vez (concurrency=1 inicial)
   - Captura output a `~/.ultron/sessions/<task_id>.log`
   - Update status en queue + emite evento al bus al terminar

3. **Concurrency** (4-6 h)
   - Pool configurable, default `max_concurrent=3`
   - Lock por queue para evitar tomar misma task dos veces

4. **Reintentos** (2-3 h)
   - Si task falla con código != 0 y no es timeout → reintentar con backoff
     exponencial (60s, 5min, 30min)
   - Max 3 intentos; tras 3 fallos → status=failed con razón en notes

5. **Heartbeat al bus** (1-2 h)
   - Cada N segundos el supervisor actualiza su entry en `sessions.json`
     con `current_task_id` y `tasks_completed_today`

6. **TUI panel "Active sessions"** (4-6 h)
   - Pantalla nueva en TUI que lista tasks pending + running + recent done
   - Botón cancel por task (matar proceso)

7. **CLI commands** (2 h)
   - `ultron remote start` / `stop` / `status`
   - `ultron remote enqueue "<prompt>" [--priority high] [--depends-on X,Y]`
   - `ultron remote tail <task_id>` (sigue log live)

8. **Tests** (4-5 h)
   - Mocking de `claude -p` con script fake
   - Cobertura: enqueue → run → output capturado → bus event

### Acceptance criteria
- [ ] `ultron remote start` lanza daemon como background process
- [ ] `ultron remote enqueue "echo hello"` se ejecuta en <10 s
- [ ] Output del task quedan en `sessions/<id>.log` + accesible vía `tail`
- [ ] Bus recibe evento `task.done` cuando termina
- [ ] Concurrency=3 demuestra ejecución paralela en test e2e
- [ ] Reintento con backoff funciona en task que falla la primera vez

### Riesgos
| Risk | Mitigación |
|---|---|
| Runaway loop consume miles de tokens | Hard cap `max_tokens_per_task` + alerta blocking si se cruza |
| Daemon crashea silenciosamente | systemd-style restart o watchdog en cron |
| Task colisiona con sesión interactiva del usuario | Priorizar interactiva (heartbeat reciente) y throttle background |

---

## v15.3 · PIPELINE DAG

### Definición
Capa encima del supervisor: permite definir trabajos con dependencias en
formato YAML y que el supervisor los ejecute en el orden topológico correcto.

### Por qué
Permite encadenar tareas tipo *"investiga X → cuando termine, implementa Y
basándote en X → cuando esté implementado, revísalo"* sin intervención humana.

### Formato de pipeline
```yaml
# ~/.ultron/pipelines/overnight-research.yaml
name: overnight-research-implement-review
version: 1
tasks:
  - id: research-X
    prompt_file: prompts/research-X.md
    max_tokens: 5000
    risk: medium

  - id: implement-Y
    depends_on: [research-X]
    prompt_template: |
      Basándote en {{ research-X.output }}, implementa Y.
    max_tokens: 10000
    risk: high

  - id: review-Z
    depends_on: [implement-Y]
    prompt_template: "Revisa {{ implement-Y.output }} y emite veredicto."
    max_tokens: 3000
    risk: medium
```

### Componentes

1. **Parser YAML + validación schema** (3-4 h)
2. **DAG topological sort** (2-3 h)
3. **Variable substitution** (`{{ task.output }}`) (3 h)
4. **Failure policies** (3 h): on_fail: abort | continue | retry
5. **Persistencia de estado** (3 h): `~/.ultron/pipelines/<name>/state.json`
   con cada task progress; permite resume si se interrumpe
6. **CLI** (2 h): `ultron pipeline run <yaml>`, `status <name>`, `resume <name>`
7. **TUI panel** (4-6 h): grafo visual de dependencias + estado actual
8. **Tests** (4-5 h)

### Acceptance criteria
- [ ] Pipeline 3-task con dependencias completa en orden correcto
- [ ] Si paso 2 falla → paso 3 NO arranca (a menos on_fail=continue)
- [ ] Resume tras kill recupera desde último completado
- [ ] Variable substitution tira del log del task previo
- [ ] Schema YAML estricto rechaza pipelines malformados

### Riesgos
| Risk | Mitigación |
|---|---|
| Cycle en DAG (A depende B, B depende A) | Detección topo-sort previa al run |
| Task X.output muy largo no cabe en prompt template | Truncate con marker `...[N chars omitidos]` + alerta |
| State.json corrupto deja pipeline zombie | Validación al arrancar; offer reset |

---

## v15.4 · OVERNIGHT LOOP

### Definición
Wrapper sobre supervisor + pipeline con safety rails fuertes diseñado para
correr sesiones desatendidas durante horas (típicamente noche).

### Por qué
Petición explícita: *"Quédate toda la noche trabajando"*. Sin safety rails
robustos esto es un agujero de presupuesto y un riesgo de runaway.

### Modelo de uso
```
ultron overnight start --until 08:00 --max-sessions 50 --max-tokens 1000000

Hard caps:
  --max-sessions-per-hour 6           evita runaway loops
  --max-tokens-per-session 50000      protege presupuesto
  --kill-switch-file ~/.ultron/STOP   crear este archivo aborta inmediatamente
  --notify ntfy:USER-overnight     canal para push notifications
```

### Componentes

1. **CLI + parser de tiempos** (2 h): hora absoluta, duración, hasta-tal-condición
2. **Hard caps + monitores** (4-6 h)
   - Tokens consumidos por hora
   - Sesiones lanzadas por hora
   - Detección de "actividad sospechosa" (>10 calls iguales en 5 min = loop)
3. **Kill switch** (2 h)
   - File-watch de `~/.ultron/STOP` (touch lo crea, cualquier edit lo activa)
   - Hard interrupt vía SIGTERM al supervisor
4. **Notify integration** (2-3 h)
   - ntfy.sh (gratis, self-hostable) como default
   - Eventos: `start`, `task.done`, `task.failed`, `caps.reached`, `end`
5. **Daily report generator** (3-4 h)
   - Al amanecer (o tras `--until`): genera markdown en
     `~/.ultron/sessions/YYYY-MM-DD-overnight-report.md`
   - Resumen: tasks completadas, fallidas, tokens consumidos, hallazgos relevantes,
     items propuestos al backlog
6. **Auto-promote a backlog** (2 h)
   - Si una task overnight produce output con marcador `<<TODO>> ...` → auto
     `ultron plans add` con `--producer overnight-loop`
7. **Tests** (3-4 h)
   - Mock de `time.sleep` y monitor de caps
   - Verifica kill-switch corta inmediatamente

### Acceptance criteria
- [ ] `ultron overnight start --until 08:00` arranca y respeta hora
- [ ] `touch ~/.ultron/STOP` aborta dentro de 30 s
- [ ] Cap `--max-sessions-per-hour` respetado en stress test
- [ ] Notify llega al móvil cuando termina cada task
- [ ] Daily report contiene resumen completo y items auto-promoted
- [ ] Si una sesión runaway → activity monitor la mata

### Riesgos
| Risk | Mitigación |
|---|---|
| Token burn descontrolado | Hard caps obligatorios; sin override por flag |
| Sistema queda bloqueado tras kill-switch | Cleanup automático al detectar STOP file |
| Daily report inunda vault con contenido irrelevante | Filtro por threshold de utilidad antes de auto-promote |

---

## v15.5 · MOBILE REMOTE (PWA)

### Definición
Aplicación web instalable en Android/iOS que se conecta al portátil del
usuario vía Tailscale tunnel y permite encolar tareas, ver sesiones activas
en streaming y recibir notificaciones cuando terminan.

### Por qué
Petición prioritaria: *"poder programar desde el móvil"* + *"lanzar instancias
de Claude Code en el portátil con acceso a todas las skills desde un entorno
externo"*.

### Arquitectura
```
Phone (PWA)  ──HTTPS──►  Tailscale tunnel  ──►  FastAPI local (port 7400)
                                                  │
                                                  ├── POST /enqueue
                                                  ├── GET  /sessions/active
                                                  ├── GET  /tail/<session_id>
                                                  └── WS   /stream/<session_id>
```

### MVP (v15.5.0) — 29 h

| Componente | Effort | Descripción |
|---|---|---|
| Mailbox file-based simple | 4 h | Sin MCP server formal — file polling. Reusa el queue.jsonl de v15.2 |
| Supervisor minimal | 6 h | Polling + lanzar `claude -p` (depende v15.2) |
| FastAPI con 4 endpoints | 6 h | `POST /enqueue`, `GET /sessions/active`, `GET /tail/<id>`, `WS /stream/<id>` |
| PWA Next.js mínima | 10 h | 3 pantallas: enqueue (form + voice), watch (live tail), history |
| Push notifications (ntfy.sh) | 2 h | Al móvil cuando termina cada task |
| Voice-to-prompt | 1 h | Web Speech API browser-native |

### Versión completa (v15.5.1) — restante

- Dashboard métricas (tokens consumidos, sesiones por día, success rate)
- Cancel task desde móvil
- Visualización de pipelines DAG en marcha
- Settings: editar caps, kill-switch global, profile per-task
- Offline mode: si Tailscale cae, encola localmente y sync al volver

### Stack técnico
- Backend: **FastAPI** + **uvicorn** + **websockets**
- Frontend: **Next.js 15** + **Tailwind** + **shadcn/ui** + **PWA manifest**
- Auth: **Tailscale identity** (ya autentica el dispositivo del user)
- Tunnel: **Tailscale** (free tier suficiente para uso personal)
- Push: **ntfy.sh** (gratis, self-hostable como fallback)

### Acceptance criteria (MVP)
- [ ] PWA instalable en Android desde browser
- [ ] Voice prompt → enqueue → ejecución en portátil → push notification
- [ ] Live streaming de stdout funciona con latencia <2 s
- [ ] Funciona desde fuera de casa (Tailscale conecta)
- [ ] PIN/biometría protege acceso

### Riesgos
| Risk | Mitigación |
|---|---|
| Tailscale latencia alta en 4G | Async polling + WS con reconnect |
| PWA no se instala en iOS | Documentar limitaciones; alternativa: Telegram bot |
| Voice-to-text falla con ruido | Fallback a teclado siempre disponible |
| Token hijack si PWA queda con sesión | Tailscale identity expira; require re-auth periódico |

---

## v15.6 · WEB SHOWCASE REFRESH

### Definición
Refresh completo del sitio estático en `~/.ultron/web/` con rediseño visual
top-tier por la skill **mike-tyson**, traducción a español y pipeline de
auto-actualización desde el sistema.

### Por qué
La web actual está desactualizada (cifras v14.8.0 hardcoded) y en inglés.
Sirve como showcase del sistema — no para vender, sino para presentar.
Restricción explícita: **NO precios, NO planes de pago, NO commerce**.

### Pipeline de auto-actualización
```
ultron doctor --json + brain stats + git log + plans status
            ↓
        render.py (Jinja2)
            ↓
    ~/.ultron/web/index.html (regenerado)
            ↓
        git commit + push (manual o cron)
            ↓
    GitHub Pages serve
```

### Secciones que faltan (descubiertas por análisis 2026-05-09)
- PI013 detector (Morse + zero-width Unicode)
- `ultron plans` CLI
- `ultron gemini` wrapper
- `constitution.json` 14 personas
- Backup mirror system (D:\)
- Mobile/remote roadmap (preview de v15.5)

### Componentes

1. **Diseño con mike-tyson** (3-4 h)
   - Skill mike-tyson genera spec visual: tipografía, paleta, layout
   - Componentes: hero, capabilities grid, architecture diagram, specs table, security
2. **Traducción ES** (1 h)
   - Todas las secciones excepto code blocks técnicos
3. **Auto-update pipeline** (2-3 h)
   - `scripts/cockpit/render_web.py` con plantilla Jinja2
   - Lee fuentes estructuradas: `doctor.json`, `brain stats`, `git log --oneline`
   - Output: `index.html` regenerable
4. **Cron / manual trigger** (1 h)
   - `ultron web render` comando
   - Cron weekly opcional con notify si cambia >5%
5. **Cleanup** (1 h)
   - Decisión D-15-4: borrar `index.html.bak` o mantener; default mantener solo en git history

### Acceptance criteria
- [ ] `ultron web render` regenera `index.html` con datos actuales
- [ ] Sitio en español 100%
- [ ] Diseño aprobado por mike-tyson skill (sin warnings de jerarquía visual)
- [ ] Datos hardcoded eliminados — todos vienen de fuentes vivas
- [ ] Lighthouse score ≥ 90 (perf, a11y, SEO)
- [ ] Mobile responsive (tested en Chrome devtools)

### Decisión a tomar
| ID | Decisión | Default propuesto |
|---|---|---|
| D-15-4 | `index.html.bak` mantener vs limpiar | Limpiar — git history ya conserva |

### Riesgos
| Risk | Mitigación |
|---|---|
| Auto-render rompe sintaxis HTML | Validar con `tidy -e` post-render; si falla, mantener anterior |
| Datos sensibles del sistema acaban en web | Sanitizer dedicado: filter por allowlist de campos públicos |
| Diseño mike-tyson demasiado experimental | Iterar con 3-5 propuestas antes de freeze |

---

## v15.7 · ANTI-HALLUCINATION LAYER

### Definición
Capa de detección y mitigación de alucinaciones aplicada al sistema ULTRON,
basada en el estado del arte 2025-2026: semantic entropy, cross-model peer
verification, provenance enforcement, execution grounding y janus pattern
entre personas.

### Por qué
La memoria persistente y la toma de decisiones autónoma (overnight, mobile
remote) amplifican el impacto de cualquier alucinación. Sin esta capa, una
alucinación puede entrar al vault y propagarse a sesiones futuras.

### Filosofía: enrutamiento por riesgo
NO aplicar siempre. Las técnicas anti-alucinación cuestan 3-10× más tokens.
Estrategia: classify task → if high-risk → activate full layer; if low-risk →
generate directly.

### Las 5 fases (12-18 h total)

#### Phase 0 — Risk classifier (2-3 h)
Extender `intent-dispatcher.py` con campo `risk_level ∈ {low, medium, high, critical}`
basado en skill destino + tipo de operación.

```
risk=low      tolkien, manolo-lama, mike-tyson sin código
risk=medium   einstein, novalbos, repo-evaluator (factual research)
risk=high     alfred, terry+commit, pana+email-send, warren (effects)
risk=critical security-review, financial transactions, deletions
```

#### Phase 1 — Semantic Entropy Probe (3-4 h)
Hook post-prompt para `risk=high+`: pide n=3 respuestas con temperature 0.9,
embeddings con MPNet, calcula varianza semántica. Si > 0.4 → activa `/triple`
mode automáticamente.

#### Phase 2 — Provenance Enforcement (2-3 h)
Forzar `source_uri` + `timestamp` + `extracted_by` en cada entry de vault.
Reconciliation loop al detectar contradicción semántica entre entries.

#### Phase 3 — Cross-Persona Janus Hook (3-4 h)
Para `risk >= medium`: output de persona "investigador" pasa por persona
"linter/crítica" antes de mostrarse. Mapping en constitution.json.

```
einstein     → repo-evaluator (rigor académico)
novalbos     → terry-davis (corrección técnica)
warren       → tio-gilito (consistencia financiera)
profesor-fisica → einstein (validación cruzada)
```

#### Phase 4 — Execution Grounding (2-3 h)
Para terry/novalbos cuando editan código: hook PostToolUse que verifica
sintaxis (linter), imports válidos, flags CLI existentes (`<comando> --help`),
TDD enforcement.

#### Phase 5 — Intent-Based Gate (2-3 h)
Pegamento que activa el subset correcto de Phases 1-4 según `risk_level`.

```
risk=low       → nada (generación directa)
risk=medium    → Phase 1 + 2
risk=high      → Phases 1+2+3
risk=critical  → Phases 1+2+3+4 + auto-/triple
```

### Acceptance criteria
- [ ] Risk classifier acierta ≥90% en corpus de 30+ pares
- [ ] Entropy probe se dispara solo en risk=high (no FP medible)
- [ ] Provenance bloquea entries malformadas en vault
- [ ] Janus produce critique útil >70% (juicio USER)
- [ ] Execution grounding caza ≥5 hallucinated flags/imports en corpus adversarial
- [ ] Latencia añadida en risk=low: ~0 ms
- [ ] Latencia añadida en risk=high: <2× baseline
- [ ] Suite tests pasa 100% sin regresiones

### Riesgos
| Risk | Mitigación |
|---|---|
| Probe demasiado caro en uso normal | Solo en risk=high+; cachear embeddings |
| Janus → bucle infinito (critic critica al critic) | Hard cap: una sola pasada |
| False positives bloquean trabajo | Soft warning, nunca abort. Bypass flag disponible |
| Provenance schema rompe vault legacy | Backward-compat con `source_uri="legacy"` |
| Risk classifier mal calibrado | Telemetría `~/.ultron/.tmp/risk-decisions.jsonl` para auto-tune |

### Métricas de éxito
```
Pre-v15.7 (baseline a establecer):
  - false claims/100 turns: a medir
  - tool hallucinations/100 calls: a medir
  - memory contradictions/week: a medir

Post-v15.7 target:
  - false claims/100 turns: ↓50%
  - tool hallucinations/100 calls: ↓80% (con Phase 4)
  - memory contradictions/week: ↓90% (con Phase 2)
```

### Spec completa
`~/.ultron/plans/specs/v15.7-anti-hallucination.md`

### Investigación base
`~/.ultron-vault/10_KNOWLEDGE/anti-hallucination-techniques.md`

---

# III · INVESTIGACIÓN APLICADA

## III.1 Mapping del estado del arte 2025-2026 a ULTRON

| Patrón industria 2026 | Estado en ULTRON | Sub-versión donde se aborda |
|---|---|---|
| Sistemas Operativos Cognitivos (COS) | ✅ arquitectura es esto | — (heredado v14) |
| LangGraph estado-grafo | ❌ dispatcher flat 56-rules | v15.3 PIPELINE acerca |
| CrewAI A2A protocol | ⚠ hooks proto-bus | v15.1 BUS lo formaliza |
| Smol Agents code-as-action | ❌ tools-as-JSON | Out of scope |
| L0/L1/L2/L3 memoria | ✅ implementado | — |
| L4 procedimental | ❌ no existe | Sprint propio futuro (v16+) |
| Sleep Pattern (consolidación L1→L2) | ⚠ `decay_queue` base | Sprint propio futuro (v16+) |
| MCP universal | ✅ 9 MCPs activos | — |
| Progressive tool-search | ❌ tools cargadas siempre | v15.7 puede tocar |
| Tailscale + home server | ❌ aún no | v15.5 lo trae |
| Voice-to-Intent local | ❌ aún no | v15.5 con Web Speech API |
| Push notifications móvil | ❌ aún no | v15.4 + v15.5 |
| Semantic Entropy | ❌ aún no | v15.7 Phase 1 |
| Cross-model verification | ⚠ /dual /triple manual | v15.7 Phase 3 lo automatiza |
| Provenance tracking | ⚠ skill-provenance.json existe | v15.7 Phase 2 lo extiende a vault |

## III.2 Lecciones críticas reportadas (industria 2025-2026)

| Pitfall | Cómo se aplica en ULTRON v15 |
|---|---|
| Context Drift en sesiones largas | Checkpointing en v15.4 OVERNIGHT |
| Memory Bloat sin consolidación | Sprint propio post-v15 (consolidación L1→L2) |
| Tool Hallucination | v15.7 Phase 4 Execution Grounding |
| Runaway Loops | v15.4 hard caps + activity monitor |
| Token burn descontrolado | v15.2 max_tokens_per_task + v15.4 max_tokens_per_session |

## III.3 Documentos de investigación en vault
- `~/.ultron-vault/10_KNOWLEDGE/ai-systems-landscape.md` — panorama AI agentic 2025-2026
- `~/.ultron-vault/10_KNOWLEDGE/anti-hallucination-techniques.md` — técnicas SOTA antialucinación
- `~/.ultron-vault/70_ERRORS/intent-rules-keyword-traps.md` — antipatrones routing
- `~/.ultron-vault/70_ERRORS/powershell-if-array-unwrap.md` — antipatrones PowerShell

---

# IV · ROADMAP DE EJECUCIÓN

## IV.1 Bloque A — Cierre técnico (16-23 h)

```
1. v14.9-structure       2-3 h    desbloquea v15.0 (estructura limpia)
2. v15.0-installer       10-14 h  package + sanitize + install
3. v15.6-web-refresh     6-10 h   showcase con datos auto-actualizables
```

**Por qué este orden:** v14.9 es prerequisito hard de v15.0 (no se puede
empaquetar lo que no está limpio). v15.6 va al final del bloque para que la
web ya muestre la estructura post-migración.

**Checkpoint A:** ULTRON instalable desde GitHub + web showcase actualizable.

## IV.2 Bloque B — Automatización + remoto (136-184 h)

```
4. v15.1-bus-foundation    32-40 h  cimientos de comunicación
5. v15.2-supervisor        24-32 h  remote launch (depende v15.1)
6. v15.5-mobile MVP        ~29 h    móvil arranca pronto (subset de v15.5)
7. v15.3-pipeline          24-32 h  DAG dependencies (depende v15.2)
8. v15.4-overnight         16-24 h  loop nocturno (depende v15.2 + v15.3)
9. v15.5-mobile completo   resto    dashboard + cancel + DAG visual
```

**Por qué v15.5 MVP antes que v15.3-v15.4:** la investigación 2025-2026
indica que el valor real está en el cockpit móvil más que en pipelines
elaborados. MVP móvil con supervisor simple ya entrega lo principal del
caso de uso. DAG y overnight son optimizaciones posteriores.

**Checkpoint B:** Dictar tarea por voz desde móvil → ULTRON la ejecuta en el
portátil → notificación móvil al terminar.

## IV.3 Bloque C — Calidad y robustez (12-18 h + polish opcional)

```
10. v15.7-anti-hallucination   12-18 h   capa de calidad sobre todo lo anterior
11. polish items (opcional)    14-24 h   hardenings y limpieza acumulada
```

**Por qué v15.7 va último:** las técnicas anti-hallucination cobran sentido
solo cuando hay infrastructure de la que verificar. Sin v15.1-v15.5, no hay
suficiente superficie de ataque para que la inversión rinda.

**Checkpoint C:** Sistema con auto-verificación, provenance completo, sin
deuda técnica conocida.

---

# V · DECISIONES PENDIENTES (D-IDs)

| ID | Decisión | Default propuesto | Bloquea |
|---|---|---|---|
| D-15-1 | Repo GitHub público vs privado | Public + MIT | v15.0 ship |
| D-15-2 | Apellido USER en commits | Sí | v15.0 polish |
| D-15-3 | Aceptar PRs externos | Sí, con CONTRIBUTING.md | v15.0 ship |
| D-15-4 | `index.html.bak` mantener | Limpiar (git lo conserva) | v15.6 |
| D-15-5 | Bus implementación | MCP server | v15.1 ship |
| D-15-6 | Push provider mobile | ntfy.sh (gratis) | v15.4 + v15.5 |
| D-15-7 | Mobile PWA vs nativa | PWA | v15.5 ship |
| D-15-8 | Risk classifier reglas iniciales | Por skill destino | v15.7 ship |

---

# VI · PROTOCOLO POR SPRINT

Cada sub-versión sigue el mismo protocolo de 5 fases:

```
DEV → TEST → QA → REV → RESOLVED
```

| Fase | Quién | Output |
|---|---|---|
| **DEV** | Claude (writer) | Implementación + spec ejecutable seguido al pie |
| **TEST** | Claude (test-engineer) | Test corpus que cubre acceptance criteria |
| **QA** | Claude (reviewer) | Confidence-filter sobre hallazgos críticos |
| **REV** | USER | Human gate: aprueba ship o pide cambios |
| **RESOLVED** | Claude (closer) | `ultron plans done <id>` + memoria al vault |

## Quality bar (todas las fases)
- TDD obligatorio: tests antes que implementación
- Suite global no debe regresar (≥99% pass)
- Cada bug detectado durante el sprint → entry en `~/.ultron-vault/70_ERRORS/`
- Ningún `--no-verify`, `--force-push`, `--dangerously-skip-permissions` salvo
  orden explícita
- Atomic commits + backup-before-destroy

---

# VII · INVENTARIO DE ARCHIVOS RELACIONADOS

```
~/.ultron/plans/
├── MEGA-PLAN-v15.md                          ← este archivo (entry point)
├── PLANS.json                                 ← fuente única (admin via `ultron plans`)
├── MASTER-pendientes.md                       ← render auto (no editar a mano)
├── 2026-05-09-v14.9-STRUCTURE.md              ← spec v14.9 estructural
├── specs/
│   ├── v15.0-installer.md                     ← spec v15.0
│   └── v15.7-anti-hallucination.md            ← spec v15.7
└── _archive/                                   ← planes superseded

~/.ultron-vault/
├── 10_KNOWLEDGE/
│   ├── ai-systems-landscape.md                ← research v15.1-v15.5
│   └── anti-hallucination-techniques.md       ← research v15.7
├── 70_ERRORS/                                  ← antipatrones a evitar
└── CC-memories/                                ← memorias bridged

~/.ultron/config/
├── constitution.json                          ← 14 personas + invariants
├── intent-rules.yaml                          ← 56 reglas dispatcher
├── skill-trust.yaml                           ← waivers
├── doctor-rules.yaml                          ← thresholds doctor
├── mcp-fallbacks.yaml                         ← qué hacer si MCP cae
├── schedule-config.json                       ← Backup-Weekly + Doctor-Weekly + ...
└── projects-exclusions.json                   ← scanner blacklist

~/.claude/skills/ultron/                       ← post-v14.9 SOLO definición
├── SKILL.md, mode-*.md, protocols.md, memory.md, CLAUDE.md
├── references/, agents/

~/.ultron/scripts/                             ← post-v14.9 código operativo
├── cockpit/                                    ← migrado desde .claude
└── hooks/                                      ← migrado desde .claude

~/.ultron/tests/                               ← post-v14.9 test suite migrada
```

---

# VIII · ARRANQUE DE SESIÓN

Procedimiento estándar para abrir una sesión nueva y empezar a trabajar:

```
1. Read ~/.ultron/plans/MEGA-PLAN-v15.md     (este archivo)
2. ultron plans status                        (snapshot del backlog)
3. ultron plans list --priority p1            (items prioritarios)
4. ultron health && ultron doctor --health-check
5. Decidir bloque (A / B / C)
6. ultron plans show <item-id>                (detalle del item)
7. Si tiene spec_path → leer spec
   Si NO tiene spec → escribir spec en specs/ ANTES de tocar código
8. Marcar in-progress (manual edit PLANS.json o vía CLI)
9. Trabajar con TDD obligatorio
10. Cerrar: ultron plans done <id> --note "<resumen + acceptance>"
11. Stop hook automatiza: brain_index update + vault sync + Qdrant embed
```

---

# IX · ITEMS EMERGENTES (sesión 2026-05-10)

Items añadidos al backlog (PLANS.json) durante la sesión de migración v14.9.
Cada uno con ID propio en `ultron plans show <id>`.

| ID en PLANS.json | Prioridad | Effort | Por qué surgió |
|---|---|---|---|
| `apps-inventory-script-tui-view-weekly-scheduler` | p2 | 2-3h | USER quiere control de programas instalados visible en TUI con auto-update semanal |
| `token-diet-skill-vault-qdrant-lazy-loading-mcp-tok` | **p1** | 12-18h | **v15.0b.** Overhead fijo ~56k → <22k. Causa raíz: 380 skills = 33.8k de metadata cargada siempre. Skill-vault + Qdrant lazy-loading + telemetría + MCP audit. Spec: `specs/v15.0b-token-diet.md`. **SUPERSEDE** `ultron-arranque-ligero-...` (deferred 2026-05-12 — sólo atacaba ~6k). |
| `memoria-automatizada-qdrant-embedding-pipeline-rec` | **p1** | 6-8h | `qdrant_storage` estaba vacío hasta hoy. Activar pipeline embedding + recall semántico + auto-MEMORY.md desde Qdrant top-N. Bloquea: necesita Docker+Qdrant live (CONFIRMADO operativo 2026-05-10). |

**Relación con sub-versiones existentes:**

- `token-diet` (v15.0b) y `memoria-automatizada-qdrant` son **prerequisitos blandos** de cualquier v15.x — reducen el coste por sesión de TODO el sistema. Ejecutar **antes de v15.1-bus** (el bus multiplica sesiones → multiplica el overhead fijo).
- `apps-inventory` es independiente del macro plan — encaja como polish entre sprints.

**Estado infra al cierre de sesión 2026-05-10 11:55:**

- ✅ Docker Desktop: running
- ✅ Container `ultron-qdrant` (qdrant/qdrant): UP
- ✅ Qdrant healthz: passed (localhost:6333)
- ✅ Collections: `ultron_skills`, `ultron_vault`
- ⚠ Volume: bind mount, no named volume — pipeline embedding pendiente para poblarlo

---

*Macro Roadmap v15. Documento vivo: actualizar al avanzar sprints o al
añadir nuevas direcciones. Cuando esté completo (todos los items resueltos),
archivar a `_archive/` y abrir el roadmap v16.*
