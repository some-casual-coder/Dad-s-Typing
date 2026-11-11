package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/admin"
	"github.com/dadstyping/whatsapp-connector/internal/config"
	"github.com/dadstyping/whatsapp-connector/internal/health"
	"github.com/dadstyping/whatsapp-connector/internal/inbound"
	"github.com/dadstyping/whatsapp-connector/internal/outbox"
	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

const version = "0.1.0"

type counts struct{ s *store.Store }

func (c counts) Pending(ctx context.Context) (int, int, error) {
	in, err := c.s.PendingInbox(ctx)
	if err != nil {
		return 0, 0, err
	}
	out, err := c.s.PendingAcks(ctx)
	return in, out, err
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err.Error())
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	if err := store.Prepare(cfg.DataDir, "connector.db", "session.db"); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	st, err := store.Open(filepath.Join(cfg.DataDir, "connector.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	if n, err := st.ExpireDispatching(ctx, time.Now()); err != nil {
		return err
	} else if n > 0 {
		log.Warn("interrupted sends marked unknown", "count", n)
	}
	tr, err := transport.NewWA(ctx, store.DSN(filepath.Join(cfg.DataDir, "session.db")),
		os.Getenv("WHATSMEOW_LOG_LEVEL"), "Dad's Typing", log)
	if err != nil {
		return err
	}
	defer tr.Close()

	ts := tsapp.New(cfg.TSBaseURL, cfg.BridgeSecret)
	fwd := &inbound.Forwarder{
		Store: st, Post: ts, Log: log, Now: time.Now, MaxAttempts: 15,
		BaseDelay: 2 * time.Second, MaxDelay: 5 * time.Minute,
		PollEvery: 5 * time.Second,
	}
	fwd.Init()
	ing := &inbound.Ingestor{
		Store: st, Log: log, Wake: fwd.Wake, Now: time.Now,
		DownloadTries: 3, DownloadWait: 2 * time.Second,
		MaxAge: 48 * time.Hour,
	}
	ob := &outbox.Worker{
		Store: st, TS: ts, TR: tr, Log: log, Now: time.Now,
		Sleep: outbox.RealSleep, ClaimLimit: 5, LeaseSeconds: 120,
		PollEvery: 3 * time.Second, MinDelay: 3 * time.Second,
		Jitter: time.Second, RecipientCap: 20, RecipientSpan: time.Hour,
		AckTries: 4, AckBackoff: time.Second, SendTimeout: 60 * time.Second,
	}
	hr := &health.Reporter{
		Post: ts, State: tr.State, Version: version, Log: log,
		Now: time.Now, Every: health.Interval,
	}
	hr.Init()

	var lastEvent atomic.Int64
	adm := &admin.Server{
		Token: cfg.AdminToken, TR: tr, Counts: counts{st}, Notify: hr.Notify,
		LastEvent: func() time.Time {
			if n := lastEvent.Load(); n != 0 {
				return time.Unix(0, n)
			}
			return time.Time{}
		},
	}
	srv := &http.Server{
		Addr: cfg.AdminAddr, Handler: adm.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if err := tr.Start(ctx); err != nil {
		return err
	}
	var wg sync.WaitGroup
	spawn := func(f func()) {
		wg.Add(1)
		go func() { defer wg.Done(); f() }()
	}
	spawn(func() { fwd.Run(ctx) })
	spawn(func() { ob.Run(ctx) })
	spawn(func() { hr.Run(ctx) })
	spawn(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-tr.Events():
				lastEvent.Store(time.Now().UnixNano())
				switch ev.Kind {
				case transport.EventMessage:
					ing.Ingest(ctx, *ev.Message)
				case transport.EventState:
					hr.Notify()
				}
			}
		}
	})
	srvErr := make(chan error, 1)
	go func() { srvErr <- srv.ListenAndServe() }()
	log.Info("connector started", "admin", cfg.AdminAddr, "version", version)

	select {
	case <-ctx.Done():
	case err := <-srvErr:
		if !errors.Is(err, http.ErrServerClosed) {
			stop()
			wg.Wait()
			return err
		}
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	wg.Wait()
	return nil
}
