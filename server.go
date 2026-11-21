package main

import (
	"bufio"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
)

// Event is one line the helper sends: a greeting, a fired binding, or a
// complaint. The helper decides and acts; this side only records and reacts.
type Event struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
	AX      bool   `json:"ax,omitempty"`
	Layers  int    `json:"layers,omitempty"`
	Actions int    `json:"actions,omitempty"`
	Layer   string `json:"layer,omitempty"`
	Action  string `json:"action,omitempty"`
}

// Link is the Unix socket the helper connects to. It is a plain stream of
// newline-delimited JSON in one direction, with "reload" going back the
// other way on the same connection.
type Link struct {
	path string
	ln   net.Listener

	mu   sync.Mutex
	conn net.Conn

	onEvent func(Event)
}

func newLink(path string) *Link {
	return &Link{path: path}
}

func socketPath() string {
	dir := os.Getenv("MYCAST_RUN")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "mycast")
	}
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "helper.sock")
}

func (l *Link) start(onEvent func(Event)) error {
	// A socket left by a crashed run would block the bind.
	_ = os.Remove(l.path)
	ln, err := net.Listen("unix", l.path)
	if err != nil {
		return err
	}
	l.ln = ln
	l.onEvent = onEvent
	go l.accept()
	return nil
}

func (l *Link) accept() {
	for {
		conn, err := l.ln.Accept()
		if err != nil {
			return
		}
		l.mu.Lock()
		if l.conn != nil {
			l.conn.Close()
		}
		l.conn = conn
		l.mu.Unlock()
		go l.read(conn)
	}
}

func (l *Link) read(conn net.Conn) {
	defer func() {
		l.mu.Lock()
		if l.conn == conn {
			l.conn = nil
		}
		l.mu.Unlock()
		conn.Close()
	}()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var ev Event
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			continue
		}
		if l.onEvent != nil {
			l.onEvent(ev)
		}
	}
}

func (l *Link) connected() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.conn != nil
}

// tell asks the helper to re-read bindings.json.
func (l *Link) tell(typ string) {
	l.mu.Lock()
	conn := l.conn
	l.mu.Unlock()
	if conn == nil {
		return
	}
	msg, err := json.Marshal(map[string]string{"type": typ})
	if err != nil {
		return
	}
	if _, err := conn.Write(append(msg, '\n')); err != nil {
		log.Printf("helper: %v", err)
	}
}
