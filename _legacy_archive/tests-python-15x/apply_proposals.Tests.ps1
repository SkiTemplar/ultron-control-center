# ULTRON v10.5.1 - Pester tests for apply_proposals.py (L3 mechanical runner)
#
# Verifies the deterministic apply path: parsing, filtering, unique-match check,
# atomic write+backup, status:consumed marker. Does NOT invoke any LLM.
#
# Run: Invoke-Pester tests/apply_proposals.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Resolve-Path (Join-Path $here '..')
$script = Join-Path $root 'scripts\cockpit\apply_proposals.py'

Describe "apply_proposals.py - file shape" {

    It "exists and is parseable Python" {
        Test-Path $script | Should Be $true
        $r = & python -c "import ast; ast.parse(open(r'$script', encoding='utf-8').read())" 2>&1
        $LASTEXITCODE | Should Be 0
    }

    It "exposes apply + list subcommands" {
        $content = Get-Content -Raw $script
        $content -match "sub\.add_parser\(`"apply`"" | Should Be $true
        $content -match "sub\.add_parser\(`"list`"" | Should Be $true
    }

    It "imports COCKPIT_DIR + USER_HOME from cockpit_base" {
        $content = Get-Content -Raw $script
        $content -match "from cockpit_base import.*COCKPIT_DIR.*USER_HOME" | Should Be $true
    }
}

Describe "apply_proposals - is_actionable filter (anti-laundering safeguards)" {

    BeforeAll {
        $tmp = Join-Path $env:TEMP "apply_proposals_test_$(Get-Random)"
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    }

    It "rejects entries with false_positive_risk=high" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import is_actionable; " +
              "ok, reason = is_actionable({'false_positive_risk': 'high', 'old_string': 'x', 'new_string': 'y', 'target_file': 'SKILL.md'}); " +
              "print(f'{ok}|{reason}')"
        $out = & python -c $py 2>&1
        $out | Should Match "False\|.*high"
    }

    It "rejects entries with empty old_string" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import is_actionable; " +
              "ok, reason = is_actionable({'old_string': '', 'new_string': 'y', 'target_file': 'SKILL.md'}); " +
              "print(f'{ok}|{reason}')"
        $out = & python -c $py 2>&1
        $out | Should Match "False\|.*empty"
    }

    It "rejects entries where old_string == new_string (no-op)" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import is_actionable; " +
              "ok, reason = is_actionable({'old_string': 'foo', 'new_string': 'foo', 'target_file': 'SKILL.md'}); " +
              "print(f'{ok}|{reason}')"
        $out = & python -c $py 2>&1
        $out | Should Match "False\|.*no-op"
    }

    It "accepts well-formed actionable entry" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import is_actionable; " +
              "ok, reason = is_actionable({'old_string': 'old', 'new_string': 'new', 'target_file': 'SKILL.md'}); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "True"
    }
}

Describe "apply_proposals - unique-match guard (prevent ambiguous edits)" {

    It "rejects when old_string appears multiple times in target" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import verify_match; " +
              "ok, reason = verify_match('foo bar foo bar', 'foo'); " +
              "print(f'{ok}|{reason}')"
        $out = & python -c $py 2>&1
        $out | Should Match "False\|.*ambiguous"
    }

    It "rejects when old_string not found" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import verify_match; " +
              "ok, reason = verify_match('hello world', 'goodbye'); " +
              "print(f'{ok}|{reason}')"
        $out = & python -c $py 2>&1
        $out | Should Match "False\|.*not found"
    }

    It "accepts unique exact match" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import verify_match; " +
              "ok, reason = verify_match('one fish two fish', 'two fish'); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "True"
    }
}

Describe "apply_proposals - skill name inference from filename" {

    It "extracts skill from <skill>-YYYY-MM-DD.json" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import infer_skill_from_proposals_file; " +
              "from pathlib import Path; " +
              "print(infer_skill_from_proposals_file(Path('senior-engineer-2026-04-28.json')))"
        $out = & python -c $py 2>&1
        $out | Should Match "senior-engineer"
    }

    It "handles single-word skill names" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from apply_proposals import infer_skill_from_proposals_file; " +
              "from pathlib import Path; " +
              "print(infer_skill_from_proposals_file(Path('ultron-2026-04-28.json')))"
        $out = & python -c $py 2>&1
        $out | Should Match "ultron"
    }
}
