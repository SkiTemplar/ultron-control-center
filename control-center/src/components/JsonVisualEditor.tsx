// JsonVisualEditor — v15.2 F9 UX
//
// Hierarchical form editor for ~/.claude/settings.json. The Raw JSON
// textarea toggle was removed in v15.2 F9 — this is now the only editor
// surface. Editing here calls onChange with the rebuilt object; the
// parent reuses the same Save flow (settings_save backend, atomic write).
//
// Design notes
// ------------
// - Pure structural: no schema validation, no Claude-Code-specific shape
//   checks. Users who need to inspect/repair an invalid settings.json
//   should edit the file on disk directly (path shown in the parent).
// - Two top-level keys get bespoke renderers:
//     · hooks       → event name → array of matcher groups, each with a
//                     matcher string + an array of {type, command}.
//     · mcpServers  → server name → card with type/command/args/url fields.
//   Everything else falls through to a generic recursive renderer.
// - Limitations explicitly NOT supported (edit settings.json on disk for
//   these — there is no Raw JSON fallback anymore):
//     · Adding/renaming top-level keys (you can only edit the values of
//       keys that already exist in the file).
//     · Arrays of arbitrary nested objects (we render them collapsed as
//       JSON snippets the user can edit in a textarea).
//     · null values (treated as empty strings).
//
// Performance: we deep-clone the whole object on every keystroke. The
// settings.json file is tiny (~10 KB), so this is fine.

import { useState } from "react";

// ---------------------------------------------------------------------------
// Tiny helpers — deep-clone via JSON round-trip is enough because settings
// holds only JSON-serialisable values.
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Field row primitives — minimal Tailwind, matches Settings.tsx aesthetics.
// ---------------------------------------------------------------------------

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="block text-[10px] font-medium uppercase tracking-[0.06em]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </span>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full rounded px-2 py-1 text-[12px]"
      style={{
        background: "var(--color-surface-1)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
        outline: "none",
        fontFamily: mono ? "var(--font-mono)" : undefined,
      }}
    />
  );
}

function NumberInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
      className="w-32 rounded px-2 py-1 text-[12px] tabular-nums"
      style={{
        background: "var(--color-surface-1)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
        outline: "none",
        fontFamily: "var(--font-mono)",
      }}
    />
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
      style={{
        background: value ? "var(--color-success)" : "var(--color-surface-3)",
        border: "1px solid var(--color-border-strong)",
        padding: "1px",
      }}
      aria-pressed={value}
    >
      <span
        className="block h-3.5 w-3.5 rounded-full transition-transform"
        style={{
          background: "var(--color-text)",
          transform: value ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

// JSON snippet textarea for values we can't render structurally (arrays of
// arbitrary objects, null, etc). Keeps the round-trip safe — invalid JSON
// is rejected silently so the parent never sees a half-baked tree.
function JsonSnippet({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const initial = JSON.stringify(value, null, 2);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function commit(next: string) {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      onChange(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        spellCheck={false}
        className="w-full rounded p-2 text-[11.5px] leading-relaxed"
        style={{
          fontFamily: "var(--font-mono)",
          background: "var(--color-surface-1)",
          color: "var(--color-text)",
          border: `1px solid ${error ? "rgba(248, 81, 73, 0.4)" : "var(--color-border-strong)"}`,
          outline: "none",
          minHeight: 80,
          resize: "vertical",
        }}
      />
      {error && (
        <div
          className="mt-1 text-[10.5px]"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic recursive renderer — strings / numbers / booleans / arrays /
// objects. Arrays of primitives get +/− buttons; arrays of objects fall
// back to the JsonSnippet escape hatch.
// ---------------------------------------------------------------------------

function ValueField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (typeof value === "string") {
    return <TextInput value={value} onChange={(v) => onChange(v)} mono={false} />;
  }
  if (typeof value === "number") {
    return <NumberInput value={value} onChange={(n) => onChange(n)} />;
  }
  if (typeof value === "boolean") {
    return <Toggle value={value} onChange={(b) => onChange(b)} />;
  }
  if (Array.isArray(value)) {
    return <ArrayField value={value} onChange={onChange} />;
  }
  if (isPlainObject(value)) {
    return <ObjectField value={value} onChange={onChange} />;
  }
  // null / undefined → render JSON snippet so user can set explicit null
  return <JsonSnippet value={value ?? null} onChange={onChange} />;
}

function ArrayField({
  value,
  onChange,
}: {
  value: unknown[];
  onChange: (next: unknown[]) => void;
}) {
  // If the array contains complex objects (anything that isn't a primitive)
  // we drop to JsonSnippet — building a generic editor for arbitrarily
  // nested object arrays would balloon the component. This is the documented
  // limitation: the user can flip to Raw view if they need to edit those.
  const primitive = value.every(
    (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
  );

  if (!primitive) {
    return <JsonSnippet value={value} onChange={(v) => onChange(v as unknown[])} />;
  }

  return (
    <div className="space-y-1">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <ValueField
            value={item}
            onChange={(next) => {
              const arr = clone(value);
              arr[i] = next;
              onChange(arr);
            }}
          />
          <button
            type="button"
            onClick={() => {
              const arr = clone(value);
              arr.splice(i, 1);
              onChange(arr);
            }}
            className="shrink-0 rounded px-2 py-0.5 text-[11.5px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Remove this item"
          >
            −
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          // Infer new-item type from existing entries; default to string.
          const sample = value[0];
          const blank: unknown =
            typeof sample === "number" ? 0 :
              typeof sample === "boolean" ? false : "";
          onChange([...value, blank]);
        }}
        className="rounded px-2 py-0.5 text-[11.5px]"
        style={{
          background: "var(--color-surface-3)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border-strong)",
        }}
        title="Append new item"
      >
        + Add item
      </button>
    </div>
  );
}

function ObjectField({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return (
      <span className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
        (empty object)
      </span>
    );
  }
  return (
    <div className="space-y-2">
      {keys.map((k) => (
        <div key={k}>
          <FieldLabel>{k}</FieldLabel>
          <div className="mt-1">
            <ValueField
              value={value[k]}
              onChange={(next) => {
                const obj = clone(value);
                obj[k] = next;
                onChange(obj);
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Specialised renderers for the two keys users actually need to manipulate
// often: hooks and mcpServers. Falling back to the generic renderer would
// technically work for both but the resulting UI is nowhere near as usable.
// ---------------------------------------------------------------------------

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };

function HooksEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const events = Object.keys(value);
  return (
    <div className="space-y-3">
      {events.map((event) => {
        const groups = (Array.isArray(value[event]) ? value[event] : []) as HookGroup[];
        return (
          <details
            key={event}
            open
            className="rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <summary
              className="cursor-pointer px-3 py-2 text-[12px] font-medium"
              style={{ color: "var(--color-text)" }}
            >
              {event}{" "}
              <span style={{ color: "var(--color-text-tertiary)" }}>
                ({groups.length} group{groups.length === 1 ? "" : "s"})
              </span>
            </summary>
            <div className="space-y-2 px-3 pb-3">
              {groups.map((g, gi) => (
                <div
                  key={gi}
                  className="rounded p-2"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <FieldLabel>Matcher</FieldLabel>
                    <button
                      type="button"
                      onClick={() => {
                        const next = clone(value);
                        const arr = (next[event] as HookGroup[]) ?? [];
                        arr.splice(gi, 1);
                        next[event] = arr;
                        onChange(next);
                      }}
                      className="ml-auto rounded px-2 py-0.5 text-[10.5px]"
                      style={{
                        background: "transparent",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(248, 81, 73, 0.32)",
                      }}
                    >
                      − Group
                    </button>
                  </div>
                  <div className="mt-1">
                    <TextInput
                      value={typeof g.matcher === "string" ? g.matcher : ""}
                      onChange={(v) => {
                        const next = clone(value);
                        const arr = (next[event] as HookGroup[]) ?? [];
                        arr[gi] = { ...arr[gi], matcher: v };
                        next[event] = arr;
                        onChange(next);
                      }}
                      placeholder="Bash|.*  (regex)"
                    />
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <FieldLabel>Hooks</FieldLabel>
                    {(g.hooks ?? []).map((h, hi) => (
                      <div
                        key={hi}
                        className="rounded p-2"
                        style={{
                          background: "var(--color-surface-2)",
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        <div className="flex gap-2">
                          <div className="w-32 shrink-0">
                            <FieldLabel>Type</FieldLabel>
                            <TextInput
                              value={typeof h.type === "string" ? h.type : "command"}
                              onChange={(v) => {
                                const next = clone(value);
                                const arr = (next[event] as HookGroup[]) ?? [];
                                const hs = [...(arr[gi].hooks ?? [])];
                                hs[hi] = { ...hs[hi], type: v };
                                arr[gi] = { ...arr[gi], hooks: hs };
                                next[event] = arr;
                                onChange(next);
                              }}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <FieldLabel>Command</FieldLabel>
                            <TextInput
                              value={typeof h.command === "string" ? h.command : ""}
                              onChange={(v) => {
                                const next = clone(value);
                                const arr = (next[event] as HookGroup[]) ?? [];
                                const hs = [...(arr[gi].hooks ?? [])];
                                hs[hi] = { ...hs[hi], command: v };
                                arr[gi] = { ...arr[gi], hooks: hs };
                                next[event] = arr;
                                onChange(next);
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const next = clone(value);
                              const arr = (next[event] as HookGroup[]) ?? [];
                              const hs = [...(arr[gi].hooks ?? [])];
                              hs.splice(hi, 1);
                              arr[gi] = { ...arr[gi], hooks: hs };
                              next[event] = arr;
                              onChange(next);
                            }}
                            className="mt-4 self-start rounded px-2 py-1 text-[10.5px]"
                            style={{
                              background: "transparent",
                              color: "var(--color-text-tertiary)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            −
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const next = clone(value);
                        const arr = (next[event] as HookGroup[]) ?? [];
                        const hs = [...(arr[gi].hooks ?? []), { type: "command", command: "" }];
                        arr[gi] = { ...arr[gi], hooks: hs };
                        next[event] = arr;
                        onChange(next);
                      }}
                      className="rounded px-2 py-0.5 text-[11.5px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      + Add hook
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const next = clone(value);
                  const arr = ((next[event] as HookGroup[]) ?? []).slice();
                  arr.push({ matcher: "", hooks: [] });
                  next[event] = arr;
                  onChange(next);
                }}
                className="rounded px-2 py-0.5 text-[11.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                + Add matcher group
              </button>
            </div>
          </details>
        );
      })}
    </div>
  );
}

type McpServer = {
  type?: string;
  command?: string;
  args?: unknown[];
  url?: string;
  env?: Record<string, unknown>;
  [k: string]: unknown;
};

function McpServersEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const names = Object.keys(value);
  return (
    <div className="space-y-3">
      {names.map((name) => {
        const srv = (isPlainObject(value[name]) ? value[name] : {}) as McpServer;
        function patch(p: Partial<McpServer>) {
          const next = clone(value);
          next[name] = { ...srv, ...p };
          onChange(next);
        }
        return (
          <details
            key={name}
            className="rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <summary
              className="cursor-pointer px-3 py-2 text-[12px] font-medium"
              style={{ color: "var(--color-text)" }}
            >
              {name}{" "}
              <span style={{ color: "var(--color-text-tertiary)" }}>
                ({srv.url ? "url" : srv.command ? "command" : "?"})
              </span>
            </summary>
            <div className="space-y-2 px-3 pb-3">
              <div>
                <FieldLabel>type</FieldLabel>
                <div className="mt-1">
                  <TextInput
                    value={typeof srv.type === "string" ? srv.type : ""}
                    onChange={(v) => patch({ type: v })}
                    placeholder="stdio | sse | http"
                  />
                </div>
              </div>
              <div>
                <FieldLabel>command</FieldLabel>
                <div className="mt-1">
                  <TextInput
                    value={typeof srv.command === "string" ? srv.command : ""}
                    onChange={(v) => patch({ command: v })}
                    placeholder="(stdio servers only)"
                  />
                </div>
              </div>
              <div>
                <FieldLabel>url</FieldLabel>
                <div className="mt-1">
                  <TextInput
                    value={typeof srv.url === "string" ? srv.url : ""}
                    onChange={(v) => patch({ url: v })}
                    placeholder="(http/sse servers only)"
                  />
                </div>
              </div>
              <div>
                <FieldLabel>args</FieldLabel>
                <div className="mt-1">
                  <ArrayField
                    value={Array.isArray(srv.args) ? srv.args : []}
                    onChange={(arr) => patch({ args: arr })}
                  />
                </div>
              </div>
              <div>
                <FieldLabel>env (raw JSON object)</FieldLabel>
                <div className="mt-1">
                  <JsonSnippet
                    value={isPlainObject(srv.env) ? srv.env : {}}
                    onChange={(v) => patch({ env: isPlainObject(v) ? v : {} })}
                  />
                </div>
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level component.
// ---------------------------------------------------------------------------

// v2.5.2 (wave 2): explicit priority order for top-level keys so the most
// edited settings (model, language, permissions, …) render first. Anything
// not in this list falls through to alphabetical order. The user reported
// that the previous order felt arbitrary and that some keys never made it
// into the form — we now iterate over Object.keys(obj) directly (real
// settings.json keys) and merely sort them, so nothing is ever dropped.
const TOP_LEVEL_PRIORITY: readonly string[] = [
  "model",
  "language",
  "permissions",
  "mcpServers",
  "env",
  "hooks",
];

function sortKeysByImportance(keys: string[]): string[] {
  const indexOf = new Map<string, number>();
  TOP_LEVEL_PRIORITY.forEach((k, i) => indexOf.set(k, i));
  return [...keys].sort((a, b) => {
    const ia = indexOf.has(a) ? (indexOf.get(a) as number) : Number.POSITIVE_INFINITY;
    const ib = indexOf.has(b) ? (indexOf.get(b) as number) : Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });
}

export function JsonVisualEditor({
  obj,
  onChange,
}: {
  obj: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  // Iterate over the real settings.json keys (never a hand-curated list)
  // so anything the user adds shows up automatically. We only re-order.
  const keys = sortKeysByImportance(Object.keys(obj));

  function patchKey(key: string, nextVal: unknown) {
    const next = clone(obj);
    next[key] = nextVal;
    onChange(next);
  }

  if (keys.length === 0) {
    return (
      <div
        className="rounded p-4 text-[12px]"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        settings.json is empty. Edit ~/.claude/settings.json directly to add the first top-level key, then reload.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        className="rounded p-2 text-[11.5px]"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        Visual form for top-level keys. Adding or renaming top-level keys is
        not supported here — edit{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</span>
        {" "}directly and reload. Arrays of complex objects fall back to a JSON
        snippet textarea.
      </div>

      {keys.map((k) => {
        const v = obj[k];
        return (
          <section
            key={k}
            className="rounded p-3"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <h3
                className="text-[13px] font-semibold"
                style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
              >
                {k}
              </h3>
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {Array.isArray(v) ? "array" : v === null ? "null" : typeof v}
              </span>
            </div>

            {k === "hooks" && isPlainObject(v) ? (
              <HooksEditor value={v} onChange={(next) => patchKey(k, next)} />
            ) : k === "mcpServers" && isPlainObject(v) ? (
              <McpServersEditor value={v} onChange={(next) => patchKey(k, next)} />
            ) : (
              <ValueField value={v} onChange={(next) => patchKey(k, next)} />
            )}
          </section>
        );
      })}
    </div>
  );
}
