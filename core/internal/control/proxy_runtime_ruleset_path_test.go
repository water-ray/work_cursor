package control

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatBuiltInRuleSetPathFindsElectronAppBundledRuleSetInWorkspace(t *testing.T) {
	tempDir := t.TempDir()
	repoDir := filepath.Join(tempDir, "repo")
	coreDir := filepath.Join(repoDir, "core")
	bundledRuleSetPath := filepath.Join(repoDir, "ElectronApp", "rule-set", "geosite-google.srs")
	if err := os.MkdirAll(filepath.Dir(bundledRuleSetPath), 0o755); err != nil {
		t.Fatalf("create bundled rule-set dir failed: %v", err)
	}
	if err := os.MkdirAll(coreDir, 0o755); err != nil {
		t.Fatalf("create core dir failed: %v", err)
	}
	if err := os.WriteFile(bundledRuleSetPath, []byte("test-rule-set"), 0o644); err != nil {
		t.Fatalf("write bundled rule-set failed: %v", err)
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

	resolvedPath, fileInfo, ok := statBuiltInRuleSetPath("geosite", "google")
	if !ok {
		t.Fatalf("expected workspace ElectronApp rule-set to be found")
	}
	if fileInfo == nil || fileInfo.Size() <= 0 {
		t.Fatalf("expected non-empty rule-set file info")
	}
	matchedBundled := strings.EqualFold(filepath.Clean(resolvedPath), filepath.Clean(bundledRuleSetPath))
	matchedCopied := strings.HasSuffix(strings.ToLower(filepath.Clean(resolvedPath)), strings.ToLower(filepath.Join("wateray", "rule-set", "geosite-google.srs")))
	if !matchedBundled && !matchedCopied {
		t.Fatalf("expected resolved path to use bundled or copied local rule-set, got %s", resolvedPath)
	}
}
