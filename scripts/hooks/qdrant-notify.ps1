param(
    [switch]$SuccessOnRetry
)

# qdrant-notify.ps1 - reads qdrant-health.json and shows a persistent floating
# WinForm panel when Qdrant is not OK. Companion to ensure-qdrant.ps1 (v15.0.2).
#
# Design notes:
# - WinForms (not BurntToast): Windows native toasts are silently swallowed
#   when notifications/Focus Assist are off. WinForm TopMost is always shown.
# - Persistent: NO auto-close. Stays visible until user clicks a button or
#   the X. Anti-spam per session via qdrant-toast-state.json.
# - Triggered from ULTRON-QdrantBoot scheduled task at user logon (v15.0.2),
#   not only from Claude SessionStart hook.
#
# Hard rule: never throw, never produce visible errors. Failures fall back
# to alerts.jsonl and exit 0.

$ErrorActionPreference = 'Continue'

$tmpDir    = "$env:USERPROFILE\.ultron\.tmp"
$hooksDir  = "$env:USERPROFILE\.ultron\scripts\hooks"
$health    = Join-Path $tmpDir 'qdrant-health.json'
$stateFile = Join-Path $tmpDir 'qdrant-toast-state.json'
$alerts    = "$env:USERPROFILE\.ultron\alerts.jsonl"
$iconPath  = "$env:USERPROFILE\.ultron\cockpit\icons\01-ultron.ico"

if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}

function Write-Alert {
    param([string]$Severity, [string]$Status, [string]$Msg)
    try {
        $obj = [ordered]@{
            timestamp = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
            source    = 'qdrant-notify'
            severity  = $Severity
            status    = $Status
            message   = $Msg
        } | ConvertTo-Json -Compress
        Add-Content -Path $alerts -Value $obj -Encoding UTF8
    } catch { }
}

