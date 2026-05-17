---
name: docker-expert
description: Docker containerization expert covering multi-stage builds, security hardening, optimization, and production-grade image patterns. Activate when writing Dockerfiles, optimizing images, configuring Docker Compose, implementing container security, or setting up container CI/CD.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [docker, expert]
token_est: 793
layer: L1-skills
---

# Docker Expert Skill

Production-grade Docker containerization with focus on image optimization, security hardening, and build performance.

## Excellence Targets

- Production images under 100MB
- Build times under 5 minutes
- Layer cache hit rates exceeding 80%
- CIS Docker Benchmark compliance above 90%
- Zero critical/high vulnerabilities

## Multi-Stage Build Pattern

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# Stage 2: Production (distroless)
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["dist/index.js"]
```

## Security Hardening

```dockerfile
# Non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Read-only filesystem
# docker run --read-only --tmpfs /tmp ...

# Drop capabilities
# docker run --cap-drop ALL --cap-add NET_BIND_SERVICE ...

# No new privileges
# docker run --security-opt no-new-privileges ...
```

## Build Optimization

```dockerfile
# Order: least-changing → most-changing layers
COPY package*.json ./          # Rarely changes
RUN npm ci                     # Cached unless package.json changes
COPY src/ ./src/               # Changes often
RUN npm run build
```

```bash
# Use BuildKit for advanced features
DOCKER_BUILDKIT=1 docker build .

# Cache mounts (secrets, package managers)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Build with specific platform
docker buildx build --platform linux/amd64,linux/arm64 .
```

## Docker Compose (Production)

```yaml
services:
  app:
    image: myapp:${VERSION:-latest}
    restart: unless-stopped
    environment:
      NODE_ENV: production
    env_file: .env.production
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
    networks:
      - app-network
    volumes:
      - app-data:/data:ro  # read-only mounts where possible

networks:
  app-network:
    driver: bridge

volumes:
  app-data:
```

## Vulnerability Scanning

```bash
# Scan with Docker Scout
docker scout cves myapp:latest

# Scan with Trivy
trivy image myapp:latest

# Generate SBOM
docker sbom myapp:latest
```

## .dockerignore (Essential)

```
.git
.gitignore
node_modules
npm-debug.log
Dockerfile
.dockerignore
.env*
*.md
coverage/
.nyc_output/
dist/
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents docker-expert](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
