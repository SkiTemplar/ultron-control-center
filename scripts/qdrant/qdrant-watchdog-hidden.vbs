' qdrant-watchdog-hidden.vbs - lanza qdrant-watchdog.ps1 con la ventana
' TOTALMENTE oculta (vbHide). Mismo patron que qdrant-bootcheck-hidden.vbs:
' "powershell -WindowStyle Hidden" desde el task scheduler sigue flasheando
' una consola ~300ms; wscript.exe es windowless y Shell.Run con 0 no.
'
' Accion de la tarea ULTRON-QdrantWatchdog (cada ~5 min). Sin args.

Option Explicit

Dim objShell, userProfile, watchdog, cmd

Set objShell = CreateObject("WScript.Shell")
userProfile = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
watchdog    = userProfile & "\.ultron\scripts\qdrant\qdrant-watchdog.ps1"

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & watchdog & """"

' vbHide (0) + no esperar (False): cero flash, el watchdog loguea su resultado.
objShell.Run cmd, 0, False
