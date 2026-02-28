import {
  ApiOutlined,
  GlobalOutlined,
  HomeOutlined,
  PartitionOutlined,
  SettingOutlined,
  SolutionOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

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
    key: "dashboard",
    path: "/dashboard",
    title: "首页",
    tip: "快速连接与运行状态总览",
    label: "首页",
    icon: <HomeOutlined />,
  },
  {
    key: "subscriptions",
    path: "/subscriptions",
    title: "订阅",
    tip: "管理订阅、分组和节点",
    label: "订阅",
    icon: <UnorderedListOutlined />,
  },
  {
    key: "proxy",
    path: "/proxy",
    title: "代理",
    tip: "配置端口、系统代理与虚拟网卡模式",
    label: "代理",
    icon: <GlobalOutlined />,
  },
  {
    key: "dns",
    path: "/dns",
    title: "DNS",
    tip: "管理远程/直连/节点解析 DNS 与 FakeIP",
    label: "DNS",
    icon: <ApiOutlined />,
  },
  {
    key: "rules",
    path: "/rules",
    title: "规则",
    tip: "配置路由模式和生效分组",
    label: "规则",
    icon: <PartitionOutlined />,
  },
  {
    key: "logs",
    path: "/logs",
    title: "日志",
    tip: "查看运行日志",
    label: "日志",
    icon: <SolutionOutlined />,
  },
  {
    key: "settings",
    path: "/settings",
    title: "设置",
    tip: "客户端偏好和内核开关",
    label: "设置",
    icon: <SettingOutlined />,
  },
];

export function resolveTitle(pathname: string): string {
  const route = navRoutes.find((item) => pathname.startsWith(item.path));
  return route?.title ?? "wateray";
}
