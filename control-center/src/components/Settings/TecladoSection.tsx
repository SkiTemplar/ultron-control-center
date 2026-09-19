// Ajustes → General: el autocompletado global `//maria`.
//
// Escribes `//maria <lo que sea>` en cualquier sitio (bloc de notas, un editor,
// un campo del navegador), pulsas Enter y mar.ia borra lo escrito y deja la
// respuesta en su lugar.
//
// Va APAGADO de fábrica y esta pantalla dice por qué antes de encenderlo: un
// hook de teclado global ve lo que tecleas. Aquí se explica exactamente qué se
// guarda y qué no, porque encender esto a ciegas no estaría bien.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ConfigTeclado = { enabled: boolean; disparador: string };

export function TecladoSection() {
  const [cfg, setCfg] = useState<ConfigTeclado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const c = await invoke<ConfigTeclado>("maria_teclado_get").catch((e) => {
      setError(String(e));
      return null;
    });
    if (c) setCfg(c);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(cambios: Partial<ConfigTeclado>) {
    if (!cfg) return;
    const config = { ...cfg, ...cambios };
    setCfg(config);
    setError(null);
    setAviso(null);
    const r = await invoke<ConfigTeclado>("maria_teclado_set", { config }).catch((e) => {
      setError(String(e));
      return null;
    });
    if (r) {
      setCfg(r);
      setAviso(
        r.enabled
          ? `activo: escribe «${r.disparador} …» y pulsa Enter en cualquier programa`
          : "apagado (deja de escuchar al reiniciar mar.ia)",
      );
    }
  }

  if (!cfg) return <p className="hud-label p-4">{error ?? "cargando…"}</p>;

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          autocompletado en cualquier sitio
        </h2>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          Escribe <code>{cfg.disparador} traduce esto al inglés</code> en el bloc de notas, en
          un editor o en un campo del navegador y pulsa Enter: mar.ia borra lo que has escrito
          y deja la respuesta ahí mismo.
        </p>
      </header>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => void guardar({ enabled: e.target.checked })}
        />
        <span>activar</span>
        <span className="hud-label">{cfg.enabled ? "escuchando" : "apagado"}</span>
      </label>

      <label className="flex items-center gap-2 text-[12.5px]">
        <span style={{ color: "var(--color-text-tertiary)" }}>disparador</span>
        <input
          value={cfg.disparador}
          onChange={(e) => setCfg({ ...cfg, disparador: e.target.value })}
          onBlur={() => void guardar({ disparador: cfg.disparador })}
          className="px-2 text-[13px]"
          style={{
            minHeight: 34,
            minWidth: 140,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            outline: "none",
            fontFamily: "var(--font-mono)",
          }}
        />
      </label>

      <div
        className="flex flex-col gap-1 px-3 py-2 text-[11.5px]"
        style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
      >
        <strong style={{ color: "var(--color-text)" }}>Qué mira y qué no</strong>
        <span>
          · Mientras no escribas el disparador, cada tecla se olvida al momento: solo se guarda
          en memoria lo que todavía podría llegar a serlo.
        </span>
        <span>· No se escribe nada en disco, y no sale de este ordenador.</span>
        <span>
          · La orden la responde el <strong>modelo local</strong>, que se carga al pulsar Enter y
          se descarga en cuanto contesta. Fuera de eso, la VRAM queda libre.
        </span>
        <span>· Escape cancela una orden a medias.</span>
      </div>

      {aviso && (
        <p className="text-[12px]" style={{ color: "var(--color-success)" }}>
          {aviso}
        </p>
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
