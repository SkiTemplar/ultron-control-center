---
type: design-blueprint
target: ULTRON v13.0 "The Foundation"
fix_id: ARCH-01
parent_audit: kirkardo-total-2026-05-03.md
effort_estimate: 8-12h
status: BLUEPRINT (no migration applied yet)
date: 2026-05-03
---

# ARCH-01 — SSOT Contractual + Path Resolver (v13.0 Blueprint)

> Blueprint de diseño post-Kirkardo TOTAL Triple. Resuelve simultáneamente:
> S-CRIT-1 (3 SSOT contradictorias), S-CRIT-2 (frontmatter al 0%),
> S-CRIT-3 (PERSONAS hardcoded), C-CRIT-2 (paths hardcoded),
> H-MED-1/2 (hook auto-derivado), S-MED-2/3 (knowledge tabla drift).
>
> **No migrar hoy.** Este documento es la decisión arquitectónica que
> guiará la implementación de v13.0 "Foundation" (4-6 semanas).

---

## 0. Diagnóstico (recap del audit)

| SSOT actual | Contenido | Problema |
|---|---|---|
| `~/.ultron/cockpit/skill_manifest.json` (277 KB) | Manifest oficial v2.0, 373 skills | Generado parcial, sin contrato de validez |
| `~/.ultron/cockpit/skills-registry.json` | Registries por root (claude/codex/agents) | Información derivable del manifest, pero usado como canónico |
| `~/.ultron/cockpit/agent_manifest.json` | Agentes (sub-categoría) | Solapamiento parcial con manifest |
| `routing-tables.md` | Tablas markdown que routing parsea | Frágil, parse de strings |
| `routing-telemetry.py:41-46` | `PERSONAS = (...)` constante | Hardcoded, drift inmediato |
| `references/version-policy.md` | Tabla skill→versión | Maintained a mano |
| `mode-*.md` headers | Versión por modo | Drift permanente (FIX-3 de hoy) |

**Conteo personas:** frontmatter dice "14 personas", pero `PERSONAS=` tuple tiene 13, routing-matrix dice 15, referencias dicen 14. **4 verdades distintas para el mismo dato.**

**Path-related drift:** scripts hardcodean `Path.home() / ".ultron"` en 60+ archivos. Renombrar `.ultron` requeriría edit masivo. `_categorize_skills.py:458` literal `C:\Users\USER\.claude\skills` (machine-specific).

---

## 1. Decisiones de diseño

### 1.1 Manifest único canónico

**`~/.ultron/cockpit/skill_manifest.json`** es la **única** fuente de verdad. Todo lo demás se deriva:

- `skills-registry.json` → derivado de `skill_manifest.entries[].present_in[]` (por root). Borrar como archivo independiente; o regenerar como cache derivada con marker `_derived: true`.
- `agent_manifest.json` → derivado de `entries[].kind == "agent"`. Mismo tratamiento.
- `claude_exclusive` → campo `entries[].claude_exclusive: bool` en manifest.
- `routing-tables.md` → **artefacto generado** por `skill_manifest_to_routing.py` (ya existe, falta promover a flujo CI).
- `PERSONAS` constante en routing-telemetry.py → **artefacto generado** por nuevo `skill_manifest_to_constants.py` que escribe `routing_telemetry_constants.py` (importable).
- `references/version-policy.md` tabla → **artefacto generado** por `skill_manifest_to_version_policy.py`.

### 1.2 Frontmatter contractual (gate de build)

Schema mínimo obligatorio en TODOS los SKILL.md:

```yaml
---
name: <slug>                 # match dirname
description: <≤200 chars>    # 1-line trigger spec
kind: persona | plugin | skill | agent | meta
tier: L1 | L2 | L3           # L1=hot, L2=cold, L3=remote
category: <known-category>   # validated against enum
last_verified: YYYY-MM-DD    # required, refreshed on edit
version: vX.Y.Z              # SemVer
---
```

**Enforcement:**
- Nuevo `validate_skill_frontmatter.py` corre como pre-commit en `~/.ultron-vault` y como step explícito de `skill_manifest rebuild`.
- Build del manifest **falla** si algún SKILL.md viola contrato → manifest queda en estado anterior conocido.
- Migración: script `enrich_skill_frontmatter.py` que infiere campos faltantes (kind por dirname, tier por path, category por heurística) y genera PR de migración.

### 1.3 Personas con IDs estables

