package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var errUnsupportedSubscriptionURL = errors.New("unsupported subscription url scheme")

const (
	maxSubscriptionURLLength        = 2048
	maxSubscriptionResponseBytes    = 8 * 1024 * 1024
	maxConverterResponseBytes       = 8 * 1024 * 1024
	maxSubscriptionRedirects        = 5
	maxSubscriptionBodyPreviewBytes = 256
)

var (
	subscriptionTrafficPattern          = regexp.MustCompile(`(?i)\d+(?:\.\d+)?\s*(?:[KMGTP]i?B)\s*/\s*\d+(?:\.\d+)?\s*(?:[KMGTP]i?B)`)
	subscriptionDateTimePattern         = regexp.MustCompile(`\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?`)
	subscriptionTrafficSeparatorPattern = regexp.MustCompile(`\s*/\s*`)
	subscriptionURLLogPattern           = regexp.MustCompile(`https?://[^\s"'<>]+`)
)

type SubscriptionParser struct {
	client              *http.Client
	converterClient     *http.Client
	converterURL        string
	converterClientType string
}

type SubscriptionParseResult struct {
	Nodes  []Node
	Status string
}

func NewSubscriptionParser() *SubscriptionParser {
	converterURL := strings.TrimSpace(os.Getenv("WATERAY_SUB_CONVERTER_URL"))
	converterClientType := strings.TrimSpace(os.Getenv("WATERAY_SUB_CONVERTER_CLIENT"))
	if converterClientType == "" {
		converterClientType = "JSON"
	}
	return &SubscriptionParser{
		client:              newSafeSubscriptionHTTPClient(20 * time.Second),
		converterClient:     newSafeSubscriptionHTTPClient(8 * time.Second),
		converterURL:        converterURL,
		converterClientType: converterClientType,
	}
}

func newSafeSubscriptionHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           safeSubscriptionDialContext(dialer),
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          16,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxSubscriptionRedirects {
				return errors.New("too many redirects")
			}
			return validateSubscriptionURL(req.URL.String())
		},
	}
}

const subscriptionResolverTimeout = 5 * time.Second

var trustedSubscriptionResolverAddresses = []string{
	"1.1.1.1:53",
	"8.8.8.8:53",
	"[2606:4700:4700::1111]:53",
	"[2001:4860:4860::8888]:53",
}

type subscriptionIPLookup func(ctx context.Context, host string) ([]net.IP, error)

func safeSubscriptionDialContext(dialer *net.Dialer) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		targetAddress, err := resolveSubscriptionDialAddress(
			ctx,
			host,
			port,
			lookupSubscriptionIPsWithSystemResolver,
			lookupSubscriptionIPsWithTrustedResolvers,
		)
		if err != nil {
			return nil, err
		}
		return dialer.DialContext(ctx, network, targetAddress)
	}
}

func validateSubscriptionURL(rawURL string) error {
	value := strings.TrimSpace(rawURL)
	if value == "" {
		return errors.New("subscription url is required")
	}
	if len(value) > maxSubscriptionURLLength {
		return fmt.Errorf("subscription url exceeds %d characters", maxSubscriptionURLLength)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return errors.New("subscription url contains invalid control characters")
		}
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("invalid url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errUnsupportedSubscriptionURL
	}
	if parsed.User != nil {
		return errors.New("subscription url must not include userinfo")
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return errors.New("subscription url host is required")
	}
	return validateSubscriptionHost(host)
}

func validateSubscriptionHost(host string) error {
	normalizedHost := strings.TrimSpace(host)
	if normalizedHost == "" {
		return errors.New("subscription host is required")
	}
	if strings.EqualFold(normalizedHost, "localhost") {
		return errors.New("subscription host must not target localhost")
	}
	if ip := net.ParseIP(normalizedHost); ip != nil {
		if isBlockedSubscriptionIP(ip) {
			return fmt.Errorf("subscription host %s is not allowed", normalizedHost)
		}
		return nil
	}
	return nil
}

func resolveSubscriptionDialAddress(
	ctx context.Context,
	host string,
	port string,
	systemLookup subscriptionIPLookup,
	trustedLookup subscriptionIPLookup,
) (string, error) {
	normalizedHost := strings.TrimSpace(host)
	if err := validateSubscriptionHost(normalizedHost); err != nil {
		return "", err
	}
	if ip := net.ParseIP(normalizedHost); ip != nil {
		return net.JoinHostPort(ip.String(), port), nil
	}
	ips, err := resolveAllowedSubscriptionHostIPs(ctx, normalizedHost, systemLookup, trustedLookup)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", errors.New("resolve host returned no address")
	}
	return net.JoinHostPort(ips[0].String(), port), nil
}

func resolveAllowedSubscriptionHostIPs(
	ctx context.Context,
	host string,
	systemLookup subscriptionIPLookup,
	trustedLookup subscriptionIPLookup,
) ([]net.IP, error) {
	resolveCtx, cancel := ensureSubscriptionResolveTimeout(ctx)
	defer cancel()

	systemIPs, systemErr := lookupSubscriptionIPs(resolveCtx, host, systemLookup)
	systemAllowed := filterAllowedSubscriptionIPs(systemIPs)
	if len(systemAllowed) > 0 {
		return systemAllowed, nil
	}

	trustedIPs, trustedErr := lookupSubscriptionIPs(resolveCtx, host, trustedLookup)
	trustedAllowed := filterAllowedSubscriptionIPs(trustedIPs)
	if len(trustedAllowed) > 0 {
		return trustedAllowed, nil
	}

	if blocked := firstBlockedSubscriptionIP(trustedIPs); blocked != nil {
		return nil, fmt.Errorf("subscription host %s resolves to disallowed address %s", host, blocked.String())
	}
	if blocked := firstBlockedSubscriptionIP(systemIPs); blocked != nil {
		return nil, fmt.Errorf("subscription host %s resolves to disallowed address %s", host, blocked.String())
	}

	if systemErr != nil && trustedErr != nil {
		return nil, fmt.Errorf("resolve host failed: system=%v trusted=%v", systemErr, trustedErr)
	}
	if systemErr != nil {
		return nil, fmt.Errorf("resolve host failed: %w", systemErr)
	}
	if trustedErr != nil {
		return nil, fmt.Errorf("resolve host failed: %w", trustedErr)
	}
	return nil, errors.New("resolve host returned no address")
}

func ensureSubscriptionResolveTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		return context.WithTimeout(context.Background(), subscriptionResolverTimeout)
	}
	if _, hasDeadline := ctx.Deadline(); hasDeadline {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, subscriptionResolverTimeout)
}

func lookupSubscriptionIPs(ctx context.Context, host string, lookup subscriptionIPLookup) ([]net.IP, error) {
	if lookup == nil {
		return nil, nil
	}
	return lookup(ctx, host)
}

