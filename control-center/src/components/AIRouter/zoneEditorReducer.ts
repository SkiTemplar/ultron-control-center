// ULTRON Control Center — AI Router: Zone Editor reducer + tipos locales
//
// Extraído de ZoneEditor.tsx (cat7: mantener ficheros < 800 líneas). Lógica de
// estado pura + los tipos locales que comparten los sub-componentes del editor.

import type { Zone, ZoneAssignment } from "./types";

/** Estado de validación de key por provider (de ai_router_validate_keys). */
export interface KeyValidation {
  provider_id: string;
  provider_label: string;
  has_key: boolean;
  source: string;
  warning?: string | null;
}

/** Estado editable de una zona — copia inmutable para edición local. */
export interface ZoneEditState {
  /** Id de la zona que está en edición ahora mismo (null = ninguna). */
  editingId: string | null;
  /** Edits pendientes, indexadas por zone id. */
  drafts: Record<string, Zone>;
  /** Zonas que se están guardando ahora mismo. */
  saving: Set<string>;
  /** Resultado del último guardado: "ok" o mensaje de error. */
  saveResults: Record<string, "ok" | string>;
}

export type ZoneEditorAction =
  | { type: "SET_EDITING"; id: string | null }
  | { type: "UPDATE_PRIMARY"; zoneId: string; field: keyof ZoneAssignment; value: string | number }
  | { type: "UPDATE_FALLBACK"; zoneId: string; index: number; field: keyof ZoneAssignment; value: string | number }
  | { type: "ADD_FALLBACK"; zoneId: string; entry: ZoneAssignment }
  | { type: "REMOVE_FALLBACK"; zoneId: string; index: number }
  | { type: "RESET_DRAFT"; zoneId: string; original: Zone }
  | { type: "SET_SAVING"; zoneId: string; saving: boolean }
  | { type: "SET_SAVE_RESULT"; zoneId: string; result: "ok" | string };

export function editorReducer(state: ZoneEditState, action: ZoneEditorAction): ZoneEditState {
  switch (action.type) {
    case "SET_EDITING":
      return { ...state, editingId: action.id };

    case "UPDATE_PRIMARY": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            primary: { ...draft.primary, [action.field]: action.value },
          },
        },
      };
    }

    case "UPDATE_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      const newFallbacks = draft.fallbacks.map((fb, i) =>
        i === action.index ? { ...fb, [action.field]: action.value } : fb,
      );
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: { ...draft, fallbacks: newFallbacks },
        },
      };
    }

    case "ADD_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            fallbacks: [...draft.fallbacks, action.entry],
          },
        },
      };
    }

    case "REMOVE_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            fallbacks: draft.fallbacks.filter((_, i) => i !== action.index),
          },
        },
      };
    }

    case "RESET_DRAFT":
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: structuredClone(action.original),
        },
        saveResults: { ...state.saveResults, [action.zoneId]: undefined as unknown as string },
      };

    case "SET_SAVING": {
      const next = new Set(state.saving);
      if (action.saving) {
        next.add(action.zoneId);
      } else {
        next.delete(action.zoneId);
      }
      return { ...state, saving: next };
    }

    case "SET_SAVE_RESULT":
      return {
        ...state,
        saveResults: { ...state.saveResults, [action.zoneId]: action.result },
      };

    default:
      return state;
  }
}
