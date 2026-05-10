# TORTUNABO — Catálogo Sandbox de Actores
## Referencia de Diseño de Niveles · v1.0 · 2026-04-18

> **Propósito:** Inventario completo de TODO lo colocable en un nivel. Diseñadores consultan este doc para construir niveles y el mapa demo `LVL_Sandbox`.
> **Fuente de verdad:** `Source/Tortunabo/Public/World/` + headers C++. Si un valor aquí diverge del C++, manda el C++.
> **Convención rutas BP:** `/Game/Blueprints/Gameplay/...`

---

## Índice
1. [Characters](#1-characters)
2. [Enemies](#2-enemies)
3. [Hazards & Volumes](#3-hazards--volumes)
4. [Interactables](#4-interactables)
5. [Items & Pickups](#5-items--pickups)
6. [Spawners](#6-spawners)
7. [Chunks & Level Streaming](#7-chunks--level-streaming)
8. [Cosmetic Statues](#8-cosmetic-statues)
9. [Game Modes & Flow](#9-game-modes--flow)
10. [Widgets](#10-widgets)
11. [Deprecated](#11-deprecated)
12. [Receta del mapa `LVL_Sandbox`](#12-receta-del-mapa-lvl_sandbox)

---

## 1. Characters

### BP_TortugaCharacter
- **C++:** `ATortugaCharacter` (`Player/TortugaCharacter.h`)
- **BP:** `Characters/BP_TortugaCharacter`
- **Rol:** Pawn controlable 1-4 jugadores coop. Third-person, spring arm OTS.
- **Componentes clave:** `TN_StaminaComponent`, `TN_InventoryComponent`, `ProximityVoiceComponent`.
- **Replicación:** Full replicated (position, rotation, IsSprinting, IsKnockedDown).
- **Placement:** NO se coloca a mano — lo spawnea el `GameMode` en `PlayerStart`.

---

## 2. Enemies

### BP_CrabActor (🦀 Cangrejo)
- **C++:** `ATN_CrabActor` · **BP:** `Enemies/Crabs/BP_CrabActor`
- **Rol:** Patrulla relativa + detecta al jugador más cercano dentro de radio + embiste causando knockdown.
- **UPROPERTYs clave:** `PatrolRadius`, `ChaseSpeed`, `DetectionRange`, `KnockdownForce`, `AttackCooldown`.
- **Replicación:** Server authoritative, Replicated.
- **Placement:**
  - Standalone → usar `BP_CrabSpawnZone` (recomendado).
  - Directo en el nivel → funciona pero sin respawn.
  - En chunk BP → funciona (defiere BeginPlay 1 tick).
- **Backlog:** Enemigo 1 (P1).

### BP_EnemySeagull (🪿 Gaviota persecutora)
- **C++:** `ATN_EnemySeagull` · **BP:** `Enemies/Seagulls/BP_EnemySeagull`
- **Rol:** Gaviota que sigue al `TargetPlayer` con un decal de sombra + suelta cacas periódicas.
- **UPROPERTYs clave:** `FlightHeight`, `FollowSpeed`, `DropInterval`, `DroppingClass`, `ShadowDecalMaterial`.
- **Replicación:** Server authoritative, Replicated.
- **Placement:** NO colocar standalone — debe venir de `BP_SeagullSpawnZone` que elige target al spawnear.
- **Backlog:** Enemigo 11 (P2 HARD).

### BP_SeagullDropping (💩 Caca)
- **C++:** `ATN_SeagullDroppingActor` · **BP:** `Enemies/Seagulls/BP_SeagullDropping`
- **Rol:** Proyectil de caída vertical a `FallSpeed`. Al impactar: daño/knockdown.
- **UPROPERTYs clave:** `FallSpeed`, `ImpactRadius`, `bKnockdownOnHit`.
- **Replicación:** Replicated (la trayectoria se ve en clientes).
- **Placement:** NO manual — lo spawnean `EnemySeagull` y `DroppingSpawnZone`.
- **Backlog:** Enemigo 12.

### BP_QuadActor (🏍️ Quad gigante)
- **C++:** `ATN_QuadActor` · **BP:** `Enemies/Quads/BP_QuadActor`
- **Rol:** Vehículo que viaja en línea recta; ruedas son trigger de muerte instantánea.
- **UPROPERTYs clave:** `TravelSpeed`, `TravelDirection`, `WheelKillRadius`, `LifeTimeSeconds`.
- **Replicación:** Replicated (movimiento visible en clientes).
- **Placement:**
  - Standalone → viaja y muere — útil para tests puntuales.
  - Vía `BP_QuadSpawner` → loop periódico (recomendado en nivel real).

---

## 3. Hazards & Volumes

### BP_BananaPeel (🍌 Piel de plátano)
- **C++:** `ATN_BananaPeel` · **BP:** `Hazards/BP_BananaPeel`
- **Rol:** Trampa pasiva. Al pisarla: `ApplyKnockdown()` + `LaunchCharacter` hacia arriba. Se destruye sin respawn.
- **UPROPERTYs clave:** `LaunchImpulseZ`, `LaunchImpulseXY`, `KnockdownDuration`.
- **Replicación:** Server destruye con `SetLifeSpan(0.2f)` para dar tiempo a la multicast de VFX/SFX.
- **Placement:** Directo en nivel o como ítem tirable (usar `BP_ConchPickup` como modelo de "trampa colocable").
- **Backlog:** #6 (P1 FÁCIL).

### BP_BreakablePlatform (💥 Plataforma que se rompe)
- **C++:** `ATN_BreakablePlatform` · **BP:** `Hazards/BP_BreakablePlatform`
- **Rol:** Plataforma que inicia timer `TimeToBreak` cuando un jugador la pisa. Al expirar: se rompe, el jugador cae. Respawn opcional.
- **UPROPERTYs clave:** `TimeToBreak` (default 1.5s), `bRespawns`, `RespawnDelay`, `WarningParticles`, `BreakSound`.
- **Replicación:** Replicated.
- **Placement:** Directo o como parte de un chunk.

### BP_DeathZoneVolume (☠️ Zona de muerte por countdown)
- **C++:** `ATN_DeathZoneVolume` (`AActor + UBoxComponent`, NO ATriggerVolume)
- **BP:** `Hazards/BP_DeathZoneVolume`
- **Rol:** Mata tras `DeathCountdown` segundos dentro. UI de countdown visible.
- **UPROPERTYs clave:** `DeathCountdown` (default 3s), `BoxExtent`.
- **Replicación:** Server authoritative.
- **Placement:** Directo o en chunk (compatible — inherita de AActor, no Brush).

### BP_QuicksandVolume (🏖️ Arenas movedizas)
- **C++:** `ATN_QuicksandVolume` · **BP:** `Hazards/BP_QuicksandVolume`
- **Rol:** Ralentiza + jugador se hunde visualmente + muere tras `SinkTime`.
- **UPROPERTYs clave:** `SinkTime`, `SinkDepth`, `MovementSpeedMultiplier`.
- **Replicación:** Server authoritative.
- **Placement:** Directo.

### BP_SlowZoneVolume (🐌 Zona lenta)
- **C++:** `ATN_SlowZoneVolume` · **BP:** `Hazards/BP_SlowZoneVolume`
- **Rol:** Limita `MaxWalkSpeed` localmente mientras se está dentro.
- **UPROPERTYs clave:** `SlowMultiplier` (0.0–1.0).
- **Replicación:** Local por cliente (se aplica al CharacterMovement del propio pawn).
- **Placement:** Directo. Útil combinarlo con charcos, barro visual, etc.

### BP_StormVolume (🌪️ Tormenta tipo Fortnite)
- **C++:** `ATN_StormVolume` · **BP:** `Hazards/BP_StormVolume`
- **Rol:** Área segura que se contrae. Fuera de ella: daño/muerte por tick.
- **UPROPERTYs clave:** `InitialRadius`, `FinalRadius`, `ShrinkDuration`, `DamagePerSecondOutside`, `TimeBeforeShrinkStarts`.
- **Replicación:** Replicated (todos deben ver la misma zona).
- **Placement:** Uno por nivel, centrado en el área jugable.

### BP_ScriptedDeathZone (🎬 Muerte scripted)
- **C++:** `ATN_ScriptedDeathZone` · **BP:** `Hazards/BP_ScriptedDeathZone`
- **Rol:** Mata con acciones scripted configurables (launch, ragdoll, fade, etc.). Usar para trampas "cinemáticas".
- **UPROPERTYs clave:** `ScriptedActions` (array configurable).
- **Placement:** Directo.

### BP_PhysicsObject (🪨 Objeto físico)
- **C++:** `ATN_PhysicsObjectActor` · **BP:** `Hazards/BP_PhysicsObject`
- **Rol:** Objeto con físicas full. Usa `DORM_DormantAll` + `FlushNetDormancy` al tocarlo para replicar solo cuando se mueve.
- **UPROPERTYs clave:** `Mass`, `StaticMesh`, `bDamagesPlayers`, `CollisionImpulseToKnockdown`.
- **Placement:** Directo. Rocas rodantes, bolas, troncos.

---

## 4. Interactables

### BP_ButtonInteractable (🟢 Botón)
- **C++:** `ATN_ButtonInteractable` · **BP:** `Interaction/BP_ButtonInteractable`
- **Rol:** Toggle con efecto personalizable. Mueve/rota objetos target mediante offset transform **relativo** al Actor (compatible chunks).
- **UPROPERTYs clave:** `bIsToggle`, `TargetOffsetTransform`, `TransitionTime`, `GroupManager` (opcional).
- **Replicación:** Server authoritative.
- **Placement:** Directo o en chunk.

### BP_ButtonGroupManager (🟢🟢 Manager de grupo de botones)
- **C++:** `ATN_ButtonGroupManager` · **BP:** `Interaction/BP_ButtonGroupManager`
- **Rol:** Detecta cuando TODOS los botones registrados están activados → dispara `OnAllButtonsActivated`.
- **UPROPERTYs clave:** `RegisteredButtons` (array), `bRequireSimultaneous`.
- **Placement:** Uno por puzzle de botones.

### BP_CollectionZone (📦 Zona de depósito)
- **C++:** `ATN_CollectionZone` · **BP:** `Interaction/BP_CollectionZone`
- **Rol:** Recibe ítems (`ScorePickup` o genérico), incrementa `DepositedCount`. Al llegar a `RequiredCount` → `OnGoalReached`.
- **UPROPERTYs clave:** `RequiredCount`, `AcceptedItemTag`.
- **Replicación:** Replicated (counter visible).
- **Placement:** Directo. Modo "recoge N items".
- **Backlog:** #28 (P2).

### BP_FinishLineVolume (🏁 Meta)
- **C++:** `ATN_FinishLineVolume` (`AActor + UBoxComponent`)
- **BP:** `Interaction/BP_FinishLineVolume`
- **Rol:** Marca `FinishRank` creciente para cada jugador que cruza.
- **UPROPERTYs clave:** `BoxExtent`.
- **Replicación:** Server authoritative.
- **Placement:** UNA por mapa de race. Al final del recorrido.

### BP_PressurePlate (⬜ Placa de presión)
- **C++:** `ATN_PressurePlate` · **BP:** `Interaction/BP_PressurePlate`
- **Rol:** Se activa con peso encima. Si está en un grupo: el manager detecta cuándo todas están activas.
- **UPROPERTYs clave:** `MinWeightToActivate`, `GroupManager` (opcional), `DeactivationDelay`.
- **Replicación:** Replicated.
- **Placement:** Directo.
- **Backlog:** #30 (P2).

### BP_PressurePlateGroupManager
- **C++:** `ATN_PressurePlateGroupManager` · **BP:** `Interaction/BP_PressurePlateGroupManager`
- **Rol:** Como `ButtonGroupManager` pero para placas. `OnAllPlatesActivated` → abrir puerta, etc.

### BP_TutorialEntryInteractable (🎓 Entrada al tutorial)
- **C++:** `ATN_TutorialEntryInteractable` · **BP:** `Interaction/BP_TutorialEntryInteractable`
- **Rol:** Teleport a `PlayerStart` con `PlayerStartTag="TutorialStart"`.
- **Placement:** En el HQ lobby, zona de tutorial.

### BP_UmbrellaInteractable (☂️ Paraguas)
- **C++:** `ATN_UmbrellaInteractable` · **BP:** `Interaction/BP_UmbrellaInteractable`
- **Rol:** Protección temporal contra cacas de gaviota / lluvia. Tiene cooldown.
- **UPROPERTYs clave:** `ProtectionDuration`, `Cooldown`, `ProtectionTypes`.
- **Replicación:** Server authoritative.
- **Backlog:** #29 (P2).

---

## 5. Items & Pickups

### BP_GenericPickup
- **C++:** `ATN_GenericPickup` · **BP:** `Items/BP_GenericPickup`
- **Rol:** Base class para pickups. Al interactuar: se guarda en `InventoryComponent`.
- **UPROPERTYs clave:** `ItemDataRow` (referencia a `DT_Items`), `PickupMesh`, `WeightCategory`.

### BP_GenericThrowable
- **C++:** `ATN_ThrowableItemActor` · **BP:** `Items/BP_GenericThrowable`
- **Rol:** Base para ítems tirables. Se convierte en proyectil al usar desde inventario.
- **UPROPERTYs clave:** `ThrowForce`, `OnImpactAction`, `bDestroyOnImpact`.

### BP_ConchPickup (🐚 Caracola)
- **C++:** `ATN_ConchPickup` · **BP:** `Items/BP_ConchPickup`
- **Rol:** Dual-use — como ítem de inventario (ruido/aturdir) y como trampa pasiva colocable (flag `bIsPlacedTrap`).
- **Backlog:** #22.

### BP_InkProjectile (🦑 Tinta de calamar)
- **C++:** `ATN_InkProjectile` · **BP:** `Items/BP_InkProjectile`
- **Rol:** Proyectil que al impactar aplica ink blendable en la pantalla del jugador afectado (`MulticastApplyInkEffect`).
- **UPROPERTYs clave:** `InkDuration`, `InkIntensity`, `ProjectileSpeed`.
- **Backlog:** #13.

### BP_JellyfishActor (🪼 Medusa trampolín)
- **C++:** `ATN_JellyfishActor` · **BP:** `Items/BP_JellyfishActor`
- **Rol:** Esfera que rebota al jugador. `LaunchCharacter` con `bZOverride=true`.
- **UPROPERTYs clave:** `LaunchZVelocity`, `CooldownBetweenBounces`.
- **Placement:** Directo o en chunk. Útil para atajos verticales.

### BP_RescuePickup (❤️ Rescate)
- **C++:** `ATN_RescuePickup` · **BP:** `Items/BP_RescuePickup`
- **Rol:** Se spawnea automáticamente donde murió un jugador. Al interactuar: revive.
- **UPROPERTYs clave:** `RescueInteractionDuration`.
- **Placement:** NO manual — lo spawnea el GameMode en `MarkPlayerDead()`.

### BP_ScorePickup (🪙 Moneda/puntos)
- **C++:** `ATN_ScorePickup` · **BP:** `Items/BP_ScorePickup`
- **Rol:** Coleccionable. Al tocarlo suma al `RaceScore` del player state.
- **UPROPERTYs clave:** `ScoreValue`, `PickupVFX`.
- **Backlog:** #27.

### BP_ItemSpawnZone (🎁 Zona que genera ítems)
- **C++:** `ATN_ItemSpawnZone` · **BP:** `Items/BP_ItemSpawnZone`
- **Rol:** Spawnea ítems aleatorios de una pool validando que haya suelo debajo.
- **UPROPERTYs clave:** `ItemClassPool` (array), `SpawnInterval`, `MaxSimultaneousItems`, `GroundCheckDistance`.
- **Replicación:** Server authoritative.
- **Placement:** Directo o en chunk.

---

## 6. Spawners

### BP_CrabSpawnZone
- **C++:** `ATN_CrabSpawnZone` · **BP:** `Enemies/Crabs/BP_CrabSpawnZone`
- **Rol:** **One-shot, lazy spawn.** Cuando entra el primer jugador: spawnea 1-N cangrejos, luego se auto-destruye o queda dormida.
- **UPROPERTYs clave:** `CrabCount`, `SpawnRadius`, `CrabClass`.
- **Replicación:** Server only.
- **Backlog:** #10 (lazy spawn — P2).

### BP_SeagullSpawnZone
- **C++:** `ATN_SeagullSpawnZone` · **BP:** `Enemies/Seagulls/BP_SeagullSpawnZone`
- **Rol:** Server elige un jugador vivo aleatorio como target y spawnea `BP_EnemySeagull` siguiéndolo.
- **UPROPERTYs clave:** `SpawnInterval`, `MaxSimultaneousSeagulls`, `SeagullClass`.
- **Backlog:** #11.

### BP_DroppingSpawnZone
- **C++:** `ATN_DroppingSpawnZone` · **BP:** `Enemies/Seagulls/BP_DroppingSpawnZone`
- **Rol:** Spawn periódico de `BP_SeagullDropping` sobre jugadores (sin gaviota visible).
- **UPROPERTYs clave:** `DropInterval`, `DropCount`, `HeightAbovePlayer`.
- **Backlog:** #12.

### BP_QuadSpawner ✅ NECESARIO
- **C++:** `ATN_QuadSpawner` · **BP:** `Enemies/Quads/BP_QuadSpawner`
- **Rol:** **Server-only** (`bReplicates=false`). `SetTimer` → `SpawnQuad()` cada `SpawnInterval`. Sin este actor los quads no aparecen.
- **UPROPERTYs clave:** `SpawnInterval`, `QuadClass`, `SpawnLocation`, `TravelDirection`, `MaxSimultaneousQuads`.
- **Placement:** Uno por "carril" de quad.

---

## 7. Chunks & Level Streaming

### BP_ChunkManager
- **C++:** `ATN_ChunkManager` · **BP:** `Chunks/BP_ChunkManager`
- **Rol:** Genera el nivel procedural concatenando chunks con sockets. 3 tiers: Easy / Medium / Hard / Final.
- **UPROPERTYs clave:** `EasyChunkClasses`, `MediumChunkClasses`, `HardChunkClasses`, `FinalChunkClass`, `ChunkCounts`.
- **Placement:** UNO en el nivel de Run.

### Chunks disponibles
- `BP_Chunk_Easy_01`, `BP_Chunk_Easy_02`
- `BP_Chunk_Medium_02`, `BP_Chunk_Medium_03`
- `BP_Chunk_Hard`, `BP_Chunk_Hard_03`
- `BP_Chunk_Final`

**Regla crítica para actores dentro de chunks:** si leen posición mundial en `BeginPlay`, diferirlo 1 tick con `SetTimerForNextTick`. Ya implementado en: `SeagullActor`, `ButtonInteractable`, `ItemSpawnZone`.

---

## 8. Cosmetic Statues

### BP_HatStatue / BP_SkinStatue
- **C++:** `ATN_SkinStatueActor` (hat también hereda)
- **BP:** `Cosmetics/BP_HatStatue`, `Cosmetics/BP_SkinStatue`
- **Rol:** Estatuas en el HQ lobby. Al interactuar: equipan cosmético → se guarda en `TN_CosmeticSaveGame`.
- **UPROPERTYs clave:** `CosmeticId`, `DataTableRef` (DT_Helmets / DT_Skins).

---

## 9. Game Modes & Flow

| Mapa | BP GameMode | C++ |
|------|-------------|-----|
| `LVL_Menu` | `BP_MenuGameMode` | `AMP_MenuGameMode` |
| `LVL_HQ` | `BP_HQGameMode` | `ATN_HQGameMode` |
| `LVL_Run` | `BP_RunGameMode` | `ATN_RunGameMode` |

**Flujo completo:** `Menu → HQ Lobby → Countdown → Cinematic → Run → Finish/Spectate → Results → HQ`

---

## 10. Widgets

| Widget | Rol |
|--------|-----|
| `WBP_MainMenuWidget` | Menú principal (host/join/settings). |
| `WBP_LoadingScreenWidget` | Pantalla de carga entre mapas. |
| `WBP_CoopFlowHUDWidget` | **HUD maestro del Run** — muestra countdown, estado de carrera, spectate, resultados. Activo toda la race. |
| `WBP_PlayerHUDWidget` | HUD personal del pawn — stamina, ítem equipado, inventario. |
| `WBP_EmoteWheel` | Rueda de emotes (1 de 10). |
| `WBP_QuickChatWheel` | Rueda de quick chat preconfigurado. |
| `WBP_QuickChatFeedEntry` | Entrada individual en el feed de chat. |
| `WBP_VoiceIndicator` | Indicador VOIP (quién está hablando). |

---

## 11. Deprecated

### ❌ BP_SeagullActor
- **C++:** `ATN_SeagullActor` (@deprecated)
- **Reemplazo:** `BP_EnemySeagull` + `BP_SeagullSpawnZone`.
- **Acción:** NO usar. Mover a `_Deprecated/` y eliminar tras confirmar que ningún chunk lo referencia.

### ❌ BP_FinishLineVolume_DEPRECATED
- **Reemplazo:** `BP_FinishLineVolume` (nuevo, hereda de AActor+BoxComponent en vez de ATriggerVolume).
- **Acción:** Eliminable.

---

## 12. Receta del mapa `LVL_Sandbox`

Mapa horizontal dividido en zonas temáticas. PlayerStart al principio; cada zona es un "aula" donde una categoría entera está representada.

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ ZONA 0  PlayerStart + panel explicativo                                    │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 1  ENEMIGOS                                                           │
 │  ▸ 1 BP_CrabSpawnZone (CrabCount=2, SpawnRadius=400)                       │
 │  ▸ 1 BP_SeagullSpawnZone (SpawnInterval=8s)                                │
 │  ▸ 1 BP_DroppingSpawnZone (DropInterval=3s)                                │
 │  ▸ 1 BP_QuadSpawner (SpawnInterval=10s, carril recto)                      │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 2  HAZARDS / VOLÚMENES                                                │
 │  ▸ Fila de 3 BP_BananaPeel                                                 │
 │  ▸ 2 BP_BreakablePlatform (una bRespawns=true, otra false)                 │
 │  ▸ 1 BP_QuicksandVolume (SinkTime=4s)                                      │
 │  ▸ 1 BP_SlowZoneVolume (SlowMultiplier=0.4)                                │
 │  ▸ 1 BP_DeathZoneVolume (DeathCountdown=2s, señalizado)                    │
 │  ▸ 1 BP_ScriptedDeathZone (ejemplo: launch + fade)                         │
 │  ▸ 2 BP_PhysicsObject (una roca grande, un barril)                         │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 3  INTERACTABLES                                                      │
 │  ▸ Puzzle: 2 BP_ButtonInteractable + 1 BP_ButtonGroupManager               │
 │           → abren una puerta (target del grupo)                            │
 │  ▸ Puzzle: 3 BP_PressurePlate + 1 BP_PressurePlateGroupManager             │
 │  ▸ 1 BP_CollectionZone (RequiredCount=5)                                   │
 │  ▸ 1 BP_UmbrellaInteractable (Cooldown=20s)                                │
 │  ▸ 1 BP_TutorialEntryInteractable (ida y vuelta a zona tutorial)           │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 4  ITEMS                                                              │
 │  ▸ 1 BP_ItemSpawnZone con pool completa (Conch, Ink, Banana, Umbrella…)    │
 │  ▸ 5 BP_ScorePickup dispersas                                              │
 │  ▸ 3 BP_JellyfishActor (trampolines a plataformas altas)                   │
 │  ▸ 1 BP_ConchPickup como trampa colocable (bIsPlacedTrap=true)             │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 5  STORM (opcional)                                                   │
 │  ▸ 1 BP_StormVolume (InitialRadius=5000, FinalRadius=500, Shrink=60s)      │
 │    envuelve la zona entera — demuestra el sistema sin matar en tránsito    │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ZONA 6  COSMÉTICOS                                                         │
 │  ▸ 1 BP_HatStatue (DT_Helmets, CosmeticId de prueba)                       │
 │  ▸ 1 BP_SkinStatue                                                         │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ FIN     BP_FinishLineVolume + BP_ChunkManager DESACTIVADO                  │
 │         (sandbox no necesita generación procedural)                        │
 └────────────────────────────────────────────────────────────────────────────┘
```

**GameMode del sandbox:** duplicar `BP_RunGameMode` como `BP_SandboxGameMode` y deshabilitar:
- Countdown (arrancar directo)
- `LobbyExpectedPlayers` check (1 jugador vale)
- Finish logic (se puede cruzar la meta pero no cierra sesión)

**WorldSettings del mapa:** `GameMode Override = BP_SandboxGameMode`.

**PlayerStart:** uno al inicio, uno por zona con tag `"TeleportZone_N"` para debug rápido con comando de consola.

---

## Anexo A — Checklist para añadir un actor nuevo al catálogo

1. ¿Tiene header en `Source/Tortunabo/Public/`? → SÍ antes de documentar.
2. ¿Hereda de `AActor + UBoxComponent` o de `ATriggerVolume`? Si es lo segundo y va en chunks → **refactorizar** antes de usar.
3. ¿Lee posición mundial en `BeginPlay`? → debe diferir 1 tick con `SetTimerForNextTick`.
4. ¿Se replica? Documentar explícitamente: Server Authoritative, Replicated (all), Server Only, Local.
5. ¿Usa `SetLifeSpan(0.2f)` antes de destruirse? Confirmar si hay multicast VFX/SFX que deba ejecutarse.
6. Añadir entrada en este catálogo en la sección correcta.

---

*Catálogo v1.0 — 2026-04-18. Mantenido en `~/.ultron/projects/tortunabo/`. Última verificación de headers: sesión actual.*
