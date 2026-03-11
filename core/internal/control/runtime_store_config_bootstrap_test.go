package control

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadWithExecutablePathPrefersStateFile(t *testing.T) {
	tempDir := t.TempDir()
	executablePath := filepath.Join(tempDir, "Wateray", "core", "WaterayServer.exe")
	stateFile := filepath.Join(tempDir, "user", "waterayd_state.json")
	bundledStateFile := filepath.Join(
		tempDir,
		"Wateray",
		"default-config",
		"waterayd_state.json",
	)

	primarySnapshot := defaultSnapshot("primary-runtime", "1.2.3")
	primarySnapshot.LocalProxyPort = 6101
	primarySnapshot.AutoConnect = false
	primarySnapshot.ProxyLogs = []RuntimeLogEntry{{TimestampMS: 1, Level: LogLevelInfo, Message: "from-primary"}}
	if err := persistSnapshotToFile(stateFile, primarySnapshot); err != nil {
		t.Fatalf("persist primary snapshot failed: %v", err)
	}

	bundledSnapshot := defaultSnapshot("bundled-runtime", "1.2.3")
	bundledSnapshot.LocalProxyPort = 6202
	if err := persistSnapshotToFile(bundledStateFile, bundledSnapshot); err != nil {
		t.Fatalf("persist bundled snapshot failed: %v", err)
	}

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     defaultSnapshot("default-runtime", "1.2.3"),
	}
	source, err := store.loadWithExecutablePath(executablePath)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if source != stateBootstrapSourceAppState {
		t.Fatalf("expected source=%s, got=%s", stateBootstrapSourceAppState, source)
	}
	if store.state.LocalProxyPort != primarySnapshot.LocalProxyPort {
		t.Fatalf("expected state file to win, got port=%d", store.state.LocalProxyPort)
	}
	if len(store.state.ProxyLogs) != 0 {
		t.Fatalf("runtime logs should be stripped after load")
	}
}

func TestLoadWithExecutablePathUsesBundledDefaultWhenStateMissing(t *testing.T) {
	tempDir := t.TempDir()
	executablePath := filepath.Join(tempDir, "Wateray", "core", "WaterayServer.exe")
	stateFile := filepath.Join(tempDir, "user", "waterayd_state.json")
	dataRoot := filepath.Join(tempDir, "appdata", "wateray")
	bundledStateFile := filepath.Join(
		tempDir,
		"Wateray",
		"default-config",
		"waterayd_state.json",
	)
	bundledRuleSetFile := filepath.Join(
		tempDir,
		"Wateray",
		"default-config",
		"rule-set",
		"geosite-google.srs",
	)

	bundledSnapshot := defaultSnapshot("bundled-runtime", "1.2.3")
	bundledSnapshot.LocalProxyPort = 6202
	bundledSnapshot.AutoConnect = false
	if err := persistSnapshotToFile(bundledStateFile, bundledSnapshot); err != nil {
		t.Fatalf("persist bundled snapshot failed: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(bundledRuleSetFile), 0o755); err != nil {
		t.Fatalf("create bundled rule-set dir failed: %v", err)
	}
	if err := os.WriteFile(bundledRuleSetFile, []byte("bundled-rule-set"), 0o644); err != nil {
		t.Fatalf("write bundled rule-set failed: %v", err)
	}
	previousDataRoot := os.Getenv(waterayDataRootEnvName)
	if err := os.Setenv(waterayDataRootEnvName, dataRoot); err != nil {
		t.Fatalf("set data root failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Setenv(waterayDataRootEnvName, previousDataRoot)
	})

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     defaultSnapshot("default-runtime", "1.2.3"),
	}
	source, err := store.loadWithExecutablePath(executablePath)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if source != stateBootstrapSourceBundledDefault {
		t.Fatalf("expected source=%s, got=%s", stateBootstrapSourceBundledDefault, source)
	}
	if store.state.LocalProxyPort != bundledSnapshot.LocalProxyPort {
		t.Fatalf("expected bundled default snapshot to be loaded, got port=%d", store.state.LocalProxyPort)
	}
	if store.state.AutoConnect != bundledSnapshot.AutoConnect {
		t.Fatalf("expected bundled default fields applied")
	}
	loadedCopy, err := loadSnapshotFromFile(stateFile, defaultSnapshot("verify-runtime", "1.2.3"))
	if err != nil {
		t.Fatalf("expected bundled default to be copied to state file: %v", err)
	}
	if loadedCopy.LocalProxyPort != bundledSnapshot.LocalProxyPort {
		t.Fatalf("expected copied state file to match bundled default, got port=%d", loadedCopy.LocalProxyPort)
	}
	localRuleSetFile := filepath.Join(dataRoot, "rule-set", "geosite-google.srs")
	localRuleSet, err := os.ReadFile(localRuleSetFile)
	if err != nil {
		t.Fatalf("expected bundled rule-set to seed app data dir: %v", err)
	}
	if string(localRuleSet) != "bundled-rule-set" {
		t.Fatalf("expected seeded rule-set content to match bundled default, got %q", string(localRuleSet))
	}
}

