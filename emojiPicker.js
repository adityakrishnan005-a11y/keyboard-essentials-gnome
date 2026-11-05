import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { boxLayoutProps } from './compat.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export class EmojiPickerSection {
    constructor(indicator) {
        this.indicator = indicator;
        this._data = null;
        this._recentEmojis = [];
        this._currentCategory = 'all';
        this._searchQuery = '';
        this._searchTimeout = null;

        this.actor = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'ke-picker-section ke-emoji-section',
            x_expand: true,
            y_expand: true
        });

        this._buildUI();
    }

    _getDataPath() {
        return GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'keyboard-essentials',
            'emoji-data.json'
        ]);
    }

    _getRecentsPath() {
        return GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'keyboard-essentials',
            'recent-emojis.json'
        ]);
    }

    _buildUI() {
        // Search entry row
        const searchBox = new St.BoxLayout({
            ...boxLayoutProps(false),
            style_class: 'ke-search-box',
            x_expand: true
        });

        this.searchEntry = new St.Entry({
            name: 'keEmojiSearchEntry',
            style_class: 'search-entry ke-search-entry',
            can_focus: true,
            hint_text: _('Search emojis...'),
            track_hover: true,
            x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
        });

        this.searchEntry.get_clutter_text().connect('text-changed', () => {
            if (this._searchTimeout) {
                clearTimeout(this._searchTimeout);
            }
            this._searchTimeout = setTimeout(() => {
                this._searchQuery = this.searchEntry.get_text().trim().toLowerCase();
                this._refreshGrid();
            }, 100);
        });

        searchBox.add_child(this.searchEntry);
        this.actor.add_child(searchBox);

        // Category filter bar
        this.categoryBar = new St.BoxLayout({
            ...boxLayoutProps(false),
            style_class: 'ke-category-bar',
            x_expand: true
        });

        this.actor.add_child(this.categoryBar);

        // Scroll view for emoji grid
        this.scrollView = new St.ScrollView({
            style_class: 'ke-emoji-scroll-view',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true
        });

        this.grid = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'ke-emoji-grid-box',
            x_expand: true
        });

        this.scrollView.add_child(this.grid);
        this.actor.add_child(this.scrollView);

        // Empty / Not installed notice
        this.noticeBox = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'keyboard-essentials-empty-state ke-notice-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this.noticeBox.visible = false;
        this.actor.add_child(this.noticeBox);
    }

    loadData() {
        if (this._data) return true;

        this._loadRecents();

        const dataPath = this._getDataPath();
        let file = Gio.File.new_for_path(dataPath);

        // Fallback: try bundled data next to the extension's JS files
        if (!file.query_exists(null)) {
            // __filename gives us the path of this module file inside the extension
            try {
                const moduleFile = Gio.File.new_for_uri(import.meta.url);
                const bundledFile = moduleFile.get_parent().get_child('data').get_child('emoji-data.json');
                if (bundledFile.query_exists(null)) {
                    file = bundledFile;
                }
            } catch (e) {
                // ignore
            }
        }

        if (!file.query_exists(null)) {
            this._showNotice(
                _('Emoji database not installed'),
                _('Open Settings to download the offline emoji database.')
            );
            return false;
        }

        try {
            const [success, contents] = file.load_contents(null);
            if (success) {
                const text = new TextDecoder('utf-8').decode(contents);
                this._data = JSON.parse(text);
                this._buildCategories();
                this._refreshGrid();
                this.noticeBox.visible = false;
                this.scrollView.visible = true;
                this.categoryBar.visible = true;
                return true;
            }
        } catch (e) {
            console.error('Keyboard Essentials: Failed to load emoji data', e);
            this._showNotice(
                _('Failed to load emoji data'),
                e.message
            );
            return false;
        }

        return false;
    }

    _showNotice(title, subtitle) {
        this.noticeBox.destroy_all_children();
        this.noticeBox.add_child(new St.Icon({
            icon_name: 'face-smile-symbolic',
            style_class: 'system-status-icon keyboard-essentials-icon',
            icon_size: 32,
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.noticeBox.add_child(new St.Label({
            text: title,
            style: 'font-weight: bold; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.noticeBox.add_child(new St.Label({
            text: subtitle,
            style: 'font-size: 0.9em; opacity: 0.7; margin-top: 4px;',
            x_align: Clutter.ActorAlign.CENTER
        }));

        const settingsBtn = new St.Button({
            label: _('Open Settings'),
            style_class: 'button ke-action-button',
            x_align: Clutter.ActorAlign.CENTER
        });
        settingsBtn.connect('clicked', () => {
            this.indicator._openSettings();
        });
        this.noticeBox.add_child(settingsBtn);

        this.scrollView.visible = false;
        this.categoryBar.visible = false;
        this.noticeBox.visible = true;
    }

    _buildCategories() {
        this.categoryBar.destroy_all_children();

        const categories = [
            { id: 'recents', name: _('Recent'), icon: 'document-open-recent-symbolic' },
            { id: 'all', name: _('All'), icon: 'view-grid-symbolic' }
        ];

        if (this._data?.categories) {
            categories.push(...this._data.categories);
        }

        this._catButtons = [];

        categories.forEach(cat => {
            const btn = new St.Button({
                style_class: 'ke-cat-btn' + (this._currentCategory === cat.id ? ' active' : ''),
                can_focus: true,
                accessible_name: cat.name,
                child: new St.Icon({
                    icon_name: cat.icon,
                    icon_size: 16
                })
            });

            btn.connect('clicked', () => {
                this._currentCategory = cat.id;
                this._catButtons.forEach(b => b.remove_style_class_name('active'));
                btn.add_style_class_name('active');
                this._refreshGrid();
            });

            this._catButtons.push(btn);
            this.categoryBar.add_child(btn);
        });
    }

    _refreshGrid() {
        this.grid.destroy_all_children();
        if (!this._data?.emojis) return;

        let filtered = [];

        if (this._currentCategory === 'recents') {
            const recentChars = new Set(this._recentEmojis);
            filtered = this._data.emojis.filter(e => recentChars.has(e.char));
            // Keep recents order
            filtered.sort((a, b) => this._recentEmojis.indexOf(a.char) - this._recentEmojis.indexOf(b.char));
        } else if (this._currentCategory === 'all') {
            filtered = this._data.emojis;
        } else {
            filtered = this._data.emojis.filter(e => e.category === this._currentCategory);
        }

        if (this._searchQuery) {
            const q = this._searchQuery;
            filtered = filtered.filter(e => {
                if (e.name.toLowerCase().includes(q)) return true;
                if (e.keywords?.some(k => k.toLowerCase().includes(q))) return true;
                return false;
            });
        }

        // Limit rendering to first 160 items for snappy performance
        const renderSlice = filtered.slice(0, 160);
        const COLS = 8;

        for (let i = 0; i < renderSlice.length; i += COLS) {
            const rowSlice = renderSlice.slice(i, i + COLS);
            const rowBox = new St.BoxLayout({
                ...boxLayoutProps(false),
                style_class: 'ke-emoji-row',
                x_expand: true
            });

            rowSlice.forEach(emoji => {
                const btn = new St.Button({
                    label: emoji.char,
                    style_class: 'ke-emoji-btn',
                    can_focus: true,
                    accessible_name: emoji.name
                });

                btn.connect('clicked', () => {
                    this._addRecent(emoji.char);
                    this.indicator.pasteEmoji(emoji.char);
                });

                rowBox.add_child(btn);
            });

            this.grid.add_child(rowBox);
        }
    }

    _loadRecents() {
        try {
            const recentsPath = this._getRecentsPath();
            const file = Gio.File.new_for_path(recentsPath);
            if (file.query_exists(null)) {
                const [ok, bytes] = file.load_contents(null);
                if (ok) {
                    this._recentEmojis = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                }
            }
        } catch (e) {
            this._recentEmojis = [];
        }
    }

    _addRecent(char) {
        this._recentEmojis = [char, ...this._recentEmojis.filter(c => c !== char)].slice(0, 36);
        try {
            const recentsPath = this._getRecentsPath();
            const parent = Gio.File.new_for_path(recentsPath).get_parent();
            if (!parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }
            const file = Gio.File.new_for_path(recentsPath);
            file.replace_contents(
                JSON.stringify(this._recentEmojis),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            console.error('Keyboard Essentials: Failed to save recent emojis', e);
        }
    }

    focusSearch() {
        this.searchEntry.grab_key_focus();
    }

    destroy() {
        if (this._searchTimeout) {
            clearTimeout(this._searchTimeout);
            this._searchTimeout = null;
        }
        this.actor.destroy();
    }
}
