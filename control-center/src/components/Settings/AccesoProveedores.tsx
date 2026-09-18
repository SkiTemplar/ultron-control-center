// Ajustes → Auth: cómo se entra en cada proveedor y si ya se ha entrado.
//
// Punto de consumo de `maria_login`. La pantalla anterior solo conocía Claude
// y Codex; para Gemini no había nada, que es justo el que cambió (Google cortó
// el OAuth de Gemini CLI para cuentas individuales el 18/06/2026).
//
// Cada ficha dice QUÉ se ha comprobado exactamente, para que un "dentro" en
// verde no signifique cosas distintas según el proveedor sin avisar.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Acceso = {
  provider: string;
  label: string;
  installed: boolean;
  logged_in: boolean;
  how_checked: string;
  how_to: string;
  command: string;
  url: string;
  note: string;
};

export function AccesoProveedores() {
  const [accesos, setAccesos] = useState<Acceso[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const a = await invoke<Acceso[]>("maria_login_status").catch((e) => {
      setError(String(e));
      return null;
    });
    if (a) setAccesos(a);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!accesos) {
    return <p className="hud-label p-4">{error ?? "comprobando…"}</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 760 }}>
      <header className="flex items-center gap-3">
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          acceso a los proveedores
        </h2>
        <button
          type="button"
          onClick={() => void cargar()}
          className="hud-panel px-3 text-[12px]"
          style={{ minHeight: 34, color: "var(--color-accent)", cursor: "pointer" }}
        >
          volver a comprobar
        </button>
      </header>

      {accesos.map((a) => (
        <article
          key={a.provider}
          className="hud-panel flex flex-col gap-2 p-3"
          style={{
            borderLeft: `3px solid ${
              a.logged_in ? "var(--color-success)" : "var(--color-warn)"
            }`,
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-[13px]" style={{ color: "var(--color-text)" }}>
              {a.label}
            </strong>
            <span
              className="px-2 py-0.5 text-[11px]"
              style={{
                border: "1px solid var(--color-border)",
                color: a.logged_in ? "var(--color-success)" : "var(--color-warn)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {a.logged_in ? "dentro" : "fuera"}
            </span>
            <span
              className="px-2 py-0.5 text-[11px]"
              style={{
                border: "1px solid var(--color-border)",
                color: a.installed ? "var(--color-text-secondary)" : "var(--color-danger)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {a.installed ? "instalado" : "no instalado"}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                setError(null);
                void invoke<string>("maria_login_open", { provider: a.provider }).catch((e) =>
                  setError(String(e)),
                );
              }}
              className="hud-panel px-3 text-[12px]"
              style={{ minHeight: 34, color: "var(--color-accent)", cursor: "pointer" }}
            >
              abrir página
            </button>
          </div>

          <p className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
            {a.how_to}
          </p>

          {a.command && (
            <div className="flex items-center gap-2">
              <code
                className="hud-panel flex-1 px-2 py-1 text-[11px]"
                style={{ color: "var(--color-accent)", overflowWrap: "anywhere" }}
              >
                {a.command}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(a.command)
                    .then(() => setCopiado(a.provider))
                    .catch(() => setError("no pude copiar al portapapeles"));
                }}
                className="hud-panel px-3 text-[12px]"
                style={{ minHeight: 34, color: "var(--color-accent)", cursor: "pointer" }}
              >
                {copiado === a.provider ? "copiado" : "copiar"}
              </button>
            </div>
          )}

          {a.note && (
            <p
              className="px-2 py-1 text-[11px]"
              style={{ border: "1px solid var(--color-warn)", color: "var(--color-warn)" }}
            >
              {a.note}
            </p>
          )}

          <span className="hud-label">comprobado: {a.how_checked}</span>
        </article>
      ))}

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
