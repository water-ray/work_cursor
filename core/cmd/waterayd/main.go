package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"wateray/core/internal/control"
)

const defaultUnifiedVersion = "0.1.0"
const daemonListenAddr = "127.0.0.1:39080"

var trustedDesktopOrigins = map[string]struct{}{
	"http://127.0.0.1:39080":  {},
	"http://localhost:39080":  {},
	"http://127.0.0.1:1420":   {},
	"http://localhost:1420":   {},
	"tauri://localhost":       {},
	"http://tauri.localhost":  {},
	"https://tauri.localhost": {},
}

var (
	appVersion          string
	strictSemVerPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

func main() {
	const addr = daemonListenAddr

	lock, err := acquireDaemonInstanceLock()
	if err != nil {
		if errors.Is(err, errDaemonAlreadyRunning) {
			log.Println("waterayd daemon already running, skip duplicate start")
			return
		}
		log.Fatalf("waterayd acquire instance lock failed: %v", err)
	}
	defer func() {
		if releaseErr := lock.release(); releaseErr != nil {
			log.Printf("waterayd release instance lock failed: %v", releaseErr)
		}
	}()

	runtimeLabel := "waterayd:http://" + addr
	store := control.NewRuntimeStore(runtimeLabel, resolveCoreVersion())
	shutdownRequestCh := make(chan string, 1)
	requestShutdown := func(reason string) {
		select {
		case shutdownRequestCh <- reason:
		default:
		}
	}

	mux := http.NewServeMux()
	registerHandlers(mux, store, requestShutdown)

	server := &http.Server{
		Addr:              addr,
		Handler:           withRequestSecurityGuards(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("waterayd daemon started on %s", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("waterayd listen failed: %v", err)
		}
	}()

	// Daemon mode: keep runtime alive independently of UI process lifecycle.
	stopSignal := make(chan os.Signal, 1)
	signal.Notify(stopSignal, syscall.SIGINT, syscall.SIGTERM)
	shutdownReason := "signal"
	select {
	case <-stopSignal:
	case reason := <-shutdownRequestCh:
		if strings.TrimSpace(reason) != "" {
			shutdownReason = reason
		}
	}
	if shutdownReason != "signal" {
		log.Printf("waterayd daemon shutdown requested: %s", shutdownReason)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	log.Println("waterayd daemon stopped")
}

func resolveCoreVersion() string {
	if version, ok := normalizeSemVerVersion(appVersion); ok {
		return version
	}
	buildInfo, ok := debug.ReadBuildInfo()
	if ok && buildInfo != nil {
		if version, versionOK := normalizeSemVerVersion(buildInfo.Main.Version); versionOK {
			return version
		}
	}
	if version, ok := resolveCoreVersionFromFile(); ok {
		return version
	}
	if version, ok := control.ResolveBundledReleaseVersion(); ok {
		return version
	}
	return defaultUnifiedVersion
}

func normalizeSemVerVersion(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "v")
	if strictSemVerPattern.MatchString(value) {
		return value, true
	}
	return "", false
}

func resolveCoreVersionFromFile() (string, bool) {
	candidates := []string{
		"VERSION",
		filepath.Join("..", "VERSION"),
		filepath.Join("..", "..", "VERSION"),
	}
	if executablePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(executablePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "VERSION"),
			filepath.Join(exeDir, "..", "VERSION"),
			filepath.Join(exeDir, "..", "..", "VERSION"),
		)
	}
	visited := map[string]struct{}{}
	for _, candidate := range candidates {
		absolutePath, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if _, exists := visited[absolutePath]; exists {
			continue
		}
		visited[absolutePath] = struct{}{}
		raw, readErr := os.ReadFile(absolutePath)
		if readErr != nil {
			continue
		}
		if version, ok := normalizeSemVerVersion(string(raw)); ok {
			return version, true
		}
	}
	return "", false
}

