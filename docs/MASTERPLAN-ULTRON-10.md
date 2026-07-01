# MASTERPLAN — ULTRON a 10/10

> **Qué es esto.** El prompt maestro de trabajo. Forjado el 2026-06-26 desde un mapa de 6 frentes,
> **reconciliado el 2026-06-26 (tarde) contra el estado VIVO en runtime** (workflow de 6 verificadores
> read-only) para no replanificar lo ya hecho ni perseguir afirmaciones falsas. **No se ejecuta de una
> pasada** — son horas/varias sesiones. Cada sesión coge la siguiente casilla `☐` de la fase activa,
> la cierra entera (con su verificación y su check Kirkardo conductual), y para. Incremental, un ítem y checkpoint.
>
> **Cómo se arranca.** "Abre `docs/MASTERPLAN-ULTRON-10.md`, retoma la primera casilla `☐` sin cerrar de
> la fase activa, y ejecútala con el MÉTODO NUEVO de abajo."
>
> Glifos: `☐` pendiente · `◐` parcial / alcance corregido · `✅` hecho (verificado en runtime).

---

## Qué significa "10" (definición de hecho)

ULTRON es 10 cuando, **verificado en runtime**, cumple los 8 pilares:

1. **Contexto infinito sin gastar ventana** — recall híbrido que trae lo correcto y *poco* (con score-floor).
2. **Memoria viva** — se autogobierna: deduplica de verdad, **actualiza estado** (supersede), llena sus
   categorías y decide sola qué entra (cero cola manual, cero secretos/PII, cero duplicados).
3. **Ahorro de tokens medido** — cifra real publicada, no estimada.
4. **Orquestación medida** — subagentes que se lanzan y cuyo uso real se mide (telemetría → consumo).
5. **Prompt-improver + auto-skill + auto-orquestación** — detección correcta, sin no-ops.
6. **Interfaz sin cáscaras** — cada panel hace lo que dice **y dice la verdad de su estado** (o explica por qué no).
7. **Kirkardo conductual y honesto** — "verde" = "se comporta"; el medidor no se autoengaña con runs parciales.
8. **Legible y vendible** — el usuario entiende el sistema entero; la web lo explica de verdad (sin cifras infladas).

---

## MÉTODO NUEVO (obligatorio en cada casilla, sin excepción)

1. **Entender** — verificar el estado real en runtime/disco antes de tocar (no claims).
2. **Arreglar / mejorar.**
3. **Explicárselo al usuario** — el porqué, denso, para que pueda decidir con criterio.
4. **Actualizar web técnica / docs** — el cambio queda legible (esto es lo que lo hace vendible).
5. **Verificar** — runtime + `cargo`/`tsc`/build verde + **un check Kirkardo conductual** que falle SIN el fix.

Reglas de oro: **medición primero**; binario fresco = aplicado (**cerrar la app antes de buildear Rust**);
nada sin cablear; 0 PII/secretos en repo público; prohibido el no-op silencioso; **declara el alcance real**.

> **⏸ HOLD WEB (decisión del usuario 2026-06-26):** `docs/web/index.html` NO se toca ni se commitea hasta tener TODO
> acabado. Durante las fases, el paso 4 del método ("actualizar web/docs") se aplica **solo a docs internos**
> (GOAL/README/INTEGRATION/COMMANDS); la **web pública se construye al final** (casilla 4.1). Esto congela 0.1.

---

## YA EJECUTADO (06-25, en `main`, SIN push) — no rehacer

- ✅ **PII cerrada de raíz** (`a275aca`): detector PII completo (email/tel/ruta, no solo credenciales) en
  `redaction.rs`; redacta en **read-path** (`engine.rs:149-155`, el summary inyectado) **y write-path**
  (`candidates.rs:104-116`); 3 items PII purgados (`7cd41c41`/`84afaee2` ya no existen ni se recallan); 9 tests verdes.
- ✅ **Stale-binary** cerrado (`cp target/release → bin/`): cat7 6.7→7.78.
- ✅ **SessionStart vivo** (`3adc4fb`): el resume inyecta nota del harness, `head` real (branch+sha) y
  `startup_policy` imperativa. *(Ojo: ahora propaga el "10" falso del harness — ver 0.4.)*
- ✅ **Cross-project dedup** (`fd61592`): no re-inyecta el MEMORY.md del cwd (~398 tok/sesión).
- ✅ **Directiva canónica de delegación** (`22e7103`): la orden "DELEGA" ancla al especialista canónico del intent.

---

## MAPA VERIFICADO EN RUNTIME (2026-06-26 · el porqué de cada fase)

- **Memoria — gobernanza pasiva, confirmada HOY:** dedup **advisory** (`candidates.rs:43-79` solo setea
  `recommended_action=Merge`; `auto_approve.rs:189-195` `candidate_is_clean` **ignora duplicados**) →
  **101 grupos de content_hash activos, uno (`78daab37`) con 211 copias** (332 redundantes; sesga el recall
  RRF con 211 hits idénticos). `supersede()` (`mutations.rs:306`) **0 callers** → estado nunca se actualiza solo.
  Threshold por defecto **0.85 inalcanzable** (techo de `derive_confidence` ~0.76) → auto-approve es código
  muerto para captura. **5 categorías vacías** (`user_profile`/`skill`/`architecture`/`tool_usage`/`workflow_state`)
  por falta de productor. *(→ 1.4 HECHO: user_profile poblado; tool_usage/workflow_state retirados del enum;
  skill/architecture conservados por tener productor vivo — enum a 12 variantes.)* **NUEVO:** los 478 `codebase_fact` están **todos deprecated** (0 activos) → se capturan
  pero no entran a recall (mand. 12). *(→ 1.5 HECHO: el productor murió en el bulk-deprecate del 06-07; ya NO se
  capturan; el codegraph se consume por el MCP + `codegraph_summary`, no por brain.db.)*
- **Hooks — la superficie REAL es ~30 eventos (el usuario tenía razón; mi verificador se equivocó):** Claude Code
  soporta **~30 tipos de evento de hook** — SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse,
  PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay,
  SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded,
  ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation,
  ElicitationResult, SessionEnd (ver [[claude-code-hook-events-30]]). El verificador confundió "los que aparecen
  *usados* en disco" (~9) con "los que *existen*" (~30) → conclusión errónea "solo 9". **Hay que separar 3 cifras:**
  (1) tipos que Claude Code soporta = **~30**; (2) tipos que **ULTRON cablea = ~9** (SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse, SessionEnd, PreCompact, SubagentStop, Notification, Stop) → usa **<1/3 de la superficie**;
  (3) los **"~75 hooks" de Library = conteo INFLADO**, no tipos — `discover_plugin_hooks` (`io.rs:105-164`) aplana
  TODOS los `hooks.json` de plugins **cacheados** marcándolos `enabled=true` **sin consultar `enabledPlugins`**, así
  los ~28 hooks de `ecc@ecc` (**deshabilitado**) + versiones duplicadas (superpowers 5.0.7+6.0.3) salen como activos.
  La pestaña Hooks (`EVENT_OPTIONS`, `constants.ts:3-13`) **solo modela 9** → no se pueden ver ni crear hooks de los
  ~21 restantes. Oportunidad enorme sin tocar: `SubagentStart/Stop` (Monitor en vivo), `PostToolUseFailure` (captura
  de errores), `TaskCreated/Completed` (kanban auto-crea), `FileChanged` (link doc↔código), `CwdChanged`, `InstructionsLoaded`.
