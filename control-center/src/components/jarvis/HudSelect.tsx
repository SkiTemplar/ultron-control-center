// mar.ia — desplegable propio del HUD.
//
// Por qué no un `<select>`: en Windows la lista desplegable de un `<select>`
// la pinta el SISTEMA, no la página. Sobre el HUD azul salía un cuadro blanco
// del tema de Windows, con la letra minúscula y sin poder leer para qué sirve
// cada modelo (el usuario: "no se ve nada bien el desplegable de los modelos
// y proveedores", 2026-09-19).
//
// Esto es un listbox de verdad: botón + lista propia, con teclado (flechas,
// Enter, Esc, Inicio/Fin), cierre al pulsar fuera y sitio para una línea de
// explicación por opción.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { siguienteIndice } from "./hudSelectNav";

export type Opcion = {
  id: string;
  label: string;
  /** Una línea de para qué sirve. Se pinta bajo la etiqueta. */
  hint?: string;
};

type Props = {
  etiqueta: string;
  valor: string;
  opciones: Opcion[];
  onChange: (v: string) => void;
  /** Texto de la opción vacía. Sin él, la selección es obligatoria. */
  vacio?: string;
  titulo?: string;
  /** Ancho mínimo del control. */
  ancho?: number;
};

export function HudSelect({
  etiqueta,
  valor,
  opciones,
  onChange,
  vacio,
  titulo,
  ancho = 150,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const [marcado, setMarcado] = useState(0);
  const caja = useRef<HTMLDivElement | null>(null);
  const boton = useRef<HTMLButtonElement | null>(null);
  const idLista = useId();

  const todas: Opcion[] = vacio === undefined ? opciones : [{ id: "", label: vacio }, ...opciones];
  const actual = todas.find((o) => o.id === valor);
  const fijado = Boolean(valor);
  const deshabilitado = todas.length === 0;

  const cerrar = useCallback(() => {
    setAbierto(false);
    boton.current?.focus();
  }, []);

  // Al abrir, el cursor arranca sobre lo que ya está elegido.
  useEffect(() => {
    if (!abierto) return;
    const i = todas.findIndex((o) => o.id === valor);
    setMarcado(i >= 0 ? i : 0);
  }, [abierto, valor, todas]);

  // Pulsar fuera cierra. Sin esto el desplegable se queda abierto encima del
  // chat y tapa la conversación.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [abierto]);

  function elegir(i: number) {
    const o = todas[i];
    if (!o) return;
    onChange(o.id);
    cerrar();
  }

  function teclas(e: React.KeyboardEvent) {
    if (!abierto) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setAbierto(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      elegir(marcado);
      return;
    }
    const siguiente = siguienteIndice(e.key, marcado, todas.length);
    if (siguiente !== null) {
      e.preventDefault();
      setMarcado(siguiente);
    }
  }

  return (
    <div className="flex flex-col gap-0.5" ref={caja} title={titulo}>
      <span className="hud-label">{etiqueta}</span>
      <div className="relative">
        <button
          ref={boton}
          type="button"
          role="combobox"
          aria-expanded={abierto}
          aria-controls={idLista}
          aria-haspopup="listbox"
          aria-label={etiqueta}
          disabled={deshabilitado}
          onClick={() => setAbierto((a) => !a)}
          onKeyDown={teclas}
          className="hud-panel flex w-full items-center gap-2 px-3 text-left text-[13px]"
          style={{
            minHeight: 38,
            minWidth: ancho,
            color: fijado ? "var(--color-accent)" : "var(--color-text-secondary)",
            border: fijado
              ? "1px solid var(--color-accent)"
              : "1px solid var(--color-border)",
            fontFamily: "var(--font-mono)",
            cursor: deshabilitado ? "not-allowed" : "pointer",
            opacity: deshabilitado ? 0.5 : 1,
          }}
        >
          <span className="flex-1 truncate">{actual?.label ?? vacio ?? "—"}</span>
          <span aria-hidden style={{ color: "var(--color-text-tertiary)" }}>
            {abierto ? "▴" : "▾"}
          </span>
        </button>

        {abierto && (
          <ul
            id={idLista}
            role="listbox"
            aria-label={etiqueta}
            className="hud-panel hud-menu absolute left-0 z-50 mt-1 max-h-[320px] w-full min-w-[220px] overflow-y-auto py-1"
            style={{ top: "100%" }}
          >
            {todas.map((o, i) => {
              const elegido = o.id === valor;
              return (
                <li key={o.id || "__vacio"}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={elegido}
                    onMouseEnter={() => setMarcado(i)}
                    onMouseDown={(e) => {
                      // mousedown, no click: el botón pierde el foco antes de
                      // que llegue el click y la elección se perdería.
                      e.preventDefault();
                      elegir(i);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left"
                    style={{
                      background: i === marcado ? "var(--color-surface-3)" : "transparent",
                      borderLeft: elegido
                        ? "2px solid var(--color-accent)"
                        : "2px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      className="text-[13px]"
                      style={{
                        color: elegido ? "var(--color-accent)" : "var(--color-text)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {o.label}
                    </span>
                    {o.hint && (
                      <span
                        className="text-[11px]"
                        style={{ color: "var(--color-text-tertiary)", lineHeight: 1.35 }}
                      >
                        {o.hint}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
