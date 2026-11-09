// Captura de sondeo del mock de Sessions: una imagen y el árbol de roles
// accesibles para guionizar las escenas del tráiler.
// Uso: node scripts/trailer/probe.mjs [baseURL] [salida.png]
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:1420";
const out = process.argv[3] ?? "../tmp/trailer/probe.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  localStorage.setItem("ultron.sesiones.theme", "obsidiana");
  localStorage.removeItem("ultron.sesiones.workspace");
  localStorage.removeItem("ultron.sesiones.inspector");
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(`${base}/sesiones.html?mock=1`);
await page.waitForSelector(".msg");
await page.locator(".send.stop").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
await page.screenshot({ path: out });
const tabs = await page.getByRole("tab").allInnerTexts();
const buttons = await page.getByRole("button").evaluateAll((els) =>
  els.map((e) => e.getAttribute("aria-label") || e.textContent?.trim()).filter(Boolean).slice(0, 80),
);
console.log(JSON.stringify({ tabs, buttons }, null, 1));
await browser.close();
