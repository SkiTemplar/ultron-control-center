# HANDOVER · ULTRON v14.9 STRUCTURE migration

Pasos para que USER ejecute la migración cuando esté listo.

## Pre-requisitos (ya cumplidos en sesión 2026-05-10)

- ✅ Repo skill limpio: 7 commits Z1-Z7 (último `ce75418`)
- ✅ Repo `~/.ultron/` inicializado con git: commit `6be42dc`
- ✅ Doctor snapshot: `~/.ultron/.tmp/doctor-pre-v14.9-2026-05-10-131102.json`
- ✅ Settings snapshot: `~/.ultron/backups/settings.pre-v14.9-2026-05-10-131126.json`
- ✅ Pytest baseline: 1028 tests collected
- ✅ Docker + Qdrant operativos
- ✅ Script v3 con 3 fixes críticos aplicados (Codex 3rd pass pending al cierre de sesión)

## Antes de ejecutar (verifica la 3era pasada Codex pasó)

Lee el output de la 3era pasada en:
```
C:\Users\USER\AppData\Local\Temp\claude\C--Users-USER--claude-skills-ultron\b34f942c-867c-4372-a8db-d1c880a255db\tasks\b66ejkrs2.output
```

Verdict válido para proceder: `"verdict": "ship"` o `"ship_with_fixes"` con regressions vacíos.

## Ejecución

### 1. Cierra Claude Code (TODAS las ventanas)

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force
# Verifica:
Get-Process claude -ErrorAction SilentlyContinue
# (no debe devolver nada)
```

### 2. Mata cualquier python corriendo desde el .venv del skill

```powershell
Get-Process python*, pythonw* -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like 'C:\Users\USER\.claude\skills\ultron\.venv\*' } |
  Stop-Process -Force
```

### 3. Abre PowerShell fresca (NO desde Claude Code)

Win+R → `pwsh` → Enter (o `powershell` si no tienes pwsh 7+)

### 4. DryRun primero — valida sin mutar nada

```powershell
pwsh -ExecutionPolicy Bypass -File C:\Users\USER\.ultron\scripts\migrate-v14.9-v3.ps1 -DryRun
```

Esperado: pre-flight OK + mensaje "[DryRun] Pre-flight passed. Stopping before mutations."

Si falla: lee el error, no continúes hasta resolverlo.

### 5. Ejecución real

```powershell
pwsh -ExecutionPolicy Bypass -File C:\Users\USER\.ultron\scripts\migrate-v14.9-v3.ps1
```

Tiempo estimado: 5-10 min (el cuello es `uv sync` recreando .venv).

Logs detallados van a stdout. Backup completo en `~/.ultron/backups/pre-v14.9-<timestamp>-<rand>/`.

### 6. Si la migración termina con "MIGRATION v3 COMPLETE"

```powershell
# Reabre Claude Code
# En nueva sesión:
ultron tui   # debe arrancar sin errores
```

Después en Claude di: `Ultron, verify v14.9` — verifico hooks, doctor, tests, commit final.

## Si algo falla

### El script aborta con FATAL

El rollback automático se ejecuta. Lees el rollback log:
```powershell
cat C:\Users\USER\.ultron\backups\pre-v14.9-*\rollback-actions.json
```

Si el rollback automático no fue suficiente, restauración manual:

```powershell
$bak = "C:\Users\USER\.ultron\backups\pre-v14.9-<timestamp>-<rand>"

# 1. Restaurar settings.json
Copy-Item "$bak\settings.json" "C:\Users\USER\.claude\settings.json" -Force

# 2. Restaurar CLAUDE.md global y skill
Copy-Item "$bak\CLAUDE.md.global" "C:\Users\USER\.claude\CLAUDE.md" -Force
Copy-Item "$bak\CLAUDE.md.skill"  "C:\Users\USER\.claude\skills\ultron\CLAUDE.md" -Force

# 3. Restaurar el skill folder entero desde tar
Remove-Item -Recurse -Force C:\Users\USER\.claude\skills\ultron
tar -xf "$bak\skill-ultron.tar" -C "C:\Users\USER\.claude\skills"

# 4. Borrar lo que se creó en .ultron
Remove-Item -Recurse -Force C:\Users\USER\.ultron\.venv
Remove-Item -Recurse -Force C:\Users\USER\.ultron\scripts\cockpit
Remove-Item -Recurse -Force C:\Users\USER\.ultron\scripts\hooks
Remove-Item -Recurse -Force C:\Users\USER\.ultron\tests

# 5. Reabre Claude → debería funcionar como antes
```

### Pytest abortó la migración

El script ahora hace Fail si pytest exit ≠ 0 (preserva rollback target).

Si tienes baseline failures conocidos (unrelated al cambio):
1. Inspecciona: `cd ~/.ultron && uv run pytest tests/ -v`
2. Marca tests como xfail/skip ANTES de la migración
3. Re-ejecuta el script

Alternativa: añadir flag `-IgnoreTestFailures` al script (no implementado todavía — pedir si lo quieres).

## Tras éxito

```powershell
# Commit final en repo skill
cd C:\Users\USER\.claude\skills\ultron
git add -A
git commit -m "feat(v14.9): STRUCTURE migration complete - skill is now markdown-only"

# Cerrar item en backlog
ultron plans done v14.9-structure --note "Migrated 2026-05-XX, 1028 tests pass post-migration"

# Verificar el siguiente sprint
ultron plans show v15.0-installer
```
