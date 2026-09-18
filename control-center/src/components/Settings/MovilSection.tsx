// Ajustes → Móvil: la webapp de mar.ia en el teléfono.
//
// Es el punto de consumo de `maria_web`: sin esta pantalla, el servidor tendría
// comandos registrados y ninguna forma de encenderlo, que es exactamente la
// clase de feature que no existe (mandamiento 12).
//
// Lo que se dice aquí es lo que hace de verdad, sin adornos: el servidor no
// lleva TLS, así que para salir del PC la vía es Tailscale, y los avisos con la
// pantalla apagada van por ntfy, no por el propio servidor.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type WebConfig = {
  enabled: boolean;
  port: number;
  bind: string;
  ntfy_topic: string;
  ntfy_server: string;
  allowed_origins: string[];
};

/** La app instalable. Se sirve desde Vercel porque un PWA necesita https para
 *  poder instalarse, y el PC no lo tiene. La app no piensa nada: solo habla
 *  con este servidor. */
const APP_MOVIL = "https://maria-movil.vercel.app";

type WebStatus = {
  running: boolean;
  config: WebConfig;
  token: string;
  urls: string[];
};

export function MovilSection() {
  const [estado, setEstado] = useState<WebStatus | null>(null);
  const [borrador, setBorrador] = useState<WebConfig | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    const s = await invoke<WebStatus>("maria_web_status").catch((e) => {
      setError(String(e));
      return null;
    });
    if (s) {
      setEstado(s);
      setBorrador(s.config);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(cambios: Partial<WebConfig>) {
    if (!borrador) return;
    const config = { ...borrador, ...cambios };
    setBorrador(config);
    setOcupado(true);
    setError(null);
    setMensaje(null);
    const s = await invoke<WebStatus>("maria_web_set", { config }).catch((e) => {
      setError(String(e));
      return null;
    });
    setOcupado(false);
    if (s) {
      setEstado(s);
      setBorrador(s.config);
      setMensaje(s.running ? "servidor levantado" : "servidor parado");
    }
  }

  if (!borrador || !estado) {
    return <p className="hud-label p-4">{error ?? "cargando…"}</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          mar.ia en el móvil
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
          Abre una webapp con el chat (mismo relevo de proveedores), el estado del PC y los
          avisos. Va <strong>apagada</strong> por defecto.
        </p>
      </header>

      {/* --- encendido ---------------------------------------------------- */}
      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={borrador.enabled}
          disabled={ocupado}
          onChange={(e) => void guardar({ enabled: e.target.checked })}
        />
        <span>servidor encendido</span>
        <span className="hud-label" style={{ color: estado.running ? "var(--color-accent)" : undefined }}>
          {estado.running ? "escuchando" : "parado"}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <label className="flex items-center gap-1">
          <span className="hud-label">puerto</span>
          <input
            type="number"
            value={borrador.port}
            min={1024}
            max={65535}
            disabled={ocupado}
            onChange={(e) => setBorrador({ ...borrador, port: Number(e.target.value) })}
            onBlur={() => void guardar({ port: borrador.port })}
            className="hud-panel w-24 px-2 py-1"
            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="hud-label">escucha en</span>
          <select
            value={borrador.bind}
            disabled={ocupado}
            onChange={(e) => void guardar({ bind: e.target.value })}
            className="hud-panel px-2 py-1"
            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
          >
            <option value="127.0.0.1">solo este PC (127.0.0.1)</option>
            <option value="0.0.0.0">la red (para el móvil)</option>
          </select>
        </label>
      </div>

      {borrador.bind === "0.0.0.0" && (
        <p
          className="px-3 py-2 text-[11px]"
          style={{ border: "1px solid var(--color-warn)", color: "var(--color-warn)" }}
        >
          Escuchando en la red y <strong>sin TLS</strong>. Úsalo dentro de una red privada
          (Tailscale); expuesto a internet, quien tenga el enlace tiene el control del PC.
        </p>
      )}

      {/* --- enlaces ------------------------------------------------------ */}
      {estado.running && estado.urls.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="hud-label">abre esto en el móvil (el enlace ya lleva el token):</span>
          {estado.urls.map((u) => (
            <code
              key={u}
              className="hud-panel px-2 py-1 text-[11px]"
              style={{ color: "var(--color-accent)", overflowWrap: "anywhere" }}
            >
              {u}
            </code>
          ))}
          <span className="hud-label">
            el token se guarda en el navegador del móvil: solo hace falta la primera vez
          </span>
        </div>
      )}

      {/* --- app instalable ------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        <h3 className="hud-label" style={{ fontSize: 12 }}>
          app del móvil
        </h3>
        <p className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Ábrela en el teléfono e instálala («Instalar aplicación» en Android, «Añadir a
          pantalla de inicio» en iPhone). Ahí dentro pegas la dirección y el token de arriba.
          La app no piensa nada: todo se manda a este PC.
        </p>
        <code
          className="hud-panel px-2 py-1 text-[12px]"
          style={{ color: "var(--color-accent)", overflowWrap: "anywhere" }}
        >
          {APP_MOVIL}
        </code>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(APP_MOVIL)
                .then(() => setMensaje("enlace copiado"))
                .catch(() => setError("no pude copiar al portapapeles"));
            }}
            className="hud-panel px-3 text-[12px]"
            style={{ minHeight: 34, color: "var(--color-accent)", cursor: "pointer" }}
          >
            copiar enlace
          </button>
        </div>
        <p className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Esa web va por https, así que solo puede hablar con una dirección https. Para usarla
          fuera de casa: instala Tailscale y ejecuta <code>tailscale serve --bg {borrador.port}</code>
          {" "}en el PC; te da un <code>https://….ts.net</code> que pegar en la app. En la misma
          red, usa directamente el enlace de arriba (lo sirve el propio PC).
        </p>
        <p className="hud-label">
          orígenes aceptados por la API: {(borrador.allowed_origins ?? []).join(", ") || "ninguno"}
        </p>
      </div>

      {/* --- avisos ------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <h3 className="hud-label" style={{ fontSize: 12 }}>
          avisos al móvil (ntfy)
        </h3>
        <p className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Los avisos con la pantalla apagada NO salen del servidor de arriba: un service worker
          necesitaría HTTPS. Van por <strong>ntfy</strong>: instala la app, suscríbete a un tema
          y pon aquí ese mismo tema.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <label className="flex items-center gap-1">
            <span className="hud-label">tema</span>
            <input
              value={borrador.ntfy_topic}
              placeholder="p. ej. maria-mokiu-7x2"
              disabled={ocupado}
              onChange={(e) => setBorrador({ ...borrador, ntfy_topic: e.target.value })}
              onBlur={() => void guardar({ ntfy_topic: borrador.ntfy_topic })}
              className="hud-panel w-60 px-2 py-1"
              style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
            />
          </label>
          <button
            type="button"
            disabled={ocupado || !borrador.ntfy_topic.trim()}
            onClick={() => {
              setError(null);
              setMensaje(null);
              void invoke("maria_web_test_notify")
                .then(() => setMensaje("aviso de prueba enviado"))
                .catch((e) => setError(String(e)));
            }}
            className="hud-panel hud-label px-2 py-1"
            style={{
              color: borrador.ntfy_topic.trim() ? "var(--color-accent)" : "var(--color-text-tertiary)",
              cursor: borrador.ntfy_topic.trim() ? "pointer" : "default",
            }}
          >
            enviar prueba
          </button>
        </div>
        <span className="hud-label">
          un tema es público para quien lo adivine: usa uno largo y raro
        </span>
      </div>

      {mensaje && (
        <p className="text-[12px]" style={{ color: "var(--color-accent)" }}>
          {mensaje}
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
