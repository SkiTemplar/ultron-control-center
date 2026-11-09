# Selftest de debloat-user.ps1 y servicios-bajo-demanda.ps1. No toca el sistema: registro, servicios, procesos y Appx
# son funciones falsas en memoria (una funcion gana a un cmdlet o a un .exe), y antes de lanzar nada se comprueba que
# todo comando de los scripts esta en la lista de falsos o en la de inofensivos. Si aparece otro, aborta sin ejecutar.
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\debloat\debloat.selftest.ps1
$ErrorActionPreference = 'Stop'
$scripts = @(
  (Join-Path $PSScriptRoot 'debloat-user.ps1'),
  (Join-Path $PSScriptRoot 'servicios-bajo-demanda.ps1')
)
$script:pass = 0
$script:fail = 0

function Check($name, $ok, $detail = '') {
  if ($ok) { $script:pass++; "ok   $name" } else { $script:fail++; "FAIL $name $detail" }
}

# --- Bytes y parser -------------------------------------------------------------------------------------------------
foreach ($s in $scripts + (Join-Path $PSScriptRoot 'debloat.selftest.ps1')) {
  $bytes = [IO.File]::ReadAllBytes($s)
  $name = Split-Path $s -Leaf
  Check "$name en ASCII puro" (-not ($bytes | Where-Object { $_ -gt 127 } | Select-Object -First 1))
  $errors = $null
  $tokens = $null
  [void][Management.Automation.Language.Parser]::ParseFile($s, [ref]$tokens, [ref]$errors)
  Check "$name sin errores de parser" ($errors.Count -eq 0) ($errors -join '; ')
}

# --- Registro y servicios falsos ------------------------------------------------------------------------------------
$global:Reg = @{}
$global:Svc = @{}
$global:Appx = @{}
$global:Writes = New-Object System.Collections.ArrayList
$global:RegFail = $false

