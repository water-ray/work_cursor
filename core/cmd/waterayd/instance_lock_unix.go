//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type fileInstanceLock struct {
	file *os.File
}

func resolveDaemonInstanceLockPath() string {
	return filepath.Join(string(os.PathSeparator), "tmp", "wateray-waterayd-instance.lock")
}

func acquireDaemonInstanceLock() (daemonInstanceLock, error) {
	lockPath := resolveDaemonInstanceLockPath()
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("prepare lock dir failed: %w", err)
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file failed: %w", err)
	}

	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errDaemonAlreadyRunning
		}
		return nil, fmt.Errorf("lock file failed: %w", err)
	}

	return &fileInstanceLock{file: file}, nil
}

func (l *fileInstanceLock) release() error {
	if l == nil || l.file == nil {
		return nil
	}

	unlockErr := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	closeErr := l.file.Close()
	l.file = nil
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
