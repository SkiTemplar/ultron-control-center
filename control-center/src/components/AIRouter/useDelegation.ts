// ULTRON Control Center — AI Router: estado e invoke del panel de delegación.
//
// Comandos Tauri (contrato plans/2026-10-26, §4):
//   ai_router_get_delegation     — lee cockpit/ai-router/delegation.json
//   ai_router_set_delegation     — valida y guarda (escritura atómica)
//   ai_router_delegation_status  — node scripts/delegate.mjs status --json
//   ai_router_delegation_ledger  — últimas líneas de cockpit/delegations.jsonl

import { useCallback, useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  INITIAL_DELEGATION_STATE,
  delegationReducer,
  isDelegationDirty,
  validateDelegationConfig,
  type DelegationAction,
  type DelegationEditState,
} from "./delegationReducer";
import type { DelegationConfig, DelegationStatus, LedgerEntry } from "./delegationTypes";

export const LEDGER_LIMIT = 50;

export interface SaveFeedback {
  kind: "ok" | "error";
  messages: string[];
}

interface AsyncSlot<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_SLOT = { data: null, loading: false, error: null };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UseDelegationResult {
  edit: DelegationEditState;
  dispatch: (action: DelegationAction) => void;
  dirty: boolean;
  configLoading: boolean;
  configError: string | null;
  saving: boolean;
  saveFeedback: SaveFeedback | null;
  status: AsyncSlot<DelegationStatus>;
  ledger: AsyncSlot<LedgerEntry[]>;
  reloadConfig: () => Promise<void>;
  save: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshLedger: () => Promise<void>;
}

export function useDelegation(): UseDelegationResult {
  const [edit, dispatch] = useReducer(delegationReducer, INITIAL_DELEGATION_STATE);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [status, setStatus] = useState<AsyncSlot<DelegationStatus>>(EMPTY_SLOT);
  const [ledger, setLedger] = useState<AsyncSlot<LedgerEntry[]>>(EMPTY_SLOT);

  const reloadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const config = await invoke<DelegationConfig>("ai_router_get_delegation");
      dispatch({ type: "LOAD", config });
      setConfigError(null);
    } catch (e) {
      setConfigError(errorText(e));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatus((prev) => ({ ...prev, loading: true }));
    try {
      const data = await invoke<DelegationStatus>("ai_router_delegation_status");
      setStatus({ data, loading: false, error: null });
    } catch (e) {
      setStatus((prev) => ({ ...prev, loading: false, error: errorText(e) }));
    }
  }, []);

  const refreshLedger = useCallback(async () => {
    setLedger((prev) => ({ ...prev, loading: true }));
    try {
      const data = await invoke<LedgerEntry[]>("ai_router_delegation_ledger", { limit: LEDGER_LIMIT });
      setLedger({ data, loading: false, error: null });
    } catch (e) {
      setLedger((prev) => ({ ...prev, loading: false, error: errorText(e) }));
    }
  }, []);

  useEffect(() => {
    void reloadConfig();
    void refreshStatus();
    void refreshLedger();
  }, [reloadConfig, refreshStatus, refreshLedger]);

  const dirty = isDelegationDirty(edit);

  const save = useCallback(async () => {
    const draft = edit.draft;
    if (!draft) {
      setSaveFeedback({ kind: "error", messages: ["No hay configuración cargada que guardar."] });
      return;
    }
    if (!dirty) {
      setSaveFeedback({ kind: "error", messages: ["No hay cambios que guardar."] });
      return;
    }
    const { errors, warnings } = validateDelegationConfig(draft);
    if (errors.length > 0) {
      setSaveFeedback({ kind: "error", messages: errors });
      return;
    }
    setSaving(true);
    try {
      await invoke("ai_router_set_delegation", { config: draft });
      dispatch({ type: "LOAD", config: draft });
      setSaveFeedback({ kind: "ok", messages: ["Cadena guardada.", ...warnings] });
      void refreshStatus();
    } catch (e) {
      setSaveFeedback({ kind: "error", messages: [errorText(e)] });
    } finally {
      setSaving(false);
    }
  }, [edit.draft, dirty, refreshStatus]);

  const dispatchAndClear = useCallback((action: DelegationAction) => {
    setSaveFeedback(null);
    dispatch(action);
  }, []);

  return {
    edit,
    dispatch: dispatchAndClear,
    dirty,
    configLoading,
    configError,
    saving,
    saveFeedback,
    status,
    ledger,
    reloadConfig,
    save,
    refreshStatus,
    refreshLedger,
  };
}
