import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EventoHook } from "./constants";
import type { HookRecord, HookMutationResult } from "./types";

export function HookFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: HookRecord;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [event, setEvent] = useState<string>(initial?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState<string>(initial?.matcher ?? "");
  const [command, setCommand] = useState<string>(initial?.command ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Los eventos los sirve el backend: es la MISMA lista que valida `add_hook`.
  // Sin catalogo no se inventa uno de repuesto — eso es lo que hacia que el
  // desplegable ofreciera eventos que el backend rechazaba.
  const [eventos, setEventos] = useState<EventoHook[] | null>(null);

  useEffect(() => {
    void invoke<EventoHook[]>("hooks_event_catalog")
      .then((l) => setEventos(l ?? []))
      .catch((e) => {
        setEventos([]);
        setErr(`No pude leer el catálogo de eventos: ${String(e)}`);
      });
  }, []);

  const ficha = useMemo(
    () => eventos?.find((x) => x.nombre === event) ?? null,
    [eventos, event],
  );

  async function submit() {
    if (!command.trim()) {
      setErr("Command cannot be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (mode === "add") {
        const res = (await invoke("add_hook", {
          event,
          matcher: matcher.trim() || null,
          command,
        })) as HookMutationResult;
        onSaved(`Added hook. Backup: ${res.backup_path ?? "n/a"}`);
      } else if (initial) {
        const res = (await invoke("update_hook", {
          id: initial.id,
          command,
          enabled: null,
          matcher: matcher.trim() || null,
        })) as HookMutationResult;
        onSaved(`Updated hook. Backup: ${res.backup_path ?? "n/a"}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">
          {mode === "add" ? "Add hook" : "Edit hook"}
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Event
          </div>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            disabled={mode === "edit"}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {(eventos ?? []).map((e) => (
              <option key={e.nombre} value={e.nombre}>
                {e.nombre}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <div className="mt-1 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              Event is immutable. Delete and re-add to change it.
            </div>
          )}
        </label>

        {/* El matcher solo aparece cuando el evento compara algo de verdad. En
            los que no (Stop, UserPromptSubmit, TaskCreated…) cualquier matcher
            casa siempre: ofrecer la caja seria prometer un filtro que no
            existe. */}
        {ficha?.campo ? (
          <label className="mb-3 block text-[12px]">
            <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
              Matcher (opcional) — se compara contra <code>{ficha.campo}</code>
              {ficha.relajado ? ", separando con | , o espacio" : ", separando SOLO con |"}
            </div>
            <input
              type="text"
              list={ficha.valores.length > 0 ? "hook-matcher-valores" : undefined}
              value={matcher}
              onChange={(e) => setMatcher(e.target.value)}
              className="w-full rounded px-2 py-1"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
              }}
            />
            {ficha.valores.length > 0 && (
              <datalist id="hook-matcher-valores">
                {ficha.valores.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            )}
          </label>
        ) : (
          ficha && (
            <div className="mb-3 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              {ficha.nombre} no compara ningún campo: no admite matcher, se dispara siempre.
            </div>
          )
        )}

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #f88)" }}
          >
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {saving ? "Saving..." : mode === "add" ? "Add hook" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
