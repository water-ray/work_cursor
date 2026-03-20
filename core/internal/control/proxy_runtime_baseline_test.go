package control

import (
	"encoding/json"
	"testing"
)

func TestBuildTunInboundConfigLinuxEnablesAutoRedirect(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	linuxInbound := buildTunInboundConfig("linux", snapshot)
	if value, ok := linuxInbound["auto_redirect"].(bool); !ok || !value {
		t.Fatalf("expected linux tun inbound to enable auto_redirect")
	}
	if stack, ok := linuxInbound["stack"].(string); !ok || stack != string(ProxyTunStackSystem) {
		t.Fatalf("expected default tun stack to be system, got %v", linuxInbound["stack"])
	}
	if mtu, ok := linuxInbound["mtu"].(int); !ok || mtu != defaultTunMTU {
		t.Fatalf("expected default tun mtu to be %d, got %v", defaultTunMTU, linuxInbound["mtu"])
	}
	if strictRoute, ok := linuxInbound["strict_route"].(bool); !ok || !strictRoute {
		t.Fatalf("expected default strict_route enabled, got %v", linuxInbound["strict_route"])
	}

	windowsInbound := buildTunInboundConfig("windows", snapshot)
	if _, ok := windowsInbound["auto_redirect"]; ok {
		t.Fatalf("unexpected auto_redirect for non-linux tun inbound")
	}
}

func TestBuildTunInboundConfigUsesSnapshotTunSettings(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.TunMTU = 1420
	snapshot.TunStack = ProxyTunStackSystem
	snapshot.StrictRoute = false
	inbound := buildTunInboundConfig("windows", snapshot)
	if mtu, ok := inbound["mtu"].(int); !ok || mtu != 1420 {
		t.Fatalf("expected tun mtu from snapshot, got %v", inbound["mtu"])
	}
	if stack, ok := inbound["stack"].(string); !ok || stack != string(ProxyTunStackSystem) {
		t.Fatalf("expected tun stack from snapshot, got %v", inbound["stack"])
	}
	if strictRoute, ok := inbound["strict_route"].(bool); !ok || strictRoute {
		t.Fatalf("expected strict_route from snapshot false, got %v", inbound["strict_route"])
	}
}

func TestSupportsRouteAutoDetectInterface(t *testing.T) {
	if !supportsRouteAutoDetectInterface("linux") {
		t.Fatalf("linux should support route.auto_detect_interface")
	}
	if !supportsRouteAutoDetectInterface("windows") {
		t.Fatalf("windows should support route.auto_detect_interface")
	}
	if !supportsRouteAutoDetectInterface("darwin") {
		t.Fatalf("darwin should support route.auto_detect_interface")
	}
	if supportsRouteAutoDetectInterface("android") {
		t.Fatalf("android should not set route.auto_detect_interface by default")
	}
}

