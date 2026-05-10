# ULTRON v10.9.0 -- Shared-file dual/triple peer launcher
# Unified replacement for codex-duet.ps1 + gemini-duet.ps1.
#
# Architecture: writes cmd.exe launcher .cmd files per peer, starts them via
# ProcessStartInfo.CreateNoWindow=true -- no visible window, no taskbar entry.
# Peers invoked via PATH-resolved 'codex' / 'gemini' commands: no node.exe path
# resolution, no Win32 wrapper errors. stdin/stdout redirected inside the .cmd file.
#
# Usage (Dual -- Codex only):
#   shared-duet.ps1 -Peers codex -Mode Dual -Round 1 -Prompt "..."
# Usage (Triple -- both peers in parallel, preferred form):
#   shared-duet.ps1 -Peers both -Mode Triple -Round 1 -PromptFile prompt.txt
# Usage (Triple -- legacy form, identical behaviour):
#   shared-duet.ps1 -Peers both -Mode Max -Round 1 -PromptFile prompt.txt
# Usage (Round 2+ resume):
#   shared-duet.ps1 -Peers both -Mode Dual -Round 2 -Prompt "..." -SessionIds '{"codex":"abc","gemini":"xyz"}'

[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('codex','gemini','both')][string]$Peers,
    [Parameter(Mandatory)][ValidateSet('Mini','Dual','Max','Triple')][string]$Mode,
    [Parameter(Mandatory)][int]$Round,
    [string]$PromptFile,
    [string]$Prompt,
    [string]$PromptTemplate,
    [string]$TemplateVars,
    # JSON {"codex":"<session_id>","gemini":"<session_id>"} -- required for Round > 1
    [string]$SessionIds  = '{}',
    [string]$CodexModel  = 'gpt-5.5',
    # Gemini model alias (resolved to literal name before CLI invocation):
    #   'pro'        → gemini-3.1-pro-preview   (default — latest pro preview)
    #   'pro-3'      → gemini-3-pro-preview     (older 3.0, still valid)
    #   'pro-2.5'    → gemini-2.5-pro           (legacy stable, fallback if quota)
    #   'flash'      → gemini-3-flash-preview   (no 3.1 flash exists yet)
    #   'flash-2.5'  → gemini-2.5-flash         (legacy stable)
    #   'flash-lite' → gemini-2.5-flash-lite
    #   'auto'       → gemini-3.1-pro-preview   (router default)
    # Or pass a literal model name (gemini-3-*-preview / gemini-2.5-*) for full control.
    [string]$GeminiModel = 'pro',
    [string]$OutputDir   = (Join-Path $env:TEMP 'ultron-shared'),
    [int]$TimeoutSec     = 240,
    [switch]$BypassCaps,
    # v12 PoF (peer-output-to-file): if set, Gemini runs in auto-edit mode and
    # the prompt is augmented to instruct the model to write its JSON answer
    # directly to the output file (bypasses headless stdout, which fails for
    # gemini-3.1-* preview models that only work in interactive sessions).
    [switch]$PoF,
    # S2-C MMFP: if set, write the request as a YAML file to
    # ~/.ultron/multimodel/requests/<id>.yaml instead of invoking the peer inline.
    # Returns {"async":true,"request_id":"<id>","request_path":"<path>"} and exits 0.
    # When NOT set, behavior is IDENTICAL to the pre-S2-C implementation.
    [switch]$Async
)

$ErrorActionPreference = 'Stop'

# Normalize: -Mode Triple is a semantic alias for (-Mode Max -Peers both).
# Caps are always counted in triple-caps.json when Peers contains Gemini.
if ($Mode -eq 'Triple') {
    $Mode  = 'Max'
    $Peers = 'both'
}

$skillRoot  = Split-Path $PSScriptRoot -Parent
$schemaFile = Join-Path $skillRoot 'references\codex-duet-schema.json'

