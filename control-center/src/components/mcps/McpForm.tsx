// ---------------------------------------------------------------------------
// Add / Edit modal — shared form
// ---------------------------------------------------------------------------

import type { EditableMcp, Transport } from "./types";

export function McpForm({
  value,
  onChange,
  lockName,
}: {
  value: EditableMcp;
  onChange: (m: EditableMcp) => void;
  lockName: boolean;
}) {
  function set<K extends keyof EditableMcp>(k: K, v: EditableMcp[K]) {
    onChange({ ...value, [k]: v });
  }
  function setEnv(i: number, patch: Partial<{ key: string; value: string }>) {
    const next = value.envRows.slice();
    next[i] = { ...next[i], ...patch };
    onChange({ ...value, envRows: next });
  }
  function addEnv() {
    onChange({ ...value, envRows: [...value.envRows, { key: "", value: "" }] });
  }
  function removeEnv(i: number) {
    const next = value.envRows.slice();
    next.splice(i, 1);
    onChange({ ...value, envRows: next });
  }

  const labelStyle: React.CSSProperties = {
    color: "var(--color-text-secondary)",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };
  const inputStyle: React.CSSProperties = {
    background: "var(--color-surface-1)",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-primary)",
    borderRadius: 4,
    padding: "6px 8px",
    fontSize: 12.5,
    width: "100%",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block" style={labelStyle}>
          Name
        </label>
        <input
          type="text"
          value={value.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="kebab-case-name"
          disabled={lockName}
          style={{ ...inputStyle, opacity: lockName ? 0.6 : 1 }}
        />
        <p
          className="mt-1 text-[11.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Lowercase letters, digits, '_' or '-'. Must start with letter/digit.
        </p>
      </div>

      <div>
        <label className="mb-1 block" style={labelStyle}>
          Transport
        </label>
        <div className="flex gap-2">
          {(["stdio", "http", "sse"] as Transport[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set("transport", t)}
              className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
              style={{
                background:
                  value.transport === t
                    ? "var(--color-accent)"
                    : "var(--color-surface-3)",
                color:
                  value.transport === t
                    ? "var(--color-accent-text)"
                    : "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {value.transport === "stdio" ? (
        <>
          <div>
            <label className="mb-1 block" style={labelStyle}>
              Command
            </label>
            <input
              type="text"
              value={value.command}
              onChange={(e) => set("command", e.target.value)}
              placeholder="npx"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="mb-1 block" style={labelStyle}>
              Args (one per line)
            </label>
            <textarea
              value={value.argsText}
              onChange={(e) => set("argsText", e.target.value)}
              rows={4}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label style={labelStyle}>Env</label>
              <button
                type="button"
                onClick={addEnv}
                className="text-[11.5px] underline-offset-2 hover:underline"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                + add row
              </button>
            </div>
            {value.envRows.length === 0 && (
              <p
                className="text-[11.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                No environment variables.
              </p>
            )}
            <div className="space-y-1.5">
              {value.envRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => setEnv(i, { key: e.target.value })}
                    placeholder="KEY"
                    style={{ ...inputStyle, flex: "1 1 35%" }}
                  />
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => setEnv(i, { value: e.target.value })}
                    placeholder="value"
                    style={{ ...inputStyle, flex: "1 1 65%" }}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnv(i)}
                    className="rounded px-2 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border)",
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div>
          <label className="mb-1 block" style={labelStyle}>
            URL
          </label>
          <input
            type="text"
            value={value.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://example.com/mcp"
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}
