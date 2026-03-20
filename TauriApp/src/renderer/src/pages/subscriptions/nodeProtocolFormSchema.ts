import type { NodeProtocol } from "../../../../shared/daemon";

export type SubscriptionNodeFieldKey =
  | "groupId"
  | "name"
  | "address"
  | "port"
  | "country"
  | "region"
  | "protocol"
  | "transport"
  | "uuid"
  | "alterId"
  | "vmessCipher"
  | "flow"
  | "password"
  | "method"
  | "plugin"
  | "pluginOptions"
  | "username"
  | "tlsEnabled"
  | "tlsMode"
  | "sni"
  | "insecure"
  | "host"
  | "path"
  | "serviceName"
  | "transportHeaders"
  | "transportMethod"
  | "wsMaxEarlyData"
  | "wsEarlyDataHeaderName"
  | "httpIdleTimeout"
  | "httpPingTimeout"
  | "grpcIdleTimeout"
  | "grpcPingTimeout"
  | "grpcPermitWithoutStream"
  | "wireguardLocalAddress"
  | "wireguardPrivateKey"
  | "wireguardPeerPublicKey"
  | "wireguardPreSharedKey"
  | "wireguardReserved"
  | "wireguardMtu";

export interface SubscriptionNodeFormValues {
  groupId: string;
  name: string;
  address: string;
  port: number;
  country: string;
  region: string;
  protocol: NodeProtocol;
  transport: string;
  uuid: string;
  alterId?: number;
  vmessCipher: string;
  flow: string;
  password: string;
  method: string;
  plugin: string;
  pluginOptions: string;
  username: string;
  tlsEnabled: boolean;
  tlsMode: string;
  sni: string;
  insecure: boolean;
  host: string;
  path: string;
  serviceName: string;
  transportHeaders: string;
  transportMethod: string;
  wsMaxEarlyData?: number;
  wsEarlyDataHeaderName: string;
  httpIdleTimeout: string;
  httpPingTimeout: string;
  grpcIdleTimeout: string;
  grpcPingTimeout: string;
  grpcPermitWithoutStream: boolean;
  wireguardLocalAddress: string;
  wireguardPrivateKey: string;
  wireguardPeerPublicKey: string;
  wireguardPreSharedKey: string;
  wireguardReserved: string;
  wireguardMtu?: number;
}

export interface NodeProtocolFormSpec {
  protocol: NodeProtocol;
  label: string;
  description: string;
  defaultTransport: string;
  supportedTransports: string[];
  authFields: SubscriptionNodeFieldKey[];
  transportFields: SubscriptionNodeFieldKey[];
  tlsFields: SubscriptionNodeFieldKey[];
  advancedFields: SubscriptionNodeFieldKey[];
}

export interface TransportOptionSpec {
  value: string;
  label: string;
  protocols: NodeProtocol[];
  source: "wateray" | "sing-box" | "xray";
  unsupportedReason?: string;
  summary?: string;
}

export interface TransportAssistNotice {
  type: "info" | "warning";
  title: string;
  lines: string[];
}

export const supportedNodeProtocols: NodeProtocol[] = [
  "vmess",
  "vless",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "wireguard",
  "socks5",
  "http",
];

const v2rayTransportProtocols: NodeProtocol[] = ["vmess", "vless", "trojan"];

