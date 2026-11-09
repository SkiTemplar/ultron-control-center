// Local build for this machine — includes the personal Finance feature.
//
// Finance is a local-only feature (datos bancarios locales; Finance.tsx + the Rust
// `finance` cargo feature are excluded from the public repo). The public
// `build:app` script deliberately omits it so third parties can build cleanly.
// This wrapper turns it on for local builds without any .env file:
//   - VITE_FINANCE=1 is injected into the environment so Vite includes the
//     Finance tab (import.meta.env.VITE_FINANCE === "1").
//   - `--features finance` is passed to `tauri build` so the Rust side compiles
//     the finance commands gated behind #[cfg(feature = "finance")].
//
// The Finance sources (src/components/Finance.tsx + src-tauri/src/finance.rs) are
// gitignored, so a clean clone of the public repo does not have them. In that
// case enabling the feature would fail to compile. We detect the sources first
// and, when absent, fall back to a public build (equivalent to build:app).
//
// Usage:  npm run build:local
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Finance is local-only: only enable it when both sources are present.
// The Rust side moved from finance.rs to the finance/ module dir (2026-08-15);
// accept either layout so the detector does not silently drop the feature.
const hasFinance =
  (existsSync("src-tauri/src/finance.rs") || existsSync("src-tauri/src/finance/mod.rs")) &&
  existsSync("src/components/Finance.tsx");

const env = { ...process.env };
if (hasFinance) env.VITE_FINANCE = "1";
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// Free the locked .exe without closing ULTRON (mirrors build:app): the open
// app and its Sessions keep running on the old binary until restarted.
run("node", ["scripts/release-locked-exe.mjs"]);
if (hasFinance) {
  // Build the bundle with the finance feature; VITE_FINANCE propagates to Vite.
  run("npx", ["tauri", "build", "--features", "finance"]);
  console.log("[build:local] done — Finance tab included.");
} else {
  // Public build: Finance sources are gitignored / not present on this clone.
  console.log(
    "[build:local] Finance es local-only; compilando SIN Finance (equivalente a build:app)."
  );
  run("npx", ["tauri", "build"]);
  console.log("[build:local] done — sin Finance.");
}

// (2026-08-16) Deploy del sidecar a ~/.ultron/bin/ SIEMPRE al final del build.
// Sin este paso cada build:local dejaba el sidecar desplegado stale: los hooks
// corrían un binario viejo y el check 7.7 del harness volvía a rojo.
// (2026-10-23) Con el mismo script que el redeploy manual, sin recompilar:
// para los procesos del sidecar, copia, verifica `version` contra HEAD,
// relanza `serve` y sale con 1 si algo falla (run() propaga el código). El
// deploy-sidecar.mjs anterior solo comparaba tamaños y salía con 0 al fallar.
run("node", ["../scripts/redeploy-memory-sidecar.mjs", "--no-build"]);
