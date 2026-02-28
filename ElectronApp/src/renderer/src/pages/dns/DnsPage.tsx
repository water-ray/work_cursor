import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  App as AntdApp,
  Button,
  Card,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import type { DNSStrategy } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { daemonApi } from "../../services/daemonApi";

type EditableDNSField = "remote" | "direct" | "bootstrap";

const defaultDNSRemoteServer = "https://1.1.1.1/dns-query";
const defaultDNSDirectServer = "223.5.5.5";
const defaultDNSBootstrapServer = defaultDNSDirectServer;
const defaultDNSFakeIPV4Range = "198.18.0.0/15";
const defaultDNSFakeIPV6Range = "fc00::/18";

const dnsStorageKeys: Record<EditableDNSField, string> = {
  remote: "wateray.dns.remote.customOptions",
  direct: "wateray.dns.direct.customOptions",
  bootstrap: "wateray.dns.bootstrap.customOptions",
};

const dnsPresetOptions: Array<{ label: string; value: string }> = [
  { label: "Google DoH", value: "https://dns.google/dns-query" },
  { label: "Google DNS", value: "8.8.8.8" },
  { label: "Cloudflare DoH", value: "https://1.1.1.1/dns-query" },
  { label: "Cloudflare DNS", value: "1.1.1.1" },
  { label: "阿里云 DoH", value: "https://dns.alidns.com/dns-query" },
  { label: "阿里云 DNS", value: "223.5.5.5" },
  { label: "腾讯云 DoH", value: "https://doh.pub/dns-query" },
  { label: "腾讯云 DNS", value: "119.29.29.29" },
  { label: "114DNS", value: "114.114.114.114" },
  { label: "微软 Azure DNS", value: "168.63.129.16" },
];

const presetLabelByValue = new Map<string, string>(
  dnsPresetOptions.map((item) => [item.value, item.label]),
);

const dnsStrategyOptions: Array<{ value: DNSStrategy; label: string }> = [
  { value: "prefer_ipv4", label: "优先 IPv4" },
  { value: "prefer_ipv6", label: "优先 IPv6" },
  { value: "ipv4_only", label: "仅 IPv4" },
  { value: "ipv6_only", label: "仅 IPv6" },
];