# ?? Usage counter (informational only — no hard block) ??????????????????
function Enforce-Cap {
    param([string]$CapsFile, [string]$Key, [int]$Limit, [string]$Label)
    $caps = if (Test-Path $CapsFile) {
        try { Get-Content -Raw $CapsFile | ConvertFrom-Json } catch { $null }
    } else { $null }
    if (-not $caps) {
        $caps = [pscustomobject]@{ mini = 0; dual = 0; triple = 0; max = 0 }
    }
    $current = [int]$caps.$Key
    if ($current -ge $Limit) {
        Write-Warning ("[SharedDuet] Info: $Label $Key = $current/$Limit today " +
                       "(soft reference - no block). Counter: $CapsFile")
    }
    $caps.$Key = $current + 1
    $caps | ConvertTo-Json -Compress | Set-Content -Path $CapsFile -Encoding utf8 -NoNewline
    Write-Host "[SharedDuet] Usage $Label/$Key`: $($caps.$Key) today"
}

# Codex H1 fix: do NOT count caps when -Async is used. Async only persists
# the request to disk; no peer is actually invoked here, so consuming a
# Dual/Triple/Max budget slot is incorrect. Also: Enforce-Cap writes
# "[SharedDuet] Usage ..." lines to Write-Host, which would pollute stdout
# before the JSON output expected from -Async mode. Suppressing both.
if ($Round -eq 1 -and $Mode -ne 'Mini' -and -not $BypassCaps -and -not $Async) {
    $today      = Get-Date -Format 'yyyy-MM-dd'
    $sessionDir = Join-Path $env:USERPROFILE ".ultron\sessions\$today"
    New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
    $capKey   = if ($Mode -eq 'Max') { 'max' } else { if ($Peers -in 'codex','both') { 'dual' } else { 'dual' } }
    # User-raised soft cap to 20 (2026-05-05). Caps are informational only —
    # never block, just emit a Write-Warning when exceeded. Higher cap allows
    # intensive multi-sprint review days without warning noise.
    $capLimit = 20
    if ($Peers -in 'codex','both') {
        Enforce-Cap -CapsFile (Join-Path $sessionDir 'dual-caps.json')   -Key $capKey   -Limit $capLimit -Label 'Codex'
    }
    if ($Peers -in 'gemini','both') {
        $gKey = if ($Mode -eq 'Max') { 'max' } else { 'triple' }
        Enforce-Cap -CapsFile (Join-Path $sessionDir 'triple-caps.json') -Key $gKey -Limit $capLimit -Label 'Gemini'
    }
}

# ?? Validate gating ???????????????????????????????????????????????????????????
if ($Mode -eq 'Mini' -and $Round -ne 1) {
    Write-Error "Mini mode is single-round (got Round=$Round)"; exit 4
}
$sids = try { $SessionIds | ConvertFrom-Json } catch { [pscustomobject]@{} }
if ($Round -gt 1) {
    if ($Peers -in 'codex','both' -and -not $sids.codex) {
        Write-Error "Round ${Round}: codex session_id required in -SessionIds"; exit 5
    }
    if ($Peers -in 'gemini','both' -and -not $sids.gemini) {
        Write-Error "Round ${Round}: gemini session_id required in -SessionIds"; exit 5
    }
}

# ?? Resolve prompt ?????????????????????????????????????????????????????????????
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$ts         = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$promptTmp  = Join-Path $OutputDir "prompt-r$Round-$ts.txt"

if ($PromptTemplate) {
    $tmplBase = Join-Path $PSScriptRoot '..\references\prompt-templates'
    $tmplPath = if ([System.IO.Path]::IsPathRooted($PromptTemplate)) {
        $PromptTemplate
    } else {
        Join-Path (Resolve-Path $tmplBase).Path $PromptTemplate
    }
    if (-not (Test-Path $tmplPath)) { Write-Error "Template not found: $tmplPath"; exit 2 }
    $promptText = Get-Content -Raw $tmplPath
    if ($TemplateVars) {
        $vars = $TemplateVars | ConvertFrom-Json
        foreach ($k in $vars.PSObject.Properties.Name) {
            $promptText = $promptText.Replace("{$k}", [string]$vars.$k)
        }
    }
} elseif ($PromptFile) {
    if (-not (Test-Path $PromptFile)) { Write-Error "Prompt file not found: $PromptFile"; exit 2 }
    $promptText = Get-Content -Raw $PromptFile
} elseif ($Prompt) {
    $promptText = $Prompt
} else {
    Write-Error "Provide -PromptTemplate, -PromptFile, or -Prompt"; exit 3
}
[System.IO.File]::WriteAllText($promptTmp, $promptText, (New-Object System.Text.UTF8Encoding $false))

