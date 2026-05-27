# Kirkardo - Auditoria Frontend ULTRON Control Center

Fecha: 2026-05-26
Auditor: Kirkardo (profesor estricto)
Alcance: `C:\Users\USER\.ultron\control-center\src\` (React 19 + TS 5.8 + Tailwind 4 sobre Tauri 2)
Modo: lectura. No se ha modificado codigo.

## Rubrica (1-10)

| Dimension | Nota |
|---|---|
| Arquitectura de componentes | 5/10 |
| TypeScript types | 8/10 |
| Accesibilidad + UX | 4/10 |
| Consistencia de estilo | 4/10 |
| Performance | 5/10 |
| Tests / verificacion visual | 1/10 |
| **GLOBAL** | **4.5/10** |

---

### 1. Arquitectura de componentes - 5/10

Evidencias:
- `src/components/Projects.tsx:1` - 3594 lineas en un solo archivo. La regla global del usuario fija 800 max. Es 4.5x el limite.
- `src/components/Memory.tsx:1` - 1143 lineas, mezcla 4 sub-vistas (`StatusCard`, `MemoryStatusCards`, `Mem0Diagnostics`, `GraphifyControls`, `KgEditorPane`, `Mem0Pane`, `EccGraphPane`) y la raiz `Memory()` en un unico archivo (linea 1093).
- `src/components/Agents.tsx:222` - `renderCardGrid` se declara como funcion local dentro del componente, recreandose cada render, en vez de extraerlo a un componente memoizable. Bug en linea 137: `useEffect(..., [])` con `reload` faltando del array.

Workdays/ y Settings/ si demuestran que sabes hacerlo bien (separacion en `WorkdaysList`, `WorkdayDetail`, `WorkdayTemplates`). Projects.tsx se quedo como god-component.

Recomendaciones:
1. Trocear `Projects.tsx` en `projects/LauncherChips.tsx` (iconos + builtins, lineas 100-213), `projects/ProjectCard.tsx` (lineas 328-...) y `projects/ProjectsHome.tsx`. Objetivo: ningun archivo > 600 lineas.
2. En `Memory.tsx` extraer cada `*Pane` y `StatusCard` a `src/components/Memory/` (mismo patron que `Workdays/`).
3. `Agents.tsx:222` `renderCardGrid` debe ser `<AgentCardGrid items={...} onOpen={...}/>` con `React.memo` y key estable.

### 2. TypeScript types - 8/10

Evidencias:
- `tsconfig.json:18-21` strict + noUnused* activados. Bien.
- Todos los catches usan `catch (e: unknown)` (16 ocurrencias). Solo un `any` aparece y es texto de comentario (`Projects.tsx:1733`).
- `src/components/projects/ProjectTerminal.tsx:62-68` triple `as ProjectTerminalLayout` / `as PtySessionSummary[]` sobre `invoke()` cuyo retorno es `unknown`. Es valido pero pierde validacion runtime.

Recomendaciones:
1. Crear un helper tipado `invokeTyped<T>(cmd, schema): Promise<T>` con validacion (zod o codecs propios) para los comandos Tauri criticos (terminal layout, settings) en `lib/tauri.ts`.
2. Eliminar el comentario con palabra "any" en `Projects.tsx:1733` para no contaminar grep de auditorias.
3. `ProjectLite` aparece duplicado en `Workdays/WorkdayTemplates.tsx:15` y `Agents.tsx:21`. Centralizar en `src/types.ts`.

### 3. Accesibilidad + UX - 4/10

Evidencias:
- `Memory.tsx:1099`, `Agents.tsx:269,300,311`, `AIRouterIndex.tsx:284,332` - botones con `onClick` pero sin `type="button"`, sin `aria-label` y solo `title=` para los iconos.
- 0 `onKeyDown` / `tabIndex` en todo `components/` (grep). El drag handlers, los tabs y los kanban no son operables por teclado.
- `ProjectTerminal.tsx:419-431` el `<div onClick>` que actua como tab no tiene `role="tab"` ni `aria-selected`. El `<input>` inline rename si captura Enter/Escape (linea 441) - el unico ejemplo bien hecho.

Recomendaciones:
1. Anyadir `role="tab"` + `aria-selected` + `tabIndex={0}` + handler de flechas en `TabsBar` (ProjectTerminal:413) y en la barra de secciones `Settings/index.tsx:157`.
2. Sustituir todos los `<div onClick>` clicables por `<button type="button">` (mas barato que ARIA correcto). Especialmente en `Memory.tsx:1099` y `AIRouterIndex.tsx:305`.
3. Anyadir `aria-live="polite"` al banner de error global en `Settings/index.tsx:181` y al `batchToast` de `ProjectTerminal.tsx:337`, asi los lectores anuncian los fallos.

### 4. Consistencia de estilo - 4/10

Evidencias:
- 1632 ocurrencias de `style={{` en 75 archivos. Tailwind 4 esta configurado pero la mitad de los estilos siguen como CSS-in-JS inline.
- `Projects.tsx:142,159,176` colores hex literales (`#cc785c`, `#10a37f`, `#4285f4`) en lugar de tokens `var(--color-claude/codex/gemini)`.
- `AIRouterIndex.tsx:27-32` paleta CLASS_COLORS mezcla tokens `var(--color-success)` con literal `#a875ff`.

Recomendaciones:
1. Anyadir `--color-provider-claude/codex/gemini` y `--color-class-medium` a `styles.css` y migrar `Projects.tsx:135-186` y `AIRouterIndex.tsx:27` a tokens. Define las marcas como Tailwind classes (`@theme`) en Tailwind 4.
2. Reemplazar `style={{background: "var(--color-surface-2)", color: "var(--color-text)", border: "1px solid var(--color-border)"}}` (patron repetido ~80 veces) por un componente `<Surface variant="2">` o por una clase utility `card-surface`.
3. Lint regla: prohibir hex literales en JSX (eslint-plugin-no-hex o regex en `tsc` pre-commit).

### 5. Performance - 5/10

Evidencias:
- 0 `React.memo`, 0 `React.lazy` (solo 1 import de `Suspense` en `SecurityPanel.tsx:1`). Toda la app monta en el primer render.
- `Workdays/index.tsx:44-72` patron `tick + setTick` para repolar `loadToday` cada 5s. Provoca re-render del subtree entero aunque `WorkdayTodayView` no cambie. Mejor: comparar `JSON.stringify` o usar un campo `updated_at` para early-return.
- `ProjectTerminal.tsx:124-156` registra `listen("pty:exit:${id}")` cada vez que `layout` cambia (deps array). Cada split/rename/ratio reabre todos los listeners. Esta a un paso del listener leak.

Recomendaciones:
1. `lazy()` + `<Suspense>` por cada tab pesada (`Projects`, `Library`, `Memory`, `AIRouter`) en `App.tsx:6-23`. Ahorro estimado >40% del first paint.
2. En `ProjectTerminal.tsx:124` mover el setup de listeners a un effect dependiente solo de `pty_id` set (usar `useMemo` para sacar el set ordenado y un `JSON.stringify` como dep estable) en vez de re-registrar con cada mutacion del layout.
3. `Agents.tsx:222` envolver `renderCardGrid` y `AgentListItem` en `React.memo` con comparador por `path`. Idem `ZoneCard` en `AIRouterIndex.tsx:53`.

### 6. Tests / verificacion visual - 1/10

Evidencias:
- `package.json:6-13` no declara vitest, jest, playwright ni testing-library. Cero scripts de test.
- `find src -name "*.test.*"` retorna 0 resultados.
- `docs/regression-check-2026-05-26.md` existe pero es verificacion manual textual, no automatizada.

Recomendaciones:
1. Anyadir vitest + @testing-library/react. Empezar por `Workdays/WorkdayTemplates.tsx` y `AIRouter/AIRouterIndex.tsx` (componentes acotados y con logica de filtrado).
2. Tests de invariantes para los reducers puros que ya existen: `terminal/layout-types.ts` (`splitLeaf`, `closeLeaf`, `setLeafPty`). Son funciones puras, son TDD-friendly.
3. Anyadir un Playwright minimo que arranque `tauri dev` y haga screenshot de cada tab (`Projects`, `Memory`, `Workdays`, `Settings`) - regresion visual barata.

---

## Resumen final

El stack es moderno y los tipos estan limpios (strict, casi nada de `any`), pero la disciplina arquitectural se cae en `Projects.tsx` (3594 lineas) y la app no tiene ni una sola prueba automatizada. El 70% del estilo va por `style={{}}` inline con hex literales mezclados con tokens CSS, asi que no hay un design system real, solo apariencia de uno. Con Workdays demuestras que sabes hacerlo bien: aplica ese patron al resto y tu nota sube a 7. Hoy: **4.5/10 - aprobado raspado, requiere refactor + tests antes del proximo release**.
