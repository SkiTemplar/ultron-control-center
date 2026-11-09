// Diagnostics — Toolbox Panel (Windows fixes, collapsible)

import type { Fix, FixCategory } from "./types";
import { FIX_CATALOG, CATEGORY_LABELS, CATEGORY_ORDER } from "./catalogs";

// Fixes that only launch a console, wizard or app read "Abrir"; the ones that
// change the system and ask first (fix.confirm) get an amber button. Depende
// de que el `detail` del catálogo empiece por «Abre» o «Lanza».
function opensOnly(fix: Fix): boolean {
  return /^(Abre|Lanza)\s/.test(fix.detail);
}

function ToolboxCard({ fix, runFix, fixBusy }: { fix: Fix; runFix: (fix: Fix) => void | Promise<void>; fixBusy: string | null }) {
  const busy = fixBusy === fix.kind;
  const risky = fix.confirm !== undefined;
  return (
    <div className="flex items-start justify-between gap-2 rounded p-2"
      style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold" style={{ color: "var(--color-text)" }}>{fix.label}</div>
        <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--color-text-tertiary)" }} title={fix.detail}>{fix.detail}</div>
      </div>
      <button
        type="button"
        onClick={() => void runFix(fix)}
        disabled={fixBusy !== null}
        className="shrink-0 rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
        style={{
          borderColor: risky ? "rgba(210,153,34,0.45)" : "var(--color-border-strong)",
          background: busy ? "var(--color-accent)" : risky ? "rgba(210,153,34,0.12)" : "var(--color-surface-3)",
          color: busy ? "var(--color-accent-text)" : risky ? "var(--color-warn)" : "var(--color-text)",
        }}
        title={risky ? `${fix.confirm?.title} Pide confirmación antes.` : undefined}
      >
        {busy ? "Ejecutando…" : opensOnly(fix) ? "Abrir" : "Ejecutar"}
      </button>
    </div>
  );
}

export function ToolboxPanel({
  open,
  onToggle,
  filter,
  onFilterChange,
  runFix,
  fixBusy,
}: {
  open: boolean;
  onToggle: () => void;
  filter: string;
  onFilterChange: (v: string) => void;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
}) {
  const allFixes = Object.values(FIX_CATALOG);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? allFixes.filter((f) => f.label.toLowerCase().includes(q) || f.detail.toLowerCase().includes(q) || f.kind.toLowerCase().includes(q))
    : allFixes;

  const grouped: Record<FixCategory, Fix[]> = {
    network: [], services: [], update: [], storage: [], shell: [], diagnostic: [], system: [],
  };
  for (const fix of filtered) grouped[fix.category].push(fix);

  return (
    <section className="rounded" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors"
        style={{ background: "var(--color-surface-1)", borderBottom: open ? "1px solid var(--color-border)" : "none" }}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Caja de herramientas de Windows <span style={{ color: "var(--color-text-tertiary)", fontWeight: 400 }}>· {allFixes.length} comandos</span>
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Arreglos de red, servicios, Windows Update, almacenamiento, shell y diagnóstico. No hace falta que se haya detectado un error.
          </div>
        </div>
        <span className="ml-3 shrink-0 font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="p-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filtrar por nombre, tipo o descripción…"
            className="mb-3 w-full rounded px-2 py-1 text-[12px]"
            style={{ background: "var(--color-surface-1)", color: "var(--color-text)", border: "1px solid var(--color-border)", outline: "none" }}
          />
          {filtered.length === 0 && (
            <div className="px-2 py-4 text-center text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Ningún comando coincide con «{filter}».
            </div>
          )}
          <div className="space-y-3">
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped[cat];
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                    {CATEGORY_LABELS[cat]} · {items.length}
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((fix) => (
                      <ToolboxCard key={fix.kind} fix={fix} runFix={runFix} fixBusy={fixBusy} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
