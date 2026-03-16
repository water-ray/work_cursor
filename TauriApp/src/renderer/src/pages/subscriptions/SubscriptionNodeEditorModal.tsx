import { Alert, AutoComplete, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Typography, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeGroup, NodeProtocol, VpnNode } from "../../../../shared/daemon";
import { countryMetadataList } from "../../app/data/countryMetadata";
import { CountryFlag } from "../../components/flag/CountryFlag";
import { HelpLabel } from "../../components/form/HelpLabel";
import type { HelpContent } from "../../components/form/HelpLabel";
import { isMobileRuntime } from "../../platform/runtimeStore";
import {
  decodeNodeToFormValues,
  encodeNodeFormToCreatePayload,
  encodeNodeFormToUpdatePayload,
} from "./nodeProtocolFormCodec";
import {
  createDefaultNodeFormValues,
  getTransportOptionsForProtocol,
  getNodeProtocolFormSpec,
  normalizeTransportForProtocol,
  protocolLabel,
  type SubscriptionNodeFieldKey,
  shadowsocksMethodOptions,
  supportedNodeProtocols,
  supportsGRPCKeepalive,
  supportsHTTPTimeouts,
  supportsTransportHost,
  supportsTransportHeaders,
  supportsTransportMethod,
  supportsTransportPath,
  supportsTransportServiceName,
  supportsWSEarlyData,
  flowOptions,
  tlsModeOptions,
  vmessCipherOptions,
  type SubscriptionNodeFormValues,
} from "./nodeProtocolFormSchema";

interface EditingNodeContext {
  groupId: string;
  node: VpnNode;
}

interface SubscriptionNodeEditorModalProps {
  open: boolean;
  mode: "add" | "edit";
  manualGroups: NodeGroup[];
  initialProtocol: NodeProtocol;
  initialGroupId: string;
  editingNode?: EditingNodeContext | null;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (
    payload: ReturnType<typeof encodeNodeFormToCreatePayload> | ReturnType<typeof encodeNodeFormToUpdatePayload>,
  ) => Promise<void>;
}

const countryOptions = countryMetadataList.map((metadata) => ({
  value: metadata.code,
  label: (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <CountryFlag code={metadata.code} ariaLabel={metadata.chineseName} />
      <span>{metadata.chineseName} · {metadata.code}</span>
    </span>
  ),
  searchText: metadata.searchText,
}));

const formLabelCol = { flex: "112px" as const };
const formWrapperCol = { flex: "auto" as const };
const compactLabelCol = { flex: "86px" as const };
const compactWrapperCol = { flex: "auto" as const };

