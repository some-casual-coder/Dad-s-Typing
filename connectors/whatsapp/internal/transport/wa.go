package transport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var phoneRe = regexp.MustCompile(`^[0-9]{6,15}$`)

// WA is the whatsmeow-backed Transport.
type WA struct {
	container *sqlstore.Container
	display   string
	waLogger  waLog.Logger
	log       *slog.Logger
	events    chan Event
	done      chan struct{}
	closeOnce sync.Once

	mu          sync.RWMutex
	client      *whatsmeow.Client
	reason      string
	bannedUntil time.Time
	qr          string
	pairing     bool
	rootCtx     context.Context
}

// NewWA opens the session store; logLevel "" silences whatsmeow's logger.
func NewWA(ctx context.Context, dsn, logLevel, display string,
	log *slog.Logger) (*WA, error) {
	wl := waLog.Noop
	if logLevel != "" {
		wl = waLog.Stdout("whatsmeow", logLevel, false)
	}
	c, err := sqlstore.New(ctx, "sqlite3", dsn, wl)
	if err != nil {
		return nil, fmt.Errorf("open session store: %w", err)
	}
	dev, err := c.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("load device: %w", err)
	}
	w := &WA{
		container: c, display: display, waLogger: wl, log: log,
		events: make(chan Event, 256), done: make(chan struct{}),
		rootCtx: ctx,
	}
	w.client = w.newClient(dev)
	return w, nil
}

func (w *WA) newClient(dev *store.Device) *whatsmeow.Client {
	cl := whatsmeow.NewClient(dev, w.waLogger)
	cl.EnableAutoReconnect = true
	cl.AddEventHandler(func(e any) { w.handle(cl, e) })
	return cl
}

func (w *WA) cur() *whatsmeow.Client {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.client
}

func (w *WA) Events() <-chan Event { return w.events }

func (w *WA) emit(ev Event) {
	select {
	case w.events <- ev:
	case <-w.done:
	}
}

func (w *WA) emitState() { w.emit(Event{Kind: EventState, State: w.State()}) }

func (w *WA) State() State {
	w.mu.RLock()
	defer w.mu.RUnlock()
	cl := w.client
	s := State{
		Paired:    cl.Store != nil && cl.Store.ID != nil,
		Connected: cl.IsConnected() && cl.IsLoggedIn(),
		Reason:    w.reason,
	}
	if w.reason == ReasonTemporaryBan && time.Now().After(w.bannedUntil) {
		s.Reason = ""
	}
	s.Halted = s.Reason != ""
	return s
}

func (w *WA) halt(reason string) {
	w.mu.Lock()
	w.reason = reason
	w.mu.Unlock()
	w.emitState()
}

func (w *WA) NewMessageID() string { return string(w.cur().GenerateMessageID()) }

// Start connects with the stored session; unpaired waits for pairing.
func (w *WA) Start(ctx context.Context) error {
	w.mu.Lock()
	w.rootCtx = ctx
	w.mu.Unlock()
	if w.State().Paired {
		go w.connectLoop(ctx, w.cur())
	}
	return nil
}

func (w *WA) connectLoop(ctx context.Context, cl *whatsmeow.Client) {
	delay := time.Second
	for ctx.Err() == nil {
		if w.cur() != cl || w.State().Halted {
			return
		}
		err := cl.Connect()
		if err == nil || errors.Is(err, whatsmeow.ErrAlreadyConnected) {
			return
		}
		w.log.Warn("whatsapp connect failed", "retry_in", delay.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay + time.Duration(rand.Int64N(int64(delay)/2))):
		}
		delay = min(delay*2, time.Minute)
	}
}

func (w *WA) handle(cl *whatsmeow.Client, e any) {
	switch ev := e.(type) {
	case *events.Message:
		w.emit(Event{Kind: EventMessage, Message: mapMessage(cl, ev)})
	case *events.Connected, *events.Disconnected, *events.PairSuccess:
		if _, ok := e.(*events.PairSuccess); ok {
			w.mu.Lock()
			w.reason, w.qr = "", ""
			w.mu.Unlock()
		}
		w.emitState()
	case *events.LoggedOut:
		w.halt(ReasonLoggedOut)
	case *events.StreamReplaced:
		w.halt(ReasonStreamReplaced)
	case *events.TemporaryBan:
		wait := ev.Expire
		if wait <= 0 {
			wait = time.Hour
		}
		w.mu.Lock()
		w.bannedUntil = time.Now().Add(wait)
		w.mu.Unlock()
		time.AfterFunc(wait+time.Second, w.emitState)
		w.halt(ReasonTemporaryBan)
	case *events.ClientOutdated:
		w.halt(ReasonClientOutdated)
	case *events.UndecryptableMessage:
		w.log.Warn("undecryptable message", "unavailable", ev.IsUnavailable)
	case *events.ConnectFailure:
		if ev.Reason.IsLoggedOut() {
			w.halt(ReasonLoggedOut)
		}
	}
}

