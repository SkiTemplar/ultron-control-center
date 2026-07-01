' qdrant-hidden-launch.vbs - launch Qdrant with NO visible console window.
'
' Why this exists: a scheduled-task or shortcut action that runs the qdrant.exe
' console binary DIRECTLY allocates a console window (conhost) in the interactive
' session, which shows up as a taskbar entry. wscript.exe is itself windowless,
' and Shell.Run with intWindowStyle = 0 (vbHide) launches the child fully hidden,
' so Qdrant keeps serving :6333 without ever drawing a window. Same technique as
' qdrant-bootcheck-hidden.vbs, but as a generic, parameterised launcher.
'
' Repo-safe: NO hardcoded machine paths. Resolves the binary in this order:
'   1) args:    wscript qdrant-hidden-launch.vbs "<qdrant.exe>" "<config.yaml>"
'   2) env:     ULTRON_QDRANT_EXE  (config optional)
'   3) default: %USERPROFILE%\.ultron\qdrant-native\qdrant.exe
'
' Args (all optional): 0 = full path to qdrant.exe, 1 = full path to config file.
' ASCII only (no em-dash / smart quotes) for maximum compatibility.

Option Explicit

Dim sh, fso, exe, cfg, dir, cmd, home

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
home = sh.ExpandEnvironmentStrings("%USERPROFILE%")

' --- resolve qdrant.exe ---
If WScript.Arguments.Count >= 1 And Len(WScript.Arguments(0)) > 0 Then
    exe = WScript.Arguments(0)
Else
    exe = sh.ExpandEnvironmentStrings("%ULTRON_QDRANT_EXE%")
    If exe = "%ULTRON_QDRANT_EXE%" Or Len(exe) = 0 Then
        exe = home & "\.ultron\qdrant-native\qdrant.exe"
    End If
End If

' --- resolve config (optional) ---
If WScript.Arguments.Count >= 2 And Len(WScript.Arguments(1)) > 0 Then
    cfg = WScript.Arguments(1)
Else
    cfg = ""
End If

' --- working dir = folder of the exe (so relative storage paths resolve) ---
If fso.FileExists(exe) Then
    dir = fso.GetParentFolderName(exe)
    If Len(dir) > 0 Then sh.CurrentDirectory = dir
End If

' --- build command line ---
cmd = """" & exe & """"
If Len(cfg) > 0 Then
    cmd = cmd & " --config-path """ & cfg & """"
End If

' window-style 0 = vbHide, wait-on-return = False (fire-and-forget). No console ever.
sh.Run cmd, 0, False