# ?? MMFP Async path (S2-C) ????????????????????????????????????????????????????
# When -Async is set: write request YAML to ~/.ultron/multimodel/requests/<id>.yaml
# then exit 0 immediately. The inline peer invocation is SKIPPED entirely.
# When -Async is NOT set: fall through to the existing inline path (unchanged).
if ($Async) {
    # Generate unique ID: req-{yyyyMMdd-HHmmss-fff}-{hash8}
    $tsId     = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $sha1     = [System.Security.Cryptography.SHA1]::Create()
    $promptBytes = [System.Text.Encoding]::UTF8.GetBytes($promptText)
    $hashBytes   = $sha1.ComputeHash($promptBytes)
    $hash8    = ([BitConverter]::ToString($hashBytes) -replace '-','').ToLower().Substring(0, 8)
    $reqId    = "req-$tsId-$hash8"

    $mmfpDir  = Join-Path $env:USERPROFILE '.ultron\multimodel\requests'
    New-Item -ItemType Directory -Force -Path $mmfpDir | Out-Null
    $reqPath  = Join-Path $mmfpDir "$reqId.yaml"

    # Escape prompt text for YAML block scalar (indent each line 2 spaces)
    $promptLines  = $promptText -split "`n"
    $promptYaml   = ($promptLines | ForEach-Object { "  $_" }) -join "`n"

    # Serialize session_ids to YAML inline object
    $sidsObj      = try { $SessionIds | ConvertFrom-Json } catch { $null }
    $codexSid     = if ($sidsObj -and $sidsObj.codex)  { $sidsObj.codex }  else { '' }
    $geminiSid    = if ($sidsObj -and $sidsObj.gemini) { $sidsObj.gemini } else { '' }

    $promptFileLine = if ($PromptFile) { """$($PromptFile -replace '\\','/')""" } else { 'null' }

    $createdAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    $yaml = @"
# MMFP Request — generated by shared-duet.ps1 -Async
# Do not edit the id or created_at fields.
id: "$reqId"
created_at: "$createdAt"
peers: "$Peers"
mode: "$Mode"
rounds: $Round
prompt: |
$promptYaml
prompt_file: $promptFileLine
codex_model: "$CodexModel"
gemini_model: "$GeminiModel"
timeout_sec: $TimeoutSec
session_ids:
  codex: "$codexSid"
  gemini: "$geminiSid"
tags: []
metadata:
  source: "shared-duet --async"
  priority: "normal"
  session_id: ""
"@

    [System.IO.File]::WriteAllText($reqPath, $yaml, (New-Object System.Text.UTF8Encoding $false))

    $result = [pscustomobject]@{
        async        = $true
        request_id   = $reqId
        request_path = $reqPath
    }
    $result | ConvertTo-Json -Compress
    exit 0
}

# ?? Hidden process helpers ?????????????????????????????????????????????????????
function Write-Launcher {
    # Writes a .cmd file with the given command lines.
    # cmd.exe handles stdin/stdout redirects natively, no PowerShell pipe issues.
    param([string]$Path, [string[]]$Lines)
    $body = "@echo off`r`ncd /d `"$skillRoot`"`r`n" + ($Lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($Path, $body, [System.Text.Encoding]::ASCII)
}

function Start-Hidden {
    # CreateNoWindow=true + UseShellExecute=false: zero visible window, zero taskbar entry.
    # cmd.exe /c resolves PATH .cmd wrappers that Start-Process alone cannot find.
    param([string]$CmdFile)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = 'cmd.exe'
    $psi.Arguments        = "/c `"`"$CmdFile`"`""
    $psi.CreateNoWindow   = $true
    $psi.UseShellExecute  = $false
    $psi.WorkingDirectory = $skillRoot
    return [System.Diagnostics.Process]::Start($psi)
}

# ?? Build and launch peer jobs ?????????????????????????????????????????????????
$jobs      = @{}
$startTime = Get-Date

