import { Select, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { DaemonSnapshot } from "../../../../shared/daemon";
import {
  buildCountrySearchText,
  normalizeCountryCode,
  resolveCountryMetadata,
} from "../../app/data/countryMetadata";
import {
  readProxyStartupSmartOptimizePreference,
  type ProxyStartupSmartOptimizePreference,
  writeProxyStartupSmartOptimizePreference,
} from "../../app/settings/uiPreferences";
import { CountryFlag } from "../../components/flag/CountryFlag";
import { BiIcon } from "../../components/icons/BiIcon";

const startupSmartOptimizeOff: ProxyStartupSmartOptimizePreference = "off";
const startupSmartOptimizeBest: ProxyStartupSmartOptimizePreference = "best";
const startupSmartOptimizeCountryPrefix = "country:";

function normalizeCountryValue(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return "";
  }
  const countryCode = normalizeCountryCode(raw);
  if (countryCode !== "") {
    return countryCode;
  }
  return raw;
}

function resolveNodeCountryValue(node: { country?: string; region?: string }): string {
  return normalizeCountryValue(node.country) || normalizeCountryValue(node.region);
}

function parseStartupSmartOptimizeCountry(
  value: ProxyStartupSmartOptimizePreference,
): string {
  if (!value.startsWith(startupSmartOptimizeCountryPrefix)) {
    return "";
  }
  return normalizeCountryValue(value.slice(startupSmartOptimizeCountryPrefix.length));
}

function buildStartupSmartOptimizeCountry(
  country: string,
): ProxyStartupSmartOptimizePreference {
  return `${startupSmartOptimizeCountryPrefix}${normalizeCountryValue(country)}`;
}

function buildSmartOptimizeCountryLabel(value: string, missing = false) {
  const metadata = resolveCountryMetadata(value);
  if (!metadata) {
    return missing ? `${value}（当前分组无匹配）` : value;
  }
  return (
    <span
      className="proxy-startup-smart-optimize-option"
      title={`${metadata.chineseName} · ${metadata.code} · ${metadata.englishName}${missing ? "（当前分组无匹配）" : ""}`}
    >
      <span className="proxy-startup-smart-optimize-flag" aria-hidden="true">
        <CountryFlag
          code={metadata.code}
          ariaLabel={metadata.chineseName}
        />
      </span>
      <span className="proxy-startup-smart-optimize-primary">
        {metadata.chineseName}
        {missing ? "（当前分组无匹配）" : ""}
      </span>
      <span className="proxy-startup-smart-optimize-meta">
        {metadata.code} · {metadata.englishName}
      </span>
    </span>
  );
}

function buildSmartOptimizePresetLabel(kind: "off" | "best") {
  const iconName = kind === "best" ? "emoji-sunglasses-fill" : "emoji-expressionless-fill";
  const primary = kind === "best" ? "订阅激活分组最佳" : "关闭优选";
  return (
    <span className="proxy-startup-smart-optimize-option">
      <span
        className={`proxy-startup-smart-optimize-preset-icon proxy-startup-smart-optimize-preset-icon-${kind}`}
        aria-hidden="true"
      >
        <BiIcon name={iconName} />
      </span>
      <span className="proxy-startup-smart-optimize-primary">{primary}</span>
      <span className="proxy-startup-smart-optimize-meta" />
    </span>
  );
}

function buildSmartOptimizeCountrySearchText(value: string, missing = false): string {
  const metadata = resolveCountryMetadata(value);
  if (!metadata) {
    return buildCountrySearchText(value);
  }
  return buildCountrySearchText(
    `${metadata.code} ${metadata.chineseName} ${metadata.englishName}${missing ? " 当前分组无匹配" : ""}`,
  );
}

interface ProxySmartOptimizeSelectProps {
  snapshot: DaemonSnapshot | null;
  disabled?: boolean;
  className?: string;
  selectClassName?: string;
  showHint?: boolean;
}