func registerHandlers(
	mux *http.ServeMux,
	store *control.RuntimeStore,
	requestShutdown func(reason string),
) {
	mux.HandleFunc("/v1/events/ws", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodGet) {
			return
		}
		serveEventStreamWS(w, r, store)
	})

	mux.HandleFunc("/v1/state", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodGet) {
			return
		}
		withLogs := parseBoolQuery(r.URL.Query().Get("withLogs"))
		snapshot, err := store.GetState(r.Context())
		if err != nil {
			store.LogCore(control.LogLevelError, fmt.Sprintf("get state failed: %v", err))
		} else if !withLogs {
			snapshot.ProxyLogs = []control.RuntimeLogEntry{}
			snapshot.CoreLogs = []control.RuntimeLogEntry{}
			snapshot.UILogs = []control.RuntimeLogEntry{}
		}
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost, http.MethodDelete) {
			return
		}
		if r.Method == http.MethodDelete {
			id := strings.TrimSpace(r.URL.Query().Get("id"))
			snapshot, err := store.RemoveSubscription(r.Context(), id)
			logCoreAction(store, fmt.Sprintf("remove subscription id=%s", id), err)
			writeResult(w, snapshot, err)
			return
		}
		var req control.AddSubscriptionRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.AddSubscription(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("add subscription name=%s url=%s", req.Name, req.URL),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/subscriptions/pull", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.PullSubscriptionRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.PullSubscriptionByGroup(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("pull subscription groupId=%s", req.GroupID),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/groups/active", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SelectGroupRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SelectActiveGroup(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("select active group=%s", req.GroupID),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/groups", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost, http.MethodDelete) {
			return
		}
		if r.Method == http.MethodPost {
			var req control.UpdateGroupRequest
			if err := decodeJSON(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			snapshot, err := store.UpdateGroup(r.Context(), req)
			logCoreAction(
				store,
				fmt.Sprintf("update group id=%s name=%s", req.GroupID, req.Name),
				err,
			)
			writeResult(w, snapshot, err)
			return
		}
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		snapshot, err := store.RemoveGroup(r.Context(), id)
		logCoreAction(store, fmt.Sprintf("remove group id=%s", id), err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/groups/reorder", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ReorderGroupsRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.ReorderGroups(r.Context(), req)
		logCoreAction(store, fmt.Sprintf("reorder groups count=%d", len(req.GroupIDs)), err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/select", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SelectNodeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SelectNode(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("select node group=%s node=%s", req.GroupID, req.NodeID),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/probe", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ProbeNodesRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, summary, err := store.ProbeNodes(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("probe nodes group=%s count=%d", req.GroupID, len(req.NodeIDs)),
			err,
		)
		writeProbeNodesResult(w, snapshot, summary, err)
	})

	mux.HandleFunc("/v1/tasks/background", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodDelete) {
			return
		}
		taskID := strings.TrimSpace(r.URL.Query().Get("taskId"))
		snapshot, err := store.RemoveBackgroundTask(r.Context(), taskID)
		logCoreAction(
			store,
			fmt.Sprintf("remove background task id=%s", taskID),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/probe/clear", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ClearProbeDataRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.ClearProbeData(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("clear probe data group=%s count=%d", req.GroupID, len(req.NodeIDs)),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/traffic/reset", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ResetTrafficStatsRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.ResetTrafficStats(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("reset traffic stats group=%s count=%d", req.GroupID, len(req.NodeIDs)),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/country/update", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.UpdateNodeCountriesRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.UpdateNodeCountries(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("update node countries count=%d", len(req.NodeIDs)),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/manual", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost, http.MethodDelete) {
			return
		}
		if r.Method == http.MethodDelete {
			groupID := strings.TrimSpace(r.URL.Query().Get("groupId"))
			nodeID := strings.TrimSpace(r.URL.Query().Get("nodeId"))
			snapshot, err := store.RemoveNode(r.Context(), groupID, nodeID)
			logCoreAction(
				store,
				fmt.Sprintf("remove node group=%s node=%s", groupID, nodeID),
				err,
			)
			writeResult(w, snapshot, err)
			return
		}
		var req control.AddManualNodeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.AddManualNode(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("add manual node group=%s name=%s", req.GroupID, req.Name),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/manual/update", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.UpdateManualNodeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.UpdateManualNode(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("update manual node group=%s node=%s", req.GroupID, req.NodeID),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/manual/import-text", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ImportManualNodesTextRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.ImportManualNodesText(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("import manual nodes from text group=%s bytes=%d", req.GroupID, len(strings.TrimSpace(req.Content))),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/transfer", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.TransferNodesRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.TransferNodes(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("transfer nodes mode=%s target=%s count=%d", req.Mode, req.TargetGroupID, len(req.NodeIDs)),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/nodes/reorder", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ReorderNodesRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.ReorderNodes(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("reorder nodes group=%s count=%d", req.GroupID, len(req.NodeIDs)),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/routing/mode", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SetRoutingModeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SetRoutingMode(r.Context(), req)
		logCoreAction(store, fmt.Sprintf("set routing mode=%s", req.Mode), err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/rules/config", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SetRuleConfigV2Request
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SetRuleConfigV2(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf(
				"set rule config v2 rules=%d policies=%d providers=%d",
				len(req.Config.Rules),
				len(req.Config.PolicyGroups),
				len(req.Config.Providers.RuleSets),
			),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/rulesets/status", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.QueryBuiltInRuleSetsStatusRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, statuses, err := store.QueryBuiltInRuleSetsStatus(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("query built-in rule-sets status geoip=%d geosite=%d", len(req.GeoIP), len(req.GeoSite)),
			err,
		)
		writeRuleSetStatusResult(w, snapshot, statuses, err)
	})

	mux.HandleFunc("/v1/rulesets/update", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.UpdateBuiltInRuleSetsRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, summary, err := store.UpdateBuiltInRuleSets(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf(
				"update built-in rule-sets mode=%s requested=%d success=%d failed=%d",
				req.DownloadMode,
				summary.Requested,
				summary.Success,
				summary.Failed,
			),
			err,
		)
		writeRuleSetUpdateResult(w, snapshot, summary, err)
	})

	mux.HandleFunc("/v1/rules/profiles", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost, http.MethodDelete) {
			return
		}
		if r.Method == http.MethodDelete {
			profileID := strings.TrimSpace(r.URL.Query().Get("id"))
			snapshot, err := store.RemoveRuleProfile(r.Context(), profileID)
			logCoreAction(store, fmt.Sprintf("remove rule profile id=%s", profileID), err)
			writeResult(w, snapshot, err)
			return
		}
		var req control.UpsertRuleProfileRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.UpsertRuleProfile(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("upsert rule profile id=%s name=%s", req.ProfileID, req.Name),
			err,
		)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/rules/profiles/active", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SelectRuleProfileRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SelectRuleProfile(r.Context(), req)
		logCoreAction(store, fmt.Sprintf("activate rule profile id=%s", req.ProfileID), err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/settings", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SetSettingsRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, err := store.SetSettings(r.Context(), req)
		logCoreAction(store, "set settings", err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/dns/cache/clear", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.ClearDNSCache(r.Context())
		logCoreAction(store, "clear dns cache", err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/dns/health", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.DNSHealthCheckRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, report, err := store.CheckDNSHealth(r.Context(), req)
		logCoreAction(store, "check dns health", err)
		writeDNSHealthResult(w, snapshot, report, err)
	})

	mux.HandleFunc("/v1/system/loopback/exempt", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, result, err := store.ExemptWindowsLoopback(r.Context())
		logCoreAction(store, "exempt windows loopback", err)
		writeLoopbackExemptResult(w, snapshot, result, err)
	})

	mux.HandleFunc("/v1/system/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, stopErr := store.Stop(r.Context())
		if stopErr != nil {
			store.LogCore(
				control.LogLevelWarn,
				fmt.Sprintf("stop proxy before daemon shutdown failed: %v", stopErr),
			)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"snapshot": snapshot,
		})
		if requestShutdown != nil {
			go func() {
				time.Sleep(150 * time.Millisecond)
				requestShutdown("api:/v1/system/shutdown")
			}()
		}
	})

	mux.HandleFunc("/v1/session/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req struct {
			SessionID string `json:"sessionId"`
			TTLSec    int    `json:"ttlSec,omitempty"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		activeSessions := store.TouchClientSession(req.SessionID, req.TTLSec)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"activeSessions": activeSessions,
		})
	})

	mux.HandleFunc("/v1/session/disconnect", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req struct {
			SessionID string `json:"sessionId"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		activeSessions := store.DisconnectClientSession(req.SessionID)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"activeSessions": activeSessions,
		})
	})

	mux.HandleFunc("/v1/logs/ui", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.AppendUILogRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := store.AppendUILog(r.Context(), req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
		})
	})

	mux.HandleFunc("/v1/logs/stream", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SetLogPushRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := store.SetLogPushEnabled(r.Context(), req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
		})
	})

	mux.HandleFunc("/v1/logs/save", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.SaveRuntimeLogsRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		savedPath, err := store.SaveRuntimeLogs(r.Context(), req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"savedPath": savedPath,
		})
	})

	mux.HandleFunc("/v1/config/catalog", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodGet) {
			return
		}
		catalog, err := store.ListConfigCatalog(r.Context())
		logCoreAction(store, "list config catalog", err)
		writeConfigCatalogResult(w, catalog, err)
	})

	mux.HandleFunc("/v1/config/backup/create", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.CreateConfigBackupRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		entry, err := store.CreateConfigBackup(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("create config backup file=%s include_subscriptions=%t", req.FileName, req.IncludeSubscriptionGroups),
			err,
		)
		writeConfigEntryResult(w, entry, err)
	})

	mux.HandleFunc("/v1/config/restore", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.RestoreConfigRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, summary, err := store.RestoreConfig(r.Context(), req)
		logCoreAction(store, fmt.Sprintf("restore config entry=%s", req.EntryID), err)
		writeConfigImportResult(w, snapshot, summary, err)
	})

	mux.HandleFunc("/v1/config/export/content", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ExportConfigContentRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		result, err := store.ExportConfigContent(r.Context(), req)
		logCoreAction(store, fmt.Sprintf("export config content entry=%s", req.EntryID), err)
		writeConfigExportContentResult(w, result, err)
	})

	mux.HandleFunc("/v1/config/import/content", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		var req control.ImportConfigContentRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		snapshot, summary, err := store.ImportConfigContent(r.Context(), req)
		logCoreAction(store, "import config content", err)
		writeConfigImportResult(w, snapshot, summary, err)
	})

	mux.HandleFunc("/v1/connection/start", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.Start(r.Context())
		logCoreAction(store, "start connection", err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/connection/start/precheck", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, precheck, err := store.CheckStartPreconditions(r.Context())
		logCoreAction(store, "check start preconditions", err)
		writeStartPrecheckResult(w, snapshot, precheck, err)
	})

	mux.HandleFunc("/v1/connection/restart", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.Restart(r.Context())
		logCoreAction(store, "restart connection", err)
		writeResult(w, snapshot, err)
	})

	mux.HandleFunc("/v1/connection/stop", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.Stop(r.Context())
		logCoreAction(store, "stop connection", err)
		writeResult(w, snapshot, err)
	})
}

