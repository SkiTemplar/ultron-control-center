// kill-running-app.mjs — kill any running Control Center before a build.
//
// `tauri build` overwrites src-tauri/target/release/control-center.exe at
// the link step; if the app is running, Windows returns "Acceso denegado"
// (os error 5) and the build aborts. Run this script first.
//
// Used by `npm run build:app`. Safe to invoke when no instance is running.
// No-op on non-Windows platforms (Tauri build still works fine when the
// binary isn't loaded by the OS, which is the macOS/Linux case anyway).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "win32") {
  // Nothing to do on macOS/Linux for this race condition.
  process.exit(0);
}

const exe = resolve(
  process.cwd(),
  "src-tauri",
  "target",
  "release",
  "control-center.exe",
);

function taskkill(image) {
  // /F = force, no /T (that would kill us if we were a child process).
  // 2>nul suppresses the "no process found" error on a clean state.
  spawnSync("taskkill", ["/IM", image, "/F"], {
    stdio: "ignore",
    shell: false,
  });
}

taskkill("control-center.exe");
taskkill("ULTRON Control Center.exe");

// Wait up to 8 s for Windows to release the file handle. taskkill returns
// before the OS finishes tearing down the process.
if (existsSync(exe)) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      const { openSync, closeSync } = await import("node:fs");
      const fd = openSync(exe, "r+");
      closeSync(fd);
      console.log("[kill-app] exe released, proceeding to build.");
      break;
    } catch {
      // Still locked — keep waiting.
    }
  }
}

process.exit(0);
