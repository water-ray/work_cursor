import { Router } from "express";

import { listPublicAds } from "../db.js";

export const apiRouter = Router();

apiRouter.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

apiRouter.get("/ads", (_request, response) => {
  response.json({
    items: listPublicAds().map((item) => ({
      id: item.id,
      title: item.title,
      imageUrl: item.imageUrl,
      targetUrl: item.targetUrl,
      summary: item.summary,
      sortOrder: item.sortOrder,
    })),
  });
});