export const transportOptions: TransportOptionSpec[] = [
  {
    value: "tcp",
    label: "TCP",
    protocols: ["vmess", "vless", "trojan", "socks5", "http"],
    source: "wateray",
    summary: "直连 TCP，不叠加额外 V2Ray transport。",
  },
  {
    value: "ws",
    label: "WebSocket",
    protocols: v2rayTransportProtocols,
    source: "sing-box",
    summary: "官方支持，可配合 Host 和 Path 使用。",
  },
  {
    value: "grpc",
    label: "gRPC",
    protocols: v2rayTransportProtocols,
    source: "sing-box",
    summary: "官方支持，真实可编辑字段是 Service Name。",
  },
  {
    value: "quic",
    label: "QUIC",
    protocols: v2rayTransportProtocols,
    source: "sing-box",
    summary: "官方支持，但 sing-box 不提供 Xray 的 QUIC 伪装类型。",
  },
  {
    value: "http",
    label: "HTTP/2",
    protocols: v2rayTransportProtocols,
    source: "sing-box",
    summary: "官方支持，对应 sing-box 的 HTTP transport。",
  },
  {
    value: "httpupgrade",
    label: "HTTP Upgrade",
    protocols: v2rayTransportProtocols,
    source: "sing-box",
    summary: "官方支持，可配合 Host 和 Path 使用。",
  },
  {
    value: "mkcp",
    label: "mKCP",
    protocols: v2rayTransportProtocols,
    source: "xray",
    unsupportedReason: "sing-box 官方明确不支持 mKCP transport。",
    summary: "常见于 Xray/V2Ray 历史配置，仅作识别展示。",
  },
  {
    value: "domainsocket",
    label: "DomainSocket",
    protocols: v2rayTransportProtocols,
    source: "xray",
    unsupportedReason: "sing-box 官方明确不支持 DomainSocket transport。",
    summary: "常见于本地 Unix Socket 场景，仅作识别展示。",
  },
  {
    value: "xhttp",
    label: "XHTTP",
    protocols: v2rayTransportProtocols,
    source: "xray",
    unsupportedReason: "sing-box 官方 transport 列表中没有 XHTTP。",
    summary: "常见扩展模式如 auto、packet-up 仅属于 Xray 语义。",
  },
  {
    value: "udp",
    label: "UDP",
    protocols: ["hysteria2", "tuic", "wireguard"],
    source: "wateray",
    summary: "当前协议固定使用 UDP。",
  },
  {
    value: "-",
    label: "无",
    protocols: ["shadowsocks"],
    source: "wateray",
    summary: "当前协议不额外展示传输层。",
  },
];

export const tlsModeOptions = [
  { value: "tls", label: "TLS" },
  { value: "reality", label: "REALITY" },
] as const;

export const vmessCipherOptions = [
  { value: "auto", label: "auto" },
  { value: "aes-128-gcm", label: "aes-128-gcm" },
  { value: "chacha20-poly1305", label: "chacha20-poly1305" },
  { value: "zero", label: "zero" },
  { value: "none", label: "none" },
] as const;

export const flowOptions = [
  { value: "", label: "空" },
  { value: "xtls-rprx-version", label: "xtls-rprx-version" },
  { value: "xtls-rprx-version-udp443", label: "xtls-rprx-version-udp443" },
] as const;

export const shadowsocksMethodOptions = [
  "aes-128-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
].map((value) => ({
  value,
  label: value,
}));

export const shadowsocksPluginOptions = [
  { value: "simple-obfs", label: "simple-obfs" },
  { value: "obfs-local", label: "obfs-local" },
  { value: "v2ray-plugin", label: "v2ray-plugin" },
].map((item) => ({
  value: item.value,
  label: item.label,
}));

