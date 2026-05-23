// v2.3 — Slash command browser.
//
// Tree view (Spotify-style) groups every discovered slash command by
// marketplace → plugin → command. The right pane shows the metadata
// (description, argument-hint, model, path) and a "Copy /<ns>:<cmd>" button.
// Search filters the tree in place.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SlashCommand } from "../../types";
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  Folder,
  Terminal,
} from "./icons";

type TreeNode = {
  marketplace: string;
  plugins: Record<string, SlashCommand[]>;
};

function groupCommands(cmds: SlashCommand[]): TreeNode[] {
  const acc = new Map<string, Record<string, SlashCommand[]>>();
  for (const c of cmds) {
    if (!acc.has(c.marketplace)) acc.set(c.marketplace, {});
    const plugins = acc.get(c.marketplace)!;
    if (!plugins[c.plugin]) plugins[c.plugin] = [];
    plugins[c.plugin].push(c);
  }
  return Array.from(acc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([marketplace, plugins]) => ({ marketplace, plugins }));
}

function commandSlug(c: SlashCommand): string {
  // `/<plugin>:<name>` is the invocation form. For the user-local
  // namespace, the plugin slug is literally "user".
  if (c.marketplace === "user" && c.plugin === "user") {
    return `/${c.name}`;
  }
  return `/${c.plugin}:${c.name}`;
}

export function Commands() {
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SlashCommand | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("list_all_slash_commands")) as SlashCommand[];
      setCmds(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cmds;
    return cmds.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.plugin.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [cmds, query]);

  const tree = useMemo(() => groupCommands(filtered), [filtered]);

  // Auto-expand all groups when the user types a query — otherwise
  // search results stay hidden behind collapsed nodes.
  useEffect(() => {
    if (!query.trim()) return;
    const next: Record<string, boolean> = {};
    for (const node of tree) {
      next[`mp:${node.marketplace}`] = true;
      for (const plugin of Object.keys(node.plugins)) {
        next[`pl:${node.marketplace}/${plugin}`] = true;
      }
    }
    setExpanded(next);
  }, [query, tree]);

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const isExpanded = (key: string, fallback = true) =>
    expanded[key] ?? fallback;

  const handleCopy = async (c: SlashCommand) => {
    const slug = commandSlug(c);
    try {
      await navigator.clipboard.writeText(slug);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(`copy ${slug}: ${e}`);
    }
  };

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Commands</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {cmds.length} slash commands
          </span>
        </div>
        <button
          onClick={reload}
          className="rounded-md border px-3 py-1 text-xs"
          style={{
            borderColor: "var(--color-border-strong)",
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
          }}
        >
          Refresh
        </button>
      </header>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar comandos…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* LEFT: tree */}
        <div
          className="min-h-0 overflow-y-auto rounded-md"
          style={{
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          {loading && (
            <p
              className="p-3 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Loading…
            </p>
          )}
          {!loading && tree.length === 0 && (
            <p
              className="p-3 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sin comandos para el filtro actual.
            </p>
          )}
          <ul className="p-1 text-sm">
            {tree.map((node) => {
              const mpKey = `mp:${node.marketplace}`;
              const mpOpen = isExpanded(mpKey, true);
              return (
                <li key={node.marketplace} className="select-none">
                  <button
                    type="button"
                    onClick={() => toggle(mpKey)}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {mpOpen ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    <Folder size={12} />
                    <span className="truncate">{node.marketplace}</span>
                  </button>
                  {mpOpen && (
                    <ul className="ml-2 border-l pl-2" style={{ borderColor: "var(--color-border)" }}>
                      {Object.entries(node.plugins)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([plugin, list]) => {
                          const plKey = `pl:${node.marketplace}/${plugin}`;
                          const plOpen = isExpanded(plKey, false);
                          return (
                            <li key={plugin}>
                              <button
                                type="button"
                                onClick={() => toggle(plKey)}
                                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px]"
                                style={{ color: "var(--color-text)" }}
                              >
                                {plOpen ? (
                                  <ChevronDown size={12} />
                                ) : (
                                  <ChevronRight size={12} />
                                )}
                                <Terminal size={12} />
                                <span className="truncate font-medium">
                                  {plugin}
                                </span>
                                <span
                                  className="ml-auto text-[10.5px]"
                                  style={{
                                    color: "var(--color-text-tertiary)",
                                  }}
                                >
                                  {list.length}
                                </span>
                              </button>
                              {plOpen && (
                                <ul
                                  className="ml-3 border-l pl-2"
                                  style={{ borderColor: "var(--color-border)" }}
                                >
                                  {list
                                    .slice()
                                    .sort((a, b) => a.name.localeCompare(b.name))
                                    .map((c) => {
                                      const isActive = selected?.path === c.path;
                                      return (
                                        <li key={c.path}>
                                          <button
                                            type="button"
                                            onClick={() => setSelected(c)}
                                            className="block w-full truncate rounded px-2 py-1 text-left text-[12px]"
                                            style={{
                                              background: isActive
                                                ? "var(--color-surface-4)"
                                                : "transparent",
                                              color: isActive
                                                ? "var(--color-text)"
                                                : "var(--color-text-secondary)",
                                              border: `1px solid ${
                                                isActive
                                                  ? "var(--color-border-strong)"
                                                  : "transparent"
                                              }`,
                                            }}
                                          >
                                            {c.name}
                                          </button>
                                        </li>
                                      );
                                    })}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* RIGHT: detail */}
        <div
          className="min-h-0 overflow-y-auto rounded-md p-4"
          style={{
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          {!selected ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Selecciona un comando del árbol para ver detalles.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold">
                    {commandSlug(selected)}
                  </h3>
                  <p
                    className="mt-0.5 truncate text-[11px]"
                    style={{
                      color: "var(--color-text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selected.marketplace} / {selected.plugin}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => handleCopy(selected)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: copied
                        ? "var(--color-accent)"
                        : "var(--color-surface-3)",
                      color: copied
                        ? "var(--color-accent-text)"
                        : "var(--color-text)",
                    }}
                  >
                    <Clipboard size={12} />
                    {copied ? "Copied!" : "Copy slash command"}
                  </button>
                  <button
                    onClick={() => handleOpen(selected.path)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                    }}
                  >
                    <ExternalLink size={12} />
                    Open
                  </button>
                </div>
              </div>

              <p
                className="text-sm leading-relaxed"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {selected.description || "(sin descripción)"}
              </p>

              {selected.argument_hint && (
                <div className="text-xs">
                  <span
                    className="mr-2 uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Arguments
                  </span>
                  <code
                    className="rounded px-1.5 py-0.5"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selected.argument_hint}
                  </code>
                </div>
              )}

              {selected.model && (
                <div className="text-xs">
                  <span
                    className="mr-2 uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Model
                  </span>
                  <code
                    className="rounded px-1.5 py-0.5"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selected.model}
                  </code>
                </div>
              )}

              <div className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                <span className="mr-2 uppercase tracking-wide">Source</span>
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  {selected.path}
                </code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Commands;
