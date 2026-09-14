// Wrappers tipados del comando Tauri `project_create_cli`, que a su vez
// lanza `~/.ultron/scripts/project-create.mjs <subcomando> --json`.
//
// Contrato del script (fuente de verdad: el otro agente que lo escribe en
// paralelo — este fichero programa contra el contrato, no contra su
// implementacion):
//   roots                                            -> { roots }
//   list --root <id> [--sub <relPath>]               -> { root, sub, entries }
//   templates [--kind asignatura|personal]           -> { templates }
//   subject new --root <id> --code <C> --name <N>    -> { subjectPath, projectId }
//   mkdir --root <id> --sub <relPath> --name <n>      -> { path }
//   create --root <id> --sub <relPath> --name <N>
//          --template <id> [--no-git] [--no-claude-md]
//          [--tags a,b] [--due YYYY-MM-DD] [--dry-run] -> { projectPath, projectId,
//                                                            template, steps, filesCreated }
// Error uniforme: { ok:false, error:{ code, message } } (mas `steps` en el
// fallo parcial de `create`, código `STEP_FAILED`).

import { invoke } from "@tauri-apps/api/core";

export type RootKind = "asignatura" | "personal";

export interface CliRoot {
  id: string;
  label: string;
  path: string;
  kind: RootKind;
  exists: boolean;
}

export interface CliEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  isProject: boolean;
  isSubject: boolean;
}

export interface CliTemplate {
  id: string;
  label: string;
  description: string;
  source: "local" | "generator";
  requires: string[];
  available: boolean;
  kinds: string[];
}

export interface CliStep {
  step: string;
  ok: boolean;
  message: string;
}

export interface CliError {
  code: string;
  message: string;
}

/** Forma comun de todas las respuestas del CLI: exito con el payload propio
 * de cada subcomando, o error con `code`/`message` (y `steps`, solo en el
 * fallo parcial de `create`). */
export type CliResult<T> = ({ ok: true } & T) | { ok: false; error: CliError; steps?: CliStep[] };

export interface RootsData {
  roots: CliRoot[];
}

export interface ListData {
  root: string;
  sub: string;
  entries: CliEntry[];
}

export interface TemplatesData {
  templates: CliTemplate[];
}

export interface SubjectNewData {
  subjectPath: string;
  projectId: string;
}

export interface MkdirData {
  path: string;
}

export interface CreateData {
  projectPath: string;
  projectId: string;
  template: string;
  steps: CliStep[];
  filesCreated: string[];
}

/**
 * Invoca `project_create_cli` y normaliza CUALQUIER fallo (proceso que no
 * arranca, node ausente, timeout, stdout no-JSON) al mismo sobre
 * `{ ok:false, error }` que ya usa el propio script para sus errores
 * esperables — así el llamador solo mira un shape, nunca un catch aparte.
 */
async function callCli<T>(args: string[]): Promise<CliResult<T>> {
  try {
    const raw = await invoke("project_create_cli", { args });
    return raw as CliResult<T>;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { code: "CLI_ERROR", message } };
  }
}

export function cliRoots(): Promise<CliResult<RootsData>> {
  return callCli<RootsData>(["roots"]);
}

export function cliList(root: string, sub?: string): Promise<CliResult<ListData>> {
  const args = ["list", "--root", root];
  if (sub) args.push("--sub", sub);
  return callCli<ListData>(args);
}

export function cliTemplates(kind?: RootKind): Promise<CliResult<TemplatesData>> {
  const args = ["templates"];
  if (kind) args.push("--kind", kind);
  return callCli<TemplatesData>(args);
}

export function cliSubjectNew(
  root: string,
  code: string,
  name: string,
): Promise<CliResult<SubjectNewData>> {
  return callCli<SubjectNewData>([
    "subject", "new",
    "--root", root,
    "--code", code,
    "--name", name,
  ]);
}

export function cliMkdir(root: string, sub: string, name: string): Promise<CliResult<MkdirData>> {
  return callCli<MkdirData>(["mkdir", "--root", root, "--sub", sub, "--name", name]);
}

export interface CreateOptions {
  root: string;
  sub: string;
  name: string;
  template: string;
  /** default true en el backend — solo se manda `--no-git` cuando es false */
  git?: boolean;
  /** default true en el backend — solo se manda `--no-claude-md` cuando es false */
  claudeMd?: boolean;
  due?: string;
  dryRun?: boolean;
}

export function cliCreate(opts: CreateOptions): Promise<CliResult<CreateData>> {
  const args = [
    "create",
    "--root", opts.root,
    "--sub", opts.sub,
    "--name", opts.name,
    "--template", opts.template,
  ];
  if (opts.git === false) args.push("--no-git");
  if (opts.claudeMd === false) args.push("--no-claude-md");
  if (opts.due) args.push("--due", opts.due);
  if (opts.dryRun) args.push("--dry-run");
  return callCli<CreateData>(args);
}

/** Quita el prefijo del root de una ruta absoluta devuelta por el CLI
 * (p.ej. `subjectPath`) y la deja como `relPath` relativo, apto para
 * `--sub` en llamadas posteriores. */
export function relPathFromRoot(root: CliRoot, absolutePath: string): string {
  const rootPath = root.path.replace(/[\\/]+$/, "");
  let rel = absolutePath.startsWith(rootPath) ? absolutePath.slice(rootPath.length) : absolutePath;
  rel = rel.replace(/^[\\/]+/, "");
  return rel;
}
