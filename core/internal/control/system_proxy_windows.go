//go:build windows

package control

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const internetSettingsRegistryPath = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

var (
	wininetDLL             = windows.NewLazySystemDLL("wininet.dll")
	internetSetOptionWProc = wininetDLL.NewProc("InternetSetOptionW")
)

func applySystemHTTPProxy(host string, port int) error {
	host = strings.TrimSpace(host)
	if host == "" || port <= 0 || port > 65535 {
		return errors.New("invalid system proxy host/port")
	}

	key, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		internetSettingsRegistryPath,
		registry.SET_VALUE,
	)
	if err != nil {
		return fmt.Errorf("open internet settings failed: %w", err)
	}
	defer key.Close()

	server := fmt.Sprintf("%s:%d", host, port)
	proxyServer := fmt.Sprintf("http=%s;https=%s", server, server)
	if err := key.SetDWordValue("ProxyEnable", 1); err != nil {
		return fmt.Errorf("set ProxyEnable failed: %w", err)
	}
	if err := key.SetStringValue("ProxyServer", proxyServer); err != nil {
		return fmt.Errorf("set ProxyServer failed: %w", err)
	}

	notifySystemProxyChanged()
	return nil
}

func clearSystemHTTPProxy() error {
	key, err := registry.OpenKey(
		registry.CURRENT_USER,
		internetSettingsRegistryPath,
		registry.SET_VALUE,
	)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil
		}
		return fmt.Errorf("open internet settings failed: %w", err)
	}
	defer key.Close()

	if err := key.SetDWordValue("ProxyEnable", 0); err != nil {
		return fmt.Errorf("disable ProxyEnable failed: %w", err)
	}
	notifySystemProxyChanged()
	return nil
}

func notifySystemProxyChanged() {
	const (
		internetOptionRefresh         = 37
		internetOptionSettingsChanged = 39
	)
	_, _, _ = internetSetOptionWProc.Call(
		0,
		uintptr(internetOptionSettingsChanged),
		0,
		0,
	)
	_, _, _ = internetSetOptionWProc.Call(
		0,
		uintptr(internetOptionRefresh),
		0,
		0,
	)
}
