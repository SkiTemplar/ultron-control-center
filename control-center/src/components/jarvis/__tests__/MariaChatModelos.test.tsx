// El chat enseña QUÉ suscripción hay en cada proveedor y qué modelos alcanza.
//
// Pedido el 2026-09-22: «debe saber la suscripción que tengo de cada proveedor
// y ponerme los modelos que me permite acceder con esa suscripción […] ya que
// podría querer un opus 5, o un 4.6». Antes el desplegable era una lista fija
// de Rust: pedir un modelo que la cuenta no alcanza se descartaba EN SILENCIO
// y contestaba el de por defecto.
//
// Se prueba contra el contrato de `maria_models_catalog` con `invoke`
// simulado, porque lo que aquí importa es que la interfaz pinte lo que el
// backend dice, no cómo lo averigua.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// jsdom no implementa scrollIntoView y el chat baja al último turno al montar.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// El setup global solo simula `open` de plugin-dialog y `openPath` de
// plugin-opener; MariaChat importa además `save` y `revealItemInDir`.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  openUrl: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

import { MariaChat } from "../MariaChat";

const HILO = {
  id: "hilo-1",
  title: "conversacion de prueba",
  folder: "",
  created: "2026-09-01T10:00:00Z",
  updated: "2026-09-01T10:00:00Z",
  pinned: false,
  closed: false,
  turns: 0,
};

/** Catálogo tal y como lo sirve el contrato. Todo inventado a propósito: el
 *  repositorio es público y de la máquina real no sale ni un id de cuenta. */
const CATALOGO = {
  providers: [
    {
      provider: "claude",
      models: [
        {
          id: "modelo-medio",
          label: "Medio",
          para: "el del día a día",
          permitido: "si",
          motivo: "",
          visto: "2026-09-22T09:00:00Z",
          origen: "casa",
        },
        {
          id: "modelo-grande",
          label: "Grande",
          para: "lo más capaz",
          permitido: "no",
          motivo: "rechazado por la cuenta: no existe o no tienes acceso",
          visto: "2026-09-22T09:00:00Z",
          origen: "suscripcion",
        },
      ],
      default_model: "modelo-medio",
      effort_mode: "Bandera",
      nota: "con este plan no entra el modelo grande",
      plan: "Plan Mediano",
      plan_origen: "fichero-de-credenciales",
      refrescado: "2026-09-22T09:00:00Z",
    },
    {
      provider: "codex",
      models: [
        {
          id: "otro-modelo",
          label: "Otro",
          para: "el único de esta cuenta",
          permitido: "si",
          motivo: "",
          visto: "",
          origen: "suscripcion",
        },
      ],
      default_model: "otro-modelo",
      effort_mode: "EnElPrompt",
      nota: "",
      plan: "Plan Gratis",
      plan_origen: "orden-de-la-cli",
      refrescado: "2026-09-22T09:00:00Z",
    },
  ],
  efforts: ["bajo", "medio", "alto"],
};

/** Lo que devuelve el botón/comando de refrescar: un modelo más y otro plan. */
const CATALOGO_FRESCO = {
  ...CATALOGO,
  providers: [
    {
      ...CATALOGO.providers[0],
      plan: "Plan Grande",
      models: [
        ...CATALOGO.providers[0].models.map((m) => ({ ...m, permitido: "si", motivo: "" })),
        {
          id: "modelo-nuevo",
          label: "Nuevo",
          para: "recién salido",
          permitido: "si",
          motivo: "",
          visto: "2026-09-22T12:00:00Z",
          origen: "suscripcion",
        },
      ],
    },
    CATALOGO.providers[1],
  ],
};

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "maria_threads_list") return [HILO];
    if (cmd === "maria_relay_thread") return [];
    if (cmd === "maria_relay_config") return { order: ["claude", "codex"], disabled: [] };
    if (cmd === "maria_models_catalog") return CATALOGO;
    if (cmd === "maria_models_refrescar") return CATALOGO_FRESCO;
    return null;
  });
});

