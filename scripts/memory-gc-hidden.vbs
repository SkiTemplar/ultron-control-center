' memory-gc-hidden.vbs - lanza hooks\scripts\memory-gc.js --scheduled con la
' ventana TOTALMENTE oculta (vbHide). Mismo patron que bitacora-sweep-hidden.vbs.
'
' Accion de la tarea ULTRON-MemoryGC (scripts/install-memory-gc.ps1). El hook
' de SessionEnd no basta: Sessions cierra el Job Object del PTY al salir Claude
' y mata el gc a medias. La cadencia semanal y el backoff viven en el script,
' asi que lanzarlo cada pocas horas no repite trabajo. Sin args.

Option Explicit

Dim objShell, userProfile, script, cmd

Set objShell = CreateObject("WScript.Shell")
userProfile = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
script = userProfile & "\.ultron\hooks\scripts\memory-gc.js"

cmd = "node.exe """ & script & """ --scheduled"

' vbHide (0) + no esperar (False): el resultado queda en logs\memory-gc.jsonl
' (trigger:"scheduled") y en .tmp\memory-gc-last.json, que lee el doctor.
objShell.Run cmd, 0, False
