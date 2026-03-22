package control

import (
	"os"
	"path/filepath"
	"strings"
)

const waterayDataRootEnvName = "WATERAY_DATA_ROOT"

func resolveWaterayDataRoot() string {
	if value := strings.TrimSpace(os.Getenv(waterayDataRootEnvName)); value != "" {
		return filepath.Clean(value)
	}
	configDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(configDir) == "" {
		return filepath.Join(os.TempDir(), "wateray")
	}
	return filepath.Join(configDir, "wateray")
}

func ResolveWaterayDataRoot() string {
	return resolveWaterayDataRoot()
}

func resolveStateFile() string {
	return filepath.Join(resolveWaterayDataRoot(), "waterayd_state.json")
}

func resolveRuntimeLogRootDir() string {
	return filepath.Join(resolveWaterayDataRoot(), "Log")
}

func resolveDNSCacheFilePath() string {
	return filepath.Join(resolveWaterayDataRoot(), "singbox-cache.db")
}

func resolveRuleSetStorageDir() string {
	return filepath.Join(resolveWaterayDataRoot(), "rule-set")
}

func resolveRequestLogDir() string {
	return filepath.Join(resolveWaterayDataRoot(), "requestlogs")
}
