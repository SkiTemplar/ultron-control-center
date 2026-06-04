# SPEC — Golden Set & Eval Harness (OLA C, fase avanzada)

Estado: 2026-06-04. SoT = `~/.ultron/brain.db` (`memory_items`, `schema_version=2`,
943 activos). Baseline de referencia: **recall@8 = 0.9166**, leaks = 0.

Este documento define el formato del dataset de evaluación de recall de memoria, las
métricas objetivo, la persistencia de runs y el procedimiento de ejecución. El tooling
asociado vive en este mismo directorio:

| Fichero | Rol |
|---|---|
| `gen_golden.py` | Generador UV, **read-only** sobre brain.db. Produce `golden_set.json`. |
| `golden_set.json` | Dataset de positivos reales (query -> `expect_ids`). Generado, no editar a mano. |
| `negative_fixtures.json` | Casos adversariales sintéticos (no datos reales). |
| `SPEC-GOLDEN-SET.md` | Este documento. |

---

## 1. Filosofía

- **Positivos** = consultas derivadas de items reales de `memory_items` cuya respuesta
  correcta es el propio item (`expect_ids = [canonical_id]`). Miden si el retriever
  encuentra lo que ya está almacenado.
- **Negativos** = casos sintéticos que el retriever **no debe** devolver: secretos,
  datos stale, fugas cross-project, duplicados y decisiones superseded. Miden la
  seguridad/calidad del gate, no el recall.
- **Read-only sagrado**: el generador nunca escribe en brain.db (`mode=ro` +
  `PRAGMA query_only=ON`). El gate de secretos descarta filas peligrosas *antes* de que
  entren al dataset, así nunca se filtra un secreto a `golden_set.json`.

---

## 2. Formato del dataset (`golden_set.json`)

```jsonc
{
  "schema": 1,
  "generated_at": "<ISO-8601 UTC>",
  "source_git_sha": "<HEAD del cockpit/memory-rework>",
  "source_db": "<ruta brain.db>",
  "seed": 20260604,
  "sampling": "stratified_by_type_proportional_deterministic",
  "stats": {
    "total_active": 943,
    "secret_filtered": 1,
    "empty_query_filtered": 0,
    "short_query_filtered": 0,
    "eligible": 942,
    "positives": 942,
    "category_distribution": { "decision": 300, "factual": 274, "file": 13, "task": 355 },
    "type_distribution": { "codebase_fact": 13, "decision": 300, "error_resolution": 14, "fact": 260, "task": 355 }
  },
  "positives": [
    {
      "id": "gs-<uuid>",            // id del caso de eval (prefijo gs-)
      "query": "<consulta derivada>",
      "category": "decision",       // taxonomía de eval (ver §3)
      "type": "decision",           // memory_items.type original
      "scope": "global",            // global | project
      "project_id": null,           // si scope=project
      "expect_ids": ["<uuid item>"] // respuesta canónica esperada
    }
  ]
}
```

### Formato de `negative_fixtures.json`

```jsonc
{
  "schema": 1,
  "negatives": [
    {
      "kind": "secret_leak | stale | cross_project | duplicate | temporal_superseded",
      "rationale": "<por qué este caso debe fallar el retriever si lo devuelve>",
      "seed_item": { /* item sintético sembrado en un índice de prueba */ },
      "query": "<consulta>",
      "must_not_return_ids": ["<id que NUNCA debe aparecer>"]
    }
  ]
}
```

Cada `kind` tiene >= 1 fixture. `cross_project` añade `query_context.active_project_id`;
`duplicate` añade `duplicate_item`; `temporal_superseded` añade `successor_item`.

---

## 3. Taxonomía de categorías

Mapeo `memory_items.type` -> categoría de eval (en `gen_golden.py::TYPE_TO_CATEGORY`):

| Categoría | Origen (type) | Descripción |
|---|---|---|
| `factual` | `fact`, `error_resolution` | Hechos atómicos, resoluciones de error. |
| `decision` | `decision` | Decisiones tomadas (con/sin supersesión). |
| `task` | `task` | Tareas / pendientes / acciones. |
| `constraint` | `constraint` | Restricciones, reglas, invariantes. |
| `persona` | `persona` | Preferencias / identidad del usuario. |
| `temporal` | `temporal` | Hechos con validez temporal acotada. |
| `file` | `file`, `codebase_fact` | Rutas, hechos de codebase. |
| `project` | `project` | Hechos a nivel proyecto. |

Las 8 categorías son el contrato. Hoy brain.db sólo puebla
`factual / decision / task / file`; las demás quedan definidas para cuando el SoT crezca
(no se inventan datos para rellenarlas).

---

## 4. Muestreo

- **Estratificado por `type`**, proporcional a la población, **determinista** (seed fijo
  `20260604`). Mismo brain.db + misma seed => `golden_set.json` byte-idéntico (salvo
  `generated_at` y `source_git_sha`, que son hechos del entorno).
- Si `--target >= eligible` (caso por defecto) se hace **censo completo** ordenado por id:
  cero aleatoriedad, máxima estabilidad para comparar runs.
- Filas eliminadas del pool elegible: (a) que disparan patrón de secreto, (b) sin texto
  derivable, (c) query < 8 caracteres.

---

## 5. Métricas objetivo

Calculadas por el harness sobre los `positives` recuperando top-k del retriever real.

