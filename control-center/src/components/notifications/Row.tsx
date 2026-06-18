import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getUltronRoot } from "../../lib/paths";
import { useRoutingTitle } from "../../lib/button-prompts";
import type { Grouped, FixProvider, OnDismissRow } from "./types";
import { severityStyle } from "./severity";
import { buildFixAlertBlock } from "./buildBulkAlertsBlock";

export function Row({ g, onDismiss }: { g: Grouped; onDismiss: OnDismissRow }) {
  const s = severityStyle(g.severity);
  const subtle = s.weight === 0;
  // The Fix button is only meaningful for severity buckets that severityStyle
  // maps to weight 2 ("critical" or "blocking"). Warn/info show nothing —
  // the user explicitly didn't want noise on those.
  const isCritical = s.weight === 2;

  // Per-row spawn state. Local state (not lifted) because each card spawns
  // independently — two simultaneous Fix clicks on different cards should
  // both work without one stomping the other's status.
  const [fixBusy, setFixBusy] = useState<FixProvider | null>(null);
  // The zone (notif_fix) only lends model/agent here — the provider is
  // forced by which Fix button the user clicks (Claude vs Codex).
  const fixClaudeTitle = useRoutingTitle(
    "notif.fix_one",
    "Spawn an interactive Claude session with this error pre-loaded on the clipboard. Paste with Ctrl+V to start the fix.",
  );
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixToast, setFixToast] = useState<string | null>(null);

  async function openFixSession(provider: FixProvider) {
    if (fixBusy) return;
    setFixBusy(provider);
    setFixError(null);
    setFixToast(null);
    try {
      // v15.2.40: prompt body comes from the central catalog (key
      // `notif.fix_one`, zone `notif_fix`). The per-row Claude / Codex
      // toggle is a deliberate user override — they explicitly picked
      // which CLI to spawn, so we ignore the router's provider but still
      // honour model/agent (relevant when auto-mode picks a subagent
      // for Claude, or when the user set a non-default model).
      const { getPrompt } = await import("../../lib/button-prompts");
      const alertBlock = buildFixAlertBlock(g);
      const prompt = await getPrompt("notif.fix_one", { alert_block: alertBlock });
      // cwd = ~/.ultron so the spawned shell starts where the relevant
      // scripts, hooks, alerts.jsonl and logs live — diagnosing a system
      // alert from C:\Users\<user>\ has zero context.
      const cwd = await getUltronRoot().catch(() => null);
      // v2.0: no AI Router. The provider is whatever the user picked
      // on the per-row Fix toggle; model/agent are the provider's defaults.
      await invoke("spawn_session", {
        provider,
        prompt,
        cwd,
        // paste_only = true → wrapper copies the prompt to the clipboard and
        // opens the terminal. The user pastes with Ctrl+V and hits Enter.
        flags: { dangerouslySkipPermissions: false, pasteOnly: true },
      });
      setFixToast(`Claude session opened — paste prompt with Ctrl+V`);
      // Auto-clear the toast after a few seconds so the card returns to its
      // resting state. The error path intentionally does not auto-clear.
      window.setTimeout(() => setFixToast(null), 5000);
    } catch (e) {
      setFixError(String(e));
    } finally {
      setFixBusy(null);
    }
  }

  const rowFp = `${g.source}::${(g.message ?? "").trim().replace(/\s+/g, " ").slice(0, 80)}`;

  return (
    <div
      className="group/row flex items-start gap-3 rounded p-3"
      style={{
        background: s.bg,
        border: `1px solid ${s.ring}`,
      }}
    >
      <span
        className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: s.color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: s.color }}
          >
            {s.label}
          </span>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {g.source}
          </span>
          {g.count > 1 && (
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
              }}
            >
              ×{g.count}
            </span>
          )}
          {g.last_ts && (
            <span
              className="ml-auto text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {g.last_ts.slice(0, 16).replace("T", " ")}
            </span>
          )}
          {/* Per-row dismiss — always visible, hides only this notification */}
          <button
            type="button"
            onClick={() => onDismiss(rowFp)}
            title="Ocultar esta notificacion"
            className="ml-1 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100"
            style={{ color: "var(--color-text-tertiary)", lineHeight: 1 }}
            aria-label="Descartar"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div
          className="mt-1 text-[12.5px] leading-snug"
          style={{
            color: subtle ? "var(--color-text-secondary)" : "var(--color-text)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          title={g.message}
        >
          {g.message}
        </div>
        {isCritical && (
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openFixSession("claude")}
              disabled={fixBusy !== null}
              title={fixClaudeTitle}
              className="rounded px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {fixBusy === "claude" ? "Opening…" : "Fix with Claude"}
            </button>
            {fixToast && (
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {fixToast}
              </span>
            )}
            {fixError && (
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-danger)" }}
                title={fixError}
              >
                Failed to open session: {fixError.slice(0, 80)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
