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
import { HudSelect, opcionDeModelo } from "../jarvis/HudSelect";
// Un solo tipo de catalogo para toda la interfaz (terminalCore.ts). La copia
// que habia aqui no tenia ni `default_model` ni `nota`: una regla podia fijar
// un modelo sin poder explicar por que la lista era esa.
import type { Catalogo } from "../jarvis/terminalCore";

type Regla = {
  tarea: string;
  provider: string;
  model: string;
  effort: string;
  cuando: string;
};

type Criterio = {
  decide_la_local: boolean;
  reglas: Regla[];
  nota: string;
  /** Claude sin hooks ni MCP en los turnos del chat (medido: 12,2 s -> ~4,5 s). */
  claude_ligero: boolean;
  /** Segundos que el modelo local sigue en VRAM tras contestar. 0 = se suelta. */
  local_residente_s: number;
  /** CLIs sin permisos por herramienta ni caja de arena; local con herramientas. */
  acceso_total: boolean;
  /** Reanudar la sesion propia de cada CLI mientras conteste la misma. */
  sesion_continua: boolean;
  /** MCP de Claude que siguen activos en el chat con el modo ligero. */
  claude_mcps: string[];
  /** Ofrecer el indice de skills a quien no las carga de forma nativa. */
  compartir_skills: boolean;
  /** El agente que contesta puede lanzar encargos a otros con `@delegar`. */
  reparto_auto: boolean;
};

type McpLocal = { nombre: string; command: string; args: string[] };
type Capacidades = { skills_encendidas: number; skills_apagadas: number; mcps: McpLocal[] };
type ResultadoCompartir = { mcp: string; destino: string; ok: boolean; detalle: string };

/** Opciones de residencia del modelo local. Los numeros de la etiqueta estan
 *  medidos el 2026-09-21 con qwen3.5:9b en esta maquina. */
const RESIDENCIAS: Array<{ s: number; label: string }> = [
  { s: 0, label: "soltar al responder (VRAM libre; ~4 s por respuesta)" },
  { s: 60, label: "1 min cargada (siguientes respuestas ~0,4 s)" },
  { s: 300, label: "5 min cargada" },
  { s: 900, label: "15 min cargada" },
];

