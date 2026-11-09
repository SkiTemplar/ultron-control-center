# Compila e instala un mod de Windhawk igual que su interfaz (requiere admin).
# Uso: install-mod.ps1 -Source <mod.wh.cpp> [-Settings @{ theme = 'DockLike' }] [-SettingsOnly]
# -SettingsOnly reescribe solo los ajustes de un mod ya instalado, sin recompilarlo.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [hashtable]$Settings = @{},
  [string]$Log = (Join-Path $PSScriptRoot 'install-mod.log'),
  [switch]$SettingsOnly
)
$ErrorActionPreference = 'Stop'

function Write-ModSettings($key, $settings) {
  Remove-Item -Path "$key\Settings" -Recurse -ErrorAction SilentlyContinue
  New-Item -Path "$key\Settings" -Force | Out-Null
  foreach ($k in $settings.Keys) {
    $v = $settings[$k]
    if ($v -is [int]) { New-ItemProperty -Path "$key\Settings" -Name $k -Value $v -PropertyType DWord -Force | Out-Null }
    else { New-ItemProperty -Path "$key\Settings" -Name $k -Value ([string]$v) -PropertyType String -Force | Out-Null }
  }
  $now = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -band 0x7FFFFFFF)
  New-ItemProperty -Path $key -Name 'SettingsChangeTime' -Value $now -PropertyType DWord -Force | Out-Null
}

function Get-Meta($text, $key) {
  $m = [regex]::Match($text, "(?m)^//\s*@$key\s+(.+?)\s*$")
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}

try {
  $code = [IO.File]::ReadAllText($Source)
  $id = Get-Meta $code 'id'
  $version = Get-Meta $code 'version'
  $include = ([regex]::Matches($code, '(?m)^//\s*@include\s+(.+?)\s*$') | ForEach-Object { $_.Groups[1].Value }) -join '|'
  $arch = Get-Meta $code 'architecture'
  $extra = (Get-Meta $code 'compilerOptions') -split '\s+' | Where-Object { $_ }
  if (-not $id -or -not $version) { throw "metadatos @id/@version ausentes en $Source" }
  if ($arch -and $arch -ne 'x86-64') { throw "arquitectura no soportada por este script: $arch" }

  $key = "HKLM:\SOFTWARE\Windhawk\Engine\Mods\$id"
  if ($SettingsOnly) {
    if (-not (Get-ItemProperty $key -ErrorAction SilentlyContinue).LibraryFileName) {
      throw "el mod $id no esta instalado; ejecutar sin -SettingsOnly"
    }
    Write-ModSettings $key $Settings
    "OK $id $version (solo ajustes)" | Out-File $Log -Encoding utf8
    return
  }

  $compiler = 'C:\Program Files\Windhawk\Compiler'
  $engine = Get-ChildItem 'C:\Program Files\Windhawk\Engine' -Directory | Sort-Object Name | Select-Object -Last 1
  $modsDir = 'C:\ProgramData\Windhawk\Engine\Mods\64'
  $dll = '{0}_{1}_{2}.dll' -f $id, $version, (Get-Random -Minimum 100000 -Maximum 999999)
  $out = Join-Path $modsDir $dll

  $args = @('-std=c++23', '-O2', '-shared', '-DUNICODE', '-D_UNICODE',
    '-DWINVER=0x0A00', '-D_WIN32_WINNT=0x0A00', '-D_WIN32_IE=0x0A00', '-DNTDDI_VERSION=0x0A000008',
    '-D__USE_MINGW_ANSI_STDIO=0', '-DWH_MOD', ('-DWH_MOD_ID=L\"{0}\"' -f $id), ('-DWH_MOD_VERSION=L\"{0}\"' -f $version),
    (Join-Path $engine.FullName '64\windhawk.lib'), '-x', 'c++', $Source, '-include', 'windhawk_api.h',
    '-target', 'x86_64-w64-mingw32', '-Wl,--export-all-symbols', '-o', $out) + $extra

  Push-Location $compiler
  $ErrorActionPreference = 'Continue'
  $result = & (Join-Path $compiler 'bin\clang++.exe') @args 2>&1
  $exit = $LASTEXITCODE
  Pop-Location
  $ErrorActionPreference = 'Stop'
  if ($exit -ne 0) { throw "clang++ salio con $exit :: $($result | Select-Object -First 40 | Out-String)" }

  $old = (Get-ItemProperty $key -ErrorAction SilentlyContinue).LibraryFileName
  New-Item -Path $key -Force | Out-Null
  $str = @{ LibraryFileName = $dll; Include = $include; Exclude = ''; IncludeCustom = ''; ExcludeCustom = ''; Architecture = $arch; Version = $version }
  foreach ($k in $str.Keys) { New-ItemProperty -Path $key -Name $k -Value $str[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in 'Disabled', 'LoggingEnabled', 'DebugLoggingEnabled', 'IncludeExcludeCustomOnly', 'PatternsMatchCriticalSystemProcesses') {
    New-ItemProperty -Path $key -Name $k -Value 0 -PropertyType DWord -Force | Out-Null
  }
  Write-ModSettings $key $Settings

  $srcDir = 'C:\ProgramData\Windhawk\ModsSource'
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  Copy-Item $Source (Join-Path $srcDir "$id.wh.cpp") -Force
  if ($old -and $old -ne $dll) { Remove-Item (Join-Path $modsDir $old) -ErrorAction SilentlyContinue }

  "OK $id $version -> $dll" | Out-File $Log -Encoding utf8
} catch {
  "ERROR: $_" | Out-File $Log -Encoding utf8
}