func TestLoadWithExecutablePathFallsBackToKernelDefaultWhenBundledMissing(t *testing.T) {
	tempDir := t.TempDir()
	executablePath := filepath.Join(tempDir, "Wateray", "core", "WaterayServer.exe")
	stateFile := filepath.Join(tempDir, "user", "waterayd_state.json")

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     defaultSnapshot("default-runtime", "1.2.3"),
	}
	expectedPort := store.state.LocalProxyPort
	expectedAutoConnect := store.state.AutoConnect
	source, err := store.loadWithExecutablePath(executablePath)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if source != stateBootstrapSourceKernelDefault {
		t.Fatalf("expected source=%s, got=%s", stateBootstrapSourceKernelDefault, source)
	}
	if store.state.LocalProxyPort != expectedPort {
		t.Fatalf("expected kernel default snapshot to remain, got port=%d", store.state.LocalProxyPort)
	}
	if store.state.AutoConnect != expectedAutoConnect {
		t.Fatalf("expected kernel default autoConnect to remain")
	}
}

func TestLoadWithExecutablePathMigratesBundledLegacySchema(t *testing.T) {
	tempDir := t.TempDir()
	executablePath := filepath.Join(tempDir, "Wateray", "core", "WaterayServer.exe")
	stateFile := filepath.Join(tempDir, "user", "waterayd_state.json")
	bundledStateFile := filepath.Join(
		tempDir,
		"Wateray",
		"default-config",
		"waterayd_state.json",
	)

	bundledSnapshot := defaultSnapshot("bundled-runtime", "1.2.3")
	bundledSnapshot.SchemaVersion = 14
	bundledSnapshot.ProbeSettings = ProbeSettings{}
	bundledSnapshot.ProxyLogs = []RuntimeLogEntry{{TimestampMS: 1, Level: LogLevelInfo, Message: "legacy-log"}}
	if err := persistSnapshotToFile(bundledStateFile, bundledSnapshot); err != nil {
		t.Fatalf("persist bundled snapshot failed: %v", err)
	}

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     defaultSnapshot("default-runtime", "1.2.3"),
	}
	source, err := store.loadWithExecutablePath(executablePath)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if source != stateBootstrapSourceBundledDefault {
		t.Fatalf("expected source=%s, got=%s", stateBootstrapSourceBundledDefault, source)
	}
	if store.state.SchemaVersion != currentSnapshotSchemaVersion {
		t.Fatalf("expected schema migrated to %d, got %d", currentSnapshotSchemaVersion, store.state.SchemaVersion)
	}
	if store.state.ProbeSettings.Concurrency != defaultProbeConcurrency {
		t.Fatalf("expected migrated probe concurrency default %d, got %d", defaultProbeConcurrency, store.state.ProbeSettings.Concurrency)
	}
	if len(store.state.ProxyLogs) != 0 {
		t.Fatalf("runtime logs should be stripped after load")
	}
}

func TestLoadWithExecutablePathSkipsBundledFutureSchema(t *testing.T) {
	tempDir := t.TempDir()
	executablePath := filepath.Join(tempDir, "Wateray", "core", "WaterayServer.exe")
	stateFile := filepath.Join(tempDir, "user", "waterayd_state.json")
	bundledStateFile := filepath.Join(
		tempDir,
		"Wateray",
		"default-config",
		"waterayd_state.json",
	)

	bundledSnapshot := defaultSnapshot("bundled-runtime", "1.2.3")
	bundledSnapshot.SchemaVersion = currentSnapshotSchemaVersion + 1
	bundledSnapshot.LocalProxyPort = 6202
	if err := persistSnapshotToFile(bundledStateFile, bundledSnapshot); err != nil {
		t.Fatalf("persist bundled snapshot failed: %v", err)
	}

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     defaultSnapshot("default-runtime", "1.2.3"),
	}
	expectedPort := store.state.LocalProxyPort
	source, err := store.loadWithExecutablePath(executablePath)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if source != stateBootstrapSourceKernelDefault {
		t.Fatalf("expected source=%s, got=%s", stateBootstrapSourceKernelDefault, source)
	}
	if store.state.LocalProxyPort != expectedPort {
		t.Fatalf("expected future-schema bundled snapshot to be ignored")
	}
}

func TestResolveBundledDefaultStateFileCandidatesIncludesTauriAppDirFromWorkspace(t *testing.T) {
	tempDir := t.TempDir()
	repoDir := filepath.Join(tempDir, "repo")
	coreDir := filepath.Join(repoDir, "core")
	tauriDir := filepath.Join(repoDir, "TauriApp")
	if err := os.MkdirAll(filepath.Join(tauriDir, "default-config"), 0o755); err != nil {
		t.Fatalf("create tauri default-config dir failed: %v", err)
	}
	if err := os.MkdirAll(coreDir, 0o755); err != nil {
		t.Fatalf("create core dir failed: %v", err)
	}
	previousCWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd failed: %v", err)
	}
	if err := os.Chdir(coreDir); err != nil {
		t.Fatalf("chdir failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(previousCWD)
	})

	candidates := resolveBundledDefaultStateFileCandidates("")
	expected := filepath.Join(tauriDir, "default-config", "waterayd_state.json")
	for _, candidate := range candidates {
		if strings.EqualFold(filepath.Clean(candidate), filepath.Clean(expected)) {
			return
		}
	}
	t.Fatalf("expected candidates to include %s, got %v", expected, candidates)
}
