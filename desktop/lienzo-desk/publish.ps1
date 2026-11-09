# Publica LienzoDesk en %LOCALAPPDATA%\Lienzo\bin y relanza el residente. Sin admin.
# - LienzoDesk.exe: lanzador nativo (desktop\lienzo-launch, NativeAOT) al que apuntan el dock, Nilesoft y el
#   arranque de sesion. Pulsa la tecla o pasa la orden al residente y sale.
# - LienzoDesk.App.exe: app WPF residente (tarjetas, menu de Apagado, selector de carpeta).
# El residente se relanza por WMI: lanzado desde una sesion de Claude moriria al cerrarse esa sesion (papercuts).
$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:LOCALAPPDATA 'Lienzo\bin'
$stage = Join-Path $env:TEMP 'lienzo-publish'
# El compilador NativeAOT busca el enlazador de MSVC con vswhere, que no esta en el PATH por defecto.
$vsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
if (Test-Path $vsInstaller) { $env:PATH = "$env:PATH;$vsInstaller" }

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
dotnet publish (Join-Path $PSScriptRoot '..\lienzo-launch\LienzoLaunch.csproj') -c Release -r win-x64 -o (Join-Path $stage 'launch')
if ($LASTEXITCODE -ne 0) { throw 'fallo al publicar el lanzador' }
dotnet publish (Join-Path $PSScriptRoot 'LienzoDesk.csproj') -c Release -o (Join-Path $stage 'app')
if ($LASTEXITCODE -ne 0) { throw 'fallo al publicar la app' }

Get-Process -Name 'LienzoDesk', 'LienzoDesk.App' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Force -Path $bin | Out-Null
# Restos del despliegue anterior, cuando LienzoDesk.exe era la propia app WPF.
foreach ($old in 'LienzoDesk.dll', 'LienzoDesk.deps.json', 'LienzoDesk.runtimeconfig.json') {
  Remove-Item (Join-Path $bin $old) -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $stage 'app\*') $bin -Force
Copy-Item (Join-Path $stage 'launch\LienzoDesk.exe') $bin -Force

$exe = Join-Path $bin 'LienzoDesk.exe'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$exe`"" }
if ($r.ReturnValue -ne 0) { throw "no se pudo relanzar el residente (Win32_Process.Create = $($r.ReturnValue))" }
Start-Sleep -Seconds 2
$app = Get-Process -Name 'LienzoDesk.App' -ErrorAction SilentlyContinue
if (-not $app) { throw 'el residente LienzoDesk.App no ha arrancado' }
"OK: residente pid $($app.Id); lanzador $((Get-Item $exe).Length / 1KB -as [int]) KB"
