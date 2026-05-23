// P5 — Install-from-GitHub confirmation modal. Scope picker
// (global/project), rename, overwrite flag. Delegates to Tauri
// `library_install_from_github`.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryKind, RemoteItem, TargetScope } from "../../types";
import { libraryInstallFromGitHub } from "../../lib/library-client";
import { Download, X } from "./icons";

type ProjectLite = { id: string; name: string };

type Props = {
  item: RemoteItem;
  kind: LibraryKind;
  defaultScope?: TargetScope;
  defaultProjectId?: string;
  onClose: () => void;
  onInstalled: (writtenPath: string) => void;
};

// Backend ProjectInfo is richer; we only need {id, name} here.
type RawProject = { id: string; name: string };

export function InstallConfirmModal({
  item,
  kind,
  defaultScope = "global",
  defaultProjectId,
  onClose,
  onInstalled,
}: Props) {
  const [scope, setScope] = useState<TargetScope>(defaultScope);
  const [projectId, setProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [renameTo, setRenameTo] = useState(item.name);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (scope !== "project") return;
    (async () => {
      try {
        const raw =
          (await invoke<RawProject[]>("list_projects")) ?? [];
        const list: ProjectLite[] = raw.map((p) => ({ id: p.id, name: p.name }));
        setProjects(list);
        if (!projectId && list[0]) setProjectId(list[0].id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  async function install() {
    setBusy(true);
    setErr(null);
    try {
      const written = await libraryInstallFromGitHub({
        owner: item.owner,
        repo: item.repo,
        path: item.path,
        kind,
        target_scope: scope,
        target_project_id: scope === "project" ? projectId : null,
        target_name: renameTo === item.name ? null : renameTo,
        overwrite,
      });
      onInstalled(written);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="w-[min(520px,92vw)] rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
          <Download size={16} />
          <h2 className="text-sm font-semibold">Install {kind}</h2>
          <button
            className="ml-auto rounded p-1 hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="text-xs text-[var(--color-text-muted)]">
            From{" "}
            <span className="font-mono">
              {item.owner}/{item.repo}/{item.path}
            </span>
          </div>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">
              Target name
            </span>
            <input
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 outline-none"
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
            />
          </label>
          <fieldset className="flex gap-3">
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={scope === "global"}
                onChange={() => setScope("global")}
              />
              Global (<span className="font-mono">~/.claude/</span>)
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={scope === "project"}
                onChange={() => setScope("project")}
              />
              Project
            </label>
          </fieldset>
          {scope === "project" && (
            <select
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value || null)}
            >
              <option value="">(pick project)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite if exists
          </label>
          {err && (
            <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-xs text-[var(--color-error)]">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            className="rounded border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            onClick={install}
            disabled={busy || (scope === "project" && !projectId)}
          >
            {busy ? "Installing..." : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default InstallConfirmModal;
