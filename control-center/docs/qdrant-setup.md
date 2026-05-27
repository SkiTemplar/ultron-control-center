# Qdrant Setup — ULTRON Control Center

Qdrant is an optional local vector database used for semantic session recall
(KIRKARDO 14). The Control Center works fine without it — hooks degrade
gracefully when Qdrant is not running.

## Decision: external binary, not embedded

Qdrant is NOT embedded inside the Tauri process. Reasons:

1. The Qdrant Rust crate (`qdrant`) requires a full gRPC stack and compiles
   to a server binary, not a library. There is no official embeddable crate.
2. Running the store in a separate process gives it persistent state across
   app restarts without any IPC glue.
3. The `qdrant-client` crate (v1.x) adds ~80 transitive deps including
   `tonic` / `prost`. Using the REST API via `reqwest` (already in the tree)
   keeps the dependency footprint near zero.

## Install Qdrant

### Option A — Pre-built binary (recommended)

1. Open: https://github.com/qdrant/qdrant/releases/latest
2. Download `qdrant-x86_64-pc-windows-msvc.zip` (or the zip for your arch).
3. Extract `qdrant.exe` to a stable location, e.g.:

   ```
   C:\Users\USER\.ultron\bin\qdrant.exe
   ```

4. Run it once manually to verify:

   ```powershell
   & "C:\Users\USER\.ultron\bin\qdrant.exe"
   # Qdrant HTTP API listening on port 6333
   ```

5. Open http://localhost:6333/dashboard to confirm it is up.

### Option B — Docker

```powershell
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 `
  -v "${env:USERPROFILE}\.ultron\qdrant-storage:/qdrant/storage" `
  qdrant/qdrant
```

## Auto-start with Windows Task Scheduler

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Users\USER\.ultron\bin\qdrant.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "Qdrant-ULTRON" `
  -Action $action -Trigger $trigger -Settings $settings `
  -RunLevel Highest -Force
```

## Configuration

By default the Control Center connects to `http://localhost:6333`. Override
with the `QDRANT_URL` environment variable:

```powershell
$env:QDRANT_URL = "http://localhost:6333"
```

Set it permanently via Windows user environment variables:

```powershell
[System.Environment]::SetEnvironmentVariable("QDRANT_URL", "http://localhost:6333", "User")
```

## Collections created automatically

| Collection | Dims | Distance | Created by |
|---|---|---|---|
| `ultron_sessions` | 384 | Cosine | `stop-compress-session.js` on first Stop hook |

The collection is created on first write. No manual setup required.

## Embedding model

The `stop-compress-session.js` hook stores **zero vectors** (384-d) with rich
text payloads. Semantic search at query time is handled by the Tauri backend
(`qdrant::embed` via fastembed BGE-small-EN-v1.5, feature flag `qdrant`).

The session-recall-inject.js hook uses **payload filter + scroll** (no
embedding needed) to retrieve facts by project name at `SessionStart`.

To enable true vector similarity in the UI, build with:

```powershell
cargo build --features qdrant
```

On first run, fastembed downloads ~22 MB to `~/.cache/fastembed_cache/`.

## Verifying the pipeline

```powershell
# 1. Check Qdrant is up
Invoke-RestMethod http://localhost:6333/

# 2. Check collection exists (after at least one Stop hook fired)
Invoke-RestMethod http://localhost:6333/collections/ultron_sessions

# 3. Scroll all points for a project
$body = @{ filter = @{ must = @(@{ key = "project"; match = @{ value = "control-center" } }) }; limit = 10; with_payload = $true } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:6333/collections/ultron_sessions/points/scroll -Body $body -ContentType "application/json"

# 4. Check hook logs
Get-Content "$env:USERPROFILE\.claude\logs\stop-compress-session.jsonl" -Tail 10
Get-Content "$env:USERPROFILE\.claude\logs\session-recall-inject.jsonl" -Tail 10
```
