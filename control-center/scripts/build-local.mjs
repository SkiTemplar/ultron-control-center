// Local build for this machine — includes the personal Finance feature.
//
// Finance is a local-only feature (KutxaBank data; Finance.tsx + the Rust
// `finance` cargo feature are excluded from the public repo). The public
// `build:app` script deliberately omits it so third parties can build cleanly.
// This wrapper turns it on for local builds without any .env file:
//   - VITE_FINANCE=1 is injected into the environment so Vite includes the
//     Finance tab (import.meta.env.VITE_FINANCE === "1").
//   - `--features finance` is passed to `tauri build` so the Rust side compiles
//     the finance commands gated behind #[cfg(feature = "finance")].
//
// Usage:  npm run build:local
import { spawnSync } from "node:child_process";

const env = { ...process.env, VITE_FINANCE: "1" };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// Close any running instance first (mirrors build:app).
run("node", ["scripts/kill-running-app.mjs"]);
// Build the bundle with the finance feature; VITE_FINANCE propagates to Vite.
run("npx", ["tauri", "build", "--features", "finance"]);
console.log("[build:local] done — Finance tab included.");
