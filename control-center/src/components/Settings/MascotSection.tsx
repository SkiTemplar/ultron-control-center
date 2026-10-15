import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, type MascotSettings } from "../mascot/engine";

// Settings > Mascota — ajustes de la mascota de escritorio
// (~/.ultron/cockpit/mascot.json) y del MCP de escritorio que la usa como
// cursor. Cada cambio se guarda y se aplica al momento: la ventana de la
// mascota escucha `mascot:settings`.

interface BridgeStatus {
  running: boolean;
  port: number;
  info_file: string;
  mcp_script: string;
  mcp_script_exists: boolean;
  register_command: string;
}

const card: React.CSSProperties = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "14px 16px",
};

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5" style={{ opacity: disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="text-[12.5px]" style={{ color: "var(--color-text)" }}>
          {label}
        </span>
        {hint && (
          <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="grid grid-cols-[150px_1fr_70px] items-center gap-3 py-1.5 text-[12.5px]">
      <span style={{ color: "var(--color-text)" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="text-right" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
        {format(value)}
      </span>
    </label>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
      {children}
    </h3>
  );
}

export function MascotSection() {
  const [s, setS] = useState<MascotSettings | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    invoke<MascotSettings>("mascot_get_settings")
      .then((r) => setS({ ...DEFAULT_SETTINGS, ...r }))
      .catch((e) => setError(String(e)));
    invoke<BridgeStatus>("mascot_bridge_status")
      .then(setBridge)
      .catch((e) => setError(String(e)));
  }, []);

  const persist = useCallback((next: MascotSettings) => {
    invoke<MascotSettings>("mascot_save_settings", { settings: next })
      .then((r) => {
        setS({ ...DEFAULT_SETTINGS, ...r });
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  /** Interruptores: guardar ya. Deslizadores y textos: tras una pausa. */
  const update = (patch: Partial<MascotSettings>, debounce = false) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (debounce) saveTimer.current = window.setTimeout(() => persist(next), 300);
    else persist(next);
  };

  async function summon() {
    setError(null);
    try {
      await invoke("mascot_summon");
      setNote("Mascota llamada al centro de la pantalla.");
      window.setTimeout(() => setNote(null), 2500);
      if (s && !s.enabled) setS({ ...s, enabled: true });
    } catch (e) {
      setError(String(e));
    }
  }

  async function registerMcp() {
    setBusy(true);
    setError(null);
    try {
      const out = await invoke<string>("mascot_register_mcp");
      setNote(`MCP registrado en Claude Code (ámbito usuario). ${out}`.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!s) {
    return (
      <div className="text-[12.5px]" style={{ color: error ? "var(--color-danger)" : "var(--color-text-tertiary)" }}>
        {error ?? "Cargando…"}
      </div>
    );
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {note && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {note}
        </div>
      )}

      <section style={card}>
        <div className="flex items-center justify-between gap-4">
          <Toggle
            label="Mostrar la mascota en el escritorio"
            hint="Vive sobre la barra de tareas del monitor principal. Solo Windows."
            checked={s.enabled}
            onChange={(v) => update({ enabled: v })}
          />
          <button
            type="button"
            onClick={summon}
            className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            Llamar a la mascota
          </button>
        </div>
        <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Pasa el ratón por encima para ver los botones de Claude, Codex y Antigravity. Arrástrala y suéltala para
          lanzarla; si mantienes <b>Ctrl</b> al soltar, se queda colgada de una chincheta (clic para soltarla). Un clic
          suelto le da un saltito.
        </p>
      </section>

      <section style={card}>
        <H>Comportamiento</H>
        <Toggle label="Pasea sola" checked={s.wander} onChange={(v) => update({ wander: v })} />
        <Toggle
          label="Se sube a las ventanas"
          hint="Puede posarse y caminar por el borde superior de las ventanas visibles, y va montada si las mueves."
          checked={s.climb_windows}
          onChange={(v) => update({ climb_windows: v })}
        />
        <Toggle
          label="Salta"
          hint="Por su cuenta salta a ventanas cercanas y se baja de ellas."
          checked={s.jump}
          disabled={!s.climb_windows}
          onChange={(v) => update({ jump: v })}
        />
        <Toggle
          label="Se estampa contra las ventanas"
          hint="Las ventanas son sólidas: al lanzarla choca con sus laterales y su parte de abajo, no solo con los bordes de la pantalla."
          checked={s.collide_windows}
          onChange={(v) => update({ collide_windows: v })}
        />
        <Toggle
          label="Se queda espachurrada al chocar fuerte"
          checked={s.splat}
          onChange={(v) => update({ splat: v })}
        />
        <Toggle
          label="Sus ojos siguen al cursor"
          checked={s.eyes_follow_cursor}
          onChange={(v) => update({ eyes_follow_cursor: v })}
        />
      </section>

      <section style={card}>
        <H>Física y tamaño</H>
        <Slider
          label="Tamaño"
          value={s.scale}
          min={2}
          max={8}
          step={1}
          format={(v) => `${v}×`}
          onChange={(v) => update({ scale: v }, true)}
        />
        <Slider
          label="Gravedad"
          value={s.gravity}
          min={0.3}
          max={2.5}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => update({ gravity: v }, true)}
        />
        <Slider
          label="Rebote"
          value={s.bounciness}
          min={0}
          max={0.9}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => update({ bounciness: v }, true)}
        />
        <Slider
          label="Dormir tras"
          value={s.sleep_after_min}
          min={0}
          max={30}
          step={1}
          format={(v) => (v === 0 ? "nunca" : `${v} min`)}
          onChange={(v) => update({ sleep_after_min: v }, true)}
        />
      </section>

      <section style={card}>
        <H>Conversación</H>
        <p className="mb-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cada botón usa primero su CLI de suscripción (<code>claude -p</code>, <code>codex exec</code>,{" "}
          <code>agy -p</code>) y, si falla, la API equivalente con su key (Anthropic, OpenAI, Gemini). El bocadillo
          indica siempre por qué camino contestó.
        </p>
        {(
          [
            ["claude_model", "Modelo de Claude", "vacío = el de la CLI (p. ej. sonnet, opus)"],
            ["codex_model", "Modelo de Codex", "vacío = el de ~/.codex/config.toml"],
          ] as const
        ).map(([key, label, ph]) => (
          <label key={key} className="grid grid-cols-[150px_1fr] items-center gap-3 py-1.5 text-[12.5px]">
            <span style={{ color: "var(--color-text)" }}>{label}</span>
            <input
              type="text"
              value={s[key]}
              placeholder={ph}
              onChange={(e) => update({ [key]: e.target.value } as Partial<MascotSettings>, true)}
              className="rounded px-2 py-1 text-[12px]"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            />
          </label>
        ))}
      </section>

      <section style={card}>
        <H>MCP de escritorio (Claude Code)</H>
        <p className="mb-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Da a Claude Code en terminal control del escritorio: capturas, mover y clicar el ratón, arrastrar, rueda,
          escribir y atajos de teclado. Con ULTRON abierto, la mascota vuela hasta cada punto llevando el cursor,
          «pulsa» al clicar y teclea al escribir. Sin ULTRON abierto, el MCP devuelve un error que lo dice.
        </p>
        <Toggle
          label="La mascota lleva el cursor cuando un agente usa el ratón"
          hint="Desactivado, el cursor salta directo al punto y la mascota sigue a lo suyo."
          checked={s.drive_with_mcp}
          onChange={(v) => update({ drive_with_mcp: v })}
        />
        {bridge && (
          <div className="mt-2 flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
            <span>
              Puente local:{" "}
              <b style={{ color: bridge.running ? "var(--color-success)" : "var(--color-danger)" }}>
                {bridge.running ? `escuchando en 127.0.0.1:${bridge.port}` : "parado"}
              </b>
            </span>
            <span>
              Script:{" "}
              <code style={{ color: bridge.mcp_script_exists ? undefined : "var(--color-danger)" }}>{bridge.mcp_script}</code>
              {!bridge.mcp_script_exists && " (no existe)"}
            </span>
            <span>
              Comando equivalente: <code>{bridge.register_command}</code>
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={registerMcp}
          disabled={busy || !bridge?.mcp_script_exists}
          className="mt-3 rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {busy ? "Registrando…" : "Registrar en Claude Code"}
        </button>
      </section>
    </div>
  );
}
