<#
.SYNOPSIS
  ULTRON visual installer wizard (WinForms checkboxes).

.DESCRIPTION
  Renders a single modal window listing every install step as a checkbox,
  grouped into Core / Memory / Claude Code / Optional UI / Optional Features.
  The user toggles what they want, hits Install, and we return a hashtable
  of selections to install.ps1, which then enables/disables steps accordingly.

  Why WinForms and not a browser-based wizard?
    - Zero new dependencies (System.Windows.Forms ships with .NET Framework,
      which PowerShell 5.1 / 7 on Windows always have).
    - Same-process: the result hashtable is returned via the pipeline, no
      HTTP roundtrip, no port collisions, no firewall prompts.
    - Failure modes are simpler: if Add-Type explodes (PS Server Core, locked
      down environment), the caller can fall back to the CLI prompts that
      install.ps1 always had.

  This script is INVOKED by install.ps1 and never run directly by users
  (though it works fine standalone for testing the UI - see -DryRun).

.PARAMETER PreviousProfile
  Hashtable with the user's previous answers (read from
  ~/.ultron/cockpit/install-profile.json). Used to pre-check boxes on
  re-runs so the user does not lose state.

.PARAMETER DryRun
  Open the window, print the selection hashtable, and exit without
  returning it. Useful when iterating on the UI.

.OUTPUTS
  Hashtable - one key per checkbox id. Empty hashtable means "user
  cancelled" - the caller MUST treat that as abort, not as "install
  nothing".

.NOTES
  Layout philosophy:
    - 720x720 fixed (DPI-aware, but no resize - too much fiddly relayout).
    - Header band with ULTRON wordmark + version (passed in).
    - Five GroupBoxes vertically. Each contains 1-N CheckBoxes with a
      one-line description label underneath.
    - Footer: Install (primary) / Cancel buttons + status bar.
    - Core (required) checkboxes are disabled (greyed) but pre-checked,
      so the user can SEE what is always installed without being able to
      uncheck it.
#>

[CmdletBinding()]
param(
    [hashtable]$PreviousProfile = @{},
    [string]$Version = "v15.3.4",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# Load WinForms. Fails fast on PS Server Core / non-Windows.
# ----------------------------------------------------------------------
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing      -ErrorAction Stop
} catch {
    Write-Error ("WinForms not available on this PowerShell host: " + $_.Exception.Message)
    return @{}
}

# Crisper rendering on high-DPI monitors. NoOp on 8.1 / older PS.
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }
try { [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false) } catch { }

