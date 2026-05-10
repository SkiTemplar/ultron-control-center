---
name: Tortunabo — Estado del Proyecto
type: project
updated: 2026-04-18
---

> ⚠️ **En Claude Code (CLI) esto ya no es la fuente de verdad.**
> La memoria project-specific vive en `~/.claude/projects/C--Users-USER-CARRERA-PROYECTOS-PERSONALES-Unreal-Engine-Tortunabo/memory/` — auto-cargada por Claude Code en cada sesión.
> Este archivo sigue siendo útil para **Claude Desktop** (donde ULTRON se lee con Desktop Commander).
> En Claude Code: leer `CLAUDE.md` del repo + auto-memory. No releer esto.


# Tortunabo — PROJECT.md

## Objetivo
Juego cooperativo multijugador 1-4 jugadores (tortugas antropomórficas). MVP en 2 semanas con Claude al 100%.
Meta MVP: conexiones estables, fluido, sin lag, jugable de inicio a fin.

## Stack
- **Engine:** Unreal Engine 5.6 (C++)
- **Red:** Steam Sockets / OnlineSubsystemSteam (SteamDevAppId=480 para testing)
- **Transporte:** Seamless Travel (NetDriver Steam permanece vivo entre mapas)
- **Build:** `TortunaboEditor Win64 Development`

## Rutas
```
Proyecto:   C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Unreal Engine\Tortunabo\
Source:     Source\Tortunabo\Private\ | Public\
Repo:       https://github.com/Unreal-portfolio/Tortunabo.git
Branch:     main (commits directos — sin PRs ni branches)
```

## Comando de build
```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" TortunaboEditor Win64 Development "C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Unreal Engine\Tortunabo\Tortunabo.uproject" -WaitMutex -NoHotReload
```
**CRÍTICO:** Nunca Live Coding ni Hot Reload en tests multijugador → NetChecksumMismatch.

## Flujo del juego
`Menu → HQ Lobby → Countdown → Cinematic → Run → Results → HQ`

## Estado actual — 2026-04-16 (verificado por subagentes)

### Bugs resueltos (todos)
| Bug | Fix | Commit |
|-----|-----|--------|
| #B1 SpawnZone ítems en centro | Ya estaba corregido (GetUnscaledBoxExtent) | previo |
| #B3 Chunks destruidos al morir | GetSafeReviveLocation + teleport antes de revivir | `167cf94` |
| #B4 Puerta phase-through | bAlwaysRelevant=true en TN_ButtonInteractable | `3db5389` |
| #B5 Pelota parada en cliente | TN_PhysicsObjectActor con dormancy automática | `3db5389` |
| #B6 Widget resultados no aparece | Delegate OnMatchFlowStateChanged binding | `f5c08d9` |
| #B7 Victoria no aparece tras revive | Mismo fix que #B6 | `f5c08d9` |
| #B8 Puerta incorrecta tras muerte | bAlwaysRelevant=true en TN_ButtonInteractable | `3db5389` |

### Bugs pendientes
*Todos los bugs resueltos* ✅ — confirmado por análisis directo de código (subagentes 2026-04-16)

### Features implementadas
| Task | Feature | Commit |
|------|---------|--------|
| #1 | Post-boost exhaustion (PostBoostExhaustionSeconds=2s) | `3db5389` |
| #3 | RestoreStaminaToFull() + pending BP pickup | `3db5389` |
| #15 | AdditionalMoveTargets[] en TN_ButtonInteractable | `3db5389` |
| #17 | bSlowFall + GravityScaleInZone en TN_SlowZoneVolume | `3db5389` |
| #21 | TN_BreakablePlatform (nueva clase) | `3db5389` |
| #31 | GrowthSpeed 80→150 en TN_StormVolume | `3db5389` |

### Pendiente en editor (requiere UE5 abierto)
| Task | Qué hacer |
|------|-----------|
| #B5 | Reparentar/crear BP hijo de TN_PhysicsObjectActor para la pelota |
| #3 | Crear BP_EnergyBarPickup hijo de ATN_PickupInteractableBase |
| #21 | Crear BP_BreakablePlatform hijo de TN_BreakablePlatform + VFX events |
| #17 | Activar bSlowFall en instancias de SlowZone que lo necesiten |

### Pendiente de testear (smoke tests multijugador PIE 2 players)
- #B3: Morir → avanzar chunks → revivir → sin errores de replicación
- #B4/#B8: Mover puerta → morir → revivir → puerta en posición correcta + sin phase-through
- #B5: Empujar pelota como cliente → movimiento en tiempo real sin snap
- #B6/#B7: Terminar carrera → pantalla resultados aparece en cliente
- #1/#3: Recoger barrita → stamina sube → penalización post-boost a los 2s
- #21: Plataforma rompible en multijugador

## Implementado esta sesión (2026-04-16)
| Task | Feature | Commit |
|------|---------|--------|
| #B2 | Head snap ±180° fix — LastHeadRawYaw para continuidad entre frames | `2a9580b` |
| #7 | Knockdown momentum — LaunchCharacter + bIsKnockedDown en Move() | `2a9580b` |
| #4 | Item Table refactor — PostBoostExhaustionSeconds, ThrowableLifeSpan, Sounds | `2a9580b` |
| #25 | Button multi-press — PressesRequired, CurrentPresses replicado | `2a9580b` |

## Backlog restante (solo estos 3 features sin implementar)
| Task | Feature | Dificultad |
|------|---------|-----------|
| #10 | Cangrejo (patrol + persecución + animación) | HARD |
| #16 | Arena movediza (hunde + atasca) | HARD |
| #18 | Quad (coche gigante con franjas mortales) | HARD |

## Pendiente Supabase
| Task | Feature | Dificultad |
|------|---------|-----------|
| #26 | HTTP Supabase para leaderboard global | VERY HARD — opcional para MVP |

## Clases C++ relevantes (nuevas esta sesión)
| Clase | Archivo | Descripción |
|-------|---------|-------------|
| ATN_PhysicsObjectActor | World/ | Actor físico: servidor simula, clientes reciben posición replicada, dormancy automática |
| ATN_BreakablePlatform | World/ | Plataforma rompible: server-auth, bBroken replicado, BP events para VFX |

## Guía de editor
Ver: `Docs/GUIA_EDITOR_SESION_20260415.md`
