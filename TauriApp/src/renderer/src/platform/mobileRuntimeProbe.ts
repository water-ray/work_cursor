import type { DaemonSnapshot, VpnNode } from "../../../shared/daemon";
import type { MobileResolverContext } from "./mobileRuntimeConfig";

type UnknownRecord = Record<string, unknown>;

export interface BuildMobileProbeProfileInput {
  snapshot: DaemonSnapshot;
  node: VpnNode;
  resolverContext: MobileResolverContext;
  socksPort: number;
  runtimeNodeTag: (nodeId: string) => string;
  buildNodeOutbound: (node: VpnNode, tag: string) => UnknownRecord;
  buildDnsConfig: (
    snapshot: DaemonSnapshot,
    finalOutbound: string,
    resolverContext: MobileResolverContext,
    options?: {
      fakeipEnabled?: boolean;
    },
  ) => UnknownRecord;
  dnsDirectOutboundTag: string;
  bootstrapDnsServerTag: string;
  defaultProbeSocksListenAddress: string;
}

export function buildMobileProbeProfile(input: BuildMobileProbeProfileInput): string {
  const tag = input.runtimeNodeTag(input.node.id);
  const config = {
    log: {
      level: "error",
      timestamp: false,
    },
    inbounds: [
      {
        type: "socks",
        tag: "probe-in",
        listen: input.defaultProbeSocksListenAddress,
        listen_port: input.socksPort,
      },
    ],
    outbounds: [
      input.buildNodeOutbound(input.node, tag),
      {
        type: "direct",
        tag: input.dnsDirectOutboundTag,
        connect_timeout: "5s",
      },
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
    ],
    dns: input.buildDnsConfig(input.snapshot, tag, input.resolverContext, { fakeipEnabled: false }),
    route: {
      rules: [
        {
          inbound: ["probe-in"],
          outbound: tag,
        },
      ],
      final: tag,
      default_domain_resolver: input.bootstrapDnsServerTag,
    },
  };
  return JSON.stringify(config);
}
