// ---------------------------------------------------------------------------
// MCP card
// ---------------------------------------------------------------------------

import type { McpPingResult } from "../../types";
import type { Action, McpInfoExt } from "./types";
import {
  ageMs,
  formatAge,
  isStaleTimestamp,
  originBadgeColor,
  parseOrigin,
  statusColor,
  statusLabel,
} from "./utils";

export function Card({
  mcp,
  hidden,
  ping,
  pingBusy,
  enabled,
  toggleBusy,
  onAction,
  onToggleEnabled,
}: {
  mcp: McpInfoExt;
  hidden: boolean;
  ping?: McpPingResult;
  pingBusy?: boolean;
  /** Whether the MCP is currently enabled (disabled flag = false in settings.json). */
  enabled: boolean;
  toggleBusy: boolean;
  onAction: (a: Action) => void;
  onToggleEnabled: () => void;
}) {
  // Determinar si el estado en cache es demasiado antiguo para mostrarlo
  // como estado verificado. Si last_checked supera STALE_THRESHOLD_MS (o no
  // existe), el badge se muestra en neutro con tooltip explicativo.
  const stale = isStaleTimestamp(mcp.last_checked);
  const staleAge = mcp.last_checked ? ageMs(mcp.last_checked) : null;
  const staleTooltip = stale
    ? staleAge !== null
      ? `Estado sin verificar (cache de ${formatAge(staleAge)}). Ejecuta "Run health check" para actualizar.`
      : `Estado sin verificar (sin timestamp de verificación). Ejecuta "Run health check" para actualizar.`
    : undefined;

  const color = statusColor(mcp.status, mcp.expected_offline, stale);
  const label = statusLabel(mcp.status, mcp.expected_offline, stale);
  const origin = parseOrigin(mcp.origin);
  const originColors = originBadgeColor(origin.kind);
  // Plugin / project-scope MCPs are read-only from the Control Center —
  // mutating them would invalidate the plugin's signature or wander into
  // a project's repo. Surface this clearly rather than silently failing.
  const readOnly = origin.kind !== "user";
  // The enable/disable toggle covers user scope (settings.json) AND project
  // scope (Claude Code's disabledMcpjsonServers). Plugin / unknown origins
  // stay non-toggleable but show an honest reason instead of a dead switch.
  const canToggle = origin.kind === "user" || origin.kind === "project";

  return (
    <div
      className="rounded-lg p-5 transition-opacity"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        opacity: hidden ? 0.45 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: color }}
              title={staleTooltip}
            />
            <h3 className="text-[16px] font-semibold leading-tight">{mcp.name}</h3>
            <span
              className="text-[11px] uppercase tracking-[0.06em]"
              style={{ color }}
              title={staleTooltip}
            >
              {label}
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
              style={{ background: originColors.bg, color: originColors.fg }}
              title={
                origin.kind === "user"
                  ? "Configured in ~/.claude/settings.json — editable from here"
                  : origin.kind === "plugin"
                    ? `Provided by plugin '${origin.label}' — read-only here`
                    : origin.kind === "project"
                      ? `Defined in project '${origin.label}' .mcp.json — read-only here`
                      : "Unknown origin"
              }
            >
              {origin.kind === "user"
                ? "user"
                : `${origin.kind}: ${origin.label}`}
            </span>
            {mcp.expected_offline && (
              <span
                className="text-[10px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                expected offline
              </span>
            )}
            {mcp.unknown && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "rgba(210, 153, 34, 0.15)",
                  color: "#d29922",
                }}
                title="Servidor no reconocido — revisa qué hace antes de confiar en él."
              >
                desconocido
              </span>
            )}
            {typeof mcp.duplicate_count === "number" && mcp.duplicate_count > 1 && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  background: "rgba(248, 81, 73, 0.12)",
                  color: "var(--color-danger, #f85149)",
                }}
                title={`Declarado ${mcp.duplicate_count} veces. Origenes: ${(
                  mcp.duplicate_origins ?? []
                ).join(", ")}`}
              >
                x{mcp.duplicate_count}
                {mcp.duplicate_origins && mcp.duplicate_origins.length > 0
                  ? ` (origenes: ${mcp.duplicate_origins.join(", ")})`
                  : ""}
              </span>
            )}
            {mcp.disabled && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
                title="disabled:true en la config — Claude Code no lo arranca."
              >
                disabled
              </span>
            )}
          </div>

          {/* Description — always shown so users know what unfamiliar MCPs do */}
          {mcp.description && (
            <p
              className="mt-1.5 text-[12px] leading-snug"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {mcp.description}
            </p>
          )}

          <div
            className="mt-2 flex items-center gap-3 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <span>
              <span style={{ color: "var(--color-text-faint)" }}>transport</span> {mcp.transport}
            </span>
            {mcp.last_checked && (
              <span>
                <span style={{ color: "var(--color-text-faint)" }}>checked</span>{" "}
                {mcp.last_checked.slice(0, 16).replace("T", " ")}
              </span>
            )}
            {ping && (
              <span>
                <span style={{ color: "var(--color-text-faint)" }}>ping</span>{" "}
                <span
                  style={{
                    color: ping.ok
                      ? "var(--color-success)"
                      : "var(--color-danger)",
                  }}
                >
                  {ping.ok ? "running" : "stopped"}
                </span>
                {ping.latency_ms != null && (
                  <span
                    className="ml-1"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    {ping.latency_ms} ms
                  </span>
                )}
              </span>
            )}
          </div>

          {/* fallback message */}
          {mcp.fallback_message && mcp.status !== "ok" && (
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {mcp.fallback_message}
            </p>
          )}

          {/* Per-card enable/disable toggle.
              Only user-scope entries can be toggled here because the
              disabled flag lives in ~/.claude/settings.json mcpServers.
              Plugin/project MCPs are declared outside that file — to
              disable them, remove or disable the plugin that provides them. */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleEnabled}
              disabled={toggleBusy || !canToggle}
              className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
              style={{
                background: enabled ? "var(--color-success)" : "var(--color-surface-3)",
                border: "1px solid var(--color-border-strong)",
                padding: "1px",
              }}
              title={
                !canToggle
                  ? origin.kind === "plugin"
                    ? `Lo provee el plugin '${origin.label}'. Para desactivarlo: /plugin disable ${origin.label}.`
                    : `Origen '${origin.label}' (user scope en ~/.claude.json). Edita ese fichero para desactivarlo.`
                  : origin.kind === "project"
                    ? enabled
                      ? "Desactivar (añade a disabledMcpjsonServers en settings.json)"
                      : "Activar (quita de disabledMcpjsonServers)"
                    : enabled
                      ? "Desactivar (escribe disabled:true en settings.json)"
                      : "Activar (quita disabled de settings.json)"
              }
            >
              <span
                className="block h-3.5 w-3.5 rounded-full transition-transform"
                style={{
                  background: "var(--color-text)",
                  transform: enabled ? "translateX(16px)" : "translateX(0)",
                }}
              />
            </button>
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {toggleBusy
                ? "Saving…"
                : !canToggle
                  ? origin.kind === "plugin"
                    ? `plugin: ${origin.label}`
                    : `${origin.label}`
                  : enabled
                    ? "Enabled"
                    : "Disabled"}
            </span>
          </div>
        </div>

        {/* No per-card "Retry": the health probe is global (it rewrites the
            whole mcp-health.json in one pass), so a per-card button would lie
            about its scope. The "Run health check" button in the tab header
            owns that action. */}
        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onAction("test")}
            disabled={!!pingBusy}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Spawn the MCP command and wait for an initialize response (2s budget)"
          >
            {pingBusy ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            onClick={() => onAction("edit")}
            disabled={readOnly}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={
              readOnly
                ? `Origin '${origin.kind}' is read-only from the Control Center`
                : "Edit this MCP's settings.json entry"
            }
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onAction("delete")}
            disabled={readOnly}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.10)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.35)",
            }}
            title={
              readOnly
                ? `Origin '${origin.kind}' is read-only from the Control Center`
                : "Remove from settings.json (backup kept)"
            }
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
