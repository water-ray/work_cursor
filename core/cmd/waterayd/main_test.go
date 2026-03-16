package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllowTrustedLocalRequest(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		host         string
		origin       string
		secFetchSite string
		wantOK       bool
		wantStatus   int
		wantError    string
	}{
		{
			name:   "allow request without origin",
			host:   "127.0.0.1:39080",
			wantOK: true,
		},
		{
			name:   "allow tauri dev localhost origin",
			host:   "127.0.0.1:39080",
			origin: "http://localhost:1420",
			wantOK: true,
		},
		{
			name:   "allow tauri dev loopback origin",
			host:   "localhost:39080",
			origin: "http://127.0.0.1:1420",
			wantOK: true,
		},
		{
			name:   "allow tauri packaged origin",
			host:   "127.0.0.1:39080",
			origin: "tauri://localhost",
			wantOK: true,
		},
		{
			name:   "allow loopback rpc candidate origin",
			host:   "127.0.0.1:59501",
			origin: "http://127.0.0.1:59501",
			wantOK: true,
		},
		{
			name:       "reject unexpected origin",
			host:       "127.0.0.1:39080",
			origin:     "https://evil.example",
			wantOK:     false,
			wantStatus: http.StatusForbidden,
			wantError:  "forbidden origin",
		},
		{
			name:       "reject unexpected host",
			host:       "192.168.1.2:39080",
			origin:     "http://localhost:1420",
			wantOK:     false,
			wantStatus: http.StatusForbidden,
			wantError:  "forbidden host",
		},
		{
			name:         "reject cross site request",
			host:         "127.0.0.1:39080",
			origin:       "http://localhost:1420",
			secFetchSite: "cross-site",
			wantOK:       false,
			wantStatus:   http.StatusForbidden,
			wantError:    "cross-site requests are forbidden",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:39080/v1/state", nil)
			req.Host = tt.host
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			if tt.secFetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tt.secFetchSite)
			}

			recorder := httptest.NewRecorder()
			got := allowTrustedLocalRequest(recorder, req)
			if got != tt.wantOK {
				t.Fatalf("allowTrustedLocalRequest() = %v, want %v", got, tt.wantOK)
			}
			if tt.wantOK {
				return
			}
			if recorder.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tt.wantStatus)
			}

			var payload struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error payload: %v", err)
			}
			if payload.Error != tt.wantError {
				t.Fatalf("error = %q, want %q", payload.Error, tt.wantError)
			}
		})
	}
}

func TestNormalizeOrigin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		input      string
		wantOrigin string
		wantOK     bool
	}{
		{
			name:       "normalize localhost http origin",
			input:      " http://LOCALHOST:1420/ ",
			wantOrigin: "http://localhost:1420",
			wantOK:     true,
		},
		{
			name:       "normalize tauri origin",
			input:      "tauri://localhost",
			wantOrigin: "tauri://localhost",
			wantOK:     true,
		},
		{
			name:   "reject opaque origin",
			input:  "null",
			wantOK: false,
		},
		{
			name:   "reject unsupported scheme",
			input:  "file://localhost",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			gotOrigin, gotOK := normalizeOrigin(tt.input)
			if gotOK != tt.wantOK {
				t.Fatalf("normalizeOrigin() ok = %v, want %v", gotOK, tt.wantOK)
			}
			if gotOrigin != tt.wantOrigin {
				t.Fatalf("normalizeOrigin() origin = %q, want %q", gotOrigin, tt.wantOrigin)
			}
		})
	}
}