- **Agentes — telemetría SÍ existe (el plan decía CERO):** `.tmp/subagent-harvest.jsonl` (**1066 filas, viva hoy**)
  captura `{agent, chars, preview}` por invocación, pero la atribución es ruidosa (239 `unknown`; dominan wrappers
  `workflow-subagent`/`general-purpose`, no el especialista) y **nadie la consume**. `dispatcher-events.jsonl` está
  **MUERTO desde 2026-05-22** (registra solo skills). 78 agentes registrados en `~/.claude/agents/`; el resto
  (caché de plugins, 690 .md de ECC, 21 variantes de `code-reviewer`) es **inerte** — no se poda ([[no-podar-catalogo-skills]]),
  el problema es de conteo honesto.
- **Skills — v3 sin cablear:** `settings.json` invoca `routing-dispatcher.v2.js` (determinista, acc@3=100%, 26/0 verde).
  El **v3 semántico** solo lo invoca `_accuracy_at3.js --v3` (diagnóstico que **no gatea exit code**) → puede romperse
  en silencio; **no hay fallback v2→v3**. Las "huérfanas" (`ui-ux-pro-max`/`gamedev-engineer`/`business-strategist`)
  son no-inyectables-lazy pero su intent **sí está cubierto** por personas (mike-tyson/don-claudio/jordan) y la skill
  activa `ui-designer`. La skill activa `ultron` arrastra catálogo stale ("78 agents/79 skills", fechado 05-27).
- **Interfaz — menos cáscaras de lo temido:** Monitor "resumen" = 200 chars truncados (`session_jsonl.rs:24`, sin
  `route('summarize')`) → **cáscara real**. Pero **kanban CREA cards** (`kanban_create_card`+`CardEditorModal`),
  **botón lanzar-en-carpeta existe** (`spawn_session(cwd)`+`openDialog{directory}`), **AI Router UI llama `route()`**
  (múltiples callers, dashboard con métricas reales), **Learn.tsx sin refs Gemini/dual/triple**, **Batch** (no
  "RunBatch") cableado en varias superficies. Repo-panel spawnea `git.exe` por llamada (sin caché/git2).
- **Honestidad / medidor / limpieza:** `logs/kirkardo-eval.json` está **CONTAMINADO** por un run `--cat=19`
  (overall=10, core=0, 1 cat de 22) → el resume propaga "10" como si fuera nota de sistema; el run completo real
  = **7.95**. `--gate` **no es default** (CI pasa verde con laggards). La web (sin commitear) muestra **9.63** (también
  irreal) y afirma **recall@8 ≥ 0.95** mientras el oráculo externo mide **0.73** (×2 sitios). Fantasmas: `gemini_cli.py`
  no existe pero se llama (`run-inline.ps1:95`, `ultron.ps1:429`); stubs Mem0 intactos (`StoreKind::Mem0`,
  `Mem0Entry`/`mem0_entries`, `.mem0-opt-out.json`, `.gitignore` con duplicados); **gemini CLOUD es fallback VIVO**
  (no tocar). Bloat: BGE-small 128MB + `.tmp` 28MB (ambos gitignored, borrado seguro).

---

# FASE 0 — Honestidad, medición y medidor (prerequisito · bajo riesgo · casi sin rebuild)

> Sin esto no se puede confiar, medir ni publicar. Va primero.

- ⏸ **0.1 Web honesta — CONGELADA (decisión 2026-06-26): no tocar ni commitear la web hasta el final; se retoma en 4.1.** La web (sin commitear) muestra **9.63** (irreal: el run completo es 7.95) y afirma
  **recall@8 ≥ 0.95** (×2: `index.html:442` y `:1383`) mientras el oráculo mide **0.73**. Reconciliar la nota
  con `overall_core`+`all_cats_pass` (o enlazar al harness) y bajar/calificar el claim de recall. *Hecho:*
  `grep -c "9.63\|9.31" docs/web/index.html` = 0 y ningún claim numérico contradice una medición. *(El claim de
  recall lo guarda la card `blocked` existente — no commitear la web hasta cerrarlo.)*
- ◐ **0.2 Refs rotas de gemini-CLI — call-sites RETIRADOS (2026-06-26).** ✅ Las dos invocaciones al inexistente
  `gemini_cli.py` (arm `gemini` en `scripts/cockpit/run-inline.ps1` y en `scripts/cockpit/ultron.ps1`) ahora fallan con
  error honesto "retirado" en vez de spawnear un script ausente (mand. 11). *Verificado:* `git grep gemini_cli` en
  `.ps1`/`.py` = 0 (los matches en Rust son los **guardas** `retire_gemini_cli`/`seed_zones_ship_no_dead_gemini_cli`,
  que 4.4 manda conservar); ambos `.ps1` parsean en PS 5.1. **NO se tocó el provider gemini cloud** (`seed.rs:66-81`, vivo).
  ☐ **Queda (→ 4.4):** `news_html_generator.py` usa gemini-CLI como **motor real** (`shutil.which('gemini')`, binario
  muerto) y `health.py` lo sondea → repuntar a proveedor vivo o marcar deprecado (necesita decidir proveedor).
- ✅ **0.3 Telemetría de agentes — consumo cableado + atribución mejorada (2026-06-26).** El dato ya se capturaba pero
  **nadie lo consumía** (mand. 12). Ahora: (a) `scripts/agent-usage.mjs` agrega el harvest → "agente X invocado N veces" +
  chars + última (real hoy: 861 invocaciones; workflow-subagent 562x, unknown 157x, rust-engineer 15x…); (b) atribución en
  `subagent-harvest.js` ampliada (camelCase + anidados) + captura `label` (desambigua wrappers genéricos) + diagnóstico
  `_keys` en los `unknown` (mand. 10). Check conductual `scripts/subagent-harvest.selftest.mjs` **7/7** (cazó las helpers
  sin cablear). **Residual (data-driven):** genéricos/unknown históricos sin label; confirmar que el payload real de
  SubagentStop trae `label`/especialista (lo revelará `_keys` en nuevas invocaciones) → luego 2.1 consume `agent-usage`.
  `dispatcher-events` murió el 05-22 (separado).
- ✅ **0.4 Kirkardo honesto — el medidor ya no se autoengaña (HECHO 2026-06-26).** El "10" era un artefacto: un run
  `--cat=19` pisaba `logs/kirkardo-eval.json`. **Cerrado:** (a) los runs `--cat` escriben `kirkardo-eval.scoped.json`
  con `scoped:true` y **no** tocan el canónico (`kirkardo-eval.mjs`); (b) **gate por defecto** (`--no-gate` opt-out) sobre
  los laggards reales — un run completo ahora **sale exit≠0** (verificado: exit 2); (c) el resume lidera con
  `all_cats_pass` + `overall_core` y **descarta** cualquier JSON `scoped` (`memory-session-resume.js readHarnessNote`).
  Run completo regenerado = **overall 7.59 / core 7.64 / all_cats_pass=FAIL** (112 checks, 22 cats; laggards cat21=0,
  cat20=3.3, cat8=3.3, cat1=3.3…). Check conductual: `scripts/kirkardo-eval.selftest.mjs` (11/11; falla con el código
  pre-fix). `GOAL.md` actualizado. *(La nota "9.63" de `docs/web/index.html` queda contradicha por el 7.59 → la corrige 0.1.)*
- ✅ **0.5 Memorias stale corregidas (2026-06-26).** Borrada `memory-hooks-not-versioned` (FALSA: `hooks/scripts/` tiene
  26 ficheros versionados, incl. `stop-compress-session.js`) + quitada del índice MEMORY.md. El `9.31` queda con caveat
  SUPERSEDED en la nota 06-24 (ya auto-corregida a 7.5 en su propia línea + audit 06-25 + resume vivo 7.59). Nota: las
  menciones "NO 9.31" del audit son **correctivas** → se conservan (por eso `grep 9.31 = 0` no es criterio válido).
  `cockpit/projects` untracked con contenidos gitignored = correcto, sin acción.
