package tsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/signer"
)

const (
	MaxBody     = 6 << 20
	maxResponse = 1 << 20
)

type StatusError struct{ Code int }

func (e *StatusError) Error() string { return "ts app status " + strconv.Itoa(e.Code) }

// IsPermanent reports responses that retrying the same body cannot fix.
func IsPermanent(err error) bool {
	var se *StatusError
	if !errors.As(err, &se) {
		return false
	}
	switch se.Code {
	case 400, 404, 413, 422:
		return true
	}
	return false
}

type Client struct {
	base   string
	secret string
	http   *http.Client
	now    func() time.Time
}

func New(base, secret string) *Client {
	return &Client{
		base:   base,
		secret: secret,
		now:    time.Now,
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (c *Client) post(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if len(body) > MaxBody {
		return &StatusError{Code: 413}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	ts, sig := signer.Headers(c.secret, http.MethodPost, path, body, c.now())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(signer.HeaderTimestamp, ts)
	req.Header.Set(signer.HeaderSignature, sig)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ts request failed: %w", sanitize(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return fmt.Errorf("ts response read failed: %w", sanitize(err))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &StatusError{Code: resp.StatusCode}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// sanitize drops the URL from transport errors so logs stay clean.
func sanitize(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) && ue.Unwrap() != nil {
		return ue.Unwrap()
	}
	return err
}

type Image struct {
	Mime   string `json:"mime"`
	Base64 string `json:"base64"`
}

type InboundPayload struct {
	ProviderMessageID string `json:"providerMessageId"`
	Sender            string `json:"sender"`
	Text              string `json:"text,omitempty"`
	Image             *Image `json:"image,omitempty"`
	ReceivedAt        string `json:"receivedAt"`
}

func (c *Client) Inbound(ctx context.Context, p InboundPayload) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	err := c.post(ctx, "/api/channel/whatsapp/inbound", p, &out)
	return out.Status, err
}

type Item struct {
	ID        string `json:"id"`
	Recipient string `json:"recipient"`
	Body      string `json:"body"`
	Attempt   int    `json:"attempt"`
}

func (c *Client) Claim(ctx context.Context, limit, lease int) ([]Item, error) {
	var out struct {
		Items []Item `json:"items"`
	}
	err := c.post(ctx, "/api/channel/whatsapp/outbox/claim",
		map[string]int{"limit": limit, "leaseSeconds": lease}, &out)
	return out.Items, err
}

type Ack struct {
	State             string `json:"state"`
	ProviderMessageID string `json:"providerMessageId,omitempty"`
	Error             string `json:"error,omitempty"`
}

func (c *Client) Ack(ctx context.Context, id string, a Ack) error {
	return c.post(ctx, "/api/channel/whatsapp/outbox/"+id+"/ack", a, nil)
}

type Health struct {
	Connected bool   `json:"connected"`
	Paired    bool   `json:"paired"`
	LoggedOut bool   `json:"loggedOut"`
	Version   string `json:"version"`
	At        string `json:"at"`
}

func (c *Client) Health(ctx context.Context, h Health) error {
	return c.post(ctx, "/api/channel/whatsapp/health", h, nil)
}
