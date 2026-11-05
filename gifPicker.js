import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { boxLayoutProps, getDefaultBackend } from './compat.js';
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
                this._activeQuery = '';
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

        // === PREVIEW PANEL (hidden by default) ===
        this.previewPanel = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'ke-gif-preview-panel',
            x_expand: true,
            visible: false
        });

        // Back button row
        const previewHeader = new St.BoxLayout({
            ...boxLayoutProps(false),
            style_class: 'ke-gif-preview-header',
            x_expand: true
        });

        const backBtn = new St.Button({
            style_class: 'ke-gif-back-btn',
            can_focus: true,
            child: new St.BoxLayout({
                ...boxLayoutProps(false),
                style_class: 'ke-gif-back-inner'
            })
        });
        const backInner = backBtn.get_child();
        backInner.add_child(new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 14 }));
        backInner.add_child(new St.Label({ text: _(' Back') }));
        backBtn.connect('clicked', () => this._closePreview());
        previewHeader.add_child(backBtn);

        this.previewTitle = new St.Label({
            text: '',
            style_class: 'ke-gif-preview-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        previewHeader.add_child(this.previewTitle);
        this.previewPanel.add_child(previewHeader);

        // Large preview image — use a Bin container so we can swap content
        this.previewImageBin = new St.Bin({
            style_class: 'ke-gif-preview-image',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this.previewImageBin.set_child(new St.Icon({
            icon_name: 'video-x-generic-symbolic',
            icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.previewPanel.add_child(this.previewImageBin);

        // Paste button
        const pasteBtn = new St.Button({
            label: _('📋  Paste GIF link'),
            style_class: 'button ke-action-button ke-gif-paste-btn',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        pasteBtn.connect('clicked', () => {
            if (this._previewGif) {
                this._addRecent(this._previewGif);
                this.indicator.pasteGif(this._previewGif.url);
                this._closePreview();
            }
        });
        this.previewPanel.add_child(pasteBtn);

        this.actor.add_child(this.previewPanel);

        // === SCROLL VIEW for GIF grid ===
        this.scrollView = new St.ScrollView({
            style_class: 'ke-gif-scroll-view',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true
        });

        this.grid = new St.BoxLayout({
            ...boxLayoutProps(true),
            style_class: 'ke-gif-grid-box',
            x_expand: true
        });

        this.scrollView.add_child(this.grid);
        this.actor.add_child(this.scrollView);
    }

    _openPreview(gif) {
        this._previewGif = gif;
        this.previewTitle.set_text(gif.title || 'GIF');
        // Reset to placeholder while loading
        this.previewImageBin.set_child(new St.Icon({
            icon_name: 'video-x-generic-symbolic',
            icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER
        }));

        this.scrollView.visible = false;
        this.previewPanel.visible = true;

        // Load larger image for preview
        const previewUrl = gif.previewUrl || gif.thumbUrl || gif.url;
        this._loadThumbnail(previewUrl).then(localPath => {
            if (this._destroyed || !this._previewGif || !localPath) return;
            this.previewImageBin.set_child(this._makeImageWidget(localPath, 356, 220));
        }).catch(() => {});
    }

    _closePreview() {
        this._previewGif = null;
        this.previewPanel.visible = false;
        this.scrollView.visible = true;
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

            if (json.meta && json.meta.status >= 400) {
                this.statusLabel.set_text(_('GIPHY: ') + (json.meta.msg || _('API key required')));
                this._showApiKeyPrompt();
                return;
            }

            if (json.data && Array.isArray(json.data) && json.data.length > 0) {
                const parsed = json.data.map(item => ({
                    id: item.id,
                    title: item.title || 'GIF',
                    url: item.images?.original?.url || item.url,
                    thumbUrl: item.images?.fixed_width?.url ||
                              item.images?.downsized?.url ||
                              item.images?.fixed_height?.url ||
                              item.images?.original?.url,
                    previewUrl: item.images?.downsized_medium?.url ||
                                item.images?.downsized?.url ||
                                item.images?.original?.url
                }));
                this._displayGifs(parsed);
            } else if (json.data && Array.isArray(json.data) && json.data.length === 0) {
                this._displayGifs([]);
            } else if (json.message) {
                this.statusLabel.set_text(_('API error: ') + json.message);
                this._showApiKeyPrompt();
            }
        } catch (e) {
            if (!this._destroyed) {
                console.error('Keyboard Essentials: GIF fetch error', e);
                this.statusLabel.set_text(_('Failed to load GIFs (offline or invalid key)'));
                this._showApiKeyPrompt();
            }
        }
    }

    _showApiKeyPrompt() {
        this.grid.destroy_all_children();
        const box = new St.BoxLayout({
            ...boxLayoutProps(true),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 24px;'
        });

        box.add_child(new St.Icon({
            icon_name: 'dialog-password-symbolic',
            icon_size: 32,
            style: 'opacity: 0.6; margin-bottom: 8px;',
            x_align: Clutter.ActorAlign.CENTER
        }));

        box.add_child(new St.Label({
            text: _('GIPHY API Key Required'),
            style: 'font-weight: bold; margin-bottom: 4px;',
            x_align: Clutter.ActorAlign.CENTER
        }));

        box.add_child(new St.Label({
            text: _('Add your free API key in Settings to search GIFs.'),
            style: 'font-size: 0.85em; opacity: 0.7; margin-bottom: 12px; text-align: center;',
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
        box.add_child(settingsBtn);

        this.grid.add_child(box);
    }

    // --------------- Image rendering (GNOME 48–51 safe) ---------------

    /**
     * Load a local image file and return an St.Bin containing a properly
     * sized image using St.ImageContent (the GNOME 48+ replacement for
     * the removed Clutter.Image).  Falls back to St.Icon on any error.
     */
    _makeImageWidget(localPath, width, height) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                localPath, width, height, true   // preserve aspect ratio
            );
            if (!pixbuf) throw new Error('null pixbuf');

            const pw = pixbuf.get_width();
            const ph = pixbuf.get_height();
            const rowstride = pixbuf.get_rowstride();
            const format = pixbuf.get_has_alpha()
                ? Cogl.PixelFormat.RGBA_8888
                : Cogl.PixelFormat.RGB_888;
            const bytes = pixbuf.read_pixel_bytes();

            const content = St.ImageContent.new_with_preferred_size(pw, ph);

            // set_bytes gained a CoglContext arg in GNOME 48+ (6 args vs old 5)
            let coglCtx = null;
            try {
                const backend = getDefaultBackend();
                coglCtx = backend?.get_cogl_context?.() ?? null;
            } catch (be) {}
            if (!coglCtx) {
                try {
                    coglCtx = global.stage?.context?.get_backend?.()?.get_cogl_context?.() ?? null;
                } catch (ce) {}
            }

            if (content.set_bytes.length >= 6 && coglCtx) {
                content.set_bytes(coglCtx, bytes, format, pw, ph, rowstride);
            } else {
                content.set_bytes(bytes, format, pw, ph, rowstride);
            }

            const bin = new St.Bin({
                width,
                height,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                content,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT
            });
            return bin;
        } catch (e) {
            console.warn('Keyboard Essentials: _makeImageWidget error, falling back to St.Icon', e);
            // Fallback: St.Icon with large icon_size
            return new St.Icon({
                gicon: Gio.icon_new_for_string(localPath),
                icon_size: Math.min(width, height),
                style_class: 'ke-gif-image'
            });
        }
    }

    // -------------------------------------------------------------------

    _displayGifs(gifList) {
        this.grid.destroy_all_children();
        this._closePreview();

        if (gifList.length === 0) {
            const emptyLabel = new St.Label({
                text: _('No GIFs found'),
                style: 'opacity: 0.6; margin: 30px;',
                x_align: Clutter.ActorAlign.CENTER
            });
            this.grid.add_child(emptyLabel);
            return;
        }

        // Single-column layout — one large card per row
        const THUMB_W = 356;
        const THUMB_H = 180;

        gifList.forEach(gif => {
            const btn = new St.Button({
                style_class: 'ke-gif-thumb-btn',
                can_focus: true,
                x_expand: true,
                accessible_name: gif.title
            });

            btn.set_child(new St.Icon({
                icon_name: 'video-x-generic-symbolic',
                style_class: 'ke-gif-placeholder',
                icon_size: 48
            }));

            btn.connect('clicked', () => this._openPreview(gif));
            this.grid.add_child(btn);

            // Async: download thumb then render with proper scaling
            this._loadThumbnail(gif.thumbUrl).then(localPath => {
                if (this._destroyed || !localPath) return;
                btn.set_child(this._makeImageWidget(localPath, THUMB_W, THUMB_H));
            }).catch(() => {});
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
