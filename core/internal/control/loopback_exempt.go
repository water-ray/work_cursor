//go:build !windows

package control

import (
	"context"
	"errors"
)

func exemptWindowsLoopbackRestrictions(_ context.Context) (LoopbackExemptResult, error) {
	return LoopbackExemptResult{}, errors.New("loopback exemption is only supported on windows")
}
