// mar.ia — Router.
//
// Dos vistas y ninguna más (2026-09-19, el usuario: «es muy liosa, y no sé cuál
// tengo configurada, ni a qué cuenta/correo»):
//
//   Proveedores — quién puede contestar, con qué cuenta, cómo se paga y qué le
//                 queda. En el orden en que se prueban.
//   Criterio    — con qué se guía el modelo local para repartir el trabajo.
//                 Sustituye a las «zonas»: una línea por tipo de tarea en vez
//                 de nueve cadenas primary→fallback con modelo y max_tokens.
//
// Lo que se quitó de la pantalla y por qué:
//   Dashboard  — «ahorro» y «uso por modelo» comparaban contra precios de API
//                que ya no se usan (todo va por suscripción o local), así que
//                la cifra no significaba nada. El consumo real de la ventana de
//                5 h se ve ahora en la fila de cada proveedor.
//   Zonas      — siguen existiendo para las llamadas internas de la app
//                (`cockpit/ai-router/zones.json`); no se editan aquí.
//   Proxy      — es una herramienta de depuración; vive en Sistema.

import { useState } from "react";
import { CriterioPanel } from "./CriterioPanel";
import { ProveedoresPanel } from "./ProveedoresPanel";
import { AIRouterErrorBoundary } from "./AIRouterErrorBoundary";

// Se reexportan los tipos compartidos para no romper a quien importe del barril.
type Vista = "proveedores" | "criterio";

const VISTAS: { id: Vista; label: string; hint: string }[] = [
  {
    id: "proveedores",
    label: "Proveedores",
    hint: "Quién contesta, con qué cuenta y qué le queda",
  },
  { id: "criterio", label: "Criterio", hint: "Con qué se guía mar.ia para repartir el trabajo" },
];

export function AIRouterPage() {
  const [vista, setVista] = useState<Vista>("proveedores");
  const activa = VISTAS.find((v) => v.id === vista) ?? VISTAS[0];

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-bg)" }}>
      <div
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[17px] font-semibold" style={{ color: "var(--color-text)" }}>
              Router
            </h1>
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              {activa.hint}
            </p>
          </div>
          <div
            className="inline-flex flex-wrap rounded p-0.5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {VISTAS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVista(v.id)}
                className="rounded px-4 text-[12.5px] font-medium transition-colors"
                style={{
                  minHeight: 34,
                  background: vista === v.id ? "var(--color-surface-3)" : "transparent",
                  color: vista === v.id ? "var(--color-text)" : "var(--color-text-tertiary)",
                  cursor: "pointer",
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <AIRouterErrorBoundary>
          {vista === "proveedores" && <ProveedoresPanel />}
          {vista === "criterio" && <CriterioPanel />}
        </AIRouterErrorBoundary>
      </div>
    </div>
  );
}