func lookupSubscriptionIPsWithSystemResolver(ctx context.Context, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

func lookupSubscriptionIPsWithTrustedResolvers(ctx context.Context, host string) ([]net.IP, error) {
	var lastErr error
	for _, resolverAddress := range trustedSubscriptionResolverAddresses {
		ips, err := lookupSubscriptionIPsByResolver(ctx, host, resolverAddress)
		if err != nil {
			lastErr = err
			continue
		}
		if len(ips) > 0 {
			return ips, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, nil
}

func lookupSubscriptionIPsByResolver(ctx context.Context, host string, resolverAddress string) ([]net.IP, error) {
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			transport := "udp"
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(network)), "tcp") {
				transport = "tcp"
			}
			dialer := &net.Dialer{Timeout: 2 * time.Second}
			return dialer.DialContext(ctx, transport, resolverAddress)
		},
	}
	return resolver.LookupIP(ctx, "ip", host)
}

func filterAllowedSubscriptionIPs(ips []net.IP) []net.IP {
	allowed := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if ip == nil || isBlockedSubscriptionIP(ip) {
			continue
		}
		allowed = append(allowed, ip)
	}
	return allowed
}

func firstBlockedSubscriptionIP(ips []net.IP) net.IP {
	for _, ip := range ips {
		if ip != nil && isBlockedSubscriptionIP(ip) {
			return ip
		}
	}
	return nil
}

func isBlockedSubscriptionIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsMulticast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsUnspecified()
}

func isAllowedSubscriptionContentType(raw string) bool {
	value := strings.ToLower(strings.TrimSpace(strings.Split(raw, ";")[0]))
	if value == "" {
		return true
	}
	switch value {
	case "text/plain",
		"application/json",
		"application/yaml",
		"application/x-yaml",
		"text/yaml",
		"text/x-yaml",
		"application/octet-stream":
		return true
	}
	if strings.HasPrefix(value, "text/") && value != "text/html" {
		return true
	}
	return false
}

func readLimitedBody(reader io.Reader, limit int64) ([]byte, error) {
	limited := &io.LimitedReader{R: reader, N: limit + 1}
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return body, nil
}

func looksLikeBinaryPayload(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	sample := body
	if len(sample) > maxSubscriptionBodyPreviewBytes {
		sample = sample[:maxSubscriptionBodyPreviewBytes]
	}
	nonPrintable := 0
	for _, b := range sample {
		if b == 0 {
			return true
		}
		if b < 0x09 || (b > 0x0D && b < 0x20) {
			nonPrintable++
		}
	}
	return nonPrintable > len(sample)/8
}

func sanitizeURLForLog(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "<invalid>"
	}
	parsed.User = nil
	query := parsed.Query()
	for key := range query {
		query.Set(key, "***")
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func sanitizeURLsInText(raw string) string {
	return subscriptionURLLogPattern.ReplaceAllStringFunc(raw, sanitizeURLForLog)
}

func (p *SubscriptionParser) ParseText(ctx context.Context, content string, groupID string) (SubscriptionParseResult, error) {
	result := SubscriptionParseResult{}
	text := strings.TrimSpace(strings.TrimPrefix(content, "\uFEFF"))
	if text == "" {
		return result, errors.New("subscription content is empty")
	}
	result.Status = parseSubscriptionStatus(text)

	if singboxNodes := p.parseSingBoxJSON(text, groupID); len(singboxNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(text, singboxNodes, result.Status)
		return result, nil
	}
	if clashNodes := p.parseClashYAML(text, groupID); len(clashNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(text, clashNodes, result.Status)
		return result, nil
	}
	if uriNodes := p.parseURILines(text, groupID); len(uriNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(text, uriNodes, result.Status)
		return result, nil
	}
	convertedNodes, convertedStatus, convertedContent, _, ok := p.tryExternalConverter(ctx, text, groupID)
	if ok && len(convertedNodes) > 0 {
		if strings.TrimSpace(result.Status) == "" && strings.TrimSpace(convertedStatus) != "" {
			result.Status = strings.TrimSpace(convertedStatus)
		}
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(convertedContent, convertedNodes, result.Status)
		return result, nil
	}
	return result, errors.New("no supported nodes parsed")
}

func (p *SubscriptionParser) FetchAndParse(ctx context.Context, rawURL string, groupID string) (SubscriptionParseResult, error) {
	result := SubscriptionParseResult{}
	trimmedURL := strings.TrimSpace(rawURL)
	if err := validateSubscriptionURL(trimmedURL); err != nil {
		return result, err
	}
	parsed, _ := url.Parse(trimmedURL)
	content, statusCode, bytesLen, err := p.downloadText(ctx, parsed.String())
	if err != nil {
		return result, fmt.Errorf(
			"download subscription failed: url=%s status=%d bytes=%d err=%s",
			sanitizeURLForLog(trimmedURL),
			statusCode,
			bytesLen,
			sanitizeURLsInText(err.Error()),
		)
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return result, errors.New("subscription content is empty")
	}

	status := parseSubscriptionStatus(content)
	result.Status = status
	singboxNodes := p.parseSingBoxJSON(content, groupID)
	if len(singboxNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(content, singboxNodes, result.Status)
		return result, nil
	}

	clashNodes := p.parseClashYAML(content, groupID)
	if len(clashNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(content, clashNodes, result.Status)
		return result, nil
	}

	uriNodes := p.parseURILines(content, groupID)
	if len(uriNodes) > 0 {
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(content, uriNodes, result.Status)
		return result, nil
	}

	convertedNodes, convertedStatus, convertedContent, _, ok := p.tryExternalConverter(
		ctx,
		content,
		groupID,
	)
	if ok && len(convertedNodes) > 0 {
		if strings.TrimSpace(result.Status) == "" && strings.TrimSpace(convertedStatus) != "" {
			result.Status = strings.TrimSpace(convertedStatus)
		}
		result.Nodes, result.Status = postProcessParsedNodesAndStatus(
			convertedContent,
			convertedNodes,
			result.Status,
		)
		return result, nil
	}
	return result, errors.New("no supported nodes parsed")
}

func (p *SubscriptionParser) downloadText(ctx context.Context, rawURL string) (string, int, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", 0, 0, err
	}
	req.Header.Set("Accept", "*/*")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", 0, 0, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if !isAllowedSubscriptionContentType(resp.Header.Get("Content-Type")) {
		return "", resp.StatusCode, 0, fmt.Errorf("unexpected content-type: %s", strings.TrimSpace(resp.Header.Get("Content-Type")))
	}

	body, err := readLimitedBody(resp.Body, maxSubscriptionResponseBytes)
	if err != nil {
		return "", resp.StatusCode, len(body), fmt.Errorf("read response failed: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", resp.StatusCode, len(body), fmt.Errorf("http status %d", resp.StatusCode)
	}
	if looksLikeBinaryPayload(body) {
		return "", resp.StatusCode, len(body), errors.New("subscription response looks like binary content")
	}
	text := strings.TrimPrefix(string(body), "\uFEFF")
	return text, resp.StatusCode, len(body), nil
}

