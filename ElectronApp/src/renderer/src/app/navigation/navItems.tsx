import type { ReactNode } from "react";
import { BiIcon } from "../../components/icons/BiIcon";

export interface NavRoute {
  key: string;
  path: string;
  title: string;
  tip: string;
  label: string;
  icon: ReactNode;
}

export const navRoutes: NavRoute[] = [
  {
    key: "proxy",
    path: "/proxy",
    title: "代理",
    tip: "配置端口、系统代理与虚拟网卡模式",
    label: "代理",
    icon: <BiIcon name="globe2" />,
  },
  {
    key: "subscriptions",
    path: "/subscriptions",
    title: "订阅",
    tip: "管理订阅、分组和节点",
    label: "订阅",
    icon: <BiIcon name="list-ul" />,
  },
  {
    key: "rules",
    path: "/rules",
    title: "规则",
    tip: "配置路由模式和生效分组",
    label: "规则",
    icon: <BiIcon name="diagram-2" />,
  },
  {
    key: "dns",
    path: "/dns",
    title: "DNS",
    tip: "管理远程/直连/节点解析 DNS 与 FakeIP",
    label: "DNS",
    icon: <BiIcon name="diagram-3" />,
  },
 
  {
    key: "logs",
    path: "/logs",
    title: "日志",
    tip: "查看运行日志",
    label: "日志",
    icon: <BiIcon name="journal-text" />,
  },
  {
    key: "airport",
    path: "/airport",
    title: "机场",
    tip: "直连本地 Web 管理首页",
    label: "机场",
    icon: <BiIcon name="airplane" />,
  },
  {
    key: "settings",
    path: "/settings",
    title: "设置",
    tip: "客户端偏好和内核开关",
    label: "设置",
    icon: <BiIcon name="gear" />,
  },
];

export function resolveTitle(pathname: string): string {
  const route = navRoutes.find((item) => pathname.startsWith(item.path));
  return route?.title ?? "wateray";
}
