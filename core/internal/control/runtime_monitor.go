package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	defaultRequestMonitorDurationSec = 30
	minRequestMonitorDurationSec     = 5
	maxRequestMonitorDurationSec     = 1800
	requestMonitorMetaFileExt        = ".meta.json"
	requestMonitorSampleInterval     = time.Second
	requestMonitorStartupRetryDelay  = 250 * time.Millisecond
	requestMonitorStartupRetryCount  = 8
)

type requestMonitorMeta struct {
	DurationSec   int                 `json:"durationSec"`
	RecordScope   RequestMonitorScope `json:"recordScope"`
	CreatedAtMS   int64               `json:"createdAtMs,omitempty"`
	CompletedAtMS int64               `json:"completedAtMs,omitempty"`
	RequestCount  int                 `json:"requestCount,omitempty"`
	Running       bool                `json:"running,omitempty"`
	LastError     string              `json:"lastError,omitempty"`
}

type requestMonitorDiskRecord struct {
	TimestampMS int64                     `json:"timestamp_ms"`
	Process     requestMonitorDiskProcess `json:"process"`
	Request     requestMonitorDiskRequest `json:"request"`
	Monitor     requestMonitorDiskMonitor `json:"monitor"`
	Tags        []string                  `json:"tags,omitempty"`
}

type requestMonitorDiskProcess struct {
	PID  int    `json:"pid"`
	Name string `json:"name,omitempty"`
	Path string `json:"path,omitempty"`
}

type requestMonitorDiskRequest struct {
	Domain          string `json:"domain,omitempty"`
	DestinationIP   string `json:"destination_ip,omitempty"`
	DestinationPort int    `json:"destination_port,omitempty"`
	Network         string `json:"network,omitempty"`
	Protocol        string `json:"protocol,omitempty"`
	InboundTag      string `json:"inbound_tag,omitempty"`
	Country         string `json:"country,omitempty"`
}

type requestMonitorDiskMonitor struct {
	RecordScope   RequestMonitorScope `json:"record_scope"`
	RuleMissed    bool                `json:"rule_missed"`
	MatchedRule   string              `json:"matched_rule,omitempty"`
	OutboundTag   string              `json:"outbound_tag,omitempty"`
	SuggestedRule string              `json:"suggested_rule,omitempty"`
	UploadBytes   int64               `json:"upload_bytes,omitempty"`
	DownloadBytes int64               `json:"download_bytes,omitempty"`
}

type requestMonitorStartupTarget struct {
	Label string
	URL   string
}

type requestMonitorRuntimeLease struct {
	OriginalSnapshot StateSnapshot
	ActiveSnapshot   StateSnapshot
	RestoreNeeded    bool
}

func normalizeRequestMonitorScope(raw RequestMonitorScope) RequestMonitorScope {
	switch RequestMonitorScope(strings.ToLower(strings.TrimSpace(string(raw)))) {
	case RequestMonitorScopeMissOnly:
		return RequestMonitorScopeMissOnly
	default:
		return RequestMonitorScopeAll
	}
}

func normalizeRequestMonitorDurationSec(durationSec int) int {
	if durationSec <= 0 {
		return defaultRequestMonitorDurationSec
	}
	if durationSec < minRequestMonitorDurationSec {
		return minRequestMonitorDurationSec
	}
	if durationSec > maxRequestMonitorDurationSec {
		return maxRequestMonitorDurationSec
	}
	return durationSec
}

func sanitizeRequestMonitorFileBaseName(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if len(value) >= len(".json") && strings.EqualFold(value[len(value)-len(".json"):], ".json") {
		value = strings.TrimSpace(value[:len(value)-len(".json")])
	}
	if value == "" {
		return "", errors.New("fileBaseName is required")
	}
	if strings.ContainsAny(value, `/\:*?"<>|`) {
		return "", errors.New("fileBaseName contains invalid characters")
	}
	if strings.Contains(value, "..") {
		return "", errors.New("fileBaseName is invalid")
	}
	return value, nil
}

func buildRequestMonitorFileName(fileBaseName string) (string, error) {
	base, err := sanitizeRequestMonitorFileBaseName(fileBaseName)
	if err != nil {
		return "", err
	}
	return base + ".json", nil
}

func resolveRequestMonitorSessionPathByID(recordID string) (string, error) {
	fileName := strings.TrimSpace(recordID)
	if fileName == "" {
		return "", errors.New("record id is required")
	}
	if filepath.Base(fileName) != fileName {
		return "", errors.New("record id is invalid")
	}
	if strings.ToLower(filepath.Ext(fileName)) != ".json" {
		return "", errors.New("record id must end with .json")
	}
	sessionPath := filepath.Join(resolveRequestLogDir(), fileName)
	if !pathIsWithinBaseDir(sessionPath, resolveRequestLogDir()) {
		return "", errors.New("record path is not allowed")
	}
	return sessionPath, nil
}

func resolveRequestMonitorMetaPath(sessionPath string) string {
	return sessionPath + requestMonitorMetaFileExt
}

func (s *RuntimeStore) ListRequestMonitorSessions(_ context.Context) ([]RequestMonitorSessionSummary, error) {
	requestLogDir := resolveRequestLogDir()
	entries, err := os.ReadDir(requestLogDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []RequestMonitorSessionSummary{}, nil
		}
		return nil, err
	}
	sessions := make([]RequestMonitorSessionSummary, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		fileName := strings.TrimSpace(entry.Name())
		if strings.ToLower(filepath.Ext(fileName)) != ".json" {
			continue
		}
		if strings.HasSuffix(strings.ToLower(fileName), requestMonitorMetaFileExt) {
			continue
		}
		sessionPath := filepath.Join(requestLogDir, fileName)
		summary, loadErr := loadRequestMonitorSessionSummary(sessionPath)
		if loadErr != nil {
			if s != nil {
				s.LogCore(
					LogLevelWarn,
					fmt.Sprintf("load request monitor session failed: file=%s err=%v", fileName, loadErr),
				)
			}
			continue
		}
		sessions = append(sessions, summary)
	}
	sort.SliceStable(sessions, func(i int, j int) bool {
		if sessions[i].CreatedAtMS == sessions[j].CreatedAtMS {
			return sessions[i].FileName > sessions[j].FileName
		}
		return sessions[i].CreatedAtMS > sessions[j].CreatedAtMS
	})
	return sessions, nil
}

