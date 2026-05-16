# Pester tests for scripts/cockpit/register_wake_triggers.ps1
# Run: Invoke-Pester tests/register-wake.Tests.ps1

$ScriptPath = Join-Path $PSScriptRoot '..\scripts\register_wake_triggers.ps1'
$content    = Get-Content -Raw $ScriptPath -ErrorAction SilentlyContinue

Describe "register_wake_triggers - file and parameters" {
    It "exists and is parseable PowerShell" {
        $ScriptPath | Should Exist
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$null)
        $ast | Should Not BeNullOrEmpty
    }

    It "exposes -DryRun switch" {
        $content | Should Match '\[switch\]\$DryRun'
    }

    It "exposes -Force switch" {
        $content | Should Match '\[switch\]\$Force'
    }
}

Describe "register_wake_triggers - null delay bug fix" {
    It "Get-LogonDelay null-guards the delay value before returning it" {
        # Fix: 'if ($t.Delay)' prevents returning null when task has no delay set.
        # This caused CimType deduction error on freshly registered tasks.
        $content | Should Match 'if \(\$t\.Delay\)'
    }

    It "fallback delay string is PT2M" {
        $content | Should Match "return 'PT2M'"
    }

    It "Add-WakeTriggersToTask loop is wrapped in try/catch" {
        $content | Should Match 'catch \{'
        $content | Should Match 'WARN.*wake trigger add failed'
    }
}

Describe "register_wake_triggers - trigger coverage" {
    It "adds SessionStateChange (screen unlock) trigger" {
        $content | Should Match 'MSFT_TaskSessionStateChangeTrigger'
        $content | Should Match 'StateChange\s*=.*8'   # TASK_SESSION_UNLOCK = 8
    }

    It "adds EventTrigger (power resume from sleep)" {
        $content | Should Match 'MSFT_TaskEventTrigger'
        $content | Should Match 'Kernel-Power'
    }

    It "UltronGithubTrending-Daily is in TARGET_TASKS" {
        $content | Should Match 'UltronGithubTrending-Daily'
    }

    It "registers 6 target tasks" {
        $matches = [regex]::Matches($content, "'Ultron\w+-(?:Daily|Weekday|Weekly)'")
        $matches.Count | Should BeGreaterThan 5
    }
}

Describe "register_wake_triggers - idempotency guards" {
    It "checks for existing SessionStateChange before adding" {
        $content | Should Match 'Has-TriggerOfClass'
        $content | Should Match 'hasUnlock'
    }

    It "checks for existing EventTrigger before adding" {
        $content | Should Match 'hasResume'
    }
}
