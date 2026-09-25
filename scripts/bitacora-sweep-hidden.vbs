' bitacora-sweep-hidden.vbs - lanza bitacora-sweep.mjs con la ventana
' TOTALMENTE oculta (vbHide). Mismo patron que qdrant-watchdog-hidden.vbs:
' "powershell -WindowStyle Hidden" desde el task scheduler sigue flasheando
' una consola ~300ms; wscript.exe es windowless y Shell.Run con 0 no.
'
' Accion de la tarea ULTRON-BitacoraSweep (cada ~15 min). Sin args.

Option Explicit

Dim objShell, userProfile, nodeExe, script, cmd

Set objShell = CreateObject("WScript.Shell")
userProfile = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
script = userProfile & "\.ultron\scripts\bitacora-sweep.mjs"

cmd = "node.exe """ & script & """"

' vbHide (0) + no esperar (False): cero flash, el sweep loguea su resultado
' en logs\session-summary.jsonl (trigger:"sweep").
objShell.Run cmd, 0, False