export function ProxySmartOptimizeSelect({
  snapshot,
  disabled = false,
  className,
  selectClassName,
  showHint = true,
}: ProxySmartOptimizeSelectProps) {
  const [startupSmartOptimize, setStartupSmartOptimize] = useState<ProxyStartupSmartOptimizePreference>(
    () => readProxyStartupSmartOptimizePreference(),
  );

  useEffect(() => {
    setStartupSmartOptimize(readProxyStartupSmartOptimizePreference());
  }, []);

  const activeGroup = useMemo(
    () => snapshot?.groups.find((group) => group.id === snapshot.activeGroupId) ?? null,
    [snapshot],
  );
  const smartOptimizeSelectedCountry = useMemo(
    () => parseStartupSmartOptimizeCountry(startupSmartOptimize),
    [startupSmartOptimize],
  );
  const smartOptimizeCountryEntries = useMemo(() => {
    if (activeGroup?.kind !== "subscription") {
      return [];
    }
    const values = new Map<
      string,
      {
        value: string;
        label: ReturnType<typeof buildSmartOptimizeCountryLabel>;
        searchText: string;
        sortLabel: string;
      }
    >();
    for (const node of activeGroup.nodes ?? []) {
      const country = resolveNodeCountryValue(node);
      if (country === "" || values.has(country)) {
        continue;
      }
      const metadata = resolveCountryMetadata(country);
      values.set(country, {
        value: country,
        label: buildSmartOptimizeCountryLabel(country),
        searchText: buildSmartOptimizeCountrySearchText(country),
        sortLabel: metadata?.chineseName ?? country,
      });
    }
    return Array.from(values.values()).sort((left, right) =>
      left.sortLabel.localeCompare(right.sortLabel, "zh-CN"),
    );
  }, [activeGroup]);
  const smartOptimizeSelectOptions = useMemo(() => {
    const options: Array<{
      value: ProxyStartupSmartOptimizePreference;
      label: ReturnType<typeof buildSmartOptimizeCountryLabel> | string;
      searchText: string;
    }> = [
      {
        value: startupSmartOptimizeOff,
        label: buildSmartOptimizePresetLabel("off"),
        searchText: "关闭优选 off disable",
      },
      {
        value: startupSmartOptimizeBest,
        label: buildSmartOptimizePresetLabel("best"),
        searchText: "订阅激活分组最佳 评分最好 best smart optimize",
      },
      ...smartOptimizeCountryEntries.map((country) => ({
        value: buildStartupSmartOptimizeCountry(country.value),
        label: country.label,
        searchText: country.searchText,
      })),
    ];
    if (
      smartOptimizeSelectedCountry !== "" &&
      !smartOptimizeCountryEntries.some((item) => item.value === smartOptimizeSelectedCountry)
    ) {
      options.push({
        value: buildStartupSmartOptimizeCountry(smartOptimizeSelectedCountry),
        label: buildSmartOptimizeCountryLabel(smartOptimizeSelectedCountry, true),
        searchText: buildSmartOptimizeCountrySearchText(smartOptimizeSelectedCountry, true),
      });
    }
    return options;
  }, [smartOptimizeCountryEntries, smartOptimizeSelectedCountry]);
  const smartOptimizeHint = useMemo(() => {
    if (!activeGroup) {
      return "当前没有激活分组，仅支持关闭优选或订阅激活分组最佳。";
    }
    if (activeGroup.kind !== "subscription") {
      return "当前为普通分组，智能优选仅对订阅激活分组生效。";
    }
    if (smartOptimizeCountryEntries.length === 0) {
      return "当前订阅分组未识别到国家字段，仅支持关闭优选或订阅激活分组最佳。";
    }
    return "";
  }, [activeGroup, smartOptimizeCountryEntries]);

  return (
    <div className={className}>
      <Select<ProxyStartupSmartOptimizePreference>
        className={selectClassName}
        showSearch
        value={startupSmartOptimize}
        disabled={disabled}
        popupMatchSelectWidth={false}
        options={smartOptimizeSelectOptions}
        placeholder="关闭优选"
        filterOption={(input, option) =>
          buildCountrySearchText(input).length === 0
            ? true
            : String(option?.searchText ?? "").includes(buildCountrySearchText(input))
        }
        onChange={(value) => {
          setStartupSmartOptimize(value);
          writeProxyStartupSmartOptimizePreference(value);
        }}
      />
      {showHint && smartOptimizeHint ? (
        <Typography.Text type="secondary" className="proxy-startup-side-hint">
          {smartOptimizeHint}
        </Typography.Text>
      ) : null}
    </div>
  );
}
