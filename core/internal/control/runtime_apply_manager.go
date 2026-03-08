package control

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

type runtimeApplyStrategy string

const (
	runtimeApplyStrategyNoop        runtimeApplyStrategy = "noop"
	runtimeApplyStrategyHotPatch    runtimeApplyStrategy = "hot_patch"
	runtimeApplyStrategyFastRestart runtimeApplyStrategy = "fast_restart"
)

const muxVerifyTimeoutMS = 4000
const tunFastRestartRetryDelay = 250 * time.Millisecond

var muxVerifyProbeURLs = []string{
	proxyURLTestProbeURL,
	"https://cp.cloudflare.com/generate_204",
}

// Runtime capability matrix for sing-box v1.12.22.
// NOTE: clash API PATCH /configs only handles mode in this version.
type runtimeCapabilityMatrix struct {
	ProxyLogLevelHotPatch bool
}

var singBoxRuntimeCapabilitiesV11222 = runtimeCapabilityMatrix{
	ProxyLogLevelHotPatch: false,
}

type RuntimeChangeSet struct {
	ProxyModeChanged        bool
	ListenSettingsChanged   bool
	SniffChanged            bool
	TransportGuardChanged   bool
	MuxChanged              bool
	DNSChanged              bool
	ProxyLogLevelChanged    bool
	HasRuntimeVersionedDiff bool
}

func (set RuntimeChangeSet) hasRuntimeChange() bool {
	return set.ProxyModeChanged ||
		set.ListenSettingsChanged ||
		set.SniffChanged ||
		set.TransportGuardChanged ||
		set.MuxChanged ||
		set.DNSChanged ||
		set.ProxyLogLevelChanged ||
		set.HasRuntimeVersionedDiff
}

func (set RuntimeChangeSet) onlyProxyLogLevelChanged() bool {
	return set.ProxyLogLevelChanged &&
		!set.ProxyModeChanged &&
		!set.ListenSettingsChanged &&
		!set.SniffChanged &&
		!set.TransportGuardChanged &&
		!set.MuxChanged &&
		!set.DNSChanged &&
		!set.HasRuntimeVersionedDiff
}

func (set RuntimeChangeSet) needsMuxConnectivityVerify(next StateSnapshot) bool {
	if !set.MuxChanged {
		return false
	}
	if next.ProxyMode == ProxyModeOff {
		return false
	}
	return next.Mux.Enabled
}

func (set RuntimeChangeSet) summary() string {
	items := make([]string, 0, 8)
	if set.ProxyModeChanged {
		items = append(items, "proxy_mode")
	}
	if set.ListenSettingsChanged {
		items = append(items, "listen")
	}
	if set.SniffChanged {
		items = append(items, "sniff")
	}
	if set.TransportGuardChanged {
		items = append(items, "transport_guard")
	}
	if set.MuxChanged {
		items = append(items, "mux")
	}
	if set.DNSChanged {
		items = append(items, "dns")
	}
	if set.ProxyLogLevelChanged {
		items = append(items, "proxy_log_level")
	}
	if set.HasRuntimeVersionedDiff {
		items = append(items, "runtime_versioned")
	}
	if len(items) == 0 {
		return "none"
	}
	return strings.Join(items, ",")
}

func buildSettingsRuntimeChangeSet(previous StateSnapshot, current StateSnapshot) RuntimeChangeSet {
	set := RuntimeChangeSet{}
	if previous.ProxyMode != current.ProxyMode {
		set.ProxyModeChanged = true
	}
	if current.ProxyMode != ProxyModeOff {
		if previous.LocalProxyPort != current.LocalProxyPort ||
			previous.AllowExternal != current.AllowExternal {
			set.ListenSettingsChanged = true
		}
	}
	if current.ProxyMode == ProxyModeTun {
		if previous.TunMTU != current.TunMTU ||
			normalizeProxyTunStack(previous.TunStack) != normalizeProxyTunStack(current.TunStack) {
			set.ListenSettingsChanged = true
		}
	}
	if previous.SniffEnabled != current.SniffEnabled ||
		previous.SniffOverrideDest != current.SniffOverrideDest ||
		previous.SniffTimeoutMS != current.SniffTimeoutMS {
		set.SniffChanged = true
	}
	if previous.BlockQUIC != current.BlockQUIC ||
		previous.BlockUDP != current.BlockUDP {
		set.TransportGuardChanged = true
	}
	if !isProxyMuxConfigEqual(previous.Mux, current.Mux) {
		set.MuxChanged = true
	}
	if !isDNSConfigEqual(previous.DNS, current.DNS) {
		set.DNSChanged = true
	}
	if previous.ProxyLogLevel != current.ProxyLogLevel {
		set.ProxyLogLevelChanged = true
	}
	if previous.RuntimeLabel != current.RuntimeLabel || previous.CoreVersion != current.CoreVersion {
		set.HasRuntimeVersionedDiff = true
	}
	return set
}

