package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
)

const tok = "admin-token-admin-token-admin-token-00"

type fakeCounts struct{}

func (fakeCounts) Pending(context.Context) (int, int, error) { return 2, 1, nil }

func setup() (*Server, *transport.Fake, http.Handler) {
	tr := transport.NewFake()
	s := &Server{Token: tok, TR: tr, Counts: fakeCounts{},
		LastEvent: func() time.Time { return time.Unix(1700000000, 0) }}
	return s, tr, s.Handler()
}

func do(h http.Handler, method, path, auth, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuthRequiredEverywhere(t *testing.T) {
	_, _, h := setup()
	routes := [][2]string{{"GET", "/healthz"}, {"GET", "/status"}, {"POST", "/pair"},
		{"GET", "/pair/qr"}, {"POST", "/logout"}}
	for _, r := range routes {
		for _, auth := range []string{"", "Bearer ", "Bearer wrong", tok, "Basic " + tok, "Bearer " + tok + "x"} {
			if c := do(h, r[0], r[1], auth, "{}").Code; c != http.StatusUnauthorized {
				t.Errorf("%s %s auth=%q: %d", r[0], r[1], auth, c)
			}
		}
	}
}

func TestHealthz(t *testing.T) {
	_, tr, h := setup()
	if c := do(h, "GET", "/healthz", "Bearer "+tok, "").Code; c != 200 {
		t.Fatalf("connected: %d", c)
	}
	tr.SetState(transport.State{Paired: true})
	if c := do(h, "GET", "/healthz", "Bearer "+tok, "").Code; c != 503 {
		t.Fatalf("disconnected: %d", c)
	}
	tr.SetState(transport.State{Connected: true})
	if c := do(h, "GET", "/healthz", "Bearer "+tok, "").Code; c != 503 {
		t.Fatalf("unpaired: %d", c)
	}
}

func TestStatusAndRepairInstruction(t *testing.T) {
	_, tr, h := setup()
	body := do(h, "GET", "/status", "Bearer "+tok, "").Body.String()
	for _, want := range []string{`"connected":true`, `"paired":true`, `"loggedOut":false`,
		`"pendingInbox":2`, `"pendingOutbox":1`, `"lastEventAt":"2023-11-14T22:13:20Z"`} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %s in %s", want, body)
		}
	}
	if strings.Contains(body, "instruction") {
		t.Error("instruction shown while healthy")
	}
	tr.SetState(transport.State{Halted: true, Reason: transport.ReasonLoggedOut})
	body = do(h, "GET", "/status", "Bearer "+tok, "").Body.String()
	if !strings.Contains(body, `"loggedOut":true`) || !strings.Contains(body, "Linked devices") {
		t.Errorf("no repair instruction: %s", body)
	}
}

func TestPair(t *testing.T) {
	_, tr, h := setup()
	tr.SetState(transport.State{})
	for _, bad := range []string{`{}`, `{"phone":"+254712345678"}`, `{"phone":"12"}`, `nope`} {
		if c := do(h, "POST", "/pair", "Bearer "+tok, bad).Code; c != 400 {
			t.Errorf("%s: %d", bad, c)
		}
	}
	rec := do(h, "POST", "/pair", "Bearer "+tok, `{"phone":"254712345678"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ABCD-1234") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestQRAndLogout(t *testing.T) {
	_, tr, h := setup()
	if c := do(h, "GET", "/pair/qr", "Bearer "+tok, "").Code; c != 409 {
		t.Fatalf("paired qr: %d", c)
	}
	tr.SetState(transport.State{})
	tr.QRCode = "2@abc,def,ghi"
	rec := do(h, "GET", "/pair/qr", "Bearer "+tok, "")
	if rec.Code != 200 || rec.Body.Len() < 50 {
		t.Fatalf("qr %d len %d", rec.Code, rec.Body.Len())
	}
	tr.SetState(transport.State{Connected: true, Paired: true})
	if c := do(h, "POST", "/logout", "Bearer "+tok, "").Code; c != 200 {
		t.Fatalf("logout %d", c)
	}
	if !tr.State().Halted {
		t.Fatal("not halted after logout")
	}
}

func TestMethodNotAllowed(t *testing.T) {
	_, _, h := setup()
	if c := do(h, "POST", "/status", "Bearer "+tok, "").Code; c != http.StatusMethodNotAllowed {
		t.Fatalf("%d", c)
	}
}

func TestInstructionByReason(t *testing.T) {
	_, tr, h := setup()
	for reason, want := range map[string]string{
		transport.ReasonClientOutdated: "Upgrade whatsmeow",
		transport.ReasonStreamReplaced: "Another client",
		transport.ReasonTemporaryBan:   "do not re-pair",
	} {
		tr.SetState(transport.State{Halted: true, Reason: reason})
		body := do(h, "GET", "/status", "Bearer "+tok, "").Body.String()
		if !strings.Contains(body, want) {
			t.Errorf("%s: %s", reason, body)
		}
	}
}
