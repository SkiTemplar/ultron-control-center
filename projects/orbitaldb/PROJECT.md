---
name: OrbitalDB
type: project
updated: 2026-04-24
---

# OrbitalDB — PROJECT.md

## Objetivo
App Android (Kotlin) para el proyecto final de la asignatura Aplicaciones Móviles (UNIVERSITY). Consume la NASA Image & Video Library API para mostrar cuerpos celestes con un Observatorio personal gamificado. Entrega: ZIP + vídeo demo ~1 min grabado con OBS.

## Stack
- **Framework:** Android nativo (Kotlin)
- **API:** NASA Image & Video Library (`images-api.nasa.gov`) — sin API key
- **Red:** Retrofit 2 + Gson
- **Imágenes:** Glide 4
- **Auth:** Firebase Authentication (email/password) — **PENDIENTE SETUP**
- **DB local:** SQLiteOpenHelper
- **Nav:** Navigation Component + BottomNavigationView
- **UI:** Material Design 3, tema Dark Space (`#0A0E1A` bg / `#4FC3F7` cyan)
- **Skill principal:** terry-davis (código) + mike-tyson (UI)

## Rutas
```
Proyecto:  C:\Users\USER\CARRERA\ASIGNATURAS\AppMoviles\codigo\OrbitalDB
Plan:      docs/superpowers/plans/2026-04-24-orbitaldb-app.md
Apuntes:   APUNTES/ (PDFs de la asignatura + LINKS + ENUNCIADO)
```

## Estado actual
**FASE: DEFINIR — COMPLETO.** Plan de 11 tasks / 4 fases escrito y guardado.
Implementación NO iniciada. Proyecto Android Studio vacío (solo scaffold).

## Bugs pendientes
*(ninguno — proyecto no iniciado)*

## Features pendientes
| Task | Feature | Dificultad |
|------|---------|-----------|
| #1-2 | Gradle deps + tema Dark Space | EASY |
| #3-4 | Modelos NASA + Retrofit client | EASY |
| #5 | SQLite ObservatoryDbHelper | EASY |
| #6 | Firebase Auth + LoginActivity | MEDIUM (requiere setup externo) |
| #7 | MainActivity + Navigation | MEDIUM |
| #8 | ExplorerFragment RecyclerView | MEDIUM |
| #9 | DetailFragment | EASY |
| #10 | ObservatoryFragment + gamificación | MEDIUM |
| #11 | Prueba manual + pulido | EASY |

## Pendiente de testing
- [ ] Flujo login → explorador → detalle → observatorio
- [ ] Swipe-to-delete en observatorio
- [ ] Persistencia SQLite entre reinicios
- [ ] Carga de imágenes NASA con Glide
- [ ] Vídeo demo OBS (~1 min)

## Decisiones clave
- **API NASA elegida** sobre Le Système Solaire: más rico en imágenes y metadatos, perfecta para Glide
- **Observatorio gamificado** (no favoritos): barra progreso "X/30 cuerpos descubiertos" → motiva explorar
- **Firebase aplazado**: setup de google-services.json pendiente, no bloquea Phase 0-1-2
- **Retrofit sobre Volley**: ambos mencionados en el enunciado, Retrofit es más limpio con Kotlin
- **Fragments recomendados** por el enunciado → Navigation Component para gestión limpia

## Notas
- La API de clase está **vetada** por el enunciado — no usar bajo ningún concepto
- Entrega: `.ZIP` del proyecto + vídeo `nombre_apellido` grabado con OBS (no vídeo de móvil)
- Sin vídeo o sin requisitos → penalización 50%
- Si se aprueba el parcial y la práctica intermedia → no hace falta ir al examen