func logCoreAction(store *control.RuntimeStore, action string, err error) {
	if err != nil {
		store.LogCore(control.LogLevelError, fmt.Sprintf("%s failed: %v", action, err))
		return
	}
	store.LogCore(control.LogLevelInfo, fmt.Sprintf("%s success", action))
}

func withRequestSecurityGuards(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowTrustedLocalRequest(w, r) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowTrustedLocalRequest(w http.ResponseWriter, r *http.Request) bool {
	if !isTrustedLocalHostHeader(r.Host) {
		writeError(w, http.StatusForbidden, "forbidden host")
		return false
	}
	originRaw := strings.TrimSpace(r.Header.Get("Origin"))
	if originRaw != "" {
		if !isTrustedDesktopOrigin(originRaw) {
			writeError(w, http.StatusForbidden, "forbidden origin")
			return false
		}
	}
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "cross-site":
		writeError(w, http.StatusForbidden, "cross-site requests are forbidden")
		return false
	}
	return true
}

func isTrustedDesktopOrigin(raw string) bool {
	origin, ok := normalizeOrigin(raw)
	if !ok {
		return false
	}
	_, trusted := trustedDesktopOrigins[origin]
	return trusted
}

func normalizeOrigin(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	if parsed == nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Opaque != "" {
		return "", false
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "tauri" {
		return "", false
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Host))
	return fmt.Sprintf("%s://%s", scheme, host), true
}

