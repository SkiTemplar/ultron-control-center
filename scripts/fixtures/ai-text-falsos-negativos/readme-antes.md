Cockpit personal de escritorio (Tauri 2 + React 19) construido sobre la CLI de
Claude Code. Vive bajo `~/.ultron/` y reune tres piezas: **memoria gobernada**,
**AI Router** y un **orquestador de skills/agentes**. No reemplaza a Claude
Code: lo envuelve con estado persistente, inspeccionable y versionable.

> Repositorio MIT de un solo mantenedor, pensado para publicarse (hoy la
> visibilidad la decide el mantenedor: si puedes leer esto en GitHub, ya es
> publico). No es un producto comercial ni un SaaS. Esta documentacion
> describe el sistema tal y como esta en el disco; no contiene secretos ni
> datos personales (la informacion personal vive solo en ficheros locales
> fuera de control de versiones).

- **Version**: 15.8.0 (`control-center/package.json`, `Cargo.toml`, `tauri.conf.json`)
- **Plataforma**: Windows 11 (objetivo principal); Linux x86_64 compila pero el
  flujo end-to-end no esta verificado por el autor.
- **Licencia**: MIT (ver [`LICENSE`](LICENSE)).

---

## Quickstart

**Sistema completo** (app + skills + hooks + memoria semantica) — el camino
recomendado; es idempotente y pregunta antes de tocar nada:

```powershell
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
powershell -ExecutionPolicy Bypass -File .\install.ps1   # Linux: ./install.sh
```

**Instalacion por componentes** (sin wizard, determinista; `-DryRun` lista el
plan sin tocar nada):

```powershell
.\install.ps1 -Core            # app + memoria + hooks (el set por defecto)
.\install.ps1 -All             # core + skills + tones + agents
.\install.ps1 -Skills -Tones   # a la carta
.\install.ps1 -Core -DryRun    # solo listar que haria
# Linux: ./install.sh --core | --all | --skills | --tones | --agents | --dry-run
```

**Solo la app de escritorio** (sin skills/hooks/sidecar de memoria):

```bash
git clone https://github.com/SkiTemplar/ultron-control-center.git ~/.ultron && cd ~/.ultron/control-center
cp ../.env.example ../.env   # opcional: claves de proveedores LLM (todas vacias por defecto)
npm install
npm run build:app            # = kill-app + tauri build -> ejecutable de escritorio
```

Guia completa (bootstrap one-liner desde release, flags, troubleshooting):
[`INSTALL.md`](../../../INSTALL.md).

Qdrant es opcional (el recall degrada a sparse-only sin el); ver la seccion
Qdrant de [`docs/INSTALL-ADVANCED.md`](../../../docs/INSTALL-ADVANCED.md).
Las rutas per-maquina se documentan en
[`config/paths.example.toml`](config/paths.example.toml).

## Caracteristicas

- **Memoria gobernada** — `brain.db` (SQLite) como unica fuente de verdad; todo
  cambio pasa por un unico servicio que anexa un evento de auditoria.
- **Recall hibrido** — denso (E5 1024d / Qdrant) + sparse (FTS5/BM25) fusionados
  con Reciprocal Rank Fusion; degrada a sparse-only sin Qdrant.
- **Inbox de candidatos** — las capturas automáticas proponen y el humano aprueba.
  Hay dos excepciones opcionales (desactivadas por defecto, en
  `cockpit/memory-settings.json`): `auto_approve` promueve los candidatos limpios
  que superan el umbral (0,72 por defecto) y `auto_supersede` sustituye un item
  activo por su actualización 1:1.
- **Redaccion + dedupe** en el write-path — secretos/PII fuera, duplicados por
  `content_hash` fuera, antes de persistir o embeber.
- **AI Router** — cadena primario -> fallbacks por zona, deteccion de claves y
  telemetria de uso/ahorro; routing directo en Rust (sin sidecar LiteLLM).
- **Orquestador por reglas** — mapea prompt -> intent -> workflow -> agentes ->
  memorias; reserva el modelo grande solo para la cola ambigua.
- **Tonos / personalidades** — deteccion determinista del tono del chat
  (senales lexicas + peticion explicita) dentro del orchestrate; los tonos se
  editan en Library -> Tones. La config real (`~/.ultron/personality.json`) es
  local y gitignored; el repo publica solo los seeds compilados
  (`orchestrator/personality.rs`). El tono viste unicamente la conversacion:
  nunca commits, docs ni artefactos.
