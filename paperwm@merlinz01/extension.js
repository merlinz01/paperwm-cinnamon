// PaperWM-style scrollable tiling for Cinnamon.
//
// Every (workspace, monitor) pair owns a horizontal strip of windows. Windows
// keep their own width, take the full work-area height, and sit side by side.
// Focusing a window scrolls its strip so the window is fully visible.

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const { GestureType, GestureDirection } = imports.ui.gestures.ToucheggTypes;

const WIDTH_STEPS = [1 / 3, 1 / 2, 2 / 3];
const MIN_FRAC = 0.1;
const OVERSCROLL_RESISTANCE = 0.3;
const MOMENTUM_MS = 250;
const VELOCITY_WINDOW_MS = 100;
const MINIMAP_HEIGHT = 0.15;      // thumbnail height as a fraction of the monitor
const MINIMAP_MAX_WIDTH = 0.9;    // of the monitor width
const MINIMAP_PADDING = 12;
const MINIMAP_LINGER_MS = 400;    // after a swipe settles
const MINIMAP_FADE_MS = 150;
const MODIFIER_POLL_MS = 50;
const HELD_MODIFIERS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;

const KEY_ACTIONS = {
    'key-focus-left': t => t.focusNeighbor(-1),
    'key-focus-right': t => t.focusNeighbor(1),
    'key-move-left': t => t.moveFocused(-1),
    'key-move-right': t => t.moveFocused(1),
    'key-focus-first': t => t.focusEdge(false),
    'key-focus-last': t => t.focusEdge(true),
    'key-cycle-width': t => t.cycleWidth(),
    'key-full-width': t => t.toggleFullWidth(),
    'key-center': t => t.centerFocused(),
    'key-toggle-float': t => t.toggleFloat(),
};
// Actions that leave the window in its strip, so the minimap is worth showing.
const MINIMAP_KEYS = new Set(Object.keys(KEY_ACTIONS).filter(k => k !== 'key-toggle-float'));

let extensionMeta = null;
let tiler = null;

class Strip {
    constructor(workspace, monitor) {
        this.workspace = workspace;
        this.monitor = monitor;
        this.windows = [];
        this.scroll = 0;
        this.lastFocus = null;
    }
}

