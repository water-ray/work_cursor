package control

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/include"
	singboxlog "github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	singjson "github.com/sagernet/sing/common/json"
	"golang.org/x/net/dns/dnsmessage"
)

const (
	defaultLocalMixedListenAddress  = "127.0.0.1"
	defaultLocalMixedListenPort     = 1088
	defaultTunInterfaceName         = "wateray-tun"
	defaultTunMTU                   = 1420
	minTunMTU                       = 576
	maxTunMTU                       = 9000
	defaultClashAPIControllerHost   = "127.0.0.1"
	bootstrapDNSServerTag           = "bootstrap"
	localDNSServerTag               = "local-resolver"
	dnsHostsOverrideServerTag       = "hosts-overrides"
	proxySelectorTag                = "proxy"
	proxyURLTestTag                 = "proxy-auto"
	proxyURLTestProbeURL            = "https://www.gstatic.com/generate_204"
	proxyURLTestInterval            = "3m"
	proxyURLTestIdleTimeout         = "30m"
	proxyURLTestToleranceMS         = 50
	defaultRuleSetUpdateInterval    = "1d"
	defaultDNSRemoteServer          = "https://dns.google/dns-query"
	defaultDNSDirectServer          = "223.5.5.5"
	defaultDNSBootstrapServer       = defaultDNSDirectServer
	defaultDNSFakeIPV4Range         = "10.128.0.0/9"
	defaultDNSFakeIPV6Range         = "fc00::/18"
	defaultDNSStrategy              = DNSStrategyPreferIPv4
	defaultDNSCacheCapacity         = 16384
	fakeIPDNSCacheCapacity          = 8192
	tunFakeIPDNSCacheCapacity       = 16384
	defaultSniffEnabled             = true
	defaultSniffOverrideDestination = true
	defaultSniffTimeoutMS           = 1000
	geoIPRuleSetURLTemplate         = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-%s.srs"
	geoSiteRuleSetURLTemplate       = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-%s.srs"
)

var defaultClashAPIControllerCandidates = []int{59520, 59521, 59522}

type proxyRuntime struct {
	mu                  sync.RWMutex
	cancel              context.CancelFunc
	box                 *box.Box
	onLog               func(level LogLevel, message string)
	clashAPIController  string
	defaultController   string
	disableCacheFile    bool
	disableExperimental bool
	internalProxyPort   int
}

type preparedRuntimeConfig struct {
	options            option.Options
	clashAPIController string
}

type runtimeRestartOutcome struct {
	Applied         bool
	RollbackApplied bool
}

type clashConnectionsSnapshot struct {
	UploadTotal        int64                   `json:"uploadTotal"`
	DownloadTotal      int64                   `json:"downloadTotal"`
	UploadTotalSnake   int64                   `json:"upload_total"`
	DownloadTotalSnake int64                   `json:"download_total"`
	Connections        []clashConnectionRecord `json:"connections"`
}

func (s *clashConnectionsSnapshot) UnmarshalJSON(data []byte) error {
	type rawSnapshot struct {
		UploadTotal        json.RawMessage         `json:"uploadTotal"`
		DownloadTotal      json.RawMessage         `json:"downloadTotal"`
		UploadTotalSnake   json.RawMessage         `json:"upload_total"`
		DownloadTotalSnake json.RawMessage         `json:"download_total"`
		Connections        []clashConnectionRecord `json:"connections"`
	}
	var raw rawSnapshot
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	uploadTotal, err := decodeFlexibleJSONInt64(raw.UploadTotal)
	if err != nil {
		return fmt.Errorf("uploadTotal: %w", err)
	}
	downloadTotal, err := decodeFlexibleJSONInt64(raw.DownloadTotal)
	if err != nil {
		return fmt.Errorf("downloadTotal: %w", err)
	}
	uploadTotalSnake, err := decodeFlexibleJSONInt64(raw.UploadTotalSnake)
	if err != nil {
		return fmt.Errorf("upload_total: %w", err)
	}
	downloadTotalSnake, err := decodeFlexibleJSONInt64(raw.DownloadTotalSnake)
	if err != nil {
		return fmt.Errorf("download_total: %w", err)
	}
	*s = clashConnectionsSnapshot{
		UploadTotal:        uploadTotal,
		DownloadTotal:      downloadTotal,
		UploadTotalSnake:   uploadTotalSnake,
		DownloadTotalSnake: downloadTotalSnake,
		Connections:        raw.Connections,
	}
	return nil
}

type clashConnectionRecord struct {
	ID            string                  `json:"id"`
	Upload        int64                   `json:"upload"`
	Download      int64                   `json:"download"`
	UploadSnake   int64                   `json:"upload_bytes"`
	DownloadSnake int64                   `json:"download_bytes"`
	Metadata      clashConnectionMetadata `json:"metadata"`
	Chains        []string                `json:"chains"`
}

func (r *clashConnectionRecord) UnmarshalJSON(data []byte) error {
	type rawRecord struct {
		ID            string                  `json:"id"`
		Upload        json.RawMessage         `json:"upload"`
		Download      json.RawMessage         `json:"download"`
		UploadSnake   json.RawMessage         `json:"upload_bytes"`
		DownloadSnake json.RawMessage         `json:"download_bytes"`
		Metadata      clashConnectionMetadata `json:"metadata"`
		Chains        []string                `json:"chains"`
	}
	var raw rawRecord
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	upload, err := decodeFlexibleJSONInt64(raw.Upload)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	download, err := decodeFlexibleJSONInt64(raw.Download)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	uploadSnake, err := decodeFlexibleJSONInt64(raw.UploadSnake)
	if err != nil {
		return fmt.Errorf("upload_bytes: %w", err)
	}
	downloadSnake, err := decodeFlexibleJSONInt64(raw.DownloadSnake)
	if err != nil {
		return fmt.Errorf("download_bytes: %w", err)
	}
	*r = clashConnectionRecord{
		ID:            strings.TrimSpace(raw.ID),
		Upload:        upload,
		Download:      download,
		UploadSnake:   uploadSnake,
		DownloadSnake: downloadSnake,
		Metadata:      raw.Metadata,
		Chains:        append([]string{}, raw.Chains...),
	}
	return nil
}

type clashConnectionStatsRecord struct {
	Upload        int64    `json:"upload"`
	Download      int64    `json:"download"`
	UploadSnake   int64    `json:"upload_bytes"`
	DownloadSnake int64    `json:"download_bytes"`
	Network       string   `json:"network"`
	Chains        []string `json:"chains"`
}

func (r *clashConnectionStatsRecord) UnmarshalJSON(data []byte) error {
	type rawRecord struct {
		Upload        json.RawMessage `json:"upload"`
		Download      json.RawMessage `json:"download"`
		UploadSnake   json.RawMessage `json:"upload_bytes"`
		DownloadSnake json.RawMessage `json:"download_bytes"`
		Metadata      struct {
			Network string `json:"network"`
		} `json:"metadata"`
		Chains []string `json:"chains"`
	}
	var raw rawRecord
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	upload, err := decodeFlexibleJSONInt64(raw.Upload)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	download, err := decodeFlexibleJSONInt64(raw.Download)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	uploadSnake, err := decodeFlexibleJSONInt64(raw.UploadSnake)
	if err != nil {
		return fmt.Errorf("upload_bytes: %w", err)
	}
	downloadSnake, err := decodeFlexibleJSONInt64(raw.DownloadSnake)
	if err != nil {
		return fmt.Errorf("download_bytes: %w", err)
	}
	*r = clashConnectionStatsRecord{
		Upload:        upload,
		Download:      download,
		UploadSnake:   uploadSnake,
		DownloadSnake: downloadSnake,
		Network:       strings.TrimSpace(raw.Metadata.Network),
		Chains:        append([]string{}, raw.Chains...),
	}
	return nil
}

type clashConnectionMetadata struct {
	Network              string `json:"network"`
	Type                 string `json:"type"`
	Host                 string `json:"host"`
	DestinationIP        string `json:"destinationIP"`
	DestinationIPSnake   string `json:"destination_ip"`
	DestinationPort      int    `json:"destinationPort"`
	DestinationPortSnake int    `json:"destination_port"`
	Inbound              string `json:"inbound"`
	InboundName          string `json:"inboundName"`
	InboundTag           string `json:"inboundTag"`
	Process              string `json:"process"`
	ProcessName          string `json:"processName"`
	ProcessPath          string `json:"processPath"`
	ProcessPathSnake     string `json:"process_path"`
	ProcessID            int64  `json:"processId"`
	ProcessIDSnake       int64  `json:"process_id"`
	Rule                 string `json:"rule"`
	RulePayload          string `json:"rulePayload"`
	RulePayloadSnake     string `json:"rule_payload"`
	Country              string `json:"country"`
}

func (m *clashConnectionMetadata) UnmarshalJSON(data []byte) error {
	type rawMetadata struct {
		Network              string          `json:"network"`
		Type                 string          `json:"type"`
		Host                 string          `json:"host"`
		DestinationIP        string          `json:"destinationIP"`
		DestinationIPSnake   string          `json:"destination_ip"`
		DestinationPort      json.RawMessage `json:"destinationPort"`
		DestinationPortSnake json.RawMessage `json:"destination_port"`
		Inbound              string          `json:"inbound"`
		InboundName          string          `json:"inboundName"`
		InboundTag           string          `json:"inboundTag"`
		Process              string          `json:"process"`
		ProcessName          string          `json:"processName"`
		ProcessPath          string          `json:"processPath"`
		ProcessPathSnake     string          `json:"process_path"`
		ProcessID            json.RawMessage `json:"processId"`
		ProcessIDSnake       json.RawMessage `json:"process_id"`
		Rule                 string          `json:"rule"`
		RulePayload          string          `json:"rulePayload"`
		RulePayloadSnake     string          `json:"rule_payload"`
		Country              string          `json:"country"`
	}
	var raw rawMetadata
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	destinationPort, err := decodeFlexibleJSONInt(raw.DestinationPort)
	if err != nil {
		return fmt.Errorf("destinationPort: %w", err)
	}
	destinationPortSnake, err := decodeFlexibleJSONInt(raw.DestinationPortSnake)
	if err != nil {
		return fmt.Errorf("destination_port: %w", err)
	}
	processID, err := decodeFlexibleJSONInt64(raw.ProcessID)
	if err != nil {
		return fmt.Errorf("processId: %w", err)
	}
	processIDSnake, err := decodeFlexibleJSONInt64(raw.ProcessIDSnake)
	if err != nil {
		return fmt.Errorf("process_id: %w", err)
	}
	*m = clashConnectionMetadata{
		Network:              strings.TrimSpace(raw.Network),
		Type:                 strings.TrimSpace(raw.Type),
		Host:                 strings.TrimSpace(raw.Host),
		DestinationIP:        strings.TrimSpace(raw.DestinationIP),
		DestinationIPSnake:   strings.TrimSpace(raw.DestinationIPSnake),
		DestinationPort:      destinationPort,
		DestinationPortSnake: destinationPortSnake,
		Inbound:              strings.TrimSpace(raw.Inbound),
		InboundName:          strings.TrimSpace(raw.InboundName),
		InboundTag:           strings.TrimSpace(raw.InboundTag),
		Process:              strings.TrimSpace(raw.Process),
		ProcessName:          strings.TrimSpace(raw.ProcessName),
		ProcessPath:          strings.TrimSpace(raw.ProcessPath),
		ProcessPathSnake:     strings.TrimSpace(raw.ProcessPathSnake),
		ProcessID:            processID,
		ProcessIDSnake:       processIDSnake,
		Rule:                 strings.TrimSpace(raw.Rule),
		RulePayload:          strings.TrimSpace(raw.RulePayload),
		RulePayloadSnake:     strings.TrimSpace(raw.RulePayloadSnake),
		Country:              strings.TrimSpace(raw.Country),
	}
	return nil
}

func decodeFlexibleJSONInt(data json.RawMessage) (int, error) {
	value, err := decodeFlexibleJSONInt64(data)
	if err != nil {
		return 0, err
	}
	return int(value), nil
}

func decodeFlexibleJSONInt64(data json.RawMessage) (int64, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return 0, nil
	}
	var intValue int64
	if err := json.Unmarshal(data, &intValue); err == nil {
		return intValue, nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		text = strings.TrimSpace(text)
		if text == "" {
			return 0, nil
		}
		value, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil {
			return 0, fmt.Errorf("invalid integer string %q", text)
		}
		return value, nil
	}
	return 0, fmt.Errorf("invalid integer value %s", trimmed)
}

type trafficTickConnectionsBuilder struct {
	stats             TrafficTickPayload
	nodeUsage         map[string]int64
	nodeUploadBytes   map[string]int64
	nodeDownloadBytes map[string]int64
}

