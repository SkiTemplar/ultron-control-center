# Tortunabo — Log de Actividad
**Formato: fecha → qué se hizo → resultado**

---

## 2026-04-15 — Sesión inicial: backlog + análisis de bugs

### Contexto
Primera sesión de documentación formal de Tortunabo en ULTRON.

### Ejecutado
- Evaluados 32 ideas del GDD → backlog priorizado (P1/P2/P3) guardado en `backlog-ideas-abril2026.md`
- 2 bugs previos registrados: #B1 (SpawnZone fantasma), #B2 (head snap 180°)
- 6 nuevos bugs reportados por USER en testing multiplayer real:
  - #B3 Chunks destruidos al morir cliente
  - #B4 Puerta atravesable
  - #B5 Pelota física parada en cliente
  - #B6 Widget fin de carrera no aparece en clientes
  - #B7 Pantalla victoria no aparece tras morir+resucitar
  - #B8 Replicación de objetos móviles (puerta) tras muerte
- Don Claudio analizó código real: `TN_ChunkManager.cpp`, `TN_RunGameMode.cpp`, `TN_CoopFlowHUDWidget.cpp`
- Root causes identificados y soluciones concretas documentadas en `memory.md`

### Estado del proyecto
- Branch: `main` (commits directos — sin PRs)
- Último commit: `13a17b2 PLAN_DE_ACCION`
- Backlog actualizado en Claude memory y en ULTRON memory
- 8 bugs activos totales (#B1-#B8)
- Features P1: pendientes (ninguna implementada aún)

### Pendiente para próxima sesión
- Implementar fixes de bugs en orden: #B6/#B7 → #B5 → #B4/#B8 → #B3
- Empezar features P1 tras limpiar bugs críticos

---

## 2026-04-15 — Sesión 4: Post-agent fixes + EndPlay cleanup + memory sync

### Ejecutado (commit `0c7b0de` — pusheado a main)
- TN_BreakablePlatform: EndPlay añadido (clear 3 timer handles); fix crítico → ShakeTimerHandle era el mismo que BreakTimerHandle, shake nunca disparaba
- TN_ButtonInteractable: bIsMoving=false diferido hasta que TODOS los targets (primario + adicionales) convergen
- TN_SlowZoneVolume: OnCharacterDestroyed limpia maps sin tocar CMC al morir dentro de la zona → fix gravity leak
- TN_PhysicsObjectActor: EndPlay añadido (clear DormancyCheckTimer)
- memory.md de ULTRON: reescrita con estado actual real (eliminada análisis stale de bugs ya resueltos, fix path mokiu→USER)

### Estado de bugs: TODOS RESUELTOS excepto #B2 (head snap)
### Próximo paso: compilar + pasos en editor + smoke tests

---

## 2026-04-15 — Sesión 3: Bugs restantes + Easy tasks batch + push

### Ejecutado
- Diagnóstico: build compilaba, bugs #B3/#B6/#B7 ya resueltos en sesión 2
- Discutido estándar de replicación para física (dormancy) y puertas (estado vs transform)
- Corregido path del proyecto (era `mokiu`, es `USER\CARRERA\PROYECTOS_PERSONALES\...`)

### Implementado C++ (commit `3db5389` — pusheado a main)
| Archivo | Cambio | Task |
|---------|--------|------|
| TN_ButtonInteractable.cpp | bAlwaysRelevant=true | #B4/#B8 |
| TN_PhysicsObjectActor.h/.cpp | Nueva clase: física replicada + dormancy | #B5 |
| TN_StaminaComponent.h/.cpp | RestoreStaminaToFull() + PostBoostExhaustionSeconds | #3 #1 |
| TN_ButtonInteractable.h/.cpp | AdditionalMoveTargets[] array | #15 |
| TN_SlowZoneVolume.h/.cpp | bSlowFall + GravityScaleInZone | #17 |
| TN_BreakablePlatform.h/.cpp | Nueva clase: plataforma rompible | #21 |
| TN_StormVolume.h | GrowthSpeed 80→150 | #31 |
| Docs/GUIA_EDITOR_SESION_20260415.md | Guía paso a paso para editor | — |

### Diagnóstico de paquetes
Build.cs correcto — Engine cubre todos los módulos de las nuevas clases. Sin cambios necesarios.

### Pendiente (próxima sesión)
1. Compilar con el build command correcto
2. Pasos en editor: BP_EnergyBarPickup, BP_BreakablePlatform, reparentar pelota
3. Smoke tests multijugador (ver PROJECT.md)
4. Continuar P1: #4 Item Table refactor → #7 Knockdown → #11 Gaviota

---

## 2026-04-15 — Sesión 2: Plan de bugs + implementación C++ (subagent-driven)

### Ejecutado
- Plan escrito: `Docs/superpowers/plans/2026-04-15-bugfix-replication-chunks-physics-widget.md`
- 7 commits entregados en main:

| Commit | Qué | Bug |
|--------|-----|-----|
| `a54bd8d` | Delegate binding `OnMatchFlowStateChanged` en widget HUD | #B6/#B7 |
| `f5c08d9` | Double-fire guard + `IsValid` en unbind del delegate | #B6/#B7 |
| `375ec87` | `GetSafeReviveLocation()` expuesto en `ATN_ChunkManager` | #B3 |
| `e74a86c` | Doc fix del getter (comentario correcto) | #B3 |
| `167cf94` | Teleport pawn muerto a zona segura en `RevivePlayer` | #B3 |
| `d1137fa` | Limpieza de logs de diagnóstico | cleanup |

### TODO PARA MAÑANA — OBLIGATORIO ANTES DE CONTINUAR

#### 1. COMPILAR (primer paso, sin esto nada funciona)
```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" TortunaboEditor Win64 Development "C:\Users\mokiu\Documents\Unreal Projects\Tortunabo\Tortunabo.uproject" -WaitMutex -NoHotReload
```

#### 2. Task 5 — BP Editor: Pelota física (#B5)
Abrir BP actor pelota en Content Browser:
- Class Defaults → `Replicates = true`, `Replicate Movement = true`
- Event BeginPlay → Switch Has Authority → Remote → `SetSimulatePhysics(false)`
- Compile + Save

#### 3. Task 6 — BP Editor: Puerta (#B4/#B8)
Abrir BP actor puerta:
- Class Defaults → `Replicates = true`, `Replicate Movement = true`, `Always Relevant = true`, `Net Update Frequency = 30`
- Timeline → Switch Has Authority → ejecutar solo en Authority
- Compile + Save

#### 4. SMOKE TESTS (con 2 jugadores en Standalone)
- [#B6/#B7] Completar carrera → verificar pantalla resultados en cliente
- [#B6/#B7] Morir + revivir + carrera acaba → verificar pantalla en cliente
- [#B3] Morir en chunk temprano → líder avanza 4+ chunks → revivir → sin errores en Output Log
- [#B5] Empujar pelota → verificar que se mueve sincrónicamente en cliente (sin snap)
- [#B4] Abrir puerta → verificar que personaje no la atraviesa en cliente
- [#B8] Morir → puerta se mueve → revivir → verificar puerta en posición correcta

#### 5. CONTINUAR CON FEATURES P1 (tras confirmar bugs resueltos)
Orden sugerido (del backlog):
- #31 Aumentar velocidad tormenta (EASY — 1 float)
- #3 Barrita Energética stamina full (EASY — 1 línea)
- #4 Item Table refactor (MED — base técnica para todo lo demás)

---

## 2026-04-18 — Sesión 7 bug fixes + QA docs

### Ejecutado
- 7 bugs fixeados: head latch, throwable replication, conch trap, camera spring arm, ink mesh, chunks relevance, pickup fantasma
- Patrones UE5 consolidados en memory.md
- QA_TESTING.md creado con casillas de smoke tests multijugador
- Auditoría de BPs pendientes documentada en MISSING_ASSETS.md

### Commits relevantes
- Múltiples fixes en una sesión (ver SESSION_LOG.md del repo)

### Estado
- bAlwaysRelevant en chunks + throwable + fixes de dormancy estabilizados
- Test Coverage: checklist creado pero sin ejecutar aún
- Benchmark: 7.3/10

---

## 2026-04-21 — Ball replication resuelto + Umbrella/Totem completos + crash host eliminado

### Ejecutado (4 commits: d9556f7 → 6c13a11 → 6ce76fa → f400401)

**Bug chain bola (TN_ThrowableItemActor) — RESUELTO:**
1. `d9556f7`: `IgnoreInstigatorCollision` sin `HasAuthority()` — PM cliente ya no congela bola en frame 0
2. `6c13a11`: Primer intento con `SetReplicateMovement(true)` — superado en siguiente commit
3. `6ce76fa`: Arquitectura definitiva **Multicast-simulation** — todas las máquinas reciben `Origin+Velocity+Mesh+Scale` y simulan PM localmente. `bReplicateMovement=false`, `NetUpdateFrequency=2`, `bAlwaysRelevant=true`. `Multicast_BallStopped` sincroniza posición final antes de Destroy
4. `f400401`: Crash host eliminado — `Multicast_BallStopped` retorna inmediatamente en servidor; clientes usan `SetActive(false)+Velocity=Zero` en lugar de `StopSimulating()` (evita recursión infinita en delegate)

**Features completadas (commit 6ce76fa):**
- `TN_UmbrellaInteractable`: UPROPERTY SoundOpen/Close/VFXOpen/Close; BIE opcionales OnUmbrellaOpened/Closed
- `TN_TotemInteractable`: UPROPERTY SoundActivate/NoTarget/VFXActivate; auto-revive en MarkPlayerDead; uso manual desde inventario
- `TortugaCharacter`: TotemSelfReviveSound/VFX + OnTotemAutoRevive BIE + Multicast_OnTotemAutoRevive
- `TN_InventoryComponent`: TryConsumeItemByUseType + ETN_ItemUseType::Totem
- Seagull shapes: BodyMesh=Cone, SeagullMesh=Cylinder, DroppingMesh=Sphere

### Patrones aprendidos (guardados en memory.md CC + .ultron)
- Multicast-simulation para proyectiles replicados (no ReplicateMovement)
- IgnoreInstigatorCollision debe llamarse sin HasAuthority() en todas las máquinas
- Nunca llamar StopSimulating() desde callback de OnProjectileStop — usar SetActive(false)

### Pendiente editor/BP
- `BP_UmbrellaInteractable` Class Defaults: SoundOpen/Close, VFXOpen/Close
- `BP_TotemInteractable` Class Defaults: SoundActivate, SoundNoTarget, VFXActivate
- `BP_TortugaCharacter` Class Defaults: TotemSelfReviveSound, TotemSelfReviveVFX

### Benchmark: 7.7/10 ↑ (vs 7.3)