func TestBuildRuntimeConfigAddsURLTestAndSelectorDefaults(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ProxyMode = ProxyModeSystem
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "node-1",
					Protocol: NodeProtocol("socks5"),
					Address:  "1.1.1.1",
					Port:     1080,
				},
				{
					ID:       "node-2",
					Name:     "node-2",
					Protocol: NodeProtocol("socks5"),
					Address:  "2.2.2.2",
					Port:     1080,
				},
			},
		},
	}
	snapshot.ActiveGroupID = "group-1"
	snapshot.SelectedNodeID = "node-1"

	rawConfig, err := buildRuntimeConfig(snapshot)
	if err != nil {
		t.Fatalf("build runtime config failed: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("unmarshal runtime config failed: %v", err)
	}
	outbounds, ok := payload["outbounds"].([]any)
	if !ok {
		t.Fatalf("runtime outbounds should be []any")
	}

	selector := findOutboundByTag(outbounds, proxySelectorTag)
	if selector == nil {
		t.Fatalf("selector outbound %q not found", proxySelectorTag)
	}
	selectorOutbounds := toStringSlice(selector["outbounds"])
	if len(selectorOutbounds) < 3 {
		t.Fatalf("selector outbounds should include auto + nodes, got %v", selectorOutbounds)
	}
	if selectorOutbounds[0] != proxyURLTestTag {
		t.Fatalf("selector first outbound should be %q, got %q", proxyURLTestTag, selectorOutbounds[0])
	}
	if selector["default"] != runtimeNodeTag("node-1") {
		t.Fatalf("selector default should be selected node")
	}

	auto := findOutboundByTag(outbounds, proxyURLTestTag)
	if auto == nil {
		t.Fatalf("urltest outbound %q not found", proxyURLTestTag)
	}
	if auto["type"] != "urltest" {
		t.Fatalf("expected urltest outbound type, got %v", auto["type"])
	}
	if auto["url"] != proxyURLTestProbeURL {
		t.Fatalf("unexpected urltest url: %v", auto["url"])
	}
	if auto["interval"] != proxyURLTestInterval {
		t.Fatalf("unexpected urltest interval: %v", auto["interval"])
	}
	if auto["idle_timeout"] != proxyURLTestIdleTimeout {
		t.Fatalf("unexpected urltest idle_timeout: %v", auto["idle_timeout"])
	}
	if tolerance, ok := auto["tolerance"].(float64); !ok || int(tolerance) != proxyURLTestToleranceMS {
		t.Fatalf("unexpected urltest tolerance: %v", auto["tolerance"])
	}
}

func TestBuildRuntimeConfigTunModeExposesMixedInbound(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ProxyMode = ProxyModeTun
	snapshot.AllowExternal = true
	snapshot.LocalProxyPort = 18080
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "node-1",
					Protocol: NodeProtocol("socks5"),
					Address:  "1.1.1.1",
					Port:     1080,
				},
			},
		},
	}
	snapshot.ActiveGroupID = "group-1"
	snapshot.SelectedNodeID = "node-1"

	rawConfig, err := buildRuntimeConfig(snapshot)
	if err != nil {
		t.Fatalf("build runtime config failed: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("unmarshal runtime config failed: %v", err)
	}
	inbounds, ok := payload["inbounds"].([]any)
	if !ok {
		t.Fatalf("runtime inbounds should be []any")
	}
	tunInbound := findInboundByType(inbounds, "tun")
	if tunInbound == nil {
		t.Fatalf("tun inbound should exist in tun mode")
	}
	mixedInbound := findInboundByType(inbounds, "mixed")
	if mixedInbound == nil {
		t.Fatalf("mixed inbound should exist in tun mode")
	}
	if mixedInbound["listen"] != "0.0.0.0" {
		t.Fatalf("unexpected mixed inbound listen: %v", mixedInbound["listen"])
	}
	listenPort, ok := mixedInbound["listen_port"].(float64)
	if !ok || int(listenPort) != 18080 {
		t.Fatalf("unexpected mixed inbound listen_port: %v", mixedInbound["listen_port"])
	}
}

func TestBuildRuntimeConfigAddsInternalHelperInbound(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ProxyMode = ProxyModeOff
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "node-1",
					Protocol: NodeProtocol("socks5"),
					Address:  "1.1.1.1",
					Port:     1080,
				},
			},
		},
	}
	snapshot.ActiveGroupID = "group-1"
	snapshot.SelectedNodeID = "node-1"

	rawConfig, err := buildRuntimeConfigWithControllerOptions(
		snapshot,
		resolveDefaultClashAPIController(),
		false,
		false,
		19527,
	)
	if err != nil {
		t.Fatalf("build runtime config failed: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("unmarshal runtime config failed: %v", err)
	}
	inbounds, ok := payload["inbounds"].([]any)
	if !ok {
		t.Fatalf("runtime inbounds should be []any")
	}
	helperInbound := findInboundByTag(inbounds, "internal-helper-in")
	if helperInbound == nil {
		t.Fatalf("internal helper inbound should exist")
	}
	if helperInbound["listen"] != "127.0.0.1" {
		t.Fatalf("unexpected helper inbound listen: %v", helperInbound["listen"])
	}
	listenPort, ok := helperInbound["listen_port"].(float64)
	if !ok || int(listenPort) != 19527 {
		t.Fatalf("unexpected helper inbound listen_port: %v", helperInbound["listen_port"])
	}
	route, ok := payload["route"].(map[string]any)
	if !ok {
		t.Fatalf("runtime route should be map")
	}
	rules, ok := route["rules"].([]any)
	if !ok || len(rules) == 0 {
		t.Fatalf("runtime route rules should exist")
	}
	firstRule, ok := rules[0].(map[string]any)
	if !ok {
		t.Fatalf("first route rule should be map")
	}
	if firstRule["outbound"] != proxySelectorTag {
		t.Fatalf("expected helper route to target selector outbound, got %v", firstRule["outbound"])
	}
}