// Overview of one strip: live thumbnails in strip order, a ring around the
// focused window, and an outline of the part of the strip that's on screen.
class Minimap {
    constructor(tiler) {
        this._tiler = tiler;
        this.strip = null;
        this._items = new Map();   // Meta.Window -> { box, clone }
        this._hideTimer = 0;
        this._pollTimer = 0;

        this.actor = new St.Widget({
            style: 'background-color: rgba(24, 24, 24, 0.85); border-radius: 12px;',
            clip_to_allocation: true,
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._inner = new St.Widget();
        this.actor.add_child(this._inner);
        this._viewport = new St.Widget({
            style: 'border: 2px solid rgba(255, 255, 255, 0.45); border-radius: 6px;',
        });
        this._ring = new St.Widget({
            style: 'border: 3px solid rgba(120, 170, 255, 0.95); border-radius: 6px;',
        });
        this._inner.add_child(this._viewport);
        this._inner.add_child(this._ring);
        Main.uiGroup.add_child(this.actor);
    }

    destroy() {
        this._clearTimers();
        this._clearItems();
        this.actor.destroy();
    }

    get visible() {
        return this.actor.visible && this.strip !== null;
    }

    show(strip) {
        this._clearTimers();
        if (strip !== this.strip) {
            this._clearItems();
            this.strip = strip;
        }
        this.actor.remove_all_transitions();
        this.actor.visible = true;
        this.sync(strip, false);
        this.actor.ease({ opacity: 255, duration: MINIMAP_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    // Hide once every modifier key is released, like Alt-Tab.
    hideOnModifierRelease() {
        this._clearTimers();
        this._pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MODIFIER_POLL_MS, () => {
            const [, , mods] = global.get_pointer();
            if (mods & HELD_MODIFIERS)
                return GLib.SOURCE_CONTINUE;
            this._pollTimer = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    hideAfter(ms) {
        this._clearTimers();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._hideTimer = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    hide() {
        this._clearTimers();
        if (!this.actor.visible)
            return;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            duration: MINIMAP_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.actor.visible = false;
                this._clearItems();
                this.strip = null;
            },
        });
    }

    sync(strip, animate) {
        if (strip !== this.strip || !this.actor.visible)
            return;
        const tiler = this._tiler;
        const { area, result, total } = tiler._positions(strip);
        const geo = global.display.get_monitor_geometry(strip.monitor);
        const thumbH = Math.round(geo.height * MINIMAP_HEIGHT);
        const scale = thumbH / area.height;
        const pad = MINIMAP_PADDING;
        const set = (actor, props) => {
            actor.remove_all_transitions();
            if (animate)
                actor.ease(Object.assign({ duration: tiler.animationTime, mode: Clutter.AnimationMode.EASE_OUT_QUAD }, props));
            else
                actor.set(props);
        };

        const focus = global.display.focus_window;
        const seen = new Set();
        let ringRect = null;
        for (const { w, x, width } of result) {
            const item = this._items.get(w) || this._makeItem(w);
            if (!item)
                continue;
            seen.add(w);
            const frame = w.get_frame_rect(), buffer = w.get_buffer_rect();
            const rect = { x: Math.round(x * scale), y: 0, width: Math.max(1, Math.round(width * scale)), height: thumbH };
            set(item.box, rect);
            // Clone the whole actor but crop away its shadow so the frame fills the box.
            item.clone.set_scale(scale, scale);
            item.clone.set_position(Math.round((buffer.x - frame.x) * scale), Math.round((buffer.y - frame.y) * scale));
            if (w === focus)
                ringRect = rect;
        }
        for (const [w, item] of this._items) {
            if (!seen.has(w)) {
                item.box.destroy();
                this._items.delete(w);
            }
        }

        this._ring.visible = ringRect !== null;
        if (ringRect)
            set(this._ring, ringRect);
        set(this._viewport, { x: Math.round(strip.scroll * scale), y: 0, width: Math.round(area.width * scale), height: thumbH });
        this._inner.set_child_above_sibling(this._viewport, null);
        this._inner.set_child_above_sibling(this._ring, null);

        // Size to the strip, up to most of the monitor; past that, keep the
        // visible part of the strip centred.
        const contentW = Math.round(total * scale);
        const innerW = Math.min(contentW, Math.round(geo.width * MINIMAP_MAX_WIDTH) - 2 * pad);
        let offset;
        if (contentW <= innerW)
            offset = 0;
        else
            offset = clamp(innerW / 2 - (strip.scroll + area.width / 2) * scale, innerW - contentW, 0);
        set(this._inner, { x: pad + Math.round(offset), y: pad });
        const boxW = innerW + 2 * pad, boxH = thumbH + 2 * pad;
        // Not via set(): that would cancel the fade in/out on this actor.
        this.actor.set_position(geo.x + Math.round((geo.width - boxW) / 2), geo.y + Math.round((geo.height - boxH) / 2));
        this.actor.set_size(boxW, boxH);
    }

    _makeItem(w) {
        const source = w.get_compositor_private();
        if (!source)
            return null;
        const box = new St.Widget({ clip_to_allocation: true, style: 'border-radius: 6px;' });
        const clone = new Clutter.Clone({ source });
        box.add_child(clone);
        this._inner.add_child(box);
        const item = { box, clone };
        this._items.set(w, item);
        return item;
    }

    _clearItems() {
        for (const item of this._items.values())
            item.box.destroy();
        this._items.clear();
    }

    _clearTimers() {
        if (this._hideTimer)
            GLib.source_remove(this._hideTimer);
        if (this._pollTimer)
            GLib.source_remove(this._pollTimer);
        this._hideTimer = this._pollTimer = 0;
    }
}

class Tiler {
    constructor(uuid) {
        this._strips = new Map();     // Meta.Workspace -> Map(monitor index -> Strip)
        this._state = new Map();      // Meta.Window -> { strip, frac, prevFrac, floating, ids }
        this._autoMinimized = new Set();
        this._signals = [];
        this._timeouts = new Set();
        this._boundKeys = [];
        this._busy = 0;
        this._grabbed = null;

        this.settings = new Settings.ExtensionSettings(this, uuid);
        this.settings.bind('gap', 'gap', () => this.layoutAll());
        this.settings.bind('new-window-width', 'newWindowWidth');
        this.settings.bind('animate', 'animate');
        this.settings.bind('animation-time', 'animationTime');
        for (const key of Object.keys(KEY_ACTIONS))
            this.settings.bind(key, key.replace(/-/g, '_'), () => this._bindKeys());
        this._bindKeys();
        this.settings.bind('gesture-fingers', 'gestureFingers');
        this.settings.bind('gesture-speed', 'gestureSpeed');
        this.settings.bind('gesture-natural', 'gestureNatural');
        this.settings.bind('show-minimap', 'showMinimap', () => this._minimap.hide());
        this._minimap = new Minimap(this);
        this._swipe = null;
        this._gestureClient = null;
        this._gestureIds = [];
        this._setupGestures();

        const display = global.display;
        this._connect(display, 'window-created', (d, w) => this._later(() => this._onWindowCreated(w)));
        this._connect(display, 'notify::focus-window', () => this._onFocusChanged());
        this._connect(display, 'grab-op-begin', (d, w, op) => this._onGrabBegin(w, op));
        this._connect(display, 'grab-op-end', (d, w, op) => this._onGrabEnd(w, op));
        this._connect(display, 'window-entered-monitor', (d, mon, w) => this._onEnteredMonitor(w, mon));
        this._connect(display, 'workareas-changed', () => this.layoutAll());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._rebuild());

        const windows = global.get_window_actors()
            .map(a => a.meta_window)
            .sort((a, b) => a.get_frame_rect().x - b.get_frame_rect().x);
        for (const w of windows)
            this._track(w, false);
        this.layoutAll(false);
        this._onFocusChanged(false);
    }

    destroy() {
        this._unbindKeys();
        this._teardownGestures();
        this._minimap.destroy();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        for (const [w, st] of this._state) {
            for (const id of st.ids)
                w.disconnect(id);
            const actor = w.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_x = 0;
            }
        }
        for (const w of this._autoMinimized)
            w.unminimize();
        this._autoMinimized.clear();
        // Don't strand scrolled-away windows offscreen once we're gone.
        for (const strip of this._allStrips()) {
            const wa = strip.workspace.get_work_area_for_monitor(strip.monitor);
            for (const w of strip.windows) {
                const r = w.get_frame_rect();
                if (r.x + r.width > wa.x && r.x < wa.x + wa.width)
                    continue;
                const x = clamp(r.x, wa.x, Math.max(wa.x, wa.x + wa.width - r.width));
                w.move_frame(true, x, r.y);
            }
        }
        this._state.clear();
        this._strips.clear();
        this.settings.finalize();
    }

    // ---- plumbing ---------------------------------------------------------

    _connect(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    _later(fn, ms = 0) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _bindKeys() {
        this._unbindKeys();
        for (const [key, action] of Object.entries(KEY_ACTIONS)) {
            const binding = this[key.replace(/-/g, '_')];
            if (!binding)
                continue;
            const name = `paperwm-cinnamon-${key}`;
            Main.keybindingManager.addHotKey(name, binding, () => {
                action(this);
                if (MINIMAP_KEYS.has(key))
                    this._flashMinimap();
            });
            this._boundKeys.push(name);
        }
    }

    _unbindKeys() {
        for (const name of this._boundKeys)
            Main.keybindingManager.removeHotKey(name);
        this._boundKeys = [];
    }

    _strip(workspace, monitor) {
        let perMonitor = this._strips.get(workspace);
        if (!perMonitor) {
            perMonitor = new Map();
            this._strips.set(workspace, perMonitor);
        }
        let strip = perMonitor.get(monitor);
        if (!strip) {
            strip = new Strip(workspace, monitor);
            perMonitor.set(monitor, strip);
        }
        return strip;
    }

    *_allStrips() {
        for (const perMonitor of this._strips.values())
            yield* perMonitor.values();
    }

    _isTileable(w) {
        return w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar() &&
            !w.get_transient_for() &&
            !w.is_attached_dialog() &&
            !w.is_on_all_workspaces() &&
            w.get_workspace() !== null;
    }

    // Windows that stay in the strip's order but take no space right now.
    _isSkipped(w) {
        return w.fullscreen ||
            w === this._grabbed ||
            (w.minimized && !this._autoMinimized.has(w));
    }

    _workArea(strip) {
        const wa = strip.workspace.get_work_area_for_monitor(strip.monitor);
        const gap = this.gap;
        return {
            x: wa.x + gap,
            y: wa.y + gap,
            width: Math.max(1, wa.width - 2 * gap),
            height: Math.max(1, wa.height - 2 * gap),
            full: wa,
        };
    }

    // ---- window tracking ---------------------------------------------------

    _onWindowCreated(w) {
        if (this._state.has(w) || !w.get_compositor_private())
            return;
        this._track(w, true);
        // Many apps resize themselves right after mapping; settle afterwards.
        this._later(() => {
            const st = this._state.get(w);
            if (st && st.strip)
                this.layout(st.strip, false);
        }, 250);
    }

    _track(w, isNew) {
        if (this._state.has(w) || w.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const st = { strip: null, frac: 0.5, prevFrac: null, floating: false, ids: [] };
        this._state.set(w, st);

        const on = (signal, fn) => {
            try {
                st.ids.push(w.connect(signal, fn));
            } catch (e) {
                global.logWarning(`paperwm-cinnamon: cannot connect ${signal}: ${e}`);
            }
        };
        on('unmanaging', () => this._untrack(w));
        on('workspace-changed', () => this._refile(w));
        on('notify::on-all-workspaces', () => this._refile(w));
        on('notify::fullscreen', () => this._relayoutOwner(w));
        on('notify::minimized', () => this._relayoutOwner(w));
        on('notify::tile-mode', () => this._onTiled(w));
        on('size-changed', () => this._onSizeChanged(w));
        on('notify::maximized-horizontally', () => this._onMaximized(w));

        if (!this._isTileable(w))
            return;

        const strip = this._strip(w.get_workspace(), w.get_monitor());
        const avail = this._workArea(strip).width;
        if (isNew && this.newWindowWidth > 0)
            st.frac = this.newWindowWidth;
        else
            st.frac = clamp(w.get_frame_rect().width / avail, MIN_FRAC, 1);

        let index = strip.windows.length;
        if (isNew && strip.lastFocus && strip.lastFocus !== w) {
            const i = strip.windows.indexOf(strip.lastFocus);
            if (i >= 0)
                index = i + 1;
        }
        this._insert(w, strip, index);
        if (isNew) {
            this._ensureVisible(strip, w);
            this.layout(strip);
        }
    }

    _untrack(w) {
        const st = this._state.get(w);
        if (!st)
            return;
        for (const id of st.ids)
            w.disconnect(id);
        const strip = st.strip;
        const index = strip ? strip.windows.indexOf(w) : -1;
        const wasFocus = strip && strip.lastFocus === w;
        this._remove(w);
        this._state.delete(w);
        this._autoMinimized.delete(w);
        if (this._grabbed === w)
            this._grabbed = null;

        if (!strip)
            return;
        this._clampScroll(strip);
        this.layout(strip);

        // Like PaperWM: closing the focused window focuses its neighbour.
        if (wasFocus && strip.workspace === global.workspace_manager.get_active_workspace()) {
            this._later(() => {
                const candidates = strip.windows.filter(x => !this._isSkipped(x));
                const next = candidates[Math.min(Math.max(index - 1, 0), candidates.length - 1)];
                const focus = global.display.focus_window;
                if (next && (!focus || !this._state.get(focus)?.strip))
                    next.activate(global.get_current_time());
            });
        }
    }

    _insert(w, strip, index) {
        const st = this._state.get(w);
        strip.windows.splice(index, 0, w);
        st.strip = strip;
    }

    _remove(w) {
        const st = this._state.get(w);
        if (!st || !st.strip)
            return null;
        const strip = st.strip;
        const i = strip.windows.indexOf(w);
        if (i >= 0)
            strip.windows.splice(i, 1);
        if (strip.lastFocus === w)
            strip.lastFocus = null;
        st.strip = null;
        return strip;
    }

    _refile(w) {
        const st = this._state.get(w);
        if (!st || st.floating)
            return;
        const old = this._remove(w);
        if (old) {
            this._clampScroll(old);
            this.layout(old);
        }
        if (!this._isTileable(w))
            return;
        const strip = this._strip(w.get_workspace(), w.get_monitor());
        this._insert(w, strip, strip.windows.length);
        this._ensureVisible(strip, w);
        this.layout(strip);
    }

    _relayoutOwner(w) {
        if (this._busy)
            return;
        const st = this._state.get(w);
        if (st && st.strip)
            this._later(() => st.strip && this.layout(st.strip));
    }

    _rebuild() {
        for (const strip of this._allStrips())
            strip.windows = [];
        const windows = [...this._state.keys()]
            .sort((a, b) => a.get_frame_rect().x - b.get_frame_rect().x);
        for (const w of windows) {
            const st = this._state.get(w);
            st.strip = null;
            if (st.floating || !this._isTileable(w))
                continue;
            this._insert(w, this._strip(w.get_workspace(), w.get_monitor()), Infinity);
        }
        for (const strip of this._allStrips())
            strip.scroll = 0;
        this.layoutAll(false);
    }

    // ---- events -------------------------------------------------------------

    _onFocusChanged(animate = true) {
        const w = global.display.focus_window;
        const st = w && this._state.get(w);
        if (!st || !st.strip)
            return;
        st.strip.lastFocus = w;
        if (this._ensureVisible(st.strip, w))
            this.layout(st.strip, animate);
        else
            this._minimap.sync(st.strip, animate && this.animate);
    }

    _onGrabBegin(w, op) {
        const st = w && this._state.get(w);
        if (st && st.strip)
            this._grabbed = w;
    }

    _onGrabEnd(w, op) {
        if (this._grabbed !== w)
            return;
        this._grabbed = null;
        const st = this._state.get(w);
        if (!st || !st.strip)
            return;
        const frame = w.get_frame_rect();

        if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING) {
            // Drop the window into whichever strip it landed on, ordered by x.
            const old = this._remove(w);
            const monitor = global.display.get_monitor_index_for_rect(frame);
            const strip = this._strip(w.get_workspace(), monitor);
            const center = frame.x + frame.width / 2;
            let index = 0;
            for (const other of strip.windows) {
                const r = other.get_frame_rect();
                if (r.x + r.width / 2 < center)
                    index++;
            }
            this._insert(w, strip, index);
            strip.lastFocus = w;
            if (old !== strip) {
                this._clampScroll(old);
                this.layout(old);
            }
            this._ensureVisible(strip, w);
            this.layout(strip);
        } else {
            st.frac = clamp(frame.width / this._workArea(st.strip).width, MIN_FRAC, 1);
            this._ensureVisible(st.strip, w);
            this.layout(st.strip);
        }
    }

    // Catches moves we did not make, e.g. Cinnamon's "move to monitor" keys.
    _onEnteredMonitor(w, monitor) {
        if (this._busy || this._grabbed)
            return;
        const st = this._state.get(w);
        if (!st || !st.strip || st.strip.monitor === monitor)
            return;
        const geo = global.display.get_monitor_geometry(monitor);
        const r = w.get_frame_rect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (cx < geo.x || cx >= geo.x + geo.width || cy < geo.y || cy >= geo.y + geo.height)
            return;
        this._later(() => {
            if (this._state.has(w) && w.get_monitor() === monitor)
                this._refile(w);
        });
    }

    // Apps sometimes resize themselves (e.g. restoring their own size after an
    // unmaximize). Put them back; if they insist, adopt their width.
    _onSizeChanged(w) {
        if (this._busy || w === this._grabbed)
            return;
        const st = this._state.get(w);
        if (!st || !st.strip || st.sizePending)
            return;
        st.sizePending = true;
        this._later(() => {
            st.sizePending = false;
            if (!st.strip || this._isSkipped(w))
                return;
            const { area, result } = this._positions(st.strip);
            const p = result.find(p => p.w === w);
            const r = w.get_frame_rect();
            if (!p || (r.width === p.width && r.height === area.height))
                return;
            const now = GLib.get_monotonic_time();
            if (st.lastSizeFix && now - st.lastSizeFix < 1000000)
                st.frac = clamp(r.width / area.width, MIN_FRAC, 1);
            st.lastSizeFix = now;
            this.layout(st.strip, false);
        }, 100);
    }

    // Cinnamon's tiling (edge drag, Super+arrows) maps onto widths: left/right
    // and corners mean half width, top means full width, bottom changes
    // nothing. layout() then untiles the window via unmaximize().
    _onTiled(w) {
        if (this._busy)
            return;
        const st = this._state.get(w);
        if (!st || !st.strip)
            return;
        const mode = w.tile_mode;
        if (mode === Meta.TileMode.NONE || mode === Meta.TileMode.MAXIMIZED)
            return;
        if (mode === Meta.TileMode.TOP) {
            if (st.frac < 0.99)
                st.prevFrac = st.frac;
            st.frac = 1;
        } else if (mode !== Meta.TileMode.BOTTOM) {
            st.frac = 0.5;
        }
        this._later(() => {
            if (st.strip && w !== this._grabbed) {
                this._ensureVisible(st.strip, w);
                this.layout(st.strip);
            }
        });
    }

    // Maximizing a tiled window means "full width" in a scrolling layout.
    _onMaximized(w) {
        if (this._busy)
            return;
        const st = this._state.get(w);
        if (!st || !st.strip || !w.maximized_horizontally)
            return;
        if (st.frac < 0.99)
            st.prevFrac = st.frac;
        st.frac = 1;
        this._later(() => {
            if (st.strip) {
                this._ensureVisible(st.strip, w);
                this.layout(st.strip);
            }
        });
    }

    // ---- layout ---------------------------------------------------------------

    // Strip-relative x and width for every window that takes space.
    _positions(strip) {
        const area = this._workArea(strip);
        const result = [];
        let x = 0;
        for (const w of strip.windows) {
            if (this._isSkipped(w))
                continue;
            const st = this._state.get(w);
            const width = w.allows_resize()
                ? Math.round(st.frac * area.width)
                : w.get_frame_rect().width;
            result.push({ w, x, width });
            x += width + this.gap;
        }
        return { area, result, total: Math.max(0, x - this.gap) };
    }

    // Returns true if the scroll offset changed.
    _ensureVisible(strip, w) {
        const { area, result } = this._positions(strip);
        const p = result.find(p => p.w === w);
        if (!p)
            return false;
        const before = strip.scroll;
        if (p.width >= area.width || p.x < strip.scroll)
            strip.scroll = p.x;
        else if (p.x + p.width > strip.scroll + area.width)
            strip.scroll = p.x + p.width - area.width;
        return strip.scroll !== before;
    }

    _clampScroll(strip) {
        const { area, total } = this._positions(strip);
        strip.scroll = clamp(strip.scroll, 0, Math.max(0, total - area.width));
    }

    layoutAll(animate = false) {
        for (const strip of this._allStrips())
            this.layout(strip, animate);
    }

    layout(strip, animate = true) {
        const { area, result } = this._positions(strip);
        const fullRect = area.full;
        const doAnimate = animate && this.animate &&
            strip.workspace === global.workspace_manager.get_active_workspace();

        this._busy++;
        try {
            for (const { w, x, width } of result) {
                const sx = area.x + x - strip.scroll;
                const visible = sx + width > fullRect.x && sx < fullRect.x + fullRect.width;

                // Offscreen windows that would spill onto another monitor get
                // tucked away; they come back when scrolled into view.
                if (!visible && this._overlapsOtherMonitor(sx, area.y, width, area.height, strip.monitor)) {
                    if (!w.minimized) {
                        this._autoMinimized.add(w);
                        w.minimize();
                    }
                    continue;
                }
                if (this._autoMinimized.has(w)) {
                    this._autoMinimized.delete(w);
                    w.unminimize();
                }

                if (w.get_maximized())
                    w.unmaximize(Meta.MaximizeFlags.BOTH);

                // user_op=true: Mutter otherwise keeps a window that was fully
                // on one monitor inside it, which stops it scrolling off.
                const old = w.get_frame_rect();
                if (w.allows_resize())
                    w.move_resize_frame(true, sx, area.y, width, area.height);
                else
                    w.move_frame(true, sx, area.y);
                const now = w.get_frame_rect();

                if (!visible)
                    w.lower();

                const actor = w.get_compositor_private();
                if (!actor)
                    continue;
                // Animate from where the window currently appears, which
                // includes any offset left over from a touchpad swipe.
                const from = actor.translation_x + old.x - now.x;
                if (doAnimate && from !== 0 && old.width === now.width && old.y === now.y) {
                    actor.remove_all_transitions();
                    actor.translation_x = from;
                    actor.ease({
                        translation_x: 0,
                        duration: this.animationTime,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else if (actor.translation_x !== 0) {
                    actor.remove_all_transitions();
                    actor.translation_x = 0;
                }
            }
        } finally {
            this._busy--;
        }
        this._minimap.sync(strip, doAnimate);
    }

    _overlapsOtherMonitor(x, y, width, height, monitor) {
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            if (i === monitor)
                continue;
            const g = global.display.get_monitor_geometry(i);
            if (x < g.x + g.width && x + width > g.x && y < g.y + g.height && y + height > g.y)
                return true;
        }
        return false;
    }


    // ---- touchpad gestures ----------------------------------------------------
    //
    // Cinnamon's GesturesManager owns the touchegg client. We hide the swipe we
    // handle from its action lookup, and listen to the same client ourselves.

    _setupGestures() {
        const gm = Main.gesturesManager;
        if (!gm || typeof gm.lookup_definition !== 'function')
            return;
        this._gm = gm;
        const original = Object.getPrototypeOf(gm).lookup_definition;
        gm.lookup_definition = (type, direction, fingers) =>
            this._ownsGesture(type, direction, fingers) ? null : original.call(gm, type, direction, fingers);
        this._hookGestureClient();
        // Cinnamon recreates the client when gestures are toggled in settings.
        this._connect(gm.settings, 'changed', () => this._later(() => this._hookGestureClient()));
    }

    _teardownGestures() {
        this._unhookGestureClient();
        if (this._gm) {
            delete this._gm.lookup_definition;
            this._gm = null;
        }
        if (this._swipe)
            this._cancelSwipe();
    }

    _hookGestureClient() {
        const client = this._gm && this._gm.client;
        if (client === this._gestureClient)
            return;
        this._unhookGestureClient();
        if (!client)
            return;
        this._gestureClient = client;
        this._gestureIds = [
            client.connect('gesture-begin', (c, ...args) => this._onGestureBegin(...args)),
            client.connect('gesture-update', (c, ...args) => this._onGestureUpdate(...args)),
            client.connect('gesture-end', (c, ...args) => this._onGestureEnd(...args)),
        ];
    }

    _unhookGestureClient() {
        if (this._gestureClient) {
            for (const id of this._gestureIds)
                this._gestureClient.disconnect(id);
        }
        this._gestureClient = null;
        this._gestureIds = [];
    }

    _ownsGesture(type, direction, fingers) {
        return this.gestureFingers > 0 &&
            type === GestureType.SWIPE &&
            fingers === this.gestureFingers &&
            (direction === GestureDirection.LEFT || direction === GestureDirection.RIGHT);
    }

    _onGestureBegin(type, direction, percentage, fingers, device, time) {
        this._swipe = null;
        if (!this._ownsGesture(type, direction, fingers) || Main.overview.visible || Main.expo.visible)
            return;
        const strip = this._currentStrip();
        if (!strip.windows.some(w => !this._isSkipped(w)))
            return;
        // Fingers moving left pull the strip left, revealing windows on the right.
        let sign = direction === GestureDirection.LEFT ? 1 : -1;
        if (!this.gestureNatural)
            sign = -sign;
        const { area, total } = this._positions(strip);
        this._swipe = {
            strip,
            sign,
            startScroll: strip.scroll,
            minScroll: Math.min(0, strip.scroll),
            maxScroll: Math.max(strip.scroll, total - area.width, 0),
            pxPerPercent: area.width * this.gestureSpeed / 100,
            samples: [],
        };
        if (this.showMinimap)
            this._minimap.show(strip);
        this._onGestureUpdate(type, direction, percentage, fingers, device, time);
    }

    _onGestureUpdate(type, direction, percentage, fingers, device, time) {
        const sw = this._swipe;
        if (!sw)
            return;
        const raw = sw.startScroll + sw.sign * percentage * sw.pxPerPercent;
        sw.samples.push({ scroll: raw, time });
        while (sw.samples.length > 2 && time - sw.samples[0].time > VELOCITY_WINDOW_MS)
            sw.samples.shift();

        let scroll = raw;
        if (scroll < sw.minScroll)
            scroll = sw.minScroll - (sw.minScroll - scroll) * OVERSCROLL_RESISTANCE;
        else if (scroll > sw.maxScroll)
            scroll = sw.maxScroll + (scroll - sw.maxScroll) * OVERSCROLL_RESISTANCE;
        sw.strip.scroll = scroll;
        this._previewScroll(sw.strip);
    }

    _onGestureEnd(type, direction, percentage, fingers, device, time) {
        const sw = this._swipe;
        if (!sw)
            return;
        this._onGestureUpdate(type, direction, percentage, fingers, device, time);
        this._swipe = null;

        const strip = sw.strip;
        const first = sw.samples[0], last = sw.samples[sw.samples.length - 1];
        const dt = last.time - first.time;
        const velocity = dt > 0 ? (last.scroll - first.scroll) / dt : 0;
        const projected = strip.scroll + velocity * MOMENTUM_MS;

        // Settle on the window closest to the middle of where the flick lands.
        const { area, result, total } = this._positions(strip);
        const mid = projected + area.width / 2;
        let target = null, best = Infinity;
        for (const p of result) {
            const d = Math.abs(p.x + p.width / 2 - mid);
            if (d < best) {
                best = d;
                target = p.w;
            }
        }
        strip.scroll = Math.round(clamp(projected, Math.min(0, sw.minScroll), Math.max(0, total - area.width)));
        if (target)
            this._ensureVisible(strip, target);
        this.layout(strip);
        if (target && target !== global.display.focus_window)
            target.activate(global.get_current_time());
        if (this._minimap.strip === strip)
            this._minimap.hideAfter(this.animationTime + MINIMAP_LINGER_MS);
    }

    _cancelSwipe() {
        const strip = this._swipe.strip;
        this._swipe = null;
        this.layout(strip, false);
        this._minimap.hide();
    }

    // Shift window actors to where the strip would put them, without moving
    // the real (X11) windows. layout() later commits and animates from here.
    _previewScroll(strip) {
        const { area, result } = this._positions(strip);
        for (const { w, x } of result) {
            const actor = w.get_compositor_private();
            if (!actor || this._autoMinimized.has(w))
                continue;
            actor.remove_all_transitions();
            actor.translation_x = area.x + x - strip.scroll - w.get_frame_rect().x;
        }
        this._minimap.sync(strip, false);
    }

    // ---- minimap -----------------------------------------------------------------

    // Shown by keyboard actions until the modifiers are released.
    _flashMinimap() {
        if (!this.showMinimap)
            return;
        const f = this._focusedTiled();
        const strip = f ? f.strip : this._currentStrip();
        if (!strip.windows.some(w => !this._isSkipped(w)))
            return;
        this._minimap.show(strip);
        this._minimap.hideOnModifierRelease();
    }

    // ---- actions ----------------------------------------------------------------

    _focusedTiled() {
        const w = global.display.focus_window;
        const st = w && this._state.get(w);
        return st && st.strip ? { w, st, strip: st.strip } : null;
    }

    // Strip on the active workspace under the pointer's monitor.
    _currentStrip() {
        const ws = global.workspace_manager.get_active_workspace();
        return this._strip(ws, global.display.get_current_monitor());
    }

    focusNeighbor(dir) {
        const f = this._focusedTiled();
        if (!f) {
            const strip = this._currentStrip();
            const target = strip.lastFocus || strip.windows.find(w => !this._isSkipped(w));
            if (target)
                target.activate(global.get_current_time());
            return;
        }
        const list = f.strip.windows.filter(w => !this._isSkipped(w));
        const target = list[list.indexOf(f.w) + dir];
        if (target)
            target.activate(global.get_current_time());
    }

    focusEdge(last) {
        const f = this._focusedTiled();
        const strip = f ? f.strip : this._currentStrip();
        const list = strip.windows.filter(w => !this._isSkipped(w));
        const target = last ? list[list.length - 1] : list[0];
        if (target)
            target.activate(global.get_current_time());
    }

    moveFocused(dir) {
        const f = this._focusedTiled();
        if (!f)
            return;
        const windows = f.strip.windows;
        let i = windows.indexOf(f.w);
        let j = i + dir;
        while (j >= 0 && j < windows.length && this._isSkipped(windows[j]))
            j += dir;
        if (j < 0 || j >= windows.length)
            return;
        windows.splice(i, 1);
        windows.splice(j, 0, f.w);
        this._ensureVisible(f.strip, f.w);
        this.layout(f.strip);
    }

    cycleWidth() {
        const f = this._focusedTiled();
        if (!f)
            return;
        const next = WIDTH_STEPS.find(s => s > f.st.frac + 0.01);
        f.st.frac = next !== undefined ? next : WIDTH_STEPS[0];
        this._ensureVisible(f.strip, f.w);
        this.layout(f.strip);
    }

    toggleFullWidth() {
        const f = this._focusedTiled();
        if (!f)
            return;
        if (f.st.frac >= 0.99) {
            f.st.frac = f.st.prevFrac || 0.5;
        } else {
            f.st.prevFrac = f.st.frac;
            f.st.frac = 1;
        }
        this._ensureVisible(f.strip, f.w);
        this.layout(f.strip);
    }

    centerFocused() {
        const f = this._focusedTiled();
        if (!f)
            return;
        const { area, result } = this._positions(f.strip);
        const p = result.find(p => p.w === f.w);
        if (!p)
            return;
        f.strip.scroll = Math.round(p.x + p.width / 2 - area.width / 2);
        this.layout(f.strip);
    }

    toggleFloat() {
        const w = global.display.focus_window;
        const st = w && this._state.get(w);
        if (!st)
            return;
        if (st.floating) {
            st.floating = false;
            if (!this._isTileable(w))
                return;
            const strip = this._strip(w.get_workspace(), w.get_monitor());
            const i = strip.lastFocus ? strip.windows.indexOf(strip.lastFocus) : -1;
            this._insert(w, strip, i >= 0 ? i + 1 : strip.windows.length);
            strip.lastFocus = w;
            this._ensureVisible(strip, w);
            this.layout(strip);
        } else {
            st.floating = true;
            const strip = this._remove(w);
            if (strip) {
                this._clampScroll(strip);
                this.layout(strip);
            }
            // Give the floating window a sensible size in the middle of its monitor.
            const wa = w.get_work_area_current_monitor();
            const width = Math.round(wa.width * 0.6), height = Math.round(wa.height * 0.7);
            w.move_resize_frame(false, wa.x + Math.round((wa.width - width) / 2),
                wa.y + Math.round((wa.height - height) / 2), width, height);
            w.raise();
        }
    }
}

function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

function init(metadata) {
    extensionMeta = metadata;
}

function enable() {
    tiler = new Tiler(extensionMeta.uuid);
}

function disable() {
    if (tiler) {
        tiler.destroy();
        tiler = null;
    }
}

// For debugging from Looking Glass / org.Cinnamon.Eval.
function getTiler() {
    return tiler;
}
