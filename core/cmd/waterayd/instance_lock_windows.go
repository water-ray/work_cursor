//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

const daemonMutexName = "Local\\WaterayWateraydSingleton"

type windowsInstanceLock struct {
	handle windows.Handle
}

func acquireDaemonInstanceLock() (daemonInstanceLock, error) {
	name, err := windows.UTF16PtrFromString(daemonMutexName)
	if err != nil {
		return nil, fmt.Errorf("build mutex name failed: %w", err)
	}

	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return nil, fmt.Errorf("create mutex failed: %w", err)
	}

	if windows.GetLastError() == windows.ERROR_ALREADY_EXISTS {
		_ = windows.CloseHandle(handle)
		return nil, errDaemonAlreadyRunning
	}

	return &windowsInstanceLock{handle: handle}, nil
}

func (l *windowsInstanceLock) release() error {
	if l == nil || l.handle == 0 {
		return nil
	}

	err := windows.CloseHandle(l.handle)
	l.handle = 0
	return err
}
