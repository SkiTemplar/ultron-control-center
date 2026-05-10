---
name: Niasjka
type: project
updated: 2026-04-22
---

# Niasjka — PROJECT.md

## Objetivo
App PWA para el Club Gastronómico Niasjka. Gestión de temporadas, cenas, votaciones, rankings y socios. Lista para publicar con amigos reales.

## Stack
- **Framework:** Next.js 16 App Router (APIs distintas al Next.js conocido — leer docs en node_modules)
- **Lenguaje:** TypeScript
- **DB:** Supabase (Postgres + Auth + Storage)
- **Auth:** Supabase Auth con emails sintéticos `{player_id}@niasjka.internal`
- **UI:** Tailwind v4, paleta oscura (#09090e bg, #c8a96e gold, #f0e6d0 text)
- **Skill principal:** terry-davis

## Rutas
```
Proyecto:  C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\niajska
Branch:    main
```

## Estado actual (2026-04-22)
**Funciona:**
- Login / Register / RecoverPassword (GoTrue bug fix aplicado)
- Inicio: temporada activa, votación abierta, próxima cena, mi posición
- Temporada: calendario + ranking provisional
- Club: lista miembros (secretarios + socios)
- Perfil: básico (nombre, temporada actual, email, logout)
- Admin: overview, gestión temporada, activar/desactivar miembros, control votación
- PWA: service worker manual (next-pwa eliminado por incompatibilidad con App Router)

**Seed data en BD:**
- 12 jugadores mock + Admin (13 total)
- 4 temporadas: 2022/2023/2024 (closed), 2025 (active)
- season_players con rankings, cámara y presidentes en temporadas cerradas
- 30 cenas publicadas (10/temporada) + 7 publicadas + 1 open_voting + 2 scheduled en 2025

## Bugs resueltos
| ID | Bug | Fix |
|----|-----|-----|
| #B1 | GoTrue v2.188.1: admin.createUser deja columnas NULL → error en signIn | RPC `fix_user_null_strings` en public schema (SECURITY DEFINER) |
| #B2 | next-pwa v5 incompatible con App Router (genera contexto Pages Router) | Eliminado, service worker manual en public/sw.js |
| #B3 | Login fallaba con email @niajska.internal (typo: niajska → niasjka) | Corregido en auth.ts |

## Features pendientes (orden de implementación)

| # | Feature | Dificultad | Prioridad |
|---|---------|-----------|-----------|
| D | **Votación de jugadores** — UI para votar en cenas open_voting | MEDIUM | 1 — flujo core roto |
| C | **Hall of Fame** — sección para el amigo fallecido (is_memorial + memorial_text ya en BD) | EASY | 2 — emocionalmente importante |
| B | **Historial + Logros** — stats por temporada en perfil, títulos (presidente, mejor cena...) | MEDIUM | 3 |
| A | **Perfil: foto, contraseña, email** — Supabase Storage + formularios | MEDIUM | 4 |
| E | **Admin: Fondo + Multas** — gestión fund_transactions y fines | MEDIUM | 5 |

## Decisiones clave
- Auth con emails sintéticos para evitar validación de email real en un club privado
- Cámara = 3 peores jugadores de la temporada anterior, no participan como anfitriones
- Presidente = jugador con mayor puntuación al cierre de temporada
- Temporada: Sep–Jun (meses 9,10,11,12,1,2,3,4,5,6), 10 cenas, 1 por socio no-cámara
- `is_memorial` y `memorial_text` en players para Hall of Fame (ningún memorial en BD aún)
- RLS habilitado en todas las tablas

## Notas
- AGENTS.md avisa: "This is NOT the Next.js you know" — APIs pueden diferir del entrenamiento
- Paleta: bg `#09090e`, surface `#0d0c12`, border `#1e1c26`, gold `#c8a96e`, text `#f0e6d0`, muted `#4a4540`
- Font: Inter (body) + Playfair Display (títulos), variables CSS `--font-inter` / `--font-playfair`
