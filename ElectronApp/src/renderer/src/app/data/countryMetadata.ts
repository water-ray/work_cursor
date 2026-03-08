export const COUNTRY_REGION_CODES = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "XK",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;

export type CountryRegionCode = (typeof COUNTRY_REGION_CODES)[number];

export interface CountryMetadata {
  code: CountryRegionCode;
  englishName: string;
  chineseName: string;
  flagEmoji: string;
  searchText: string;
}

interface CountryNameOverride {
  englishName: string;
  chineseName: string;
}

const COUNTRY_NAME_OVERRIDES: Partial<Record<CountryRegionCode, CountryNameOverride>> = {
  GB: { englishName: "United Kingdom", chineseName: "英国" },
  HK: { englishName: "Hong Kong", chineseName: "香港" },
  MO: { englishName: "Macao", chineseName: "澳门" },
  TW: { englishName: "Taiwan", chineseName: "台湾" },
  US: { englishName: "United States", chineseName: "美国" },
  XK: { englishName: "Kosovo", chineseName: "科索沃" },
};

const COUNTRY_CODE_ALIASES: Record<string, CountryRegionCode> = {
  UK: "GB",
};

const COUNTRY_TEXT_ALIASES: Record<string, CountryRegionCode> = {
  uk: "GB",
  usa: "US",
  "united states of america": "US",
  america: "US",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "hong kong": "HK",
  hongkong: "HK",
  macau: "MO",
  macao: "MO",
  taiwan: "TW",
  "south korea": "KR",
  "north korea": "KP",
  "czech republic": "CZ",
  uae: "AE",
};

function createDisplayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    return null;
  }
}

function normalizeCountrySearchText(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[./,()_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildFlagEmoji(code: CountryRegionCode): string {
  return String.fromCodePoint(
    ...code.split("").map((char) => 127397 + char.charCodeAt(0)),
  );
}

function resolveDisplayName(
  displayNames: Intl.DisplayNames | null,
  code: CountryRegionCode,
): string {
  try {
    const label = displayNames?.of(code);
    return typeof label === "string" && label.trim() !== "" ? label : code;
  } catch {
    return code;
  }
}

const englishDisplayNames = createDisplayNames("en");
const chineseDisplayNames = createDisplayNames("zh-Hans");

export const countryMetadataList: CountryMetadata[] = COUNTRY_REGION_CODES.map((code) => {
  const override = COUNTRY_NAME_OVERRIDES[code];
  const englishName = override?.englishName ?? resolveDisplayName(englishDisplayNames, code);
  const chineseName = override?.chineseName ?? resolveDisplayName(chineseDisplayNames, code);
  const flagEmoji = buildFlagEmoji(code);
  const searchText = normalizeCountrySearchText(
    `${code} ${englishName} ${chineseName}`,
  );
  return {
    code,
    englishName,
    chineseName,
    flagEmoji,
    searchText,
  };
});

export const countryMetadataByCode = new Map<string, CountryMetadata>(
  countryMetadataList.map((item) => [item.code, item]),
);

const countryLookupByText = new Map<string, CountryRegionCode>();

function registerCountryLookup(key: string, code: CountryRegionCode): void {
  const normalized = normalizeCountrySearchText(key);
  if (normalized === "") {
    return;
  }
  if (!countryLookupByText.has(normalized)) {
    countryLookupByText.set(normalized, code);
  }
  const compact = normalized.replace(/\s+/g, "");
  if (compact !== normalized && !countryLookupByText.has(compact)) {
    countryLookupByText.set(compact, code);
  }
}

for (const metadata of countryMetadataList) {
  registerCountryLookup(metadata.code, metadata.code);
  registerCountryLookup(metadata.englishName, metadata.code);
  registerCountryLookup(metadata.chineseName, metadata.code);
}

for (const [alias, code] of Object.entries(COUNTRY_TEXT_ALIASES)) {
  registerCountryLookup(alias, code);
}

export function resolveCountryMetadata(value: string | undefined): CountryMetadata | null {
  const code = normalizeCountryCode(value);
  if (code === "") {
    return null;
  }
  return countryMetadataByCode.get(code) ?? null;
}

export function normalizeCountryCode(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return "";
  }
  const direct = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) {
    const aliasCode = COUNTRY_CODE_ALIASES[direct];
    if (aliasCode) {
      return aliasCode;
    }
    if (countryMetadataByCode.has(direct)) {
      return direct;
    }
  }
  const normalized = normalizeCountrySearchText(raw);
  if (normalized === "") {
    return "";
  }
  return (
    countryLookupByText.get(normalized) ??
    countryLookupByText.get(normalized.replace(/\s+/g, "")) ??
    ""
  );
}

export function resolveCountryFlagEmoji(value: string | undefined): string {
  const metadata = resolveCountryMetadata(value);
  return metadata?.flagEmoji ?? "";
}

export function buildCountrySearchText(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return "";
  }
  const metadata = resolveCountryMetadata(raw);
  if (!metadata) {
    return normalizeCountrySearchText(raw);
  }
  return metadata.searchText;
}
