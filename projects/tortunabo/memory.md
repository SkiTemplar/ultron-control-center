# Tortunabo — Memoria Técnica
**Mantenida por ULTRON + Don Claudio | Última actualización: 2026-04-24 (sesión ULTRA CONTRAST)**

---

## RUTAS CLAVE

```
Proyecto UE5:  C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Unreal Engine\Tortunabo\
Source C++:    Source\Tortunabo\Private\ y Public\
Logs editor:   Saved\Logs\
```

```powershell
# Compilar — IMPORTANTE: DebugGame (el editor carga ese DLL, NO Development)
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" TortunaboEditor Win64 DebugGame "C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Unreal Engine\Tortunabo\Tortunabo.uproject" -WaitMutex -NoHotReload
```
**CRÍTICO 2026-04-24**: Editor corre `UnrealEditor-Tortunabo-Win64-DebugGame.dll`. Build debe ser **DebugGame**. Development produce DLL distinto que el editor ignora → fixes invisibles. Síntoma: cambios no aparecen + `UE_LOG` vacío.

**NUNCA** usar Live Coding ni Hot Reload en tests multijugador → `NetChecksumMismatch`. Editor cerrado para build (Live Coding bloquea).

---

## ESTADO DE BUGS (actualizado 2026-04-18 — todos resueltos)

| Bug | Estado | Solución aplicada |
|-----|--------|-------------------|
| #B1 ItemSpawnZone posición | RESUELTO | `GetUnscaledBoxExtent()` para bbox sin escala |
| #B2 Cabeza snappea 180° | RESUELTO (2026-04-16) | `LastHeadRawYaw` para continuidad entre frames · commit `2a9580b` |
| #B3 Chunks al morir/revivir | RESUELTO | `GetSafeReviveLocation()` en ChunkManager, teleport a chunk activo antes de revivir |
| #B4 Puerta phase-through | RESUELTO | `bAlwaysRelevant=true` en `TN_ButtonInteractable` · commit `3db5389` |
| #B5 Pelota física teleporta | RESUELTO | Nueva clase `TN_PhysicsObjectActor` — servidor simula, clientes `SetSimulatePhysics(false)`, dormancy automática · commit `3db5389` |
| #B6 Widget resultados clientes | RESUELTO | Guard en ShowResultsPanel + IsValid check en delegate flow · commit `f5c08d9` |
| #B7 Pantalla victoria tras revive | RESUELTO | Parte del fix de #B6 · commit `f5c08d9` |
| #B8 Estado puerta post-muerte cliente | RESUELTO | Misma causa que #B4 — `bAlwaysRelevant=true` · commit `3db5389` |

---

## FEATURES IMPLEMENTADAS (sesión 2026-04-15)

| # | Feature | Clase C++ | Estado |
|---|---------|-----------|--------|
| #1 | Post-boost exhaustion penalty | `TN_StaminaComponent` (`PostBoostExhaustionSeconds`, `bPostBoostPenaltyActive`) | IMPLEMENTADA, pendiente test |
| #3 | RestoreStaminaToFull (energy bar pickup) | `TN_StaminaComponent::RestoreStaminaToFull()` + `bPostBoostPenaltyActive` reset | IMPLEMENTADA, pendiente BP hijo |
| #15 | Button multi-target | `TN_ButtonInteractable` (`AdditionalMoveTargets`, `AdditionalOriginalTransforms`, `AdditionalActivatedTransforms`) | IMPLEMENTADA |
| #17 | SlowZone con gravedad | `TN_SlowZoneVolume` (`bSlowFall`, `GravityScaleInZone`, `OriginalGravityScales`, `OnCharacterDestroyed`) | IMPLEMENTADA |
| #21 | Plataforma rompible | `TN_BreakablePlatform` — timer break+respawn, `bBroken` replicado, Multicast shake | IMPLEMENTADA, pendiente BP hijo |
| #31 | Storm más rápida | `TN_StormVolume::GrowthSpeed` 80→150 | IMPLEMENTADA |

---

## ARQUITECTURA DE RED — PATRONES CRÍTICOS

### Seamless Travel
- `bUseSeamlessTravel = true` — Steam NetDriver permanece vivo entre maps
- `PostLogin` NO se llama para jugadores que viajan — usar `HandleSeamlessTravelPlayer` / `PostSeamlessTravel`
- `PlayerControllers` y `PlayerStates` persisten. `Pawns` se destruyen antes del travel.

### OnRep en Listen-Server
- `OnRep_*` NO dispara en la máquina propietaria de la variable
- Solución: `BroadcastFlowStateChange()` en `TN_CoopGameState` fuerza el delegate manualmente en el host

