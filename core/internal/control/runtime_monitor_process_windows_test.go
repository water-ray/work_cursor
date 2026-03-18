//go:build windows

package control

import (
	"net/netip"
	"testing"
)

func TestBuildWindowsMonitorConnectionQueriesKeepsMissingPIDWhenPathExists(t *testing.T) {
	queries := buildWindowsMonitorConnectionQueries([]clashConnectionRecord{
		{
			Metadata: clashConnectionMetadata{
				Network:         "tcp",
				SourceIP:        "127.0.0.1",
				SourcePort:      52345,
				DestinationIP:   "104.21.16.1",
				DestinationPort: 443,
				ProcessName:     "Netch.exe",
				ProcessPath:     `D:\Dawn Launcher\tools\Netch\Netch.exe`,
			},
		},
	})
	if len(queries) != 1 {
		t.Fatalf("expected query to be kept when pid is missing, got %d", len(queries))
	}
	if queries[0].LocalPort != 52345 || queries[0].RemotePort != 443 {
		t.Fatalf("expected ports to be preserved, got %+v", queries[0])
	}
}

func TestApplyWindowsMonitorProcessOwnersUsesExactTuple(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					Network:         "tcp",
					SourceIP:        "127.0.0.1",
					SourcePort:      52345,
					DestinationIP:   "104.21.16.1",
					DestinationPort: 443,
					ProcessName:     "Netch.exe",
					ProcessPath:     `D:\Dawn Launcher\tools\Netch\Netch.exe`,
				},
			},
		},
	}
	queries := buildWindowsMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []windowsMonitorSocketEntry{
		{
			Protocol:   "tcp",
			LocalIP:    mustParseWindowsMonitorAddr(t, "127.0.0.1"),
			LocalPort:  40000,
			RemoteIP:   mustParseWindowsMonitorAddr(t, "104.21.16.1"),
			RemotePort: 443,
			PID:        111,
		},
		{
			Protocol:   "tcp",
			LocalIP:    mustParseWindowsMonitorAddr(t, "127.0.0.1"),
			LocalPort:  52345,
			RemoteIP:   mustParseWindowsMonitorAddr(t, "104.21.16.1"),
			RemotePort: 443,
			PID:        222,
		},
	}

	applyWindowsMonitorProcessOwners(snapshot, queries, socketEntries)

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 222 || metadata.ProcessIDSnake != 222 {
		t.Fatalf("expected exact tuple owner pid=222, got %+v", metadata)
	}
	if metadata.ProcessName != "Netch.exe" || metadata.Process != "Netch.exe" {
		t.Fatalf("expected existing process name to be preserved, got %+v", metadata)
	}
	if metadata.ProcessPath != `D:\Dawn Launcher\tools\Netch\Netch.exe` ||
		metadata.ProcessPathSnake != `D:\Dawn Launcher\tools\Netch\Netch.exe` {
		t.Fatalf("expected existing process path to be preserved, got %+v", metadata)
	}
}

func TestApplyWindowsMonitorProcessOwnersSkipsAmbiguousMatches(t *testing.T) {
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
	queries := buildWindowsMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []windowsMonitorSocketEntry{
		{
			Protocol:  "udp",
			LocalIP:   mustParseWindowsMonitorAddr(t, "0.0.0.0"),
			LocalPort: 5353,
			PID:       111,
		},
		{
			Protocol:  "udp",
			LocalIP:   mustParseWindowsMonitorAddr(t, "::"),
			LocalPort: 5353,
			PID:       222,
		},
	}

	applyWindowsMonitorProcessOwners(snapshot, queries, socketEntries)

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 0 || metadata.ProcessIDSnake != 0 {
		t.Fatalf("expected ambiguous match to be skipped, got %+v", metadata)
	}
}

func mustParseWindowsMonitorAddr(t *testing.T, raw string) netip.Addr {
	t.Helper()
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		t.Fatalf("parse addr %q failed: %v", raw, err)
	}
	return addr
}
