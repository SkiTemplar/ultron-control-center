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
import { Confirmar } from "./Confirmar";
import { BotonRefrescar } from "./BotonRefrescar";

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

/** Una cuenta guardada con nombre, para poder volver a ella. */
type Perfil = { provider: string; nombre: string; account: string; activo: boolean };

/** Lo que el diálogo de confirmación tiene pendiente de ejecutar. */
type Pendiente = {
  titulo: string;
  detalle: string;
  accion: string;
  palabraClave?: string;
  hacer: () => Promise<unknown>;
};

/** Variables de clave que mar.ia sabe quitar, por proveedor. Tiene que cuadrar
 *  con `CLAVES_CONOCIDAS` en `maria_perfiles.rs`: si no, el botón pide borrar
 *  algo que el backend rechaza. */
const CLAVES: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  // Antigravity va por suscripcion: no tiene clave de API que borrar.
  antigravity: [],
};

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
  const [perfiles, setPerfiles] = useState<Perfil[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  /** Proveedor cuyo campo «guardar como» está abierto. */
  const [guardando, setGuardando] = useState<string | null>(null);
  const [nombreNuevo, setNombreNuevo] = useState("");

  // El error del informe SUBE: lo enseña el boton de refrescar. Los perfiles
  // son secundarios, asi que su fallo no tumba la pantalla entera.
  const cargar = useCallback(async () => {
    const ps = await invoke<Perfil[]>("maria_perfiles_listar").catch(() => []);
    setPerfiles(ps ?? []);
    try {
      setInforme(await invoke<Informe>("maria_cuentas_informe"));
      setError(null);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  /** Lanza una acción y refresca. Todo lo destructivo pasa por aquí. */
  const ejecutar = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      setAviso(null);
      try {
        const r = await fn();
        if (typeof r === "string" && r) setAviso(r);
        await cargar();
      } catch (e) {
        setError(String(e));
      }
    },
    [cargar],
  );

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
        <BotonRefrescar
          onRefrescar={cargar}
          title="vuelve a leer que cuenta y que clave tiene cada proveedor"
        />
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

            {/* --- cuentas guardadas de este proveedor -------------------- */}
            {c.tipo !== "Local" && (
              <div className="flex flex-col gap-1.5">
                {perfiles.filter((p) => p.provider === c.provider).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="hud-label">cuentas guardadas:</span>
                    {perfiles
                      .filter((p) => p.provider === c.provider)
                      .map((p) => (
                        <span
                          key={p.nombre}
                          className="flex items-center gap-1 px-2 py-0.5 text-[11.5px]"
                          style={{
                            border: `1px solid ${
                              p.activo ? "var(--color-success)" : "var(--color-border)"
                            }`,
                            color: p.activo
                              ? "var(--color-success)"
                              : "var(--color-text-secondary)",
                          }}
                          title={p.account || "sin correo legible"}
                        >
                          {p.nombre}
                          {p.activo && " ·  activa"}
                          {!p.activo && (
                            <button
                              type="button"
                              onClick={() =>
                                void ejecutar(() =>
                                  invoke("maria_perfil_activar", {
                                    provider: c.provider,
                                    nombre: p.nombre,
                                  }),
                                )
                              }
                              className="px-1"
                              style={{
                                background: "none",
                                border: "none",
                                color: "var(--color-accent)",
                                cursor: "pointer",
                              }}
                              title="usar esta cuenta"
                            >
                              usar
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setPendiente({
                                titulo: `Borrar la cuenta guardada «${p.nombre}»`,
                                detalle:
                                  `Se borra la copia guardada de ${c.label}` +
                                  `${p.account ? ` (${p.account})` : ""}. ` +
                                  "La sesión que tengas activa ahora NO se toca.",
                                accion: "Borrar copia",
                                hacer: () =>
                                  invoke("maria_perfil_borrar", {
                                    provider: c.provider,
                                    nombre: p.nombre,
                                    confirmar: true,
                                  }),
                              })
                            }
                            aria-label={`borrar la cuenta guardada ${p.nombre}`}
                            className="px-1"
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--color-text-tertiary)",
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {guardando === c.provider ? (
                    <>
                      <input
                        value={nombreNuevo}
                        onChange={(e) => setNombreNuevo(e.target.value)}
                        placeholder="nombre (p. ej. personal)"
                        aria-label="nombre de la cuenta guardada"
                        autoFocus
                        className="px-2 text-[12px]"
                        style={{
                          minHeight: 32,
                          minWidth: 190,
                          background: "var(--color-surface-3)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                          outline: "none",
                        }}
                      />
                      <button
                        type="button"
                        disabled={!nombreNuevo.trim()}
                        onClick={() => {
                          const nombre = nombreNuevo.trim();
                          setGuardando(null);
                          setNombreNuevo("");
                          void ejecutar(() =>
                            invoke("maria_perfil_guardar", { provider: c.provider, nombre }),
                          );
                        }}
                        className="hud-panel px-3 text-[12px]"
                        style={{
                          minHeight: 32,
                          color: nombreNuevo.trim()
                            ? "var(--color-accent)"
                            : "var(--color-text-tertiary)",
                          cursor: nombreNuevo.trim() ? "pointer" : "not-allowed",
                        }}
                      >
                        guardar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setGuardando(null);
                          setNombreNuevo("");
                        }}
                        className="px-2 text-[12px]"
                        style={{
                          minHeight: 32,
                          background: "none",
                          border: "none",
                          color: "var(--color-text-tertiary)",
                          cursor: "pointer",
                        }}
                      >
                        cancelar
                      </button>
                    </>
                  ) : (
                    c.tipo === "Suscripcion" && (
                      <button
                        type="button"
                        onClick={() => {
                          setGuardando(c.provider);
                          setNombreNuevo("");
                        }}
                        className="hud-panel px-3 text-[12px]"
                        style={{ minHeight: 32, color: "var(--color-accent)", cursor: "pointer" }}
                        title="guarda esta sesión con un nombre para poder volver a ella"
                      >
                        guardar esta cuenta
                      </button>
                    )
                  )}

                  {/* Quitar la clave de API, si la hay. */}
                  {c.key_tail &&
                    (CLAVES[c.provider] ?? []).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          setPendiente({
                            titulo: `Quitar ${v}`,
                            detalle:
                              `Se borra ${v} del .env de mar.ia y de tus variables de usuario. ` +
                              `${c.label} dejará de facturar por API. ` +
                              "Si está definida como variable del SISTEMA, hará falta quitarla " +
                              "a mano con permisos de administrador; te lo dirá.",
                            accion: "Quitar clave",
                            hacer: () =>
                              invoke("maria_clave_borrar", { variable: v, confirmar: true }),
                          })
                        }
                        className="px-3 text-[12px]"
                        style={{
                          minHeight: 32,
                          background: "transparent",
                          border: "1px solid var(--color-warn)",
                          color: "var(--color-warn)",
                          cursor: "pointer",
                        }}
                      >
                        quitar {v}
                      </button>
                    ))}

                  {/* Cerrar sesión: lo más destructivo, con palabra clave. */}
                  {c.tipo === "Suscripcion" && (
                    <button
                      type="button"
                      onClick={() =>
                        setPendiente({
                          titulo: `Cerrar la sesión de ${c.label}`,
                          detalle:
                            `Se borra la credencial de ${c.label}` +
                            `${c.account ? ` (${c.account})` : ""} de este equipo. ` +
                            "Tendrás que volver a entrar desde su CLI. " +
                            "Si quieres poder volver, guarda antes la cuenta con un nombre.",
                          accion: "Cerrar sesión",
                          palabraClave: "cerrar",
                          hacer: () =>
                            invoke("maria_cuenta_cerrar_sesion", {
                              provider: c.provider,
                              confirmar: true,
                            }),
                        })
                      }
                      className="px-3 text-[12px]"
                      style={{
                        minHeight: 32,
                        background: "transparent",
                        border: "1px solid var(--color-danger)",
                        color: "var(--color-danger)",
                        cursor: "pointer",
                      }}
                    >
                      cerrar sesión
                    </button>
                  )}
                </div>
              </div>
            )}

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
        De una clave solo se muestran sus cuatro últimos caracteres, y de una sesión solo el
        correo. Guardar una cuenta con nombre sí copia su credencial entera a{" "}
        <code>cuentas/</code> dentro de la carpeta de mar.ia: es la única forma de poder volver
        a ella, pero significa que ese token está en dos sitios del disco.
      </p>

      {aviso && (
        <p className="text-[12px]" style={{ color: "var(--color-success)" }}>
          {aviso}
        </p>
      )}

      {pendiente && (
        <Confirmar
          titulo={pendiente.titulo}
          detalle={pendiente.detalle}
          accion={pendiente.accion}
          palabraClave={pendiente.palabraClave}
          onCancelar={() => setPendiente(null)}
          onConfirmar={() => {
            const p = pendiente;
            setPendiente(null);
            void ejecutar(p.hacer);
          }}
        />
      )}

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
