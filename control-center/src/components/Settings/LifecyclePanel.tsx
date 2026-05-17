import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// ---------------------------------------------------------------------------
// LifecyclePanel — Uninstall + Update buttons. Both spawn wt.exe in a new
// window so the user sees the script's output live and can confirm or
// abort. The Control Center keeps running in the meantime; the update
// path produces a new binary alongside the current one, which the user
// can run after closing this instance.
// ---------------------------------------------------------------------------

export function LifecyclePanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // v15.3 auto-updater state. `pendingUpdate` holds the manifest after a
  // successful `check()` so the modal can show version + notes and the
  // user can confirm before bytes are downloaded.
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number | null;
  } | null>(null);

  async function run(kind: "uninstall" | "update") {
    setBusy(kind);
    setError(null);
    setStatus(null);
    try {
      await invoke("run_app_lifecycle", { kind });
      setStatus(
        kind === "uninstall"
          ? "Uninstaller opened in a new terminal. Follow the prompts there."
          : "Update opened in a new terminal. Rebuild takes ~3-5 minutes the first time.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // v15.3 auto-updater. Calls the Tauri updater plugin which:
  //   1. Hits plugins.updater.endpoints[0] from tauri.conf.json.
  //   2. Verifies the signature against plugins.updater.pubkey.
  //   3. Compares remote version vs Cargo.toml version.
  // If newer, we stash the Update handle and show a confirm modal. The
  // modal's "Install" button calls downloadAndInstall + relaunch.
  async function checkForUpdates() {
    setBusy("check");
    setError(null);
    setStatus(null);
    setPendingUpdate(null);
    try {
      const update = await checkForUpdate();
      if (update) {
        setPendingUpdate(update);
      } else {
        setStatus("You're already on the latest version.");
      }
    } catch (e) {
      setError(`Check failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function installPendingUpdate() {
    if (!pendingUpdate) return;
    setBusy("install");
    setError(null);
    setStatus(null);
    setDownloadProgress({ downloaded: 0, total: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await pendingUpdate.downloadAndInstall((event) => {
        // Plugin emits Started -> Progress* -> Finished. We track bytes for
        // a tiny progress readout; the installer itself runs after Finished.
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setDownloadProgress({ downloaded: 0, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setDownloadProgress({ downloaded, total });
            break;
          case "Finished":
            setDownloadProgress({ downloaded, total });
            break;
        }
      });
      setStatus("Update installed. Restarting the app…");
      setPendingUpdate(null);
      // Tiny delay so the user sees the status before the window vanishes.
      setTimeout(() => {
        void relaunch();
      }, 800);
    } catch (e) {
      setError(`Install failed: ${String(e)}`);
    } finally {
      setBusy(null);
      setDownloadProgress(null);
    }
  }

  function cancelPendingUpdate() {
    setPendingUpdate(null);
    setDownloadProgress(null);
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold">App lifecycle</h3>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          One-shot actions for the Control Center binary itself. Both open a
          new terminal window so you can watch the script run; the app
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

      {/* v15.3 auto-updater: signed-binary path. Talks to GitHub Releases
          via tauri-plugin-updater. No Rust/Node toolchain required on the
          user's machine — the binary is downloaded and installed in-place,
          then the app relaunches. */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Check for updates</div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Pull the latest signed release from GitHub. No local Rust or
              Node setup needed — the installer runs in the background and
              the app restarts itself when done. Use this in preference to
              the Rebuild path below if you just want the newest version.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy === "check" ? "Checking…" : "Check for updates"}
          </button>
        </div>
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
              Useful when working on a branch that hasn't been released yet.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run("update")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {busy === "update" ? "Opening…" : "Rebuild"}
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

      {/* v15.3 auto-updater confirm modal. Rendered inline rather than via
          a Tauri dialog so we can show the changelog snippet from the
          signed manifest's `notes` field plus a progress readout during
          downloadAndInstall. */}
      {pendingUpdate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0, 0, 0, 0.55)" }}
          onClick={() => {
            if (busy !== "install") cancelPendingUpdate();
          }}
        >
          <div
            className="w-[520px] max-w-[92vw] rounded p-5 shadow-xl"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="text-[14px] font-semibold">
              Update available: v{pendingUpdate.version}
            </div>
            <div
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Currently installed: v{pendingUpdate.currentVersion}
              {pendingUpdate.date ? ` · published ${pendingUpdate.date}` : ""}
            </div>
            {pendingUpdate.body && (
              <div
                className="mt-3 max-h-[260px] overflow-auto rounded p-3 text-[11.5px] whitespace-pre-wrap"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {pendingUpdate.body}
              </div>
            )}
            {downloadProgress && (
              <div
                className="mt-3 text-[11px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {downloadProgress.total
                  ? `Downloaded ${(downloadProgress.downloaded / 1_048_576).toFixed(1)} / ${(downloadProgress.total / 1_048_576).toFixed(1)} MB`
                  : `Downloaded ${(downloadProgress.downloaded / 1_048_576).toFixed(1)} MB`}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelPendingUpdate}
                disabled={busy === "install"}
                className="rounded px-3 py-1.5 text-[12px] disabled:opacity-50"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-primary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void installPendingUpdate()}
                disabled={busy === "install"}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {busy === "install" ? "Installing…" : "Install and restart"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
