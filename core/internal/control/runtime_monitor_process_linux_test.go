//go:build linux

package control

import "testing"

func TestParseLinuxMonitorProcSocketAddressIPv4(t *testing.T) {
	ip, port, err := parseLinuxMonitorProcSocketAddress("0100007F:0277", false)
	if err != nil {
		t.Fatalf("parse ipv4 proc socket address failed: %v", err)
	}
	if ip != "127.0.0.1" {
		t.Fatalf("expected ipv4 127.0.0.1, got %q", ip)
	}
	if port != 631 {
		t.Fatalf("expected port 631, got %d", port)
	}
}

func TestParseLinuxMonitorProcSocketAddressIPv6(t *testing.T) {
	ip, port, err := parseLinuxMonitorProcSocketAddress(
		"00000000000000000000000001000000:0277",
		true,
	)
	if err != nil {
		t.Fatalf("parse ipv6 proc socket address failed: %v", err)
	}
	if ip != "::1" {
		t.Fatalf("expected ipv6 ::1, got %q", ip)
	}
	if port != 631 {
		t.Fatalf("expected port 631, got %d", port)
	}
}

func TestApplyLinuxMonitorProcessOwnersUsesExactTuple(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					Network:         "tcp",
					SourcePort:      52345,
					DestinationIP:   "104.21.16.1",
					DestinationPort: 443,
				},
			},
		},
	}
	queries := buildLinuxMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []linuxMonitorSocketEntry{
		{
			Protocol:   "tcp",
			LocalPort:  40000,
			RemoteIP:   "104.21.16.1",
			RemotePort: 443,
			Inode:      "1",
		},
		{
			Protocol:   "tcp",
			LocalPort:  52345,
			RemoteIP:   "104.21.16.1",
			RemotePort: 443,
			Inode:      "2",
		},
	}
	owners := map[string]linuxMonitorSocketOwner{
		"1": {PID: 111, Name: "wrong", Path: "/usr/bin/wrong"},
		"2": {PID: 222, Name: "firefox", Path: "/usr/bin/firefox"},
	}

	applyLinuxMonitorProcessOwners(snapshot, queries, socketEntries, owners)

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 222 || metadata.ProcessIDSnake != 222 {
		t.Fatalf("expected exact tuple owner pid=222, got %+v", metadata)
	}
	if metadata.ProcessName != "firefox" || metadata.Process != "firefox" {
		t.Fatalf("expected firefox process name, got %+v", metadata)
	}
	if metadata.ProcessPath != "/usr/bin/firefox" || metadata.ProcessPathSnake != "/usr/bin/firefox" {
		t.Fatalf("expected firefox process path, got %+v", metadata)
	}
}

func TestApplyLinuxMonitorProcessOwnersSkipsAmbiguousMatches(t *testing.T) {
	snapshot := &clashConnectionsSnapshot{
		Connections: []clashConnectionRecord{
			{
				Metadata: clashConnectionMetadata{
					Network:         "tcp",
					DestinationIP:   "104.21.16.1",
					DestinationPort: 443,
				},
			},
		},
	}
	queries := buildLinuxMonitorConnectionQueries(snapshot.Connections)
	socketEntries := []linuxMonitorSocketEntry{
		{
			Protocol:   "tcp",
			LocalPort:  40000,
			RemoteIP:   "104.21.16.1",
			RemotePort: 443,
			Inode:      "1",
		},
		{
			Protocol:   "tcp",
			LocalPort:  40001,
			RemoteIP:   "104.21.16.1",
			RemotePort: 443,
			Inode:      "2",
		},
	}
	owners := map[string]linuxMonitorSocketOwner{
		"1": {PID: 111, Name: "alpha", Path: "/usr/bin/alpha"},
		"2": {PID: 222, Name: "beta", Path: "/usr/bin/beta"},
	}

	applyLinuxMonitorProcessOwners(snapshot, queries, socketEntries, owners)

	metadata := snapshot.Connections[0].Metadata
	if metadata.ProcessID != 0 || metadata.ProcessIDSnake != 0 {
		t.Fatalf("expected ambiguous match to be skipped, got %+v", metadata)
	}
	if metadata.ProcessName != "" || metadata.ProcessPath != "" {
		t.Fatalf("expected no process info on ambiguous match, got %+v", metadata)
	}
}