```yaml
# ~/.ultron/cockpit/personas.json (derivado del manifest, kind: persona)
{
  "version": 1,
  "personas": [
    {"id": "alfred",        "name": "ALFRED", "skill": "alfred",        "category": "lifestyle"},
    {"id": "don-claudio",   "name": "DON CLAUDIO", "skill": "don-claudio", "category": "gamedev"},
    {"id": "einstein",      "name": "EINSTEIN", ...},
    ...
  ],
  "expected_count": <derivado>,
  "_generated_from": "skill_manifest.json",
  "_generated_at": "..."
}
```

`PERSONAS = (...)` desaparece como código fuente. `routing-telemetry.py` importa `routing_telemetry_constants.PERSONAS` (autogenerado). Drift imposible — si añades persona al manifest, regenerar es un comando.

### 1.4 Path resolver unificado

**Python:** `~/.claude/skills/ultron/scripts/cockpit/ultron_paths.py`

```python
"""
ULTRON v13.0 path resolver. Single source for all directory locations.
Override via env vars (ULTRON_HOME, etc.) or ~/.ultron/paths.json.
"""
from pathlib import Path
import json, os

DEFAULTS = {
    "ULTRON_HOME":    str(Path.home() / ".ultron"),
    "ULTRON_COCKPIT": str(Path.home() / ".ultron" / "cockpit"),
    "ULTRON_VAULT":   str(Path.home() / ".ultron-vault"),
    "CLAUDE_HOME":    str(Path.home() / ".claude"),
    "CLAUDE_SKILLS":  str(Path.home() / ".claude" / "skills"),
    "CODEX_HOME":     str(Path.home() / ".codex"),
}

_PATHS_CACHE = None

def _load() -> dict:
    global _PATHS_CACHE
    if _PATHS_CACHE is not None:
        return _PATHS_CACHE
    cfg_path = Path(DEFAULTS["ULTRON_HOME"]) / "paths.json"
    cfg = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    out = {}
    for k, v in DEFAULTS.items():
        out[k] = os.environ.get(k) or cfg.get(k) or v
    _PATHS_CACHE = out
    return out

def get(key: str) -> Path:
    return Path(_load()[key])

# Shorthand
ULTRON_HOME    = get("ULTRON_HOME")
ULTRON_COCKPIT = get("ULTRON_COCKPIT")
ULTRON_VAULT   = get("ULTRON_VAULT")
CLAUDE_HOME    = get("CLAUDE_HOME")
CLAUDE_SKILLS  = get("CLAUDE_SKILLS")
CODEX_HOME     = get("CODEX_HOME")
```

**PowerShell:** `~/.ultron/hooks/ultron-paths.ps1` (dot-source compatible)

```powershell
# . "$PSScriptRoot\ultron-paths.ps1"
$Script:UltronPaths = @{}
$cfgPath = "$env:USERPROFILE\.ultron\paths.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $cfg.PSObject.Properties | ForEach-Object {
            $Script:UltronPaths[$_.Name] = $_.Value
        }
    } catch { }
}
function Get-UltronPath {
    param([Parameter(Mandatory)][string]$Key)
    $envVal = [Environment]::GetEnvironmentVariable($Key)
    if ($envVal) { return $envVal }
    if ($Script:UltronPaths.ContainsKey($Key)) { return $Script:UltronPaths[$Key] }
    switch ($Key) {
        "ULTRON_HOME"    { return "$env:USERPROFILE\.ultron" }
        "ULTRON_COCKPIT" { return "$env:USERPROFILE\.ultron\cockpit" }
        "ULTRON_VAULT"   { return "$env:USERPROFILE\.ultron-vault" }
        "CLAUDE_HOME"    { return "$env:USERPROFILE\.claude" }
        "CLAUDE_SKILLS"  { return "$env:USERPROFILE\.claude\skills" }
        "CODEX_HOME"     { return "$env:USERPROFILE\.codex" }
    }
    throw "Unknown ULTRON path key: $Key"
}
```

**Migración:** sed-replace incremental. Phase A: nuevos scripts importan/dot-source. Phase B: refactor 60+ scripts existentes uno por uno. No rush — el wrapper coexiste con `Path.home() / ".ultron"` durante la transición.

### 1.5 Audit redaction policy

Política nueva en `protocols.md`:
- Audits NUNCA incluyen secrets en plaintext. Plantilla obligatoria sustituye literales por `[REDACTED — <prefix>***<lastN>]`.
- Tag `<!-- redact-on-write: true -->` al inicio del file marca al consumer (kirkardo template).
- Validador opcional: `validate_audit_redaction.py` corre gitleaks contra `~/.ultron/cockpit/audits/` antes de cualquier push.