/** Fija «claude» en el desplegable de proveedor y devuelve su etiqueta. */
async function elegirClaude() {
  const proveedor = await screen.findByRole("combobox", { name: "proveedor" });
  fireEvent.click(proveedor);
  const opcion = await screen.findByRole("option", { name: /claude/ });
  const etiqueta = opcion.textContent ?? "";
  fireEvent.mouseDown(opcion);
  return etiqueta;
}

describe("el chat y la suscripción de cada proveedor", () => {
  it("pinta el plan detectado junto al proveedor", async () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    const etiqueta = await elegirClaude();
    // El plan va pegado al nombre: es lo que decide qué modelos hay debajo.
    expect(etiqueta).toContain("claude");
    expect(etiqueta).toContain("Plan Mediano");
    // Y una vez elegido sigue a la vista en el botón cerrado.
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "proveedor" }).textContent,
      ).toContain("Plan Mediano");
    });
  });

  it("enseña la nota del proveedor bajo los selectores", async () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await elegirClaude();
    expect(
      await screen.findByText(/con este plan no entra el modelo grande/),
    ).toBeTruthy();
  });

  it("el modelo vetado se ve, con su motivo, y no se puede elegir", async () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await elegirClaude();

    fireEvent.click(await screen.findByRole("combobox", { name: "modelo" }));
    const grande = await screen.findByRole("option", { name: /Grande/ });
    expect(grande.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/rechazado por la cuenta/)).toBeTruthy();

    fireEvent.mouseDown(grande);
    // Sigue sin modelo fijado: el botón muestra el texto de «auto».
    expect(screen.getByRole("combobox", { name: "modelo" }).textContent).toContain("auto");
  });

  it("/modelo sobre uno vetado dice el motivo y la fecha, no «no está»", async () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await elegirClaude();

    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;
    fireEvent.change(caja, { target: { value: "/modelo modelo-grande" } });
    fireEvent.submit(caja.closest("form") as HTMLFormElement);

    const aviso = await screen.findByText(/no lo permite tu cuenta de claude/);
    expect(aviso.textContent).toContain("22/09");
    expect(aviso.textContent).toContain("rechazado por la cuenta");
    // El mensaje viejo era mentira: el modelo SÍ está en claude.
    expect(aviso.textContent).not.toContain("no está en claude");
  });

  it("/modelos vuelve a preguntar y cuenta lo que hay", async () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await screen.findByRole("combobox", { name: "proveedor" });

    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;
    fireEvent.change(caja, { target: { value: "/modelos" } });
    fireEvent.submit(caja.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("maria_models_refrescar");
    });
    const aviso = await screen.findByText(/catálogo actualizado/);
    expect(aviso.textContent).toContain("3 modelos en claude");
    expect(aviso.textContent).toContain("1 en codex");
    expect(aviso.textContent).toContain("Plan Grande");
  });

  it("después de /modelos el que estaba vetado ya se puede elegir", async () => {
    // El punto de tener botón: el plan cambia fuera de mar.ia y el catálogo de
    // arranque se queda viejo sin avisar.
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await elegirClaude();

    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;
    fireEvent.change(caja, { target: { value: "/modelos" } });
    fireEvent.submit(caja.closest("form") as HTMLFormElement);
    await screen.findByText(/catálogo actualizado/);

    fireEvent.click(screen.getByRole("combobox", { name: "modelo" }));
    const grande = await screen.findByRole("option", { name: /Grande/ });
    expect(grande.getAttribute("aria-disabled")).toBe(null);
    fireEvent.mouseDown(grande);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "modelo" }).textContent).toContain("Grande");
    });
  });
});

