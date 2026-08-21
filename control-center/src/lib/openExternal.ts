import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Abre un enlace externo en el navegador del sistema.
 *
 * En la webview de Tauri un `<a target="_blank">` intenta crear una webview
 * nueva y el ACL de capabilities lo rechaza ("... not allowed by ACL"), asi que
 * el click no hace nada visible. El plugin `opener` si esta permitido
 * (`opener:allow-open-url`), de modo que el anchor conserva su href para el
 * menu contextual y el click real se delega al navegador.
 */
export function handleExternalClick(e: MouseEvent<HTMLAnchorElement>): void {
  const href = e.currentTarget.getAttribute("href") ?? "";
  e.preventDefault();
  if (!href || !/^https?:\/\//i.test(href)) return;
  void openUrl(href).catch(() => {
    /* sin navegador disponible: silencioso, el href queda copiable */
  });
}
