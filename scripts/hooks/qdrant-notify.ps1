param(
    [switch]$SuccessOnRetry
)

# qdrant-notify.ps1 - reads qdrant-health.json and shows a floating WinForm
# panel when Qdrant is not OK. Companion to ensure-qdrant.ps1 (v15.0.2).
#
# Why a WinForm and not a native Windows toast: BurntToast respects Windows
# notification settings. If USER has Focus Assist on or notifications
# globally disabled, toasts are swallowed silently. A WinForm is a regular
# top-most window — always visible.
#
# Triggered from session-init.ps1 after ensure-qdrant has finished, and from
# the panel's "Reintentar" button after a manual retry (with -SuccessOnRetry
# to surface a confirmation panel).
#
# Hard rule: never block, never throw, never produce visible errors. Failures
# fall back to alerts.jsonl and exit 0.

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

# --- Read current health state ---
if (-not (Test-Path $health)) {
    exit 0
}

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
    try {
        $state = Get-Content -Raw $stateFile | ConvertFrom-Json -ErrorAction Stop
    } catch { $state = $null }
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

# --- WinForm panel builder ---
function Show-UltronPanel {
    param(
        [string]$Title,
        [string]$Body,
        [bool]$ShowRetry = $true,
        [bool]$SuccessVariant = $false
    )

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
    } catch {
        Write-Alert -Severity 'warn' -Status $status -Msg "WinForms load failed: $($_.Exception.Message)"
        return $null
    }

    # Colors: ULTRON dark theme.
    $bgColor      = [System.Drawing.Color]::FromArgb(255, 22, 24, 32)
    $borderColor  = if ($SuccessVariant) {
                        [System.Drawing.Color]::FromArgb(255, 56, 178, 110)   # green
                    } else {
                        [System.Drawing.Color]::FromArgb(255, 232, 89, 89)    # red
                    }
    $titleColor   = [System.Drawing.Color]::FromArgb(255, 230, 232, 240)
    $bodyColor    = [System.Drawing.Color]::FromArgb(255, 168, 172, 184)
    $btnBg        = [System.Drawing.Color]::FromArgb(255, 38, 42, 54)
    $btnHover     = [System.Drawing.Color]::FromArgb(255, 56, 60, 76)
    $btnText      = [System.Drawing.Color]::FromArgb(255, 230, 232, 240)
    $accentBg     = [System.Drawing.Color]::FromArgb(255, 88, 110, 255)
    $accentHover  = [System.Drawing.Color]::FromArgb(255, 108, 130, 255)

    $form              = New-Object System.Windows.Forms.Form
    $form.Text         = 'ULTRON'
    $form.Size         = New-Object System.Drawing.Size(420, 170)
    $form.FormBorderStyle = 'None'
    $form.StartPosition   = 'Manual'
    $form.TopMost      = $true
    $form.ShowInTaskbar = $false
    $form.BackColor    = $bgColor
    $form.Padding      = New-Object System.Windows.Forms.Padding(2)

    # Position bottom-right of primary screen with a 24px margin.
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Location = New-Object System.Drawing.Point(
        ($screen.Right  - $form.Width  - 24),
        ($screen.Bottom - $form.Height - 24)
    )

    # Colored top border strip (signals severity).
    $strip          = New-Object System.Windows.Forms.Panel
    $strip.Height   = 3
    $strip.Dock     = 'Top'
    $strip.BackColor = $borderColor
    $form.Controls.Add($strip)

    # Title.
    $lblTitle             = New-Object System.Windows.Forms.Label
    $lblTitle.Text        = $Title
    $lblTitle.ForeColor   = $titleColor
    $lblTitle.Font        = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
    $lblTitle.Location    = New-Object System.Drawing.Point(18, 14)
    $lblTitle.Size        = New-Object System.Drawing.Size(360, 22)
    $lblTitle.BackColor   = [System.Drawing.Color]::Transparent
    $form.Controls.Add($lblTitle)

    # Body.
    $lblBody              = New-Object System.Windows.Forms.Label
    $lblBody.Text         = $Body
    $lblBody.ForeColor    = $bodyColor
    $lblBody.Font         = New-Object System.Drawing.Font('Segoe UI', 9)
    $lblBody.Location     = New-Object System.Drawing.Point(18, 40)
    $lblBody.Size         = New-Object System.Drawing.Size(384, 62)
    $lblBody.BackColor    = [System.Drawing.Color]::Transparent
    $form.Controls.Add($lblBody)

    # Close X (top-right).
    $btnClose             = New-Object System.Windows.Forms.Label
    $btnClose.Text        = '×'
    $btnClose.Font        = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $btnClose.ForeColor   = $bodyColor
    $btnClose.BackColor   = [System.Drawing.Color]::Transparent
    $btnClose.Size        = New-Object System.Drawing.Size(24, 24)
    $btnClose.Location    = New-Object System.Drawing.Point(388, 8)
    $btnClose.TextAlign   = 'MiddleCenter'
    $btnClose.Cursor      = [System.Windows.Forms.Cursors]::Hand
    $btnClose.Add_Click({ $form.Close() })
    $btnClose.Add_MouseEnter({ $btnClose.ForeColor = $titleColor })
    $btnClose.Add_MouseLeave({ $btnClose.ForeColor = $bodyColor })
    $form.Controls.Add($btnClose)

    # Buttons row.
    $btnY = 110

    if ($ShowRetry -and -not $SuccessVariant) {
        $btnRetry             = New-Object System.Windows.Forms.Button
        $btnRetry.Text        = 'Reintentar'
        $btnRetry.Size        = New-Object System.Drawing.Size(110, 32)
        $btnRetry.Location    = New-Object System.Drawing.Point(186, $btnY)
        $btnRetry.FlatStyle   = 'Flat'
        $btnRetry.BackColor   = $accentBg
        $btnRetry.ForeColor   = $titleColor
        $btnRetry.Font        = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)
        $btnRetry.FlatAppearance.BorderSize = 0
        $btnRetry.FlatAppearance.MouseOverBackColor = $accentHover
        $btnRetry.Cursor      = [System.Windows.Forms.Cursors]::Hand
        $btnRetry.Add_Click({
            $form.Tag = 'retry'
            $form.Close()
        })
        $form.Controls.Add($btnRetry)

        $btnSilence           = New-Object System.Windows.Forms.Button
        $btnSilence.Text      = 'Silenciar'
        $btnSilence.Size      = New-Object System.Drawing.Size(100, 32)
        $btnSilence.Location  = New-Object System.Drawing.Point(302, $btnY)
        $btnSilence.FlatStyle = 'Flat'
        $btnSilence.BackColor = $btnBg
        $btnSilence.ForeColor = $btnText
        $btnSilence.Font      = New-Object System.Drawing.Font('Segoe UI', 9)
        $btnSilence.FlatAppearance.BorderSize = 0
        $btnSilence.FlatAppearance.MouseOverBackColor = $btnHover
        $btnSilence.Cursor    = [System.Windows.Forms.Cursors]::Hand
        $btnSilence.Add_Click({
            $form.Tag = 'silence'
            $form.Close()
        })
        $form.Controls.Add($btnSilence)
    } elseif ($SuccessVariant) {
        $btnOk             = New-Object System.Windows.Forms.Button
        $btnOk.Text        = 'OK'
        $btnOk.Size        = New-Object System.Drawing.Size(90, 32)
        $btnOk.Location    = New-Object System.Drawing.Point(312, $btnY)
        $btnOk.FlatStyle   = 'Flat'
        $btnOk.BackColor   = $btnBg
        $btnOk.ForeColor   = $btnText
        $btnOk.Font        = New-Object System.Drawing.Font('Segoe UI', 9)
        $btnOk.FlatAppearance.BorderSize = 0
        $btnOk.FlatAppearance.MouseOverBackColor = $btnHover
        $btnOk.Cursor      = [System.Windows.Forms.Cursors]::Hand
        $btnOk.Add_Click({ $form.Close() })
        $form.Controls.Add($btnOk)
    }

    # Auto-close timer: 60s for failures, 6s for success.
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = if ($SuccessVariant) { 6000 } else { 60000 }
    $timer.Add_Tick({
        $timer.Stop()
        if ($form -and -not $form.IsDisposed) { $form.Close() }
    })
    $timer.Start()

    # Set icon if available.
    if (Test-Path $iconPath) {
        try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch { }
    }

    [void]$form.ShowDialog()
    $timer.Stop(); $timer.Dispose()

    return $form.Tag
}

