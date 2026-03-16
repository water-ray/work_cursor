import type { HelpContent } from "../../../components/form/HelpLabel";

export const desktopProxyPagePlatform = {
  fixedTunMode: false,
  modeSwitchLabel: "网卡模式",
  modeSwitchHelpContent: {
    effect: "控制默认启动模式：开启为虚拟网卡模式，关闭为系统代理模式。",
    recommendation:
      "需全局接管流量时优先开启；仅浏览器等显式代理场景可关闭。若当前代理正在运行，切换后会自动刷新服务。",
  } satisfies HelpContent,
  modeSwitchAlertDescription: "",
  smartOptimizeHelpContent: {
    scene:
      "启动前希望自动挑选更稳或更符合地区偏好的节点，例如固定优先某个国家，或日常直接选当前激活订阅分组里的最佳节点。",
    effect:
      "仅在点击“启动”时会先执行评分；选择“订阅激活分组最佳”时会评分当前激活订阅分组全部节点，选择国家时只评分该国家候选节点，以减少检测耗时。",
    caution:
      "“重启服务”不会重新执行智能优选。智能优选仅对当前激活订阅分组生效；国家优选还要求节点具备国家字段。若没有可用候选，系统会回退当前激活节点继续启动并提示警告。",
    recommendation:
      "默认建议“关闭优选”；想始终优先当前订阅分组最佳线路可选“订阅激活分组最佳”；有明确地区偏好时再切换到对应国家。",
  } satisfies HelpContent,
};
