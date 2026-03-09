import cookieParser from "cookie-parser";
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { config, resolveWebDistPath } from "./config.js";
import { getDatabasePath } from "./db/client.js";
import { ensureDefaultAdmin, migrateDatabase } from "./db/migrate.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";
import { userRouter } from "./routes/user.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((request, response, next) => {
  const origin = String(request.headers.origin ?? "").trim();
  if (origin && config.corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.use("/api", publicRouter);
app.use("/api/auth", authRouter);
app.use("/api/user", userRouter);
app.use("/api/admin", adminRouter);

const webDistPath = resolveWebDistPath();
const webIndexPath = join(webDistPath, "index.html");
const hasWebDist = existsSync(webIndexPath);

if (hasWebDist) {
  app.use(express.static(webDistPath));
  app.get("/{*path}", (request, response, next) => {
    if (request.path === "/api" || request.path.startsWith("/api/")) {
      next();
      return;
    }
    response.sendFile(webIndexPath);
  });
} else {
  app.get("/", (_request, response) => {
    response.type("text/plain; charset=utf-8").send(
      "Wateray Ads Server is running. Build adsroot/web and place dist bundle for SPA UI.",
    );
  });
}

app.use((_request, response) => {
  response.status(404).json({
    ok: false,
    error: "not found",
  });
});

function main() {
  migrateDatabase();
  const adminUser = ensureDefaultAdmin();
  app.listen(config.port, config.host, () => {
    console.log(`[ads-server] listening on http://${config.host}:${config.port}`);
    console.log(`[ads-server] database -> ${getDatabasePath()}`);
    if (adminUser.created) {
      console.log("[ads-server] detected empty database, initialized bootstrap data");
      console.log(
        `[ads-server] bootstrap admin -> ${adminUser.username} (password from ADS_SERVER_DEFAULT_ADMIN_PASSWORD)`,
      );
    } else {
      console.log(`[ads-server] admin account -> ${adminUser.username}`);
    }
    if (hasWebDist) {
      console.log(`[ads-server] web dist -> ${webDistPath}`);
    } else {
      console.log("[ads-server] web dist not found, serving fallback root message");
    }
  });
}

main();
