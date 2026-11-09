// Escenario del tráiler de ULTRON Sessions: la ventana (mock) va en un iframe
// de 1600x900 centrado sobre un fondo de 1920x1080, con una banda de rótulos
// debajo y una tarjeta a pantalla completa para la entrada y el cierre.
// La captura usa el screencast de CDP (JPEG) en lugar de `recordVideo`,
// que en Playwright graba VP8 a una tasa de bits fija y pierde el texto fino.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const W = 1920;
export const H = 1080;
export const APP_W = 1600;
export const APP_H = 900;

const STAGE_HTML = (src) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#07090b;font-family:"Segoe UI",system-ui,sans-serif}
  body{background:radial-gradient(1200px 600px at 50% 0%,#1a1209 0%,#07090b 60%)}
  #app{position:absolute;left:${(W - APP_W) / 2}px;top:28px;width:${APP_W}px;height:${APP_H}px;border:1px solid #2a2f35;border-radius:10px;
    box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,140,40,.06);background:#000}
  #cap{position:absolute;left:0;right:0;top:${28 + APP_H + 18}px;text-align:center;opacity:0;transition:opacity .35s ease}
  #cap.on{opacity:1}
  #cap .k{color:#ff8a2a;font:600 15px/1 "Cascadia Code",Consolas,monospace;letter-spacing:.18em;text-transform:uppercase}
  #cap .t{color:#f2f2f2;font:600 38px/1.25 "Segoe UI",system-ui,sans-serif;margin-top:10px}
  #card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    background:radial-gradient(900px 500px at 50% 45%,#1d1309 0%,#07090b 70%);opacity:0;transition:opacity .5s ease;pointer-events:none}
  #card.on{opacity:1}
  #card .brand{font:700 26px/1 "Cascadia Code",Consolas,monospace;letter-spacing:.32em;color:#ff8a2a}
  #card .h{font:700 96px/1 "Segoe UI",system-ui,sans-serif;color:#fff;letter-spacing:-.02em}
  #card .s{font:400 32px/1.3 "Segoe UI",system-ui,sans-serif;color:#b9bec4;max-width:1300px;text-align:center}
  #card .f{font:500 20px/1 "Cascadia Code",Consolas,monospace;color:#6f767d;margin-top:22px}
</style></head><body>
<iframe id="app" src="${src}"></iframe>
<div id="cap"><div class="k"></div><div class="t"></div></div>
<div id="card"><div class="brand">ULTRON</div><div class="h"></div><div class="s"></div><div class="f"></div></div>
</body></html>`;

/** Monta el escenario y espera a que el mock pinte el primer mensaje. */
export async function mountStage(page, src) {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(STAGE_HTML(src));
  const frame = await appFrame(page);
  await frame.waitForSelector(".msg", { timeout: 30000 });
  return frame;
}

export async function appFrame(page) {
  const handle = await page.waitForSelector("#app");
  return handle.contentFrame();
}

/** Recarga solo la app (p. ej. tras cambiar el tema en localStorage). */
export async function reloadApp(page) {
  await page.evaluate(() => {
    const f = document.getElementById("app");
    f.src = f.src;
  });
  await page.waitForTimeout(150);
  const frame = await appFrame(page);
  await frame.waitForSelector(".msg", { timeout: 30000 });
  return frame;
}

export async function caption(page, kicker, title) {
  await page.evaluate(([k, t]) => {
    const c = document.getElementById("cap");
    c.querySelector(".k").textContent = k;
    c.querySelector(".t").textContent = t;
    c.classList.toggle("on", Boolean(t));
  }, [kicker, title]);
}

export async function card(page, { h = "", s = "", f = "" } = {}) {
  await page.evaluate(([hh, ss, ff]) => {
    const c = document.getElementById("card");
    c.querySelector(".h").textContent = hh;
    c.querySelector(".s").textContent = ss;
    c.querySelector(".f").textContent = ff;
    c.classList.toggle("on", Boolean(hh));
  }, [h, s, f]);
}

/**
 * Graba un tramo con el screencast de CDP. El screencast solo emite cuadros
 * cuando la imagen cambia: cada cuadro dura hasta el siguiente y el último
 * hasta el final del tramo (lista para el demuxer `concat` de ffmpeg).
 */
export async function recordSegment(page, dir, run) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, ts: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  const start = Date.now() / 1000;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await run();
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(100);
  await cdp.detach();
  if (frames.length === 0) throw new Error(`sin cuadros en ${dir}`);
  const lines = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : end;
    const from = i === 0 ? Math.min(f.ts, start) : f.ts;
    lines.push(`file '${f.file.replace(/\\/g, "/")}'`, `duration ${Math.max(next - from, 0.001).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file.replace(/\\/g, "/")}'`);
  const list = join(dir, "list.txt");
  writeFileSync(list, `${lines.join("\n")}\n`);
  return { list, seconds: end - start, frames: frames.length };
}

/** Captura fija de la app sola (1600x900) para la web. */
export async function still(page, file) {
  await page.locator("#app").screenshot({ path: file });
}
