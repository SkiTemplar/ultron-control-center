import type { HookLastFired } from "../../types";
import { X } from "../library/icons";
import { eventColors } from "./constants";
import type { HookRecord, HookFire } from "./types";

export function HookDetailPane({
  hook,
  displayName,
  lastFired,
  fires,
  firesInstrumented,
  firesLogPath,
  onTest,
  onEdit,
  onToggle,
  onNameThis,
  onDelete,
  onClose,
}: {
  hook: HookRecord;
  displayName: string | undefined;
  lastFired: HookLastFired | undefined;
  fires: HookFire[];
  firesInstrumented: boolean;
  firesLogPath: string | null;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onNameThis: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const colors = eventColors(hook.event);

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ background: "var(--color-surface-2)" }}
    >
      {/* Header — ribbon comes from event color */}
      <header
        className="flex items-start justify-between gap-2 border-b p-3"
        style={{
          borderColor: "var(--color-border)",
          boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {displayName ? (
              <span
                className="truncate text-[13.5px] font-semibold"
                style={{ color: "var(--color-text)" }}
                title={hook.id}
              >
                {displayName}
              </span>
            ) : (
              <span
                className="truncate text-[12.5px] font-semibold"
                style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                title={hook.id}
              >
                {hook.id}
              </span>
            )}
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                background: colors.chipBg,
                color: colors.chipFg,
                border: `1px solid ${colors.chipBorder}`,
              }}
            >
              {hook.event}
            </span>
          </div>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
          >
            {displayName && (
              <span style={{ color: "var(--color-text-tertiary)" }}>{hook.id}</span>
            )}
            <span>matcher: {hook.matcher ?? "(any)"}</span>
            <span>source: {hook.source}</span>
            <span>{hook.enabled ? "enabled" : "disabled"}</span>
            {lastFired?.timestamp && (
              <span title={`in ${lastFired.project ?? "?"}`}>
                last fired {lastFired.timestamp.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
          }}
          title="Close detail panel"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <button
          type="button"
          onClick={onTest}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          title="Run this hook against a mock payload in a sandboxed shell"
        >
          Test
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "var(--color-surface-3)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
          title="Edit matcher / command / extra flags"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "var(--color-border-strong)",
            color: hook.enabled ? "var(--color-text-secondary)" : colors.chipFg,
          }}
          title={hook.enabled ? "Disable this hook" : "Enable this hook"}
        >
          {hook.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onNameThis}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text-secondary)",
          }}
          title="Assign a readable name using AI Router (or heuristic fallback)"
        >
          Name
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "rgba(248, 81, 73, 0.30)",
            color: "var(--color-danger, #f88)",
          }}
          title="Delete this hook from settings.json"
        >
          Delete
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Command
          </div>
          <pre
            className="overflow-auto rounded border p-2 text-[11.5px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            <code>{hook.command}</code>
          </pre>
        </div>

        {Object.keys(hook.extra).length > 0 && (
          <div className="mb-4">
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Extra flags
            </div>
            <pre
              className="overflow-auto rounded border p-2 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <code>{JSON.stringify(hook.extra, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Recent fires */}
        <div>
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Recent fires
          </div>
          {!firesInstrumented && (
            <div
              className="rounded border px-2 py-1.5 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
              }}
            >
              No fire history available.
            </div>
          )}
          {firesInstrumented && fires.length === 0 && (
            <div className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              No fires logged for this hook yet.
            </div>
          )}
          {firesInstrumented && fires.length > 0 && (
            <ul className="space-y-1">
              {fires.map((f, i) => (
                <li
                  key={i}
                  className="rounded border px-2 py-1 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-1)",
                  }}
                >
                  <div style={{ color: "var(--color-text)" }}>
                    {f.timestamp ?? "(no ts)"} · exit{" "}
                    <span
                      style={{
                        color: f.exit_code === 0 ? "var(--color-success)" : "var(--color-warn)",
                      }}
                    >
                      {f.exit_code ?? "?"}
                    </span>
                  </div>
                  <div style={{ color: "var(--color-text-tertiary)" }}>
                    {f.event ?? "?"} / {f.matcher ?? "any"}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {firesLogPath && (
            <div className="mt-2 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              Log:{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{firesLogPath}</code>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