func (s *RuntimeStore) GetRequestMonitorSessionContent(
	_ context.Context,
	recordID string,
) (RequestMonitorSessionContent, error) {
	sessionPath, err := resolveRequestMonitorSessionPathByID(recordID)
	if err != nil {
		return RequestMonitorSessionContent{}, err
	}
	if !pathIsWithinBaseDir(sessionPath, resolveRequestLogDir()) {
		return RequestMonitorSessionContent{}, errors.New("record path is not allowed")
	}
	summary, err := loadRequestMonitorSessionSummary(sessionPath)
	if err != nil {
		return RequestMonitorSessionContent{}, err
	}
	diskRecords, err := loadRequestMonitorDiskRecords(sessionPath)
	if err != nil {
		return RequestMonitorSessionContent{}, err
	}
	records := make([]RequestMonitorRecord, 0, len(diskRecords))
	for index, item := range diskRecords {
		records = append(records, convertDiskMonitorRecord(summary.ID, index, item))
	}
	return RequestMonitorSessionContent{
		Session: summary,
		Records: records,
	}, nil
}

func (s *RuntimeStore) DeleteRequestMonitorSession(_ context.Context, recordID string) (StateSnapshot, error) {
	sessionPath, err := resolveRequestMonitorSessionPathByID(recordID)
	if err != nil {
		return StateSnapshot{}, err
	}
	if !pathIsWithinBaseDir(sessionPath, resolveRequestLogDir()) {
		return StateSnapshot{}, errors.New("record path is not allowed")
	}
	if removeErr := os.Remove(sessionPath); removeErr != nil {
		if os.IsNotExist(removeErr) {
			return StateSnapshot{}, errors.New("monitor record not found")
		}
		return StateSnapshot{}, removeErr
	}
	metaPath := resolveRequestMonitorMetaPath(sessionPath)
	if removeMetaErr := os.Remove(metaPath); removeMetaErr != nil && !os.IsNotExist(removeMetaErr) {
		return StateSnapshot{}, removeMetaErr
	}
	return s.snapshotWithOperations(), nil
}

func (s *RuntimeStore) CreateRequestMonitorSession(
	ctx context.Context,
	req CreateRequestMonitorSessionRequest,
) (StateSnapshot, error) {
	_ = ctx
	request := req
	request.DurationSec = normalizeRequestMonitorDurationSec(request.DurationSec)
	request.RecordScope = normalizeRequestMonitorScope(request.RecordScope)
	fileBaseName, err := sanitizeRequestMonitorFileBaseName(request.FileBaseName)
	if err != nil {
		return StateSnapshot{}, err
	}
	request.FileBaseName = fileBaseName
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeRequestMonitor,
			ScopeKey:     "request_monitor:active",
			Title:        "请求监控",
			ProgressText: "正在准备请求监控",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			return s.createRequestMonitorSessionNow(runCtx, request, handle)
		},
	)
}

func (s *RuntimeStore) createRequestMonitorSessionNow(
	ctx context.Context,
	req CreateRequestMonitorSessionRequest,
	handle runtimeOperationHandle,
) (StateSnapshot, error) {
	fileName, err := buildRequestMonitorFileName(req.FileBaseName)
	if err != nil {
		return StateSnapshot{}, err
	}
	requestLogDir := resolveRequestLogDir()
	if err := os.MkdirAll(requestLogDir, 0o755); err != nil {
		return StateSnapshot{}, err
	}
	sessionPath := filepath.Join(requestLogDir, fileName)
	if !pathIsWithinBaseDir(sessionPath, requestLogDir) {
		return StateSnapshot{}, errors.New("monitor session path is not allowed")
	}
	if _, statErr := os.Stat(sessionPath); statErr == nil {
		return StateSnapshot{}, errors.New("monitor record file already exists")
	} else if !os.IsNotExist(statErr) {
		return StateSnapshot{}, statErr
	}

	lease, err := s.beginRequestMonitorRuntime(ctx, handle)
	if err != nil {
		return s.snapshotWithOperations(), err
	}
	if err := s.validateRequestMonitorRuntime(ctx, lease.ActiveSnapshot, handle); err != nil {
		cleanupErr := s.finishRequestMonitorRuntime(ctx, lease, handle)
		return s.snapshotWithOperations(), joinRequestMonitorErrors(err, cleanupErr)
	}
	metaPath := resolveRequestMonitorMetaPath(sessionPath)
	meta := requestMonitorMeta{
		DurationSec: req.DurationSec,
		RecordScope: req.RecordScope,
		CreatedAtMS: time.Now().UnixMilli(),
		Running:     true,
	}

	if err := writeRequestMonitorDiskRecords(sessionPath, []requestMonitorDiskRecord{}); err != nil {
		cleanupErr := s.finishRequestMonitorRuntime(ctx, lease, handle)
		return s.snapshotWithOperations(), joinRequestMonitorErrors(err, cleanupErr)
	}
	if err := writeRequestMonitorMetaFile(metaPath, meta); err != nil {
		_ = os.Remove(sessionPath)
		cleanupErr := s.finishRequestMonitorRuntime(ctx, lease, handle)
		return s.snapshotWithOperations(), joinRequestMonitorErrors(err, cleanupErr)
	}

	persistProgress := func(records []requestMonitorDiskRecord) {
		if err := writeRequestMonitorDiskRecords(sessionPath, records); err != nil {
			if s != nil {
				s.LogCore(
					LogLevelWarn,
					fmt.Sprintf("persist request monitor progress failed: file=%s err=%v", fileName, err),
				)
			}
			return
		}
		progressMeta := meta
		progressMeta.RequestCount = len(records)
		progressMeta.Running = true
		if err := writeRequestMonitorMetaFile(metaPath, progressMeta); err != nil && s != nil {
			s.LogCore(
				LogLevelWarn,
				fmt.Sprintf("persist request monitor meta failed: file=%s err=%v", fileName, err),
			)
		}
	}

	handle.UpdateProgress(fmt.Sprintf("代理验证通过，开始计时（%d 秒）", req.DurationSec))
	records, collectErr := s.collectRequestMonitorRecords(
		ctx,
		s.queryConnectionsSnapshotForMonitor,
		req.RecordScope,
		time.Duration(req.DurationSec)*time.Second,
		handle,
		persistProgress,
	)
	cleanupErr := s.finishRequestMonitorRuntime(ctx, lease, handle)

	completedAtMS := time.Now().UnixMilli()
	if writeErr := writeRequestMonitorDiskRecords(sessionPath, records); writeErr != nil {
		meta.Running = false
		meta.CompletedAtMS = completedAtMS
		meta.RequestCount = len(records)
		meta.LastError = writeErr.Error()
		_ = writeRequestMonitorMetaFile(metaPath, meta)
		return s.snapshotWithOperations(), writeErr
	}
	meta.Running = false
	meta.CompletedAtMS = completedAtMS
	meta.RequestCount = len(records)
	if collectErr != nil {
		meta.LastError = appendRequestMonitorError(meta.LastError, collectErr)
	}
	if cleanupErr != nil {
		meta.LastError = appendRequestMonitorError(meta.LastError, cleanupErr)
	}
	if err := writeRequestMonitorMetaFile(metaPath, meta); err != nil {
		return s.snapshotWithOperations(), err
	}
	if collectErr != nil && len(records) == 0 {
		return s.snapshotWithOperations(), collectErr
	}
	if collectErr != nil && s != nil {
		s.LogCore(
			LogLevelWarn,
			fmt.Sprintf(
				"request monitor completed with partial data: file=%s records=%d err=%v",
				fileName,
				len(records),
				collectErr,
			),
		)
	}
	if cleanupErr != nil {
		return s.snapshotWithOperations(), cleanupErr
	}
	return s.snapshotWithOperations(), nil
}

