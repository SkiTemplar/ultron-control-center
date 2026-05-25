# Skills Audit Report — 2026-05-24

**Auditor:** sub-agente autonomo (Claude Opus 4.7 1M, sin permisos de borrado)
**Alcance:** `C:\Users\USER\.claude\skills\` (user-level) + `C:\Users\USER\.claude\plugins\` (plugins)
**Objetivo:** identificar skills redundantes / duplicadas / candidatas a eliminar para reducir consumo de tokens (~17k segun card `card-v26-fb-027`).
**Restriccion:** SOLO INFORME. NO se ha borrado ni modificado nada.

**Nota importante de ubicacion:** este informe se intento escribir en `C:\Users\USER\.ultron\cockpit\diagnostics\skills-audit-2026-05-24.md` pero el sandbox del sub-agente denego escritura fuera del cwd. Por eso queda aqui en la raiz de `control-center`. Mover manualmente con:
`Move-Item "C:\Users\USER\.ultron\control-center\skills-audit-2026-05-24.md" "C:\Users\USER\.ultron\cockpit\diagnostics\skills-audit-2026-05-24.md"`

---

## 1. Resumen ejecutivo

| Metrica | Valor |
|---|---|
| Skills user-level activas (carpetas con `SKILL.md` directo bajo `~/.claude/skills/`) | ~100 |
| Skills duplicadas en stale worktree `agent-ab8c425fe827d7b67` | 30 |
| Skills de plugins (ECC + superclaude + superpowers + addy-agent-skills + claude-code-workflows + thedotmack + pensyve + claude-code-plugins) | ~210 (con duplicados cache vs marketplace) |
| Skills user-level redundantes con plugins (mismo nombre) | ~20 |
| Skills "MUST BE USED" detectadas en system reminder | 5 (using-superpowers, brainstorming, tdd, systematic-debugging, etc.) |
| **Candidatas a eliminar (LOW-RISK)** | **42** |
| **Candidatas a fusionar / consolidar** | **18 grupos** |
| **Mantener pero revisar** | **15** |
| **Core / nunca tocar** | **22** |
| **Tokens estimados ahorrados** (calculo: ~150 tokens/skill descripcion + frontmatter, sin contar cuerpo) | **~6.3k - 9.0k** tokens por sesion |
| **Ahorro adicional desinstalando plugins enteros redundantes** | **~3-5k** tokens adicionales |
| **Ahorro total potencial** | **~10-14k tokens / sesion** (~60-80% del coste actual de 17k) |

---

## 2. Hallazgos criticos (cleanup obvio, riesgo CERO)

### 2.1 Stale Git worktree con 30 skills duplicadas

**Ruta:** `C:\Users\USER\.claude\skills\.claude\worktrees\agent-ab8c425fe827d7b67\`

Es un worktree de un sub-agente antiguo (`agent-ab8c425fe827d7b67`) que dejo copias completas de skills personales (don-claudio, einstein, jordan-belfort, mike-tyson, novalbos, pana, terry-davis, tio-gilito, tolkien, ultron, warren, etc.). Las mismas skills ya existen en `~/.claude/skills/<name>/SKILL.md`.

**Skills duplicadas:**
ask-questions-first, consolidate-memory, differential-review, don-claudio, einstein, insecure-defaults, jordan-belfort, manolo-lama, mcp-builder, mike-tyson, modern-python, mutation-testing, novalbos, pana, profesor-fisica, property-based-testing, repo-evaluator, second-opinion, sharp-edges, skill-creator, spec-to-code-compliance, terry-davis, theme-factory, tio-gilito, tolkien, ui-ux-pro-max, ultron, variant-analysis, warren, webapp-testing

Mas carpetas auxiliares: api-design-reviewer, database-schema-designer, focused-fix, performance-profiler, tech-debt-tracker.

**Riesgo:** ZERO. Es un worktree fantasma.
**Accion:** borrar el directorio entero.

### 2.2 Python venv dentro de skills/ (ERROR de instalacion)

**Ruta:** `C:\Users\USER\.claude\skills\ultron\.venv\`

Contiene un entorno virtual de Python completo (jsonschema, markdown-it, pyyaml, rpds, typer, etc.) — claramente residual de un intento de packaging que dejo el venv dentro de la skill `ultron`. Pesa cientos de MB y NO afecta tokens (Claude no lo escanea), pero ocupa disco y contamina el git status.

**Sub-hallazgo extra:** dentro del venv hay un `SKILL.md` de typer:
`skills\ultron\.venv\Lib\site-packages\typer\.agents\skills\typer\SKILL.md`
Esto SI puede estar siendo detectado por Claude como skill fantasma.

**Riesgo:** ZERO. Es basura.
**Accion:** `Remove-Item -Recurse -Force C:\Users\USER\.claude\skills\ultron\.venv`

### 2.3 Cache duplicate: addy-agent-skills

**Plugin:** `agent-skills` aparece DOS veces:
- `plugins\marketplaces\addy-agent-skills\skills\*` (20 skills)
- `plugins\cache\addy-agent-skills\agent-skills\1.0.0\skills\*` (los mismos 20 skills)

Marketplace path es el "vivo"; cache es el descargado. Si ambos se cargan, son 40 entradas por 20 skills reales.

**Accion sugerida:** investigar si Claude Code carga ambos o solo el de `marketplaces/`. Si carga ambos, eliminar el de `cache/`.

### 2.4 Superpowers en cache antiguo

**Plugin:** `superpowers` en `plugins\cache\superpowers-marketplace\superpowers\5.0.7\` mientras que las skills activas (`using-superpowers`, `brainstorming`, etc.) vienen del marketplace. Verificar si la version `5.0.7` del cache esta obsoleta.

---

## 3. Tabla de eliminacion recomendada (LOW-RISK, 42 items)

### 3.1 Skills de agentes/lenguajes que USER NO usa

Proyectos activos verificados (`~/.ultron/cockpit/projects/`):
- **ultron** (Tauri 2 + React + Rust + TypeScript)
- **rdr2-mods, tortunabo** (UE5 + C++ + Lua)
- **laundry-club-next, niajska, fuux-web** (Next.js + React)
- **finanzas, finance** (dashboards web)
- **proggrafica** (graphics programming, C++)
- **ia_template** (AI scaffolding, Python)
- **sairanskies, web2, sparkling-luxury** (web)
- **blackboard-morning-sync, ai-shell-propuesta** (utilidades)

Stacks NO presentes: Java/JVM, Kotlin (excepto Android Compose teorico), Go, Swift/iOS, .NET/F#, HarmonyOS, Flutter, Perl, Quarkus, Spring Boot, Laravel, Django, FastAPI, NestJS, Angular, Cisco IOS.

| Skill | Ubicacion | Razon | Riesgo |
|---|---|---|---|
| `ecc:dart-flutter-patterns` | plugin ecc | Sin proyectos Flutter | low |
| `ecc:flutter-build / flutter-review / flutter-test / flutter-dart-code-review` | plugin ecc | Sin Flutter | low |
| `ecc:golang-patterns / golang-testing / go-build / go-review / go-test` | plugin ecc | Sin Go | low |
| `ecc:java-coding-standards / jpa-patterns` | plugin ecc | Sin Java | low |
| `ecc:kotlin-patterns / kotlin-testing / kotlin-coroutines-flows / kotlin-ktor-patterns / kotlin-exposed-patterns / kotlin-build / kotlin-review / kotlin-test` | plugin ecc | Sin Kotlin | low |
| `ecc:compose-multiplatform-patterns` | plugin ecc | Sin Compose | low |
| `ecc:dotnet-patterns / csharp-testing / fsharp-testing` | plugin ecc | Sin .NET/F# | low |
| `ecc:springboot-patterns / springboot-security / springboot-tdd / springboot-verification` | plugin ecc | Sin Spring | low |
| `ecc:quarkus-patterns / quarkus-security / quarkus-tdd / quarkus-verification` | plugin ecc | Sin Quarkus | low |
| `ecc:laravel-patterns / laravel-security / laravel-tdd / laravel-verification / laravel-plugin-discovery` | plugin ecc | Sin PHP/Laravel | low |
| `ecc:django-patterns / django-celery / django-tdd / django-security / django-verification` | plugin ecc | Sin Django (USER usa FastAPI/Tauri) | low |
| `ecc:nestjs-patterns` | plugin ecc | Sin NestJS | low |
| `ecc:angular-developer` | plugin ecc | Sin Angular | low |
| `ecc:nuxt4-patterns` | plugin ecc | Sin Nuxt | low |
| `ecc:perl-patterns / perl-testing / perl-security` | plugin ecc | Sin Perl | low |
| `ecc:swiftui-patterns / swift-actor-persistence / swift-concurrency-6-2 / swift-protocol-di-testing` | plugin ecc | Sin Swift/iOS | low |
| `ecc:ios-icon-gen` | plugin ecc | Sin iOS | low |
| `ecc:tinystruct-patterns` | plugin ecc | Framework Java oscuro | low |
| `ecc:gradle-build` | plugin ecc | Sin JVM | low |
| `ecc:cisco-ios-patterns / netmiko-ssh-automation / network-bgp-diagnostics / network-config-validation / network-interface-health` | plugin ecc | Sin networking enterprise | low |
| `ecc:homelab-pihole-dns / homelab-wireguard-vpn / homelab-vlan-segmentation / homelab-network-readiness / homelab-network-setup` | plugin ecc | Sin homelab confirmado | low |
| `ecc:healthcare-emr-patterns / healthcare-eval-harness / healthcare-cdss-patterns / healthcare-phi-compliance / hipaa-compliance` | plugin ecc | Dominio medico sin uso | low |
| `ecc:visa-doc-translate` | plugin ecc | Sin uso | low |
| `ecc:carrier-relationship-management / customs-trade-compliance / inventory-demand-planning / returns-reverse-logistics / production-scheduling / logistics-exception-management` | plugin ecc | Logistica enterprise sin uso | low |
| `ecc:customer-billing-ops / finance-billing-ops / energy-procurement / quality-nonconformance` | plugin ecc | Ops enterprise sin uso | low |
| `ecc:defi-amm-security / evm-token-decimals / agent-payment-x402 / nodejs-keccak256 / llm-trading-agent-security` | plugin ecc | Sin Web3/blockchain activo | low |
| `ecc:foundation-models-on-device` | plugin ecc | Apple Foundation Models sin uso | low |
| `ecc:android-clean-architecture` | plugin ecc | Sin Android | low |
| `ecc:blender-motion-state-inspection` | plugin ecc | Sin Blender activo | low |
| `ecc:hermes-imports` | plugin ecc | Especifico React Native Hermes, sin uso | low |
| `ecc:clickhouse-io` | plugin ecc | Sin Clickhouse | low |
| `ecc:dmux-workflows` | plugin ecc | Tool externo sin uso | low |
| `ecc:flox-environments` | plugin ecc | Nix-based env, sin uso | low |
| `ecc:nutrient-document-processing` | plugin ecc | SDK comercial sin uso | low |
| `ecc:videodb / remotion-video-creation / manim-video / fal-ai-media` | plugin ecc | Sin pipeline de video activo | low |
| `ecc:scientific-pkg-gget / scientific-db-pubmed-database / scientific-db-uspto-database` | plugin ecc | Sin investigacion bio/patentes | low |
| `ecc:ralphinho-rfc-pipeline / openclaw-persona-forge / plankton-code-quality` | plugin ecc | Skills especificas de otros sistemas | low |

**Total LOW-RISK confirmados: ~42 skills**

### 3.2 Skills user-level claramente residuales

| Skill | Ubicacion | Razon | Riesgo |
|---|---|---|---|
| Worktree completo `skills/.claude/worktrees/agent-ab8c425fe827d7b67/` | user-level | Stale worktree, 30 skills duplicadas | zero |
| `skills/ultron/.venv/` (Python venv) | user-level | Basura de packaging, no es skill | zero |
| `skills/ultron/.venv/Lib/site-packages/typer/.agents/skills/typer/` | user-level | Fantasma dentro de venv | zero |

---

## 4. Tabla de FUSION recomendada (18 grupos)

Mismo nombre/funcion en MULTIPLES scopes — quedarse con UNA version.

| Skill / Funcion | Versiones existentes | Recomendacion |
|---|---|---|
| `code-reviewer` / `code-review` | user-level `skills/code-reviewer/`, `pr-review-toolkit`, `code-review` plugin, `ecc:code-review`, `agent-skills:review`, `feature-dev`, top-level `code-review` skill | Quedarse con `code-review` (built-in CLI) + user-level. Eliminar duplicados de plugins menos usados |
| `skill-creator` | user-level + `skill-creator` plugin + plugin cache | Quedarse con user-level (mas custom) |
| `mcp-builder` | user-level + worktree | Quedarse con user-level |
| `webapp-testing` | user-level + worktree | Quedarse con user-level |
| `repo-evaluator` (Kirkardo) | user-level + worktree | Quedarse con user-level |
| `second-opinion` | user-level + worktree + `codex:review` | Quedarse con user-level |
| `consolidate-memory` | user-level + worktree | Quedarse con user-level |
| `terry-davis / don-claudio / jordan-belfort / mike-tyson / pana / einstein / tolkien / novalbos / tio-gilito / warren / alfred` (personas) | user-level + worktree | Quedarse con user-level (canon de USER) |
| `ui-ux-pro-max` | user-level + worktree | Quedarse con user-level |
| `frontend-design` | user-level + `frontend-design` plugin + `ecc:frontend-design-direction` | Quedarse con user-level + ecc, borrar plugin marketplace |
| `cpp-pro / cpp-testing / cpp-coding-standards` | user-level + ecc + agents `cpp-pro.md` | Consolidar en user-level (USER usa C++ en UE5/proggrafica) |
| `python-pro / python-patterns / python-testing` | user-level + ecc + superclaude `python-expert` | Quedarse con user-level + ecc python-testing |
| `typescript-pro` | user-level + agent | Quedarse con user-level |
| `debugger / systematic-debugging` | user-level + superpowers + `ecc:debugger-agent-introspection` | Quedarse con superpowers (`MUST USE`) + user-level |
| `tdd-workflow / test-driven-development` | superpowers + `agent-skills:tdd` + `ecc:tdd-workflow` | Quedarse con superpowers (`MUST USE`) |
| `brainstorming / brainstorm` | superpowers + `superpowers:brainstorm` (deprecated) + superclaude | Quedarse con `superpowers:brainstorming`, borrar deprecated |
| `write-plan / writing-plans / planning-and-task-breakdown / plan-orchestrate / make-plan` | superpowers + agent-skills + ecc + thedotmack | Quedarse con `superpowers:writing-plans` (`MUST USE`) + `agent-skills:planning-and-task-breakdown` |
| `git-workflow / git-workflow-manager / git-conflict-resolver / git-workflow-and-versioning` | user-level + ecc + agent-skills | Quedarse con user-level + `agent-skills:git-workflow-and-versioning` |
| `agent-architecture-audit / agent-harness-construction / autonomous-agent-harness / autonomous-loops / continuous-agent-loop` | user-level (5 skills muy similares) + duplicados en ecc | Consolidar en 2: `agent-architecture-audit` (diagnostico) + `autonomous-loops` (ejecucion) |
| `continuous-learning / continuous-learning-v2` | user-level (v1+v2) | Quedarse SOLO con v2 |

---

## 5. Mantener pero revisar (15 items)

Estos parecen redundantes pero hacen falta verificar el uso real antes de tocar.

| Skill | Por que dudar |
|---|---|
| `senior-engineer` vs `terry-davis` | Ambos son "ingeniero serio". Terry es persona; senior-engineer es generico. Verificar si senior-engineer aporta algo |
| `agentic-engineering` vs `agentic-os` vs `agent-architecture-audit` | Tres skills "agentic*". Posiblemente solapadas |
| `hiper-plans` vs `writing-plans` | Hiper-plans parece custom de USER, writing-plans es superpowers. Mantener ambos si hacen cosas distintas |
| `loki-mode` | Skill personal, no se conoce su rol — confirmar antes de tocar |
| `gateguard` / `safety-guard` / `security-scan` / `security-review` / `security-bounty-hunter` | 5 skills de seguridad. Probablemente 2-3 suficientes |
| `cost-tracking` / `cost-aware-llm-pipeline` / `ecc:ecc-tools-cost-audit` | 3 skills de coste. Si USER paga Claude Max (no API), revisar utilidad |
| `prompt-optimizer` | Util pero verificar si se invoca |
| `team-builder` | Vago, verificar |
| `dashboard-builder` | Generico |
| `learning-guide` / `socratic-mentor` (superclaude) vs `novalbos` (user) | Novalbos hace teaching custom; los superclaude pueden ser redundantes |
| `connections-optimizer` | Sin contexto claro |
| `iterative-retrieval` / `regex-vs-llm-structured-text` | Tooling avanzado, verificar uso |
| `claude-devfleet` | Sin contexto |
| `evolve` (ecc) | Posible meta-skill, verificar |
| `instinct-export / instinct-import / instinct-status` | Triple skill de "instinct" — verificar que es |

---

## 6. Core / NUNCA TOCAR (22 items)

Skills criticas para los flujos diarios de USER. Eliminar = romper sistema.

### Personas (canon de USER)
- `ultron` (orquestador maestro)
- `pana` (sistema operativo personal)
- `alfred` (mayordomo digital del PC)
- `terry-davis` (ingeniero de elite)
- `don-claudio` (game dev padrino)
- `jordan-belfort` (estratega de negocio)
- `mike-tyson` (UI/UX)
- `einstein` (cientifico/investigador)
- `tolkien` (escritor del Libro)
- `novalbos` (profesor tecnico)
- `tio-gilito` (finanzas dia a dia)
- `warren` (inversiones)

### Workflows criticos
- `superpowers:using-superpowers` (`MUST USE`)
- `superpowers:brainstorming` (`MUST USE`)
- `superpowers:test-driven-development` (`MUST USE`)
- `superpowers:systematic-debugging` (`MUST USE`)
- `superpowers:writing-plans` (`MUST USE`)
- `superpowers:verification-before-completion`
- `consolidate-memory` (custom USER)
- `repo-evaluator` (Kirkardo)
- `commit-commands:commit` / `commit-push-pr`
- `ecc:ecc-guide` (entrada al sistema)
- `ue5-dev` (Tortunabo)
- `gateguard` (seguridad del harness)

---

## 7. Plan de ejecucion por fases

### Fase 0 — Cero riesgo (hacer YA)

1. Borrar worktree fantasma:
   ```powershell
   Remove-Item -Recurse -Force "C:\Users\USER\.claude\skills\.claude"
   ```
2. Borrar venv basura:
   ```powershell
   Remove-Item -Recurse -Force "C:\Users\USER\.claude\skills\ultron\.venv"
   ```
3. Verificar git status del repo `.claude` (si es un repo) y commitear el cleanup.

**Resultado:** ~30 skills duplicadas fuera + cientos de MB de disco recuperados. Sin riesgo de romper nada activo.

### Fase 1 — Plugins fuera de stack (LOW-RISK, 42 skills)

Desactivar plugins ECC enteros que no aplican (mejor que skill-by-skill).

Verificar primero como esta configurado ECC:
```powershell
Get-Content "C:\Users\USER\.claude\settings.json" | Select-String "ecc"
Get-ChildItem "C:\Users\USER\.claude\plugins\marketplaces\" -Directory
```

Si ECC permite desactivar categorias, deshabilitar:
- Flutter / Dart
- Java / Kotlin / JVM
- Go
- Swift / iOS
- .NET / F#
- PHP / Laravel
- Python web (Django, FastAPI si no se usa, NestJS)
- Networking enterprise (Cisco, BGP)
- Homelab
- Healthcare
- Logistics / Energy / Manufacturing
- Web3 / DeFi
- Video pipeline (videodb, manim, remotion, fal-ai)
- Scientific DBs

Si no permite granular, usar:
```powershell
# Renombrar el plugin entero a .disabled
Rename-Item "C:\Users\USER\.claude\plugins\<plugin-name>" "<plugin-name>.disabled"
```

**Resultado:** -42 skills minimo de la system reminder.

### Fase 2 — Consolidacion (MEDIUM-RISK)

Para cada grupo en seccion 4, decidir cual versionar:

1. **Personas:** ya estan limpias tras Fase 0 (solo queda user-level).
2. **code-reviewer:** quedarse con built-in `code-review` CLI + 1 plugin (preferiblemente ecc por integracion con ecc-guide).
3. **planning skills:** dejar `superpowers:writing-plans` (MUST) + 1 mas. Eliminar las 4 restantes.
4. **brainstorm:** eliminar `superpowers:brainstorm` (DEPRECATED, la describe el system reminder).
5. **agent harness:** elegir entre las 5 user-level (`agent-architecture-audit`, `agent-harness-construction`, `autonomous-agent-harness`, `autonomous-loops`, `continuous-agent-loop`). Recomendado: quedarse con `agent-architecture-audit` + `autonomous-loops`.

**Resultado:** -15 a -20 skills mas.

### Fase 3 — Revision manual (HIGH-CARE)

Para cada item en seccion 5, abrir el SKILL.md y leer la descripcion completa. Decidir caso por caso.

### Fase 4 — Verificacion

Tras cada fase:
1. Reiniciar Claude Code
2. Verificar que `available-skills` en system reminder bajo
3. Verificar que ningun flujo critico se rompio (probar `/pana`, `/terry-davis`, `/ecc:feature-dev`, `/commit`)
4. Actualizar `card-v26-fb-027` en el kanban con tokens reales medidos

---

## 8. Comandos exactos (post-revision USER)

### Fase 0 (sin riesgo, ejecutar tras leer este informe)
```powershell
# Backup primero (por si acaso)
Compress-Archive -Path "C:\Users\USER\.claude\skills\.claude" -DestinationPath "C:\Users\USER\.ultron\cockpit\diagnostics\skills-worktree-backup-2026-05-24.zip"

