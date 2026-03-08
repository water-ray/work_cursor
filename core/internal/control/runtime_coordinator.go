package control

import (
	"sync"
	"time"
)

const runtimeCoordinatorWaitWarnThreshold = 120 * time.Millisecond

type RuntimeCoordinator struct {
	mu         sync.RWMutex
	runtime    *proxyRuntime
	apply      *runtimeApplyManager
	onLockWait func(wait time.Duration, reason string)
}

func newRuntimeCoordinator(
	runtime *proxyRuntime,
	apply *runtimeApplyManager,
	onLockWait func(wait time.Duration, reason string),
) *RuntimeCoordinator {
	if apply == nil {
		apply = newRuntimeApplyManager(runtime)
	}
	return &RuntimeCoordinator{
		runtime:    runtime,
		apply:      apply,
		onLockWait: onLockWait,
	}
}

func (c *RuntimeCoordinator) lock(reason string) {
	start := time.Now()
	c.mu.Lock()
	wait := time.Since(start)
	if c.onLockWait != nil && wait >= runtimeCoordinatorWaitWarnThreshold {
		c.onLockWait(wait, reason)
	}
}

func (c *RuntimeCoordinator) unlock() {
	c.mu.Unlock()
}

func (c *RuntimeCoordinator) rlock(reason string) {
	start := time.Now()
	c.mu.RLock()
	wait := time.Since(start)
	if c.onLockWait != nil && wait >= runtimeCoordinatorWaitWarnThreshold {
		c.onLockWait(wait, reason)
	}
}

func (c *RuntimeCoordinator) runlock() {
	c.mu.RUnlock()
}

func (c *RuntimeCoordinator) ApplySettings(
	previous StateSnapshot,
	current StateSnapshot,
	wasConnected bool,
) (runtimeApplyResult, error) {
	c.lock("apply_settings")
	defer c.unlock()
	return c.apply.ApplySettings(previous, current, wasConnected)
}

func (c *RuntimeCoordinator) ApplyFastRestart(
	nextSnapshot StateSnapshot,
	rollbackSnapshot StateSnapshot,
	reason string,
	verifyMuxConnectivity bool,
) error {
	c.lock(reason)
	defer c.unlock()
	return c.apply.ApplyFastRestart(nextSnapshot, rollbackSnapshot, reason, verifyMuxConnectivity)
}

func (c *RuntimeCoordinator) WithRuntime(
	reason string,
	fn func(runtime *proxyRuntime) error,
) error {
	if fn == nil {
		return nil
	}
	c.lock(reason)
	defer c.unlock()
	return fn(c.runtime)
}

func (c *RuntimeCoordinator) WithRuntimeRead(
	reason string,
	fn func(runtime *proxyRuntime) error,
) error {
	if fn == nil {
		return nil
	}
	c.rlock(reason)
	defer c.runlock()
	return fn(c.runtime)
}

func (c *RuntimeCoordinator) Applier() *runtimeApplyManager {
	return c.apply
}
