// Diagnostics — CommonErrorRow

import { useEffect, useRef, useState } from "react";
import type { CommonError, CommonErrorCheckResult, Fix, FixHistoryEntry } from "./types";
import { FIX_CATALOG } from "./catalogs";
import { severityIcon } from "./helpers";

export function CommonErrorRow({
  error,
  checkResult,
  fixBusy,
  onDiagnose,
  onFix,
}: {
  error: CommonError;
  checkResult: CommonErrorCheckResult | "running" | null;
  fixBusy: string | null;
  onDiagnose: () => void;
  onFix: (fix: Fix, source: FixHistoryEntry["source"], errorId: string) => void;
}) {
  const icon = severityIcon(error.severity);
  const [extraOpen, setExtraOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!extraOpen) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setExtraOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [extraOpen]);

  const isRunning = checkResult === "running";
  const result = checkResult !== "running" ? checkResult : null;

  const hasExtraFixes = (error.extraFixes ?? []).length > 0;
  const primaryFix = error.primaryFixKind ? FIX_CATALOG[error.primaryFixKind] : null;

  return (
    <li className="px-3 py-3">
      <div className="flex items-start gap-3">
        {/* Severity icon */}
        <span
          className="mt-0.5 shrink-0 text-[14px]"
          title={error.severity}
          style={{ color: icon.color, lineHeight: 1 }}
        >
          {icon.symbol}
        </span>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
              {error.title}
            </span>
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {error.category}
            </span>
          </div>

          <div className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
            {error.symptom}
          </div>

          {/* Check result */}
          {result && (
            <div
              className="mt-1.5 rounded px-2 py-1 text-[11.5px] leading-snug"
              style={{
                background:
                  result.status === "ok"
                    ? "rgba(63,185,80,0.08)"
                    : result.status === "fail"
                    ? "rgba(248,81,73,0.08)"
                    : "rgba(210,153,34,0.08)",
                border: `1px solid ${
                  result.status === "ok"
                    ? "rgba(63,185,80,0.25)"
                    : result.status === "fail"
                    ? "rgba(248,81,73,0.25)"
                    : "rgba(210,153,34,0.25)"
                }`,
                color:
                  result.status === "ok"
                    ? "var(--color-success, #3fb950)"
                    : result.status === "fail"
                    ? "var(--color-danger, #f85149)"
                    : "var(--color-warn, #d29922)",
              }}
            >
              <span className="font-semibold capitalize">{result.status}</span>
              {" — "}
              {result.details}
              {result.suggested_fix && (
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {" "}Sugerencia: {result.suggested_fix}
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/* Diagnose */}
            <button
              type="button"
              onClick={onDiagnose}
              disabled={isRunning}
              className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                borderColor: "var(--color-border-strong)",
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
              }}
            >
              {isRunning ? "Checking..." : result ? "Re-check" : "Diagnose"}
            </button>

            {/* Primary Fix */}
            {primaryFix ? (
              <button
                type="button"
                onClick={() => onFix(primaryFix, "common_error", error.id)}
                disabled={fixBusy !== null}
                title={primaryFix.detail}
                className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                style={{
                  borderColor:
                    result?.status === "fail"
                      ? "rgba(248,81,73,0.5)"
                      : "var(--color-border-strong)",
                  background:
                    fixBusy === primaryFix.kind
                      ? "var(--color-accent)"
                      : result?.status === "fail"
                      ? "rgba(248,81,73,0.12)"
                      : "var(--color-surface-3)",
                  color:
                    fixBusy === primaryFix.kind
                      ? "var(--color-accent-text)"
                      : result?.status === "fail"
                      ? "var(--color-danger)"
                      : "var(--color-text)",
                }}
              >
                {fixBusy === primaryFix.kind ? "Running..." : `Fix: ${error.primaryFixLabel}`}
              </button>
            ) : (
              /* Non-automated fix — informational button */
              <span
                className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium"
                style={{
                  borderColor: "var(--color-border)",
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                }}
                title="Este fix requiere acción manual — ver la descripción del síntoma"
              >
                Fix: {error.primaryFixLabel}
              </span>
            )}

            {/* More fixes dropdown */}
            {hasExtraFixes && (
              <div ref={dropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExtraOpen((v) => !v)}
                  disabled={fixBusy !== null}
                  className="rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    borderColor: "var(--color-border-strong)",
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  More {extraOpen ? "▲" : "▼"}
                </button>
                {extraOpen && (
                  <div
                    className="absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded shadow-lg"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    {(error.extraFixes ?? []).map((ef) => {
                      const fix = FIX_CATALOG[ef.kind];
                      if (!fix) return null;
                      return (
                        <button
                          key={ef.kind}
                          type="button"
                          onClick={() => {
                            setExtraOpen(false);
                            onFix(fix, "common_error", error.id);
                          }}
                          title={fix.detail}
                          className="flex w-full items-start px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5"
                          style={{ color: "var(--color-text)" }}
                        >
                          {ef.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
