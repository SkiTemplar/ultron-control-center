---
name: recall-aporta-el-hecho
---

# Qué se está midiendo

Este caso existe para responder a una sola pregunta: **¿el recall de memoria
aporta algo que el modelo no tendría de otro modo?**

El hecho elegido (la política de disparo del hook `kanban-update-reminder.js`
v3.0) vive en `brain.db` como una decisión capturada, y **no** está escrito en
`CLAUDE.md`, en el README ni en ningún otro fichero que el modelo lea de
entrada. Por eso sirve de sonda: bajo `--ablation with-without`, el arm sin
plugin no puede acertarlo salvo leyendo el código del hook, y el arm con
plugin solo acierta si el recall recupera la entrada correcta y la inyecta.

Un delta cercano a cero entre ambos arms significa que el recall no está
aportando — no que el sistema esté roto, sino que ese hecho no llegaba.

# Criterios

La respuesta es correcta si recoge, como mínimo, **dos** de estos elementos,
sin contradecir ninguno:

- El hook habla solo tras una edición (`Edit` / `Write`) o tras un `git commit`.
- Cierra la tarjeta por coincidencia con el commit.
- Nombra la tarjeta que está En Progreso.
- Tiene un cooldown de 30 minutos.
- Habla una sola vez por sesión.

## Fallo

- Inventa una política de disparo distinta (cifras de cooldown que no son 30
  minutos, disparadores que no aparecen arriba). Una alucinación segura es
  **peor** que admitir desconocimiento: puntúa por debajo de "no lo sé".
- Responde con generalidades sobre hooks sin comprometerse con la política
  concreta.

## Aprobado parcial

- Dice explícitamente que no tiene el dato, sin inventarlo. Es la respuesta
  correcta para el arm sin plugin y no debe penalizarse como alucinación.