| Métrica | Definición | Objetivo |
|---|---|---|
| **precision@k** | fracción de los k devueltos que están en `expect_ids` | informativa (expect=1 => techo 1/k) |
| **recall@k** | `expect_ids` cubiertos en top-k / total esperados | **>= 0.9166** (no regresión vs baseline) en k=8; meta 0.95 |
| **MRR** | media de 1/rank del primer acierto | **>= 0.85** |
| **nDCG@k** | ganancia descontada normalizada | **>= 0.90** en k=8 |
| **context_waste_ratio** | tokens devueltos que NO pertenecen a `expect_ids` / tokens totales devueltos | **<= 0.40** |
| **latency p50 / p95** | latencia por consulta (ms), end-to-end del retriever | p50 **<= 150ms**, p95 **<= 500ms** |
| **leak_rate** (negativos) | nº de `must_not_return_ids` devueltos / nº de fixtures | **== 0** (gate duro) |

k de referencia: **k=8** (alinea con el baseline 0.9166). Reportar también k ∈ {1,3,5,10}.

Regla de gate: un run **falla** si `recall@8 < 0.9166`, o `leak_rate > 0`, o
`p95 > 500ms`. Falla blanda (warning) si `MRR < 0.85` o `context_waste_ratio > 0.40`.

---

## 6. Persistencia de runs (`eval_runs`)

Cada ejecución del harness persiste una fila (propuesta de esquema, tabla nueva en
brain.db o en un `evals.db` separado para no contaminar el SoT — preferible `evals.db`):

```sql
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id            TEXT PRIMARY KEY,        -- uuid del run
  created_at        INTEGER NOT NULL,        -- epoch ms
  git_sha           TEXT,                    -- HEAD al correr
  golden_sha256     TEXT,                    -- hash de golden_set.json usado
  retriever         TEXT,                    -- p.ej. memory_unified_search
  k                 INTEGER,                 -- k principal evaluado
  n_positives       INTEGER,
  n_negatives       INTEGER,
  precision_at_k    REAL,
  recall_at_k       REAL,
  mrr               REAL,
  ndcg_at_k         REAL,
  context_waste     REAL,
  latency_p50_ms    REAL,
  latency_p95_ms    REAL,
  leak_rate         REAL,
  passed            INTEGER,                 -- 0/1 según gate §5
  baseline_recall   REAL DEFAULT 0.9166,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS eval_run_cases (
  run_id     TEXT NOT NULL,
  case_id    TEXT NOT NULL,                  -- gs-... o neg-...
  category   TEXT,
  rank_hit   INTEGER,                        -- rank del primer acierto, NULL si miss
  hit        INTEGER,                        -- 0/1
  latency_ms REAL,
  PRIMARY KEY (run_id, case_id)
);
```

`evals.db` queda **fuera** del SoT: el harness puede escribirlo libremente sin violar la
regla "MemoryService único escritor de brain.db".

---

## 7. Comparación vs baseline 0.9166

- El baseline histórico es `recall@8 = 0.9166` (HEAD f936a66, leaks=0).
- Cada run compara `recall_at_k(k=8)` contra `baseline_recall` y marca `passed=0` si
  regresiona por debajo del umbral.
- Para tendencia: `SELECT created_at, recall_at_k FROM eval_runs WHERE k=8 ORDER BY created_at`.
- Comparación de datasets entre HEADs: diferenciar por `golden_sha256`; cambios en
  `source_git_sha` con mismo `golden_sha256` indican dataset estable entre commits.

---

## 8. Cómo correrlo

Generar / regenerar el golden set (read-only, UV obligatorio):

```bash
cd ~/.ultron/cockpit/memory-rework/evals
uv run python gen_golden.py                 # censo completo del pool elegible
uv run python gen_golden.py --target 100    # muestra estratificada de 100
uv run python gen_golden.py --seed 123      # otra seed determinista
```

Verificación rápida del dataset:

```bash
# JSON válido
uv run python -c "import json; json.load(open('golden_set.json', encoding='utf-8'))"

# 0 secretos en el dataset (debe imprimir 0)
grep -E "sk-[A-Za-z0-9]{8}|gho_[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{12}|-----BEGIN" golden_set.json | wc -l

# nº de positivos
uv run python -c "import json; d=json.load(open('golden_set.json', encoding='utf-8')); print('positives:', len(d['positives']))"
```

Ejecución del harness de recall (a implementar; consume estos tres ficheros):
1. Carga `golden_set.json` + `negative_fixtures.json`.
2. Por cada positivo: llama al retriever real (`memory_unified_search`), top-k,
   computa hit/rank/latencia.
3. Por cada negativo: siembra `seed_item` en un índice de prueba, lanza `query`,
   asegura que ningún `must_not_return_ids` aparezca.
4. Agrega métricas (§5), persiste en `eval_runs` (§6), compara vs baseline (§7).
5. Sale con código != 0 si el gate duro falla.

---

## 9. Garantías de seguridad

- El generador descarta filas con patrón de secreto **antes** de derivar query.
- Doble verificación: la query derivada se re-escanea; el JSON serializado completo se
  escanea antes de escribir a disco (aborta si detecta secreto).
- `negative_fixtures.json` usa exclusivamente material **sintético** marcado `FAKE...` —
  no son secretos reales y no provienen de brain.db.
- Patrones cubiertos: `sk-`, `gho_`, `ghp_`, `github_pat_`, `AKIA`, PEM
  (`-----BEGIN ... PRIVATE KEY-----`), Slack `xox*`.