function global:New-FakeKey { @{ values = @{} } }
function global:Test-RegPath($p) { "$p" -match '^(Registry::|HK[A-Z]+:?\\)' }
function global:Norm($p) { ("$p" -replace '^Registry::', '') -replace '^HKCU\\', 'HKCU:\' -replace '^HKLM\\', 'HKLM:\' }
function global:Note($what) { [void]$global:Writes.Add($what) }

function global:Test-Path {
  param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
  $p = if ($LiteralPath) { $LiteralPath } else { $Path }
  if (Test-RegPath $p) { return $global:Reg.ContainsKey((Norm $p)) }
  Microsoft.PowerShell.Management\Test-Path -LiteralPath $p
}
function global:Get-Item {
  param([string]$LiteralPath, $ErrorAction)
  $k = Norm $LiteralPath
  if (-not $global:Reg.ContainsKey($k)) { return $null }
  $values = $global:Reg[$k].values
  $sub = @($global:Reg.Keys | Where-Object { $_ -like "$k\*" }).Count
  $o = [pscustomobject]@{ ValueCount = $values.Count; SubKeyCount = $sub; Vals = $values }
  $o | Add-Member ScriptMethod GetValueNames { @($this.Vals.Keys) }
  $o | Add-Member ScriptMethod GetValueKind { param($n) $this.Vals[$n].kind }
  $o | Add-Member ScriptMethod GetValue { param($n) $this.Vals[$n].value }
  $o
}
function global:New-Item {
  param([string]$Path, [string]$ItemType, [switch]$Force)
  if ($ItemType -eq 'Directory') { return Microsoft.PowerShell.Management\New-Item -ItemType Directory -Force -Path $Path }
  Note "new-key $Path"
  $global:Reg[(Norm $Path)] = New-FakeKey
}
function global:New-ItemProperty {
  param([string]$Path, [string]$Name, $Value, [string]$PropertyType, [switch]$Force)
  Note "set $Path [$Name]"
  # Como el real: el nombre vacio no se acepta y el valor por defecto se llama (default).
  if ($Name -eq '') { throw 'New-ItemProperty: -Name vacio' }
  $real = if ($Name -eq '(default)') { '' } else { $Name }
  $global:Reg[(Norm $Path)].values[$real] = @{ kind = $PropertyType; value = $Value }
}
function global:Remove-ItemProperty {
  param([string]$Path, [string]$Name)
  Note "del $Path [$Name]"
  if ($Name -eq '') { throw 'Remove-ItemProperty: -Name vacio' }
  $real = if ($Name -eq '(default)') { '' } else { $Name }
  [void]$global:Reg[(Norm $Path)].values.Remove($real)
}
function global:Remove-Item { param([string]$LiteralPath) Note "del-key $LiteralPath"; [void]$global:Reg.Remove((Norm $LiteralPath)) }
function global:reg {
  if ($global:RegFail) { $global:LASTEXITCODE = 1; return }
  if ($args[0] -eq 'export') { Set-Content -LiteralPath $args[2] -Value 'copia falsa' }
  $global:LASTEXITCODE = 0
}
function global:Get-AppxPackage { param([string]$Name) if ($global:Appx.ContainsKey($Name)) { $global:Appx[$Name] } }
function global:Remove-AppxPackage {
  param([Parameter(ValueFromPipeline = $true)]$Package)
  process { Note "appx-del $($Package.Name)"; [void]$global:Appx.Remove($Package.Name) }
}
function global:Add-AppxPackage { param([string]$Register, [switch]$DisableDevelopmentMode, $ErrorAction) Note "appx-add $Register" }
function global:Get-Service {
  param([string]$Name, $ErrorAction)
  if ($global:Svc.ContainsKey($Name)) { [pscustomobject]@{ Name = $Name; StartType = $global:Svc[$Name].start; Status = $global:Svc[$Name].status } }
}
function global:Set-Service { param([string]$Name, [string]$StartupType) Note "svc-set $Name $StartupType"; $global:Svc[$Name].start = $StartupType }
function global:Stop-Service {
  param([string]$Name, [switch]$Force)
  Note "svc-stop $Name"
  if ($global:Svc[$Name].stuck) { throw 'servicio atascado' }
  $global:Svc[$Name].status = 'Stopped'
}
function global:Start-Service { param([string]$Name) Note "svc-start $Name"; $global:Svc[$Name].status = 'Running' }
function global:Get-Process { param([string[]]$Name, $ErrorAction) }
function global:Stop-Process { param([switch]$Force) Note 'proc-stop' }

$fakes = 'Test-Path', 'Get-Item', 'New-Item', 'New-ItemProperty', 'Remove-ItemProperty', 'Remove-Item', 'reg',
  'Get-AppxPackage', 'Remove-AppxPackage', 'Add-AppxPackage', 'Get-Service', 'Set-Service', 'Stop-Service',
  'Start-Service', 'Get-Process', 'Stop-Process'
# Cmdlets reales que solo calculan o actuan sobre -BackupDir y -StartupDir, que aqui son carpetas temporales.
$harmless = 'Join-Path', 'Split-Path', 'Get-Date', 'New-Object', 'Out-Null', 'ConvertTo-Json', 'ConvertFrom-Json',
  'Where-Object', 'ForEach-Object', 'Sort-Object', 'Get-Content', 'Set-Content', 'Get-ChildItem', 'Move-Item', 'Rename-Item'

# --- Guardia: ningun comando fuera de las listas ----------------------------------------------------------------------
$unknown = foreach ($s in $scripts) {
  $ast = [Management.Automation.Language.Parser]::ParseFile($s, [ref]$null, [ref]$null)
  $own = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
  $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique |
    Where-Object { $own -notcontains $_ -and $fakes -notcontains $_ -and $harmless -notcontains $_ }
}
if ($unknown) { throw "comandos sin falso ni clasificar; no se ejecuta nada: $($unknown -join ', ')" }
foreach ($f in $fakes) {
  if ((Get-Command $f).CommandType -ne 'Function') { throw "$f no esta suplantado; no se ejecuta nada" }
}
Check 'todo comando de los scripts esta suplantado o es inofensivo' $true

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("debloat-selftest-" + [guid]::NewGuid().ToString('N'))
$backups = Join-Path $tmp 'backups'
$startup = Join-Path $tmp 'startup'
Microsoft.PowerShell.Management\New-Item -ItemType Directory -Force -Path $backups, $startup | Out-Null

function Reset-Fixture {
  $global:Reg = @{}
  $global:Svc = @{}
  $global:Appx = @{}
  $global:Writes.Clear()
  $global:RegFail = $false
  Get-ChildItem -LiteralPath $backups -Force | Microsoft.PowerShell.Management\Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $startup -Force | Microsoft.PowerShell.Management\Remove-Item -Recurse -Force
}

function Get-Fingerprint {
  ($global:Reg.Keys | Sort-Object | ForEach-Object {
      $k = $_
      $vals = ($global:Reg[$k].values.Keys | Sort-Object | ForEach-Object { "$_=$($global:Reg[$k].values[$_].kind):$($global:Reg[$k].values[$_].value)" }) -join ','
      "$k{$vals}"
    }) -join ';'
}

$userScript = $scripts[0]
$svcScript = $scripts[1]
$adv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function New-UserFixture {
  Reset-Fixture
  $global:Reg['HKCU:\Software'] = New-FakeKey
  $global:Reg['HKCU:\Software\Microsoft\Windows\CurrentVersion'] = New-FakeKey
  $global:Reg[$adv] = New-FakeKey
  $global:Reg[$adv].values['HideFileExt'] = @{ kind = 'DWord'; value = 1 }
  $global:Reg[$adv].values['Otro'] = @{ kind = 'String'; value = 'no se toca' }
  $global:Reg[$run] = New-FakeKey
  $global:Reg[$run].values['MicrosoftEdgeAutoLaunch_X'] = @{ kind = 'String'; value = 'msedge.exe --start' }
  $global:Reg[$run].values['Mio'] = @{ kind = 'String'; value = 'mio.exe' }
  $global:Appx['Microsoft.People'] = [pscustomobject]@{ Name = 'Microsoft.People'; PackageFullName = 'People_1'; InstallLocation = (Join-Path $tmp 'sin-ficheros') }
  Set-Content -LiteralPath (Join-Path $startup 'Send to OneNote.lnk') -Value 'x'
}

# --- debloat-user -----------------------------------------------------------------------------------------------------
New-UserFixture
$before = Get-Fingerprint
& $userScript -WhatIf -BackupDir $backups -StartupDir $startup | Out-Null
Check '-WhatIf de debloat no escribe nada' ($global:Writes.Count -eq 0) ($global:Writes -join '; ')
Check '-WhatIf de debloat no deja estado' (-not (Get-ChildItem -LiteralPath $backups))
Check '-WhatIf de debloat deja el registro igual' ((Get-Fingerprint) -eq $before)
Check '-WhatIf de debloat no quita el paquete' $global:Appx.ContainsKey('Microsoft.People')

$out = & $userScript -Force -BackupDir $backups -StartupDir $startup
Check 'debloat aplica un ajuste' ($global:Reg[$adv].values['HideFileExt'].value -eq 0)
Check 'debloat no toca el dock' (-not $global:Reg[$adv].values.ContainsKey('ShowTaskViewButton'))
Check 'debloat crea los protocolos' ($global:Reg.ContainsKey('HKCU:\Software\Classes\ms-gamebar\shell\open\command'))
Check 'debloat quita lo de arranque' (-not $global:Reg[$run].values.ContainsKey('MicrosoftEdgeAutoLaunch_X'))
Check 'debloat conserva lo demas de arranque' ($global:Reg[$run].values.ContainsKey('Mio'))
Check 'debloat saca el acceso de Inicio' (-not (Get-ChildItem -LiteralPath $startup))
Check 'debloat quita el paquete' (-not $global:Appx.ContainsKey('Microsoft.People'))
$first = @(Get-ChildItem -LiteralPath $backups -Filter 'debloat-*.json')
Check 'debloat anota el estado' ($first.Count -eq 1)

Start-Sleep -Milliseconds 20
$global:Writes.Clear()
& $userScript -Force -BackupDir $backups -StartupDir $startup | Out-Null
Check 'la segunda ejecucion no escribe nada' ($global:Writes.Count -eq 0) ($global:Writes -join '; ')
Check 'la segunda ejecucion no tapa el estado original' (@(Get-ChildItem -LiteralPath $backups -Filter 'debloat-*.json').Count -eq 1)

& $userScript -Undo -BackupDir $backups -StartupDir $startup | Out-Null
$undoExit = $LASTEXITCODE
Check '-Undo devuelve todo el registro a como estaba' ((Get-Fingerprint) -eq $before) (Get-Fingerprint)
Check '-Undo devuelve el acceso de Inicio' (Get-ChildItem -LiteralPath $startup -Filter '*OneNote*')
Check '-Undo dice que no puede reponer un paquete sin ficheros' ($undoExit -eq 1)
Check 'sin ficheros, el estado no se marca como deshecho' (-not (Get-ChildItem -LiteralPath $backups -Filter '*.undone.json'))

New-UserFixture
Set-Content -LiteralPath (Join-Path $tmp 'AppxManifest.xml') -Value 'x'
$global:Appx['Microsoft.People'].InstallLocation = $tmp
$before = Get-Fingerprint
& $userScript -Force -BackupDir $backups -StartupDir $startup | Out-Null
$global:Reg[$adv].values['HideFileExt'] = @{ kind = 'DWord'; value = 5 }
Start-Sleep -Milliseconds 20
& $userScript -Force -BackupDir $backups -StartupDir $startup | Out-Null
Check 'un cambio ajeno entre ejecuciones se anota aparte' (@(Get-ChildItem -LiteralPath $backups -Filter 'debloat-*.json').Count -eq 2)
& $userScript -Undo -BackupDir $backups -StartupDir $startup | Out-Null
Check '-Undo encadenado llega al estado de la primera ejecucion' ((Get-Fingerprint) -eq $before) (Get-Fingerprint)
Check '-Undo marca todo como deshecho' (@(Get-ChildItem -LiteralPath $backups -Filter '*.undone.json').Count -eq 2)
Check '-Undo registra el paquete con ficheros' (($global:Writes -join ';') -match 'appx-add')
$threw = $false
try { & $userScript -Undo -BackupDir $backups -StartupDir $startup | Out-Null } catch { $threw = $true }
Check 'sin nada que deshacer, -Undo falla y lo dice' $threw

New-UserFixture
$global:RegFail = $true
$threw = $false
try { & $userScript -Force -BackupDir $backups -StartupDir $startup | Out-Null } catch { $threw = $true }
Check 'si una exportacion falla, aborta' $threw
Check 'si una exportacion falla, no toca nada' ($global:Writes.Count -eq 0) ($global:Writes -join '; ')

# --- servicios --------------------------------------------------------------------------------------------------------
function New-SvcFixture($start = 'Automatic', $status = 'Running') {
  Reset-Fixture
  $global:Reg['HKLM:\SOFTWARE'] = New-FakeKey
  $global:Svc['OVRService'] = @{ start = $start; status = $status; stuck = $false }
}

New-SvcFixture
$threw = $false
try { & $svcScript -BackupDir $backups | Out-Null } catch { $threw = $_.Exception.Message -match 'administrador' }
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Check 'sin admin, servicios aborta y lo dice' $threw
  Check 'sin admin, servicios no toca nada' ($global:Writes.Count -eq 0)
  Check 'sin admin, servicios no deja copia' (-not (Get-ChildItem -LiteralPath $backups))
}

