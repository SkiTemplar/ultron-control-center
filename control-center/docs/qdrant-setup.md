# Qdrant Setup — ULTRON Control Center

Qdrant is an optional local vector database used for semantic session recall
(KIRKARDO 14). The Control Center works fine without it — hooks degrade
gracefully when Qdrant is not running.

## Status on this machine (2026-05-27)

Installed at `D:\Ultron\qdrant\qdrant.exe` (v1.13.0). Auto-start registered as
Windows scheduled task `UltronQdrant` (run at user logon, restart x3 if fails).
Config at `D:\Ultron\qdrant\config.yaml`, storage at
`D:\Ultron\qdrant\storage`, snapshots at `D:\Ultron\qdrant\snapshots`. HTTP on
`127.0.0.1:6333`, gRPC on `6334`, telemetry disabled. The `qdrant.rs` module
hits the HTTP API via `reqwest`, so no extra env var is needed by default.

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
text payloads. Semantic search at query time is handled by:

- **Tauri backend** — `qdrant::embed` via fastembed BGE-small-EN-v1.5 (feature
  flag `qdrant`). Exposed as the `qdrant_embed_query` Tauri command for the
  frontend.
- **`ultron-embed` sidecar** — standalone CLI binary that wraps the same
  `qdrant::embed` function so Node.js hooks can call it via `spawnSync`.

### `ultron-embed` sidecar

The `session-recall-inject.js` hook cannot invoke Tauri commands (it is a Node
process, not a webview). The sidecar solves this:

1. **Build** (once, after any Rust change to `qdrant.rs`):

   ```powershell
   cd C:\Users\USER\.ultron\control-center\src-tauri
   cargo build --release --bin ultron-embed --features qdrant
   # Produces: target\release\ultron-embed.exe
   ```

2. **Install** — copy to a stable location so the hook finds it:

   ```powershell
   Copy-Item .\target\release\ultron-embed.exe "$env:USERPROFILE\.ultron\bin\ultron-embed.exe" -Force
   ```

   The hook searches these paths in order:
   - `ULTRON_EMBED_BIN` env var (explicit override)
   - `~/.ultron/bin/ultron-embed.exe` (recommended install target)
   - `~/.ultron/control-center/src-tauri/target/release/ultron-embed.exe` (dev fallback)

3. **Verify**:

   ```powershell
   # Quick smoke test — should print a JSON array of 384 floats
   "control-center Rust semantic recall" | & "$env:USERPROFILE\.ultron\bin\ultron-embed.exe"
   ```

4. **Fallback** — if the binary is absent, `session-recall-inject.js` logs a
   warning and falls back to the `/scroll` payload-filter path automatically.
   No manual intervention required.

The ONNX model cache at `~/.cache/fastembed_cache/` is shared between the
Tauri process and the sidecar, so the ~22 MB download only occurs once.

## Verifying the pipeline

```powershell
# 1. Check Qdrant is up
Invoke-RestMethod http://localhost:6333/

# 2. Check collection exists (after at least one Stop hook fired)
Invoke-RestMethod http://localhost:6333/collections/ultron_sessions

# 3. Test ultron-embed sidecar — should output 384 floats as JSON
"control-center Rust backend recall" | & "$env:USERPROFILE\.ultron\bin\ultron-embed.exe"

# 4. True vector search test (using the sidecar output as the query vector)
$vec = ("control-center" | & "$env:USERPROFILE\.ultron\bin\ultron-embed.exe") | ConvertFrom-Json
$body = @{
  vector = $vec
  limit = 5
  with_payload = $true
  filter = @{ must = @(@{ key = "project"; match = @{ value = "control-center" } }) }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:6333/collections/ultron_sessions/points/search -Body $body -ContentType "application/json"

# 5. Scroll fallback test (no vector needed — for when sidecar not built)
$body = @{ filter = @{ must = @(@{ key = "project"; match = @{ value = "control-center" } }) }; limit = 10; with_payload = $true } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:6333/collections/ultron_sessions/points/scroll -Body $body -ContentType "application/json"

# 6. Check hook logs
Get-Content "$env:USERPROFILE\.claude\logs\stop-compress-session.jsonl" -Tail 10
Get-Content "$env:USERPROFILE\.claude\logs\session-recall-inject.jsonl" -Tail 10
```