func (s *RuntimeStore) collectRequestMonitorRecords(
	ctx context.Context,
	querySnapshot func() (clashConnectionsSnapshot, error),
	recordScope RequestMonitorScope,
	duration time.Duration,
	handle runtimeOperationHandle,
	onProgress func([]requestMonitorDiskRecord),
) ([]requestMonitorDiskRecord, error) {
	recordScope = normalizeRequestMonitorScope(recordScope)
	if duration <= 0 {
		duration = time.Duration(defaultRequestMonitorDurationSec) * time.Second
	}
	if querySnapshot == nil {
		return []requestMonitorDiskRecord{}, errors.New("query monitor snapshot is required")
	}
	recordsByKey := map[string]requestMonitorDiskRecord{}
	deadline := time.Now().Add(duration)
	var firstErr error
	capture := func() {
		snapshot, err := querySnapshot()
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return
		}
		for _, connection := range snapshot.Connections {
			diskRecord, ok := buildRequestMonitorDiskRecord(connection, recordScope)
			if !ok {
				continue
			}
			key := strings.TrimSpace(connection.ID)
			if key == "" {
				key = buildRequestMonitorFallbackKey(diskRecord)
			}
			if existing, exists := recordsByKey[key]; exists {
				recordsByKey[key] = mergeRequestMonitorDiskRecord(existing, diskRecord)
				continue
			}
			recordsByKey[key] = diskRecord
		}
		if onProgress != nil {
			onProgress(materializeRequestMonitorDiskRecords(recordsByKey))
		}
	}
	capture()
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		remainingSec := int((remaining + time.Second - 1) / time.Second)
		handle.UpdateProgress(fmt.Sprintf("正在采集请求连接，剩余 %d 秒", remainingSec))
		waitDuration := requestMonitorSampleInterval
		if remaining < waitDuration {
			waitDuration = remaining
		}
		timer := time.NewTimer(waitDuration)
		select {
		case <-ctx.Done():
			timer.Stop()
			records := materializeRequestMonitorDiskRecords(recordsByKey)
			if firstErr == nil {
				firstErr = ctx.Err()
			}
			return records, firstErr
		case <-timer.C:
		}
		capture()
	}
	return materializeRequestMonitorDiskRecords(recordsByKey), firstErr
}

func (s *RuntimeStore) beginRequestMonitorRuntime(
	ctx context.Context,
	handle runtimeOperationHandle,
) (requestMonitorRuntimeLease, error) {
	if s == nil {
		return requestMonitorRuntimeLease{}, errors.New("runtime store is not available")
	}
	s.mu.Lock()
	s.ensureValidLocked()
	if s.state.ConnectionStage == ConnectionConnecting || s.state.ConnectionStage == ConnectionDisconnecting {
		s.mu.Unlock()
		return requestMonitorRuntimeLease{}, errors.New("代理服务正在切换中，请稍后再试")
	}
	originalSnapshot := cloneSnapshot(s.state)
	s.mu.Unlock()

	lease := requestMonitorRuntimeLease{
		OriginalSnapshot: originalSnapshot,
		ActiveSnapshot:   originalSnapshot,
	}
	monitorCtx := withSuppressedReferencedNodePoolRefresh(ctx)
	proxyWasRunning := isRequestMonitorProxyRunning(originalSnapshot)
	originalLogLevel := normalizeLogLevel(originalSnapshot.ProxyLogLevel)
	logLevelChanged := originalLogLevel != LogLevelInfo

	if logLevelChanged {
		if _, err := s.updateRequestMonitorProxyLogLevel(LogLevelInfo); err != nil {
			return lease, err
		}
		lease.RestoreNeeded = true
	}

	if !proxyWasRunning {
		handle.UpdateProgress("正在启动代理服务并临时提升日志等级")
		activeSnapshot, err := s.startNow(monitorCtx)
		if err != nil {
			if restoreErr := s.restoreRequestMonitorLogLevelAfterFailure(ctx, lease); restoreErr != nil {
				return lease, fmt.Errorf("start monitor proxy failed: %v; restore log level failed: %w", err, restoreErr)
			}
			return lease, fmt.Errorf("start monitor proxy failed: %w", err)
		}
		lease.ActiveSnapshot = activeSnapshot
		lease.RestoreNeeded = true
		return lease, nil
	}

	if logLevelChanged {
		handle.UpdateProgress("正在重启代理服务并临时提升日志等级")
		activeSnapshot, err := s.restartNow(monitorCtx)
		if err != nil {
			if restoreErr := s.restoreRequestMonitorLogLevelAfterFailure(ctx, lease); restoreErr != nil {
				return lease, fmt.Errorf("restart monitor proxy failed: %v; restore log level failed: %w", err, restoreErr)
			}
			return lease, fmt.Errorf("restart monitor proxy failed: %w", err)
		}
		lease.ActiveSnapshot = activeSnapshot
	}
	return lease, nil
}

