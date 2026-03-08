//go:build !windows

package control

import "os"

func detectRuntimeAdmin() bool {
	return os.Geteuid() == 0
}