- ✅ **0.6 Auditoría REAL de hooks (~30 eventos) + la pestaña deja de mentir (HECHO 2026-06-26).** DOS cosas, no una. **(A) Tipos de
  evento:** ULTRON usa ~9 de ~30 ([[claude-code-hook-events-30]]); mapear evento→usado/sin-usar y **ampliar
  `EVENT_OPTIONS`** (`constants.ts:3-13`) para poder ver/crear los ~21 restantes (priorizando alto valor:
  SubagentStart/Stop, PostToolUseFailure, TaskCreated/Completed, FileChanged). **(B) Conteo de Library:** cruzar
  `discover_plugin_hooks` (`io.rs:105-164`) con `enabledPlugins` para marcar `inert/disabled` los hooks de plugins no
  activos (ECC sale activo siendo `false`, `settings.json:269`), deduplicar versiones cacheadas y separar contador
  user vs plugin → los "75" dejan de mentir. *Hecho:* tabla evento→usado/sin-usar de los ~30; la pestaña distingue
  activo de inerte y ofrece los eventos reales. Alimenta 3.2/3.9. Kirkardo 11.
  *Código HECHO + verificado (2026-06-26):* (A) `EVENT_OPTIONS` ampliado a 30 + colores (tsc 0 err); (B)
  `discover_plugin_hooks` cruza `enabledPlugins` (plugins off → hooks inertes) + 1 versión por plugin; **2 tests Rust
  verdes**, lib compila release. **HECHO: rebuild desplegado + verificación visual confirmada por el usuario** (~30
  eventos creables · ECC inerte · conteo baja). Separar contador user/plugin (B3) queda como display (campo `source`).

---

# FASE 1 — Memoria viva (el corazón · pilar #1 · Rust → cerrar app + rebuild)

> El salto de "acumula" a "se autogobierna y se actualiza". Lo que cumple tu "no acordarme de nada".