if ($Peers -in 'codex','both') {
    $cOut = Join-Path $OutputDir "codex-r$Round-$ts.json"
    $cLog = Join-Path $OutputDir "codex-r$Round-$ts.jsonl"
    $cErr = Join-Path $OutputDir "codex-r$Round-$ts.err.txt"
    $cCmd = Join-Path $OutputDir "codex-r$Round-$ts.cmd"

    $isResume = ($Round -gt 1 -and $Mode -ne 'Mini')
    if ($isResume) {
        $cLine = "codex exec resume -m $CodexModel `"$($sids.codex)`" - < `"$promptTmp`" > `"$cLog`" 2> `"$cErr`""
    } else {
        $cLine = "codex exec --sandbox read-only -m $CodexModel " +
                 "--output-schema `"$schemaFile`" -o `"$cOut`" --json " +
                 "--skip-git-repo-check --ignore-user-config - " +
                 "< `"$promptTmp`" > `"$cLog`" 2>> `"$cErr`""
    }
    Write-Launcher -Path $cCmd -Lines @($cLine)
    $jobs['codex'] = @{
        Proc     = Start-Hidden -CmdFile $cCmd
        OutFile  = $cOut;  LogFile = $cLog;  ErrFile = $cErr
        IsResume = $isResume
    }
    Write-Host "[SharedDuet] Codex launched hidden (Round=$Round Model=$CodexModel Resume=$isResume)"
}

if ($Peers -in 'gemini','both') {
    $gOut = Join-Path $OutputDir "gemini-r$Round-$ts.json"
    $gErr = Join-Path $OutputDir "gemini-r$Round-$ts.err.txt"
    $gCmd = Join-Path $OutputDir "gemini-r$Round-$ts.cmd"

    if ($PoF) {
        # PoF: Gemini writes its JSON answer DIRECTLY to $gOut via the write_file
        # tool. Required for preview models (gemini-3.1-*) where headless stdout
        # capture fails with "No capacity available". Auto-edit gives the model
        # filesystem write capability inside its workspace.
        $gPromptTmp = Join-Path $OutputDir "prompt-gemini-pof-r$Round-$ts.txt"
        $pofInstruction = @"


## OUTPUT INSTRUCTION (CRITICAL - PoF mode)
After your analysis, write your COMPLETE response (valid JSON, schema as defined above)
to this exact filesystem path using the write_file tool:

  $gOut

Do NOT print the JSON to stdout. Just write the file. The user is polling for it.
The output file MUST contain only the JSON object, nothing else, ready to parse.
"@
        $gPromptText = $promptText + $pofInstruction
        [System.IO.File]::WriteAllText($gPromptTmp, $gPromptText, (New-Object System.Text.UTF8Encoding $false))
        $resolvedGModel = switch ($GeminiModel) {
            { $_ -in @('pro','auto') } { 'gemini-3.1-pro-preview' }
            'pro-3'     { 'gemini-3-pro-preview' }
            'pro-2.5'   { 'gemini-2.5-pro' }
            'flash'     { 'gemini-3-flash-preview' }
            'flash-2.5' { 'gemini-2.5-flash' }
            'flash-lite'{ 'gemini-2.5-flash-lite' }
            default     { $GeminiModel }   # literal passthrough
        }
        $gFlags = "-p `"`" -m $resolvedGModel --approval-mode auto_edit --skip-trust"
        $gStdin = $gPromptTmp
    } else {
        # Default: headless stdout-redirect mode (works for stable models).
        # -p "" = headless; prompt comes via stdin.
        # Gemini --resume accepts "latest" or index (NOT UUID) -- Round 2+ uses "latest".
        $resolvedGModel = switch ($GeminiModel) {
            { $_ -in @('pro','auto') } { 'gemini-3.1-pro-preview' }
            'pro-3'     { 'gemini-3-pro-preview' }
            'pro-2.5'   { 'gemini-2.5-pro' }
            'flash'     { 'gemini-3-flash-preview' }
            'flash-2.5' { 'gemini-2.5-flash' }
            'flash-lite'{ 'gemini-2.5-flash-lite' }
            default     { $GeminiModel }
        }
        $gFlags = "-p `"`" -m $resolvedGModel --approval-mode plan --output-format json --skip-trust"
        $gStdin = $promptTmp
    }
    if ($Round -gt 1 -and $Mode -ne 'Mini') {
        $gFlags += " --resume latest"
    }
    if ($PoF) {
        # Stdout is irrelevant in PoF; redirect to a log file for diagnostics only.
        $gLog = Join-Path $OutputDir "gemini-r$Round-$ts.log.txt"
        $gLine = "gemini $gFlags < `"$gStdin`" > `"$gLog`" 2> `"$gErr`""
    } else {
        $gLine = "gemini $gFlags < `"$gStdin`" > `"$gOut`" 2> `"$gErr`""
    }
    Write-Launcher -Path $gCmd -Lines @($gLine)
    $jobs['gemini'] = @{
        Proc    = Start-Hidden -CmdFile $gCmd
        OutFile = $gOut;  ErrFile = $gErr;  PoF = [bool]$PoF
    }
    $modeLabel = if ($PoF) { 'PoF (auto-edit)' } else { 'plan' }
    Write-Host "[SharedDuet] Gemini launched hidden (Round=$Round Alias=$GeminiModel ResolvedModel=$resolvedGModel Mode=$modeLabel)"
}

