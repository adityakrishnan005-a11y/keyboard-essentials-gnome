import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { boxLayoutProps } from './compat.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const GIPHY_DEFAULT_KEY = 'dc6zaTOxFJmzC';

export class GifPickerSection {
    constructor(indicator) {
        this.indicator = indicator;
        this._httpSession = new Soup.Session();
        this._searchTimeout = null;
        this._recentGifs = [];
        this._activeQuery = '';
        this._destroyed = false;

        this.actor = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'ke-picker-section ke-gif-section',
            x_expand: true,
            y_expand: true
        });

        this._ensureDirectories();
        this._loadRecents();
        this._buildUI();
    }

    _ensureDirectories() {
        try {
            const cacheDir = Gio.File.new_for_path(this._getThumbCacheDir());
            if (!cacheDir.query_exists(null)) {
                cacheDir.make_directory_with_parents(null);
            }
            const dataDir = Gio.File.new_for_path(this._getDataDir());
            if (!dataDir.query_exists(null)) {
                dataDir.make_directory_with_parents(null);
            }
        } catch (e) {
            console.error('Keyboard Essentials: Failed to create GIF cache dir', e);
        }
    }

    _getDataDir() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'keyboard-essentials']);
    }

    _getThumbCacheDir() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'keyboard-essentials', 'gifs']);
    }

    _getRecentsPath() {
        return GLib.build_filenamev([this._getDataDir(), 'recent-gifs.json']);
    }

    _buildUI() {
        // Search entry row
        const searchBox = new St.BoxLayout({
            ...boxLayoutProps(false),
            style_class: 'ke-search-box',
            x_expand: true
        });

        this.searchEntry = new St.Entry({
            name: 'keGifSearchEntry',
            style_class: 'search-entry ke-search-entry',
            can_focus: true,
            hint_text: _('Search GIFs via Giphy...'),
            track_hover: true,
            x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
        });

        this.searchEntry.get_clutter_text().connect('text-changed', () => {
            if (this._searchTimeout) {
                clearTimeout(this._searchTimeout);
            }
            this._searchTimeout = setTimeout(() => {
                const query = this.searchEntry.get_text().trim();
                this._fetchGifs(query);
            }, 350);
        });

        searchBox.add_child(this.searchEntry);
        this.actor.add_child(searchBox);

        // Status / Loading label
        this.statusLabel = new St.Label({
            text: _('Trending GIFs'),
            style_class: 'ke-section-subtitle',
            x_align: Clutter.ActorAlign.START
        });
        this.actor.add_child(this.statusLabel);

        // Scroll view for GIF grid
        this.scrollView = new St.ScrollView({
            style_class: 'ke-gif-scroll-view',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true
        });

        const flowLayout = new Clutter.FlowLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            homogeneous: false,
            column_spacing: 6,
            row_spacing: 6,
            min_line_length: 340,
            max_line_length: 380
        });

        this.grid = new St.Widget({
            layout_manager: flowLayout,
            style_class: 'ke-gif-grid',
            x_expand: true,
            y_expand: true
        });

        this.scrollView.add_child(this.grid);
        this.actor.add_child(this.scrollView);
    }

    async initContent() {
        if (this._activeQuery) return;
        if (this._recentGifs.length > 0) {
            this.statusLabel.set_text(_('Recent GIFs'));
            this._displayGifs(this._recentGifs);
        } else {
            this._fetchGifs('');
        }
    }

    async _fetchGifs(query) {
        if (this._destroyed) return;
        this._activeQuery = query;

        const customKey = this.indicator.extension.settings.get_string('gif-api-key');
        const apiKey = customKey ? customKey.trim() : GIPHY_DEFAULT_KEY;
        const limit = this.indicator.extension.settings.get_int('gif-recent-limit') || 20;

        let url;
        if (query) {
            this.statusLabel.set_text(_(`Results for "${query}"`));
            url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&rating=g`;
        } else {
            this.statusLabel.set_text(_('Trending on Giphy'));
            url = `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&rating=g`;
        }

        try {
            const message = Soup.Message.new('GET', url);
            const bytes = await this._httpSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null
            );

            if (this._destroyed) return;

            const text = new TextDecoder('utf-8').decode(bytes.get_data());
            const json = JSON.parse(text);

            if (json.data && Array.isArray(json.data)) {
                const parsed = json.data.map(item => ({
                    id: item.id,
                    title: item.title || 'GIF',
                    url: item.images?.original?.url || item.url,
                    thumbUrl: item.images?.fixed_width_small?.url ||
                              item.images?.preview_gif?.url ||
                              item.images?.fixed_height_small?.url ||
                              item.images?.original?.url
                }));
                this._displayGifs(parsed);
            } else if (json.message) {
                this.statusLabel.set_text(_('API error: ') + json.message);
            }
        } catch (e) {
            if (!this._destroyed) {
                console.error('Keyboard Essentials: GIF fetch error', e);
                this.statusLabel.set_text(_('Failed to load GIFs (offline or API limit)'));
            }
        }
    }

    _displayGifs(gifList) {
        this.grid.destroy_all_children();

        if (gifList.length === 0) {
            const emptyLabel = new St.Label({
                text: _('No GIFs found'),
                style: 'opacity: 0.6; margin: 20px;',
                x_align: Clutter.ActorAlign.CENTER
            });
            this.grid.add_child(emptyLabel);
            return;
        }

        gifList.forEach(gif => {
            const btn = new St.Button({
                style_class: 'ke-gif-thumb-btn',
                can_focus: true,
                accessible_name: gif.title
            });

            const placeholder = new St.Icon({
                icon_name: 'video-x-generic-symbolic',
                style_class: 'ke-gif-placeholder',
                icon_size: 32
            });

            btn.set_child(placeholder);

            btn.connect('clicked', () => {
                this._addRecent(gif);
                this.indicator.pasteGif(gif.url);
            });

            this.grid.add_child(btn);

            // Asynchronously load thumbnail image
            this._loadThumbnail(gif.thumbUrl).then(localPath => {
                if (this._destroyed || !localPath) return;
                const gicon = Gio.icon_new_for_string(localPath);
                const thumbIcon = new St.Icon({
                    gicon,
                    style_class: 'ke-gif-image'
                });
                btn.set_child(thumbIcon);
            }).catch(e => {
                // Keep placeholder on error
            });
        });
    }

    async _loadThumbnail(url) {
        if (!url) return null;

        const checksum = GLib.compute_checksum_for_string(
            GLib.ChecksumType.MD5,
            url,
            -1
        );
        const filename = `${checksum}.jpg`;
        const localPath = GLib.build_filenamev([this._getThumbCacheDir(), filename]);
        const localFile = Gio.File.new_for_path(localPath);

        if (localFile.query_exists(null)) {
            return localPath;
        }

        try {
            const message = Soup.Message.new('GET', url);
            const bytes = await this._httpSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null
            );
            if (bytes && !this._destroyed) {
                localFile.replace_contents(
                    bytes.get_data(),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
                return localPath;
            }
        } catch (e) {
            // failed to cache
        }
        return null;
    }

    _loadRecents() {
        try {
            const file = Gio.File.new_for_path(this._getRecentsPath());
            if (file.query_exists(null)) {
                const [ok, bytes] = file.load_contents(null);
                if (ok) {
                    this._recentGifs = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                }
            }
        } catch (e) {
            this._recentGifs = [];
        }
    }

    _addRecent(gif) {
        const limit = this.indicator.extension.settings.get_int('gif-recent-limit') || 20;
        this._recentGifs = [gif, ...this._recentGifs.filter(g => g.url !== gif.url)].slice(0, limit);
        try {
            const file = Gio.File.new_for_path(this._getRecentsPath());
            file.replace_contents(
                JSON.stringify(this._recentGifs),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            console.error('Keyboard Essentials: Failed to save recent GIFs', e);
        }
    }

    focusSearch() {
        this.searchEntry.grab_key_focus();
    }

    destroy() {
        this._destroyed = true;
        if (this._searchTimeout) {
            clearTimeout(this._searchTimeout);
            this._searchTimeout = null;
        }
        if (this._httpSession) {
            this._httpSession.abort();
        }
        this.actor.destroy();
    }
}
