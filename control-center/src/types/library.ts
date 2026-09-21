// ---------------------------------------------------------------------------
// Library (P5): agent/skill discovery + install + pinning.
// ---------------------------------------------------------------------------

export type LibraryKind = "agent" | "skill";

export type TargetScope = "global" | "project";

export type RemoteItem = {
  owner: string;
  repo: string;
  path: string;
  name: string;
  html_url: string | null;
  preview: string | null;
};

export type PinnedAgents = {
  pinned: string[];
};

export type AgentCreateInput = {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

export type SkillCreateInput = {
  name: string;
  description: string;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

export type InstallInput = {
  owner: string;
  repo: string;
  path: string;
  kind: LibraryKind;
  target_scope: TargetScope;
  target_project_id: string | null;
  target_name: string | null;
  overwrite: boolean;
};

// Post-install integration outcome — mirrors
// `crate::commands::library::post_install::PostInstallReport`.
// Returned by `analyze_local_repo` (and produced internally on every install)
// so the UI can show "catalog synced + N detected + memory proposed".
export type PostInstallReport = {
  /** True when sync-registry.js ran and exited 0. */
  registry_synced: boolean;
  /** Raw JSON summary line from sync-registry, when available. */
  registry_summary: string | null;
  /** New skills/agents discovered on disk and added to the registry. */
  newly_detected: number;
  /** Memory inbox candidate id awaiting approval, if any. */
  memory_candidate_id: string | null;
  /** Non-fatal notes (missing node, dispatcher error, DB closed, …). */
  warnings: string[];
};

// Result of scanning a local repo — mirrors
// `crate::commands::library::post_install::AnalyzeRepoResult`.
export type AnalyzeRepoResult = {
  /** Absolute path that was scanned. */
  repo_path: string;
  /** Skill/agent slugs discovered on disk. */
  assets: string[];
  /** Catalog-sync + memory-capture outcome. */
  integration: PostInstallReport;
};

// ---------------------------------------------------------------------------
// Destacados (2026-09-22) — espejo de `crate::maria::repos`.
// ---------------------------------------------------------------------------

/** Una tarjeta de repositorio. `topics` ya llega de verdad: la API REST lo
 *  devuelve, y la CLI `gh` que había antes lo había dejado caer. */
export type RepoHit = {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  html_url: string | null;
  updated_at: string | null;
  topics: string[];
  created_at: string | null;
  pushed_at: string | null;
  license: string | null;
  stars_per_day: number | null;
};

/** De dónde salen las tarjetas. Agrupar por fuente y no por topic de GitHub
 *  es deliberado: `claude-agents` tiene 130 repos en todo GitHub. */
export type FuenteRepos =
  | "oficiales"
  | "en_alza"
  | "mejor_valorados"
  | "skills"
  | "agentes"
  | "mcps"
  | "libre";

/** Lo que queda de la cuota de GitHub. Sin token son 10 búsquedas por minuto
 *  para TODA la aplicación, así que esto se pinta antes de quedarse seco. */
export type EstadoCuota = {
  recurso: string;
  limite: number | null;
  restantes: number | null;
  reinicio_epoch: number | null;
  con_token: boolean;
  agotada: boolean;
};

export type RespuestaBusqueda = {
  fuente: string;
  hits: RepoHit[];
  consulta: string;
  parcial: boolean;
  avisos: string[];
  cuota: EstadoCuota;
  desde_cache: boolean;
};

export type TipoRepo =
  | "marketplace"
  | "skill"
  | "agente"
  | "mcp"
  | "hook"
  | "proyecto";

export type Severidad = "bloquea" | "mira";

export type AvisoRepo = {
  severidad: Severidad;
  regla: string;
  detalle: string;
};

export type FicheroPlan = {
  origen: string;
  destino_rel: string;
  tamano: number | null;
};

/** Lo que se escribiría para UNA skill o UN agente concreto. Va uno por
 *  asset porque el caso normal es un repo con varias skills. */
export type Manifiesto = {
  asset: string;
  tipo: TipoRepo;
  ficheros: FicheroPlan[];
};

/** Lo que trae un repo y lo que costaría aplicarlo. Los manifiestos SON lo
 *  que el usuario ve antes de pulsar Aplicar. */
export type DetalleRepo = {
  owner: string;
  repo: string;
  sha: string;
  rama: string;
  tipos: TipoRepo[];
  resumen: string;
  skills: string[];
  agentes: string[];
  manifiestos: Manifiesto[];
  truncado: boolean;
  rutas_rechazadas: number;
  avisos: AvisoRepo[];
  hit: RepoHit;
};

export type PlanAplicar = {
  owner: string;
  repo: string;
  sha: string;
  tipo: TipoRepo;
  nombre: string;
  ficheros: FicheroPlan[];
  destino: TargetScope;
  project_id: string | null;
  overwrite: boolean;
};

export type ResultadoAplicar = {
  ok: boolean;
  que_paso: string;
  escritos: string[];
  comando_sugerido: string | null;
  diff_propuesto: string | null;
  avisos: AvisoRepo[];
  assets: string[];
};
