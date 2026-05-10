# Tortunabo — Backlog de Ideas (Abril 2026)
**Evaluado por ULTRON · 2026-04-15**
**Contexto:** 2 semanas de desarrollo, Claude al 100% para código. MVP: conexiones estables, fluido, sin lag.

---

## LEYENDA
- **Prioridad P1** — Hacer en semana 1. Core del MVP o alto impacto/bajo coste.
- **Prioridad P2** — Semana 2 si P1 completado. Enriquecen el juego.
- **Prioridad P3** — Solo si sobra tiempo. Nice-to-have o dependencias de otras features.
- **Dificultad:** EASY (< 2h) · MED (2-8h) · HARD (8h+) · VERY HARD (multisistema)

---

## BUGS ACTIVOS (resolver antes de continuar features)

| # | Bug | Dificultad | Notas |
|---|-----|-----------|-------|
| B1 | SpawnZone spawna Stamina Boost fantasma en el centro | EASY | El item spawna siempre en el centro del volumen, no se puede recoger. Probablemente el spawn point no está correctamente definido o el item se spawna sin overlap válido. Revisar `TN_ItemSpawnZone` → lógica de spawn position + colisión del item. |
| B2 | Cabeza snappea a 180° al girar (debería pasar por delante) | MED | Al llegar a yaw ±180 la cabeza salta instantáneamente al lado opuesto. Solución: detectar el cruce de 180° y forzar el giro por delante (anatómicamente correcto) con una rotación rápida interpolada en lugar de snap. Revisar la lógica de `LookAt` / `SetBoneRotation` / procedural head IK en `TortugaCharacter`. |
| B3 | Chunks destruidos cuando un cliente muere fuera de rango → error de replicación al respawnear | HARD | `CleanupChunks()` destruye el chunk que rodea al pawn muerto (hidden). Cliente pierde la réplica. Al revivir, el pawn está en una zona sin chunk → errores de replicación. **Fix**: en `CleanupChunks`, detectar si algún `DeadPlayerPawns` está dentro del chunk a destruir y teleportarlo a `NextSpawnTransform` antes de destruir. `TN_ChunkManager.cpp:382`. |
| B4 | Puerta: el personaje puede atravesarla (colisión rota en clientes) | MED | El actor de puerta no tiene `bReplicateMovement = true` o el Timeline/InterpTo corre solo en servidor. El cliente tiene la puerta en posición desincronizada → colisión no coincide. **Fix**: actor puerta necesita `bReplicates=true`, `bReplicateMovement=true` o `UPROPERTY(Replicated)` del ángulo + OnRep. |
| B5 | Pelota (objeto físico): se queda parada en cliente → teleporta a posición final | MED | Si el chunk tiene `SetReplicateMovement(false)` y la pelota es un ChildActor del chunk, hereda ese false. Cliente no recibe actualizaciones de transform → pelota inmóvil. Cuando la pelota para en servidor, llega la posición final de golpe. **Fix**: pelota actor con `bReplicateMovement=true` explícito; en clientes `SetSimulatePhysics(false)`. |
| B6 | Widget de fin de carrera no aparece en clientes (ServerTravel al lobby sí funciona) | MED | Probable BindWidget mismatch: `ResultsOverlay` en C++ con nombre diferente al widget en BP Designer → `ResultsOverlay == nullptr` → `ShowResultsPanel()` es no-op silencioso. O el PlayerController del espectador no tiene HUD activo. **Fix**: verificar nombre exacto en BP Designer. Añadir `UE_LOG` de diagnóstico en `ShowResultsPanel`. `TN_CoopFlowHUDWidget.cpp:274`. |
| B7 | Pantalla de victoria no aparece en clientes (confirmado tras morir+resucitar) | MED | Probable mismo root cause que B6. También posible: el jugador revivido vuelve a Playing state pero si muere de nuevo y entra en espectador, el HUD puede ser destruido/ocultado antes de que llegue el estado Results. **Fix**: verificar que el HUD widget persiste en modo espectador. Confirmar si falla también en flujo normal sin muerte. |
| B8 | Replicación de objetos móviles (puerta) incorrecta tras muerte de cliente | MED | Al entrar en espectador, el actor de puerta puede perder relevancia para ese PC (ViewTarget cambia). Al revivir, UE solo envía deltas desde último estado conocido → puerta en posición incorrecta. **Fix**: `bAlwaysRelevant = true` en actor puerta. Relacionado con B4. |

---

## P1 — SEMANA 1 (Core MVP)