func newTrafficTickConnectionsBuilder(uploadBytes int64, downloadBytes int64) trafficTickConnectionsBuilder {
	return trafficTickConnectionsBuilder{
		stats: TrafficTickPayload{
			UploadBytes:   uploadBytes,
			DownloadBytes: downloadBytes,
		},
		nodeUsage:         map[string]int64{},
		nodeUploadBytes:   map[string]int64{},
		nodeDownloadBytes: map[string]int64{},
	}
}

func (b *trafficTickConnectionsBuilder) setUploadBytes(value int64) {
	b.stats.UploadBytes = maxInt64(b.stats.UploadBytes, value)
}

func (b *trafficTickConnectionsBuilder) setDownloadBytes(value int64) {
	b.stats.DownloadBytes = maxInt64(b.stats.DownloadBytes, value)
}

func (b *trafficTickConnectionsBuilder) addConnection(network string, uploadBytes int64, downloadBytes int64, chains []string) {
	b.stats.TotalConnections++
	switch {
	case strings.HasPrefix(network, "tcp"):
		b.stats.TCPConnections++
	case strings.HasPrefix(network, "udp"):
		b.stats.UDPConnections++
	}

	var connectionNodeIDs map[string]struct{}
	for _, chainTag := range chains {
		nodeID, ok := parseRuntimeNodeIDFromTag(chainTag)
		if !ok {
			continue
		}
		if connectionNodeIDs == nil {
			connectionNodeIDs = make(map[string]struct{}, len(chains))
		}
		connectionNodeIDs[nodeID] = struct{}{}
	}
	for nodeID := range connectionNodeIDs {
		b.nodeUsage[nodeID]++
		b.nodeUploadBytes[nodeID] += uploadBytes
		b.nodeDownloadBytes[nodeID] += downloadBytes
	}
}

func (b *trafficTickConnectionsBuilder) build() TrafficTickPayload {
	stats := b.stats
	if len(b.nodeUsage) == 0 {
		return stats
	}
	stats.ActiveNodeCount = int64(len(b.nodeUsage))
	nodeIDs := make([]string, 0, len(b.nodeUsage))
	for nodeID := range b.nodeUsage {
		nodeIDs = append(nodeIDs, nodeID)
	}
	sort.Slice(nodeIDs, func(i, j int) bool {
		left := b.nodeUsage[nodeIDs[i]]
		right := b.nodeUsage[nodeIDs[j]]
		if left == right {
			return nodeIDs[i] < nodeIDs[j]
		}
		return left > right
	})
	stats.Nodes = make([]ActiveNodeConnection, 0, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		stats.Nodes = append(stats.Nodes, ActiveNodeConnection{
			NodeID:        nodeID,
			Connections:   b.nodeUsage[nodeID],
			UploadBytes:   b.nodeUploadBytes[nodeID],
			DownloadBytes: b.nodeDownloadBytes[nodeID],
		})
	}
	return stats
}

func decodeFlexibleJSONInt64FromDecoder(decoder *json.Decoder) (int64, error) {
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return 0, err
	}
	return decodeFlexibleJSONInt64(raw)
}

func decodeTrafficTickConnectionsArray(
	decoder *json.Decoder,
	builder *trafficTickConnectionsBuilder,
) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("decode connections array start failed: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '[' {
		return errors.New("connections is not an array")
	}
	for decoder.More() {
		var record clashConnectionStatsRecord
		if err := decoder.Decode(&record); err != nil {
			return fmt.Errorf("decode connection record failed: %w", err)
		}
		builder.addConnection(
			strings.ToLower(strings.TrimSpace(record.Network)),
			maxInt64(record.Upload, record.UploadSnake),
			maxInt64(record.Download, record.DownloadSnake),
			record.Chains,
		)
	}
	token, err = decoder.Token()
	if err != nil {
		return fmt.Errorf("decode connections array end failed: %w", err)
	}
	delim, ok = token.(json.Delim)
	if !ok || delim != ']' {
		return errors.New("connections array did not close correctly")
	}
	return nil
}

func buildTrafficTickFromConnectionsReader(reader io.Reader) (TrafficTickPayload, error) {
	decoder := json.NewDecoder(reader)
	token, err := decoder.Token()
	if err != nil {
		return TrafficTickPayload{}, fmt.Errorf("decode connections response start failed: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return TrafficTickPayload{}, errors.New("connections response is not an object")
	}
	builder := newTrafficTickConnectionsBuilder(0, 0)
	for decoder.More() {
		fieldToken, err := decoder.Token()
		if err != nil {
			return TrafficTickPayload{}, fmt.Errorf("decode connections field failed: %w", err)
		}
		fieldName, ok := fieldToken.(string)
		if !ok {
			return TrafficTickPayload{}, errors.New("connections field name is invalid")
		}
		switch fieldName {
		case "uploadTotal", "upload_total":
			value, err := decodeFlexibleJSONInt64FromDecoder(decoder)
			if err != nil {
				return TrafficTickPayload{}, fmt.Errorf("%s: %w", fieldName, err)
			}
			builder.setUploadBytes(value)
		case "downloadTotal", "download_total":
			value, err := decodeFlexibleJSONInt64FromDecoder(decoder)
			if err != nil {
				return TrafficTickPayload{}, fmt.Errorf("%s: %w", fieldName, err)
			}
			builder.setDownloadBytes(value)
		case "connections":
			if err := decodeTrafficTickConnectionsArray(decoder, &builder); err != nil {
				return TrafficTickPayload{}, fmt.Errorf("connections: %w", err)
			}
		default:
			var discarded any
			if err := decoder.Decode(&discarded); err != nil {
				return TrafficTickPayload{}, fmt.Errorf("skip connections field %s failed: %w", fieldName, err)
			}
		}
	}
	token, err = decoder.Token()
	if err != nil {
		return TrafficTickPayload{}, fmt.Errorf("decode connections response end failed: %w", err)
	}
	delim, ok = token.(json.Delim)
	if !ok || delim != '}' {
		return TrafficTickPayload{}, errors.New("connections response did not close correctly")
	}
	return builder.build(), nil
}

func newProxyRuntime(onLog func(level LogLevel, message string)) *proxyRuntime {
	return &proxyRuntime{
		onLog:             onLog,
		defaultController: resolveDefaultClashAPIController(),
	}
}

func currentProxyCoreVersion() string {
	version := strings.TrimSpace(constant.Version)
	if version == "" {
		return "unknown"
	}
	return version
}

func resolveClashAPIController(controller string) string {
	controller = strings.TrimSpace(controller)
	if controller == "" {
		return resolveDefaultClashAPIController()
	}
	return controller
}

func resolveDefaultClashAPIController() string {
	for _, port := range defaultClashAPIControllerCandidates {
		address := fmt.Sprintf("%s:%d", defaultClashAPIControllerHost, port)
		listener, err := net.Listen("tcp", address)
		if err != nil {
			continue
		}
		_ = listener.Close()
		return address
	}
	return fmt.Sprintf("%s:%d", defaultClashAPIControllerHost, defaultClashAPIControllerCandidates[0])
}

func (r *proxyRuntime) clashAPIControllerOrDefault() string {
	if r == nil {
		return resolveDefaultClashAPIController()
	}
	r.mu.RLock()
	controller := resolveClashAPIController(r.clashAPIController)
	r.mu.RUnlock()
	return controller
}

func (r *proxyRuntime) ConfigurePrepareDefaults(
	controller string,
	disableCacheFile bool,
	disableExperimental bool,
) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.defaultController = resolveClashAPIController(controller)
	r.disableCacheFile = disableCacheFile
	r.disableExperimental = disableExperimental
}

func (r *proxyRuntime) ConfigureInternalProxyPort(port int) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.internalProxyPort = port
}

func (r *proxyRuntime) PrepareRuntimeConfig(snapshot StateSnapshot) (*preparedRuntimeConfig, error) {
	if r == nil {
		return nil, errors.New("runtime is required")
	}
	r.mu.Lock()
	controller := resolveClashAPIController(r.defaultController)
	disableCacheFile := r.disableCacheFile
	disableExperimental := r.disableExperimental
	internalProxyPort := r.internalProxyPort
	r.mu.Unlock()
	return r.PrepareRuntimeConfigWithControllerOptions(
		snapshot,
		controller,
		disableCacheFile,
		disableExperimental,
		internalProxyPort,
	)
}

func (r *proxyRuntime) PrepareRuntimeConfigWithController(
	snapshot StateSnapshot,
	externalController string,
) (*preparedRuntimeConfig, error) {
	return r.PrepareRuntimeConfigWithControllerOptions(snapshot, externalController, false, false, 0)
}

func (r *proxyRuntime) PrepareRuntimeConfigWithControllerOptions(
	snapshot StateSnapshot,
	externalController string,
	disableCacheFile bool,
	disableExperimental bool,
	internalProxyPort int,
) (*preparedRuntimeConfig, error) {
	configContent, err := buildRuntimeConfigWithControllerOptions(
		snapshot,
		externalController,
		disableCacheFile,
		disableExperimental,
		internalProxyPort,
	)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(include.Context(context.Background()))
	defer cancel()
	options, err := singjson.UnmarshalExtendedContext[option.Options](ctx, []byte(configContent))
	if err != nil {
		return nil, fmt.Errorf("decode sing-box config failed: %w", err)
	}
	return &preparedRuntimeConfig{
		options:            options,
		clashAPIController: resolveClashAPIController(externalController),
	}, nil
}

func (r *proxyRuntime) Start(snapshot StateSnapshot) error {
	prepared, err := r.PrepareRuntimeConfig(snapshot)
	if err != nil {
		return err
	}
	return r.StartPrepared(prepared)
}

func (r *proxyRuntime) StartPrepared(prepared *preparedRuntimeConfig) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = r.stopLocked()
	if err := r.startPreparedLocked(prepared); err != nil {
		return err
	}
	return nil
}

func (r *proxyRuntime) RestartFast(nextPrepared *preparedRuntimeConfig, rollbackPrepared *preparedRuntimeConfig) (runtimeRestartOutcome, error) {
	if nextPrepared == nil {
		return runtimeRestartOutcome{}, errors.New("next prepared runtime config is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	_ = r.stopLocked()
	if err := r.startPreparedLocked(nextPrepared); err != nil {
		if rollbackPrepared == nil {
			return runtimeRestartOutcome{}, fmt.Errorf("start next runtime failed: %w", err)
		}
		rollbackErr := r.startPreparedLocked(rollbackPrepared)
		if rollbackErr != nil {
			return runtimeRestartOutcome{}, fmt.Errorf("start next runtime failed: %v; rollback failed: %w", err, rollbackErr)
		}
		return runtimeRestartOutcome{
			Applied:         false,
			RollbackApplied: true,
		}, fmt.Errorf("start next runtime failed: %v; rollback succeeded", err)
	}
	return runtimeRestartOutcome{
		Applied:         true,
		RollbackApplied: false,
	}, nil
}

func (r *proxyRuntime) ValidateConfig(snapshot StateSnapshot) error {
	if _, err := r.PrepareRuntimeConfig(snapshot); err != nil {
		return err
	}
	return nil
}

func (r *proxyRuntime) Stop() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopLocked()
}

func (r *proxyRuntime) IsRunning() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	running := r.box != nil
	r.mu.Unlock()
	return running
}

func (r *proxyRuntime) startPreparedLocked(prepared *preparedRuntimeConfig) error {
	if prepared == nil {
		return errors.New("prepared runtime config is required")
	}
	ctx, cancel := context.WithCancel(include.Context(context.Background()))
	options := prepared.options
	instance, err := box.New(box.Options{
		Context:           ctx,
		Options:           options,
		PlatformLogWriter: &proxyPlatformWriter{onLog: r.onLog},
	})
	if err != nil {
		cancel()
		return fmt.Errorf("create sing-box instance failed: %w", err)
	}
	if err := instance.Start(); err != nil {
		cancel()
		_ = instance.Close()
		return fmt.Errorf("start sing-box failed: %w", err)
	}
	r.box = instance
	r.cancel = cancel
	r.clashAPIController = resolveClashAPIController(prepared.clashAPIController)
	return nil
}

func (r *proxyRuntime) SwitchSelectedNode(nodeID string) error {
	return r.SwitchSelectorOutbound(proxySelectorTag, runtimeNodeTag(nodeID))
}

