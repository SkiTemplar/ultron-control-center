// Ajustes → Cuentas: con qué cuenta y con qué factura está conectado cada
// proveedor.
//
// Lo pidió el usuario con foco explícito (2026-09-19): "saber qué cuentas y
// apis tengo conectadas y el correo asociado, para no equivocarme con el de
// compañeros". El riesgo no es técnico: es trabajar con la cuenta de otro.
//
// Tres cosas y bien claras:
//   1. QUIÉN: el correo de cada proveedor, y de qué fichero ha salido.
//   2. CÓMO SE PAGA: suscripción (incluida) o clave de API (se factura).
//   3. AVISOS: correos distintos entre proveedores, o una clave que hace que
//      lo que creías suscripción pase a facturarse.
//
// Nunca se enseña una clave: como mucho sus cuatro últimos caracteres.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TipoAcceso = "Suscripcion" | "ClaveApi" | "Local" | "SinAcceso";

type Cuenta = {
  provider: string;
  label: string;
  tipo: TipoAcceso;
  account: string;
  source: string;
  key_tail: string;
  warnings: string[];
};

type Informe = { cuentas: Cuenta[]; correos: string[]; warnings: string[] };

const TIPO: Record<TipoAcceso, { texto: string; color: string; nota: string }> = {
  Suscripcion: {
    texto: "suscripción",
    color: "var(--color-success)",
    nota: "incluido en tu plan; no genera factura por uso",
  },
  ClaveApi: {
    texto: "clave de API",
    color: "var(--color-warn)",
    nota: "se factura por uso",
  },
  Local: {
    texto: "local",
    color: "var(--color-accent)",
    nota: "corre en este ordenador; no hay cuenta ni factura",
  },
  SinAcceso: {
    texto: "sin acceso",
    color: "var(--color-text-tertiary)",
    nota: "ni sesión ni clave: este proveedor no puede contestar",
  },
};

export function CuentasSection() {
  const [informe, setInforme] = useState<Informe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const i = await invoke<Informe>("maria_cuentas_informe").catch((e) => {
      setError(String(e));
      return null;
    });
    if (i) setInforme(i);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!informe) return <p className="hud-label p-4">{error ?? "comprobando…"}</p>;

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 780 }}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          cuentas conectadas
        </h2>
        <span className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {informe.correos.length === 0
            ? "ningún correo detectado"
            : informe.correos.length === 1
              ? `un solo correo: ${informe.correos[0]}`
              : `${informe.correos.length} correos distintos`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void cargar()}
          className="hud-panel px-3 text-[12px]"
          style={{ minHeight: 34, color: "var(--color-accent)", cursor: "pointer" }}
        >
          volver a comprobar
        </button>
      </header>

      {/* Lo más importante arriba: si hay dos correos, que se vea antes que
          nada. Es el error que el usuario quiere no cometer. */}
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

      {informe.cuentas.map((c) => {
        const t = TIPO[c.tipo];
        return (
          <article
            key={c.provider}
            className="hud-panel flex flex-col gap-1.5 p-3"
            style={{ borderLeft: `3px solid ${t.color}` }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[13px]" style={{ color: "var(--color-text)" }}>
                {c.label}
              </strong>
              <span
                className="px-2 py-0.5 text-[11px]"
                style={{
                  border: `1px solid ${t.color}`,
                  color: t.color,
                  fontFamily: "var(--font-mono)",
                }}
                title={t.nota}
              >
                {t.texto}
              </span>
              {c.key_tail && (
                <span
                  className="px-2 py-0.5 text-[11px]"
                  style={{
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text-tertiary)",
                    fontFamily: "var(--font-mono)",
                  }}
                  title="solo los últimos caracteres; la clave nunca sale de tu equipo"
                >
                  clave {c.key_tail}
                </span>
              )}
            </div>

            <div className="text-[13px]" style={{ color: "var(--color-text)" }}>
              {c.account ? (
                <>
                  cuenta:{" "}
                  <strong
                    style={{ color: "var(--color-accent)", fontFamily: "var(--font-mono)" }}
                  >
                    {c.account}
                  </strong>
                </>
              ) : (
                <span style={{ color: "var(--color-text-tertiary)" }}>
                  {c.tipo === "Local" ? "sin cuenta (es tu ordenador)" : "cuenta no expuesta"}
                </span>
              )}
            </div>

            <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              {t.nota} · origen del dato: <code>{c.source}</code>
            </span>

            {c.warnings.map((w) => (
              <p
                key={w}
                className="px-2 py-1 text-[11.5px]"
                style={{ border: "1px solid var(--color-warn)", color: "var(--color-warn)" }}
              >
                {w}
              </p>
            ))}
          </article>
        );
      })}

      <p className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
        Los tokens no se leen ni se muestran nunca: de una clave solo salen sus cuatro últimos
        caracteres, y de una sesión solo el correo.
      </p>

      {error && (
        <p
          className="px-3 py-2 text-[12px]"
          style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