func TestBuildRouteRuleSetDefinitionsAppliesRemoteDefaults(t *testing.T) {
	config := RuleConfigV2{
		Providers: RuleProviders{
			RuleSets: []RuleSetProvider{
				{
					ID:     "geosite-ads",
					Name:   "geosite-ads",
					Kind:   RuleProviderKindRuleSet,
					Format: "binary",
					Source: RuleProviderSource{
						Type: RuleProviderSourceTypeRemote,
						URL:  "https://example.com/geosite-ads.srs",
					},
				},
			},
		},
	}
	definitions := buildRouteRuleSetDefinitions(config)
	if len(definitions) != 1 {
		t.Fatalf("expected one rule-set definition, got %d", len(definitions))
	}
	entry, ok := definitions[0].(map[string]any)
	if !ok {
		t.Fatalf("rule-set definition should be map")
	}
	if entry["download_detour"] != "direct" {
		t.Fatalf("unexpected download_detour: %v", entry["download_detour"])
	}
	if entry["update_interval"] != defaultRuleSetUpdateInterval {
		t.Fatalf("unexpected update_interval: %v", entry["update_interval"])
	}
}

func TestBuildTransportGuardRouteRules(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.BlockQUIC = true
	snapshot.BlockUDP = false
	rules := buildTransportGuardRouteRules(snapshot)
	if len(rules) != 2 {
		t.Fatalf("expected 2 quic guard rules, got %d", len(rules))
	}
	firstRule, ok := rules[0].(map[string]any)
	if !ok {
		t.Fatalf("first guard rule should be map")
	}
	if firstRule["protocol"] != "quic" || firstRule["action"] != "reject" {
		t.Fatalf("unexpected first guard rule: %v", firstRule)
	}

	snapshot.BlockUDP = true
	rules = buildTransportGuardRouteRules(snapshot)
	if len(rules) != 1 {
		t.Fatalf("expected 1 udp block rule, got %d", len(rules))
	}
	onlyRule, ok := rules[0].(map[string]any)
	if !ok {
		t.Fatalf("udp block rule should be map")
	}
	if onlyRule["network"] != "udp" || onlyRule["action"] != "reject" {
		t.Fatalf("unexpected udp block rule: %v", onlyRule)
	}

	snapshot.BlockUDP = false
	snapshot.BlockQUIC = false
	rules = buildTransportGuardRouteRules(snapshot)
	if len(rules) != 0 {
		t.Fatalf("expected no guard rules, got %d", len(rules))
	}
}

func TestBuildNodeOutboundStripsMuxWhenPolicyForbids(t *testing.T) {
	node := Node{
		ID:       "node-vmess",
		Name:     "node-vmess",
		Protocol: NodeProtocol("vmess"),
		Address:  "1.1.1.1",
		Port:     443,
		RawConfig: `{
  "uuid": "bf000d23-0752-40b4-affe-68f7707a9661"
}`,
	}
	muxConfig := ProxyMuxConfig{
		Enabled:        true,
		Protocol:       ProxyMuxProtocolSMux,
		MaxConnections: 8,
		MinStreams:     2,
		MaxStreams:     0,
		Padding:        true,
		Brutal: ProxyMuxBrutal{
			Enabled:  true,
			UpMbps:   50,
			DownMbps: 60,
		},
	}
	outbound, err := buildNodeOutbound(node, muxConfig)
	if err != nil {
		t.Fatalf("build node outbound failed: %v", err)
	}
	if _, exists := outbound["multiplex"]; exists {
		t.Fatalf("expected outbound multiplex to be stripped")
	}
}

