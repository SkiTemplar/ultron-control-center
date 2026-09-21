// P5 — Agent/Skill library client. Envuelve los comandos Tauri `library_*`
// y los de Destacados (`repos_*`).
//
// 2026-09-22: `librarySearchGitHub` se retiró con su comando de Rust. Lanzaba
// `gh search code` (ausente en esta máquina) y no tenía ni un llamador: el
// único sitio del código donde aparecía era su propia definición.

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentCreateInput,
  AnalyzeRepoResult,
  DetalleRepo,
  FuenteRepos,
  InstallInput,
  PinnedAgents,
  PlanAplicar,
  RespuestaBusqueda,
  ResultadoAplicar,
  SkillCreateInput,
} from "../types";

export function libraryInstallFromGitHub(args: InstallInput): Promise<string> {
  return invoke<string>("library_install_from_github", { args });
}

// ---------------------------------------------------------------------------
// Destacados
// ---------------------------------------------------------------------------

/**
 * Una fuente de repositorios. Nunca rechaza por cuota agotada: eso viaja
 * dentro de la respuesta (`cuota.agotada` + `avisos`) porque en la pantalla es
 * otro estado, no un fallo.
 *
 * `refrescar` salta la caché de disco, y es lo único que gasta cuota a
 * petición del usuario: sin token son 10 búsquedas por minuto para toda la
 * aplicación.
 */
export function reposBuscar(
  fuente: FuenteRepos,
  consulta: string | null,
  limite = 30,
  refrescar = false,
): Promise<RespuestaBusqueda> {
  return invoke<RespuestaBusqueda>("repos_buscar", {
    args: { fuente, consulta, limite, refrescar },
  });
}

/** Qué trae un repo, leyendo sólo la lista de rutas de su árbol. */
export function reposDetalle(
  owner: string,
  repo: string,
  refrescar = false,
): Promise<DetalleRepo> {
  return invoke<DetalleRepo>("repos_detalle", { owner, repo, refrescar });
}

/** Aplica un plan que el usuario ya ha visto en el manifiesto. */
export function reposAplicar(plan: PlanAplicar): Promise<ResultadoAplicar> {
  return invoke<ResultadoAplicar>("repos_aplicar", { plan });
}

/**
 * Scan a LOCAL repo on disk for skills/agents and run the same post-install
 * integration (sync-registry catalog refresh + governed memory candidate) as a
 * GitHub install. Read-only: copies nothing. Returns the assets it found plus
 * the integration report (registry synced, newly detected, memory candidate id).
 */
export function analyzeLocalRepo(path: string): Promise<AnalyzeRepoResult> {
  return invoke<AnalyzeRepoResult>("analyze_local_repo", { path });
}

export function agentCreate(args: AgentCreateInput): Promise<string> {
  return invoke<string>("agent_create", { args });
}

export function skillCreate(args: SkillCreateInput): Promise<string> {
  return invoke<string>("skill_create", { args });
}

export function libraryPinAgent(
  projectId: string,
  agentSlug: string,
): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_pin_agent", { projectId, agentSlug });
}

export function libraryUnpinAgent(
  projectId: string,
  agentSlug: string,
): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_unpin_agent", { projectId, agentSlug });
}

export function libraryListPinned(projectId: string): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_list_pinned", { projectId });
}
