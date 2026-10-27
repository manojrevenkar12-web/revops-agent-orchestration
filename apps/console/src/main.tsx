import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "./shared/theme/tokens.css";
import "./app.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
