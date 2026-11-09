// Settings/api-keys/useCustomProviders.ts — proveedores personalizados del
// AI Router: listar (ai_router_list_providers, custom: true), añadir o editar
// (ai_router_upsert_custom_provider + set_env_vars_keys para la key) y quitar
// (ai_router_remove_custom_provider). Contrato plans/2026-10-26, §4.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  CustomApiFormat,
  CustomProviderInput,
  EnvKeysSaveResult,
  RouterProviderRecord,
} from "./types";
import {
  isLoopbackHttpUrl,
  slugToKeyEnv,
  validateCustomProvider,
  type CustomProviderDraft,
  type CustomProviderErrors,
} from "./validation";

export interface CustomFeedback {
  kind: "ok" | "warn" | "error";
  text: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function keySaveProblem(envVar: string, r: EnvKeysSaveResult): string | null {
  if (r.saved.includes(envVar)) return null;
  if (r.errors[envVar]) return r.errors[envVar];
  if (r.skipped.includes(envVar)) return "el backend la rechazó (nombre fuera de la lista admitida)";
  return "el backend no la guardó";
}

/**
 * Variable de la key que se manda al backend. Un servidor en loopback sin
 * key escrita va sin variable (`""`): el backend no manda Authorization y lo
 * da por configurado. Si ese proveedor ya tenía variable, se conserva (la key
 * puede estar ya en el entorno).
 */
export function keyEnvFor(
  id: string,
  baseUrl: string,
  secret: string,
  existing: RouterProviderRecord | undefined,
): string {
  if (secret || !isLoopbackHttpUrl(baseUrl)) return slugToKeyEnv(id);
  return existing?.key_env_var ?? "";
}

/** `ok` = el proveedor se guardó (la key puede haber fallado: ver feedback). */
export interface SubmitOutcome {
  ok: boolean;
  errors: CustomProviderErrors;
}

export interface UseCustomProvidersResult {
  customs: RouterProviderRecord[];
  takenIds: ReadonlySet<string>;
  loading: boolean;
  loadError: string | null;
  busy: boolean;
  feedback: CustomFeedback | null;
  reload: () => Promise<void>;
  submit: (draft: CustomProviderDraft, defaultModel: string) => Promise<SubmitOutcome>;
  remove: (providerId: string) => Promise<void>;
}

export function useCustomProviders(): UseCustomProvidersResult {
  const [providers, setProviders] = useState<RouterProviderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<CustomFeedback | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await invoke<RouterProviderRecord[]>("ai_router_list_providers"));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const customs = useMemo(() => providers.filter((p) => p.custom === true), [providers]);
  const takenIds = useMemo(
    () => new Set(providers.filter((p) => p.custom !== true).map((p) => p.id)),
    [providers],
  );

  const submit = useCallback(
    async (draft: CustomProviderDraft, defaultModel: string): Promise<SubmitOutcome> => {
      const errors = validateCustomProvider(draft, takenIds);
      if (Object.keys(errors).length > 0) {
        setFeedback({ kind: "error", text: "Revisa los campos marcados." });
        return { ok: false, errors };
      }
      const id = draft.id.trim();
      const secret = draft.apiKey.trim();
      const envVar = keyEnvFor(id, draft.baseUrl, secret, customs.find((p) => p.id === id));
      const provider: CustomProviderInput = {
        id,
        name: draft.name.trim(),
        base_url: draft.baseUrl.trim().replace(/\/+$/, ""),
        api_format: draft.apiFormat as CustomApiFormat,
        key_env_var: envVar,
        ...(defaultModel.trim() ? { default_model: defaultModel.trim() } : {}),
      };
      setBusy(true);
      setFeedback(null);
      try {
        await invoke<RouterProviderRecord>("ai_router_upsert_custom_provider", { provider });
      } catch (e) {
        setFeedback({ kind: "error", text: `No se pudo guardar el proveedor: ${errorText(e)}` });
        setBusy(false);
        return { ok: false, errors: {} };
      }
      let text = `Proveedor «${id}» guardado.`;
      let kind: CustomFeedback["kind"] = "ok";
      if (!envVar) {
        text += " Servidor local sin key: las peticiones van sin autenticación.";
      } else if (secret) {
        try {
          const r = await invoke<EnvKeysSaveResult>("set_env_vars_keys", { keys: { [envVar]: secret } });
          const problem = keySaveProblem(envVar, r);
          if (problem) {
            kind = "warn";
            text += ` La key NO se guardó en ${envVar}: ${problem}.`;
          } else {
            text += ` Key guardada en ${envVar}.`;
          }
        } catch (e) {
          kind = "warn";
          text += ` La key NO se guardó en ${envVar}: ${errorText(e)}.`;
        }
      } else {
        kind = "warn";
        text += ` Sin key: el router leerá ${envVar}; guárdala aquí o con setx.`;
      }
      setFeedback({ kind, text });
      setBusy(false);
      await reload();
      return { ok: true, errors: {} };
    },
    [customs, reload, takenIds],
  );

  const remove = useCallback(
    async (providerId: string) => {
      const envVar =
        customs.find((p) => p.id === providerId)?.key_env_var || slugToKeyEnv(providerId);
      setBusy(true);
      try {
        await invoke("ai_router_remove_custom_provider", { providerId });
        setFeedback({
          kind: "ok",
          text: `Proveedor «${providerId}» quitado. La variable ${envVar} sigue en tu entorno de usuario: bórrala a mano si ya no la quieres.`,
        });
        await reload();
      } catch (e) {
        setFeedback({ kind: "error", text: `No se pudo quitar «${providerId}»: ${errorText(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [customs, reload],
  );

  return { customs, takenIds, loading, loadError, busy, feedback, reload, submit, remove };
}
