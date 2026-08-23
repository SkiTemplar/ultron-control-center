# Corpus de evaluacion del detector de texto IA

Muestras etiquetadas para medir el catalogo con `scripts/ai-text-eval.mjs`.

- `ia/` — texto generado por IA, en espanol.
- `humano/` — texto escrito por una persona.

**El contenido esta fuera del repo** (`.gitignore`): son textos personales y
este repositorio es publico. Solo se versiona este README.

## Como anadir muestras

Un fichero por muestra, `.md` o `.txt`. **La extension importa**: en `.md` el
detector exime los patrones de markup, que ahi son sintaxis legitima. Guarda
cada muestra con la extension del destino real donde ese texto viviria.

Cuanto mas se parezca el corpus a lo que escribes de verdad (memoria del TFG,
informes, prosa academica), mas valen las cifras. Un corpus de texto de chat
mide el detector sobre texto de chat, no sobre tu TFG.

## Que mirar

```bash
node scripts/ai-text-eval.mjs
```

Por patron: cobertura (documentos IA en que dispara), falsos positivos
(documentos humanos en que dispara) y densidad de senales. Al final, el
veredicto a nivel documento con el umbral del gate.

Un patron con cobertura 0% no protege de nada. Uno con falsos positivos altos
te hace reescribir prosa que ya estaba bien.
