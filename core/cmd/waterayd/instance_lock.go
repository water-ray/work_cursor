package main

import "errors"

var errDaemonAlreadyRunning = errors.New("waterayd daemon already running")

type daemonInstanceLock interface {
	release() error
}