func previewText(input string, maxLength int) string {
	text := strings.TrimSpace(input)
	if text == "" {
		return "-"
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, "\n", "\\n")
	if len(text) <= maxLength {
		return text
	}
	return text[:maxLength] + "...(truncated)"
}

func (p *SubscriptionParser) parseSubscriptionContent(content string, groupID string) []Node {
	if nodes := p.parseSingBoxJSON(content, groupID); len(nodes) > 0 {
		return nodes
	}
	if nodes := p.parseClashYAML(content, groupID); len(nodes) > 0 {
		return nodes
	}
	return p.parseURILines(content, groupID)
}

func (p *SubscriptionParser) tryExternalConverter(
	ctx context.Context,
	content string,
	groupID string,
) ([]Node, string, string, bool, bool) {
	if strings.TrimSpace(content) == "" {
		return nil, "", "", false, false
	}
	endpoint := strings.TrimSpace(p.converterURL)
	if endpoint == "" {
		return nil, "", "", false, false
	}

	payload := map[string]string{
		"data":     content,
		"content":  content,
		"client":   p.converterClientType,
		"platform": p.converterClientType,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", "", false, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", "", false, false
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")

	resp, err := p.converterClient.Do(req)
	if err != nil {
		return nil, "", "", false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, "", "", false, false
	}
	rawBody, err := readLimitedBody(resp.Body, maxConverterResponseBytes)
	if err != nil {
		return nil, "", "", false, false
	}
	converted := strings.TrimSpace(extractConvertedContent(rawBody))
	if converted == "" {
		return nil, "", "", false, false
	}

	nodes := p.parseSubscriptionContent(converted, groupID)
	if len(nodes) == 0 {
		return nil, "", converted, true, false
	}
	status := parseSubscriptionStatus(converted)
	return nodes, status, converted, true, true
}

func extractConvertedContent(raw []byte) string {
	if strings.TrimSpace(string(raw)) == "" {
		return ""
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return strings.TrimSpace(string(raw))
	}
	lookup := []any{
		root["par_res"],
		root["content"],
		root["result"],
	}
	if data, ok := root["data"].(map[string]any); ok {
		lookup = append(lookup, data["par_res"], data["content"], data["result"])
	}
	for _, candidate := range lookup {
		if text := normalizeConvertedPayload(candidate); text != "" {
			return text
		}
	}
	return ""
}

func normalizeConvertedPayload(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case []byte:
		return strings.TrimSpace(string(v))
	case nil:
		return ""
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(raw))
	}
}

func (p *SubscriptionParser) parseURILines(content string, groupID string) []Node {
	candidates := []string{content}
	if decoded, ok := decodeBase64String(content); ok && strings.Contains(decoded, "://") {
		candidates = append(candidates, decoded)
	}

	nodes := make([]Node, 0, 16)
	index := 0
	for _, candidate := range candidates {
		lines := splitLines(candidate)
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
				continue
			}
			if node, ok := p.parseURINode(line, groupID, index); ok {
				nodes = append(nodes, node)
				index++
				continue
			}
			// Support mixed subscriptions like:
			// REMARKS=...
			// STATUS=...
			// <base64-encoded node lines>
			decodedLine, ok := decodeBase64String(line)
			if !ok || !strings.Contains(decodedLine, "://") {
				continue
			}
			for _, decodedItem := range splitLines(decodedLine) {
				decodedItem = strings.TrimSpace(decodedItem)
				if decodedItem == "" || strings.HasPrefix(decodedItem, "#") || strings.HasPrefix(decodedItem, "//") {
					continue
				}
				if node, ok := p.parseURINode(decodedItem, groupID, index); ok {
					nodes = append(nodes, node)
					index++
				}
			}
		}
	}
	return nodes
}

func parseSubscriptionStatus(content string) string {
	candidates := []string{content}
	if decoded, ok := decodeBase64String(content); ok && strings.TrimSpace(decoded) != "" {
		candidates = append(candidates, decoded)
	}

	statusFallback := ""
	statusTraffic := ""
	statusDate := ""
	for _, candidate := range candidates {
		for _, line := range collectSubscriptionStatusLines(candidate) {
			text := strings.TrimSpace(line)
			if text == "" || strings.HasPrefix(text, "#") || strings.HasPrefix(text, "//") {
				continue
			}
			equalPos := strings.Index(text, "=")
			valueText := text
			hasStatusKey := false
			if equalPos > 0 {
				key := strings.ToUpper(strings.TrimSpace(text[:equalPos]))
				if key == "STATUS" {
					hasStatusKey = true
					valueText = normalizeHeaderValue(text[equalPos+1:])
				} else {
					// YAML fields (for example name: 32 GB | 200 GB) should also
					// participate in status extraction.
					valueText = normalizeHeaderValue(text[equalPos+1:])
				}
			}

			if valueText == "" {
				continue
			}

			lineTraffic, lineDate := extractSubscriptionStatusParts(valueText)
			if statusTraffic == "" && lineTraffic != "" {
				statusTraffic = lineTraffic
			}
			if statusDate == "" && lineDate != "" {
				statusDate = lineDate
			}
			if statusFallback == "" && (hasStatusKey || isLikelyStatusText(valueText)) {
				statusFallback = valueText
			}
			if statusTraffic != "" && statusDate != "" {
				return composeSubscriptionStatus(statusTraffic, statusDate, statusFallback)
			}
		}
	}
	if statusTraffic != "" || statusDate != "" || statusFallback != "" {
		return composeSubscriptionStatus(statusTraffic, statusDate, statusFallback)
	}
	return ""
}

func isLikelyStatusText(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if strings.HasPrefix(strings.ToUpper(text), "STATUS=") {
		return true
	}
	traffic, date := extractSubscriptionStatusParts(text)
	return traffic != "" || date != ""
}

func collectSubscriptionStatusLines(candidate string) []string {
	lines := splitLines(candidate)
	proxyNames := parseClashProxyNames(candidate)
	surgeProxyNames := parseSurgeProxyNames(candidate)
	if len(proxyNames) == 0 {
		if len(surgeProxyNames) == 0 {
			return lines
		}
		combined := make([]string, 0, len(lines)+len(surgeProxyNames))
		combined = append(combined, lines...)
		combined = append(combined, surgeProxyNames...)
		return combined
	}
	combined := make([]string, 0, len(lines)+len(proxyNames)+len(surgeProxyNames))
	combined = append(combined, lines...)
	combined = append(combined, proxyNames...)
	combined = append(combined, surgeProxyNames...)
	return combined
}