| # | Feature | Dificultad | Notas |
|---|---------|-----------|-------|
| 31 | Aumentar velocidad tormenta | EASY | Un float. Impacto inmediato en ritmo. |
| 3 | Barrita Energética (stamina full) | EASY | Una línea en TN_StaminaComponent. |
| 4 | Item Table refactor (variables compartidas) | MED | Deuda técnica que escala mal. Hacer primero. |
| 7 | Knockdown caída con momentum (sin ragdoll) | MED | LaunchCharacter(velocidad actual + impulso abajo) + bloquear input. CMC activo. Network-friendly. |
| 11 | Gaviota dinámica (aparece de repente, sigue, círculo se cierra) | HARD | Rediseño completo. Implementar ANTES que Sombrilla (#29) y BigHead (#2). Gaviota caca (#12) es un enemigo independiente — no depende de #11. |
| 26 | Cronómetro + puntuación + Supabase global | VERY HARD | Feature de retención clave. Dividir: cronómetro local → guardado → Supabase HTTP. |

---

## P2 — SEMANA 2 (Enriquecer juego)

| # | Feature | Dificultad | Notas |
|---|---------|-----------|-------|
| 1 | Stamina boost efecto negativo post-boost | EASY | Extensión del timer existente. |
| 25 | Mejorar botones (1/2 pulsados) | EASY | Contador + enum en actor botón. |
| 15 | Array de objetos en botones de interacción | EASY | Cambio de var única a TArray. |
| 17 | Zona lenta (afecta XYZ + vuelo) | EASY | MaxWalkSpeed + JumpZVelocity + GravityScale. |
| 21 | Plataforma rompible | EASY | Timer + shake + visibilidad replicada. |
| 27 | Coleccionables que dan puntuación | EASY | Depende del sistema de puntuación (P1 #26). |
| 2 | Big Head + gaviota = segunda oportunidad + mareo | MED | Depende de #11. Hook en sistema de daño. |
| 5 | Tótem (respawn compañero muerto) | MED | Inversión del flujo MarkPlayerDead. |
| 6 | Cáscara de plátano (knockea + desliza) | MED | Overlap + knockdown + launch velocity. |
| 12 | Gaviota caca — sombra cae desde arriba, mata en punto de impacto | MED | Independiente de #11. Spawn aleatorio + timer. |
| 13 | Tinta de calamar (mancha pantalla) | MED | Proyectil + Post Process client-side. |
| 14 | DeathZone scripted con array de acciones | MED | Interface o struct con enum de acción. |
| 19 | Tormenta de arena (Post Process + Niagara) | MED | Assets Niagara + material PP. |
| 20 | Puentes que se rompen con X jugadores | MED | Overlap count replicado + destrucción. |
| 22 | Concha (trampa + item) | MED | Dual-mode: trampa pasiva + item activo. |
| 23 | Objetos con físicas empujables | MED | PhysicsReplication en red — gestionar autoridad. |
| 24 | Gestor multi-botón → transform array | MED | Observer pattern entre botones y gestor. |
| 28 | Objetos recogibles a zona (gestor de recogida) | MED | Tracking de depósitos replicado. |
| 29 | Sombrilla (protege de gaviota) | MED | Depende de #11. Comprobación inmunidad en sistema gaviota. |
| 30 | Placas (100% vivos encima) | MED | Conteo vivos + overlaps por placa. |
| 10 | Cangrejo (patrol + persecución + animación) | HARD | AI básica + animación + replicación. |
| 16 | Arena movediza (hunde + atasca) | HARD | No tocar CMC directamente — flag replicado + override local. |
| 18 | Quad (coche gigante con franjas mortales) | HARD | Spline/lerp + audio anticipación + timing red. |

---

## P3 — SOLO SI SOBRA TIEMPO

| # | Feature | Dificultad | Notas |
|---|---------|-----------|-------|
| 8 | Arpón | HARD | Cable Component + lógica enganche multi-target. |
| 9 | Charcos de pesca | MED | Bloqueado por: Arpón (#8). |
| 32 | UI de skins | MED | Integración TN_CosmeticSaveGame. |

---

## RIESGOS IDENTIFICADOS

1. **Knockdown (#7)**: LaunchCharacter — asegurar que `OnLanded` no interfiere con gameplay. Timer máximo de seguridad si knockdown ocurre en el aire. **NO usar ragdoll/SimulatePhysics** — CMC debe permanecer activo.
2. **Gaviota dinámica (#11)**: Implementar ANTES que Sombrilla (#29) y Big Head (#2) — ambos dependen de ella.
3. **Cronómetro + Supabase (#26)**: Evaluar BP HTTP nodes antes de C++ para prototipar rápido. La integración C++ requiere HTTP requests manuales o plugin.
4. **Objetos con físicas (#23)**: Limitar a objetos decorativos o baja frecuencia de interacción para el MVP.
5. **Arena movediza (#16)**: No tocar el CMC directamente — usar flag replicado + override local para evitar desincronías en red.

---

## ORDEN DE IMPLEMENTACIÓN SUGERIDO (semana 1)

```
Día 1:    #31 + #3  — calentamiento (ambos triviales)
Día 2-3:  #4        — refactor Item Table (base técnica para todos los items)
Día 4-5:  #7        — knockdown con momentum (LaunchCharacter, sin ragdoll)
Día 6-7:  #11       — gaviota dinámica (implementar antes que sus dependencias)
Día 8-10: #26       — cronómetro → puntuación → Supabase (dividir en 3 subpasos)
```
