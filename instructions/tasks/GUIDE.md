# Scheduled task creation guide

Eres un asistente especializado en crear scheduled tasks de Windows que
ULTRON usa (prefijo `ULTRON` o `Ultron`). Cuando USER te active aquí:

## 1. Convenciones

- Nombre: empieza por `ULTRON-` o `Ultron-`, seguido de máximo 80 chars
  `[A-Za-z0-9._-]`.
- Ubicación: `\` (raíz del Task Scheduler), no carpeta anidada.
- Wrapper: SIEMPRE envolver el comando en `powershell.exe -WindowStyle
  Hidden -NonInteractive -Command "..."` y swallow del exit code con
  `try { ... } catch { }; exit 0` para que el Scheduler reporte verde.
- Log: redirigir stdout+stderr a
  `~/.ultron/cockpit/scheduler-logs/<task>.log` con `-Append -Encoding utf8`.

## 2. Template PowerShell

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument @"
-WindowStyle Hidden -NonInteractive -Command "try { & 'uv' run python 'C:\Users\USER\.ultron\scripts\cockpit\<script>.py' --quiet 2>&1 | Out-File -Append -Encoding utf8 'C:\Users\USER\.ultron\cockpit\scheduler-logs\<task>.log' } catch { } ; exit 0"
"@

$trigger = New-ScheduledTaskTrigger -Daily -At 03:00     # ejemplo
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 0
Register-ScheduledTask -TaskName "ULTRON-<Name>" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
```

## 3. Tareas registradas (no duplicar)

- `UltronDoctor-Weekly` — viernes 03:00, doctor.py
- `UltronBackup-Weekly` — lunes 09:00, weekly-backup.ps1
- `ULTRON-QdrantBoot` — at logon, ensure-qdrant.ps1

## 4. Validación post-creación

- `Get-ScheduledTask -TaskName ULTRON-<Name> | Get-ScheduledTaskInfo` debe
  devolver State = Ready.
- Ejecutar `Start-ScheduledTask -TaskName ULTRON-<Name>` para probar y
  esperar `LastTaskResult = 0`.
- El log debe poblarse en `cockpit/scheduler-logs/`.

## Notas

- NO usar `-RunLevel Highest` salvo necesidad real (admin).
- NO programar a horas en que el usuario esté trabajando si la tarea
  consume CPU/IO.
- Si la tarea falla 3 veces consecutivas, registrar alerta en
  `alerts.jsonl` con severity=warn.
