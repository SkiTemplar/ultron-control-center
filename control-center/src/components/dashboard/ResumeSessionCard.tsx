// "Continuar donde lo dejaste" — primary dashboard action (card-vis-resume-last-session).
//
// Fetches the most recent Claude Code session via the existing
// `recall_last_session_global` command (backend recall.rs::RecallResult) and
// surfaces it as a one-click resume affordance at the top of the Dashboard.
//
// Resume action: the GLOBAL recall does not carry the originating project's
// cwd, so we do NOT spawn a session blindly into the wrong folder. Instead we
// copy the suggested prompt to the clipboard (the system's clipboard-always
// convention) and navigate to Sessions, where the user starts/forks a session
// and pastes. Spawning directly in the project cwd is deferred until recall
// carries project context (see card note).
//
// Hidden entirely when there is no previous session (Nielsen #5: no empty card).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecallResult } from "../../types";
import { showToast } from "../../lib/popups";
import { Card, SmallButton } from "./Card";

interface ResumeSessionCardProps {
  /** Navigate to the Sessions tab (wired by Dashboard to onNavigate). */
  onOpenSessions?: () => void;
}

function previewOf(summaryMd: string, max = 260): string {
  const flat = summaryMd
    .replace(/[#>*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function ResumeSessionCard({ onOpenSessions }: ResumeSessionCardProps) {
  const [result, setResult] = useState<RecallResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<RecallResult>("recall_last_session_global");
        if (!cancelled) setResult(r);
      } catch {
        // Recall is best-effort; on failure we simply hide the card.
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide while loading and whenever there is no real previous session.
  if (loading || !result || !result.found) return null;

  const prompt = result.suggested_prompt?.trim() ?? "";

  async function handleResume() {
    if (!prompt) return;
    setResuming(true);
    try {
      await navigator.clipboard.writeText(prompt);
      showToast({
        source: "resume",
        severity: "info",
        message:
          "Prompt de la última sesión copiado. Abre/forka una sesión y pégalo con Ctrl+V.",
      });
      onOpenSessions?.();
    } catch (e) {
      showToast({ source: "resume", severity: "warn", message: `No se pudo copiar el prompt: ${String(e)}` });
    } finally {
      setResuming(false);
    }
  }

  return (
    <Card
      title="Continuar donde lo dejaste"
      subtitle={result.last_active_iso ? `Última actividad: ${result.last_active_iso}` : undefined}
      accent="ok"
      size="lg"
      action={
        <div className="flex items-center gap-2">
          <SmallButton onClick={() => setExpanded((v) => !v)} variant="neutral">
            {expanded ? "Ocultar" : "Ver resumen"}
          </SmallButton>
          <SmallButton onClick={() => void handleResume()} disabled={!prompt || resuming} variant="accent">
            {resuming ? "Copiando…" : "Resumir"}
          </SmallButton>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
        {expanded ? previewOf(result.summary_md, 1200) : previewOf(result.summary_md)}
      </p>
    </Card>
  );
}
