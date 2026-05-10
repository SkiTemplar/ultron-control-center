# Pester tests for scripts/shared-duet.ps1
# Run from repo root: Invoke-Pester tests/shared-duet.Tests.ps1

$ScriptPath = Join-Path $PSScriptRoot '..\scripts\shared-duet.ps1'
$content    = Get-Content -Raw $ScriptPath -ErrorAction SilentlyContinue

Describe "shared-duet helper - file and parameter shape" {
    It "exists and is parseable PowerShell" {
        $ScriptPath | Should Exist
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$null)
        $ast | Should Not BeNullOrEmpty
    }

    It "accepts Peers: codex/gemini/both" {
        $content | Should Match "'codex','gemini','both'"
    }

    It "accepts Mode: Mini/Dual/Max/Triple" {
        $content | Should Match "ValidateSet.*Mini.*Dual.*Max.*Triple"
    }

    It "exposes BypassCaps switch" {
        $content | Should Match '\[switch\]\$BypassCaps'
    }

    It "exposes OutputDir with TEMP default" {
        $content | Should Match '\$env:TEMP'
    }
}

Describe "shared-duet helper - Triple normalization" {
    It "normalizes -Mode Triple to Mode=Max + Peers=both" {
        $content | Should Match "if \(\`$Mode -eq 'Triple'\)"
        $content | Should Match "\`$Mode\s+=\s+'Max'"
        $content | Should Match "\`$Peers\s+=\s+'both'"
    }

    It "documentation shows -Mode Triple as preferred Triple alias" {
        $content | Should Match '-Mode Triple'
    }
}

Describe "shared-duet helper - Codex resume extraction (bug fix)" {
    It "reads LogFile directly for resume rounds (not just ErrFile extraction)" {
        $content | Should Match 'Get-Content -Raw \$job\.LogFile'
    }

    It "does NOT break extraction at blank lines (multi-paragraph support)" {
        # Old buggy pattern: break at blank line if buf.Count -gt 0
        $content | Should Not Match "match '\\^\\\\s\*\$'.*buf\.Count"
    }

    It "still falls back to ErrFile extraction when LogFile is empty" {
        $content | Should Match 'ErrFile'
        $content | Should Match '\$found\s*=\s*\$false'
    }

    It "ErrFile fallback breaks at terminal markers not blank lines" {
        $content | Should Match 'tokens used\|--------\|user\|assistant'
    }
}

Describe "shared-duet helper - Gemini flags (bug fix)" {
    It "uses -p flag for headless mode (not --prompt=  with spaces)" {
        $content | Should Match '\-p `"`"'
    }

    It "uses --output-format json (not -o json shorthand)" {
        $content | Should Match '--output-format json'
    }

    It "uses --resume latest for round 2+ (not UUID-based -r flag)" {
        $content | Should Match '--resume latest'
    }

    It "does NOT pass UUID session ID to Gemini -r flag" {
        # Old bug: -r "$($sids.gemini)" passed UUID which Gemini doesn't accept
        $content | Should Not Match '-r.*sids\.gemini'
    }
}

Describe "shared-duet helper - usage tracking" {
    It "tracks usage counter for Round=1 non-Mini" {
        $content | Should Match 'Enforce-Cap'
    }

    It "skips cap check when -BypassCaps is set" {
        $content | Should Match '-not \$BypassCaps'
    }

    It "Cap limit is a single soft cap (raised to 20, 2026-05-05)" {
        $content | Should Match 'capLimit\s*=\s*20'
    }
}

Describe "shared-duet helper - hidden process architecture" {
    It "uses CreateNoWindow for hidden execution" {
        $content | Should Match 'CreateNoWindow\s*=\s*\$true'
    }

    It "writes UTF-8 without BOM for prompt file" {
        # [System.Text.UTF8Encoding] false = no BOM -- Spanish locale fix
        $content | Should Match 'UTF8Encoding.*\$false'
    }

    It "uses ASCII for .cmd launcher files (no encoding issues)" {
        $content | Should Match 'Encoding.*ASCII'
    }

    It "uses [^'] type-accelerator workaround for session_id regex" {
        $content | Should Match '\[char\]91.*\[char\]93'
    }
}

Describe "shared-duet helper - output structure" {
    It "emits combined JSON with round/mode/peers/elapsed_s" {
        $content | Should Match 'round\s*='
        $content | Should Match 'mode\s*='
        $content | Should Match 'peers\s*='
        $content | Should Match 'elapsed_s\s*='
    }

    It "includes session_ids block in output" {
        $content | Should Match 'session_ids'
    }

    It "outputs last line as compressed JSON" {
        $content | Should Match 'ConvertTo-Json -Depth 10 -Compress'
    }
}
