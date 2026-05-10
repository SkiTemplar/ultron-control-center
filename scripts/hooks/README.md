# ULTRON HOOKS — Recomendados (Opt-in)

> Scripts de hook listos para usar. **No están instalados** por default — USER decide cuáles activar.
> Última actualización: 2026-04-27 · v1.0

---

## 📋 Hooks disponibles

| Hook | Evento | Función |
|---|---|---|
| `auto-approve-readonly.py` | `PreToolUse` | Auto-aprueba Read/Glob/Grep/WebFetch/WebSearch sin prompt |
| `block-dangerous-bash.py` | `PreToolUse` (Bash) | Bloquea `rm -rf /`, `git push --force main`, `DROP DATABASE`, etc. |
| `session-log.py` | `Stop` | Append entry a `~/.ultron/sessions/YYYY-MM-DD.md` por sesión |
| `routing-telemetry.py` (v8.1.2) | `PostToolUse` (Skill\|Agent) | Append JSONL a `~/.ultron/sessions/YYYY-MM-DD/routing.jsonl` con persona/plugin/subagente invocado — base para benchmark empírico de uso |

---

## 🚀 Cómo activar uno

Editar `~/.claude/settings.json` añadiendo el bloque `hooks`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Glob|Grep|WebFetch|WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "python C:/Users/USER/.claude/skills/ultron/hooks/auto-approve-readonly.py"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python C:/Users/USER/.claude/skills/ultron/hooks/block-dangerous-bash.py"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python C:/Users/USER/.claude/skills/ultron/hooks/session-log.py"
          }
        ]
      }
    ]
  }
}
```

**Tip:** la skill `update-config` (sistema CC) puede aplicar estos cambios via Skill tool si quieres orquestarlo automáticamente.

---

## 🧪 Testar un hook localmente

Cada script lee JSON por stdin y escribe JSON por stdout. Para probar:

```bash
echo '{
  "hook_event_name": "PreToolUse",
  "tool_name": "Read",
  "tool_input": {"file_path": "test.txt"}
}' | python ~/.claude/skills/ultron/hooks/auto-approve-readonly.py
```

Salida esperada (auto-approve):
```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "Read-only tool 'Read' auto-approved by ULTRON hook"}}
```

---

## ⚠️ Caveats

1. **`auto-approve-readonly`** quita prompts también para `WebFetch`/`WebSearch`. Si trabajas con sistemas sensibles donde quieres confirmar cada fetch externo, NO actives este hook (o quita esos tools del set).
2. **`block-dangerous-bash`** es heurístico — no cubre todos los casos peligrosos posibles. Es complemento al sentido común, no sustituto.
3. **`session-log`** crea el directorio `~/.ultron/sessions/` si no existe. Si quieres que viva en otra ruta, edita el script.
4. **Path en Windows con backslash:** los scripts usan forward slashes en paths. CC en Windows acepta ambas; en JSON usar siempre `/`.
5. **Permission prompt para el hook:** la primera vez que CC ejecute el comando, te pedirá permiso. Una vez aprobado, queda persistente.

---

## 🔧 Crear hooks nuevos

Patrón:
1. Recibir JSON por `stdin`.
2. Comprobar `hook_event_name` y `tool_name`.
3. Hacer la lógica.
4. Si quieres bloquear/permitir: imprimir JSON con `hookSpecificOutput.permissionDecision`.
5. Si solo logging: salir sin imprimir nada (sys.exit 0).

Para más patrones ver `~/.ultron/knowledge/claude-platform/subagents-and-hooks.md`.

---

## 📚 Fuentes

- [Hooks reference (Claude Code)](https://code.claude.com/docs/en/hooks)
- [Hooks (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/hooks)
- `~/.ultron/knowledge/claude-platform/subagents-and-hooks.md`
