# KIRKARDO — Evaluación AI Router (2026-05-26)

## Resumen (3 líneas)
El AI Router es un panel de configuración con health checks y test-invoke reales, pero **nadie del Control Center consume el router para enrutar producción**: ningún feature llama a un comando tipo `ai_router_request`, ese comando ni siquiera existe. Hay seis wrappers HTTP funcionales, fallbacks declarados pero jamás invocados, métricas hardcoded a default y un drift grave entre `types.ts` (catálogo "anthropic/cerebras", DEFAULT_ZONES de 12 entradas) y el backend Rust (catálogo "claude-haiku/deepseek", 7 zones). **Veredicto: decorativo con backend semi-honesto, no funcional como router.**

## Notas

### Provider abstraction — 4/10
No hay trait. Es un `match provider.id.as_str()` a pelo en `test_zone` (line 619-627) con seis brazos hardcoded. Añadir un séptimo provider exige tocar el match, el seed, los structs de auth en `probe_provider` (líneas 541-553, con if-encadenados por id), y los tres componentes TSX. Cero polimorfismo. Lo único que se acerca a abstracción es `call_openai_compat` reutilizado por codex/groq/deepseek — bien — pero el resto son funciones por proveedor sin contrato común.

### Zone fallback chain — 1/10
**Los fallbacks no se ejecutan jamás.** `test_zone` solo invoca `zone.primary` (líneas 619-627). El campo `fallbacks: Vec<ZoneAssignment>` se serializa, se edita en el `ZoneEditor`, se persiste en disco… y nunca se lee en runtime. No hay `try_primary_then_fallbacks`. El `fallback_rate` de métricas es un campo decorativo. Si el primary falla, el caller recibe el error y punto.

### Health checks — 6/10
Lo mejor del módulo. Cache de 30s con TTL (`HEALTH_CACHE`, líneas 492-527), timeout HTTP de 10s, "any <500 means alive" — razonable y barato. Auth headers por proveedor en `probe_provider`. Punto débil: la cache es estática global con `Mutex`, no se invalida cuando el usuario edita una key, no diferencia entre "key faltante" y "endpoint caído", y trata 401/403 como "online" (correcto para reachability, engañoso para el usuario).

### Cost tracking — 2/10
`cost_per_mtok` existe en `Provider` y se muestra en `ProviderCatalog`. **Nunca se multiplica por nada.** `RouterMetrics.cost_saved_usd` se inicializa a 0 y nunca se actualiza — `load_metrics` lee el JSON, pero **`metrics.json` no existe** (verificado: `cannot access`), así que se devuelve `RouterMetrics::default()` cada vez. No hay escritor de métricas. El dashboard muestra ceros eternos.

### UX configuración — 3/10
Sub-tab embebido en Settings: bien. Pero para añadir una key hay que **setear la env var fuera del proceso y reiniciar** la app, porque `compute_key_status` lee `std::env::var` (línea 442) que se snapshot al arrancar Tauri. No hay UI para introducir la key, ni `.env` file watcher, ni keychain integration. El propio comentario del banner en `ProviderCatalog` lo confiesa. Cinco de seis providers en `missing` por defecto es la prueba.

### Routing decisión automática — 0/10
Existe la zone `routing-decision` con system prompt "classify into one of the zones, reply with id only". **Nadie la invoca.** No hay `route(prompt) -> zone_id` ni en Rust ni en TS. Es una zone como cualquier otra, testeable manualmente desde el ZoneEditor. Pura coreografía.

## Producción: ¿se usa?

`grep ai_router_` fuera de `src/components/AIRouter/` y `src-tauri/src/{ai_router.rs,lib.rs}`: **cero hits**. El único consumidor externo es `Settings/index.tsx`, que **monta el componente UI**, no llama comandos. Ningún feature del CC (Usage, News, Memory, Notifications, Plans, MCPs) enruta a través del Router. Cada feature sigue llamando a su provider directo. El Router es un panel huérfano.

Drift adicional: `types.ts` declara `PROVIDER_CATALOG` con `anthropic`/`cerebras` y `DEFAULT_ZONES` con 12 zones dot-namespaced (`usage.refresh_with_claude`, etc.) que **no existen en el backend**. El backend tiene `claude-haiku`/`deepseek` y 7 zones planas. El frontend usa los datos del backend (vía `invoke`), así que el catálogo TS es código muerto — pero indica que el plan original era otro y nunca se reconcilió.

## Acción priorizada TOP 5

1. **Implementar `ai_router_request(zone_id, prompt) -> Response` con fallback chain real.** Es la razón de existir del módulo. Iterar `[primary, ...fallbacks]`, primer éxito gana, actualizar `fallback_rate` y `by_class.count/tokens` en `metrics.json` por cada llamada. Sin esto, todo lo demás es teatro.
2. **Migrar al menos un feature del CC a `ai_router_request`.** Empieza por uno barato: el botón "Refresh usage" o el "Summarize document" del News. Demuestra el flow end-to-end. Si no hay caller, mata el módulo.
3. **Refactorizar a `trait Provider { fn invoke(...); fn probe(...); fn auth_header(...); }`.** Eliminar el match-por-id, eliminar los if-encadenados de auth en `probe_provider`. Añadir provider nuevo = un struct nuevo + registrar en un `HashMap<String, Box<dyn Provider>>`.
4. **UI para gestionar API keys sin reiniciar.** Comando `ai_router_set_key(provider_id, key)` que escriba a `~/.ultron/cockpit/ai-router/keys.enc` (DPAPI en Windows), y que `compute_key_status` consulte un store dinámico en vez de `std::env::var` snapshot. Borrar el banner "set env var and restart".
5. **Cablear `routing-decision` como dispatcher automático.** Comando `ai_router_classify(prompt) -> zone_id` que llame al primary de esa zona con un prompt template restringido a los zone ids existentes, y un wrapper `ai_router_auto(prompt)` que clasifique → enrute. Esto convierte el panel en un router real, no en un selector manual.

Bonus eliminatorio: reconciliar `types.ts` con el backend o borrar `PROVIDER_CATALOG`/`DEFAULT_ZONES`. Drift = mentira mantenida.

## Nota final

**3.5/10.** Backend Rust limpio para lo que hace (test-invoke y health), frontend coherente, pero el producto declarado ("AI Router que enruta entre providers con fallback") **no existe**. Es un panel de pruebas con tres tabs bonitos. Si nadie lo usa para enrutar, no es un router; es un Postman empotrado.
