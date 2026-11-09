// ULTRON Control Center — AI Router: estado editable de la cadena de
// delegación. Lógica pura (sin invoke ni JSX): reducer inmutable sobre el
// borrador de DelegationConfig y validación previa a ai_router_set_delegation.

import {
  DELEGATION_RUNNERS,
  DELEGATION_TIERS,
  TIER_LABELS,
  type DelegationConfig,
  type DelegationEngine,
  type DelegationTier,
} from "./delegationTypes";

export interface DelegationEditState {
  /** Última configuración leída o guardada en el backend. */
  saved: DelegationConfig | null;
  /** Borrador en edición (null hasta la primera carga). */
  draft: DelegationConfig | null;
}

export type DelegationAction =
  | { type: "LOAD"; config: DelegationConfig }
  | { type: "MOVE"; engineId: string; delta: -1 | 1 }
  | { type: "TOGGLE_ENABLED"; engineId: string }
  | { type: "ADD_TO_CHAIN"; engineId: string }
  | { type: "REMOVE_FROM_CHAIN"; engineId: string }
  | { type: "SET_MODEL"; engineId: string; tier: DelegationTier | null; model: string }
  | { type: "SET_TIER_START"; tier: DelegationTier; engineId: string }
  | { type: "SET_RELAY_ON_CHECK_FAIL"; value: boolean }
  /** `null` quita el tope (el runner usa su valor por defecto). */
  | { type: "SET_MAX_BUDGET"; engineId: string; value: number | null }
  | { type: "RESET" };

export const INITIAL_DELEGATION_STATE: DelegationEditState = { saved: null, draft: null };

function moveItem(list: string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function setModel(
  config: DelegationConfig,
  engineId: string,
  tier: DelegationTier | null,
  model: string,
): DelegationConfig {
  const engine = config.engines[engineId];
  if (!engine) return config;
  if (tier === null) {
    return { ...config, engines: { ...config.engines, [engineId]: { ...engine, model } } };
  }
  const tierModels = { ...(engine.tierModels ?? {}) };
  if (model.trim() === "") delete tierModels[tier];
  else tierModels[tier] = model;
  const nextEngine: DelegationEngine = { ...engine, tierModels };
  if (Object.keys(tierModels).length === 0) delete nextEngine.tierModels;
  return { ...config, engines: { ...config.engines, [engineId]: nextEngine } };
}

function applyToDraft(config: DelegationConfig, action: DelegationAction): DelegationConfig {
  switch (action.type) {
    case "MOVE": {
      const chain = moveItem(config.chain, config.chain.indexOf(action.engineId), action.delta);
      return chain === config.chain ? config : { ...config, chain };
    }
    case "TOGGLE_ENABLED": {
      const engine = config.engines[action.engineId];
      if (!engine) return config;
      return {
        ...config,
        engines: { ...config.engines, [action.engineId]: { ...engine, enabled: !engine.enabled } },
      };
    }
    case "ADD_TO_CHAIN":
      if (config.chain.includes(action.engineId) || !config.engines[action.engineId]) return config;
      return { ...config, chain: [...config.chain, action.engineId] };
    case "REMOVE_FROM_CHAIN":
      return { ...config, chain: config.chain.filter((id) => id !== action.engineId) };
    case "SET_MODEL":
      return setModel(config, action.engineId, action.tier, action.model);
    case "SET_TIER_START":
      return { ...config, tiers: { ...config.tiers, [action.tier]: { start: action.engineId } } };
    case "SET_RELAY_ON_CHECK_FAIL":
      return { ...config, relayOnCheckFail: action.value };
    case "SET_MAX_BUDGET": {
      const engine = config.engines[action.engineId];
      if (!engine) return config;
      const next = { ...engine, maxBudgetUsd: action.value ?? undefined };
      if (action.value === null) delete next.maxBudgetUsd;
      return { ...config, engines: { ...config.engines, [action.engineId]: next } };
    }
    default:
      return config;
  }
}

export function delegationReducer(
  state: DelegationEditState,
  action: DelegationAction,
): DelegationEditState {
  if (action.type === "LOAD") {
    return { saved: action.config, draft: structuredClone(action.config) };
  }
  if (action.type === "RESET") {
    return { ...state, draft: state.saved ? structuredClone(state.saved) : null };
  }
  if (!state.draft) return state;
  const draft = applyToDraft(state.draft, action);
  return draft === state.draft ? state : { ...state, draft };
}

/** True si el borrador difiere de lo guardado. */
export function isDelegationDirty(state: DelegationEditState): boolean {
  if (!state.saved || !state.draft) return false;
  return JSON.stringify(state.saved) !== JSON.stringify(state.draft);
}

/** Motores definidos que no están en la cadena (se pueden añadir). */
export function enginesOutsideChain(config: DelegationConfig): string[] {
  return Object.keys(config.engines).filter((id) => !config.chain.includes(id));
}

export interface DelegationIssues {
  /** Bloquean el guardado: el backend también las rechazaría. */
  errors: string[];
  /** Se guardan, pero conviene saberlas (p. ej. nivel que entra por un motor apagado). */
  warnings: string[];
}

/** `maxBudgetUsd` solo vale para el runner claude y tiene que ser > 0. */
function budgetIssue(id: string, runner: string, budget: number | undefined): string | null {
  if (budget === undefined) return null;
  if (runner !== "claude") return `El motor «${id}» lleva maxBudgetUsd, que solo admite el runner claude.`;
  if (!Number.isFinite(budget) || budget <= 0) {
    return `El tope de gasto de «${id}» tiene que ser un número mayor que 0.`;
  }
  return null;
}

/** Lista blanca del modelo, igual que `is_safe_model` en delegation.rs: el
 *  valor acaba en una línea de shell de delegate.mjs. */
export const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,200}$/;

