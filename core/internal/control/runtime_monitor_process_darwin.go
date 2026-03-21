//go:build darwin

package control

import (
	"encoding/binary"
	"net"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	minimumDarwinMonitorSocketMatchScore = 8
	darwinMonitorProcPIDPathInfo         = 0xb
	darwinMonitorProcPIDPathInfoSize     = 1024
	darwinMonitorProcCallNumPIDInfo      = 0x2
)

var (
	darwinMonitorPCBStructSize = func() int {
		value, _ := syscall.Sysctl("kern.osrelease")
		major, _, _ := strings.Cut(value, ".")
		n, _ := strconv.ParseInt(major, 10, 64)
		switch {
		case n >= 22:
			return 408
		default:
			return 384
		}
	}()
	darwinMonitorProcessPathReader = readDarwinMonitorProcessPath
)

type darwinMonitorConnectionQuery struct {
	ConnectionIndex int
	Protocol        string
	LocalIP         netip.Addr
	LocalPort       int
}

type darwinMonitorSocketEntry struct {
	Protocol  string
	LocalIP   netip.Addr
	LocalPort int
	PID       uint32
	IsIPv4    bool
}

type darwinMonitorSocketOwner struct {
	PID  int64
	Name string
	Path string
}

func enrichMonitorConnectionsProcessInfo(snapshot *clashConnectionsSnapshot) {
	if snapshot == nil || len(snapshot.Connections) == 0 {
		return
	}
	ownerCache := map[uint32]darwinMonitorSocketOwner{}
	applyDarwinMonitorProcessInfoFromExistingPID(snapshot, ownerCache)
	queries := buildDarwinMonitorConnectionQueries(snapshot.Connections)
	if len(queries) == 0 {
		return
	}
	socketEntries := collectDarwinMonitorSocketEntries(queries)
	if len(socketEntries) == 0 {
		return
	}
	applyDarwinMonitorProcessOwners(snapshot, queries, socketEntries, ownerCache)
}

func applyDarwinMonitorProcessInfoFromExistingPID(
	snapshot *clashConnectionsSnapshot,
	ownerCache map[uint32]darwinMonitorSocketOwner,
) {
	if snapshot == nil {
		return
	}
	for index := range snapshot.Connections {
		metadata := &snapshot.Connections[index].Metadata
		pid := uint32(maxInt64(metadata.ProcessID, metadata.ProcessIDSnake))
		if pid == 0 {
			continue
		}
		if metadata.ProcessID <= 0 {
			metadata.ProcessID = int64(pid)
		}
		if metadata.ProcessIDSnake <= 0 {
			metadata.ProcessIDSnake = int64(pid)
		}
		applyDarwinMonitorProcessOwnerToMetadata(metadata, resolveDarwinMonitorSocketOwner(pid, ownerCache))
	}
}

func buildDarwinMonitorConnectionQueries(connections []clashConnectionRecord) []darwinMonitorConnectionQuery {
	queries := make([]darwinMonitorConnectionQuery, 0, len(connections))
	for index, connection := range connections {
		metadata := connection.Metadata
		if maxInt64(metadata.ProcessID, metadata.ProcessIDSnake) > 0 {
			continue
		}
		protocol := normalizeDarwinMonitorNetwork(metadata.Network)
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
		localIP := normalizeDarwinMonitorIP(firstNonEmpty(
			strings.TrimSpace(metadata.SourceIP),
			strings.TrimSpace(metadata.SourceIPSnake),
		))
		queries = append(queries, darwinMonitorConnectionQuery{
			ConnectionIndex: index,
			Protocol:        protocol,
			LocalIP:         localIP,
			LocalPort:       localPort,
		})
	}
	return queries
}

