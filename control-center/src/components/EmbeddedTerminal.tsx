// ULTRON Control Center 2.0 — Embedded xterm.js terminal
//
// Mounts xterm into a div, subscribes to `pty:data:<sessionId>` and
// `pty:exit:<sessionId>` Tauri events, forwards keystrokes via `pty_write`,
// and resizes on ResizeObserver.

import { useEffect, useRef } from "react";
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
    const safeFit = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        fit.fit();
        void invoke("pty_resize", {
          sessionId,
          rows: term.rows,
          cols: term.cols,
        });
      } catch {
        // Transient: container not laid out yet. ResizeObserver will retry.
      }
    };
    const initialFitFrame = requestAnimationFrame(safeFit);

    // Forward keystrokes.
    const dataDispose = term.onData((data) => {
      // data is a JS string in UTF-16; encode to bytes then base64.
      const bytes = new TextEncoder().encode(data);
      const b64 = BASE64.encode(bytes);
      void invoke("pty_write", { sessionId, data: b64 });
    });

    // Listen for chunks.
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
    })();

    // Resize on container change. Same proposeDimensions guard as initial
    // fit — observers fire during teardown / zero-size transitions too.
    const resizeObserver = new ResizeObserver(() => {
      safeFit();
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(initialFitFrame);
      resizeObserver.disconnect();
      dataDispose.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, onExit]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#0d0d11]"
      style={{ minHeight: 200 }}
    />
  );
}
