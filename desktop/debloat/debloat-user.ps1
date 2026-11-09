# Debloat de usuario (HKCU + paquetes Appx del usuario). Sin admin.
#
# Antes de tocar nada exporta cada clave a ..\backups\reg-<fecha>\ y aborta si una exportacion falla.
# Cada cambio queda anotado en ..\backups\debloat-<fecha>.json con el estado anterior: valor y tipo, o que no existia.
#   -WhatIf  ensena lo que haria sin tocar nada.
#   -Undo    deshace todas las ejecuciones aun sin deshacer, de la mas reciente a la mas antigua, y las renombra a
#            *.undone.json. Volver a lanzar el script no pierde el estado original: una ejecucion sin cambios no anota
#            nada y el -Undo encadenado llega hasta la primera.
#   -Force   no pide confirmacion para quitar los paquetes.
# Lo que NO siempre se puede deshacer:
#   - Paquetes Appx: -Undo los registra de nuevo solo si sus ficheros siguen en disco. Si Windows ya los borro, no hay
#     copia: -Undo lo dice, da el nombre para instalarlo desde la Store y termina con codigo 1.
#   - El Explorador puede necesitar reiniciarse para reflejar los ajustes, tanto al aplicar como al deshacer.
# SearchboxTaskbarMode y ShowTaskViewButton no se tocan aqui: los fija ..\escritorio\accesos-dock.ps1.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [switch]$Undo,
  [switch]$Force,
  [string]$BackupDir = (Join-Path $PSScriptRoot '..\backups'),
  [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
$script:failures = New-Object System.Collections.ArrayList

function Add-Failure($message) {
  [void]$script:failures.Add($message)
  "FALLO: $message"
}

function Get-ValueState($path, $name) {
  $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if ($key -and (@($key.GetValueNames()) -contains $name)) {
    return [ordered]@{
      path = $path; name = $name; existed = $true
      kind = [string]$key.GetValueKind($name)
      value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
    }
  }
  [ordered]@{ path = $path; name = $name; existed = $false; kind = $null; value = $null }
}

# El valor por defecto de una clave: '' para .NET, '(default)' para los cmdlets del registro.
function Get-CmdletName($name) {
  if ($name -eq '') { return '(default)' }
  $name
}

# New-Item -Force sobre una clave existente la vaciaria: solo se crea lo que falta, y se anota para -Undo.
function New-KeyIfMissing($path, $created) {
  $missing = New-Object System.Collections.ArrayList
  $p = $path
  while ($p -and -not (Test-Path -LiteralPath $p)) {
    [void]$missing.Insert(0, $p)
    $p = Split-Path -Path $p -Parent
  }
  foreach ($m in $missing) {
    New-Item -Path $m | Out-Null
    [void]$created.Add($m)
  }
}

function Set-Value($state, $path, $name, $value, $kind) {
  $prev = Get-ValueState $path $name
  if ($prev.existed -and $prev.kind -eq $kind -and $prev.value -eq $value) { return }
  if (-not $PSCmdlet.ShouldProcess("$path [$name]", "poner a '$value' ($kind)")) { return }
  New-KeyIfMissing $path $state.createdKeys
  New-ItemProperty -Path $path -Name (Get-CmdletName $name) -Value $value -PropertyType $kind -Force | Out-Null
  [void]$state.values.Add($prev)
}

function Set-Dword($state, $path, $name, $value) { Set-Value $state $path $name $value 'DWord' }

function Export-Keys($dir, $keys) {
  if (-not $PSCmdlet.ShouldProcess($dir, 'exportar las claves antes de tocarlas')) { return }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $i = 0
  foreach ($k in $keys) {
    $i++
    # Una clave que no existe no tiene nada que copiar; -Undo la borra por el estado anotado.
    if (-not (Test-Path -LiteralPath "Registry::$k")) { continue }
    reg export $k (Join-Path $dir "$i.reg") /y 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "no se pudo exportar $k (codigo $LASTEXITCODE): no se toca nada" }
  }
}

