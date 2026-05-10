# ULTRON v14.1 — Genesis Audit Completo
> Fecha: 2026-05-06 · Sesión: post-GENESIS cleanup
> Auditoría manual de todos los directorios + 7 preguntas de sistema

---

## LIMPIEZA EJECUTADA

### Eliminados (sin valor de conocimiento)
| Ruta | Motivo |
|------|--------|
| `~/.ultron/bin/` | C# artifacts pre-reescritura Python (UltronCockpit.cs/.exe) |
| `~/.ultron/news/` (top-level) | 3 HTMLs de Apr-30, orphan (cockpit/news/ es el activo) |
| `~/.ultron/skill_cache/coding-20260430/` | Cache con fecha, obsoleto |
| `~/.ultron/skill_cache/skill_66dc2b17/` | Cache hash anónimo |
| `~/.ultron/skill_cache/audit-context-building/` | Cache antiguo |
| `~/.ultron/skill_cache/skill-improver/` | Cache antiguo |
| `~/.ultron/INDEX.md` | Marcado como retired en CLAUDE.md |
| `~/.ultron/cockpit/jobs/` | 4 dirs hash de Apr-29, stale |
| `~/.ultron/cockpit/*.bak` | 4 archivos backup (ide-mappings, projects.json x3) |
| `~/.ultron/cockpit/skills-gemini-raw.txt` | Raw data Apr-29 |
| `~/.ultron/cockpit/notes/ultron.md` | Solo nota smoke test v10.7.1 Apr-28 |
| `~/.claude/skills/ultron/.sixth/` | Skills cache pre-v13 (Apr-27) |
| `~/.claude/skills/ultron/generated_newsletter.html` | Artefacto stale en root |
| `~/.ultron-vault/40_SKILLS/skills/` | 380 shells vacíos (solo frontmatter, no indexados por brain_index) |

### Archivados a `~/.ultron/archive/`
| Ruta origen | Motivo |
|-------------|--------|
| `deferred/2026-05-04-plan-session.md` | Plan histórico superseded por master plan |
| `skill_discoveries/smart_analysis/converter_20260429_1720.json` | Tool artifact Apr-29 |
| `cockpit/proposals/*.json` | Proposals ya aplicadas (terry-davis + ultron Apr-28) |

### Conservados (referenciados activamente)
- `skills-registry.json` → referenciado en `registry_sync.py`, `tui.py`, `ultron_paths.py`
- `memory/L1/` → context packets generados por `context_packet_builder.py` (activo)
- `scripts/alerts/write-alert.ps1` → utility wrapper (standalone PS helper)
- `cockpit/audits/` → histórico de evaluaciones kirkardo, security playbooks (valor archivístico)
- `cockpit/proposals/` → archivado ✅

### Brain index post-cleanup
`brain_index.py build` → 642 notas (unchanged — 40_SKILLS shells no estaban en scope de escaneo)

---

## 1. SISTEMA DE MEMORIA — ¿Inmejorable?

**Veredicto: Sólido pero mejorable en 2 puntos concretos.**

### Estado real
- L0 context.md (≤400 tok): generado por hook, primed en sesión ✅
- L1 brain_index FTS5 BM25 (642 notas, 10K chunks): SSOT de búsqueda ✅
- L2 vault + CC-memories bridge: funciona, `memory/L1/` context packets activos ✅
- L3 remote git: ✅
- `seen.json`: 668 hashes acumulativos, deduplication funciona ✅

### Debilidades reales

**A) Solo keyword matching (BM25):** FTS5 busca por ocurrencia de tokens. Una query como *"arregla este crash raro"* no encontrará `superpowers:systematic-debugging` a menos que "crash" aparezca en su SKILL.md. Intent-rules.yaml cubre patrones conocidos, pero falla en variaciones.

**B) Sin query expansion:** `query-synonyms.json` existe en cockpit pero NO está conectado a brain_index.py. Está desconectado.