### Autoridad
- `TN_ChunkManager` solo existe en servidor (`bReplicates = false`)
- Chunks spawneados con `SetReplicates(true)` → UE los envía automáticamente a clientes
- `TN_CoopGameState` es la única fuente de verdad para estado replicado del partido

### Dormancy para objetos físicos
- `NetDormancy = DORM_DormantAll` en constructor → 0 bytes en reposo
- `FlushNetDormancy()` al recibir golpe → inicia replicación
- Timer periódico (`DormancyCheckInterval`) verifica velocidad < umbral → `SetNetDormancy(DORM_DormantAll)`
- Clientes: `SetSimulatePhysics(false)` en BeginPlay — solo reciben posición del servidor

### Relevancia
- `bAlwaysRelevant = true` en actores cuyo estado el cliente necesita siempre, incluso tras morir
- Sin esto: si el cliente muere y el viewtarget cambia, el actor puede perder relevancia → estado replicado se pierde

---

## SISTEMA DE CHUNKS — TN_ChunkManager

### Spawn pattern (2 fases)
```
GetOrComputeInSocketTransform() → cachea InSocket offset por clase de BP
FinalTransform = InSocketTransform.Inverse() * TargetTransform
SpawnActor<>(ChunkClass, FinalTransform)  ← BeginPlay en posición correcta
SetReplicates(true), SetReplicateMovement(false)
```
**CRÍTICO**: No usar spawn-en-Identity + teleport — los Child Actors corren BeginPlay en (0,0,0)

### Child Actors en chunks
Deben diferir lógica que lea world position con `SetTimerForNextTick`.
Ejemplos: `TN_SeagullActor`, `TN_ButtonInteractable`, `TN_ItemSpawnZone`

### GetSafeReviveLocation
Expuesto para que `TN_RunGameMode::RevivePlayer` pueda teleportar el pawn muerto
a un chunk activo antes de restaurar la colisión. Evita que el pawn reaparezca en un chunk ya destruido.

---

## SISTEMA DE MUERTE Y RESPAWN

### Flujo de revive (post fix #B3)
```
RevivePlayer() →
  Obtener safe location vía TN_ChunkManager::GetSafeReviveLocation()
  Teleportar pawn hidden a esa location
  bIsEliminated = false, bIsAlive = true
  UnPossess() → Possess(Pawn) → ChangeState(Playing) → EnableInput
  Timer retry 10×0.1s para restaurar input en edge cases
```

---

## HUD — TN_CoopFlowHUDWidget

