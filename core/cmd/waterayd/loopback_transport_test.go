package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBuildLoopbackBootstrapPayload(t *testing.T) {
	t.Parallel()

	auth := newLoopbackAuthManager()
	bootstrap, err := buildLoopbackBootstrapPayload(auth, 59501)
	if err != nil {
		t.Fatalf("buildLoopbackBootstrapPayload() error = %v", err)
	}
	if bootstrap.ProtocolVersion != loopbackTransportProtocolVersion {
		t.Fatalf("protocolVersion = %d, want %d", bootstrap.ProtocolVersion, loopbackTransportProtocolVersion)
	}
	if bootstrap.PlatformKind != "desktop" {
		t.Fatalf("platformKind = %q, want desktop", bootstrap.PlatformKind)
	}
	if bootstrap.ActiveControlPort != 59501 {
		t.Fatalf("activeControlPort = %d, want 59501", bootstrap.ActiveControlPort)
	}
	if bootstrap.SessionID == "" || bootstrap.AuthToken == "" {
		t.Fatalf("expected non-empty session/auth token")
	}
	if bootstrap.WSPath != loopbackTransportWSPath {
		t.Fatalf("wsPath = %q, want %q", bootstrap.WSPath, loopbackTransportWSPath)
	}
	if len(bootstrap.ControlPortCandidates) != len(desktopControlPortCandidates) {
		t.Fatalf("controlPortCandidates length = %d, want %d", len(bootstrap.ControlPortCandidates), len(desktopControlPortCandidates))
	}
	if err := auth.validate(bootstrap.SessionID, bootstrap.AuthToken); err != nil {
		t.Fatalf("validate() error = %v", err)
	}
}

func TestLoopbackAuthManagerRejectsExpiredSession(t *testing.T) {
	t.Parallel()

	auth := newLoopbackAuthManager()
	auth.sessions["expired-session"] = loopbackAuthSession{
		token:     "expired-token",
		expiresAt: time.Now().Add(-1 * time.Second),
	}
	if err := auth.validate("expired-session", "expired-token"); err == nil {
		t.Fatal("validate() expected error for expired session")
	}
}

func TestDispatchLoopbackDaemonRequest(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/test", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    true,
			"error": "",
		})
	})

	response, err := dispatchLoopbackDaemonRequest(mux, loopbackWSRequestEnvelope{
		Type:      "request",
		RequestID: "req-1",
		Command:   "daemon.request",
		Payload:   []byte(`{"method":"POST","path":"/v1/test","body":{"hello":"world"}}`),
	})
	if err != nil {
		t.Fatalf("dispatchLoopbackDaemonRequest() error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected OK response, got %#v", response)
	}
	if response.RequestID != "req-1" {
		t.Fatalf("requestId = %q, want req-1", response.RequestID)
	}

	recorder := httptest.NewRecorder()
	writeJSON(recorder, http.StatusOK, response.Payload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("payload recorder status = %d, want 200", recorder.Code)
	}
}