describe("degradación con un backend que no sabe de suscripciones", () => {
  it("sin los campos nuevos, la lista se ofrece entera como hasta ahora", async () => {
    // Obligatorio: los campos del contrato son opcionales justamente para que
    // una versión anterior de Rust siga funcionando igual que hoy.
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "maria_threads_list") return [HILO];
      if (cmd === "maria_relay_thread") return [];
      if (cmd === "maria_relay_config") return { order: ["claude"], disabled: [] };
      if (cmd === "maria_models_catalog") {
        return {
          providers: [
            {
              provider: "claude",
              models: [{ id: "modelo-medio", label: "Medio", para: "el del día a día" }],
              default_model: "modelo-medio",
              effort_mode: "Bandera",
            },
          ],
          efforts: ["bajo", "medio", "alto"],
        };
      }
      return null;
    });

    render(<MariaChat compacto hiloInicial="hilo-1" />);
    await elegirClaude();
    // Sin plan no se escribe ningún plan: el separador «·» es justo lo que
    // delataría un plan inventado.
    await waitFor(() => {
      const puesto = screen.getByRole("combobox", { name: "proveedor" }).textContent ?? "";
      expect(puesto).toContain("claude");
      expect(puesto).not.toContain("·");
    });

    fireEvent.click(await screen.findByRole("combobox", { name: "modelo" }));
    const medio = await screen.findByRole("option", { name: /Medio/ });
    expect(medio.getAttribute("aria-disabled")).toBe(null);
    fireEvent.mouseDown(medio);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "modelo" }).textContent).toContain("Medio");
    });
  });
});

describe("el modelo concreto y el menú de «/» (2026-09-23)", () => {
  it("un turno pedido con alias enseña el modelo que contestó, con su nombre", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "maria_threads_list") return [HILO];
      if (cmd === "maria_relay_thread")
        return [
          { ts: "2026-09-23T10:00:00Z", role: "user", provider: "", text: "hola" },
          {
            ts: "2026-09-23T10:00:05Z",
            role: "assistant",
            provider: "claude",
            model: "alias-grande",
            effort: "medio",
            text: "hola",
            modelo_real: "modelo-grande-20260901",
          },
          {
            ts: "2026-09-23T10:01:00Z",
            role: "assistant",
            provider: "claude",
            model: "modelo-medio",
            effort: "bajo",
            text: "adiós",
          },
        ];
      if (cmd === "maria_relay_config") return { order: ["claude", "codex"], disabled: [] };
      if (cmd === "maria_models_catalog") return CATALOGO;
      return null;
    });
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    // Con fecha de versión o sin ella, el catálogo lo nombra: «Grande».
    const chip = await screen.findByTitle(/se pidió «alias-grande» y contestó modelo-grande-20260901/);
    expect(chip.textContent).toContain("Grande");
    // Caso negativo: sin modelo_real se enseña lo que se pidió, sin inventar.
    expect(screen.getByText(/modelo-medio/)).toBeTruthy();
  });

  it("«/» a secas abre una lista con alto máximo y lleva la marca a la vista", async () => {
    const vista = vi.fn();
    Element.prototype.scrollIntoView = vista;
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    const caja = (await screen.findByLabelText("mensaje")) as HTMLInputElement;
    fireEvent.change(caja, { target: { value: "/" } });
    const lista = await screen.findByRole("listbox", { name: "comandos disponibles" });
    expect(lista.style.maxHeight).toContain("320px");
    expect(lista.className).toContain("overflow-y-auto");
    expect(lista.className).not.toContain("overflow-hidden");
    const opciones = screen.getAllByRole("option");
    expect(opciones.length).toBeGreaterThan(10);
    vista.mockClear();
    // Flecha arriba desde la primera = la última: tiene que traerse a la vista.
    fireEvent.keyDown(caja, { key: "ArrowUp" });
    await waitFor(() => expect(vista).toHaveBeenCalled());
    const marcada = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
    expect(marcada).toBe(screen.getAllByRole("option").at(-1));
  });
});