const fieldHelpMap: Partial<Record<SubscriptionNodeFieldKey | "address" | "port" | "country", HelpContent>> = {
  groupId: {
    scene: "选择节点要写入的普通分组。",
    effect: "决定该节点出现在什么分组里，后续右键编辑也基于这个分组。",
    caution: "只能写入普通分组，订阅分组节点不直接编辑。",
    recommendation: "建议按用途拆分普通分组，例如“自建节点”“临时测试”。",
  },
  name: {
    scene: "用于列表展示和快速识别节点。",
    effect: "不会直接参与协议握手，但会影响你在表格、日志里的辨识度。",
    caution: "尽量不要只写数字，后续排查时不容易区分。",
    recommendation: "推荐“地区 + 协议/线路”，例如“日本东京 VLESS 01”。",
  },
  address: {
    scene: "服务端域名或 IP。",
    effect: "这是节点真正连接的目标地址。",
    caution: "域名可配合 SNI/CDN 使用；如果是 IP，确认端口和证书匹配。",
    recommendation: "优先填服务端实际接入域名，便于 TLS/SNI 一起配置。",
  },
  port: {
    scene: "服务端监听端口。",
    effect: "决定客户端连接到服务器的哪个端口。",
    caution: "端口错了通常会直接连不上，和传输层/TLS 也要匹配。",
    recommendation: "按服务端真实配置填写，常见如 443、8443、80、8080。",
  },
  country: {
    scene: "给节点补充国家信息，便于列表展示和筛选。",
    effect: "会影响国家列显示，也可配合优选、分组查看。",
    caution: "这不是协议必填项，填错不会阻止连接，但会误导展示。",
    recommendation: "有明确国家就填写，没有就留空。",
  },
  protocol: {
    scene: "决定该节点使用哪种代理协议。",
    effect: "切换协议后右侧字段会随之变化，并重置不兼容配置。",
    caution: "协议切换后原协议专属字段不会保留。",
    recommendation: "按节点实际协议选择，不要只凭端口猜测。",
  },
  transport: {
    scene: "用于配置协议上的传输层包装方式。",
    effect: "会决定是否需要 Host、Path、gRPC Service Name 等附加字段，也会影响节点最终生成的 rawConfig。",
    caution: "下拉中的灰显项只用于识别常见 Xray 配置，不代表当前 sing-box 内核可直接使用。",
    recommendation: "优先选择服务端明确提供且 sing-box 官方支持的传输，例如 `tcp`、`ws`、`grpc`、`quic`。",
  },
  uuid: {
    scene: "VMess、VLESS、TUIC 常用的身份标识。",
    effect: "用于服务端认证，是连接能否成功的核心字段。",
    caution: "格式错误或复制多空格都会认证失败。",
    recommendation: "直接粘贴服务端给出的 UUID，避免手输。",
  },
  alterId: {
    scene: "旧 VMess 节点可能仍会使用。",
    effect: "兼容部分历史 VMess 配置。",
    caution: "大多数新节点已经不需要，乱填可能导致不兼容。",
    recommendation: "没有明确要求时保持空或 0。",
  },
  vmessCipher: {
    scene: "VMess 的加密方式。",
    effect: "决定 VMess 数据加密模式。",
    caution: "需和服务端兼容，老旧配置才需要手动指定。",
    recommendation: "一般使用 `auto`。",
  },
  flow: {
    scene: "VLESS + XTLS/REALITY 场景使用。",
    effect: "决定特定流控模式，例如 Vision。",
    caution: "只有服务端明确给出 flow 时才填写。",
    recommendation: "常见为 `xtls-rprx-vision`，普通 VLESS 留空即可。",
  },
  password: {
    scene: "Trojan、Shadowsocks、Hysteria2、TUIC、HTTP/SOCKS 认证都会用到。",
    effect: "用于身份验证或共享密钥。",
    caution: "密码区分大小写，复制时注意首尾空格。",
    recommendation: "直接粘贴服务端提供值；HTTP/SOCKS 没开认证可留空。",
  },
  method: {
    scene: "Shadowsocks 节点必须指定加密方法。",
    effect: "决定 Shadowsocks 使用的 cipher。",
    caution: "必须和服务端完全一致。",
    recommendation: "优先使用 AEAD/2022 系列，除非服务端只支持旧方法。",
  },
  username: {
    scene: "SOCKS5/HTTP 开启认证时使用。",
    effect: "和密码一起组成认证信息。",
    caution: "未启用认证时不要乱填。",
    recommendation: "只有服务端明确开启账号认证时再填写。",
  },
  tlsEnabled: {
    scene: "需要 HTTPS/TLS/REALITY 的场景。",
    effect: "打开后会启用证书握手与相关字段。",
    caution: "服务端未启用 TLS 时不要强开。",
    recommendation: "443 端口、域名接入的节点通常优先检查是否应启用。",
  },
  tlsMode: {
    scene: "选择普通 TLS 或 REALITY。",
    effect: "影响客户端握手方式。",
    caution: "REALITY 只在服务端明确支持时使用。",
    recommendation: "默认 `tls`，仅当服务端明确给出 REALITY 配置时切换。",
  },
  sni: {
    scene: "TLS/REALITY 常用字段。",
    effect: "指定握手时使用的 Server Name。",
    caution: "和证书域名/CDN 回源域名不一致会导致握手失败。",
    recommendation: "通常填写服务端给出的域名，例如 `www.google.com` 或站点主域名。",
  },
  insecure: {
    scene: "测试环境、自签证书或临时排障。",
    effect: "跳过证书校验。",
    caution: "会降低安全性，不建议长期开启。",
    recommendation: "优先关闭，仅在你确定证书校验确实过不去时临时开启。",
  },
  host: {
    scene: "WS / HTTP Upgrade / H2 常用。",
    effect: "用于伪装请求头中的 Host / Authority。",
    caution: "需和服务端/CDN 配置一致。",
    recommendation: "使用服务端给出的域名，不要随意填写。",
  },
  path: {
    scene: "WS / HTTP Upgrade / H2 路径伪装。",
    effect: "决定请求路径，常用于区分不同入口。",
    caution: "路径不匹配会直接握手失败。",
    recommendation: "按服务端原样填写，例如 `/ray`、`/ws`。",
  },
  serviceName: {
    scene: "gRPC 传输使用。",
    effect: "指定 gRPC service name。",
    caution: "必须和服务端一致，大小写也要一致。",
    recommendation: "直接使用服务端提供值。",
  },
  transportHeaders: {
    scene: "WS / HTTP / HTTP Upgrade 需要自定义请求头时使用。",
    effect: "会写入 transport 的 headers，常用于兼容反代或特殊服务端校验。",
    caution: "格式使用一行一个 `Header: value`，名称和值之间必须有冒号。",
    recommendation: "没有明确要求时留空，优先只填 Host 与 Path。",
  },
  transportMethod: {
    scene: "HTTP transport 需要指定请求方法时使用。",
    effect: "写入 sing-box HTTP transport 的 `method` 字段。",
    caution: "仅 HTTP transport 生效，且必须与服务端校验逻辑一致。",
    recommendation: "通常保持空，只有服务端明确要求时再填写例如 `GET` 或 `POST`。",
  },
  wsMaxEarlyData: {
    scene: "WS 需要启用 early data 时使用。",
    effect: "控制可提前携带的请求负载大小。",
    caution: "只有服务端明确支持 early data 时才应配置，否则可能握手失败。",
    recommendation: "没有明确要求时保持空或 0。",
  },
  wsEarlyDataHeaderName: {
    scene: "WS early data 的头名称。",
    effect: "控制 early data 通过哪个 header 传递。",
    caution: "需与服务端完全一致；兼容 Xray 常见场景时可能会用到 `Sec-WebSocket-Protocol`。",
    recommendation: "只有服务端明确给出时再填写。",
  },
  httpIdleTimeout: {
    scene: "HTTP transport 长连接保活控制。",
    effect: "控制闲置连接的探活或关闭时机。",
    caution: "格式使用 Go duration，例如 `15s`、`30s`、`1m`。",
    recommendation: "没有特殊需求时留空，使用 sing-box 默认值。",
  },
  httpPingTimeout: {
    scene: "HTTP/2 transport 的 ping 响应超时。",
    effect: "用于探测连接是否仍然可用。",
    caution: "值过小可能导致弱网环境下误判断连。",
    recommendation: "没有特殊需求时留空，或按服务端建议填写如 `15s`。",
  },
  grpcIdleTimeout: {
    scene: "gRPC keepalive 空闲探活间隔。",
    effect: "控制空闲连接多久后发起健康检查。",
    caution: "格式使用 Go duration，且并非所有部署都需要主动 keepalive。",
    recommendation: "无明确需求时留空。",
  },
  grpcPingTimeout: {
    scene: "gRPC keepalive 探活等待时长。",
    effect: "决定发送 ping 后等待响应的超时时间。",
    caution: "值过小会在高延迟环境里误判失败。",
    recommendation: "没有明确需求时留空，常见示例为 `15s`。",
  },
  grpcPermitWithoutStream: {
    scene: "gRPC 在无活跃流时也持续发送 keepalive。",
    effect: "打开后即使没有活动请求也会继续探活。",
    caution: "会增加额外保活流量，部分服务端或网络环境不需要。",
    recommendation: "默认关闭，只有服务端明确要求时再开启。",
  },
  wireguardLocalAddress: {
    scene: "WireGuard 虚拟网卡地址。",
    effect: "决定本地隧道地址段。",
    caution: "一行一个 CIDR，不要漏掉掩码。",
    recommendation: "按服务端分配的地址原样填写，可同时填 IPv4/IPv6。",
  },
  wireguardPrivateKey: {
    scene: "WireGuard 客户端私钥。",
    effect: "用于隧道身份认证。",
    caution: "不要泄露，也不要和服务端公钥填反。",
    recommendation: "直接使用客户端私钥原文。",
  },
  wireguardPeerPublicKey: {
    scene: "WireGuard 服务端公钥。",
    effect: "用于验证对端身份。",
    caution: "填错会导致握手失败。",
    recommendation: "使用服务端提供的 peer public key。",
  },
  wireguardPreSharedKey: {
    scene: "可选的额外共享密钥。",
    effect: "为 WireGuard 增加一层额外保护。",
    caution: "只有服务端启用了 PSK 时才填写。",
    recommendation: "没有就留空。",
  },
  wireguardReserved: {
    scene: "部分特殊 WireGuard 配置需要。",
    effect: "透传到 sing-box outbound 的 reserved 字段。",
    caution: "格式使用逗号分隔整数，例如 `1, 2, 3`。",
    recommendation: "没有明确要求时留空。",
  },
  wireguardMtu: {
    scene: "网络环境特殊时可手动调优。",
    effect: "影响隧道包大小。",
    caution: "乱改可能导致分片或连接不稳定。",
    recommendation: "无特别需求保持空，交给默认值。",
  },
};

