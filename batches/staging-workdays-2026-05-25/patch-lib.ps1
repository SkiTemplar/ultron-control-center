# Patch lib.rs: add `mod workdays;` and replace skeleton command with 15 full commands
param([string]$LibPath = "C:\Users\USER\.ultron\control-center\src-tauri\src\lib.rs")

$ErrorActionPreference = "Stop"
$content = Get-Content $LibPath -Raw

# 1. mod workdays; (idempotent)
if ($content -notmatch "(?m)^mod workdays;") {
    $content = $content -replace "(?m)^mod usage;", "mod usage;`r`nmod workdays;"
    Write-Host "OK lib.rs - mod workdays; added"
} else {
    Write-Host "SKIP lib.rs - mod workdays; already present"
}

# 2. Replace skeleton workday_list with full 15 commands (idempotent)
$old = @"
            // -- workdays (jornadas de trabajo, v2.5.3 skeleton) --
            commands::workdays::workday_list,
"@
$new = @"
            // -- workdays (jornadas de trabajo, v2.7 completo) --
            commands::workdays::create_workday,
            commands::workdays::start_workday,
            commands::workdays::pause_workday,
            commands::workdays::resume_workday,
            commands::workdays::complete_workday,
            commands::workdays::archive_workday,
            commands::workdays::list_workdays,
            commands::workdays::get_workday_detail,
            commands::workdays::link_session,
            commands::workdays::link_task,
            commands::workdays::get_workday_metrics,
            commands::workdays::list_templates,
            commands::workdays::save_template,
            commands::workdays::update_goal,
            commands::workdays::workday_list,
"@

if ($content.Contains($old)) {
    $content = $content.Replace($old, $new)
    Write-Host "OK lib.rs - 15 workday commands registered"
} elseif ($content.Contains("commands::workdays::create_workday")) {
    Write-Host "SKIP lib.rs - 15 workday commands already registered"
} else {
    Write-Host "WARN lib.rs - anchor not found; manual review needed"
    exit 1
}

Set-Content $LibPath $content -NoNewline
Write-Host "Done."