---

## 2. Plan de migración

### Fase 0 — Preparación (1h)
- [ ] Crear `ultron_paths.py` + `ultron-paths.ps1` (no usado aún, solo presente)
- [ ] Crear `validate_skill_frontmatter.py` con dry-run mode

### Fase 1 — Frontmatter migration (2-3h)
- [ ] Run `enrich_skill_frontmatter.py --dry-run` → revisar diff propuesto
- [ ] Apply: cada SKILL.md gana `kind`, `tier`, `category`, `last_verified`
- [ ] Activar gate en `skill_manifest rebuild`
- [ ] Validar manifest reconstruido idéntico (no regression)

### Fase 2 — Personas autogeneradas (1-2h)
- [ ] `skill_manifest_to_constants.py` → `routing_telemetry_constants.py`
- [ ] `routing-telemetry.py` import en lugar de literal
- [ ] `personas.json` derivado en cockpit/
- [ ] Validar que `consistency-check.py` ahora reporta count consistent

### Fase 3 — SSOT collapse (3-4h)
- [ ] Marcar `skills-registry.json` y `agent_manifest.json` como `_derived: true` con timestamp
- [ ] Reescribir `registry_sync.py` para regenerarlos desde manifest
- [ ] Borrar referencias directas en otros scripts
- [ ] Update `protocols.md` § AUTO-MEJORA con nueva regla "manifest es canónico"

### Fase 4 — Path resolver rollout (2-3h, gradual)
- [ ] Nuevos scripts (a partir de v13.0): obligatorio importar `ultron_paths`
- [ ] Top-10 scripts más invocados: refactor primero (brain_index, memory_sync, session_compactor, skill_manifest, decay_queue, retention, audit_index, pending_actions, route_quality, telemetry)
- [ ] Resto: refactor cuando se toque
- [ ] Smoke test: cambiar `paths.json` para apuntar a `~/.ultron-test/` y verificar isolation

---

## 3. Acceptance criteria v13.0

- [ ] `consistency-check.py` reporta TODOS los chequeos verdes (incluyendo persona count)
- [ ] `skill_manifest rebuild --strict` falla con cualquier SKILL.md sin frontmatter completo
- [ ] Borrar `skills-registry.json` y regenerarlo da resultado bit-identical
- [ ] `routing-telemetry.PERSONAS` no existe como literal; viene de import
- [ ] `personas.json` cuenta = expected_count en el código = `count(kind=persona)` en manifest
- [ ] Cambiar `~/.ultron/paths.json` redirige todos los scripts a la nueva root sin edits
- [ ] gitleaks pass sobre `~/.ultron/cockpit/audits/` (cero leaks históricos)
- [ ] CHANGELOG.md tiene entry v13.0 con bump y fecha

---

## 4. Riesgos + mitigaciones

| Riesgo | Mitigación |
|---|---|
| Migración rompe frontmatter inferido (kind erróneo) | `--dry-run` first; PR explícito a revisar antes de apply |
| Cache de `_PATHS_CACHE` se vuelve stale en sesión larga | Add `reload_paths()` API; no aplicar en hooks (que duran <1s) |
| Scripts de terceros (no-ULTRON) siguen hardcodeando paths | Aceptable; ULTRON solo gobierna lo propio |
| `skill_manifest rebuild` falla por frontmatter incompleto en mid-sesión | Gate solo aplica con `--strict`; default sigue tolerante hasta fin de migración |
| PERSONAS autogenerado pierde casos especiales (don-claudio mention etc.) | Mantener `personas_overrides.json` para datos que no fluyen del manifest |

---

## 5. Post-v13.0 follow-ups

- v13.1: Bandit/Thompson Sampling sobre route_quality.json (LRN-01 del audit)
- v13.1: dead-letter consumer en SessionStart con escalado por edad
- v13.1: skill-discovery → manifest ingest automatizado
- v13.2: Cockpit refactor a sub-packages (Typer)
- v13.2: TUI decisión binaria (archivar o reactivar con tests)

---

**Autor:** Claude Opus 4.7 (post-Kirkardo TOTAL Triple)
**Fuente:** `~/.ultron/cockpit/audits/kirkardo-total-2026-05-03.md` § 3.ARCH-01
**Estado:** Blueprint aprobado para v13.0; implementación en sesiones futuras.
