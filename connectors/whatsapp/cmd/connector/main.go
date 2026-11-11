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

func (c counts) Pending(ctx context.Context) (in, out, failed int, err error) {
	if in, err = c.s.PendingInbox(ctx); err != nil {
		return
	}
	if out, err = c.s.PendingAcks(ctx); err != nil {
		return
	}
	failed, err = c.s.FailedInbox(ctx)
	return
}

// healthz is the container health probe: exit 0 only when ready.
func healthz() int {
	addr := os.Getenv("ADMIN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/healthz", nil)
	if err != nil {
		return 1
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("ADMIN_TOKEN"))
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func purgeLoop(ctx context.Context, st *store.Store, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		p, err := st.Purge(ctx, time.Now())
		if err != nil && ctx.Err() == nil {
			log.Error("retention purge failed", "err", "db")
		} else if p.Failed > 0 {
			log.Error("failed inbox rows expired unforwarded", "count", p.Failed)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthz" {
		os.Exit(healthz())
	}
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

	if cfg.InsecureTS {
		log.Warn("TS_BASE_URL is plain http to a non-loopback host; " +
			"traffic (including image bodies) is unencrypted")
	}
	ts := tsapp.New(cfg.TSBaseURL, cfg.BridgeSecret, config.Channel)
	fwd := &inbound.Forwarder{
		Store: st, Post: ts, Log: log, Now: time.Now,
		BaseDelay: 2 * time.Second, MaxDelay: time.Hour,
		FailedRetry: 6 * time.Hour, PollEvery: 5 * time.Second,
	}
	fwd.Init()
	ing := &inbound.Ingestor{
		Store: st, Log: log, Wake: fwd.Wake, Now: time.Now,
		DownloadTries: 3, DownloadWait: 2 * time.Second,
		MaxAge: 48 * time.Hour, Allowed: allowed(cfg.AllowedSenders),
	}
	ob := &outbox.Worker{
		Store: st, TS: ts, TR: tr, Log: log, Now: time.Now,
		Sleep: outbox.RealSleep, ClaimLimit: 2, LeaseSeconds: 300,
		PollEvery: 3 * time.Second, MinDelay: 3 * time.Second,
		Jitter: time.Second, RecipientCap: 20, RecipientSpan: time.Hour,
		AckBackoff: 5 * time.Second, AckMaxBackoff: time.Hour,
		SendTimeout: 60 * time.Second, RecordTimeout: 10 * time.Second,
	}
	hr := &health.Reporter{
		Post: ts, State: tr.State, Version: version, Log: log,
		Now: time.Now, Every: health.Interval,
		Degraded: func(ctx context.Context) bool {
			n, err := st.FailedInbox(ctx)
			return err == nil && n > 0
		},
	}
	hr.Init()

	var lastEvent atomic.Int64
	adm := &admin.Server{
		Token: cfg.AdminToken, TR: tr, Counts: counts{st}, Notify: hr.Notify,
		Port: config.AdminPort(cfg.AdminAddr),
		LastEvent: func() time.Time {
			if n := lastEvent.Load(); n != 0 {
				return time.Unix(0, n)
			}
			return time.Time{}
		},
	}
	srv := &http.Server{
		Addr: cfg.AdminAddr, Handler: adm.Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second,
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
	spawn(func() { purgeLoop(ctx, st, log) })
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

func allowed(list []string) map[string]struct{} {
	if len(list) == 0 {
		return nil
	}
	m := make(map[string]struct{}, len(list))
	for _, s := range list {
		m[s] = struct{}{}
	}
	return m
}
