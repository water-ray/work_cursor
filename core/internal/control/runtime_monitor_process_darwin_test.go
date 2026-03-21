//go:build darwin

package control

import (
	"net/netip"
	"testing"
)

func TestBuildDarwinMonitorConnectionQueriesKeepsMissingPIDWhenPathExists(t *testing.T) {
	queries := buildDarwinMonitorConnectionQueries([]clashConnectionRecord{
		{
			Metadata: clashConnectionMetadata{
				Network:     "tcp",
				SourceIP:    "127.0.0.1",
				SourcePort:  52345,
				ProcessPath: "/Applications/Cursor.app/Contents/MacOS/Cursor",
			},
		},
	})
	if len(queries) != 1 {
		t.Fatalf("expected query to be kept when pid is missing, got %d", len(queries))
	}
	if queries[0].LocalPort != 52345 {
		t.Fatalf("expected local port to be preserved, got %+v", queries[0])
	}
}

func TestApplyDarwinMonitorProcessInfoFromExistingPIDUsesProcessPathReader(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					ProcessID: 321,
				},
			},
		},
	}
	restore := stubDarwinMonitorProcessPathReader(t, func(pid uint32) (string, error) {
		if pid != 321 {
			t.Fatalf("expected pid 321, got %d", pid)
		}
		return "/Applications/Cursor.app/Contents/MacOS/Cursor", nil
	})
	defer restore()

	applyDarwinMonitorProcessInfoFromExistingPID(snapshot, map[uint32]darwinMonitorSocketOwner{})

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessPath != "/Applications/Cursor.app/Contents/MacOS/Cursor" ||
		metadata.ProcessPathSnake != "/Applications/Cursor.app/Contents/MacOS/Cursor" {
		t.Fatalf("expected process path to be populated from pid, got %+v", metadata)
	}
	if metadata.ProcessName != "Cursor" || metadata.Process != "Cursor" {
		t.Fatalf("expected process name derived from path, got %+v", metadata)
	}
}

func TestApplyDarwinMonitorProcessOwnersUsesExactLocalSocket(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					Network:    "tcp",
					SourceIP:   "127.0.0.1",
					SourcePort: 52345,
				},
			},
		},
	}
	queries := buildDarwinMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []darwinMonitorSocketEntry{
		{
			Protocol:  "tcp",
			LocalIP:   mustParseDarwinMonitorAddr(t, "127.0.0.1"),
			LocalPort: 40000,
			PID:       111,
			IsIPv4:    true,
		},
		{
			Protocol:  "tcp",
			LocalIP:   mustParseDarwinMonitorAddr(t, "127.0.0.1"),
			LocalPort: 52345,
			PID:       222,
			IsIPv4:    true,
		},
	}
	restore := stubDarwinMonitorProcessPathReader(t, func(pid uint32) (string, error) {
		if pid != 222 {
			t.Fatalf("expected pid 222, got %d", pid)
		}
		return "/Applications/Cursor.app/Contents/MacOS/Cursor", nil
	})
	defer restore()

	applyDarwinMonitorProcessOwners(snapshot, queries, socketEntries, map[uint32]darwinMonitorSocketOwner{})

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 222 || metadata.ProcessIDSnake != 222 {
		t.Fatalf("expected exact tuple owner pid=222, got %+v", metadata)
	}
	if metadata.ProcessName != "Cursor" || metadata.Process != "Cursor" {
		t.Fatalf("expected process name to be derived from path, got %+v", metadata)
	}
	if metadata.ProcessPath != "/Applications/Cursor.app/Contents/MacOS/Cursor" ||
		metadata.ProcessPathSnake != "/Applications/Cursor.app/Contents/MacOS/Cursor" {
		t.Fatalf("expected process path to be populated, got %+v", metadata)
	}
}

func TestApplyDarwinMonitorProcessOwnersSkipsAmbiguousMatches(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					Network:    "udp",
					SourcePort: 5353,
				},
			},
		},
	}
	queries := buildDarwinMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []darwinMonitorSocketEntry{
		{
			Protocol:  "udp",
			LocalPort: 5353,
			PID:       111,
			IsIPv4:    true,
		},
		{
			Protocol:  "udp",
			LocalPort: 5353,
			PID:       222,
			IsIPv4:    false,
		},
	}

	applyDarwinMonitorProcessOwners(snapshot, queries, socketEntries, map[uint32]darwinMonitorSocketOwner{})

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 0 || metadata.ProcessIDSnake != 0 {
		t.Fatalf("expected ambiguous match to be skipped, got %+v", metadata)
	}
	if metadata.ProcessName != "" || metadata.ProcessPath != "" {
		t.Fatalf("expected ambiguous match to keep process info empty, got %+v", metadata)
	}
}

func stubDarwinMonitorProcessPathReader(
	t *testing.T,
	reader func(pid uint32) (string, error),
) func() {
	t.Helper()
	previous := darwinMonitorProcessPathReader
	darwinMonitorProcessPathReader = reader
	return func() {
		darwinMonitorProcessPathReader = previous
	}
}

func mustParseDarwinMonitorAddr(t *testing.T, raw string) netip.Addr {
	t.Helper()
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		t.Fatalf("parse addr %q failed: %v", raw, err)
	}
	return addr
}
