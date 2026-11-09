// Tráiler y capturas de ULTRON Sessions (mock + Playwright + ffmpeg).
// Uso (con Vite en marcha): node scripts/trailer/record.mjs [baseURL]
// Salida: docs/web/media/sesiones/{trailer.mp4,poster.jpg,*.png} en la raíz del repo.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { card, caption, mountStage, recordSegment, still as shot } from "./stage.mjs";
import { CODEX_SCENE, SCENES, THEMES, themeCut } from "./scenes.mjs";

const base = process.argv[2] ?? "http://localhost:1420";
const work = resolve("../tmp/trailer");
const media = resolve("../docs/web/media/sesiones");
const FADE = 0.35;

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(media, { recursive: true });

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

/** Codifica un tramo a H.264 30 fps con fundido de entrada y salida. */
function encode(seg, out) {
  const d = seg.seconds;
  const vf = `fps=30,format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${Math.max(d - FADE, 0).toFixed(3)}:d=${FADE}`;
  ffmpeg(["-f", "concat", "-safe", "0", "-i", seg.list, "-vf", vf, "-t", d.toFixed(3), "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-r", "30", out]);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  try {
    if (!location.href.includes("sesiones.html")) return;
    if (!sessionStorage.getItem("trailer.init")) {
      sessionStorage.setItem("trailer.init", "1");
      localStorage.setItem("ultron.sesiones.theme", "obsidiana");
      localStorage.removeItem("ultron.sesiones.workspace");
      localStorage.removeItem("ultron.sesiones.inspector");
    }
  } catch {
    /* about:blank del escenario no tiene almacenamiento */
  }
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
let frame = await mountStage(page, `${base}/sesiones.html?mock=1`);
await frame.locator(".send.stop").first().waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);

const segments = [];
let n = 0;
async function scene(name, run) {
  const seg = await recordSegment(page, join(work, `${String(n).padStart(2, "0")}-${name}`), run);
  const out = join(work, `${String(n).padStart(2, "0")}-${name}.mp4`);
  encode(seg, out);
  segments.push(out);
  console.log(`${name}: ${seg.seconds.toFixed(1)} s, ${seg.frames} cuadros`);
  n += 1;
}
const still = (file) => shot(page, join(media, file));

await scene("entrada", async () => {
  await card(page, { h: "ULTRON Sessions", s: "Claude Code con ventana propia: la CLI real, presentada como un chat" });
  await page.waitForTimeout(3600);
  await card(page);
  await page.waitForTimeout(500);
});

for (const sc of [CODEX_SCENE, ...SCENES]) {
  await scene(sc.name, async () => {
    await caption(page, sc.kicker, sc.title);
    await page.waitForTimeout(400);
    await sc.run(page, frame, still);
    await caption(page, "", "");
    await page.waitForTimeout(350);
  });
}

const themeShots = [];
await scene("temas", async () => {
  await caption(page, "Temas", "Siete temas, del negro puro al ámbar");
  for (const t of THEMES) {
    frame = await themeCut(page, t);
    await page.waitForTimeout(950);
    if (themeShots.length < 4) {
      const file = join(work, `tema-${t}.png`);
      await shot(page, file);
      themeShots.push(file);
    }
  }
  await caption(page, "", "");
  await page.waitForTimeout(350);
});

await scene("cierre", async () => {
  await card(page, { h: "ULTRON Sessions", s: "Parte de ULTRON Control Center", f: "Tauri 2 · React 19 · Rust" });
  await page.waitForTimeout(3800);
});
await browser.close();

// Lámina de temas 2x2 para la web.
ffmpeg([
  ...themeShots.flatMap((f) => ["-i", f]),
  "-filter_complex", "[0][1]hstack[a];[2][3]hstack[b];[a][b]vstack,scale=1600:-1",
  join(media, "temas.png"),
]);

const list = join(work, "segments.txt");
writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
const trailer = join(media, "trailer.mp4");
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", trailer]);
ffmpeg(["-ss", "6", "-i", trailer, "-frames:v", "1", "-q:v", "3", join(media, "poster.jpg")]);
console.log(trailer);
