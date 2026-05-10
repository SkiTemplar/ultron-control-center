# sample fixture — sentinel block on a stub PowerShell case
"status" {
    Write-Host "live command"
}

# @ULTRON-DEPRECATED:14.0.0
#   reason: auth_vault.py removed in v12.5 cockpit reorg
#   replaced-by: Windows Credential Manager (cmdkey)
#   remove-after: 2099-01-01
#   owner: USER
"auth" {
    Write-Host "ultron auth: removed in v12.5" -ForegroundColor Yellow
    exit 1
}
# @ULTRON-DEPRECATED-END

"another" {
    Write-Host "still alive"
}
