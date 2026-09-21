// Registro de las acciones del chat.
//
// `MariaChat` vive dentro de la pestaña Chat y App.tsx lo monta por condicional,
// así que se desmonta al cambiar de pestaña. La paleta y los atajos, en cambio,
// viven en App y están siempre. Este módulo es el puente: el chat PUBLICA lo
// que puede hacer mientras está en pantalla y lo retira al irse.
//
// Consecuencia buscada (2026-09-22): fuera de la pestaña Chat la lista está
// vacía, así que ni la paleta ofrece «parar la respuesta» ni el atajo hace
// nada. Un botón que no puede actuar es peor que no tenerlo (mandamiento 11).

import { useEffect, useState } from "react";
import type { AccionChat } from "../components/jarvis/chatAcciones";

let actuales: AccionChat[] = [];
const oyentes = new Set<(a: AccionChat[]) => void>();

/** Publica la lista (o la vacía al desmontar). Devuelve cómo retirarla. */
export function publicarAccionesChat(lista: AccionChat[]): () => void {
  actuales = lista;
  for (const o of oyentes) o(actuales);
  return () => {
    // Solo retira SU lista: si otra pantalla publicó después, no se la pisa.
    if (actuales !== lista) return;
    actuales = [];
    for (const o of oyentes) o(actuales);
  };
}

/** Las acciones del chat que haya ahora mismo. Vacío = no hay chat montado. */
export function useAccionesChat(): AccionChat[] {
  const [lista, setLista] = useState<AccionChat[]>(actuales);
  useEffect(() => {
    // Por si el chat publicó entre el primer render y este efecto.
    setLista(actuales);
    oyentes.add(setLista);
    return () => {
      oyentes.delete(setLista);
    };
  }, []);
  return lista;
}
