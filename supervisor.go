package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Supervisor keeps the Swift helper running. The helper can die on its own: a
// crash, or the user revoking Accessibility. The app has to outlive it and
// bring it back rather than look dead.
type Supervisor struct {
	bin     string
	pathEnv []string
	onExit  func(error)

	mu   sync.Mutex
	cmd  *exec.Cmd
	quit bool
}

// helperBinary finds the helper: an explicit override first, then next to the
// app's executable, then the repo's bin/ while developing.
func helperBinary() (string, error) {
	if p := os.Getenv("MYCAST_HELPER"); p != "" {
		return p, nil
	}
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		// A packaged app keeps it in Resources; a dev build beside itself.
		candidates = append(candidates,
			filepath.Join(dir, "mycast-helper"),
			filepath.Join(dir, "..", "Resources", "mycast-helper"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "bin", "mycast-helper"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			if abs, err := filepath.Abs(c); err == nil {
				return abs, nil
			}
			return c, nil
		}
	}
	return "", fmt.Errorf("找不到 mycast-helper，先跑 helper/build.sh，或设置 MYCAST_HELPER")
}

func newSupervisor(bin, socket, configPath string) *Supervisor {
	return &Supervisor{
		bin: bin,
		pathEnv: append(os.Environ(),
			"MYCAST_SOCKET="+socket,
			"MYCAST_BINDINGS="+configPath,
		),
	}
}

func (s *Supervisor) start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil {
		return nil
	}
	cmd := exec.Command(s.bin)
	cmd.Env = s.pathEnv
	// The helper's stderr goes to the terminal that started the app, so a
	// missing permission shows its explanation somewhere visible.
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	s.cmd = cmd
	go s.wait(cmd)
	return nil
}

func (s *Supervisor) wait(cmd *exec.Cmd) {
	err := cmd.Wait()

	s.mu.Lock()
	stopped := s.quit
	if s.cmd == cmd {
		s.cmd = nil
	}
	s.mu.Unlock()

	if stopped {
		return
	}
	if err != nil && s.onExit != nil {
		s.onExit(err)
	}
	// Coming back after a pause covers the usual case: Accessibility was
	// revoked, the helper died, and granting it again should heal in place.
	time.Sleep(2 * time.Second)
	s.mu.Lock()
	stillQuit := s.quit
	s.mu.Unlock()
	if !stillQuit {
		_ = s.start()
	}
}

func (s *Supervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cmd != nil
}

func (s *Supervisor) stop() {
	s.mu.Lock()
	cmd := s.cmd
	s.quit = true
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
