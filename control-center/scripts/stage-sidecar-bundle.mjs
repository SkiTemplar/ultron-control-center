// stage-sidecar-bundle.mjs — beforeBundleCommand helper.
//
// The src-tauri crate ships extra [[bin]] targets (ultron-memory). Tauri 2
// bundles every cargo binary of the app package into the installer, but
// tauri-cli looks them up with snake_case names (target/release/ultron_memory)
// while cargo emits the artifact with the literal target name
// (target/release/ultron-memory). Without this shim the bundler dies with
// "failed to bundle project: ... does not exist" on every platform — it broke
// release runs 28778269306 and 28779352946 (v15.6.0).
//
// We copy (never rename: hooks/scripts/docs all consume the dash name) each
// dash-named binary to its snake_case twin right before bundling. Missing
// sources are skipped silently: local builds with bundle targets ["app"] on
// Windows never bundle, and a build without the qdrant feature has no sidecar.
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.join(here, "..", "src-tauri", "target", "release");
const BINS = ["ultron-memory"];

for (const bin of BINS) {
  for (const ext of ["", ".exe"]) {
    const src = path.join(releaseDir, bin + ext);
    const dst = path.join(releaseDir, bin.replace(/-/g, "_") + ext);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`[stage-sidecar] ${src} -> ${dst}`);
    }
  }
}
