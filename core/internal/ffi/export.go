package ffi

import (
	"encoding/json"
	"sync"
)

const (
	ErrOK            int32 = 0
	ErrInvalidConfig int32 = 1
)

var (
	runtimeMu  sync.Mutex
	running    bool
	lastConfig string
)

// StartCore validates config and starts runtime state.
func StartCore(configJSON string) int32 {
	if !json.Valid([]byte(configJSON)) {
		return ErrInvalidConfig
	}
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	running = true
	lastConfig = configJSON
	return ErrOK
}

// ReloadCore validates config and applies runtime hot-reload state.
func ReloadCore(configJSON string) int32 {
	if !json.Valid([]byte(configJSON)) {
		return ErrInvalidConfig
	}
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	if !running {
		return ErrInvalidConfig
	}
	lastConfig = configJSON
	return ErrOK
}

// StopCore stops runtime state.
func StopCore() int32 {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	running = false
	lastConfig = ""
	return ErrOK
}

// CoreVersion returns linked sing-box version string.
func CoreVersion() string {
	return singBoxVersion()
}
