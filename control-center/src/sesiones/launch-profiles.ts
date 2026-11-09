// Perfiles de lanzamiento de «+ Claude» (por equipo, en localStorage): modelo,
// effort, modo de permisos y carpeta con los que arranca una sesión nueva. Lo
// que un perfil no fija lo decide Ajustes → Sesiones nuevas. «Normal» no fija
// nada, va siempre el primero y no se puede editar ni borrar. Se recuerda el
// último perfil usado para proponerlo al abrir el desplegable.

import { useSyncExternalStore } from "react";
import { newSessionInCwd, newSessionInProject, newSessionLike, resumeSession, type NewSessionOverrides } from "./actions";
import type { SesionesApi } from "./api";
import { EFFORTS, NEW_SESSION_MODELS } from "./prefs";
import { createStore } from "./store";
import type { Effort, PastSession, PermissionMode, SessionId } from "./types";

export type ProfileModel = (typeof NEW_SESSION_MODELS)[number];

export interface LaunchProfile {
  id: string;
  name: string;
  model?: ProfileModel;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** Carpeta de trabajo absoluta; sustituye a la del proyecto elegido. */
  cwd?: string;
}

export interface ProfilesState {
  /** «Normal» siempre en la posición 0. */
  profiles: readonly LaunchProfile[];
  lastUsed: string;
}

export const NORMAL_ID = "normal";
export const NORMAL_PROFILE: LaunchProfile = { id: NORMAL_ID, name: "Normal" };
export const STORAGE_KEY = "ultron.sesiones.launchProfiles";
export const NAME_MAX = 40;
const CWD_MAX = 1024;

/** Todos los modos de Claude Code; el `Record` obliga a añadir aquí uno nuevo del tipo. */
const MODES: Record<PermissionMode, true> = { default: true, acceptEdits: true, plan: true, auto: true, dontAsk: true, bypassPermissions: true };
export const PROFILE_MODES = Object.keys(MODES) as PermissionMode[];

const DEFAULT_STATE: ProfilesState = { profiles: [NORMAL_PROFILE], lastUsed: NORMAL_ID };

const isModel = (v: unknown): v is ProfileModel => NEW_SESSION_MODELS.includes(v as ProfileModel);
const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);
const isMode = (v: unknown): v is PermissionMode => typeof v === "string" && Object.prototype.hasOwnProperty.call(MODES, v);
/** Unidad de Windows, ruta UNC o raíz POSIX. */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/;
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32);

/** Motivo por el que `cwd` no vale, o null. */
export function cwdProblem(cwd: string): string | null {
  if (!ABSOLUTE.test(cwd)) return "La carpeta tiene que ser una ruta absoluta (p. ej. C:\\proyectos\\web).";
  if (cwd.length > CWD_MAX || hasControl(cwd)) return "La carpeta contiene caracteres no válidos o es demasiado larga.";
  return null;
}

function nameProblem(name: string): string | null {
  if (!name) return "El perfil necesita un nombre.";
  if (name.length > NAME_MAX) return `El nombre admite como mucho ${NAME_MAX} caracteres.`;
  if (hasControl(name)) return "El nombre contiene caracteres no válidos.";
  return null;
}

/** Perfil leído del almacenamiento; null si algún campo no es válido (no se arranca con un perfil a medias). */
export function sanitizeProfile(raw: unknown): LaunchProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id === NORMAL_ID || r.id.length > 80) return null;
  if (typeof r.name !== "string" || nameProblem(r.name.trim())) return null;
  if (r.model !== undefined && !isModel(r.model)) return null;
  if (r.effort !== undefined && !isEffort(r.effort)) return null;
  if (r.permissionMode !== undefined && !isMode(r.permissionMode)) return null;
  if (r.cwd !== undefined && (typeof r.cwd !== "string" || cwdProblem(r.cwd))) return null;
  return {
    id: r.id,
    name: r.name.trim(),
    ...(r.model !== undefined ? { model: r.model as ProfileModel } : {}),
    ...(r.effort !== undefined ? { effort: r.effort as Effort } : {}),
    ...(r.permissionMode !== undefined ? { permissionMode: r.permissionMode as PermissionMode } : {}),
    ...(r.cwd !== undefined ? { cwd: r.cwd as string } : {}),
  };
}

/** Estado a partir de lo guardado: entradas corruptas o repetidas fuera, «Normal» delante. */
export function parseProfiles(raw: unknown): ProfilesState {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(r.profiles) ? r.profiles : [];
  const seen = new Set<string>([NORMAL_ID]);
  const profiles: LaunchProfile[] = [NORMAL_PROFILE];
  for (const item of list) {
    const p = sanitizeProfile(item);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    profiles.push(p);
  }
  const lastUsed = typeof r.lastUsed === "string" && seen.has(r.lastUsed) ? r.lastUsed : NORMAL_ID;
  return { profiles, lastUsed };
}

