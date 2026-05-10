# ULTRON MEMORY v14 GENESIS · árbol compacto

> Lee `context.md` primero (≤400 tok). Para detalle dinámico: `ultron status` / `ultron doctor --json`.
> Para deep dive: `uv run python brain_index.py query "<topic>"`. Vault L2 = source-of-truth.
> Actualizado: 2026-05-08 (v14.4 P3 rewrite — −1,400 tok)

---

## SISTEMA

Stats live en `ultron status` y `~/.ultron/.tmp/current-session.json`. Manifest, brain count, test count y skills count NO viven hardcoded aquí (drift). Release y changelog en `~/.claude/skills/ultron/references/changelog.md`.

Pickups y narrativas históricas viven en `~/.ultron/plans/` (`2026-05-09-pickup.md` actual, `2026-05-09-MACRO-INDEX.md` para roadmap). Cualquier acción residual abierta queda en pickup, no aquí.

---

## PROYECTOS ACTIVOS

| Nombre | Path corto | Stack | Estado |
|---|---|---|---|
| PROGRAM_A-DisenoVideojuegos | PROGRAM_A/codigo/Unity/IA_Template | C#/Unity | ACTIVO |
| ULTRON | ~/.claude/skills/ultron/ | Python/PS1 | ACTIVO (v14.4) |
| Tortunabo | PROYECTOS_PERSONALES/Unreal/Tortunabo | C++/UE5 | PAUSADO |
| OrbitalDB/BildyApp | AppMoviles/codigo/OrbitalDB | Kotlin/Android | ENTREGA |
| Niasjka | PROYECTOS_PERSONALES/niajska | Next.js/Supabase | PAUSADO |

---

## SKILL GRAPH — Personas

```
Persona         Dominio                 Conecta con
──────────────────────────────────────────────────────
don-claudio     UE5·Unity·netcode       cpp-pro, ue5-dev
novalbos        C++·Gráfica·IA·low-lvl  einstein, cpp-pro
terry-davis     refactor·git·deuda      focused-fix
einstein        investiga·física·math   novalbos
warren          bolsa·finanzas          tio-gilito
tio-gilito      finanzas personales     warren
alfred          Windows·CLI·scripts     openjarvis
openjarvis      DevOps·cloud·Docker     alfred
obliteratus    rewrite·purga·deuda     terry-davis
manolo-lama     ventas·persuasión       (none)
tolkien         narrativa·escritura     (none)
pana            productividad·archivos  alfred
shannon         información·teoría      novalbos
jordan-belfort  pitch·estrategia        warren
```

Knowledge per persona se consulta on-demand vía `brain_index.py query "<topic>"`. Full graph: `~/.ultron/cockpit/skill_graph.json`.

---

## COCKPIT SCRIPTS

Inventario canónico: `scripts/cockpit/health.py:EXPECTED_SCRIPTS`. Listar: `uv run python scripts/cockpit/health.py --json`. Cada subsystem (routing, doctor, brain, security, tokens, alerts) entra ahí.

---

## QUICK LINKS

- context: `~/.ultron/.tmp/context.md`
- master plan + pickup: `~/.ultron/plans/2026-05-09-{MACRO-INDEX,pickup}.md`
- changelog: `~/.claude/skills/ultron/references/changelog.md`
- queries: `brain_index.py query "<topic>"` · `ultron doctor [--fix|--health-check|--security]`

---

## USER

```
Grado Ingeniería Programación + PROGRAM_A mención Gráfica · UNIVERSITY
Stack: C++ (UE5) · C# (Unity) · TypeScript · Python
IDEs: CLion (UE5) · Rider (Unity) · VS Code (web)
email: user@example.com  |  TZ: Europe/Madrid
banco: ~/.../Bank/finanzas/finanzas.db
```

---

*Source-of-truth = vault L2 + brain_index FTS5. Esta es solo orientación. Stats/state/pickups en archivos linkados arriba.*