### ResultsOverlay
- `BindWidget` — nombre en BP Designer debe ser exactamente "ResultsOverlay"
- Guard añadido: `if (!ResultsOverlay) return;` con log warning
- IsValid check en delegate flow para evitar double-fire (#B6/#B7)

---

## CONVENCIONES DE TIMERS

- Usar `FTimerDelegate::BindUObject` (no lambdas) → `EndPlay → ClearAllTimersForObject` cancela correctamente
- Siempre añadir `EndPlay()` en clases con timer handles propios; llamar `ClearTimer(Handle)` antes de `Super::EndPlay`
- Handles separados para cada timer (no reusar el mismo handle para timers distintos)

---

## DROP ZONE QA — 2026-04-24 (SESIÓN ULTRA CONTRAST cerrada)

### Commits 24h (11 commits)
```
dd3abfe HEAD-NECK follow (NeckFollowBone + ratio UPROPERTY)
c063639 ROUND 3 force BeginPlay + diagnostic + ragdoll fall (blend weight 1.0 + gravity)
5841e1f SkinStatue silence GetSocketByName(None) warning
67a450c SlowZone AddDynamic → AddUniqueDynamic
93fa1a7 ROUND 2: ragdoll bPauseAnims + dash quat + kirk negate + sandwich + cam v2
e618163 HQ-WARN-01 safety net PostSeamlessTravel
3c9bb22 DASH-01 + EMOTE-01 + CAM-01 v1
ccd957c DEATH-01 Roblox death swap (timer → pickup en pos ragdoll)
951e59f ANIM-FIX guard PostEval durante ragdoll
ee3a5d0 CMC bPushesRigidBodies → bEnablePhysicsInteraction (UE5.6)
814b764 ANIM-02 physics push + BigHead + SKIN-01 + head pitch (pre-sesión)
```

### ✅ Fixed alta confianza
- Ragdoll NO cae → `SetAllBodiesPhysicsBlendWeight(1.f)` + `SetEnableGravity(true)` (sin esto física al 0%)
- Physics immovibles → `PushForceFactor=1.0` FORZADO en BeginPlay (bypass BP override)
- SlowZone ensure delegate, SkinStatue warning, CMC build break, DEATH-01 Roblox

### ⚠️ Necesita verificación con DLL DebugGame nuevo
Tests pendientes — `Saved/Logs/Tortunabo.log` debe tener líneas `[Diagnostic]`:
- Ragdoll glitch (bPauseAnims)
- Dash axis lateral (quat compose; log revela `DiveMeshDefaultRot`)
- Kirk knockdown invertido (negaciones + Pata LY→LZ)
- HQ-WARN-01 "fully simulated SkM" (safety net + BeginPlay reset)
- CAM-01 clipping suelo (ProbeSize=30 + floor clamp dual-channel)
- Cara cuello pegada → `NeckFollowBone`/`NeckFollowRatio` (configurar en BP)

### ❌ Problema arquitectónico
Kirk oculto si ragdoll activa: guard `IsSimulatingPhysics()` en `TN_ProcAnimInstance::NativePostEvaluateAnimation` suprime BoneQuat durante ragdoll. Necesita separar knockdown (pose manual) de death (ragdoll). 2h futuro si test confirma.

### Nuevos UPROPERTY tunables en BP_TortugaCharacter
- `Head Animation → NeckFollowBone` (FName, default NAME_None) — hueso cuello para arrastre skin
- `Head Animation → NeckFollowRatio` (0..1, default 0.3) — cuánto sigue el cuello

### Run|Death tunable en BP_RunGameMode
- `DeathRagdollDurationSeconds` (default 1.5s) — tiempo ragdoll antes del swap pickup

---

## SPRINT 3 DÍAS — 2026-04-24 → 2026-04-27

### Gap arquitectónico: item ↔ enemigo interactions
Pedido por USER: concha aturde enemigos, calamar ciega, bola aturde. **No existe** interface común. Plan día 2:
- `ITN_StunnableInterface` con `ApplyStun(Duration)` + `ApplyBlind(Duration)`
- Implementar en `ATN_EnemySeagull`, `ATN_CrabActor`, `ATN_JellyfishActor`
- Triggers: `TN_ConchPickup` overlap → stun · `TN_InkProjectile` hit → blind · `TN_ThrowableItemActor` hit → stun

### Enemigos C++ listos, pendiente asset/BP
- BP_EnemySeagull (mesh + decal material + sonidos + VFX)
- BP_CrabActor (SkeletalMesh + AnimBP + 4 montages + 4 sonidos)
- BP_QuadActor, BP_QuadSpawner, BP_JellyfishActor

### Plan día por día
- **Día 1**: test DLL DebugGame nuevo + copiar `[Diagnostic]` logs a Claude Code + asignar assets críticos BP
- **Día 2**: `ITN_StunnableInterface` + integrar en 3 items
- **Día 3**: features P2 alto ROI (#3 barrita, #29 sombrilla, #2 BigHead) + 2h test Steam real

### Riesgos
- Kirk refactor 2h si DLL nuevo no lo arregla
- Sin assets enemigos: pirateo Quixel/Sketchfab 1h
- PIE ≠ Steam real: reservar 2h día 3 test online con amigo

---

## MULTIPLAYER HEALTH (audit 2026-04-24)
92 refs Replicated/DOREPLIFETIME/RPC en 33 archivos. Sistemas validados en código: seamless travel, CoopGameState, knockdown/death replication, chunks, physics dormancy, ball multicast sim. Riesgos conocidos: VOIP WASAPI crash si teardown mal tiempo, OnRep no dispara en host (workaround activo), cosmetics race travel (retry timer activo). Sin test: 4 jugadores Steam real, reconnect.

---

## PENDIENTE (estado al 2026-04-18 — ver PROJECT.md para más detalle)

### Editor (requiere UE5 abierto)
1. Reparentar BP de la pelota a `TN_PhysicsObjectActor`
2. Crear `BP_EnergyBarPickup` hijo de `ATN_PickupInteractableBase` → OnPickedUp → `RestoreStaminaToFull()`
3. Crear `BP_BreakablePlatform` hijo de `TN_BreakablePlatform` → asignar mesh, implementar eventos VFX
4. Activar `bSlowFall` en instancias de SlowZone que lo necesiten

### Backlog restante (solo 3 features sin implementar)
- #10 Cangrejo — patrol + persecución + animación (HARD)
- #16 Arena movediza — hunde + atasca (HARD)
- #18 Quad — coche gigante con franjas mortales (HARD)

### Opcional para MVP
- #26 HTTP Supabase para leaderboard global (VERY HARD)