function Apply-Settings($state) {
  $cdm = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
  foreach ($n in 'SilentInstalledAppsEnabled', 'SystemPaneSuggestionsEnabled', 'SoftLandingEnabled', 'SubscribedContent-338388Enabled', 'SubscribedContent-338389Enabled', 'SubscribedContent-338393Enabled', 'SubscribedContent-353694Enabled', 'SubscribedContent-353696Enabled', 'SubscribedContent-310093Enabled', 'RotatingLockScreenOverlayEnabled', 'ContentDeliveryAllowed', 'OemPreInstalledAppsEnabled', 'PreInstalledAppsEnabled', 'FeatureManagementEnabled') { Set-Dword $state $cdm $n 0 }

  $adv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
  Set-Dword $state $adv 'HideFileExt' 0
  Set-Dword $state $adv 'Hidden' 1
  Set-Dword $state $adv 'Start_IrisRecommendations' 0
  Set-Dword $state $adv 'Start_AccountNotifications' 0
  Set-Dword $state $adv 'ShowSyncProviderNotifications' 0
  Set-Dword $state $adv 'TaskbarMn' 0
  Set-Dword $state $adv 'ShowCopilotButton' 0
  Set-Dword $state $adv 'LaunchTo' 1

  $search = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Search'
  Set-Dword $state $search 'BingSearchEnabled' 0
  Set-Dword $state $search 'CortanaConsent' 0
  Set-Dword $state 'HKCU:\Software\Policies\Microsoft\Windows\Explorer' 'DisableSearchBoxSuggestions' 1
  Set-Dword $state 'HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot' 'TurnOffWindowsCopilot' 1
  Set-Dword $state 'HKCU:\Software\Policies\Microsoft\Windows\WindowsAI' 'DisableAIDataAnalysis' 1
  Set-Dword $state 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo' 'Enabled' 0
  Set-Dword $state 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Privacy' 'TailoredExperiencesWithDiagnosticDataEnabled' 0
  Set-Dword $state 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled' 0
  Set-Dword $state 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled' 0
}

