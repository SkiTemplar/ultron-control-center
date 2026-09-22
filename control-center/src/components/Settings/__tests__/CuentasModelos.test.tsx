// Ajustes → Cuentas: qué plan tiene cada cuenta y a cuántos modelos llega.
//
// La pantalla ya decía QUIÉN eres y CÓMO se paga; le faltaba lo que el usuario
// pidió el 2026-09-22: «debe saber la suscripción que tengo de cada proveedor
// y ponerme los modelos que me permite acceder con esa suscripción». El plan
// cambia fuera de mar.ia (se contrata, caduca), así que además hace falta un
// botón para volver a preguntarlo sin reiniciar nada.
//
// Todos los datos de la prueba son inventados: el repositorio es público.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CuentasSection } from "../CuentasSection";

const INFORME = {
  cuentas: [
    {
      provider: "claude",
      label: "Claude",
      tipo: "Suscripcion",
      account: "quien-sea@ejemplo.test",
      source: "fichero-de-sesion",
      key_tail: "",
      warnings: [],
      plan: "Plan Mediano",
      plan_origen: "fichero-de-credenciales",
    },
  ],
  correos: ["quien-sea@ejemplo.test"],
  warnings: [],
};

const CATALOGO = {
  providers: [
    {
      provider: "claude",
      models: [
        { id: "modelo-medio", label: "Medio", para: "el del día a día", permitido: "si" },
        { id: "modelo-grande", label: "Grande", para: "lo más capaz", permitido: "no" },
        // «desconocido» sí se ofrece: solo el «no» queda fuera del recuento.
        { id: "modelo-raro", label: "Raro", para: "nadie lo ha probado", permitido: "desconocido" },
      ],
      default_model: "modelo-medio",
      effort_mode: "Bandera",
      plan: "Plan Mediano",
      plan_origen: "fichero-de-credenciales",
    },
  ],
  efforts: ["bajo", "medio", "alto"],
};

const CATALOGO_FRESCO = {
  ...CATALOGO,
  providers: [{ ...CATALOGO.providers[0], plan: "Plan Grande" }],
};
// Tras refrescar, el informe de cuentas también trae el plan nuevo.
const INFORME_FRESCO = {
  ...INFORME,
  cuentas: [{ ...INFORME.cuentas[0], plan: "Plan Grande" }],
};

beforeEach(() => {
  let informe = INFORME;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "maria_cuentas_informe") return informe;
    if (cmd === "maria_perfiles_listar") return [];
    if (cmd === "maria_models_catalog") return CATALOGO;
    if (cmd === "maria_models_refrescar") {
      informe = INFORME_FRESCO;
      return CATALOGO_FRESCO;
    }
    return null;
  });
});

describe("plan y modelos en la tarjeta de cada cuenta", () => {
  it("enseña el plan detectado y cuántos modelos alcanza", async () => {
    render(<CuentasSection />);
    expect(await screen.findByText("Plan Mediano")).toBeTruthy();
    // 3 en el catálogo, 1 vetado: se cuentan los elegibles (sí + desconocido).
    expect(screen.getByText(/2 modelos disponibles/)).toBeTruthy();
  });

  it("«actualizar modelos» vuelve a preguntar y lo dice", async () => {
    render(<CuentasSection />);
    fireEvent.click(await screen.findByRole("button", { name: /actualizar modelos/ }));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("maria_models_refrescar");
    });
    // El aviso nombra el proveedor y su cuenta: «se actualizó algo» no sirve.
    expect(await screen.findByText(/claude: 2 modelos con Plan Grande/)).toBeTruthy();
    // Y la tarjeta cambia con él: antes el aviso decía el plan nuevo y la
    // tarjeta seguía con el viejo.
    expect(await screen.findByText("Plan Grande")).toBeTruthy();
    expect(screen.queryByText("Plan Mediano")).toBeNull();
  });

  it("sin plan detectado lo dice, en vez de inventarse uno", async () => {
    // Caso negativo: un plan inventado aquí lleva a pedir en el chat un modelo
    // que la cuenta rechaza, que es el problema que esto viene a arreglar.
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "maria_cuentas_informe") {
        return { ...INFORME, cuentas: [{ ...INFORME.cuentas[0], plan: "", plan_origen: "" }] };
      }
      if (cmd === "maria_perfiles_listar") return [];
      if (cmd === "maria_models_catalog") return null;
      return null;
    });

    render(<CuentasSection />);
    expect(await screen.findByText("sin detectar")).toBeTruthy();
  });
});
