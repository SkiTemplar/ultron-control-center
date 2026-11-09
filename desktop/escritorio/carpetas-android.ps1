# Carpetas estilo Android: las carpetas reales viven en %LOCALAPPDATA%\Lienzo\Carpetas y el escritorio solo
# tiene accesos directos que abren LienzoFolders.exe (panel flotante con las apps). Idempotente. Sin admin.
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$store = Join-Path $env:LOCALAPPDATA 'Lienzo\Carpetas'
$exe = Join-Path $env:LOCALAPPDATA 'Lienzo\bin\LienzoFolders.exe'
if (-not (Test-Path $exe)) { throw "falta $exe (dotnet publish de desktop\lienzo-folders)" }
New-Item -ItemType Directory -Force -Path $store | Out-Null
$shell = New-Object -ComObject WScript.Shell

foreach ($name in 'Juegos', 'Desarrollo', 'Apps', 'Utilidades') {
  $onDesktop = Join-Path $desktop $name
  $target = Join-Path $store $name
  if (Test-Path $onDesktop -PathType Container) {
    attrib -r $onDesktop | Out-Null
    if (Test-Path $target) {
      Get-ChildItem $onDesktop -Force | Move-Item -Destination $target -Force
      Remove-Item $onDesktop -Force -Recurse
    } else {
      Move-Item $onDesktop $target
    }
  }
  if (-not (Test-Path $target)) { continue }
  $lnk = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
  $lnk.TargetPath = $exe
  $lnk.Arguments = "`"$target`""
  $lnk.WorkingDirectory = $target
  $ico = Join-Path $target 'folder.ico'
  if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
  $lnk.Description = "Carpeta $name"
  $lnk.Save()
  "carpeta: $name -> $target"
}