func normalizeDarwinMonitorNetwork(value string) string {
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

func normalizeDarwinMonitorIP(value string) netip.Addr {
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

func collectDarwinMonitorSocketEntries(queries []darwinMonitorConnectionQuery) []darwinMonitorSocketEntry {
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
	entries := make([]darwinMonitorSocketEntry, 0, len(queries))
	if hasTCP {
		entries = append(entries, readDarwinMonitorSocketTable("net.inet.tcp.pcblist_n", "tcp", queries)...)
	}
	if hasUDP {
		entries = append(entries, readDarwinMonitorSocketTable("net.inet.udp.pcblist_n", "udp", queries)...)
	}
	return entries
}

func readDarwinMonitorSocketTable(
	sysctlPath string,
	protocol string,
	queries []darwinMonitorConnectionQuery,
) []darwinMonitorSocketEntry {
	buf, err := unix.SysctlRaw(sysctlPath)
	if err != nil || len(buf) <= 24 {
		return nil
	}
	itemSize := darwinMonitorPCBStructSize
	if protocol == "tcp" {
		// xtcpcb_n is appended ahead of xinpcb_n for TCP sockets.
		itemSize += 208
	}
	entries := make([]darwinMonitorSocketEntry, 0, len(queries))
	for index := 24; index+itemSize <= len(buf); index += itemSize {
		inpOffset := index
		soOffset := index + 104
		localPort := int(binary.BigEndian.Uint16(buf[inpOffset+18 : inpOffset+20]))
		if localPort <= 0 {
			continue
		}
		flags := buf[inpOffset+44]
		entry := darwinMonitorSocketEntry{
			Protocol:  protocol,
			LocalPort: localPort,
			PID:       binary.LittleEndian.Uint32(buf[soOffset+68 : soOffset+72]),
		}
		switch {
		case flags&0x1 > 0:
			var raw [4]byte
			copy(raw[:], buf[inpOffset+76:inpOffset+80])
			entry.LocalIP = normalizeDarwinMonitorTableAddr(netip.AddrFrom4(raw))
			entry.IsIPv4 = true
		case flags&0x2 > 0:
			var raw [16]byte
			copy(raw[:], buf[inpOffset+64:inpOffset+80])
			entry.LocalIP = normalizeDarwinMonitorTableAddr(netip.AddrFrom16(raw))
		default:
			continue
		}
		if entry.PID == 0 {
			continue
		}
		if maxDarwinMonitorSocketMatchScore(entry, queries) < minimumDarwinMonitorSocketMatchScore {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func normalizeDarwinMonitorTableAddr(addr netip.Addr) netip.Addr {
	if !addr.IsValid() {
		return netip.Addr{}
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() {
		return netip.Addr{}
	}
	return addr
}

func maxDarwinMonitorSocketMatchScore(
	entry darwinMonitorSocketEntry,
	queries []darwinMonitorConnectionQuery,
) int {
	best := 0
	for _, query := range queries {
		score := scoreDarwinMonitorSocketMatch(entry, query)
		if score > best {
			best = score
		}
	}
	return best
}

func scoreDarwinMonitorSocketMatch(
	entry darwinMonitorSocketEntry,
	query darwinMonitorConnectionQuery,
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
		if entry.LocalIP.IsValid() {
			if entry.LocalIP != query.LocalIP {
				return 0
			}
			score++
		} else if entry.IsIPv4 != query.LocalIP.Is4() {
			return 0
		}
	}
	return score
}

func applyDarwinMonitorProcessOwners(
	snapshot *clashConnectionsSnapshot,
	queries []darwinMonitorConnectionQuery,
	socketEntries []darwinMonitorSocketEntry,
	ownerCache map[uint32]darwinMonitorSocketOwner,
) {
	if snapshot == nil {
		return
	}
	for _, query := range queries {
		if query.ConnectionIndex < 0 || query.ConnectionIndex >= len(snapshot.Connections) {
			continue
		}
		bestScore := 0
		var bestPID uint32
		unique := true
		for _, entry := range socketEntries {
			score := scoreDarwinMonitorSocketMatch(entry, query)
			if score < minimumDarwinMonitorSocketMatchScore || entry.PID == 0 {
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
		if bestScore < minimumDarwinMonitorSocketMatchScore || !unique || bestPID == 0 {
			continue
		}
		metadata := &snapshot.Connections[query.ConnectionIndex].Metadata
		if metadata.ProcessID <= 0 {
			metadata.ProcessID = int64(bestPID)
		}
		if metadata.ProcessIDSnake <= 0 {
			metadata.ProcessIDSnake = int64(bestPID)
		}
		applyDarwinMonitorProcessOwnerToMetadata(metadata, resolveDarwinMonitorSocketOwner(bestPID, ownerCache))
	}
}

func applyDarwinMonitorProcessOwnerToMetadata(
	metadata *clashConnectionMetadata,
	owner darwinMonitorSocketOwner,
) {
	if metadata == nil {
		return
	}
	existingPath := firstNonEmpty(
		strings.TrimSpace(metadata.ProcessPath),
		strings.TrimSpace(metadata.ProcessPathSnake),
	)
	existingName := firstNonEmpty(
		strings.TrimSpace(metadata.ProcessName),
		strings.TrimSpace(metadata.Process),
	)
	if existingName == "" && existingPath != "" {
		existingName = strings.TrimSpace(filepath.Base(existingPath))
	}
	if existingPath == "" && owner.Path != "" {
		existingPath = owner.Path
	}
	if existingName == "" && owner.Name != "" {
		existingName = owner.Name
	}
	if strings.TrimSpace(metadata.ProcessPath) == "" && existingPath != "" {
		metadata.ProcessPath = existingPath
	}
	if strings.TrimSpace(metadata.ProcessPathSnake) == "" && existingPath != "" {
		metadata.ProcessPathSnake = existingPath
	}
	if strings.TrimSpace(metadata.ProcessName) == "" && existingName != "" {
		metadata.ProcessName = existingName
	}
	if strings.TrimSpace(metadata.Process) == "" && existingName != "" {
		metadata.Process = existingName
	}
}

func resolveDarwinMonitorSocketOwner(
	pid uint32,
	cache map[uint32]darwinMonitorSocketOwner,
) darwinMonitorSocketOwner {
	if owner, ok := cache[pid]; ok {
		return owner
	}
	owner := darwinMonitorSocketOwner{PID: int64(pid)}
	path, err := darwinMonitorProcessPathReader(pid)
	if err == nil {
		owner.Path = strings.TrimSpace(path)
	}
	if owner.Path != "" {
		owner.Name = strings.TrimSpace(filepath.Base(owner.Path))
	}
	if cache != nil {
		cache[pid] = owner
	}
	return owner
}

func readDarwinMonitorProcessPath(pid uint32) (string, error) {
	if pid == 0 {
		return "", syscall.EINVAL
	}
	buffer := make([]byte, darwinMonitorProcPIDPathInfoSize)
	_, _, errno := syscall.Syscall6(
		syscall.SYS_PROC_INFO,
		uintptr(darwinMonitorProcCallNumPIDInfo),
		uintptr(pid),
		uintptr(darwinMonitorProcPIDPathInfo),
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(darwinMonitorProcPIDPathInfoSize),
	)
	if errno != 0 {
		return "", errno
	}
	return strings.TrimSpace(unix.ByteSliceToString(buffer)), nil
}
