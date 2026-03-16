import React from "react";
import ReactDOM from "react-dom/client";

import { MobileApp } from "./App";

export function renderMobileApp(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}
