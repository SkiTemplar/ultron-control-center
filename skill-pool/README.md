# skill-pool

Pool de skills y herramientas de terceros que se activan por proyecto en lugar de globalmente. Plan: `plans/2026-10-18-skill-pool.md`.

- `pool.json` (versionado): una entrada por pieza, con repo, SHA fijado (o versión en `python-lib`), subcarpeta, tipo, licencia, plantillas que la sugieren y revisión de seguridad.
- `repos/` (ignorado por git): clones en `repos/<nombre>@<sha7>/`, con el HEAD fijado en el SHA de `pool.json`. No se ejecuta nada de ellos.

Se gestiona solo con `node scripts/skill-pool.mjs` (`--help` para la lista de subcomandos). `link` exige que el HEAD del clon coincida con el SHA fijado y que la entrada tenga revisión para ese SHA; `update --accept` re-fija y deja la revisión a `null`. `doctor` comprueba la pool y los enlaces de los proyectos registrados.
