package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

const MinSecretLen = 32

type Config struct {
	TSBaseURL    string
	BridgeSecret string
	DataDir      string
	AdminToken   string
	AdminAddr    string
}

// Load reads and validates the environment; errors name vars, never values.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		TSBaseURL:    strings.TrimRight(strings.TrimSpace(getenv("TS_BASE_URL")), "/"),
		BridgeSecret: getenv("WHATSAPP_BRIDGE_SECRET"),
		DataDir:      strings.TrimSpace(getenv("DATA_DIR")),
		AdminToken:   getenv("ADMIN_TOKEN"),
		AdminAddr:    strings.TrimSpace(getenv("ADMIN_ADDR")),
	}
	if c.AdminAddr == "" {
		c.AdminAddr = "127.0.0.1:8091"
	}
	var errs []error
	if err := checkBaseURL(c.TSBaseURL); err != nil {
		errs = append(errs, err)
	}
	if c.DataDir == "" {
		errs = append(errs, errors.New("DATA_DIR is required"))
	}
	if len(c.BridgeSecret) < MinSecretLen {
		errs = append(errs, fmt.Errorf(
			"WHATSAPP_BRIDGE_SECRET must be at least %d chars", MinSecretLen))
	}
	if len(c.AdminToken) < MinSecretLen {
		errs = append(errs, fmt.Errorf(
			"ADMIN_TOKEN must be at least %d chars", MinSecretLen))
	}
	if err := checkLoopback(c.AdminAddr); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return c, nil
}

func checkBaseURL(raw string) error {
	u, err := url.Parse(raw)
	if raw == "" || err != nil || u.Host == "" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("TS_BASE_URL must be an absolute http(s) URL")
	}
	if u.Path != "" || u.RawQuery != "" || u.User != nil {
		return errors.New("TS_BASE_URL must have no path, query or userinfo")
	}
	return nil
}

func checkLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return errors.New("ADMIN_ADDR must be host:port")
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return errors.New("ADMIN_ADDR must bind a loopback address")
	}
	return nil
}
