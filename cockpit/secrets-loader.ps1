# ULTRON Secrets Loader — carga credenciales desde Windows Credential Manager
# a variables de entorno de la sesión. DPAPI-encrypted en disco, descifrado
# solo en memoria de tu proceso PowerShell.
#
# Instalación:
#   1. Asegúrate de que el PAT está en cmdkey:
#      cmdkey /generic:ULTRON_GITHUB_PAT /user:USER /pass:<PAT>
#   2. Añade al final de tu $PROFILE:
#      . "$env:USERPROFILE\.ultron\cockpit\secrets-loader.ps1"
#   3. Reinicia PowerShell. Verifica con:  $env:GITHUB_TOKEN.Substring(0,8)
#
# Uso single-shot (sin tocar $PROFILE):
#   . C:\Users\USER\.ultron\cockpit\secrets-loader.ps1

# P/Invoke a Win32 CredRead — sin dependencias de módulos externos
$cmType = [System.Management.Automation.PSTypeName]'Ultron.CredManApi'
if (-not $cmType.Type) {
    Add-Type -Namespace 'Ultron' -Name 'CredManApi' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
}
[DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);
[DllImport("advapi32.dll", SetLastError=true)]
public static extern void CredFree(IntPtr cred);
'@
}

function Get-UltronCredential {
    param([Parameter(Mandatory)][string]$Target)
    $ptr = [IntPtr]::Zero
    $ok = [Ultron.CredManApi]::CredRead($Target, 1, 0, [ref]$ptr)  # 1 = CRED_TYPE_GENERIC
    if (-not $ok -or $ptr -eq [IntPtr]::Zero) { return $null }
    try {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
            $ptr, [type][Ultron.CredManApi+CREDENTIAL])
        if ($cred.CredentialBlobSize -eq 0) { return $null }
        return [System.Runtime.InteropServices.Marshal]::PtrToStringUni(
            $cred.CredentialBlob, [int]($cred.CredentialBlobSize / 2))
    }
    finally {
        if ($ptr -ne [IntPtr]::Zero) { [Ultron.CredManApi]::CredFree($ptr) }
    }
}

# ---- Cargar PATs ULTRON a env vars de la sesión actual --------------------
$pat = Get-UltronCredential -Target 'ULTRON_GITHUB_PAT'
if ($pat) {
    # Mismo PAT bajo dos nombres porque settings.json (CC) y config.toml (Codex)
    # usan claves distintas.
    $env:GITHUB_TOKEN                 = $pat
    $env:GITHUB_PERSONAL_ACCESS_TOKEN = $pat
    Write-Host "[ultron-secrets] GITHUB_TOKEN cargado desde Credential Manager" -ForegroundColor DarkGreen
} else {
    Write-Warning "[ultron-secrets] ULTRON_GITHUB_PAT no encontrado en Credential Manager."
    Write-Warning "  Ejecuta: cmdkey /generic:ULTRON_GITHUB_PAT /user:USER /pass:<PAT>"
}

# Espacio para futuras credenciales:
# $env:OPENAI_API_KEY = Get-UltronCredential -Target 'ULTRON_OPENAI_KEY'
# $env:ANTHROPIC_API_KEY = Get-UltronCredential -Target 'ULTRON_ANTHROPIC_KEY'
