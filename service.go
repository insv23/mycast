package main

import (
	"fmt"
	"sort"
	"strings"
)

// The window is a web page. These types and methods are what it calls: the
// page never touches the file, only this, and Go writes it.

// defaultDoubleWindow is where a layer's double-tap window starts: tight
// enough not to catch two deliberate presses.
const defaultDoubleWindow = 350

// Row is one line of the layer list as the page draws it.
type Row struct {
	ID          string            `json:"id"`
	Kind        string            `json:"kind"`
	Title       string            `json:"title"`
	Label       string            `json:"label"`
	Mods        []string          `json:"mods"`
	Keys        map[string]Action `json:"keys"`
	OnRelease   *Action           `json:"onRelease"`
	OnDoubleTap *Action           `json:"onDoubleTap"`
	Window      int               `json:"window"`
}

// View is everything the page needs to draw the window.
type View struct {
	Rows   []Row  `json:"rows"`
	Helper bool   `json:"helper"`
	AX     bool   `json:"ax"`
	Note   string `json:"note"`
}

// AppInfo is one result of the app picker.
type AppInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Service is bound to the page.
type Service struct{ a *app }

func (s Service) View() View {
	a := s.a
	var v View
	for _, it := range a.config.Items {
		window := it.Window
		if it.OnDoubleTap != nil && window == 0 {
			window = defaultDoubleWindow
		}
		v.Rows = append(v.Rows, Row{
			ID: it.ID, Kind: it.Kind, Title: it.Title, Label: it.Label,
			Mods: it.Mods, Keys: it.Keys, OnRelease: it.OnRelease,
			OnDoubleTap: it.OnDoubleTap, Window: window,
		})
	}
	a.mu.Lock()
	v.Helper, v.AX, v.Note = a.helperOK, a.axOK, a.helperMsg
	a.mu.Unlock()
	return v
}

// Icon answers an app's icon as a data URL, or "" when it has none.
func (s Service) Icon(bundleID string) string {
	if bundleID == "" {
		return ""
	}
	return s.a.icons.url(bundleID)
}

// Apps answers the installed apps, filtered by query. The window reads the
// whole list once and filters it there, so an empty query returns everything.
func (s Service) Apps(query string) []AppInfo {
	needle := strings.ToLower(strings.TrimSpace(query))
	installed := s.a.icons.apps()
	out := make([]AppInfo, 0, len(installed))
	for _, app := range installed {
		if needle != "" && !strings.Contains(strings.ToLower(app.Name), needle) {
			continue
		}
		out = append(out, AppInfo{ID: app.ID, Name: app.Name})
	}
	return out
}

// Name is the name the system shows for an app.
func (s Service) Name(bundleID string) string {
	return s.a.icons.name(bundleID)
}

// SetBinding points one key at one action.
func (s Service) SetBinding(layerID, key, kind, value string) {
	a := s.a
	idx := a.indexOf(layerID)
	if idx < 0 {
		return
	}
	act, ok := makeAction(kind, value)
	if !ok {
		return
	}
	if a.config.Items[idx].Keys == nil {
		a.config.Items[idx].Keys = map[string]Action{}
	}
	a.config.Items[idx].Keys[key] = act
	a.save()
}

// makeAction builds the action a pick describes.
func makeAction(kind, value string) (Action, bool) {
	switch kind {
	case "app":
		if value == "" {
			return Action{}, false
		}
		return Action{Type: "app", BundleID: value}, true
	case "note", "block":
		return Action{Type: kind, Text: value}, true
	case "key":
		mods, key, ok := parseKeyAction(value)
		if !ok {
			return Action{}, false
		}
		return Action{Type: "key", Mods: mods, Key: key}, true
	}
	return Action{}, false
}

func parseKeyAction(value string) ([]string, string, bool) {
	parts := strings.Split(value, ":")
	if len(parts) > 2 {
		return nil, "", false
	}
	key := parts[len(parts)-1]
	if key == "" {
		return nil, "", false
	}
	var mods []string
	if len(parts) == 2 {
		for _, mod := range strings.Split(parts[0], "+") {
			switch mod {
			case "lctrl", "rctrl", "lalt", "ralt", "lshift", "rshift", "lcmd", "rcmd":
				mods = append(mods, mod)
			default:
				return nil, "", false
			}
		}
		sort.Strings(mods)
	}
	return mods, key, true
}

