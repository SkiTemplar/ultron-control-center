---
name: dockerfile-linter
description: >
  Linting y best practices para Dockerfiles: seguridad, layer optimization, tamaño de imagen.
  Activar cuando: escribiendo o revisando Dockerfiles · optimizando build times · auditando
  seguridad de imágenes · multi-stage builds · .dockerignore review · docker-compose review.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [dockerfile, linter]
token_est: 1158
layer: L1-skills
---

# Dockerfile Linter

## CHECKLIST DE SEGURIDAD

```
✅ No usar 'latest' como base — pinear versión exacta: FROM node:20.11.1-alpine3.19
✅ No ejecutar como root — añadir USER nonroot o USER 1000 (Linux) / USER ContainerUser (Windows)
✅ No hardcodear secrets en ENV o ARG — usar secrets en buildtime o inject en runtime
✅ Añadir HEALTHCHECK para que el orchestrator detecte containers degradados
✅ Escanear imagen con trivy/snyk antes de push
❌ FROM ubuntu:latest
❌ RUN curl ... | bash
❌ ENV DB_PASSWORD=secret123
❌ ADD (usar COPY salvo que necesites auto-extract de tarballs)
```

## LAYER OPTIMIZATION

### Orden correcto (frecuencia de cambio: menor → mayor)
```dockerfile
FROM node:20.11.1-alpine3.19
# 1. Dependencias del SO (cambia raramente)
RUN apk add --no-cache tini
# 2. Archivos de dependencias (cambia poco)
COPY package*.json ./
RUN npm ci --only=production
# 3. Código fuente (cambia frecuentemente)
COPY src/ ./src/
```

### Multi-stage build — Node.js
```dockerfile
FROM node:20.11.1-alpine3.19 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.11.1-alpine3.19 AS runtime
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER appuser
EXPOSE 3000/tcp
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

### Multi-stage build — Python
```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev

FROM python:3.12-slim AS runtime
WORKDIR /app
# Copy installed packages — note: site-packages path must match builder Python version exactly
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY src/ ./src/
RUN useradd -r -s /sbin/nologin appuser
USER appuser
EXPOSE 8000/tcp
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Windows containers (mcr.microsoft.com base)
```dockerfile
# Windows containers use ContainerUser, not nonroot/1000
FROM mcr.microsoft.com/dotnet/aspnet:8.0-nanoserver-ltsc2022
WORKDIR /app
COPY --from=builder /app/publish .
USER ContainerUser
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=10s CMD powershell -Command "Invoke-WebRequest -Uri http://localhost:8080/health -UseBasicParsing" || exit 1
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

> **tini** es necesario cuando el proceso principal no maneja señales SIGTERM (PID 1 problem).
> Si usas `CMD ["node", ...]` en exec form, Node maneja señales directamente — `tini` es opcional.
> En Python/Java, `tini` es recomendado. En Windows containers, no aplica.

## PROBLEMAS COMUNES

| Problema | Fix |
|---|---|
| `RUN apt-get update && apt-get install -y X` en líneas separadas | Unir en una sola RUN — el update se cachea y puede quedar stale |
| `COPY . .` antes de instalar deps | Invalida el cache de deps con cada cambio de código |
| `RUN npm install` en prod | Usar `npm ci --only=production` |
| No tener `.dockerignore` | Añadir: `node_modules`, `.git`, `*.log`, `.env`, `dist` |
| `EXPOSE` sin documentar el protocolo | `EXPOSE 3000/tcp` |
| `ENV NODE_ENV production` nunca seteado | Setearlo explícitamente para optimizaciones de runtime |
| Sin `HEALTHCHECK` | Orchestrators no detectan containers degradados; add HEALTHCHECK |
| Python multi-stage: site-packages path hardcoded | Verificar que el Python version tag en FROM coincide con la ruta de site-packages |

## .dockerignore MÍNIMO

```
.git
.gitignore
node_modules
npm-debug.log
.env
.env.*
*.md
Dockerfile*
docker-compose*
.vscode
coverage
dist
__pycache__
*.pyc
.pytest_cache
```

## SCORING (0–10)

| Dimensión | Peso |
|---|---|
| Seguridad (user, secrets, base pinned) | 40% |
| Layer efficiency (order, cache invalidation) | 30% |
| Build reproducibility (locked versions) | 20% |
| Documentation (LABEL, HEALTHCHECK, ARG docs) | 10% |
