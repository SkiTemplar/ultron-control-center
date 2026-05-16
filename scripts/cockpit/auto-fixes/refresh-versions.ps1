# auto-fixes/refresh-versions.ps1
# Sincroniza la versión de los 5 archivos clave con la canónica de
# CHANGELOG.md. Llamado desde el Doctor "Version drift" auto-fix.

$ErrorActionPreference = "Stop"
$report = [ordered]@{
    fix     = "refresh-versions"
    actions = @()
    success = $false
    error   = $null
}

try {
    $repo = Join-Path $HOME ".ultron"
    $claude = Join-Path $HOME ".claude"

    # 1. Parse canonical version from CHANGELOG.md
    $changelog = Join-Path $repo "CHANGELOG.md"
    if (-not (Test-Path -LiteralPath $changelog)) {
        throw "CHANGELOG.md not found at $changelog"
    }
    $canonical = $null
    foreach ($line in Get-Content -LiteralPath $changelog) {
        if ($line -match '^##\s+v?(\d+\.\d+\.\d+)\b') {
            $canonical = $Matches[1]
            break
        }
    }
    if (-not $canonical) { throw "Could not parse canonical version" }
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $report.actions += "canonical: v$canonical"

    # 2. Cargo.toml
    $cargo = Join-Path $repo "control-center\src-tauri\Cargo.toml"
    if (Test-Path -LiteralPath $cargo) {
        $t = Get-Content -LiteralPath $cargo -Raw
        $t2 = [regex]::Replace($t, '(?m)^version\s*=\s*"[^"]*"', "version = `"$canonical`"", 1)
        if ($t2 -ne $t) {
            Set-Content -LiteralPath $cargo -Value $t2 -Encoding UTF8 -NoNewline
            $report.actions += "Cargo.toml updated"
        }
    }

    # 3. package.json
    $pkg = Join-Path $repo "control-center\package.json"
    if (Test-Path -LiteralPath $pkg) {
        $t = Get-Content -LiteralPath $pkg -Raw
        $t2 = [regex]::Replace($t, '"version":\s*"[^"]*"', "`"version`": `"$canonical`"", 1)
        if ($t2 -ne $t) {
            Set-Content -LiteralPath $pkg -Value $t2 -Encoding UTF8 -NoNewline
            $report.actions += "package.json updated"
        }
    }

    # 4. tauri.conf.json
    $tc = Join-Path $repo "control-center\src-tauri\tauri.conf.json"
    if (Test-Path -LiteralPath $tc) {
        $t = Get-Content -LiteralPath $tc -Raw
        $t2 = [regex]::Replace($t, '"version":\s*"[^"]*"', "`"version`": `"$canonical`"", 1)
        if ($t2 -ne $t) {
            Set-Content -LiteralPath $tc -Value $t2 -Encoding UTF8 -NoNewline
            $report.actions += "tauri.conf.json updated"
        }
    }

    # 5. ULTRON skill frontmatter
    $skill = Join-Path $claude "skills\ultron\SKILL.md"
    if (Test-Path -LiteralPath $skill) {
        $t = Get-Content -LiteralPath $skill -Raw
        $t2 = [regex]::Replace($t, '(?m)^version:\s*v\d+\.\d+\.\d+\b', "version: v$canonical")
        $t2 = [regex]::Replace($t2, '(?m)^last_verified:\s*\d{4}-\d{2}-\d{2}', "last_verified: $today")
        if ($t2 -ne $t) {
            Set-Content -LiteralPath $skill -Value $t2 -Encoding UTF8 -NoNewline
            $report.actions += "ULTRON skill updated"
        }
    }

    # 6. SYSTEM-MAP.md SSOT line
    $sm = Join-Path $repo "SYSTEM-MAP.md"
    if (Test-Path -LiteralPath $sm) {
        $t = Get-Content -LiteralPath $sm -Raw
        $t2 = [regex]::Replace($t, 'SSOT version:\s*v?\d+\.\d+\.\d+\S*', "SSOT version: v$canonical")
        if ($t2 -ne $t) {
            Set-Content -LiteralPath $sm -Value $t2 -Encoding UTF8 -NoNewline
            $report.actions += "SYSTEM-MAP.md updated"
        }
    }

    $report.success = $true
} catch {
    $report.error = $_.Exception.Message
}

[pscustomobject]$report | ConvertTo-Json -Compress
