// Top 3 Claude sessions ordered by last_activity, click to resume.

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
    .slice(0, 3);

  async function resume(s: ClaudeSession) {
    setBusy(s.id);
    try {
      // Resume uses `--resume <id>` inside the project's cwd. The project's
      // cwd isn't always knowable from here, so fall back to home_dir when
      // the session record only carries a project_slug — spawn_session will
      // route by resumeId regardless.
      await invoke("spawn_session", {
        // v2.6 bug fix: backend command requires `provider` key. Without it
        // the Recent sessions resume button failed with "invalid args
        // `provider` for command `spawn_session`".
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
      title={`Recent sessions (${recent.length})`}
      loading={loading}
      error={error}
      empty={!loading && recent.length === 0 ? "No Claude sessions yet." : null}
      action={
        <SmallButton onClick={onOpenSessions} title="Open Sessions tab">
          open
        </SmallButton>
      }
    >
      <ul className="space-y-1.5">
        {recent.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-2 text-[11.5px]"
            style={{ minHeight: 24 }}
          >
            <span
              className="flex-1 truncate"
              style={{ color: "var(--color-text)" }}
              title={s.preview ?? s.id}
            >
              {s.project_label || s.project_slug || s.id.slice(0, 8)}
            </span>
            <span
              className="shrink-0 tabular-nums"
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-mono, ui-monospace)",
                fontSize: 10,
              }}
            >
              {relativeTime(s.last_activity)}
            </span>
            <SmallButton
              variant="accent"
              onClick={() => void resume(s)}
              disabled={busy === s.id}
              title="Resume session"
            >
              resume
            </SmallButton>
          </li>
        ))}
      </ul>
    </Card>
  );
}