function normalizeServerValue(value: string): string {
  return value.trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of values) {
    const value = normalizeServerValue(item);
    if (value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function readStoredOptions(field: EditableDNSField): string[] {
  try {
    const raw = window.localStorage.getItem(dnsStorageKeys[field]);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return uniqueNonEmpty(parsed.filter((item) => typeof item === "string"));
  } catch {
    return [];
  }
}

function writeStoredOptions(field: EditableDNSField, values: string[]): void {
  window.localStorage.setItem(dnsStorageKeys[field], JSON.stringify(uniqueNonEmpty(values)));
}

function buildInitialOptions(field: EditableDNSField, selectedValue: string): string[] {
  const stored = readStoredOptions(field);
  const base = stored.length > 0 ? stored : dnsPresetOptions.map((item) => item.value);
  return uniqueNonEmpty([...base, selectedValue]);
}

function getDisplayLabel(value: string): string {
  const presetLabel = presetLabelByValue.get(value);
  if (!presetLabel) {
    return value;
  }
  return `${presetLabel} (${value})`;
}

export function DnsPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const { message } = AntdApp.useApp();
  const [dnsRemoteServer, setDnsRemoteServer] = useState<string>(defaultDNSRemoteServer);
  const [dnsDirectServer, setDnsDirectServer] = useState<string>(defaultDNSDirectServer);
  const [dnsBootstrapServer, setDnsBootstrapServer] = useState<string>(
    defaultDNSBootstrapServer,
  );
  const [dnsStrategy, setDnsStrategy] = useState<DNSStrategy>("prefer_ipv4");
  const [dnsIndependentCache, setDnsIndependentCache] = useState<boolean>(true);
  const [dnsCacheFileEnabled, setDnsCacheFileEnabled] = useState<boolean>(true);
  const [dnsCacheStoreRDRC, setDnsCacheStoreRDRC] = useState<boolean>(true);
  const [dnsFakeIPEnabled, setDnsFakeIPEnabled] = useState<boolean>(true);
  const [dnsFakeIPV4Range, setDnsFakeIPV4Range] = useState<string>(
    defaultDNSFakeIPV4Range,
  );
  const [dnsFakeIPV6Range, setDnsFakeIPV6Range] = useState<string>(
    defaultDNSFakeIPV6Range,
  );
  const [dnsDirty, setDnsDirty] = useState(false);
  const [clearingDNSCache, setClearingDNSCache] = useState(false);

  const [remoteOptions, setRemoteOptions] = useState<string[]>(() =>
    buildInitialOptions("remote", defaultDNSRemoteServer),
  );
  const [directOptions, setDirectOptions] = useState<string[]>(() =>
    buildInitialOptions("direct", defaultDNSDirectServer),
  );
  const [bootstrapOptions, setBootstrapOptions] = useState<string[]>(() =>
    buildInitialOptions("bootstrap", defaultDNSBootstrapServer),
  );

  const [editingField, setEditingField] = useState<EditableDNSField | null>(null);
  const [customServerInput, setCustomServerInput] = useState<string>("");

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    const nextRemote = snapshot.dnsRemoteServer ?? defaultDNSRemoteServer;
    const nextDirect = snapshot.dnsDirectServer ?? defaultDNSDirectServer;
    const nextBootstrap =
      snapshot.dnsBootstrapServer ?? snapshot.dnsDirectServer ?? defaultDNSBootstrapServer;

    if (!dnsDirty) {
      setDnsRemoteServer(nextRemote);
      setDnsDirectServer(nextDirect);
      setDnsBootstrapServer(nextBootstrap);
      setDnsStrategy(snapshot.dnsStrategy ?? "prefer_ipv4");
      setDnsIndependentCache(snapshot.dnsIndependentCache ?? true);
      setDnsCacheFileEnabled(snapshot.dnsCacheFileEnabled ?? true);
      setDnsCacheStoreRDRC(snapshot.dnsCacheStoreRDRC ?? true);
      setDnsFakeIPEnabled(snapshot.dnsFakeIPEnabled ?? true);
      setDnsFakeIPV4Range(snapshot.dnsFakeIPV4Range ?? defaultDNSFakeIPV4Range);
      setDnsFakeIPV6Range(snapshot.dnsFakeIPV6Range ?? defaultDNSFakeIPV6Range);
    }

    setRemoteOptions((previous) => uniqueNonEmpty([...previous, nextRemote]));
    setDirectOptions((previous) => uniqueNonEmpty([...previous, nextDirect]));
    setBootstrapOptions((previous) => uniqueNonEmpty([...previous, nextBootstrap]));
  }, [snapshot, dnsDirty]);

  const canApplyDNS = useMemo(() => {
    if (!dnsDirty) {
      return false;
    }
    if (
      dnsRemoteServer.trim() === "" ||
      dnsDirectServer.trim() === "" ||
      dnsBootstrapServer.trim() === ""
    ) {
      return false;
    }
    if (!dnsFakeIPEnabled) {
      return true;
    }
    return dnsFakeIPV4Range.trim() !== "" && dnsFakeIPV6Range.trim() !== "";
  }, [
    dnsDirty,
    dnsRemoteServer,
    dnsDirectServer,
    dnsBootstrapServer,
    dnsFakeIPEnabled,
    dnsFakeIPV4Range,
    dnsFakeIPV6Range,
  ]);

  const persistOptionList = (field: EditableDNSField, values: string[]): void => {
    writeStoredOptions(field, values);
    switch (field) {
      case "remote":
        setRemoteOptions(values);
        break;
      case "direct":
        setDirectOptions(values);
        break;
      case "bootstrap":
        setBootstrapOptions(values);
        break;
      default:
        break;
    }
  };

  const removeOption = (field: EditableDNSField, value: string): void => {
    const targetValue = normalizeServerValue(value);
    if (targetValue === "") {
      return;
    }

    const currentOptions =
      field === "remote"
        ? remoteOptions
        : field === "direct"
          ? directOptions
          : bootstrapOptions;
    const nextOptions = currentOptions.filter((item) => item !== targetValue);
    if (nextOptions.length === 0) {
      message.warning("至少保留 1 个 DNS 服务器选项");
      return;
    }

    persistOptionList(field, nextOptions);
    if (field === "remote" && dnsRemoteServer === targetValue) {
      setDnsRemoteServer(nextOptions[0]);
      setDnsDirty(true);
    }
    if (field === "direct" && dnsDirectServer === targetValue) {
      setDnsDirectServer(nextOptions[0]);
      setDnsDirty(true);
    }
    if (field === "bootstrap" && dnsBootstrapServer === targetValue) {
      setDnsBootstrapServer(nextOptions[0]);
      setDnsDirty(true);
    }
  };

  const addCustomOption = (): void => {
    if (!editingField) {
      return;
    }
    const value = normalizeServerValue(customServerInput);
    if (value === "") {
      message.warning("请输入 DNS 服务器地址");
      return;
    }
    const currentOptions =
      editingField === "remote"
        ? remoteOptions
        : editingField === "direct"
          ? directOptions
          : bootstrapOptions;
    const nextOptions = uniqueNonEmpty([...currentOptions, value]);
    persistOptionList(editingField, nextOptions);

    if (editingField === "remote") {
      setDnsRemoteServer(value);
    } else if (editingField === "direct") {
      setDnsDirectServer(value);
    } else {
      setDnsBootstrapServer(value);
    }
    setDnsDirty(true);
    setEditingField(null);
    setCustomServerInput("");
  };

  const applyDNSSettings = async () => {
    const nextRemote = dnsRemoteServer.trim();
    const nextDirect = dnsDirectServer.trim();
    const nextBootstrap = dnsBootstrapServer.trim();
    const nextFakeIPV4 = dnsFakeIPV4Range.trim();
    const nextFakeIPV6 = dnsFakeIPV6Range.trim();

    if (nextRemote === "" || nextDirect === "" || nextBootstrap === "") {
      message.warning("请完整填写远程/直连/节点解析 DNS");
      return;
    }
    if (dnsFakeIPEnabled && (nextFakeIPV4 === "" || nextFakeIPV6 === "")) {
      message.warning("开启 FakeIP 后，请填写完整的 IPv4/IPv6 响应范围");
      return;
    }

    try {
      await runAction(() =>
        daemonApi.setSettings({
          dnsRemoteServer: nextRemote,
          dnsDirectServer: nextDirect,
          dnsBootstrapServer: nextBootstrap,
          dnsStrategy,
          dnsIndependentCache,
          dnsCacheFileEnabled,
          dnsCacheStoreRDRC,
          dnsFakeIPEnabled,
          dnsFakeIPV4Range: nextFakeIPV4,
          dnsFakeIPV6Range: nextFakeIPV6,
        }),
      );
      setDnsDirty(false);
      message.success("DNS 配置已应用");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "应用 DNS 配置失败");
    }
  };

  const clearDNSCache = async () => {
    setClearingDNSCache(true);
    try {
      await runAction(() => daemonApi.clearDNSCache());
      message.success("DNS 缓存已清理");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "清理 DNS 缓存失败");
    } finally {
      setClearingDNSCache(false);
    }
  };

  const renderServerSelector = (
    field: EditableDNSField,
    value: string,
    options: string[],
    onChange: (next: string) => void,
  ) => {
    if (editingField === field) {
      return (
        <Space.Compact style={{ width: "100%", maxWidth: 560 }}>
          <Input
            value={customServerInput}
            placeholder="输入新的 DNS 服务器地址（IP / DoH URL）"
            onChange={(event) => setCustomServerInput(event.target.value)}
          />
          <Button
            type="primary"
            onClick={addCustomOption}
          >
            保存
          </Button>
          <Button
            onClick={() => {
              setEditingField(null);
              setCustomServerInput("");
            }}
          >
            取消
          </Button>
        </Space.Compact>
      );
    }

    return (
      <Space.Compact style={{ width: "100%", maxWidth: 560 }}>
        <Select<string>
          value={value}
          style={{ width: 500, maxWidth: "100%" }}
          options={options.map((item) => ({
            label: getDisplayLabel(item),
            value: item,
          }))}
          onChange={(next) => {
            onChange(next);
            setDnsDirty(true);
          }}
          optionRender={(option) => {
            const optionValue = String((option as { value?: string }).value ?? "");
            return (
              <Space
                style={{ width: "100%", justifyContent: "space-between" }}
                size={8}
              >
                <Typography.Text
                  style={{ maxWidth: 360 }}
                  ellipsis={{ tooltip: getDisplayLabel(optionValue) }}
                >
                  {getDisplayLabel(optionValue)}
                </Typography.Text>
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  title="删除该项"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeOption(field, optionValue);
                  }}
                />
              </Space>
            );
          }}
        />
        <Button
          icon={<PlusOutlined />}
          title="新增 DNS 服务器"
          onClick={() => {
            setEditingField(field);
            setCustomServerInput("");
          }}
        />
      </Space.Compact>
    );
  };

  return (
    <Card
      loading={loading}
    >
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <Typography.Text type="secondary">
          走代理时建议优先使用远程 DNS；节点域名解析可单独指定，避免依赖系统 DNS 被污染。
        </Typography.Text>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text>DNS 远程服务器（代理链路查询）</Typography.Text>
          {renderServerSelector("remote", dnsRemoteServer, remoteOptions, setDnsRemoteServer)}

          <Typography.Text>DNS 直连服务器（直连流量查询）</Typography.Text>
          {renderServerSelector("direct", dnsDirectServer, directOptions, setDnsDirectServer)}

          <Typography.Text>节点域名解析服务器（bootstrap，直连）</Typography.Text>
          {renderServerSelector(
            "bootstrap",
            dnsBootstrapServer,
            bootstrapOptions,
            setDnsBootstrapServer,
          )}
        </Space>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text>DNS 查询策略</Typography.Text>
          <Select<DNSStrategy>
            value={dnsStrategy}
            options={dnsStrategyOptions}
            style={{ width: 220 }}
            onChange={(value) => {
              setDnsStrategy(value);
              setDnsDirty(true);
            }}
          />
          <Space size={12}>
            <Typography.Text>独立 DNS 缓存</Typography.Text>
            <Switch
              checked={dnsIndependentCache}
              onChange={(checked) => {
                setDnsIndependentCache(checked);
                setDnsDirty(true);
              }}
            />
          </Space>
          <Space size={12}>
            <Typography.Text>启用缓存文件</Typography.Text>
            <Switch
              checked={dnsCacheFileEnabled}
              onChange={(checked) => {
                setDnsCacheFileEnabled(checked);
                setDnsDirty(true);
              }}
            />
          </Space>
          <Space size={12}>
            <Typography.Text>缓存 RDRC（防污染结果缓存）</Typography.Text>
            <Switch
              checked={dnsCacheStoreRDRC}
              disabled={!dnsCacheFileEnabled}
              onChange={(checked) => {
                setDnsCacheStoreRDRC(checked);
                setDnsDirty(true);
              }}
            />
          </Space>
        </Space>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text strong>FakeIP</Typography.Text>
          <Space size={12}>
            <Typography.Text>启用 FakeIP</Typography.Text>
            <Switch
              checked={dnsFakeIPEnabled}
              onChange={(checked) => {
                setDnsFakeIPEnabled(checked);
                setDnsDirty(true);
              }}
            />
          </Space>
          <Typography.Text>FakeIP IPv4 响应范围</Typography.Text>
          <Input
            value={dnsFakeIPV4Range}
            disabled={!dnsFakeIPEnabled}
            style={{ width: 320, maxWidth: "100%" }}
            placeholder="198.18.0.0/15"
            onChange={(event) => {
              setDnsFakeIPV4Range(event.target.value);
              setDnsDirty(true);
            }}
          />
          <Typography.Text>FakeIP IPv6 响应范围</Typography.Text>
          <Input
            value={dnsFakeIPV6Range}
            disabled={!dnsFakeIPEnabled}
            style={{ width: 320, maxWidth: "100%" }}
            placeholder="fc00::/18"
            onChange={(event) => {
              setDnsFakeIPV6Range(event.target.value);
              setDnsDirty(true);
            }}
          />
          <Typography.Text type="secondary">
            默认 IPv4 使用 198.18.0.0/15（比 /16 更大，且为测试保留网段，冲突风险更低）。
          </Typography.Text>
        </Space>

        <Space size={8}>
          <Button
            type="primary"
            disabled={!canApplyDNS}
            onClick={() => void applyDNSSettings()}
          >
            应用
          </Button>
          <Button
            loading={clearingDNSCache}
            onClick={() => void clearDNSCache()}
          >
            清理 DNS 缓存
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
