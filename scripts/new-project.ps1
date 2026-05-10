# ULTRON New Project Initializer
# Uso: powershell -File new-project.ps1 -Name "nombre" -Type "PERSONAL"

param(
    [Parameter(Mandatory=$true)][string]$Name,
    [string]$Type = "PERSONAL",
    [string]$RootPath = "C:\Users\USER\.ultron"
)

$normalizedName = $Name.ToLower() -replace '\s+', '-' -replace '[^a-z0-9-]', ''
$projectPath = Join-Path $RootPath "projects\$normalizedName"
$date = Get-Date -Format "yyyy-MM-dd"

if (Test-Path $projectPath) {
    Write-Host "Project already exists: $projectPath" -ForegroundColor Yellow; exit 0
}

New-Item -ItemType Directory -Path $projectPath -Force | Out-Null

@"
# $Name
Estado: ACTIVO
Iniciado: $date
Ultima actualizacion: $date
Tipo: $Type

## Objetivo
[RELLENAR]

## Stack
- Lenguaje principal:
- Framework:
- Base de datos:

## Deadline
sin deadline

## Rutas Clave
- Codigo local: C:\Users\USER\
- Repositorio:

## Estado Actual
Proyecto recien inicializado.

## Decisiones Tomadas
| Decision | Razonamiento | Fecha |
|----------|--------------|-------|

## Proximos Pasos
- [ ] [primer paso]
"@ | Out-File "$projectPath\PROJECT.md" -Encoding UTF8

@"
# Log — $Name

### $date — Inicializacion
**Hecho:** Proyecto inicializado en sistema ULTRON
"@ | Out-File "$projectPath\log.md" -Encoding UTF8

@"
# Memory — $Name
Ultima actualizacion: $date

[Conocimiento tecnico especifico del proyecto se acumula aqui]
"@ | Out-File "$projectPath\memory.md" -Encoding UTF8

Write-Host "Project '$normalizedName' initialized at $projectPath" -ForegroundColor Cyan
