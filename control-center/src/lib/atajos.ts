// Los atajos de dentro de la ventana, tal y como los sirve Rust.
//
// Vive fuera de App.tsx (2026-09-22) por una razon concreta: desde que hay
// editor (Ajustes → Atajos) el mapa YA NO se lee una vez al arrancar. Guardar
// en esa pantalla tiene que llegar al manejador de teclado sin reiniciar la
// app, y esa regla —"al oir «maria:atajos», vuelve a preguntar"— es justo lo
// que hay que poder probar. Dentro de App.tsx solo se podia probar montando la
// aplicacion entera: la suite pasaba de 7,5 s a ~80 s por el grafo de modulos
// de esa pantalla (xterm y compania). Medido antes de sacarlo.
//
// El combo NO se interpreta aqui: eso lo hace `matchCombo` en App.tsx, que es
// quien ve los KeyboardEvent. Esto solo trae el mapa y avisa cuando cambia.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Eventos de ventana que obligan a releer el mapa.
 *
 *  Son dos porque los dispara gente distinta: `in-app-shortcuts-updated` es el
 *  historico (lo puede lanzar el backend) y `maria:atajos` lo lanza el editor
 *  al guardar. Escuchar solo uno dejaria al otro sin efecto hasta reiniciar. */
export const EVENTOS_ATAJOS = ["in-app-shortcuts-updated", "maria:atajos"] as const;

export type Atajos = Record<string, string>;

/**
 * El mapa `accion -> combinacion`, releido en cada evento de `EVENTOS_ATAJOS`.
 *
 * Devuelve las dos caras que hacen falta:
 *   * `bindings`, reactivo, para pintar el atajo en la paleta;
 *   * `ref`, para leerlo DENTRO del manejador de teclado, que se registra una
 *     sola vez y con el valor reactivo se quedaria mirando el mapa de cuando
 *     se monto.
 *
 * Un fallo al leer no vacia lo que ya habia: quedarse sin teclado porque una
 * lectura suelta fallo seria peor que seguir con el mapa anterior.
 */
export function useAtajos(): { bindings: Atajos; ref: React.RefObject<Atajos> } {
  const ref = useRef<Atajos>({});
  const [bindings, setBindings] = useState<Atajos>({});

  useEffect(() => {
    let cancelado = false;
    async function cargar() {
      try {
        const map = (await invoke("get_in_app_shortcuts")) as Atajos | null;
        if (cancelado || !map) return;
        ref.current = map;
        setBindings(map);
      } catch (err) {
        console.warn("[maria] get_in_app_shortcuts falló", err);
      }
    }
    void cargar();
    const alCambiar = () => void cargar();
    for (const ev of EVENTOS_ATAJOS) window.addEventListener(ev, alCambiar);
    return () => {
      cancelado = true;
      for (const ev of EVENTOS_ATAJOS) window.removeEventListener(ev, alCambiar);
    };
  }, []);

  return { bindings, ref };
}
