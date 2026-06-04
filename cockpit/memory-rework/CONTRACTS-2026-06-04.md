# CONTRACTS — Policy & Manifest Schemas — ULTRON — 2026-06-04

> OLA A (fase diseno). Define los contratos de datos/policy que gobiernan memoria, hooks, router,
> MCPs y lifecycle. **Reuse-over-rebuild**: cada contrato marca [EXISTE] (ya en codigo) vs [ANADIR]
> (nuevo campo/modulo). La implementacion (detectores, validadores) es codigo + rebuild + tests y se
> hace en olas posteriores; aqui solo se especifica. SoT: SQLite `brain.db`; unico escritor: `MemoryService`.

---

## 1. Memory Item — contrato de provenance e injection policy

Base real: `memory/model.rs` (MemoryItem/MemoryCandidate), `sqlite_store.rs` (memory_items/_candidates/_events).

```
MemoryItem {
  id: string                      # [EXISTE]
  project: string                 # [EXISTE] filtro de scope (vault off-by-default)
  kind: enum                      # [EXISTE] decision|task|constraint|persona|file|project|...
  text: string                    # [EXISTE] contenido canonico
  status: enum                    # [EXISTE] active|deprecated|rejected|pending|stale
  sensitivity: enum               # [EXISTE] Public|Internal|Secret  (gate Secret en recall, Ola 0)
  # --- OLA A/B (verificado f936a66 + Codex/Gemini) ---
  normalized_text: string         # [EXISTE Ola B] texto normalizado (lower, sin ruido) para dedupe/FTS (texthash.rs)
  content_hash: string            # [EXISTE Ola B] FNV-1a 64-bit hex(normalized_text) -> dedupe exacto + idempotencia (NO sha256; texthash.rs:26-37). Aun SIN lookup find_by_content_hash; qdrant_point_id existe pero no se genera en index_item
  semantic_cluster_id: string?    # [ANADIR] cluster de duplicados (dedupe multicapa)
  schema_version: int             # [EXISTE Ola B, =2] version del esquema del item (migraciones aditivas)
  valid_from: ts                  # [ANADIR] bitemporalidad (supersession/temporal queries)
  valid_to: ts?                   # [ANADIR] null = vigente; set = superseded/stale
  source_trust: enum              # [ANADIR] user_explicit > tool_observed > assistant_inferred > external_imported
  injection_policy: enum          # [ANADIR] always | contextual | never_inject | routing_only | info_only
  retention_class: enum           # [ANADIR] permanent | session | ttl_<n>d | audit
  provenance: {                   # [ANADIR/parcial] trazabilidad
    source: string, source_ids: [string], source_session_id: string?,
    derived_from: [string], confidence: float, captured_by: string
  }
}
```

Invariantes (algunas ya en CI, Ola 3-D2):
- [EXISTE] recall NUNCA devuelve `rejected|deprecated|secret|cross-project`.
- [ANADIR] NUNCA se indexa en Qdrant texto no redactado (secret/PII).
- [ANADIR] `injection_policy=never_inject` excluye de cualquier pack; `routing_only` no entra en context pack pero puede influir routing.
- [ANADIR] auto-captura (Stop) entra como `candidate` con `source_trust<=assistant_inferred` -> quarantine por defecto si confidence baja.

## 2. Source Trust Model

```
user_explicit     (1.00)  # el usuario lo dijo/confirmo -> puede ir a active via inbox
tool_observed     (0.80)  # observado de salida de herramienta fiable
assistant_inferred(0.50)  # inferido por el asistente (Stop hook) -> candidate/quarantine
external_imported (0.30)  # MCP/import/fuente externa -> quarantine + prompt-injection scan obligatorio
```
Regla: el destino (active vs candidate vs quarantine) = f(source_trust, confidence, sensitivity). Nada
con `source_trust<=assistant_inferred` pasa a `active` sin politica/inbox explicito.

## 3. Write-path security (OLA A, codigo)

Pipeline obligatorio ANTES de persistir a SQLite y ANTES de generar embeddings:
1. **[HECHO OLA A/H2 — commits 2c28c20, cda7a99]** `secret_detect(text)` -> redacta in-place (`redaction.rs`, cableado en `create_candidate`+`add_imported`) + escala `sensitivity=Secret` (H2: el gate Secret del recall ya NO está hueco) + candidate->`Quarantine` (anti-poisoning).
2. `pii_detect(text)` -> redactar segun retention_class.
3. `prompt_injection_scan(text)` si `source_trust<=external_imported` -> quarantine si hit.
4. `content_hash` + dedupe (ver 4) antes de insertar.
Contrato: el embedding se genera SOLO sobre texto post-redaccion. Borrado verificable = SQLite + Qdrant +
backups + logs + JSONL (un `forget(id)` debe cubrir todos los sumideros).

## 4. Dedupe multicapa (OLA E)

```
L0 exact:       content_hash igual                      -> merge directo
L1 normalized:  normalized_text igual                   -> merge
L2 shingle:     MinHash/SimHash Jaccard >= theta_shingle -> candidato merge
L3 embedding:   cosine >= theta_embed (calibrado/dataset)-> candidato merge
L4 entity:      misma entidad canonica + scope           -> candidato merge
```
Guard temporal: items con `valid_from/valid_to` distintos o `scope` distinto **NO** se fusionan
(near-duplicate != duplicate). Merge = plan explicable (que campo gana cada uno) + provenance preservada + rollback.

