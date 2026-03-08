package control

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

func normalizeDNSHostsText(raw string) string {
	value := strings.ReplaceAll(raw, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.TrimSpace(value)
}

func parseDNSHostsEntries(raw string) (map[string][]string, error) {
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	entries := map[string][]string{}
	for index, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if commentIndex := strings.Index(line, "#"); commentIndex >= 0 {
			line = strings.TrimSpace(line[:commentIndex])
			if line == "" {
				continue
			}
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return nil, fmt.Errorf("line %d must contain ip and host", index+1)
		}
		address := strings.TrimSpace(fields[0])
		parsedIP := net.ParseIP(address)
		if parsedIP == nil {
			return nil, fmt.Errorf("line %d has invalid ip: %s", index+1, address)
		}
		ipText := parsedIP.String()
		for _, rawHost := range fields[1:] {
			host := normalizeDNSHostsDomain(rawHost)
			if host == "" {
				return nil, fmt.Errorf("line %d has invalid host: %s", index+1, rawHost)
			}
			entries[host] = uniqueNonEmptyStrings(append(entries[host], ipText))
		}
	}
	return entries, nil
}

func normalizeDNSHostsDomain(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimSuffix(value, ".")
	if value == "" {
		return ""
	}
	if strings.ContainsAny(value, " \t\r\n") || strings.HasPrefix(value, "#") {
		return ""
	}
	return value
}

func resolveSystemHostsFilePath() string {
	if runtime.GOOS == "windows" {
		systemRoot := strings.TrimSpace(os.Getenv("SystemRoot"))
		if systemRoot == "" {
			systemRoot = strings.TrimSpace(os.Getenv("WINDIR"))
		}
		if systemRoot == "" {
			systemRoot = `C:\Windows`
		}
		return filepath.Join(systemRoot, "System32", "drivers", "etc", "hosts")
	}
	return "/etc/hosts"
}

func loadSystemDNSHostsEntries() (map[string][]string, error) {
	content, err := os.ReadFile(resolveSystemHostsFilePath())
	if err != nil {
		return nil, err
	}
	return parseDNSHostsEntries(string(content))
}

func mergeDNSHostsEntries(base map[string][]string, override map[string][]string) map[string][]string {
	merged := map[string][]string{}
	for domain, addresses := range base {
		merged[domain] = uniqueNonEmptyStrings(append([]string{}, addresses...))
	}
	for domain, addresses := range override {
		merged[domain] = uniqueNonEmptyStrings(append([]string{}, addresses...))
	}
	return merged
}

func sortDNSHostsDomains(entries map[string][]string) []string {
	if len(entries) == 0 {
		return nil
	}
	domains := make([]string, 0, len(entries))
	for domain := range entries {
		domains = append(domains, domain)
	}
	sort.Strings(domains)
	return domains
}
