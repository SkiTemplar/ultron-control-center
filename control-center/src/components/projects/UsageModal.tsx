// Uso de Claude Code del proyecto — coste nocional, modelos, sesion principal
// frente a subagentes y contexto medio por llamada.
//
// Se abre desde la tarjeta "Uso" de ProjectWorkspace (fila Codigo, junto a la
// bitacora). Nada aqui interrumpe: el dato se pide al abrir y la ventana de
// dias se cambia con tres botones. Los importes son nocionales (precio de la
// API por token); con suscripcion sirven para comparar, no para facturar.
import { useEffect, useState } from "react";
import {
  fetchProjectUsage,
  formatContext,
  formatUsd,
  subagentHint,
  type ProjectUsage,
  type UsageSource,
} from "../../lib/project-usage";

const WINDOWS = [7, 30, 90] as const;
const BAR_MAX_PX = 56;

type Props = {
  projectId: string;
  projectName: string;
  onClose: () => void;
};

function SourceRow({ label, s, total }: { label: string; s: UsageSource; total: number }) {
  const share = total > 0 ? (s.costUsd / total) * 100 : 0;
  return (
    <div className="flex items-baseline gap-3 text-[12px]">
      <span className="w-28 shrink-0" style={{ color: "var(--color-text-secondary)" }}>{label}</span>
      <span className="w-20 shrink-0 tabular-nums">{formatUsd(s.costUsd)}</span>
      <span className="w-12 shrink-0 tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>{Math.round(share)} %</span>
      <span className="tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
        {s.messages} llamadas
        {s.messages > 0 && ` · contexto medio ${formatContext(s.avgContextTokens)}`}
      </span>
    </div>
  );
}

export function UsageModal({ projectId, projectName, onClose }: Props) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<ProjectUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const r = await fetchProjectUsage(projectId, days);
        if (cancelled) return;
        if (r.ok) setData(r);
        else setError(`${r.error.code}: ${r.error.message}`);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, days]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxDay = data ? Math.max(...data.byDay.map((d) => d.costUsd), 0) : 0;
  const hint = data ? subagentHint(data) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col rounded"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Uso de Claude en ${projectName}`}
      >
        <header
          className="flex shrink-0 items-baseline justify-between gap-4 border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2 className="text-[14px] font-semibold">Uso de Claude</h2>
            <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {projectName}
              {data && ` · ${data.window.from} a ${data.window.to}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1" role="group" aria-label="Ventana de días">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setDays(w)}
                  aria-pressed={days === w}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: days === w ? "var(--color-accent)" : "var(--color-surface-3)",
                    color: days === w ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  }}
                >
                  {w} d
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-[12px]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
            >
              Cerrar
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
          {error && (
            <p className="text-[12px]" style={{ color: "var(--color-danger, #e5484d)" }}>
              No se pudo calcular el uso: {error}
            </p>
          )}

          {!error && data === null && (
            <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Calculando… la primera vez lee todos los transcripts del proyecto y puede tardar unos segundos.
            </p>
          )}

          {data && data.totals.messages === 0 && (
            <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              No hay uso de Claude Code en esta ventana.
            </p>
          )}

          {data && data.totals.messages > 0 && (
            <>
              <section className="flex flex-wrap gap-x-8 gap-y-2">
                {[
                  ["Coste nocional", formatUsd(data.totals.costUsd)],
                  ["Sesiones", String(data.totals.sessions)],
                  ["Llamadas", data.totals.messages.toLocaleString("es-ES")],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-text-tertiary)" }}>
                      {label}
                    </p>
                    <p className="text-[18px] font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </section>

              <section>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-text-tertiary)" }}>
                  Por día
                </p>
                <div className="flex items-end gap-[2px]" style={{ height: BAR_MAX_PX }}>
                  {data.byDay.map((d) => (
                    <div
                      key={d.day}
                      className="min-w-[2px] flex-1 rounded-t-sm"
                      title={`${d.day}: ${formatUsd(d.costUsd)} · ${d.messages} llamadas`}
                      style={{
                        height: maxDay > 0 ? Math.max(d.costUsd > 0 ? 2 : 0, (d.costUsd / maxDay) * BAR_MAX_PX) : 0,
                        background: "var(--color-accent)",
                        opacity: d.costUsd > 0 ? 1 : 0.15,
                      }}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-text-tertiary)" }}>
                  Sesión principal y subagentes
                </p>
                <SourceRow label="Sesión principal" s={data.bySource.main} total={data.totals.costUsd} />
                <SourceRow label="Subagentes" s={data.bySource.sub} total={data.totals.costUsd} />
                {hint && (
                  <p className="pt-1 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                    {hint}
                  </p>
                )}
              </section>

              <section className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-text-tertiary)" }}>
                  Por modelo
                </p>
                {data.byModel.map((m) => (
                  <div key={m.model} className="flex items-center gap-3 text-[12px]">
                    <span className="w-40 shrink-0 truncate" style={{ fontFamily: "var(--font-mono)" }} title={m.model}>
                      {m.model}
                    </span>
                    <span className="w-20 shrink-0 tabular-nums">{m.priced ? formatUsd(m.costUsd) : "sin precio"}</span>
                    <div className="h-1.5 min-w-0 flex-1 rounded" style={{ background: "var(--color-surface-3)" }}>
                      <div
                        className="h-full rounded"
                        style={{ width: `${Math.min(100, m.sharePct)}%`, background: "var(--color-accent)" }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                      {Math.round(m.sharePct)} %
                    </span>
                  </div>
                ))}
              </section>
            </>
          )}

          {data && data.notes.length > 0 && (
            <ul className="space-y-0.5 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              {data.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
