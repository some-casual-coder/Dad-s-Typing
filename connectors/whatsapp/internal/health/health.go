package health

import (
	"context"
	"log/slog"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

const Interval = 30 * time.Second

type Poster interface {
	Health(ctx context.Context, h tsapp.Health) error
}

type Reporter struct {
	Post    Poster
	State   func() transport.State
	Version string
	Log     *slog.Logger
	Now     func() time.Time
	Every   time.Duration
	kick    chan struct{}
}

func (r *Reporter) Init() { r.kick = make(chan struct{}, 1) }

// Notify requests an immediate report after a state change.
func (r *Reporter) Notify() {
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

func (r *Reporter) Report(ctx context.Context) error {
	s := r.State()
	return r.Post.Health(ctx, tsapp.Health{
		Connected: s.Connected,
		Paired:    s.Paired,
		LoggedOut: s.Halted,
		Version:   r.Version,
		At:        r.Now().UTC().Format(time.RFC3339),
	})
}

func (r *Reporter) Run(ctx context.Context) {
	t := time.NewTicker(r.Every)
	defer t.Stop()
	for {
		if err := r.Report(ctx); err != nil && ctx.Err() == nil {
			r.Log.Warn("health report failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-r.kick:
		}
	}
}
