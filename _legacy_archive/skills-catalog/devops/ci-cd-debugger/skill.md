---
name: ci-cd-debugger
description: >
  Debugging de pipelines CI/CD: GitHub Actions, GitLab CI, errores de workflows.
  Activar cuando: GitHub Actions failing · pipeline error · workflow yml · CI red ·
  job failed · secret not found · cache miss · artifact upload · matrix build ·
  act local · runner problem · permission denied en CI.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [debugger]
token_est: 1451
layer: L1-skills
---

# CI/CD Debugger

## TRIAGE RÁPIDO — en qué orden mirar

```
1. ¿Es el mismo commit que pasaba antes?        → flaky test / runner problem
2. ¿Falla en el primer step?                    → setup/checkout/env issue
3. ¿Error de permisos (403, permission denied)? → secrets/token scope
4. ¿Falla en "Restore cache" o después?         → cache key stale / corruption
5. ¿Solo falla en Windows runner?               → path separator, CRLF, PowerShell vs bash
```

## LEER LOGS DE GITHUB ACTIONS

```
::error file=src/index.ts,line=42::Cannot find module './utils'
         ↑ archivo                  ↑ mensaje exacto

Groups en el log:
▶ Set up job          — runner config, versions, checkout
▶ Run npm test        — tu step; expandir aquí primero
▶ Post Run actions/cache  — upload de cache; ignorar si el step ya pasó
```

Para ver el log completo sin truncar: Actions → workflow run → job → botón `...` → "View raw logs"

## SECRETS Y VARIABLES DE ENTORNO

### Los 3 contextos de GitHub Actions — error más común
```yaml
# ${{ secrets.X }}   — repositorio secrets (Settings > Secrets)
# ${{ env.X }}       — variables definidas en el workflow
# ${{ vars.X }}      — repository variables (no sensibles)

# PROBLEMA FRECUENTE: env context NO disponible en `with:` blocks
- uses: actions/checkout@v4
  with:
    token: ${{ env.MY_TOKEN }}    # ❌ NO FUNCIONA
    token: ${{ secrets.MY_TOKEN }} # ✅ correcto

# PROBLEMA: secret no llega al step
- name: debug secrets
  run: echo "secret length = ${#MY_SECRET}"  # muestra longitud, no el valor
  env:
    MY_SECRET: ${{ secrets.MY_SECRET }}
```

### Permisos del GITHUB_TOKEN
```yaml
# Si hay 403 en API calls o push — verificar permisos explícitamente
permissions:
  contents: write      # para git push
  pull-requests: write # para PR comments
  packages: write      # para ghcr.io push
  id-token: write      # para OIDC (AWS/Azure auth sin secrets)
```

## CACHE — diagnóstico y reparación

```yaml
- uses: actions/cache@v4
  id: cache-node
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-

# DIAGNÓSTICO: ver si el cache se restauró
- run: echo "Cache hit = ${{ steps.cache-node.outputs.cache-hit }}"

# PROBLEMA: restore-keys demasiado permisivo restaura cache stale
# Si npm install falla después de restaurar cache → cambiar restore-keys a key exacta

# BUST MANUAL: cambiar prefijo en key
key: ${{ runner.os }}-node-v2-${{ hashFiles('**/package-lock.json') }}
```

## WINDOWS RUNNER — PROBLEMAS ESPECÍFICOS

```yaml
# PROBLEMA: path separators — usa ${{ runner.os }} para condicionales
- run: echo "path"
  shell: bash           # usar bash explícito en Windows si el comando es POSIX

# PROBLEMA: CRLF en scripts checkeados en Windows
- uses: actions/checkout@v4
  with:
    eol: lf             # forzar LF en checkout

# PROBLEMA: PowerShell vs bash
- name: Windows step
  shell: pwsh           # PowerShell 7 (pwsh) vs shell: powershell (PS5)
  run: |
    $env:MY_VAR         # PS syntax, no $MY_VAR

# PROBLEMA: artifact path con backslash
- uses: actions/upload-artifact@v4
  with:
    path: dist/         # siempre forward slash, GitHub lo maneja
```

## MATRIX BUILDS — debugging eficiente

```yaml
strategy:
  fail-fast: false      # ver TODOS los fallos, no solo el primero
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [18, 20]

# Si solo falla una combinación:
# Actions → workflow run → filtrar por job name → ver esa combinación específica

# Debug una combinación localmente con act:
act -j test --matrix os:ubuntu-latest --matrix node:20
```

## ARTIFACTS — upload/download errors

```yaml
# Upload falla silenciosamente si el path no existe
- uses: actions/upload-artifact@v4
  with:
    name: test-results
    path: coverage/      # DEBE existir; añadir if-no-files-found: error
    if-no-files-found: error   # falla el step si no hay archivos

# Download en job posterior — requiere needs:
download-job:
  needs: [test-job]
  steps:
    - uses: actions/download-artifact@v4
      with:
        name: test-results
        path: ./downloaded/
```

## DEBUGGING LOCAL CON ACT

```bash
# Instalar act (simula GitHub Actions localmente)
# Windows: winget install nektos.act

# Ejecutar un workflow completo
act push

# Ejecutar un job específico
act -j build

# Con secrets locales
act -s MY_SECRET=value -s GITHUB_TOKEN=$(gh auth token)

# Ver qué runner image usará
act --list
```

## ERRORES FRECUENTES

| Error | Causa probable | Fix |
|---|---|---|
| `Error: Process completed with exit code 1` | El step falló sin mensaje claro | Ver raw logs del step específico |
| `Error: ENOENT: no such file or directory` | Artifact path no existe | Verificar `if-no-files-found: error` + que el step anterior generó el archivo |
| `Error: HttpError: Resource not accessible` | Permisos insuficientes del GITHUB_TOKEN | Añadir `permissions:` al job o workflow |
| `Warning: Cache not found` | Key no coincide | Verificar que `hashFiles()` apunta al archivo correcto |
| `Error: Input required and not supplied` | `with:` field requerido vacío | Revisar la acción usada — puede que el secret/var esté vacío |
| `fatal: could not read Password` | Checkout sin token | Usar `token: ${{ secrets.GITHUB_TOKEN }}` en actions/checkout |
| Timeout sin error claro | Job excede 6h (default) | Añadir `timeout-minutes: 30` al job |
