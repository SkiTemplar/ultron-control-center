---
title: Qdrant MCP Install — Pre-flight & Decision
date: 2026-05-08
status: BLOCKED on user infra decision
---

# Qdrant MCP — D-MCP-3 Install Pre-flight

## State (2026-05-08)

- Recommendation in `~/.ultron/plans/2026-05-06-kirkardo-genesis-14-audit.md` Section I: install `qdrant-mcp-server` (official) for semantic memory complement to the existing FTS5 brain index.
- Local Docker probe: **NOT INSTALLED**. `docker.exe` not on PATH; Docker Desktop not running.
- Qdrant Cloud probe: not attempted (needs user account + API key).

## Two install paths

### Path A — Qdrant local (Docker)

Pros: free, fully local, no network round-trip per query. Best for ULTRON's
"memoria privada" stance.

Pre-requisites:

1. Install Docker Desktop from <https://www.docker.com/products/docker-desktop/>
   (or install just the Docker Engine via WSL2, but Desktop is smoother on Windows).
2. Verify with `docker info` — needs server reachable.
3. Pull + run Qdrant:
   ```powershell
   docker run -d --name qdrant -p 6333:6333 -p 6334:6334 `
     -v ${env:USERPROFILE}\.ultron\qdrant\storage:/qdrant/storage `
     qdrant/qdrant
   ```
4. Verify: `curl http://localhost:6333/healthz` → 200.
5. Add MCP:
   ```powershell
   . "$env:USERPROFILE\.ultron\cockpit\secrets-loader.ps1"
   claude mcp add -s user qdrant `
     -e "QDRANT_URL=http://localhost:6333" `
     -- uvx mcp-server-qdrant
   ```
6. Verify: `claude mcp list | Select-String qdrant`

### Path B — Qdrant Cloud (free tier)

Pros: no Docker; managed infra. Cons: data leaves the box; free tier has
limits.

Pre-requisites:

1. Create account at <https://cloud.qdrant.io>.
2. Create a free-tier cluster (1GB).
3. Generate an API key + cluster URL (looks like `https://<id>.<region>.gcp.cloud.qdrant.io:6333`).
4. Store in Credential Manager (mirror the GitHub PAT pattern):
   ```powershell
   cmdkey /generic:ULTRON_QDRANT_URL /user:USER /pass:<URL>
   cmdkey /generic:ULTRON_QDRANT_KEY /user:USER /pass:<KEY>
   ```
5. Update `~/.ultron/cockpit/secrets-loader.ps1` to load both into env vars.
6. Add MCP (same shape as A, but with both env vars):
   ```powershell
   claude mcp add -s user qdrant `
     -e "QDRANT_URL=$env:QDRANT_URL" `
     -e "QDRANT_API_KEY=$env:QDRANT_API_KEY" `
     -- uvx mcp-server-qdrant
   ```

## Recommendation

**Path A** (local) for the privacy/independence stance, BUT only after
Docker Desktop install. If USER doesn't want a Docker dependency,
Path B is the fallback.

## What ULTRON gains

- Vector store backing a future "semantic recall" tool that complements
  the existing FTS5 brain index. Useful when the user remembers the
  *concept* of a note but not the *keywords*.
- Plug-in path for embedding models (OpenAI / local sentence-transformers).
- Cross-session "rolling memory" that's faster than re-indexing the
  whole vault.

## What's NOT done in this sprint

- The actual install — needs your input on A vs B.
- Embedding pipeline that pushes vault notes into Qdrant — separate
  follow-up after the server is reachable.
- A first-class `ultron qdrant` subcommand — also future work.
