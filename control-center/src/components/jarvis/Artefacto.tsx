// mar.ia — panel de artefactos.
//
// Lo que la IA genera para verse: una pagina, un SVG, un diagrama. A la derecha
// del chat, con dos pestañas (vista / codigo) y dos acciones (copiar y guardar
// en la carpeta de trabajo de la conversacion). Cerrar es cosa del panel que lo
// contiene (`PanelLateral.tsx`).
//
// El HTML y el SVG corren en un `iframe` con `sandbox="allow-scripts"` servido
// por `maria/artefactos.rs` desde otro origen: pueden ejecutar su JavaScript,
// pero no alcanzan la aplicacion. Mermaid se pinta aqui mismo, que no ejecuta
// nada.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BotonCopiar } from "./BotonCopiar";
import { Mermaid, type ArtefactoRef } from "./Markdown";

const EXT: Record<ArtefactoRef["tipo"], string> = { html: "html", svg: "svg", mermaid: "mmd" };

export function Artefacto({
  artefacto,
  threadId,
  onAviso,
}: {
  artefacto: ArtefactoRef;
  threadId: string;
  onAviso: (texto: string, tono?: "info" | "error") => void;
}) {
  const [vista, setVista] = useState<"vista" | "codigo">("vista");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (artefacto.tipo === "mermaid") return;
    let vivo = true;
    invoke<string>("maria_artefacto_publicar", {
      tipo: artefacto.tipo,
      contenido: artefacto.codigo,
    })
      .then((u) => vivo && setUrl(u))
      .catch((e) => vivo && setError(String(e)));
    return () => {
      vivo = false;
    };
  }, [artefacto]);

  async function guardar() {
    const nombre = `artefacto-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${EXT[artefacto.tipo]}`;
    try {
      const ruta = await invoke<string>("maria_artefacto_guardar", {
        threadId,
        nombre,
        contenido: artefacto.codigo,
      });
      onAviso(`guardado en ${ruta}`);
      void revealItemInDir(ruta).catch(() => undefined);
    } catch (e) {
      onAviso(`no pude guardarlo: ${String(e)}`, "error");
    }
  }

  const pestaña = (id: "vista" | "codigo", label: string) => (
    <button
      type="button"
      onClick={() => setVista(id)}
      className="px-3 py-1.5 text-[11px] uppercase"
      style={{
        background: vista === id ? "var(--color-surface-3)" : "transparent",
        color: vista === id ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: "none",
        borderBottom: vista === id ? "1px solid var(--color-accent)" : "1px solid transparent",
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.1em",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-w-0 flex-col" aria-label="artefacto">
      <div
        className="flex items-center justify-between gap-2 border-b px-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center">
          {pestaña("vista", "vista")}
          {pestaña("codigo", "código")}
          <span className="hud-label ml-3">{artefacto.tipo}</span>
        </div>
        <div className="flex items-center gap-2 py-1">
          <BotonCopiar texto={artefacto.codigo} />
          <button type="button" className="cc-bloque-boton" onClick={() => void guardar()}>
            guardar
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {vista === "codigo" ? (
          <pre className="cc-code m-0 h-full" style={{ borderRadius: 0 }}>
            <code>{artefacto.codigo}</code>
          </pre>
        ) : artefacto.tipo === "mermaid" ? (
          <div className="p-4">
            <Mermaid codigo={artefacto.codigo} />
          </div>
        ) : error ? (
          <p className="p-4 text-[12px]" style={{ color: "var(--color-danger)" }}>
            no pude preparar la vista: {error}
          </p>
        ) : url ? (
          <iframe
            title="vista del artefacto"
            src={url}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-full w-full"
            style={{ border: "none", background: "#fff" }}
          />
        ) : (
          <p className="hud-label hud-pulse p-4">preparando la vista…</p>
        )}
      </div>
    </div>
  );
}
