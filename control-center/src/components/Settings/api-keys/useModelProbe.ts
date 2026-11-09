// Settings/api-keys/useModelProbe.ts — botón «Probar» por proveedor:
// `ai_router_discover_models` (GET {base_url}/models con la key) y cuántos
// modelos ve, o el error tal cual. El proveedor del router se busca por su
// variable de entorno para no duplicar ids del seed en el frontend.

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RouterProviderRecord } from "./types";

export type ProbeState =
  | { status: "running" }
  | { status: "ok"; providerId: string; models: string[] }
  | { status: "error"; message: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UseModelProbeResult {
  probes: Record<string, ProbeState>;
  /** Prueba el proveedor del router cuya `key_env_var` es `envVar`. */
  probeByEnv: (envVar: string, keyConfigured: boolean | undefined) => Promise<void>;
  /** Prueba un proveedor por id (personalizados). */
  probeById: (providerId: string) => Promise<void>;
}

export function useModelProbe(): UseModelProbeResult {
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  const setProbe = useCallback((key: string, state: ProbeState) => {
    setProbes((prev) => ({ ...prev, [key]: state }));
  }, []);

  const discover = useCallback(
    async (key: string, providerId: string) => {
      try {
        const models = await invoke<string[]>("ai_router_discover_models", { providerId });
        setProbe(key, { status: "ok", providerId, models });
      } catch (e) {
        setProbe(key, { status: "error", message: errorText(e) });
      }
    },
    [setProbe],
  );

  const probeByEnv = useCallback(
    async (envVar: string, keyConfigured: boolean | undefined) => {
      if (keyConfigured === false) {
        setProbe(envVar, {
          status: "error",
          message: "No hay key guardada: guárdala antes de probar (se prueba la variable de entorno, no el campo).",
        });
        return;
      }
      setProbe(envVar, { status: "running" });
      let providers: RouterProviderRecord[];
      try {
        providers = await invoke<RouterProviderRecord[]>("ai_router_list_providers");
      } catch (e) {
        setProbe(envVar, { status: "error", message: `No se pudo leer el catálogo del router: ${errorText(e)}` });
        return;
      }
      const provider = providers.find((p) => p.key_env_var === envVar);
      if (!provider) {
        setProbe(envVar, {
          status: "error",
          message: `Ningún proveedor del router usa ${envVar}: el catálogo cargado no lo tiene (¿binario anterior al cambio? reinicia la app tras el build).`,
        });
        return;
      }
      await discover(envVar, provider.id);
    },
    [discover, setProbe],
  );

  const probeById = useCallback(
    async (providerId: string) => {
      setProbe(providerId, { status: "running" });
      await discover(providerId, providerId);
    },
    [discover, setProbe],
  );

  return { probes, probeByEnv, probeById };
}