func (r *proxyRuntime) UpdateLogLevel(level LogLevel) error {
	targetLevel := normalizeClashAPILogLevel(toClashAPILogLevel(level))
	controller := r.clashAPIControllerOrDefault()
	requestBody, err := json.Marshal(map[string]string{
		"log-level": toClashAPILogLevel(level),
	})
	if err != nil {
		return fmt.Errorf("build update log-level request failed: %w", err)
	}
	request, err := http.NewRequest(
		http.MethodPatch,
		"http://"+controller+"/configs",
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return fmt.Errorf("create update log-level request failed: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("update log-level failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusOK {
		currentLevel, queryErr := queryClashAPILogLevel(controller, client)
		if queryErr != nil {
			return fmt.Errorf("verify update log-level failed: %w", queryErr)
		}
		if normalizeClashAPILogLevel(currentLevel) != targetLevel {
			return fmt.Errorf(
				"update log-level not applied: expected=%s actual=%s",
				targetLevel,
				currentLevel,
			)
		}
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	return fmt.Errorf(
		"update log-level failed: status=%d body=%s",
		response.StatusCode,
		strings.TrimSpace(string(body)),
	)
}

func (r *proxyRuntime) UpdateMode(mode string) error {
	targetMode := normalizeClashAPIProxyMode(mode)
	if targetMode == "" {
		return errors.New("mode is required")
	}
	controller := r.clashAPIControllerOrDefault()
	requestBody, err := json.Marshal(map[string]string{
		"mode": targetMode,
	})
	if err != nil {
		return fmt.Errorf("build update mode request failed: %w", err)
	}
	request, err := http.NewRequest(
		http.MethodPatch,
		"http://"+controller+"/configs",
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return fmt.Errorf("create update mode request failed: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("update mode failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusOK {
		currentMode, queryErr := queryClashAPIProxyMode(controller, client)
		if queryErr != nil {
			return fmt.Errorf("verify update mode failed: %w", queryErr)
		}
		if normalizeClashAPIProxyMode(currentMode) != targetMode {
			return fmt.Errorf(
				"update mode not applied: expected=%s actual=%s",
				targetMode,
				currentMode,
			)
		}
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	return fmt.Errorf(
		"update mode failed: status=%d body=%s",
		response.StatusCode,
		strings.TrimSpace(string(body)),
	)
}

func queryClashAPILogLevel(controller string, client *http.Client) (string, error) {
	controller = resolveClashAPIController(controller)
	if client == nil {
		client = &http.Client{
			Timeout: 3 * time.Second,
		}
	}
	request, err := http.NewRequest(
		http.MethodGet,
		"http://"+controller+"/configs",
		nil,
	)
	if err != nil {
		return "", fmt.Errorf("create query log-level request failed: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("query log-level failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return "", fmt.Errorf(
			"query log-level failed: status=%d body=%s",
			response.StatusCode,
			strings.TrimSpace(string(body)),
		)
	}
	var payload struct {
		LogLevel string `json:"log-level"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode query log-level response failed: %w", err)
	}
	if strings.TrimSpace(payload.LogLevel) == "" {
		return "", errors.New("query log-level response missing log-level")
	}
	return payload.LogLevel, nil
}

func queryClashAPIProxyMode(controller string, client *http.Client) (string, error) {
	controller = resolveClashAPIController(controller)
	if client == nil {
		client = &http.Client{
			Timeout: 3 * time.Second,
		}
	}
	request, err := http.NewRequest(
		http.MethodGet,
		"http://"+controller+"/configs",
		nil,
	)
	if err != nil {
		return "", fmt.Errorf("create query mode request failed: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("query mode failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return "", fmt.Errorf(
			"query mode failed: status=%d body=%s",
			response.StatusCode,
			strings.TrimSpace(string(body)),
		)
	}
	var payload struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode query mode response failed: %w", err)
	}
	if strings.TrimSpace(payload.Mode) == "" {
		return "", errors.New("query mode response missing mode")
	}
	return payload.Mode, nil
}

func normalizeClashAPILogLevel(level string) string {
	value := strings.ToLower(strings.TrimSpace(level))
	switch value {
	case "warn":
		return "warning"
	case "none", "off":
		return "silent"
	default:
		return value
	}
}

func normalizeClashAPIProxyMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "direct":
		return "direct"
	case "global":
		return "global"
	case "rule":
		return "rule"
	default:
		return ""
	}
}

func (r *proxyRuntime) SwitchSelectorOutbound(selectorTag string, outboundTag string) error {
	selectorTag = strings.TrimSpace(selectorTag)
	outboundTag = strings.TrimSpace(outboundTag)
	if selectorTag == "" || outboundTag == "" {
		return errors.New("selectorTag/outboundTag is required")
	}
	controller := r.clashAPIControllerOrDefault()
	requestBody, err := json.Marshal(map[string]string{
		"name": outboundTag,
	})
	if err != nil {
		return fmt.Errorf("build selector request failed: %w", err)
	}
	request, err := http.NewRequest(
		http.MethodPut,
		"http://"+controller+"/proxies/"+url.PathEscape(selectorTag),
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return fmt.Errorf("create selector request failed: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("switch selector failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusOK {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	return fmt.Errorf("switch selector failed: status=%d body=%s", response.StatusCode, strings.TrimSpace(string(body)))
}

func (r *proxyRuntime) ProbeNodeDelay(nodeID string, probeURL string, timeoutMS int) (int, error) {
	tag := runtimeNodeTag(nodeID)
	controller := r.clashAPIControllerOrDefault()
	normalizedProbeURL := strings.TrimSpace(probeURL)
	if normalizedProbeURL == "" {
		normalizedProbeURL = "https://www.gstatic.com/generate_204"
	}
	if timeoutMS <= 0 {
		timeoutMS = 5000
	}
	controllerURL := "http://" + controller + "/proxies/" + url.PathEscape(tag) + "/delay?url=" + url.QueryEscape(normalizedProbeURL) + "&timeout=" + strconv.Itoa(timeoutMS)
	request, err := http.NewRequest(http.MethodGet, controllerURL, nil)
	if err != nil {
		return 0, fmt.Errorf("create probe request failed: %w", err)
	}
	client := &http.Client{
		Timeout: time.Duration(timeoutMS+2000) * time.Millisecond,
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("probe delay failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return 0, fmt.Errorf(
			"probe delay failed: status=%d body=%s",
			response.StatusCode,
			strings.TrimSpace(string(body)),
		)
	}
	var payload struct {
		Delay int `json:"delay"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return 0, fmt.Errorf("decode probe response failed: %w", err)
	}
	if payload.Delay <= 0 {
		return 0, errors.New("probe delay is zero")
	}
	return payload.Delay, nil
}

func (r *proxyRuntime) ProbeNodeRealConnect(nodeID string, probeURL string, timeoutMS int) (int, error) {
	return r.ProbeNodeDelay(nodeID, probeURL, timeoutMS)
}

func (r *proxyRuntime) CloseAllConnections() error {
	controller := r.clashAPIControllerOrDefault()
	request, err := http.NewRequest(
		http.MethodDelete,
		"http://"+controller+"/connections",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create close-all-connections request failed: %w", err)
	}
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("close all connections failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusOK {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	return fmt.Errorf(
		"close all connections failed: status=%d body=%s",
		response.StatusCode,
		strings.TrimSpace(string(body)),
	)
}

func (r *proxyRuntime) QueryConnectionsStats() (TrafficTickPayload, error) {
	response, err := r.queryConnectionsResponse()
	if err != nil {
		return TrafficTickPayload{}, err
	}
	defer response.Body.Close()
	stats, err := buildTrafficTickFromConnectionsReader(response.Body)
	if err != nil {
		return TrafficTickPayload{}, fmt.Errorf("decode query connections response failed: %w", err)
	}
	return stats, nil
}

func (r *proxyRuntime) queryConnectionsResponse() (*http.Response, error) {
	controller := r.clashAPIControllerOrDefault()
	request, err := http.NewRequest(
		http.MethodGet,
		"http://"+controller+"/connections",
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("create query connections request failed: %w", err)
	}
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("query connections failed: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		_ = response.Body.Close()
		return nil, fmt.Errorf(
			"query connections failed: status=%d body=%s",
			response.StatusCode,
			strings.TrimSpace(string(body)),
		)
	}
	return response, nil
}

func (r *proxyRuntime) QueryConnectionsSnapshot() (clashConnectionsSnapshot, error) {
	response, err := r.queryConnectionsResponse()
	if err != nil {
		return clashConnectionsSnapshot{}, err
	}
	defer response.Body.Close()
	var payload clashConnectionsSnapshot
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return clashConnectionsSnapshot{}, fmt.Errorf("decode query connections response failed: %w", err)
	}
	return payload, nil
}

func buildTrafficTickFromConnectionsSnapshot(payload clashConnectionsSnapshot) TrafficTickPayload {
	builder := newTrafficTickConnectionsBuilder(
		maxInt64(payload.UploadTotal, payload.UploadTotalSnake),
		maxInt64(payload.DownloadTotal, payload.DownloadTotalSnake),
	)
	for _, connection := range payload.Connections {
		builder.addConnection(
			strings.ToLower(strings.TrimSpace(connection.Metadata.Network)),
			maxInt64(connection.Upload, connection.UploadSnake),
			maxInt64(connection.Download, connection.DownloadSnake),
			connection.Chains,
		)
	}
	return builder.build()
}

func maxInt64(a int64, b int64) int64 {
	if a >= b {
		if a < 0 {
			return 0
		}
		return a
	}
	if b < 0 {
		return 0
	}
	return b
}

func (r *proxyRuntime) FlushFakeIPCache() error {
	controller := r.clashAPIControllerOrDefault()
	request, err := http.NewRequest(
		http.MethodPost,
		"http://"+controller+"/cache/fakeip/flush",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create flush fakeip request failed: %w", err)
	}
	client := &http.Client{
		Timeout: 3 * time.Second,
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("flush fakeip cache failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusOK {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	bodyText := strings.TrimSpace(string(body))
	// sing-box may return 500 {"message":"bucket not found"} when fakeip cache bucket does not exist.
	// Treat it as an idempotent no-op instead of surfacing a hard error to UI.
	if response.StatusCode == http.StatusInternalServerError &&
		strings.Contains(strings.ToLower(bodyText), "bucket not found") {
		return nil
	}
	return fmt.Errorf(
		"flush fakeip cache failed: status=%d body=%s",
		response.StatusCode,
		bodyText,
	)
}

func (r *proxyRuntime) CheckDNSResolver(
	ctx context.Context,
	endpoint DNSResolverEndpoint,
	domain string,
	timeout time.Duration,
) ([]string, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return nil, errors.New("domain is required")
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	resolveWithSystem := func() ([]string, error) {
		values, err := net.DefaultResolver.LookupHost(checkCtx, domain)
		if err != nil {
			return nil, err
		}
		return uniqueNonEmptyStrings(values), nil
	}
	switch endpoint.Type {
	case DNSResolverTypeLocal, DNSResolverTypeHosts, DNSResolverTypeResolved, DNSResolverTypeDHCP:
		return resolveWithSystem()
	case DNSResolverTypeUDP, DNSResolverTypeTCP:
		serverAddress := net.JoinHostPort(endpoint.Address, strconv.Itoa(endpoint.Port))
		resolverNetwork := "udp"
		if endpoint.Type == DNSResolverTypeTCP {
			resolverNetwork = "tcp"
		}
		dialer := net.Dialer{
			Timeout: timeout,
		}
		resolver := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network string, address string) (net.Conn, error) {
				return dialer.DialContext(ctx, resolverNetwork, serverAddress)
			},
		}
		values, err := resolver.LookupHost(checkCtx, domain)
		if err != nil {
			return nil, err
		}
		return uniqueNonEmptyStrings(values), nil
	case DNSResolverTypeTLS:
		return resolveDNSOverTLS(checkCtx, endpoint, domain, timeout)
	case DNSResolverTypeQUIC:
		address := net.JoinHostPort(endpoint.Address, strconv.Itoa(endpoint.Port))
		conn, err := (&net.Dialer{Timeout: timeout}).DialContext(checkCtx, "udp", address)
		if err != nil {
			return nil, err
		}
		_ = conn.Close()
		return []string{}, nil
	case DNSResolverTypeHTTPS, DNSResolverTypeH3:
		return resolveDNSOverHTTPS(checkCtx, endpoint, domain, timeout)
	default:
		return nil, errors.New("unsupported dns resolver type")
	}
}

func resolveDNSOverTLS(
	ctx context.Context,
	endpoint DNSResolverEndpoint,
	domain string,
	timeout time.Duration,
) ([]string, error) {
	address := net.JoinHostPort(endpoint.Address, strconv.Itoa(endpoint.Port))
	dialer := &tls.Dialer{
		NetDialer: &net.Dialer{
			Timeout: timeout,
		},
		Config: &tls.Config{
			ServerName:         endpoint.Address,
			InsecureSkipVerify: true,
		},
	}
	queryFn := func(query []byte) ([]byte, error) {
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetDeadline(deadline)
		} else {
			_ = conn.SetDeadline(time.Now().Add(timeout))
		}
		packet := make([]byte, 2+len(query))
		binary.BigEndian.PutUint16(packet[:2], uint16(len(query)))
		copy(packet[2:], query)
		if _, err := conn.Write(packet); err != nil {
			return nil, err
		}
		lengthBuffer := make([]byte, 2)
		if _, err := io.ReadFull(conn, lengthBuffer); err != nil {
			return nil, err
		}
		responseLength := int(binary.BigEndian.Uint16(lengthBuffer))
		if responseLength <= 0 || responseLength > 65535 {
			return nil, errors.New("invalid dns-over-tls response length")
		}
		response := make([]byte, responseLength)
		if _, err := io.ReadFull(conn, response); err != nil {
			return nil, err
		}
		return response, nil
	}
	return resolveDNSViaQueryFn(domain, queryFn)
}

func resolveDNSOverHTTPS(
	ctx context.Context,
	endpoint DNSResolverEndpoint,
	domain string,
	timeout time.Duration,
) ([]string, error) {
	pathValue := strings.TrimSpace(endpoint.Path)
	if pathValue == "" {
		pathValue = "/dns-query"
	}
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				ServerName:         endpoint.Address,
				InsecureSkipVerify: true,
			},
		},
	}
	queryFn := func(query []byte) ([]byte, error) {
		baseURL := url.URL{
			Scheme: "https",
			Host:   net.JoinHostPort(endpoint.Address, strconv.Itoa(endpoint.Port)),
			Path:   pathValue,
		}
		queryValues := baseURL.Query()
		queryValues.Set("dns", base64.RawURLEncoding.EncodeToString(query))
		baseURL.RawQuery = queryValues.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept", "application/dns-message")
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
			return nil, fmt.Errorf(
				"dns-over-https status=%d body=%s",
				response.StatusCode,
				strings.TrimSpace(string(body)),
			)
		}
		payload, err := io.ReadAll(io.LimitReader(response.Body, 65535))
		if err != nil {
			return nil, err
		}
		return payload, nil
	}
	return resolveDNSViaQueryFn(domain, queryFn)
}

func resolveDNSViaQueryFn(
	domain string,
	queryFn func(query []byte) ([]byte, error),
) ([]string, error) {
	if queryFn == nil {
		return nil, errors.New("dns query function is required")
	}
	aggregated := make([]string, 0, 4)
	for _, queryType := range []dnsmessage.Type{
		dnsmessage.TypeA,
		dnsmessage.TypeAAAA,
	} {
		queryWire, err := buildDNSQueryWire(domain, queryType)
		if err != nil {
			return nil, err
		}
		responseWire, err := queryFn(queryWire)
		if err != nil {
			return nil, err
		}
		resolvedIPs, err := extractResolvedIPsFromDNSResponse(responseWire)
		if err != nil {
			return nil, err
		}
		aggregated = append(aggregated, resolvedIPs...)
	}
	aggregated = uniqueNonEmptyStrings(aggregated)
	if len(aggregated) == 0 {
		return nil, errors.New("dns response contains no A/AAAA records")
	}
	return aggregated, nil
}

func buildDNSQueryWire(domain string, queryType dnsmessage.Type) ([]byte, error) {
	nameValue := strings.TrimSpace(domain)
	if nameValue == "" {
		return nil, errors.New("domain is required")
	}
	if !strings.HasSuffix(nameValue, ".") {
		nameValue += "."
	}
	name, err := dnsmessage.NewName(nameValue)
	if err != nil {
		return nil, fmt.Errorf("invalid domain for dns query: %w", err)
	}
	message := dnsmessage.Message{
		Header: dnsmessage.Header{
			ID:                 uint16(time.Now().UnixNano()),
			RecursionDesired:   true,
			Response:           false,
			Authoritative:      false,
			Truncated:          false,
			RecursionAvailable: false,
		},
		Questions: []dnsmessage.Question{
			{
				Name:  name,
				Type:  queryType,
				Class: dnsmessage.ClassINET,
			},
		},
	}
	wire, err := message.Pack()
	if err != nil {
		return nil, fmt.Errorf("pack dns query failed: %w", err)
	}
	return wire, nil
}

func extractResolvedIPsFromDNSResponse(response []byte) ([]string, error) {
	if len(response) == 0 {
		return nil, errors.New("empty dns response")
	}
	var message dnsmessage.Message
	if err := message.Unpack(response); err != nil {
		return nil, fmt.Errorf("decode dns response failed: %w", err)
	}
	if message.Header.RCode != dnsmessage.RCodeSuccess {
		return nil, fmt.Errorf("dns response rcode=%s", message.Header.RCode)
	}
	ips := make([]string, 0, len(message.Answers))
	for _, answer := range message.Answers {
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			ip := net.IP(body.A[:]).String()
			if strings.TrimSpace(ip) != "" {
				ips = append(ips, ip)
			}
		case *dnsmessage.AAAAResource:
			ip := net.IP(body.AAAA[:]).String()
			if strings.TrimSpace(ip) != "" {
				ips = append(ips, ip)
			}
		}
	}
	return uniqueNonEmptyStrings(ips), nil
}

