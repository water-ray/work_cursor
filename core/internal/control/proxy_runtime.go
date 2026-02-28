package control

import (
	"bytes"
	"context"
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
	"github.com/sagernet/sing-box/include"
	singboxlog "github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	singjson "github.com/sagernet/sing/common/json"
)

const (
	defaultLocalMixedListenAddress  = "127.0.0.1"
	defaultLocalMixedListenPort     = 1088
	defaultTunInterfaceName         = "wateray-tun"
	defaultClashAPIController       = "127.0.0.1:39081"
	bootstrapDNSServerTag           = "bootstrap"
	localDNSServerTag               = "local-resolver"
	proxySelectorTag                = "proxy"
	defaultDNSRemoteServer          = "https://1.1.1.1/dns-query"
	defaultDNSDirectServer          = "223.5.5.5"
	defaultDNSBootstrapServer       = defaultDNSDirectServer
	defaultDNSFakeIPV4Range         = "198.18.0.0/15"
	defaultDNSFakeIPV6Range         = "fc00::/18"
	defaultDNSStrategy              = DNSStrategyPreferIPv4
	defaultDNSCacheCapacity         = 4096
	fakeIPDNSCacheCapacity          = 8192
	tunFakeIPDNSCacheCapacity       = 16384
	defaultSniffEnabled             = true
	defaultSniffOverrideDestination = true
	defaultSniffTimeoutMS           = 1000
	geoIPRuleSetURLTemplate         = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-%s.srs"
	geoSiteRuleSetURLTemplate       = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-%s.srs"
)

type proxyRuntime struct {
	mu     sync.Mutex
	cancel context.CancelFunc
	box    *box.Box
	onLog  func(level LogLevel, message string)
}

func newProxyRuntime(onLog func(level LogLevel, message string)) *proxyRuntime {
	return &proxyRuntime{
		onLog: onLog,
	}
}

func (r *proxyRuntime) Start(snapshot StateSnapshot) error {
	configContent, err := buildRuntimeConfig(snapshot)
	if err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	_ = r.stopLocked()

	ctx, cancel := context.WithCancel(include.Context(context.Background()))
	options, err := singjson.UnmarshalExtendedContext[option.Options](ctx, []byte(configContent))
	if err != nil {
		cancel()
		return fmt.Errorf("decode sing-box config failed: %w", err)
	}
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
		_ = instance.Close()
		cancel()
		return fmt.Errorf("start sing-box failed: %w", err)
	}

	r.box = instance
	r.cancel = cancel
	return nil
}

func (r *proxyRuntime) Stop() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopLocked()
}

func (r *proxyRuntime) SwitchSelectedNode(nodeID string) error {
	return r.SwitchSelectorOutbound(proxySelectorTag, runtimeNodeTag(nodeID))
}

