import "antd/dist/reset.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles/global.css";

import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