func (r *proxyRuntime) stopLocked() error {
	var stopErr error
	cancel := r.cancel
	instance := r.box
	r.cancel = nil
	r.box = nil
	r.clashAPIController = ""
	if cancel != nil {
		cancel()
	}
	if instance != nil {
		stopErr = instance.Close()
	}
	if errors.Is(stopErr, os.ErrClosed) {
		return nil
	}
	return stopErr
}

func buildRuntimeConfig(snapshot StateSnapshot) (string, error) {
	return buildRuntimeConfigWithController(snapshot, resolveDefaultClashAPIController())
}

func buildRuntimeConfigWithController(snapshot StateSnapshot, externalController string) (string, error) {
	return buildRuntimeConfigWithControllerOptions(snapshot, externalController, false, false, 0)
}

func buildRuntimeConfigWithControllerOptions(
	snapshot StateSnapshot,
	externalController string,
	disableCacheFile bool,
	disableExperimental bool,
	internalProxyPort int,
) (string, error) {
	mode := normalizeProxyMode(snapshot.ProxyMode)
	if !isValidProxyMode(mode) {
		mode = inferProxyMode(snapshot.TunEnabled, snapshot.SystemProxyEnabled)
	}
	muxConfig := normalizeProxyMuxConfig(snapshot.Mux)
	nodeOutbounds := []any{}
	nodeTags := []string{}
	nodeTagsByID := map[string]string{}
	nodeByID := map[string]Node{}
	seenNodeIDs := map[string]struct{}{}
	selectedTag := ""
	appendNodeOutbound := func(node Node) {
		if _, exists := seenNodeIDs[node.ID]; exists {
			return
		}
		outbound, outboundErr := buildNodeOutbound(node, muxConfig)
		if outboundErr != nil {
			return
		}
		tag := runtimeNodeTag(node.ID)
		outbound["tag"] = tag
		nodeOutbounds = append(nodeOutbounds, outbound)
		nodeTags = append(nodeTags, tag)
		nodeTagsByID[node.ID] = tag
		nodeByID[node.ID] = node
		seenNodeIDs[node.ID] = struct{}{}
	}

	if mode != ProxyModeOff {
		selectedNode, err := resolveRuntimeNode(snapshot)
		if err != nil {
			return "", err
		}
		selectedTag = runtimeNodeTag(selectedNode.ID)
		appendNodeOutbound(selectedNode)
	} else if selectedNode, err := resolveRuntimeNode(snapshot); err == nil {
		// Prefer active node first in selector order when running probe-only minimal runtime.
		selectedTag = runtimeNodeTag(selectedNode.ID)
		appendNodeOutbound(selectedNode)
	}

	for _, group := range snapshot.Groups {
		for _, node := range group.Nodes {
			appendNodeOutbound(node)
		}
	}
	if strings.TrimSpace(selectedTag) != "" {
		selectedTagExists := false
		for _, tag := range nodeTags {
			if tag == selectedTag {
				selectedTagExists = true
				break
			}
		}
		if !selectedTagExists {
			selectedTag = ""
		}
	}
	if strings.TrimSpace(selectedTag) == "" {
		if len(nodeTags) > 0 {
			selectedTag = nodeTags[0]
		} else {
			selectedTag = "direct"
		}
	}
	dnsConfig := buildDNSConfig(snapshot)
	routeRules := make([]any, 0, len(snapshot.RuleConfigV2.Rules)+4)
	if internalProxyPort > 0 {
		routeRules = append(routeRules, map[string]any{
			"inbound":  []string{"internal-helper-in"},
			"action":   "route",
			"outbound": proxySelectorTag,
		})
	}
	if runtimeSniffEnabled(snapshot) {
		routeRules = append(routeRules, map[string]any{
			"action":  "sniff",
			"timeout": runtimeSniffTimeout(snapshot),
		})
	}
	routeRules = append(routeRules,
		map[string]any{
			"protocol": "dns",
			"action":   "hijack-dns",
		},
	)
	routeRules = append(routeRules, buildTransportGuardRouteRules(snapshot)...)
	routeRules = append(routeRules,
		map[string]any{
			"ip_is_private": true,
			"action":        "route",
			"outbound":      "direct",
		},
	)
	userRouteRules, rulePoolOutbounds, finalOutbound, generatedRuleSetDefs := buildTrafficRuleRuntime(
		snapshot,
		nodeTagsByID,
		nodeByID,
	)
	routeRules = append(routeRules, userRouteRules...)
	if strings.TrimSpace(finalOutbound) == "" {
		finalOutbound = proxySelectorTag
	}
	routeConfig := map[string]any{
		"rules":                   routeRules,
		"final":                   finalOutbound,
		"default_domain_resolver": bootstrapDNSServerTag,
	}
	if supportsRouteAutoDetectInterface(runtime.GOOS) {
		routeConfig["auto_detect_interface"] = true
	}
	if ruleSetDefs := mergeRouteRuleSetDefinitions(
		buildRouteRuleSetDefinitions(snapshot.RuleConfigV2),
		generatedRuleSetDefs,
	); len(ruleSetDefs) > 0 {
		routeConfig["rule_set"] = ruleSetDefs
	}

	inbounds := []any{}
	if internalProxyPort > 0 {
		inbounds = append(inbounds, map[string]any{
			"type":        "mixed",
			"tag":         "internal-helper-in",
			"listen":      defaultLocalMixedListenAddress,
			"listen_port": internalProxyPort,
		})
	}
	switch mode {
	case ProxyModeTun:
		inbounds = append(inbounds, buildTunInboundConfig(runtime.GOOS, snapshot), map[string]any{
			"type":        "mixed",
			"tag":         "mixed-in",
			"listen":      runtimeListenAddress(snapshot),
			"listen_port": runtimeListenPort(snapshot),
		})
	case ProxyModeSystem:
		inbounds = append(inbounds, map[string]any{
			"type":        "mixed",
			"tag":         "mixed-in",
			"listen":      runtimeListenAddress(snapshot),
			"listen_port": runtimeListenPort(snapshot),
		})
	default:
		// ProxyModeOff keeps runtime alive for probing only, without exposing local proxy inbounds.
	}

	runtimeOutbounds := append([]any{}, nodeOutbounds...)
	selectorOutbounds := []string{"direct"}
	if len(nodeTags) > 0 {
		runtimeOutbounds = append(runtimeOutbounds, map[string]any{
			"type":                        "urltest",
			"tag":                         proxyURLTestTag,
			"outbounds":                   append([]string{}, nodeTags...),
			"url":                         proxyURLTestProbeURL,
			"interval":                    proxyURLTestInterval,
			"tolerance":                   proxyURLTestToleranceMS,
			"idle_timeout":                proxyURLTestIdleTimeout,
			"interrupt_exist_connections": true,
		})
		selectorOutbounds = append([]string{proxyURLTestTag}, nodeTags...)
	}
	runtimeOutbounds = append(runtimeOutbounds, rulePoolOutbounds...)
	runtimeOutbounds = append(
		runtimeOutbounds,
		map[string]any{
			"type": "direct",
			"tag":  "direct",
		},
		map[string]any{
			"type": "block",
			"tag":  "block",
		},
	)

	config := map[string]any{
		"log": map[string]any{
			"level":     toSingBoxLogLevel(snapshot.ProxyLogLevel),
			"timestamp": true,
		},
		"inbounds": inbounds,
		"outbounds": append([]any{
			map[string]any{
				"type":                        "selector",
				"tag":                         proxySelectorTag,
				"outbounds":                   selectorOutbounds,
				"default":                     selectedTag,
				"interrupt_exist_connections": true,
			},
		}, runtimeOutbounds...),
		"dns":   dnsConfig,
		"route": routeConfig,
	}
	if !disableExperimental {
		if experimentalConfig := buildExperimentalConfig(snapshot, externalController, disableCacheFile); experimentalConfig != nil {
			config["experimental"] = experimentalConfig
		}
	}

	raw, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("marshal runtime config failed: %w", err)
	}
	return string(raw), nil
}