func isTrustedLocalHostHeader(rawHost string) bool {
	host := strings.ToLower(strings.TrimSpace(rawHost))
	if host == "" {
		return false
	}
	if splitHost, _, err := net.SplitHostPort(host); err == nil {
		host = splitHost
	}
	host = strings.Trim(host, "[]")
	switch host {
	case "127.0.0.1", "localhost":
		return true
	default:
		return false
	}
}

func allowMethod(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, method := range methods {
		if r.Method == method {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func parseBoolQuery(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func decodeJSON(r *http.Request, out any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	return nil
}

func writeResult(w http.ResponseWriter, snapshot control.StateSnapshot, err error) {
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"snapshot":  snapshot,
		"task":      resolveResponseTask(snapshot),
		"operation": resolveResponseOperation(snapshot),
	})
}

func writeProbeNodesResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	summary control.ProbeNodesSummary,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":           true,
		"snapshot":     snapshot,
		"probeSummary": summary,
		"task":         resolveResponseTask(snapshot),
		"operation":    resolveResponseOperation(snapshot),
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeRuleSetUpdateResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	summary control.RuleSetUpdateSummary,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":            true,
		"snapshot":      snapshot,
		"ruleSetUpdate": summary,
		"task":          resolveResponseTask(snapshot),
		"operation":     resolveResponseOperation(snapshot),
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeRuleSetStatusResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	statuses []control.RuleSetLocalStatus,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":              true,
		"snapshot":        snapshot,
		"ruleSetStatuses": statuses,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeStartPrecheckResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	precheck control.StartPrecheckResult,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":            true,
		"snapshot":      snapshot,
		"startPrecheck": precheck,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeDNSHealthResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	report control.DNSHealthReport,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":        true,
		"snapshot":  snapshot,
		"dnsHealth": report,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeLoopbackExemptResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	result control.LoopbackExemptResult,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":             true,
		"snapshot":       snapshot,
		"loopbackExempt": result,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeConfigCatalogResult(
	w http.ResponseWriter,
	catalog control.ConfigCatalog,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":            true,
		"configCatalog": catalog,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeConfigEntryResult(
	w http.ResponseWriter,
	entry control.ConfigCatalogEntry,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":          true,
		"configEntry": entry,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeConfigExportContentResult(
	w http.ResponseWriter,
	result control.ExportConfigContentResult,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":            true,
		"exportContent": result,
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeConfigImportResult(
	w http.ResponseWriter,
	snapshot control.StateSnapshot,
	summary control.ImportConfigSummary,
	err error,
) {
	status := http.StatusOK
	payload := map[string]any{
		"ok":            true,
		"snapshot":      snapshot,
		"importSummary": summary,
		"task":          resolveResponseTask(snapshot),
		"operation":     resolveResponseOperation(snapshot),
	}
	if err != nil {
		status = http.StatusBadRequest
		payload["ok"] = false
		payload["error"] = err.Error()
	}
	writeJSON(w, status, payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": message,
	})
}

func resolveResponseTask(snapshot control.StateSnapshot) *control.BackgroundTask {
	if len(snapshot.BackgroundTasks) == 0 {
		return nil
	}
	for _, task := range snapshot.BackgroundTasks {
		if task.Status == control.BackgroundTaskStatusQueued || task.Status == control.BackgroundTaskStatusRunning {
			taskCopy := task
			return &taskCopy
		}
	}
	taskCopy := snapshot.BackgroundTasks[0]
	return &taskCopy
}

func resolveResponseOperation(snapshot control.StateSnapshot) *control.OperationStatus {
	if len(snapshot.Operations) == 0 {
		return nil
	}
	for _, operation := range snapshot.Operations {
		if operation.Status == control.OperationStatusQueued || operation.Status == control.OperationStatusRunning {
			operationCopy := operation
			return &operationCopy
		}
	}
	operationCopy := snapshot.Operations[0]
	return &operationCopy
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func serveEventStreamWS(w http.ResponseWriter, r *http.Request, store *control.RuntimeStore) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Requests already passed allowTrustedLocalRequest, which validates the
		// full Wateray desktop origin allowlist for both Tauri dev and packaged
		// runtimes. Skip the library's secondary host-only origin check here.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "closed")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	subID, events := store.SubscribePushEvents()
	defer store.UnsubscribePushEvents(subID)

	if err := writePushEvent(ctx, conn, store.SnapshotPushEvent()); err != nil {
		return
	}

	readErr := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				readErr <- err
				return
			}
		}
	}()

	heartbeatTicker := time.NewTicker(20 * time.Second)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-readErr:
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := writePushEvent(ctx, conn, event); err != nil {
				return
			}
		case <-heartbeatTicker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				return
			}
		}
	}
}

func writePushEvent(ctx context.Context, conn *websocket.Conn, event control.DaemonPushEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
	defer writeCancel()
	return conn.Write(writeCtx, websocket.MessageText, data)
}
