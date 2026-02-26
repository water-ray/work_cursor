//go:build !sbcore

package ffi

func singBoxVersion() string {
	return "unlinked"
}