### Propuestas
1. **Conectar query-synonyms.json a brain_index.py** (`query` method): cuando la query contiene una key del JSON, expand la query FTS5 con los sinónimos. ~30 líneas. Impacto: queries NL → recall +40% estimado.
2. **Retention sessions/.md >30 días**: Añadir al task `Retention-Daily`. Sessions acumulándose sin rotación.
3. **Telemetry rotation**: `telemetry/dispatcher-events.jsonl` crece sin límite. Añadir rotation semanal en Retention-Daily.

---

## 2. SKILLS — ¿Se llaman con fiabilidad alta?

**Veredicto: Parcial. Skills técnicas bien. Personas: routing débil sin NL hints.**

### Pipeline de dispatch (4 pasos)
1. Slash-command short-circuit (`/skill-name`) → confianza 1.0
2. `intent-rules.yaml` exact-match regex → confianza 0.90 para patrones conocidos
3. ZTMSI FTS5 sobre brain_index → confianza variable (BM25 score normalizado)
4. No-route fallthrough

### Problema central (verificado empíricamente)
`manifest.cache.json` entries tienen SOLO: `id`, `triggers` (tokens del nombre), `description`, `deprecated`, `source`, `cost_tier`. El ZTMSI step usa **únicamente el campo `triggers`** para matching — NO description, NO routing_hint.

`query-synonyms.json` existe en cockpit pero **NO está importado ni referenciado en ningún punto de intent-dispatcher.py**. Es un archivo muerto que no afecta al routing.

### Propuestas
1. **`routing_hint` en SKILL.md + exportado a manifest**: Añadir campo `routing_hint` a los 16 SKILL.md de personas. Modificar `skill_manifest.py` para exportarlo a `manifest.cache.json`. Modificar `_score_against_manifest()` en dispatcher para incluirlo en el score. Ejemplo para terry-davis:
   ```yaml
   routing_hint: "limpiar código legacy, refactorizar desastre, deuda técnica, código sucio, reorganizar estructura"
   ```
2. **Conectar query-synonyms.json al dispatcher**: Cargar en `_load_manifest()`, aplicar expansion de términos antes del ZTMSI step. ~30 líneas.
3. **Integration test**: `tests/test_dispatcher_natural.py` con 20 prompts NL → skill esperada. Cierra E2 gate.

---

## 3. PROMPT INJECTIONS — ¿Casi 100% seguro?

**Veredicto: Sólido contra ataques obvios. Gaps en re-verificación y ofuscación.**

### PI001-PI011 verificados (análisis completo)

| Regla | Detecta | Severidad | FP Risk |
|-------|---------|-----------|---------|
| PI001 | "ignore previous", "override system" directs | CRITICAL | HIGH |
| PI002 | HTML comments con directives | HIGH | MEDIUM |
| PI003 | Zero-width chars, RTL override, homoglyphs | HIGH | LOW |
| PI004 | Base64 blobs ≥200 chars (excluye data URIs) | MEDIUM | MEDIUM |
| PI005 | Shell commands en YAML frontmatter values | CRITICAL | MEDIUM |
| PI006 | Frontmatter keys no en whitelist (45+ keys) | MEDIUM | LOW |
| PI007 | Tool-call injection en description | HIGH | MEDIUM |
| PI008 | URL/IP exfiltration (webhook.site, .onion, IPs) | HIGH | MEDIUM |
| PI009 | Permisos excesivos bash/write en skills no-trusted | MEDIUM | LOW |
| PI010 | Hex/URL/Unicode encoding ≥34 chars (length-based) | MEDIUM | MEDIUM |
| PI011 | Frontmatter "source" field spoofing | MEDIUM | LOW |

- Arquitectura: block > quarantine > warn > allow ✅
- Trusted-source downgrade ✅
- Waiver mechanism (skill-trust.yaml) ✅
- Quarantine automático ✅

### Gaps confirmados (verificados empíricamente)

