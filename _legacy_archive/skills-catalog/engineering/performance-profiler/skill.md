---
name: performance-profiler
description: >
  Profiling sistemático de rendimiento para Node.js, Python, C++/UE5, y web.
  Activar cuando: lento · bottleneck · framerate bajo · memory leak · query N+1 · bundle grande.
  Metodología: baseline → profile → fix → verify. Nunca optimizar sin medir primero.
kind: skill
tier: L1
category: engineering
last_verified: 2026-05-03
tags: [performance, profiler]
token_est: 781
layer: L1-skills
---

# Performance Profiler

## PRINCIPIO FUNDAMENTAL

**Mide antes de optimizar. Nunca.** Establece baseline antes de tocar nada.

```
BASELINE: P50, P95, P99 latency | RPS | error rate | memory usage | framerate
```

---

## FASE 1 — BASELINE

Registrar métricas actuales antes de cualquier cambio:
- APIs/backend: latencia (ms), throughput (req/s), error rate (%)
- Frontend: LCP, FID, CLS, bundle size (KB), tiempo de carga
- UE5/C++: framerate (FPS), frame time (ms), memory (MB), draw calls
- Base de datos: query time (ms), N+1 count, índices usados/no usados

---

## FASE 2 — IDENTIFICAR BOTTLENECK

### Web / Node.js
- CPU flamegraph: py-spy (Python), clinic.js (Node), Chrome DevTools
- Memory: heap snapshots, `--expose-gc`, leak detection
- Bundle: webpack-bundle-analyzer, vite-bundle-visualizer

### Base de datos (Supabase/SQL)
- EXPLAIN ANALYZE en queries lentas
- Detectar: N+1 queries, SELECT *, resultados sin LIMIT, índices faltantes
- Índices compuestos para soft-delete: `WHERE deleted_at IS NULL AND user_id = ?`

### UE5 / C++
- Unreal Insights · stat unit · stat fps · profilegpu
- Detectar: tick excesivo, shadow draws, overdraw, GC pressure
- Physics: collision complexity, trace channels innecesarios

---

## QUICK WIN CHECKLIST

**Base de datos:**
- [ ] Índice faltante en columna de filtro frecuente
- [ ] N+1 → usar `select(..., { count: 'exact' })` o batch
- [ ] SELECT * → seleccionar solo columnas necesarias
- [ ] Resultados sin LIMIT en queries de listado

**Node.js / TypeScript:**
- [ ] I/O síncrono en path crítico → async/await
- [ ] Parseo repetido de JSON grande → cachear resultado
- [ ] Sin compresión gzip/brotli en respuestas
- [ ] Librería pesada → alternativa ligera (moment→dayjs, lodash→native)

**Frontend:**
- [ ] Componentes grandes sin lazy loading
- [ ] Imágenes sin optimizar (next/image, sharp)
- [ ] Re-renders innecesarios → memo, useMemo, useCallback
- [ ] Bundle principal > 200KB → code splitting

---

## FASE 3 — APLICAR FIX

Documentar cada optimización con este template:

```
PROBLEMA: [descripción del bottleneck]
CAUSA RAÍZ: [evidencia del profiler]
BASELINE: [métrica antes]
FIX: [cambio aplicado]
RESULTADO: [métrica después] (+X% mejora)
VERIFICADO CON: [load test / Insights / browser perf]
```

---

## FASE 4 — VERIFICAR

- Correr load test equivalente al baseline (k6, Artillery, Gatling)
- Verificar en datos de escala de producción (no datos de dev)
- Confirmar que el fix no degrada otras métricas
- Documentar en PROJECT.md o log de sesión

---

## REGLAS

- Sin medición → sin optimización (nunca)
- Optimizar el bottleneck real, no el que parece más obvio
- Una optimización a la vez → verificar → siguiente
- Si la mejora es <5% en producción real → no valió la pena