func TestBuildNodeOutboundUsesEmbeddedSingboxOutbound(t *testing.T) {
	node := Node{
		ID:       "node-wireguard",
		Name:     "node-wireguard",
		Protocol: NodeProtocol("wireguard"),
		Address:  "fallback.example.com",
		Port:     51820,
		RawConfig: `{
  "singboxOutbound": {
    "type": "wireguard",
    "server": "wg.example.com",
    "server_port": 51820,
    "local_address": ["10.0.0.2/32"],
    "private_key": "private-key",
    "peer_public_key": "peer-key"
  }
}`,
	}
	outbound, err := buildNodeOutbound(node, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build wireguard outbound failed: %v", err)
	}
	if outbound["type"] != "wireguard" {
		t.Fatalf("expected wireguard outbound type, got %#v", outbound["type"])
	}
	if outbound["server"] != "wg.example.com" {
		t.Fatalf("expected server from embedded outbound, got %#v", outbound["server"])
	}
	if anyToInt(outbound["server_port"]) != 51820 {
		t.Fatalf("expected server_port 51820, got %#v", outbound["server_port"])
	}
}

func TestBuildNodeOutboundAppliesQuicTransport(t *testing.T) {
	node := Node{
		ID:       "node-vless-quic",
		Name:     "node-vless-quic",
		Protocol: NodeProtocol("vless"),
		Address:  "quic.example.com",
		Port:     443,
		RawConfig: `{
  "uuid": "bf000d23-0752-40b4-affe-68f7707a9661",
  "transport": "quic",
  "tls": true,
  "security": "tls",
  "server_name": "quic.example.com"
}`,
	}
	outbound, err := buildNodeOutbound(node, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build quic outbound failed: %v", err)
	}
	transport, ok := outbound["transport"].(map[string]any)
	if !ok {
		t.Fatalf("expected transport map, got %#v", outbound["transport"])
	}
	if transport["type"] != "quic" {
		t.Fatalf("expected quic transport type, got %#v", transport["type"])
	}
}

func TestBuildNodeOutboundAppliesWebSocketAdvancedTransportFields(t *testing.T) {
	node := Node{
		ID:       "node-vmess-ws",
		Name:     "node-vmess-ws",
		Protocol: NodeProtocol("vmess"),
		Address:  "ws.example.com",
		Port:     443,
		RawConfig: `{
  "uuid": "bf000d23-0752-40b4-affe-68f7707a9661",
  "transport": "ws",
  "path": "/ws",
  "transport_headers": {
    "User-Agent": "Wateray"
  },
  "ws_max_early_data": 2048,
  "ws_early_data_header_name": "Sec-WebSocket-Protocol"
}`,
	}
	outbound, err := buildNodeOutbound(node, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build ws outbound failed: %v", err)
	}
	transport, ok := outbound["transport"].(map[string]any)
	if !ok {
		t.Fatalf("expected transport map, got %#v", outbound["transport"])
	}
	if transport["type"] != "ws" {
		t.Fatalf("expected ws transport type, got %#v", transport["type"])
	}
	if transport["path"] != "/ws" {
		t.Fatalf("expected ws path, got %#v", transport["path"])
	}
	headers, ok := transport["headers"].(map[string]any)
	if !ok || headers["User-Agent"] != "Wateray" {
		t.Fatalf("expected ws headers, got %#v", transport["headers"])
	}
	if anyToInt(transport["max_early_data"]) != 2048 {
		t.Fatalf("expected ws max_early_data 2048, got %#v", transport["max_early_data"])
	}
	if transport["early_data_header_name"] != "Sec-WebSocket-Protocol" {
		t.Fatalf("expected ws early_data_header_name, got %#v", transport["early_data_header_name"])
	}
}

