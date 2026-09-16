# Ollama Tab

Extension minima de VS Code que ofrece autocompletado de linea (ghost text,
Tab para aceptar) usando un modelo local de Ollama. No incluye chat, comandos
de agente, paneles adicionales ni telemetria: solo `InlineCompletionItemProvider`.

## Como funciona

En cada punto de edicion la extension toma el texto antes y despues del
cursor, lo recorta a una ventana de caracteres configurable (cortando siempre
en un limite de linea) y construye un prompt FIM (`fill-in-the-middle`):

```
<|fim_prefix|>{prefijo}<|fim_suffix|>{sufijo}<|fim_middle|>
```

Lo envia a `POST {endpoint}/api/generate` con `raw: true`, `stream: false` y
`stop: ["\n"]`, de forma que Ollama complete como maximo hasta el final de la
linea actual. La respuesta se sanea (se descarta si esta vacia, si son solo
espacios, o si duplica el texto que ya esta despues del cursor) y, si queda
contenido util, se muestra como sugerencia inline.

La extension **no** envia `keep_alive`: la carga/descarga del modelo la
gestiona el interruptor de la bandeja de ULTRON (o la seccion AI Router >
Modelo local de ULTRON Control Center). Si el modelo no esta cargado, la
peticion simplemente puede agotar el `timeout` configurado y no se muestra
nada (sin reintentos ni notificaciones).

### Modelo activo

`ollamaTab.model` esta vacio por defecto. Con el vacio, cada sugerencia
pregunta `GET {endpoint}/api/ps` (cacheado `4 s` para no anadir una
peticion extra por pulsacion) y usa el primer modelo que aparezca cargado
— es decir, seguira automaticamente al modelo que este activo segun
ULTRON (bandeja o AI Router > Modelo local), sin tocar el `settings.json`
de VS Code. Si `/api/ps` no informa ningun modelo (servidor parado, sin
red) cae a `qwen2.5-coder:1.5b-base`. Un valor explicito en el ajuste
SIEMPRE se respeta y se salta la consulta a `/api/ps`.

## Ajustes

| Ajuste | Por defecto | Descripcion |
|---|---|---|
| `ollamaTab.enabled` | `true` | Activa o desactiva el autocompletado. |
| `ollamaTab.endpoint` | `http://127.0.0.1:11434` | URL base del servidor Ollama. |
| `ollamaTab.model` | `""` (vacio) | Modelo usado para el completado FIM. Vacio = sigue al modelo cargado segun `/api/ps` (ver arriba). |
| `ollamaTab.debounceMs` | `75` | Espera tras dejar de escribir antes de pedir sugerencia. |
| `ollamaTab.timeoutMs` | `1500` | Tiempo maximo de espera de la respuesta. |
| `ollamaTab.maxPrefixChars` | `3000` | Caracteres de contexto antes del cursor. |
| `ollamaTab.maxSuffixChars` | `1000` | Caracteres de contexto despues del cursor. |
| `ollamaTab.logSuggestions` | `true` | Traza en el OutputChannel una linea por sugerencia mostrada (ver abajo). |

### Barra de estado y traza — distinguirla de GitHub Copilot

Ambas extensiones muestran la sugerencia como "ghost text" gris e son
visualmente indistinguibles, así que la barra de estado ("Ollama Tab")
siempre muestra el modelo activo y un contador de sugerencias mostradas en
la sesion, p. ej. `Ollama Tab · qwen2.5-coder:1.5b-base · 12`. El icono
cambia mientras hay una peticion en vuelo (`$(sync~spin)`), en reposo
(`$(zap)`), sin conexion (`$(warning)`) o desactivada
(`$(circle-slash)`). Un clic activa/desactiva la extension.

Con `ollamaTab.logSuggestions` (activo por defecto), cada sugerencia
MOSTRADA (las descartadas por `sanitizeCompletion` no cuentan) anade una
linea al OutputChannel "Ollama Tab" con hora, lenguaje, latencia en ms y
el texto sugerido truncado a ~60 caracteres:

```
[14:30:05] typescript 82ms: return total;
```

Nunca se vuelca el prefijo/sufijo del fichero — solo la sugerencia ya
saneada (y truncada).

## Desarrollo

```bash
npm install
npm run compile   # tsc --noEmit / build a out/
npm test          # vitest sobre la logica pura (src/logic.ts)
npm run smoke      # prueba real contra un Ollama en marcha
npm run package    # genera el .vsix con @vscode/vsce
```

La logica de construccion del prompt, recorte de contexto y saneado de la
respuesta vive en `src/logic.ts` sin ninguna dependencia de la API de
`vscode`, precisamente para poder testearla de forma aislada
(`test/logic.test.ts`). `src/extension.ts` es la unica pieza que habla con
`vscode` (proveedor de inline completion, barra de estado, comando de
toggle).

## Limitaciones conocidas

- Solo autocompleta hasta el primer salto de linea; no hay completado
  multi-linea ni streaming parcial.
- No hay cache de peticiones ni deduplicacion entre pulsaciones muy
  seguidas mas alla del debounce.
- No se ha verificado con modelos que no sigan la convencion de marcadores
  `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` de Qwen2.5-Coder.
- Con `ollamaTab.model` vacio, el modelo activo se cachea 4 s: si se
  cambia de modelo desde ULTRON a mitad de esa ventana, la extension
  puede tardar hasta 4 s en enterarse.
- El contador de sugerencias de la barra de estado es de sesion (se
  reinicia al reiniciar VS Code) — no persiste entre reinicios.
