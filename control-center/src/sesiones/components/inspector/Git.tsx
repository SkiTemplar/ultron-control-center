// Git del proyecto de la sesión: ficheros cambiados en árbol plegable, diff
// por fichero y commit.
// Reutiliza git_repo_snapshot, git_diff_file, git_commit y git_log_full.

import { useEffect, useMemo, useState } from "react";
import { useApi } from "../../context";
import { useGit } from "../../hooks/useGit";
import type { GitCommitInfo, GitFileChange } from "../../types";
import { IconChevron, IconChevronDown, IconRefresh } from "../icons";
import { allDirPaths, buildGitTree, type GitTreeNode } from "./git-tree";
import { NoSession } from "./Inspector";

function statusChar(c: GitFileChange): string {
  if (c.untracked) return "U";
  const s = (c.staged ? c.index_status : c.worktree_status).trim();
  return s || c.index_status.trim() || "M";
}

/** Con más cambios que esto, el árbol arranca plegado. */
const OPEN_UP_TO = 20;

interface TreeProps {
  nodes: GitTreeNode[];
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selected: GitFileChange | null;
  onSelect: (c: GitFileChange) => void;
}

function FileTree({ nodes, open, onToggle, selected, onSelect }: TreeProps) {
  return (
    <div className="gtree" role="group">
      {nodes.map((n) => {
        if (n.kind === "file") {
          const c = n.change;
          return (
            <button key={c.path} className="file" aria-current={selected?.path === c.path} onClick={() => onSelect(c)} title={c.path}>
              <span className={`st ${statusChar(c)}`}>{statusChar(c)}</span>
              <span className="p">{n.name}</span>
              {c.staged || c.untracked ? <span className="badge">{c.staged ? "preparado" : "nuevo"}</span> : <span />}
            </button>
          );
        }
        const isOpen = open.has(n.path);
        return (
          <div key={n.path}>
            <button className="file dir" aria-expanded={isOpen} onClick={() => onToggle(n.path)} title={n.path}>
              <span className="st">{isOpen ? <IconChevronDown /> : <IconChevron />}</span>
              <span className="p">{n.name}/</span>
              <span className="badge num">{n.count}</span>
            </button>
            {isOpen && <FileTree nodes={n.children} open={open} onToggle={onToggle} selected={selected} onSelect={onSelect} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Quita la cabecera de git (hasta el primer `@@` de cada fichero). Solo ahí se
 * descartan `--- a/…` y `+++ b/…`: dentro de un hunk, una línea borrada que empieza
 * por «-- » o añadida por «++ » es contenido y antes desaparecía.
 */
export function diffBodyLines(text: string): string[] {
  let inHeader = /^(diff --git|index |--- )/.test(text);
  return text.split("\n").filter((l) => {
    if (l.startsWith("diff --git")) inHeader = true;
    else if (l.startsWith("@@")) inHeader = false;
    // «Binary files … differ» va en la cabecera y es lo único que explica el fichero.
    return !inHeader || l.startsWith("Binary files");
  });
}

function DiffView({ text }: { text: string }) {
  const lines = diffBodyLines(text);
  return (
    <div className="diff" role="region" aria-label="Diff del fichero">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l || " "}</div>
      ))}
    </div>
  );
}

export function Git({ cwd }: { cwd: string | null }) {
  const api = useApi();
  const git = useGit(cwd);
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [log, setLog] = useState<GitCommitInfo[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tree = useMemo(() => buildGitTree(git.snapshot?.changes ?? []), [git.snapshot]);
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  // Hasta que el usuario pliega o despliega algo, decide el tamaño del cambio.
  const openDirs = open ?? new Set((git.snapshot?.changes.length ?? 0) <= OPEN_UP_TO ? allDirPaths(tree) : []);
  const toggleDir = (path: string) =>
    setOpen(() => {
      const next = new Set(openDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const allOpen = openDirs.size > 0 && openDirs.size >= allDirPaths(tree).length;

  useEffect(() => {
    if (!cwd) return;
    // Al cambiar de sesión, el log del repo anterior puede llegar tarde y pisar el del nuevo.
    let alive = true;
    api.gitLog(cwd, 5).then(
      (l) => {
        if (!alive) return;
        setLog(l);
        setLogError(null);
      },
      (e: unknown) => {
        if (!alive) return;
        setLog([]);
        setLogError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, cwd, git.snapshot]);

  useEffect(() => {
    const first = git.snapshot?.changes[0] ?? null;
    setSelected((cur) => git.snapshot?.changes.find((c) => c.path === cur?.path) ?? first);
  }, [git.snapshot]);

  useEffect(() => {
    if (!cwd || !selected) {
      setDiff(null);
      return;
    }
    let alive = true;
    api.gitDiffFile(cwd, selected.path, selected.staged).then((d) => alive && setDiff(d)).catch((e: unknown) => alive && setDiff(String(e)));
    return () => {
      alive = false;
    };
  }, [api, cwd, selected]);

  if (!cwd) return <NoSession />;
  if (git.loading && !git.snapshot) return <p className="loading">Leyendo el repositorio…</p>;
  if (git.error) return <p className="err-text" role="alert">No se pudo leer git: {git.error}</p>;
  const snap = git.snapshot;
  if (!snap || !snap.state.is_repo) return <p className="note">Esta carpeta no es un repositorio git.</p>;

  async function commit() {
    if (!cwd || !message.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const out = await api.gitCommit(cwd, message.trim());
      setResult({ ok: true, text: out });
      setMessage("");
      git.reload();
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const s = snap.state;
  return (
    <>
      <div className="sect">
        <span className="sect-title" title={`${snap.changes.length} fichero${snap.changes.length === 1 ? "" : "s"} sin commitear`}>
          {s.branch ?? "HEAD"} · {snap.changes.length === 0 ? "sin cambios" : `${snap.changes.length} sin commitear`}
        </span>
        <span className="acts">
        {(s.ahead > 0 || s.behind > 0) && (
          <span className="badge num" title={[s.ahead > 0 && `${s.ahead} por subir`, s.behind > 0 && `${s.behind} por bajar`].filter(Boolean).join(" · ")}>
            {[s.ahead > 0 && `↑${s.ahead}`, s.behind > 0 && `↓${s.behind}`].filter(Boolean).join(" ")}
          </span>
        )}
        {tree.some((n) => n.kind === "dir") && (
          <button className="act" onClick={() => setOpen(new Set(allOpen ? [] : allDirPaths(tree)))}>{allOpen ? "Plegar todo" : "Desplegar todo"}</button>
        )}
        <button className="act" onClick={git.reload} aria-label="Recargar git"><IconRefresh /></button>
        </span>
      </div>
      <FileTree nodes={tree} open={openDirs} onToggle={toggleDir} selected={selected} onSelect={setSelected} />
      {diff && <DiffView text={diff} />}
      {snap.changes.length > 0 && (
        <div className="commit">
          <label className="sect" htmlFor="commit-msg">Commit</label>
          <textarea id="commit-msg" placeholder="feat: descripción del cambio" value={message} onChange={(e) => setMessage(e.target.value)} />
          <button className="btn pri" disabled={busy || !message.trim()} onClick={() => void commit()}>{busy ? "Haciendo commit…" : "Commit"}</button>
        </div>
      )}
      {result && <p className={result.ok ? "ok-text" : "err-text"} role="status">{result.text}</p>}
      {logError && <p className="err-text" role="status" data-testid="git-log-error">No se pudo leer el historial de commits: {logError}</p>}
      {log.length > 0 && (
        <>
          <div className="sect">Últimos commits</div>
          <div className="glog">
            {log.map((c) => (
              <div key={c.hash} className="file" title={c.subject}>
                <span className="st">·</span>
                <span className="p" style={{ direction: "ltr" }}>{c.short} {c.subject}</span>
                <span />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
