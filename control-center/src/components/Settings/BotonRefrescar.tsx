// Botón de "volver a comprobar" con estado a la vista.
//
// El usuario lo pidió el 2026-09-20: "que los botones de refresh en ajustes den
// feedback visual del estado". Antes se pulsaba y no pasaba nada visible: si la
// comprobación tardaba dos segundos, no había forma de saber si se había
// enterado del clic, si estaba trabajando o si había fallado. Un botón que no
// dice nada se acaba pulsando cinco veces.
//
// Los cuatro estados son los cuatro que importan:
//   reposo      — se puede pulsar
//   comprobando — pulsado y trabajando (deshabilitado, no se puede repetir)
//   hecho       — salió bien, con la hora; se desvanece solo a los 4 s
//   error       — falló, y se dice POR QUÉ (mandamiento 11)

import { useCallback, useEffect, useRef, useState } from "react";

type Estado =
  | { fase: "reposo" }
  | { fase: "comprobando" }
  | { fase: "hecho"; cuando: Date }
  | { fase: "error"; motivo: string };

type Props = {
  /** Lo que se ejecuta al pulsar. Si lanza, se enseña el motivo. */
  onRefrescar: () => Promise<unknown>;
  /** Texto en reposo. */
  etiqueta?: string;
  /** Texto mientras trabaja. */
  trabajando?: string;
  title?: string;
};

function hora(d: Date): string {
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function BotonRefrescar({
  onRefrescar,
  etiqueta = "volver a comprobar",
  trabajando = "comprobando…",
  title,
}: Props) {
  const [estado, setEstado] = useState<Estado>({ fase: "reposo" });
  // Para no tocar el estado de un componente ya desmontado (la comprobación
  // puede tardar más que la pestaña).
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const pulsar = useCallback(async () => {
    setEstado({ fase: "comprobando" });
    try {
      await onRefrescar();
      if (!vivo.current) return;
      setEstado({ fase: "hecho", cuando: new Date() });
    } catch (e) {
      if (!vivo.current) return;
      setEstado({ fase: "error", motivo: e instanceof Error ? e.message : String(e) });
    }
  }, [onRefrescar]);

  // El "hecho" se retira solo: dejarlo fijo haría creer que se acaba de
  // comprobar cuando ya pasaron diez minutos.
  useEffect(() => {
    if (estado.fase !== "hecho") return;
    const t = window.setTimeout(() => {
      if (vivo.current) setEstado({ fase: "reposo" });
    }, 4000);
    return () => window.clearTimeout(t);
  }, [estado]);

  const ocupado = estado.fase === "comprobando";

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void pulsar()}
        disabled={ocupado}
        aria-busy={ocupado}
        title={title}
        className="hud-panel px-3 text-[12px] transition-opacity disabled:opacity-60"
        style={{
          minHeight: 34,
          color: estado.fase === "error" ? "var(--color-danger)" : "var(--color-accent)",
          cursor: ocupado ? "progress" : "pointer",
        }}
      >
        {ocupado ? trabajando : etiqueta}
      </button>
      {estado.fase === "hecho" && (
        <span className="text-[11px]" style={{ color: "var(--color-success)" }}>
          ✓ {hora(estado.cuando)}
        </span>
      )}
      {estado.fase === "error" && (
        <span
          className="max-w-[320px] truncate text-[11px]"
          style={{ color: "var(--color-danger)" }}
          title={estado.motivo}
        >
          {estado.motivo}
        </span>
      )}
    </span>
  );
}
