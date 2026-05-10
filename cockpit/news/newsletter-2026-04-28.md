# ULTRON Newsletter - Semana 18 (2026-04-28)

_Cobertura: últimos 7 días | 11 items deduplicados_
_Generado: 2026-04-28T17:22:29 | refinado con claude-sonnet-4-6_

---

## 1. Editorial

La semana 18 de 2026 está protagonizada casi en exclusiva por OpenAI: GPT-5.5 llega a la API, varios modelos anteriores entran en fase de retirada, y la compañía anuncia colaboraciones estratégicas de escala gubernamental e industrial que redefinen el perímetro de lo que era un "proveedor de API". La señal débil que merece atención es la evaluación conjunta de seguridad OpenAI-Anthropic: dos competidores directos publicando resultados coordinados es inusual y apunta a presión regulatoria creciente, no a altruismo. Para un dev que usa Claude Code + Codex + Gemini en paralelo, la noticia operativa inmediata es clara: GPT-5.5 ya tiene acceso API oficial y los modelos más viejos del stack de Codex CLI están en lista de retirada. Toca auditar dependencias antes de que algo se rompa en producción.

---

## 2. Top 5 prioritarios

### 1. [GPT-5.5 y GPT-5.5 Pro disponibles en la API](https://developers.openai.com/api/docs/changelog)
_Fuente: OpenAI Dev Changelog · Fecha: 2026-04-27_
_GPT-5.5 es ahora el modelo oficial que Codex CLI usa en tu setup ULTRON (según CLAUDE.md, la sub plan ChatGPT solo permite `gpt-5.5`). Con acceso API confirmado, el benchmark MineBench de Reddit ya muestra diferencias cuantificables sobre GPT-5.4. Revisión del dual-mode-protocol.md recomendada para actualizar referencias de modelo._

### 2. [OpenAI retira GPT-4o, GPT-4.1, GPT-4.1 mini y o4-mini de ChatGPT](https://openai.com/index/retiring-gpt-4o-and-older-models)
_Fuente: OpenAI · Fecha: 2026-04-28_
_Deprecation en ChatGPT no significa inmediata retirada en API, pero es señal de que el soporte se acortará. Si algún script o skill de tu stack referencia estos modelos de forma hardcoded, el reloj está corriendo. El fallback de Codex a `gpt-5.4-codex` (vía API key) podría verse afectado si ese modelo queda en lista de espera._

### 3. [OpenAI y Anthropic publican evaluación conjunta de seguridad](https://openai.com/index/openai-anthropic-safety-evaluation)
_Fuente: OpenAI · Fecha: 2026-04-28_
_Colaboración pública entre los dos proveedores principales de tu stack: relevante porque las conclusiones de safety suelen traducirse en cambios de comportamiento del modelo (refusals, rate limits, system prompt overrides). Leer el documento es trabajo preventivo para anticipar degradaciones en casos de uso edge._

### 4. [Diferencias entre GPT-5.4 y GPT-5.5 en MineBench](https://reddit.com/r/singularity/comments/1sxapqb/differences_between_gpt_54_and_gpt_55_on_minebench/)
_Fuente: r/singularity · Fecha: 2026-04-27_
_Primer benchmark comparativo público entre las dos versiones. Los resultados en MineBench son el único dato empírico disponible antes de que OpenAI publique evals oficiales. Útil para calibrar si el salto de 5.4 a 5.5 justifica revisar los prompts del dual-mode o si el comportamiento es suficientemente estable._

### 5. [OpenAI y Broadcom anuncian colaboración para desplegar 10 GW de aceleradores diseñados por OpenAI](https://openai.com/index/openai-and-broadcom-announce-strategic-collaboration)
_Fuente: OpenAI · Fecha: 2026-04-28_
_Infraestructura a escala de gigavatios implica que OpenAI apuesta por capacidad propia de silicio, alejándose de dependencia exclusiva de NVIDIA. A medio plazo esto puede traducirse en menor latencia y mayor disponibilidad de API para modelos de frontera, lo que beneficia directamente cualquier workflow que dependa de Codex CLI en producción._

---

## 3. Impacto en tu sistema ULTRON

El cambio más directo esta semana es la confirmación de GPT-5.5 como modelo operativo en la API: el archivo `dual-mode-protocol.md` y el helper `codex-duet.ps1` pueden seguir funcionando sin modificación si ya apuntan a `gpt-5.5`, pero conviene verificarlo explícitamente. El riesgo real es el anuncio de retirada de modelos en ChatGPT: si el fallback a `gpt-5.4-codex` (disponible solo con API key) queda también en scope de deprecation, el sub-modo `/maxdual` podría perder su fallback antes de lo esperado. No hay breaking change confirmado en Anthropic ni Gemini esta semana, así que el resto del Triple Mode permanece estable. Prioridad: auditar referencias de modelo en scripts ULTRON y confirmar que `--ignore-user-config` sigue siendo el flag correcto con la nueva versión de Codex CLI.

---

## 4. Acciones recomendadas

- Ejecutar `codex --version` y verificar que `codex-duet.ps1` referencia `gpt-5.5` de forma explícita, no un alias que pueda resolver a un modelo en retirada.
- Leer el documento de evaluación conjunta OpenAI-Anthropic para identificar si alguno de los comportamientos documentados afecta a tus prompts de sistema en `/dual` o `/maxdual`.
- Añadir los modelos deprecados (`gpt-4o`, `gpt-4.1`, `gpt-4.1-mini`, `o4-mini`) a una lista de watch en `competitive-intel` para trackear cuándo llega el anuncio de retirada en API (no solo en ChatGPT).

---

## 5. Alertas pendientes

- **[ALERT 2026-04-27]** GPT-5.5 activo en API — confirmar que `codex-duet.ps1` y `dual-mode-protocol.md` usan `gpt-5.5` y no referencias implícitas a modelos ahora en retirada.

---

## 6. Digests crudos (últimos 7 días)

### 2026-04-28
- [Building OpenAI with OpenAI](https://openai.com/index/building-openai-with-openai) _OpenAI_
- [OpenAI and Broadcom announce strategic collaboration to deploy 10 gigawatts of OpenAI-designed AI accelerators](https://openai.com/index/openai-and-broadcom-announce-strategic-collaboration) _OpenAI_
- [Addendum to OpenAI o3 and o4-mini system card: OpenAI o3 Operator](https://openai.com/index/o3-o4-mini-system-card-addendum-operator-o3) _OpenAI_
- [OpenAI and Greek Government launch ‘OpenAI for Greece’](https://openai.com/global-affairs/openai-for-greece) _OpenAI_
- [Retiring GPT-4o, GPT-4.1, GPT-4.1 mini, and OpenAI o4-mini in ChatGPT](https://openai.com/index/retiring-gpt-4o-and-older-models) _OpenAI_
- [SAP and OpenAI partner to launch sovereign ‘OpenAI for Germany’](https://openai.com/global-affairs/openai-for-germany) _OpenAI_
- [OpenAI and Anthropic share findings from a joint safety evaluation](https://openai.com/index/openai-anthropic-safety-evaluation) _OpenAI_
- [OpenAI o3 and o4-mini System Card](https://openai.com/index/o3-o4-mini-system-card) _OpenAI_

### 2026-04-27
- [OpenAI releases GPT-5.5 and GPT-5.5 Pro in the API](https://developers.openai.com/api/docs/changelog) _HN AI_