func buildTunInboundConfig(goos string, snapshot StateSnapshot) map[string]any {
	stack := normalizeProxyTunStack(snapshot.TunStack)
	if !isValidProxyTunStack(stack) {
		stack = ProxyTunStackSystem
	}
	inbound := map[string]any{
		"type":           "tun",
		"tag":            "tun-in",
		"interface_name": defaultTunInterfaceName,
		"address": []string{
			"172.19.0.1/30",
			"fdfe:dcba:9876::1/126",
		},
		"auto_route":   true,
		"strict_route": snapshot.StrictRoute,
		"mtu":          normalizeProxyTunMTU(snapshot.TunMTU),
		"stack":        string(stack),
	}
	if strings.EqualFold(strings.TrimSpace(goos), "linux") {
		// Linux 平台下官方推荐启用 auto_redirect 以提升透明代理性能与兼容性。
		inbound["auto_redirect"] = true
	}
	return inbound
}

func supportsRouteAutoDetectInterface(goos string) bool {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "linux", "windows", "darwin":
		return true
	default:
		return false
	}
}

func buildTransportGuardRouteRules(snapshot StateSnapshot) []any {
	rules := make([]any, 0, 2)
	if snapshot.BlockUDP {
		rules = append(rules, map[string]any{
			"network": "udp",
			"action":  "reject",
		})
		return rules
	}
	if !snapshot.BlockQUIC {
		return rules
	}
	rules = append(
		rules,
		map[string]any{
			"protocol": "quic",
			"action":   "reject",
		},
		map[string]any{
			"network": "udp",
			"port":    443,
			"action":  "reject",
		},
	)
	return rules
}

func buildTrafficRuleRuntime(
	snapshot StateSnapshot,
	nodeTagsByID map[string]string,
	nodeByID map[string]Node,
) ([]any, []any, string, []any) {
	config := snapshot.RuleConfigV2
	policyOutboundTag, policyOutbounds := buildPolicyGroupRuntimeOutbounds(
		config,
		snapshot,
		nodeTagsByID,
		nodeByID,
	)
	defaultMatchPolicy := "proxy"
	defaultMissPolicy := "direct"
	if resolveActiveRuleGroupOnMissMode(config) == RuleMissModeProxy {
		defaultMissPolicy = "proxy"
	}
	matchOutbound := resolvePolicyOutboundTag(defaultMatchPolicy, policyOutboundTag)
	if strings.TrimSpace(matchOutbound) == "" {
		matchOutbound = proxySelectorTag
	}
	finalOutbound := resolvePolicyOutboundTag(defaultMissPolicy, policyOutboundTag)
	if strings.TrimSpace(finalOutbound) == "" {
		finalOutbound = "direct"
	}

	routeRules := make([]any, 0, len(config.Rules))
	generatedRuleSets := map[string]map[string]any{}
	for _, item := range config.Rules {
		if !item.Enabled {
			continue
		}
		actionType := normalizeRuleActionType(item.Action.Type)
		outboundTag := matchOutbound
		switch actionType {
		case RuleActionTypeReject:
			outboundTag = "block"
		case RuleActionTypeRoute:
			policyID := strings.TrimSpace(item.Action.TargetPolicy)
			if policyID == "" {
				policyID = defaultMatchPolicy
			}
			if resolved := resolvePolicyOutboundTag(policyID, policyOutboundTag); strings.TrimSpace(resolved) != "" {
				outboundTag = resolved
			}
		default:
			// Keep fallback `outboundTag = matchOutbound`.
		}
		if compiledRule := compileRuleMatchV2(item.Match, outboundTag, generatedRuleSets); compiledRule != nil {
			routeRules = append(routeRules, compiledRule)
		}
	}
	return routeRules, policyOutbounds, finalOutbound, convertRuleSetDefinitionMapToList(generatedRuleSets)
}

func buildRouteRuleSetDefinitions(config RuleConfigV2) []any {
	if len(config.Providers.RuleSets) == 0 {
		return nil
	}
	definitions := make([]any, 0, len(config.Providers.RuleSets))
	seen := map[string]struct{}{}
	for _, provider := range config.Providers.RuleSets {
		tag := strings.TrimSpace(provider.ID)
		if tag == "" {
			continue
		}
		if _, ok := seen[strings.ToLower(tag)]; ok {
			continue
		}
		seen[strings.ToLower(tag)] = struct{}{}

		format := strings.TrimSpace(provider.Format)
		if format == "" {
			format = "source"
		}
		entry := map[string]any{
			"tag":    tag,
			"format": format,
		}
		if behavior := strings.TrimSpace(provider.Behavior); behavior != "" {
			entry["behavior"] = behavior
		}
		sourceType := normalizeRuleProviderSourceType(provider.Source.Type)
		switch sourceType {
		case RuleProviderSourceTypeLocal:
			path := strings.TrimSpace(provider.Source.Path)
			if path == "" {
				continue
			}
			entry["type"] = "local"
			entry["path"] = path
		default:
			urlValue := strings.TrimSpace(provider.Source.URL)
			if urlValue == "" {
				continue
			}
			entry["type"] = "remote"
			entry["url"] = urlValue
			entry["download_detour"] = "direct"
			if provider.UpdateIntervalSec > 0 {
				entry["update_interval"] = fmt.Sprintf("%ds", provider.UpdateIntervalSec)
			} else {
				entry["update_interval"] = defaultRuleSetUpdateInterval
			}
		}
		definitions = append(definitions, entry)
	}
	return definitions
}

func mergeRouteRuleSetDefinitions(base []any, extra []any) []any {
	if len(base) == 0 {
		return append([]any{}, extra...)
	}
	if len(extra) == 0 {
		return append([]any{}, base...)
	}
	merged := append([]any{}, base...)
	seen := map[string]struct{}{}
	for _, item := range base {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tag := strings.ToLower(strings.TrimSpace(anyToString(entry["tag"])))
		if tag == "" {
			continue
		}
		seen[tag] = struct{}{}
	}
	for _, item := range extra {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tag := strings.ToLower(strings.TrimSpace(anyToString(entry["tag"])))
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		merged = append(merged, item)
	}
	return merged
}

func convertRuleSetDefinitionMapToList(definitions map[string]map[string]any) []any {
	if len(definitions) == 0 {
		return nil
	}
	tags := make([]string, 0, len(definitions))
	for tag := range definitions {
		tags = append(tags, tag)
	}
	sort.Strings(tags)
	result := make([]any, 0, len(tags))
	for _, tag := range tags {
		result = append(result, definitions[tag])
	}
	return result
}

