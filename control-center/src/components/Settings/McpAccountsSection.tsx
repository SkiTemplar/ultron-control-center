import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Settings > MCP Accounts — alta de N cuentas por plantilla de MCP (Supabase…)
// sin tocar comandos: alias + token y la app escribe la entrada mcpServers en
// ~/.claude.json (backup + escritura atómica en el backend). El token viaja
// del input al JSON local; nunca se muestra entero de vuelta ni se loguea.

interface McpAccountTemplate {
  id: string;
  label: string;
  env_key: string;
  package: string;
  read_only_flag: string | null;
  docs_url: string;
}

interface McpAccountRow {
  name: string;
  template_id: string;
  token_masked: string;
  read_only: boolean;
}

export function McpAccountsSection() {
  const [templates, setTemplates] = useState<McpAccountTemplate[]>([]);
  const [rows, setRows] = useState<McpAccountRow[]>([]);
  const [templateId, setTemplateId] = useState("supabase");
  const [alias, setAlias] = useState("");
  const [token, setToken] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tpls, accounts] = await Promise.all([
        invoke<McpAccountTemplate[]>("mcp_account_templates"),
        invoke<McpAccountRow[]>("mcp_accounts_list"),
      ]);
      setTemplates(tpls);
      setRows(accounts);
      if (tpls.length > 0 && !tpls.some((t) => t.id === templateId)) {
        setTemplateId(tpls[0].id);
      }
    } catch (e) {
      setError(String(e));
    }
    // templateId solo se corrige si dejó de existir; no debe relanzar el load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const template = templates.find((t) => t.id === templateId) ?? null;

  const handleAdd = useCallback(async () => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const [name] = await invoke<[string, string]>("mcp_account_add", {
        templateId,
        alias,
        token,
        readOnly,
      });
      setOkMsg(
        `Cuenta '${name}' añadida. Reinicia la sesión de Claude Code para que aparezca.`,
      );
      setAlias("");
      setToken("");
      setReadOnly(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [templateId, alias, token, readOnly, load]);

  const handleRemove = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      setOkMsg(null);
      try {
        await invoke<string>("mcp_account_remove", { name });
        setOkMsg(`Cuenta '${name}' eliminada. Reinicia la sesión de Claude Code.`);
        setConfirmRemove(null);
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const inputStyle: React.CSSProperties = {
    background: "var(--color-surface-1)",
    border: "1px solid var(--color-border-strong)",
    color: "var(--color-text)",
  };

  return (
    <div className="max-w-[560px]">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold">MCP Accounts</h2>
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Varias cuentas del mismo servicio (un token por correo), todas
          conectadas a la vez: en el chat basta nombrar la cuenta a usar. Se
          escriben como servers MCP en <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude.json</code>{" "}
          con backup automático; los cambios se aplican al reiniciar la sesión
          de Claude Code.
        </p>
      </div>

      {/* Formulario de alta */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2">
          <label className="text-[12px] font-medium" htmlFor="mcpacc-template">
            Servicio
          </label>
          <select
            id="mcpacc-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="rounded px-2 py-1.5 text-[12px] outline-none"
            style={inputStyle}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {template && (
            <a
              href={template.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[10.5px]"
              style={{ color: "var(--color-accent)" }}
            >
              Generar token ↗
            </a>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          <input
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="alias de la cuenta (tienda, blog…)"
            autoComplete="off"
            spellCheck={false}
            className="w-[180px] rounded px-2.5 py-1.5 text-[12px] outline-none"
            style={inputStyle}
          />
          <input
            type={tokenVisible ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={template ? `token (${template.env_key})` : "token"}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 rounded px-2.5 py-1.5 text-[12px] outline-none"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          />
          <button
            type="button"
            onClick={() => setTokenVisible((v) => !v)}
            title={tokenVisible ? "Ocultar" : "Mostrar"}
            className="shrink-0 rounded px-2 py-1.5 text-[11px]"
            style={inputStyle}
          >
            {tokenVisible ? "🙈" : "👁"}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          {template?.read_only_flag && (
            <label
              className="flex items-center gap-1.5 text-[12px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              solo lectura
            </label>
          )}
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy || !alias.trim() || !token.trim()}
            className="ml-auto rounded px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Guardando…" : "Añadir cuenta"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {okMsg && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {okMsg}
        </div>
      )}

      {/* Cuentas configuradas */}
      <div className="mt-5">
        <p
          className="mb-2 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Cuentas configuradas ({rows.length})
        </p>
        {rows.length === 0 ? (
          <div
            className="rounded p-5 text-center text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            Ninguna todavía. Añade la primera arriba.
          </div>
        ) : (
          <ul
            className="rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {rows.map((r, i) => (
              <li
                key={r.name}
                className="flex items-center gap-2 border-t px-3 py-2 text-[12px]"
                style={{ borderColor: i === 0 ? "transparent" : "var(--color-border)" }}
              >
                <span style={{ fontFamily: "var(--font-mono)" }}>{r.name}</span>
                {r.read_only && (
                  <span
                    className="rounded px-1.5 py-px text-[10px]"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    read-only
                  </span>
                )}
                <span
                  className="ml-auto text-[11px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  {r.token_masked}
                </span>
                {confirmRemove === r.name ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleRemove(r.name)}
                      disabled={busy}
                      className="rounded px-2 py-1 text-[11px] font-medium"
                      style={{
                        background: "rgba(248, 81, 73, 0.10)",
                        border: "1px solid rgba(248, 81, 73, 0.30)",
                        color: "var(--color-danger)",
                      }}
                    >
                      Confirmar
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(null)}
                      className="rounded px-2 py-1 text-[11px]"
                      style={inputStyle}
                    >
                      No
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(r.name)}
                    disabled={busy}
                    title="Eliminar esta cuenta"
                    className="rounded px-2 py-1 text-[11px]"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--color-border-strong)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    Eliminar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