New-SvcFixture
& $svcScript -WhatIf -BackupDir $backups | Out-Null
Check '-WhatIf de servicios no escribe nada' ($global:Writes.Count -eq 0) ($global:Writes -join '; ')
Check '-WhatIf de servicios no deja copia' (-not (Get-ChildItem -LiteralPath $backups))

$before = Get-Fingerprint
& $svcScript -NoAdminCheck -BackupDir $backups | Out-Null
Check 'servicios pasa a Manual y para' ($global:Svc['OVRService'].start -eq 'Manual' -and $global:Svc['OVRService'].status -eq 'Stopped')
Check 'servicios pone la directiva' ($global:Reg['HKLM:\SOFTWARE\Policies\Microsoft\VisualStudio\Setup'].values['BackgroundDownloadDisabled'].value -eq 1)
Start-Sleep -Milliseconds 20
$global:Writes.Clear()
& $svcScript -NoAdminCheck -BackupDir $backups | Out-Null
Check 'la segunda ejecucion de servicios no escribe nada' ($global:Writes.Count -eq 0) ($global:Writes -join '; ')
Check 'la segunda ejecucion de servicios no tapa el original' (@(Get-ChildItem -LiteralPath $backups -Filter 'servicios-*.json').Count -eq 1)
& $svcScript -Undo -NoAdminCheck -BackupDir $backups | Out-Null
Check '-Undo restaura el inicio' ($global:Svc['OVRService'].start -eq 'Automatic')
Check '-Undo vuelve a arrancar lo que estaba en marcha' ($global:Svc['OVRService'].status -eq 'Running')
Check '-Undo deja la directiva como estaba' ((Get-Fingerprint) -eq $before) (Get-Fingerprint)
Check '-Undo de servicios marca como deshecho' (@(Get-ChildItem -LiteralPath $backups -Filter '*.undone.json').Count -eq 1)

