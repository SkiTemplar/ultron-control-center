// ULTRON Control Center 2.0 — Card create/edit modal
//
// Fields: title, description (markdown textarea), agent (text input —
// agent-picker dropdown integrates in sub-commit 7), prompt template with
// {var} preview, cwd override, tags. Save calls kanban_create_card /
// kanban_update_card. "Abrir en Sessions" abre una sesión visible del
// proyecto (sesiones_launch) y deja el prompt de la tarjeta en el
// portapapeles. Sustituye a "Run again" (kanban_dispatch_card), que lanzaba un
// Claude invisible, sin el prompt y con bypass de permisos; ese despacho se
// retiró el 2026-10-17 (H12 de la auditoría).
//
// v2.6: the "power user" fields (agent, cwd override, prompt template) live
// behind a collapsible "Advanced" section so the main form stays focused on
// title / priority / description / tags. Each advanced field carries a
// `title` tooltip explaining its purpose.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Save, X } from "./icons";
import type { Card, KanbanBoard } from "../../types";

type Props =
  | {
      projectId: string;
      board: KanbanBoard;
      mode: "create";
      columnId: string;
      card: null;
      onClose: () => void;
      onSaved: () => void;
    }
  | {
      projectId: string;
      board: KanbanBoard;
      mode: "edit";
      columnId: string;
      card: Card;
      onClose: () => void;
      onSaved: () => void;
    };

