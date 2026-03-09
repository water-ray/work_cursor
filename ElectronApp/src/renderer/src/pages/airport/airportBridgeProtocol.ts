export const airportBridgeChannel = "wateray-airport-bridge";
export const airportHostControlChannel = "wateray-airport-host-control";

export type AirportBridgeAction = "exportClientConfig" | "importClientConfig" | "reportDebugNotice";
export type AirportHostControlAction = "home" | "refresh";

export interface AirportBridgeRequest {
  channel: typeof airportBridgeChannel;
  kind: "request";
  requestId: string;
  bridgeToken: string;
  action: AirportBridgeAction;
  payload?: unknown;
}

export interface AirportBridgeResponse {
  channel: typeof airportBridgeChannel;
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AirportHostControlCommand {
  channel: typeof airportHostControlChannel;
  kind: "command";
  action: AirportHostControlAction;
}

export function isAirportBridgeRequest(data: unknown): data is AirportBridgeRequest {
  if (!data || typeof data !== "object") {
    return false;
  }
  const value = data as Record<string, unknown>;
  if (value.channel !== airportBridgeChannel || value.kind !== "request") {
    return false;
  }
  if (typeof value.requestId !== "string" || value.requestId.trim() === "") {
    return false;
  }
  if (typeof value.bridgeToken !== "string" || value.bridgeToken.trim() === "") {
    return false;
  }
  return (
    value.action === "exportClientConfig"
    || value.action === "importClientConfig"
    || value.action === "reportDebugNotice"
  );
}