# ----------------------------------------------------------------------
# Feature catalog - one entry per checkbox.
#
#   id       - stable key returned in the result hashtable (snake_case).
#   group    - which GroupBox this checkbox lives in.
#   label    - shown next to the checkbox.
#   note     - one-line gray description under the label.
#   default  - initial state if PreviousProfile has no value for this id.
#   required - true means the checkbox is disabled (always installed).
# ----------------------------------------------------------------------
$Catalog = @(
    # ---- Core (required, greyed out) ----------------------------------
    @{ id="core_git";        group="Core (required)";              label="Git";                       note="version control - winget Git.Git";                             default=$true;  required=$true  }
    @{ id="core_node";       group="Core (required)";              label="Node 22 LTS";               note="needed for Claude Code CLI - winget OpenJS.NodeJS.LTS";        default=$true;  required=$true  }
    @{ id="core_uv";         group="Core (required)";              label="uv (Python)";               note="fast Python pkg manager - astral.sh/uv";                       default=$true;  required=$true  }
    @{ id="core_claude";     group="Core (required)";              label="Claude Code CLI";           note="must be present - hard requirement, refuses to continue";      default=$true;  required=$true  }
    @{ id="core_layout";     group="Core (required)";              label="Directory layout";         note="creates ~/.ultron, ~/.ultron-vault, ~/.claude/skills";          default=$true;  required=$true  }

    # ---- Memory (recommended) -----------------------------------------
    @{ id="mem_qdrant";      group="Memory (recommended)";         label="Qdrant native";             note="semantic recall over vault - ~40 MB binary, no Docker";        default=$true;  required=$false }
    @{ id="mem_brain_index"; group="Memory (recommended)";         label="brain_index";               note="SQLite FTS5 keyword index - ~10 sec init";                     default=$true;  required=$false }
    @{ id="mem_vault";       group="Memory (recommended)";         label="Vault structure";           note="~/.ultron-vault folders for L2 memory";                        default=$true;  required=$false }

    # ---- Claude Code integration --------------------------------------
    @{ id="cc_hooks";        group="Claude Code integration";      label="Hooks";                     note="merge templates into ~/.claude/settings.json (SessionStart, Stop)"; default=$true;  required=$false }
    @{ id="cc_skills_core";  group="Claude Code integration";      label="Core skills";               note="superpowers, ultron, agent-skills - the always-on set";        default=$true;  required=$false }
    @{ id="cc_skills_extra"; group="Claude Code integration";      label="Personal skills";           note="optional personality skills (alfred, terry, pana, einstein...)"; default=$false; required=$false }
    @{ id="cc_skills_comm";  group="Claude Code integration";      label="Community skills";          note="clone curated skills from SkiTemplar/ultron-skills";           default=$false; required=$false }
    @{ id="cc_agents";       group="Claude Code integration";      label="Agents (24 pre-installed)"; note="copy agent manifests into ~/.claude/agents/";                  default=$true;  required=$false }

    # ---- Optional UI --------------------------------------------------
    @{ id="ui_npm";          group="Optional UI";                  label="Control Center deps (npm install)"; note="~150 MB, ~2 min - needed even if you skip the Tauri build"; default=$false; required=$false }
    @{ id="ui_tauri_build";  group="Optional UI";                  label="Tauri release build";       note="3-5 min Rust compile, produces installer.exe";                 default=$false; required=$false }

    # ---- Optional features --------------------------------------------
    @{ id="feat_news";       group="Optional features";            label="News digest";               note="Gemini-generated daily newsletter - costs tokens";             default=$false; required=$false }
    @{ id="feat_gaming";     group="Optional features";            label="Gaming utilities";          note="game detector + tweaks panel";                                 default=$false; required=$false }
    @{ id="feat_personal";   group="Optional features";            label="Personal section";         note="private profile slots in the cockpit";                          default=$true;  required=$false }
    @{ id="feat_schedules";  group="Optional features";            label="Schedules";                 note="Windows scheduled-task management";                            default=$false; required=$false }
    @{ id="feat_selfimp";    group="Optional features";            label="Self-improve";              note="route telemetry feeds the dispatcher tuner";                   default=$true;  required=$false }
)

# Merge defaults with previous profile (previous wins, except for required).
foreach ($item in $Catalog) {
    if ($item.required) { continue }
    if ($PreviousProfile.ContainsKey($item.id)) {
        $item.default = [bool]$PreviousProfile[$item.id]
    }
}

# ----------------------------------------------------------------------
# Colors and fonts. Match the cockpit dark theme.
# ----------------------------------------------------------------------
$ColorBg          = [System.Drawing.Color]::FromArgb(24, 26, 31)
$ColorPanel       = [System.Drawing.Color]::FromArgb(32, 35, 42)
$ColorFg          = [System.Drawing.Color]::FromArgb(220, 222, 226)
$ColorMuted       = [System.Drawing.Color]::FromArgb(140, 145, 155)
$ColorAccent      = [System.Drawing.Color]::FromArgb(120, 170, 255)
$ColorDanger      = [System.Drawing.Color]::FromArgb(232, 95, 95)

$FontHeader  = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$FontGroup   = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$FontItem    = New-Object System.Drawing.Font("Segoe UI", 9)
$FontNote    = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Italic)

# ----------------------------------------------------------------------
# Build the form.
# ----------------------------------------------------------------------
$form               = New-Object System.Windows.Forms.Form
$form.Text          = "ULTRON Installer"
$form.Size          = New-Object System.Drawing.Size(740, 760)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox   = $false
$form.MinimizeBox   = $true
$form.BackColor     = $ColorBg
$form.ForeColor     = $ColorFg
$form.Font          = $FontItem
$form.Topmost       = $false
$form.KeyPreview    = $true

