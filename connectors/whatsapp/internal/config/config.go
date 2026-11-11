package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

const (
	MinSecretLen = 32
	// Channel is the bridge channel id used in /api/channel/{channel}/ paths.
	Channel = "whatsapp"
)

type Config struct {
	TSBaseURL    string
	BridgeSecret string
	DataDir      string
	AdminToken   string
	AdminAddr    string
	// InsecureTS is set when plain http to a non-loopback host was opted into.
	InsecureTS     bool
	AllowedSenders []string
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
	insecureOK := getenv("ALLOW_INSECURE_TS_URL") == "1"
	insecure, err := checkBaseURL(c.TSBaseURL, insecureOK)
	if err != nil {
		errs = append(errs, err)
	}
	c.InsecureTS = insecure
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
	if c.AdminToken == c.BridgeSecret {
		errs = append(errs, errors.New(
			"ADMIN_TOKEN must differ from WHATSAPP_BRIDGE_SECRET"))
	}
	if err := checkLoopback(c.AdminAddr); err != nil {
		errs = append(errs, err)
	}
	senders, err := parseSenders(getenv("ALLOWED_SENDERS"))
	if err != nil {
		errs = append(errs, err)
	}
	c.AllowedSenders = senders
	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return c, nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// checkBaseURL requires https unless the host is loopback or opted in.
func checkBaseURL(raw string, allowInsecure bool) (bool, error) {
	u, err := url.Parse(raw)
	if raw == "" || err != nil || u.Host == "" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		return false, errors.New("TS_BASE_URL must be an absolute http(s) URL")
	}
	if u.Path != "" || u.RawQuery != "" || u.User != nil {
		return false, errors.New("TS_BASE_URL must have no path, query or userinfo")
	}
	if u.Scheme == "https" || isLoopbackHost(u.Hostname()) {
		return false, nil
	}
	if !allowInsecure {
		return false, errors.New("TS_BASE_URL must be https unless the host is " +
			"loopback; set ALLOW_INSECURE_TS_URL=1 only on a private network")
	}
	return true, nil
}

func checkLoopback(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return errors.New("ADMIN_ADDR must be host:port")
	}
	if !isLoopbackHost(host) {
		return errors.New("ADMIN_ADDR must bind a loopback address")
	}
	return nil
}

func parseSenders(raw string) ([]string, error) {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimPrefix(strings.TrimSpace(s), "+")
		if s == "" {
			continue
		}
		if len(s) < 6 || len(s) > 15 || strings.Trim(s, "0123456789") != "" {
			return nil, errors.New("ALLOWED_SENDERS must be comma separated digits")
		}
		out = append(out, s)
	}
	return out, nil
}

// AdminPort returns the port of a validated ADMIN_ADDR.
func AdminPort(addr string) string {
	_, p, _ := net.SplitHostPort(addr)
	return p
}
