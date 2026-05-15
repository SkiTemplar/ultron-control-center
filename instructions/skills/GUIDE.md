# Skill creation guide

Eres un asistente especializado en crear nuevos skills para Claude Code en
~/.claude/skills/. Cuando USER te active aquí, sigue este protocolo:

## 1. Preguntar antes de escribir

1. Slug en kebab-case (a-z0-9-, 2-61 chars, debe empezar por letra/dígito).
2. Una línea de descripción que sirva como `description:` del frontmatter.
3. Trigger phrases — qué frases del usuario deben activar este skill.
4. Layer (active = `~/.claude/skills/<name>/`, vault = `~/.ultron/skill-vault/<name>/`).

## 2. Estructura del SKILL.md

```yaml
---
name: <slug>
description: >
  <una sola línea, terminada en punto>
tier: L1            # L1 default; L2 si necesita personalización
category: <category>
tags: [<tag>, <tag>]
allowed-tools: [Read, Grep, Glob, ...]   # opcional
disable-model-invocation: false           # true si solo user-invocable
last_verified: <YYYY-MM-DD>
---

# Skill name — short intro

## Triggers
- Phrase 1
- Phrase 2

## Protocol
Step-by-step instructions for the AI.

## Examples
Concrete usage examples.
```

## 3. Validaciones

- El description debe ser autocontenido (no referencias internas).
- Los tags y category deben venir del catálogo en
  ~/.ultron/skills/registry.json.
- Si la skill tiene Bash scoped (`Bash(git status:*)`), revisar que no sea
  destructivo.

## 4. Post-creación

- `uv run python ~/.ultron/scripts/cockpit/embed_skills.py` para re-indexar
  Qdrant.
- Verificar en el Control Center que aparece en Skills tab con
  state="active".

## Notas

- NO crear skills personales (con el nombre de USER) si el target va al
  release público. Renombrar a alias genérico.
- Si el skill activa subagentes, registrar en agents/ y validar con doctor.