export function CriterioPanel() {
  const [criterio, setCriterio] = useState<Criterio | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [capacidades, setCapacidades] = useState<Capacidades | null>(null);
  const [compartiendo, setCompartiendo] = useState(false);
  const [compartido, setCompartido] = useState<ResultadoCompartir[] | null>(null);
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
    void invoke<Capacidades>("maria_capacidades")
      .then(setCapacidades)
      .catch(() => setCapacidades(null));
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

  // El plan detectado va en la etiqueta del proveedor: una regla que mande a
  // claude con un modelo de un plan que no se tiene caía al modelo por
  // defecto sin decir nada (relay.rs), y aquí no se veía venir.
  const proveedores = (catalogo?.providers ?? []).map((p) => ({
    id: p.provider,
    label: p.plan ? `${p.provider} · ${p.plan}` : p.provider,
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

      <section
        className="flex flex-col gap-2 rounded-md p-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        aria-label="velocidad"
      >
        <span className="hud-label">velocidad</span>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={criterio.claude_ligero}
            onChange={(e) => void guardar({ ...criterio, claude_ligero: e.target.checked })}
          />
          <span>Claude ligero en el chat</span>
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {criterio.claude_ligero
              ? "sin hooks ni MCP de Claude Code: ~4,5 s por mensaje en vez de ~12 s"
              : "con todo Claude Code (hooks y MCP): más lento, pero puede usar tus conectores"}
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>IA local en memoria</span>
          <select
            value={criterio.local_residente_s}
            onChange={(e) =>
              void guardar({ ...criterio, local_residente_s: Number(e.target.value) })
            }
            className="px-2 text-[13px]"
            style={{
              minHeight: 30,
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {RESIDENCIAS.map((r) => (
              <option key={r.s} value={r.s}>
                {r.label}
              </option>
            ))}
          </select>
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            el 87 % de lo que tarda la IA local es cargar el modelo; al cerrar mar.ia se suelta siempre
          </span>
        </label>
      </section>

      <section
        className="flex flex-col gap-2 rounded-md p-3"
        style={{
          background: "var(--color-surface-2)",
          border: `1px solid ${criterio.acceso_total ? "var(--color-warn)" : "var(--color-border)"}`,
        }}
        aria-label="capacidades de los agentes"
      >
        <span className="hud-label">capacidades de los agentes</span>
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-1"
            checked={criterio.acceso_total}
            onChange={(e) => void guardar({ ...criterio, acceso_total: e.target.checked })}
          />
          <span>
            Acceso total al equipo
            <span
              className="block text-[11.5px]"
              style={{
                color: criterio.acceso_total ? "var(--color-warn)" : "var(--color-text-tertiary)",
              }}
            >
              {criterio.acceso_total
                ? "Claude, Codex y Antigravity trabajan sin pedir permiso y sin caja de arena; el modelo local puede leer, escribir y ejecutar órdenes (con una lista de órdenes vetadas). Todos parten de la carpeta de trabajo de la conversación."
                : "apagado: Codex en solo lectura, las demás con sus permisos por defecto y el modelo local solo conversa"}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-1"
            checked={criterio.sesion_continua}
            onChange={(e) => void guardar({ ...criterio, sesion_continua: e.target.checked })}
          />
          <span>
            Sesión continua
            <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              mientras conteste el mismo proveedor se reanuda su propia sesión: recuerda toda la
              conversación y gasta menos cuota. Al cambiar de proveedor se le cuenta el hilo.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-1"
            checked={criterio.compartir_skills}
            onChange={(e) => void guardar({ ...criterio, compartir_skills: e.target.checked })}
          />
          <span>
            Skills para todos
            <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {capacidades
                ? `${capacidades.skills_encendidas} encendidas y ${capacidades.skills_apagadas} apagadas en ~/.claude/skills. `
                : ""}
              Claude las carga de forma nativa; a Codex, Antigravity y el local se les ofrece el
              índice de las que encajan con cada petición.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-1"
            checked={criterio.reparto_auto}
            onChange={(e) => void guardar({ ...criterio, reparto_auto: e.target.checked })}
          />
          <span>
            Reparto automático de encargos
            <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              quien contesta puede encargar parte del trabajo a otro proveedor en paralelo (hasta
              cuatro a la vez por conversación). Lo verás en la tira de encargos y en su respuesta.
              También puedes lanzarlos tú con /delegar.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-1 text-[13px]">
          <span>MCP en el chat de Claude</span>
          {capacidades && capacidades.mcps.length > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {capacidades.mcps.map((m) => (
                <label key={m.nombre} className="flex items-center gap-1.5 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={criterio.claude_mcps.includes(m.nombre)}
                    onChange={(e) =>
                      void guardar({
                        ...criterio,
                        claude_mcps: e.target.checked
                          ? [...criterio.claude_mcps, m.nombre]
                          : criterio.claude_mcps.filter((n) => n !== m.nombre),
                      })
                    }
                  />
                  <span title={`${m.command} ${m.args.join(" ")}`}>{m.nombre}</span>
                </label>
              ))}
            </div>
          ) : (
            <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              no hay servidores MCP locales en ~/.claude.json
            </span>
          )}
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            con «Claude ligero» solo arrancan los marcados (cada uno suma arranque a cada mensaje);
            sin él, arrancan todos. Los conectores de claude.ai no aparecen: van con el inicio de
            sesión de Claude.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={compartiendo || !capacidades || capacidades.mcps.length === 0}
              onClick={() => {
                setCompartiendo(true);
                setCompartido(null);
                void invoke<ResultadoCompartir[]>("maria_compartir_mcps")
                  .then(setCompartido)
                  .catch((e) => setError(String(e)))
                  .finally(() => setCompartiendo(false));
              }}
              className="px-3 text-[12.5px]"
              style={{
                minHeight: 30,
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                cursor: compartiendo ? "default" : "pointer",
                opacity: compartiendo ? 0.6 : 1,
              }}
            >
              {compartiendo ? "compartiendo…" : "compartir estos MCP con Codex y Antigravity"}
            </button>
            {compartido && (
              <span className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                {compartido.length === 0
                  ? "nada que compartir"
                  : compartido
                      .map((r) => `${r.mcp}→${r.destino}: ${r.ok ? "ok" : r.detalle}`)
                      .join(" · ")}
              </span>
            )}
          </div>
        </div>
      </section>

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
              // Mismo mapeo que el chat: lo que la cuenta rechaza se ve en
              // gris con su motivo y NO se puede fijar en una regla.
              opciones={modelosDe(r.provider).map(opcionDeModelo)}
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
        Alcance: esto gobierna el chat, la voz, la app del móvil y los encargos. Las llamadas
        internas de la aplicación (titular una conversación, resumir una sesión, extraer
        recuerdos) usan el mismo orden de relevo, con tres reglas propias: nunca con acceso total,
        el modelo local primero y, si toca Claude, su modelo más barato.
      </p>
    </div>
  );
}