func (s *RuntimeStore) finishRequestMonitorRuntime(
	ctx context.Context,
	lease requestMonitorRuntimeLease,
	handle runtimeOperationHandle,
) error {
	if s == nil || !lease.RestoreNeeded {
		return nil
	}
	originalSnapshot := lease.OriginalSnapshot
	originalLogLevel := normalizeLogLevel(originalSnapshot.ProxyLogLevel)
	monitorCtx := withSuppressedReferencedNodePoolRefresh(ctx)
	if _, err := s.updateRequestMonitorProxyLogLevel(originalLogLevel); err != nil {
		return err
	}
	if !isRequestMonitorProxyRunning(originalSnapshot) {
		handle.UpdateProgress("监控结束，正在停止代理服务")
		_, err := s.stopNow(monitorCtx)
		return err
	}
	if originalLogLevel != LogLevelInfo {
		handle.UpdateProgress("监控结束，正在恢复代理日志等级")
		_, err := s.restartNow(monitorCtx)
		return err
	}
	return nil
}

func buildRequestMonitorStartupTargets(snapshot StateSnapshot) []requestMonitorStartupTarget {
	probeSettings := normalizeProbeSettings(snapshot.ProbeSettings)
	targets := make([]requestMonitorStartupTarget, 0, 3)
	seen := map[string]struct{}{}
	appendTarget := func(label string, rawURL string) {
		urlValue := strings.TrimSpace(rawURL)
		if urlValue == "" {
			return
		}
		if _, ok := seen[urlValue]; ok {
			return
		}
		seen[urlValue] = struct{}{}
		targets = append(targets, requestMonitorStartupTarget{
			Label: strings.TrimSpace(label),
			URL:   urlValue,
		})
	}
	appendTarget("订阅地址", resolveRequestMonitorActiveSubscriptionURL(snapshot))
	appendTarget("探测设置地址", probeSettings.NodeInfoQueryURL)
	appendTarget("真实连接测试地址", probeSettings.RealConnectTestURL)
	return targets
}

func resolveRequestMonitorActiveSubscriptionURL(snapshot StateSnapshot) string {
	group := findGroupByID(snapshot.Groups, snapshot.ActiveGroupID)
	if group == nil {
		return ""
	}
	subscriptionID := strings.TrimSpace(group.SubscriptionID)
	if subscriptionID == "" {
		return ""
	}
	for _, item := range snapshot.Subscriptions {
		if strings.TrimSpace(item.ID) != subscriptionID {
			continue
		}
		return strings.TrimSpace(item.URL)
	}
	return ""
}

func resolveRequestMonitorValidationTimeoutMS(snapshot StateSnapshot) int {
	probeSettings := normalizeProbeSettings(snapshot.ProbeSettings)
	timeoutMS := probeSettings.TimeoutSec * 1000
	if timeoutMS <= 0 {
		timeoutMS = defaultProbeTimeoutSec * 1000
	}
	if timeoutMS > 120000 {
		timeoutMS = 120000
	}
	return timeoutMS
}

func (s *RuntimeStore) validateRequestMonitorRuntime(
	ctx context.Context,
	activeSnapshot StateSnapshot,
	handle runtimeOperationHandle,
) error {
	if s == nil {
		return errors.New("runtime store is not available")
	}
	if !isRequestMonitorProxyRunning(activeSnapshot) {
		return errors.New("代理服务未运行，无法开始监控")
	}
	proxyPort := runtimeListenPort(activeSnapshot)
	if proxyPort <= 0 || proxyPort > 65535 {
		return errors.New("当前代理监听端口无效，无法开始监控")
	}
	validationTargets := buildRequestMonitorStartupTargets(activeSnapshot)
	validationTimeoutMS := resolveRequestMonitorValidationTimeoutMS(activeSnapshot)

	handle.UpdateProgress("正在验证监控代理日志级别")
	currentLogLevel, err := waitForRequestMonitorRuntimeValue(
		ctx,
		func() (string, error) {
			return s.queryRequestMonitorRuntimeLogLevel()
		},
	)
	if err != nil {
		return fmt.Errorf("verify monitor runtime log level failed: %w", err)
	}
	if normalizeClashAPILogLevel(currentLogLevel) != normalizeClashAPILogLevel(toClashAPILogLevel(LogLevelInfo)) {
		return fmt.Errorf("monitor runtime log level is %s, expected info", currentLogLevel)
	}

	handle.UpdateProgress("正在验证监控代理连接视图")
	if _, err := waitForRequestMonitorRuntimeValue(
		ctx,
		func() (clashConnectionsSnapshot, error) {
			return s.queryConnectionsSnapshotForMonitor()
		},
	); err != nil {
		return fmt.Errorf("query monitor runtime connections failed: %w", err)
	}

	for _, target := range validationTargets {
		handle.UpdateProgress(fmt.Sprintf("正在验证监控代理访问：%s", target.Label))
		if _, err := waitForRequestMonitorRuntimeValue(
			ctx,
			func() (bool, error) {
				return true, fetchRequestMonitorURLThroughProxy(
					ctx,
					target.URL,
					proxyPort,
					validationTimeoutMS,
				)
			},
		); err != nil {
			return fmt.Errorf("启动监控后访问%s失败: url=%s err=%w", target.Label, target.URL, err)
		}
	}
	return nil
}

func (s *RuntimeStore) updateRequestMonitorProxyLogLevel(level LogLevel) (StateSnapshot, error) {
	if s == nil {
		return StateSnapshot{}, errors.New("runtime store is not available")
	}
	level = normalizeLogLevel(level)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureValidLocked()
	if normalizeLogLevel(s.state.ProxyLogLevel) == level {
		return cloneSnapshot(s.state), nil
	}
	s.state.ProxyLogLevel = level
	if err := s.saveLocked(); err != nil {
		return StateSnapshot{}, err
	}
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) restoreRequestMonitorLogLevelAfterFailure(
	ctx context.Context,
	lease requestMonitorRuntimeLease,
) error {
	if s == nil {
		return nil
	}
	originalSnapshot := lease.OriginalSnapshot
	originalLogLevel := normalizeLogLevel(originalSnapshot.ProxyLogLevel)
	if originalLogLevel == LogLevelInfo {
		return nil
	}
	if _, err := s.updateRequestMonitorProxyLogLevel(originalLogLevel); err != nil {
		return err
	}
	if isRequestMonitorProxyRunning(originalSnapshot) {
		_, err := s.restartNow(withSuppressedReferencedNodePoolRefresh(ctx))
		return err
	}
	return nil
}

