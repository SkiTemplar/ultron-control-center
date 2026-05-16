# Entrega Memoria — Design Spec

**Fecha:** 2026-05-13
**Proyecto:** Tortunabo (UE 5.6, C++)
**Branch destino:** `entrega-memoria` (desde `main`, push standalone)
**Contexto:** Preparar el repo para la defensa académica T-Day. Producción del prototipo cerrada.

---

## 1. Objetivo

Dejar el repo en un estado presentable para que los profesores puedan:
- Leer las memorias académicas sin ruido de docs internos de agentes/IA.
- Abrir el código y entender qué hace cada archivo / clase pública.
- Compilar y abrir el proyecto siguiendo el `README.md`.

## 2. No-objetivos

- **No** cambiar lógica del juego ni mecánicas.
- **No** tocar `Content/`, `.uproject`, `Config/*.ini`, ni `Source/Tortunabo/Tortunabo.Build.cs`.
- **No** refactorizar código (renombrar, mover clases, extraer helpers).
- **No** mergear a `main` ni abrir PR — el branch queda standalone.
- **No** comitear el `.spec` en el repo del proyecto (vive en `~/.ultron/plans/specs/`).
- **🛡️ NO TOCAR `Docs/Memoria_T-Day.md`** — congelada byte-perfect, es la memoria principal de defensa. Ni edición de estilo, ni reformat.

## 3. Estado actual (snapshot)

- `main` con 2 untracked: `Docs/DayT_GDD_Final.pdf` (final PDF) y `Docs/LDD_Tortunabo.md` (LDD final).
- 74 headers (`.h`) + 69 implementaciones (`.cpp`) en `Source/Tortunabo/`.
- ~297 UFUNCTION públicas, ~372 funciones C++ adicionales, ~752 UPROPERTY.
- Doxygen parcial existente — inconsistente entre `///`, `/** */` y `//`.
- Docs/ mezcla académicos (`Memoria_*_T-Day.md`, GDD final, LDD) con internos (AgentSync, superpowers/plans, Logs, .obsidian) y WIP (TODO, MISSING_ASSETS, QA_TESTING, SISTEMA_SKINS, drafts).

## 4. Plan de trabajo (5 fases, 1 commit por fase)

### Fase 0 — Branch
```
git checkout -b entrega-memoria
```
Punto de partida limpio para revertir si algo se rompe.

### Fase 1 — Borrar docs internos/agentes (commit: `chore: borrar docs internos de agentes`)

Carpetas enteras:
- `Docs/AgentSync/`
- `Docs/superpowers/`
- `Docs/Logs/`
- `Docs/.obsidian/`
- `.claude/`

Archivos sueltos en root:
- `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`

### Fase 2 — Borrar docs WIP/legacy (commit: `chore: borrar docs legacy y WIP`)

- `Docs/SISTEMA_SKINS.md`
- `Docs/QA_TESTING.md`
- `Docs/MISSING_ASSETS.md`
- `Docs/TODO.md`
- `Docs/GDD_Tortunabo.md` (draft con `[POR DEFINIR]`, queda el PDF)
- `Docs/Memoria_Grupal.md` (legacy, queda `Memoria_T-Day.md`)
- `Docs/Memoria_Individual_JoseAntonio.md` (legacy, queda `_T-Day`)
- `GUIA_MONTAJE_INICIAL.md` (root, redundante con README)

### Fase 3 — Cleanup + doxygen híbrido (commits por dominio)

**Scope**: solo `Source/Tortunabo/**/*.{h,cpp}`.

**Reglas de cleanup**:
- Borrar bloques de código C++ comentado (líneas que son código, no prosa).
- Borrar `// TODO`, `// FIXME`, `// XXX`, `// HACK`, `// DEBUG`, `// TEMP`, `// !!!`, `// ???`.
- Mantener doxygen existente (`///`, `/** */`).
- Mantener comentarios de "porqué" no-obvio (network quirks, race conditions, workarounds) — críticos según el `CLAUDE.md` del proyecto.
- Mantener separadores tipo `// ── Section ──` (estructura visual).
- Mantener headers de licencia/copyright.

**Reglas de doxygen híbrido** (idioma: **español**):
- **UCLASS / USTRUCT / UENUM**: doxygen `/** @brief ... */` al cabecero de cada declaración si falta. Una frase de qué hace la clase.
- **UFUNCTION pública** (todas las marcadas con macro): doxygen completo (`@brief`, `@param` si aplica, `@return` si aplica, `@note`/`@warning` para detalles de replicación o thread safety).
- **Funciones C++ no triviales** (lógica de negocio, getters/setters complejos, virtuales overrides relevantes): doxygen.
- **UPROPERTY**: NO se tocan. El campo `Category=` ya las clasifica.
- **Functions triviales** (defaults de constructor, getters/setters simples): no añadir doxygen — sería ruido.

