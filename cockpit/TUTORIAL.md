# ULTRON Cockpit v10.0 — Tutorial completo

> Cockpit = capa de Project Management que envuelve toda la infraestructura ULTRON.
> Pensado para USER: **un único comando `ultron` con 14 subcomandos** que cubre proyectos,
> auth, telemetría, dashboard, news, IDE launcher.

---

## 0. TL;DR — los 5 comandos más útiles

```powershell
ultron status              # Vista general de todo (dashboard en terminal)
ultron open <project>      # Lanzar proyecto en su IDE correcto + warm-start Claude
ultron auth list           # Ver cuentas Gmail/Drive/Supabase guardadas
ultron auth switch -Service gmail -ProfileName freelance   # Cambiar de cuenta
ultron schedule status     # Verificar que las 7 cron jobs están sanas
```

Si solo aprendes 5 comandos, que sean estos.

---

## 1. Setup inicial (una sola vez)

### Si todavía no tienes el alias

```powershell
# Verifica el path del profile
echo $PROFILE

# Añade el alias permanente
Add-Content -Path $PROFILE -Value "function ultron { & 'C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ultron.ps1' @args }"

# Carga el profile en la sesión actual (futuras se cargan solas)
. $PROFILE

# Verifica
ultron help
```

### Activar las 7 cron jobs (ejecutado una sola vez)

```powershell
# Instala las 7 tareas en Task Scheduler
ultron schedule install

# Verifica
ultron schedule status

# Ver/desinstalar cuando quieras
ultron schedule status
ultron schedule uninstall
```

**Las 7 cron jobs y cuándo corren:**

| Task | Cuándo |
|---|---|
| `UltronScanProjects-Login` | Al iniciar sesión Windows (5 min delay) |
| `UltronScanProjects-Periodic` | Cada 12 horas |
| `UltronTrackActivity` | **Cada 10 minutos** — registra qué proyecto tienes activo |
| `UltronRetention-Daily` | Diario 03:00 — limpia logs viejos |
| `UltronNewsScraper-Daily` | Diario 08:00 — fetch RSS + Reddit + filter |
| `UltronDashboard-Hourly` | Cada hora — regenera DASHBOARD.md |
| `UltronStandup-Weekday` | Lun-Vie 08:15 — genera standup matinal |

### Verifica que todo arrancó OK

```powershell
ultron status
```

Debes ver: proyectos detectados, scheduler tasks Ready, vault status, activity samples.

---

## 2. Comandos — los 14 explicados

### `ultron status` — vista general
Dashboard rápido en terminal. Muestra: proyectos top por last_active, vault summary, activity 7d, alerts pendientes, scheduler health. **Empieza el día con esto.**

### `ultron open <project>` — lanzar IDE con warm-start
```powershell
ultron open tortunabo            # match exacto por id
ultron open laundry              # substring match (encuentra laundry-club-next)
ultron open --list               # lista los 30 proyectos más recientes
ultron open --search calendar    # busca por nombre
ultron open <project> --no-context   # sin escribir .claude/context.md
ultron open <project> --ide VSCode    # forzar IDE distinto al detectado
```

**Qué hace bajo el capó:**
1. Lee `projects.json` y `ide-mappings.json` para resolver el IDE
2. Escribe `.claude/context.md` en el proyecto con metadatos (path, IDE, deadline, last_active, tags)
3. Lanza el IDE (Rider/Webstorm/VSCode/AndroidStudio/VisualStudio) con la carpeta abierta
4. Loguea el evento a `activity.jsonl`

Cuando luego abras Claude en ese IDE, lee primero `.claude/context.md` → warm start sin que se lo expliques.

### `ultron projects [--list|--search <q>]` — explorar registro
```powershell
ultron projects --list           # top 30 proyectos por activity
ultron projects --search ue5     # busca "ue5" en nombres/ids
```

### `ultron scan` — re-escanear filesystem
```powershell
ultron scan                      # silencioso
ultron scan --verbose            # ver cada proyecto detectado
ultron scan --dry-run            # sin escribir
```

