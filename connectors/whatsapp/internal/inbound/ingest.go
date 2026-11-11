package inbound

import (
	"context"
	"encoding/base64"
	"log/slog"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/transport"
)

const downloadTimeout = 60 * time.Second

type Ingestor struct {
	Store *store.Store
	Log   *slog.Logger
	Wake  func()
	Now   func() time.Time
	// DownloadTries bounds image download attempts; DownloadWait spaces them.
	DownloadTries int
	DownloadWait  time.Duration
	// MaxAge drops replayed history older than this; zero disables.
	MaxAge time.Duration
}

// Redact keeps only the last 4 characters of an id for logs.
func Redact(s string) string {
	if len(s) <= 4 {
		return "****"
	}
	return "…" + s[len(s)-4:]
}

// Ingest filters, downloads and persists a message; forwarding is separate.
func (g *Ingestor) Ingest(ctx context.Context, m transport.Message) {
	if reason := Filter(m); reason != "" {
		g.Log.Info("inbound dropped", "reason", reason)
		return
	}
	if ok, err := g.Store.HasInbox(ctx, m.ID); err != nil {
		g.Log.Error("inbox lookup failed", "err", "db")
		return
	} else if ok {
		g.Log.Info("inbound duplicate", "id", Redact(m.ID))
		return
	}
	if g.MaxAge > 0 && !m.Timestamp.IsZero() &&
		g.Now().Sub(m.Timestamp) > g.MaxAge {
		g.Log.Info("inbound dropped", "reason", DropStale)
		return
	}
	row := store.InboxMsg{
		ProviderID: m.ID, Sender: m.Sender, Text: m.Text,
		ReceivedAt: m.Timestamp.UTC(),
	}
	if row.ReceivedAt.IsZero() {
		row.ReceivedAt = g.Now().UTC()
	}
	if m.Kind == transport.KindImage {
		data, err := g.download(ctx, m)
		if err != nil {
			g.Log.Error("image download failed", "id", Redact(m.ID),
				"err", "download")
			return
		}
		mime := SniffImage(data)
		if mime == "" || len(data) > MaxImageBytes {
			g.Log.Info("inbound dropped", "reason", DropOversize+"_or_mime")
			return
		}
		row.ImageMime = mime
		row.ImageB64 = base64.StdEncoding.EncodeToString(data)
	}
	if _, err := g.Store.InsertInbox(ctx, row, g.Now()); err != nil {
		g.Log.Error("inbox insert failed", "id", Redact(m.ID), "err", "db")
		return
	}
	g.Wake()
}

func (g *Ingestor) download(ctx context.Context, m transport.Message) ([]byte, error) {
	var err error
	for i := 0; i < g.DownloadTries; i++ {
		var data []byte
		dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
		data, err = m.Image(dctx)
		cancel()
		if err == nil {
			return data, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(g.DownloadWait):
		}
	}
	return nil, err
}
