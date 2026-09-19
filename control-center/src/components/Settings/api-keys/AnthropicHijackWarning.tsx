// Settings/api-keys/AnthropicHijackWarning.tsx
//
// cat: ANTHROPIC_API_KEY secuestra el CLI `claude` de la sesión si queda como
// variable de USUARIO — ver control-center/src-tauri/src/pty/spawn.rs
// (strip_api_key_for_claude) y hooks/scripts/session-summarize-previous.js
// (delete env.ANTHROPIC_API_KEY), que ya la limpian antes de spawnear
// `claude`. Fuera de esos dos caminos (p. ej. un `claude` lanzado a mano en
// una terminal normal) el secuestro sí se aplica.

export function AnthropicHijackWarning() {
  return (
    <div
      className="mt-1.5 rounded p-2.5 text-[11.5px] leading-relaxed"
      style={{
        background: "rgba(248, 140, 0, 0.06)",
        border: "1px solid rgba(248, 140, 0, 0.22)",
        color: "var(--color-warning, #f8a000)",
      }}
    >
      Si esta key queda como variable de ENTORNO DE USUARIO de Windows,
      cualquier CLI <code style={{ fontFamily: "var(--font-mono)" }}>claude</code>{" "}
      que la herede factura por token contra la API en vez de contra tu
      suscripción, y desactiva los conectores de claude.ai (mensaje literal de
      Claude Code 2.1.270: "claude.ai connectors are disabled because
      ANTHROPIC_API_KEY or another auth source is set"). mar.ia ya se
      defiende en dos sitios: el PTY que lanza <code style={{ fontFamily: "var(--font-mono)" }}>claude</code>{" "}
      (<code style={{ fontFamily: "var(--font-mono)" }}>pty/spawn.rs::strip_api_key_for_claude</code>) y
      el hook de resumen de sesión anterior (
      <code style={{ fontFamily: "var(--font-mono)" }}>session-summarize-previous.js</code>) la borran
      del entorno del hijo antes de invocarlo. Fuera de esos dos caminos —
      p. ej. un <code style={{ fontFamily: "var(--font-mono)" }}>claude</code> lanzado a mano en una
      terminal normal — el secuestro sí se aplica.
    </div>
  );
}
