// Ajustes → arranque con Windows.
//
// El usuario lo pidió el 2026-09-21: "la aplicación debería iniciarse en el
// arranque del pc y no lo hace, debes poner una opción en ajustes para ello, y
// que si está activada lo cumpla".
//
// La parte de "que lo cumpla" es la que importa. Ya había un interruptor, pero
// se limitaba a decir sí o no: un arranque que no ocurre no avisaba de nada.
// Aquí se enseñan los tres motivos reales por los que puede no arrancar —sin
// entrada, apuntando a otra copia, o desactivado por Windows— y se comprueba
// el resultado después de escribirlo, no antes.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BotonRefrescar } from "./BotonRefrescar";

type EstadoArranque = {
  registrado: boolean;
  comando: string;
  apunta_aqui: boolean;
  bloqueado_por_windows: boolean;
  problema: string;
};

export function ArranqueSection() {
  const [estado, setEstado] = useState<EstadoArranque | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setEstado(await invoke<EstadoArranque>("maria_arranque_estado"));
      setError(null);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  useEffect(() => {
    void cargar().catch(() => undefined);
  }, [cargar]);

  async function cambiar(activar: boolean) {
    setOcupado(true);
    setError(null);
    try {
      // El backend devuelve el estado LEÍDO después de escribir: si no quedó
      // hecho, se ve aquí mismo en vez de dar por bueno el clic.
      setEstado(await invoke<EstadoArranque>("maria_arranque_set", { activar }));
    } catch (e) {
      setError(String(e));
    } finally {
      setOcupado(false);
    }
  }

  const activo = Boolean(estado?.registrado && estado.apunta_aqui && !estado.bloqueado_por_windows);

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          arrancar con Windows
        </h2>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          mar.ia se abre sola al iniciar sesión. Arranca en la bandeja: para verla, pulsa{" "}
          <code>Ctrl+Alt+M</code> o haz clic en su icono.
        </p>
      </header>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={activo}
          disabled={ocupado || estado === null}
          onChange={(e) => void cambiar(e.target.checked)}
        />
        <span>arrancar con Windows</span>
        <span className="hud-label">
          {estado === null ? "comprobando…" : activo ? "activo" : "no arranca sola"}
        </span>
      </label>

      {estado && (
        <div
          className="flex flex-col gap-1 px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
        >
          <Marca ok={estado.registrado} texto="entrada de arranque escrita" />
          <Marca ok={estado.apunta_aqui} texto="apunta a esta copia de mar.ia" />
          <Marca ok={!estado.bloqueado_por_windows} texto="Windows la deja arrancar" />
          {estado.comando && (
            <code
              className="mt-1 text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)", overflowWrap: "anywhere" }}
            >
              {estado.comando}
            </code>
          )}
        </div>
      )}

      {estado?.problema && (
        <p
          className="px-3 py-2 text-[12px]"
          style={{
            border: "1px solid var(--color-warning, #f8a000)",
            color: "var(--color-warning, #f8a000)",
          }}
        >
          {estado.problema}
        </p>
      )}

      <BotonRefrescar onRefrescar={cargar} etiqueta="volver a comprobar" />

      {error && (
        <p
          className="px-3 py-2 text-[12px]"
          style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

function Marca({ ok, texto }: { ok: boolean; texto: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span style={{ color: ok ? "var(--color-success)" : "var(--color-danger)" }}>
        {ok ? "●" : "○"}
      </span>
      <span>{texto}</span>
    </span>
  );
}
