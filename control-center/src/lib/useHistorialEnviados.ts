// Enganche de React para el historial de enviados (ver `historialEnviados.ts`).
//
// Da lo justo para una caja de texto: `onKeyDown` para las flechas y `recordar`
// para cuando se envía. La lógica de navegar vive aparte y es pura.

import { useCallback, useRef, useState } from "react";
import {
  anadir,
  cargar,
  guardar,
  inicio,
  navegar,
  type Navegacion,
} from "./historialEnviados";

const almacen = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export type HistorialEnviados = {
  /** Ponlo en el `onKeyDown` de la caja. Devuelve true si ha gestionado la
   *  tecla (entonces hay que llamar a preventDefault). */
  manejarTecla: (
    e: { key: string; preventDefault: () => void },
    valorActual: string,
    ponerValor: (v: string) => void,
  ) => boolean;
  /** Llámalo al enviar. */
  recordar: (mensaje: string) => void;
  /** Vuelve al modo "escribiendo". Útil al cambiar de conversación. */
  reiniciar: () => void;
};

/**
 * @param nombre identifica la caja: cada una tiene su historial. Así el chat
 *        y la línea de órdenes del orbe no se mezclan.
 */
export function useHistorialEnviados(nombre: string): HistorialEnviados {
  const [historial, setHistorial] = useState<string[]>(() => cargar(almacen(), nombre));
  // En una ref y no en estado: cambia en medio de un manejador de teclado y no
  // necesita repintar por sí mismo.
  const nav = useRef<Navegacion>(inicio());

  const manejarTecla = useCallback(
    (
      e: { key: string; preventDefault: () => void },
      valorActual: string,
      ponerValor: (v: string) => void,
    ): boolean => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        // Escribir cualquier otra cosa sale del historial: si no, seguir
        // escribiendo sobre un mensaje recuperado dejaría las flechas
        // apuntando a un sitio que ya no corresponde.
        if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
          nav.current = { ...nav.current, indice: -1 };
        }
        return false;
      }
      if (historial.length === 0) return false;
      // ↓ estando en el borrador no hace nada: no hay "más nuevo" que esto.
      if (e.key === "ArrowDown" && nav.current.indice === -1) return false;

      e.preventDefault();
      nav.current = navegar(
        nav.current,
        historial,
        e.key === "ArrowUp" ? 1 : -1,
        valorActual,
      );
      ponerValor(nav.current.texto);
      return true;
    },
    [historial],
  );

  const recordar = useCallback(
    (mensaje: string) => {
      setHistorial((prev) => {
        const nuevo = anadir(prev, mensaje);
        guardar(almacen(), nombre, nuevo);
        return nuevo;
      });
      nav.current = inicio();
    },
    [nombre],
  );

  const reiniciar = useCallback(() => {
    nav.current = inicio();
  }, []);

  return { manejarTecla, recordar, reiniciar };
}
