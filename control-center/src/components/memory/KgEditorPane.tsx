// KgEditorPane — editor local del knowledge graph (kg.jsonl).
// Extraído de Memory.tsx (1151 L) como parte del refactor P1.
//
// Comandos Tauri cableados:
//   kg_read_graph        — carga inicial + recarga post-mutacion
//   kg_create_entities   — crear entidad
//   kg_delete_entity     — borrar entidad (cascada de relaciones en backend)
//   kg_create_relations  — crear relacion entre dos entidades existentes
//   kg_delete_relation   — borrar relacion exacta (from + to + relation_type)

import { useCallback, useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KgGraph, KgRelation } from "./memoryTypes";

// ---------------------------------------------------------------------------
// Tipos de estado para el formulario de confirmacion de borrado
// ---------------------------------------------------------------------------

type ConfirmState =
  | { kind: "none" }
  | { kind: "entity"; name: string }
  | { kind: "relation"; from: string; to: string; relation_type: string };

// ---------------------------------------------------------------------------
// Reducer minimo para evitar re-renders innecesarios en el formulario
// ---------------------------------------------------------------------------

interface FormState {
  entName: string;
  entType: string;
  entObs: string;
  relFrom: string;
  relType: string;
  relTo: string;
}

type FormAction =
  | { field: "entName"; value: string }
  | { field: "entType"; value: string }
  | { field: "entObs"; value: string }
  | { field: "relFrom"; value: string }
  | { field: "relType"; value: string }
  | { field: "relTo"; value: string }
  | { type: "RESET_ENTITY" }
  | { type: "RESET_RELATION" };

const FORM_INIT: FormState = {
  entName: "",
  entType: "",
  entObs: "",
  relFrom: "",
  relType: "",
  relTo: "",
};

function formReducer(state: FormState, action: FormAction): FormState {
  if ("field" in action) {
    return { ...state, [action.field]: action.value };
  }
  switch (action.type) {
    case "RESET_ENTITY":
      return { ...state, entName: "", entType: "", entObs: "" };
    case "RESET_RELATION":
      return { ...state, relFrom: "", relType: "", relTo: "" };
  }
}

// ---------------------------------------------------------------------------
// Subcomponente: panel de confirmacion inline
// ---------------------------------------------------------------------------

