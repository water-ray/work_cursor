//go:build windows

package control

import (
	"net"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/sagernet/sing/common/winiphlpapi"
	"golang.org/x/sys/windows"
)

const minimumWindowsMonitorSocketMatchScore = 8

var (
	loadWindowsMonitorTablesOnce sync.Once
	loadWindowsMonitorTablesErr  error
)

type windowsMonitorConnectionQuery struct {
	ConnectionIndex int
	Protocol        string
	LocalIP         netip.Addr
	LocalPort       int
	RemoteIP        netip.Addr
	RemotePort      int
}

type windowsMonitorSocketEntry struct {
	Protocol   string
	LocalIP    netip.Addr
	LocalPort  int
	RemoteIP   netip.Addr
	RemotePort int
	PID        uint32
}

type windowsMonitorSocketOwner struct {
	PID  int64
	Name string
	Path string
}

func enrichMonitorConnectionsProcessInfo(snapshot *clashConnectionsSnapshot) {
	if snapshot == nil || len(snapshot.Connections) == 0 {
		return
	}
	loadWindowsMonitorTablesOnce.Do(func() {
		loadWindowsMonitorTablesErr = winiphlpapi.LoadExtendedTable()
	})
	if loadWindowsMonitorTablesErr != nil {
		return
	}
	queries := buildWindowsMonitorConnectionQueries(snapshot.Connections)
	if len(queries) == 0 {
		return
	}
	socketEntries := collectWindowsMonitorSocketEntries(queries)
	if len(socketEntries) == 0 {
		return
	}
	applyWindowsMonitorProcessOwners(snapshot, queries, socketEntries)
}

