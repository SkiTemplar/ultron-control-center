// Settings/api-keys/AnthropicHijackWarning.tsx
//
// cat: ANTHROPIC_API_KEY secuestra el CLI `claude` de la sesión si queda como
// variable de USUARIO — ver control-center/src-tauri/src/pty/spawn.rs
// (strip_api_key_for_claude) y hooks/scripts/session-summarize-previous.js
// (delete env.ANTHROPIC_API_KEY), que ya la limpian antes de spawnear
// `claude`. Fuera de esos dos caminos (p. ej. un `claude` lanzado a mano en
// una terminal normal) el secuestro sí se aplica.
//
// Sin la key configurada ni escrita basta una línea con el detalle plegado;
// con ella, el aviso se despliega entero porque el riesgo ya es real.

const WARN_COLOR = "var(--color-warning, #f8a000)";
const mono = { fontFamily: "var(--font-mono)" } as const;

function Detail() {
  return (
    <>
      Cualquier CLI <code style={mono}>claude</code> que herede la variable
      factura por token contra la API en vez de contra tu suscripción y
      desactiva los conectores de claude.ai. ULTRON la quita del entorno de los{" "}
      <code style={mono}>claude</code> que lanza él (las sesiones y el resumen
      de la sesión anterior), pero un <code style={mono}>claude</code> abierto a
      mano en una terminal normal sí queda afectado.
    </>
  );
}

export function AnthropicHijackWarning({ expanded }: { expanded: boolean }) {
  const summary = "Como variable de entorno de usuario, esta clave hace que claude facture por API.";
  if (!expanded) {
    return (
      <details className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: WARN_COLOR }}>
        <summary className="cursor-pointer">
          {summary} <span className="underline">¿Por qué?</span>
        </summary>
        <p className="mt-1" style={{ color: "var(--color-text-secondary)" }}>
          <Detail />
        </p>
      </details>
    );
  }
  return (
    <div
      className="mt-1.5 rounded p-2.5 text-[11.5px] leading-relaxed"
      style={{
        background: "rgba(248, 140, 0, 0.06)",
        border: "1px solid rgba(248, 140, 0, 0.22)",
        color: WARN_COLOR,
      }}
    >
      <p className="font-medium">{summary}</p>
      <p className="mt-1">
        <Detail />
      </p>
    </div>
  );
}
