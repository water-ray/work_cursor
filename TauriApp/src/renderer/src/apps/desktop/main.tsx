import React from "react";
import ReactDOM from "react-dom/client";

import { DesktopApp } from "./App";

export function renderDesktopApp(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <DesktopApp />
    </React.StrictMode>,
  );
}