func fetchRequestMonitorURLThroughProxy(
	ctx context.Context,
	requestURL string,
	proxyPort int,
	timeoutMS int,
) error {
	requestURL = strings.TrimSpace(requestURL)
	if requestURL == "" {
		return errors.New("request monitor validation url is empty")
	}
	if proxyPort <= 0 || proxyPort > 65535 {
		return errors.New("request monitor validation proxy port is invalid")
	}
	if timeoutMS <= 0 {
		timeoutMS = defaultProbeTimeoutSec * 1000
	}
	proxyURL, err := neturl.Parse(
		"http://" + net.JoinHostPort(defaultLocalMixedListenAddress, fmt.Sprintf("%d", proxyPort)),
	)
	if err != nil {
		return fmt.Errorf("build validation proxy url failed: %w", err)
	}
	transport := &http.Transport{
		Proxy:             http.ProxyURL(proxyURL),
		DisableKeepAlives: true,
	}
	client := &http.Client{
		Timeout:   time.Duration(timeoutMS) * time.Millisecond,
		Transport: transport,
	}
	request, err := http.NewRequest(http.MethodGet, requestURL, nil)
	if err != nil {
		return fmt.Errorf("create validation request failed: %w", err)
	}
	if ctx != nil {
		request = request.WithContext(ctx)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("perform validation request failed: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusBadRequest {
		return nil
	}
	return fmt.Errorf("status=%d", response.StatusCode)
}

func (s *RuntimeStore) queryRequestMonitorRuntimeLogLevel() (string, error) {
	if s == nil {
		return "", errors.New("runtime store is not available")
	}
	var controller string
	err := s.runtimeCoordinatorOrDefault().WithRuntimeRead(
		"request_monitor_query_log_level",
		func(runtime *proxyRuntime) error {
			if runtime == nil {
				return errors.New("proxy runtime is not available")
			}
			controller = runtime.clashAPIControllerOrDefault()
			return nil
		},
	)
	if err != nil {
		return "", err
	}
	return queryClashAPILogLevel(controller, nil)
}

func (s *RuntimeStore) queryConnectionsSnapshotForMonitor() (clashConnectionsSnapshot, error) {
	if s == nil {
		return clashConnectionsSnapshot{}, errors.New("runtime store is not available")
	}
	var snapshot clashConnectionsSnapshot
	err := s.runtimeCoordinatorOrDefault().WithRuntimeRead(
		"request_monitor_collect",
		func(runtime *proxyRuntime) error {
			if runtime == nil {
				return errors.New("proxy runtime is not available")
			}
			result, queryErr := runtime.QueryConnectionsSnapshot()
			if queryErr != nil {
				return queryErr
			}
			snapshot = result
			return nil
		},
	)
	if err != nil {
		return clashConnectionsSnapshot{}, err
	}
	return snapshot, nil
}

func waitForRequestMonitorRuntimeValue[T any](
	ctx context.Context,
	run func() (T, error),
) (T, error) {
	var zero T
	if ctx == nil {
		ctx = context.Background()
	}
	if run == nil {
		return zero, errors.New("runtime probe callback is required")
	}
	var lastErr error
	for attempt := 0; attempt < requestMonitorStartupRetryCount; attempt++ {
		value, err := run()
		if err == nil {
			return value, nil
		}
		lastErr = err
		if attempt == requestMonitorStartupRetryCount-1 {
			break
		}
		timer := time.NewTimer(requestMonitorStartupRetryDelay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return zero, ctx.Err()
		}
	}
	if lastErr == nil {
		lastErr = errors.New("runtime probe failed")
	}
	return zero, lastErr
}

func joinRequestMonitorErrors(primary error, secondary error) error {
	if primary == nil {
		return secondary
	}
	if secondary == nil {
		return primary
	}
	return fmt.Errorf("%v; cleanup failed: %w", primary, secondary)
}

func appendRequestMonitorError(existing string, err error) string {
	if err == nil {
		return strings.TrimSpace(existing)
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return strings.TrimSpace(existing)
	}
	current := strings.TrimSpace(existing)
	if current == "" {
		return message
	}
	if current == message {
		return current
	}
	return current + "; " + message
}

func isRequestMonitorProxyRunning(snapshot StateSnapshot) bool {
	return snapshot.ConnectionStage == ConnectionConnected && snapshot.ProxyMode != ProxyModeOff
}

type requestMonitorMetaCompat struct {
	DurationSec    int                 `json:"durationSec"`
	RecordScope    RequestMonitorScope `json:"recordScope"`
	UseActiveRules bool                `json:"useActiveRules"`
	CreatedAtMS    int64               `json:"createdAtMs,omitempty"`
	CompletedAtMS  int64               `json:"completedAtMs,omitempty"`
	RequestCount   int                 `json:"requestCount,omitempty"`
	Running        bool                `json:"running,omitempty"`
	LastError      string              `json:"lastError,omitempty"`
}

type requestMonitorDiskMonitorCompat struct {
	RecordScope   RequestMonitorScope `json:"record_scope"`
	UseActiveRule bool                `json:"use_active_rules"`
	RuleMissed    *bool               `json:"rule_missed"`
	MatchedRule   string              `json:"matched_rule,omitempty"`
	OutboundTag   string              `json:"outbound_tag,omitempty"`
	SuggestedRule string              `json:"suggested_rule,omitempty"`
	UploadBytes   int64               `json:"upload_bytes,omitempty"`
	DownloadBytes int64               `json:"download_bytes,omitempty"`
}

type requestMonitorDiskRecordCompat struct {
	TimestampMS int64                        `json:"timestamp_ms"`
	Process     requestMonitorDiskProcess    `json:"process"`
	Request     requestMonitorDiskRequest    `json:"request"`
	Monitor     requestMonitorDiskMonitorCompat `json:"monitor"`
	Tags        []string                     `json:"tags,omitempty"`
}

func loadRequestMonitorSessionSummary(sessionPath string) (RequestMonitorSessionSummary, error) {
	sessionPath = filepath.Clean(sessionPath)
	fileInfo, err := os.Stat(sessionPath)
	if err != nil {
		return RequestMonitorSessionSummary{}, err
	}
	if fileInfo.IsDir() {
		return RequestMonitorSessionSummary{}, errors.New("monitor record path is a directory")
	}
	diskRecords, err := loadRequestMonitorDiskRecords(sessionPath)
	if err != nil {
		return RequestMonitorSessionSummary{}, err
	}
	metaPath := resolveRequestMonitorMetaPath(sessionPath)
	meta, hasMeta, _ := loadRequestMonitorMetaFile(metaPath)
	fileName := filepath.Base(sessionPath)
	createdAtMS := fileInfo.ModTime().UnixMilli()
	completedAtMS := createdAtMS
	recordScope := RequestMonitorScopeAll
	durationSec := 0
	if len(diskRecords) > 0 {
		first := diskRecords[0]
		last := diskRecords[len(diskRecords)-1]
		createdAtMS = first.TimestampMS
		completedAtMS = last.TimestampMS
		recordScope = normalizeRequestMonitorScope(first.Monitor.RecordScope)
		if completedAtMS >= createdAtMS {
			durationSec = int((completedAtMS - createdAtMS) / 1000)
		}
	}
	summary := RequestMonitorSessionSummary{
		ID:            fileName,
		FileName:      fileName,
		FileBaseName:  strings.TrimSuffix(fileName, filepath.Ext(fileName)),
		DurationSec:   durationSec,
		RecordScope:   recordScope,
		CreatedAtMS:   createdAtMS,
		CompletedAtMS: completedAtMS,
		RequestCount:  len(diskRecords),
	}
	if hasMeta {
		if meta.DurationSec > 0 {
			summary.DurationSec = meta.DurationSec
		}
		if strings.TrimSpace(string(meta.RecordScope)) != "" {
			summary.RecordScope = normalizeRequestMonitorScope(meta.RecordScope)
		}
		if meta.CreatedAtMS > 0 {
			summary.CreatedAtMS = meta.CreatedAtMS
		}
		if meta.CompletedAtMS > 0 {
			summary.CompletedAtMS = meta.CompletedAtMS
		}
		if meta.RequestCount > 0 || len(diskRecords) == 0 {
			summary.RequestCount = max(0, meta.RequestCount)
		}
		summary.Running = meta.Running
		summary.LastError = strings.TrimSpace(meta.LastError)
	}
	return summary, nil
}

func loadRequestMonitorDiskRecords(sessionPath string) ([]requestMonitorDiskRecord, error) {
	content, err := os.ReadFile(sessionPath)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(content))) == 0 {
		return []requestMonitorDiskRecord{}, nil
	}
	var compatRecords []requestMonitorDiskRecordCompat
	if err := json.Unmarshal(content, &compatRecords); err != nil {
		return nil, err
	}
	if compatRecords == nil {
		return []requestMonitorDiskRecord{}, nil
	}
	records := make([]requestMonitorDiskRecord, 0, len(compatRecords))
	for _, item := range compatRecords {
		recordScope := normalizeLoadedRequestMonitorScope(item.Monitor.RecordScope, item.Monitor.UseActiveRule)
		ruleMissed := recordScope == RequestMonitorScopeMissOnly
		if item.Monitor.RuleMissed != nil {
			ruleMissed = *item.Monitor.RuleMissed
		}
		record := requestMonitorDiskRecord{
			TimestampMS: item.TimestampMS,
			Process:     item.Process,
			Request:     item.Request,
			Monitor: requestMonitorDiskMonitor{
				RecordScope:   recordScope,
				RuleMissed:    ruleMissed,
				MatchedRule:   strings.TrimSpace(item.Monitor.MatchedRule),
				OutboundTag:   strings.TrimSpace(item.Monitor.OutboundTag),
				SuggestedRule: strings.TrimSpace(item.Monitor.SuggestedRule),
				UploadBytes:   item.Monitor.UploadBytes,
				DownloadBytes: item.Monitor.DownloadBytes,
			},
			Tags: append([]string{}, item.Tags...),
		}
		record.Tags = buildRequestMonitorRecordTags(record)
		records = append(records, record)
	}
	return records, nil
}