# Fullscreen detection: if a fullscreen-exclusive app (game) is in foreground,
# DO NOT show the panel at all — even a non-activating window forces Windows
# to switch out of exclusive mode. Just write an alert and exit silently.
# Next trigger (next logon or run-now) will surface the panel when the user
# is back at the desktop.
function Test-ForegroundFullscreen {
    try {
        if (-not ('UltronFsCheck' -as [type])) {
            Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class UltronFsCheck {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
        }
        $hwnd = [UltronFsCheck]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        $shell   = [UltronFsCheck]::GetShellWindow()
        $desktop = [UltronFsCheck]::GetDesktopWindow()
        if ($hwnd -eq $shell -or $hwnd -eq $desktop) { return $false }

        $rect = New-Object 'UltronFsCheck+RECT'
        if (-not [UltronFsCheck]::GetWindowRect($hwnd, [ref]$rect)) { return $false }

        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        $bounds  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $working = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top

        # Maximizada = cubre WorkingArea (sin tocar zona de taskbar).
        # Fullscreen exclusiva/borderless = cubre Bounds completo (incluye
        # la franja de la taskbar). Solo yield en el segundo caso.
        # Tolerancia de 4px por DPI scaling.
        $isFullScreen = ($w -ge ($bounds.Width - 4) -and
                         $h -ge ($bounds.Height - 4) -and
                         $h -gt ($working.Height + 4))

        return $isFullScreen
    } catch {
        return $false
    }
}

if (-not (Test-Path $health)) { exit 0 }

try {
    $rawHealth = [System.IO.File]::ReadAllText($health, [System.Text.Encoding]::UTF8)
    $hs = $rawHealth | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Alert -Severity 'warn' -Status 'health-parse-error' -Msg $_.Exception.Message
    exit 0
}

$status = if ($hs.status) { [string]$hs.status } else { 'unknown' }
$msg    = if ($hs.message) { [string]$hs.message } else { '' }

$state = $null
if (Test-Path $stateFile) {
    try { $state = Get-Content -Raw $stateFile | ConvertFrom-Json -ErrorAction Stop } catch { $state = $null }
}

function Save-State {
    param([string]$NotifiedStatus)
    try {
        $obj = [ordered]@{
            notified_status = $NotifiedStatus
            timestamp       = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
        } | ConvertTo-Json
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($stateFile, $obj, $utf8)
    } catch { }
}

# All user-facing strings use ASCII only to survive PS5.1 cp1252 fallback
# if the script is somehow read without BOM. The bullet between ULTRON and
# the message is a plain ASCII pipe.

function Show-UltronPanel {
    param(
        [string]$Title,
        [string]$Body,
        [bool]$ShowRetry = $true,
        [bool]$SuccessVariant = $false,
        [bool]$ShowSetup = $false
    )

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
    } catch {
        Write-Alert -Severity 'warn' -Status $status -Msg "WinForms load failed: $($_.Exception.Message)"
        return $null
    }

    # Subclase de Form que se muestra SIN robar foco. Critica para que el
    # panel no saque al usuario de un juego en modo borderless. En juegos
    # fullscreen exclusivo Windows siempre va a interrumpir (limitacion del
    # OS, no nuestra) — para esos casos el usuario tendra que cerrar el
    # juego para ver el panel.
    if (-not ('UltronNoActivateForm' -as [type])) {
        Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Windows.Forms;
public class UltronNoActivateForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            // WS_EX_NOACTIVATE = 0x08000000  (no robar foco al aparecer)
            // WS_EX_TOPMOST    = 0x00000008  (siempre encima)
            // WS_EX_TOOLWINDOW = 0x00000080  (no entry en Alt+Tab)
            const int WS_EX_NOACTIVATE = 0x08000000;
            const int WS_EX_TOPMOST    = 0x00000008;
            const int WS_EX_TOOLWINDOW = 0x00000080;
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
            return cp;
        }
    }
}
'@ -ErrorAction SilentlyContinue
    }

    $bgColor      = [System.Drawing.Color]::FromArgb(255, 22, 24, 32)
    $borderColor  = if ($SuccessVariant) {
                        [System.Drawing.Color]::FromArgb(255, 56, 178, 110)
                    } else {
                        [System.Drawing.Color]::FromArgb(255, 232, 89, 89)
                    }
    $titleColor   = [System.Drawing.Color]::FromArgb(255, 230, 232, 240)
    $bodyColor    = [System.Drawing.Color]::FromArgb(255, 168, 172, 184)
    $btnBg        = [System.Drawing.Color]::FromArgb(255, 38, 42, 54)
    $btnHover     = [System.Drawing.Color]::FromArgb(255, 56, 60, 76)
    $btnText      = [System.Drawing.Color]::FromArgb(255, 230, 232, 240)
    $accentBg     = [System.Drawing.Color]::FromArgb(255, 88, 110, 255)
    $accentHover  = [System.Drawing.Color]::FromArgb(255, 108, 130, 255)

    # Usa la subclase NoActivate si esta disponible; si no (fallo de Add-Type)
    # cae a Form normal — sigue funcional pero robaria foco en juegos.
    if ('UltronNoActivateForm' -as [type]) {
        $form = New-Object UltronNoActivateForm
    } else {
        $form = New-Object System.Windows.Forms.Form
    }
    $form.Text         = 'ULTRON'
    $form.Size         = New-Object System.Drawing.Size(480, 200)
    $form.FormBorderStyle = 'None'
    $form.StartPosition   = 'Manual'
    $form.TopMost      = $true
    $form.ShowInTaskbar = $false
    $form.BackColor    = $bgColor

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Location = New-Object System.Drawing.Point(
        ($screen.Right  - $form.Width  - 20),
        ($screen.Bottom - $form.Height - 20)
    )

    # Outer 1px frame (border feel without window chrome).
    $outerFrame              = New-Object System.Windows.Forms.Panel
    $outerFrame.Dock         = 'Fill'
    $outerFrame.BackColor    = [System.Drawing.Color]::FromArgb(255, 60, 64, 80)
    $outerFrame.Padding      = New-Object System.Windows.Forms.Padding(1)
    $form.Controls.Add($outerFrame)

    $inner               = New-Object System.Windows.Forms.Panel
    $inner.Dock          = 'Fill'
    $inner.BackColor     = $bgColor
    $outerFrame.Controls.Add($inner)

    # Top colored strip (severity signal).
    $strip               = New-Object System.Windows.Forms.Panel
    $strip.Height        = 4
    $strip.Dock          = 'Top'
    $strip.BackColor     = $borderColor
    $inner.Controls.Add($strip)

    # Close X.
    $btnClose            = New-Object System.Windows.Forms.Label
    $btnClose.Text       = 'x'
    $btnClose.Font       = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $btnClose.ForeColor  = $bodyColor
    $btnClose.BackColor  = [System.Drawing.Color]::Transparent
    $btnClose.Size       = New-Object System.Drawing.Size(28, 24)
    $btnClose.Location   = New-Object System.Drawing.Point(444, 8)
    $btnClose.TextAlign  = 'MiddleCenter'
    $btnClose.Cursor     = [System.Windows.Forms.Cursors]::Hand
    $btnClose.Add_Click({ $form.Close() })
    $btnClose.Add_MouseEnter({ $btnClose.ForeColor = $titleColor })
    $btnClose.Add_MouseLeave({ $btnClose.ForeColor = $bodyColor })
    $inner.Controls.Add($btnClose)
    $btnClose.BringToFront()

    # Title.
    $lblTitle             = New-Object System.Windows.Forms.Label
    $lblTitle.Text        = $Title
    $lblTitle.ForeColor   = $titleColor
    $lblTitle.Font        = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
    $lblTitle.Location    = New-Object System.Drawing.Point(20, 18)
    $lblTitle.Size        = New-Object System.Drawing.Size(420, 24)
    $lblTitle.BackColor   = [System.Drawing.Color]::Transparent
    $inner.Controls.Add($lblTitle)

    # Body.
    $lblBody              = New-Object System.Windows.Forms.Label
    $lblBody.Text         = $Body
    $lblBody.ForeColor    = $bodyColor
    $lblBody.Font         = New-Object System.Drawing.Font('Segoe UI', 10)
    $lblBody.Location     = New-Object System.Drawing.Point(20, 48)
    $lblBody.Size         = New-Object System.Drawing.Size(444, 86)
    $lblBody.BackColor    = [System.Drawing.Color]::Transparent
    $inner.Controls.Add($lblBody)

    # Buttons row.
    $btnY = 142
    $btnW = 110
    $rightEdge = 460
    $cursorX = $rightEdge

    function New-FlatBtn {
        param([string]$Text, [object]$Bg, [object]$HoverBg, [object]$Fg)
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Text
        $b.Size = New-Object System.Drawing.Size($btnW, 32)
        $b.FlatStyle = 'Flat'
        $b.BackColor = $Bg
        $b.ForeColor = $Fg
        $b.Font = New-Object System.Drawing.Font('Segoe UI', 9)
        $b.FlatAppearance.BorderSize = 0
        $b.FlatAppearance.MouseOverBackColor = $HoverBg
        $b.Cursor = [System.Windows.Forms.Cursors]::Hand
        return $b
    }

    if ($SuccessVariant) {
        $cursorX -= $btnW
        $btnOk = New-FlatBtn 'OK' $btnBg $btnHover $btnText
        $btnOk.Location = New-Object System.Drawing.Point($cursorX, $btnY)
        $btnOk.Add_Click({ $form.Close() })
        $inner.Controls.Add($btnOk)
    } else {
        # Always show Silenciar so the panel can always be dismissed via button.
        $cursorX -= $btnW
        $btnSil = New-FlatBtn 'Silenciar' $btnBg $btnHover $btnText
        $btnSil.Location = New-Object System.Drawing.Point($cursorX, $btnY)
        $btnSil.Add_Click({ $form.Tag = 'silence'; $form.Close() })
        $inner.Controls.Add($btnSil)

        if ($ShowRetry) {
            $cursorX -= ($btnW + 8)
            $btnRetry = New-FlatBtn 'Reintentar' $accentBg $accentHover $titleColor
            $btnRetry.Location = New-Object System.Drawing.Point($cursorX, $btnY)
            $btnRetry.Add_Click({ $form.Tag = 'retry'; $form.Close() })
            $inner.Controls.Add($btnRetry)
        }

        if ($ShowSetup) {
            $cursorX -= ($btnW + 8)
            $btnSetup = New-FlatBtn 'Copiar setup' $accentBg $accentHover $titleColor
            $btnSetup.Location = New-Object System.Drawing.Point($cursorX, $btnY)
            $btnSetup.Add_Click({
                param($sender, $eventArgs)
                try {
                    Set-Clipboard -Value 'ultron qdrant setup'
                    $sender.Text = 'Copiado!'
                    $okColor = [System.Drawing.Color]::FromArgb(255, 56, 178, 110)
                    $sender.BackColor = $okColor
                    $sender.FlatAppearance.MouseOverBackColor = $okColor
                    $sender.Enabled = $false
                    # Re-enable visual contrast on disabled state.
                    $sender.ForeColor = [System.Drawing.Color]::White
                } catch {
                    $sender.Text = 'Error copiando'
                    $errColor = [System.Drawing.Color]::FromArgb(255, 232, 89, 89)
                    $sender.BackColor = $errColor
                    $sender.FlatAppearance.MouseOverBackColor = $errColor
                }
            })
            $inner.Controls.Add($btnSetup)
        }
    }

    if (Test-Path $iconPath) {
        try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch { }
    }

    [void]$form.ShowDialog()

    return $form.Tag
}

