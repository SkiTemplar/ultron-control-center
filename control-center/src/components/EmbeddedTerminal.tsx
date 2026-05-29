// ULTRON Control Center 2.0 — Embedded xterm.js terminal
//
// Mounts xterm into a div, subscribes to `pty:data:<sessionId>` and
// `pty:exit:<sessionId>` Tauri events, forwards keystrokes via `pty_write`,
// and resizes on ResizeObserver.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import "xterm/css/xterm.css";
import type { PtyDataEvent, PtyExitEvent } from "../types";

type Props = {
  sessionId: string;
  onExit?: (code: number) => void;
};

// Active-CLI badge styling by provider (card-vis-cli-model-indicator).
// Colours per the card: Anthropic naranja, Google azul, OpenAI verde.
const PROVIDER_BADGE: Record<
  string,
  { label: string; bg: string; color: string; border: string }
> = {
  claude: { label: "Claude Code", bg: "rgba(217,119,87,0.16)", color: "#e0996f", border: "rgba(217,119,87,0.4)" },
  codex: { label: "Codex", bg: "rgba(34,197,94,0.14)", color: "#4ade80", border: "rgba(34,197,94,0.38)" },
  gemini: { label: "Gemini", bg: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "rgba(59,130,246,0.38)" },
};

const BASE64 = {
  // Decode to Uint8Array (not a JS string) so xterm.write receives raw
  // bytes. atob() returns a binary string where each char is one byte —
  // if we hand that to term.write directly, xterm treats each char as a
  // UTF-16 code point and any UTF-8 multibyte sequence (acentos, emojis,
  // box-drawing characters used by Claude/Codex/Gemini TUIs) is broken
  // into garbage. xterm decodes UTF-8 internally when given a Uint8Array.
  decode: (s: string): Uint8Array => {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },
  encode: (bytes: Uint8Array): string => {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
};

export default function EmbeddedTerminal({ sessionId, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

  // Fetch the session's active CLI once so the badge can show which provider
  // is running in this terminal (card-vis-cli-model-indicator). Best-effort:
  // on any failure the badge simply doesn't render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke<{ provider?: string } | null>("pty_summary", { sessionId });
        if (!cancelled) setProvider(s?.provider ?? null);
      } catch {
        if (!cancelled) setProvider(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Theme matches the dark CSS vars of the Control Center.
    const term = new Terminal({
      fontFamily: "JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#0d0d11",
        foreground: "#e5e5e7",
        cursor: "#e5e5e7",
        selectionBackground: "#3b3b46",
      },
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // v2.6 bug fix: WebGL addon disabled — multiple EmbeddedTerminals in
    // the same window (split-pane, second Claude session) contended for
    // the WebGL context and left subsequent panes blank. Canvas renderer
    // is enough for our line counts and renders reliably across instances.
    const webgl: WebglAddon | null = null as WebglAddon | null;

    term.open(container);
    termRef.current = term;

    // v2.5.1 — defer the initial fit() to the next animation frame. When
    // mounted inside a split-pane that has zero measured dimensions on the
    // first synchronous tick, FitAddon.proposeDimensions returns undefined
    // and dereferencing `.dimensions` throws. rAF + safety guard fixes it.
    //
    // v2.6.1 P0 bug fix (continued): also retry the fit on a 100ms timer
    // until proposeDimensions returns valid cols/rows. ResizeObserver fires
    // only when the container size *changes*; if the container is sized
    // synchronously by the parent's flex layout before mount, the observer
    // may not fire again and we'd never resize the PTY past the default
    // 30x120. The timer self-clears on the first successful fit.
    let fitRetryTimer: number | null = null;
    let didFirstSuccessfulFit = false;
    const safeFit = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return false;
        fit.fit();
        void invoke("pty_resize", {
          sessionId,
          rows: term.rows,
          cols: term.cols,
        });
        didFirstSuccessfulFit = true;
        return true;
      } catch {
        // Transient: container not laid out yet. ResizeObserver / timer will retry.
        return false;
      }
    };
    const initialFitFrame = requestAnimationFrame(() => {
      if (safeFit()) return;
      // Container still has no measurable size — poll for up to ~3s.
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        if (didFirstSuccessfulFit) return;
        if (safeFit()) return;
        if (attempts >= 30) return;
        fitRetryTimer = window.setTimeout(tick, 100);
      };
      fitRetryTimer = window.setTimeout(tick, 100);
    });

    // Copy selection to clipboard on mouse-up (xterm v5 has no built-in copyOnSelect).
    const selDispose = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
    });

    // Windows Terminal-style copy/paste. xterm.js by default forwards every
    // keystroke to the PTY, so Ctrl+C arrives as \x03 (SIGINT) and Ctrl+V as
    // \x16 (literal). On Windows users expect Ctrl+C/Ctrl+V (plus the Shift
    // variants and Ctrl+Insert/Shift+Insert) to do clipboard ops in terminal
    // UIs. We intercept at the DOM key event layer BEFORE xterm emits onData:
    //   - Ctrl+C  : if there's a selection, copy + swallow. Otherwise fall
    //               through (xterm sends SIGINT to the PTY).
    //   - Ctrl+V  : read clipboard, write to PTY. Always swallowed.
    //   - Ctrl+Shift+C / Ctrl+Insert  : force copy.
    //   - Ctrl+Shift+V / Shift+Insert : alias for paste.
    // Returning `false` from attachCustomKeyEventHandler tells xterm NOT to
    // process the event further (no onData emission, no default scroll).
    const writeToPty = (text: string) => {
      if (!text) return;
      const bytes = new TextEncoder().encode(text);
      void invoke("pty_write", { sessionId, data: BASE64.encode(bytes) });
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const isCtrl = event.ctrlKey && !event.altKey && !event.metaKey;
      if (!isCtrl) return true;
      const key = event.key;
      const code = event.code;

      const isPaste =
        key === "v" || key === "V" || code === "KeyV" ||
        (event.shiftKey && (key === "Insert" || code === "Insert"));
      if (isPaste) {
        void navigator.clipboard.readText().then(writeToPty).catch(() => {});
        event.preventDefault();
        return false;
      }

      const isForceCopy =
        (event.shiftKey && (key === "C" || code === "KeyC")) ||
        (!event.shiftKey && (key === "Insert" || code === "Insert"));
      if (isForceCopy) {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        event.preventDefault();
        return false;
      }

      const isCtrlC = !event.shiftKey && (key === "c" || key === "C" || code === "KeyC");
      if (isCtrlC) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          term.clearSelection();
          event.preventDefault();
          return false;
        }
        return true;
      }
      return true;
    });

    // Forward keystrokes.
    const dataDispose = term.onData((data) => {
      // data is a JS string in UTF-16; encode to bytes then base64.
      const bytes = new TextEncoder().encode(data);
      const b64 = BASE64.encode(bytes);
      void invoke("pty_write", { sessionId, data: b64 });
    });

    // Listen for chunks.
    //
    // v2.6.1 P0 bug fix: the backend now holds live emission until the
    // frontend calls `pty_replay`. Ordering:
    //   1. register `pty:data` and `pty:exit` listeners (idempotent IPC).
    //   2. call `pty_replay` — atomically returns the captured buffer
    //      AND flips the session's `subscribed` flag under the registry
    //      mutex, so the reader thread starts emitting live events for
    //      every chunk produced after this point. No chunk can be both
    //      buffered and emitted (mutex guarantees the transition is
    //      observed by the reader before the next read iteration).
    //   3. write the replay bytes to xterm — this is the entire initial
    //      TUI paint that the previous build lost into the void.
    // From now on, the listener handler writes live chunks directly.
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    (async () => {
      unlistenData = await listen<PtyDataEvent>(
        `pty:data:${sessionId}`,
        (event) => {
          const bytes = BASE64.decode(event.payload.data);
          term.write(bytes);
        },
      );
      unlistenExit = await listen<PtyExitEvent>(
        `pty:exit:${sessionId}`,
        (event) => {
          term.write(
            `\r\n[process exited with code ${event.payload.exit_code}]\r\n`,
          );
          if (onExit) onExit(event.payload.exit_code);
        },
      );
      try {
        const b64 = (await invoke("pty_replay", { sessionId })) as string;
        if (b64) {
          const bytes = BASE64.decode(b64);
          if (bytes.length > 0) term.write(bytes);
        }
      } catch (e) {
        // Replay is best-effort — surface as a transient warning but
        // keep the terminal usable; live events will still flow.
        // eslint-disable-next-line no-console
        console.warn("pty_replay failed", e);
      }
    })();

    // Resize on container change. Same proposeDimensions guard as initial
    // fit — observers fire during teardown / zero-size transitions too.
    const resizeObserver = new ResizeObserver(() => {
      safeFit();
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(initialFitFrame);
      if (fitRetryTimer !== null) window.clearTimeout(fitRetryTimer);
      resizeObserver.disconnect();
      selDispose.dispose();
      dataDispose.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, onExit]);

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (!text || !termRef.current) return;
    const bytes = new TextEncoder().encode(text);
    void invoke("pty_write", { sessionId, data: BASE64.encode(bytes) });
  };

  const badge = provider ? PROVIDER_BADGE[provider] : undefined;

  return (
    <div className="relative h-full w-full" style={{ minHeight: 200 }}>
      {badge && (
        <div
          className="pointer-events-none absolute right-2 top-1 z-10 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}
          title={`CLI activo: ${badge.label}`}
        >
          {badge.label}
        </div>
      )}
      <div
        ref={containerRef}
        className="h-full w-full bg-[#0d0d11]"
        style={{ minHeight: 200 }}
        onPaste={handlePaste}
      />
    </div>
  );
}
