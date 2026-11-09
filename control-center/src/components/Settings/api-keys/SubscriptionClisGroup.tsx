// Settings/api-keys/SubscriptionClisGroup.tsx — «Suscripciones (CLI)»:
// motores que van con la sesión de su CLI y no con una key (Codex,
// Antigravity, claude -p). Solo informa: el estado sale de
// ai_router_delegation_status (delegate.mjs status --json) y se pide al abrir
// la sección o con «Comprobar».

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { handleExternalClick } from "../../../lib/openExternal";
import type { DelegationStatus, EngineStatus } from "../../AIRouter/delegationTypes";
import { SUBSCRIPTION_CLIS } from "./key-catalog";

interface SubscriptionClisGroupProps {
  /** Lo pone a true la sección al abrirse por primera vez. */
  active: boolean;
}

function statusLine(engine: EngineStatus | undefined): { text: string; ok: boolean | null } {
  if (!engine) return { text: "No figura en la cadena de delegación.", ok: null };
  if (!engine.installed) return { text: "CLI no instalado.", ok: false };
  const quota = engine.quota ? ` · ${Math.round(engine.quota.usedPct)} % usado (${engine.quota.window})` : "";
  if (engine.available) return { text: `Instalado y disponible${quota}.`, ok: true };
  return { text: `Instalado, no disponible: ${engine.reason ?? "sin motivo"}${quota}.`, ok: false };
}

export function SubscriptionClisGroup({ active }: SubscriptionClisGroupProps) {
  const [status, setStatus] = useState<DelegationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const check = useCallback(async () => {
    setRequested(true);
    setLoading(true);
    try {
      setStatus(await invoke<DelegationStatus>("ai_router_delegation_status"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !requested) void check();
  }, [active, requested, check]);

  return (
    <div>
      <ul className="flex flex-col gap-2.5">
        {SUBSCRIPTION_CLIS.map((cli) => {
          const engine = status?.engines.find((e) => e.id === cli.engineId);
          const line = status ? statusLine(engine) : null;
          const color =
            line?.ok === true ? "var(--color-success)" : line?.ok === false ? "var(--color-danger)" : "var(--color-text-tertiary)";
          return (
            <li key={cli.engineId} className="text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{cli.label}</span>
                <a
                  href={cli.docsUrl}
                  target="_blank"
                  onClick={handleExternalClick}
                  rel="noopener noreferrer"
                  className="text-[10.5px]"
                  style={{ color: "var(--color-accent)" }}
                >
                  Documentación ↗
                </a>
              </div>
              <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                {cli.description}
              </p>
              {line && (
                <p className="mt-0.5 text-[11.5px]" style={{ color }}>
                  {line.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void check()}
          disabled={loading}
          className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-secondary)",
          }}
        >
          {loading ? "Comprobando…" : "Comprobar"}
        </button>
        {error && (
          <span role="alert" className="text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            No se pudo leer el estado: {error}
          </span>
        )}
      </div>
    </div>
  );
}