if ($SuccessOnRetry) {
    if ($status -eq 'up') {
        Show-UltronPanel -Title 'ULTRON | Qdrant up' `
                         -Body 'Recall semantico de vuelta. Todo OK.' `
                         -ShowRetry $false `
                         -SuccessVariant $true | Out-Null
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        exit 0
    }
}

if ($status -eq 'up') {
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    exit 0
}

if ($state -and $state.notified_status -eq $status) { exit 0 }

# Yield to fullscreen games / immersive apps. NOTE: we do NOT save state
# here, so the next trigger (logon, run-now, retry) will try again — the
# user only sees the panel when they're actually at the desktop.
if (Test-ForegroundFullscreen) {
    Write-Alert -Severity 'info' -Status $status -Msg "Panel skipped: foreground app is fullscreen. Will retry on next trigger."
    exit 0
}

$statusMap = @{
    'native-failed'   = @{ Title = 'ULTRON | Qdrant nativo';      Body = "Qdrant nativo (qdrant.exe) no arranca. Sistema en modo degraded (recall por FTS5 keyword sigue OK). Detalle: $msg"; Retry = $true; Setup = $false }
    'native-missing'  = @{ Title = 'ULTRON | Qdrant no instalado'; Body = "Binario nativo qdrant.exe ausente. Recall semantico desactivado (FTS5 keyword sigue OK). Reinstala el v1.18.0 windows zip."; Retry = $false; Setup = $false }
    'unhealthy'       = @{ Title = 'ULTRON | Qdrant degradado';   Body = "Qdrant esta up pero healthz responde mal. $msg"; Retry = $true; Setup = $false }
}

if (-not $statusMap.ContainsKey($status)) {
    $cfg = @{ Title = 'ULTRON | Qdrant'; Body = "Estado inesperado: $status. $msg"; Retry = $true; Setup = $false }
} else {
    $cfg = $statusMap[$status]
}

Save-State -NotifiedStatus $status

$choice = Show-UltronPanel -Title $cfg.Title -Body $cfg.Body `
                           -ShowRetry $cfg.Retry -ShowSetup $cfg.Setup

if ($choice -eq 'retry') {
    $ensure = Join-Path $hooksDir 'ensure-qdrant.ps1'
    $notify = $MyInvocation.MyCommand.Path
    if ((Test-Path $ensure) -and (Test-Path $notify)) {
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        $chain = "& `"$ensure`"; Start-Sleep -Seconds 1; & `"$notify`" -SuccessOnRetry"
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass',
            '-Command', $chain
        ) -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    }
}

exit 0