interface ConfirmBannerProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmBanner({ message, onConfirm, onCancel }: ConfirmBannerProps) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
      style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
      role="alertdialog"
      aria-label={message}
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={onConfirm}
        className="rounded-md border border-[var(--color-danger)] px-2 py-0.5 font-medium hover:bg-[var(--color-danger)] hover:text-[var(--color-bg)]"
      >
        Confirmar
      </button>
      <button
        onClick={onCancel}
        className="rounded-md border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Cancelar
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function KgEditorPane() {
  const [graph, setGraph] = useState<KgGraph>({ entities: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "none" });
  const [mutating, setMutating] = useState(false);

  const [form, dispatch] = useReducer(formReducer, FORM_INIT);

  // ---- Carga del grafo ----

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const g = (await invoke("kg_read_graph")) as KgGraph;
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ---- Helper comun para mutaciones ----

  const mutate = useCallback(
    async (fn: () => Promise<KgGraph>) => {
      setMutating(true);
      setError(null);
      try {
        const g = await fn();
        setGraph(g);
      } catch (e) {
        setError(String(e));
      } finally {
        setMutating(false);
        setConfirm({ kind: "none" });
      }
    },
    [],
  );

  // ---- Crear entidad ----

  const createEntity = useCallback(async () => {
    const name = form.entName.trim();
    if (!name) return;
    await mutate(() =>
      invoke<KgGraph>("kg_create_entities", {
        entities: [
          {
            name,
            entity_type: form.entType.trim() || "entity",
            observations: form.entObs
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        ],
      }),
    );
    dispatch({ type: "RESET_ENTITY" });
  }, [form.entName, form.entType, form.entObs, mutate]);

  // ---- Borrar entidad — dos pasos ----

  const requestDeleteEntity = useCallback((name: string) => {
    setConfirm({ kind: "entity", name });
  }, []);

  const confirmDeleteEntity = useCallback(
    async (name: string) => {
      await mutate(() => invoke<KgGraph>("kg_delete_entity", { name }));
    },
    [mutate],
  );

  // ---- Crear relacion ----

  const createRelation = useCallback(async () => {
    const from = form.relFrom.trim();
    const to = form.relTo.trim();
    const relation_type = form.relType.trim() || "relates_to";
    if (!from || !to) return;
    await mutate(() =>
      invoke<KgGraph>("kg_create_relations", {
        relations: [{ from, to, relation_type }],
      }),
    );
    dispatch({ type: "RESET_RELATION" });
  }, [form.relFrom, form.relTo, form.relType, mutate]);

  // ---- Borrar relacion — dos pasos ----

  const requestDeleteRelation = useCallback((rel: KgRelation) => {
    setConfirm({
      kind: "relation",
      from: rel.from,
      to: rel.to,
      relation_type: rel.relation_type,
    });
  }, []);

  const confirmDeleteRelation = useCallback(
    async (from: string, to: string, relation_type: string) => {
      await mutate(() =>
        invoke<KgGraph>("kg_delete_relation", { from, to, relation_type }),
      );
    },
    [mutate],
  );

  // ---- Render ----

  const entityNames = graph.entities.map((e) => e.name);

  return (
    <section className="flex h-full flex-col gap-3 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {/* Cabecera */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Knowledge graph local</h3>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {loading
            ? "cargando…"
            : `${graph.entities.length} entidades · ${graph.relations.length} relaciones`}
        </span>
      </div>

      {/* Banner de error */}
      {error && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Banner de confirmacion */}
      {confirm.kind === "entity" && (
        <ConfirmBanner
          message={`Borrar entidad "${confirm.name}" y todas sus relaciones. Esta accion no se puede deshacer.`}
          onConfirm={() => void confirmDeleteEntity(confirm.name)}
          onCancel={() => setConfirm({ kind: "none" })}
        />
      )}
      {confirm.kind === "relation" && (
        <ConfirmBanner
          message={`Borrar relacion "${confirm.from}" —[${confirm.relation_type}]→ "${confirm.to}".`}
          onConfirm={() =>
            void confirmDeleteRelation(
              confirm.from,
              confirm.to,
              confirm.relation_type,
            )
          }
          onCancel={() => setConfirm({ kind: "none" })}
        />
      )}

      {/* Formulario: nueva entidad */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Nueva entidad
        </div>
        <input
          type="text"
          value={form.entName}
          onChange={(e) => dispatch({ field: "entName", value: e.target.value })}
          placeholder="nombre"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <input
          type="text"
          value={form.entType}
          onChange={(e) => dispatch({ field: "entType", value: e.target.value })}
          placeholder="entityType (por defecto: entity)"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <textarea
          value={form.entObs}
          onChange={(e) => dispatch({ field: "entObs", value: e.target.value })}
          placeholder="observaciones (una por linea)"
          rows={2}
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={() => void createEntity()}
          disabled={!form.entName.trim() || mutating}
          className="mt-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
        >
          Crear entidad
        </button>
      </div>

      {/* Formulario: nueva relacion */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Nueva relacion
        </div>
        <div className="flex items-center gap-1">
          {/* Selector origen */}
          <select
            value={form.relFrom}
            onChange={(e) => dispatch({ field: "relFrom", value: e.target.value })}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            aria-label="Entidad origen"
          >
            <option value="">origen…</option>
            {entityNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>

          {/* Tipo de relacion */}
          <input
            type="text"
            value={form.relType}
            onChange={(e) => dispatch({ field: "relType", value: e.target.value })}
            placeholder="tipo (relates_to)"
            className="w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            aria-label="Tipo de relacion"
          />

          {/* Selector destino */}
          <select
            value={form.relTo}
            onChange={(e) => dispatch({ field: "relTo", value: e.target.value })}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            aria-label="Entidad destino"
          >
            <option value="">destino…</option>
            {entityNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => void createRelation()}
          disabled={!form.relFrom || !form.relTo || form.relFrom === form.relTo || mutating}
          className="mt-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
        >
          Crear relacion
        </button>
      </div>

      {/* Lista de entidades */}
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Entidades
        </div>
        {graph.entities.length === 0 ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            Sin entidades. Usa el formulario de arriba para crear la primera.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {graph.entities.map((e) => (
              <li
                key={e.name}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{e.name}</span>
                      <span className="text-[var(--color-text-tertiary)]">
                        {e.entity_type}
                      </span>
                    </div>
                    {e.observations.length > 0 && (
                      <p className="mt-0.5 truncate text-[var(--color-text-tertiary)]">
                        {e.observations.slice(0, 2).join(" · ")}
                        {e.observations.length > 2
                          ? ` +${e.observations.length - 2} mas`
                          : ""}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => requestDeleteEntity(e.name)}
                    disabled={mutating}
                    aria-label={`Borrar entidad ${e.name}`}
                    className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                    style={{
                      borderColor: "var(--color-danger)",
                      color: "var(--color-danger)",
                    }}
                  >
                    Borrar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Lista de relaciones */}
      {graph.relations.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
            Relaciones
          </div>
          <ul className="space-y-1 text-xs">
            {graph.relations.map((r) => {
              const key = `${r.from}|${r.relation_type}|${r.to}`;
              return (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5"
                >
                  <span className="font-medium">{r.from}</span>
                  <span
                    className="rounded-full border px-1.5 py-px text-[10px]"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    {r.relation_type}
                  </span>
                  <span className="font-medium">{r.to}</span>
                  <button
                    onClick={() => requestDeleteRelation(r)}
                    disabled={mutating}
                    aria-label={`Borrar relacion ${r.from} ${r.relation_type} ${r.to}`}
                    className="ml-auto shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                    style={{
                      borderColor: "var(--color-danger)",
                      color: "var(--color-danger)",
                    }}
                  >
                    Borrar
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
