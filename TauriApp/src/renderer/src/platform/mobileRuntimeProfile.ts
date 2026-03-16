import type { ProxyMode } from "../../../shared/daemon";

type UnknownRecord = Record<string, unknown>;

export interface BuildMobileRuntimeProfileInput {
  targetMode: ProxyMode;
  inbounds: UnknownRecord[];
  outbounds: UnknownRecord[];
  dns: UnknownRecord;
  experimental: UnknownRecord;
  routeRules: UnknownRecord[];
  finalOutbound: string;
  mergedRuleSetDefinitions: UnknownRecord[];
  proxySelectorTag: string;
  bootstrapDnsServerTag: string;
  groupName: string;
  selectedNodeName: string;
  selectedNodeId: string;
  logLevel: string;
}

export function buildMobileRuntimeProfile(
  input: BuildMobileRuntimeProfileInput,
): {
  configJson: string;
  profileName: string;
  selectedNodeId: string;
} {
  const config = {
    log: {
      level: input.logLevel,
      timestamp: false,
    },
    inbounds: input.inbounds,
    outbounds: input.outbounds,
    dns: input.dns,
    experimental: input.experimental,
    route: {
      rules: input.routeRules,
      final: input.finalOutbound || input.proxySelectorTag,
      default_domain_resolver: input.bootstrapDnsServerTag,
      auto_detect_interface: input.targetMode === "tun",
      override_android_vpn: input.targetMode === "tun",
      ...(input.mergedRuleSetDefinitions.length > 0
        ? {
            rule_set: input.mergedRuleSetDefinitions,
          }
        : {}),
    },
  };

  return {
    configJson: JSON.stringify(config),
    profileName: `${input.groupName || "移动代理"} · ${input.selectedNodeName}`,
    selectedNodeId: input.selectedNodeId,
  };
}
