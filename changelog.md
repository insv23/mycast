# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-11-21

First release.

### Added

- Layer-based keyboard mapping: hold a combination of modifier keys to activate a layer, then assign an action to any key in that layer. Left and right Control, Option, Shift and Command are tracked separately.
- Four key actions:
  - App: launch an application, bring it forward, hide it when it is already in front, and reopen it when it has no window.
  - Note: label a key without changing what the key does.
  - Block: consume the key so the frontmost application never receives it.
  - Key: send a chosen key or modifier combination to the frontmost application.
- Key mapping supports bare keys such as F, uppercase letters as Shift plus the letter key, shortcuts such as Command+V, and side-specific modifiers such as left Control versus right Control.
- Gestures on a layer's own modifiers: a single tap and a double tap can each carry an action. The double-tap window is adjustable from 10 ms to 800 ms.
- Installed-app picker with search and on-demand app icons.
- Layer management: create layers from modifier combinations, add dividers, reorder rows by dragging, and delete layers or dividers from the context menu.
- Three-pane window with a layer list, a keyboard view, and an action inspector. Light and dark appearances are both supported.
- `bindings.json` as the single source of truth. Edits made in the window save immediately, and external edits are picked up through a reload.
- A native macOS helper with an event tap. Unbound keys pass through untouched, and bound keys are consumed only at the final key of a combination.
- Helper lifecycle handling: a single instance lock, automatic helper restart, and a visible connection status.
- Accessibility permission is requested on startup so keyboard interception and synthetic key posting work.
