' qdrant-bootcheck-hidden.vbs - launches the ensure-qdrant + qdrant-notify
' chain with PowerShell window FULLY hidden (no flash, no flicker).
'
' Why this exists: the Windows scheduled task action "powershell.exe -Hidden"
' still flashes a console window for a few hundred ms on logon and on every
' run-now, which interrupts fullscreen games. The Windows Script Host
' (wscript.exe) is itself windowless, and its Shell.Run can launch child
' processes with vbHide (0), which prevents the console from ever appearing.
'
' Args: none. Hardcoded to the v15.0.2 hook chain. Idempotent.

Option Explicit

Dim objShell, userProfile, hooksDir, qdrantDir, ensure, notify, cmd, delaySec

Set objShell = CreateObject("WScript.Shell")
userProfile = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
' v15.5.15: ensure-qdrant relocated to qdrant/ (fix for incomplete v15.5.14 move).
' All three callers (session-init, vbs, install-bootcheck) now use qdrant/.
hooksDir    = userProfile & "\.ultron\scripts\hooks"
qdrantDir   = userProfile & "\.ultron\scripts\qdrant"
ensure      = qdrantDir & "\ensure-qdrant.ps1"
notify      = qdrantDir & "\qdrant-notify.ps1"
delaySec    = 12   ' let Docker Desktop autostart settle

cmd = "powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -Command " & _
      """Start-Sleep -Seconds " & delaySec & "; " & _
      "& '" & ensure & "'; " & _
      "Start-Sleep -Seconds 1; " & _
      "& '" & notify & "'"""

' Run with: window-style = 0 (vbHide), wait-on-return = False (fire-and-forget).
' This is the key combination that prevents *any* console flash.
objShell.Run cmd, 0, False
