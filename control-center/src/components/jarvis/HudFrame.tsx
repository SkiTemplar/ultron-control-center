// mar.ia — el marco del HUD.
//
// Envuelve la aplicacion entera: capas de fondo (rejilla de plano, barrido,
// viñeta) detras, y una barra superior de telemetria delante. Las pestañas
// heredadas de ULTRON se pintan dentro sin cambiar una linea de su codigo:
// su aspecto cambia porque los tokens de color (styles.css) ahora son los del
// HUD.
//
// Las capas de fondo llevan pointer-events:none (ver styles.css): decoran, no
// interceptan clics.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Reactor, type ReactorState } from "./Reactor";

/** Telemetria que pinta la barra.
 *
 *  Los nombres son los de `RichSystemInfo` en system.rs — una version anterior
 *  invento `cpu_percent`/`memory_used_gb`, que no existen, y la barra mostraba
 *  guiones para siempre sin dar ningun error. */
type SystemInfo = {
  cpu_load_pct?: number | null;
  ram_used_gb?: number | null;
  ram_total_gb?: number | null;
  ram_pct_used?: number | null;
};

function fmtPct(v: number | null | undefined): string {
  return typeof v === "number" ? `${Math.round(v)}%` : "—";
}

export function HudTopBar({ voiceState }: { voiceState: ReactorState }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    const pull = () => {
      // rich_system_info ya existe en ULTRON (System > Diagnostics). Si falla,
      // la barra se queda con guiones: nada de cifras inventadas.
      void invoke<SystemInfo>("rich_system_info")
        .then((d) => {
          if (alive) setInfo(d ?? null);
        })
        .catch(() => {
          if (alive) setInfo(null);
        });
    };
    pull();
    const idData = setInterval(pull, 15_000);
    const idClock = setInterval(() => setClock(new Date()), 1_000);
    return () => {
      alive = false;
      clearInterval(idData);
      clearInterval(idClock);
    };
  }, []);

  const cells: Array<[string, string]> = [
    ["cpu", fmtPct(info?.cpu_load_pct)],
    [
      "ram",
      typeof info?.ram_used_gb === "number" && typeof info?.ram_total_gb === "number"
        ? `${info.ram_used_gb.toFixed(1)}/${info.ram_total_gb.toFixed(0)} GB`
        : "—",
    ],
    ["voz", voiceState === "offline" ? "off" : voiceState],
  ];

  return (
    <div
      className="relative z-10 flex items-center gap-4 px-4 py-1.5"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <span className="hud-label">mar.ia</span>
      <span className="flex-1" />
      {cells.map(([k, v]) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="hud-label">{k}</span>
          <span className="hud-value text-[11px]">{v}</span>
        </span>
      ))}
      <span className="hud-value text-[11px] tabular-nums">
        {clock.toLocaleTimeString("es-ES", { hour12: false })}
      </span>
      <Reactor size={16} state={voiceState} />
    </div>
  );
}

/** Capas decorativas del fondo. Se montan una vez, detras de todo. */
export function HudBackground() {
  return (
    <>
      <div className="hud-bg" aria-hidden />
      <div className="hud-lines" aria-hidden />
      <div className="hud-scan" aria-hidden />
    </>
  );
}

/** Estado de voz compartido: estado, nivel de microfono y ultima frase.
 *
 *  Un solo `listen` para toda la aplicacion: el reactor de la barra, el de la
 *  pantalla principal y el subtitulo beben del mismo evento. Con un hook por
 *  componente habria tres suscripciones al mismo canal. */
export function useVoice(): { state: ReactorState; amp: number; caption: string } {
  const [state, setState] = useState<ReactorState>("offline");
  const [amp, setAmp] = useState(0);
  const [caption, setCaption] = useState("");

  useEffect(() => {
    // Al montar preguntamos si el sidecar vive; luego mandan los eventos.
    void invoke<boolean>("maria_voice_running")
      .then((running) => setState(running ? "idle" : "offline"))
      .catch(() => setState("offline"));
    const un = listen<{ state?: string; amp?: number; text?: string }>("maria:voice", (e) => {
      const p = e.payload ?? {};
      if (p.state === "idle" || p.state === "listening" || p.state === "thinking" || p.state === "speaking") {
        setState(p.state);
      }
      if (typeof p.amp === "number") setAmp(Math.max(0, Math.min(1, p.amp)));
      if (typeof p.text === "string") setCaption(p.text.slice(0, 200));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  return { state, amp, caption };
}