type runtimeApplyResult struct {
	Strategy             runtimeApplyStrategy
	ChangeSet            RuntimeChangeSet
	PlanReason           string
	ProxyLogHotUpdated   bool
	ProxyLogFallbackFast bool
}

type runtimeApplyPlan struct {
	Strategy              runtimeApplyStrategy
	ChangeSet             RuntimeChangeSet
	Reason                string
	VerifyMuxConnectivity bool
}

type runtimeChangePlanner struct {
	capability runtimeCapabilityMatrix
}

func newRuntimeChangePlanner(capability runtimeCapabilityMatrix) runtimeChangePlanner {
	return runtimeChangePlanner{
		capability: capability,
	}
}

func (p runtimeChangePlanner) PlanSettingsApply(
	previous StateSnapshot,
	current StateSnapshot,
	wasConnected bool,
) runtimeApplyPlan {
	changeSet := buildSettingsRuntimeChangeSet(previous, current)
	plan := runtimeApplyPlan{
		Strategy:              runtimeApplyStrategyFastRestart,
		ChangeSet:             changeSet,
		Reason:                "runtime_change_requires_fast_restart",
		VerifyMuxConnectivity: changeSet.needsMuxConnectivityVerify(current),
	}
	if !wasConnected {
		plan.Reason = "runtime_not_connected"
		return plan
	}
	if !changeSet.hasRuntimeChange() {
		plan.Strategy = runtimeApplyStrategyNoop
		plan.Reason = "no_runtime_change"
		return plan
	}
	if changeSet.onlyProxyLogLevelChanged() {
		if p.capability.ProxyLogLevelHotPatch {
			plan.Strategy = runtimeApplyStrategyHotPatch
			plan.Reason = "proxy_log_level_hot_patch_supported"
			return plan
		}
		plan.Strategy = runtimeApplyStrategyFastRestart
		plan.Reason = "proxy_log_level_hot_patch_unsupported"
		return plan
	}
	return plan
}

type runtimeApplyError struct {
	err             error
	rollbackApplied bool
}

func (e *runtimeApplyError) Error() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e *runtimeApplyError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

func wrapRuntimeApplyError(err error, rollbackApplied bool) error {
	if err == nil {
		return nil
	}
	return &runtimeApplyError{
		err:             err,
		rollbackApplied: rollbackApplied,
	}
}

type runtimeApplyEngine interface {
	PrepareRuntimeConfig(snapshot StateSnapshot) (*preparedRuntimeConfig, error)
	RestartFast(nextPrepared *preparedRuntimeConfig, rollbackPrepared *preparedRuntimeConfig) (runtimeRestartOutcome, error)
	StartPrepared(prepared *preparedRuntimeConfig) error
	UpdateLogLevel(level LogLevel) error
	ProbeNodeDelay(nodeID string, probeURL string, timeoutMS int) (int, error)
}

type runtimeApplyManager struct {
	runtime           runtimeApplyEngine
	capability        runtimeCapabilityMatrix
	syncSystemProxyFn func(snapshot StateSnapshot) error
	muxProbeURLs      []string
	muxProbeTimeoutMS int
	tunRetryDelay     time.Duration
}

type selectedNodeSwitcher interface {
	SwitchSelectedNode(nodeID string) error
}

func newRuntimeApplyManager(runtime *proxyRuntime) *runtimeApplyManager {
	return &runtimeApplyManager{
		runtime:           runtime,
		capability:        singBoxRuntimeCapabilitiesV11222,
		syncSystemProxyFn: syncSystemProxy,
		muxProbeURLs:      append([]string{}, muxVerifyProbeURLs...),
		muxProbeTimeoutMS: muxVerifyTimeoutMS,
		tunRetryDelay:     tunFastRestartRetryDelay,
	}
}

