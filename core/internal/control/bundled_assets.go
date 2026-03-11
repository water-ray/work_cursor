package control

import (
	"embed"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	embeddedVersionAssetPath        = "embedded/VERSION"
	embeddedDefaultConfigAssetRoot  = "embedded/default-config"
	embeddedDefaultStateAssetPath   = embeddedDefaultConfigAssetRoot + "/waterayd_state.json"
	embeddedRuleSetAssetRoot        = embeddedDefaultConfigAssetRoot + "/rule-set"
	embeddedSystemDefaultConfigPath = "__embedded__/default-config/waterayd_state.json"
)

// bundledReleaseAssetsEnabled is set to "1" by desktop release builds.
var bundledReleaseAssetsEnabled string

//go:embed embedded/default-config embedded/VERSION
var bundledReleaseAssetsFS embed.FS

func bundledReleaseAssetsActive() bool {
	return strings.TrimSpace(bundledReleaseAssetsEnabled) == "1"
}

func ResolveBundledReleaseVersion() (string, bool) {
	if !bundledReleaseAssetsActive() {
		return "", false
	}
	content, err := bundledReleaseAssetsFS.ReadFile(embeddedVersionAssetPath)
	if err != nil {
		return "", false
	}
	version := strings.TrimSpace(string(content))
	if version == "" {
		return "", false
	}
	return version, true
}

func readEmbeddedBundledDefaultState() ([]byte, bool, error) {
	return readEmbeddedBundledAsset(embeddedDefaultStateAssetPath)
}

func readEmbeddedBundledRuleSetFile(fileName string) ([]byte, bool, error) {
	normalizedFileName := strings.TrimSpace(fileName)
	if normalizedFileName == "" {
		return nil, false, nil
	}
	return readEmbeddedBundledAsset(path.Join(embeddedRuleSetAssetRoot, normalizedFileName))
}

func readEmbeddedBundledAsset(assetPath string) ([]byte, bool, error) {
	if !bundledReleaseAssetsActive() {
		return nil, false, nil
	}
	normalizedPath := path.Clean(strings.TrimSpace(assetPath))
	if normalizedPath == "." || normalizedPath == "" {
		return nil, false, nil
	}
	content, err := bundledReleaseAssetsFS.ReadFile(normalizedPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return content, true, nil
}

func hasEmbeddedSystemDefaultConfigPath(candidate string) bool {
	return strings.EqualFold(
		filepath.Clean(strings.TrimSpace(candidate)),
		filepath.Clean(embeddedSystemDefaultConfigPath),
	)
}

func copyEmbeddedBundledRuleSetFileToLocal(fileName string, targetPath string) (os.FileInfo, bool) {
	trimmedTargetPath := strings.TrimSpace(targetPath)
	if trimmedTargetPath == "" {
		return nil, false
	}
	content, ok, err := readEmbeddedBundledRuleSetFile(fileName)
	if err != nil || !ok {
		return nil, false
	}
	if err := os.MkdirAll(filepath.Dir(trimmedTargetPath), 0o755); err != nil {
		return nil, false
	}
	if err := os.WriteFile(trimmedTargetPath, content, 0o644); err != nil {
		return nil, false
	}
	fileInfo, err := os.Stat(trimmedTargetPath)
	if err != nil || fileInfo.IsDir() || fileInfo.Size() <= 0 {
		return nil, false
	}
	return fileInfo, true
}

func copyEmbeddedBundledRuleSetStorageToLocal(targetDir string) error {
	trimmedTargetDir := strings.TrimSpace(targetDir)
	if trimmedTargetDir == "" || !bundledReleaseAssetsActive() {
		return fs.ErrNotExist
	}
	copiedFiles := 0
	walkErr := fs.WalkDir(bundledReleaseAssetsFS, embeddedRuleSetAssetRoot, func(
		entryPath string,
		entry fs.DirEntry,
		err error,
	) error {
		if err != nil {
			return err
		}
		if entryPath == embeddedRuleSetAssetRoot {
			return nil
		}
		relativePath := strings.TrimPrefix(entryPath, embeddedRuleSetAssetRoot+"/")
		if relativePath == entryPath || strings.TrimSpace(relativePath) == "" {
			return nil
		}
		targetPath := filepath.Join(trimmedTargetDir, filepath.FromSlash(relativePath))
		if entry.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}
		content, readErr := bundledReleaseAssetsFS.ReadFile(entryPath)
		if readErr != nil {
			return readErr
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, content, 0o644); err != nil {
			return err
		}
		copiedFiles++
		return nil
	})
	if walkErr != nil {
		if errors.Is(walkErr, fs.ErrNotExist) {
			return fs.ErrNotExist
		}
		return walkErr
	}
	if copiedFiles == 0 {
		return fs.ErrNotExist
	}
	return nil
}