function fieldLabel(key: keyof typeof fieldHelpMap, label: string, fullLabel?: string) {
  return <HelpLabel label={label} helpContent={fieldHelpMap[key]} helpTitle={`${fullLabel ?? label} 说明`} />;
}

function renderEmptyPanel(text: string) {
  return <Typography.Text type="secondary">{text}</Typography.Text>;
}

const desktopCompactFormItemLayout = {
  labelCol: compactLabelCol,
  wrapperCol: compactWrapperCol,
};

const browserUserAgentOptions = [
  {
    value: "none",
    label: "none",
    userAgent: "",
  },
  {
    value: "chrome",
    label: "Chrome",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  },
  {
    value: "edge",
    label: "Edge",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
  },
  {
    value: "firefox",
    label: "Firefox",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  },
  {
    value: "safari",
    label: "Safari",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  },
] as const;

function upsertUserAgentHeader(headersText: string, userAgent: string): string {
  const lines = headersText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const result: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      result.push(line);
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (key.toLowerCase() !== "user-agent") {
      result.push(line);
      continue;
    }
    if (userAgent !== "") {
      result.push(`User-Agent: ${userAgent}`);
      replaced = true;
    }
  }
  if (!replaced && userAgent !== "") {
    result.unshift(`User-Agent: ${userAgent}`);
  }
  return result.join("\n");
}