func newRuntimeApplyManagerForTest(
	runtime runtimeApplyEngine,
	capability runtimeCapabilityMatrix,
	syncFn func(snapshot StateSnapshot) error,
) *runtimeApplyManager {
	if syncFn == nil {
		syncFn = func(StateSnapshot) error { return nil }
	}
	return &runtimeApplyManager{
		runtime:           runtime,
		capability:        capability,
		syncSystemProxyFn: syncFn,
		muxProbeURLs:      append([]string{}, muxVerifyProbeURLs...),
		muxProbeTimeoutMS: muxVerifyTimeoutMS,
		tunRetryDelay:     0,
	}
}

func (m *runtimeApplyManager) ApplySettings(
	previous StateSnapshot,
	current StateSnapshot,
	wasConnected bool,
) (runtimeApplyResult, error) {
	plan := newRuntimeChangePlanner(m.capability).PlanSettingsApply(previous, current, wasConnected)
	result := runtimeApplyResult{
		Strategy:   plan.Strategy,
		ChangeSet:  plan.ChangeSet,
		PlanReason: plan.Reason,
	}
	switch result.Strategy {
	case runtimeApplyStrategyNoop:
		return result, nil
	case runtimeApplyStrategyHotPatch:
		if err := m.ensureEngineReady(); err != nil {
			return result, err
		}
		if err := m.runtime.UpdateLogLevel(current.ProxyLogLevel); err == nil {
			result.ProxyLogHotUpdated = true
			return result, nil
		} else {
			// Defensive fallback path: only used when capability matrix allows hot patch.
			result.ProxyLogFallbackFast = true
			result.Strategy = runtimeApplyStrategyFastRestart
		}
	}
	err := m.ApplyFastRestart(
		current,
		previous,
		"apply_settings",
		plan.VerifyMuxConnectivity,
	)
	if err != nil {
		return result, err
	}
	return result, nil
}

func (m *runtimeApplyManager) ApplyFastRestart(
	nextSnapshot StateSnapshot,
	rollbackSnapshot StateSnapshot,
	reason string,
	verifyMuxConnectivity bool,
) error {
	if err := m.ensureEngineReady(); err != nil {
		return err
	}
	nextPrepared, err := m.runtime.PrepareRuntimeConfig(nextSnapshot)
	if err != nil {
		return wrapRuntimeApplyError(
			fmt.Errorf("%s: prepare runtime config failed: %w", reason, err),
			false,
		)
	}
	rollbackPrepared, err := m.runtime.PrepareRuntimeConfig(rollbackSnapshot)
	if err != nil {
		return wrapRuntimeApplyError(
			fmt.Errorf("%s: prepare rollback config failed: %w", reason, err),
			false,
		)
	}
	restartOutcome, restartErr := m.runtime.RestartFast(nextPrepared, rollbackPrepared)
	if restartErr != nil && shouldRetryTunFastRestart(nextSnapshot, restartErr) {
		if m.tunRetryDelay > 0 {
			time.Sleep(m.tunRetryDelay)
		}
		restartOutcome, restartErr = m.runtime.RestartFast(nextPrepared, rollbackPrepared)
	}
	if restartErr != nil {
		if restartOutcome.RollbackApplied {
			if restoreErr := m.syncSystemProxyFn(rollbackSnapshot); restoreErr != nil {
				return wrapRuntimeApplyError(
					fmt.Errorf(
						"%s: fast restart failed: %v; rollback succeeded but restore system proxy failed: %v",
						reason,
						restartErr,
						restoreErr,
					),
					true,
				)
			}
			return wrapRuntimeApplyError(
				fmt.Errorf("%s: fast restart failed: %v", reason, restartErr),
				true,
			)
		}
		return wrapRuntimeApplyError(
			fmt.Errorf("%s: fast restart failed: %w", reason, restartErr),
			false,
		)
	}
	if verifyMuxConnectivity {
		if verifyErr := m.verifyMuxConnectivity(nextSnapshot); verifyErr != nil {
			if rollbackErr := m.runtime.StartPrepared(rollbackPrepared); rollbackErr != nil {
				return wrapRuntimeApplyError(
					fmt.Errorf(
						"%s: mux post-check failed: %v; rollback start failed: %w",
						reason,
						verifyErr,
						rollbackErr,
					),
					false,
				)
			}
			if restoreErr := m.syncSystemProxyFn(rollbackSnapshot); restoreErr != nil {
				return wrapRuntimeApplyError(
					fmt.Errorf(
						"%s: mux post-check failed: %v; rollback succeeded but restore system proxy failed: %v",
						reason,
						verifyErr,
						restoreErr,
					),
					true,
				)
			}
			return wrapRuntimeApplyError(
				fmt.Errorf("%s: mux post-check failed: %v; rollback succeeded", reason, verifyErr),
				true,
			)
		}
	}
	if proxyErr := m.syncSystemProxyFn(nextSnapshot); proxyErr != nil {
		if rollbackErr := m.runtime.StartPrepared(rollbackPrepared); rollbackErr != nil {
			return wrapRuntimeApplyError(
				fmt.Errorf(
					"%s: sync system proxy failed: %v; rollback start failed: %w",
					reason,
					proxyErr,
					rollbackErr,
				),
				false,
			)
		}
		if restoreErr := m.syncSystemProxyFn(rollbackSnapshot); restoreErr != nil {
			return wrapRuntimeApplyError(
				fmt.Errorf(
					"%s: sync system proxy failed: %v; rollback succeeded but restore system proxy failed: %v",
					reason,
					proxyErr,
					restoreErr,
				),
				true,
			)
		}
		return wrapRuntimeApplyError(
			fmt.Errorf("%s: sync system proxy failed: %v; rollback succeeded", reason, proxyErr),
			true,
		)
	}
	m.restoreSelectedNodeBestEffort(nextSnapshot)
	return nil
}