- ✅ **1.0 (P0 · NÚCLEO) Recall cross-project — read+write-path RESUELTOS (2026-06-26).** *Diagnóstico runtime
  2026-06-26 (sesión Oryntics del usuario):* **82% de memorias con `project_id=NULL`** (3086/3783); el recall
  **scoped a un proyecto FILTRA** todo lo no-coincidente → `recall --project ORYNTICS` devuelve **0** aunque hay **76
  memorias sobre Oryntics** — el recall GLOBAL las encuentra al instante (*"Oryntics es una empresa de soluciones con
  IA"*). Dos bugs que se componen: **(read-path, INMEDIATO)** cuando el scope de proyecto está vacío/escaso, fallback a
  globales/NULL de alta relevancia (o no hard-filtrar); **(write-path, durable)** taggear `project_id` real por
  **git-root** (no `basename(cwd)` → genera basura: el basename del home, "src", subdirs) + backfill de los 3086 NULL donde se infiera.
  *Hecho:* en una sesión de Oryntics, "busca info sobre Oryntics" inyecta la memoria real; check conductual: recall
  scoped a un proyecto sin memoria propia devuelve los hits globales relevantes (hoy: 0). **Es el fix de mayor impacto
  del plan — explica la decepción del usuario y el motivo real de que "todo parezca no servir".**
  *✅ HECHO read-path (2026-06-26):* items `project_id=NULL` = AMBIENTE → se inyectan bajo filtro de proyecto, como
  Global (`assemble_pack` admite `project_id.is_none()` + filtro denso Qdrant con `is_empty`). El gate solo excluye
  memorias de OTRO proyecto IDENTIFICADO; la relevancia da la precisión. **Verificado runtime:** recall scoped a
  ORYNTICS **0 → 8** (las 8 sobre Oryntics: *"empresa B2B de integración AI con dos clientes"*); ULTRON sigue trayendo
  lo suyo sin fugas; golden eval **recall@k 1.0**, 0 leaks; test `assemble_pack_admits_ambient_null_project_items`
  verde; sidecar redeployado. *✅ HECHO write-path (2026-06-26):* `emit_candidate` deriva `project_id` del **git-root
  del cwd** (normalizado, ".ultron"→"ultron") cuando el payload no lo trae — antes el flag `--project` se ignoraba →
  NULL. **Verificado runtime:** captura nueva desde ~/.ultron tagea `project:ultron` (antes NULL); robusto a subcarpetas;
  fuera de repo git → None (ambiente). Backfill de los 3086 NULL existentes: NO necesario (el read-path los trata como
  ambiente; el proyecto-origen no es inferible a posteriori).
- ✅ **1.1 Threshold alcanzable + invariante testado (HECHO 2026-06-26).** El default 0.85 era inalcanzable: el techo
  matemático de `derive_confidence` (`capture.rs:276-293`) es **0.762** (router + `llm_score=1.0`: `0.7·0.66+0.3·1.0`)
  → BAND A era código MUERTO para captura conversacional (todo fact del Stop-hook se quedaba en el inbox por limpio que
  fuera). *HECHO:* `DEFAULT_AUTO_APPROVE_THRESHOLD` 0.85→**0.72** (const en `auto_approve.rs`), triplemente acotado:
  `>0.70` (la confianza media/inferida sigue a BAND B) y `<0.762` (alcanzable) → ventana estrecha `[0.72,0.762]` que solo
  admite router-extracted con self-score ≥~0.86, limpio, no decision/architecture. Sigue OPT-IN (default OFF). Check
  conductual cross-module `capture.rs::factory_threshold_can_auto_approve_top_confidence_capture`: **ROJO sin el fix**
  (conf 0.762 < 0.85 → Pending), **VERDE con él** (→ Approve); ata el umbral al techo REAL productor, así que volver a
  subirlo por encima del techo lo rompe. Suite memory **215/215** (0 rotos); build release exit 0; sidecar redeployado
  (doctor: binario en uso == desplegado, recall@8=1.0, leaks=0). Verificación adversarial 3-lentes (0 bloqueantes; cazó
  y corrigió 2 comentarios stale: doc de `auto_approve_threshold` y la ruta inexistente "remember 0.9"). **ALCANCE REAL
  (mand. 13):** el `memory-settings.json` del usuario ya tiene `auto_approve:true, threshold:0.65` → el cambio del DEFAULT
  no altera SU runtime (su archivo manda); el valor es fresh-installs + el fallback de serde + el invariante anti-regresión.

> **Deuda de gobernanza detectada al cerrar 1.1 (verificación adversarial 3-lentes · NO bloqueante · fuera de 1.1).**
> Hacer BAND A alcanzable + el usuario con auto-approve ON (0.65) activa 3 fallos silenciosos PRE-EXISTENTES que el techo
> 0.762-vs-0.85 anestesiaba: (a) **contradiction-judge fail-open por timeout** (`candidates.rs:180-208`: en
> `RecvTimeoutError` solo añade tag `unjudged` y `contradiction_candidates` queda vacío → `candidate_is_clean=true`,
> una Fact que SÍ contradice un ACTIVE se auto-promueve bajo carga/429); (b) **dedup silent-on-error** (`candidates.rs:48,69`
> `if let Ok(..)` traga Err de FTS5/SQLite → puede regresar el bug 1.2 de las 211 copias ante fallo transitorio); (c)
> **cobertura PII más estrecha que credenciales** (`candidates.rs:87-97`: `proposed_text` excluye `proposed_content_json`
> y `proposed_tags` → PII solo en esos campos no marca `risk_level=secret`). El path conversacional NO popula esos campos,
> pero otras rutas a `create_candidate` (agentes/import) sí. **→ CERRADA en la casilla 1.7 (2026-06-26):
> write-path fail-closed end-to-end.**
- ✅ **1.2 Dedup ACTIVO — fuga de 211 copias CERRADA (2026-06-26).** En `create_candidate`, si hay `duplicate_candidates`: NO
  auto-aprobar (forzar Merge) **o** merge real (bump `access_count`/`importance` del existente). Añadir
  `!duplicate_candidates.is_empty()` a la negación de `candidate_is_clean` (`auto_approve.rs:189-195`). Backfill: colapsar
  los 101 grupos activos (empezar por `78daab37`=211). *✅ HECHO:* `candidate_is_clean` excluye duplicados (un duplicado
  va al inbox, NUNCA auto-active; test `candidate_with_duplicate_is_not_clean` verde). Backfill gobernado (forget de 332
  extras, conserva 1 por grupo, 0 fallos): **grupos duplicados activos 101 → 0**, "Fallo de WebFetch" 211→1, items
  3304→2978. Verificado runtime + doctor ok; sidecar redeployado.
- ✅ **1.3 supersede VIVO — (a) subcomando + (b) auto-trigger por contradicción HECHOS (corte seguro opt-in; 2026-07-01).**
  *✅ (a):* subcomando gobernado `ultron-memory supersede --old <id>` (viejo→Deprecated `superseded_by`/`valid_to=now`
  recuperable; nuevo→Active; recall prefiere el nuevo). *✅ (b) auto-trigger:* clasificador LLM de 3 salidas
  `classify_contradiction` (NoConflict/StateUpdate/RealConflict) reemplaza al juez booleano en `check`; decisión **PURA**
  `supersede_disposition` — CONSERVADORA: auto-supersede SOLO si hay **exactamente 1** finding `StateUpdate`; conflicto
  real, >1 finding, o flag OFF → **Quarantine** (como hoy). Cableado en `create_candidate`: si dispara, promueve el
  candidato a ACTIVE deprecando el viejo (reusa `cand.to_item` + `MemoryService::supersede`, con redaction/índice), en
  orden **fail-safe** (supersede primero; si falla, el candidato queda Pending — no se pierde ni corrompe nada).
  **Opt-in `auto_supersede` (default OFF)** en `memory-settings.json` → **cero riesgo** para la memoria viva hasta
  activarlo (mismo patrón que 1.1). **Verificado:** `cargo` 12/12 en `contradiction` (5 de `supersede_disposition`, con
  **3 casos negativos**: real-conflict / >1-finding / flag-OFF → Quarantine) + fail-safe del clasificador (blank→None).
  **ALCANCE REAL (mand. 13):** el clasificador LLM aún NO tiene eval de accuracy (state-update vs conflicto real) — por eso
  el flag va **default OFF**: encenderlo requiere ese eval (un state-update mal clasificado deprecaría memoria válida,
  reversible). La capacidad está construida y su LÓGICA probada; la confianza para activarla la da el eval (pendiente).
  **NO time-based** (decisión #1 resuelta: solo contradicciones de estado, no deprecación por "N días sin acceso").
- ✅ **1.4 user_profile poblado · tool_usage/workflow_state retirados · skill/architecture conservados (HECHO 2026-06-26).**
  Decisión #2 resuelta. *Diagnóstico runtime:* las 5 estaban a 0; el `extraction_prompt` (`capture.rs`) solo ofrecía al LLM
  `decision/preference/fact/constraint/task` → las otras nunca se emitían. **(A) user_profile POBLADO:** añadido al prompt
  con guía que lo distingue de `preference` (identidad/rol/forma-de-trabajar ESTABLE); el parser ya lo mapeaba; el match
  `type_base_importance` ya lo cubría (0.70). **(B) tool_usage + workflow_state RETIRADOS** (sin productor real): fuera del
  enum `MemoryType` (`model.rs`), del match (`capture.rs`) y del `TYPE_OPTIONS` del frontend (`MemoryBrowser.tsx`).
  **(C) skill + architecture CONSERVADOS:** tienen productor vivo — `skill` lo crea `post_install.rs` (registro de
  instalaciones de Library para routing), `architecture` lo usa `migrations.rs` (ETL kg) + `classify_band` (gobernanza);
  vacías por dormidas, no muertas. Checks conductuales (`capture.rs`): `prompt_offers_user_profile_type` (+ regresión: el
  prompt NO ofrece los retirados) y `retired_memory_types_no_longer_parse` (`parse("tool_usage"|"workflow_state")`==None;
  skill/architecture/user_profile siguen). Suite memory **217/217**; tsc 0; verificación adversarial 2-lentes (0
  bloqueantes; integridad=pass, retirada completa sin huérfanos; el struct `WorkflowState` de `workflow_runs.rs` es OTRO
  tipo, intacto). Sidecar redeployado. **ALCANCE REAL (mand. 13):** el productor de user_profile queda CABLEADO y testeado
  a nivel de contrato (offer + parse + match); la EMISIÓN real end-to-end (que el LLM extractor emita `kind=UserProfile`
  en una sesión con identidad) NO está medida con eval determinista — se observará en captura real. No se vende "se llena
  solo" como verificado.
- ✅ **1.5 `codebase_fact` — decisión #3: NO capturar (ya de facto) + guard de regresión (HECHO 2026-06-26).**
  *Diagnóstico runtime:* los 478 (413 `posttooluse_symbol` + 64 imports ETL + 1 test) se **deprecaron en masa** el
  2026-06-07 (evento `bulk-deprecate type=codebase_fact`, Kirkardo R5) y **el productor está MUERTO** — `capture-symbols.js`
  solo existe como propuesta en un audit (`audits/.../proposed-files/`), nunca cableado; ningún hook activo captura símbolos
  hoy. *Premisa corregida:* no es "se captura pero no se inyecta" → es "ya NO se captura, y NUNCA debe inyectarse al
  conversacional". El codegraph **sí tiene consumo real**, pero NO es brain.db: el **MCP codegraph** (sesiones CLI) +
  `codegraph_summary` (panel ProjectWorkspace). Reactivarlos sería deshacer R5 (saturaban el pack y expulsaban conocimiento
  real; `engine.rs:83-86` los excluye por diseño). *HECHO:* guard conductual
  `assemble_pack_excludes_codebase_fact_even_when_active` (`recall_unified/tests.rs`): un codebase_fact ACTIVE se descarta
  del pack (atribución explícita) mientras un Fact ACTIVE de control sí entra. **Caso negativo demostrado** (mand. 7):
  deshabilitada la exclusión en `engine.rs` el guard se pone ROJO; restaurada, VERDE. Suite recall_unified 11/11; sin
  cambio de comportamiento → sin rebuild. **Los 478 deprecated quedan para la limpieza física de 4.3** (no molestan al recall).
- ✅ **1.6 Secretos en prosa detectados (2026-06-26; PII ya estaba).** *HECHO:* Pass 3 en `redaction.rs`
  (`detect_prose_secrets`): keyword (clave/contraseña/password/token/secret…) + conector (es/son/:/=) + valor mixto
  **≥6 chars con dígito Y letra** (gate que evita falsos positivos en prosa). 28 tests verdes (positivo + negativo:
  "trabajar"/"simplicidad"/"constancia" NO se redactan). **Verificado runtime:** "la clave es Patata2024" → "la clave
  es [REDACTED:secret]" en el write-path. Sidecar redeployado.

- ✅ **1.7 (NUEVA) Write-path fail-CLOSED — 3 fugas de gobernanza cerradas (HECHO 2026-06-26).** Deuda detectada al
  cerrar 1.1: con auto-approve ON (el usuario lo tiene a 0.65) el write-path fallaba OPEN — cuando NO podía verificar,
  trataba al candidato como "clean" y lo auto-promovía a ACTIVE. **Mecanismo central:** `candidate_is_clean`
  (`auto_approve.rs`) rechaza candidatos con un `UNVERIFIED_TAGS` (`unjudged`/`dedup-unverified`, case-insensitive) →
  sin verdicto verificado, al inbox. **(a) contradicción fail-closed END-TO-END:** nueva
  `qdrant_index::search_dense_checked` → `Option` (None = Qdrant/E5 caído), `contradiction::check` → `Option<Vec>`, el
  match marca `unjudged` cuando la infra no verificó (5 ramas exhaustivas); además el juez usa summary **O content**
  (antes summary=None saltaba el detector sin marca). **(b) dedup fail-closed:** `search_items` y
  `find_active_by_content_hash` Err → `dedup-unverified` (antes el Err se tragaba → podía regresar el bug 1.2 de las 211
  copias). **(c) PII a paridad con credenciales:** `pii_scan_text` + redacción cubren ahora `content_json`, `tags` y
  `proposed_symbol` (antes excluidos → PII ahí no elevaba Secret). Checks conductuales: `unjudged`/`dedup-unverified`
  no-clean (rojo→verde), `pii_scan_covers_content_json_tags_and_symbol` (atado a `contains_pii`). Suite memory **221/221**;
  build release exit 0; sidecar redeployado. **Verificación adversarial:** workflow 2-lentes (cazó el fail-open residual
  de infra, cerrado) + rust-engineer (5 PASS, cazó el fail-open de summary=None, cerrado). *Residual declarado (mand. 13):*
  el juez-LLM-None sigue conservador (no marca); el fail-closed cubre la infra de BÚSQUEDA. *Falso positivo descartado:*
  "`redact_pii` destruye JSON" — usa offsets, no tokeniza por espacios.

> **Quitado de la lista de defectos:** "decisions siempre al inbox" (`auto_approve.rs:167-180`) es **intencional**
> (Decision/Architecture siempre necesitan ojo humano, testeado). No es bug; documentarlo como invariante de gobernanza.

---

# FASE 2 — Orquestación medida y honesta (depende de 0.3)

- ✅ **2.1 Consumir la telemetría de agentes — HECHO + VERIFICADO VISUALMENTE (2026-06-28).** El dato (1215 filas
  vivas en `.tmp/subagent-harvest.jsonl`) era huérfano: lo consumía solo el CLI `agent-usage.mjs`, **0 puntos de consumo
  en el producto** (codegraph confirmó cero `agent_usage` en la app → mand. 12). *Hecho:* comando Tauri
  `agent_usage_stats(project)` (`agent_orchestration/usage.rs`, **porta fielmente** la agregación de `agent-usage.mjs`:
  count/chars/last_ts/orden DESC/top-5 labels; fichero ausente → `Ok(vec![])`) cableado en `lib.rs` (mand. 4) + tira
  **"Uso real por agente"** en la pestaña Agents (`AgentUsageStrip.tsx`, gemela de `DelegationsStrip`, polling 30s).
  **Honestidad (mand. 13):** especialistas reales (rust-engineer, frontend-developer, Explore…) destacados; wrappers
  genéricos/`unknown` (capturas de sesión sin tipo de agente) agrupados, atenuados y colapsados con nota explícita;
  header declara alcance `· all projects`. Construido por workflow (rust-engineer ∥ react-specialist, contrato fijo) +
  **revisión adversarial de 3 lentes** (14 agentes; 10 hallazgos reales, 1 refutado). **7 fixes aplicados** tras la review:
  `agent=""`→`unknown` y `chars:null`→0 (fidelidad vs .mjs), tira fuera del ternario del filtro (no se desvanece al
  vaciar la rejilla, mand. 11), tooltip honesto (es SubagentStop=fin, no invocación), test hermético en Windows, + 2
  tests nuevos (líneas corruptas + fidelidad empty/null). **5 tests verdes**, `tsc` 0, `cargo` 0 warnings, `build:local`
  verde. *Residual declarado (mand. 13):* el diagnóstico `_keys` (firma de payloads `unknown`, ayuda de atribución) NO se
  portó a la UI — se queda en el CLI `agent-usage.mjs` (es herramienta de dev, no telemetría de producto). Pre-requisito
  0.3 estaba hecho. **Verificación visual confirmada por el usuario (2026-06-28)** (Agents → tira "Agent usage"; commit `88f0eb7`).
- ✅ **2.2 Plugins desactivados = inertes (HONESTO + ROUTING; alcance A elegido por el usuario · 2026-06-28).** Bug: ni
  `list_skills_with_origin_inner` ni `list_agents_with_origin_inner` cruzaban `enabledPlugins`, así que ECC (`ecc@ecc=false`,
  773 SKILL.md + 254 agentes en caché) surface sus items como **ACTIVOS**. *Hecho:* módulo compartido `plugin_state.rs`
  (`read_enabled_plugins` + `plugin_is_disabled`, clave `<plugin>@<marketplace>`) reusado por skills+agents
  (`enabled = sufijo && !plugin_disabled`; outer dir=marketplace, inner=plugin, igual que `discover_plugin_hooks`).
  **ALCANCE REAL (mand. 13 — la review adversarial cazó mi claim falso de "solo UI"):** `enabled` no solo pinta el conteo;
  lo leen 4 consumidores de routing — `index_skills`→`ultron_catalog` (orquestador `delegate_agents`),
  `index_skills_lazy`→payload, y los 2 roster-proposers. **El usuario eligió alcance A (inerte en TODO):** un plugin off
  tampoco compite en routing/recomendaciones (coherente con el diseño: `ultron_catalog`=enabled→routing,
  `ultron_skills_lazy`=todas→dispatcher lazy, que SIGUE inyectando ECC on-demand). **Purga del índice stale (finding 3):**
  `index_skills`/`index_agents` ahora hacen *sync* — `purge_orphans` (scroll+delete por entity; helper puro `orphan_ids`
  testeado; guardado por `ok>0` para no vaciar el índice en un pase transitorio) borra los puntos fuera del set vivo (ECC
  ya no se upsertea → se purga). Aplicado en runtime (`ultron-memory catalog` + `reindex-skills-lazy`). **Seguridad de ECC
  (petición del usuario):** auditoría adversarial de 10 agentes → **ECC LIMPIO** (0/5 amenazas confirmadas; sin exfiltración,
  secretos, persistencia ni escalada; los hits eran fetch/exec a petición explícita del usuario). Dejar en caché inerte
  (no podar — [[no-podar-catalogo-skills]]). **562 tests verdes** (`orphan_ids` + `plugin_state` nuevos), `cargo`/`tsc` 0,
  `build:local` + sidecar verdes. *Pendiente:* purga aplicada + verificación visual del usuario (Skills/Agents → ECC bajo Disabled).
- ✅ **2.3 No-op `rules.rs:645` — RESUELTO (premisa obsoleta).** `ui_design` alimenta correctamente el routing de SKILLS
  (`preferred_skills`→`rank_skills`→`SkillChoice`); la delegación usa `preferred_specialists` con agentes reales. La ref
  muerta agente↔skill ya se eliminó (documentado `ranking.rs:71-74`). Opcional: test de regresión para que no reaparezca.
- ✅ **2.4 Skills "huérfanas" NO lo están + catálogo stale del `ultron` corregido (HECHO 2026-06-28).** *Verificado en
  runtime (skill-query al daemon v3):* `ui-ux-pro-max` surface rank 2 (score 0.842) en un prompt de UI y `gamedev-engineer`
  rank 3 (0.823) en uno de gamedev — ambas alcanzables por v3 semántico (están en `ultron_skills_lazy`), además cubiertas
  por personas (mike-tyson/don-claudio, top-1 en esas queries) + skills activas (ui-designer/frontend-design).
  `business-strategist` además tiene entrada v2 (ruteable determinista). **Decisión: NO son deuda** — v3 + personas las
  cubren; añadir entradas v2 sería redundante. **Catálogo stale corregido:** la skill activa `~/.claude/skills/ultron/SKILL.md`
  afirmaba "78 agents / 79 skills activas (verificado 2026-05-27) · 17 pestañas · KIRKARDO R11.2" — mentira que además se
  **inyectaba en el contexto de routing** (la vi en los resultados de skill-query). Reescrita a una descripción honesta y
  lazy-aware ("núcleo mínimo activo; el dispatcher v2+v3 inyecta el resto on-demand; los conteos exactos viven en las
  pestañas Skills/Agents"). El template público del repo (`~/.ultron/skills/ultron/SKILL.md`) decía "dual/triple LLM mode"
  (muerto) → corregido a "AI Router (primary→fallback)". Re-embebida en `ultron_catalog` + `ultron_skills_lazy` para purgar
  el texto stale del índice. *(El fix de la skill activa vive fuera del repo, en ~/.claude; el del template es committable.)*
- ✅ **2.5 v3 semántico — (a) activado en hot path + (b) gate acc@3 en CI HECHOS. Alcance CORREGIDO en runtime (2026-06-26): el cuello era LATENCIA, no cableado.** *Entendido (medido):*
  el código del fallback **ya existe y es maduro** en `routing-dispatcher.v3.js` (branch B semántico cuando conf<0.80; shared
  deadline 4.5s que acota TODO el I/O y nunca rompe el hook de 5s; mata el subproceso Python huérfano en Windows). El problema
  NO es "añadir el fallback" sino que **`embed_skills.py query` tarda ~10.4s en caliente** (medido 3×: 10.8/10.4/10.2s, tras
  warm-up) porque recarga el modelo mpnet 768d + reranker en CADA proceso (`SentenceTransformer(...)`, sin daemon). Con el
  deadline de 4.5s, recablear v3 al hot path haría que **cada prompt ambiguo (conf<0.80) esperase +4.5s y recibiese vacío** —
  exactamente la regresión por la que se retiró el 2026-06-10 (`manifest.json:362`). **NO recablear hasta acelerar el embed.**
  Dos sub-tareas:
  - ◐ **(a) BLOQUEANTE — daemon de skills. Camino de reuse VERIFICADO (2026-06-26).** La INFRA E5 ya existe y es reusable:
    daemon `serve.rs` residente+warm + collection `ultron_catalog` (E5 1024d) que el orquestador YA consulta sub-segundo
    (`rank_skills`←`search_catalog`). PERO `catalog::index_skills` **excluye las `.disabled` por diseño** (`catalog.rs:16-18` —
    el orquestador no debe rutear a skills apagadas), y el v3 lazy existe JUSTO para inyectar las `.disabled`. Propósitos opuestos
    sobre el estado → **no hay reuse a coste cero**. El reuse real = **añadir al daemon E5 un cmd `skill_query` sobre una collection
    E5 con TODAS las skills (incl. disabled), reindexada desde `ultron_skills` (hoy mpnet 768d) a E5 1024d**; el v3.js consulta al
    daemon (cero proceso Python, cero modelo extra). *Coste honesto (mand. 13):* re-index + **re-eval de acc@3** (E5 vs mpnet puede
    mover resultados; `_accuracy_at3.js --v3` lo mide) + portar el reranker (`embed_skills._rerank`) a Rust. Alternativa
    (descartada salvo orden del usuario): daemon Python residente con mpnet — mantiene el acc conocido pero añade un runtime
    Python permanente (~400MB). *Hecho:* `skill_query` al daemon E5 <800ms warm + acc@3 sin regresión + v3 cableado a v3.
    *✅ PROGRESO (2026-06-26) — capacidad construida + GATE MEDIDO:* `index_skills_lazy` + `search_skills_lazy` (collection
    `ultron_skills_lazy` E5 1024d, **129 skills incl. `.disabled`**) + subcomandos `reindex-skills-lazy`/`skill-query`
    (delegado a rust-engineer contra contrato fijo; build release 0 warn; `ultron_catalog` intacto). **Medición acc@3 sobre los
    12 casos skill-scoped del harness: E5 = 100% (12/12) vs mpnet `embed_skills.py` = 91.7% (11/12)** — E5 NO degrada, MEJORA
    (acierta `test-driven-development`, que mpnet falla). El gate ("si E5 degrada, abortar sin escribir el daemon") está superado.
    *✅ cmd daemon HECHO (2026-06-26):* `skill_query` en `serve.rs` (Req.top + brazo + lock E5 compartido con orchestrate + 2
    tests herméticos). **Verificado runtime: 42-44 ms warm** (vs 10.4 s del CLI mpnet → ~240×), resultados correctos
    (`test-driven-development` top 0.847 para el prompt TDD que mpnet falla). El branch B del v3 ahora cabe de sobra en el budget
    de 4.5 s. *✅ v3.js CABLEADO (2026-06-26):* `querySemanticSkills` ahora hace `daemonRequest({cmd:'skill_query', prompt, top})`
    reusando el cliente compartido `hooks/scripts/lib/ultron-memory-cli.js` — 0 spawn de Python; cabecera/comentarios reescritos
    (no mienten). Verificado AISLADO (sin tocar `settings.json`): prompt "historia épica de fantasía con elfos y anillos" →
    `[semantic-fallback]` con `tolkien` top vía daemon; determinista intacto (`_accuracy_at3.js` acc@3 21/21). *✅ ACTIVADO (2026-06-26):*
    `~/.claude/settings.json` UserPromptSubmit → `routing-dispatcher.v3.js`; `manifest.json` regenerado a v3 (gate de paridad
    verde, descripción honesta, entry "retired" obsoleto eliminado). `embed_skills.py` FUERA del hot path (queda como indexador
    offline). **Se aplica desde la PRÓXIMA sesión de Claude Code** (settings se carga al inicio de sesión). *✅ auto-reindex
    idempotente HECHO (2026-06-26):* `maybe_index_skills_lazy()` (`catalog.rs`, probe + skip si poblada) llamada en el arranque
    del daemon (`serve.rs`, best-effort). **Verificado:** daemon con collection poblada → skip (lockfile instantáneo, count
    intacto 113, sin "indexed" en log, `skill_query` 37 ms). La rama index-si-vacía se ejecuta; caso negativo limpio no probado
    porque un `DELETE` HTTP de la collection corrompió Qdrant por lock de Windows → recuperado reiniciando Qdrant.
    *Lección operativa:* NO hacer `DELETE` HTTP de collections Qdrant en Windows (lock → estado inconsistente "no existe en
    memoria / datos en disco"); para reset, reiniciar Qdrant (re-lee disco). **Verificación del usuario:** sesión nueva → prompts
    fluidos + en prompt ambiguo aparece `[semantic-fallback]`. **2.5(a) CERRADA salvo OK visual;** resta 2.5(b) gate CI.
  - ◐ **(b) Gate de routing en CI — gate PORTABLE hecho; acc@3 e2e necesita fixtures (2026-06-26).** *Verificado:* los harnesses
    NO son portables a CI — `v2.js` lee candidatas de `~/.claude/skills` (L898) + ECC cache (L1131) + proyectos (L945), y
    `_verify_final.js` exige 232 entradas del ECC cache (L59); en un checkout limpio darían acc@3<100% → falso-fail (justo lo que
    este item advertía). *✅ HECHO:* job `routing-dispatcher` en `ci.yml` (ubuntu, PORTABLE, no toca `~/.claude`): `node --check`
    + require-chain de v2+v3+cliente-daemon → atrapa el fallo catastrófico (un dispatcher roto deja el hook UserPromptSubmit
    muerto → TODOS los prompts sin routing en silencio; exactamente el riesgo del `require` al daemon que v3 añadió hoy). YAML
    validado. *✅ HECHO — gate acc@3 e2e (2026-06-28):* la premisa "necesita fixtures de skills" era FALSA (mand. 2). Verificado
    en runtime: los 21 casos de `_accuracy_at3.js` resuelven de las tablas hardcodeadas PERSONAS/PLUGINS/AGENTS de v2 → con un
    árbol de descubrimiento VACÍO acc@3 sigue 100% (21/21). *Hecho:* un solo env `ULTRON_ROUTING_FIXTURES` raíza los 4 roots de
    descubrimiento (SKILLS_DIR/ECC_CACHE_ROOT/ULTRON_SKILLS_DIR/PROJECTS_DIR) bajo un fixtures tree cuando está set —
    **unset = byte-idéntico a producción** (verificado: acc@3 100% + `_verify_final` 26/0 sin el env). El job `routing-dispatcher`
    de `ci.yml` añade el step "accuracy@3 gate" (`ULTRON_ROUTING_FIXTURES=<tmp vacío> node _accuracy_at3.js`; exit 1 si <100% →
    caza regresiones del RANKER, no solo de sintaxis). Verificado local: gate exit 0, YAML válido. **2.5(b) CERRADA → Fase 2 COMPLETA.**

---

# FASE 3 — Interfaz: de cáscaras a producto (mucho ya construido — ver verificación)

- ✅ **3.1 Monitor con resumen REAL — VERIFICADO VISUALMENTE (2026-06-26).** Nuevo comando Tauri
  `summarize_session_activity(session_id)` (`commands/sessions_sub/session_summary.rs`): resuelve el transcript bajo
  `~/.claude/projects`, lee el último turno assistant COMPLETO (no el truncado de 200), lo pasa por `route("summarize")`,
  cachea por `(session_id, hash_del_texto)`. Frontend (`components/sessions/SessionCard.tsx`): invoke LAZY por sesión —
  el truncado queda como placeholder inmediato y se reemplaza por el resumen real al resolver (indicador `···`); cache de
  módulo para no re-invocar en el polling de 4s. Path-traversal cerrado (rechaza `..`/separadores en session_id).
  `cargo check` 0/0 + **6 tests** (cache/hash/guard) + `tsc` 0; backend cableado en `lib.rs`. Implementado por agentes
  especialistas (rust + react) contra contrato fijo, revisado y hardened en el hilo principal. **VERIFICADO (2026-06-26):**
  rebuild `build:local` desplegado (binario fresco) + **verificación visual confirmada por el usuario** (Sessions → Monitor).
  **Ampliado el mismo día (commit `2e58603`):** cada tarjeta añade el bloque de **orquestación por sesión**
  (intent/workflow/agentes/skills/memoria), correlacionado por `session_id` vía `live_session_feed` — base de 3.2. Aparte,
  commit `3785ab8`: el botón *Rebuild* de Ajustes usaba `tauri build` público (perdía Finance) → ahora `build:local`.
- ✅ **3.2 Monitor en directo — subagentes del harvest en el feed (código HECHO + verde; 2026-07-01).** `live_session_feed`
  expone ahora una 4ª lista `subagents` leída de `~/.ultron/.tmp/subagent-harvest.jsonl` (reusa `read_jsonl_tail` +
  `usage::harvest_path`, sin duplicar la ruta), **filtrando el ruido** (chars 0 / preview vacío → el hook SubagentStop también
  recibe payloads que no son subagentes reales, y una tarjeta vacía sería cáscara, mand. 11); `agent` vacío/ausente → "unknown"
  (el Monitor lo pinta como "subagente"). El `LiveSessionMonitor` añade la sección **"Subagentes recientes"**
  (agente/label/preview/chars/tiempo). Los eventos `workflow:*` ya se mostraban (liveEvents delegating/delegated). **Verificado:**
  `cargo test live_session` **4/4** (nuevo `recent_subagents_drops_noise_and_defaults_unknown`, con caso negativo: la fila
  chars:0 se filtra) + `tsc` 0. **ALCANCE REAL (mand. 13):** son subagentes COMPLETADOS (el hook escribe en SubagentStop = al
  terminar), no in-flight — el "arrancó en vivo" lo daría un hook `SubagentStart` (item 3.9); la atribución fina del especialista
  sigue siendo deuda de 0.3 (hoy dominan `unknown`). *Pendiente: rebuild `build:local` (cerrar la app) + verificación visual del
  usuario (Sessions → Orquestación en vivo → "Subagentes recientes").*
- ◐ **3.3 AI Router UI — solo nota de alcance.** La UI **NO está vacía** y la app **sí llama `route()`** (dashboard de
  métricas reales). Queda: aviso honesto "el CLI de esta sesión NO se rutea" (mand. 13) + verificar proxy free-tier en runtime.
- ✅ **3.4 Kanban CREA cards — HECHO.** `kanban_create_card`+`CardEditorModal`. *(Si se quiere auto-crear desde tarea
  detectada por proyecto, es mejora aparte, no cáscara.)*
- ✅ **3.5 Botón "Lanzar en carpeta" — HECHO.** `spawn_session(cwd)`+`openDialog{directory:true}` (Projects/Workspace).
  Queda verificación VISUAL del usuario.
- ◐ **3.6 Batch (no "RunBatch") fuera + consolidar barra.** Está cableado en varias superficies + cola backend (no es
  huérfano). **Decisión del usuario:** ¿se retira para subir CodeGraph/Repo a la barra de 5 botones y agrandar el kanban?
- ✅ **3.7 Repo-panel rápido — HECHO (`bed217e`, 2026-06-30).** `git_repo_state` cachea el estado con TTL (ya no
  spawnea `git.exe` por refresh) + muestra el path del repo para desambiguar el "siempre Ultron".
- ◐ **3.8 Learn auto — re-especificar o cerrar.** `Learn.tsx` **no tiene** refs Gemini/dual/triple (es estático). Si el
  plan apuntaba a otra superficie, nombrarla; si no, cerrar el item (no hay deuda en Learn.tsx).
- ✅ **3.9 Adoptar eventos de alto valor — 2 hooks nuevos cableados + consumidos (código HECHO + verde; 2026-07-01).**
  De los ~21 eventos sin usar, cableados los dos de mayor valor (confirmados como emitidos por `claude-code-guide` contra
  la doc oficial). **(1) `SubagentStart`** → hook `subagent-lifecycle.js` (registrado en `SubagentStart` + `SubagentStop`)
  escribe `{event:start|stop, agent_id, agent, label}` a `~/.ultron/.tmp/subagent-lifecycle.jsonl`; `live_session_feed`
  reduce por `agent_id` (último evento = start → EN VUELO) y el Monitor pinta la sección **"Subagentes activos"** con pulso
  — **cierra el límite in-flight que 3.2 declaró** (`subagent-harvest.js` de resultados queda intacto). **(2) `PostToolUseFailure`**
  → `posttoolfail-capture.js` (que ya proponía `error_resolution` al inbox) ahora corre también en el evento dedicado:
  `PostToolUse` captura fallos CON resultado (is_error/exit≠0), `PostToolUseFailure` los que la tool NI ejecutó
  (permiso/timeout/harness, `error` top-level) — clases **complementarias**, no un traslado (mand. 13). **Verificado:**
  `cargo` 5/5 (`running_subagents_pairs_start_and_stop_by_agent_id`, caso negativo start+stop→no activo), `tsc` 0, selftests
  `subagent-lifecycle` 6/6 + `posttoolfail-capture` 5/5 (caso negativo éxito→null), settings.json válido, `regen-manifest
  --check` OK (23 hooks). **ALCANCE REAL (mand. 13):** un hook nuevo SOLO se carga al inicio de sesión → la EMISIÓN real
  se verifica en la PRÓXIMA sesión; aquí queda probada la LÓGICA (selftests con payloads reales) + el consumo. Límite del
  in-flight: si un `SubagentStop` se pierde, el "start" queda activo hasta salir de la ventana reciente (sin TTL por tiempo
  en este corte). `TaskCreated/Completed` (kanban auto-crea) y `FileChanged` (doc↔código) quedan como oportunidad futura.
  *Pendiente: rebuild + verificación en la próxima sesión (lanzar un subagente → "Subagentes activos"; forzar fallo de tool → candidate al inbox).*

---

# FASE 4 — Legibilidad y venta (el artefacto durable)

- ☐ **4.1 Página técnica "Cómo funciona ULTRON de verdad"** en la web, desde este mapa: write-path de memoria, los
  los **hooks (~9 usados de ~30 disponibles)**, routing lazy (v2 + v3 cuando se cablee), orquestación con telemetría, interfaz.
  El manual del usuario y el argumento de venta. **Se actualiza al cerrar cada fase.**
- ✅ **4.2 Docs coherentes + provider gemini-CLI erradicado (CERRADO 2026-06-28).** El usuario decidió retirar el
  provider gemini de sesiones; erradicado de `App.tsx`, las 6 superficies de spawn, `tray.rs` y `COMMANDS.md:43`
  (commits `36f7bd5`/`12953d3`). gemini cloud del router intacto. *(Histórico abajo.)* Las refs a gemini-CLI/Mem0 en
  `INSTALL.md`/`INTEGRATION.md`/`MAINTAINERS.md`/`COMMANDS.md:178` son **historia honesta** (documentan que murieron) → se
  conservan. `GOAL.md` limpio. **PERO `COMMANDS.md:43` "Spawn Gemini session" NO es solo doc:** la app tiene el comando VIVO
  (`App.tsx:463` + gemini como provider en 6 superficies de lanzamiento de sesiones). Con el free-tier OAuth de gemini-CLI
  muerto el spawn está roto para el usuario típico, pero puede funcionar con un CLI de pago → **decisión de producto del
  usuario** (quitar el provider gemini vs dejarlo) + cambio frontend multi-archivo + verificación visual. No es fix de docs
  autónomo. *Pendiente: decisión del usuario sobre el provider gemini.*
- ✅ **4.3 Limpieza física BGE legacy (CERRADO 2026-06-28, verificado en runtime).** El código 384d ya se había
  retirado en `005f763` (`qdrant.rs` solo tiene `embed_e5`; `qdrant_embed_query` y `bin/ultron_embed.rs` ya NO existen).
  Borrados hoy: modelo BGE-small (128MB) + `ultron-embed.exe` (26MB) huérfanos; `recall_hybrid` (último caller del store
  384d) erradicado + `QdrantStore.capabilities()` honestizado (`111d3c4`). `.tmp` conservado (subagent-harvest vivo +
  backups). E5 intacto. *(Premisa original abajo, ya superada.)* **premisa CORREGIDA (2026-06-26, mirar-antes-de-borrar): BGE-small NO era huérfano simple.**
  `.fastembed_cache` = 2.3GB (E5 2.1GB vivo + BGE-small ~128MB). BGE-small está **referenciado en código vivo**: sidecar
  `ultron-embed.exe` (`bin/ultron_embed.rs`) + `qdrant.rs::embed()` (384d) + `qdrant_store.rs` + `recall_hybrid.rs:97` +
  el comando Tauri `qdrant_embed_query`. Contradice el "DESCARTADO" de la memoria. NO hay collection 384d en el doctor →
  **probablemente muerto en runtime, pero NO un borrado de 128MB a secas**: cae en la card "limpieza-codigo-muerto" (verificar
  end-to-end que ese embedding legacy no se invoca, retirar código+sidecar+modelo juntos, idealmente rama reversible). `.tmp`
  (28MB) tiene un backup `brain-pre-purge-2026-06-07.db` (16MB) + el `subagent-harvest.jsonl` VIVO (lo consume 2.1) + backups
  de kanban → borrado SELECTIVO, no wholesale. *Pendiente: verificación + go del usuario para retirar el subsistema BGE legacy.*
- ✅ **4.4 ERRADICAR los fantasmas — CERRADO (2026-06-28).** Mem0 (`12ded09`) + gemini-CLI COMPLETO: Control Center
  back+front (`36f7bd5`), scripts `.ps1`/`.py`/`.js` — 6 superficies de spawn (`8b9b773`), modo News Digest entero
  (`12953d3`), fixes post-audit (`8b0de21`). Audit adversarial 16-agentes: **0 CRITICAL/HIGH, cero regresiones de lo
  vivo**; tsc/cargo/tests/harnesses verdes. *(Alcance original abajo.)* **Mem0: borrar completo** (`StoreKind::Mem0` en `mod.rs:137`,
  `Mem0Entry`/`mem0_entries` en `project_context.rs`, `.mem0-opt-out.json`, líneas dup en `.gitignore`, comentarios "retired",
  "Sincronizar a Mem0"). **Gemini: solo el CLI muerto** (call-sites de `gemini_cli.py`) — **NO** el provider gemini cloud
  (`seed.rs:66-81`, fallback VIVO intencional; borrarlo rompe el router, mand. 13). **EXCEPCIÓN (no borrar):** los guardas
  protectores se quedan **renombrados genéricos** — `SecretKind::Mem0Token` (caza tokens `m0-`) y el test
  `seed_zones_ship_no_dead_gemini_cli` (regresión). *Riesgo:* el usuario declara **miedo a la limpieza** → **rama dedicada,
  borrado reversible paso a paso, `cargo`/`tsc`/build verde tras CADA retirada, y un agente revisor que confirme 0
  referencias vivas**. *Hecho:* `grep -ri "mem0"` en código vivo = solo guardas renombrados; `grep -ri "gemini_cli"` = 0;
  gemini cloud intacto; build verde; el sistema arranca igual.

---

## Decisiones abiertas para el usuario (resolver al arrancar cada fase)

1. **Memoria viva (1.3):** **RESUELTO (2026-07-01)** — el supersede automático actúa **solo en contradicciones de "estado
   del mismo hecho"** (state-update 1:1 claro); **NO** deprecación proactiva por "N días sin acceso". Implementado opt-in
   (`auto_supersede`, default OFF); encenderlo requiere el eval del clasificador (pendiente).
2. **Categorías vacías (1.4):** **RESUELTO (2026-06-26)** — `user_profile` poblado (productor en el prompt);
   `tool_usage`/`workflow_state` retirados (sin productor); `skill`/`architecture` conservados (productor vivo:
   `post_install` / `migrations`+gobernanza). Enum a 12 variantes vivas.
3. **`codebase_fact` (1.5):** **RESUELTO (2026-06-26)** — NO capturar (ya de facto: productor muerto desde el
   bulk-deprecate del 06-07) y NO reactivar (deshacer R5 saturaría el pack). El codegraph se consume por el MCP +
   `codegraph_summary`, no por brain.db. Guard de regresión añadido. Los 478 deprecated → limpieza física en 4.3.
4. **Poda (2.2):** **RESUELTO** — no se poda el catálogo ([[no-podar-catalogo-skills]]); solo honestidad de conteo.
5. **Batch (3.6):** ¿se retira de la barra para agrandar el kanban, o se mantiene?
6. **v3 semántico (2.5):** **RESUELTO** — se cablea (el usuario lo quiere funcionando).
7. **Limpieza de fantasmas (4.4):** el usuario tiene MIEDO → rama dedicada con checkpoint por retirada (recomendado: **sí**).

> Orden recomendado: 0 → 1 → (2 ∥ 3) → 4 continuo. La Fase 4 (web) se rellena a medida que cada subsistema queda
> entendido y arreglado. Si prefieres entender antes de tocar, se adelanta la casilla 4.1 correspondiente a ese subsistema.
