// SecurityPanel — shared between the Skills and Agents tabs.
//
// Why a shared component? Both tabs run the same prompt-injection scanner
// (`skill_sync_security.py`) and surface the same decision ladder
// (allow / warn / quarantine / block). Duplicating the panel in two
// places means every fix has to be applied twice. This component owns:
//
//   - the title + summary line (decision, findings count, sha1 short)
//   - the per-finding rows (severity badge, rule_id, excerpt)
//   - the "Allow anyway" form (textarea + button + audit-trail validation)
//
// The caller is responsible for:
//   - fetching the report (`onLoad`)
//   - invoking the waiver writer when the user submits (`onAllow`)
//   - opening/closing the panel (the `open` prop)
//
// This keeps the data sources (Skills vs Agents) cleanly separated while
// guaranteeing the UX stays in lock-step.

import { useEffect, useState } from "react";

// We accept both SkillFinding and AgentFinding — their shapes are
// identical by construction, so a structural type is fine.
export type SecurityPanelFinding = {
  rule_id: string;
  severity: string;
  pattern_name: string;
  excerpt: string;
  line_number: number | null;
  waived: boolean;
};

export type SecurityPanelReport = {
  decision: string;
  sha1: string | null;
  findings: SecurityPanelFinding[];
};

export function SecurityPanel({
  open,
  loading,
  error,
  report,
  busy,
  onAllow,
  // Free-text label describing the asset class — "skill" or "agent".
  // Used only in human-facing copy; never affects logic.
  targetLabel,
  // YAML file the waiver is written to. Different deployments could
  // theoretically point this elsewhere; today both Skills and Agents
  // share ~/.ultron/config/skill-trust.yaml.
  waiverPath = "~/.ultron/config/skill-trust.yaml",
}: {
  open: boolean;
  loading: boolean;
  error: string | null;
  report: SecurityPanelReport | null;
  busy: boolean;
  onAllow: (rules: string[], reason: string) => void;
  targetLabel: "skill" | "agent";
  waiverPath?: string;
}) {
  const [reason, setReason] = useState("");

  // Reset the reason whenever the panel closes so re-opening doesn't
  // surprise the user with a stale text from a previous attempt.
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  if (!open) return null;

  const activeFindings = report
    ? report.findings.filter((f) => !f.waived)
    : [];
  const canSubmit = !busy && activeFindings.length > 0 && reason.trim().length > 0;

  function submit() {
    if (!report) return;
    const rules = Array.from(
      new Set(activeFindings.map((f) => f.rule_id)),
    );
    if (rules.length === 0) return;
    onAllow(rules, reason.trim());
  }

  return (
    <div
      className="mt-3 rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid rgba(232, 169, 58, 0.32)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "#e8a93a" }}
        >
          Security findings
        </span>
        {report && (
          <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            decision:{" "}
            <strong style={{ color: "var(--color-text)" }}>{report.decision}</strong>
            {" · "}
            {report.findings.length} finding(s)
            {report.sha1 && (
              <>
                {" · sha1 "}
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  {report.sha1.slice(0, 10)}…
                </code>
              </>
            )}
          </span>
        )}
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Strict mode keeps these {targetLabel}s out of the active list. Review each
        finding below — if you trust this {targetLabel}, write a justification and
        click "Allow anyway" to record a per-SHA1 waiver in{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>{waiverPath}</code>. Editing
        the source file invalidates the waiver, forcing a fresh review.
      </p>
      {loading && (
        <div className="mt-3 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Running scanner…
        </div>
      )}
      {error && (
        <div
          className="mt-2 rounded px-2 py-1 text-[11px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {report && report.findings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {report.findings.map((f, i) => (
            <div
              key={`${f.rule_id}-${i}`}
              className="rounded p-2 text-[11px]"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                opacity: f.waived ? 0.55 : 1,
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background:
                      f.severity === "critical" || f.severity === "high"
                        ? "rgba(248, 81, 73, 0.12)"
                        : "rgba(232, 169, 58, 0.10)",
                    color:
                      f.severity === "critical" || f.severity === "high"
                        ? "#f85149"
                        : "#e8a93a",
                  }}
                >
                  {f.severity}
                </span>
                <code
                  className="text-[10.5px]"
                  style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}
                >
                  {f.rule_id}
                </code>
                <span style={{ color: "var(--color-text-secondary)" }}>{f.pattern_name}</span>
                {f.waived && (
                  <span
                    className="ml-auto text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    waived
                  </span>
                )}
              </div>
              {f.excerpt && (
                <pre
                  className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {f.excerpt}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      {activeFindings.length > 0 && (
        <div className="mt-3">
          <label
            className="mb-1 block text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Reason (audit trail · required)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Por qué confío en este ${targetLabel} (proveniencia, revisión, etc.)`}
            className="w-full rounded p-2 text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
              minHeight: 60,
              resize: "vertical",
            }}
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.32)",
              }}
            >
              {busy ? "Writing waiver…" : "Allow anyway"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SecurityBadge — small pill rendered in row lists (next to state badge).
// Returns null when there's nothing to surface (no security info, or the
// decision is "allow"). Caller still receives the element to slot in.
// ---------------------------------------------------------------------------

export function securityHintFromInfo(
  sec: { decision: string; findings_count?: number; high_severity_rules?: string[] } | null | undefined,
): { color: string; bg: string; label: string; title: string } | null {
  if (!sec) return null;
  const d = sec.decision;
  if (d === "block" || d === "quarantine") {
    return {
      color: "#f85149",
      bg: "rgba(248, 81, 73, 0.10)",
      label: d === "block" ? "blocked" : `${sec.findings_count ?? 0} findings`,
      title: `Security ${d.toUpperCase()} — ${
        (sec.high_severity_rules ?? []).join(", ") || "review required"
      }`,
    };
  }
  if (d === "warn") {
    return {
      color: "#e8a93a",
      bg: "rgba(232, 169, 58, 0.10)",
      label: `warn ${sec.findings_count ?? 0}`,
      title: `Security WARN — ${
        (sec.high_severity_rules ?? []).join(", ") || "low-severity findings"
      }`,
    };
  }
  return null;
}
