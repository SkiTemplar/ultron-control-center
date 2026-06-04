---
name: react-native-perf
description: React Native performance optimization for FPS, TTI, bundle size, memory leaks, re-renders, and animations. Activate when debugging slow/janky UI, investigating memory leaks, optimizing startup time, reducing bundle size, or writing Turbo Modules.
kind: skill
tier: L1
category: mobile
last_verified: 2026-05-03
tags: [react, native, perf]
token_est: 1039
layer: L1-skills
---

# React Native Performance Skill

Performance optimization guide for React Native applications based on Callstack's "Ultimate Guide to React Native Optimization."

## Optimization Workflow

Always: **Measure → Optimize → Re-measure → Validate**

1. **Measure**: Capture baseline before changes. Prefer commit timeline, re-render counts, slow components.
2. **Optimize**: Apply targeted fix from relevant reference.
3. **Re-measure**: Same measurement after fix.
4. **Validate**: Confirm improvement (e.g., FPS 45→60, TTI 3.2s→1.8s).

If metrics did not improve, revert and try next fix.

## Priority-Ordered Guidelines

| Priority | Category | Impact |
|---|---|---|
| 1 | FPS & Re-renders | CRITICAL |
| 2 | Bundle Size | CRITICAL |
| 3 | TTI Optimization | HIGH |
| 4 | Native Performance | HIGH |
| 5 | Memory Management | MEDIUM-HIGH |
| 6 | Animations | MEDIUM |

## Critical: FPS & Re-renders

```bash
# Profile via React Native DevTools
# Press 'j' in Metro, or shake device → "Open DevTools"
```

Common fixes:
- Replace `ScrollView` with `FlatList`/`FlashList` for lists
- Use React Compiler for automatic memoization
- Use atomic state (Jotai/Zustand) to reduce re-renders
- Use `useDeferredValue` for expensive computations

```tsx
// Good: FlashList for long lists
import { FlashList } from "@shopify/flash-list"
<FlashList
  data={items}
  renderItem={({ item }) => <Item item={item} />}
  estimatedItemSize={80}
/>

// Good: atomic state
import { atom, useAtom } from 'jotai'
const countAtom = atom(0)
```

## Critical: Bundle Size

```bash
# Analyze bundle
npx react-native bundle \
  --entry-file index.js \
  --bundle-output output.js \
  --platform ios \
  --dev false --minify true

npx source-map-explorer output.js
```

Common fixes:
- Avoid barrel imports (import directly from source)
- Enable tree shaking (Expo SDK 52+ or Re.Pack)
- Enable R8 for Android native code shrinking

```typescript
// Bad: barrel import
import { Button, Input, Modal } from '@ui-kit'

// Good: direct import
import Button from '@ui-kit/components/Button'
```

## High: TTI Optimization

```typescript
// Measure cold start
import { performance } from 'react-native-performance'
performance.mark('app_start')
// Later...
performance.measure('startup', 'app_start')
```

Common fixes:
- Disable JS bundle compression on Android (enables Hermes mmap)
- Use native navigation (`react-native-screens`)
- Preload heavy screens before navigation

## High: Native Performance

```typescript
// Turbo Module pattern (v0.73+)
import { TurboModuleRegistry } from 'react-native'
const NativeModule = TurboModuleRegistry.getEnforcing('MyModule')

// Always async for heavy work
NativeModule.heavyOperation(data).then(result => {
  // handle result
})
```

## Memory Management

```typescript
// Cancel subscriptions in cleanup
useEffect(() => {
  const subscription = eventEmitter.addListener('event', handler)
  return () => subscription.remove()  // CRITICAL cleanup
}, [])

// Avoid memory leaks in async ops
useEffect(() => {
  let cancelled = false
  fetchData().then(data => {
    if (!cancelled) setState(data)
  })
  return () => { cancelled = true }
}, [])
```

## Android 16KB Alignment

For Google Play submission, ensure third-party `.so` libraries are 16KB-aligned:
```bash
# Check alignment
readelf -S lib.so | grep LOAD
# LOAD entries must have Align: 0x4000 (16384)
```

## Review Guardrails

- Check library versions before suggesting API-specific fixes
- Do NOT suggest `useMemo`/`useCallback` without profiler evidence
- Do NOT report stale closures speculatively
- Profile the target interaction, not component tree depth

## Source

Based on [callstackincubator/agent-skills react-native-best-practices](https://github.com/callstackincubator/agent-skills) (MIT) — Callstack Ultimate Guide.
