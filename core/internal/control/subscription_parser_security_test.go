package control

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestValidateSubscriptionURLRejectsUnsafeTargets(t *testing.T) {
	t.Run("unsupported scheme", func(t *testing.T) {
		err := validateSubscriptionURL("ftp://example.com/sub")
		if err == nil {
			t.Fatalf("expected unsupported scheme error")
		}
	})

	t.Run("localhost host", func(t *testing.T) {
		err := validateSubscriptionURL("https://localhost/sub")
		if err == nil || !strings.Contains(err.Error(), "localhost") {
			t.Fatalf("expected localhost rejection, got %v", err)
		}
	})

	t.Run("private ip", func(t *testing.T) {
		err := validateSubscriptionURL("https://127.0.0.1/sub")
		if err == nil || !strings.Contains(err.Error(), "not allowed") {
			t.Fatalf("expected private ip rejection, got %v", err)
		}
	})
}

func TestDownloadTextAllowsUnexpectedContentType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html>blocked</html>")
	}))
	defer server.Close()

	parser := &SubscriptionParser{client: server.Client()}
	body, statusCode, bytesLen, err := parser.downloadText(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("expected html content-type to be accepted, got %v", err)
	}
	if statusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", statusCode)
	}
	if bytesLen != len("<html>blocked</html>") {
		t.Fatalf("expected bytes len %d, got %d", len("<html>blocked</html>"), bytesLen)
	}
	if body != "<html>blocked</html>" {
		t.Fatalf("expected html body returned, got %q", body)
	}
}

func TestDownloadTextRejectsOversizedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, strings.Repeat("a", maxSubscriptionResponseBytes+1))
	}))
	defer server.Close()

	parser := &SubscriptionParser{client: server.Client()}
	_, statusCode, _, err := parser.downloadText(context.Background(), server.URL)
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("expected body limit rejection, got %v", err)
	}
	if statusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", statusCode)
	}
}

func TestFetchAndParseSanitizesURLInDownloadError(t *testing.T) {
	parser := &SubscriptionParser{
		client: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				return nil, errors.New("network down")
			}),
		},
	}

	_, err := parser.FetchAndParse(
		context.Background(),
		"https://1.1.1.1/sub?token=secret-token&sig=secret-signature",
		"group-1",
	)
	if err == nil {
		t.Fatalf("expected fetch error")
	}
	message := err.Error()
	if strings.Contains(message, "secret-token") || strings.Contains(message, "secret-signature") {
		t.Fatalf("expected sanitized error, got %s", message)
	}
	if !strings.Contains(message, "token=%2A%2A%2A") || !strings.Contains(message, "sig=%2A%2A%2A") {
		t.Fatalf("expected masked query in error, got %s", message)
	}
}
