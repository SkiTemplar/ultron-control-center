// ---------------------------------------------------------------------------
// Tarjeta de un MCP
// ---------------------------------------------------------------------------

import type { McpPingResult } from "../../types";
import { ToggleSwitch } from "../skills/ToggleSwitch";
import type { Action, McpInfoExt } from "./types";
import { mcpHealthLine, shouldShowUnknownBadge } from "./cardStatus";
import {
  originBadgeColor,
  originKindLabel,
  parseOrigin,
  statusColor,
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
  /** Si el MCP está activado (sin `disabled: true` y fuera de disabledMcpjsonServers). */
  enabled: boolean;
  toggleBusy: boolean;
  onAction: (a: Action) => void;
  onToggleEnabled: () => void;
}) {
  // Una sola verdad sobre la salud (ver mcpHealthLine): «sin comprobar» si no
  // hay fecha, «comprobado hace 3 meses» si es vieja (color neutro, sin
  // afirmar el estado) y el estado real más su antigüedad si es reciente.
  const health = mcpHealthLine(mcp.status, mcp.expected_offline, mcp.last_checked);
  const stale = health.stale;
  const neverChecked = health.statusText === "sin comprobar";
  const staleTooltip = neverChecked
    ? "No consta ninguna comprobación de este servidor. Pulsa «Comprobar salud» para comprobarlo."
    : stale
      ? `El estado de entonces ya no se da por bueno (${mcp.last_checked}). Pulsa «Comprobar salud» para actualizarlo.`
      : `Última comprobación: ${mcp.last_checked}`;

  const color = statusColor(mcp.status, mcp.expected_offline, stale);
  const label = health.statusText;
  const origin = parseOrigin(mcp.origin);
  const showUnknown = shouldShowUnknownBadge(mcp.unknown, origin.kind);
  const originColors = originBadgeColor(origin.kind);
  // Solo el ámbito de usuario de ~/.claude.json es editable. Los MCP de
  // plugin o de proyecto son de solo lectura (firma del plugin, repo del
  // proyecto). Las entradas heredadas de settings.json solo se pueden borrar:
  // Claude Code nunca las lee.
  const readOnly = origin.kind !== "user";
  const canDelete = origin.kind === "user" || origin.kind === "settings";
  // El interruptor corresponde a disabledMcpjsonServers de Claude Code, que
  // solo aplica al ámbito de proyecto. El ámbito de usuario no tiene
  // interruptor global (es por proyecto, con /mcp): etiqueta fija con motivo.
  const canToggle = origin.kind === "project";
  const disabledNote = mcp.disabled
    ? " Ahora: disabled:true en la configuración; Claude Code no lo arranca."
    : "";
  const lockedReason =
    (origin.kind === "plugin"
      ? `Lo aporta el plugin '${origin.label}'. Para desactivarlo: /plugin disable ${origin.label}.`
      : origin.kind === "user"
        ? "Claude Code no tiene interruptor global para el ámbito de usuario: desactívalo por proyecto con /mcp o bórralo."
        : origin.kind === "settings"
          ? "Claude Code no lee esta entrada: no hay nada que desactivar."
          : `Origen '${origin.label}': edita su fichero para desactivarlo.`) + disabledNote;

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
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: color }}
              title={staleTooltip}
            />
            <h3
              className="min-w-0 truncate text-[16px] font-semibold leading-tight"
              title={mcp.name}
            >
              {mcp.name}
            </h3>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
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
                  ? "Configurado en ~/.claude.json (ámbito de usuario); se puede editar desde aquí"
                  : origin.kind === "settings"
                    ? "Declarado en ~/.claude/settings.json, que Claude Code no lee para los MCP: nunca arranca. Bórralo y vuelve a añadirlo."
                    : origin.kind === "plugin"
                    ? `Lo aporta el plugin '${origin.label}'; aquí es de solo lectura`
                    : origin.kind === "project"
                      ? `Definido en el .mcp.json del proyecto '${origin.label}'; aquí es de solo lectura`
                      : "Origen desconocido"
              }
            >
              {origin.kind === "user"
                ? originKindLabel(origin.kind)
                : origin.kind === "settings"
                  ? "settings.json (sin uso)"
                  : `${originKindLabel(origin.kind)}: ${origin.label}`}
            </span>
            {mcp.expected_offline && (
              <span
                className="text-[10px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                desconexión prevista
              </span>
            )}
            {showUnknown && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "rgba(210, 153, 34, 0.15)",
                  color: "#d29922",
                }}
                title="No está en el catálogo de MCP conocidos y llega con el .mcp.json de un proyecto, no lo has añadido tú: revisa qué ejecuta antes de aprobarlo."
              >
                no reconocido
              </span>
            )}
            {typeof mcp.duplicate_count === "number" && mcp.duplicate_count > 1 && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  background: "rgba(248, 81, 73, 0.12)",
                  color: "var(--color-danger, #f85149)",
                }}
                title={`Declarado ${mcp.duplicate_count} veces. Orígenes: ${(
                  mcp.duplicate_origins ?? []
                ).join(", ")}`}
              >
                ×{mcp.duplicate_count}
              </span>
            )}
          </div>

          {/* Descripción: siempre visible para saber qué hace un MCP desconocido */}
          {mcp.description && (
            <p
              className="mt-1.5 break-words text-[12px] leading-snug"
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
              <span style={{ color: "var(--color-text-faint)" }}>transporte</span> {mcp.transport}
            </span>
            {health.checkedText && (
              <span title={staleTooltip}>{health.checkedText}</span>
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
                  {ping.ok ? "en marcha" : "parado"}
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

          {/* Mensaje de respaldo */}
          {mcp.fallback_message && mcp.status !== "ok" && (
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {mcp.fallback_message}
            </p>
          )}

          {/* Estado activado/desactivado con el patrón común (ToggleSwitch):
              interruptor solo en ámbito de proyecto (disabledMcpjsonServers);
              el resto, etiqueta fija con el motivo en el tooltip. */}
          <div className="mt-3 flex items-center gap-2">
            <ToggleSwitch
              enabled={enabled}
              busy={toggleBusy}
              readonly={!canToggle}
              onToggle={onToggleEnabled}
              lockedReason={lockedReason}
              disableTitle="Desactivar (lo añade a disabledMcpjsonServers en settings.json)"
              enableTitle="Activar (lo quita de disabledMcpjsonServers)"
              withLabel
            />
          </div>
        </div>

        {/* Sin «Reintentar» por tarjeta: la comprobación de salud es global
            (reescribe mcp-health.json entero de una pasada), así que un botón
            por tarjeta mentiría sobre su alcance. Esa acción es del botón
            «Comprobar salud» de la cabecera. */}
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
            title="stdio: ejecuta el comando (sin ventana, con su env) y espera la respuesta a initialize. HTTP/SSE: envía initialize a la URL. Límite de 10 s."
          >
            {pingBusy ? "Probando…" : "Probar"}
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
                ? `El origen «${originKindLabel(origin.kind)}» es de solo lectura desde el Control Center`
                : "Editar la entrada de este MCP en ~/.claude.json"
            }
          >
            Editar
          </button>
          <button
            type="button"
            onClick={() => onAction("delete")}
            disabled={!canDelete}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.10)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.35)",
            }}
            title={
              !canDelete
                ? `El origen «${originKindLabel(origin.kind)}» es de solo lectura desde el Control Center`
                : origin.kind === "settings"
                  ? "Quitar la entrada sin uso de ~/.claude/settings.json (se guarda un backup)"
                  : "Quitar de ~/.claude.json (se guarda un backup)"
            }
          >
            Borrar
          </button>
        </div>
      </div>
    </div>
  );
}
