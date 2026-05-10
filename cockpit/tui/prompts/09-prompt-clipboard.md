# Botón 9 — Prompt Folder Audit (Codex directo)

> Este botón abre **Codex** directamente con el prompt cargado en el portapapeles.
> No pasa por Claude/Ultron — Codex audita en sandbox read-only los prompts
> que viven en `~/.ultron/cockpit/tui/prompts/` y otros prompts relacionados del Cockpit.

```
Audita los prompts de la TUI de ULTRON. Sandbox read-only. No edites nada.

OBJETIVO:
  Verificar que los 8 prompts de Kirkardo (botones 1-8 del AutoUpdater) están
  up-to-date con el estado actual de ULTRON y comunican su intención de forma
  clara, eficiente y reusable. Tú solo auditas: los cambios los aplica
  Claude/USER después.

INPUTS:
  1. Prompts principales:
       ~/.ultron/cockpit/tui/prompts/01-memoria.md
       ~/.ultron/cockpit/tui/prompts/02-skill-network.md
       ~/.ultron/cockpit/tui/prompts/03-vault.md
       ~/.ultron/cockpit/tui/prompts/04-hooks.md
       ~/.ultron/cockpit/tui/prompts/05-cockpit.md
       ~/.ultron/cockpit/tui/prompts/06-self-improve.md
       ~/.ultron/cockpit/tui/prompts/07-skills.md
       ~/.ultron/cockpit/tui/prompts/08-todo-sistema.md

  2. Prompts relacionados:
       - Buscar read-only otros *.md/*.txt bajo ~/.ultron/cockpit/
       - Reportarlos aparte como “prompts relacionados”, sin tratarlos como botones 1-8.

  3. Ground truth:
       ~/.claude/skills/ultron/CLAUDE.md
       ~/.claude/skills/ultron/SKILL.md
       ~/.claude/skills/ultron/protocols.md § AUTO-MEJORA + § EXISTENCE GATE
       ~/.claude/skills/ultron/scripts/cockpit/
       ~/.claude/skills/ultron/scripts/cockpit/tui.py § AUDIT_BUTTONS

EJES DE EVALUACIÓN:
  - Frescura
  - Claridad de objetivo
  - Estructura
  - Especificidad
  - Mensurabilidad
  - Token efficiency
  - Tono consistente
  - Anti-laundering

PROCESO:
  1. Lee los 8 prompts, prompts relacionados y ground truth.
  2. Para cada prompt 1-8 entrega scores, frescura, líneas a reescribir,
     versión refinada completa y diff antes/después.
  3. Para prompts relacionados entrega solo: path, propósito inferido,
     riesgos de frescura y si conviene alinearlo con el formato estándar.
  4. Cierra con inconsistencias globales, patrón estándar recomendado,
     TOP 3 urgentes y nota global X/10.

PROHIBIDO:
  - Modificar cualquier archivo.
  - Ejecutar las acciones que los prompts describen.
  - Auditar arquitectura/scripts/hooks de ULTRON más allá de validar referencias.
  - Sugerir botones nuevos.
  - Tocar archivos en ~/.ultron/, ~/.claude/, ~/.ultron-vault/.

OUTPUT:
  Imprime el report completo en stdout. No persistir.
```
