// Capturas de la ventana «ULTRON Sessions» en modo mock: cada tema y las
// piezas de la v0.2 (paleta, HUD con desplegable, historial y pestañas nuevas).
// Uso: node scripts/sesiones-capturas.mjs [baseURL] (requiere el servidor de Vite en marcha).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:1420";
const out = "docs/sesiones/capturas";
mkdirSync(out, { recursive: true });

const themes = [
  { theme: "obsidiana", w: 1440, h: 900 },
  { theme: "vacio", w: 1440, h: 900 },
  { theme: "fosforo", w: 1440, h: 900 },
  { theme: "acero", w: 1440, h: 900 },
  { theme: "obsidiana", w: 900, h: 700 },
];

/** Escenas de interacción sobre Obsidiana: nombre y pasos. */
const scenes = [
  {
    name: "paleta",
    async run(page) {
      const box = page.getByRole("textbox", { name: "Mensaje" }).first();
      await box.click();
      await box.fill("/");
      await page.getByRole("listbox", { name: "Comandos" }).waitFor();
    },
  },
  {
    name: "hud-modelo",
    async run(page) {
      await page.getByTestId("hud-model").first().click();
      await page.getByRole("listbox", { name: "Modelo" }).waitFor();
    },
  },
  {
    name: "hud-contexto",
    async run(page) {
      await page.getByTestId("hud-context").first().click();
      await page.getByRole("dialog", { name: "Contexto" }).waitFor();
    },
  },
  {
    name: "historial",
    async run(page) {
      const box = page.getByRole("textbox", { name: "Mensaje" }).first();
      await box.click();
      await box.press("Control+r");
      await page.getByRole("dialog", { name: "Buscar en el historial" }).waitFor();
      await page.keyboard.type("columnas");
    },
  },
  {
    name: "consejos",
    async run(page) {
      const box = page.getByRole("textbox", { name: "Mensaje" }).first();
      await box.click();
      await box.fill("arregla esto");
      await page.getByTestId("prompt-tips").waitFor();
    },
  },
  { name: "motores", tab: "Motores" },
  { name: "kanban", tab: "Kanban" },
  { name: "mods", tab: "Mods" },
  { name: "hooks", tab: "Hooks" },
  { name: "bitacora", tab: "Bitácora" },
];

async function open(browser, theme, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => {
    localStorage.setItem("ultron.sesiones.theme", t);
    localStorage.removeItem("ultron.sesiones.workspace");
    localStorage.removeItem("ultron.sesiones.inspector");
  }, theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${theme}] pageerror:`, e.message));
  await page.goto(`${base}/sesiones.html?mock=1`);
  await page.waitForSelector(".msg");
  return { ctx, page };
}

const browser = await chromium.launch();
for (const s of themes) {
  const { ctx, page } = await open(browser, s.theme, s.w, s.h);
  await page.waitForTimeout(Number(process.env.WAIT ?? 2600));
  const file = `${out}/sesiones-${s.theme}-${s.w}x${s.h}.png`;
  await page.screenshot({ path: file });
  console.log(file);
  await ctx.close();
}
for (const sc of scenes) {
  const { ctx, page } = await open(browser, "obsidiana", 1440, 900);
  // Se espera a que termine la respuesta inicial de la demo para que no tape la escena.
  await page.locator(".send.stop").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
  if (sc.tab) {
    await page.getByRole("tab", { name: sc.tab, exact: true }).click();
    await page.waitForTimeout(500);
  } else {
    await sc.run(page);
    await page.waitForTimeout(300);
  }
  const file = `${out}/sesiones-v2-${sc.name}.png`;
  await page.screenshot({ path: file });
  console.log(file);
  await ctx.close();
}
await browser.close();