func writeRequestMonitorDiskRecords(sessionPath string, records []requestMonitorDiskRecord) error {
	if strings.TrimSpace(sessionPath) == "" {
		return errors.New("monitor record path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o755); err != nil {
		return err
	}
	if records == nil {
		records = []requestMonitorDiskRecord{}
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := sessionPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, sessionPath)
}

func loadRequestMonitorMetaFile(metaPath string) (requestMonitorMeta, bool, error) {
	content, err := os.ReadFile(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return requestMonitorMeta{}, false, nil
		}
		return requestMonitorMeta{}, false, err
	}
	var compatMeta requestMonitorMetaCompat
	if err := json.Unmarshal(content, &compatMeta); err != nil {
		return requestMonitorMeta{}, false, err
	}
	meta := requestMonitorMeta{
		DurationSec:   compatMeta.DurationSec,
		RecordScope:   normalizeLoadedRequestMonitorScope(compatMeta.RecordScope, compatMeta.UseActiveRules),
		CreatedAtMS:   compatMeta.CreatedAtMS,
		CompletedAtMS: compatMeta.CompletedAtMS,
		RequestCount:  compatMeta.RequestCount,
		Running:       compatMeta.Running,
		LastError:     strings.TrimSpace(compatMeta.LastError),
	}
	return meta, true, nil
}

func writeRequestMonitorMetaFile(metaPath string, meta requestMonitorMeta) error {
	if strings.TrimSpace(metaPath) == "" {
		return errors.New("monitor meta path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o755); err != nil {
		return err
	}
	meta.RecordScope = normalizeRequestMonitorScope(meta.RecordScope)
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := metaPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, metaPath)
}

func normalizeLoadedRequestMonitorScope(
	recordScope RequestMonitorScope,
	legacyUseActiveRule bool,
) RequestMonitorScope {
	if normalizeRequestMonitorScope(recordScope) == RequestMonitorScopeMissOnly || legacyUseActiveRule {
		return RequestMonitorScopeMissOnly
	}
	return RequestMonitorScopeAll
}

func isRequestMonitorRuleMiss(ruleName string) bool {
	switch strings.ToUpper(strings.TrimSpace(ruleName)) {
	case "", "MATCH", "FINAL":
		return true
	default:
		return false
	}
}

func shouldIncludeConnectionForMonitor(
	metadata clashConnectionMetadata,
	recordScope RequestMonitorScope,
) bool {
	if normalizeRequestMonitorScope(recordScope) != RequestMonitorScopeMissOnly {
		return true
	}
	return isRequestMonitorRuleMiss(metadata.Rule)
}

