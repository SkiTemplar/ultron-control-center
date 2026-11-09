# Servicios residentes que no hacen falta siempre (2026-10-28). Requiere admin, salvo con -WhatIf.
# Medido con 31,7 GB de RAM y 19 GB libres: no hay presion de memoria, pero estos procesos ocupan ~700 MB
# sin uso diario:
# - Meta Horizon (OVRService): OVRServer_x64 + OVRServiceLauncher + RemoteDesktopCompanion + OVRRedir, ~330 MB.
#   Pasa a Manual: la app de Meta Horizon lo arranca al abrirla (si no, Inicio > Servicios > OVRService > Iniciar).
# - Instalador de Visual Studio: BackgroundDownload.exe descarga actualizaciones en segundo plano, ~380 MB
#   mientras corre. Directiva BackgroundDownloadDisabled = 1; las actualizaciones se bajan al abrir el instalador.
#
# Guarda el estado anterior en ..\backups\servicios-<fecha>.json.
#   -WhatIf  ensena lo que haria sin tocar nada.
#   -Undo    deshace todas las ejecuciones aun sin deshacer, de la mas reciente a la mas antigua, y las renombra a
#            *.undone.json. Lanzarlo dos veces no pierde el estado original: una ejecucion sin cambios no anota nada y
#            el -Undo encadenado llega hasta la primera. Vuelve a arrancar el servicio si estaba en marcha.
# Lo que -Undo NO deshace: los procesos matados (OVRServer_x64, OVRRedir, RemoteDesktopCompanion, BackgroundDownload) no
# se relanzan uno a uno; los de Meta vuelven con el servicio y BackgroundDownload con la siguiente descarga.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [switch]$Undo,
  [string]$BackupDir = (Join-Path $PSScriptRoot '..\backups'),
  # Solo para debloat.selftest.ps1, que corre con servicios y registro falsos.
  [switch]$NoAdminCheck
)
$ErrorActionPreference = 'Stop'
$policy = 'HKLM:\SOFTWARE\Policies\Microsoft\VisualStudio\Setup'
$policyName = 'BackgroundDownloadDisabled'
$services = @('OVRService')
$script:failures = New-Object System.Collections.ArrayList

function Add-Failure($message) {
  [void]$script:failures.Add($message)
  "FALLO: $message"
}

function Assert-Admin {
  if ($NoAdminCheck -or $WhatIfPreference) { return }
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'requiere una consola de administrador: no se ha tocado nada'
  }
}

function Get-PolicyValue {
  $key = Get-Item -LiteralPath $policy -ErrorAction SilentlyContinue
  if ($key -and (@($key.GetValueNames()) -contains $policyName)) { return $key.GetValue($policyName) }
  $null
}

function Undo-Service($s) {
  if (-not $PSCmdlet.ShouldProcess($s.name, "restaurar inicio $($s.startType), estado $($s.status)")) { return }
  Set-Service -Name $s.name -StartupType $s.startType
  "restaurado $($s.name) -> $($s.startType)"
  if ($s.status -ne 'Running') { return }
  Start-Service -Name $s.name
  $now = [string](Get-Service -Name $s.name).Status
  if ($now -eq 'Running') { "$($s.name): en marcha otra vez" }
  else { Add-Failure "$($s.name): estaba en marcha y sigue $now" }
}

function Undo-Policy($state) {
  if (-not $PSCmdlet.ShouldProcess($policy, 'restaurar la directiva')) { return }
  if ($null -ne $state.backgroundDownloadDisabled) {
    New-ItemProperty -Path $policy -Name $policyName -Value $state.backgroundDownloadDisabled -PropertyType DWord -Force | Out-Null
    "directiva restaurada a $($state.backgroundDownloadDisabled)"
    return
  }
  $key = Get-Item -LiteralPath $policy -ErrorAction SilentlyContinue
  if ($key -and (@($key.GetValueNames()) -contains $policyName)) { Remove-ItemProperty -Path $policy -Name $policyName }
  $created = @($state.createdKeys | Where-Object { $_ })
  [array]::Reverse($created)
  foreach ($k in $created) {
    $item = Get-Item -LiteralPath $k -ErrorAction SilentlyContinue
    if ($item -and -not ($item.ValueCount -or $item.SubKeyCount)) { Remove-Item -LiteralPath $k }
  }
  'directiva quitada: antes no existia'
}