## 5. Hook Manifest (OLA I)

SoT unica versionada (decidir `~/.ultron/hooks` vs versionar `~/.claude/scripts`). Cada hook declara:
```
HookManifest {
  id: string, event: SessionStart|UserPromptSubmit|Stop|PostToolUse,
  command: string, timeout_s: int, env: {..}, version: string, checksum: sha256,
  failure_policy: no_op | retry | disable_after_N, writes_memory: bool,
  writer_path: "MemoryService" | "NONE"   # PROHIBIDO: qdrant_direct | mem0 | other_store
}
```
Contratos: Stop emite `candidate` via `ultron-memory candidate` (idempotente, exactly-once), NUNCA upsert
directo a Qdrant/Mem0. Ningun hook escribe a stores legacy. Circuit breaker auto-disable si falla N veces.
Prompt budget guard: no inyectar si excede limite o si ya hay contexto equivalente.

## 6. AI Router Zone Policy (OLA F)

Base real: `ai_router.rs::route(zone, prompt)`, ZoneAssignment, proxy free-tier.
```
ZonePolicy {
  zone: string,
  temperature: float,             # [ANADIR] hoy ausente -> bloqueante JSON determinista
  response_schema: json?,         # [ANADIR] valida salida; retry/escalation en schema_error
  privacy: local_only | remote_ok | no_secret_remote,  # [ANADIR] private/secret nunca a remoto no autorizado
  candidates: [provider/model],   # [EXISTE] cadena primary->fallback
  selection_objective: cost|latency|quality|reliability, # [ANADIR] selector dinamico
  cache: { ttl_s, key: hash(prompt+model_ver+schema_ver+project) }, # [ANADIR]
  circuit_breaker: { error_threshold, cooldown_s }       # [ANADIR]
}
```
Capability model por provider/modelo: json_mode, tools, context, vision, code, latency, cost, reliability,
local/remote, privacy. Selector = f(capability, key availability, privacy, latency p95, success_rate, malformed_rate, cost).

## 7. Skill/Agent Manifest (OLA G)

Gap real: `catalog.rs:133` solo indexa `entity="agent"`; no hay `index_skills()` en Rust.
```
CatalogEntry {
  id: "agent::<name>" | "skill::<name>",   # [ANADIR] namespacing (skills hoy no compiten)
  entity: agent | skill,                    # [EXISTE para agent]
  description, when_to_use, when_not_to_use, inputs, outputs, tools, permissions,
  conflicts: [id], prerequisites: [id], examples, version, hash
}
```
Activation policy: directiva_fuerte | sugerencia | no_op segun confidence + histeresis/cooldown
(evitar 5 activaciones por prompt). Procedural memory: intent/proyecto -> skill/agente que funciono (decay+confianza).

## 8. MCP Policy (OLA J)

```
McpPolicy {
  server: string, classification: core|optional|dangerous|duplicate,
  tool_allowlist: [string], token_scope: minimal, version_pin: string,
  writes_memory: bool  # si true -> DEBE pasar por MemoryService o quedar bloqueado
}
```
Hoy: context7, playwright, codex (gpt-5.5 read-only), github (`Bearer ${GITHUB_TOKEN}` env, OK no-literal),
+ MCP `ecc memory` (knowledge graph, competing store latente). Contrato: ningun MCP es escritor de memoria
canonica. `GITHUB_TOKEN` con fuga historica -> rotacion pendiente (decision humana).

## 9. Deprecation Registry Schema (OLA K)

Formaliza `DEPRECATION-REGISTRY-2026-06-04.md`:
```
DeprecationEntry {
  id, artifact, type, owner, path, reason, replacement,
  state: active|deprecated|shadowed|quarantined|pending_delete|deleted|restored,
  first_seen, last_seen, deadline?, risk: bajo|medio|alto,
  cleanup_action, rollback_action, regenerable: bool
}
```
Contrato: nada pasa a `deleted` sin snapshot/rollback o prueba de regenerabilidad; todo delete emite
evento auditado con trace_id; limpieza idempotente; no rompe `eval`/`reconcile`/hooks/startup.

## 10. Observabilidad (OLA M)

`trace_id` por turno: hook -> orchestrator -> recall -> router -> agent -> memory_event. Errores con taxonomy:
`provider_error|schema_error|timeout|policy_block|index_stale|corrupt_memory|secret_block`. Replay por trace_id.

---

## Orden de implementacion (de estos contratos)
1. [B] `schema_version`, `normalized_text`, `content_hash` en model + migracion. 2. [A] write-path secret/PII.
3. [B] outbox + `reconcile`. 4. [I] hook manifest + Stop->candidate. 5. [F] zone temperature/response_schema.
6. [G] index_skills + namespacing. 7. [E] dedupe L0-L4 + bitemporal. 8. [J] MCP policy. 9. [K] registry vivo. 10. [M] trace_id.