func parseClashProxyNames(content string) []string {
	if !strings.Contains(content, "proxies:") {
		return nil
	}
	var root map[string]any
	if err := yaml.Unmarshal([]byte(content), &root); err != nil {
		return nil
	}
	rawProxies, ok := root["proxies"].([]any)
	if !ok || len(rawProxies) == 0 {
		return nil
	}
	names := make([]string, 0, len(rawProxies))
	for _, rawProxy := range rawProxies {
		item, ok := rawProxy.(map[string]any)
		if !ok {
			continue
		}
		name := strings.TrimSpace(toString(item["name"]))
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}

func parseSurgeProxyNames(content string) []string {
	lines := splitLines(content)
	if len(lines) == 0 {
		return nil
	}
	names := make([]string, 0, 8)
	inProxySection := false
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "//") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			sectionName := strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			inProxySection = sectionName == "proxy"
			continue
		}
		if !inProxySection {
			continue
		}
		equalPos := strings.Index(line, "=")
		if equalPos <= 0 {
			continue
		}
		name := strings.TrimSpace(line[:equalPos])
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}

func extractSubscriptionStatusParts(raw string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	normalizedText := strings.NewReplacer("｜", "/", "|", "/").Replace(text)
	trafficRaw := strings.TrimSpace(subscriptionTrafficPattern.FindString(normalizedText))
	traffic := ""
	if trafficRaw != "" {
		traffic = normalizeSubscriptionTrafficValue(trafficRaw)
	}

	date := strings.TrimSpace(subscriptionDateTimePattern.FindString(text))
	if date == "" {
		date = strings.TrimSpace(subscriptionDateTimePattern.FindString(normalizedText))
	}
	return traffic, date
}

func normalizeSubscriptionTrafficValue(raw string) string {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return ""
	}
	normalized = strings.NewReplacer("｜", "/", "|", "/").Replace(normalized)
	normalized = subscriptionTrafficSeparatorPattern.ReplaceAllString(normalized, "/")
	return strings.TrimSpace(normalized)
}

func composeSubscriptionStatus(traffic string, date string, fallback string) string {
	parts := make([]string, 0, 3)
	if traffic != "" {
		parts = append(parts, traffic)
	}
	if date != "" {
		parts = append(parts, date)
	}
	composed := strings.TrimSpace(strings.Join(parts, " "))
	if composed != "" {
		return composed
	}
	return strings.TrimSpace(fallback)
}

func postProcessParsedNodesAndStatus(content string, nodes []Node, status string) ([]Node, string) {
	if len(nodes) == 0 {
		return nodes, strings.TrimSpace(status)
	}
	explicitMarker := hasExplicitStatusMarker(content)
	filtered, nextStatus := applyStrictStatusNodeFilter(nodes, status, explicitMarker)
	return filtered, strings.TrimSpace(nextStatus)
}

func hasExplicitStatusMarker(content string) bool {
	candidates := []string{content}
	if decoded, ok := decodeBase64String(content); ok && strings.TrimSpace(decoded) != "" {
		candidates = append(candidates, decoded)
	}
	for _, candidate := range candidates {
		for _, line := range splitLines(candidate) {
			text := strings.TrimSpace(line)
			if text == "" || strings.HasPrefix(text, "#") || strings.HasPrefix(text, "//") {
				continue
			}
			sepPos := strings.Index(text, "=")
			if colonPos := strings.Index(text, ":"); sepPos < 0 || (colonPos > 0 && colonPos < sepPos) {
				sepPos = colonPos
			}
			if sepPos <= 0 {
				continue
			}
			key := strings.ToUpper(strings.TrimSpace(text[:sepPos]))
			if key == "STATUS" || key == "REMARKS" {
				return true
			}
		}
	}
	return false
}

func applyStrictStatusNodeFilter(nodes []Node, status string, explicitMarker bool) ([]Node, string) {
	traffic, date := extractSubscriptionStatusParts(status)
	fallback := strings.TrimSpace(status)
	if explicitMarker {
		return nodes, composeSubscriptionStatus(traffic, date, fallback)
	}

	groups := make(map[string][]int, len(nodes))
	for index, node := range nodes {
		signature := buildNodeConfigSignature(node)
		groups[signature] = append(groups[signature], index)
	}

	removeIndexes := map[int]struct{}{}
	for _, indexes := range groups {
		if len(indexes) < 2 {
			continue
		}
		statusIndexes := make([]int, 0, len(indexes))
		nonStatusCount := 0
		for _, index := range indexes {
			name := strings.TrimSpace(nodes[index].Name)
			if isStatusPseudoNodeName(name) {
				statusIndexes = append(statusIndexes, index)
				lineTraffic, lineDate := extractSubscriptionStatusParts(name)
				if traffic == "" && lineTraffic != "" {
					traffic = lineTraffic
				}
				if date == "" && lineDate != "" {
					date = lineDate
				}
				continue
			}
			nonStatusCount++
		}
		// Strict mode: only remove markers when a same-config real node exists.
		if nonStatusCount <= 0 || len(statusIndexes) <= 0 {
			continue
		}
		for _, index := range statusIndexes {
			removeIndexes[index] = struct{}{}
		}
	}

	if len(removeIndexes) == 0 {
		return nodes, composeSubscriptionStatus(traffic, date, fallback)
	}

	filtered := make([]Node, 0, len(nodes)-len(removeIndexes))
	for index, node := range nodes {
		if _, shouldRemove := removeIndexes[index]; shouldRemove {
			continue
		}
		filtered = append(filtered, node)
	}
	if len(filtered) == 0 {
		return nodes, composeSubscriptionStatus(traffic, date, fallback)
	}
	return filtered, composeSubscriptionStatus(traffic, date, fallback)
}

func buildNodeConfigSignature(node Node) string {
	rawConfig := map[string]any{}
	if strings.TrimSpace(node.RawConfig) != "" {
		_ = json.Unmarshal([]byte(node.RawConfig), &rawConfig)
	}
	extract := func(key string) string {
		return strings.TrimSpace(toString(rawConfig[key]))
	}
	server := strings.ToLower(strings.TrimSpace(node.Address))
	port := node.Port
	protocol := strings.ToLower(strings.TrimSpace(string(node.Protocol)))
	transport := strings.ToLower(strings.TrimSpace(node.Transport))
	method := strings.ToLower(firstNonEmpty(extract("method"), extract("security"), extract("cipher")))
	password := firstNonEmpty(extract("password"), extract("passwd"))
	uuid := strings.ToLower(extract("uuid"))
	flow := strings.ToLower(extract("flow"))
	sni := strings.ToLower(firstNonEmpty(extract("sni"), extract("servername"), extract("host")))
	serviceName := strings.ToLower(extract("service_name"))
	return fmt.Sprintf(
		"%s|%s|%d|%s|%s|%s|%s|%s|%s|%s",
		protocol,
		server,
		port,
		transport,
		method,
		password,
		uuid,
		flow,
		sni,
		serviceName,
	)
}