**Commits por dominio** (compilar `TortunaboEditor Win64 DebugGame` tras cada uno):
1. `docs(core): doxygen híbrido en Core/`
2. `docs(game): doxygen híbrido en Game/`
3. `docs(lobby+menu): doxygen híbrido en Lobby/ y Menu/`
4. `docs(player): doxygen híbrido en Player/`
5. `docs(world): doxygen híbrido en World/`
6. `docs(ui): doxygen híbrido en UI/`
7. `docs(voice+multiplayer): doxygen híbrido en Voice/ y Multiplayer/`

### Fase 4 — Inventario_Scripts.md (commit: `docs: añadir Inventario_Scripts.md`)

Ubicación: `Docs/Inventario_Scripts.md`.

Estructura: 1 sección por carpeta de `Source/Tortunabo/Public/`. Tabla con columnas `Archivo | Propósito | Autor`.

- **Archivo**: nombre del `.h`.
- **Propósito**: 1 frase extraída del doxygen UCLASS que añadimos en Fase 3.
- **Autor**: extracto de `git log --follow --format="%an" <file> | sort -u | tr '\n' ',' `.

Cobertura: **74 archivos `.h` completos** (todos).

### Fase 5 — README + verificación final (commit: `docs: simplificar README post-cleanup`)

- Revisar `README.md`: eliminar referencias a docs borrados (BACKLOG, AGENTS, CLAUDE, GUIA_MONTAJE_INICIAL).
- Añadir referencia a `Docs/Inventario_Scripts.md` y a las memorias.
- Compilación final: `TortunaboEditor Win64 DebugGame`.
- Smoke test: abrir el editor, verificar carga.

### Fase 6 — Push (commit: ya hecho, solo `git push -u origin entrega-memoria`)

Branch standalone en GitHub. `main` queda intacto.

## 5. Criterio de DONE

- Branch `entrega-memoria` con ~10 commits pushed a origin.
- `main` intacto.
- `git ls-files` en branch entrega: sin `AgentSync/`, sin `superpowers/`, sin `.claude/`, sin docs WIP listados arriba.
- `Docs/Inventario_Scripts.md` existe con 74 entradas distribuidas por carpeta.
- `Source/Tortunabo/**/*.h`: cada UCLASS tiene doxygen `@brief`, cada UFUNCTION pública tiene doxygen.
- `Build.bat TortunaboEditor Win64 DebugGame` retorna `BUILD: 0 errors, 0 warnings related to my changes`.
- Editor abre el proyecto sin errores rojos al cargar.

## 6. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Doxygen mal formateado rompe parsing en Rider/CLion | Validar visualmente en 1 archivo antes de aplicar al resto. |
| Borrar un comentario `//` que era documentación útil (heurística falla) | Modo conservador: si en duda, dejar. Mejor sobrar que faltar. |
| Romper build al borrar bloques de código comentado que en realidad eran `#if 0 ... #endif` semánticos | `grep -r "#if 0" Source/` antes de empezar; preservar `#if 0` literal. |
| Compañero José Antonio tiene cambios locales que perderá | Branch es independiente; main intacto. Sin riesgo para su rama. |
| Tokens explotan en doxygen de 297 UFUNCTION + 100s funciones | Commits por dominio: si llegamos al 50% del scope con buena cobertura, podemos parar y proseguir en otra sesión. |

## 7. Rollback

```
git checkout main             # volver al estado previo
git branch -D entrega-memoria # descartar
```
Si el push ya se hizo: `git push origin --delete entrega-memoria`.

## 8. Token budget estimado

- Fase 1+2 (borrados): ~5K tokens (operaciones masivas vía script).
- Fase 3 (doxygen 74 archivos): ~80-120K tokens (read + edit por archivo).
- Fase 4 (inventario): ~10K tokens (recolección + write).
- Fase 5 (README + verif): ~5K tokens.
- **Total estimado: ~120-150K tokens**. Margen amplio en sesión 1M.

## 9. Preguntas abiertas

Ninguna — todas las decisiones cerradas en el brainstorm:
- Branch standalone push ✓
- Cobertura inventario completa ✓
- Doxygen híbrido + español ✓
- Cleanup conservador ✓

---

**Aprobación esperada del usuario antes de empezar Fase 0.**