func mapMessage(cl *whatsmeow.Client, e *events.Message) *Message {
	m := &Message{
		ID:         string(e.Info.ID),
		ChatServer: e.Info.Chat.Server,
		IsGroup:    e.Info.IsGroup,
		FromMe:     e.Info.IsFromMe,
		Timestamp:  e.Info.Timestamp,
	}
	m.Sender = senderDigits(cl, e.Info)
	msg := e.Message
	switch {
	case e.Info.Edit != types.EditAttributeEmpty ||
		msg.GetProtocolMessage().GetEditedMessage() != nil:
		m.Kind = KindEdit
	case msg.GetReactionMessage() != nil || msg.GetEncReactionMessage() != nil:
		m.Kind = KindReaction
	case msg.GetImageMessage() != nil:
		img := msg.GetImageMessage()
		m.Kind, m.Text = KindImage, img.GetCaption()
		m.ImageSize = int64(img.GetFileLength())
		m.Image = func(ctx context.Context) ([]byte, error) {
			return cl.Download(ctx, img)
		}
	case msg.GetConversation() != "":
		m.Kind, m.Text = KindText, msg.GetConversation()
	case msg.GetExtendedTextMessage() != nil:
		m.Kind, m.Text = KindText, msg.GetExtendedTextMessage().GetText()
	case msg.GetVideoMessage() != nil, msg.GetAudioMessage() != nil,
		msg.GetDocumentMessage() != nil, msg.GetStickerMessage() != nil:
		m.Kind = KindMedia
	}
	return m
}

// senderDigits resolves a phone number for PN and LID addressed senders.
func senderDigits(cl *whatsmeow.Client, i types.MessageInfo) string {
	switch {
	case i.Sender.Server == types.DefaultUserServer:
		return i.Sender.User
	case i.SenderAlt.Server == types.DefaultUserServer:
		return i.SenderAlt.User
	case i.Sender.Server == types.HiddenUserServer && cl != nil &&
		cl.Store != nil && cl.Store.LIDs != nil:
		pn, err := cl.Store.LIDs.GetPNForLID(context.Background(), i.Sender)
		if err == nil && pn.Server == types.DefaultUserServer {
			return pn.User
		}
	}
	return ""
}

func (w *WA) Send(ctx context.Context, phone, text, id string) error {
	if !w.State().Ready() {
		return ErrNotReady
	}
	if !phoneRe.MatchString(phone) || text == "" {
		return ErrRejected
	}
	_, err := w.cur().SendMessage(ctx,
		types.NewJID(phone, types.DefaultUserServer),
		&waE2E.Message{Conversation: proto.String(text)},
		whatsmeow.SendRequestExtra{ID: types.MessageID(id)})
	if errors.Is(err, whatsmeow.ErrNotLoggedIn) {
		return ErrNotReady
	}
	return err
}

// freshClient swaps in an unpaired client after a logout or revoke.
func (w *WA) freshClient(ctx context.Context) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.reason == ReasonLoggedOut || w.client.Store.ID == nil {
		old := w.client
		old.Disconnect()
		if old.Store.ID != nil {
			_ = old.Store.Delete(ctx)
		}
		w.client = w.newClient(w.container.NewDevice())
		w.reason = ""
	}
}

var errPairing = errors.New("pairing already in progress")

func (w *WA) beginPairing(ctx context.Context) (
	<-chan whatsmeow.QRChannelItem, context.CancelFunc, error) {
	w.freshClient(ctx)
	if w.State().Paired {
		return nil, nil, errors.New("already paired")
	}
	w.mu.Lock()
	if w.pairing {
		w.mu.Unlock()
		return nil, nil, errPairing
	}
	w.pairing = true
	cl := w.client
	w.mu.Unlock()
	fail := func(err error, cancel context.CancelFunc) (
		<-chan whatsmeow.QRChannelItem, context.CancelFunc, error) {
		if cancel != nil {
			cancel()
		}
		w.mu.Lock()
		w.pairing = false
		w.mu.Unlock()
		return nil, nil, err
	}
	pctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	ch, err := cl.GetQRChannel(pctx)
	if err != nil {
		return fail(err, cancel)
	}
	if err := cl.Connect(); err != nil {
		return fail(err, cancel)
	}
	return ch, cancel, nil
}

func (w *WA) drainQR(cancel context.CancelFunc, ch <-chan whatsmeow.QRChannelItem) {
	defer cancel()
	for it := range ch {
		w.mu.Lock()
		w.qr = ""
		if it.Event == "code" {
			w.qr = it.Code
		}
		w.mu.Unlock()
	}
	w.mu.Lock()
	w.pairing = false
	w.mu.Unlock()
}

func (w *WA) StartQR(ctx context.Context) error {
	ch, cancel, err := w.beginPairing(ctx)
	if errors.Is(err, errPairing) {
		return nil
	}
	if err != nil {
		return err
	}
	go w.drainQR(cancel, ch)
	return nil
}

func (w *WA) QR() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.qr
}

// PairPhone mirrors whatsmeow's flow: open QR channel, connect, then request.
func (w *WA) PairPhone(ctx context.Context, phone string) (string, error) {
	ch, cancel, err := w.beginPairing(ctx)
	if err != nil {
		return "", err
	}
	select {
	case it := <-ch:
		if it.Event == "code" {
			w.mu.Lock()
			w.qr = it.Code
			w.mu.Unlock()
		}
	case <-ctx.Done():
		cancel()
		return "", ctx.Err()
	}
	code, err := w.cur().PairPhone(context.Background(), phone, true,
		whatsmeow.PairClientChrome, w.display)
	if err != nil {
		cancel()
		return "", err
	}
	go w.drainQR(cancel, ch)
	return code, nil
}

func (w *WA) Logout(ctx context.Context) error {
	cl := w.cur()
	if cl.Store.ID != nil {
		if err := cl.Logout(ctx); err != nil {
			return err
		}
	}
	w.halt(ReasonLoggedOut)
	return nil
}

func (w *WA) Close() {
	w.closeOnce.Do(func() {
		close(w.done)
		w.cur().Disconnect()
		_ = w.container.Close()
	})
}
