# ULTRON Memory System Initializer
# Uso: powershell -File init-memory.ps1

param([string]$RootPath = "$env:USERPROFILE\.ultron")

Write-Host "ULTRON Memory System — Initializing..." -ForegroundColor Cyan

$dirs = @("","projects","global","archive","knowledge","knowledge\cpp-ue5",
          "knowledge\csharp-unity","knowledge\typescript-web","knowledge\python",
          "knowledge\shell","knowledge\supabase","sessions","scripts")

foreach ($dir in $dirs) {
    $path = if ($dir -eq "") { $RootPath } else { Join-Path $RootPath $dir }
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Host "  Created: $path" -ForegroundColor Green
    }
}

$date = Get-Date -Format "yyyy-MM-dd"

$indexPath = Join-Path $RootPath "INDEX.md"
if (-not (Test-Path $indexPath)) {
@"
# ULTRON — Index Global
Ultima actualizacion: $date

## Proyecto Activo
ninguno

## Proyectos
| Nombre | Estado | Ultima sesion | Descripcion |
|--------|--------|---------------|-------------|

## Decisiones Globales Recientes
Sin decisiones registradas aun.

## Notas del Sistema
Sistema ULTRON inicializado el $date. Version: 1.0
"@ | Out-File $indexPath -Encoding UTF8
    Write-Host "  Created: INDEX.md" -ForegroundColor Green
}

@"
# Patrones de trabajo
Ultima actualizacion: $date

## Patrones de trabajo
Sin patrones registrados aun.

## Preferencias tecnicas
- Commits limpios y descriptivos
- Arquitectura antes de implementar
- Sin over-engineering
"@ | Out-File "$RootPath\global\patterns.md" -Encoding UTF8

@"
# Decisiones Globales
Ultima actualizacion: $date

## Stack por defecto — $date
Decision: TypeScript + Supabase para proyectos web
Impacto: todos los proyectos web
"@ | Out-File "$RootPath\global\decisions.md" -Encoding UTF8

@"
# Skill Usage Log
Ultima actualizacion: $date

## Que funciona bien
| Skill | Caso de uso | Resultado | Fecha |
|-------|-------------|-----------|-------|

## Que NO funciona bien
| Skill | Problema | Alternativa | Fecha |
|-------|----------|-------------|-------|
"@ | Out-File "$RootPath\global\skill-usage.md" -Encoding UTF8

Write-Host ""
Write-Host "ULTRON Memory System initialized at: $RootPath" -ForegroundColor Cyan