function load(): ProfilesState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return parseProfiles(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_STATE;
  }
}

export const profilesStore = createStore<ProfilesState, (s: ProfilesState) => ProfilesState>((s, fn) => fn(s), load());

/** Escribe el estado; `false` si no hay almacenamiento (los perfiles duran lo que la ventana). */
function persist(): boolean {
  const { profiles, lastUsed } = profilesStore.getState();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ profiles: profiles.slice(1), lastUsed }));
    return true;
  } catch {
    return false;
  }
}

/** Relee el almacenamiento (otra ventana de Sessions los cambió, o un test). */
export function reloadProfiles(): void {
  const next = load();
  profilesStore.dispatch(() => next);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) reloadProfiles();
  });
}

export function useLaunchProfiles(): ProfilesState {
  return useSyncExternalStore(profilesStore.subscribe, profilesStore.getState);
}

/** Perfil por id; uno que ya no existe (borrado) cae en «Normal». */
export function resolveProfile(state: ProfilesState, id: string | null | undefined): LaunchProfile {
  return state.profiles.find((p) => p.id === id) ?? NORMAL_PROFILE;
}

export const lastUsedProfile = (state: ProfilesState = profilesStore.getState()): LaunchProfile => resolveProfile(state, state.lastUsed);

export type ProfileResult = { ok: true; profile: LaunchProfile; persisted: boolean } | { ok: false; error: string };

/** Borrador del diálogo: campos vacíos = «como en Ajustes». */
export interface ProfileDraft {
  id?: string;
  name: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  cwd?: string | null;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `p-${crypto.randomUUID()}`;
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Valida el borrador y lo convierte en perfil; nunca guarda valores fuera de las listas. */
export function validateDraft(state: ProfilesState, draft: ProfileDraft): { ok: true; profile: LaunchProfile } | { ok: false; error: string } {
  if (draft.id === NORMAL_ID) return { ok: false, error: "«Normal» no se puede editar: duplícalo para crear uno propio." };
  const name = draft.name.trim();
  const bad = nameProblem(name);
  if (bad) return { ok: false, error: bad };
  const clash = state.profiles.find((p) => p.id !== draft.id && p.name.localeCompare(name, "es", { sensitivity: "base" }) === 0);
  if (clash) return { ok: false, error: `Ya hay un perfil llamado «${clash.name}».` };
  if (draft.model && !isModel(draft.model)) return { ok: false, error: `Modelo no admitido: ${draft.model}.` };
  if (draft.effort && !isEffort(draft.effort)) return { ok: false, error: `Effort no admitido: ${draft.effort}.` };
  if (draft.permissionMode && !isMode(draft.permissionMode)) return { ok: false, error: `Modo de permisos no admitido: ${draft.permissionMode}.` };
  const cwd = draft.cwd?.trim() ?? "";
  const cwdBad = cwd ? cwdProblem(cwd) : null;
  if (cwdBad) return { ok: false, error: cwdBad };
  return {
    ok: true,
    profile: {
      id: draft.id ?? newId(),
      name,
      ...(draft.model ? { model: draft.model as ProfileModel } : {}),
      ...(draft.effort ? { effort: draft.effort as Effort } : {}),
      ...(draft.permissionMode ? { permissionMode: draft.permissionMode as PermissionMode } : {}),
      ...(cwd ? { cwd } : {}),
    },
  };
}

/** Crea (sin `id`) o sustituye un perfil. */
export function saveProfile(draft: ProfileDraft): ProfileResult {
  const state = profilesStore.getState();
  if (draft.id && draft.id !== NORMAL_ID && !state.profiles.some((p) => p.id === draft.id)) {
    return { ok: false, error: "El perfil ya no existe (¿lo borraste en otra ventana?)." };
  }
  const v = validateDraft(state, draft);
  if (!v.ok) return v;
  profilesStore.dispatch((s) => ({
    ...s,
    profiles: s.profiles.some((p) => p.id === v.profile.id)
      ? s.profiles.map((p) => (p.id === v.profile.id ? v.profile : p))
      : [...s.profiles, v.profile],
  }));
  return { ok: true, profile: v.profile, persisted: persist() };
}

/** Primer nombre libre del tipo «X (copia)», «X (copia 2)»… dentro del límite. */
function copyName(state: ProfilesState, base: string): string {
  const taken = (n: string) => state.profiles.some((p) => p.name.localeCompare(n, "es", { sensitivity: "base" }) === 0);
  for (let i = 1; ; i += 1) {
    const suffix = i === 1 ? " (copia)" : ` (copia ${i})`;
    const name = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken(name)) return name;
  }
}