# ?? Wait (parallel -- both run simultaneously) ??????????????????????????????????
$deadline = $startTime.AddSeconds($TimeoutSec)
foreach ($peer in $jobs.Keys) {
    $job = $jobs[$peer]
    $ms  = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
    if (-not $job.Proc.WaitForExit($ms)) {
        try { $job.Proc.Kill() } catch {}
        Write-Warning "[SharedDuet] $peer timed out after ${TimeoutSec}s -- killed"
        $job['TimedOut'] = $true
    }
    $job['ExitCode'] = try { $job.Proc.ExitCode } catch { -1 }
}

# ?? Parse Codex output ????????????????????????????????????????????????????????
$codexResult = $null
$newCodexSid = $null

if ($jobs.ContainsKey('codex')) {
    $job = $jobs['codex']

    # Resume rounds: stdout of `codex exec resume` IS the response -- read LogFile directly.
    # Fallback to ErrFile extraction only if stdout is empty (rare).
    if ($job.IsResume) {
        $extracted = $null
        if (Test-Path $job.LogFile) {
            $txt = (Get-Content -Raw $job.LogFile).Trim()
            if ($txt) { $extracted = $txt }
        }
        if (-not $extracted -and (Test-Path $job.ErrFile)) {
            # ErrFile extraction: collect all lines between "^codex$" and terminal markers.
            # Does NOT break at blank lines -- response body can be multi-paragraph.
            $lines = Get-Content $job.ErrFile
            $found = $false; $buf = @()
            foreach ($ln in $lines) {
                if ($found) {
                    if ($ln -match '^(tokens used|--------|user|assistant)\s*$') { break }
                    if ($ln -match '^\d{4}-\d{2}-\d{2}T.*ERROR')                { continue }
                    $buf += $ln
                } elseif ($ln -match '^codex\s*$') { $found = $true }
            }
            if ($buf.Count -gt 0) { $extracted = ($buf -join "`n").Trim() }
        }
        if ($extracted) {
            Set-Content -Path $job.OutFile -Value $extracted -Encoding utf8 -NoNewline
        }
    }

    if (Test-Path $job.OutFile) {
        $raw = Get-Content -Raw $job.OutFile
        if ($raw) {
            try   { $codexResult = $raw | ConvertFrom-Json }
            catch { Write-Warning "[SharedDuet] Codex output not valid JSON"
                    $codexResult = [pscustomobject]@{ raw_text = $raw } }
        }
    }
    if (-not $codexResult) {
        $errMsg = if (Test-Path $job.ErrFile) { (Get-Content $job.ErrFile -First 5) -join ' ' } else { '' }
        Write-Warning "[SharedDuet] Codex: no output. Exit=$($job.ExitCode) Err=$errMsg"
        $codexResult = [pscustomobject]@{ error = 'no_output'; exit_code = $job.ExitCode; stderr_preview = $errMsg }
    }

    # Extract new session_id from log (Round 1 only)
    if ($Round -eq 1 -and $Mode -ne 'Mini' -and (Test-Path $job.LogFile)) {
        $_notQ = [char]91 + '^"' + [char]93  # [^"] -- avoid PS5.1 type-accelerator parse bug
        $m = Select-String -Path $job.LogFile -Pattern ('"thread_id"\s*:\s*"(' + $_notQ + '+)"') | Select-Object -First 1
        if (-not $m) { $m = Select-String -Path $job.LogFile -Pattern ('"session_id"\s*:\s*"(' + $_notQ + '+)"') | Select-Object -First 1 }
        if ($m) {
            $newCodexSid = $m.Matches[0].Groups[1].Value
            Write-Host "CODEX_SESSION_ID=$newCodexSid"
            Set-Content (Join-Path $OutputDir 'last-codex-session-id.txt') -Value $newCodexSid -Encoding ascii -NoNewline
        } else {
            Write-Warning "[SharedDuet] Codex: no session_id in log -- Round 2+ resume unavailable"
        }
    }
}