function resolveUserAgentPreset(headersText: string): string {
  const match = headersText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("user-agent:"));
  if (!match) {
    return "none";
  }
  const headerValue = match.slice(match.indexOf(":") + 1).trim();
  const matchedOption = browserUserAgentOptions.find(
    (option) => option.userAgent !== "" && option.userAgent === headerValue,
  );
  return matchedOption?.value ?? "none";
}

export function SubscriptionNodeEditorModal({
  open,
  mode,
  manualGroups,
  initialProtocol,
  initialGroupId,
  editingNode,
  submitting,
  onCancel,
  onSubmit,
}: SubscriptionNodeEditorModalProps) {
  const isMobileView = isMobileRuntime();
  const [form] = Form.useForm<SubscriptionNodeFormValues>();
  const initializedStateRef = useRef<string>("");
  const [transportHeadersExpanded, setTransportHeadersExpanded] = useState(false);
  const compactFormItemLayout = isMobileView ? {} : desktopCompactFormItemLayout;
  const mainFormLayout = isMobileView ? "vertical" : "horizontal";
  const mainColumnSpan = isMobileView ? 24 : 10;
  const sideColumnSpan = isMobileView ? 24 : 14;
  const halfColumnSpan = isMobileView ? 24 : 12;
  const modalGridGutter = isMobileView ? ([0, 12] as [number, number]) : ([12, 0] as [number, number]);
  const compactGridGutter =
    isMobileView ? ([0, 10] as [number, number]) : ([12, 0] as [number, number]);
  const transportHeaderGutter =
    isMobileView ? ([0, 8] as [number, number]) : ([8, 0] as [number, number]);
  const transportHeaderEditorFlex = isMobileView ? "100%" : "auto";
  const transportHeaderPresetFlex = isMobileView ? "100%" : "160px";
  const currentProtocol = Form.useWatch("protocol", form) ?? editingNode?.node.protocol ?? initialProtocol;
  const currentTransport = Form.useWatch("transport", form) ?? "";
  const currentTlsEnabled = Form.useWatch("tlsEnabled", form) ?? false;
  const currentTransportHeaders = Form.useWatch("transportHeaders", form) ?? "";
  const protocolSpec = useMemo(
    () => getNodeProtocolFormSpec(currentProtocol),
    [currentProtocol],
  );
  const currentUserAgentPreset = useMemo(
    () => resolveUserAgentPreset(currentTransportHeaders),
    [currentTransportHeaders],
  );
  const transportSelectOptions = useMemo(
    () =>
      getTransportOptionsForProtocol(currentProtocol).map((option) => {
        const selectable = protocolSpec.supportedTransports.includes(option.value);
        const suffix = selectable
          ? option.source === "sing-box"
            ? "sing-box"
            : undefined
          : "sing-box 不支持";
        return {
          value: option.value,
          disabled: !selectable,
          label: (
            <Space size={8}>
              <span>{option.label}</span>
              {suffix ? <Typography.Text type="secondary">{suffix}</Typography.Text> : null}
            </Space>
          ),
        };
      }),
    [currentProtocol, protocolSpec.supportedTransports],
  );
  const initializeStateKey =
    mode === "edit"
      ? `edit:${editingNode?.node.id ?? ""}:${editingNode?.groupId ?? ""}`
      : `add:${initialProtocol}:${initialGroupId}`;
  useEffect(() => {
    if (!open) {
      initializedStateRef.current = "";
      setTransportHeadersExpanded(false);
      return;
    }
    if (initializedStateRef.current === initializeStateKey) {
      return;
    }
    initializedStateRef.current = initializeStateKey;
    if (mode === "edit" && editingNode) {
      form.resetFields();
      form.setFieldsValue(decodeNodeToFormValues(editingNode.groupId, editingNode.node));
      return;
    }
    form.resetFields();
    form.setFieldsValue(
      createDefaultNodeFormValues(initialProtocol, {
        groupId: initialGroupId,
      }),
    );
  }, [editingNode, form, initialGroupId, initialProtocol, initializeStateKey, mode, open]);

  const handleFinish = async () => {
    try {
      await form.validateFields();
    } catch (error) {
      const errorFields =
        error && typeof error === "object" && "errorFields" in error
          ? ((error as { errorFields?: Array<{ name?: (string | number)[] }> }).errorFields ?? [])
          : [];
      const firstError = errorFields[0];
      if (firstError?.name && firstError.name.length > 0) {
        form.scrollToField(firstError.name, {
          block: "center",
        });
      }
      void message.warning("请先完善必填项后再保存");
      return;
    }
    try {
      const values = form.getFieldsValue(true) as SubscriptionNodeFormValues;
      if (mode === "edit" && editingNode) {
        await onSubmit(encodeNodeFormToUpdatePayload(editingNode.node.id, values));
        return;
      }
      await onSubmit(encodeNodeFormToCreatePayload(values));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "保存节点失败");
    }
  };

  return (
    <Modal
      title={mode === "edit" ? "编辑节点" : "添加节点"}
      open={open}
      width={isMobileView ? "calc(100vw - 16px)" : 1120}
      destroyOnHidden
      maskClosable={false}
      okText={mode === "edit" ? "保存" : "添加"}
      cancelText="取消"
      confirmLoading={submitting}
      styles={{
        body: {
          padding: isMobileView ? 12 : undefined,
        },
      }}
      onCancel={onCancel}
      onOk={() => {
        void handleFinish();
      }}
    >
      {manualGroups.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message="当前没有可写入的普通分组"
          description="请先创建一个普通分组，再添加或编辑手动节点。"
        />
      ) : null}
      <Form<SubscriptionNodeFormValues>
        layout={mainFormLayout}
        colon={false}
        labelAlign="left"
        labelCol={isMobileView ? undefined : formLabelCol}
        wrapperCol={isMobileView ? undefined : formWrapperCol}
        form={form}
        size={isMobileView ? "small" : "middle"}
        style={{ marginTop: 8 }}
        onValuesChange={(changedValues, allValues) => {
          if ("protocol" in changedValues) {
            const nextProtocol = changedValues.protocol ?? allValues.protocol;
            const commonValues = {
              groupId: allValues.groupId,
              name: allValues.name,
              address: allValues.address,
              port: allValues.port,
              country: allValues.country,
            };
            form.setFieldsValue(
              createDefaultNodeFormValues(nextProtocol, commonValues),
            );
            return;
          }
          if ("transport" in changedValues) {
            const nextTransport = normalizeTransportForProtocol(
              allValues.protocol,
              String(changedValues.transport ?? allValues.transport ?? ""),
            );
            const patch: Partial<SubscriptionNodeFormValues> = {};
            if (nextTransport !== allValues.transport) {
              patch.transport = nextTransport;
            }
            if (!supportsTransportHost(nextTransport)) {
              patch.host = "";
            }
            if (!supportsTransportPath(nextTransport)) {
              patch.path = "";
            }
            if (!supportsTransportServiceName(nextTransport)) {
              patch.serviceName = "";
            }
            if (!supportsTransportHeaders(nextTransport)) {
              patch.transportHeaders = "";
            }
            if (!supportsTransportMethod(nextTransport)) {
              patch.transportMethod = "";
            }
            if (!supportsWSEarlyData(nextTransport)) {
              patch.wsMaxEarlyData = undefined;
              patch.wsEarlyDataHeaderName = "";
            }
            if (!supportsHTTPTimeouts(nextTransport)) {
              patch.httpIdleTimeout = "";
              patch.httpPingTimeout = "";
            }
            if (!supportsGRPCKeepalive(nextTransport)) {
              patch.grpcIdleTimeout = "";
              patch.grpcPingTimeout = "";
              patch.grpcPermitWithoutStream = false;
            }
            if (Object.keys(patch).length > 0) {
              form.setFieldsValue(patch);
            }
          }
          if ("tlsEnabled" in changedValues && !allValues.tlsEnabled) {
            form.setFieldsValue({
              tlsMode: "tls",
              sni: "",
              insecure: false,
            });
          }
        }}
      >
        <Form.Item name="groupId" hidden>
          <Input />
        </Form.Item>
        <Row gutter={modalGridGutter}>
          <Col span={mainColumnSpan}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Card
                size="small"
                title={<Typography.Text strong>基础信息</Typography.Text>}
                styles={{ body: { paddingBottom: 0 } }}
              >
                <Form.Item
                  label={fieldLabel("protocol", "协议类型")}
                  name="protocol"
                  rules={[{ required: true, message: "请选择协议类型" }]}
                  style={{ marginBottom: 12 }}
                >
                  <Select
                    disabled={mode === "edit"}
                    options={supportedNodeProtocols.map((protocol) => ({
                      value: protocol,
                      label: protocolLabel(protocol),
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  label={fieldLabel("name", "节点名称")}
                  name="name"
                  rules={[{ required: true, message: "请输入节点名称" }]}
                  style={{ marginBottom: 12 }}
                >
                  <Input placeholder="例如：日本东京 VLESS 01" />
                </Form.Item>
                <Form.Item
                  label={fieldLabel("address", "服务器地址")}
                  name="address"
                  rules={[{ required: true, message: "请输入服务器地址" }]}
                  style={{ marginBottom: 12 }}
                >
                  <Input placeholder="example.com 或 1.2.3.4" />
                </Form.Item>
                <Form.Item
                  label={fieldLabel("port", "端口")}
                  name="port"
                  rules={[{ required: true, message: "请输入端口" }]}
                  style={{ marginBottom: 12 }}
                >
                  <InputNumber min={1} max={65535} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={fieldLabel("country", "国家")} name="country" style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="searchText"
                    placeholder="可选，优先用于国家列"
                    options={countryOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                      searchText: option.searchText,
                    }))}
                  />
                </Form.Item>
              </Card>

              <Card
                size="small"
                title={<Typography.Text strong>协议字段</Typography.Text>}
                styles={{ body: { paddingBottom: 0 } }}
              >
                {protocolSpec.authFields.length === 0 ? renderEmptyPanel("当前协议没有额外认证字段。") : null}
                {protocolSpec.authFields.includes("uuid") ? (
                  <Form.Item
                    label={fieldLabel("uuid", "UUID")}
                    name="uuid"
                    rules={[{ required: true, message: "请输入 UUID" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("alterId") ? (
                  <Form.Item label={fieldLabel("alterId", "Alter ID")} name="alterId" style={{ marginBottom: 12 }}>
                    <InputNumber min={0} style={{ width: "100%" }} />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("vmessCipher") ? (
                  <Form.Item label={fieldLabel("vmessCipher", "VMess Cipher")} name="vmessCipher" style={{ marginBottom: 12 }}>
                    <Select options={vmessCipherOptions as unknown as { value: string; label: string }[]} />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("flow") ? (
                  <Form.Item label={fieldLabel("flow", "Flow")} name="flow" style={{ marginBottom: 12 }}>
                    <AutoComplete
                      options={flowOptions.map((item) => ({ value: item.value, label: item.label }))}
                      placeholder="留空或选择常用 Flow"
                      filterOption={(inputValue, option) =>
                        String(option?.value ?? "")
                          .toLowerCase()
                          .includes(inputValue.toLowerCase())
                      }
                    />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("method") ? (
                  <Form.Item
                    label={fieldLabel("method", "加密方法")}
                    name="method"
                    rules={[{ required: true, message: "请选择或输入加密方法" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Select showSearch options={shadowsocksMethodOptions} />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("username") ? (
                  <Form.Item label={fieldLabel("username", "用户名")} name="username" style={{ marginBottom: 12 }}>
                    <Input placeholder="可选" />
                  </Form.Item>
                ) : null}
                {protocolSpec.authFields.includes("password") ? (
                  <Form.Item
                    label={fieldLabel("password", "密码")}
                    name="password"
                    rules={[{ required: !protocolSpec.authFields.includes("username"), message: "请输入密码" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Input.Password placeholder="请输入密码或密钥" />
                  </Form.Item>
                ) : null}
              </Card>
            </Space>
          </Col>
          <Col span={sideColumnSpan}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Card
                size="small"
                title={<Typography.Text strong>传输层</Typography.Text>}
                styles={{ body: { paddingBottom: 0 } }}
              >
                {protocolSpec.transportFields.length === 0 && protocolSpec.tlsFields.length === 0
                  ? renderEmptyPanel("当前协议没有额外传输层配置。")
                  : null}
                {protocolSpec.transportFields.includes("transport") ? (
                  <Form.Item label={fieldLabel("transport", "传输协议")} name="transport" style={{ marginBottom: 12 }}>
                    <Select options={transportSelectOptions} />
                  </Form.Item>
                ) : null}
                {supportsTransportHost(currentTransport) || supportsTransportPath(currentTransport) ? (
                  <Row gutter={compactGridGutter}>
                    {supportsTransportHost(currentTransport) ? (
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("host", "Host")}
                          name="host"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Input placeholder="例如：cdn.example.com" />
                        </Form.Item>
                      </Col>
                    ) : null}
                    {supportsTransportPath(currentTransport) ? (
                      <Col span={halfColumnSpan}>
                        <Form.Item label={fieldLabel("path", "Path")} name="path" style={{ marginBottom: 12 }} {...compactFormItemLayout}>
                          <Input placeholder="例如：/ray" />
                        </Form.Item>
                      </Col>
                    ) : null}
                  </Row>
                ) : null}
                {supportsTransportServiceName(currentTransport) ? (
                  <Form.Item
                    label={fieldLabel("serviceName", "服务名", "Service Name")}
                    name="serviceName"
                    style={{ marginBottom: 12 }}
                    {...compactFormItemLayout}
                  >
                    <Input placeholder="例如：grpc-service" />
                  </Form.Item>
                ) : null}
                {supportsTransportMethod(currentTransport) ? (
                  <Form.Item
                    label={fieldLabel("transportMethod", "方法", "HTTP Method")}
                    name="transportMethod"
                    style={{ marginBottom: 12 }}
                    {...compactFormItemLayout}
                  >
                    <Input placeholder="例如：GET" />
                  </Form.Item>
                ) : null}
                {supportsTransportHeaders(currentTransport) ? (
                  <Form.Item
                    label={fieldLabel("transportHeaders", "请求头", "自定义Http请求头")}
                    style={{ marginBottom: 12 }}
                    {...compactFormItemLayout}
                  >
                    <Row gutter={transportHeaderGutter} align="top">
                      <Col flex={transportHeaderEditorFlex}>
                        <Form.Item name="transportHeaders" noStyle>
                          <Input.TextArea
                            autoSize={
                              transportHeadersExpanded
                                ? {
                                    minRows: 4,
                                    maxRows: 6,
                                  }
                                : {
                                    minRows: 1,
                                    maxRows: 1,
                                  }
                            }
                            placeholder={"User-Agent: Wateray\nX-Forwarded-Host: cdn.example.com"}
                            onFocus={() => {
                              setTransportHeadersExpanded(true);
                            }}
                            onBlur={() => {
                              setTransportHeadersExpanded(false);
                            }}
                          />
                        </Form.Item>
                      </Col>
                      <Col flex={transportHeaderPresetFlex}>
                        <Select
                          value={currentUserAgentPreset}
                          options={browserUserAgentOptions.map((option) => ({
                            value: option.value,
                            label: option.label,
                          }))}
                          onChange={(value) => {
                            const selectedOption = browserUserAgentOptions.find((option) => option.value === value);
                            form.setFieldValue(
                              "transportHeaders",
                              upsertUserAgentHeader(currentTransportHeaders, selectedOption?.userAgent ?? ""),
                            );
                          }}
                        />
                      </Col>
                    </Row>
                  </Form.Item>
                ) : null}
                {supportsWSEarlyData(currentTransport) ? (
                  <Row gutter={compactGridGutter}>
                    <Col span={halfColumnSpan}>
                      <Form.Item
                        label={fieldLabel("wsMaxEarlyData", "ED大小", "Early Data Size")}
                        name="wsMaxEarlyData"
                        style={{ marginBottom: 12 }}
                        {...compactFormItemLayout}
                      >
                        <InputNumber min={0} style={{ width: "100%" }} placeholder="例如：2048" />
                      </Form.Item>
                    </Col>
                    <Col span={halfColumnSpan}>
                      <Form.Item
                        label={fieldLabel("wsEarlyDataHeaderName", "ED头", "Early Data Header")}
                        name="wsEarlyDataHeaderName"
                        style={{ marginBottom: 12 }}
                        {...compactFormItemLayout}
                      >
                        <Input placeholder="例如：Sec-WebSocket-Protocol" />
                      </Form.Item>
                    </Col>
                  </Row>
                ) : null}
                {supportsHTTPTimeouts(currentTransport) ? (
                  <Row gutter={compactGridGutter}>
                    <Col span={halfColumnSpan}>
                      <Form.Item
                        label={fieldLabel("httpIdleTimeout", "空闲超时", "HTTP Idle Timeout")}
                        name="httpIdleTimeout"
                        style={{ marginBottom: 12 }}
                        {...compactFormItemLayout}
                      >
                        <Input placeholder="例如：15s" />
                      </Form.Item>
                    </Col>
                    <Col span={halfColumnSpan}>
                      <Form.Item
                        label={fieldLabel("httpPingTimeout", "Ping超时", "HTTP Ping Timeout")}
                        name="httpPingTimeout"
                        style={{ marginBottom: 12 }}
                        {...compactFormItemLayout}
                      >
                        <Input placeholder="例如：15s" />
                      </Form.Item>
                    </Col>
                  </Row>
                ) : null}
                {supportsGRPCKeepalive(currentTransport) ? (
                  <>
                    <Row gutter={compactGridGutter}>
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("grpcIdleTimeout", "空闲超时", "gRPC Idle Timeout")}
                          name="grpcIdleTimeout"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Input placeholder="例如：15s" />
                        </Form.Item>
                      </Col>
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("grpcPingTimeout", "Ping超时", "gRPC Ping Timeout")}
                          name="grpcPingTimeout"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Input placeholder="例如：15s" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={compactGridGutter}>
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("grpcPermitWithoutStream", "空闲保活", "gRPC Permit Without Stream")}
                          name="grpcPermitWithoutStream"
                          valuePropName="checked"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ) : null}
                {protocolSpec.tlsFields.includes("tlsEnabled") || (protocolSpec.tlsFields.includes("tlsMode") && currentTlsEnabled) ? (
                  <Row gutter={compactGridGutter}>
                    {protocolSpec.tlsFields.includes("tlsEnabled") ? (
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("tlsEnabled", "启用 TLS")}
                          name="tlsEnabled"
                          valuePropName="checked"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                    ) : null}
                    {protocolSpec.tlsFields.includes("tlsMode") && currentTlsEnabled ? (
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("tlsMode", "TLS 模式")}
                          name="tlsMode"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Select options={tlsModeOptions as unknown as { value: string; label: string }[]} />
                        </Form.Item>
                      </Col>
                    ) : null}
                  </Row>
                ) : null}
                {protocolSpec.tlsFields.includes("sni") && currentTlsEnabled ? (
                  <Row gutter={compactGridGutter}>
                    <Col span={halfColumnSpan}>
                      <Form.Item label={fieldLabel("sni", "SNI")} name="sni" style={{ marginBottom: 12 }} {...compactFormItemLayout}>
                        <Input placeholder="例如：www.google.com" />
                      </Form.Item>
                    </Col>
                    {protocolSpec.tlsFields.includes("insecure") ? (
                      <Col span={halfColumnSpan}>
                        <Form.Item
                          label={fieldLabel("insecure", "跳过证书校验")}
                          name="insecure"
                          valuePropName="checked"
                          style={{ marginBottom: 12 }}
                          {...compactFormItemLayout}
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                    ) : null}
                  </Row>
                ) : protocolSpec.tlsFields.includes("insecure") && currentTlsEnabled ? (
                  <Form.Item
                    label={fieldLabel("insecure", "跳过证书校验")}
                    name="insecure"
                    valuePropName="checked"
                    style={{ marginBottom: 12 }}
                    {...compactFormItemLayout}
                  >
                    <Switch />
                  </Form.Item>
                ) : null}
              </Card>

              {currentProtocol === "wireguard" ? (
                <Card
                  size="small"
                  title={<Typography.Text strong>高级字段</Typography.Text>}
                  styles={{ body: { paddingBottom: 0 } }}
                >
                  <Form.Item
                    label={fieldLabel("wireguardLocalAddress", "Local Address")}
                    name="wireguardLocalAddress"
                    rules={[{ required: true, message: "请输入至少一个 Local Address" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Input.TextArea rows={4} placeholder={"10.0.0.2/32\nfd00::2/128"} />
                  </Form.Item>
                  <Form.Item
                    label={fieldLabel("wireguardPrivateKey", "Private Key")}
                    name="wireguardPrivateKey"
                    rules={[{ required: true, message: "请输入 Private Key" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Input.Password />
                  </Form.Item>
                  <Form.Item
                    label={fieldLabel("wireguardPeerPublicKey", "Peer Public Key")}
                    name="wireguardPeerPublicKey"
                    rules={[{ required: true, message: "请输入 Peer Public Key" }]}
                    style={{ marginBottom: 12 }}
                  >
                    <Input.Password />
                  </Form.Item>
                  <Form.Item label={fieldLabel("wireguardPreSharedKey", "Pre-shared Key")} name="wireguardPreSharedKey" style={{ marginBottom: 12 }}>
                    <Input.Password />
                  </Form.Item>
                  <Form.Item label={fieldLabel("wireguardReserved", "Reserved")} name="wireguardReserved" style={{ marginBottom: 12 }}>
                    <Input placeholder="例如：1, 2, 3" />
                  </Form.Item>
                  <Form.Item label={fieldLabel("wireguardMtu", "MTU")} name="wireguardMtu" style={{ marginBottom: 12 }}>
                    <InputNumber min={1280} max={9200} style={{ width: "100%" }} />
                  </Form.Item>
                </Card>
              ) : null}
            </Space>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