func (r *proxyRuntime) SwitchSelectorOutbound(selectorTag string, outboundTag string) error {
	selectorTag = strings.TrimSpace(selectorTag)
	outboundTag = strings.TrimSpace(outboundTag)
	if selectorTag == "" || outboundTag == "" {
		return errors.New("selectorTag/outboundTag is required")
	}
	requestBody, err := json.Marshal(map[string]string{
		"name": outboundTag,
	})
	if err != nil {
		return fmt.Errorf("build selector request failed: %w", err)
	}
	request, err := http.NewRequest(
		http.MethodPut,
		"http://"+defaultClashAPIController+"/proxies/"+url.PathEscape(selectorTag),
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
	normalizedProbeURL := strings.TrimSpace(probeURL)
	if normalizedProbeURL == "" {
		normalizedProbeURL = "https://www.gstatic.com/generate_204"
	}
	if timeoutMS <= 0 {
		timeoutMS = 5000
	}
	controllerURL := "http://" + defaultClashAPIController + "/proxies/" + url.PathEscape(tag) + "/delay?url=" + url.QueryEscape(normalizedProbeURL) + "&timeout=" + strconv.Itoa(timeoutMS)
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

func (r *proxyRuntime) CloseAllConnections() error {
	request, err := http.NewRequest(
		http.MethodDelete,
		"http://"+defaultClashAPIController+"/connections",
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

func (r *proxyRuntime) FlushFakeIPCache() error {
	request, err := http.NewRequest(
		http.MethodPost,
		"http://"+defaultClashAPIController+"/cache/fakeip/flush",
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
	return fmt.Errorf(
		"flush fakeip cache failed: status=%d body=%s",
		response.StatusCode,
		strings.TrimSpace(string(body)),
	)
}

func (r *proxyRuntime) stopLocked() error {
	var stopErr error
	if r.box != nil {
		stopErr = r.box.Close()
		r.box = nil
	}
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	if errors.Is(stopErr, os.ErrClosed) {
		return nil
	}
	return stopErr
}

func buildRuntimeConfig(snapshot StateSnapshot) (string, error) {
	mode := normalizeProxyMode(snapshot.ProxyMode)
	if !isValidProxyMode(mode) {
		mode = inferProxyMode(snapshot.TunEnabled, snapshot.SystemProxyEnabled)
	}
	if mode == ProxyModeOff {
		return "", errors.New("proxy mode is off")
	}

	selectedNode, err := resolveRuntimeNode(snapshot)
	if err != nil {
		return "", err
	}
	selectedOutbound, err := buildNodeOutbound(selectedNode)
	if err != nil {
		return "", err
	}
	selectedTag := runtimeNodeTag(selectedNode.ID)
	selectedOutbound["tag"] = selectedTag
	nodeOutbounds := []any{selectedOutbound}
	nodeTags := []string{selectedTag}
	nodeTagsByID := map[string]string{
		selectedNode.ID: selectedTag,
	}
	nodeByID := map[string]Node{
		selectedNode.ID: selectedNode,
	}
	seenNodeIDs := map[string]struct{}{
		selectedNode.ID: {},
	}
	for _, group := range snapshot.Groups {
		for _, node := range group.Nodes {
			if _, exists := seenNodeIDs[node.ID]; exists {
				continue
			}
			outbound, outboundErr := buildNodeOutbound(node)
			if outboundErr != nil {
				continue
			}
			tag := runtimeNodeTag(node.ID)
			outbound["tag"] = tag
			nodeOutbounds = append(nodeOutbounds, outbound)
			nodeTags = append(nodeTags, tag)
			nodeTagsByID[node.ID] = tag
			nodeByID[node.ID] = node
			seenNodeIDs[node.ID] = struct{}{}
		}
	}
	dnsConfig := buildDNSConfig(snapshot)
	routeRules := make([]any, 0, len(snapshot.RuleConfigV2.Rules)+3)
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
		"auto_detect_interface":   true,
		"default_domain_resolver": bootstrapDNSServerTag,
	}
	if ruleSetDefs := mergeRouteRuleSetDefinitions(
		buildRouteRuleSetDefinitions(snapshot.RuleConfigV2),
		generatedRuleSetDefs,
	); len(ruleSetDefs) > 0 {
		routeConfig["rule_set"] = ruleSetDefs
	}

	inbounds := []any{}
	if mode == ProxyModeTun {
		inbounds = append(inbounds, map[string]any{
			"type":           "tun",
			"tag":            "tun-in",
			"interface_name": defaultTunInterfaceName,
			"address": []string{
				"172.19.0.1/30",
				"fdfe:dcba:9876::1/126",
			},
			"auto_route":   true,
			"strict_route": true,
			"stack":        "mixed",
		})
	} else {
		inbounds = append(inbounds, map[string]any{
			"type":        "mixed",
			"tag":         "mixed-in",
			"listen":      runtimeListenAddress(snapshot),
			"listen_port": runtimeListenPort(snapshot),
		})
	}

	runtimeOutbounds := append([]any{}, nodeOutbounds...)
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
				"outbounds":                   nodeTags,
				"default":                     selectedTag,
				"interrupt_exist_connections": true,
			},
		}, runtimeOutbounds...),
		"dns":   dnsConfig,
		"route": routeConfig,
	}
	if experimentalConfig := buildExperimentalConfig(snapshot); experimentalConfig != nil {
		config["experimental"] = experimentalConfig
	}

	raw, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("marshal runtime config failed: %w", err)
	}
	return string(raw), nil
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
	defaultMatchPolicy := strings.TrimSpace(config.Defaults.OnMatch)
	if defaultMatchPolicy == "" {
		defaultMatchPolicy = "direct"
	}
	defaultMissPolicy := strings.TrimSpace(config.Defaults.OnMiss)
	if defaultMissPolicy == "" {
		defaultMissPolicy = "proxy"
	}
	matchOutbound := resolvePolicyOutboundTag(defaultMatchPolicy, policyOutboundTag)
	if strings.TrimSpace(matchOutbound) == "" {
		matchOutbound = "direct"
	}
	finalOutbound := resolvePolicyOutboundTag(defaultMissPolicy, policyOutboundTag)
	if strings.TrimSpace(finalOutbound) == "" {
		finalOutbound = proxySelectorTag
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
			nodeIDs := resolveNodePoolRefsToNodeIDs(group.NodePool.Nodes, activeNodes)
			if len(nodeIDs) == 0 {
				result[group.ID] = proxySelectorTag
				continue
			}
			nodeTags := make([]string, 0, len(nodeIDs))
			for _, nodeID := range nodeIDs {
				tag, ok := nodeTagsByID[nodeID]
				if !ok {
					continue
				}
				nodeTags = append(nodeTags, tag)
			}
			if len(nodeTags) == 0 {
				result[group.ID] = proxySelectorTag
				continue
			}
			defaultTag := nodeTags[0]
			if normalizeRuleNodeSelectStrategy(group.NodePool.NodeSelectStrategy) == RuleNodeSelectFastest {
				if fastestNodeID, ok := pickBestRulePoolNodeID(nodeIDs, nodeByID); ok {
					if fastestTag, exists := nodeTagsByID[fastestNodeID]; exists {
						defaultTag = fastestTag
					}
				}
			}
			selectorTag := buildPolicyGroupSelectorTag(group.ID, index)
			result[group.ID] = selectorTag
			extraOutbounds = append(extraOutbounds, map[string]any{
				"type":                        "selector",
				"tag":                         selectorTag,
				"outbounds":                   nodeTags,
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
				generatedRuleSets[tag] = map[string]any{
					"tag":             tag,
					"type":            "remote",
					"format":          "binary",
					"url":             urlValue,
					"download_detour": "direct",
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
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
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
	remoteServer := strings.TrimSpace(snapshot.DNSRemoteServer)
	if remoteServer == "" {
		remoteServer = defaultDNSRemoteServer
	}
	directServer := strings.TrimSpace(snapshot.DNSDirectServer)
	if directServer == "" {
		directServer = defaultDNSDirectServer
	}
	bootstrapServer := strings.TrimSpace(snapshot.DNSBootstrapServer)
	if bootstrapServer == "" {
		bootstrapServer = directServer
	}
	if bootstrapServer == "" {
		bootstrapServer = defaultDNSBootstrapServer
	}
	strategy := normalizeDNSStrategy(snapshot.DNSStrategy)
	if !isValidDNSStrategy(strategy) {
		strategy = defaultDNSStrategy
	}
	mode := normalizeProxyMode(snapshot.ProxyMode)
	cacheCapacity := defaultDNSCacheCapacity
	if snapshot.DNSFakeIPEnabled {
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
		buildModernDNSServer("remote", remoteServer, "proxy", localDNSServerTag),
		map[string]any{
			"type": "local",
			"tag":  "local",
		},
		buildModernDNSServer("direct", directServer, "direct", localDNSServerTag),
		buildModernDNSServer(bootstrapDNSServerTag, bootstrapServer, "direct", localDNSServerTag),
	}
	rules := []any{
		map[string]any{
			"domain_suffix": []string{"lan", "local"},
			"server":        "direct",
		},
	}
	dns := map[string]any{
		"servers":           servers,
		"rules":             rules,
		"final":             "remote",
		"strategy":          string(strategy),
		"independent_cache": snapshot.DNSIndependentCache,
		"cache_capacity":    cacheCapacity,
		"reverse_mapping":   snapshot.DNSFakeIPEnabled,
	}

	if snapshot.DNSFakeIPEnabled {
		servers = append(
			servers,
			map[string]any{
				"type":        "fakeip",
				"tag":         "fakeip",
				"inet4_range": firstNonEmpty(snapshot.DNSFakeIPV4Range, defaultDNSFakeIPV4Range),
				"inet6_range": firstNonEmpty(snapshot.DNSFakeIPV6Range, defaultDNSFakeIPV6Range),
			},
		)
		rules = append(
			rules,
			map[string]any{
				"query_type": []string{"A", "AAAA"},
				"server":     "fakeip",
			},
		)
		dns["servers"] = servers
		dns["rules"] = rules
	}
	return dns
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

func buildExperimentalConfig(snapshot StateSnapshot) map[string]any {
	experimental := map[string]any{
		"clash_api": map[string]any{
			"external_controller": defaultClashAPIController,
			"default_mode":        "Rule",
		},
	}
	if snapshot.DNSCacheFileEnabled {
		experimental["cache_file"] = map[string]any{
			"enabled":      true,
			"path":         resolveDNSCacheFilePath(),
			"store_rdrc":   snapshot.DNSCacheStoreRDRC,
			"store_fakeip": snapshot.DNSFakeIPEnabled,
			"rdrc_timeout": "7d",
		}
	}
	return experimental
}

func resolveDNSCacheFilePath() string {
	configDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(configDir) == "" {
		return filepath.Join(os.TempDir(), "wateray", "singbox-cache.db")
	}
	return filepath.Join(configDir, "wateray", "singbox-cache.db")
}

func runtimeNodeTag(nodeID string) string {
	trimmed := strings.TrimSpace(nodeID)
	if trimmed == "" {
		return "node-default"
	}
	return "node-" + trimmed
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
	default:
		return "error"
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

func buildNodeOutbound(node Node) (map[string]any, error) {
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
	switch transport {
	case "ws", "websocket":
		ws := map[string]any{
			"type": "ws",
		}
		if path := firstNonEmptyString(raw, "path"); path != "" {
			ws["path"] = path
		}
		if host := firstNonEmptyString(raw, "host", "authority"); host != "" {
			ws["headers"] = map[string]any{
				"Host": host,
			}
		}
		outbound["transport"] = ws
	case "grpc":
		grpc := map[string]any{
			"type": "grpc",
		}
		if serviceName := firstNonEmptyString(raw, "service_name", "serviceName"); serviceName != "" {
			grpc["service_name"] = serviceName
		}
		outbound["transport"] = grpc
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