// DeleteBinding leaves the key empty.
func (s Service) DeleteBinding(layerID, key string) {
	a := s.a
	if idx := a.indexOf(layerID); idx >= 0 {
		delete(a.config.Items[idx].Keys, key)
		a.save()
	}
}

// SetOnRelease binds what pressing this layer's modifiers alone does.
func (s Service) SetOnRelease(layerID, kind, value string) {
	s.setGesture(layerID, kind, value, func(it *Item) **Action { return &it.OnRelease })
}

// SetOnDoubleTap binds what two clean taps of the same modifiers do.
func (s Service) SetOnDoubleTap(layerID, kind, value string) {
	s.setGesture(layerID, kind, value, func(it *Item) **Action { return &it.OnDoubleTap })
}

// setGesture points one of a layer's own gestures at an action. An empty kind
// leaves the gesture unbound.
func (s Service) setGesture(layerID, kind, value string, field func(*Item) **Action) {
	a := s.a
	idx := a.indexOf(layerID)
	if idx < 0 {
		return
	}
	if kind == "" {
		*field(&a.config.Items[idx]) = nil
		a.save()
		return
	}
	act, ok := makeAction(kind, value)
	if !ok {
		return
	}
	*field(&a.config.Items[idx]) = &act
	a.save()
}

// ClearOnRelease leaves the gesture unbound.
func (s Service) ClearOnRelease(layerID string) {
	s.SetOnRelease(layerID, "", "")
}

// ClearOnDoubleTap leaves the gesture unbound.
func (s Service) ClearOnDoubleTap(layerID string) {
	s.SetOnDoubleTap(layerID, "", "")
}

// AddLayer makes a layer for the modifiers given, in the order they were
// pressed: lalt, lcmd, and so on.
func (s Service) AddLayer(mods []string) string {
	a := s.a
	if len(mods) == 0 {
		return ""
	}
	sorted := append([]string(nil), mods...)
	sort.Strings(sorted)
	id := strings.Join(sorted, "+")
	if _, ok := a.item(id); ok {
		return id
	}
	a.config.Items = append(a.config.Items, Item{
		Kind: KindHold, ID: id, Title: modsTitle(sorted),
		Mods: sorted, Keys: map[string]Action{},
	})
	a.save()
	return id
}

// InsertDivider puts a section line above the row named, or at the end when
// the row is gone. A divider carries no text: it is a line between layers.
func (s Service) InsertDivider(beforeID string) string {
	a := s.a
	id := fmt.Sprintf("sep:%d", len(a.config.Items)+1)
	item := Item{Kind: KindDivider, ID: id}
	idx := a.indexOf(beforeID)
	if idx < 0 {
		a.config.Items = append(a.config.Items, item)
	} else {
		a.config.Items = append(a.config.Items[:idx], append([]Item{item}, a.config.Items[idx:]...)...)
	}
	a.save()
	return id
}

// RemoveItem deletes a layer or a divider, whatever its bindings.
func (s Service) RemoveItem(id string) {
	s.a.removeItem(id)
}

// MoveItem moves a row up (-1) or down (1).
func (s Service) MoveItem(id string, delta int) {
	s.a.moveItem(id, delta)
}

// MoveTo drops a row at an index of the list without it, which is what a drag
// computes: where the row lands once it is lifted out.
func (s Service) MoveTo(id string, to int) {
	a := s.a
	from := a.indexOf(id)
	if from < 0 {
		return
	}
	item := a.config.Items[from]
	rest := append(append([]Item{}, a.config.Items[:from]...), a.config.Items[from+1:]...)
	if to < 0 {
		to = 0
	}
	if to > len(rest) {
		to = len(rest)
	}
	rest = append(rest[:to], append([]Item{item}, rest[to:]...)...)
	a.config.Items = rest
	a.save()
}

// SetGestureWindow sets how long the two taps of a double may be apart, in
// milliseconds.
func (s Service) SetGestureWindow(id string, ms int) {
	a := s.a
	if ms < 10 {
		ms = 10
	}
	if ms > 800 {
		ms = 800
	}
	if idx := a.indexOf(id); idx >= 0 {
		a.config.Items[idx].Window = ms
		a.save()
	}
}

// Reload reads the file again, for an edit made outside the window.
func (s Service) Reload() {
	s.a.reload()
}