# ---- Header banner ---------------------------------------------------
$header             = New-Object System.Windows.Forms.Panel
$header.Dock        = "Top"
$header.Height      = 58
$header.BackColor   = $ColorPanel
$form.Controls.Add($header)

$lblTitle           = New-Object System.Windows.Forms.Label
$lblTitle.Text      = "ULTRON Installer"
$lblTitle.Font      = $FontHeader
$lblTitle.ForeColor = $ColorAccent
$lblTitle.AutoSize  = $true
$lblTitle.Location  = New-Object System.Drawing.Point(20, 10)
$header.Controls.Add($lblTitle)

$lblSubtitle        = New-Object System.Windows.Forms.Label
$lblSubtitle.Text   = "Pick what to install - " + $Version + "   |   Re-running keeps your previous choices."
$lblSubtitle.Font   = $FontNote
$lblSubtitle.ForeColor = $ColorMuted
$lblSubtitle.AutoSize  = $true
$lblSubtitle.Location  = New-Object System.Drawing.Point(22, 35)
$header.Controls.Add($lblSubtitle)

# ---- Scrollable body -------------------------------------------------
$body               = New-Object System.Windows.Forms.Panel
$body.Dock          = "Fill"
$body.AutoScroll    = $true
$body.BackColor     = $ColorBg
$body.Padding       = New-Object System.Windows.Forms.Padding(14)
$form.Controls.Add($body)
$body.BringToFront()

# ---- Footer ----------------------------------------------------------
$footer             = New-Object System.Windows.Forms.Panel
$footer.Dock        = "Bottom"
$footer.Height      = 60
$footer.BackColor   = $ColorPanel
$form.Controls.Add($footer)

$lblStatus          = New-Object System.Windows.Forms.Label
$lblStatus.Text     = "Ready."
$lblStatus.ForeColor = $ColorMuted
$lblStatus.AutoSize = $true
$lblStatus.Location = New-Object System.Drawing.Point(18, 22)
$footer.Controls.Add($lblStatus)

$btnCancel          = New-Object System.Windows.Forms.Button
$btnCancel.Text     = "Cancel"
$btnCancel.Size     = New-Object System.Drawing.Size(110, 32)
$btnCancel.Location = New-Object System.Drawing.Point(498, 14)
$btnCancel.BackColor = [System.Drawing.Color]::FromArgb(60, 64, 72)
$btnCancel.ForeColor = $ColorFg
$btnCancel.FlatStyle = "Flat"
$btnCancel.FlatAppearance.BorderColor = $ColorMuted
$footer.Controls.Add($btnCancel)

$btnInstall         = New-Object System.Windows.Forms.Button
$btnInstall.Text    = "Install"
$btnInstall.Size    = New-Object System.Drawing.Size(110, 32)
$btnInstall.Location = New-Object System.Drawing.Point(614, 14)
$btnInstall.BackColor = $ColorAccent
$btnInstall.ForeColor = [System.Drawing.Color]::Black
$btnInstall.FlatStyle = "Flat"
$btnInstall.Font    = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$footer.Controls.Add($btnInstall)

$form.AcceptButton = $btnInstall
$form.CancelButton = $btnCancel

# ----------------------------------------------------------------------
# Render groups + checkboxes.
#
# We build top-down by computing a running Y offset. Each group is a
# bordered panel (drawn as a Label header + a child Panel). Checkboxes
# inside use a 22 px row + 16 px note-line.
# ----------------------------------------------------------------------
$Checkboxes = @{}    # id -> CheckBox object
$y          = 8

$groups = $Catalog | ForEach-Object { $_.group } | Select-Object -Unique

