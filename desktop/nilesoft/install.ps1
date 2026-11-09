# Enlaza el tema y las entradas propias en Nilesoft Shell y recarga el Explorador (requiere admin).
# Nilesoft no admite rutas absolutas en import: se usan enlaces simbolicos al repo, asi los cambios
# posteriores de theme.nss, ultron.nss o apps.local.nss (gen-apps.mjs) solo necesitan "shell.exe -restart", sin admin.
$ErrorActionPreference = 'Stop'
$dir = 'C:\Program Files\Nilesoft Shell'
$log = Join-Path $PSScriptRoot 'install.log'
try {
  if (-not (Test-Path "$dir\imports\theme.nss.orig")) { Copy-Item "$dir\imports\theme.nss" "$dir\imports\theme.nss.orig" }
  foreach ($name in 'theme.nss', 'ultron.nss', 'apps.local.nss') {
    $link = "$dir\imports\$name"
    if (Test-Path $link) { Remove-Item $link -Force }
    New-Item -ItemType SymbolicLink -Path $link -Target (Join-Path $PSScriptRoot $name) | Out-Null
  }
  $main = Get-Content "$dir\shell.nss" -Raw
  foreach ($imp in 'ultron.nss', 'apps.local.nss') {
    if ($main -notmatch "imports/$imp") { $main = $main.TrimEnd() + "`r`nimport 'imports/$imp'`r`n" }
  }
  # "Mas opciones" solo salia con seleccion (mode="multiple"); sin mode sale siempre, tambien en el escritorio.
  $main = $main.Replace('menu(mode="multiple" title=title.more_options', 'menu(title=title.more_options')
  Set-Content "$dir\shell.nss" $main -Encoding UTF8 -NoNewline
  # El menu de la barra trae su propio submenu "Apps" (Paint, Edge...); se quita para dejar solo el de
  # apps.local.nss.
  $taskbar = "$dir\imports\taskbar.nss"
  if (-not (Test-Path "$taskbar.orig")) { Copy-Item $taskbar "$taskbar.orig" }
  $tb = Get-Content $taskbar -Raw
  $tb = [regex]::Replace($tb, '(?s)\r?\n\s*menu\(title="Apps"[^\r\n]*\r?\n\s*\{.*?\r?\n\s*\}', '')
  Set-Content $taskbar $tb -Encoding UTF8 -NoNewline
  & "$dir\shell.exe" -register -restart -silent
  'OK' | Out-File $log -Encoding utf8
} catch { "ERROR: $_" | Out-File $log -Encoding utf8 }