func normalizeIPCIDRPatterns(patterns []string) []string {
	result := make([]string, 0, len(patterns))
	seen := map[string]struct{}{}
	for _, raw := range patterns {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if ip := net.ParseIP(value); ip != nil {
			if ip.To4() != nil {
				value = value + "/32"
			} else {
				value = value + "/128"
			}
		} else {
			_, parsedCIDR, err := net.ParseCIDR(value)
			if err != nil {
				continue
			}
			value = parsedCIDR.String()
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func buildPolicyGroupRuntimeOutbounds(
	config RuleConfigV2,
	snapshot StateSnapshot,
	nodeTagsByID map[string]string,
	nodeByID map[string]Node,
) (map[string]string, []any) {
	result := map[string]string{
		"direct": "direct",
		"proxy":  proxySelectorTag,
		"reject": "block",
	}
	activeNodes := resolveActiveGroupNodes(snapshot)
	extraOutbounds := make([]any, 0, len(config.PolicyGroups))
	for index, group := range config.PolicyGroups {
		switch group.Type {
		case RulePolicyGroupTypeBuiltin:
			switch normalizeRulePolicyBuiltin(group.Builtin) {
			case RulePolicyBuiltinDirect:
				result[group.ID] = "direct"
			case RulePolicyBuiltinReject:
				result[group.ID] = "block"
			default:
				result[group.ID] = proxySelectorTag
			}
		case RulePolicyGroupTypeNodePool:
			if group.NodePool == nil {
				result[group.ID] = proxySelectorTag
				continue
			}
			decision := resolveRulePoolDecision(group.NodePool, activeNodes, nodeByID)
			nodeTags := make([]string, 0, len(decision.candidateNodeIDs))
			seenTag := map[string]struct{}{}
			for _, nodeID := range decision.candidateNodeIDs {
				tag, ok := nodeTagsByID[nodeID]
				if !ok {
					continue
				}
				if _, exists := seenTag[tag]; exists {
					continue
				}
				seenTag[tag] = struct{}{}
				nodeTags = append(nodeTags, tag)
			}
			fallbackTag := decision.fallbackOutboundTag
			if strings.TrimSpace(fallbackTag) == "" {
				fallbackTag = "block"
			}
			defaultTag := fallbackTag
			if strings.TrimSpace(decision.selectedNodeID) != "" {
				if selectedTag, exists := nodeTagsByID[decision.selectedNodeID]; exists {
					defaultTag = selectedTag
				}
			}
			selectorOutbounds := append([]string{}, nodeTags...)
			if _, exists := seenTag[fallbackTag]; !exists {
				selectorOutbounds = append(selectorOutbounds, fallbackTag)
			}
			if len(selectorOutbounds) == 0 {
				selectorOutbounds = append(selectorOutbounds, fallbackTag)
			}
			selectorTag := buildPolicyGroupSelectorTag(group.ID, index)
			result[group.ID] = selectorTag
			extraOutbounds = append(extraOutbounds, map[string]any{
				"type":                        "selector",
				"tag":                         selectorTag,
				"outbounds":                   selectorOutbounds,
				"default":                     defaultTag,
				"interrupt_exist_connections": true,
			})
		}
	}
	return result, extraOutbounds
}

func resolvePolicyOutboundTag(policyID string, mapping map[string]string) string {
	policyID = strings.TrimSpace(policyID)
	if policyID == "" {
		return ""
	}
	if outboundTag, ok := mapping[policyID]; ok {
		return outboundTag
	}
	switch strings.ToLower(policyID) {
	case "direct":
		return "direct"
	case "reject", "block":
		return "block"
	default:
		return proxySelectorTag
	}
}

func compileRuleMatchV2(
	match RuleMatch,
	outboundTag string,
	generatedRuleSets map[string]map[string]any,
) map[string]any {
	if strings.TrimSpace(outboundTag) == "" {
		return nil
	}
	rule := map[string]any{
		"action":   "route",
		"outbound": outboundTag,
	}
	if len(match.Domain.Exact) > 0 {
		rule["domain"] = uniqueNonEmptyStrings(match.Domain.Exact)
	}
	if len(match.Domain.Suffix) > 0 {
		rule["domain_suffix"] = uniqueNonEmptyStrings(match.Domain.Suffix)
	}
	if len(match.Domain.Keyword) > 0 {
		rule["domain_keyword"] = uniqueNonEmptyStrings(match.Domain.Keyword)
	}
	if len(match.Domain.Regex) > 0 {
		rule["domain_regex"] = uniqueNonEmptyStrings(match.Domain.Regex)
	}
	ipCIDR := normalizeIPCIDRPatterns(match.IPCIDR)
	if len(ipCIDR) > 0 {
		rule["ip_cidr"] = ipCIDR
	}
	ruleSetRefs := uniqueNonEmptyStrings(match.RuleSetRefs)
	geoRuleSetRefs, matchPrivateIP := buildGeoRuleSetRefs(match, generatedRuleSets)
	if matchPrivateIP {
		rule["ip_is_private"] = true
	}
	if len(geoRuleSetRefs) > 0 {
		ruleSetRefs = append(ruleSetRefs, geoRuleSetRefs...)
	}
	if len(ruleSetRefs) > 0 {
		rule["rule_set"] = uniqueNonEmptyStrings(ruleSetRefs)
	}

	// iOS 环境下进程匹配无权限，编译时跳过进程条件。
	if runtime.GOOS != "ios" {
		processRegex := make([]string, 0, len(match.Process.NameContains)+len(match.Process.PathContains)+len(match.Process.PathRegex))
		seen := map[string]struct{}{}
		for _, name := range match.Process.NameContains {
			pattern := "(?i).*" + regexp.QuoteMeta(strings.TrimSpace(name)) + ".*"
			if pattern == "(?i).*.*" {
				continue
			}
			if _, ok := seen[pattern]; ok {
				continue
			}
			seen[pattern] = struct{}{}
			processRegex = append(processRegex, pattern)
		}
		for _, pathValue := range match.Process.PathContains {
			pattern := "(?i).*" + regexp.QuoteMeta(strings.TrimSpace(pathValue)) + ".*"
			if pattern == "(?i).*.*" {
				continue
			}
			if _, ok := seen[pattern]; ok {
				continue
			}
			seen[pattern] = struct{}{}
			processRegex = append(processRegex, pattern)
		}
		for _, regexValue := range match.Process.PathRegex {
			pattern := strings.TrimSpace(regexValue)
			if pattern == "" {
				continue
			}
			if _, ok := seen[pattern]; ok {
				continue
			}
			seen[pattern] = struct{}{}
			processRegex = append(processRegex, pattern)
		}
		if len(processRegex) > 0 {
			rule["process_path_regex"] = processRegex
		}
	}

	if len(rule) <= 2 {
		return nil
	}
	return rule
}

func buildGeoRuleSetRefs(
	match RuleMatch,
	generatedRuleSets map[string]map[string]any,
) ([]string, bool) {
	ruleSetRefs := make([]string, 0, len(match.GeoIP)+len(match.GeoSite))
	matchPrivateIP := false
	appendGeoRefs := func(values []string, kind string) {
		for _, rawValue := range values {
			value := normalizeGeoRuleSetValue(rawValue)
			if value == "" {
				continue
			}
			if kind == "geoip" && value == "private" {
				matchPrivateIP = true
				continue
			}
			tag := fmt.Sprintf("wateray-%s-%s", kind, value)
			urlValue := ""
			switch kind {
			case "geoip":
				urlValue = fmt.Sprintf(geoIPRuleSetURLTemplate, value)
			case "geosite":
				urlValue = fmt.Sprintf(geoSiteRuleSetURLTemplate, value)
			default:
				continue
			}
			if _, exists := generatedRuleSets[tag]; !exists {
				if localPath, _, ok := statBuiltInRuleSetPath(kind, value); ok {
					generatedRuleSets[tag] = map[string]any{
						"tag":    tag,
						"type":   "local",
						"format": "binary",
						"path":   localPath,
					}
				} else {
					generatedRuleSets[tag] = map[string]any{
						"tag":             tag,
						"type":            "remote",
						"format":          "binary",
						"url":             urlValue,
						"download_detour": "direct",
						"update_interval": defaultRuleSetUpdateInterval,
					}
				}
			}
			ruleSetRefs = append(ruleSetRefs, tag)
		}
	}
	appendGeoRefs(match.GeoIP, "geoip")
	appendGeoRefs(match.GeoSite, "geosite")
	return uniqueNonEmptyStrings(ruleSetRefs), matchPrivateIP
}

func normalizeGeoRuleSetValue(rawValue string) string {
	value := strings.ToLower(strings.TrimSpace(rawValue))
	if value == "" {
		return ""
	}
	builder := strings.Builder{}
	builder.Grow(len(value))
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' || char == '!' || char == '@' {
			builder.WriteRune(char)
			continue
		}
		builder.WriteRune('-')
	}
	normalized := strings.Trim(builder.String(), "-")
	return strings.ReplaceAll(normalized, "_", "-")
}

func normalizeRuleNodeRefType(rawType string) string {
	normalized := strings.ToLower(strings.TrimSpace(rawType))
	switch normalized {
	case "序号", "index", "idx", "number", "no":
		return "index"
	case "国家", "country", "region":
		return "country"
	case "名称", "name", "node_name":
		return "name"
	case "id", "node", "nodeid", "节点", "节点id":
		return "id"
	default:
		if normalized == "" {
			return "id"
		}
		return normalized
	}
}

func parseRuleNodeIndex(raw string) (int, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	index, err := strconv.Atoi(value)
	if err != nil || index <= 0 {
		return 0, false
	}
	return index, true
}

func resolveActiveGroupNodes(snapshot StateSnapshot) []Node {
	if len(snapshot.Groups) == 0 {
		return nil
	}
	group := snapshot.Groups[0]
	for _, item := range snapshot.Groups {
		if item.ID == snapshot.ActiveGroupID {
			group = item
			break
		}
	}
	return append([]Node{}, group.Nodes...)
}

func buildDNSConfig(snapshot StateSnapshot) map[string]any {
	dnsConfig, err := normalizeDNSConfig(snapshot.DNS)
	if err != nil {
		dnsConfig = defaultDNSConfig()
	}
	mode := normalizeProxyMode(snapshot.ProxyMode)
	cacheCapacity := dnsConfig.Cache.Capacity
	if cacheCapacity < 1024 {
		cacheCapacity = defaultDNSCacheCapacity
	}
	if dnsConfig.FakeIP.Enabled {
		cacheCapacity = fakeIPDNSCacheCapacity
		if mode == ProxyModeTun {
			cacheCapacity = tunFakeIPDNSCacheCapacity
		}
	}

	servers := []any{
		map[string]any{
			"type": "local",
			"tag":  localDNSServerTag,
		},
		buildStructuredDNSServer("remote", dnsConfig.Remote, bootstrapDNSServerTag),
		map[string]any{
			"type": "local",
			"tag":  "local",
		},
		buildStructuredDNSServer("direct", dnsConfig.Direct, bootstrapDNSServerTag),
		buildStructuredDNSServer(bootstrapDNSServerTag, dnsConfig.Bootstrap, ""),
	}
	rules := make([]any, 0, len(dnsConfig.Rules)+1)
	for _, rule := range dnsConfig.Rules {
		if compiled := buildStructuredDNSRule(rule); compiled != nil {
			rules = append(rules, compiled)
		}
	}
	if hostsEntries := buildDNSHostsEntries(dnsConfig.Hosts); len(hostsEntries) > 0 {
		servers = append(
			servers,
			map[string]any{
				"type":       "hosts",
				"tag":        dnsHostsOverrideServerTag,
				"predefined": hostsEntries,
			},
		)
		if domains := sortDNSHostsDomains(hostsEntries); len(domains) > 0 {
			rules = append(
				[]any{
					map[string]any{
						"domain": domains,
						"action": "route",
						"server": dnsHostsOverrideServerTag,
					},
				},
				rules...,
			)
		}
	}
	dns := map[string]any{
		"servers":           servers,
		"rules":             rules,
		"final":             resolveDNSRuleServerTag(dnsConfig.Policy.Final),
		"strategy":          string(dnsConfig.Policy.Strategy),
		"independent_cache": dnsConfig.Cache.IndependentCache,
		"cache_capacity":    cacheCapacity,
		"reverse_mapping":   dnsConfig.FakeIP.Enabled,
	}
	if clientSubnet := strings.TrimSpace(dnsConfig.Policy.ClientSubnet); clientSubnet != "" {
		dns["client_subnet"] = clientSubnet
	}
	if dnsConfig.FakeIP.Enabled {
		servers = append(
			servers,
			map[string]any{
				"type":        "fakeip",
				"tag":         "fakeip",
				"inet4_range": firstNonEmpty(dnsConfig.FakeIP.IPv4Range, defaultDNSFakeIPV4Range),
				"inet6_range": firstNonEmpty(dnsConfig.FakeIP.IPv6Range, defaultDNSFakeIPV6Range),
			},
		)
		rules = append(
			rules,
			map[string]any{
				"query_type": []string{"A", "AAAA"},
				"action":     "route",
				"server":     "fakeip",
			},
		)
		dns["servers"] = servers
		dns["rules"] = rules
	}
	return dns
}

func buildDNSHostsEntries(config DNSHostsPolicy) map[string][]string {
	entries := map[string][]string{}
	if config.UseSystemHosts {
		if systemEntries, err := loadSystemDNSHostsEntries(); err == nil && len(systemEntries) > 0 {
			entries = mergeDNSHostsEntries(entries, systemEntries)
		}
	}
	if config.UseCustomHosts {
		customHosts := normalizeDNSHostsText(config.CustomHosts)
		if customHosts != "" {
			if customEntries, err := parseDNSHostsEntries(customHosts); err == nil && len(customEntries) > 0 {
				// Custom records override system entries for same domain.
				entries = mergeDNSHostsEntries(entries, customEntries)
			}
		}
	}
	return entries
}

func resolveDNSRuleServerTag(server DNSRuleServer) string {
	switch normalizeDNSRuleServer(server) {
	case DNSRuleServerDirect:
		return "direct"
	case DNSRuleServerBootstrap:
		return bootstrapDNSServerTag
	case DNSRuleServerFakeIP:
		return "fakeip"
	default:
		return "remote"
	}
}

func buildStructuredDNSServer(tag string, endpoint DNSResolverEndpoint, resolverTag string) map[string]any {
	entry := map[string]any{
		"type": string(endpoint.Type),
		"tag":  tag,
	}
	switch endpoint.Type {
	case DNSResolverTypeLocal, DNSResolverTypeHosts, DNSResolverTypeResolved:
		return entry
	case DNSResolverTypeDHCP:
		if iface := strings.TrimSpace(endpoint.Interface); iface != "" && !strings.EqualFold(iface, "auto") {
			entry["interface"] = iface
		}
		return entry
	default:
		entry["server"] = endpoint.Address
		if endpoint.Port > 0 {
			entry["server_port"] = endpoint.Port
		}
		if path := strings.TrimSpace(endpoint.Path); path != "" && (endpoint.Type == DNSResolverTypeHTTPS || endpoint.Type == DNSResolverTypeH3) {
			entry["path"] = path
		}
		if normalizeDNSDetourMode(endpoint.Detour) == DNSDetourModeProxy {
			entry["detour"] = proxySelectorTag
		}
		if shouldUseBootstrapResolver(endpoint.Address) && strings.TrimSpace(resolverTag) != "" && tag != resolverTag {
			entry["domain_resolver"] = resolverTag
		}
		return entry
	}
}

func buildStructuredDNSRule(rule DNSRule) map[string]any {
	if !rule.Enabled {
		return nil
	}
	action := normalizeDNSRuleActionType(rule.Action)
	if action == "" {
		return nil
	}
	compiled := map[string]any{}
	if values := uniqueNonEmptyStrings(rule.Domain); len(values) > 0 {
		compiled["domain"] = values
	}
	if values := uniqueNonEmptyStrings(rule.DomainSuffix); len(values) > 0 {
		compiled["domain_suffix"] = values
	}
	if values := uniqueNonEmptyStrings(rule.DomainKeyword); len(values) > 0 {
		compiled["domain_keyword"] = values
	}
	if values := uniqueNonEmptyStrings(rule.DomainRegex); len(values) > 0 {
		compiled["domain_regex"] = values
	}
	if values := uniqueNonEmptyStrings(rule.QueryType); len(values) > 0 {
		compiled["query_type"] = values
	}
	if values := uniqueNonEmptyStrings(rule.Outbound); len(values) > 0 {
		compiled["outbound"] = values
	}
	if len(compiled) == 0 {
		return nil
	}
	if action == DNSRuleActionTypeReject {
		compiled["action"] = "reject"
		return compiled
	}
	compiled["action"] = "route"
	compiled["server"] = resolveDNSRuleServerTag(rule.Server)
	if rule.DisableCache {
		compiled["disable_cache"] = true
	}
	if subnet := strings.TrimSpace(rule.ClientSubnet); subnet != "" {
		compiled["client_subnet"] = subnet
	}
	return compiled
}

type dnsServerSpec struct {
	ServerType string
	Server     string
	ServerPort int
	Path       string
}

func buildModernDNSServer(tag string, raw string, detour string, resolverTag string) map[string]any {
	spec := parseDNSServerSpec(raw)
	entry := map[string]any{
		"type": spec.ServerType,
		"tag":  tag,
	}
	switch spec.ServerType {
	case "local", "hosts", "resolved":
		return entry
	case "dhcp":
		if iface := strings.TrimSpace(spec.Server); iface != "" && !strings.EqualFold(iface, "auto") {
			entry["interface"] = iface
		}
		return entry
	case "fakeip":
		entry["inet4_range"] = defaultDNSFakeIPV4Range
		entry["inet6_range"] = defaultDNSFakeIPV6Range
		return entry
	default:
		entry["server"] = spec.Server
		if spec.ServerPort > 0 {
			entry["server_port"] = spec.ServerPort
		}
		if spec.Path != "" && (spec.ServerType == "https" || spec.ServerType == "h3") {
			entry["path"] = spec.Path
		}
		if strings.TrimSpace(detour) != "" && !strings.EqualFold(strings.TrimSpace(detour), "direct") {
			entry["detour"] = detour
		}
		if shouldUseBootstrapResolver(spec.Server) && strings.TrimSpace(resolverTag) != "" && tag != resolverTag {
			entry["domain_resolver"] = resolverTag
		}
		return entry
	}
}

func parseDNSServerSpec(raw string) dnsServerSpec {
	value := strings.TrimSpace(raw)
	if value == "" {
		return dnsServerSpec{
			ServerType: "udp",
			Server:     "1.1.1.1",
			ServerPort: 53,
		}
	}
	lower := strings.ToLower(value)
	switch lower {
	case "local":
		return dnsServerSpec{ServerType: "local"}
	case "hosts":
		return dnsServerSpec{ServerType: "hosts"}
	case "resolved":
		return dnsServerSpec{ServerType: "resolved"}
	case "fakeip":
		return dnsServerSpec{ServerType: "fakeip"}
	}
	if strings.HasPrefix(lower, "dhcp://") {
		return dnsServerSpec{
			ServerType: "dhcp",
			Server:     strings.TrimPrefix(value, "dhcp://"),
		}
	}
	if strings.Contains(value, "://") {
		if parsed, err := url.Parse(value); err == nil {
			serverType := strings.ToLower(strings.TrimSpace(parsed.Scheme))
			switch serverType {
			case "http3":
				serverType = "h3"
			}
			switch serverType {
			case "udp", "tcp", "tls", "quic", "https", "h3", "dhcp":
			default:
				serverType = "udp"
			}
			if serverType == "dhcp" {
				iface := strings.TrimSpace(parsed.Host)
				if iface == "" {
					iface = strings.Trim(parsed.Opaque, "/")
				}
				return dnsServerSpec{
					ServerType: "dhcp",
					Server:     iface,
				}
			}
			server := strings.TrimSpace(parsed.Hostname())
			if server != "" {
				defaultPort := 53
				switch serverType {
				case "tls", "quic":
					defaultPort = 853
				case "https", "h3":
					defaultPort = 443
				}
				port := defaultPort
				if parsed.Port() != "" {
					if parsedPort, err := strconv.Atoi(parsed.Port()); err == nil && parsedPort > 0 {
						port = parsedPort
					}
				}
				path := strings.TrimSpace(parsed.Path)
				return dnsServerSpec{
					ServerType: firstNonEmpty(serverType, "udp"),
					Server:     server,
					ServerPort: port,
					Path:       path,
				}
			}
		}
	}

	server, port := splitServerPort(value, 53)
	return dnsServerSpec{
		ServerType: "udp",
		Server:     server,
		ServerPort: port,
	}
}

func splitServerPort(value string, defaultPort int) (string, int) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", defaultPort
	}
	if host, port, err := net.SplitHostPort(value); err == nil {
		if parsedPort, err := strconv.Atoi(port); err == nil && parsedPort > 0 {
			return host, parsedPort
		}
	}
	if strings.Count(value, ":") == 1 && !strings.Contains(value, "]") {
		parts := strings.SplitN(value, ":", 2)
		if len(parts) == 2 {
			if parsedPort, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil && parsedPort > 0 {
				return strings.TrimSpace(parts[0]), parsedPort
			}
		}
	}
	return value, defaultPort
}