func TestBuildNodeOutboundAppliesHTTPAndGrpcAdvancedTransportFields(t *testing.T) {
	httpNode := Node{
		ID:       "node-vless-http",
		Name:     "node-vless-http",
		Protocol: NodeProtocol("vless"),
		Address:  "http.example.com",
		Port:     443,
		RawConfig: `{
  "uuid": "bf000d23-0752-40b4-affe-68f7707a9661",
  "transport": "http",
  "host": "cdn.example.com",
  "path": "/h2",
  "transport_method": "POST",
  "transport_headers": {
    "X-Test": "yes"
  },
  "http_idle_timeout": "20s",
  "http_ping_timeout": "12s"
}`,
	}
	httpOutbound, err := buildNodeOutbound(httpNode, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build http outbound failed: %v", err)
	}
	httpTransport, ok := httpOutbound["transport"].(map[string]any)
	if !ok {
		t.Fatalf("expected http transport map, got %#v", httpOutbound["transport"])
	}
	if httpTransport["type"] != "http" {
		t.Fatalf("expected http transport type, got %#v", httpTransport["type"])
	}
	if httpTransport["method"] != "POST" {
		t.Fatalf("expected http method POST, got %#v", httpTransport["method"])
	}
	httpHeaders, ok := httpTransport["headers"].(map[string]any)
	if !ok || httpHeaders["X-Test"] != "yes" {
		t.Fatalf("expected http headers, got %#v", httpTransport["headers"])
	}
	if httpTransport["idle_timeout"] != "20s" || httpTransport["ping_timeout"] != "12s" {
		t.Fatalf("expected http timeouts, got %#v %#v", httpTransport["idle_timeout"], httpTransport["ping_timeout"])
	}

	grpcNode := Node{
		ID:       "node-trojan-grpc",
		Name:     "node-trojan-grpc",
		Protocol: NodeProtocol("trojan"),
		Address:  "grpc.example.com",
		Port:     443,
		RawConfig: `{
  "password": "secret",
  "transport": "grpc",
  "service_name": "TunService",
  "grpc_idle_timeout": "30s",
  "grpc_ping_timeout": "10s",
  "grpc_permit_without_stream": true
}`,
	}
	grpcOutbound, err := buildNodeOutbound(grpcNode, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build grpc outbound failed: %v", err)
	}
	grpcTransport, ok := grpcOutbound["transport"].(map[string]any)
	if !ok {
		t.Fatalf("expected grpc transport map, got %#v", grpcOutbound["transport"])
	}
	if grpcTransport["type"] != "grpc" {
		t.Fatalf("expected grpc transport type, got %#v", grpcTransport["type"])
	}
	if grpcTransport["service_name"] != "TunService" {
		t.Fatalf("expected grpc service_name, got %#v", grpcTransport["service_name"])
	}
	if grpcTransport["idle_timeout"] != "30s" || grpcTransport["ping_timeout"] != "10s" {
		t.Fatalf("expected grpc timeouts, got %#v %#v", grpcTransport["idle_timeout"], grpcTransport["ping_timeout"])
	}
	if value, ok := grpcTransport["permit_without_stream"].(bool); !ok || !value {
		t.Fatalf("expected grpc permit_without_stream true, got %#v", grpcTransport["permit_without_stream"])
	}
}

func TestBuildNodeOutboundAppliesShadowsocksSimpleObfsPlugin(t *testing.T) {
	node := Node{
		ID:       "node-ss-obfs",
		Name:     "node-ss-obfs",
		Protocol: NodeProtocol("shadowsocks"),
		Address:  "gz-cloud1.233netboom.com",
		Port:     12001,
		RawConfig: `{
  "method": "aes-128-gcm",
  "password": "Sj10bnYDe7w6V29E",
  "plugin": "simple-obfs",
  "plugin_opts": "obfs=http;obfs-host=bfd5a72b22.m.ctrip.com"
}`,
	}
	outbound, err := buildNodeOutbound(node, ProxyMuxConfig{})
	if err != nil {
		t.Fatalf("build shadowsocks outbound failed: %v", err)
	}
	if outbound["plugin"] != "obfs-local" {
		t.Fatalf("expected obfs-local plugin, got %#v", outbound["plugin"])
	}
	if outbound["plugin_opts"] != "obfs=http;obfs-host=bfd5a72b22.m.ctrip.com" {
		t.Fatalf("expected plugin_opts preserved, got %#v", outbound["plugin_opts"])
	}
	if outbound["network"] != "tcp" {
		t.Fatalf("expected plugin-backed shadowsocks network tcp, got %#v", outbound["network"])
	}
}

