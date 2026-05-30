# Onboarding — ULTRON Fullize (2026-05-30)

Guía paso a paso para un desarrollador nuevo del equipo. Cubre la configuración local completa, compilación, variables de entorno, y validación del sistema.

**Contexto:** ULTRON es una aplicación Tauri 2 con backend Rust (`src-tauri/`) y frontend React+TypeScript (`control-center/src/`). La campaña "fullize" entregó un Control Center compilable, honesto (telemetría real) y accionable (cockpit con diagnostics, detach/reattach, recall semántico Qdrant, proxy free-tier). Tres acciones manuales están pendientes de validación: rebuild npm, compilar proxy Go, validar instalador.

---

## 1. Prerequisitos del sistema

Instala estas herramientas **en orden**:

### 1.1 Rust (backend Tauri)
- Descarga desde https://rustup.rs/
- Ejecuta el instalador y selecciona la opción por defecto (default installation)
- Abre una terminal nueva (PowerShell o cmd) y verifica:
  ```powershell
  rustc --version
  cargo --version
  ```
- Esperado: `rustc 1.XX.X` y `cargo 1.XX.X`

### 1.2 Node.js + npm (frontend React)
- Descarga desde https://nodejs.org/ (versión LTS recomendada: 20+)
- Instala con las opciones por defecto
- Verifica en una terminal nueva:
  ```powershell
  node --version
  npm --version
  ```
- Esperado: `v20.XX.X` y `10.X.X` (o superior)

### 1.3 Tauri CLI
- Una vez que Rust y Node estén instalados, ejecuta:
  ```powershell
  npm install -g @tauri-apps/cli
  ```
- Verifica:
  ```powershell
  tauri --version
  ```
- Esperado: `tauri XX.X.X` o superior

### 1.4 Go (para compilar el proxy, opcional pero recomendado)
- Descarga desde https://go.dev/dl/ (versión 1.21+)
- Instala y reinicia la terminal
- Verifica:
  ```powershell
  go version
  ```
- Esperado: `go version go1.21.X ...` o superior
- **Nota:** Si prefieres no compilar Go, puedes usar la opción de fallback Python (ver paso 3.3)

### 1.5 PowerShell (Control Center)
- Windows 11 Home trae PowerShell 5.1 por defecto
- Para acceso a permisos y scripting avanzado, recomendado:
  ```powershell
  winget install Microsoft.PowerShell
  ```
- Verifica:
  ```powershell
  $PSVersionTable.PSVersion
  ```
- Esperado: `7.X.X` (7+ recomendado para mejor manejo de encoding)

---

## 2. Clonar y configurar el repositorio

### 2.1 Clonar ULTRON
```powershell
cd $env:USERPROFILE
git clone https://github.com/tu-org/ultron.git .ultron
cd .ultron
```

### 2.2 Verificar rama principal
```powershell
git branch -a
git log --oneline -5
```
- Esperado: rama `main` activa, 18 commits recientes de la campaña fullize

### 2.3 Instalar dependencias Node
```powershell
npm install
```
- Durará 2-5 minutos. Al terminar, debería haber una carpeta `node_modules/` en la raíz

---

## 3. Configurar variables de entorno

### 3.1 Copiar archivo base
```powershell
Copy-Item .env.example .env
```

### 3.2 Editar `~/.ultron/.env`
Abre `C:\Users\<tu-usuario>\.ultron\.env` en tu editor favorito (VSCode, Notepad++) y completa **al menos** estas claves:

```
# Requeridas para AI Router
MEM0_API_KEY=<tu-clave-mem0>
MEM0_USER_ID=dev-<tu-nombre>

# Recomendadas para proxy free-tier
NVIDIA_NIM_API_KEY=nvapi-...
OPENROUTER_API_KEY=sk-or-...

# Opcionales (pero útiles para testing directo)
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
```

