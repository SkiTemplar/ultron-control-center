// Settings/api-keys/CustomProvidersGroup.tsx — «Personalizadas»: lista de
// proveedores con `custom: true` (Probar / Quitar con confirmación en dos
// pasos) y el formulario de alta.

import { useState } from "react";
import { CustomProviderForm } from "./CustomProviderForm";
import { ProbeButton } from "./ProbeButton";
import type { UseCustomProvidersResult } from "./useCustomProviders";
import type { ProbeState } from "./useModelProbe";

interface CustomProvidersGroupProps {
  custom: UseCustomProvidersResult;
  probes: Record<string, ProbeState>;
  onProbe: (providerId: string) => void;
}

const FEEDBACK_COLORS = {
  ok: "var(--color-success)",
  warn: "var(--color-warning, #f8a000)",
  error: "var(--color-danger)",
} as const;

export function CustomProvidersGroup({ custom, probes, onProbe }: CustomProvidersGroupProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const { customs, loading, loadError, busy, feedback } = custom;

  return (
    <div>
      {loadError && (
        <div role="alert" className="mb-2 flex items-center gap-2 text-[12px]" style={{ color: "var(--color-danger)" }}>
          No se pudo leer el catálogo del router: {loadError}
          <button type="button" onClick={() => void custom.reload()} className="underline">
            Reintentar
          </button>
        </div>
      )}
      {!loadError && customs.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {loading ? "Cargando…" : "No hay proveedores personalizados."}
        </p>
      )}
      {customs.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {customs.map((p) => (
            <li key={p.id} className="rounded p-2.5" style={{ border: "1px solid var(--color-border)" }}>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium">{p.name}</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
                  {p.id} · {p.api_format ?? "?"} · {p.key_env_var ?? "sin variable"}
                </span>
                <span className="flex-1" />
                {confirming === p.id ? (
                  <>
                    <span className="text-[11.5px]" style={{ color: "var(--color-danger)" }}>
                      ¿Quitar del router?
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        void custom.remove(p.id);
                      }}
                      className="rounded px-2 py-0.5 text-[11px] font-medium disabled:opacity-50"
                      style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
                    >
                      Sí, quitar
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded px-2 py-0.5 text-[11px]"
                      style={{ border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(p.id)}
                    className="rounded px-2 py-0.5 text-[11px] font-medium disabled:opacity-50"
                    style={{ border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                  >
                    Quitar
                  </button>
                )}
              </div>
              <p className="mt-0.5 truncate text-[11px]" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
                {p.base_url}
              </p>
              <ProbeButton state={probes[p.id]} onProbe={() => onProbe(p.id)} />
            </li>
          ))}
        </ul>
      )}
      {feedback && (
        <p role="status" className="mt-3 text-[12px]" style={{ color: FEEDBACK_COLORS[feedback.kind] }}>
          {feedback.text}
        </p>
      )}
      <CustomProviderForm busy={busy} onSubmit={custom.submit} />
    </div>
  );
}