func isStatusPseudoNodeName(name string) bool {
	text := strings.TrimSpace(name)
	if text == "" {
		return false
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "traffic reset") ||
		strings.Contains(lower, "expire date") ||
		strings.Contains(lower, "expiration") ||
		strings.Contains(lower, "到期时间") ||
		strings.Contains(lower, "到期") ||
		strings.Contains(lower, "流量") {
		return true
	}
	traffic, date := extractSubscriptionStatusParts(text)
	return traffic != "" || date != ""
}

func normalizeHeaderValue(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if unescaped, err := url.QueryUnescape(value); err == nil && strings.TrimSpace(unescaped) != "" {
		value = strings.TrimSpace(unescaped)
	}
	decoded, ok := decodeBase64String(value)
	if ok {
		decoded = strings.TrimSpace(decoded)
		if decoded != "" && utf8.ValidString(decoded) && isMostlyPrintableText(decoded) {
			value = decoded
		}
	}
	return strings.TrimSpace(value)
}

func (p *SubscriptionParser) parseURINode(line string, groupID string, index int) (Node, bool) {
	lower := strings.ToLower(line)
	if strings.HasPrefix(lower, "vmess://") {
		return parseVmessNode(line, groupID, index)
	}
	if strings.HasPrefix(lower, "ss://") {
		return parseShadowsocksNode(line, groupID, index)
	}

	parsed, err := url.Parse(line)
	if err != nil || parsed.Scheme == "" {
		return Node{}, false
	}
	protocol, ok := mapSchemeToProtocol(parsed.Scheme)
	if !ok {
		return Node{}, false
	}

	host := strings.TrimSpace(parsed.Hostname())
	port := parsed.Port()
	portNumber := defaultPortForProtocol(protocol)
	if port != "" {
		if parsedPort, err := strconv.Atoi(port); err == nil {
			portNumber = parsedPort
		}
	}
	if host == "" || portNumber <= 0 {
		return Node{}, false
	}

	name := decodeFragment(parsed.Fragment)
	if name == "" {
		name = fmt.Sprintf("%s-%s:%d", string(protocol), host, portNumber)
	}
	transport := resolveTransport(parsed.Query())
	country := resolveNodeCountry(firstNonEmpty(parsed.Query().Get("country"), parsed.Query().Get("region")), name)
	rawConfig := buildURIRawConfig(line, protocol, parsed, host, portNumber, transport)
	return buildNode(
		groupID,
		fmt.Sprintf("uri-%d", index),
		name,
		host,
		portNumber,
		protocol,
		transport,
		country,
		rawConfig,
	), true
}

func parseVmessNode(line string, groupID string, index int) (Node, bool) {
	payload := strings.TrimSpace(strings.TrimPrefix(line, "vmess://"))
	decoded, ok := decodeBase64String(payload)
	if !ok || decoded == "" {
		return Node{}, false
	}

	var data map[string]any
	if err := json.Unmarshal([]byte(decoded), &data); err != nil {
		return Node{}, false
	}

	host := strings.TrimSpace(toString(data["add"]))
	port := toInt(data["port"])
	if host == "" || port <= 0 {
		return Node{}, false
	}
	name := strings.TrimSpace(toString(data["ps"]))
	if name == "" {
		name = fmt.Sprintf("vmess-%s:%d", host, port)
	}
	transport := strings.TrimSpace(toString(data["net"]))
	if transport == "" {
		transport = "tcp"
	}
	rawConfig := marshalRawConfig(map[string]any{
		"schema":      "wateray.node.v1",
		"source":      "vmess_uri",
		"protocol":    "vmess",
		"uri":         line,
		"server":      host,
		"server_port": port,
		"uuid":        strings.TrimSpace(toString(data["id"])),
		"alter_id":    toInt(data["aid"]),
		"security": firstNonEmpty(
			strings.TrimSpace(toString(data["scy"])),
			"auto",
		),
		"transport": transport,
		"tls":       strings.EqualFold(strings.TrimSpace(toString(data["tls"])), "tls"),
		"sni":       strings.TrimSpace(toString(data["sni"])),
		"host":      strings.TrimSpace(toString(data["host"])),
		"path":      strings.TrimSpace(toString(data["path"])),
		"display": map[string]any{
			"address":   host,
			"port":      port,
			"transport": normalizeDisplayTransport(NodeProtocol("vmess"), transport),
			"security":  strings.TrimSpace(toString(data["scy"])),
		},
	})
	country := resolveNodeCountry(firstNonEmpty(toString(data["country"]), toString(data["region"])), name)
	return buildNode(
		groupID,
		fmt.Sprintf("vmess-%d", index),
		name,
		host,
		port,
		NodeProtocol("vmess"),
		transport,
		country,
		rawConfig,
	), true
}

func parseShadowsocksNode(line string, groupID string, index int) (Node, bool) {
	body := strings.TrimPrefix(line, "ss://")
	body = strings.TrimSpace(strings.Split(strings.Split(body, "#")[0], "?")[0])
	hostPortPart := ""
	method := ""
	password := ""

	if strings.Contains(body, "@") {
		atIndex := strings.LastIndex(body, "@")
		userInfo := body[:atIndex]
		hostPortPart = body[atIndex+1:]
		hostPortPart = strings.TrimSpace(hostPortPart)
		if slashIndex := strings.Index(hostPortPart, "/"); slashIndex >= 0 {
			hostPortPart = hostPortPart[:slashIndex]
		}
		hostPortPart = strings.TrimSpace(strings.TrimSuffix(hostPortPart, "/"))
		if decoded, ok := decodeBase64String(userInfo); ok && strings.Contains(decoded, ":") {
			userInfo = decoded
		} else {
			decodedValue, err := url.QueryUnescape(userInfo)
			if err == nil {
				userInfo = decodedValue
			}
		}
		if sep := strings.Index(userInfo, ":"); sep > 0 {
			method = userInfo[:sep]
			password = userInfo[sep+1:]
		}
	} else {
		decoded, ok := decodeBase64String(body)
		if !ok || !strings.Contains(decoded, "@") {
			return Node{}, false
		}
		atIndex := strings.LastIndex(decoded, "@")
		hostPortPart = decoded[atIndex+1:]
		hostPortPart = strings.TrimSpace(hostPortPart)
		if slashIndex := strings.Index(hostPortPart, "/"); slashIndex >= 0 {
			hostPortPart = hostPortPart[:slashIndex]
		}
		hostPortPart = strings.TrimSpace(strings.TrimSuffix(hostPortPart, "/"))
		userInfo := decoded[:atIndex]
		if sep := strings.Index(userInfo, ":"); sep > 0 {
			method = userInfo[:sep]
			password = userInfo[sep+1:]
		}
	}

	host, port, ok := parseHostPort(hostPortPart)
	if !ok || host == "" || port <= 0 {
		return Node{}, false
	}
	parsed, _ := url.Parse(line)
	name := ""
	if parsed != nil {
		name = decodeFragment(parsed.Fragment)
	}
	if name == "" {
		name = fmt.Sprintf("ss-%s:%d", host, port)
	}
	rawConfig := marshalRawConfig(map[string]any{
		"schema":      "wateray.node.v1",
		"source":      "ss_uri",
		"protocol":    "shadowsocks",
		"uri":         line,
		"server":      host,
		"server_port": port,
		"method":      strings.TrimSpace(method),
		"password":    strings.TrimSpace(password),
		"transport":   "",
		"security":    strings.TrimSpace(method),
		"display": map[string]any{
			"address":   host,
			"port":      port,
			"transport": "-",
			"security":  strings.TrimSpace(method),
		},
	})
	country := resolveNodeCountry("", name)
	return buildNode(
		groupID,
		fmt.Sprintf("ss-%d", index),
		name,
		host,
		port,
		NodeProtocol("shadowsocks"),
		"-",
		country,
		rawConfig,
	), true
}