func TestPrepareRuntimeConfigForMinimalMode(t *testing.T) {
	runtime := newProxyRuntime(nil)
	snapshot := defaultSnapshot("test-runtime", "test-core")
	prepared, err := runtime.PrepareRuntimeConfig(snapshot)
	if err != nil {
		t.Fatalf("prepare runtime config failed: %v", err)
	}
	if prepared == nil {
		t.Fatalf("expected prepared runtime config")
	}
}

func TestBuildRuntimeConfigWithMinimalProbeSnapshotUsesOnlyHelperInbound(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ProxyMode = ProxyModeTun
	snapshot.SystemProxyEnabled = true
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "node-1",
					Protocol: NodeProtocol("socks5"),
					Address:  "1.1.1.1",
					Port:     1080,
				},
			},
		},
	}
	snapshot.ActiveGroupID = "group-1"
	snapshot.SelectedNodeID = "node-1"

	minimal := buildMinimalProbeRuntimeSnapshot(snapshot)
	rawConfig, err := buildRuntimeConfigWithControllerOptions(
		minimal,
		resolveDefaultClashAPIController(),
		true,
		false,
		39091,
	)
	if err != nil {
		t.Fatalf("build minimal runtime config failed: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("unmarshal minimal runtime config failed: %v", err)
	}
	inbounds, ok := payload["inbounds"].([]any)
	if !ok {
		t.Fatalf("minimal runtime inbounds should be []any")
	}
	if len(inbounds) != 1 {
		t.Fatalf("expected helper inbound only, got %#v", inbounds)
	}
	helperInbound := findInboundByTag(inbounds, "internal-helper-in")
	if helperInbound == nil {
		t.Fatalf("expected internal helper inbound")
	}
	if helperInbound["listen_port"] != float64(39091) {
		t.Fatalf("expected helper port 39091, got %#v", helperInbound["listen_port"])
	}
	if findInboundByType(inbounds, "tun") != nil {
		t.Fatalf("did not expect tun inbound in minimal runtime")
	}
	experimental, ok := payload["experimental"].(map[string]any)
	if !ok {
		t.Fatalf("expected experimental config")
	}
	if _, exists := experimental["cache_file"]; exists {
		t.Fatalf("did not expect cache_file in minimal runtime when disableCacheFile=true")
	}
	outbounds, ok := payload["outbounds"].([]any)
	if !ok {
		t.Fatalf("minimal runtime outbounds should be []any")
	}
	if findOutboundByTag(outbounds, runtimeNodeTag("node-1")) == nil {
		t.Fatalf("expected node outbound preserved in minimal runtime")
	}
}

func TestStartPreparedRejectsNilPreparedConfig(t *testing.T) {
	runtime := newProxyRuntime(nil)
	if err := runtime.StartPrepared(nil); err == nil {
		t.Fatalf("expected error when prepared config is nil")
	}
}

func TestRestartFastRejectsNilPreparedConfig(t *testing.T) {
	runtime := newProxyRuntime(nil)
	if _, err := runtime.RestartFast(nil, nil); err == nil {
		t.Fatalf("expected error when next prepared config is nil")
	}
}

func findOutboundByTag(outbounds []any, tag string) map[string]any {
	for _, raw := range outbounds {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if itemTag, _ := item["tag"].(string); itemTag == tag {
			return item
		}
	}
	return nil
}

func toStringSlice(raw any) []string {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			continue
		}
		result = append(result, text)
	}
	return result
}

func findInboundByType(inbounds []any, inboundType string) map[string]any {
	for _, raw := range inbounds {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if itemType, _ := item["type"].(string); itemType == inboundType {
			return item
		}
	}
	return nil
}

func findInboundByTag(inbounds []any, tag string) map[string]any {
	for _, raw := range inbounds {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if itemTag, _ := item["tag"].(string); itemTag == tag {
			return item
		}
	}
	return nil
}
