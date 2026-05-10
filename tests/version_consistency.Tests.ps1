# Pester tests — ULTRON version consistency across all doc files
# Run: Invoke-Pester tests/version_consistency.Tests.ps1

$SkillRoot = Split-Path $PSScriptRoot -Parent
$ModeFiles = Get-ChildItem -Path $SkillRoot -Filter "mode-*.md" | Select-Object -ExpandProperty FullName
$SkillMd   = Join-Path $SkillRoot "SKILL.md"
$ClaudeMd  = Join-Path $SkillRoot "CLAUDE.md"

Describe "ULTRON version consistency" {

    It "all mode-*.md files exist (5 expected)" {
        $ModeFiles.Count | Should Be 5
    }

    It "all mode-*.md files share the same version string" {
        $versions = $ModeFiles | ForEach-Object {
            $first = Get-Content $_ | Select-Object -First 1
            if ($first -match 'v(\d+\.\d+\.\d+)') { $matches[1] } else { "MISSING:$_" }
        }
        $unique = $versions | Select-Object -Unique
        $unique.Count | Should Be 1
    }

    It "all mode-*.md files reference the AWAKENING codename" {
        foreach ($f in $ModeFiles) {
            $first = Get-Content $f | Select-Object -First 1
            $first | Should Match 'AWAKENING'
        }
    }

    It "SKILL.md references v12.0" {
        Get-Content -Raw $SkillMd | Should Match 'v12\.0'
    }

    It "CLAUDE.md references v12.0" {
        Get-Content -Raw $ClaudeMd | Should Match 'v12\.0'
    }

    It "SKILL.md and CLAUDE.md agree on the Brain Update codename" {
        $skill  = Get-Content -Raw $SkillMd
        $claude = Get-Content -Raw $ClaudeMd
        $skill  | Should Match 'Brain Update'
        $claude | Should Match 'Brain Update'
    }
}
