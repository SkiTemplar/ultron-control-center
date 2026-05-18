import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  refreshButtonPrompts,
  resetButtonPrompt,
  updateButtonPrompt,
  type ButtonPrompt,
  type ButtonPromptsCatalog,
} from "../../lib/button-prompts";

// ---------------------------------------------------------------------------
// Button prompts section — every Control Center button that spawns a Claude
// or Codex session now reads its prompt from a catalog persisted at
// `~/.ultron/cockpit/button-prompts.json`. This panel lists every catalog
// entry with an editable textarea, a Save button (atomic write), a
// "Refine with Claude" button (opens a session asking Claude to improve the
// prompt) and a "Reset" button (drops the override). The consumer components
// import `getPrompt(key, vars)` from `src/lib/button-prompts.ts` so the
// edits take effect on the next click — no app reload required.
// ---------------------------------------------------------------------------

export function ButtonPromptsSection() {
  const [catalog, setCatalog] = useState<ButtonPromptsCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const c = (await invoke("list_button_prompts")) as ButtonPromptsCatalog;
      setCatalog(c);
      const next: Record<string, string> = {};
      for (const b of c.buttons) next[b.key] = b.prompt;
      setDrafts(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function flashSuccess(msg: string) {
    setSuccess(msg);
    window.setTimeout(() => setSuccess(null), 2500);
  }

  async function onSave(key: string) {
    const draft = drafts[key] ?? "";
    setBusy(key);
    setError(null);
    try {
      await updateButtonPrompt(key, draft);
      const next = await refreshButtonPrompts();
      setCatalog(next);
      const persisted = next.buttons.find((b) => b.key === key)?.prompt ?? draft;
      setDrafts((prev) => ({ ...prev, [key]: persisted }));
      flashSuccess(`Saved ${key}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onReset(key: string) {
    setBusy(key);
    setError(null);
    try {
      const restored = await resetButtonPrompt(key);
      const next = await refreshButtonPrompts();
      setCatalog(next);
      setDrafts((prev) => ({ ...prev, [key]: restored.prompt }));
      flashSuccess(`Reset ${key}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRefineWithAI(entry: ButtonPrompt) {
    setBusy(entry.key);
    setError(null);
    try {
      const current = drafts[entry.key] ?? entry.prompt;
      const refinePrompt = [
        `Quiero mejorar el prompt asociado al botón "${entry.label}" del ULTRON Control Center.`,
        `Ubicación: ${entry.location}`,
        `Propósito: ${entry.description || "(sin descripción)"}`,
        entry.vars.length > 0
          ? `Variables disponibles (se sustituyen con valores en runtime): ${entry.vars.map((v) => `{${v}}`).join(", ")}.`
          : "Este prompt no usa variables.",
        "",
        "Prompt actual:",
        "```",
        current,
        "```",
        "",
        "Hazme 1-2 preguntas concretas si necesitas contexto y luego propón una versión mejorada. Mantén las variables {var} intactas. Devuelve sólo el prompt nuevo entre triples backticks para que lo pueda pegar en el Control Center.",
      ].join("\n");
      const { getHomeDir, joinPath } = await import("../../lib/paths");
      const cwd = joinPath(await getHomeDir(), ".ultron");
      await invoke("spawn_session", {
        provider: "claude",
        prompt: refinePrompt,
        cwd,
        flags: { dangerouslySkipPermissions: false },
      });
      flashSuccess(`Claude session opened to refine "${entry.label}"`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    if (!catalog) return [] as ButtonPrompt[];
    const q = filter.trim().toLowerCase();
    if (!q) return catalog.buttons;
    // v15.5.18 (user request): also search the PROMPT body so a user looking
    // for "rebuild" / "qdrant" / specific Spanish phrasing finds the right
    // entry without scrolling. Prior filter only matched key/label/location.
    return catalog.buttons.filter(
      (b) =>
        b.key.toLowerCase().includes(q) ||
        b.label.toLowerCase().includes(q) ||
        b.location.toLowerCase().includes(q) ||
        (b.prompt ?? "").toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  if (loading) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading button prompts…
      </div>
    );
  }

  return (
    <div>
      <p className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
        Each entry here is the prompt that fires when you press an AI-powered
        button somewhere in the Control Center. Edit it, click Save, and the
        next click of that button uses your version. "Refine with Claude"
        opens a Claude session that helps you rewrite the prompt; "Reset"
        drops the override and goes back to the canonical default.
      </p>
      <p
        className="mt-1 text-[10.5px]"
        style={{
          color: "var(--color-text-faint)",
          fontFamily: "var(--font-mono)",
        }}
      >
        ~/.ultron/cockpit/button-prompts.json
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter by key, label, location or prompt text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 rounded px-2 py-1.5 text-[12px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
          }}
        />
        <span
          className="tabular-nums text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {filter ? `${filtered.length} / ${catalog?.buttons.length ?? 0}` : `${catalog?.buttons.length ?? 0}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded px-2.5 py-1.5 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Reload
        </button>
      </div>

      {error && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {filtered.map((b) => {
          const draft = drafts[b.key] ?? "";
          const dirty = draft !== b.prompt;
          const isBusy = busy === b.key;
          return (
            <div
              key={b.key}
              className="rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${b.overridden ? "var(--color-accent)" : "var(--color-border)"}`,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[13px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      {b.label}
                    </span>
                    {b.overridden && (
                      <span
                        className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                        style={{
                          background: "rgba(88, 166, 255, 0.12)",
                          color: "var(--color-accent)",
                        }}
                      >
                        custom
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-0.5 text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {b.location} ·{" "}
                    <span style={{ fontFamily: "var(--font-mono)" }}>{b.key}</span>
                  </div>
                  {b.description && (
                    <div
                      className="mt-1 text-[11.5px]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {b.description}
                    </div>
                  )}
                  {b.vars.length > 0 && (
                    <div
                      className="mt-1 text-[10.5px]"
                      style={{
                        color: "var(--color-text-faint)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      vars: {b.vars.map((v) => `{${v}}`).join(", ")}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void onRefineWithAI(b)}
                    disabled={isBusy}
                    className="rounded px-2.5 py-1 text-[11px] disabled:opacity-40"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                    title="Open a Claude session that helps you rewrite this prompt"
                  >
                    Refine with Claude
                  </button>
                  <button
                    type="button"
                    onClick={() => void onReset(b.key)}
                    disabled={isBusy || !b.overridden}
                    className="rounded px-2.5 py-1 text-[11px] disabled:opacity-30"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-tertiary)",
                      border: "1px solid var(--color-border)",
                    }}
                    title="Drop the override and go back to the default"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => void onSave(b.key)}
                    disabled={isBusy || !dirty}
                    className="rounded px-2.5 py-1 text-[11px] font-medium disabled:opacity-40"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    {isBusy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <textarea
                value={draft}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [b.key]: e.target.value }))
                }
                rows={Math.min(14, Math.max(4, draft.split("\n").length))}
                className="mt-3 w-full rounded p-2.5 text-[12px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${dirty ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  resize: "vertical",
                }}
                spellCheck={false}
              />
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div
            className="rounded p-6 text-center text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No buttons match the filter.
          </div>
        )}
      </div>
    </div>
  );
}
