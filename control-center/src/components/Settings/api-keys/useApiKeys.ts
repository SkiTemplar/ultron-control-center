// Settings/api-keys/useApiKeys.ts — estado y llamadas invoke de la seccion.
// Sin JSX: toda la logica de guardar/validar/cargar vive aqui para que
// ApiKeysSection.tsx quede como pura composicion visual.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EMAIL_ENV_VARS, PROVIDER_KEYS, RESEARCH_KEYS } from "./key-catalog";
import { isPlausibleEmail } from "./validation";
import type {
  EnvKeysSaveResult,
  EnvKeyStatus,
  FieldState,
  KeyValidation,
} from "./types";

export interface UseApiKeysResult {
  fields: Record<string, FieldState>;
  statuses: Record<string, EnvKeyStatus>;
  saving: boolean;
  result: EnvKeysSaveResult | null;
  error: string | null;
  validations: KeyValidation[] | null;
  validating: boolean;
  savedCount: number;
  errorCount: number;
  handleChange: (envVar: string, value: string) => void;
  toggleVisible: (envVar: string) => void;
  handleSave: () => Promise<void>;
  handleValidate: () => Promise<void>;
}

export function useApiKeys(): UseApiKeysResult {
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      [...PROVIDER_KEYS, ...RESEARCH_KEYS].map((p) => [
        p.envVar,
        { value: "", visible: false },
      ]),
    ),
  );

  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<EnvKeysSaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EnvKeyStatus>>({});
  // cat14.5: validacion real de keys/CLIs del router contra los providers
  // configurados (no contra la lista estatica de campos de esta seccion).
  const [validations, setValidations] = useState<KeyValidation[] | null>(null);
  const [validating, setValidating] = useState(false);

  const handleValidate = useCallback(async () => {
    setValidating(true);
    setError(null);
    try {
      const rows = await invoke<KeyValidation[]>("ai_router_validate_keys");
      setValidations(rows);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    try {
      const rows = await invoke<EnvKeyStatus[]>("get_env_keys_status");
      setStatuses(Object.fromEntries(rows.map((r) => [r.env_var, r])));
    } catch {
      // Best-effort: si falla, simplemente no mostramos los badges.
    }
  }, []);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const handleChange = useCallback((envVar: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      [envVar]: { ...prev[envVar], value },
    }));
    // Clear stale result when the user starts editing again.
    setResult(null);
    setError(null);
  }, []);

  const toggleVisible = useCallback((envVar: string) => {
    setFields((prev) => ({
      ...prev,
      [envVar]: { ...prev[envVar], visible: !prev[envVar].visible },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setResult(null);
    setError(null);

    // Only send keys that have a non-empty value. Email fields (OPENALEX_MAILTO,
    // UNPAYWALL_EMAIL) get a client-side format check first — the backend
    // repeats it (env_keys.rs::is_valid_email) and skips silently, but failing
    // fast here means the user finds out WHY the field didn't save.
    const payload: Record<string, string> = {};
    const badEmails: string[] = [];
    for (const [envVar, state] of Object.entries(fields)) {
      const trimmed = state.value.trim();
      if (!trimmed) continue;
      if (EMAIL_ENV_VARS.has(envVar) && !isPlausibleEmail(trimmed)) {
        badEmails.push(envVar);
        continue;
      }
      payload[envVar] = trimmed;
    }

    if (Object.keys(payload).length === 0) {
      setError(
        badEmails.length > 0
          ? `Formato de email inválido: ${badEmails.join(", ")}.`
          : "No hay valores para guardar. Rellena al menos una key.",
      );
      setSaving(false);
      return;
    }
    if (badEmails.length > 0) {
      setError(`Formato de email inválido, no se guardó: ${badEmails.join(", ")}.`);
    }

    try {
      const r = await invoke<EnvKeysSaveResult>("set_env_vars_keys", {
        keys: payload,
      });
      setResult(r);
      // Refrescar el estado para que los badges reflejen lo recién guardado.
      void loadStatuses();
      // Clear fields that were saved successfully so they don't linger.
      setFields((prev) => {
        const next = { ...prev };
        for (const envVar of r.saved) {
          if (next[envVar]) {
            next[envVar] = { ...next[envVar], value: "" };
          }
        }
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [fields, loadStatuses]);

  const savedCount = result?.saved.length ?? 0;
  const errorCount = Object.keys(result?.errors ?? {}).length;

  return {
    fields,
    statuses,
    saving,
    result,
    error,
    validations,
    validating,
    savedCount,
    errorCount,
    handleChange,
    toggleVisible,
    handleSave,
    handleValidate,
  };
}