# Sin Game Bar (se quita abajo), Windows sigue abriendo ms-gamebar: al lanzar un juego y sale "Obtener una aplicacion
# para abrir este vinculo". Los dos protocolos se atienden con systray.exe, que no hace nada visible.
function Apply-Protocols($state) {
  $target = "`"$env:SystemRoot\System32\systray.exe`""
  foreach ($proto in 'ms-gamebar', 'ms-gamingoverlay') {
    $cls = "HKCU:\Software\Classes\$proto"
    Set-Value $state $cls '' "URL:$proto" 'String'
    Set-Value $state $cls 'URL Protocol' '' 'String'
    Set-Value $state $cls 'NoOpenWith' '' 'String'
    Set-Value $state "$cls\shell\open\command" '' $target 'String'
  }
}

function Remove-RunEntries($state) {
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $key = Get-Item -LiteralPath $run -ErrorAction SilentlyContinue
  if (-not $key) { return }
  foreach ($name in @($key.GetValueNames())) {
    if (-not ($name -like 'MicrosoftEdgeAutoLaunch*' -or $name -eq 'Opera GX Browser Assistant')) { continue }
    if (-not $PSCmdlet.ShouldProcess("$run [$name]", 'quitar del arranque')) { continue }
    $prev = Get-ValueState $run $name
    Remove-ItemProperty -Path $run -Name $name
    [void]$state.values.Add($prev)
    "run quitado: $name"
  }
}

function Move-StartupItems($state, $dir) {
  foreach ($f in @(Get-ChildItem -LiteralPath $StartupDir -Filter '*OneNote*' -ErrorAction SilentlyContinue)) {
    if (-not $PSCmdlet.ShouldProcess($f.FullName, 'sacar de la carpeta de Inicio')) { continue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $to = Join-Path $dir $f.Name
    Move-Item -LiteralPath $f.FullName -Destination $to
    [void]$state.startup.Add([ordered]@{ from = $f.FullName; to = $to })
    "inicio quitado: $($f.Name)"
  }
}

function Remove-Apps($state) {
  $apps = 'Clipchamp.Clipchamp', 'Microsoft.People', 'Microsoft.PowerAutomateDesktop', 'Microsoft.Todos', 'Microsoft.Windows.DevHome', 'MicrosoftWindows.Client.WebExperience', 'Microsoft.XboxGamingOverlay', 'Microsoft.YourPhone', 'MicrosoftWindows.CrossDevice', 'SpotifyAB.SpotifyMusic'
  $found = @($apps | ForEach-Object { Get-AppxPackage -Name $_ } | Where-Object { $_ })
  if (-not $found) { return }
  $names = ($found | ForEach-Object { $_.Name }) -join ', '
  if (-not $PSCmdlet.ShouldProcess($names, 'quitar los paquetes Appx (-Undo no siempre puede reponerlos)')) { return }
  if (-not ($Force -or $PSCmdlet.ShouldContinue($names, 'Quitar estos paquetes? -Undo no siempre puede reponerlos'))) {
    'paquetes conservados: no confirmado'
    return
  }
  foreach ($pkg in $found) {
    try {
      $pkg | Remove-AppxPackage -ErrorAction Stop
      [void]$state.appx.Add([ordered]@{ name = $pkg.Name; fullName = $pkg.PackageFullName; location = $pkg.InstallLocation })
      "appx quitado: $($pkg.Name)"
    } catch { Add-Failure "appx $($pkg.Name): $($_.Exception.Message)" }
  }
}

function Save-State($state, $file) {
  $empty = -not ($state.values.Count -or $state.createdKeys.Count -or $state.startup.Count -or $state.appx.Count)
  if ($empty) { return 'sin cambios: nada que anotar' }
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $file -Encoding UTF8
  "estado anterior en $file; se deshace con -Undo"
}

function Invoke-Debloat {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $bk = Join-Path $BackupDir "reg-$stamp"
  $keys = @(
    'HKCU\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Search',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Privacy',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR',
    'HKCU\System\GameConfigStore',
    'HKCU\Software\Policies\Microsoft\Windows',
    'HKCU\Software\Classes\ms-gamebar',
    'HKCU\Software\Classes\ms-gamingoverlay'
  )
  Export-Keys $bk $keys
  $state = [ordered]@{
    stamp = $stamp
    values = New-Object System.Collections.ArrayList
    createdKeys = New-Object System.Collections.ArrayList
    startup = New-Object System.Collections.ArrayList
    appx = New-Object System.Collections.ArrayList
  }
  # Lo que se llegue a hacer queda anotado aunque un paso falle a medias.
  try {
    Apply-Settings $state
    Apply-Protocols $state
    Remove-RunEntries $state
    Move-StartupItems $state $bk
    Remove-Apps $state
  } finally {
    if ($PSCmdlet.ShouldProcess($BackupDir, 'anotar el estado anterior')) {
      Save-State $state (Join-Path $BackupDir "debloat-$stamp.json")
    }
  }
}

function Restore-Value($v) {
  if ($v.existed) {
    if (-not (Test-Path -LiteralPath $v.path)) { New-Item -Path $v.path | Out-Null }
    New-ItemProperty -Path $v.path -Name (Get-CmdletName $v.name) -Value $v.value -PropertyType $v.kind -Force | Out-Null
    return
  }
  $key = Get-Item -LiteralPath $v.path -ErrorAction SilentlyContinue
  if ($key -and (@($key.GetValueNames()) -contains $v.name)) { Remove-ItemProperty -Path $v.path -Name (Get-CmdletName $v.name) }
}

function Remove-CreatedKey($path) {
  $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $key) { return }
  if ($key.ValueCount -or $key.SubKeyCount) {
    "clave conservada, tiene mas contenido: $path"
    return
  }
  Remove-Item -LiteralPath $path
}

function Restore-App($a) {
  $manifest = if ($a.location) { Join-Path $a.location 'AppxManifest.xml' } else { '' }
  if ($manifest -and (Test-Path -LiteralPath $manifest)) {
    Add-AppxPackage -Register $manifest -DisableDevelopmentMode -ErrorAction Stop
    "appx registrado de nuevo: $($a.name)"
    return
  }
  Add-Failure "appx $($a.name): sin ficheros en disco, NO se puede deshacer; instalalo desde la Store"
}

function Undo-Run($state) {
  $values = @($state.values | Where-Object { $_ })
  [array]::Reverse($values)
  foreach ($v in $values) {
    try {
      if ($PSCmdlet.ShouldProcess("$($v.path) [$($v.name)]", 'restaurar')) { Restore-Value $v }
    } catch { Add-Failure "$($v.path) [$($v.name)]: $($_.Exception.Message)" }
  }
  $keys = @($state.createdKeys | Where-Object { $_ })
  [array]::Reverse($keys)
  foreach ($k in $keys) {
    try {
      if ($PSCmdlet.ShouldProcess($k, 'borrar si quedo vacia')) { Remove-CreatedKey $k }
    } catch { Add-Failure "${k}: $($_.Exception.Message)" }
  }
  foreach ($s in @($state.startup | Where-Object { $_ })) {
    try {
      if ($PSCmdlet.ShouldProcess($s.from, 'devolver a la carpeta de Inicio')) { Move-Item -LiteralPath $s.to -Destination $s.from }
    } catch { Add-Failure "$($s.from): $($_.Exception.Message)" }
  }
  foreach ($a in @($state.appx | Where-Object { $_ })) {
    try {
      if ($PSCmdlet.ShouldProcess($a.name, 'registrar el paquete de nuevo')) { Restore-App $a }
    } catch { Add-Failure "appx $($a.name): $($_.Exception.Message)" }
  }
}

function Invoke-Undo {
  $all = @(Get-ChildItem -LiteralPath $BackupDir -Filter 'debloat-*.json' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*.undone.json' } | Sort-Object Name -Descending)
  if (-not $all) { throw "no hay ningun debloat-*.json sin deshacer en $BackupDir" }
  foreach ($file in $all) {
    $before = $script:failures.Count
    Undo-Run (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json)
    if ($script:failures.Count -ne $before) {
      "NO se marca como deshecho, revisa los fallos: $($file.Name)"
      continue
    }
    if ($PSCmdlet.ShouldProcess($file.Name, 'marcar como deshecho')) {
      Rename-Item -LiteralPath $file.FullName -NewName ($file.BaseName + '.undone.json')
      "deshecho: $($file.Name)"
    }
  }
}

if ($Undo) { Invoke-Undo } else { Invoke-Debloat }
if ($script:failures.Count) {
  "$($script:failures.Count) fallos: revisa las lineas FALLO"
  exit 1
}
