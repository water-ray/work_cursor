//go:build linux

package control

import (
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const minimumLinuxMonitorSocketMatchScore = 6

type linuxMonitorConnectionQuery struct {
	ConnectionIndex int
	Protocol        string
	LocalIP         string
	LocalPort       int
	RemoteIP        string
	RemotePort      int
}

type linuxMonitorSocketEntry struct {
	Protocol   string
	LocalIP    string
	LocalPort  int
	RemoteIP   string
	RemotePort int
	Inode      string
}

type linuxMonitorSocketOwner struct {
	PID  int64
	Name string
	Path string
}

func enrichMonitorConnectionsProcessInfo(snapshot *clashConnectionsSnapshot) {
	if snapshot == nil || len(snapshot.Connections) == 0 {
		return
	}
	queries := buildLinuxMonitorConnectionQueries(snapshot.Connections)
	if len(queries) == 0 {
		return
	}
	socketEntries := collectLinuxMonitorSocketEntries(queries)
	if len(socketEntries) == 0 {
		return
	}
	owners := resolveLinuxMonitorSocketOwners(socketEntries)
	if len(owners) == 0 {
		return
	}
	applyLinuxMonitorProcessOwners(snapshot, queries, socketEntries, owners)
}

func buildLinuxMonitorConnectionQueries(connections []clashConnectionRecord) []linuxMonitorConnectionQuery {
	queries := make([]linuxMonitorConnectionQuery, 0, len(connections))
	for index, connection := range connections {
		metadata := connection.Metadata
		if maxInt64(metadata.ProcessID, metadata.ProcessIDSnake) > 0 {
			continue
		}
		if firstNonEmpty(
			strings.TrimSpace(metadata.ProcessName),
			strings.TrimSpace(metadata.Process),
			strings.TrimSpace(metadata.ProcessPath),
			strings.TrimSpace(metadata.ProcessPathSnake),
		) != "" {
			continue
		}
		protocol := normalizeLinuxMonitorNetwork(metadata.Network)
		if protocol == "" {
			continue
		}
		localIP := normalizeLinuxMonitorIP(firstNonEmpty(
			strings.TrimSpace(metadata.SourceIP),
			strings.TrimSpace(metadata.SourceIPSnake),
		))
		localPort := metadata.SourcePort
		if localPort <= 0 {
			localPort = metadata.SourcePortSnake
		}
		remoteIP := normalizeLinuxMonitorIP(firstNonEmpty(
			strings.TrimSpace(metadata.DestinationIP),
			strings.TrimSpace(metadata.DestinationIPSnake),
		))
		if remoteIP == "" {
			remoteIP = normalizeLinuxMonitorIP(strings.TrimSpace(metadata.Host))
		}
		remotePort := metadata.DestinationPort
		if remotePort <= 0 {
			remotePort = metadata.DestinationPortSnake
		}
		if remotePort <= 0 {
			continue
		}
		// Require at least local port or remote IP so we don't guess blindly from port alone.
		if localPort <= 0 && remoteIP == "" {
			continue
		}
		queries = append(queries, linuxMonitorConnectionQuery{
			ConnectionIndex: index,
			Protocol:        protocol,
			LocalIP:         localIP,
			LocalPort:       localPort,
			RemoteIP:        remoteIP,
			RemotePort:      remotePort,
		})
	}
	return queries
}

func normalizeLinuxMonitorNetwork(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch {
	case strings.HasPrefix(normalized, "tcp"):
		return "tcp"
	case strings.HasPrefix(normalized, "udp"):
		return "udp"
	default:
		return ""
	}
}

func normalizeLinuxMonitorIP(value string) string {
	value = strings.TrimSpace(strings.Trim(value, "[]"))
	if value == "" {
		return ""
	}
	parsed := net.ParseIP(value)
	if parsed == nil {
		return ""
	}
	if parsed.IsUnspecified() {
		return ""
	}
	if ipv4 := parsed.To4(); ipv4 != nil {
		return ipv4.String()
	}
	return parsed.String()
}

func collectLinuxMonitorSocketEntries(queries []linuxMonitorConnectionQuery) []linuxMonitorSocketEntry {
	if len(queries) == 0 {
		return nil
	}
	hasTCP := false
	hasUDP := false
	for _, query := range queries {
		switch query.Protocol {
		case "tcp":
			hasTCP = true
		case "udp":
			hasUDP = true
		}
	}
	entries := make([]linuxMonitorSocketEntry, 0, len(queries))
	if hasTCP {
		entries = append(entries, readLinuxMonitorSocketTable("/proc/net/tcp", "tcp", false, queries)...)
		entries = append(entries, readLinuxMonitorSocketTable("/proc/net/tcp6", "tcp", true, queries)...)
	}
	if hasUDP {
		entries = append(entries, readLinuxMonitorSocketTable("/proc/net/udp", "udp", false, queries)...)
		entries = append(entries, readLinuxMonitorSocketTable("/proc/net/udp6", "udp", true, queries)...)
	}
	return entries
}

func readLinuxMonitorSocketTable(
	path string,
	protocol string,
	ipv6 bool,
	queries []linuxMonitorConnectionQuery,
) []linuxMonitorSocketEntry {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	entries := make([]linuxMonitorSocketEntry, 0, len(lines))
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		localIP, localPort, err := parseLinuxMonitorProcSocketAddress(fields[1], ipv6)
		if err != nil {
			continue
		}
		remoteIP, remotePort, err := parseLinuxMonitorProcSocketAddress(fields[2], ipv6)
		if err != nil {
			continue
		}
		entry := linuxMonitorSocketEntry{
			Protocol:   protocol,
			LocalIP:    localIP,
			LocalPort:  localPort,
			RemoteIP:   remoteIP,
			RemotePort: remotePort,
			Inode:      strings.TrimSpace(fields[9]),
		}
		if entry.Inode == "" || entry.Inode == "0" {
			continue
		}
		if maxLinuxMonitorSocketMatchScore(entry, queries) < minimumLinuxMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func parseLinuxMonitorProcSocketAddress(value string, ipv6 bool) (string, int, error) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	if len(parts) != 2 {
		return "", 0, strconv.ErrSyntax
	}
	portValue, err := strconv.ParseUint(parts[1], 16, 16)
	if err != nil {
		return "", 0, err
	}
	raw, err := hex.DecodeString(parts[0])
	if err != nil {
		return "", 0, err
	}
	var ip net.IP
	if ipv6 {
		if len(raw) != net.IPv6len {
			return "", 0, strconv.ErrSyntax
		}
		decoded := make([]byte, net.IPv6len)
		for offset := 0; offset < len(raw); offset += 4 {
			decoded[offset] = raw[offset+3]
			decoded[offset+1] = raw[offset+2]
			decoded[offset+2] = raw[offset+1]
			decoded[offset+3] = raw[offset]
		}
		ip = net.IP(decoded)
	} else {
		if len(raw) != net.IPv4len {
			return "", 0, strconv.ErrSyntax
		}
		ip = net.IP{raw[3], raw[2], raw[1], raw[0]}
	}
	return normalizeLinuxMonitorIP(ip.String()), int(portValue), nil
}

func maxLinuxMonitorSocketMatchScore(
	entry linuxMonitorSocketEntry,
	queries []linuxMonitorConnectionQuery,
) int {
	best := 0
	for _, query := range queries {
		score := scoreLinuxMonitorSocketMatch(entry, query)
		if score > best {
			best = score
		}
	}
	return best
}

func scoreLinuxMonitorSocketMatch(
	entry linuxMonitorSocketEntry,
	query linuxMonitorConnectionQuery,
) int {
	if entry.Protocol != query.Protocol {
		return 0
	}
	score := 0
	if query.RemotePort > 0 {
		if entry.RemotePort != query.RemotePort {
			return 0
		}
		score += 2
	}
	if query.RemoteIP != "" {
		if entry.RemoteIP != query.RemoteIP {
			return 0
		}
		score += 4
	}
	if query.LocalPort > 0 {
		if entry.LocalPort != query.LocalPort {
			return 0
		}
		score += 8
	}
	if query.LocalIP != "" {
		if entry.LocalIP != query.LocalIP {
			return 0
		}
		score++
	}
	return score
}

func resolveLinuxMonitorSocketOwners(
	entries []linuxMonitorSocketEntry,
) map[string]linuxMonitorSocketOwner {
	targetInodes := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.Inode == "" || entry.Inode == "0" {
			continue
		}
		targetInodes[entry.Inode] = struct{}{}
	}
	if len(targetInodes) == 0 {
		return nil
	}
	owners := make(map[string]linuxMonitorSocketOwner, len(targetInodes))
	procEntries, err := os.ReadDir("/proc")
	if err != nil {
		return owners
	}
	for _, procEntry := range procEntries {
		if !procEntry.IsDir() {
			continue
		}
		pidText := strings.TrimSpace(procEntry.Name())
		pidValue, err := strconv.ParseInt(pidText, 10, 64)
		if err != nil || pidValue <= 0 {
			continue
		}
		fdEntries, err := os.ReadDir(filepath.Join("/proc", pidText, "fd"))
		if err != nil {
			continue
		}
		matched := map[string]struct{}{}
		for _, fdEntry := range fdEntries {
			linkTarget, err := os.Readlink(filepath.Join("/proc", pidText, "fd", fdEntry.Name()))
			if err != nil {
				continue
			}
			inode := parseLinuxMonitorSocketInode(linkTarget)
			if inode == "" {
				continue
			}
			if _, wanted := targetInodes[inode]; !wanted {
				continue
			}
			if _, exists := owners[inode]; exists {
				continue
			}
			matched[inode] = struct{}{}
		}
		if len(matched) == 0 {
			continue
		}
		owner := linuxMonitorSocketOwner{
			PID:  pidValue,
			Name: readLinuxMonitorProcComm(pidText),
			Path: readLinuxMonitorProcExe(pidText),
		}
		if owner.Name == "" && owner.Path != "" {
			owner.Name = filepath.Base(owner.Path)
		}
		for inode := range matched {
			owners[inode] = owner
		}
		if len(owners) >= len(targetInodes) {
			break
		}
	}
	return owners
}

