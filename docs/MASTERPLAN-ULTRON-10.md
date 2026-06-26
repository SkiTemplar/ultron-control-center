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
  por falta de productor. **NUEVO:** los 478 `codebase_fact` están **todos deprecated** (0 activos) → se capturan
  pero no entran a recall (mand. 12).
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
- ☐ **1.1 Threshold alcanzable + invariante testado.** El default 0.85 es inalcanzable (techo `derive_confidence`
  ~0.76, `capture.rs:276-292` vs `auto_approve.rs:39`) → bajar a ~0.72 o elevar el techo; test "config de fábrica PUEDE
  auto-aprobar un fact de alta confianza". *Hecho:* test rojo sin el fix, verde con él.
- ☐ **1.2 Dedup ACTIVO (cierra la fuga de 211 copias).** En `create_candidate`, si hay `duplicate_candidates`: NO
  auto-aprobar (forzar Merge) **o** merge real (bump `access_count`/`importance` del existente). Añadir
  `!duplicate_candidates.is_empty()` a la negación de `candidate_is_clean` (`auto_approve.rs:189-195`). Backfill: colapsar
  los 101 grupos activos (empezar por `78daab37`=211). *Hecho:* 0 grupos de hash idéntico nuevos; check Kirkardo "no duplicados activos".
- ☐ **1.3 Auto-supersede (MEMORIA VIVA — el eslabón que falta).** Cablear `supersede()` (hoy 0 callers) a (a) un
  subcomando del sidecar y (b) el path de contradicción: cuando es "misma entidad, distinto valor", en vez de Quarantine
  (`contradiction.rs:121-127`) ejecutar `supersede(old→deprecated/valid_to, new→Active)`. *Hecho:* "faltan 10"→"faltan 2"
  deja UN solo Active fresco; test conductual.
- ☐ **1.4 Productores para las 5 categorías vacías.** Extender la extracción para emitir `user_profile` (y decidir
  `skill`/`architecture`/`tool_usage`/`workflow_state`): cablear productor o retirarlas del enum/UI (mand. 12). *Evidencia:*
  `capture.rs:126-135`. *Hecho:* `user_profile` se llena solo tras sesiones.
- ☐ **1.5 `codebase_fact` muerto en recall (NUEVO).** 478 capturados, **todos deprecated** (0 activos) → el codegraph
  se captura pero no se inyecta (mand. 12). Decidir: activarlos (que entren a recall) o dejar de capturarlos. *Hecho:*
  o `codebase_fact` activos > 0 y recallables, o se deja de escribir.
- ☐ **1.6 Cobertura del detector de secretos (residual; PII ya cerrada).** El detector PII está hecho (06-25). Queda el
  caso "secreto genérico en prosa" (p. ej. "la clave es Patata2024", sin prefijo `sk-`): heurística de entropía/longitud +
  key-names. *Hecho:* un secreto en prosa NO se auto-aprueba; caso negativo en el harness. *(Prioridad baja: PII —lo grave— ya está.)*

> **Quitado de la lista de defectos:** "decisions siempre al inbox" (`auto_approve.rs:167-180`) es **intencional**
> (Decision/Architecture siempre necesitan ojo humano, testeado). No es bug; documentarlo como invariante de gobernanza.

---

# FASE 2 — Orquestación medida y honesta (depende de 0.3)

- ☐ **2.1 Consumir la telemetría de agentes** — panel/subcomando de uso real por agente (count/chars/última-ts).
  Pre-requisito: 0.3 (atribución arreglada). El dato existe (1066 filas) pero es huérfano sin punto de consumo.
- ◐ **2.2 Honestidad de conteo (NO podar — [[no-podar-catalogo-skills]]).** Los "21 code-reviewer / 690 ECC .md" son
  **caché de plugins inerte**; el único registrado es `~/.claude/agents/code-reviewer.md`. **No se borra.** El fix es que
  la app (Skills/Agents/Hooks) no cuente inerte como activo (mismo bug que 0.6). Conservar es gratis (lazy no cuesta tokens del CLI).
- ✅ **2.3 No-op `rules.rs:645` — RESUELTO (premisa obsoleta).** `ui_design` alimenta correctamente el routing de SKILLS
  (`preferred_skills`→`rank_skills`→`SkillChoice`); la delegación usa `preferred_specialists` con agentes reales. La ref
  muerta agente↔skill ya se eliminó (documentado `ranking.rs:71-74`). Opcional: test de regresión para que no reaparezca.
- ◐ **2.4 Skills "huérfanas" — separar dos conceptos.** No-inyectable-lazy ≠ no-ruteable. `business-strategist` es
  ruteable (entrada v2 + persona jordan); `ui-ux-pro-max`/`gamedev-engineer` están cubiertas por personas + `ui-designer`
  activa. Decisión: marcar `lazy_loadable` las que falten **o** aceptar que las personas las cubren (entonces no es deuda).
  Y corregir el catálogo stale de la skill activa `ultron` (quitar "78 agents/79 skills" → "catálogo lazy").
- ☐ **2.5 v3 semántico DEBE funcionar (el usuario lo confirma).** Hoy solo lo invoca `_accuracy_at3.js --v3` (diagnóstico que
  no gatea) → puede romperse en silencio. Añadir vía semántica de **fallback v2→v3** para prompts que no superen el umbral
  determinista (invoca `embed_skills.py`), y **gatear v3 en CI**. *Hecho:* un prompt ambiguo que el v2 no matchea recibe
  inyección semántica del v3; check conductual en `_accuracy_at3.js` con casos ambiguos que SÍ gatea.

