---
name: github-actions
description: GitHub Actions CI/CD workflows for mobile (React Native iOS/Android builds) and general CI pipelines. Activate when setting up GitHub Actions workflows, configuring CI/CD pipelines, working with GitHub artifacts, or automating builds via gh CLI and GitHub API.
kind: skill
tier: L1
category: devops
last_verified: 2026-05-03
tags: [github, actions]
token_est: 880
layer: L1-skills
---

# GitHub Actions Skill

Reusable GitHub Actions patterns for CI/CD pipelines, with focus on mobile builds and downloadable artifacts.

## Core Use Cases

- Building React Native apps for iOS simulators and Android emulators in the cloud
- Publishing artifacts retrievable via `gh` CLI or GitHub API
- Establishing CI workflows that generate simulator/emulator builds
- Automating deployments with GitOps patterns

## When to Apply

- Setting up CI workflows that generate mobile simulator/emulator artifacts
- Uploading iOS and Android installables from pull requests or manual trigger runs
- Transitioning from local development builds to cloud-based downloadable artifacts
- Requiring consistent artifact identifiers for automated retrieval

## Workflow Patterns

### Basic CI Pipeline

```yaml
name: CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test
      - run: npm run build
```

### Mobile Build (Android)

```yaml
android-build:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-java@v4
      with:
        java-version: '17'
        distribution: 'temurin'
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
    - run: npm ci
    - name: Build APK
      run: |
        cd android
        ./gradlew assembleRelease
    - name: Upload APK
      uses: actions/upload-artifact@v4
      id: upload-apk
      with:
        name: app-release-${{ github.run_id }}
        path: android/app/build/outputs/apk/release/app-release.apk
    - name: Output artifact ID
      run: echo "Artifact ID ${{ steps.upload-apk.outputs.artifact-id }}"
```

### Artifact Download

```bash
# Download via gh CLI
gh run download <run-id> --name <artifact-name>

# Download via GitHub REST API
curl -L \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip" \
  -o artifact.zip
```

### Secrets Management

```yaml
# In workflow — never hardcode secrets
env:
  API_KEY: ${{ secrets.API_KEY }}
  DATABASE_URL: ${{ secrets.DATABASE_URL }}

# For environment-specific secrets
environment: production
```

### Matrix Strategy

```yaml
strategy:
  matrix:
    node-version: [18, 20, 22]
    os: [ubuntu-latest, windows-latest]
  fail-fast: false  # continue other matrix jobs if one fails
```

### Caching

```yaml
# npm cache
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-

# Gradle cache (Android)
- uses: actions/cache@v4
  with:
    path: |
      ~/.gradle/caches
      ~/.gradle/wrapper
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
```

## Source

Adapted from [callstackincubator/agent-skills github-actions](https://github.com/callstackincubator/agent-skills) (MIT) — Callstack GitHub Actions patterns.
