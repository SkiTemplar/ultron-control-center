// P5 — GitHub search modal (Agents + Skills). Debounced input -> Tauri
// `library_search_github` -> list of remote items. Per-item Install
// triggers the parent's onInstall callback (which opens
// InstallConfirmModal).

import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryKind, RemoteItem } from "../../types";
import { librarySearchGitHub } from "../../lib/library-client";
import { Github, Loader, Search, X } from "./icons";

type Props = {
  kind: LibraryKind;
  onClose: () => void;
  onInstall: (item: RemoteItem) => void;
};

export function SearchGitHubModal({ kind, onClose, onInstall }: Props) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<RemoteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const placeholder = useMemo(
    () =>
      kind === "agent"
        ? "rust-reviewer, security, ..."
        : "tdd, refactor, ...",
    [kind],
  );

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setItems([]);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await librarySearchGitHub(query, kind, 30);
        setItems(r);
      } catch (e) {
        setErr(String(e));
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, kind]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[80vh] w-[min(720px,92vw)] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
          <Github size={16} />
          <h2 className="text-sm font-semibold">
            Search GitHub — {kind === "agent" ? "Agents" : "Skills"}
          </h2>
          <button
            className="ml-auto rounded p-1 hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
          <Search size={14} className="text-[var(--color-text-muted)]" />
          <input
            autoFocus
            type="text"
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
          />
          {loading && (
            <Loader size={14} className="animate-spin text-[var(--color-text-muted)]" />
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {err && (
            <div className="m-2 rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-xs text-[var(--color-error)]">
              {err}
            </div>
          )}
          {!loading && !err && query.trim() && items.length === 0 && (
            <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
              No results.
            </div>
          )}
          {items.map((it) => (
            <div
              key={`${it.owner}/${it.repo}/${it.path}`}
              className="flex items-start gap-2 rounded p-2 hover:bg-[var(--color-surface-2)]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {it.owner}/{it.repo}
                </div>
                <div className="truncate text-xs text-[var(--color-text-muted)]">
                  {it.path}
                </div>
                <div className="truncate text-xs text-[var(--color-text-muted)]">
                  name: {it.name}
                </div>
              </div>
              <button
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)]"
                onClick={() => onInstall(it)}
              >
                Install
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SearchGitHubModal;
