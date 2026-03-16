import { BiIcon } from "../../components/icons/BiIcon";
import type { NavRoute } from "../shared/navigationTypes";

const mobileNavRouteCatalog: NavRoute[] = [
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
    tip: "查看机场推广页",
    label: "机场",
    icon: <BiIcon name="airplane" />,
  },
  {
    key: "settings",
    path: "/settings",
    title: "设置",
    tip: "客户端偏好和移动端配置",
    label: "设置",
    icon: <BiIcon name="gear" />,
  },
];

const mobileLogsRoute: NavRoute = {
  key: "logs",
  path: "/logs",
  title: "日志",
  tip: "查看运行日志",
  label: "日志",
  icon: <BiIcon name="journal-text" />,
};

export function buildMobileNavRoutes(showLogs: boolean): NavRoute[] {
  if (!showLogs) {
    return mobileNavRouteCatalog.filter((route) => route.key !== "logs");
  }
  return mobileNavRouteCatalog.map((route) => (route.key === "logs" ? mobileLogsRoute : route));
}

export function resolveMobileTitle(pathname: string): string {
  const route = [...mobileNavRouteCatalog, mobileLogsRoute].find((item) =>
    pathname.startsWith(item.path),
  );
  return route?.title ?? "wateray";
}
