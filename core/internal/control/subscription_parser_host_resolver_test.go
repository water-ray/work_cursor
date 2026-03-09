package control

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestResolveAllowedSubscriptionHostIPsFallsBackToTrustedResolver(t *testing.T) {
	systemLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return []net.IP{net.ParseIP("10.128.0.62")}, nil
	}
	trustedLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return []net.IP{net.ParseIP("172.67.141.31")}, nil
	}

	ips, err := resolveAllowedSubscriptionHostIPs(
		context.Background(),
		"din.154641.xyz",
		systemLookup,
		trustedLookup,
	)
	if err != nil {
		t.Fatalf("expected trusted resolver fallback success, got %v", err)
	}
	if len(ips) != 1 || ips[0].String() != "172.67.141.31" {
		t.Fatalf("unexpected resolved ips: %#v", ips)
	}
}

func TestResolveAllowedSubscriptionHostIPsFallsBackWhenSystemResolverErrors(t *testing.T) {
	systemLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return nil, errors.New("system dns failed")
	}
	trustedLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return []net.IP{net.ParseIP("104.21.16.1")}, nil
	}

	ips, err := resolveAllowedSubscriptionHostIPs(
		context.Background(),
		"din.154641.xyz",
		systemLookup,
		trustedLookup,
	)
	if err != nil {
		t.Fatalf("expected trusted resolver fallback success after system error, got %v", err)
	}
	if len(ips) != 1 || ips[0].String() != "104.21.16.1" {
		t.Fatalf("unexpected resolved ips: %#v", ips)
	}
}

func TestResolveAllowedSubscriptionHostIPsRejectsWhenOnlyBlockedIPsRemain(t *testing.T) {
	systemLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return []net.IP{net.ParseIP("10.128.0.62")}, nil
	}
	trustedLookup := func(ctx context.Context, host string) ([]net.IP, error) {
		_ = ctx
		_ = host
		return []net.IP{net.ParseIP("192.168.0.10")}, nil
	}

	_, err := resolveAllowedSubscriptionHostIPs(
		context.Background(),
		"din.154641.xyz",
		systemLookup,
		trustedLookup,
	)
	if err == nil {
		t.Fatal("expected blocked-address error")
	}
	if !strings.Contains(err.Error(), "disallowed address") {
		t.Fatalf("expected disallowed-address error, got %v", err)
	}
}