New-SvcFixture 'Automatic' 'Stopped'
& $svcScript -NoAdminCheck -BackupDir $backups | Out-Null
& $svcScript -Undo -NoAdminCheck -BackupDir $backups | Out-Null
Check '-Undo no arranca lo que estaba parado' ($global:Svc['OVRService'].status -eq 'Stopped')

New-SvcFixture
$global:Reg['HKLM:\SOFTWARE\Policies'] = New-FakeKey
$global:Reg['HKLM:\SOFTWARE\Policies\Microsoft'] = New-FakeKey
$global:Reg['HKLM:\SOFTWARE\Policies\Microsoft\VisualStudio'] = New-FakeKey
$setup = 'HKLM:\SOFTWARE\Policies\Microsoft\VisualStudio\Setup'
$global:Reg[$setup] = New-FakeKey
$global:Reg[$setup].values['OtraDirectiva'] = @{ kind = 'DWord'; value = 7 }
$before = Get-Fingerprint
& $svcScript -NoAdminCheck -BackupDir $backups | Out-Null
Check 'una clave de directivas existente no se vacia' ($global:Reg[$setup].values['OtraDirectiva'].value -eq 7)
& $svcScript -Undo -NoAdminCheck -BackupDir $backups | Out-Null
Check '-Undo conserva las directivas ajenas' ((Get-Fingerprint) -eq $before) (Get-Fingerprint)

New-SvcFixture
$global:Svc['OVRService'].stuck = $true
$text = & $svcScript -NoAdminCheck -BackupDir $backups
$stuckExit = $LASTEXITCODE
Check 'un servicio que no para no se da por parado' (($text -join "`n") -match 'FALLO' -and ($text -join "`n") -notmatch 'Manual y parado') ($text -join ' | ')
Check 'un servicio que no para termina con codigo 1' ($stuckExit -eq 1)
Check 'aunque falle, el estado queda anotado' (@(Get-ChildItem -LiteralPath $backups -Filter 'servicios-*.json').Count -eq 1)

Microsoft.PowerShell.Management\Remove-Item -LiteralPath $tmp -Recurse -Force
"$($script:pass) ok, $($script:fail) fallos"
if ($script:fail) { exit 1 }
