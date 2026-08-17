# Sistema de memoria — especificacion

La pieza central de ULTRON. Da a Claude Code (y a cualquier cliente MCP) una
memoria persistente entre sesiones: decisiones, arquitectura, gotchas y estado
de proyectos, recuperados de forma semantica en cada prompt.

## Principios

1. **Una sola fuente de verdad.** `~/.ultron/brain.db` (SQLite + FTS5).
   Qdrant es un indice derivado y reconstruible (`reindex`); si divergen,
   manda SQLite (`doctor` lo detecta, `reconcile` lo mide).
2. **Escritor unico y event-sourcing.** Toda mutacion pasa por `MemoryService`
   y anexa un `MemoryEvent` de auditoria (quien, cuando, por que). No hay
   escrituras directas a la tabla desde ningun otro punto del sistema.
3. **El humano gobierna.** La captura automatica nunca escribe memoria activa:
   propone **candidatos** a un inbox con dedupe por `content_hash`, juez de
   contradicciones y gates de sensibilidad. Se aprueba, se rechaza o se drena
   con politica auditable.
4. **Fail-safe.** Sin Qdrant: recall solo-sparse. Sin modelos: el hook degrada
   y el prompt entra igual. Un fallo de memoria jamas bloquea la sesion.
5. **Local.** Modelos ONNX locales (E5, cross-encoder), SQLite y Qdrant en
   disco propio. La unica salida de red opcional es la fase LLM del backfill y
   la captura via router, ambas configurables.

## Esquema

| Concepto | Detalle |
|---|---|
| Item | `title`, `summary`, `kind`, `scope` (Global/Project), `project_id`, `sensitivity`, `status` (Active/Deprecated/Stale), `content_hash`, procedencia episodica (`source_session_id`) |
| Evento | Append-only: Created/Edited/Deprecated/... con actor y razon |
| Candidato | Igual que item + banda de confianza del juez; vive en el inbox |
| Indice denso | Coleccion `ultron_memory` en Qdrant, E5 `multilingual-e5-large` 1024d |
| Indice sparse | FTS5 (BM25) dentro de brain.db |

## Recall hibrido

```
query -> [BM25 top-K]  ->  RRF (k=60)  ->  factores de ranking  ->  cross-encoder top-48  ->  pack
         [E5 dense top-K]                  (calidad, recencia,       (BGE reranker v2-m3,
          fanout 30 hot / 60 calidad        penalty ambiente)         solo path de calidad)
```

- **Fusion**: Reciprocal Rank Fusion sobre los dos rankings.
- **Re-rank selectivo**: el cross-encoder solo entra en prompts tecnicos y en
  el path de calidad (CLI/evals); la charla no lo paga. Si esta frio, el turno
  sale sin re-rank y el modelo se calienta en background.
- **Gates de honestidad**: floor de confianza (dense >= 0.81 o respaldo lexico
  fuerte) y trust-gate de terminos — ante una query que el corpus no conoce,
  el sistema **se abstiene** en vez de inyectar relleno. Ambos knobs son
  configurables por entorno y estan calibrados contra trafico real, no solo
  contra un golden set sintetico.
- **Presupuesto**: cap de tokens por pack; el hook tiene timeouts medidos para
  no retrasar nunca el prompt (daemon 9 s peor caso, one-shot 6 s).

## Daemon residente

`ultron-memory serve`: mantiene E5 caliente (orchestrate sub-segundo frente a
~3.5 s de carga fria por proceso). Los one-shots y la GUI le preguntan por
socket local con token; si no responde, resuelven en proceso propio. Los
modelos se liberan tras una ventana de inactividad (`ULTRON_MODEL_IDLE_MIN`,
default 30 min): RAM de ~40 MB en reposo, ~1.5-3.5 GB con modelos cargados.

## Ciclo de vida de una sesion

1. **SessionStart** — resume acotado del proyecto (estado, tareas, decisiones
   recientes, nota del harness) + warmup de modelos.
2. **UserPromptSubmit** — orquestacion: recall del pack de memorias + routing
   de skills/agentes + deteccion de tono. Inyectado como contexto adicional.
3. **Stop** — captura: extraccion de hechos durables del transcript ->
   candidatos al inbox (con redaccion de secretos/PII y dedupe) -> drain
   automatico con politica de bandas.

## Herramientas

- **CLI** (`ultron-memory`): `recall`, `orchestrate`, `stats`, `doctor`,
  `eval --golden` (oraculo etiquetado a mano), `trace` (diagnostico completo
  del retrieval por query), `backfill-projects` (atribucion de proyecto:
  normalize -> provenance -> voto denso k-NN -> LLM batch opcional),
  `curate` (correccion puntual de un item), `forget` (borrado gobernado),
  `provenance` (cita episodica verificable con hash y transcript).
- **MCP server** (`scripts/mcp-memory-server.mjs`): expone `memory_recall`,
  `memory_stats` y `memory_provenance` por el protocolo MCP — cualquier
  cliente (Claude Code, Codex, Gemini CLI) lee la misma memoria.
- **GUI**: pestaña Memory con stats, inbox de candidatos y Retrieval
  Inspector (por que entro cada memoria: rank denso/sparse, descartes y
  razon).

## Medicion

La calidad no se declara: se mide. `eval --golden` corre 29 queries con ids
relevantes etiquetados a mano (recall@8 / precision@3 / MRR / nDCG /
context-waste); un harness de sistema (Kirkardo) fija umbrales por check y un
audit de trafico real (`scripts/traffic-recall-audit.mjs`) mide cuantos
prompts reales entran sin memoria y por que causa. Los experimentos negativos
(poda por margen dense, Contextual Retrieval, floors alternativos) quedan
documentados en el codigo con sus cifras: lo que no compra recall medible, se
queda fuera.
