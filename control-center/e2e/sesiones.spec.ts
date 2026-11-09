import { expect, test, type Page } from "@playwright/test";

// Ventana «ULTRON Sessions» en modo mock (contratos v0.1 y v0.2): chat de
// terminal, HUD con desplegables, historial, paleta, consejos, motores en el
// hilo, pestañas nuevas del inspector y estados de arranque y diálogo.

async function openMock(page: Page, query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/sesiones.html?mock=1${query}`);
  await expect(page.locator(".app[data-mock='1']")).toBeVisible();
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Mensaje" }).first();

/** Opción del Dropdown por su etiqueta exacta (el nombre accesible incluye la descripción). */
const option = (page: Page, label: string) =>
  page.getByRole("option").filter({ has: page.locator(".dd-label", { hasText: new RegExp(`^${label}$`) }) });

/** La demo arranca respondiendo; se espera a que la sesión quede libre. */
async function waitIdle(page: Page) {
  await expect(page.locator(".send.stop")).toHaveCount(0, { timeout: 20000 });
}

test.beforeEach(async ({ page }) => {
  // Limpia la disposición y el tema solo en la primera carga (las recargas conservan).
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-limpio")) return;
    sessionStorage.setItem("e2e-limpio", "1");
    localStorage.removeItem("ultron.sesiones.workspace");
    localStorage.removeItem("ultron.sesiones.theme");
    localStorage.removeItem("ultron.sesiones.inspector");
  });
});

test("abre ULTRON Sessions con chat de terminal, HUD e inspector", async ({ page }) => {
  await openMock(page);
  await expect(page).toHaveTitle(/ULTRON Sessions/);
  await expect(page.locator(".brand")).toHaveText("ULTRON Sessions");
  await expect(page.getByRole("complementary", { name: "Sesiones" }).locator(".sess")).not.toHaveCount(0);
  await expect(page.locator(".msg.user .mk.prompt").first()).toHaveText("❯");
  await expect(page.locator(".msg.assistant .mk.reply").first()).toHaveText("⏺");
  await expect(page.locator(".tl-res .mk.res").first()).toHaveText("⎿");
  await expect(page.locator(".md table").first()).toBeVisible();
  await expect(page.getByTestId("statusline").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Agentes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "acero");
  // Sin <select> nativos: todo pasa por el Dropdown propio.
  await expect(page.locator("select")).toHaveCount(0);
});

test("el turno pliega sus herramientas y se despliegan con la línea de actividad", async ({ page }) => {
  await openMock(page);
  await expect(page.locator(".tool-row[aria-expanded]")).toHaveCount(0);
  const activity = page.locator(".activity").first();
  await activity.scrollIntoViewIfNeeded();
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await activity.click();
  await expect(activity).toHaveAttribute("aria-expanded", "true");
  const tool = page.locator(".tool-row[aria-expanded]").first();
  await tool.scrollIntoViewIfNeeded();
  await expect(tool).toHaveAttribute("aria-expanded", "false");
  await tool.click();
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".tool-body").first()).toBeVisible();
});

test("envía un prompt y responde el permiso", async ({ page }) => {
  await openMock(page);
  await waitIdle(page);
  const box = composer(page);
  await box.fill("Pide permiso y ajusta el ancho mínimo a 24 columnas");
  await box.press("Enter");
  await expect(page.locator(".msg.user").last()).toContainText("Pide permiso y ajusta el ancho mínimo a 24 columnas");
  await expect(page.getByTestId("live-bubble")).toBeVisible();

  const ask = page.getByTestId("ask-permission");
  await expect(ask).toBeVisible({ timeout: 20000 });
  await ask.getByRole("button", { name: "Permitir", exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator(".msg.assistant").last()).toContainText("Commit creado", { timeout: 20000 });
});

test("ajustes: cambia tema y escala y los persiste", async ({ page }) => {
  await openMock(page);
  await page.getByRole("button", { name: "Ajustes" }).click();
  const dialog = page.getByRole("dialog", { name: "Ajustes" });
  await dialog.getByRole("button", { name: "Fósforo" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fosforo");
  await dialog.getByRole("button", { name: "110 %" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fosforo");
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("zoom"))).toBe("1.1");
});

test("/mejorar deja el prompt mejorado en el composer sin enviarlo", async ({ page }) => {
  await openMock(page);
  const box = page.locator("textarea").first();
  await box.fill("/mejorar arregla el login");
  await page.keyboard.press("Escape");
  await box.press("Enter");
  await expect(box).toHaveValue(/Objetivo: arregla el login/);
});

test("divide el espacio de trabajo en dos paneles", async ({ page }) => {
  await openMock(page);
  await expect(page.locator(".grid > .pane")).toHaveCount(1);
  await page.getByRole("button", { name: /Dividir/ }).click();
  await expect(page.locator(".grid > .pane")).toHaveCount(2);
  await expect(page.locator(".grid")).toHaveAttribute("data-split", "h");
  await expect(page.locator(".grid > .pane").nth(1).getByTestId("ask-permission")).toBeVisible();
  await page.keyboard.press("Control+1");
  await expect(page.locator(".grid > .pane").first()).toHaveAttribute("data-focused", "true");
});

test("paleta / con recomendados y adjunto arrastrado", async ({ page }) => {
  await openMock(page);
  const box = composer(page);
  await box.fill("/");
  const palette = page.getByRole("listbox", { name: "Comandos" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("group", { name: "Recomendados" })).toContainText("/commit");
  // Tab completa el comando resaltado; Enter ejecuta uno sin argumentos obligatorios
  // (`runsOnEnter` en Composer.tsx) y deja el composer vacío.
  await box.fill("/comp");
  await box.press("Tab");
  await expect(box).toHaveValue(/^\/(compilar|compact) $/);
  await box.fill("/comp");
  await box.press("Enter");
  await expect(palette).toBeHidden();
  await expect(box).toHaveValue("");

  await page.locator(".cbox").first().evaluate((el) => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "captura.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const chip = page.locator(".att").first();
  await expect(chip).toContainText("captura.png");
  await expect(page.getByTestId("hud-attach").first()).toContainText("1");
  await chip.getByRole("button", { name: "Quitar captura.png" }).click();
  await expect(page.locator(".att")).toHaveCount(0);
});

test("historial con ↑/↓ que conserva el borrador y Ctrl+R", async ({ page }) => {
  await openMock(page);
  const box = composer(page);
  await box.fill("borrador a medias");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("¿Y en 80 columnas cómo queda? Enséñamelo.");
  await box.press("ArrowUp");
  await expect(box).toHaveValue(/El panel de uso se corta/);
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await expect(box).toHaveValue("borrador a medias");

  await box.press("Control+r");
  const search = page.getByRole("dialog", { name: "Buscar en el historial" });
  await expect(search).toBeVisible();
  await page.keyboard.type("sombras");
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(box).toHaveValue(/Las sombras tienen acné/);
});

// Bajo carga el fotograma de `moveCaretToEnd` llegaba tras abrir la búsqueda y le robaba el
// foco: «sombras» se escribía en el borrador y Enter lo mandaba a la cola. Aquí se retrasa
// el fotograma para que la carrera ocurra siempre.
test("Ctrl+R justo tras ↑: lo escrito va a la búsqueda aunque el fotograma llegue tarde", async ({ page }) => {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => window.setTimeout(() => raf(cb), 150);
  });
  await openMock(page);
  const box = composer(page);
  await box.fill("borrador a medias");
  await box.press("ArrowUp");
  await box.press("Control+r");
  const search = page.getByRole("dialog", { name: "Buscar en el historial" });
  await expect(search).toBeVisible();
  await page.keyboard.type("sombras", { delay: 60 });
  await expect(search.getByRole("textbox")).toHaveValue("sombras");
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(box).toHaveValue(/Las sombras tienen acné/);
  await expect(page.getByTestId("queue-item")).toHaveCount(0);
});

test("el composer no muestra consejos de prompting", async ({ page }) => {
  await openMock(page);
  await composer(page).fill("arregla esto");
  await expect(page.getByTestId("prompt-tips")).toHaveCount(0);
});

test("el HUD cambia el modelo con el teclado y avisa si el effort no aplica", async ({ page }) => {
  await openMock(page);
  const model = page.getByTestId("hud-model").first();
  await model.focus();
  await model.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Modelo" });
  await expect(list).toBeFocused();
  await list.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(model).toBeFocused();

  await model.press("ArrowDown");
  // End va a la última opción: Haiku 5.5 desde el 2026-10-21.
  await page.getByRole("listbox", { name: "Modelo" }).press("End");
  await page.getByRole("listbox", { name: "Modelo" }).press("Enter");
  await expect(model).toContainText("Haiku 5.5");

  await page.getByTestId("hud-effort").first().click();
  await option(page, "max").click();
  await expect(page.locator(".toast")).toContainText("solo se aplica a sesiones nuevas");
});

test("Codex y Gemini intervienen en el hilo y se traen a Claude", async ({ page }) => {
  await openMock(page);
  await waitIdle(page);
  const blocks = page.getByTestId("engine-block");
  const before = await blocks.count();

  await page.getByTestId("send-target").first().click();
  await option(page, "Codex").click();
  const box = composer(page);
  await box.fill("Revisa el caso de 0 columnas");
  await box.press("Enter");
  await expect(blocks).toHaveCount(before + 1);
  const fresh = blocks.filter({ hasText: "Revisa el caso de 0 columnas" });
  await expect(fresh.getByRole("button", { name: "Traer a Claude" })).toBeVisible({ timeout: 10000 });
  await fresh.getByRole("button", { name: "Traer a Claude" }).click();
  await expect(page.locator(".msg.user").last()).toContainText("Resultado de Codex traído a Claude");
  await expect(page.locator(".msg.user").last()).not.toContainText("¿Lo integras?");
  await expect(fresh.getByRole("button", { name: "Traer a Claude" })).toHaveCount(0);
  await expect(fresh).toContainText("Traído a Claude");

  await page.locator(".turn-acts").first().getByRole("button", { name: "→ Gemini" }).click();
  await expect(page.locator(".msg.engine[data-engine='gemini']")).toHaveCount(2);
  await fresh.getByRole("button", { name: "Descartar" }).click();
  await expect(fresh).toHaveCount(0);
});

test("un motor ausente aparece deshabilitado con el motivo", async ({ page }) => {
  await openMock(page, "&sinMotor=gemini");
  await page.getByTestId("send-target").first().click();
  const gemini = option(page, "Gemini");
  await expect(gemini).toHaveAttribute("aria-disabled", "true");
  await expect(gemini).toContainText("No se encontró agy");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Motores", exact: true }).click();
  await expect(page.locator(".engine-row.gemini")).toHaveAttribute("data-available", "false");
});

// Kanban, Mods y Hooks salieron del inspector el 2026-10-14 (duplicaban el Control Center).
test("pestañas del inspector: Bitácora y Motores sin cortar en un inspector estrecho", async ({ page }) => {
  await openMock(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.getByRole("tab", { name: "Bitácora", exact: true }).click();
  await expect(page.locator(".bres")).toContainText("ULTRON Sessions v0.2");

  // La tira no cabe en una fila de 300 px: pasa a dos (`flex-wrap`), sin desplazamiento y sin cortar ninguna.
  const strip = page.getByRole("tablist", { name: "Inspector" });
  expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const stripBox = await strip.boundingBox();
  // Dentro de la tira: la página tiene también las pestañas de sesión del espacio de trabajo.
  const tabs = strip.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  const tabBoxes = await Promise.all(Array.from({ length: count }, (_, i) => tabs.nth(i).boundingBox()));
  expect(new Set(tabBoxes.map((b) => b?.y)).size).toBeGreaterThan(1);
  for (const b of tabBoxes) {
    expect(stripBox && b && b.x >= stripBox.x - 1 && b.x + b.width <= stripBox.x + stripBox.width + 1 && b.y + b.height <= stripBox.y + stripBox.height + 1).toBe(true);
  }

  const motores = page.getByRole("tab", { name: "Motores", exact: true });
  await motores.click();
  await expect(motores).toHaveAttribute("aria-selected", "true");
});

test("en cola mientras Claude arranca y el diálogo de la TUI se maneja en el chat, sin terminal", async ({ page }) => {
  await openMock(page);
  await waitIdle(page);
  await page.getByRole("button", { name: "Sesión nueva" }).click();
  const status = page.getByTestId("chat-status").first().locator(".cs-text");
  await expect(status).toHaveText("Arrancando Claude…");
  const box = composer(page);
  await expect(page.getByTestId("enqueue")).toBeVisible();
  await box.fill("abre el diálogo de la TUI");
  await box.press("Enter");
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.locator(".msg.user").last()).toContainText("abre el diálogo de la TUI", { timeout: 10000 });

  const menu = page.getByTestId("menu-block");
  await expect(menu).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".term")).toHaveCount(0);
  await menu.getByRole("button", { name: "No" }).click();
  await expect(menu).toHaveCount(0);
  await expect(status).toHaveText(/Listo/);
});

test("markdown rico: callout, KaTeX, Mermaid, Graphviz, gráfica, tabla ordenable y diff", async ({ page }) => {
  await openMock(page);
  await page.getByText("Práctica 7 · sombras").first().click();
  const md = page.locator(".msg.assistant").filter({ hasText: "Pipeline de sombras" }).last();
  await md.scrollIntoViewIfNeeded();
  await expect(md.locator(".callout-tip")).toContainText("Consejo");
  await expect(md.locator(".katex").first()).toBeVisible();
  for (const kind of ["mermaid", "dot", "vega"]) {
    await expect(md.locator(`.diagram[data-kind='${kind}'] .diagram-body svg`)).toBeVisible({ timeout: 20000 });
  }
  await expect(md.locator(".d-add")).toContainText("max(0.05");
  await expect(md.locator(".cb-file")).toContainText("src/shaders/shadow.frag");
  await md.locator("th", { hasText: "Tiempo" }).click();
  await expect(md.locator("tbody tr td").first()).toHaveText("1024");
  await md.locator("th", { hasText: "Tiempo" }).click();
  await expect(md.locator("tbody tr td").first()).toHaveText("4096");
  await page.setViewportSize({ width: 1200, height: 2400 });
  await md.scrollIntoViewIfNeeded();
  await md.screenshot({ path: "test-results/markdown-rico.png" });
});

test("baja solo mientras llega la respuesta salvo que el usuario suba; gasto por turno", async ({ page }) => {
  await openMock(page);
  await waitIdle(page);
  await expect(page.getByTestId("turn-stats").first()).toContainText("$");
  const scroll = page.getByTestId("message-scroll").first();
  const gap = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const box = composer(page);
  await box.fill("Ajusta el ancho mínimo a 24 columnas");
  await box.press("Enter");
  await expect(page.getByTestId("live-bubble")).toBeVisible();
  await expect.poll(gap).toBeLessThan(5);

  // El usuario sube con la rueda: el chat deja de seguir el final.
  await scroll.hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(gap).toBeGreaterThan(200);
  await expect(page.getByRole("button", { name: "↓ Ir al final" })).toBeVisible();
});
