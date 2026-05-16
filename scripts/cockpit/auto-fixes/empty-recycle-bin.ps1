# auto-fixes/empty-recycle-bin.ps1
# Empties the Windows Recycle Bin (all drives).
#
# The UI already collected the user's explicit consent in the modal —
# we still pass -Force to skip the native confirmation prompt because
# Clear-RecycleBin in -NonInteractive sessions would otherwise hang.

$ErrorActionPreference = "Stop"
$ok = $false
$err = $null

try {
    Clear-RecycleBin -Force -ErrorAction Stop
    $ok = $true
} catch {
    $err = $_.Exception.Message
}

$summary = [pscustomobject]@{
    fix     = "empty-recycle-bin"
    success = $ok
    error   = $err
}
$summary | ConvertTo-Json -Compress
