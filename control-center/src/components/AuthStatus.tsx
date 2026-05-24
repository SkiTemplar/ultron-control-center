import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type AuthEntry = {
  provider: string;
  logged_in: boolean;
  credential_path: string;
  last_modified: string | null;
  age_days: number | null;
  binary_present: boolean;
  binary_path: string | null;
  note: string | null;
};

export type AuthReport = {
  entries: AuthEntry[];
};

const META: Record<
  string,
  { label: string; color: string; loginHint: string }
> = {
  claude: {
    label: "Claude",
    color: "var(--color-success)",
    loginHint: "Start a `claude` session and type `/login`.",
  },
  codex: {
    label: "Codex",
    color: "#a875ff",
    loginHint: "Run `codex login` in a terminal.",
  },
  gemini: {
    label: "Gemini",
    color: "var(--color-warn)",
    loginHint: "Run `gemini auth login` in a terminal.",
  },
};

function formatRelativeIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function AuthStatus() {
  const [report, setReport] = useState<AuthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const r = (await invoke("auth_status")) as AuthReport;
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Authentication
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="text-[11.5px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </div>
      <p
        className="text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Status of the three CLI peers. Tokens are never read or transmitted —
        we only look at credential file presence + age.
      </p>

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        {report?.entries.map((e) => {
          const m = META[e.provider] ?? {
            label: e.provider,
            color: "var(--color-text-secondary)",
            loginHint: "",
          };
          const stale = e.age_days != null && e.age_days > 60;
          const dot = !e.logged_in
            ? "var(--color-danger)"
            : stale
              ? "var(--color-warn)"
              : "var(--color-success)";
          const stateLabel = !e.logged_in
            ? "not logged in"
            : stale
              ? `stale · ${e.age_days}d`
              : `OK · ${formatRelativeIso(e.last_modified)}`;
          return (
            <div
              key={e.provider}
              className="rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: dot }}
                />
                <span
                  className="text-[12.5px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {m.label}
                </span>
                <span
                  className="ml-auto text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {stateLabel}
                </span>
              </div>
              <div
                className="mt-1 truncate text-[10.5px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                title={e.credential_path}
              >
                {e.credential_path}
              </div>
              {!e.binary_present && (
                <div
                  className="mt-2 text-[11.5px]"
                  style={{ color: "var(--color-warn)" }}
                >
                  Binary not found in PATH.
                </div>
              )}
              {e.note && (
                <p
                  className="mt-2 text-[11.5px] leading-relaxed"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {e.note}
                </p>
              )}
              {!e.logged_in && (
                <p
                  className="mt-1 text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  → {m.loginHint}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