func buildExperimentalConfig(snapshot StateSnapshot, externalController string, disableCacheFile bool) map[string]any {
	dnsConfig, err := normalizeDNSConfig(snapshot.DNS)
	if err != nil {
		dnsConfig = defaultDNSConfig()
	}
	controller := strings.TrimSpace(externalController)
	if controller == "" {
		controller = resolveDefaultClashAPIController()
	}
	experimental := map[string]any{
		"clash_api": map[string]any{
			"external_controller": controller,
			"default_mode":        "Rule",
		},
	}
	if dnsConfig.Cache.FileEnabled && !disableCacheFile {
		experimental["cache_file"] = map[string]any{
			"enabled":      true,
			"path":         resolveDNSCacheFilePath(),
			"store_rdrc":   dnsConfig.Cache.StoreRDRC,
			"store_fakeip": dnsConfig.FakeIP.Enabled,
			"rdrc_timeout": "7d",
		}
	}
	return experimental
}

func resolveBuiltInRuleSetPath(kind string, value string) (string, bool) {
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	normalizedValue := normalizeGeoRuleSetValue(value)
	if normalizedKind == "" || normalizedValue == "" {
		return "", false
	}
	switch normalizedKind {
	case "geoip", "geosite":
	default:
		return "", false
	}
	fileName := fmt.Sprintf("%s-%s.srs", normalizedKind, normalizedValue)
	return filepath.Join(resolveRuleSetStorageDir(), fileName), true
}