func parseLinuxMonitorSocketInode(linkTarget string) string {
	const prefix = "socket:["
	if !strings.HasPrefix(linkTarget, prefix) || !strings.HasSuffix(linkTarget, "]") {
		return ""
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(linkTarget, prefix), "]"))
}

func readLinuxMonitorProcComm(pidText string) string {
	data, err := os.ReadFile(filepath.Join("/proc", pidText, "comm"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func readLinuxMonitorProcExe(pidText string) string {
	target, err := os.Readlink(filepath.Join("/proc", pidText, "exe"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(target)
}

func applyLinuxMonitorProcessOwners(
	snapshot *clashConnectionsSnapshot,
	queries []linuxMonitorConnectionQuery,
	socketEntries []linuxMonitorSocketEntry,
	owners map[string]linuxMonitorSocketOwner,
) {
	if snapshot == nil {
		return
	}
	for _, query := range queries {
		if query.ConnectionIndex < 0 || query.ConnectionIndex >= len(snapshot.Connections) {
			continue
		}
		bestScore := 0
		bestOwner := linuxMonitorSocketOwner{}
		unique := true
		for _, entry := range socketEntries {
			score := scoreLinuxMonitorSocketMatch(entry, query)
			if score < minimumLinuxMonitorSocketMatchScore {
				continue
			}
			owner, ok := owners[entry.Inode]
			if !ok || owner.PID <= 0 {
				continue
			}
			if score > bestScore {
				bestScore = score
				bestOwner = owner
				unique = true
				continue
			}
			if score == bestScore && !sameLinuxMonitorSocketOwner(bestOwner, owner) {
				unique = false
			}
		}
		if bestScore < minimumLinuxMonitorSocketMatchScore || !unique || bestOwner.PID <= 0 {
			continue
		}
		metadata := &snapshot.Connections[query.ConnectionIndex].Metadata
		if metadata.ProcessID <= 0 {
			metadata.ProcessID = bestOwner.PID
		}
		if metadata.ProcessIDSnake <= 0 {
			metadata.ProcessIDSnake = bestOwner.PID
		}
		if strings.TrimSpace(metadata.ProcessName) == "" {
			metadata.ProcessName = bestOwner.Name
		}
		if strings.TrimSpace(metadata.Process) == "" {
			metadata.Process = bestOwner.Name
		}
		if strings.TrimSpace(metadata.ProcessPath) == "" {
			metadata.ProcessPath = bestOwner.Path
		}
		if strings.TrimSpace(metadata.ProcessPathSnake) == "" {
			metadata.ProcessPathSnake = bestOwner.Path
		}
	}
}

func sameLinuxMonitorSocketOwner(
	left linuxMonitorSocketOwner,
	right linuxMonitorSocketOwner,
) bool {
	return left.PID == right.PID &&
		left.Name == right.Name &&
		left.Path == right.Path
}