func isMostlyPrintableText(value string) bool {
	if value == "" {
		return false
	}
	total := 0
	printable := 0
	for _, runeValue := range value {
		total++
		if unicode.IsPrint(runeValue) || unicode.IsSpace(runeValue) {
			printable++
		}
	}
	if total == 0 {
		return false
	}
	return printable*100/total >= 90
}

func (p *SubscriptionParser) parseClashYAML(content string, groupID string) []Node {
	if !strings.Contains(content, "proxies:") {
		return nil
	}
	var root map[string]any
	if err := yaml.Unmarshal([]byte(content), &root); err != nil {
		return nil
	}
	rawProxies, ok := root["proxies"].([]any)
	if !ok {
		return nil
	}

	nodes := make([]Node, 0, len(rawProxies))
	index := 0
	for _, rawProxy := range rawProxies {
		item, ok := rawProxy.(map[string]any)
		if !ok {
			continue
		}
		typeValue := strings.ToLower(strings.TrimSpace(toString(item["type"])))
		protocol, ok := mapTypeToProtocol(typeValue)
		if !ok {
			continue
		}
		host := strings.TrimSpace(toString(item["server"]))
		if host == "" {
			host = strings.TrimSpace(toString(item["address"]))
		}
		port := toInt(item["port"])
		if host == "" || port <= 0 {
			continue
		}
		name := strings.TrimSpace(toString(item["name"]))
		if name == "" {
			name = fmt.Sprintf("%s-%s:%d", string(protocol), host, port)
		}
		transport := strings.TrimSpace(toString(item["network"]))
		if transport == "" {
			transport = strings.TrimSpace(toString(item["obfs"]))
		}
		if transport == "" {
			transport = typeValue
		}
		displayTransport := normalizeDisplayTransport(protocol, transport)
		country := resolveNodeCountry(
			firstNonEmpty(
				strings.TrimSpace(toString(item["country"])),
				strings.TrimSpace(toString(item["region"])),
				strings.TrimSpace(toString(item["location"])),
			),
			name,
		)
		method := firstNonEmpty(
			strings.TrimSpace(toString(item["cipher"])),
			strings.TrimSpace(toString(item["method"])),
			strings.TrimSpace(toString(item["security"])),
		)
		rawConfig := marshalRawConfig(map[string]any{
			"schema":       "wateray.node.v1",
			"source":       "clash",
			"protocol":     string(protocol),
			"server":       host,
			"server_port":  port,
			"transport":    transport,
			"uuid":         strings.TrimSpace(toString(item["uuid"])),
			"alter_id":     toInt(item["alterId"]),
			"security":     method,
			"password":     strings.TrimSpace(toString(item["password"])),
			"method":       method,
			"flow":         strings.TrimSpace(toString(item["flow"])),
			"sni":          strings.TrimSpace(toString(item["servername"])),
			"host":         strings.TrimSpace(toString(item["host"])),
			"path":         strings.TrimSpace(toString(item["path"])),
			"service_name": strings.TrimSpace(toString(item["serviceName"])),
			"tls":          toBool(item["tls"]),
			"country":      country,
			"display": map[string]any{
				"address":   host,
				"port":      port,
				"transport": displayTransport,
				"security":  method,
				"country":   country,
			},
		})
		nodes = append(
			nodes,
			buildNode(
				groupID,
				fmt.Sprintf("clash-%d", index),
				name,
				host,
				port,
				protocol,
				displayTransport,
				country,
				rawConfig,
			),
		)
		index++
	}
	return nodes
}

func (p *SubscriptionParser) parseSingBoxJSON(content string, groupID string) []Node {
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return nil
	}

	var root map[string]any
	if err := json.Unmarshal([]byte(trimmed), &root); err != nil {
		return nil
	}
	rawOutbounds, ok := root["outbounds"].([]any)
	if !ok {
		return nil
	}

	nodes := make([]Node, 0, len(rawOutbounds))
	index := 0
	for _, rawOutbound := range rawOutbounds {
		item, ok := rawOutbound.(map[string]any)
		if !ok {
			continue
		}
		typeValue := strings.ToLower(strings.TrimSpace(toString(item["type"])))
		protocol, ok := mapTypeToProtocol(typeValue)
		if !ok {
			continue
		}
		host := strings.TrimSpace(toString(item["server"]))
		if host == "" {
			host = strings.TrimSpace(toString(item["address"]))
		}
		port := toInt(item["server_port"])
		if port <= 0 {
			port = toInt(item["port"])
		}
		if host == "" || port <= 0 {
			continue
		}
		name := strings.TrimSpace(toString(item["tag"]))
		if name == "" {
			name = fmt.Sprintf("%s-%s:%d", string(protocol), host, port)
		}
		transport := strings.TrimSpace(toString(item["network"]))
		if transport == "" {
			if transportOptions, ok := item["transport"].(map[string]any); ok {
				transport = strings.TrimSpace(toString(transportOptions["type"]))
			}
		}
		if transport == "" {
			transport = typeValue
		}
		displayTransport := normalizeDisplayTransport(protocol, transport)
		country := resolveNodeCountry(
			firstNonEmpty(
				strings.TrimSpace(toString(item["country"])),
				strings.TrimSpace(toString(item["region"])),
				strings.TrimSpace(toString(item["location"])),
			),
			name,
		)
		singboxOutbound := make(map[string]any, len(item)+1)
		for key, value := range item {
			singboxOutbound[key] = value
		}
		if strings.TrimSpace(toString(singboxOutbound["tag"])) == "" {
			singboxOutbound["tag"] = name
		}
		rawConfig := marshalRawConfig(map[string]any{
			"schema":          "wateray.node.v1",
			"source":          "singbox",
			"singboxOutbound": singboxOutbound,
			"protocol":        string(protocol),
			"server":          host,
			"server_port":     port,
			"country":         country,
			"display": map[string]any{
				"address":   host,
				"port":      port,
				"transport": displayTransport,
				"security":  strings.TrimSpace(toString(item["security"])),
				"country":   country,
			},
		})
		nodes = append(
			nodes,
			buildNode(
				groupID,
				fmt.Sprintf("sb-%d", index),
				name,
				host,
				port,
				protocol,
				displayTransport,
				country,
				rawConfig,
			),
		)
		index++
	}
	return nodes
}

