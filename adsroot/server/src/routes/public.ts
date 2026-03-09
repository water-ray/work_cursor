import { Router } from "express";

import { listAds } from "../db/repositories/adsRepo.js";

export const publicRouter = Router();

function mapPublicAd(item: ReturnType<typeof listAds>[number]) {
  return {
    id: item.id,
    title: item.title,
    imageUrl: item.imageUrl,
    targetUrl: item.targetUrl,
    summary: item.summary,
    sortOrder: item.sortOrder,
  };
}

publicRouter.get("/ads", (_request, response) => {
  response.json({
    ok: true,
    items: listAds(false).map(mapPublicAd),
  });
});

publicRouter.get("/public/home", (_request, response) => {
  response.json({
    ok: true,
    hero: {
      title: "Wateray VPN 客户端",
      slogan: "像水一样流畅，雷电般迅猛",
      description:
        "Wateray 是面向多平台的 VPN 桌面客户端，聚焦稳定连接、快速切换与清晰可控的代理体验。登录后可云端保存个人客户端配置，随时随地使用",
      techStacks: [
        "桌面端 UI：Electron + React + TypeScript",
        "核心运行时：Go（waterayd 守护进程）",
        "核心代理：sing-box",
       
      ],
    },
    ads: listAds(false).map(mapPublicAd),
  });
});
