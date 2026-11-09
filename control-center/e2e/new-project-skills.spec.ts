// Asistente "+ Nuevo proyecto": sección de skills de la pool con `invoke` de
// Tauri simulado (window.__TAURI_INTERNALS__). Genera capturas para revisión
// visual en .tmp/audit-2026-10-18/wizard-skills/.

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SHOTS = join(process.cwd(), "..", ".tmp", "audit-2026-10-18", "wizard-skills");

interface MockConfig {
  skills: unknown;
  createSkills?: { name: string; ok: boolean; message: string }[];
  createSteps?: { step: string; ok: boolean; message: string }[];
}

const POOL = [
  { name: "vercel-react-best-practices", license: "MIT", reviewed: true, suggested: true, conditions: "Solo lectura; sin red ni scripts." },
  { name: "web-design-guidelines", license: "Apache-2.0", reviewed: true, suggested: true, conditions: "Contiene scripts auxiliares; revisados línea a línea." },
  { name: "pdf-toolkit", license: "MIT", reviewed: true, suggested: false, conditions: "" },
  { name: "browser-automation-extra", license: null, reviewed: false, suggested: false, conditions: "" },
];

async function installMock(page: Page, cfg: MockConfig) {
  await page.addInitScript((c) => {
    const w = window as unknown as Record<string, unknown>;
    const BS = String.fromCharCode(92);
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => 0,
      unregisterCallback: () => undefined,
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: { args?: string[] }) => {
        if (cmd === "plugin:event|listen") return 0;
        if (cmd === "project_create_cli") {
          const a = args?.args ?? [];
          switch (a[0]) {
            case "roots":
              return { ok: true, roots: [{ id: "personal", label: "Proyectos personales", path: ["C:", "Users", "demo", "proyectos"].join(BS), kind: "personal", exists: true }] };
            case "list":
              return { ok: true, root: "personal", sub: "", entries: [] };
            case "templates":
              return { ok: true, templates: [
                { id: "web-vite-react-ts", label: "Web Vite + React + TS", description: "SPA con Vite", source: "local", requires: [], available: true, kinds: ["personal"] },
                { id: "vacio", label: "Vacío", description: "Carpeta vacía", source: "local", requires: [], available: true, kinds: ["personal"] },
              ] };
            case "skills":
              return c.skills;
            case "create":
              return { ok: true, projectPath: ["C:", "Users", "demo", "proyectos", "demo"].join(BS), projectId: "demo", template: "web-vite-react-ts",
                steps: c.createSteps ?? [], filesCreated: [], skills: c.createSkills ?? [] };
            default:
              return { ok: true };
          }
        }
        if (cmd.startsWith("get_") || cmd.startsWith("list_")) return [];
        return null;
      },
    };
  }, cfg);
}

async function openWizardToOptions(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.locator("text=Proyectos").first().click();
  await page.locator("button", { hasText: "+ Nuevo proyecto" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Proyectos personales/ }).click();
  await dialog.getByRole("button", { name: "Siguiente" }).click(); // carpeta
  await dialog.getByRole("button", { name: "Siguiente" }).click(); // nombre
  await dialog.getByRole("textbox").first().fill("demo");
  await dialog.getByRole("button", { name: "Siguiente" }).click(); // plantilla
  await dialog.getByText("Web Vite + React + TS").click();
  await dialog.getByRole("button", { name: "Siguiente" }).click(); // opciones
  return dialog;
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("pool con 4 entradas: preselecciona las sugeridas y bloquea la sin revisión", async ({ page }) => {
  await installMock(page, { skills: { ok: true, template: "web-vite-react-ts", skills: POOL } });
  const dialog = await openWizardToOptions(page);
  const section = dialog.getByRole("group", { name: "Skills de la pool" });
  await expect(section).toBeVisible();
  const boxes = section.getByRole("checkbox");
  await expect(boxes).toHaveCount(4);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.nth(2)).not.toBeChecked();
  await expect(boxes.nth(3)).not.toBeChecked();
  await expect(boxes.nth(3)).toBeDisabled();
  await expect(boxes.nth(2)).toBeEnabled();
  await page.screenshot({ path: join(SHOTS, "1-pool-con-skills.png") });
});

test("pool vacía: la sección no aparece", async ({ page }) => {
  await installMock(page, { skills: { ok: true, template: "web-vite-react-ts", skills: [] } });
  const dialog = await openWizardToOptions(page);
  await expect(dialog.getByText("Crear CLAUDE.md")).toBeVisible();
  await expect(dialog.getByText("Skills de la pool")).toHaveCount(0);
});

test("pool ilegible: error con Reintentar", async ({ page }) => {
  await installMock(page, { skills: { ok: false, error: { code: "POOL_UNREADABLE", message: "skill-pool.json no es JSON válido (línea 12)" } } });
  const dialog = await openWizardToOptions(page);
  await expect(dialog.getByRole("button", { name: "Reintentar" })).toBeVisible();
  await expect(dialog.getByText(/No se pudo leer la pool de skills/)).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "2-pool-error-reintentar.png") });
});

test("vista final con un link fallido muestra el ErrorBox", async ({ page }) => {
  await installMock(page, {
    skills: { ok: true, template: "web-vite-react-ts", skills: POOL },
    createSkills: [
      { name: "vercel-react-best-practices", ok: true, message: "enlazada" },
      { name: "web-design-guidelines", ok: false, message: "junction: acceso denegado" },
    ],
    createSteps: [
      { step: "mkdir", ok: true, message: "carpeta creada" },
      { step: "template", ok: true, message: "plantilla web-vite-react-ts aplicada" },
      { step: "skill:vercel-react-best-practices", ok: true, message: "enlazada" },
      { step: "skill:web-design-guidelines", ok: false, message: "junction: acceso denegado" },
    ],
  });
  const dialog = await openWizardToOptions(page);
  await dialog.getByRole("button", { name: "Crear proyecto" }).click();
  await expect(dialog.getByText(/No se pudo enlazar: web-design-guidelines/)).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "3-resultado-link-fallido.png") });
});
