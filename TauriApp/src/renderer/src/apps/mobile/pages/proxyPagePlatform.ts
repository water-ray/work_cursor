import type { HelpContent } from "../../../components/form/HelpLabel";

export const mobileProxyPagePlatform = {
  fixedTunMode: true,
  modeSwitchLabel: "VPN 模式",
  modeSwitchHelpContent: {
    effect: "Android 当前固定使用虚拟网卡（VPN/TUN）模式运行。",
    recommendation:
      "启动后才会接管系统流量与 DNS；停止后系统网络与 DNS 将完全回归 Android 本身。",
  } satisfies HelpContent,
  modeSwitchAlertDescription:
    "Android 当前仅支持虚拟网卡（VPN/TUN）模式。未启动代理时不会单独运行最小实例，也不支持节点测速/真连评分；点击启动后会先建立 VPN，再在运行中的代理环境里执行节点评分与优选切换，停止后系统 DNS 与网络完全回交给 Android。",
  smartOptimizeHelpContent: {
    scene: "Android 端希望在 VPN 代理已经建立后，再为当前订阅分组执行评分并自动切到更优节点。",
    effect: "点击“启动”后先建立代理服务，再在运行中的代理环境里执行评分；若优选结果变更节点，会自动刷新服务使其生效。",
    caution: "未启动代理时不会单独拉起最小实例，因此也不支持离线测速/真连评分。",
    recommendation: "默认建议“关闭优选”；需要自动筛选更优节点时再开启。",
  } satisfies HelpContent,
};
