# skill-lazy — PILAR 2: Lazy-Loading de Skills

Artefactos de staging para reducir el coste de tokens en SessionStart
sin tocar la configuracion viva.

---

## Problema

Claude Code carga los metadatos (SKILL.md) de TODAS las skills activas en
SessionStart. Con ~80 skills activas el coste medido es ~39-40 k tokens
por sesion unicamente en la categoria Skills.

---

## Solucion

Dos niveles complementarios:

### Nivel 1 (fisico): apply-lazy-skills.ps1

Renombra a `<nombre>.disabled` las carpetas de las 73 skills marcadas
`keep_active: false` en `skills-registry.json`. Claude Code ignora
carpetas `.disabled` en SessionStart. Resultado: solo cargan las 10
skills complejas (keep_active: true), que suman ~30 k tokens frente a
los ~195 k del total.

### Nivel 2 (dinamico): routing-dispatcher.v2.js

Extiende el dispatcher v1 sin romper nada. Cuando una skill `lazy_loadable`
puntua >=0.80, el hook lee su SKILL.md de disco (async, timeout 5 s) e
inyecta el contenido en `additionalContext` bajo el encabezado:

    --- [skill-inyectada: NOMBRE] ---
    <contenido de SKILL.md>
    --- [fin skill-inyectada: NOMBRE] ---

El coste por-prompt es proporcional al tamano del SKILL.md inyectado
(tipicamente 500-6000 tokens). Solo se paga cuando la skill se necesita.

---

## Clasificacion de skills

| Categoria       | Criterio                                              | Count | keep_active | lazy_loadable |
|-----------------|-------------------------------------------------------|-------|-------------|---------------|
| Complejas       | Sub-archivos/scripts/referencias reales (10 skills)   | 10    | true        | false         |
| Lazy (personas) | Solo SKILL.md, persona o patron simple                | 73    | false       | true          |

Las 10 complejas son: ultron, docx, pdf, ui-ux-pro-max, senior-engineer,
continuous-learning-v2, gamedev-engineer, business-strategist, ui-designer,
hiper-plans.

---

## Ahorro estimado

| Escenario                             | Tokens SessionStart |
|---------------------------------------|---------------------|
| Sin cambios (todas activas)           | ~195 k              |
| Solo Nivel 1 (10 complejas activas)   | ~30 k               |
| Ahorro                                | ~165 k (~85%)       |

El dato de referencia (~39-40 k/sesion en la categoria Skills) corresponde
a una sesion tipica con ~80 skills activas medida en telemetria de routing.
El calculo de 195 k es el total real de todos los SKILL.md activos dividido
entre 4 (bytes/token).

---

## Como aplicar (Nivel 1)

Abrir PowerShell en el directorio de este archivo:

    .\apply-lazy-skills.ps1

Esto renombra las 73 carpetas lazy a `<nombre>.disabled`. La operacion
es idempotente: si ya estan desactivadas, las omite.

Verificar que funciona reiniciando Claude Code y comprobando el contexto
de SessionStart (deberia ser notablemente mas corto).

---

## Como revertir (Nivel 1)

    .\apply-lazy-skills.ps1 -Undo

Restaura todos los nombres originales. Vuelve a activar las 73 skills.

---

## Como activar el Nivel 2 (dispatcher v2)

El archivo `routing-dispatcher.v2.js` es un reemplazo directo del v1.
Para activarlo en la configuracion viva:

1. Hacer copia de seguridad del v1:
   cp ~/.claude/scripts/routing-dispatcher.js ~/.claude/scripts/routing-dispatcher.v1.bak.js

2. Copiar el v2 al lugar del v1:
   cp cockpit/skill-lazy/routing-dispatcher.v2.js ~/.claude/scripts/routing-dispatcher.js

3. Verificar sintaxis:
   node --check ~/.claude/scripts/routing-dispatcher.js

El v2 es compatible hacia atras: si el registry no existe o falla la
lectura, se comporta exactamente igual que el v1.

---

## Trade-off por-prompt

- SessionStart sin lazy: paga ~165 k tokens extra SIEMPRE, use o no esa skill.
- Nivel 2 inyeccion: paga 500-6000 tokens SOLO cuando la skill puntua >=0.80.
- Cooldown de 2 invocaciones: evita re-inyectar la misma skill en prompts
  consecutivos dentro de la misma sesion.
- Fallback graceful: si el disco falla, el hook emite la sugerencia normal
  sin contenido adicional. Nunca bloquea el prompt.

---

## Archivos en esta carpeta

| Archivo                      | Descripcion                                              |
|------------------------------|----------------------------------------------------------|
| routing-dispatcher.v2.js     | Hook v2 con lazy injection                               |
| skills-registry.json         | Registro de todas las skills con clasificacion           |
| apply-lazy-skills.ps1        | Script reversible para desactivar skills lazy            |
| README.md                    | Este documento                                           |
