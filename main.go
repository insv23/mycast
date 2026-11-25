package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

//go:embed resources/tray.png
var trayIcon []byte

type app struct {
	cfgPath string

	// The helper's side of the world, written from its goroutine.
	mu        sync.Mutex
	quitting  bool
	helperOK  bool
	axOK      bool
	helperMsg string

	// The document, written only from the window's calls.
	config *Config
	icons  *icons

	win      *mygo.Window
	launcher *mygo.Window
	tray     *mygo.Tray
	link     *Link
	sup      *Supervisor

	commands *Registry
	cmdMu    sync.Mutex
	cmdWins  map[string]*mygo.Window
}

func (a *app) item(id string) (Item, bool) {
	for _, it := range a.config.Items {
		if it.ID == id {
			return it, true
		}
	}
	return Item{}, false
}

func (a *app) indexOf(id string) int {
	for i, it := range a.config.Items {
		if it.ID == id {
			return i
		}
	}
	return -1
}

func (a *app) removeItem(id string) {
	idx := a.indexOf(id)
	if idx < 0 {
		return
	}
	a.config.Items = append(a.config.Items[:idx], a.config.Items[idx+1:]...)
	a.save()
}

func (a *app) moveItem(id string, delta int) {
	idx := a.indexOf(id)
	if idx < 0 {
		return
	}
	to := idx + delta
	if to < 0 || to >= len(a.config.Items) {
		return
	}
	a.config.Items[idx], a.config.Items[to] = a.config.Items[to], a.config.Items[idx]
	a.save()
}

// save writes the file the helper reads, and tells it to read it again.
func (a *app) save() {
	data, err := json.MarshalIndent(a.config, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(a.cfgPath), 0o755); err != nil {
		log.Printf("save: %v", err)
		return
	}
	if err := os.WriteFile(a.cfgPath, append(data, '\n'), 0o644); err != nil {
		log.Printf("save: %v", err)
		return
	}
	if a.link != nil {
		a.link.tell("reload")
	}
}

func (a *app) reload() {
	cfg, err := loadConfig(a.cfgPath)
	if err != nil {
		log.Printf("config: %v", err)
		return
	}
	a.config = cfg
	if a.link != nil {
		a.link.tell("reload")
	}
	go a.icons.warm(a.config)
}

func (a *app) record(ev Event) {
	a.mu.Lock()
	switch ev.Type {
	case "hello":
		a.helperOK = true
		a.axOK = ev.AX
		a.helperMsg = fmt.Sprintf("%d 层 / %d 动作", ev.Layers, ev.Actions)
	case "error":
		a.helperOK = false
		a.helperMsg = ev.Message
	case "fired", "log":
		a.helperMsg = ev.Message
	}
	a.mu.Unlock()
}

func clock() string {
	return time.Now().Format("15:04:05")
}

func (a *app) showLauncher() {
	if a.launcher == nil {
		return
	}
	a.launcher.Show()
	a.launcher.Focus()
	a.syncDock()
}

func (a *app) hideLauncher() {
	if a.launcher != nil {
		a.launcher.Hide()
	}
	a.syncDock()
}

func (a *app) syncDock() {
	visible := a.launcher != nil && a.launcher.IsVisible()
	a.cmdMu.Lock()
	for _, win := range a.cmdWins {
		if win != nil && !win.IsDestroyed() && win.IsVisible() {
			visible = true
		}
	}
	a.cmdMu.Unlock()
	if visible {
		mygo.App.Dock.Show()
	} else {
		mygo.App.Dock.Hide()
	}
}

func (a *app) openCommandWindow(id string) {
	a.cmdMu.Lock()
	if win := a.cmdWins[id]; win != nil && !win.IsDestroyed() {
		a.cmdMu.Unlock()
		win.Show()
		win.Focus()
		a.syncDock()
		return
	}
	a.cmdMu.Unlock()

	opts := mygo.WindowOptions{
		Title:             "MyCast",
		URL:               "/" + id,
		HideWindowButtons: true,
		Width:           1236,
		Height:          650,
		MinWidth:        900,
		MinHeight:       560,
		StateKey:        "command-" + id,
		TitleBarStyle:   mygo.TitleBarHiddenInset,
		BackgroundColor: "light-dark(#f6f6f8, #1a1a1c)",
	}
	if id == "keyboard-mapping" {
		opts.Title = "键盘映射"
		opts.URL = "/keyboard"
	}
	win := mygo.NewWindow(opts)
	a.cmdMu.Lock()
	a.cmdWins[id] = win
	a.cmdMu.Unlock()
	win.OnClosed(func() {
		a.cmdMu.Lock()
		if a.cmdWins[id] == win {
			delete(a.cmdWins, id)
		}
		a.cmdMu.Unlock()
		a.syncDock()
	})
	win.Show()
	win.Focus()
	a.syncDock()
}