**Cómo obtener las claves:**
- **MEM0_API_KEY:** https://app.mem0.ai → Dashboard → Generate Key
- **MEM0_USER_ID:** Usa `dev-<tu-nombre>` para diferenciarte de otros devs (ej: `dev-rodriguez`)
- **NVIDIA_NIM_API_KEY:** https://build.nvidia.com/ → Manage Keys → Generate
- **OPENROUTER_API_KEY:** https://openrouter.ai/ → Settings → Create Key
- **ANTHROPIC_API_KEY:** https://console.anthropic.com/settings/keys
- **GROQ_API_KEY:** https://console.groq.com/keys

**Importante:** Estas variables **nunca se commitean** (`.env` está en `.gitignore`). Solo tú las ves localmente.

### 3.3 Estructura de archivos de entorno
ULTRON carga variables en este orden (primera coincidencia gana):
1. `~/.ultron/.env` (local, gitignored) ← **Aquí pones tus claves**
2. `control-center/.env` (si existe)
3. `cwd/.env` (donde lanzas tauri)

Usa siempre la opción 1 (`~/.ultron/.env`).

---

## 4. Los tres pasos manuales de validación

Después del onboarding anterior, quedan tres acciones críticas. Hazlas en orden.

### 4.1 Rebuild npm + npm run tauri build

Este es el paso que USER aún no ha validado. Ejecuta:

```powershell
cd C:\Users\<tu-usuario>\.ultron
npm run tauri build
```

Esto:
1. Compila el frontend React (control-center/src/)
2. Compila el backend Rust (src-tauri/) usando el cargo.lock existente
3. Empaqueta todo en un instalador `.msi` en `src-tauri\target\release\bundle\msi\`

**Tiempo esperado:** 10-20 minutos en hardware moderno. La primera compilación es más lenta.

**Qué buscar después:**
- No hay errores `error[EXX]` en el output
- Se genera el archivo `.msi` final sin warnings rojos
- La ventana del app se abre correctamente con los componentes Cockpit, Dashboard, etc.

**Si falla:**
- Lee el error completo (`error[...]`)
- Si es un error de `qdrant.rs` o `onnxruntime.dll`, el bundle ONNX no se incluyó (paso 4.2)
- Si es un error de `cargo`, asegúrate de que el `Cargo.toml` tiene `qdrant` en features activo:
  ```toml
  [features]
  default = ["qdrant"]
  qdrant = ["qdrant-client", "ort"]
  ```

### 4.2 Compilar ultron-proxy.exe (binario Go sidecar)

El proxy es un servidor HTTP que implementa la API Anthropic y reenvía las peticiones a NVIDIA NIM / OpenRouter. Está en la rama fullize pero el binario aún no se ha compilado.

**Opción A: Compilar desde fuente (recomendado)**

```powershell
cd $env:USERPROFILE\.ultron\proxy

# Clonar el repo (la primera vez)
git clone https://github.com/nielspeter/claude-code-proxy src
cd src

# Compilar
go build -o ..\ultron-proxy.exe .

