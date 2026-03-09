import { useEffect, useMemo, useRef, useState } from "react";

import { emitAppExternalNotice } from "../../components/notify/AppNoticeProvider";
import { bindAirportBridge } from "./airportBridge";
import {
  airportHostControlChannel,
  type AirportHostControlAction,
} from "./airportBridgeProtocol";

const AIRPORT_WEB_PROD_HOME_URL = "https://wateray.net/";
const AIRPORT_WEB_DEV_HOME_URL = "http://127.0.0.1:5179/";

export interface AirportControlCommand {
  action: AirportHostControlAction;
  seq: number;
}

interface AirportPageProps {
  command: AirportControlCommand | null;
}

function normalizeAirportHomeUrl(rawUrl: string): string {
  const normalized = new URL(rawUrl).toString();
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function createBridgeToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `airport-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resolveAirportHomeUrl(): string {
  const overrideUrl = String(import.meta.env.VITE_AIRPORT_WEB_URL ?? "").trim();
  if (overrideUrl !== "") {
    try {
      return normalizeAirportHomeUrl(overrideUrl);
    } catch {
      // ignore invalid override and use fallback urls.
    }
  }
  return import.meta.env.DEV ? AIRPORT_WEB_DEV_HOME_URL : AIRPORT_WEB_PROD_HOME_URL;
}

function resolveAirportOrigin(airportHomeUrl: string): string {
  return new URL(airportHomeUrl).origin;
}

function resolveParentOriginForBridge(): string {
  if (window.location.protocol === "file:") {
    return "opaque";
  }
  return window.location.origin;
}

function buildAirportEntryUrl(airportHomeUrl: string, bridgeToken: string): string {
  const url = new URL(airportHomeUrl);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("parentOrigin", resolveParentOriginForBridge());
  url.searchParams.set("bridgeToken", bridgeToken);
  return url.toString();
}

function postHostControl(
  iframe: HTMLIFrameElement | null,
  allowedOrigin: string,
  action: AirportHostControlAction,
): boolean {
  const target = iframe?.contentWindow;
  if (!target) {
    return false;
  }
  target.postMessage(
    {
      channel: airportHostControlChannel,
      kind: "command",
      action,
    },
    allowedOrigin,
  );
  return true;
}

export function AirportPage({ command }: AirportPageProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeTokenRef = useRef<string>(createBridgeToken());
  const airportHomeUrl = useMemo(() => resolveAirportHomeUrl(), []);
  const [frameSrc, setFrameSrc] = useState(() =>
    buildAirportEntryUrl(airportHomeUrl, bridgeTokenRef.current),
  );
  const [reloadSeed, setReloadSeed] = useState(0);
  const allowedOrigin = useMemo(() => resolveAirportOrigin(airportHomeUrl), [airportHomeUrl]);

  useEffect(() => {
    console.info("[airport-page] iframe.init", {
      airportHomeUrl,
      allowedOrigin,
      frameSrc,
    });
    emitAppExternalNotice({
      level: "info",
      title: "机场桥接",
      content: `机场页面已加载（origin=${allowedOrigin}）`,
      toast: false,
    });
  }, [airportHomeUrl, allowedOrigin, frameSrc]);

  useEffect(
    () =>
      bindAirportBridge({
        iframeRef,
        allowedOrigin,
        bridgeToken: bridgeTokenRef.current,
      }),
    [allowedOrigin],
  );

  useEffect(() => {
    if (!command) {
      return;
    }
    if (command.action === "home") {
      const posted = postHostControl(iframeRef.current, allowedOrigin, "home");
      if (!posted) {
        setFrameSrc(buildAirportEntryUrl(airportHomeUrl, bridgeTokenRef.current));
        setReloadSeed((value) => value + 1);
      }
      return;
    }
    const posted = postHostControl(iframeRef.current, allowedOrigin, "refresh");
    if (!posted) {
      setReloadSeed((value) => value + 1);
    }
  }, [command, allowedOrigin, airportHomeUrl]);

  return (
    <div className="airport-web-page">
      <iframe
        ref={iframeRef}
        key={reloadSeed}
        className="airport-web-frame"
        title="Wateray Airport Web"
        src={frameSrc}
      />
    </div>
  );
}
