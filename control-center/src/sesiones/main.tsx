// Entrada de la ventana «ULTRON Sessions». No importa nada del Control Center.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "./styles/base.css";
import "./styles/chat.css";
import "./styles/bookmarks.css";
import "./styles/search.css";
import "./styles/inspector.css";
import "./styles/hud.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyPrefs, prefsStore } from "./prefs";
import { applyTheme, loadThemeId } from "./themes";
import { initWorkspace } from "./workspace";

applyTheme(loadThemeId());
applyPrefs(prefsStore.getState());
initWorkspace();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="la ventana" detail={<button className="btn sm" onClick={() => window.location.reload()}>Recargar la ventana</button>}>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
