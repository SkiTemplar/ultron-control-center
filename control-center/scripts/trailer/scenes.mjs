// Escenas del tráiler de ULTRON Sessions sobre el mock (`sesiones.html?mock=1`).
// Cada escena recibe la página del escenario y el frame de la app; `still`
// guarda la captura de la web en el momento más representativo.
import { reloadApp } from "./stage.mjs";

const pause = (page, ms) => page.waitForTimeout(ms);

function box(frame) {
  return frame.getByRole("textbox", { name: "Mensaje" }).first();
}

async function say(page, frame, text) {
  const b = box(frame);
  await b.click();
  await b.pressSequentially(text, { delay: 32 });
  await pause(page, 250);
  await frame.getByRole("button", { name: /^(Enviar|Encolar)$/ }).first().click();
}

async function idle(frame, timeout = 20000) {
  await frame.locator(".send.stop").first().waitFor({ state: "detached", timeout }).catch(() => undefined);
}

export const SCENES = [
  {
    name: "chat",
    kicker: "Chat",
    title: "Markdown, tablas y código mientras Claude escribe",
    async run(page, frame, still) {
      await say(page, frame, "Arregla el ancho de la columna de ritmo en /uso");
      await pause(page, 2600);
      await idle(frame);
      await pause(page, 900);
      await still("chat.png");
    },
  },
  {
    name: "pregunta",
    kicker: "Preguntas",
    title: "Las preguntas de Claude, como botones en el chat",
    async run(page, frame, still) {
      await say(page, frame, "Dame opciones para el ritmo por debajo de 72 columnas");
      const ask = frame.getByTestId("ask-question");
      await ask.waitFor({ timeout: 20000 });
      await ask.scrollIntoViewIfNeeded();
      await pause(page, 1200);
      await still("pregunta.png");
      await ask.getByText("Segunda línea", { exact: true }).click();
      await pause(page, 700);
      await ask.getByRole("button", { name: "Responder" }).click();
      await pause(page, 1500);
    },
  },
  {
    name: "permiso",
    kicker: "Permisos",
    title: "Permitir o denegar con un clic",
    async run(page, frame) {
      await idle(frame);
      await say(page, frame, "Haz el commit; pide permiso antes");
      const ask = frame.getByTestId("ask-permission");
      await ask.waitFor({ timeout: 20000 });
      await ask.scrollIntoViewIfNeeded();
      await pause(page, 1600);
      await ask.getByRole("button", { name: "Permitir", exact: true }).click();
      await pause(page, 1400);
    },
  },
  {
    name: "cola",
    kicker: "Cola",
    title: "Escribe mientras trabaja: se envía en orden y sin duplicados",
    async run(page, frame, still) {
      await idle(frame);
      await say(page, frame, "Revisa también el caso de 60 columnas");
      await pause(page, 500);
      await say(page, frame, "Después añade un test de 40 columnas");
      await say(page, frame, "Y al final actualiza el CHANGELOG");
      await frame.getByTestId("queue").waitFor({ timeout: 10000 });
      await pause(page, 1300);
      await still("cola.png");
      await pause(page, 1500);
    },
  },
  {
    name: "comandos",
    kicker: "Comandos",
    title: "Todos los slash commands, desde el chat",
    async run(page, frame, still) {
      await idle(frame, 40000);
      const b = box(frame);
      await b.click();
      await b.pressSequentially("/", { delay: 60 });
      await frame.getByRole("listbox", { name: "Comandos" }).waitFor();
      await pause(page, 1100);
      await b.pressSequentially("mo", { delay: 220 });
      await pause(page, 1300);
      await still("comandos.png");
      await b.press("Escape");
      await b.fill("");
      await pause(page, 400);
    },
  },
  {
    name: "agentes",
    kicker: "Subagentes",
    title: "Cada subagente, con su contexto y su tarea",
    async run(page, frame, still) {
      await frame.getByRole("tab", { name: "Agentes", exact: true }).click();
      await pause(page, 1800);
      await still("agentes.png");
      await frame.getByRole("tab", { name: "Uso", exact: true }).click();
      await pause(page, 2200);
    },
  },
  {
    name: "hud",
    kicker: "HUD",
    title: "Modelo, contexto, cuota y coste de un vistazo",
    async run(page, frame, still) {
      await frame.getByTestId("hud-model").first().click();
      await frame.getByRole("listbox", { name: "Modelo" }).waitFor();
      await pause(page, 1500);
      await still("hud.png");
      await page.keyboard.press("Escape");
      await pause(page, 300);
      await frame.getByTestId("hud-context").first().click();
      await pause(page, 1800);
      await page.keyboard.press("Escape");
      await pause(page, 300);
    },
  },
  {
    name: "dividir",
    kicker: "Paneles",
    title: "Varias sesiones a la vez",
    async run(page, frame, still) {
      // El panel nuevo toma la siguiente sesión abierta (la revisión del PR con un permiso pendiente).
      await frame.getByRole("button", { name: /Dividir/ }).first().click();
      await frame.getByRole("region", { name: "Panel 2" }).waitFor();
      await pause(page, 2600);
      await still("dividir.png");
      await pause(page, 600);
    },
  },
];

/** Segunda opinión: va justo después de cargar, con el bloque de Codex a la vista. */
export const CODEX_SCENE = {
  name: "codex",
  kicker: "Segunda opinión",
  title: "Manda la respuesta a Codex o Gemini y trae su veredicto",
  async run(page, frame, still) {
    const block = frame.getByText("Revisa críticamente la última respuesta de Claude").first();
    await block.scrollIntoViewIfNeeded();
    await pause(page, 2200);
    await still("codex.png");
    await block.hover();
    await pause(page, 1600);
  },
};

/** Orden del corte de temas; los cuatro primeros forman la lámina de la web. */
export const THEMES = ["obsidiana", "vacio", "fosforo", "acero", "grafito", "medianoche", "ambar", "obsidiana"];

/** Cambia de tema recargando la app; devuelve el frame nuevo. */
export async function themeCut(page, theme) {
  const frame = page.frames().find((f) => f.url().includes("sesiones.html"));
  await frame.evaluate((t) => {
    localStorage.setItem("ultron.sesiones.theme", t);
    localStorage.removeItem("ultron.sesiones.workspace");
  }, theme);
  return reloadApp(page);
}
