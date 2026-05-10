# ULTRON Roadmap System

Source-of-truth para el desarrollo de ULTRON. Reemplaza la dispersión previa entre
`MACRO-INDEX.md`, planes individuales, y trackers en commits.

## Archivos

| Archivo | Qué contiene | Cuándo se edita |
|---|---|---|
| `backlog.yaml` | Items (TODOs) con status, sprint, priority | A mano o vía `backlog.py` |
| `decisions.yaml` | Decisiones tomadas + alternativas descartadas + razón | Cuando hay un trade-off no obvio |
| `_archive/` | Items completados >90d + decisiones obsoletas | Auto via cron mensual |

## Workflow

```bash
# Añadir nueva idea
ultron backlog add "..." --priority P2 --sprint v15.0

# Ver qué hay activo
ultron backlog list --pending
ultron backlog list --sprint v15.0

# Empezar item
ultron backlog start U-010

# Cerrar item con decisión
ultron backlog done U-010 --decision D-007

# Decisiones
ultron decision add "..." --alt "..." --why "..."
ultron decision list --recent
ultron decision search "vault"
```

## Estados (status)

| Estado | Significado |
|---|---|
| `ideated` | Idea suelta, no tiene spec |
| `spec` | Tiene plan_doc o acceptance criteria |
| `ready` | Listo para empezar |
| `in_progress` | Ejecutando |
| `done` | Completado, opcional `completed:` date |
| `cancelled` | Descartado, mantener registro |

## Prioridades

- `P0` — urgente, bloquea otras cosas
- `P1` — importante para sprint actual
- `P2` — backlog, hacer cuando haya tiempo
- `P3` — futuro lejano, parking

## Filosofía

- **YAML editable a mano** — no hace falta CLI para tocar items
- **IDs estables** (`U-001`, `D-001`) — referenciables desde commits, plans, conversaciones
- **Decisiones inmutables** — si cambias de opinión, crea decisión nueva que supersedes la anterior
- **Sin sub-tasks** — si un item es complejo, divídelo en items separados con `depends_on`