export const nodeProtocolFormSpecs: Record<NodeProtocol, NodeProtocolFormSpec> = {
  vmess: {
    protocol: "vmess",
    label: "VMess",
    description: "基础字段为 UUID，可选 AEAD cipher、传输层和 TLS。",
    defaultTransport: "tcp",
    supportedTransports: ["tcp", "ws", "grpc", "quic", "http", "httpupgrade"],
    authFields: ["uuid", "alterId", "vmessCipher"],
    transportFields: [
      "transport",
      "host",
      "path",
      "serviceName",
      "transportHeaders",
      "transportMethod",
      "wsMaxEarlyData",
      "wsEarlyDataHeaderName",
      "httpIdleTimeout",
      "httpPingTimeout",
      "grpcIdleTimeout",
      "grpcPingTimeout",
      "grpcPermitWithoutStream",
    ],
    tlsFields: ["tlsEnabled", "sni", "insecure"],
    advancedFields: [],
  },
  vless: {
    protocol: "vless",
    label: "VLESS",
    description: "基础字段为 UUID，可选 flow、传输层以及 TLS/REALITY。",
    defaultTransport: "tcp",
    supportedTransports: ["tcp", "ws", "grpc", "quic", "http", "httpupgrade"],
    authFields: ["uuid", "flow"],
    transportFields: [
      "transport",
      "host",
      "path",
      "serviceName",
      "transportHeaders",
      "transportMethod",
      "wsMaxEarlyData",
      "wsEarlyDataHeaderName",
      "httpIdleTimeout",
      "httpPingTimeout",
      "grpcIdleTimeout",
      "grpcPingTimeout",
      "grpcPermitWithoutStream",
    ],
    tlsFields: ["tlsEnabled", "tlsMode", "sni", "insecure"],
    advancedFields: [],
  },
  trojan: {
    protocol: "trojan",
    label: "Trojan",
    description: "基础字段为密码，通常需要 TLS，可选传输层。",
    defaultTransport: "tcp",
    supportedTransports: ["tcp", "ws", "grpc", "quic", "http", "httpupgrade"],
    authFields: ["password"],
    transportFields: [
      "transport",
      "host",
      "path",
      "serviceName",
      "transportHeaders",
      "transportMethod",
      "wsMaxEarlyData",
      "wsEarlyDataHeaderName",
      "httpIdleTimeout",
      "httpPingTimeout",
      "grpcIdleTimeout",
      "grpcPingTimeout",
      "grpcPermitWithoutStream",
    ],
    tlsFields: ["tlsEnabled", "tlsMode", "sni", "insecure"],
    advancedFields: [],
  },
  shadowsocks: {
    protocol: "shadowsocks",
    label: "Shadowsocks",
    description: "基础字段为加密方法与密码，可选 SIP003 插件与插件参数。",
    defaultTransport: "-",
    supportedTransports: ["-"],
    authFields: ["method", "password"],
    transportFields: ["plugin", "pluginOptions"],
    tlsFields: [],
    advancedFields: [],
  },
  hysteria2: {
    protocol: "hysteria2",
    label: "Hysteria2",
    description: "基础字段为密码，默认 UDP + TLS，可补充 SNI。",
    defaultTransport: "udp",
    supportedTransports: ["udp"],
    authFields: ["password"],
    transportFields: [],
    tlsFields: ["tlsEnabled", "tlsMode", "sni", "insecure"],
    advancedFields: [],
  },
  tuic: {
    protocol: "tuic",
    label: "TUIC",
    description: "基础字段为 UUID + 密码，默认 UDP + TLS。",
    defaultTransport: "udp",
    supportedTransports: ["udp"],
    authFields: ["uuid", "password"],
    transportFields: [],
    tlsFields: ["tlsEnabled", "tlsMode", "sni", "insecure"],
    advancedFields: [],
  },
  wireguard: {
    protocol: "wireguard",
    label: "WireGuard",
    description: "通过 sing-box outbound 直出，需填写本地地址、私钥与对端公钥。",
    defaultTransport: "udp",
    supportedTransports: ["udp"],
    authFields: [],
    transportFields: [],
    tlsFields: [],
    advancedFields: [
      "wireguardLocalAddress",
      "wireguardPrivateKey",
      "wireguardPeerPublicKey",
      "wireguardPreSharedKey",
      "wireguardReserved",
      "wireguardMtu",
    ],
  },
  socks5: {
    protocol: "socks5",
    label: "SOCKS5",
    description: "基础字段为地址端口，可选用户名密码。",
    defaultTransport: "tcp",
    supportedTransports: ["tcp"],
    authFields: ["username", "password"],
    transportFields: [],
    tlsFields: [],
    advancedFields: [],
  },
  http: {
    protocol: "http",
    label: "HTTP",
    description: "基础字段为地址端口，可选用户名密码与 HTTPS。",
    defaultTransport: "tcp",
    supportedTransports: ["tcp"],
    authFields: ["username", "password"],
    transportFields: [],
    tlsFields: ["tlsEnabled", "tlsMode", "sni", "insecure"],
    advancedFields: [],
  },
};

export function getNodeProtocolFormSpec(protocol: NodeProtocol): NodeProtocolFormSpec {
  return nodeProtocolFormSpecs[protocol];
}

export function getTransportOptionsForProtocol(protocol: NodeProtocol): TransportOptionSpec[] {
  return transportOptions.filter((option) => option.protocols.includes(protocol));
}

export function getTransportOptionSpec(transport: string): TransportOptionSpec | undefined {
  return transportOptions.find((option) => option.value === transport);
}

