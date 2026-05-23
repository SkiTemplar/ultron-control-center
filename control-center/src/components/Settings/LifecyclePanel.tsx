import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

// ---------------------------------------------------------------------------
// LifecyclePanel (post-cleanup 2026-05-23):
//   - "Check for updates" button removed (USER owns the binary now, no
//     remote update channel needed). The top-of-window UpdateBanner +
//     lib.rs setup auto-check are out of scope for this file.
//   - Keep: Rebuild from source, Close Control Center, Uninstall.
// ---------------------------------------------------------------------------

export function LifecyclePanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // After a Rebuild we offer to fully close the app so the new binary can
  // replace control-center.exe (locked while this process runs).
  const [showCloseAfterRebuild, setShowCloseAfterRebuild] = useState(false);

  async function run(kind: "uninstall" | "update") {
    setBusy(kind);
    setError(null);
    setStatus(null);
    setShowCloseAfterRebuild(false);
    try {
      await invoke("run_app_lifecycle", { kind });
      setStatus(
        kind === "uninstall"
          ? "Uninstaller opened in a new terminal. Follow the prompts there."
          : "Rebuild opened in a new terminal. Takes ~3-5 minutes the first time.",
      );
      if (kind === "update") {
        setShowCloseAfterRebuild(true);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function closeControlCenter(reason: "rebuild" | "manual") {
    const msg =
      reason === "rebuild"
        ? "Close ULTRON Control Center now?\n\n" +
          "This frees the file lock on control-center.exe so the rebuild " +
          "can replace it. The current window will exit fully (not just " +
          "minimize to tray)."
        : "Close ULTRON Control Center?\n\n" +
          "This fully exits the app (not just minimize to tray). " +
          "Global hotkeys stop working until you relaunch.";
    const ok = await confirmDialog(msg, { title: "Close Control Center", kind: "warning" });
    if (!ok) return;
    try {
      await invoke("close_control_center");
    } catch (e) {
      console.error("close_control_center failed", e);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold">App lifecycle</h3>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          One-shot actions for the Control Center binary itself. Both open
          a new terminal window so you can watch the script run; the app
          keeps working in the meantime.
        </p>
      </div>

      {status && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {status}
        </div>
      )}
      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Rebuild from source</div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Rebuild the Control Center from the latest source in this
              repo. Runs <code style={{ fontFamily: "var(--font-mono)" }}>
              npm run tauri build</code> in <code style={{ fontFamily: "var(--font-mono)" }}>
              control-center/</code>. The current window keeps running;
              relaunch after the new binary appears in
              <code style={{ fontFamily: "var(--font-mono)" }}> src-tauri/target/release/bundle/</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run("update")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy === "update" ? "Opening…" : "Rebuild"}
          </button>
        </div>
        {showCloseAfterRebuild && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded p-3 text-[11.5px]"
            style={{
              background: "rgba(210, 153, 34, 0.06)",
              border: "1px solid rgba(210, 153, 34, 0.28)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span>
              Once the rebuild finishes, this process must exit so the new
              binary can overwrite <code style={{ fontFamily: "var(--font-mono)" }}>control-center.exe</code>.
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setShowCloseAfterRebuild(false)}
                className="rounded px-2.5 py-1 text-[11px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={() => void closeControlCenter("rebuild")}
                className="rounded px-2.5 py-1 text-[11px] font-medium"
                style={{
                  background: "var(--color-warn)",
                  color: "var(--color-accent-text)",
                }}
              >
                Close Control Center now
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Close Control Center</div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Fully exit the app. The window X button only minimizes to the
              system tray so global hotkeys keep working — use this when you
              actually want the process to stop (e.g. before a rebuild, to
              free file locks, or to disable the hotkey listener).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void closeControlCenter("manual")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            Close Control Center
          </button>
        </div>
      </div>

      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid rgba(248, 81, 73, 0.28)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-danger)" }}
            >
              Uninstall
            </div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Open the uninstaller in a new terminal. Removes
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.ultron/</code>,
              autostart entry, ULTRON scheduled tasks, Start Menu shortcuts,
              and hook entries that point at ~/.ultron in
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.claude/settings.json</code>.
              Your Claude Code skills in
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.claude/skills/</code> are preserved.
              The terminal asks for confirmation before doing anything destructive.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run("uninstall")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            {busy === "uninstall" ? "Opening…" : "Uninstall…"}
          </button>
        </div>
      </div>
    </div>
  );
}
