import { expect, test, type Page } from "@playwright/test";

// Sesión larga contra el mock (`?largo=N`, contrato v3 §7): carga inicial de la
// última página y anteriores al llegar arriba sin saltos de scroll ni duplicados.

const TOTAL = 3000;
const LAST_TURN = TOTAL / 4 - 1;

async function openLong(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/sesiones.html?mock=1&largo=${TOTAL}`);
  await expect(page.locator(".app[data-mock='1']")).toBeVisible();
  await page.getByText("Sesión larga").first().click();
  await expect(page.getByText(`Respuesta larga ${LAST_TURN}.`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-limpio")) return;
    sessionStorage.setItem("e2e-limpio", "1");
    localStorage.removeItem("ultron.sesiones.workspace");
    localStorage.removeItem("ultron.sesiones.queue");
  });
});

/** Primer prompt visible dentro del área del chat y su posición respecto a ella. */
async function firstVisiblePrompt(page: Page) {
  return page.getByTestId("message-scroll").first().evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll<HTMLElement>(".msg.user .utext")];
    const row = rows.find((r) => r.getBoundingClientRect().top >= top);
    return row ? { text: row.textContent ?? "", y: row.getBoundingClientRect().top - top } : null;
  });
}

/** Sube con la rueda, como el usuario, hasta que se pide la página anterior. */
async function wheelUntilLoading(page: Page) {
  const box = await page.getByTestId("message-scroll").first().boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  for (let i = 0; i < 40; i += 1) {
    if (await page.getByTestId("history-loading").count()) return;
    await page.mouse.wheel(0, -8000);
    await page.waitForTimeout(60);
  }
}

test("sesión larga: anteriores al llegar arriba sin saltar el scroll y hasta el inicio sin duplicados (§7)", async ({ page }) => {
  await openLong(page);
  const scroll = page.getByTestId("message-scroll").first();
  await expect(page.getByTestId("history-start")).toHaveCount(0);
  // Abrir la sesión no pide anteriores por sí solo: solo la última página (300 elementos visibles).
  await page.waitForTimeout(600);
  await expect(page.locator(".msg.user .utext", { hasText: /^Mensaje largo 649$/ })).toHaveCount(0);
  await wheelUntilLoading(page);
  await expect(page.getByTestId("history-loading")).toBeVisible();
  const before = await firstVisiblePrompt(page);
  expect(before).not.toBeNull();
  await expect(page.getByTestId("history-loading")).toHaveCount(0);
  const after = await page.locator(".msg.user .utext", { hasText: new RegExp(`^${before?.text}$`) }).first().evaluate((row) => {
    const box = row.closest("[data-testid='message-scroll']")?.getBoundingClientRect().top ?? 0;
    return row.getBoundingClientRect().top - box;
  });
  expect(Math.abs(after - (before?.y ?? 0))).toBeLessThan(40);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);

  for (let i = 0; i < 20; i += 1) {
    if (await page.getByTestId("history-start").count()) break;
    await wheelUntilLoading(page);
    await expect(page.getByTestId("history-loading")).toHaveCount(0);
  }
  await expect(page.getByTestId("history-start")).toBeVisible();
  // La última página antepuesta también se ancla: se sube a mano hasta el principio.
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator(".msg.user .utext", { hasText: /^Mensaje largo 0$/ })).toHaveCount(1);
  await expect(page.getByTestId("history-start")).toBeInViewport();
  await expect(page.locator(".msg.user .utext", { hasText: /^Mensaje largo 1$/ })).toHaveCount(1);
});
