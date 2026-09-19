// Router → Proveedores: quién puede contestar, con qué cuenta y qué le queda.
//
// Antes esto estaba repartido entre «Dashboard» (ahorro, uso por modelo, proxy)
// y «Providers» (salud, coste, estado de keys), y ninguna de las dos contestaba
// la pregunta que el usuario hace de verdad: «¿cuál tengo configurada, con qué
// cuenta, y es mi suscripción o me está cobrando por API?» (2026-09-19).
//
// Una fila por proveedor con lo único que importa para decidir:
//   quién es · con qué cuenta · cómo se paga · si responde · qué le queda.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TipoAcceso = "Suscripcion" | "ClaveApi" | "Local" | "SinAcceso";

type Cuenta = {
  provider: string;
  label: string;
  tipo: TipoAcceso;
  account: string;
  key_tail: string;
  warnings: string[];
};
type Informe = { cuentas: Cuenta[]; correos: string[]; warnings: string[] };

type EstadoProveedor = { status: string; detail: string; at: string; answered: number };
type VentanaCuota = {
  provider: string;
  tokens: number;
  turns: number;
  window_hours: number;
  pct: number | null;
};

const PAGO: Record<TipoAcceso, { texto: string; color: string }> = {
  Suscripcion: { texto: "suscripción", color: "var(--color-success)" },
  ClaveApi: { texto: "clave de API · se factura", color: "var(--color-warn)" },
  Local: { texto: "local · gratis", color: "var(--color-accent)" },
  SinAcceso: { texto: "sin acceso", color: "var(--color-text-tertiary)" },
};

const ESTADO: Record<string, { texto: string; color: string }> = {
  ok: { texto: "contestó", color: "var(--color-success)" },
  cuota: { texto: "sin cuota", color: "var(--color-danger)" },
  error: { texto: "error", color: "var(--color-danger)" },
  desactivado: { texto: "apagado", color: "var(--color-text-tertiary)" },
};

function hace(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

export function ProveedoresPanel() {
  const [informe, setInforme] = useState<Informe | null>(null);
  const [estado, setEstado] = useState<Record<string, EstadoProveedor>>({});
  const [orden, setOrden] = useState<string[]>([]);
  const [cuotas, setCuotas] = useState<VentanaCuota[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const [i, e, c, q] = await Promise.all([
      invoke<Informe>("maria_cuentas_informe").catch((x) => {
        setError(String(x));
        return null;
      }),
      invoke<Record<string, EstadoProveedor>>("maria_relay_state").catch(() => ({})),
      invoke<{ order: string[] }>("maria_relay_config").catch(() => ({ order: [] })),
      invoke<VentanaCuota[]>("maria_quota_windows").catch(() => []),
    ]);
    if (i) setInforme(i);
    setEstado(e ?? {});
    setOrden(c?.order ?? []);
    setCuotas(q ?? []);
  }, []);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => void cargar(), 30_000);
    return () => clearInterval(id);
  }, [cargar]);

  if (!informe) return <p className="p-6 text-[13px]">{error ?? "comprobando…"}</p>;

  // Se pinta en el orden del relevo: así se lee como lo que es, una cola.
  const porOrden = [
    ...orden
      .map((id) => informe.cuentas.find((c) => c.provider === id))
      .filter((c): c is Cuenta => Boolean(c)),
    ...informe.cuentas.filter((c) => !orden.includes(c.provider)),
  ];

  return (
    <div className="flex flex-col gap-3 p-6" style={{ maxWidth: 940 }}>
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
            Quién puede contestar
          </h2>
          <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
            En el orden en que mar.ia los prueba. Si el primero se queda sin cuota, pasa al
            siguiente con el contexto de la conversación.
          </p>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void cargar()}
          className="px-3 text-[12.5px]"
          style={{
            minHeight: 34,
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
            cursor: "pointer",
          }}
        >
          actualizar
        </button>
      </header>

      {informe.warnings.map((w) => (
        <p
          key={w}
          className="px-3 py-2 text-[12.5px]"
          style={{
            border: "1px solid var(--color-danger)",
            background: "rgba(255,77,94,0.08)",
            color: "var(--color-danger)",
          }}
        >
          ⚠ {w}
        </p>
      ))}

      {porOrden.map((c, i) => {
        const pago = PAGO[c.tipo];
        const e = estado[c.provider];
        const est = e ? (ESTADO[e.status] ?? { texto: e.status, color: "var(--color-text)" }) : null;
        const q = cuotas.find((x) => x.provider === c.provider);
        return (
          <article
            key={c.provider}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              borderLeft: `3px solid ${pago.color}`,
              opacity: c.tipo === "SinAcceso" ? 0.65 : 1,
            }}
          >
            <span
              className="text-[12px]"
              style={{ color: "var(--color-text-tertiary)", minWidth: 18 }}
              title="orden en la cola de relevo"
            >
              {i + 1}º
            </span>
            <strong className="text-[13.5px]" style={{ color: "var(--color-text)", minWidth: 92 }}>
              {c.label}
            </strong>
            <span className="text-[12px]" style={{ color: pago.color, minWidth: 150 }}>
              {pago.texto}
              {c.key_tail ? ` (${c.key_tail})` : ""}
            </span>
            <span
              className="flex-1 text-[12.5px]"
              style={{ color: "var(--color-accent)", fontFamily: "var(--font-mono)", minWidth: 190 }}
            >
              {c.account || (c.tipo === "Local" ? "este ordenador" : "cuenta no expuesta")}
            </span>
            {est && (
              <span className="text-[12px]" style={{ color: est.color, minWidth: 130 }}>
                {est.texto} · {e ? `${e.answered} resp.` : ""} {e?.at ? hace(e.at) : ""}
              </span>
            )}
            {q && q.tokens > 0 && (
              <span
                className="text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
                title={`${q.turns} turnos en las últimas ${q.window_hours} h`}
              >
                {Math.round(q.tokens / 1000)}k tokens / {q.window_hours} h
                {q.pct !== null ? ` · ${Math.round(q.pct)}%` : " · tope sin medir"}
              </span>
            )}
            {c.warnings.map((w) => (
              <p
                key={w}
                className="w-full px-2 py-1 text-[11.5px]"
                style={{ border: "1px solid var(--color-warn)", color: "var(--color-warn)" }}
              >
                {w}
              </p>
            ))}
          </article>
        );
      })}

      <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Solo quedan los proveedores con suscripción y el modelo local: los de pago por API
        sueltos (groq, deepseek…) se quitaron del catálogo. El detalle de cuentas y el cambio
        de sesión están en Ajustes → Cuentas.
      </p>
    </div>
  );
}
