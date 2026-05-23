// ULTRON Control Center 2.0 — Rules viewer (P2).
//
// Lists every Markdown rule under ~/.claude/rules/, shows a 3-line preview,
// and opens the source file in the OS-default editor. Backend = `rules_list`
// Tauri command (path-sandboxed to the rules root).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { RuleFile } from "../types";

export function Rules() {
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("rules_list")) as RuleFile[];
      setRules(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Rules</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            ~/.claude/rules/**/*.md
          </p>
        </div>
        <button
          onClick={reload}
          className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
        >
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-md border border-[var(--color-error)] bg-[var(--color-surface-1)] p-3 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Sin reglas en ~/.claude/rules/.
          </p>
        ) : (
          <ul className="space-y-2">
            {rules.map((r) => (
              <li
                key={r.path}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-sm"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {r.relative}
                  </span>
                </div>
                <pre className="mb-2 max-h-20 overflow-hidden whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">
                  {r.preview || "(sin preview)"}
                </pre>
                <button
                  onClick={() => handleOpen(r.path)}
                  className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
                >
                  Open in editor
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
