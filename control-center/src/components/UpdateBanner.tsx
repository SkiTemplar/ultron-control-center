import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runRebuildWithFeedback } from "./palette/systemPaletteActions";
import { handleExternalClick } from "../lib/openExternal";

// v15.4.2 — surfaces the "new version available" hint that
// `update_checker.rs` fires on startup. Reusable; mount once at the top
// of App.tsx so the banner shows on every tab.
//
// Lifecycle:
//   1. Backend startup task runs `check_for_updates_inner` after 6s.
//      If `has_update == true`, it emits the `update-available` event
//      with the full UpdateInfo payload.
//   2. We listen + memoise the payload. User can dismiss with × (only
//      until the next backend check on next launch).
//   3. "Update now" runs the canonical Rebuild flow (`startRebuild` via
//      `runRebuildWithFeedback`), the same one Settings → Recompilar uses:
//      confirmation first, then a visible terminal; the new binary takes
//      effect when the app restarts.
//   4. If localStorage holds `ultron.auto_rebuild_on_update = "1"` we start
//      that same flow without showing the banner (it still asks before
//      building). No UI writes that key yet (the Settings → Features
//      section was never built), so the banner does not advertise it.

type UpdateInfo = {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  release_url: string;
  published_at: string | null;
  error: string | null;
};

const AUTO_REBUILD_KEY = "ultron.auto_rebuild_on_update";
const DISMISSED_KEY = "ultron.update_banner_dismissed_for";
const UPDATE_HINT =
  "«Actualizar ahora» abre una ventana que recompila ULTRON (~3–5 min); el binario nuevo entra al reiniciar la app.";

function autoRebuildEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_REBUILD_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissedFor(version: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === version;
  } catch {
    return false;
  }
}

function rememberDismissed(version: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // localStorage disabled (private mode, ACL); just don't remember.
  }
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Also do an explicit check on mount — `setup()` in lib.rs already
    // fires one but the listener might not be wired in time. This second
    // pass closes the race; the backend serves a cached HTTP miss so
    // we're not double-hitting GitHub.
    invoke<UpdateInfo>("check_for_updates")
      .then((u) => {
        if (cancelled) return;
        if (u.has_update && u.latest_version) {
          if (autoRebuildEnabled()) {
            void triggerRebuild();
          } else if (!dismissedFor(u.latest_version)) {
            setInfo(u);
          }
        }
      })
      .catch(() => {});

    const unlisten = listen<UpdateInfo>("update-available", (e) => {
      if (cancelled) return;
      const u = e.payload;
      if (!u.has_update || !u.latest_version) return;
      if (autoRebuildEnabled()) {
        void triggerRebuild();
      } else if (!dismissedFor(u.latest_version)) {
        setInfo(u);
        setHidden(false);
      }
    });

    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function triggerRebuild() {
    // Two startup paths can call this (the initial check_for_updates poll
    // and the backend `update-available` event 6 s later). Without this
    // guard both would spawn parallel git-pull + tauri-build processes
    // that race on target/ and corrupt the binary — gemini review v15.4.16.
    if (busy) return;
    setBusy(true);
    try {
      // Same canonical flow as Settings → Recompilar (rebuildFlow): asks
      // first, opens the visible terminal (git pull + npm install + npm run
      // build:local) and reports the outcome or the error app-wide.
      await runRebuildWithFeedback("update-banner");
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    if (info?.latest_version) {
      rememberDismissed(info.latest_version);
    }
    setHidden(true);
  }

  if (!info || hidden) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-3 flex shrink-0 items-center justify-between gap-4 rounded px-4 py-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-accent)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: "var(--color-accent)" }}
        />
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>
            Ya está disponible ULTRON {info.latest_version}; tienes la {info.current_version}.
          </div>
          <div
            className="mt-0.5 truncate text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
            title={UPDATE_HINT}
          >
            {UPDATE_HINT}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={info.release_url}
          target="_blank"
          onClick={handleExternalClick}
          rel="noreferrer noopener"
          className="rounded px-2 py-1 text-[11.5px] underline-offset-2 hover:underline"
          style={{
            background: "transparent",
            color: "var(--color-text-secondary)",
          }}
        >
          Notas de la versión
        </a>
        <button
          type="button"
          onClick={() => void triggerRebuild()}
          disabled={busy}
          className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Lanzando…" : "Actualizar ahora"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Ocultar hasta la próxima versión"
          title="Ocultar hasta la próxima versión"
          className="flex h-6 w-6 items-center justify-center rounded text-[14px]"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export { AUTO_REBUILD_KEY };
