// Package tstest is a signature-checking fake of the TS app for tests.
package tstest

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/signer"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

const Secret = "test-secret-test-secret-test-secret-0000"

type Server struct {
	*httptest.Server
	mu          sync.Mutex
	FailInbound int
	FailAck     bool
	Accepted    map[string]int
	Calls       int
	Queue       []tsapp.Item
	Acks        map[string][]tsapp.Ack
	Healths     []tsapp.Health
	BadSig      int
	Last        []tsapp.InboundPayload
}

func New() *Server {
	s := &Server{Accepted: map[string]int{}, Acks: map[string][]tsapp.Ack{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}

func (s *Server) Lock()   { s.mu.Lock() }
func (s *Server) Unlock() { s.mu.Unlock() }

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	err := signer.Verify(Secret, r.Header.Get(signer.HeaderTimestamp),
		r.Header.Get(signer.HeaderSignature), r.Method, r.URL.Path, body, time.Now())
	if err != nil {
		s.BadSig++
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	p := r.URL.Path
	switch {
	case p == "/api/channel/whatsapp/inbound":
		s.Calls++
		if s.FailInbound > 0 {
			s.FailInbound--
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var in tsapp.InboundPayload
		_ = json.Unmarshal(body, &in)
		s.Accepted[in.ProviderMessageID]++
		s.Last = append(s.Last, in)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	case p == "/api/channel/whatsapp/outbox/claim":
		var items []tsapp.Item
		for _, it := range s.Queue {
			if len(s.Acks[it.ID]) == 0 {
				items = append(items, it)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	case strings.HasSuffix(p, "/ack"):
		if s.FailAck {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/api/channel/whatsapp/outbox/"), "/ack")
		var a tsapp.Ack
		_ = json.Unmarshal(body, &a)
		s.Acks[id] = append(s.Acks[id], a)
		_, _ = w.Write([]byte(`{"state":"` + a.State + `"}`))
	case p == "/api/channel/whatsapp/health":
		var h tsapp.Health
		_ = json.Unmarshal(body, &h)
		s.Healths = append(s.Healths, h)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}