func buildNode(
	groupID string,
	suffix string,
	name string,
	host string,
	port int,
	protocol NodeProtocol,
	transport string,
	country string,
	rawConfig string,
) Node {
	normalizedCountry := normalizeCountry(country)
	return Node{
		ID:              fmt.Sprintf("%s-%s", groupID, suffix),
		Name:            name,
		Region:          normalizedCountry,
		Country:         normalizedCountry,
		Protocol:        protocol,
		LatencyMS:       0,
		Address:         host,
		Port:            port,
		Transport:       transport,
		TotalDownloadMB: 0,
		TotalUploadMB:   0,
		TodayDownloadMB: 0,
		TodayUploadMB:   0,
		RawConfig:       rawConfig,
	}
}

func splitLines(content string) []string {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")
	return strings.Split(content, "\n")
}

func mapSchemeToProtocol(scheme string) (NodeProtocol, bool) {
	return mapTypeToProtocol(strings.ToLower(strings.TrimSpace(scheme)))
}

func mapTypeToProtocol(value string) (NodeProtocol, bool) {
	switch value {
	case "vmess":
		return NodeProtocol("vmess"), true
	case "vless":
		return NodeProtocol("vless"), true
	case "trojan":
		return NodeProtocol("trojan"), true
	case "ss", "shadowsocks":
		return NodeProtocol("shadowsocks"), true
	case "hysteria2", "hy2":
		return NodeProtocol("hysteria2"), true
	case "tuic":
		return NodeProtocol("tuic"), true
	case "wireguard", "wg":
		return NodeProtocol("wireguard"), true
	case "socks", "socks5":
		return NodeProtocol("socks5"), true
	case "http", "https":
		return NodeProtocol("http"), true
	default:
		return "", false
	}
}

func defaultPortForProtocol(protocol NodeProtocol) int {
	switch protocol {
	case NodeProtocol("http"):
		return 80
	case NodeProtocol("socks5"):
		return 1080
	default:
		return 443
	}
}

func normalizeDisplayTransport(protocol NodeProtocol, transport string) string {
	normalized := strings.TrimSpace(strings.ToLower(transport))
	if protocol == NodeProtocol("shadowsocks") {
		return "-"
	}
	if normalized == "" {
		return "tcp"
	}
	if normalized == strings.ToLower(string(protocol)) {
		return "tcp"
	}
	return normalized
}

func resolveTransport(query url.Values) string {
	if v := strings.TrimSpace(query.Get("type")); v != "" {
		return v
	}
	if v := strings.TrimSpace(query.Get("network")); v != "" {
		return v
	}
	if v := strings.TrimSpace(query.Get("transport")); v != "" {
		return v
	}
	if v := strings.TrimSpace(query.Get("obfs")); v != "" {
		return v
	}
	return "tcp"
}

func decodeFragment(fragment string) string {
	if fragment == "" {
		return ""
	}
	value, err := url.QueryUnescape(fragment)
	if err != nil {
		return strings.TrimSpace(fragment)
	}
	return strings.TrimSpace(value)
}

func decodeBase64String(raw string) (string, bool) {
	compact := strings.TrimSpace(strings.Join(strings.Fields(raw), ""))
	if compact == "" {
		return "", false
	}
	normalized := strings.NewReplacer("-", "+", "_", "/").Replace(compact)
	padding := (4 - len(normalized)%4) % 4
	input := normalized + strings.Repeat("=", padding)
	decoded, err := base64.StdEncoding.DecodeString(input)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(normalized)
		if err != nil {
			return "", false
		}
	}
	return string(decoded), true
}

