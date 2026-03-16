package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"wateray/core/internal/control"
)

const (
	loopbackTransportWSPath          = "/v1/rpc/ws"
	loopbackTransportBootstrapPath   = "/v1/transport/bootstrap"
	loopbackTransportProtocolVersion = 1
	loopbackAuthTTL                  = 60 * time.Second
)

var desktopControlPortCandidates = []int{59500, 59501, 59502}

type loopbackTransportBootstrapPayload struct {
	ProtocolVersion      int                 `json:"protocolVersion"`
	PlatformKind         string              `json:"platformKind"`
	SessionID            string              `json:"sessionId"`
	AuthToken            string              `json:"authToken"`
	ExpiresAtMS          int64               `json:"expiresAtMs"`
	ControlPortCandidates []int              `json:"controlPortCandidates"`
	ActiveControlPort    int                 `json:"activeControlPort"`
	WSPath               string              `json:"wsPath"`
	InternalPorts        map[string]int      `json:"internalPorts,omitempty"`
}

type loopbackWSHelloMessage struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SessionID       string `json:"sessionId"`
	AuthToken       string `json:"authToken"`
}

type loopbackWSRequestEnvelope struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Command   string          `json:"command"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type loopbackWSResponseEnvelope struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	OK        bool   `json:"ok"`
	Payload   any    `json:"payload,omitempty"`
	Error     string `json:"error,omitempty"`
}

type loopbackWSEventEnvelope struct {
	Type      string `json:"type"`
	EventType string `json:"eventType"`
	Payload   any    `json:"payload"`
}

type loopbackWSHelloAckEnvelope struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SessionID       string `json:"sessionId"`
	ExpiresAtMS     int64  `json:"expiresAtMs"`
}

type daemonRPCRequestPayload struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type loopbackAuthSession struct {
	token      string
	expiresAt  time.Time
}

type loopbackAuthManager struct {
	mu       sync.Mutex
	sessions map[string]loopbackAuthSession
}

func newLoopbackAuthManager() *loopbackAuthManager {
	return &loopbackAuthManager{
		sessions: map[string]loopbackAuthSession{},
	}
}

func (m *loopbackAuthManager) issue() (string, string, time.Time, error) {
	if m == nil {
		return "", "", time.Time{}, fmt.Errorf("loopback auth manager is required")
	}
	sessionID, err := generateLoopbackToken(18)
	if err != nil {
		return "", "", time.Time{}, err
	}
	authToken, err := generateLoopbackToken(24)
	if err != nil {
		return "", "", time.Time{}, err
	}
	expiresAt := time.Now().Add(loopbackAuthTTL)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	m.sessions[sessionID] = loopbackAuthSession{
		token:     authToken,
		expiresAt: expiresAt,
	}
	return sessionID, authToken, expiresAt, nil
}

func (m *loopbackAuthManager) validate(sessionID string, authToken string) error {
	if m == nil {
		return fmt.Errorf("loopback auth manager is required")
	}
	id := strings.TrimSpace(sessionID)
	token := strings.TrimSpace(authToken)
	if id == "" || token == "" {
		return fmt.Errorf("missing auth session")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	session, exists := m.sessions[id]
	if !exists {
		return fmt.Errorf("session expired")
	}
	if session.token != token {
		return fmt.Errorf("invalid auth token")
	}
	return nil
}

func (m *loopbackAuthManager) pruneLocked() {
	now := time.Now()
	for sessionID, session := range m.sessions {
		if !session.expiresAt.After(now) {
			delete(m.sessions, sessionID)
		}
	}
}

func generateLoopbackToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func bindDesktopLoopbackListener() (net.Listener, int, error) {
	var lastErr error
	for _, port := range desktopControlPortCandidates {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return listener, port, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no loopback candidate port configured")
	}
	return nil, 0, lastErr
}

func buildLoopbackBootstrapPayload(
	auth *loopbackAuthManager,
	activePort int,
) (loopbackTransportBootstrapPayload, error) {
	sessionID, authToken, expiresAt, err := auth.issue()
	if err != nil {
		return loopbackTransportBootstrapPayload{}, err
	}
	return loopbackTransportBootstrapPayload{
		ProtocolVersion:       loopbackTransportProtocolVersion,
		PlatformKind:          "desktop",
		SessionID:             sessionID,
		AuthToken:             authToken,
		ExpiresAtMS:           expiresAt.UnixMilli(),
		ControlPortCandidates: append([]int(nil), desktopControlPortCandidates...),
		ActiveControlPort:     activePort,
		WSPath:                loopbackTransportWSPath,
	}, nil
}

func serveLoopbackRPCWS(
	w http.ResponseWriter,
	r *http.Request,
	mux *http.ServeMux,
	store *control.RuntimeStore,
	auth *loopbackAuthManager,
) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Requests already passed allowTrustedLocalRequest, which validates loopback host
		// and Wateray desktop origins. Skip the library's secondary host-only check here.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "closed")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	helloCtx, helloCancel := context.WithTimeout(ctx, 5*time.Second)
	defer helloCancel()
	_, rawHello, err := conn.Read(helloCtx)
	if err != nil {
		return
	}
	var hello loopbackWSHelloMessage
	if err := json.Unmarshal(rawHello, &hello); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid hello payload")
		return
	}
	if hello.Type != "hello" || hello.ProtocolVersion != loopbackTransportProtocolVersion {
		_ = conn.Close(websocket.StatusPolicyViolation, "unsupported loopback protocol")
		return
	}
	if err := auth.validate(hello.SessionID, hello.AuthToken); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	if err := writeLoopbackWSJSON(ctx, conn, &sync.Mutex{}, loopbackWSHelloAckEnvelope{
		Type:            "hello_ack",
		ProtocolVersion: loopbackTransportProtocolVersion,
		SessionID:       hello.SessionID,
		ExpiresAtMS:     time.Now().Add(loopbackAuthTTL).UnixMilli(),
	}); err != nil {
		return
	}

	subID, events := store.SubscribePushEvents()
	defer store.UnsubscribePushEvents(subID)

	writeMu := &sync.Mutex{}
	requestCh := make(chan loopbackWSRequestEnvelope, 1)
	readErrCh := make(chan error, 1)

	go func() {
		for {
			_, message, readErr := conn.Read(ctx)
			if readErr != nil {
				readErrCh <- readErr
				return
			}
			var envelope loopbackWSRequestEnvelope
			if err := json.Unmarshal(message, &envelope); err != nil {
				readErrCh <- err
				return
			}
			requestCh <- envelope
		}
	}()

	heartbeatTicker := time.NewTicker(20 * time.Second)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-readErrCh:
			return
		case request := <-requestCh:
			if request.Type != "request" {
				if err := writeLoopbackWSJSON(ctx, conn, writeMu, loopbackWSResponseEnvelope{
					Type:      "response",
					RequestID: request.RequestID,
					OK:        false,
					Error:     "unsupported request type",
				}); err != nil {
					return
				}
				continue
			}
			response, err := dispatchLoopbackDaemonRequest(mux, request)
			if err != nil {
				response = loopbackWSResponseEnvelope{
					Type:      "response",
					RequestID: request.RequestID,
					OK:        false,
					Error:     err.Error(),
				}
			}
			if err := writeLoopbackWSJSON(ctx, conn, writeMu, response); err != nil {
				return
			}
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := writeLoopbackWSJSON(ctx, conn, writeMu, loopbackWSEventEnvelope{
				Type:      "event",
				EventType: "daemonPush",
				Payload:   event,
			}); err != nil {
				return
			}
		case <-heartbeatTicker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			pingErr := conn.Ping(pingCtx)
			pingCancel()
			if pingErr != nil {
				return
			}
		}
	}
}

func dispatchLoopbackDaemonRequest(
	mux *http.ServeMux,
	request loopbackWSRequestEnvelope,
) (loopbackWSResponseEnvelope, error) {
	if strings.TrimSpace(request.Command) != "daemon.request" {
		return loopbackWSResponseEnvelope{
			Type:      "response",
			RequestID: request.RequestID,
			OK:        false,
			Error:     "unsupported command",
		}, nil
	}
	var payload daemonRPCRequestPayload
	if len(request.Payload) > 0 && string(request.Payload) != "null" {
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return loopbackWSResponseEnvelope{}, fmt.Errorf("invalid daemon request payload: %w", err)
		}
	}
	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	path := strings.TrimSpace(payload.Path)
	if method == "" || path == "" {
		return loopbackWSResponseEnvelope{
			Type:      "response",
			RequestID: request.RequestID,
			OK:        false,
			Error:     "daemon method and path are required",
		}, nil
	}
	var bodyReader io.Reader
	if len(payload.Body) > 0 && string(payload.Body) != "null" {
		bodyReader = bytes.NewReader(payload.Body)
	}
	httpRequest := httptest.NewRequest(method, "http://127.0.0.1"+path, bodyReader)
	httpRequest.Host = "127.0.0.1"
	httpRequest.Header.Set("Accept", "application/json")
	if bodyReader != nil {
		httpRequest.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httpRequest)
	responseBody := recorder.Body.Bytes()
	var responsePayload any
	if len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, &responsePayload); err != nil {
			responsePayload = map[string]any{
				"ok":    false,
				"error": fmt.Sprintf("invalid response payload: %s", strings.TrimSpace(string(responseBody))),
			}
		}
	} else {
		responsePayload = map[string]any{
			"ok": recorder.Code >= http.StatusOK && recorder.Code < http.StatusBadRequest,
		}
	}
	okValue := recorder.Code >= http.StatusOK && recorder.Code < http.StatusBadRequest
	if payloadMap, isMap := responsePayload.(map[string]any); isMap {
		if rawOK, exists := payloadMap["ok"]; exists {
			if value, isBool := rawOK.(bool); isBool {
				okValue = value
			}
		}
	}
	return loopbackWSResponseEnvelope{
		Type:      "response",
		RequestID: request.RequestID,
		OK:        okValue,
		Payload:   responsePayload,
	}, nil
}

func writeLoopbackWSJSON(
	ctx context.Context,
	conn *websocket.Conn,
	writeMu *sync.Mutex,
	payload any,
) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
	defer writeCancel()
	writeMu.Lock()
	defer writeMu.Unlock()
	return conn.Write(writeCtx, websocket.MessageText, data)
}