func buildRequestMonitorDiskRecord(
	connection clashConnectionRecord,
	recordScope RequestMonitorScope,
) (requestMonitorDiskRecord, bool) {
	metadata := connection.Metadata
	recordScope = normalizeRequestMonitorScope(recordScope)
	if !shouldIncludeConnectionForMonitor(metadata, recordScope) {
		return requestMonitorDiskRecord{}, false
	}
	processName := firstNonEmpty(
		strings.TrimSpace(metadata.ProcessName),
		strings.TrimSpace(metadata.Process),
	)
	processPath := firstNonEmpty(
		strings.TrimSpace(metadata.ProcessPath),
		strings.TrimSpace(metadata.ProcessPathSnake),
	)
	pid := int(maxInt64(metadata.ProcessID, metadata.ProcessIDSnake))
	domain := strings.TrimSpace(metadata.Host)
	destinationIP := firstNonEmpty(
		strings.TrimSpace(metadata.DestinationIP),
		strings.TrimSpace(metadata.DestinationIPSnake),
	)
	if domain != "" && net.ParseIP(strings.Trim(domain, "[]")) != nil {
		if destinationIP == "" {
			destinationIP = domain
		}
		domain = ""
	}
	destinationPort := metadata.DestinationPort
	if destinationPort <= 0 {
		destinationPort = metadata.DestinationPortSnake
	}
	ruleMissed := isRequestMonitorRuleMiss(metadata.Rule)
	matchedRule := ""
	if !ruleMissed {
		matchedRule = strings.TrimSpace(metadata.Rule)
	}
	outboundTag := resolveRequestMonitorOutboundTag(connection.Chains)
	uploadBytes := maxInt64(connection.Upload, connection.UploadSnake)
	downloadBytes := maxInt64(connection.Download, connection.DownloadSnake)
	diskRecord := requestMonitorDiskRecord{
		TimestampMS: time.Now().UnixMilli(),
		Process: requestMonitorDiskProcess{
			PID:  pid,
			Name: processName,
			Path: processPath,
		},
		Request: requestMonitorDiskRequest{
			Domain:          strings.TrimSpace(domain),
			DestinationIP:   destinationIP,
			DestinationPort: destinationPort,
			Network:         strings.TrimSpace(metadata.Network),
			Protocol:        strings.TrimSpace(metadata.Type),
			InboundTag: firstNonEmpty(
				strings.TrimSpace(metadata.InboundTag),
				strings.TrimSpace(metadata.InboundName),
				strings.TrimSpace(metadata.Inbound),
			),
			Country: strings.TrimSpace(metadata.Country),
		},
		Monitor: requestMonitorDiskMonitor{
			RecordScope:   recordScope,
			RuleMissed:    ruleMissed,
			MatchedRule:   matchedRule,
			OutboundTag:   outboundTag,
			SuggestedRule: buildRequestMonitorSuggestedRule(
				processName,
				domain,
				destinationIP,
				destinationPort,
			),
			UploadBytes:   uploadBytes,
			DownloadBytes: downloadBytes,
		},
	}
	diskRecord.Tags = buildRequestMonitorRecordTags(diskRecord)
	return diskRecord, true
}

func resolveRequestMonitorOutboundTag(chains []string) string {
	for index := len(chains) - 1; index >= 0; index-- {
		tag := strings.TrimSpace(chains[index])
		if tag != "" {
			return tag
		}
	}
	return ""
}

func buildRequestMonitorSuggestedRule(
	processName string,
	domain string,
	destinationIP string,
	destinationPort int,
) string {
	if process := strings.TrimSpace(processName); process != "" {
		return "process_name:" + process
	}
	if normalizedDomain := deriveMonitorSuffixDomain(domain); normalizedDomain != "" {
		return "domain_suffix:" + normalizedDomain
	}
	if ipValue := strings.TrimSpace(destinationIP); ipValue != "" {
		cidrSuffix := "/32"
		if parsed := net.ParseIP(strings.Trim(ipValue, "[]")); parsed != nil && parsed.To4() == nil {
			cidrSuffix = "/128"
		}
		return "ip_cidr:" + ipValue + cidrSuffix
	}
	if destinationPort > 0 {
		return fmt.Sprintf("port:%d", destinationPort)
	}
	return ""
}

func deriveMonitorSuffixDomain(raw string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	normalized = strings.TrimSuffix(normalized, ".")
	if normalized == "" {
		return ""
	}
	parts := strings.Split(normalized, ".")
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		cleaned = append(cleaned, part)
	}
	if len(cleaned) <= 2 {
		return strings.Join(cleaned, ".")
	}
	lastTwo := strings.Join(cleaned[len(cleaned)-2:], ".")
	switch lastTwo {
	case "co.uk", "org.uk", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "com.hk", "com.tw", "co.jp":
		return strings.Join(cleaned[len(cleaned)-3:], ".")
	default:
		return lastTwo
	}
}

func buildRequestMonitorRecordTags(record requestMonitorDiskRecord) []string {
	tags := make([]string, 0, 14)
	if name := strings.TrimSpace(record.Process.Name); name != "" {
		tags = append(tags, "process:"+name)
	}
	if record.Process.PID > 0 {
		tags = append(tags, fmt.Sprintf("pid:%d", record.Process.PID))
	}
	if domain := strings.TrimSpace(record.Request.Domain); domain != "" {
		tags = append(tags, "domain:"+domain)
	}
	if ipValue := strings.TrimSpace(record.Request.DestinationIP); ipValue != "" {
		tags = append(tags, "ip:"+ipValue)
	}
	if record.Request.DestinationPort > 0 {
		tags = append(tags, fmt.Sprintf("port:%d", record.Request.DestinationPort))
	}
	if protocol := strings.TrimSpace(record.Request.Protocol); protocol != "" {
		tags = append(tags, "protocol:"+protocol)
	}
	if inbound := strings.TrimSpace(record.Request.InboundTag); inbound != "" {
		tags = append(tags, "inbound:"+inbound)
	}
	tags = append(tags, "scope:"+string(normalizeRequestMonitorScope(record.Monitor.RecordScope)))
	if record.Monitor.RuleMissed {
		tags = append(tags, "result:missed")
	} else {
		tags = append(tags, "result:matched")
	}
	if matchedRule := strings.TrimSpace(record.Monitor.MatchedRule); matchedRule != "" {
		tags = append(tags, "matched:"+matchedRule)
	}
	if outboundTag := strings.TrimSpace(record.Monitor.OutboundTag); outboundTag != "" {
		tags = append(tags, "outbound:"+outboundTag)
	}
	if rule := strings.TrimSpace(record.Monitor.SuggestedRule); rule != "" {
		tags = append(tags, "rule:"+rule)
	}
	if country := strings.TrimSpace(record.Request.Country); country != "" {
		tags = append(tags, "country:"+country)
	}
	return tags
}

