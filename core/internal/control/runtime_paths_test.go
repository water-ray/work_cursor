package control

import (
	"path/filepath"
	"testing"
)

func TestResolveWaterayPathsUseDataRootEnv(t *testing.T) {
	dataRoot := filepath.Join(string(filepath.Separator), "tmp", "wateray-data-root-test")
	t.Setenv(waterayDataRootEnvName, dataRoot)

	if got := resolveWaterayDataRoot(); got != filepath.Clean(dataRoot) {
		t.Fatalf("expected data root %q, got %q", filepath.Clean(dataRoot), got)
	}
	if got := resolveStateFile(); got != filepath.Join(filepath.Clean(dataRoot), "waterayd_state.json") {
		t.Fatalf("unexpected state file path: %q", got)
	}
	if got := resolveRuntimeLogRootDir(); got != filepath.Join(filepath.Clean(dataRoot), "Log") {
		t.Fatalf("unexpected runtime log root dir: %q", got)
	}
	if got := resolveDNSCacheFilePath(); got != filepath.Join(filepath.Clean(dataRoot), "singbox-cache.db") {
		t.Fatalf("unexpected DNS cache file path: %q", got)
	}
	if got := resolveRuleSetStorageDir(); got != filepath.Join(filepath.Clean(dataRoot), "rule-set") {
		t.Fatalf("unexpected rule-set storage dir: %q", got)
	}
}