**A) Sin re-verificación hash en load-time (CONFIRMADO):** `intent-dispatcher.py` NO lee `skill-provenance.json` en ningún momento. El hash check solo ocurre en `skill_sync_security.py:scan_skill()` durante la instalación. Un SKILL.md modificado post-install corre sin re-scan.

**B) Base64 corto no detectado (CONFIRMADO):** PI004 detecta bloques ≥200 chars. Ofuscación con <200 chars de Base64 pasa. PI010 length-based: hex <34 chars pasa.

**C) Parafraseo semántico evade regex:** "olvida lo anterior" no matchea PI001. Sin semantic layer.

### Propuestas corregidas
1. **PI004 threshold bajado a 60 chars**: La regla existe, solo ajustar el límite. Suficiente para capturar ofuscación corta sin FP excesivos.
2. **PI012 — Embedded system prompt**: Detectar `You are`, `Your role is`, `SYSTEM:`, `<system>` en body (fuera frontmatter). Severity: `high`. Muchas skills legítimas NO necesitan esto en body.
3. **Hash re-check en PreToolUse Skill**: En `auto-approve-readonly.py`, cuando Skill tool se activa, comparar `SHA1(SKILL.md)` vs `skill-provenance.json[skill_id].hash`. Si mismatch → re-run `skill_sync_security.py --quiet --skill <id>`. Si no en provenance → warn.

---

## 4. ESCALABILIDAD — ¿Sin dejar deprecated sueltos?

**Veredicto: Buena base. 3 gaps de retention activos.**

### Estado post-limpieza
- skill_cache: 392 JSON files planos ✅ (los 4 subdirs viejos eliminados)
- brain_index SQLite FTS5: escala a millones de rows ✅
- manifest.cache.json: ~50KB flat load en RAM, bien hasta ~2000 skills
- sessions/: dirs por fecha + .md files **sin retention policy para .md**
- telemetry/dispatcher-events.jsonl: **acumulativo sin límite**
- alerts.jsonl: append-only, rotation periódica en Retention-Daily ✅

### Propuesta de retention completa para `Retention-Daily`
```python
# Añadir a retention script:
# sessions/*.md older than 30 days → archive
# telemetry/dispatcher-events.jsonl > 10MB → rotate to .1
# cockpit/standup/ai_standup.log > 1MB → rotate
```

---

## 5. COCKPIT — ¿Funcionamiento óptimo?

**Veredicto: Funciona bien. BUG-4 UX pendiente. cockpit/trending/ en duda.**

### Activo y saludable
- standup (ai_standup.log updated today) ✅
- retention (retention.log updated today) ✅
- news (newsletter-2026-05-06.html generated today) ✅
- pending_actions.json updated today ✅
- bridge-index.json updated today ✅

