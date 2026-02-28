package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"wateray/core/internal/control"
)

func main() {
	const addr = "127.0.0.1:39080"
	runtimeLabel := "waterayd:http://" + addr
	store := control.NewRuntimeStore(runtimeLabel, "daemon")

	mux := http.NewServeMux()
	registerHandlers(mux, store)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("waterayd daemon started on %s", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("waterayd listen failed: %v", err)
		}
	}()

	// Daemon mode: keep runtime alive independently of UI process lifecycle.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	log.Println("waterayd daemon stopped")
}

func registerHandlers(mux *http.ServeMux, store *control.RuntimeStore) {
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
		snapshot, err := store.ProbeNodes(r.Context(), req)
		logCoreAction(
			store,
			fmt.Sprintf("probe nodes group=%s count=%d", req.GroupID, len(req.NodeIDs)),
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

	mux.HandleFunc("/v1/rules/reload", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.HotReloadRules(r.Context())
		logCoreAction(store, "hot reload rules", err)
		writeResult(w, snapshot, err)
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

	mux.HandleFunc("/v1/connection/start", func(w http.ResponseWriter, r *http.Request) {
		if !allowMethod(w, r, http.MethodPost) {
			return
		}
		snapshot, err := store.Start(r.Context())
		logCoreAction(store, "start connection", err)
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
		"ok":       true,
		"snapshot": snapshot,
	})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": message,
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func serveEventStreamWS(w http.ResponseWriter, r *http.Request, store *control.RuntimeStore) {
	conn, err := websocket.Accept(w, r, nil)
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
