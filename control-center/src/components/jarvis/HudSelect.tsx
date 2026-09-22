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
import type { ModeloInfo } from "./terminalCore";

export type Opcion = {
  id: string;
  label: string;
  /** Una línea de para qué sirve. Se pinta bajo la etiqueta. */
  hint?: string;
  /** No se puede elegir, pero SE SIGUE VIENDO (en gris, con su motivo).
   *  Una opción que desaparece parece un fallo del programa; una en gris que
   *  dice «rechazado por la cuenta el 22/09» explica la suscripción. */
  deshabilitada?: boolean;
  /** Por qué no se puede elegir. Se pinta bajo la pista, en color de aviso. */
  motivo?: string;
};

/** Un modelo del catálogo (`maria_models_catalog`), tal y como se ofrece en un
 *  desplegable.
 *
 *  Vive aquí, y no copiado en cada pantalla, porque son CUATRO las que ofrecen
 *  modelos (chat, reglas del Router, terminales y panel de terminal) y hasta
 *  el 2026-09-22 cada una hacía su propio `.map()`: el día que el catálogo
 *  empezó a decir qué permite la suscripción, tres de las cuatro se habrían
 *  quedado ofreciendo modelos que la cuenta rechaza. */
export function opcionDeModelo(m: ModeloInfo): Opcion {
  const vetado = m.permitido === "no";
  return {
    id: m.id,
    label: m.label,
    hint: m.para || m.id,
    deshabilitada: vetado,
    motivo: vetado ? m.motivo || "tu suscripción no lo permite" : undefined,
  };
}

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

  // Al abrir, el cursor arranca sobre lo que ya está elegido; si no hay nada
  // elegido, sobre la primera que SE PUEDA elegir, para que el primer Enter
  // haga algo (2026-09-22).
  //
  // `colocado` es lo que hace que esto pase UNA VEZ por apertura. `todas` se
  // construye en cada render, así que sin el candado el efecto se ejecutaba
  // después de cada render y devolvía el cursor a la opción ya elegida: las
  // flechas movían el resaltado y el siguiente render lo traía de vuelta, de
  // modo que Enter elegía siempre lo mismo. Salió al probar el salto de las
  // opciones vetadas, pero llevaba roto desde que existe el desplegable.
  const colocado = useRef(false);
  useEffect(() => {
    if (!abierto) {
      colocado.current = false;
      return;
    }
    if (colocado.current) return;
    colocado.current = true;
    const i = todas.findIndex((o) => o.id === valor);
    if (i >= 0) {
      setMarcado(i);
      return;
    }
    const libre = todas.findIndex((o) => !o.deshabilitada);
    setMarcado(libre >= 0 ? libre : 0);
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
    // Una opción deshabilitada se ve pero no se elige, ni con el ratón ni con
    // Enter: el desplegable se queda abierto para que se lea el motivo.
    if (o.deshabilitada) return;
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
      // El listener de `window` (App.tsx) tiene Escape atado a «parar el
      // turno»: sin cortar aquí la propagación, cerrar este desplegable
      // mataba además la respuesta que se estaba escribiendo (2026-09-22).
      // Solo con el desplegable ABIERTO — cerrado, Escape sigue siendo del
      // chat aunque el foco esté en el botón.
      e.stopPropagation();
      cerrar();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      elegir(marcado);
      return;
    }
    const siguiente = siguienteIndice(e.key, marcado, todas.length, (i) =>
      Boolean(todas[i]?.deshabilitada),
    );
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
          // El foco no se mueve de aquí: quien lee la pantalla necesita que se
          // le diga sobre qué opción está el cursor de las flechas.
          aria-activedescendant={abierto ? `${idLista}-${marcado}` : undefined}
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
                    id={`${idLista}-${i}`}
                    aria-selected={elegido}
                    // aria-disabled, no el atributo `disabled`: un botón
                    // deshabilitado de verdad no recibe el ratón y el tooltip
                    // con el motivo no llegaría a verse nunca.
                    aria-disabled={o.deshabilitada || undefined}
                    title={o.motivo || undefined}
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
                      cursor: o.deshabilitada ? "not-allowed" : "pointer",
                    }}
                  >
                    <span
                      className="text-[13px]"
                      style={{
                        color: o.deshabilitada
                          ? "var(--color-text-tertiary)"
                          : elegido
                            ? "var(--color-accent)"
                            : "var(--color-text)",
                        fontFamily: "var(--font-mono)",
                        textDecoration: o.deshabilitada ? "line-through" : undefined,
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
                    {o.motivo && (
                      <span
                        className="text-[11px]"
                        style={{ color: "var(--color-warn)", lineHeight: 1.35 }}
                      >
                        {o.motivo}
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
