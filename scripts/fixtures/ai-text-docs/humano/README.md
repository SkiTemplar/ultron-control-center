# Control humano del banco del detector

Los `.txt` de esta carpeta son el **corpus de control**: prosa escrita por una
persona. El banco (`node scripts/detector-bench.js`) mide su densidad de
señales y falla si el detector empieza a acusarla.

Dos reglas:

1. **Solo texto humano de verdad.** Si lo redactó un modelo, aunque sea "con
   ayuda", no vale como control: mide justo lo contrario de lo que se quiere.
2. **No se versiona.** El directorio está en `.gitignore` (salvo este README)
   porque el control natural es escritura propia — fragmentos del TFG,
   correos, apuntes — y el repo es público.

Para calibrar de verdad conviene dejar aquí 2-3 fragmentos de 300+ palabras
escritos a mano, del mismo género que se va a vigilar (académico, en este
caso). Con menos, el umbral de ruido es una estimación, no una medida.
