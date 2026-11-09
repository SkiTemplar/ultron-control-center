// Contexto con el adaptador de API activo (real o mock).

import { createContext, useContext } from "react";
import type { SesionesApi } from "./api";

export const ApiContext = createContext<SesionesApi | null>(null);

export function useApi(): SesionesApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi fuera de ApiContext");
  return api;
}