func (a *app) makeTray() {
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "打开 MyCast", Click: func(*mygo.MenuItem, *mygo.Window) { a.showLauncher() }},
		mygo.Separator(),
		{Role: mygo.RoleQuit},
	})
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "mycast",
		Icon:           trayIcon,
		IconIsTemplate: true,
		ToolTip:        "MyCast",
		Menu:           menu,
	})
	if err != nil {
		log.Printf("tray: %v", err)
		return
	}
	a.tray = tray
}

// modsTitle names a layer the way the sidebar shows it.
func modsTitle(mods []string) string {
	names := map[string]string{
		"lcmd": "左 Command", "rcmd": "右 Command",
		"lalt": "左 Option", "ralt": "右 Option",
		"lctrl": "左 Control", "rctrl": "右 Control",
		"lshift": "左 Shift", "rshift": "右 Shift",
		"fn": "fn",
	}
	out := make([]string, 0, len(mods))
	for _, m := range mods {
		if n, ok := names[m]; ok {
			out = append(out, n)
		} else {
			out = append(out, m)
		}
	}
	return strings.Join(out, " + ")
}

func main() {
	cfgPath := configPath()
	if err := ensureConfig(cfgPath); err != nil {
		log.Printf("config: %v", err)
	}
	a := &app{
		cfgPath: cfgPath,
		icons:   newIcons(),
	}
	a.reload()
	a.commands = newRegistry()
	a.cmdWins = map[string]*mygo.Window{}
	a.commands.Register(Command{
		ID:       "keyboard-mapping",
		Title:    "打开键盘映射",
		Subtitle: "MyCast",
		Type:     "Command",
		Shortcut: "⌥⇧K",
		Keywords: []string{"键盘", "映射", "keyboard", "keymap"},
		Run:      func() { a.openCommandWindow("keyboard-mapping") },
	})
	mygo.Bind(Service{a: a})

	// Two copies would each start a helper, and two event taps fight over the
	// same keys: one swallows what the other was bound to act on.
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.App.OnSecondInstance(func([]string, string) {
		a.showLauncher()
	})

	mygo.App.WhenReady(func() {
		a.launcher = mygo.NewWindow(mygo.WindowOptions{
			Title:             "MyCast",
			Width:             720,
			Height:            440,
			DisableResize:     true,
			HideWindowButtons: true,
			StateKey:          "launcher-compact-v2",
			TitleBarStyle:     mygo.TitleBarHiddenInset,
			BackgroundColor:   "light-dark(#ebebeb, #1a1a1c)",
			URL:               "/launcher",
		})
		// 关窗只隐藏窗口；助手继续监听，映射保持生效。退出走菜单栏。
		a.launcher.OnClose(func(e *mygo.CloseEvent) {
			a.mu.Lock()
			quitting := a.quitting
			a.mu.Unlock()
			if quitting {
				return
			}
			e.PreventDefault()
			a.hideLauncher()
		})
		a.makeTray()

		if err := mygo.GlobalShortcut.Register("Ctrl+Option+Space", func() {
			if a.launcher.IsVisible() {
				a.hideLauncher()
			} else {
				a.showLauncher()
			}
		}); err != nil {
			log.Printf("shortcut: %v", err)
		}

		sock := socketPath()
		a.link = newLink(sock)
		if err := a.link.start(a.record); err != nil {
			log.Printf("socket: %v", err)
		}

		bin, err := helperBinary()
		if err != nil {
			log.Printf("%v", err)
		} else {
			a.sup = newSupervisor(bin, sock, a.cfgPath)
			a.sup.onExit = func(err error) {
				a.mu.Lock()
				a.helperOK = false
				a.helperMsg = "助手退出：" + err.Error()
				a.mu.Unlock()
			}
			if err := a.sup.start(); err != nil {
				log.Printf("helper: %v", err)
			}
		}

		go func() {
			a.icons.index()
			a.icons.warm(a.config)
		}()
	})

	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) {
		mygo.GlobalShortcut.Unregister("Ctrl+Option+Space")
		a.mu.Lock()
		a.quitting = true
		a.mu.Unlock()
		if a.sup != nil {
			a.sup.stop()
		}
	})
	mygo.App.OnQuitCanceled(func() {
		a.mu.Lock()
		a.quitting = false
		a.mu.Unlock()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
