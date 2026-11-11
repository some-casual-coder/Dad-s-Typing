package transport

import (
	"context"
	"errors"
	"sync"

	"go.mau.fi/whatsmeow"
)

var errPairing = errors.New("pairing already in progress")

// pairing is the single-flight guard and QR holder for linking a device.
type pairing struct {
	mu     sync.Mutex
	active bool
	gen    uint64
	qr     string
}

// pairSource abstracts the whatsmeow calls so the flow is testable.
type pairSource struct {
	open    func() (<-chan whatsmeow.QRChannelItem, context.CancelFunc, error)
	request func(phone string) (string, error)
}

func (p *pairing) begin() (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active {
		return 0, errPairing
	}
	p.active = true
	p.gen++
	return p.gen, nil
}

// end releases the guard only for the attempt that still owns it.
func (p *pairing) end(gen uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen == gen {
		p.active = false
		p.qr = ""
	}
}

func (p *pairing) setQR(gen uint64, code string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen == gen {
		p.qr = code
	}
}

func (p *pairing) current() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.qr
}

func (p *pairing) clear() {
	p.mu.Lock()
	p.qr = ""
	p.mu.Unlock()
}

// drain consumes QR updates until the channel closes, then releases the guard.
func (p *pairing) drain(gen uint64, cancel context.CancelFunc,
	ch <-chan whatsmeow.QRChannelItem) {
	defer cancel()
	for it := range ch {
		code := ""
		if it.Event == "code" {
			code = it.Code
		}
		p.setQR(gen, code)
	}
	p.end(gen)
}

// abort cancels the attempt, releases the guard and empties the channel.
func (p *pairing) abort(gen uint64, cancel context.CancelFunc,
	ch <-chan whatsmeow.QRChannelItem) {
	cancel()
	p.end(gen)
	if ch != nil {
		go func() {
			for range ch {
			}
		}()
	}
}

func (p *pairing) startQR(src pairSource) error {
	gen, err := p.begin()
	if errors.Is(err, errPairing) {
		return nil
	}
	if err != nil {
		return err
	}
	ch, cancel, err := src.open()
	if err != nil {
		p.end(gen)
		return err
	}
	go p.drain(gen, cancel, ch)
	return nil
}

// phone opens the QR channel, then requests a pairing code for the number.
func (p *pairing) phone(ctx context.Context, src pairSource, phone string) (string, error) {
	gen, err := p.begin()
	if err != nil {
		return "", err
	}
	ch, cancel, err := src.open()
	if err != nil {
		p.end(gen)
		return "", err
	}
	select {
	case it := <-ch:
		if it.Event == "code" {
			p.setQR(gen, it.Code)
		}
	case <-ctx.Done():
		p.abort(gen, cancel, ch)
		return "", ctx.Err()
	}
	code, err := src.request(phone)
	if err != nil {
		p.abort(gen, cancel, ch)
		return "", err
	}
	go p.drain(gen, cancel, ch)
	return code, nil
}