export default function CardEditorModal(props: Props) {
  const { projectId, mode, columnId, onClose, onSaved, board } = props;
  const initial = mode === "edit" ? props.card : null;

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? "");
  const [promptTemplate, setPromptTemplate] = useState(
    initial?.prompt_template ?? "",
  );
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [tags, setTags] = useState(
    (initial?.tags ?? []).filter((t) => !/^p\d$/.test(t)).join(", "),
  );
  // v2.6: priority selector — extracted from the first `pN` tag, written
  // back on save so ProjectBoard's badge logic keeps working.
  const [priority, setPriority] = useState<"" | "p0" | "p1" | "p2" | "p3">(
    () => {
      const p = (initial?.tags ?? []).find((t) => /^p\d$/.test(t));
      if (p === "p0" || p === "p1" || p === "p2" || p === "p3") return p;
      return "";
    },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const preview = useMemo(() => {
    // La plantilla del tablero también lleva variables: antes se enseñaba (y
    // se habría copiado) con los {title} sin sustituir.
    const template = promptTemplate || board.default_prompt_template || "";
    return template
      .replace(/\{title\}/g, title)
      .replace(/\{description\}/g, description)
      .replace(/\{tags\}/g, tags)
      .replace(/\{card_id\}/g, initial?.id ?? "<new>");
  }, [promptTemplate, title, description, tags, initial?.id, board.default_prompt_template]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !/^p\d$/.test(t)); // strip stale priority tags
    if (priority) tagList.unshift(priority);
    try {
      if (mode === "create") {
        await invoke("kanban_create_card", {
          projectId,
          columnId,
          partial: {
            title: title.trim() || "Sin título",
            description,
            agent: agent || null,
            prompt_template: promptTemplate || null,
            cwd: cwd || null,
            tags: tagList,
          },
        });
      } else {
        await invoke("kanban_update_card", {
          projectId,
          cardId: initial!.id,
          patch: {
            title,
            description,
            agent: agent || null,
            prompt_template: promptTemplate || null,
            cwd: cwd || null,
            tags: tagList,
          },
        });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Texto que se pega en la sesión: la vista previa de la plantilla o, sin
  // plantilla, el título y la descripción de la tarjeta.
  const sessionPrompt = (
    preview.trim() || [title.trim(), description.trim()].filter(Boolean).join("\n\n")
  ).trim();

  const openInSessions = async () => {
    if (mode !== "edit") return;
    setError(null);
    setInfo(null);
    let copied = false;
    let copyError: string | null = null;
    if (sessionPrompt) {
      try {
        await navigator.clipboard.writeText(sessionPrompt);
        copied = true;
      } catch (e) {
        copyError = String(e);
      }
    }
    try {
      await invoke("sesiones_launch", { projectId });
    } catch (e) {
      setError(`No se pudo abrir la sesión en Sessions: ${String(e)}`);
      return;
    }
    setInfo(
      copied
        ? "Sesión abierta en Sessions. El prompt de la tarjeta está en el portapapeles: pégalo con Ctrl+V y revísalo antes de enviar."
        : copyError
        ? `Sesión abierta en Sessions, pero no se pudo copiar el prompt (${copyError}): cópialo de la vista previa.`
        : "Sesión abierta en Sessions. La tarjeta no tiene título ni plantilla que copiar.",
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-3xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <h2 className="text-sm font-semibold">
            {mode === "create" ? "Nueva tarjeta" : "Editar tarjeta"}
          </h2>
          <button onClick={onClose} aria-label="Cerrar">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4 p-4 text-xs">
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder="Título de la tarjeta"
            />
          </div>
          {/* v2.6: priority selector. */}
          <div className="col-span-2 flex items-center gap-2">
            <label className="text-[var(--color-text-muted)]">Prioridad</label>
            <div
              className="flex items-center gap-0.5 rounded p-0.5"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {(["", "p0", "p1", "p2", "p3"] as const).map((p) => {
                const active = priority === p;
                const label = p === "" ? "Ninguna" : p.toUpperCase();
                return (
                  <button
                    key={p || "none"}
                    type="button"
                    onClick={() => setPriority(p)}
                    className="rounded px-2 py-0.5 text-[11.5px] font-medium uppercase tracking-wide transition-colors"
                    style={{
                      background: active
                        ? "var(--color-surface-3)"
                        : "transparent",
                      color: active
                        ? "var(--color-text)"
                        : "var(--color-text-tertiary)",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">
              Descripción (markdown)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono"
              placeholder="Qué hay que hacer…"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">Etiquetas (separadas por comas)</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder="bug, p1, docs"
            />
          </div>
          {/* v2.6 Advanced section — collapsed by default. Holds the
              power-user fields (agent override, cwd override, prompt
              template). Each label has a `title` tooltip explaining the
              intent so first-time users aren't lost. */}
          <div className="col-span-2">
            <details className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)]">
              <summary className="cursor-pointer list-none px-3 py-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                  &#9656;
                </span>
                Avanzado (agente, directorio, plantilla de prompt)
              </summary>
              <div className="grid grid-cols-2 gap-4 border-t border-[var(--color-border)] p-3">
                <div>
                  <label
                    className="mb-1 flex items-center gap-1 text-[var(--color-text-muted)]"
                    title="Agente IA que se ejecutará al lanzar esta tarjeta (opcional)"
                  >
                    Agente
                    <span
                      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[var(--color-border)] text-[9px] text-[var(--color-text-muted)]"
                      title="Agente IA que se ejecutará al lanzar esta tarjeta (opcional). Si lo dejas en blanco se usa el agente por defecto del proyecto."
                      aria-label="Info"
                    >
                      i
                    </span>
                  </label>
                  <input
                    value={agent ?? ""}
                    onChange={(e) => setAgent(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
                    placeholder={board.default_agent ?? "(el del proyecto)"}
                  />
                </div>
                <div>
                  <label
                    className="mb-1 flex items-center gap-1 text-[var(--color-text-muted)]"
                    title="Cambiar el directorio de trabajo solo para esta tarjeta (opcional, default: directorio del proyecto)"
                  >
                    Directorio de trabajo
                    <span
                      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[var(--color-border)] text-[9px] text-[var(--color-text-muted)]"
                      title="Cambiar el directorio de trabajo solo para esta tarjeta (opcional). Por defecto se usa el directorio del proyecto."
                      aria-label="Info"
                    >
                      i
                    </span>
                  </label>
                  <input
                    value={cwd ?? ""}
                    onChange={(e) => setCwd(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
                    placeholder="(ruta del proyecto)"
                  />
                </div>
                <div className="col-span-2">
                  <label
                    className="mb-1 flex items-center gap-1 text-[var(--color-text-muted)]"
                    title="Plantilla de prompt que se enviará al agente al lanzar (opcional)"
                  >
                    Plantilla de prompt (admite {"{title}"} {"{description}"} {"{tags}"} {"{card_id}"})
                    <span
                      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[var(--color-border)] text-[9px] text-[var(--color-text-muted)]"
                      title="Plantilla de prompt que se enviará al agente al lanzar. Soporta los placeholders {title}, {description}, {tags} y {card_id}."
                      aria-label="Info"
                    >
                      i
                    </span>
                  </label>
                  <textarea
                    value={promptTemplate ?? ""}
                    onChange={(e) => setPromptTemplate(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono"
                    placeholder={board.default_prompt_template ?? "Plantilla libre…"}
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-[var(--color-text-muted)]">Vista previa</label>
                  <pre className="max-h-32 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono whitespace-pre-wrap">
                    {preview || "(vacía)"}
                  </pre>
                </div>
              </div>
            </details>
          </div>
          {mode === "edit" && initial && initial.runs.length > 0 && (
            <div className="col-span-2">
              <label className="mb-1 block text-[var(--color-text-muted)]">Ejecuciones</label>
              <ul className="max-h-32 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono text-[10px]">
                {initial.runs.map((r) => (
                  <li key={r.session_id} className="py-0.5">
                    <div className="flex justify-between">
                      <span>{r.session_id.slice(-14)}</span>
                      <span
                        className={r.status.kind === "failed" ? "text-[var(--color-error)]" : undefined}
                      >
                        {r.status.kind}
                      </span>
                    </div>
                    {r.error && (
                      <p className="whitespace-normal font-sans text-[var(--color-text-muted)]">
                        {r.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {error && (
          <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
            {error}
          </div>
        )}
        {info && (
          <div
            role="status"
            className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-muted)]"
          >
            {info}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2">
          {mode === "edit" && (
            <button
              onClick={() => void openInSessions()}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)]"
              title="Abre una sesión visible del proyecto en Sessions y copia el prompt de la tarjeta al portapapeles"
            >
              <Play size={11} /> Abrir en Sessions
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:opacity-50"
          >
            <Save size={11} /> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