foreach ($groupName in $groups) {
    # Group header label
    $lblGroup           = New-Object System.Windows.Forms.Label
    $lblGroup.Text      = $groupName
    $lblGroup.Font      = $FontGroup
    $lblGroup.ForeColor = $ColorAccent
    $lblGroup.AutoSize  = $true
    $lblGroup.Location  = New-Object System.Drawing.Point(10, $y)
    $body.Controls.Add($lblGroup)
    $y += 24

    # Thin separator line
    $sep            = New-Object System.Windows.Forms.Label
    $sep.Text       = ""
    $sep.BorderStyle = "Fixed3D"
    $sep.Height     = 2
    $sep.Width      = 660
    $sep.Location   = New-Object System.Drawing.Point(10, $y)
    $body.Controls.Add($sep)
    $y += 8

    $items = $Catalog | Where-Object { $_.group -eq $groupName }
    foreach ($item in $items) {
        $cb              = New-Object System.Windows.Forms.CheckBox
        $cb.Text         = $item.label
        $cb.Font         = $FontItem
        $cb.ForeColor    = $ColorFg
        $cb.BackColor    = $ColorBg
        $cb.AutoSize     = $true
        $cb.Checked      = [bool]$item.default
        $cb.Location     = New-Object System.Drawing.Point(20, $y)
        if ($item.required) {
            $cb.Enabled  = $false
            $cb.ForeColor = $ColorMuted
        }
        # Stash the id on the control so the result-collector can find it.
        $cb.Tag          = $item.id
        $body.Controls.Add($cb)
        $Checkboxes[$item.id] = $cb
        $y += 21

        # Note line
        $note            = New-Object System.Windows.Forms.Label
        $note.Text       = "  " + $item.note
        $note.Font       = $FontNote
        $note.ForeColor  = $ColorMuted
        $note.AutoSize   = $true
        $note.Location   = New-Object System.Drawing.Point(36, $y)
        $body.Controls.Add($note)
        $y += 19
    }

    $y += 10
}

# ----------------------------------------------------------------------
# Live cost / time hint. Tauri build + npm install dominate.
# ----------------------------------------------------------------------
function Update-Status {
    $minutes = 1   # baseline (dir layout + brain_index)
    if ($Checkboxes["mem_qdrant"].Checked)      { $minutes += 1 }
    if ($Checkboxes["cc_skills_comm"].Checked)  { $minutes += 1 }
    if ($Checkboxes["ui_npm"].Checked)          { $minutes += 2 }
    if ($Checkboxes["ui_tauri_build"].Checked)  { $minutes += 4 }
    if ($Checkboxes["feat_news"].Checked)       { $minutes += 1 }   # initial digest fetch
    $lblStatus.Text = ("Estimated time: ~" + $minutes + " min")
}

foreach ($cb in $Checkboxes.Values) {
    $cb.Add_CheckedChanged({ Update-Status })
}
Update-Status

# ----------------------------------------------------------------------
# Button handlers.
#
# We use DialogResult on the form to drive the ShowDialog return value.
# - Install => DialogResult.OK   => return the selection hashtable.
# - Cancel  => DialogResult.Cancel => return @{} (caller treats as abort).
# ----------------------------------------------------------------------
$btnInstall.Add_Click({
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
}.GetNewClosure())

$btnCancel.Add_Click({
    $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Close()
}.GetNewClosure())

# Esc cancels, even when the focus is on a checkbox.
$form.Add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Close()
    }
}.GetNewClosure())

# ----------------------------------------------------------------------
# Show the dialog and harvest the selection.
# ----------------------------------------------------------------------
$dlgResult = $form.ShowDialog()

if ($dlgResult -ne [System.Windows.Forms.DialogResult]::OK) {
    if ($DryRun) { Write-Host "(dry-run: user cancelled)" }
    return @{}
}

$selections = @{}
foreach ($id in $Checkboxes.Keys) {
    $selections[$id] = [bool]$Checkboxes[$id].Checked
}
# Stamp who/when for the persisted profile.
$selections["_version"]   = $Version
$selections["_timestamp"] = (Get-Date).ToString("o")

if ($DryRun) {
    Write-Host "(dry-run) selections:"
    $selections.GetEnumerator() | Sort-Object Name | ForEach-Object {
        Write-Host ("  " + $_.Name.PadRight(20) + " = " + $_.Value)
    }
    return @{}
}

return $selections