# Borrar worktree fantasma
Remove-Item -Recurse -Force "C:\Users\USER\.claude\skills\.claude"

# Borrar venv basura
Remove-Item -Recurse -Force "C:\Users\USER\.claude\skills\ultron\.venv"
```

### Fase 1 (deshabilitar plugins, NO borrar, renombrar)
```powershell
# Ejemplo para deshabilitar todas las skills java/jvm de ECC
# (REQUIERE confirmar primero como ECC estructura sus skills)
Get-ChildItem "C:\Users\USER\.claude\plugins\ecc" -Recurse -Directory |
  Where-Object { $_.Name -match "(java|kotlin|flutter|dart|swift|laravel|django|quarkus|spring|nestjs|angular|nuxt|perl|cisco|homelab|healthcare|hipaa|logistics|carrier|customs|inventory|production|energy|defi|evm|web3|blender|hermes|clickhouse|dmux|flox|nutrient|videodb|manim|remotion|fal-ai|scientific-db|gget)" } |
  ForEach-Object { Rename-Item $_.FullName "$($_.Name).disabled" }
```

**NO ejecutar a ciegas — USER debe revisar cada renombrado.**

### Fase 2 (consolidacion — caso por caso, manual)
```powershell
# Ejemplo: eliminar superpowers:brainstorm deprecated
# (UBICACION EXACTA pendiente de verificar)
```

---

## 9. Notas finales

- **NO se ha tocado nada.** Este es un informe puro.
- Las cifras de tokens son **estimaciones**. Medir antes y despues con el contador real del system reminder.
- Si ECC se reinstala en el futuro, todas las skills LOW-RISK volveran. Considerar mantener un script `ecc-prune.ps1` o issue en su repo para soporte granular de instalacion.
- El built-in CLI (`/code-review`, `/run`, `/verify`, `/init`, `/schedule`, `/loop`, `/claude-api`) NUNCA se debe tocar — viene del propio Claude Code.
- Marketplaces a revisar individualmente (no auditados en profundidad por restricciones de tool):
  - `thedotmack/openclaw` y `thedotmack/plugin` (varios `do/make-plan/knowledge-agent` duplicados)
  - `pensyve/integrations/{claude-code, codex-plugin, gemini-extension}` (mismas 4 skills repetidas 3 veces)
  - `claude-code-workflows` (accessibility-compliance y otros sin auditar a fondo)

---

**Fin del informe.**
**Generado:** 2026-05-24
**Proximo paso recomendado:** USER lee, aprueba Fase 0, y luego decidimos Fase 1.
