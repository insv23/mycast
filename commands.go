package main

import (
	"sort"
	"strings"
	"sync"
)

// CommandInfo is what the launcher needs to draw one result row.
type CommandInfo struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Type     string `json:"type"`
	Shortcut string `json:"shortcut"`
}

// Command is one launcher entry. Run hides everything about how the command
// opens its window from the caller.
type Command struct {
	ID       string
	Title    string
	Subtitle string
	Type     string
	Shortcut string
	Keywords []string
	Run      func()
}

// Registry holds the commands available to the launcher.
type Registry struct {
	mu       sync.RWMutex
	commands []Command
}

func newRegistry() *Registry { return &Registry{} }

func (r *Registry) Register(cmd Command) {
	if cmd.ID == "" || cmd.Run == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.commands {
		if r.commands[i].ID == cmd.ID {
			r.commands[i] = cmd
			return
		}
	}
	r.commands = append(r.commands, cmd)
}

func (r *Registry) all() []Command {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]Command(nil), r.commands...)
}

func (r *Registry) Search(query string) []CommandInfo {
	needle := strings.ToLower(strings.TrimSpace(query))
	commands := r.all()
	out := make([]CommandInfo, 0, len(commands))
	for _, cmd := range commands {
		if needle != "" && !matchesCommand(cmd, needle) {
			continue
		}
		out = append(out, CommandInfo{
			ID: cmd.ID, Title: cmd.Title, Subtitle: cmd.Subtitle,
			Type: cmd.Type, Shortcut: cmd.Shortcut,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Title < out[j].Title })
	return out
}

func matchesCommand(cmd Command, needle string) bool {
	if strings.Contains(strings.ToLower(cmd.Title), needle) ||
		strings.Contains(strings.ToLower(cmd.Subtitle), needle) {
		return true
	}
	for _, word := range cmd.Keywords {
		if strings.Contains(strings.ToLower(word), needle) {
			return true
		}
	}
	return false
}

func (r *Registry) Open(id string) bool {
	for _, cmd := range r.all() {
		if cmd.ID == id {
			cmd.Run()
			return true
		}
	}
	return false
}