function modelIssue(id: string, label: string, model: string): string | null {
  if (model.trim() === "") return `El motor «${id}» no tiene ${label} (es obligatorio aunque esté desactivado).`;
  if (!MODEL_RE.test(model)) {
    return `El ${label} de «${id}» lleva caracteres no admitidos: solo letras, dígitos y . _ : / @ + -`;
  }
  return null;
}

/** Mismas reglas que `validate_engine` en el backend: modelo en TODO motor,
 *  activo o no, y los modelos por nivel con la misma lista blanca. */
function modelIssues(id: string, engine: DelegationEngine): string[] {
  const tierIssues = Object.entries(engine.tierModels ?? {}).map(([tier, model]) =>
    modelIssue(id, `modelo del nivel ${tier}`, model ?? ""),
  );
  return [modelIssue(id, "modelo", engine.model), ...tierIssues].filter((e): e is string => e !== null);
}

/** Valida ids, runners, tiers y modelos antes de llamar a ai_router_set_delegation. */
export function validateDelegationConfig(config: DelegationConfig): DelegationIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const id of config.chain) {
    if (seen.has(id)) errors.push(`El motor «${id}» aparece dos veces en la cadena.`);
    seen.add(id);
    if (!config.engines[id]) errors.push(`La cadena nombra «${id}», que no está definido en engines.`);
  }

  for (const [id, engine] of Object.entries(config.engines)) {
    if (!(DELEGATION_RUNNERS as readonly string[]).includes(engine.runner)) {
      errors.push(`El motor «${id}» tiene un runner no admitido: «${engine.runner}».`);
    }
    errors.push(...modelIssues(id, engine));
    const budgetError = budgetIssue(id, engine.runner, engine.maxBudgetUsd);
    if (budgetError) errors.push(budgetError);
  }

  const enabledInChain = config.chain.filter((id) => config.engines[id]?.enabled);
  if (enabledInChain.length === 0) {
    errors.push("No hay ningún motor activo en la cadena: toda tarea volvería a Opus.");
  }

  for (const tier of DELEGATION_TIERS) {
    const start = config.tiers[tier]?.start ?? "";
    const label = TIER_LABELS[tier];
    if (!config.chain.includes(start)) {
      errors.push(`El nivel ${label} entra por «${start || "(vacío)"}», que no está en la cadena.`);
    } else if (!config.engines[start]?.enabled) {
      warnings.push(`El nivel ${label} entra por «${start}», que está desactivado: empezará por el siguiente.`);
    }
  }

  return { errors, warnings };
}
