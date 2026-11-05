/**
 * compat.js — GNOME Shell version compatibility helpers
 *
 * GNOME 51 removed:
 *   - Clutter.get_default_backend()  → use global.stage.context.get_backend()
 *   - St.BoxLayout { vertical }      → use { orientation: Clutter.Orientation.VERTICAL/HORIZONTAL }
 */

import Clutter from 'gi://Clutter';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const shellVersion = Number(Config.PACKAGE_VERSION.split('.')[0]);

/**
 * Returns the default Clutter backend in a version-safe way.
 * GNOME ≤50: Clutter.get_default_backend()
 * GNOME 51+: global.stage.context.get_backend()
 */
export function getDefaultBackend() {
    if (shellVersion >= 51) {
        return global.stage.context.get_backend();
    }
    return Clutter.get_default_backend();
}

/**
 * Returns St.BoxLayout orientation props in a version-safe way.
 * @param {boolean} vertical - true for vertical, false for horizontal
 * GNOME ≤50: { vertical: true/false }
 * GNOME 51+: { orientation: Clutter.Orientation.VERTICAL/HORIZONTAL }
 */
export function boxLayoutProps(vertical) {
    if (shellVersion >= 51) {
        return {
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }
    return { vertical };
}