func (m *runtimeApplyManager) restoreSelectedNodeBestEffort(snapshot StateSnapshot) {
	if normalizeProxyMode(snapshot.ProxyMode) == ProxyModeOff {
		return
	}
	nodeID := strings.TrimSpace(snapshot.SelectedNodeID)
	if nodeID == "" {
		return
	}
	switcher, ok := any(m.runtime).(selectedNodeSwitcher)
	if !ok || switcher == nil {
		return
	}
	_ = switcher.SwitchSelectedNode(nodeID)
}

func (m *runtimeApplyManager) verifyMuxConnectivity(snapshot StateSnapshot) error {
	if snapshot.ProxyMode == ProxyModeOff || !snapshot.Mux.Enabled {
		return nil
	}
	node, err := resolveRuntimeNode(snapshot)
	if err != nil {
		return fmt.Errorf("resolve active node failed: %w", err)
	}
	timeoutMS := m.muxProbeTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = muxVerifyTimeoutMS
	}
	probeURLs := m.muxProbeURLs
	if len(probeURLs) == 0 {
		probeURLs = []string{proxyURLTestProbeURL}
	}
	var lastErr error
	for _, probeURL := range probeURLs {
		_, probeErr := m.runtime.ProbeNodeDelay(node.ID, probeURL, timeoutMS)
		if probeErr == nil {
			return nil
		}
		lastErr = probeErr
	}
	if lastErr == nil {
		lastErr = errors.New("probe failed for unknown reason")
	}
	return fmt.Errorf("probe selected node failed: %w", lastErr)
}

func (m *runtimeApplyManager) ensureEngineReady() error {
	if m == nil || m.runtime == nil {
		return errors.New("runtime apply manager is not initialized")
	}
	if m.syncSystemProxyFn == nil {
		m.syncSystemProxyFn = syncSystemProxy
	}
	return nil
}

func shouldRetryTunFastRestart(nextSnapshot StateSnapshot, err error) bool {
	if err == nil {
		return false
	}
	if normalizeProxyMode(nextSnapshot.ProxyMode) != ProxyModeTun {
		return false
	}
	message := strings.ToLower(strings.TrimSpace(err.Error()))
	if message == "" {
		return false
	}
	if !strings.Contains(message, "configure tun interface") {
		return false
	}
	return strings.Contains(message, "already exists") ||
		strings.Contains(message, "cannot create a file when that file already exists")
}
