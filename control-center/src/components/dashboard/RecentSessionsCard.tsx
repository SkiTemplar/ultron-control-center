// Top 5 Claude sessions ordered by last_activity, click row to resume.
//
// v2.7 redesign: 5 items, bigger typography, preview line under the title,
// row hover affordance, resume button on hover/end-of-row.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeSession } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface RecentSessionsCardProps {
  onOpenSessions?: () => void;
}

export function RecentSessionsCard({ onOpenSessions }: RecentSessionsCardProps) {
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<ClaudeSession[]>("list_claude_sessions");
        if (!cancelled) setSessions(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const recent = (sessions ?? [])
    .slice()
    .sort((a, b) => {
      const at = a.last_activity ?? "";
      const bt = b.last_activity ?? "";
      return at < bt ? 1 : at > bt ? -1 : 0;
    })
    .slice(0, 5);

  async function resume(s: ClaudeSession) {
    setBusy(s.id);
    try {
      // Resume uses `--resume <id>` inside the project's cwd. The project's
      // cwd isn't always knowable from here, so fall back to home_dir when
      // the session record only carries a project_slug — spawn_session will
      // route by resumeId regardless.
      await invoke("spawn_session", {
        // backend command requires `provider` key.
        provider: "claude",
        cwd: null,
        prompt: null,
        flags: {
          dangerouslySkipPermissions: true,
          resumeId: s.id,
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Recent sessions"
      subtitle={`Last ${recent.length} Claude sessions`}
      loading={loading}
      error={error}
      empty={!loading && recent.length === 0 ? "No Claude sessions yet." : null}
      action={
        <SmallButton
          onClick={onOpenSessions}
          size="md"
          title="Open Sessions tab"
        >
          Open
        </SmallButton>
      }
    >
      <ul className="space-y-1">
        {recent.map((s) => {
          const label = s.project_label || s.project_slug || s.id.slice(0, 8);
          return (
            <li
              key={s.id}
              className="group flex items-center gap-3 rounded px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-3)]"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                  title={label}
                >
                  {label}
                </div>
                {s.preview && (
                  <div
                    className="truncate text-[11.5px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                    title={s.preview}
                  >
                    {s.preview}
                  </div>
                )}
              </div>
              <span
                className="shrink-0 tabular-nums text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {relativeTime(s.last_activity)}
              </span>
              <SmallButton
                variant="accent"
                onClick={() => void resume(s)}
                disabled={busy === s.id}
                title="Resume session"
              >
                {busy === s.id ? "…" : "Resume"}
              </SmallButton>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