---

# FASE 3 — Interfaz: de cáscaras a producto (mucho ya construido — ver verificación)

- ☐ **3.1 Monitor con resumen REAL** — `last_activity_summary` pasa por `route('summarize')` (async/cacheado por
  `session_id`) en vez de truncar a 200 chars (`session_jsonl.rs:24`). *(Única cáscara confirmada del Monitor.)*
- ☐ **3.2 Monitor en directo** — unificar sobre `live_session.rs` + eventos `workflow:*` + el **`SubagentStop` ya cableado**
  (`subagent-harvest`) para mostrar subagentes en vivo.
- ◐ **3.3 AI Router UI — solo nota de alcance.** La UI **NO está vacía** y la app **sí llama `route()`** (dashboard de
  métricas reales). Queda: aviso honesto "el CLI de esta sesión NO se rutea" (mand. 13) + verificar proxy free-tier en runtime.
- ✅ **3.4 Kanban CREA cards — HECHO.** `kanban_create_card`+`CardEditorModal`. *(Si se quiere auto-crear desde tarea
  detectada por proyecto, es mejora aparte, no cáscara.)*
- ✅ **3.5 Botón "Lanzar en carpeta" — HECHO.** `spawn_session(cwd)`+`openDialog{directory:true}` (Projects/Workspace).
  Queda verificación VISUAL del usuario.
- ◐ **3.6 Batch (no "RunBatch") fuera + consolidar barra.** Está cableado en varias superficies + cola backend (no es
  huérfano). **Decisión del usuario:** ¿se retira para subir CodeGraph/Repo a la barra de 5 botones y agrandar el kanban?
- ☐ **3.7 Repo-panel rápido** — `git_repo_state` spawnea `git.exe` por llamada (`git_ops.rs:9-14`); cachear con TTL o usar
  `git2`; mostrar el path para desambiguar el "siempre Ultron". *(Baja prioridad: 1 proceso por refresh.)*
- ◐ **3.8 Learn auto — re-especificar o cerrar.** `Learn.tsx` **no tiene** refs Gemini/dual/triple (es estático). Si el
  plan apuntaba a otra superficie, nombrarla; si no, cerrar el item (no hay deuda en Learn.tsx).
- ☐ **3.9 Adoptar eventos de alto valor de los ~30.** De los ~21 sin usar, cablear los que dan producto:
  `SubagentStart/Stop` → feed del Monitor en vivo (enlaza 3.2); `PostToolUseFailure` → captura de errores dedicada
  (hoy `posttoolfail-capture` corre en `PostToolUse` genérico); `TaskCreated/Completed` → kanban auto-crea (enlaza 3.4);
  `FileChanged` → link doc↔código (un cambio de código marca su doc stale). *Hecho:* ≥2 hooks nuevos de alto valor
  cableados y verificados en runtime.

---

# FASE 4 — Legibilidad y venta (el artefacto durable)

- ☐ **4.1 Página técnica "Cómo funciona ULTRON de verdad"** en la web, desde este mapa: write-path de memoria, los
  los **hooks (~9 usados de ~30 disponibles)**, routing lazy (v2 + v3 cuando se cablee), orquestación con telemetría, interfaz.
  El manual del usuario y el argumento de venta. **Se actualiza al cerrar cada fase.**
- ☐ **4.2 Docs coherentes** — quitar "Spawn Gemini session" (`COMMANDS.md:43`) y mención en spec histórica; INTEGRATION/GOAL al día.
- ☐ **4.3 Limpieza física** — borrar BGE-small (128MB, `.fastembed_cache/...bge-small...`) y `.tmp` (28MB) (**NO tocar el E5
  2.1GB vivo**); pasar el scanner de PII sobre `.tmp/`, `cockpit/projects/*` (untracked, con archives) antes de cualquier push.
- ◐ **4.4 ERRADICAR los fantasmas — alcance corregido.** **Mem0: borrar completo** (`StoreKind::Mem0` en `mod.rs:137`,
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

1. **Memoria viva (1.3):** ¿el supersede automático actúa solo en contradicciones de "estado del mismo hecho", o también
   deprecia proactivamente lo que lleva N días sin accederse?
2. **Categorías vacías (1.4):** `user_profile`/`skill`/`architecture`/`tool_usage`/`workflow_state` — ¿se pueblan o se
   retiran del enum? (5 tipos, no 2).
3. **`codebase_fact` (1.5):** ¿se activan para recall o se deja de capturarlos?
4. **Poda (2.2):** **RESUELTO** — no se poda el catálogo ([[no-podar-catalogo-skills]]); solo honestidad de conteo.
5. **Batch (3.6):** ¿se retira de la barra para agrandar el kanban, o se mantiene?
6. **v3 semántico (2.5):** **RESUELTO** — se cablea (el usuario lo quiere funcionando).
7. **Limpieza de fantasmas (4.4):** el usuario tiene MIEDO → rama dedicada con checkpoint por retirada (recomendado: **sí**).

> Orden recomendado: 0 → 1 → (2 ∥ 3) → 4 continuo. La Fase 4 (web) se rellena a medida que cada subsistema queda
> entendido y arreglado. Si prefieres entender antes de tocar, se adelanta la casilla 4.1 correspondiente a ese subsistema.
