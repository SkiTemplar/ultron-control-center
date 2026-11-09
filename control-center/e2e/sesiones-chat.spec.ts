import { expect, test, type Page } from "@playwright/test";

// Chat de ULTRON Sessions contra el mock alineado con el backend del contrato de
// estabilidad v3 (§8.6) y el cambio de diseño del 2026-10-08: todos los slash
// commands desde el chat, menús de la TUI en un bloque dentro del chat, línea de
// estado única, cola del backend, tarjetas con salida y autoscroll por gesto.

async function openMock(page: Page, query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/sesiones.html?mock=1${query}`);
  await expect(page.locator(".app[data-mock='1']")).toBeVisible();
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Mensaje" }).first();
const status = (page: Page) => page.getByTestId("chat-status").first().locator(".cs-text");

/** Sesión libre de la demo (Práctica 7), sin turno en curso ni preguntas. */
async function openIdle(page: Page, query = "") {
  await openMock(page, query);
  await page.getByText("Práctica 7 · sombras").first().click();
  await expect(status(page)).toHaveText(/Listo/);
}

async function send(page: Page, text: string, key = "Enter") {
  const box = composer(page);
  await box.fill(text);
  await box.press(key);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-limpio")) return;
    sessionStorage.setItem("e2e-limpio", "1");
    localStorage.removeItem("ultron.sesiones.workspace");
    localStorage.removeItem("ultron.sesiones.queue");
  });
});

test("/cost: tarjeta con la salida, sigue libre y el siguiente mensaje no se encola (AC-1, SC-10)", async ({ page }) => {
  await openIdle(page);
  await send(page, "/cost");
  const card = page.getByTestId("command-card").last();
  await expect(card).toContainText("/cost");
  await expect(card).toContainText("Total cost");
  await expect(status(page)).toHaveText(/Listo/);
  await expect(page.getByTestId("send")).toBeVisible();
  await send(page, "Sin cola, por favor");
  await expect(page.getByTestId("queue")).toHaveCount(0);
  await expect(page.locator(".msg.user").last()).toContainText("Sin cola, por favor");
});

test("/config abre el menú en el chat, se maneja con el teclado y Esc lo cierra (AC-2)", async ({ page }) => {
  await openIdle(page);
  await send(page, "/config");
  const menu = page.getByTestId("menu-block");
  await expect(menu).toBeVisible();
  await expect(status(page)).toHaveText("Menú /config abierto en la TUI");
  await expect(page.locator(".msg.user .utext", { hasText: "/config" })).toHaveCount(0);
  await page.getByTestId("menu-screen").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("command-card").last()).toContainText("Ajuste cambiado: Tema dark");
  await expect(status(page)).toHaveText(/Listo/);

  await send(page, "/config");
  await expect(menu).toBeVisible();
  await composer(page).focus();
  await composer(page).press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("command-card").last()).toContainText("Cancelado");
  await send(page, "Mensaje justo después del menú");
  await expect(page.locator(".msg.user").last()).toContainText("Mensaje justo después del menú");
});

test("/model, /permissions, /mcp, /doctor y /resume abren su menú y «Cerrar menú» vuelve a idle", async ({ page }) => {
  await openIdle(page);
  for (const cmd of ["/model", "/permissions", "/mcp", "/doctor", "/resume"]) {
    await send(page, cmd);
    await expect(page.getByTestId("menu-block")).toContainText(cmd);
    await page.getByTestId("menu-close").click();
    await expect(page.getByTestId("menu-block")).toHaveCount(0);
    await expect(status(page)).toHaveText(/Listo/);
  }
});

test("aviso de caché tras /model x: tarjeta con opciones y, al elegir, idle (AC-1)", async ({ page }) => {
  await openIdle(page);
  await send(page, "/model claude-sonnet-5-5");
  const menu = page.getByTestId("menu-block");
  await expect(menu).toContainText("invalida la caché");
  await menu.getByRole("button", { name: "Sí, cambiar de modelo" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("command-card").last()).toContainText("Modelo: claude-sonnet-5-5");
  await expect(status(page)).toHaveText(/Listo/);
});

test("/vim deja una nota explicada y no se ejecuta", async ({ page }) => {
  await openIdle(page);
  await send(page, "/vim");
  await expect(page.getByTestId("chat-note").last()).toContainText("modo vim");
  await expect(status(page)).toHaveText(/Listo/);
});

test("una pregunta pendiente sobrevive a la recarga (AC-6, SC-03)", async ({ page }) => {
  await openMock(page);
  await page.getByText("Revisión adversarial PR #41").first().click();
  await expect(page.getByTestId("ask-permission")).toBeVisible();
  await page.reload();
  await page.getByText("Revisión adversarial PR #41").first().click();
  await expect(page.getByTestId("ask-permission")).toBeVisible();
});

test("pregunta + Interrumpir: tarjeta fuera al momento y la sesión vuelve a idle (AC-5)", async ({ page }) => {
  await openIdle(page);
  await send(page, "Hazme una pregunta sobre el ritmo");
  const ask = page.getByTestId("ask-question");
  await expect(ask).toBeVisible({ timeout: 20000 });
  await expect(status(page)).toHaveText("Esperando tu respuesta: pregunta");
  // Interrumpir vive solo en el composer (con Esc); la tarjeta no lo repite.
  await page.getByTestId("interrupt").click();
  await expect(ask).toHaveCount(0);
  await expect(status(page)).toHaveText("Interrumpido", { timeout: 2500 });
});

test("plan: la opción por defecto conserva el bypass previo (SC-06)", async ({ page }) => {
  await openMock(page);
  await page.getByRole("button", { name: "Sesión nueva" }).click();
  await expect(status(page)).toHaveText(/Listo/, { timeout: 10000 });
  await send(page, "Prepara un plan para el ancho");
  const plan = page.getByTestId("ask-plan");
  await expect(plan).toBeVisible({ timeout: 20000 });
  const first = plan.locator(".acts .btn").first();
  // El número es el atajo de teclado de la opción (<kbd> sin nombre accesible).
  await expect(first).toHaveText(/^1?Sí, mantener sin permisos \(bypass\)$/);
  await first.click();
  await expect(page.locator(".msg.assistant").last()).toContainText("modo bypassPermissions", { timeout: 20000 });
});

test("tres mensajes durante un turno: en orden, uno absorbido marcado y una sola actividad por turno (O7, R6)", async ({ page }) => {
  await openIdle(page);
  await send(page, "Primero: ajusta el ancho");
  await expect(status(page)).not.toHaveText(/Listo/);
  await send(page, "Segundo en cola");
  await send(page, "Tercero ya", "Control+Enter");
  await send(page, "Cuarto en cola");
  await expect(page.getByTestId("queue-item")).toHaveCount(2);
  await expect(page.getByTestId("queued-mark")).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByTestId("queue")).toHaveCount(0, { timeout: 40000 });
  await expect(status(page)).toHaveText(/Listo/, { timeout: 40000 });
  const prompts = await page.locator(".msg.user .utext").allTextContents();
  const order = ["Primero", "Tercero", "Segundo", "Cuarto"].map((t) => prompts.findIndex((p) => p.startsWith(t)));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const turn = page.locator(".msg.assistant").filter({ hasText: "Primero: ajusta" });
  await expect(turn.locator(".activity")).toHaveCount(1);
});

test("el transcript antes del último delta deja una sola respuesta (AC-11)", async ({ page }) => {
  await openIdle(page);
  await send(page, "Respuesta única por favor");
  await expect(status(page)).toHaveText(/Listo/, { timeout: 20000 });
  await expect(page.getByTestId("live-bubble")).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator(".msg.assistant").filter({ hasText: "Respuesta única por favor" })).toHaveCount(1);
});

test("menú simulado: «Salir del menú» vuelve a idle", async ({ page }) => {
  await openIdle(page);
  await send(page, "Abre el menú de la TUI");
  await expect(status(page)).toHaveText("Menú abierto en la TUI", { timeout: 10000 });
  await page.getByTestId("exit-menu").click();
  await expect(page.getByTestId("menu-block")).toHaveCount(0);
  await expect(status(page)).toHaveText(/Listo/);
});

test("colgado: la línea dice la causa y ofrece Recuperar; Interrumpir sigue en el composer (AC-12)", async ({ page }) => {
  await openIdle(page);
  await send(page, "Simula que se queda colgado");
  await expect(status(page)).toContainText("Sin eventos desde hace", { timeout: 10000 });
  await expect(page.getByTestId("status-interrupt")).toHaveCount(0);
  await expect(page.getByTestId("interrupt")).toBeVisible();
  await expect(page.getByTestId("status-recover")).toBeVisible();
  await page.getByTestId("status-recover").click();
  await expect(status(page)).toHaveText(/Interrumpido|Listo/);
});

test("confianza: tarjeta y ningún envío hasta responder (SC-17)", async ({ page }) => {
  await openMock(page, "&confianza=1");
  await page.getByRole("button", { name: "Sesión nueva" }).click();
  const card = page.getByTestId("trust-card");
  await expect(card).toBeVisible({ timeout: 10000 });
  await send(page, "Espera a la confianza");
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.locator(".msg.user .utext", { hasText: "Espera a la confianza" })).toHaveCount(0);
  await card.getByRole("button", { name: "Confiar en esta carpeta" }).click();
  await expect(page.locator(".msg.user .utext", { hasText: "Espera a la confianza" })).toHaveCount(1, { timeout: 10000 });
});

// Auditoría 2026-10-17: `bridgeConnected` no tenía consumidor. Una sesión sin
// hello del puente lo dice en la línea de estado; con puente, «Listo» a secas.
for (const [query, text] of [["&sinpuente=1", /^Listo · sin puente/], ["", /^Listo$/]] as const) {
  test(`sesión nueva ${query ? "sin puente: la línea de estado lo avisa" : "con puente: «Listo» a secas (caso negativo)"}`, async ({ page }) => {
    await openMock(page, query);
    await page.getByRole("button", { name: "Sesión nueva" }).click();
    await expect(status(page)).toHaveText(text, { timeout: 10000 });
  });
}

test("fallo de envío: el elemento queda «falló» con Reintentar y no se pierde (COLA-02)", async ({ page }) => {
  await openIdle(page);
  await send(page, "Primero mientras trabaja");
  await send(page, "Este falla al enviar");
  const item = page.getByTestId("queue-item").filter({ hasText: "Este falla al enviar" });
  await expect(item).toHaveAttribute("data-state", "failed", { timeout: 30000 });
  await expect(item).toContainText("falló");
  await item.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.locator(".msg.user .utext", { hasText: "Este falla al enviar" })).toHaveCount(1, { timeout: 20000 });
});

test("autoscroll: un arrastre lento hacia arriba no se reancla; una salida de 200 líneas sigue el final (SCR-01)", async ({ page }) => {
  await openIdle(page);
  const scroll = page.getByTestId("message-scroll").first();
  const gap = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await send(page, "Dame una salida larga del test");
  await expect.poll(gap, { timeout: 15000 }).toBeLessThan(5);
  await expect(status(page)).toHaveText(/Listo/, { timeout: 30000 });

  await scroll.dispatchEvent("pointerdown");
  for (let i = 0; i < 5; i += 1) {
    await scroll.evaluate((el) => {
      el.scrollTop -= 80;
    });
    await page.waitForTimeout(220);
  }
  await send(page, "Sigue mientras leo arriba");
  await page.waitForTimeout(800);
  expect(await gap()).toBeGreaterThan(200);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup")));
});

test("proceso salido: exited en menos de 2 s y el envío siguiente avisa (AC-13)", async ({ page }) => {
  await openIdle(page);
  await send(page, "/exit");
  await page.getByTestId("exit-confirm").getByRole("button", { name: "Cerrar la sesión" }).click();
  await expect(status(page)).toHaveText(/La sesión terminó/, { timeout: 2000 });
  await send(page, "¿Sigues ahí?");
  await expect(page.getByTestId("chat-note").last()).toContainText("La sesión terminó");
});

test("composer en una sola fila y sin botones Fichero ni Historial (req. 19)", async ({ page }) => {
  await openIdle(page);
  const bar = page.locator(".cbar").first();
  await expect(bar.getByRole("button", { name: /Fichero/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /Historial/ })).toHaveCount(0);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = await bar.evaluate((el) => {
      const visible = [...el.children].filter((c) => (c as HTMLElement).offsetParent !== null);
      const mids = visible.map((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      return Math.max(...mids) - Math.min(...mids);
    });
    // Todos los controles comparten fila: sus centros verticales caben en unos pocos píxeles.
    expect(rows).toBeLessThan(8);
  }
});

test("el composer al crecer hasta su tope o al vaciarse no tapa el final del chat", async ({ page }) => {
  await openIdle(page);
  const box = composer(page);
  const scroll = page.getByTestId("message-scroll").first();
  const gap = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await box.click();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.type(`línea ${i} del prompt largo`);
    await page.keyboard.press("Shift+Enter");
  }
  await expect(box).toHaveJSProperty("clientHeight", 280);
  // Con el textarea ya al tope, lo que se sigue escribiendo no cambia su altura.
  await page.keyboard.type("y sigue escribiendo");
  await expect.poll(gap).toBeLessThan(2);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await expect.poll(() => box.evaluate((el) => el.clientHeight)).toBeLessThan(40);
  await expect.poll(gap).toBeLessThan(2);
});
