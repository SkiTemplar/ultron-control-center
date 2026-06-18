// ---------------------------------------------------------------------------
// Generate MCP from prompt modal — self-contained state + handlers
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpGenerationResult, McpMutationResult } from "../../types";
import { Modal } from "./Modal";

export function GenerateModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (msg: string) => void;
}) {
  const [genDescription, setGenDescription] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<McpGenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  async function submitGenerate() {
    if (!genDescription.trim()) return;
    setGenBusy(true);
    setGenError(null);
    setGenResult(null);
    try {
      const res = (await invoke("generate_mcp_from_prompt", {
        description: genDescription,
      })) as McpGenerationResult;
      setGenResult(res);
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function acceptGenerated() {
    if (!genResult || !genResult.success) return;
    try {
      const res = (await invoke("add_mcp", {
        name: genResult.name,
        config: genResult.config,
      })) as McpMutationResult;
      onClose();
      onAdded(`Added '${res.name}' (from prompt). Restart Claude Code to apply.`);
    } catch (e) {
      setGenError(String(e));
    }
  }

  const generatedPreview = useMemo(() => {
    if (!genResult) return "";
    try {
      return JSON.stringify(
        { name: genResult.name, config: genResult.config },
        null,
        2,
      );
    } catch {
      return "";
    }
  }, [genResult]);

  return (
    <Modal
      title="Generate MCP from prompt"
      onClose={() => !genBusy && onClose()}
      wide
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={genBusy}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Close
          </button>
          {genResult?.success && (
            <button
              type="button"
              onClick={acceptGenerated}
              className="rounded px-3 py-1.5 text-[12px] font-medium"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              Add it
            </button>
          )}
          {!genResult && (
            <button
              type="button"
              onClick={submitGenerate}
              disabled={genBusy || !genDescription.trim()}
              className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {genBusy ? "Asking Claude…" : "Generate"}
            </button>
          )}
          {genResult && !genResult.success && (
            <button
              type="button"
              onClick={() => {
                setGenResult(null);
              }}
              className="rounded px-3 py-1.5 text-[12px] font-medium"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              Try again
            </button>
          )}
        </>
      }
    >
      {!genResult && (
        <>
          <label
            className="mb-1 block"
            style={{
              color: "var(--color-text-secondary)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Description
          </label>
          <textarea
            value={genDescription}
            onChange={(e) => setGenDescription(e.target.value)}
            rows={6}
            placeholder="e.g. a tool that wraps the Linear API for searching issues"
            disabled={genBusy}
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary)",
              borderRadius: 4,
              padding: "8px 10px",
              fontSize: 12.5,
              width: "100%",
              resize: "vertical",
            }}
          />
          <p
            className="mt-2 text-[11.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Claude is invoked via{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>cmd.exe /C claude -p</code>{" "}
            and asked to emit a strict JSON object. You can review before adding.
          </p>
          {genBusy && (
            <p
              className="mt-3 text-[12.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Asking Claude…
            </p>
          )}
          {genError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {genError}
            </p>
          )}
        </>
      )}

      {genResult && genResult.success && (
        <>
          <p
            className="mb-2 text-[12.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Claude proposed:
          </p>
          <pre
            className="rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {generatedPreview}
          </pre>
          <p
            className="mt-2 text-[11.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            "Add it" will call <code>add_mcp</code> with this config and
            refresh the list.
          </p>
        </>
      )}

      {genResult && !genResult.success && (
        <>
          <p
            className="mb-2 text-[12.5px]"
            style={{ color: "var(--color-warn)" }}
          >
            Could not parse a valid MCP config out of Claude's response.
            Raw output below — try rephrasing the description.
          </p>
          <pre
            className="rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {genResult.raw_output || "(no output)"}
          </pre>
        </>
      )}
    </Modal>
  );
}