export function duplicateProfile(id: string): ProfileResult {
  const state = profilesStore.getState();
  const src = state.profiles.find((p) => p.id === id);
  if (!src) return { ok: false, error: "El perfil ya no existe." };
  const { name, ...fields } = src;
  return saveProfile({ ...fields, id: undefined, name: copyName(state, name) });
}

export function deleteProfile(id: string): { ok: true; persisted: boolean } | { ok: false; error: string } {
  if (id === NORMAL_ID) return { ok: false, error: "«Normal» no se puede borrar." };
  if (!profilesStore.getState().profiles.some((p) => p.id === id)) return { ok: false, error: "El perfil ya no existe." };
  profilesStore.dispatch((s) => ({
    profiles: s.profiles.filter((p) => p.id !== id),
    lastUsed: s.lastUsed === id ? NORMAL_ID : s.lastUsed,
  }));
  return { ok: true, persisted: persist() };
}

/** Recuerda el perfil con el que se lanzó la última sesión (uno inexistente → «Normal»). */
export function markProfileUsed(id: string): void {
  const state = profilesStore.getState();
  const next = resolveProfile(state, id).id;
  if (next === state.lastUsed) return;
  profilesStore.dispatch((s) => ({ ...s, lastUsed: next }));
  persist();
}

/**
 * Lo que el perfil sustituye en `sesiones_create`. Al retomar una conversación
 * se omite la carpeta: el transcript vive bajo la del proyecto original y en otra
 * carpeta Claude Code no lo encontraría.
 */
export function profileOverrides(profile: LaunchProfile, opts: { resume?: boolean } = {}): NewSessionOverrides {
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    ...(profile.permissionMode ? { permissionMode: profile.permissionMode } : {}),
    ...(profile.cwd && !opts.resume ? { cwd: profile.cwd } : {}),
  };
}

export type LaunchTarget =
  | { kind: "here"; focusedId: SessionId | null }
  | { kind: "project"; projectId: string }
  | { kind: "resume"; past: PastSession }
  /** Carpeta pedida desde fuera (`--sesiones-cwd`): manda sobre la del perfil. */
  | { kind: "cwd"; cwd: string };

/**
 * Lanza con el perfil (y el modo de permisos elegido en el desplegable, que manda
 * sobre el del perfil) y lo recuerda como último usado. Los errores del backend
 * (carpeta inexistente, valor rechazado) los muestra `createSession`.
 */
export async function launchWithProfile(
  api: SesionesApi,
  target: LaunchTarget,
  profile: LaunchProfile,
  permissionMode?: PermissionMode | null,
): Promise<void> {
  markProfileUsed(profile.id);
  const overrides: NewSessionOverrides = {
    ...profileOverrides(profile, { resume: target.kind === "resume" }),
    ...(permissionMode ? { permissionMode } : {}),
  };
  if (target.kind === "here") return newSessionLike(api, target.focusedId, overrides);
  if (target.kind === "resume") return resumeSession(api, target.past, overrides);
  if (target.kind === "cwd") return newSessionInCwd(api, target.cwd, overrides);
  return newSessionInProject(api, target.projectId, overrides);
}

/**
 * Sesión nueva «aquí» (Ctrl+T, «+» de las pestañas y «Nueva sesión» del panel libre)
 * con el último perfil usado, el mismo que propone el desplegable de «+ Claude».
 * Sin esto el atajo anunciado como «Aquí · Ctrl+T» ignoraba perfil y modo.
 */
export function newSessionHere(api: SesionesApi, focusedId: SessionId | null): Promise<void> {
  return launchWithProfile(api, { kind: "here", focusedId }, lastUsedProfile());
}

/** Perfil por nombre, sin distinguir mayúsculas ni tildes; null si no existe. */
export function findProfileByName(name: string, state: ProfilesState = profilesStore.getState()): LaunchProfile | null {
  const wanted = name.trim();
  return state.profiles.find((p) => p.name.localeCompare(wanted, "es", { sensitivity: "base" }) === 0) ?? null;
}

/** Texto de ayuda de los botones de sesión nueva: dice con qué perfil arrancan. */
export function newSessionTitle(profile: LaunchProfile = lastUsedProfile()): string {
  return profile.id === NORMAL_ID ? "Sesión nueva (Ctrl+T)" : `Sesión nueva con el perfil «${profile.name}» (Ctrl+T)`;
}
