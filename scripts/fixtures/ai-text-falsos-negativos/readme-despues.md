Cockpit personal de escritorio (Tauri 2 + React 19) construido sobre la CLI de
Claude Code. Vive bajo `~/.ultron/` y reúne tres piezas: memoria gobernada,
AI Router y un orquestador de skills y agentes. Se ejecuta sobre Claude Code y
le añade un estado persistente que se puede inspeccionar y versionar.

> Repositorio MIT de un solo mantenedor, pensado para publicarse. Hoy la
> visibilidad la decide el mantenedor: si puedes leer esto en GitHub, ya es
> público. No es un producto comercial ni un SaaS. La documentación no contiene
> secretos ni datos personales: la información personal vive solo en ficheros
> locales fuera de control de versiones.

- Versión: 15.8.0 (`control-center/package.json`, `Cargo.toml`, `tauri.conf.json`).
- Plataforma: Windows 11 es el objetivo principal. Linux x86_64 compila, pero el
  autor no ha verificado el flujo completo.
- Licencia: MIT (ver [`LICENSE`](LICENSE)).

---

## Quickstart

Para instalar el sistema completo (app, skills, hooks y memoria semántica) hay
un camino recomendado. Es idempotente y pregunta antes de tocar nada:

```powershell
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
powershell -ExecutionPolicy Bypass -File .\install.ps1   # Linux: ./install.sh
```

La instalación por componentes no usa el asistente y es determinista. Con
`-DryRun` lista el plan sin tocar nada:

```powershell
.\install.ps1 -Core            # app + memoria + hooks (el set por defecto)
.\install.ps1 -All             # core + skills + tones + agents
.\install.ps1 -Skills -Tones   # a la carta
.\install.ps1 -Core -DryRun    # solo listar que haria
# Linux: ./install.sh --core | --all | --skills | --tones | --agents | --dry-run
```

Si solo quieres la app de escritorio, sin skills, hooks ni sidecar de memoria:

```bash
git clone https://github.com/SkiTemplar/ultron-control-center.git ~/.ultron && cd ~/.ultron/control-center
cp ../.env.example ../.env   # opcional: claves de proveedores LLM (todas vacias por defecto)
npm install
npm run build:app            # = kill-app + tauri build -> ejecutable de escritorio
```

La guía completa (bootstrap desde release, flags y resolución de problemas)
está en [`INSTALL.md`](../../../INSTALL.md).

Qdrant es opcional: sin él, el recall pasa a sparse-only (ver la sección Qdrant
de [`docs/INSTALL-ADVANCED.md`](../../../docs/INSTALL-ADVANCED.md)). Las rutas de cada
máquina se documentan en [`config/paths.example.toml`](config/paths.example.toml).

## Características

- Memoria gobernada: `brain.db` (SQLite) es la única fuente de verdad, y todo
  cambio pasa por un único servicio que anexa un evento de auditoría.
- Recall híbrido: denso (E5 1024d / Qdrant) y sparse (FTS5/BM25), fusionados
  con Reciprocal Rank Fusion. Sin Qdrant queda solo el sparse.
- Inbox de candidatos: las capturas automáticas proponen y el humano aprueba.
  Hay dos excepciones opcionales, desactivadas por defecto, en
  `cockpit/memory-settings.json`: `auto_approve` promueve los candidatos limpios
  que superan el umbral (0,72 por defecto) y `auto_supersede` sustituye un item
  activo por su actualización 1:1.
- Redacción y dedupe en el write-path: antes de persistir o embeber se eliminan
  los secretos y la PII, y también los duplicados por `content_hash`.
- AI Router: cadena primario -> fallbacks por zona, detección de claves y
  telemetría de uso y ahorro. El routing es directo en Rust, sin sidecar LiteLLM.
- Orquestador por reglas: mapea prompt -> intent -> workflow -> agentes ->
  memorias, y reserva el modelo grande para la cola ambigua.
- Tonos y personalidades: el orchestrate detecta el tono del chat de forma
  determinista (señales léxicas y petición explícita), y los tonos se editan en
  Library -> Tones. La config real (`~/.ultron/personality.json`) es local y
  está en gitignore; el repo publica solo los seeds compilados
  (`orchestrator/personality.rs`). El tono viste únicamente la conversación y
  nunca llega a commits, docs ni artefactos.
