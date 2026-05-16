import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { InboxModal } from "./components/InboxModal";
import "@fontsource-variable/inter";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <InboxModal />
  </React.StrictMode>,
);
