# Quiz template — reusable type-test for any topic

Origen: `~/CARRERA/ASIGNATURAS/AppMoviles/codigo/OrbitalDB/APUNTES_EXAMEN/quiz/`
Copiado a ULTRON 2026-05-27 como base reutilizable.

## Schema actual (`questions.example.json`)

```json
{
  "version": "2.0.0",
  "topics": {
    "T1": {
      "name": "<topic>",
      "questions": [
        {
          "question": "...",
          "options": ["a", "b", "c", "d"],
          "correct": 1,
          "explanation": "..."
        }
      ]
    }
  }
}
```

Tipo único: single-choice 4 opciones, 0-indexed `correct`, explicación libre.

## Roadmap de mejoras (registrado en kanban ULTRON 2026-05-27)

1. **Schema v3** que soporte más tipos:
   - `single` (actual)
   - `multi` (multi-select)
   - `truefalse`
   - `fill_blank`
   - `order` (ordenar items)
   - `match` (emparejar pares)
2. **HTML/JS configurable**: penalty per wrong, número de preguntas, modos custom, mostrar/ocultar explicación.
3. **JSON-only authoring**: el HTML/JS quedan fijos; solo cambia el JSON.
4. **Quiz Generator panel** en ULTRON Control Center:
   - Tab nueva "Quiz Generator"
   - Drag-drop de ficheros/carpetas con temario (md, pdf, txt)
   - Parámetros: nº preguntas/tema, dificultad, tipos a generar
   - Instrucciones previas configurables
   - Backend tauri command llama a Claude Sonnet vía API
   - Output: JSON v3 listo para colocar en `quiz-instance/data/questions.json`
5. **Spawn de quiz instance**: comando `ultron quiz new <topic-slug>` que copia el template a una carpeta nueva con el JSON generado dentro.

## Compromiso de diseño
- Full black (ULTRON aesthetic). El styles.css actual ya tira a oscuro; ajustar paleta para que coincida con `--color-background`, `--color-accent` del Control Center.
- Cero emojis en UI nueva. El template original tiene emojis en headers — limpiar al portarlo.

Ver `kanban.json` cards `card-quiz-gen-*` para tracking detallado.
