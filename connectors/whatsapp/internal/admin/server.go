package admin

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/mdp/qrterminal/v3"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
)

const RepairInstruction = "WhatsApp session is not usable. Run POST /pair " +
	`{"phone":"<digits>"} or GET /pair/qr, then on the phone open ` +
	"Settings > Linked devices > Link a device to complete pairing."

type Counts interface {
	Pending(ctx context.Context) (inbox, outbox, failed int, err error)
}

type Server struct {
	Token     string
	TR        transport.Transport
	Counts    Counts
	LastEvent func() time.Time
	Notify    func()
	// Port is the configured admin port; Host headers must carry it.
	Port string
}

type Status struct {
	Connected     bool   `json:"connected"`
	Paired        bool   `json:"paired"`
	LoggedOut     bool   `json:"loggedOut"`
	Reason        string `json:"reason,omitempty"`
	PendingInbox  int    `json:"pendingInbox"`
	PendingOutbox int    `json:"pendingOutbox"`
	FailedInbox   int    `json:"failedInbox"`
	LastEventAt   string `json:"lastEventAt"`
	Instruction   string `json:"instruction,omitempty"`
}

var phoneRe = regexp.MustCompile(`^[0-9]{8,15}$`)

var digitsRe = regexp.MustCompile(`[0-9]{6,}`)

// redact shortens an upstream error for the operator, masking anything that
// could be a phone number or JID user part.
func redact(err error) string {
	msg := digitsRe.ReplaceAllString(err.Error(), "…")
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /status", s.status)
	mux.HandleFunc("POST /pair", s.pair)
	mux.HandleFunc("POST /pair/qr", s.startQR)
	mux.HandleFunc("GET /pair/qr", s.qr)
	mux.HandleFunc("POST /logout", s.logout)
	return s.local(s.auth(mux))
}

// local rejects non-loopback peers and unexpected Host headers.
func (s *Server) local(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() || !s.hostOK(r.Host) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) hostOK(h string) bool {
	host, port, err := net.SplitHostPort(h)
	if err != nil || port != s.Port {
		return false
	}
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		ok := strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") &&
			subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) == 1
		if !ok {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	st := s.TR.State()
	if st.Ready() {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	st := s.TR.State()
	in, out, failed, err := s.Counts.Pending(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db"})
		return
	}
	res := Status{
		Connected: st.Connected, Paired: st.Paired, LoggedOut: st.Halted,
		Reason: st.Reason, PendingInbox: in, PendingOutbox: out, FailedInbox: failed,
	}
	if t := s.LastEvent(); !t.IsZero() {
		res.LastEventAt = t.UTC().Format(time.RFC3339)
	}
	switch {
	case st.Reason == transport.ReasonClientOutdated:
		res.Instruction = "WhatsApp rejected this client version. Upgrade " +
			"whatsmeow, rebuild and redeploy the connector."
	case st.Reason == transport.ReasonStreamReplaced:
		res.Instruction = "Another client took over this session. Stop the " +
			"other instance, then restart this connector."
	case st.Reason == transport.ReasonTemporaryBan:
		res.Instruction = "Temporarily banned by WhatsApp. Sends are paused " +
			"until the ban expires; do not re-pair."
	case st.Halted || !st.Paired:
		res.Instruction = RepairInstruction
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	if err := dec.Decode(&in); err != nil || !phoneRe.MatchString(in.Phone) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "phone must be 8-15 digits, international format, no +"})
		return
	}
	code, err := s.TR.PairPhone(r.Context(), in.Phone)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "pair_failed", "reason": redact(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func (s *Server) startQR(w http.ResponseWriter, r *http.Request) {
	st := s.TR.State()
	if st.Paired && !st.Halted {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already_paired"})
		return
	}
	if err := s.TR.StartQR(r.Context()); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "qr_failed", "reason": redact(err)})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "started"})
}

// qr is read-only: it renders the current code, if pairing is under way.
func (s *Server) qr(w http.ResponseWriter, _ *http.Request) {
	code := s.TR.QR()
	if code == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no_qr_yet"})
		return
	}
	var buf bytes.Buffer
	qrterminal.GenerateHalfBlock(code, qrterminal.L, &buf)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.TR.Logout(r.Context()); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "logout_failed"})
		return
	}
	if s.Notify != nil {
		s.Notify()
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
