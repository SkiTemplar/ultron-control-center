# Pester 3.x smoke tests for ~/.ultron/scripts/hooks/stop-memory-sync.ps1 + session-init.ps1
#
# Coverage today (Sprint 1.5):
#   - Scripts parse without syntax errors
#   - Required job-wrap blocks present (Phase B compactor timeout, push-queue, pending prime)
#   - Debounce mechanism present (Phase A guard)
# Future (Sprint 3 OPS-01):
#   - End-to-end execution under simulated transcript fixtures
#   - Concurrent Stop scenarios (race detection)
#   - Phase A parallelization

$stopHook = Join-Path $env:USERPROFILE '.ultron\scripts\hooks\stop-memory-sync.ps1'
$initHook = Join-Path $env:USERPROFILE '.ultron\scripts\hooks\session-init.ps1'
$stopContent = Get-Content -Raw $stopHook -ErrorAction SilentlyContinue
$initContent = Get-Content -Raw $initHook -ErrorAction SilentlyContinue

Describe "stop-memory-sync.ps1" {
    It "exists at expected path" {
        $stopHook | Should Exist
    }

    It "parses without syntax errors" {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseInput(
            $stopContent, [ref]$null, [ref]$errs
        ) | Out-Null
        $errs | Should BeNullOrEmpty
    }

    It "wraps session_compactor in Start-Job (Sprint 1.3 H-CRIT-1 fix)" {
        $stopContent | Should Match "Start-Job.*ultron-compactor"
    }

    It "applies 60s timeout to compactor job" {
        $stopContent | Should Match "Wait-Job.*-Timeout 60"
    }

    It "has debounce guard (last-stop-sync.json)" {
        $stopContent | Should Match "last-stop-sync\.json"
    }

    It "always exits 0 (never blocks Stop event)" {
        $stopContent | Should Match "exit 0"
    }

    It "reads CC session_id from stdin when available" {
        $stopContent | Should Match "stdinSessionId"
    }
}

Describe "session-init.ps1" {
    It "exists at expected path" {
        $initHook | Should Exist
    }

    It "parses without syntax errors" {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseInput(
            $initContent, [ref]$null, [ref]$errs
        ) | Out-Null
        $errs | Should BeNullOrEmpty
    }

    It "wraps push-queue in Start-Job (Sprint 1.4 purity restore)" {
        $initContent | Should Match "ultron-push-queue"
    }

    It "applies 5s timeout to push-queue job" {
        $initContent | Should Match "Wait-Job -Job .pushJob -Timeout 5"
    }

    It "wraps pending_actions prime in Start-Job (Sprint 1.4)" {
        $initContent | Should Match "ultron-pending-prime"
    }

    It "applies 3s timeout to pending prime job" {
        $initContent | Should Match "Wait-Job -Job .pendJob -Timeout 3"
    }

    It "always exits 0" {
        $initContent | Should Match "exit 0"
    }
}
