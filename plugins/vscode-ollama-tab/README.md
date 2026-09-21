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

### Calentamiento del modelo

Cada peticion lleva `keep_alive` (30 min por defecto) para que el modelo siga
residente entre rafagas de escritura. Medido en este equipo con
`qwen2.5-coder:1.5b-base`: con el modelo fuera de RAM la carga tarda ~10,7 s;
con el modelo residente, ~50 ms.

Antes de cada sugerencia se comprueba en `/api/ps` si el modelo esta cargado.
Si no lo esta, se lanza UNA peticion de calentamiento en segundo plano
(`num_predict: 0`, timeout propio de 120 s) y ese turno no sugiere nada; las
pulsaciones siguientes ya lo encuentran caliente. Sin ese gate, la peticion en
frio se abortaba por timeout y Ollama cancelaba tambien la carga, de modo que
el modelo nunca llegaba a quedarse residente.

### Modelo activo

El modelo sale, por este orden:

1. `ollamaTab.model`, si tiene un valor explicito — siempre gana.
2. El modelo del motor activo: `modelLow` con `engine: low`, `modelMid` con
   `engine: mid` y `modelHigh` con `engine: high`.
3. Solo si no hay ninguno de los dos (motor no local y `model` vacio), el
   primer modelo que `GET {endpoint}/api/ps` declare cargado, cacheado 4 s, y
   `qwen2.5-coder:1.5b-base` como ultimo recurso.

El motor manda sobre `/api/ps` a proposito: con varios modelos instalados,
preguntar cual esta cargado devolveria el del motor anterior mientras se
suelta.

## Ajustes

| Ajuste | Por defecto | Descripcion |
|---|---|---|
| `ollamaTab.enabled` | `true` | Interruptor maestro de la extension. |
| `ollamaTab.engine` | `low` | Motor activo: `off`, `copilot`, `low`, `mid` o `high`. Excluyente (ver abajo). |
| `ollamaTab.modelLow` | `qwen2.5-coder:1.5b-base` | Modelo del motor `low`. |
| `ollamaTab.modelMid` | `qwen2.5-coder:3b-base` | Modelo del motor `mid`. |
| `ollamaTab.modelHigh` | `qwen2.5-coder:7b-base` | Modelo del motor `high`. |
| `ollamaTab.endpoint` | `http://127.0.0.1:11434` | URL base del servidor Ollama. |
| `ollamaTab.model` | `""` (vacio) | Modelo usado para el completado FIM. Vacio = sigue al modelo cargado segun `/api/ps` (ver arriba). |
| `ollamaTab.debounceMs` | `75` | Espera tras dejar de escribir antes de pedir sugerencia. |
| `ollamaTab.timeoutMs` | `2500` | Tiempo maximo de espera de la respuesta. |
| `ollamaTab.maxPrefixChars` | `3000` | Caracteres de contexto antes del cursor. |
| `ollamaTab.maxSuffixChars` | `1000` | Caracteres de contexto despues del cursor. |
| `ollamaTab.logSuggestions` | `true` | Traza en el OutputChannel una linea por sugerencia mostrada (ver abajo). |
| `ollamaTab.keepAlive` | `30m` | Cuanto sigue el modelo residente tras cada peticion. |
| `ollamaTab.warmupTimeoutMs` | `120000` | Timeout de la peticion que carga el modelo en RAM. |

## Motor de autocompletado (excluyente)

VS Code deja que varias extensiones registren ghost text a la vez y elige una
sin criterio estable, asi que con Copilot y Ollama Tab activos no se sabe quien
escribio la sugerencia. Aqui el motor es uno solo, en `ollamaTab.engine`:

| Motor | Sugiere | Copilot | VRAM |
|---|---|---|---|
| `low` | Ollama con `modelLow` | apagado | la del modelo pequeno |
| `mid` | Ollama con `modelMid` | apagado | la del modelo intermedio |
| `high` | Ollama con `modelHigh` | apagado | la del modelo grande |
| `copilot` | GitHub Copilot | encendido | ninguna (los dos modelos se sueltan) |
| `off` | nadie | apagado | ninguna |

Se cambia con un clic en la barra de estado (a la izquierda) o desde la paleta
con **Ollama Tab: elegir motor de autocompletado**. Al cambiar, la extension
escribe `github.copilot.editor.enableAutoCompletions` con el valor contrario,
suelta de VRAM (`keep_alive: 0`) el modelo que ya no toca y calienta el nuevo.
Si Copilot no esta instalado, el cambio sigue adelante y lo deja anotado en el
OutputChannel.

Medido en este equipo (RTX 4060 Laptop, 8 GB): `7b-base` ocupa 4,7 GB de VRAM
integros y responde en ~460 ms en caliente; `1.5b-base` ronda 1 GB y ~50 ms.
Por eso conviene tener `high` apagado salvo cuando se necesita.

### Aviso de VRAM

Antes de activar un motor local se compara la VRAM libre (`nvidia-smi`) con el
tamano que `/api/tags` declara para ese modelo, mas un 15 % de margen para
contexto y buffers. Si no cabe — porque Unreal, un juego o cualquier otra cosa
esta ocupando la GPU — sale un aviso con las dos cifras y la opcion de activarlo
igualmente; cancelar deja el motor anterior intacto. Sin GPU NVIDIA, sin
`nvidia-smi` o con un modelo que no aparece en `/api/tags`, no se avisa: se deja
pasar en vez de bloquear por una sospecha.

### Desde ULTRON Control Center

El mismo motor se cambia en **AI Router > Modelo local (Ollama)**, sin abrir
VS Code: los comandos `editor_engine_status` / `editor_engine_set`
(`src-tauri/src/ollama/editor.rs`) leen y escriben `ollamaTab.engine` en el
`settings.json` de VS Code — edicion quirurgica de esa clave, respetando
comentarios y formato, con copia previa en `settings.json.ultron-bak` — y
mueven los modelos de VRAM. VS Code recoge el cambio en caliente.

### Barra de estado y traza — distinguirla de GitHub Copilot

Las dos fuentes de ghost text son visualmente identicas, asi que la barra de
estado (a la izquierda) nombra SIEMPRE el motor activo: `Ollama low ·
qwen2.5-coder:1.5b-base · 12`, `Copilot` o `Sin autocompletado`. El contador
solo sube con sugerencias servidas por esta extension. El icono cambia entre
peticion en vuelo (`$(sync~spin)`), reposo (`$(zap)`), sin conexion
(`$(warning)`), Copilot (`$(github)`) y apagado (`$(circle-slash)`). Un clic
abre el selector de motor.

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
