# ULTRON v10.3 Cockpit - Desktop shortcut installer
#
# Creates a .lnk on the Desktop that launches `ultron tui` in Windows Terminal.
# User can change icon afterwards via right-click -> Properties -> Change Icon.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File desktop-shortcut.ps1
#   powershell -File desktop-shortcut.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$Name = "ULTRON Cockpit"
)

$ErrorActionPreference = "Stop"

$Desktop      = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "$Name.lnk"

if ($Uninstall) {
    if (Test-Path $ShortcutPath) {
        Remove-Item -Force $ShortcutPath
        Write-Host "[Desktop] Removed: $ShortcutPath" -ForegroundColor Yellow
    } else {
        Write-Host "[Desktop] Nothing to remove ($ShortcutPath does not exist)"
    }
    return
}

# Find wt.exe (Windows Terminal). Fallback to powershell.exe if not present.
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
$tuiScript = Join-Path $PSScriptRoot "tui.py"

if (-not (Test-Path $tuiScript)) {
    Write-Error "tui.py not found at: $tuiScript"
    exit 1
}

# Resolve uv (ULTRON always uses uv, never raw python)
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    Write-Error "uv not found in PATH. Install from https://docs.astral.sh/uv/"
    exit 1
}
$uvExe = $uv.Source
$ultronRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($wt) {
    # Windows Terminal route - opens a proper tab
    $target    = $wt.Source
    $arguments = "new-tab --title `"⌬ ULTRON Cockpit`" -d `"$ultronRoot`" `"$uvExe`" run python `"$tuiScript`""
} else {
    # Fallback: plain PowerShell window
    $target = (Get-Command powershell.exe).Source
    $arguments = "-NoExit -ExecutionPolicy Bypass -Command `"Set-Location '$ultronRoot'; & '$uvExe' run python '$tuiScript'`""
}

# Create the .lnk via WScript.Shell COM
$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath       = $target
$shortcut.Arguments        = $arguments
$shortcut.WorkingDirectory = $ultronRoot
$shortcut.Description      = "ULTRON Cockpit TUI - master orchestrator"
$shortcut.WindowStyle      = 1   # Normal window

# Default icon: use uv.exe icon. User can change via right-click -> Properties -> Change Icon.
$shortcut.IconLocation = "$uvExe,0"

$shortcut.Save()

Write-Host "[Desktop] Created: $ShortcutPath" -ForegroundColor Green
Write-Host "[Desktop] Target:  $target" -ForegroundColor DarkGray
Write-Host "[Desktop] Tip: Right-click the shortcut -> Properties -> Change Icon -> pick your custom .ico" -ForegroundColor Cyan
