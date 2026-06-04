<!--
  ULTRON Control Center — README (Español)
-->

# ULTRON Control Center

Repositorio **privado**, de un solo usuario. El README principal ya esta en
español: ver **[`README.md`](README.md)**.

- Que es: cockpit de escritorio (Tauri 2 + React 19) sobre la CLI de Claude Code,
  con memoria gobernada, AI Router y orquestador de skills/agentes.
- Arquitectura: `~/.ultron/brain.db` (SQLite) = unica fuente de verdad; Qdrant
  `ultron_memory` (E5 1024d) = indice derivado; recall hibrido denso+sparse con
  RRF; captura automatica via Stop hook hacia un inbox de candidatos.
- Quickstart y build: `npm run build:app` desde `control-center/` — pasos
  completos en [`README.md`](README.md#quickstart).
- Rutas per-maquina: [`config/paths.example.toml`](config/paths.example.toml).
- Licencia: MIT (ver [`LICENSE`](LICENSE)).

Toda la documentacion vive en [`README.md`](README.md).
