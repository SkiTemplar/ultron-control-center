// Router → Criterio: con qué se guía mar.ia para decidir a quién pedir cada
// cosa.
//
// Sustituye a las «zonas» en lo que el usuario ve. Las zonas eran nueve filas
// de `primary → fallbacks` con modelo y max_tokens por fila: 27 decisiones
// para contestar «¿quién me contesta?». Aquí hay una fila por tipo de trabajo.
//
// Esto NO es decorativo: lo que se escriba aquí entra literalmente en el
// prompt con el que el modelo local decide (`maria_relay::plan_para_tarea`).
// La caja de abajo enseña el texto exacto que le llega, para que no haya que
// creerse nada.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HudSelect } from "../jarvis/HudSelect";

type Regla = {
  tarea: string;
  provider: string;
  model: string;
  effort: string;
  cuando: string;
};

type Criterio = { decide_la_local: boolean; reglas: Regla[]; nota: string };

type ModeloInfo = { id: string; label: string; para: string };
type Catalogo = {
  providers: Array<{ provider: string; models: ModeloInfo[] }>;
  efforts: string[];
};

export function CriterioPanel() {
  const [criterio, setCriterio] = useState<Criterio | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const [c, cat] = await Promise.all([
      invoke<Criterio>("maria_criterio_get").catch((e) => {
        setError(String(e));
        return null;
      }),
      invoke<Catalogo>("maria_models_catalog").catch(() => null),
    ]);
    if (c) setCriterio(c);
    if (cat) setCatalogo(cat);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(siguiente: Criterio) {
    setCriterio(siguiente);
    setError(null);
    const r = await invoke<Criterio>("maria_criterio_set", { criterio: siguiente }).catch((e) => {
      setError(String(e));
      return null;
    });
    if (r) {
      setCriterio(r);
      setEstado("guardado");
      setTimeout(() => setEstado(null), 2500);
    }
  }

  if (!criterio) return <p className="p-6 text-[13px]">{error ?? "cargando…"}</p>;

  const proveedores = (catalogo?.providers ?? []).map((p) => ({
    id: p.provider,
    label: p.provider,
  }));
  const modelosDe = (prov: string) =>
    catalogo?.providers.find((p) => p.provider === prov)?.models ?? [];

  /** El texto exacto que recibe el modelo local. Se construye igual que en
   *  Rust (`maria_criterio::como_prompt`) para que lo que se lee aquí sea lo
   *  que de verdad se manda. */
  const prompt = [
    ...criterio.reglas.map(
      (r) =>
        `- ${r.tarea}: usa ${r.provider}${r.model ? ` con ${r.model}` : ""}` +
        `${r.effort ? `, esfuerzo ${r.effort}` : ""} (${r.cuando}).`,
    ),
    ...(criterio.nota.trim() ? [`- Ademas: ${criterio.nota.trim()}`] : []),
  ].join("\n");

  function cambiar(i: number, campo: keyof Regla, valor: string) {
    const reglas = criterio!.reglas.map((r, j) =>
      j === i
        ? {
            ...r,
            [campo]: valor,
            // El modelo pertenece a un proveedor: al cambiar de proveedor se
            // suelta, o quedaría pidiendo «opus» a Gemini.
            ...(campo === "provider" ? { model: "" } : {}),
          }
        : r,
    );
    void guardar({ ...criterio!, reglas });
  }

  return (
    <div className="flex flex-col gap-4 p-6" style={{ maxWidth: 940 }}>
      <header>
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
          Con qué se guía mar.ia
        </h2>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          Una línea por tipo de trabajo. Cuando le escribes o le hablas, el modelo local lee
          esto y elige a quién mandárselo. Cambiarlo cambia su comportamiento al instante.
        </p>
      </header>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={criterio.decide_la_local}
          onChange={(e) => void guardar({ ...criterio, decide_la_local: e.target.checked })}
        />
        <span>que decida el modelo local</span>
        <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {criterio.decide_la_local
            ? "lee estas reglas y elige por cada mensaje"
            : "desactivado: se usa el orden de relevo sin preguntarle (útil si Ollama está caído)"}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        {criterio.reglas.map((r, i) => (
          <div
            key={`${r.tarea}-${i}`}
            className="flex flex-wrap items-end gap-3 rounded-md p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex min-w-[190px] flex-1 flex-col gap-0.5">
              <span className="hud-label">tarea</span>
              <input
                value={r.tarea}
                onChange={(e) => cambiar(i, "tarea", e.target.value)}
                className="px-2 text-[13px]"
                style={{
                  minHeight: 38,
                  background: "var(--color-surface-3)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  outline: "none",
                }}
              />
            </div>
            <HudSelect
              etiqueta="proveedor"
              valor={r.provider}
              ancho={140}
              opciones={proveedores}
              onChange={(v) => cambiar(i, "provider", v)}
            />
            <HudSelect
              etiqueta="modelo"
              valor={r.model}
              vacio="el de por defecto"
              ancho={170}
              opciones={modelosDe(r.provider).map((m) => ({
                id: m.id,
                label: m.label,
                hint: m.para,
              }))}
              onChange={(v) => cambiar(i, "model", v)}
            />
            <HudSelect
              etiqueta="esfuerzo"
              valor={r.effort}
              ancho={120}
              opciones={(catalogo?.efforts ?? ["bajo", "medio", "alto"]).map((e) => ({
                id: e,
                label: e,
              }))}
              onChange={(v) => cambiar(i, "effort", v)}
            />
            <div className="flex min-w-[260px] flex-[2] flex-col gap-0.5">
              <span className="hud-label">cuándo</span>
              <input
                value={r.cuando}
                onChange={(e) => cambiar(i, "cuando", e.target.value)}
                className="px-2 text-[13px]"
                style={{
                  minHeight: 38,
                  background: "var(--color-surface-3)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  outline: "none",
                }}
              />
            </div>
            <button
              type="button"
              onClick={() =>
                void guardar({
                  ...criterio,
                  reglas: criterio.reglas.filter((_, j) => j !== i),
                })
              }
              aria-label={`quitar la regla ${r.tarea}`}
              className="px-3 text-[13px]"
              style={{
                minHeight: 38,
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)",
                cursor: "pointer",
              }}
            >
              quitar
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            void guardar({
              ...criterio,
              reglas: [
                ...criterio.reglas,
                {
                  tarea: "nueva tarea",
                  provider: proveedores[0]?.id ?? "local",
                  model: "",
                  effort: "medio",
                  cuando: "describe cuándo aplica",
                },
              ],
            })
          }
          className="px-3 text-[13px]"
          style={{
            minHeight: 38,
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
            cursor: "pointer",
          }}
        >
          + regla
        </button>
        <button
          type="button"
          onClick={() => {
            void invoke<Criterio>("maria_criterio_reset")
              .then((c) => {
                setCriterio(c);
                setEstado("vuelto al criterio de fábrica");
                setTimeout(() => setEstado(null), 2500);
              })
              .catch((e) => setError(String(e)));
          }}
          className="px-3 text-[13px]"
          style={{
            minHeight: 38,
            background: "transparent",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
            cursor: "pointer",
          }}
        >
          volver al de fábrica
        </button>
        {estado && (
          <span className="text-[12px]" style={{ color: "var(--color-success)" }}>
            {estado}
          </span>
        )}
        {error && (
          <span className="text-[12px]" style={{ color: "var(--color-danger)" }}>
            {error}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="hud-label">nota libre (va tal cual al final del criterio)</span>
        <input
          value={criterio.nota}
          placeholder="p. ej. no uses gemini para nada de código"
          onChange={(e) => setCriterio({ ...criterio, nota: e.target.value })}
          onBlur={() => void guardar(criterio)}
          className="px-2 text-[13px]"
          style={{
            minHeight: 38,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            outline: "none",
          }}
        />
      </div>

      <details>
        <summary
          className="cursor-pointer text-[12.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          ver lo que recibe exactamente el modelo local
        </summary>
        <pre
          className="mt-2 whitespace-pre-wrap p-3 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {prompt || "(sin reglas: el modelo local decidirá sin guía)"}
        </pre>
      </details>

      <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Alcance: esto gobierna el chat, la voz y la app del móvil. Las llamadas internas que
        hace la aplicación siguen usando sus propias zonas (<code>cockpit/ai-router/zones.json</code>),
        que no se editan desde aquí.
      </p>
    </div>
  );
}
