//go:build darwin

package control

import (
	"reflect"
	"testing"
)

func TestParseDarwinNetworkServicesSkipsDisabledServices(t *testing.T) {
	raw := `
An asterisk (*) denotes that a network service is disabled.
Wi-Fi
USB 10/100/1000 LAN
*Thunderbolt Bridge

`
	got := parseDarwinNetworkServices(raw)
	want := []string{"Wi-Fi", "USB 10/100/1000 LAN"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected services: got=%v want=%v", got, want)
	}
}

func TestBuildDarwinShellCommandQuotesArgs(t *testing.T) {
	got := buildDarwinShellCommand([]string{
		darwinNetworkSetupPath,
		"-setwebproxy",
		"Wi-Fi",
		"127.0.0.1",
		"7890",
	})
	want := "'/usr/sbin/networksetup' '-setwebproxy' 'Wi-Fi' '127.0.0.1' '7890'"
	if got != want {
		t.Fatalf("unexpected command: got=%q want=%q", got, want)
	}
}
