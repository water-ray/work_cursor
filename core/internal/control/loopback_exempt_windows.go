//go:build windows

package control

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const appContainerMappingsRegistryPath = `Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings`

func exemptWindowsLoopbackRestrictions(ctx context.Context) (LoopbackExemptResult, error) {
	result := LoopbackExemptResult{}
	if _, err := exec.LookPath("CheckNetIsolation.exe"); err != nil {
		return result, fmt.Errorf("CheckNetIsolation.exe not found: %w", err)
	}
	key, err := registry.OpenKey(
		registry.CURRENT_USER,
		appContainerMappingsRegistryPath,
		registry.READ,
	)
	if err != nil {
		return result, fmt.Errorf("open appcontainer mappings failed: %w", err)
	}
	defer key.Close()

	subKeys, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return result, fmt.Errorf("read appcontainer sid list failed: %w", err)
	}
	sort.Strings(subKeys)
	failedDetails := make([]string, 0)
	for _, rawSID := range subKeys {
		sid := strings.TrimSpace(rawSID)
		if sid == "" {
			continue
		}
		result.Total++
		output, cmdErr := exec.CommandContext(
			ctx,
			"CheckNetIsolation.exe",
			"LoopbackExempt",
			"-a",
			"-p="+sid,
		).CombinedOutput()
		if cmdErr != nil {
			result.Failed++
			result.FailedSIDs = append(result.FailedSIDs, sid)
			detail := strings.TrimSpace(string(output))
			if detail == "" {
				detail = cmdErr.Error()
			}
			failedDetails = append(failedDetails, fmt.Sprintf("%s: %s", sid, detail))
			continue
		}
		result.Succeeded++
	}
	if result.Failed > 0 {
		firstFailure := failedDetails[0]
		return result, fmt.Errorf(
			"loopback exemption failed for %d/%d sid(s): %s",
			result.Failed,
			result.Total,
			firstFailure,
		)
	}
	return result, nil
}