# Verifica que se creó
ls ..\ultron-proxy.exe
```

El binario resultante debe ser ~10-20 MB.

**Opción B: Descargar precompilado (si existe)**

```powershell
# Visita https://github.com/nielspeter/claude-code-proxy/releases
# Descarga el .exe para Windows
# Colócalo en: C:\Users\<tu-usuario>\.ultron\proxy\ultron-proxy.exe
```

**Opción C: Fallback Python**

Si no quieres instalar Go:

```powershell
cd $env:USERPROFILE\.ultron\proxy
git clone https://github.com/Alishahryar1/free-claude-code py-proxy
cd py-proxy
uv pip install -r requirements.txt
```

Luego, antes de activar el toggle de proxy en ULTRON, lanza manualmente:
```powershell
uv run python server.py --port 8082
```

**Verificar que funciona:**
1. Abre ULTRON (desde el `.msi` que compilaste en 4.1)
2. Ve a Settings → AI Router
3. Activa el toggle "Free Tier (NVIDIA NIM)"
4. El dot debajo debería volverse verde y mostrar "Running"
5. Abre una sesión Claude Code: en el terminal verás el banner:
   ```
   [ULTRON] Sesion enrutada por proxy free-tier (NVIDIA NIM).
   ```

Si el dot permanece rojo, revisa:
- `NVIDIA_NIM_API_KEY` está en `~/.ultron/.env`
- El proxy está compilado y es accesible (`ls ~/.ultron/proxy/ultron-proxy.exe`)
- El puerto 8082 no está ocupado (`netstat -ano | findstr :8082`)

### 4.3 Validar instalador limpio (smoke test)

Una vez compilado, ejecuta el `.msi`:

```powershell
# El .msi está en src-tauri\target\release\bundle\msi\
cd $env:USERPROFILE\.ultron\src-tauri\target\release\bundle\msi
.\ULTRON_0.1.0_x64_en-US.msi
```

El instalador abrirá una ventana. Sigue los pasos estándar.

Después, **smoke test** (pruebas rápidas de humo):

1. **Abre la aplicación instalada** desde el menú Inicio o escritorio
2. **Cockpit → Dashboard:** Debería mostrar ActiveProjectCard, RecentSessions, proyectos recientes
3. **Cockpit → Diagnostics:** Ejecuta el botón "Run Diagnostics" → debería mostrar 14 checks (incluso si algunos fallan)
4. **Cockpit → Projects:** Lista de proyectos; haz clic en uno → debería mostrar Terminal, IDE, Contexto, IA buttons
5. **AI Router → Providers:** Debería listar providers reales (no Anthropic/Cerebras fantasma); costes actualizados desde `ai_router_list_providers`
6. **Settings → API Keys:** Debería mostrar verde si MEM0_API_KEY está en `.env`
7. **Create a Session:**
   - Crea una nueva sesión Claude Code
   - En el terminal, verifica que aparece:
     - `[ULTRON] Project: <project-slug>` (si está dentro de un proyecto)
     - `[ULTRON] Sesion enrutada por proxy free-tier (NVIDIA NIM)` (si el proxy está activado)

Si algo falla:
- Busca en los logs de ULTRON: `~/.ultron/.logs/`
- Revisa en la consola del navegador (F12 en el Control Center)
- Verifica que el backend está arriba: `~/.ultron/src-tauri/target/release/ULTRON.exe` debe estar corriendo

---

## 5. Estructura de directorios clave

```
~/.ultron/
├── .env                          ← TU ARCHIVO DE CLAVES (gitignored)
├── .env.example                  ← Plantilla de referencia
├── src-tauri/                    ← Backend Rust (Tauri)
│   ├── Cargo.toml               ← Dependencias Rust, features
│   ├── src/
│   │   ├── main.rs              ← Entry point del backend
│   │   ├── lib.rs               ← Funciones exportadas a frontend
│   │   ├── ai_router.rs         ← Honestidad del router
│   │   ├── memory_graph.rs       ← Recall Qdrant (embeddings BGE 384-d)
│   │   ├── diagnostics_native.rs ← 14 checks del sistema
│   │   ├── proxy.rs             ← Lifecycle free-tier proxy
│   │   └── ...
│   └── target/release/bundle/msi/ ← Aquí va el .msi compilado
├── control-center/               ← Frontend React+TS
│   ├── src/
│   │   ├── App.tsx              ← Cockpit, Dashboard, Kanban, Decisions
│   │   ├── views/
│   │   │   ├── CockpitShell.tsx  ← Cockpit layout principal
│   │   │   ├── Dashboard.tsx     ← ActiveProjectCard, RecentSessions
│   │   │   ├── KanbanBoard.tsx   ← Kanban con role canónico
│   │   │   ├── Decisions.tsx     ← Panel de decisiones (fuera del kanban)
│   │   │   └── ...
│   │   └── ...
│   └── package.json
├── proxy/                        ← Binario Go sidecar (compilar aquí)
│   ├── src/                      ← Clonado desde github.com/nielspeter/...
│   ├── ultron-proxy.exe          ← Resultado de `go build`
│   └── HOWTO.md                  ← Este archivo
├── docs/
│   ├── ONBOARDING-fullize.md     ← TÚ ESTÁS AQUÍ
│   ├── MASTER-PLAN-fullize-2026-05-30.md
│   └── ...
└── cockpit/
    ├── kanban.json               ← Cards actualizadas post-fullize
    ├── MASTER-PLAN-fullize-2026-05-30.md
    └── ...
