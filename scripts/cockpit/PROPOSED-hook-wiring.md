# PROPOSED: Hook Wiring para auto-indexado de Skills

Este documento describe el patch exacto a aplicar en `~/.claude/settings.json`
para que cada vez que se cree o edite una SKILL.md el sistema la indexe
automáticamente en Qdrant y actualice skill-catalog.json — sin intervención manual.

**IMPORTANTE**: No aplicar con un script automatizado. USER debe revisarlo,
validarlo en un entorno de prueba, y pegarlo a mano o con un script específico
de migración (`settings-patch.py`, aún no existe).

---

## Contexto — estado actual

`~/.claude/settings.json` tiene hoy:

```json
"PostToolUse": [
  {
    "matcher": "Edit|Write|MultiEdit",
    "hooks": [
      {
        "type": "command",
        "command": "node C:/Users/USER/.ultron/hooks/scripts/capture-symbols.js",
        "timeout": 10,
        "async": true
      }
    ]
  }
],
"Stop": [
  { ... stop-compress-session.js ... },
  { ... kanban-update-reminder.js ... },
  { ... batch-capture.js ... },
  { ... qdrant-mirror-sync.js ... },
  { ... route_quality_aggregator.py aggregate --today ... }
]
```

---

## Patch propuesto

### 1. PostToolUse — indexado incremental al guardar SKILL.md

Añadir un segundo entry en el array `PostToolUse` justo después del entry existente:

```json
{
  "matcher": "Edit|Write|MultiEdit",
  "hooks": [
    {
      "type": "command",
      "command": "uv run python C:/Users/USER/.ultron/scripts/cockpit/ultron_skill_add.py \"${tool_input.file_path}\"",
      "timeout": 30,
      "async": true,
      "_comment": "Solo se activa si el archivo es SKILL.md — ultron_skill_add.py valida el nombre internamente y sale con 0 si no es SKILL.md sin tocar nada."
    }
  ]
}
```

**Comportamiento esperado:**

- Si el archivo editado ES un SKILL.md válido:
  - Valida frontmatter (name, description, tags).
  - Embebe en Qdrant (incremental — solo si desc_sha1 cambió).
  - Actualiza skill-catalog.json.
  - Sale con código 0. El hook es async → no bloquea la sesión.
- Si NO es un SKILL.md o no tiene frontmatter correcto:
  - Sale silenciosamente con código 1 (no muestra error al usuario).
  - Qdrant no es tocado.

**Nota de implementación pendiente**: El script actualmente valida que
`skill_path.name == "SKILL.md"` y devuelve `{"ok": False, "error": "..."}` si
no lo es, pero devuelve exit code 1. Para que el hook sea completamente silencioso
con archivos no-SKILL.md habría que añadir un early-exit con código 0 cuando el
nombre no coincide. Ejemplo de parche en `ultron_skill_add.py`:

```python
# En la función add_skill(), antes del bloque de validación:
if skill_path.name != "SKILL.md":
    return {"ok": True, "skipped": True, "reason": "not a SKILL.md"}
```

Con este cambio el hook es completamente no-intrusivo.

---

### 2. Stop — rebuild full trimestral (no semanal, para ahorrar tokens)

Añadir al array `Stop` un entry nuevo:

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "uv run python C:/Users/USER/.ultron/scripts/cockpit/embed_skills.py index",
      "timeout": 120,
      "async": true,
      "_comment": "Sync incremental al final de cada sesión. Duración típica <1s si el estado está al día; ~30-60s en cold start o tras instalar muchas skills nuevas."
    }
  ]
}
```

**Nota sobre el rebuild trimestral**: `embed_skills.py index` sin `--rebuild` ya es
incremental (salta skills con desc_sha1 sin cambios). El rebuild destructivo
(`--rebuild`) limpia huérfanos pero es más caro. Recomendación: ejecutar
`--rebuild` manualmente una vez al trimestre o después de desinstalar skills en
masa. No incluirlo en el hook Stop para no penalizar cada sesión.

---

## Resultado completo de settings.json (sección hooks)

Abajo el JSON final de la sección `hooks` con los dos entries nuevos marcados
con `// NUEVO`:

```json
"hooks": {
  "PostToolUse": [
    {
      "matcher": "Edit|Write|MultiEdit",
      "hooks": [
        {
          "type": "command",
          "command": "node C:/Users/USER/.ultron/hooks/scripts/capture-symbols.js",
          "timeout": 10,
          "async": true
        }
      ]
    },
    {
      "matcher": "Edit|Write|MultiEdit",
      "hooks": [
        {
          "type": "command",
          "command": "uv run python C:/Users/USER/.ultron/scripts/cockpit/ultron_skill_add.py \"${tool_input.file_path}\"",
          "timeout": 30,
          "async": true
        }
      ]
    }
  ],
  "Stop": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node C:/Users/USER/.claude/scripts/stop-compress-session.js",
          "timeout": 30,
          "async": true
        }
      ]
    },
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node C:/Users/USER/.claude/scripts/kanban-update-reminder.js",
          "timeout": 5,
          "async": true
        }
      ]
    },
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node C:/Users/USER/.claude/scripts/batch-capture.js",
          "timeout": 10,
          "async": true
        }
      ]
    },
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node C:/Users/USER/.ultron/hooks/scripts/qdrant-mirror-sync.js",
          "timeout": 30,
          "async": true
        }
      ]
    },
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "uv run python C:/Users/USER/.ultron/scripts/cockpit/route_quality_aggregator.py aggregate --today",
          "timeout": 20,
          "async": true
        }
      ]
    },
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "uv run python C:/Users/USER/.ultron/scripts/cockpit/embed_skills.py index",
          "timeout": 120,
          "async": true
        }
      ]
    }
  ]
}
```

---

## Checklist antes de aplicar

- [ ] Probar `uv run python scripts/cockpit/ultron_skill_add.py --help` — sin errores.
- [ ] Probar con una SKILL.md de prueba: `uv run python scripts/cockpit/ultron_skill_add.py ~/.claude/skills/don-claudio/SKILL.md`.
- [ ] Verificar que Qdrant está corriendo (`embed_skills.py status`).
- [ ] Añadir early-exit silencioso en `ultron_skill_add.py` para archivos no-SKILL.md (ver nota arriba).
- [ ] Hacer backup de `~/.claude/settings.json` antes de editar.
- [ ] Aplicar el patch manualmente (editar el JSON o con `jq`).
- [ ] Crear una SKILL.md de prueba nueva y verificar que aparece en `skill-catalog.json` sin intervención manual.

---

## Alternativa futura: skill-watcher.js

Como mejora futura (no urgente), se puede crear un `skill-watcher.js` que use
`chokidar` para monitorear `~/.claude/skills/**` en background y llamar a
`ultron_skill_add.py` automáticamente. Esto elimina la dependencia del hook
PostToolUse y funciona incluso al copiar skills manualmente desde el explorador.