func toString(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func toInt(raw any) int {
	switch v := raw.(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func toBool(raw any) bool {
	switch v := raw.(type) {
	case bool:
		return v
	case string:
		value := strings.TrimSpace(strings.ToLower(v))
		return value == "1" || value == "true" || value == "yes" || value == "on" || value == "tls"
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func marshalRawConfig(payload map[string]any) string {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(raw)
}

func buildURIRawConfig(
	line string,
	protocol NodeProtocol,
	parsed *url.URL,
	host string,
	port int,
	transport string,
) string {
	query := parsed.Query()
	username := ""
	password := ""
	if parsed.User != nil {
		username = strings.TrimSpace(parsed.User.Username())
		passwordValue, _ := parsed.User.Password()
		password = strings.TrimSpace(passwordValue)
	}
	raw := map[string]any{
		"schema":       "wateray.node.v1",
		"source":       "uri",
		"protocol":     string(protocol),
		"uri":          line,
		"server":       host,
		"server_port":  port,
		"transport":    transport,
		"username":     username,
		"password":     password,
		"security":     strings.TrimSpace(query.Get("security")),
		"sni":          firstNonEmpty(query.Get("sni"), query.Get("peer")),
		"host":         firstNonEmpty(query.Get("host"), query.Get("authority")),
		"path":         strings.TrimSpace(query.Get("path")),
		"flow":         strings.TrimSpace(query.Get("flow")),
		"service_name": firstNonEmpty(query.Get("serviceName"), query.Get("service_name")),
		"tls":          strings.EqualFold(strings.TrimSpace(query.Get("security")), "tls"),
		"country":      resolveNodeCountry(firstNonEmpty(query.Get("country"), query.Get("region")), decodeFragment(parsed.Fragment)),
		"display": map[string]any{
			"address":   host,
			"port":      port,
			"transport": normalizeDisplayTransport(protocol, transport),
			"security":  strings.TrimSpace(query.Get("security")),
		},
	}
	if insecure, ok := resolveURIInsecure(query); ok {
		raw["insecure"] = insecure
	}

	switch protocol {
	case NodeProtocol("vless"):
		raw["uuid"] = username
	case NodeProtocol("trojan"), NodeProtocol("hysteria2"):
		raw["password"] = username
	case NodeProtocol("tuic"):
		raw["uuid"] = username
	case NodeProtocol("socks5"), NodeProtocol("http"):
		// keep username/password from userinfo
	}

	return marshalRawConfig(raw)
}

func resolveURIInsecure(query url.Values) (bool, bool) {
	return readBoolQueryValue(
		query,
		"insecure",
		"allowInsecure",
		"allow_insecure",
		"allow-insecure",
		"skip-cert-verify",
		"skip_cert_verify",
		"skipCertVerify",
	)
}

func readBoolQueryValue(query url.Values, keys ...string) (bool, bool) {
	for _, key := range keys {
		values, exists := query[key]
		if !exists || len(values) == 0 {
			continue
		}
		raw := strings.TrimSpace(values[len(values)-1])
		if raw == "" {
			return true, true
		}
		switch strings.ToLower(raw) {
		case "1", "true", "yes", "on":
			return true, true
		case "0", "false", "no", "off":
			return false, true
		}
	}
	return false, false
}

func guessRegion(name string, host string) string {
	source := strings.ToUpper(name + " " + host)
	regions := []string{"US", "JP", "SG", "HK", "DE", "GB", "TW", "KR", "FR", "CA"}
	for _, region := range regions {
		if strings.Contains(source, region) {
			return region
		}
	}
	return ""
}

func resolveNodeCountry(explicit string, name string) string {
	if country := normalizeCountry(explicit); country != "" {
		return country
	}
	return normalizeCountry(name)
}

func normalizeCountry(value string) string {
	if country := extractCountryCodeFromFlagEmoji(value); country != "" {
		return country
	}
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	normalized = strings.ReplaceAll(normalized, "_", " ")
	normalized = strings.ReplaceAll(normalized, "-", " ")
	normalized = strings.Join(strings.Fields(normalized), " ")
	if len(normalized) == 2 && normalized[0] >= 'a' && normalized[0] <= 'z' &&
		normalized[1] >= 'a' && normalized[1] <= 'z' {
		return strings.ToUpper(normalized)
	}
	countryAliases := map[string]string{
		"hk":                   "HK",
		"hong kong":            "HK",
		"hongkong":             "HK",
		"香港":                   "HK",
		"mo":                   "MO",
		"macao":                "MO",
		"macau":                "MO",
		"澳门":                   "MO",
		"jp":                   "JP",
		"japan":                "JP",
		"日本":                   "JP",
		"sg":                   "SG",
		"singapore":            "SG",
		"新加坡":                  "SG",
		"ch":                   "CH",
		"switzerland":          "CH",
		"swiss":                "CH",
		"瑞士":                   "CH",
		"in":                   "IN",
		"india":                "IN",
		"印度":                   "IN",
		"nl":                   "NL",
		"netherlands":          "NL",
		"holland":              "NL",
		"荷兰":                   "NL",
		"vn":                   "VN",
		"vietnam":              "VN",
		"viet nam":             "VN",
		"越南":                   "VN",
		"kh":                   "KH",
		"cambodia":             "KH",
		"柬埔寨":                  "KH",
		"np":                   "NP",
		"nepal":                "NP",
		"尼泊尔":                  "NP",
		"th":                   "TH",
		"thailand":             "TH",
		"泰国":                   "TH",
		"my":                   "MY",
		"malaysia":             "MY",
		"马来西亚":                 "MY",
		"id":                   "ID",
		"indonesia":            "ID",
		"印尼":                   "ID",
		"ph":                   "PH",
		"philippines":          "PH",
		"菲律宾":                  "PH",
		"us":                   "US",
		"usa":                  "US",
		"united states":        "US",
		"美国":                   "US",
		"tw":                   "TW",
		"taiwan":               "TW",
		"台湾":                   "TW",
		"kr":                   "KR",
		"korea":                "KR",
		"south korea":          "KR",
		"韩国":                   "KR",
		"gb":                   "GB",
		"uk":                   "GB",
		"united kingdom":       "GB",
		"英国":                   "GB",
		"de":                   "DE",
		"germany":              "DE",
		"德国":                   "DE",
		"fr":                   "FR",
		"france":               "FR",
		"法国":                   "FR",
		"ca":                   "CA",
		"canada":               "CA",
		"加拿大":                  "CA",
		"au":                   "AU",
		"australia":            "AU",
		"澳大利亚":                 "AU",
		"ru":                   "RU",
		"russia":               "RU",
		"俄罗斯":                  "RU",
		"it":                   "IT",
		"italy":                "IT",
		"意大利":                  "IT",
		"es":                   "ES",
		"spain":                "ES",
		"西班牙":                  "ES",
		"br":                   "BR",
		"brazil":               "BR",
		"巴西":                   "BR",
		"tr":                   "TR",
		"turkey":               "TR",
		"土耳其":                  "TR",
		"ae":                   "AE",
		"uae":                  "AE",
		"dubai":                "AE",
		"united arab emirates": "AE",
		"阿联酋":                  "AE",
	}
	if country, ok := countryAliases[normalized]; ok {
		return country
	}
	tokens := strings.Fields(normalized)
	for alias, country := range countryAliases {
		if strings.Contains(alias, " ") {
			if strings.Contains(normalized, alias) {
				return country
			}
			continue
		}
		for _, token := range tokens {
			if token == alias {
				return country
			}
		}
		if len(alias) >= 3 && strings.Contains(normalized, alias) {
			return country
		}
	}
	return ""
}

func extractCountryCodeFromFlagEmoji(value string) string {
	runes := []rune(strings.TrimSpace(value))
	for index := 0; index < len(runes)-1; index++ {
		first := runes[index]
		second := runes[index+1]
		if !isRegionalIndicator(first) || !isRegionalIndicator(second) {
			continue
		}
		code := []rune{
			rune('A' + (first - 0x1F1E6)),
			rune('A' + (second - 0x1F1E6)),
		}
		return string(code)
	}
	return ""
}

func isRegionalIndicator(value rune) bool {
	return value >= 0x1F1E6 && value <= 0x1F1FF
}

func parseHostPort(raw string) (string, int, bool) {
	source := strings.TrimSpace(raw)
	if source == "" {
		return "", 0, false
	}

	if strings.HasPrefix(source, "[") && strings.Contains(source, "]:") {
		split := strings.LastIndex(source, "]:")
		host := source[1:split]
		portValue := source[split+2:]
		port, err := strconv.Atoi(portValue)
		if err != nil || host == "" || port <= 0 {
			return "", 0, false
		}
		return host, port, true
	}

	host, portString, err := net.SplitHostPort(source)
	if err != nil {
		split := strings.LastIndex(source, ":")
		if split <= 0 || split >= len(source)-1 {
			return "", 0, false
		}
		host = source[:split]
		portString = source[split+1:]
	}
	port, err := strconv.Atoi(strings.TrimSpace(portString))
	if err != nil || strings.TrimSpace(host) == "" || port <= 0 {
		return "", 0, false
	}
	return strings.TrimSpace(host), port, true
}