function Invoke-Undo {
  $all = @(Get-ChildItem -LiteralPath $BackupDir -Filter 'servicios-*.json' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*.undone.json' } | Sort-Object Name -Descending)
  if (-not $all) { throw "no hay ningun servicios-*.json sin deshacer en $BackupDir" }
  foreach ($file in $all) {
    $before = $script:failures.Count
    $state = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    try {
      foreach ($s in @($state.services | Where-Object { $_ })) { Undo-Service $s }
      if ($state.policyChanged) { Undo-Policy $state }
    } catch { Add-Failure "$($file.Name): $($_.Exception.Message)" }
    if ($script:failures.Count -ne $before) {
      "NO se marca como deshecho: $($file.Name)"
      continue
    }
    if ($PSCmdlet.ShouldProcess($file.Name, 'marcar como deshecho')) {
      Rename-Item -LiteralPath $file.FullName -NewName ($file.BaseName + '.undone.json')
      "deshecho: $($file.Name)"
    }
  }
}

# Solo lo que va a cambiar: una segunda ejecucion no anota nada y no tapa el estado original.
function Get-PendingState {
  $found = @($services | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
  $pending = @($found | Where-Object { [string]$_.StartType -ne 'Manual' -or [string]$_.Status -ne 'Stopped' })
  $value = Get-PolicyValue
  [ordered]@{
    services = @($pending | ForEach-Object { [ordered]@{ name = $_.Name; startType = [string]$_.StartType; status = [string]$_.Status } })
    backgroundDownloadDisabled = $value
    policyChanged = ($value -ne 1)
    createdKeys = New-Object System.Collections.ArrayList
  }
}

function Stop-OneService($s) {
  if (-not $PSCmdlet.ShouldProcess($s.name, 'pasar a Manual y parar')) { return }
  Set-Service -Name $s.name -StartupType Manual
  try { Stop-Service -Name $s.name -Force } catch { Add-Failure "$($s.name): no se pudo parar: $($_.Exception.Message)" }
  $now = [string](Get-Service -Name $s.name).Status
  if ($now -eq 'Stopped') { "$($s.name): Manual y parado" }
  else { Add-Failure "$($s.name): Manual, pero sigue $now" }
}

function Stop-Leftovers($names, $what) {
  $procs = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
  if ($procs -and $PSCmdlet.ShouldProcess(($procs.Name -join ', '), $what)) { $procs | Stop-Process -Force }
}

function Set-Policy($state) {
  if (-not $state.policyChanged) { return }
  if (-not $PSCmdlet.ShouldProcess($policy, "$policyName = 1")) { return }
  # New-Item -Force sobre una clave existente la vaciaria: solo se crea lo que falta.
  $missing = New-Object System.Collections.ArrayList
  $p = $policy
  while ($p -and -not (Test-Path -LiteralPath $p)) {
    [void]$missing.Insert(0, $p)
    $p = Split-Path -Path $p -Parent
  }
  foreach ($m in $missing) {
    New-Item -Path $m | Out-Null
    [void]$state.createdKeys.Add($m)
  }
  New-ItemProperty -Path $policy -Name $policyName -Value 1 -PropertyType DWord -Force | Out-Null
  'Visual Studio: descarga en segundo plano desactivada'
}

function Invoke-Apply {
  $state = Get-PendingState
  if (-not $state.services.Count -and -not $state.policyChanged) {
    'sin cambios: ya estaba aplicado, no se anota nada'
    return
  }
  $file = Join-Path $BackupDir "servicios-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff').json"
  # Lo que se llegue a hacer queda anotado aunque un paso falle a medias.
  try {
    foreach ($s in $state.services) { Stop-OneService $s }
    Stop-Leftovers @('OVRServer_x64', 'OVRRedir', 'RemoteDesktopCompanion') 'matar los procesos de Meta Horizon'
    Set-Policy $state
    Stop-Leftovers @('BackgroundDownload') 'matar la descarga de Visual Studio'
  } finally {
    if ($PSCmdlet.ShouldProcess($file, 'anotar el estado anterior')) {
      New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
      $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding UTF8
      "copia: $file; se deshace con -Undo"
    }
  }
}

Assert-Admin
if ($Undo) { Invoke-Undo } else { Invoke-Apply }
if ($script:failures.Count) {
  "$($script:failures.Count) fallos: revisa las lineas FALLO"
  exit 1
}