```

---

## 6. Workflow de desarrollo típico

Después de onboarding, así trabajas día a día:

### 6.1 Lanzar el app en modo dev (hot-reload)
```powershell
cd ~/.ultron
npm run tauri dev
```
- Frontend y backend se recargan automáticamente al guardar archivos
- Abre DevTools con F12 en el app

### 6.2 Compilar para producción
```powershell
npm run tauri build
```
- Genera el `.msi` final en `src-tauri/target/release/bundle/msi/`

### 6.3 Hacer cambios
- **Frontend (React/TS):** Edita `control-center/src/` → se recarga automático en `npm run tauri dev`
- **Backend (Rust):** Edita `src-tauri/src/` → se recompila automático en `npm run tauri dev`
- **Variables de entorno:** Edita `~/.ultron/.env` → reinicia `npm run tauri dev` para que el backend lo cargue

### 6.4 Commitear
```powershell
git add .
git commit -m "feat(dashboard): add quick-actions button to project card"
```
- Los commits siguen formato convencional: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- Nunca commits `.env` (está en `.gitignore`)

---

## 7. Troubleshooting rápido

| Problema | Causa | Solución |
|----------|-------|----------|
| `error: could not compile 'ultron'` | Dependencia Rust rota | `cargo clean && npm run tauri dev` |
| `npm ERR! code ERESOLVE` | Conflicto en node_modules | `rm -r node_modules package-lock.json && npm install` |
| `ONERROR: Cannot find module 'qdrant-client'` | Qdrant no en features | Verifica `Cargo.toml` `default = ["qdrant"]` |
| `The proxy cannot start` | Puerto 8082 ocupado | `netstat -ano \| findstr :8082` y mata el proceso |
| `MEM0_API_KEY is empty` | Variable no en `.env` | Edita `~/.ultron/.env` con tu clave |
| `Tauri window won't open` | Backend no compiló | Revisa logs: `npm run tauri build 2>&1 \| tail -50` |

---

## 8. Checklist de onboarding

Antes de empezar a trabajar, marca todo esto:

- [ ] Rust instalado (`rustc --version`)
- [ ] Node.js instalado (`node --version`)
- [ ] Tauri CLI instalado (`tauri --version`)
- [ ] Go instalado (opcional pero recomendado, `go version`)
- [ ] Repositorio clonado en `~/.ultron/`
- [ ] `npm install` completado
- [ ] `~/.ultron/.env` creado y completado con claves
- [ ] Paso 4.1: `npm run tauri build` sin errores → `.msi` generado
- [ ] Paso 4.2: `ultron-proxy.exe` compilado o descargado
- [ ] Paso 4.3: Smoke test pasado (app abre, Dashboard visible, Diagnostics run)
- [ ] `npm run tauri dev` inicia correctamente
- [ ] Frontend se recarga al editar `control-center/src/`
- [ ] Backend se recompila al editar `src-tauri/src/`

---

## 9. Siguientes pasos

Una vez completado onboarding:

1. **Revisar MASTER-PLAN:** Lee `cockpit/MASTER-PLAN-fullize-2026-05-30.md` para entender la arquitectura
2. **Familiarización:** Abre ULTRON y explora Cockpit, Dashboard, Kanban, Decisions
3. **Git history:** `git log --oneline main..HEAD` para ver los 18 commits de fullize
4. **Asignar tarea:** Tu PM te dirá en cuál de las Olas 3 trabajar
5. **Preguntar:** Si algo no funciona, revisa los logs en `~/.ultron/.logs/` y pregunta al equipo

---

**Última actualización:** 2026-05-30  
**Responsable de onboarding:** Team  
**Para preguntas:** Abre un issue en el repo o pregunta en el canal de dev
