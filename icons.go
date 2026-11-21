package main

import (
	"encoding/base64"
	"sync"

	"github.com/egoist/mygo"
)

// icons reads the app list once and keeps the PNG of each icon it has drawn.
// FileIcon reads the disk in a few milliseconds, so every icon is asked for
// once and the bytes are handed to the page as a data URL.
type icons struct {
	mu    sync.Mutex
	png   map[string][]byte
	urls  map[string]string
	paths map[string]string
	names map[string]string
	all   []mygo.InstalledApp
	// ready closes once the app list has been read, so a window opened before
	// the scan finishes waits for it instead of showing an empty list.
	ready chan struct{}
	once  sync.Once
}

func newIcons() *icons {
	return &icons{
		png:   map[string][]byte{},
		urls:  map[string]string{},
		paths: map[string]string{},
		names: map[string]string{},
		ready: make(chan struct{}),
	}
}

// index lists the installed apps: their identifiers, names and where they are.
func (s *icons) index() {
	defer s.once.Do(func() { close(s.ready) })
	apps, err := mygo.Shell.InstalledApps()
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.all = apps
	for _, a := range apps {
		s.paths[a.ID] = a.Path
		s.names[a.ID] = a.Name
	}
}

func (s *icons) apps() []mygo.InstalledApp {
	<-s.ready
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.all
}

func (s *icons) name(id string) string {
	<-s.ready
	s.mu.Lock()
	defer s.mu.Unlock()
	if n, ok := s.names[id]; ok {
		return n
	}
	return id
}

// raw is the PNG the window draws for an app, made once.
func (s *icons) raw(id string) ([]byte, error) {
	<-s.ready
	s.mu.Lock()
	if b, ok := s.png[id]; ok {
		s.mu.Unlock()
		return b, nil
	}
	path := s.paths[id]
	s.mu.Unlock()

	if path == "" {
		return nil, nil
	}
	data, err := mygo.Shell.FileIcon(path, 128)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.png[id] = data
	s.mu.Unlock()
	return data, nil
}

// url is an app's icon as a data URL, made once. Bound methods run on a
// goroutine of their own, so the cache is guarded.
func (s *icons) url(id string) string {
	s.mu.Lock()
	if u, ok := s.urls[id]; ok {
		s.mu.Unlock()
		return u
	}
	s.mu.Unlock()

	png, err := s.raw(id)
	if err != nil || len(png) == 0 {
		return ""
	}
	u := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	s.mu.Lock()
	s.urls[id] = u
	s.mu.Unlock()
	return u
}

// warm reads the icon of every app the bindings mention, so the first frame
// that shows one does not wait for the disk.
func (s *icons) warm(cfg *Config) {
	wanted := map[string]bool{}
	var add func(a *Action)
	add = func(a *Action) {
		if a == nil {
			return
		}
		if a.Type == "app" && a.BundleID != "" {
			wanted[a.BundleID] = true
		}
	}
	for _, it := range cfg.Items {
		for _, a := range it.Keys {
			copy := a
			add(&copy)
		}
		add(it.OnRelease)
		add(it.OnDoubleTap)
	}
	for id := range wanted {
		_, _ = s.raw(id)
	}
}