### Pendientes
- **BUG-4**: `ultron.ps1` Show-Help y strings internos referencian v12.5/v13.4
- **cockpit/trending/**: `github_trending.log` last run May 1. ¿Task Scheduler task "GithubTrending-Daily" corriendo?
- **DASHBOARD.md**: Apr 30, posiblemente stale

---

## 6. NEWS SYSTEM Y PROMPT — ¿Efectivo?

**Veredicto: Funcionando. 2 mejoras de signal-to-noise y relevancia.**

### Estado real
- Generación diaria activa ✅ (newsletter-2026-05-06.html)
- Deduplication via seen.json (668 entries) ✅
- Security alerts funcionan (GHSA-wpqr-6v78-jr5g detectado y resuelto) ✅
- audit-flags de Apr-30 y May-2 indican que el sistema auto-detectó problemas de contenido

### Debilidades
- Los audit-flags sugieren que el news prompt genera contenido que viola reglas. Podría ser demasiado amplio o generar resúmenes de contenido sensible.
- No hay resumen de news en context.md — cada día hay nuevos items pero Claude no sabe cuántos ni cuáles son relevantes sin abrir la newsletter.

### Propuestas
1. **Añadir news digest a context.md**: `context_primer.py` debería incluir 1 línea: *"📰 3 news items hoy (latest: newsletter-2026-05-06.html)"*. Zero tokens extra si solo muestra el count.
2. **Tighten news prompt**: Filtrar explícitamente por stack de USER (C++, UE5, C#, Unity, TypeScript, Python, Claude API). Reducir audit-flags.

---

## 7. SCHEDULE — ¿Mejorable?

**Veredicto: Base sólida. Falta doctor weekly + verificar GithubTrending.**

### Estado schedule-config.json (v1.1, Apr-28)
| Task | Estado | Frecuencia |
|------|--------|------------|
| Retention-Daily | enabled ✅ | diario |
| Standup-Weekday | enabled ✅ | días hábiles |
| Research-Weekly | enabled | domingo |
| GithubTrending-Daily | enabled | diario ⚠️ (log parado May-1) |
| ScanProjects-Login | disabled | — |
| TUI-Login | disabled | — |

### Gaps
- **Doctor semanal NO está en scheduler**: actualmente opt-in en `stop-memory-sync.ps1`. Si no hay sesión activa esa semana, el doctor no corre.
- **GithubTrending-Daily posiblemente parado**: último log May-1.

### Propuestas
1. **Añadir `Doctor-Weekly` a schedule-config.json**:
   ```json
   "Doctor-Weekly": {
     "enabled": true,
     "delay_minutes": 20,
     "frequency": "once_per_week_sunday",
     "description": "Run ultron doctor --quiet --json → write doctor-weekly.json → fold-in findings to context.md on next SessionStart"
   }
   ```
2. **Extender `install-scheduler.ps1`** para registrar este task en Windows Task Scheduler.
3. **Verificar GithubTrending-Daily**: comprobar si el script sigue funcionando o fue deshabilitado implícitamente.

---

## 8. WEB AUTO-UPDATE

**Decisión: Codex instancia (PostToolUse hook).**

**Por qué Codex y no Claude agent:**
- Evita recursión (Claude llama Claude para actualizar web de edición que Claude acaba de hacer)
- Codex es más barato, output-bounded (solo modifica web/)
- mike-tyson persona ya está en cockpit con contexto de design
- `shared-duet.ps1` ya integrado

### Plan de implementación

**Archivo nuevo:** `scripts/cockpit/web_updater.py` (~100 líneas)
```
Flujo:
1. Lee GENESIS-CAPABILITIES.md → SHA1
2. Compara vs ~/.ultron/web/.last-cap-hash
3. Si igual → exit 0 (no cambió)
4. Cap: lee ~/.ultron/web/.last-update → si <24h → exit 0
5. Backup web/ → web/.backups/YYYY-MM-DD/
6. Llama shared-duet.ps1 -Provider codex con mike-tyson persona + diff
7. Actualiza .last-cap-hash y .last-update
8. Si error → alert en alerts.jsonl, web intacta
```

**Hook entry en settings.json (PostToolUse):**
```json
{
  "matcher": {"tool": "Edit|Write", "path": "*GENESIS-CAPABILITIES.md*"},
  "command": "uv run python ~/.claude/skills/ultron/scripts/cockpit/web_updater.py --check-and-update"
}
```

---

## Resumen ejecutivo

| Sistema | Estado | Prioridad fix |
|---------|--------|---------------|
| Memoria | Sólido, BM25 mejorable con query expansion | MEDIUM |
| Skills routing | Funciona, personas sin NL hints | HIGH |
| Prompt injection | Sólido, 2 PI rules + hash re-check | HIGH |
| Escalabilidad | OK post-limpieza, retention gaps | MEDIUM |
| Cockpit | Funciona, BUG-4 pendiente | LOW |
| News | Funciona, añadir digest a context.md | LOW |
| Schedule | Doctor-Weekly falta | MEDIUM |
| Web auto-update | No implementado → plan listo | LOW |
