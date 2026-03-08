export interface AirportAdItem {
  id: number;
  title: string;
  imageUrl: string;
  targetUrl: string;
  summary: string;
  sortOrder: number;
}

function resolveAirportAdsBaseUrl(): string {
  const override = globalThis.localStorage?.getItem("wateray.airportAdsApiBase")?.trim() ?? "";
  const baseUrl = override || "http://127.0.0.1:3180";
  return baseUrl.replace(/\/+$/, "");
}

export function getAirportAdsEndpoint(): string {
  return `${resolveAirportAdsBaseUrl()}/api/ads`;
}

export async function fetchAirportAds(signal?: AbortSignal): Promise<AirportAdItem[]> {
  const response = await fetch(getAirportAdsEndpoint(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`广告接口请求失败: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    items?: Array<Partial<AirportAdItem>>;
  };
  return (payload.items ?? [])
    .map((item, index) => ({
      id: Number(item.id ?? index + 1),
      title: String(item.title ?? "").trim(),
      imageUrl: String(item.imageUrl ?? "").trim(),
      targetUrl: String(item.targetUrl ?? "").trim(),
      summary: String(item.summary ?? "").trim(),
      sortOrder: Number(item.sortOrder ?? index),
    }))
    .filter((item) => item.title !== "" && item.imageUrl !== "" && item.targetUrl !== "");
}