func buildRequestMonitorFallbackKey(record requestMonitorDiskRecord) string {
	builder := strings.Builder{}
	builder.WriteString(strings.ToLower(strings.TrimSpace(record.Process.Name)))
	builder.WriteString("|")
	builder.WriteString(strings.ToLower(strings.TrimSpace(record.Request.Domain)))
	builder.WriteString("|")
	builder.WriteString(strings.ToLower(strings.TrimSpace(record.Request.DestinationIP)))
	builder.WriteString("|")
	builder.WriteString(fmt.Sprintf("%d", record.Request.DestinationPort))
	builder.WriteString("|")
	builder.WriteString(strings.ToLower(strings.TrimSpace(record.Request.Protocol)))
	return builder.String()
}

func mergeRequestMonitorDiskRecord(
	existing requestMonitorDiskRecord,
	next requestMonitorDiskRecord,
) requestMonitorDiskRecord {
	merged := existing
	merged.Monitor.RecordScope = normalizeRequestMonitorScope(existing.Monitor.RecordScope)
	if merged.TimestampMS <= 0 || (next.TimestampMS > 0 && next.TimestampMS < merged.TimestampMS) {
		merged.TimestampMS = next.TimestampMS
	}
	merged.Monitor.UploadBytes = maxInt64(existing.Monitor.UploadBytes, next.Monitor.UploadBytes)
	merged.Monitor.DownloadBytes = maxInt64(existing.Monitor.DownloadBytes, next.Monitor.DownloadBytes)
	if strings.TrimSpace(merged.Process.Name) == "" {
		merged.Process.Name = strings.TrimSpace(next.Process.Name)
	}
	if strings.TrimSpace(merged.Process.Path) == "" {
		merged.Process.Path = strings.TrimSpace(next.Process.Path)
	}
	if merged.Process.PID <= 0 && next.Process.PID > 0 {
		merged.Process.PID = next.Process.PID
	}
	if strings.TrimSpace(merged.Request.Domain) == "" {
		merged.Request.Domain = strings.TrimSpace(next.Request.Domain)
	}
	if strings.TrimSpace(merged.Request.DestinationIP) == "" {
		merged.Request.DestinationIP = strings.TrimSpace(next.Request.DestinationIP)
	}
	if merged.Request.DestinationPort <= 0 && next.Request.DestinationPort > 0 {
		merged.Request.DestinationPort = next.Request.DestinationPort
	}
	if strings.TrimSpace(merged.Request.Network) == "" {
		merged.Request.Network = strings.TrimSpace(next.Request.Network)
	}
	if strings.TrimSpace(merged.Request.Protocol) == "" {
		merged.Request.Protocol = strings.TrimSpace(next.Request.Protocol)
	}
	if strings.TrimSpace(merged.Request.InboundTag) == "" {
		merged.Request.InboundTag = strings.TrimSpace(next.Request.InboundTag)
	}
	if strings.TrimSpace(merged.Request.Country) == "" {
		merged.Request.Country = strings.TrimSpace(next.Request.Country)
	}
	if strings.TrimSpace(merged.Monitor.OutboundTag) == "" {
		merged.Monitor.OutboundTag = strings.TrimSpace(next.Monitor.OutboundTag)
	}
	if merged.Monitor.RuleMissed != next.Monitor.RuleMissed {
		merged.Monitor.RuleMissed = merged.Monitor.RuleMissed || next.Monitor.RuleMissed
		if merged.Monitor.RuleMissed {
			merged.Monitor.MatchedRule = ""
		}
	}
	if strings.TrimSpace(merged.Monitor.MatchedRule) == "" && !merged.Monitor.RuleMissed {
		merged.Monitor.MatchedRule = strings.TrimSpace(next.Monitor.MatchedRule)
	}
	if strings.TrimSpace(merged.Monitor.SuggestedRule) == "" {
		merged.Monitor.SuggestedRule = strings.TrimSpace(next.Monitor.SuggestedRule)
	}
	merged.Tags = buildRequestMonitorRecordTags(merged)
	return merged
}

func materializeRequestMonitorDiskRecords(recordsByKey map[string]requestMonitorDiskRecord) []requestMonitorDiskRecord {
	records := make([]requestMonitorDiskRecord, 0, len(recordsByKey))
	for _, item := range recordsByKey {
		records = append(records, item)
	}
	sort.SliceStable(records, func(i int, j int) bool {
		if records[i].TimestampMS == records[j].TimestampMS {
			leftProcess := strings.ToLower(strings.TrimSpace(records[i].Process.Name))
			rightProcess := strings.ToLower(strings.TrimSpace(records[j].Process.Name))
			if leftProcess == rightProcess {
				leftDomain := strings.ToLower(strings.TrimSpace(records[i].Request.Domain))
				rightDomain := strings.ToLower(strings.TrimSpace(records[j].Request.Domain))
				return leftDomain < rightDomain
			}
			return leftProcess < rightProcess
		}
		return records[i].TimestampMS < records[j].TimestampMS
	})
	return records
}

func convertDiskMonitorRecord(
	sessionID string,
	index int,
	disk requestMonitorDiskRecord,
) RequestMonitorRecord {
	recordID := strings.TrimSpace(sessionID)
	if recordID == "" {
		recordID = "monitor"
	}
	return RequestMonitorRecord{
		ID:          fmt.Sprintf("%s-%d", recordID, index+1),
		TimestampMS: disk.TimestampMS,
		Process: RequestMonitorProcess{
			PID:  disk.Process.PID,
			Name: strings.TrimSpace(disk.Process.Name),
			Path: strings.TrimSpace(disk.Process.Path),
		},
		Request: RequestMonitorRequest{
			Domain:          strings.TrimSpace(disk.Request.Domain),
			DestinationIP:   strings.TrimSpace(disk.Request.DestinationIP),
			DestinationPort: disk.Request.DestinationPort,
			Network:         strings.TrimSpace(disk.Request.Network),
			Protocol:        strings.TrimSpace(disk.Request.Protocol),
			InboundTag:      strings.TrimSpace(disk.Request.InboundTag),
			Country:         strings.TrimSpace(disk.Request.Country),
		},
		Monitor: RequestMonitorDecision{
			RecordScope:   normalizeRequestMonitorScope(disk.Monitor.RecordScope),
			RuleMissed:    disk.Monitor.RuleMissed,
			MatchedRule:   strings.TrimSpace(disk.Monitor.MatchedRule),
			OutboundTag:   strings.TrimSpace(disk.Monitor.OutboundTag),
			SuggestedRule: strings.TrimSpace(disk.Monitor.SuggestedRule),
			UploadBytes:   maxInt64(disk.Monitor.UploadBytes, 0),
			DownloadBytes: maxInt64(disk.Monitor.DownloadBytes, 0),
		},
		Tags: append([]string{}, disk.Tags...),
	}
}