Recorre `C:\Users\USER\CARRERA\` (asignaturas + personales + proyectos) + `~/.claude/skills/`.
Detecta `.git`, `*.uproject`, `package.json`, `*.csproj`, `build.gradle`, `pyproject.toml`, `SKILL.md`, etc.
**Preserva tus ediciones manuales** a `status`/`deadline`/`tags`.

### `ultron auth <action>` — cambiar de cuenta sin esfuerzo
```powershell
ultron auth status                                    # resumen vault
ultron auth list                                      # detalle
ultron auth add -Service gmail -ProfileName personal -ConfigPath gmail.json -Label "USER@..."
ultron auth get -Service gmail -ProfileName personal  # ver JSON desencriptado (sale a stdout)
ultron auth switch -Service gmail -ProfileName freelance   # SWAP con confirmación
ultron auth switch -Service gmail -ProfileName freelance -Force   # sin preguntar
ultron auth remove -Service gmail -ProfileName old -Force
```

**Cómo capturar un profile inicial:**
1. Configura el MCP de Gmail en `settings.json` con la cuenta deseada
2. `$cfg = (Get-Content -Raw ~/.claude/settings.json | ConvertFrom-Json).mcpServers.gmail`
3. `$cfg | ConvertTo-Json -Depth 10 | Set-Content gmail-personal.json`
4. `ultron auth add -Service gmail -ProfileName personal -ConfigPath gmail-personal.json -Label "tu@email"`
5. Repite con la otra cuenta → ahora `ultron auth switch` cambia entre ambas

**Encriptación:** Windows DPAPI scope `CurrentUser` + entropy bind. Solo tu user en este PC desencripta.

### `ultron schedule <install|status|uninstall>` — gestión cron jobs
```powershell
ultron schedule install      # crea las 7 tasks
ultron schedule status       # estado y last run
ultron schedule uninstall    # quita todas
```

### `ultron track [snapshot|summary]` — actividad
```powershell
ultron track snapshot                # capturar AHORA qué tengo abierto
ultron track snapshot --verbose      # con detalle de detección
ultron track summary --days 7        # histograma proyectos últimos 7 días
```

La task `UltronTrackActivity` corre esto cada 10 min. Detecta:
1. Foreground window title → match contra projects.json
2. Procesos IDE corriendo (Rider, Webstorm, etc.)
3. Fallback: cwd actual del shell

### `ultron retention [--dry-run]` — limpieza
```powershell
ultron retention --dry-run           # ver qué borraría sin tocar
ultron retention                     # ejecutar limpieza
```

Política de retención:
- `routing.jsonl`: 30 días
- `activity.jsonl`: 60 días (más para Schedule Learner)
- `news/*.md`: 30 días (ALERTS.md preservado siempre)
- `settings.json.*.bak`: 90 días
- `scheduler-logs/*.log`: keep last 5

### `ultron news` — AI news
```powershell
ultron news                   # SHOW today's digest + ALERTS
ultron news --no-gemini       # RUN scraper (rápido, sin Gemini)
ultron news --verbose         # RUN con logs detallados
```

**Sin args = mostrar lo que ya hay. Con args = ejecutar el scraper de nuevo.**

### `ultron dashboard [--print]` — DASHBOARD.md
```powershell
ultron dashboard              # regenerar DASHBOARD.md
ultron dashboard --print      # mostrar el actual
```

Ubicación: `~/.ultron/cockpit/DASHBOARD.md`. Cron lo regenera cada hora.

### `ultron standup [--print|--gemini]` — briefing matinal
```powershell
ultron standup                # generar el de hoy
ultron standup --print        # mostrar el de hoy
ultron standup --gemini       # generar con polish de Gemini flash
```

Ubicación: `~/.ultron/cockpit/standup/YYYY-MM-DD.md`. Cron weekday 08:15.

### `ultron calendar <args>` — Calendar matching
```powershell
ultron calendar --sample              # test con eventos sintéticos
ultron calendar --print               # ver deadlines.json actual
ultron calendar --events events.json  # match contra eventos reales
ultron calendar --stdin               # match desde stdin
```

**Para matching real con Google Calendar MCP** (cuando lo tengas):
```python
# Claude reads:
events = mcp__claude_ai_Google_Calendar__list_events(timeMin=now, timeMax=+60d)
# Save to JSON file, then:
ultron calendar --events events.json
```

### `ultron alias` — copy-paste alias
Si pierdes el profile, esto te imprime la línea exacta para añadir.

### `ultron help` — esto

---

## 3. Casos de uso reales

### "Cambiar de Gmail personal a Gmail freelance ahora"
```powershell
ultron auth switch -Service gmail -ProfileName freelance
# Confirmas con 'y'
# Reiniciar Claude Code para que el MCP cargue la nueva config
```

### "Voy a trabajar en Tortunabo, abre todo"
```powershell
ultron open tortunabo
# Rider arranca con la carpeta + .claude/context.md prefill listo
```

### "¿Qué tenía pendiente?"
```powershell
ultron status              # vista global
ultron standup --print     # standup matinal con deadlines + recomendación
ultron dashboard --print   # más detalle
```

### "Detectar nuevos proyectos sin esperar al cron"
```powershell
ultron scan --verbose
ultron projects --list
```

### "Editar mappings de IDE manualmente"
```powershell
notepad ~/.ultron/cockpit/ide-mappings.json
# Edita by_project_id o by_path_pattern
ultron scan   # aplica
```

### "Marcar un proyecto como archivado para que no aparezca en top"
```powershell
notepad ~/.ultron/cockpit/projects.json
# Cambia "status": "auto-detected" → "status": "archived"
# El scanner respeta tu edición en re-scans
```

### "Añadir deadline a un proyecto"
```powershell
notepad ~/.ultron/cockpit/projects.json
# En la entrada del proyecto añade: "deadline": "2026-05-15"
ultron dashboard   # regenera con el deadline visible
```

### "Ver últimas noticias AI antes del cron de mañana"
```powershell
ultron news --no-gemini       # rápido, sin tokens
ultron news                   # ver el digest
```

---

## 4. Ubicaciones y convenciones

```
C:\Users\USER\.ultron\cockpit\
├── projects.json              # Registry (editable: status, deadline, tags se preservan)
├── ide-mappings.json          # Overrides IDE por proyecto / path pattern
├── activity.jsonl             # Append-only, una línea cada 10 min cuando hay actividad
├── deadlines.json             # Output de calendar matching
├── auth-vault.dpapi           # Encrypted profiles (DPAPI)
├── DASHBOARD.md               # Regenerated hourly
├── TUTORIAL.md                # Este archivo
├── README.md                  # Ref técnica
├── news/
│   ├── 2026-04-27.md          # Daily digest
│   ├── ALERTS.md              # Breaking changes (auto-load próxima sesión Claude)
│   └── seen.json              # Dedup hash
├── standup/
│   └── 2026-04-27.md          # Daily standup (weekdays only)
└── scheduler-logs/
    ├── scan_projects.log
    ├── track_activity.log
    ├── retention.log
    ├── news_scraper.log
    ├── build_dashboard.log
    └── ai_standup.log
```

```
C:\Users\USER\.claude\skills\ultron\scripts\cockpit\
├── ultron.ps1                 # Centralita (entry point)
├── cockpit_base.py            # Utilities + Project dataclass + IDE detection
├── scan_projects.py           # 4.B
├── track_activity.py          # 4.G
├── launch_project.py          # 4.E
├── retention.py               # 4.D
├── auth-vault.ps1             # 4.C (DPAPI)
├── auth_vault.py              # Python wrapper
├── news_scraper.py            # 4.L
├── build_dashboard.py         # 4.K
├── ai_standup.py              # 4.M
├── calendar_match.py          # 4.J
└── install-scheduler.ps1      # 7 cron jobs
```

---

## 5. Troubleshooting

### "ultron: command not found"
Profile no cargado. `. $PROFILE` o cierra/abre PowerShell.

### "Cannot run scripts (execution policy)"
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
Confirmas con S. Una sola vez.

### "Las cron jobs aparecen `LastRun: 30/11/1999`"
Significa "nunca ejecutadas todavía". Para forzar disparo:
```powershell
Start-ScheduledTask -TaskName UltronTrackActivity
```

### "Scanner detectó proyectos viejos / abandonados"
Edita `projects.json` y cambia `"status"` a `"archived"`. Persiste en re-scans.

### "El IDE detectado no es el correcto"
Edita `ide-mappings.json` → `by_project_id` o `by_path_pattern`. Re-run `ultron scan`.

### "El standup no detectó mis commits"
El standup mira `git log --since=24.hours` en cada proyecto. Si no commiteaste o git no está en PATH, no aparecen.

### "Vault corrompido"
```powershell
Copy-Item ~/.ultron/cockpit/auth-vault.dpapi.bak ~/.ultron/cockpit/auth-vault.dpapi
```

### "settings.json corrompido tras Switch"
```powershell
ls ~/.claude/settings.json.*.bak | Sort-Object LastWriteTime -Descending | Select-Object -First 1
# Copia el .bak más reciente sobre settings.json
```

### "El news scraper falla con 404 de Anthropic"
Sí, su URL RSS cambió. No bloquea (las otras 3 fuentes funcionan). Lo arreglaré en v10.1.

### "¿Cómo añado un nuevo MCP service al vault?"
No hay restricción de servicios — usa cualquier nombre:
```powershell
ultron auth add -Service notion -ProfileName personal -ConfigPath notion-config.json -Label "..."
```
El vault crea el nodo automáticamente.

### "¿Cómo añado una nueva carpeta de proyectos al scan?"
Editar `scripts/cockpit/cockpit_base.py:SCAN_ROOTS` (lista hardcoded). En v10.1 será configurable via JSON.

---

## 6. Datos sensibles — qué NO compartir

- ❌ **`auth-vault.dpapi`** — contiene tokens cifrados. NO subir a git, NO copiar a otro PC.
- ❌ **`settings.json.*.bak`** — backups con tokens crudos. Borra los antiguos (`ultron retention` lo hace).
- ✅ **`projects.json`** — solo metadatos, OK compartir si quieres
- ✅ **`activity.jsonl`** — telemetría de tiempos de uso, OK compartir
- ✅ **`DASHBOARD.md`** — derivado, OK compartir

---

## 7. Cierre

Para cerrar el día:

```powershell
ultron status
# Lee el dashboard, ajusta deadlines manualmente si toca
```

Para cierre de sesión Claude Code (al final del día):
- ULTRON ya escribe a `~/.ultron/sessions/<fecha>.md` automáticamente vía hook Stop
- El standup mañana 08:15 verá tu actividad y commits

---

## 8. Roadmap v10.1+

- **v10.1 (datos reales):** Schedule Learner (necesita 7+ días activity.jsonl) · scan_roots configurable JSON · Auto-Kirkardo cron domingo 22:00
- **v10.2 (polish):** MCP Plugin Packs (presets gaming/backend/web/academia) · Health Check hook · Memory dedup mensual
- **v11.0 (futuro):** Voice Interface · Local LLM fast path · Web Dashboard React

---

**Cualquier duda, abre Claude Code y pide "Ultron, explícame X" — la skill carga este tutorial automáticamente.**
