// mar.ia — el orbe.
//
// Ventana pequena, sin marco y transparente: solo el blob y una linea de
// estado. Es la cara del asistente; el resto de la aplicacion (memoria,
// skills, MCPs, terminales, conversaciones) vive en la ventana principal,
// que se abre con doble clic.
//
// El microfono NO se abre aqui. Lo posee el sidecar de voz, que es quien hace
// palabra clave -> VAD -> transcripcion -> modelo local -> voz; el orbe solo
// recibe su estado y su nivel de audio por eventos. Dos duenos del microfono
// serian dos capturas simultaneas y una pelea por el dispositivo.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FRAG_SRC, ORB_STATE, VERT_SRC, type OrbState } from "./blobShader";

/** Texto bajo el orbe por estado. Corto: la ventana es pequena. */
const STATE_LABEL: Record<OrbState, string> = {
  idle: "di «María»",
  listening: "te escucho",
  thinking: "pensando",
  speaking: "hablando",
};

type OrbEvent = { state?: OrbState; amp?: number; text?: string };

export function MariaOrb() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>("idle");
  const ampRef = useRef(0);
  const [label, setLabel] = useState<string>(STATE_LABEL.idle);
  const [caption, setCaption] = useState<string>("");
  const [glError, setGlError] = useState<string | null>(null);

  // --- ciclo de vida del sidecar de voz -----------------------------------
  // Arranca con el orbe y se para al cerrarlo: el microfono no se queda en
  // manos de un proceso invisible cuando la cara no esta en pantalla.
  useEffect(() => {
    void invoke("maria_voice_start").catch((e) => setCaption(`voz: ${String(e)}`));
    return () => {
      void invoke("maria_voice_stop").catch(() => undefined);
    };
  }, []);

  // --- eventos del sidecar de voz -----------------------------------------
  useEffect(() => {
    const un = listen<OrbEvent>("maria:voice", (e) => {
      const p = e.payload ?? {};
      if (p.state && p.state in STATE_LABEL) {
        stateRef.current = p.state;
        setLabel(STATE_LABEL[p.state]);
      }
      if (typeof p.amp === "number") {
        ampRef.current = Math.max(0, Math.min(1, p.amp));
      }
      // `text` es lo ultimo transcrito o dicho: se muestra como subtitulo.
      if (typeof p.text === "string") setCaption(p.text.slice(0, 120));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // --- render WebGL --------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setGlError("Sin WebGL2: el orbe no puede dibujarse.");
      return;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("createShader devolvio null");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? "shader sin log");
      }
      return sh;
    };

    let program: WebGLProgram | null = null;
    try {
      program = gl.createProgram();
      if (!program) throw new Error("createProgram devolvio null");
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT_SRC));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? "link sin log");
      }
    } catch (e) {
      setGlError(String(e));
      return;
    }

    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Dos triangulos que cubren el viewport.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uAmp = gl.getUniformLocation(program, "uAmp");
    const uState = gl.getUniformLocation(program, "uState");

    let raf = 0;
    const t0 = performance.now();
    // Amplitud suavizada: el valor crudo del sidecar llega a saltos y el blob
    // daria tirones.
    let smooth = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const frame = () => {
      resize();
      smooth += (ampRef.current - smooth) * 0.15;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.uniform1f(uAmp, smooth);
      gl.uniform1f(uState, ORB_STATE[stateRef.current]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteBuffer(buf);
      if (program) gl.deleteProgram(program);
    };
  }, []);

  return (
    <div
      // Toda la ventana es zona de arrastre: no hay barra de titulo que agarrar.
      data-tauri-drag-region
      // Clic: hablar. Clic derecho: abrir la aplicacion completa. Arrastrar:
      // mover el orbe. Sin menus: la ventana mide 260 px.
      onClick={() => {
        if (stateRef.current === "listening") {
          void invoke("maria_voice_cancel").catch(() => undefined);
          return;
        }
        void invoke("maria_voice_listen").catch((e) => setCaption(String(e)));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void invoke("maria_open_main").catch(() => undefined);
      }}
      title="Clic: hablar · Clic derecho: abrir mar.ia · Arrastra para mover"
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        userSelect: "none",
        cursor: "default",
      }}
    >
      {glError ? (
        <p style={{ color: "var(--color-danger)", fontSize: 12, padding: "0 1rem", textAlign: "center" }}>
          {glError}
        </p>
      ) : (
        <canvas
          ref={canvasRef}
          // pointerEvents none: los clics son para arrastrar la ventana.
          style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
        />
      )}

      <div
        style={{
          position: "absolute",
          bottom: 14,
          width: "100%",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.04em", color: "rgba(190,225,255,0.85)" }}>
          {label}
        </p>
        {caption && (
          <p
            style={{
              margin: "2px 12px 0",
              fontSize: 10,
              lineHeight: 1.3,
              color: "rgba(150,190,225,0.7)",
              overflowWrap: "anywhere",
            }}
          >
            {caption}
          </p>
        )}
      </div>
    </div>
  );
}