func buildWindowsMonitorConnectionQueries(connections []clashConnectionRecord) []windowsMonitorConnectionQuery {
	queries := make([]windowsMonitorConnectionQuery, 0, len(connections))
	for index, connection := range connections {
		metadata := connection.Metadata
		if maxInt64(metadata.ProcessID, metadata.ProcessIDSnake) > 0 {
			continue
		}
		protocol := normalizeWindowsMonitorNetwork(metadata.Network)
		if protocol == "" {
			continue
		}
		localPort := metadata.SourcePort
		if localPort <= 0 {
			localPort = metadata.SourcePortSnake
		}
		if localPort <= 0 {
			continue
		}
		localIP := normalizeWindowsMonitorIP(firstNonEmpty(
			strings.TrimSpace(metadata.SourceIP),
			strings.TrimSpace(metadata.SourceIPSnake),
		))
		remoteIP := normalizeWindowsMonitorIP(firstNonEmpty(
			strings.TrimSpace(metadata.DestinationIP),
			strings.TrimSpace(metadata.DestinationIPSnake),
		))
		if !remoteIP.IsValid() {
			remoteIP = normalizeWindowsMonitorIP(strings.TrimSpace(metadata.Host))
		}
		remotePort := metadata.DestinationPort
		if remotePort <= 0 {
			remotePort = metadata.DestinationPortSnake
		}
		queries = append(queries, windowsMonitorConnectionQuery{
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

func normalizeWindowsMonitorNetwork(value string) string {
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

func normalizeWindowsMonitorIP(value string) netip.Addr {
	value = strings.TrimSpace(strings.Trim(value, "[]"))
	if value == "" {
		return netip.Addr{}
	}
	parsed := net.ParseIP(value)
	if parsed == nil {
		return netip.Addr{}
	}
	addr, ok := netip.AddrFromSlice(parsed)
	if !ok {
		return netip.Addr{}
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() {
		return netip.Addr{}
	}
	return addr
}

func collectWindowsMonitorSocketEntries(queries []windowsMonitorConnectionQuery) []windowsMonitorSocketEntry {
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
	entries := make([]windowsMonitorSocketEntry, 0, len(queries))
	if hasTCP {
		entries = append(entries, collectWindowsMonitorTCPv4Entries(queries)...)
		entries = append(entries, collectWindowsMonitorTCPv6Entries(queries)...)
	}
	if hasUDP {
		entries = append(entries, collectWindowsMonitorUDPv4Entries(queries)...)
		entries = append(entries, collectWindowsMonitorUDPv6Entries(queries)...)
	}
	return entries
}

func collectWindowsMonitorTCPv4Entries(queries []windowsMonitorConnectionQuery) []windowsMonitorSocketEntry {
	rows, err := winiphlpapi.GetExtendedTcpTable()
	if err != nil {
		return nil
	}
	entries := make([]windowsMonitorSocketEntry, 0, len(rows))
	for _, row := range rows {
		entry := windowsMonitorSocketEntry{
			Protocol:   "tcp",
			LocalIP:    normalizeWindowsMonitorTableAddr(winiphlpapi.DwordToAddr(row.DwLocalAddr)),
			LocalPort:  int(winiphlpapi.DwordToPort(row.DwLocalPort)),
			RemoteIP:   normalizeWindowsMonitorTableAddr(winiphlpapi.DwordToAddr(row.DwRemoteAddr)),
			RemotePort: int(winiphlpapi.DwordToPort(row.DwRemotePort)),
			PID:        row.DwOwningPid,
		}
		if entry.PID == 0 || entry.LocalPort <= 0 {
			continue
		}
		if maxWindowsMonitorSocketMatchScore(entry, queries) < minimumWindowsMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func collectWindowsMonitorTCPv6Entries(queries []windowsMonitorConnectionQuery) []windowsMonitorSocketEntry {
	rows, err := winiphlpapi.GetExtendedTcp6Table()
	if err != nil {
		return nil
	}
	entries := make([]windowsMonitorSocketEntry, 0, len(rows))
	for _, row := range rows {
		entry := windowsMonitorSocketEntry{
			Protocol:   "tcp",
			LocalIP:    normalizeWindowsMonitorTableAddr(netip.AddrFrom16(row.UcLocalAddr)),
			LocalPort:  int(winiphlpapi.DwordToPort(row.DwLocalPort)),
			RemoteIP:   normalizeWindowsMonitorTableAddr(netip.AddrFrom16(row.UcRemoteAddr)),
			RemotePort: int(winiphlpapi.DwordToPort(row.DwRemotePort)),
			PID:        row.DwOwningPid,
		}
		if entry.PID == 0 || entry.LocalPort <= 0 {
			continue
		}
		if maxWindowsMonitorSocketMatchScore(entry, queries) < minimumWindowsMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func collectWindowsMonitorUDPv4Entries(queries []windowsMonitorConnectionQuery) []windowsMonitorSocketEntry {
	rows, err := winiphlpapi.GetExtendedUdpTable()
	if err != nil {
		return nil
	}
	entries := make([]windowsMonitorSocketEntry, 0, len(rows))
	for _, row := range rows {
		entry := windowsMonitorSocketEntry{
			Protocol:  "udp",
			LocalIP:   normalizeWindowsMonitorTableAddr(winiphlpapi.DwordToAddr(row.DwLocalAddr)),
			LocalPort: int(winiphlpapi.DwordToPort(row.DwLocalPort)),
			PID:       row.DwOwningPid,
		}
		if entry.PID == 0 || entry.LocalPort <= 0 {
			continue
		}
		if maxWindowsMonitorSocketMatchScore(entry, queries) < minimumWindowsMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func collectWindowsMonitorUDPv6Entries(queries []windowsMonitorConnectionQuery) []windowsMonitorSocketEntry {
	rows, err := winiphlpapi.GetExtendedUdp6Table()
	if err != nil {
		return nil
	}
	entries := make([]windowsMonitorSocketEntry, 0, len(rows))
	for _, row := range rows {
		entry := windowsMonitorSocketEntry{
			Protocol:  "udp",
			LocalIP:   normalizeWindowsMonitorTableAddr(netip.AddrFrom16(row.UcLocalAddr)),
			LocalPort: int(winiphlpapi.DwordToPort(row.DwLocalPort)),
			PID:       row.DwOwningPid,
		}
		if entry.PID == 0 || entry.LocalPort <= 0 {
			continue
		}
		if maxWindowsMonitorSocketMatchScore(entry, queries) < minimumWindowsMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func normalizeWindowsMonitorTableAddr(addr netip.Addr) netip.Addr {
	if !addr.IsValid() {
		return netip.Addr{}
	}
	return addr.Unmap()
}

func maxWindowsMonitorSocketMatchScore(
	entry windowsMonitorSocketEntry,
	queries []windowsMonitorConnectionQuery,
) int {
	best := 0
	for _, query := range queries {
		score := scoreWindowsMonitorSocketMatch(entry, query)
		if score > best {
			best = score
		}
	}
	return best
}

func scoreWindowsMonitorSocketMatch(
	entry windowsMonitorSocketEntry,
	query windowsMonitorConnectionQuery,
) int {
	if entry.Protocol != query.Protocol {
		return 0
	}
	score := 0
	if query.LocalPort > 0 {
		if entry.LocalPort != query.LocalPort {
			return 0
		}
		score += 8
	}
	if query.LocalIP.IsValid() {
		if entry.LocalIP.IsValid() && !entry.LocalIP.IsUnspecified() {
			if entry.LocalIP != query.LocalIP {
				return 0
			}
			score++
		}
	}
	if query.Protocol == "tcp" {
		if query.RemotePort > 0 {
			if entry.RemotePort != query.RemotePort {
				return 0
			}
			score += 2
		}
		if query.RemoteIP.IsValid() {
			if !entry.RemoteIP.IsValid() || entry.RemoteIP != query.RemoteIP {
				return 0
			}
			score += 4
		}
	}
	return score
}

func applyWindowsMonitorProcessOwners(
	snapshot *clashConnectionsSnapshot,
	queries []windowsMonitorConnectionQuery,
	socketEntries []windowsMonitorSocketEntry,
) {
	if snapshot == nil {
		return
	}
	ownerCache := map[uint32]windowsMonitorSocketOwner{}
	for _, query := range queries {
		if query.ConnectionIndex < 0 || query.ConnectionIndex >= len(snapshot.Connections) {
			continue
		}
		bestScore := 0
		var bestPID uint32
		unique := true
		for _, entry := range socketEntries {
			score := scoreWindowsMonitorSocketMatch(entry, query)
			if score < minimumWindowsMonitorSocketMatchScore || entry.PID == 0 {
				continue
			}
			if score > bestScore {
				bestScore = score
				bestPID = entry.PID
				unique = true
				continue
			}
			if score == bestScore && bestPID != 0 && entry.PID != bestPID {
				unique = false
			}
		}
		if bestScore < minimumWindowsMonitorSocketMatchScore || !unique || bestPID == 0 {
			continue
		}
		metadata := &snapshot.Connections[query.ConnectionIndex].Metadata
		if metadata.ProcessID <= 0 {
			metadata.ProcessID = int64(bestPID)
		}
		if metadata.ProcessIDSnake <= 0 {
			metadata.ProcessIDSnake = int64(bestPID)
		}

		// Keep any existing name/path from sing-box. Only ask Windows for extra fields we still miss.
		existingPath := firstNonEmpty(
			strings.TrimSpace(metadata.ProcessPath),
			strings.TrimSpace(metadata.ProcessPathSnake),
		)
		existingName := firstNonEmpty(
			strings.TrimSpace(metadata.ProcessName),
			strings.TrimSpace(metadata.Process),
		)
		if existingName == "" && existingPath != "" {
			existingName = filepath.Base(existingPath)
		}
		if strings.TrimSpace(metadata.ProcessName) == "" && existingName != "" {
			metadata.ProcessName = existingName
		}
		if strings.TrimSpace(metadata.Process) == "" && existingName != "" {
			metadata.Process = existingName
		}
		if strings.TrimSpace(metadata.ProcessPath) == "" && existingPath != "" {
			metadata.ProcessPath = existingPath
		}
		if strings.TrimSpace(metadata.ProcessPathSnake) == "" && existingPath != "" {
			metadata.ProcessPathSnake = existingPath
		}
		needName := strings.TrimSpace(metadata.ProcessName) == "" || strings.TrimSpace(metadata.Process) == ""
		needPath := strings.TrimSpace(metadata.ProcessPath) == "" || strings.TrimSpace(metadata.ProcessPathSnake) == ""
		if !needName && !needPath {
			continue
		}

		owner := resolveWindowsMonitorSocketOwner(bestPID, ownerCache)
		if needPath && owner.Path != "" {
			if strings.TrimSpace(metadata.ProcessPath) == "" {
				metadata.ProcessPath = owner.Path
			}
			if strings.TrimSpace(metadata.ProcessPathSnake) == "" {
				metadata.ProcessPathSnake = owner.Path
			}
		}
		if needName && owner.Name != "" {
			if strings.TrimSpace(metadata.ProcessName) == "" {
				metadata.ProcessName = owner.Name
			}
			if strings.TrimSpace(metadata.Process) == "" {
				metadata.Process = owner.Name
			}
		}
	}
}

func resolveWindowsMonitorSocketOwner(
	pid uint32,
	cache map[uint32]windowsMonitorSocketOwner,
) windowsMonitorSocketOwner {
	if owner, ok := cache[pid]; ok {
		return owner
	}
	owner := windowsMonitorSocketOwner{PID: int64(pid)}
	path, err := readWindowsMonitorProcessPath(pid)
	if err == nil {
		owner.Path = strings.TrimSpace(path)
	}
	if owner.Path != "" {
		owner.Name = strings.TrimSpace(filepath.Base(owner.Path))
	}
	cache[pid] = owner
	return owner
}

func readWindowsMonitorProcessPath(pid uint32) (string, error) {
	switch pid {
	case 0:
		return ":System Idle Process", nil
	case 4:
		return ":System", nil
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	size := uint32(syscall.MAX_LONG_PATH)
	buffer := make([]uint16, syscall.MAX_LONG_PATH)
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buffer[:size]), nil
}
