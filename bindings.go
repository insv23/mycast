package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ItemKind says how a row is triggered. A divider groups the list and holds
// no bindings; the runtime skips it.
const (
	KindHold    = "hold"
	KindDivider = "divider"
)

// Item is one row of the flat list. Layers are equal peers: no nesting, no
// parent, and the order in the file is the order on screen.
type Item struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`

	// hold
	Mods        []string           `json:"mods,omitempty"`
	Keys        map[string]Action  `json:"keys,omitempty"`
	OnRelease   *Action            `json:"onRelease,omitempty"`
	OnDoubleTap *Action            `json:"onDoubleTap,omitempty"`

	// hold: how long the two taps of onDoubleTap may be apart, milliseconds
	Window int `json:"window,omitempty"`

	// divider
	Label string `json:"label,omitempty"`
}

// Action is what a key does. It is stored directly on the key that runs it:
// no ID, no shared table, no orphans when a binding changes.
type Action struct {
	Type     string   `json:"type"`
	BundleID string   `json:"bundleID,omitempty"`
	Text     string   `json:"text,omitempty"`
	Mods     []string `json:"mods,omitempty"`
	Key      string   `json:"key,omitempty"`
}

// Config is bindings.json as a whole. The helper parses the same file with
// its own decoder, so both read one source of truth.
type Config struct {
	Version int    `json:"version"`
	Items   []Item `json:"items"`
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &cfg, nil
}

// layers counts the rows that hold bindings, which is what the window reports.
func (c *Config) layers() []Item {
	out := make([]Item, 0, len(c.Items))
	for _, it := range c.Items {
		if it.Kind != KindDivider {
			out = append(out, it)
		}
	}
	return out
}

func (c *Config) layer(id string) (Item, bool) {
	for _, it := range c.Items {
		if it.ID == id && it.Kind != KindDivider {
			return it, true
		}
	}
	return Item{}, false
}

// configPath is where bindings.json lives: overridden by the environment, or
// the user's Application Support directory for both dev and packaged builds.
func configPath() string {
	if p := os.Getenv("MYCAST_BINDINGS"); p != "" {
		return p
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "Library", "Application Support", "mycast", "bindings.json")
	}
	return "bindings.json"
}

// ensureConfig gives a fresh install an empty config the helper can read at
// startup. An existing file is the user's own bindings and stays untouched.
func ensureConfig(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	cfg := Config{Version: 1, Items: []Item{}}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
