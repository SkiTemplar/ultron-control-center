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
//
// Y al revés (2026-09-23): "deshabilita completamente que maria se ejecute al
// inicio, siempre y cuando lo tenga desactivado en la aplicación, ninguno de
// sus procesos". El interruptor refleja la DECISIÓN guardada
// (`cockpit/maria/arranque.json`), no el registro: desactivado quita la entrada
// y apaga las tareas de mar.ia que se lanzarían al iniciar sesión, y ni el
// build ni la app al abrir lo vuelven a poner.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BotonRefrescar } from "./BotonRefrescar";

type EstadoArranque = {
  activado_en_ajustes: boolean;
  tareas_de_inicio: string[];
  tareas_apagadas: string[];
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

  const activado = Boolean(estado?.activado_en_ajustes);
  const funciona = Boolean(
    estado?.registrado && estado.apunta_aqui && !estado.bloqueado_por_windows,
  );

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          arrancar con Windows
        </h2>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          Activado, mar.ia se abre sola al iniciar sesión, en la bandeja: para verla, pulsa{" "}
          <code>Ctrl+Alt+M</code> o haz clic en su icono. Desactivado, no se lanza nada de
          mar.ia al iniciar sesión: ni la app ni sus tareas programadas.
        </p>
      </header>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={activado}
          disabled={ocupado || estado === null}
          onChange={(e) => void cambiar(e.target.checked)}
        />
        <span>arrancar con Windows</span>
        <span className="hud-label">
          {estado === null
            ? "comprobando…"
            : !activado
              ? "desactivado"
              : funciona
                ? "activo"
                : "activado, pero no arranca"}
        </span>
      </label>

      {estado && (
        <div
          className="flex flex-col gap-1 px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
        >
          {activado ? (
            <>
              <Marca ok={estado.registrado} texto="entrada de arranque escrita" />
              <Marca ok={estado.apunta_aqui} texto="apunta a esta copia de mar.ia" />
              <Marca ok={!estado.bloqueado_por_windows} texto="Windows la deja arrancar" />
            </>
          ) : (
            <>
              <Marca ok={!estado.registrado} texto="sin entrada de arranque" />
              <Marca
                ok={estado.tareas_de_inicio.length === 0}
                texto={
                  estado.tareas_de_inicio.length === 0
                    ? "ninguna tarea de mar.ia al iniciar sesión"
                    : `tareas que siguen lanzándose al iniciar sesión: ${estado.tareas_de_inicio.join(", ")}`
                }
              />
              {estado.tareas_apagadas.length > 0 && (
                <span style={{ color: "var(--color-text-tertiary)" }}>
                  apagadas por mar.ia (se vuelven a encender al activarlo):{" "}
                  {estado.tareas_apagadas.join(", ")}
                </span>
              )}
            </>
          )}
          {activado && estado.comando && (
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