# --- Success-on-retry branch ---
if ($SuccessOnRetry) {
    if ($status -eq 'up') {
        Show-UltronPanel -Title 'ULTRON · Qdrant up' `
                         -Body 'Recall semántico de vuelta. Todo OK.' `
                         -ShowRetry $false `
                         -SuccessVariant $true | Out-Null
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        exit 0
    }
    # Retry failed: fall through to normal failure panel.
}

# --- Status=up → silent ---
if ($status -eq 'up') {
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- Anti-spam check ---
if ($state -and $state.notified_status -eq $status) {
    exit 0
}

# --- Status → (title, body) mapping ---
$statusMap = @{
    'disk-missing'      = @{ Title = 'ULTRON · Qdrant offline';       Body = 'Drive D:\ no detectado. Conecta el USB o monta el disco y reintenta.' }
    'container-missing' = @{ Title = 'ULTRON · Qdrant setup';         Body = 'Contenedor ultron-qdrant no existe. Ejecuta ultron qdrant setup en una terminal.' }
    'daemon-down'       = @{ Title = 'ULTRON · Docker no responde';   Body = 'Docker daemon no arrancó. Comprueba Docker Desktop y reintenta.' }
    'unhealthy'         = @{ Title = 'ULTRON · Qdrant degradado';     Body = "Qdrant up pero healthz responde mal. $msg" }
    'unreachable'       = @{ Title = 'ULTRON · Qdrant inalcanzable';  Body = "Container up pero healthz no responde. $msg" }
}

if (-not $statusMap.ContainsKey($status)) {
    $cfg = @{ Title = 'ULTRON · Qdrant'; Body = "Estado inesperado: $status. $msg" }
} else {
    $cfg = $statusMap[$status]
}

# container-missing: no retry button (user must run setup command manually).
$showRetry = ($status -ne 'container-missing')

# Persist state BEFORE showing dialog (so even if user kills the process
# mid-dialog, anti-spam still kicks in next time).
Save-State -NotifiedStatus $status

$choice = Show-UltronPanel -Title $cfg.Title -Body $cfg.Body -ShowRetry $showRetry

if ($choice -eq 'retry') {
    $ensure = Join-Path $hooksDir 'ensure-qdrant.ps1'
    $notify = $MyInvocation.MyCommand.Path
    if ((Test-Path $ensure) -and (Test-Path $notify)) {
        # Clear state so the success path (or new failure) can fire.
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        $chain = "& `"$ensure`"; Start-Sleep -Seconds 1; & `"$notify`" -SuccessOnRetry"
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass',
            '-Command', $chain
        ) -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    }
}

exit 0