# ?? Parse Gemini output ???????????????????????????????????????????????????????
$geminiResult = $null
$newGeminiSid = $null

if ($jobs.ContainsKey('gemini')) {
    $job = $jobs['gemini']

    if (Test-Path $job.OutFile) {
        $rawLines  = Get-Content $job.OutFile
        # Skip "Skill X overriding..." pollution lines before the JSON object
        $jsonStart = -1
        for ($i = 0; $i -lt $rawLines.Count; $i++) {
            if ($rawLines[$i] -match '^\s*\{') { $jsonStart = $i; break }
        }
        if ($jsonStart -ge 0) {
            $jsonTxt = ($rawLines[$jsonStart..($rawLines.Count - 1)]) -join "`n"
            try {
                $parsed   = $jsonTxt | ConvertFrom-Json
                $response = $parsed.response
                # PoF mode (and some plan-mode outputs): Gemini writes raw JSON directly
                # (no session_id/response wrapper). Detect by presence of 'verdict' field.
                if ($parsed.verdict -and -not $response) {
                    $geminiResult = $parsed
                } elseif ($response) {
                    # Wrapped response: strip markdown code fences Gemini sometimes adds.
                    # ([string][char]96) * 3 = ``` -- cast to string first; PS5.1 does not
                    # support [char] * [int] multiplication (returns null silently).
                    $_bt3   = ([string][char]96) * 3
                    $_rp1   = '^' + $_bt3 + 'json\s*'
                    $_rp2   = '^' + $_bt3 + '\s*'
                    $_rp3   = '\s*' + $_bt3 + '$'
                    $clean  = [regex]::Replace([regex]::Replace([regex]::Replace($response, $_rp1, ''), $_rp2, ''), $_rp3, '')
                    $clean = $clean.Trim()
                    try   { $geminiResult = $clean | ConvertFrom-Json }
                    catch { $geminiResult = [pscustomobject]@{ raw_text = $clean } }

                    if ($Round -eq 1 -and $Mode -ne 'Mini' -and $parsed.session_id) {
                        $newGeminiSid = $parsed.session_id
                        Write-Host "GEMINI_SESSION_ID=$newGeminiSid"
                        Set-Content (Join-Path $OutputDir 'last-gemini-session-id.txt') -Value $newGeminiSid -Encoding ascii -NoNewline
                    }
                }
            } catch { Write-Warning "[SharedDuet] Gemini JSON parse failed: $($_.Exception.Message)" }
        }
    }
    if (-not $geminiResult) {
        $errMsg = if (Test-Path $job.ErrFile) { (Get-Content $job.ErrFile -First 5) -join ' ' } else { '' }
        Write-Warning "[SharedDuet] Gemini: no output. Exit=$($job.ExitCode) Err=$errMsg"
        $geminiResult = [pscustomobject]@{ error = 'no_output'; exit_code = $job.ExitCode; stderr_preview = $errMsg }
    }
}

# ?? Combined output ???????????????????????????????????????????????????????????
$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
Write-Host "[SharedDuet] Mode=$Mode Round=$Round Peers=$Peers done in ${elapsed}s"

$out = [pscustomobject]@{
    round       = $Round
    mode        = $Mode
    peers       = $Peers
    elapsed_s   = $elapsed
    codex       = $codexResult
    gemini      = $geminiResult
    session_ids = [pscustomobject]@{
        codex  = if ($newCodexSid)  { $newCodexSid }  else { $sids.codex }
        gemini = if ($newGeminiSid) { $newGeminiSid } else { $sids.gemini }
    }
}

Write-Host "--- OUTPUT JSON ---"
$out | ConvertTo-Json -Depth 10 -Compress