export function getTransportAssistNotices(transport: string): TransportAssistNotice[] {
  switch (transport) {
    case "quic":
      return [
        {
          type: "info",
          title: "QUIC 字段边界",
          lines: [
            "sing-box 官方支持 QUIC transport，本面板可直接保存为 `quic`。",
            "当前不需要额外 Host、Path、Service Name 等字段。",
          ],
        },
        {
          type: "warning",
          title: "Xray QUIC 伪装当前不兼容",
          lines: [
            "像 `srtp`、`utp`、`dns`、`dtls`、`wechat-video` 这些伪装类型属于旧版 Xray/V2Ray 的 QUIC 语义，sing-box 不支持。",
            "如果服务端依赖这些伪装字段，当前 sing-box 客户端通常无法兼容，并不是“留空也没关系”。",
          ],
        },
      ];
    case "grpc":
      return [
        {
          type: "info",
          title: "gRPC 可编辑字段",
          lines: [
            "sing-box 官方 gRPC transport 的核心字段是 `service_name`，并支持 keepalive 相关超时与 `permit_without_stream`。",
            "如果服务端未要求 keepalive 类参数，本面板保持最小配置即可。",
          ],
        },
        {
          type: "warning",
          title: "gRPC 兼容边界",
          lines: [
            "`gun`、`multi` 等模式属于 Xray 常见叫法，sing-box 官方 schema 没有这些字段。",
            "当前仓库构建链未显式传入 `with_grpc`，实际兼容性取决于内核构建产物。",
          ],
        },
      ];
    case "xhttp":
      return [
        {
          type: "warning",
          title: "XHTTP 仅作识别展示",
          lines: [
            "sing-box 官方 transport 列表中没有 XHTTP，因此 Wateray 不允许保存该项。",
            "`auto`、`packet-up` 等扩展模式也不会进入提交 payload。",
          ],
        },
      ];
    case "ws":
      return [
        {
          type: "info",
          title: "WebSocket 可编辑字段",
          lines: [
            "除 Host、Path 外，当前还支持额外请求头以及 early data 相关字段。",
            "没有特殊需求时建议只填 Host、Path，其余高级项保持空。",
          ],
        },
      ];
    case "http":
      return [
        {
          type: "info",
          title: "HTTP Transport 可编辑字段",
          lines: [
            "当前支持 Method、额外请求头，以及 HTTP/2 的 idle/ping timeout。",
            "格式化时长请使用 `15s`、`30s`、`1m` 这类 Go duration。",
          ],
        },
      ];
    default:
      return [];
  }
}

export function createDefaultNodeFormValues(
  protocol: NodeProtocol,
  overrides: Partial<SubscriptionNodeFormValues> = {},
): SubscriptionNodeFormValues {
  const spec = getNodeProtocolFormSpec(protocol);
  const tlsEnabledByDefault =
    protocol === "vless" ||
    protocol === "trojan" ||
    protocol === "hysteria2" ||
    protocol === "tuic";
  return {
    groupId: "",
    name: "",
    address: "",
    port: 443,
    country: "",
    region: "",
    protocol,
    transport: spec.defaultTransport,
    uuid: "",
    alterId: undefined,
    vmessCipher: "auto",
    flow: "",
    password: "",
    method: "aes-256-gcm",
    plugin: "",
    pluginOptions: "",
    username: "",
    tlsEnabled: tlsEnabledByDefault,
    tlsMode: "tls",
    sni: "",
    insecure: false,
    host: "",
    path: "",
    serviceName: "",
    transportHeaders: "",
    transportMethod: "",
    wsMaxEarlyData: undefined,
    wsEarlyDataHeaderName: "",
    httpIdleTimeout: "",
    httpPingTimeout: "",
    grpcIdleTimeout: "",
    grpcPingTimeout: "",
    grpcPermitWithoutStream: false,
    wireguardLocalAddress: "",
    wireguardPrivateKey: "",
    wireguardPeerPublicKey: "",
    wireguardPreSharedKey: "",
    wireguardReserved: "",
    wireguardMtu: undefined,
    ...overrides,
  };
}

export function supportsTransportHost(transport: string): boolean {
  return transport === "ws" || transport === "http" || transport === "httpupgrade";
}

export function supportsTransportPath(transport: string): boolean {
  return transport === "ws" || transport === "http" || transport === "httpupgrade";
}

export function supportsTransportServiceName(transport: string): boolean {
  return transport === "grpc";
}

export function supportsTransportHeaders(transport: string): boolean {
  return transport === "ws" || transport === "http" || transport === "httpupgrade";
}

export function supportsTransportMethod(transport: string): boolean {
  return transport === "http";
}

export function supportsWSEarlyData(transport: string): boolean {
  return transport === "ws";
}

export function supportsHTTPTimeouts(transport: string): boolean {
  return transport === "http";
}

export function supportsGRPCKeepalive(transport: string): boolean {
  return transport === "grpc";
}

export function isTransportSelectable(protocol: NodeProtocol, transport: string): boolean {
  return getNodeProtocolFormSpec(protocol).supportedTransports.includes(transport);
}

export function normalizeTransportForProtocol(protocol: NodeProtocol, transport: string): string {
  const spec = getNodeProtocolFormSpec(protocol);
  return spec.supportedTransports.includes(transport) ? transport : spec.defaultTransport;
}

export function protocolLabel(protocol: NodeProtocol): string {
  return getNodeProtocolFormSpec(protocol).label;
}
