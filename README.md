# PaperWM for Cinnamon

A Cinnamon extension that adds basic
[PaperWM](https://github.com/paperwm/PaperWM)-style
scrollable tiling to Linux Mint / Cinnamon.

> [!NOTE]
> **This project is AI-generated.** The code and this README were written by AI.
> They were tested by hand on Linux Mint 22.3 with Cinnamon 6.6 (X11),
> but not reviewed line by line.
> Expect rough edges, and read the code before you trust it.

It is unrelated to the PaperWM project for GNOME Shell and shares no code with it.

## Features

- Each workspace × monitor has its own horizontal strip.
  Windows are full height, keep their own width, and sit side by side.
- When a window is focused (shortcut, click, Alt-Tab, or taskbar),
  the strip scrolls so that window is fully visible.
- A new window opens to the right of the focused one.
- Dragging a window drops it into the strip at that position, even on another monitor.
  Resizing with the mouse sets its width.
- Maximizing a window makes it full width.
- Cinnamon's snapping still works but changes
  the window's width rather than tiling it.
  Dragging against a side edge, Super+Left, or Super+Right gives half width.
  Super+Up gives full width.
- If an app resizes itself, the extension puts it back to its strip width.
  If the app keeps doing it, the extension uses the app's width instead.
- Dialogs, sticky windows, and fullscreen windows float.

## Keys (change them in System Settings → Extensions → PaperWM for Cinnamon → Configure)

| Key               | Action                          |
| ----------------- | ------------------------------- |
| Super+, / Super+. | Focus left / right              |
| Super+Shift+, / . | Move window left / right        |
| Super+Home / End  | Focus first / last              |
| Super+R           | Cycle width ⅓ → ½ → ⅔           |
| Super+F           | Toggle full width               |
| Super+Alt+C       | Center window                   |
| Super+T           | Float / tile the focused window |

## Touchpad

A 3-finger swipe left/right scrolls the strip.
The strip follows your fingers, and when you lift them
it settles on the nearest window, taking flick speed into account.
Cinnamon's own action for that swipe (switching workspaces, by default)
is turned off while the extension is enabled. Other swipes keep working as before.
The finger count (3, 4, or off), swipe distance,
and direction are in the extension settings.

## Install

    git clone https://github.com/merlinz01/paperwm-cinnamon.git
    cd paperwm-cinnamon
    ln -s "$PWD/paperwm@cinnamon" ~/.local/share/cinnamon/extensions/

Then enable **PaperWM for Cinnamon** in System Settings → Extensions.

Tested only on Cinnamon 6.6.
Gesture support needs touchegg, which Linux Mint ships and enables by default.

## Development

For debugging, the live instance is `imports.misc.fileUtils.getModuleByIndex(imports.ui.extension.getExtension('paperwm@cinnamon').moduleIndex).getTiler()` in Looking Glass.

To reload after editing: `gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.ReloadXlet paperwm@cinnamon EXTENSION`

## Limitations

- X11 only (Cinnamon's default session).
- Mutter keeps a 75px sliver of each off-screen window visible.
  Where there's another monitor next to that edge,
  off-screen windows are minimized instead.
- On startup, windows are ordered by their current screen x position.
  Windows that were scrolled off-screen can come back in a different order.
- Touchpad gestures work by overriding one internal method
  of Cinnamon's gesture manager,
  so a future Cinnamon update could break them.

## License

MIT. See [LICENSE](LICENSE).