func resolveBundledRuleSetStorageDirCandidatesWithExecutablePath(executablePath string) []string {
	baseDirs := resolveBundledInstallDirCandidates(executablePath)
	relativeDirs := []string{
		filepath.Join("default-config", "rule-set"),
		"rule-set",
	}
	candidates := make([]string, 0, len(baseDirs)*len(relativeDirs))
	seen := map[string]struct{}{}
	for _, baseDir := range baseDirs {
		for _, relativeDir := range relativeDirs {
			candidate := filepath.Clean(filepath.Join(baseDir, relativeDir))
			key := strings.ToLower(candidate)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func resolveBundledRuleSetStorageDirCandidates() []string {
	return resolveBundledRuleSetStorageDirCandidatesWithExecutablePath("")
}

func resolveBundledBuiltInRuleSetPaths(kind string, value string) []string {
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	normalizedValue := normalizeGeoRuleSetValue(value)
	if normalizedKind == "" || normalizedValue == "" {
		return nil
	}
	switch normalizedKind {
	case "geoip", "geosite":
	default:
		return nil
	}
	fileName := fmt.Sprintf("%s-%s.srs", normalizedKind, normalizedValue)
	candidates := make([]string, 0, 4)
	seen := map[string]struct{}{}
	for _, bundledDir := range resolveBundledRuleSetStorageDirCandidates() {
		if strings.TrimSpace(bundledDir) == "" {
			continue
		}
		candidate := filepath.Join(bundledDir, fileName)
		key := strings.ToLower(candidate)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func builtInRuleSetPathCandidates(kind string, value string) []string {
	candidates := make([]string, 0, 4)
	if localPath, ok := resolveBuiltInRuleSetPath(kind, value); ok {
		candidates = append(candidates, localPath)
	}
	for _, bundledPath := range resolveBundledBuiltInRuleSetPaths(kind, value) {
		duplicate := false
		for _, candidate := range candidates {
			if strings.EqualFold(candidate, bundledPath) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		candidates = append(candidates, bundledPath)
	}
	return candidates
}

func copyBundledRuleSetToLocalIfNeeded(kind string, value string) (string, os.FileInfo, bool) {
	localPath, ok := resolveBuiltInRuleSetPath(kind, value)
	if !ok {
		return "", nil, false
	}
	if fileInfo, err := os.Stat(localPath); err == nil && !fileInfo.IsDir() && fileInfo.Size() > 0 {
		return localPath, fileInfo, true
	}
	for _, bundledPath := range resolveBundledBuiltInRuleSetPaths(kind, value) {
		fileInfo, statErr := os.Stat(bundledPath)
		if statErr != nil || fileInfo.IsDir() || fileInfo.Size() <= 0 {
			continue
		}
		content, readErr := os.ReadFile(bundledPath)
		if readErr == nil {
			if mkdirErr := os.MkdirAll(filepath.Dir(localPath), 0o755); mkdirErr == nil {
				_ = os.WriteFile(localPath, content, 0o644)
				if copiedInfo, copiedErr := os.Stat(localPath); copiedErr == nil && !copiedInfo.IsDir() && copiedInfo.Size() > 0 {
					return localPath, copiedInfo, true
				}
			}
		}
		return bundledPath, fileInfo, true
	}
	fileName := fmt.Sprintf("%s-%s.srs", strings.ToLower(strings.TrimSpace(kind)), normalizeGeoRuleSetValue(value))
	if copiedInfo, copied := copyEmbeddedBundledRuleSetFileToLocal(fileName, localPath); copied {
		return localPath, copiedInfo, true
	}
	return "", nil, false
}

func statBuiltInRuleSetPath(kind string, value string) (string, os.FileInfo, bool) {
	if localPath, fileInfo, ok := copyBundledRuleSetToLocalIfNeeded(kind, value); ok {
		return localPath, fileInfo, true
	}
	for _, candidate := range builtInRuleSetPathCandidates(kind, value) {
		fileInfo, statErr := os.Stat(candidate)
		if statErr != nil || fileInfo.IsDir() || fileInfo.Size() <= 0 {
			continue
		}
		return candidate, fileInfo, true
	}
	return "", nil, false
}

func runtimeNodeTag(nodeID string) string {
	trimmed := strings.TrimSpace(nodeID)
	if trimmed == "" {
		return "node-default"
	}
	return "node-" + trimmed
}

func parseRuntimeNodeIDFromTag(chainTag string) (string, bool) {
	trimmed := strings.TrimSpace(chainTag)
	if !strings.HasPrefix(trimmed, "node-") {
		return "", false
	}
	nodeID := strings.TrimSpace(strings.TrimPrefix(trimmed, "node-"))
	if nodeID == "" {
		return "", false
	}
	return nodeID, true
}

func toSingBoxLogLevel(level LogLevel) string {
	switch normalizeLogLevel(level) {
	case LogLevelTrace:
		return "trace"
	case LogLevelDebug:
		return "debug"
	case LogLevelInfo:
		return "info"
	case LogLevelWarn:
		return "warn"
	case LogLevelError:
		return "error"
	case LogLevelNone:
		// Closest behavior to "none" in sing-box runtime log levels.
		return "panic"
	default:
		return "error"
	}
}

func toClashAPILogLevel(level LogLevel) string {
	switch normalizeLogLevel(level) {
	case LogLevelTrace, LogLevelDebug:
		return "debug"
	case LogLevelInfo:
		return "info"
	case LogLevelWarn:
		return "warning"
	case LogLevelError:
		return "error"
	case LogLevelNone:
		return "silent"
	default:
		return "info"
	}
}

type proxyPlatformWriter struct {
	onLog func(level LogLevel, message string)
}

func (w *proxyPlatformWriter) DisableColors() bool {
	return true
}

func (w *proxyPlatformWriter) WriteMessage(level singboxlog.Level, message string) {
	if w == nil || w.onLog == nil {
		return
	}
	w.onLog(mapSingBoxLogLevel(level), message)
}

func mapSingBoxLogLevel(level singboxlog.Level) LogLevel {
	switch level {
	case singboxlog.LevelTrace:
		return LogLevelTrace
	case singboxlog.LevelDebug:
		return LogLevelDebug
	case singboxlog.LevelInfo:
		return LogLevelInfo
	case singboxlog.LevelWarn:
		return LogLevelWarn
	case singboxlog.LevelError, singboxlog.LevelFatal, singboxlog.LevelPanic:
		return LogLevelError
	default:
		return LogLevelInfo
	}
}

func runtimeListenPort(snapshot StateSnapshot) int {
	if snapshot.LocalProxyPort <= 0 || snapshot.LocalProxyPort > 65535 {
		return defaultLocalMixedListenPort
	}
	return snapshot.LocalProxyPort
}

func runtimeListenAddress(snapshot StateSnapshot) string {
	if snapshot.AllowExternal {
		return "0.0.0.0"
	}
	return defaultLocalMixedListenAddress
}

func runtimeSniffEnabled(snapshot StateSnapshot) bool {
	return snapshot.SniffEnabled
}

func runtimeSniffTimeout(snapshot StateSnapshot) string {
	timeoutMS := snapshot.SniffTimeoutMS
	if timeoutMS < 100 || timeoutMS > 10000 {
		timeoutMS = defaultSniffTimeoutMS
	}
	return fmt.Sprintf("%dms", timeoutMS)
}

func resolveRuntimeNode(snapshot StateSnapshot) (Node, error) {
	if len(snapshot.Groups) == 0 {
		return Node{}, errors.New("no node group available")
	}

	activeGroupIndex := -1
	for i, group := range snapshot.Groups {
		if group.ID == snapshot.ActiveGroupID {
			activeGroupIndex = i
			break
		}
	}
	if activeGroupIndex < 0 {
		activeGroupIndex = 0
	}

	activeGroup := snapshot.Groups[activeGroupIndex]
	if len(activeGroup.Nodes) == 0 {
		return Node{}, errors.New("active group has no node")
	}
	if strings.TrimSpace(snapshot.SelectedNodeID) == "" {
		return activeGroup.Nodes[0], nil
	}
	for _, node := range activeGroup.Nodes {
		if node.ID == snapshot.SelectedNodeID {
			return node, nil
		}
	}
	return activeGroup.Nodes[0], nil
}

func buildNodeOutbound(node Node, muxConfig ProxyMuxConfig) (map[string]any, error) {
	raw := parseNodeRawConfig(node.RawConfig)
	if singboxOutbound, ok := toAnyMap(raw["singboxOutbound"]); ok {
		cloned := cloneMap(singboxOutbound)
		if strings.TrimSpace(anyToString(cloned["type"])) == "" {
			return nil, errors.New("invalid sing-box outbound: missing type")
		}
		if strings.TrimSpace(anyToString(cloned["server"])) == "" {
			cloned["server"] = node.Address
		}
		if anyToInt(cloned["server_port"]) <= 0 && node.Port > 0 {
			cloned["server_port"] = node.Port
		}
		applyOutboundMultiplex(cloned, muxConfig)
		applyOutboundDomainResolver(cloned, anyToString(cloned["server"]))
		return cloned, nil
	}

	server := firstNonEmptyString(raw, "server", "address")
	if server == "" {
		server = strings.TrimSpace(node.Address)
	}
	serverPort := anyToInt(raw["server_port"])
	if serverPort <= 0 {
		serverPort = anyToInt(raw["port"])
	}
	if serverPort <= 0 {
		serverPort = node.Port
	}
	if server == "" || serverPort <= 0 {
		return nil, errors.New("node server/port is invalid")
	}

	protocol := strings.ToLower(strings.TrimSpace(string(node.Protocol)))
	switch protocol {
	case "vmess":
		uuid := firstNonEmptyString(raw, "uuid", "id", "username")
		if uuid == "" {
			return nil, errors.New("vmess node missing uuid")
		}
		outbound := map[string]any{
			"type":        "vmess",
			"server":      server,
			"server_port": serverPort,
			"uuid":        uuid,
			"security": firstNonEmpty(
				firstNonEmptyString(raw, "security", "scy"),
				"auto",
			),
		}
		if alterID := anyToInt(raw["alter_id"]); alterID > 0 {
			outbound["alter_id"] = alterID
		}
		if alterID := anyToInt(raw["aid"]); alterID > 0 {
			outbound["alter_id"] = alterID
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundMultiplex(outbound, muxConfig)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "vless":
		uuid := firstNonEmptyString(raw, "uuid", "username")
		if uuid == "" {
			return nil, errors.New("vless node missing uuid")
		}
		outbound := map[string]any{
			"type":        "vless",
			"server":      server,
			"server_port": serverPort,
			"uuid":        uuid,
		}
		if flow := firstNonEmptyString(raw, "flow"); flow != "" {
			outbound["flow"] = flow
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundMultiplex(outbound, muxConfig)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "trojan":
		password := firstNonEmptyString(raw, "password", "username")
		if password == "" {
			return nil, errors.New("trojan node missing password")
		}
		outbound := map[string]any{
			"type":        "trojan",
			"server":      server,
			"server_port": serverPort,
			"password":    password,
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundMultiplex(outbound, muxConfig)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "shadowsocks":
		method := firstNonEmptyString(raw, "method", "cipher", "security")
		if method == "" {
			legacyMethod := strings.TrimSpace(node.Transport)
			if looksLikeShadowsocksMethod(legacyMethod) {
				method = legacyMethod
			}
		}
		password := firstNonEmptyString(raw, "password", "user_password")
		if method == "" || password == "" {
			return nil, errors.New("shadowsocks node missing method/password")
		}
		outbound := map[string]any{
			"type":        "shadowsocks",
			"server":      server,
			"server_port": serverPort,
			"method":      method,
			"password":    password,
		}
		applyOutboundMultiplex(outbound, muxConfig)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "socks5":
		outbound := map[string]any{
			"type":        "socks",
			"server":      server,
			"server_port": serverPort,
			"version":     "5",
		}
		if username := firstNonEmptyString(raw, "username"); username != "" {
			outbound["username"] = username
		}
		if password := firstNonEmptyString(raw, "password"); password != "" {
			outbound["password"] = password
		}
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "http":
		outbound := map[string]any{
			"type":        "http",
			"server":      server,
			"server_port": serverPort,
		}
		if username := firstNonEmptyString(raw, "username"); username != "" {
			outbound["username"] = username
		}
		if password := firstNonEmptyString(raw, "password"); password != "" {
			outbound["password"] = password
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "hysteria2":
		password := firstNonEmptyString(raw, "password", "username")
		if password == "" {
			return nil, errors.New("hysteria2 node missing password")
		}
		outbound := map[string]any{
			"type":        "hysteria2",
			"server":      server,
			"server_port": serverPort,
			"password":    password,
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	case "tuic":
		uuid := firstNonEmptyString(raw, "uuid", "username")
		password := firstNonEmptyString(raw, "password")
		if uuid == "" || password == "" {
			return nil, errors.New("tuic node missing uuid/password")
		}
		outbound := map[string]any{
			"type":        "tuic",
			"server":      server,
			"server_port": serverPort,
			"uuid":        uuid,
			"password":    password,
		}
		applyTransportAndTLS(outbound, raw)
		applyOutboundDomainResolver(outbound, server)
		return outbound, nil
	default:
		return nil, fmt.Errorf("unsupported protocol for runtime: %s", protocol)
	}
}

func supportsOutboundMultiplex(outboundType string) bool {
	switch strings.ToLower(strings.TrimSpace(outboundType)) {
	case "vmess", "vless", "trojan", "shadowsocks":
		return true
	default:
		return false
	}
}

func hasEnabledUDPOverTCP(outbound map[string]any) bool {
	if outbound == nil {
		return false
	}
	raw, exists := outbound["udp_over_tcp"]
	if !exists {
		return false
	}
	if disabled, ok := raw.(bool); ok {
		return !disabled
	}
	return true
}

func buildMuxOutboundConfig(config ProxyMuxConfig) map[string]any {
	_ = config
	// Mux is explicitly forbidden in runtime outbounds.
	return nil
}

func applyOutboundMultiplex(outbound map[string]any, config ProxyMuxConfig) {
	if outbound == nil {
		return
	}
	_ = config
	// Explicitly strip any multiplex stanza from raw node config.
	delete(outbound, "multiplex")
}

func applyOutboundDomainResolver(outbound map[string]any, server string) {
	if strings.TrimSpace(anyToString(outbound["domain_resolver"])) != "" {
		return
	}
	if !shouldUseBootstrapResolver(server) {
		return
	}
	outbound["domain_resolver"] = bootstrapDNSServerTag
}

func shouldUseBootstrapResolver(server string) bool {
	value := strings.TrimSpace(server)
	if value == "" {
		return false
	}
	if ip := net.ParseIP(strings.Trim(value, "[]")); ip != nil {
		return false
	}
	return true
}

func applyTransportAndTLS(outbound map[string]any, raw map[string]any) {
	transport := strings.ToLower(firstNonEmptyString(raw, "transport", "network", "net"))
	headers := cloneMap(toFlatStringMap(raw["transport_headers"]))
	switch transport {
	case "ws", "websocket":
		ws := map[string]any{
			"type": "ws",
		}
		if path := firstNonEmptyString(raw, "path"); path != "" {
			ws["path"] = path
		}
		if host := firstNonEmptyString(raw, "host", "authority"); host != "" {
			headers["Host"] = host
		}
		if len(headers) > 0 {
			ws["headers"] = headers
		}
		if maxEarlyData := anyToInt(raw["ws_max_early_data"]); maxEarlyData > 0 {
			ws["max_early_data"] = maxEarlyData
		}
		if headerName := firstNonEmptyString(raw, "ws_early_data_header_name"); headerName != "" {
			ws["early_data_header_name"] = headerName
		}
		outbound["transport"] = ws
	case "grpc":
		grpc := map[string]any{
			"type": "grpc",
		}
		if serviceName := firstNonEmptyString(raw, "service_name", "serviceName"); serviceName != "" {
			grpc["service_name"] = serviceName
		}
		if idleTimeout := firstNonEmptyString(raw, "grpc_idle_timeout"); idleTimeout != "" {
			grpc["idle_timeout"] = idleTimeout
		}
		if pingTimeout := firstNonEmptyString(raw, "grpc_ping_timeout"); pingTimeout != "" {
			grpc["ping_timeout"] = pingTimeout
		}
		if permitWithoutStream, ok := anyToBool(raw["grpc_permit_without_stream"]); ok {
			grpc["permit_without_stream"] = permitWithoutStream
		}
		outbound["transport"] = grpc
	case "quic":
		outbound["transport"] = map[string]any{
			"type": "quic",
		}
	case "http", "h2":
		httpTransport := map[string]any{
			"type": "http",
		}
		if path := firstNonEmptyString(raw, "path"); path != "" {
			httpTransport["path"] = path
		}
		if host := firstNonEmptyString(raw, "host", "authority"); host != "" {
			httpTransport["host"] = []string{host}
		}
		if method := firstNonEmptyString(raw, "transport_method"); method != "" {
			httpTransport["method"] = method
		}
		if len(headers) > 0 {
			httpTransport["headers"] = headers
		}
		if idleTimeout := firstNonEmptyString(raw, "http_idle_timeout"); idleTimeout != "" {
			httpTransport["idle_timeout"] = idleTimeout
		}
		if pingTimeout := firstNonEmptyString(raw, "http_ping_timeout"); pingTimeout != "" {
			httpTransport["ping_timeout"] = pingTimeout
		}
		outbound["transport"] = httpTransport
	case "httpupgrade", "http-upgrade":
		upgrade := map[string]any{
			"type": "httpupgrade",
		}
		if path := firstNonEmptyString(raw, "path"); path != "" {
			upgrade["path"] = path
		}
		if host := firstNonEmptyString(raw, "host", "authority"); host != "" {
			upgrade["host"] = host
		}
		if len(headers) > 0 {
			upgrade["headers"] = headers
		}
		outbound["transport"] = upgrade
	}

	security := strings.ToLower(firstNonEmptyString(raw, "security"))
	tlsEnabled := false
	if rawValue, exists := raw["tls"]; exists {
		if value, ok := anyToBool(rawValue); ok {
			tlsEnabled = value
		}
	}
	if security == "tls" || security == "reality" {
		tlsEnabled = true
	}
	if !tlsEnabled {
		return
	}

	tlsOptions := map[string]any{
		"enabled": true,
	}
	if serverName := firstNonEmptyString(raw, "sni", "server_name"); serverName != "" {
		tlsOptions["server_name"] = serverName
	}
	if insecureValue, ok := anyToBool(raw["insecure"]); ok {
		tlsOptions["insecure"] = insecureValue
	}
	outbound["tls"] = tlsOptions
}

func toFlatStringMap(raw any) map[string]any {
	value, ok := raw.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	result := make(map[string]any, len(value))
	for key, item := range value {
		text := strings.TrimSpace(anyToString(item))
		if text != "" {
			result[key] = text
		}
	}
	return result
}

func parseNodeRawConfig(rawConfig string) map[string]any {
	rawConfig = strings.TrimSpace(rawConfig)
	if rawConfig == "" {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		return map[string]any{}
	}
	return payload
}

func toAnyMap(raw any) (map[string]any, bool) {
	value, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	return value, true
}

func cloneMap(source map[string]any) map[string]any {
	target := make(map[string]any, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func firstNonEmptyString(source map[string]any, keys ...string) string {
	for _, key := range keys {
		value := strings.TrimSpace(anyToString(source[key]))
		if value != "" {
			return value
		}
	}
	return ""
}

func anyToString(raw any) string {
	switch value := raw.(type) {
	case nil:
		return ""
	case string:
		return value
	case json.Number:
		return value.String()
	case fmt.Stringer:
		return value.String()
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	default:
		return fmt.Sprint(value)
	}
}

func anyToInt(raw any) int {
	switch value := raw.(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		parsed, err := value.Int64()
		if err != nil {
			return 0
		}
		return int(parsed)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func anyToBool(raw any) (bool, bool) {
	switch value := raw.(type) {
	case bool:
		return value, true
	case string:
		normalized := strings.ToLower(strings.TrimSpace(value))
		switch normalized {
		case "1", "true", "yes", "on":
			return true, true
		case "0", "false", "no", "off":
			return false, true
		default:
			return false, false
		}
	case int:
		return value != 0, true
	case int64:
		return value != 0, true
	case float64:
		return value != 0, true
	default:
		return false, false
	}
}

func looksLikeShadowsocksMethod(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || normalized == "-" || normalized == "tcp" || normalized == "udp" {
		return false
	}
	return strings.Contains(normalized, "gcm") ||
		strings.Contains(normalized, "poly1305") ||
		strings.HasPrefix(normalized, "aes-") ||
		strings.HasPrefix(normalized, "chacha20") ||
		strings.HasPrefix(normalized, "xchacha20") ||
		normalized == "none"
}
