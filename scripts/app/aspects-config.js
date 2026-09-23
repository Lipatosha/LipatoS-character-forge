import { FontLoader } from "../utils/font-loader.js";
import { acquireForgeStyles, releaseForgeStyles } from "../runtime-style.js";
import { applyWindowScaling, cleanupWindowScaling } from "../utils/scaling-helper.js";
import {
    getThemeChoices,
    getThemeClassList,
    getThemePanel,
    getThemePreview
} from "../theme-registry.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const DEFAULT_PREVIEW_MODES = [
    { id: 'start', label: 'ORIGINATE.Aspects.PreviewStart', icon: 'fas fa-home' },
    { id: 'details', label: 'ORIGINATE.Aspects.PreviewDetails', icon: 'fas fa-user' }
];

const themeClasses = () => getThemeClassList().split(/\s+/).filter(Boolean);

export class AspectsConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "originate-aspects-config",
        classes: ["originate-aspects-config"],
        tag: "form",
        position: {
            width: 1700,
            height: 1150
        },
        window: {
            title: "ORIGINATE.Aspects.Title",
            icon: "fas fa-palette",
            resizable: true
        },
        form: {
            handler: AspectsConfigApp.prototype._onSubmit,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            activateTab: AspectsConfigApp.prototype._onActivateTab,
            chooseTheme: AspectsConfigApp.prototype._onChooseTheme,
            chooseFont: AspectsConfigApp.prototype._onChooseFont,
            choosePreviewMode: AspectsConfigApp.prototype._onChoosePreviewMode,
            browseFile: AspectsConfigApp.prototype._onBrowseFile,
            addCustomFont: AspectsConfigApp.prototype._onAddCustomFont,
            removeCustomFont: AspectsConfigApp.prototype._onRemoveCustomFont
        }
    };

    static PARTS = {
        main: {
            template: "modules/character-forge/templates/aspects-config.hbs"
        }
    };

    constructor(options = {}) {
        super(options);
        acquireForgeStyles(this).catch(error => console.warn('Character Forge | Не удалось загрузить стили внешнего вида:', error));
        const visualTheme = game.settings.get('character-forge', 'visualTheme');
        this._activeSettingsTab = getThemePanel(visualTheme) ? 'theme' : 'general';
        this._previewMode = getThemePreview(visualTheme)?.defaultMode || 'start';
        this._previewState = {};
        this._previewKey = null;
        this._previewHandle = null;
        this._themePanelHandle = null;
        this._previewScale = 1;
    }

    async _prepareContext() {
        const visualTheme = game.settings.get('character-forge', 'visualTheme');
        const panelDef = getThemePanel(visualTheme);
        const availableFonts = FontLoader.getAvailableFonts();

        return {
            visualTheme,
            startPageBackground: game.settings.get('character-forge', 'startPageBackground'),
            detailsPageBackground: game.settings.get('character-forge', 'detailsPageBackground'),
            welcomeMessage: game.settings.get('character-forge', 'welcomeMessage'),
            welcomeMessageFont: game.settings.get('character-forge', 'welcomeMessageFont') || "Cinzel",
            themeChoices: getThemeChoices(),
            fontChoices: Object.fromEntries(availableFonts.map(font => [font, font])),
            customFonts: game.settings.get('character-forge', 'customFonts') || [],
            activeSettingsTab: this._activeSettingsTab,
            themePanel: panelDef
                ? { label: game.i18n?.localize(panelDef.label) ?? panelDef.label }
                : null
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this._resizeObserver?.disconnect();
        cleanupWindowScaling(this._windowScaleObserver);
        this._destroyThemePanel();
        this._destroyPreview();

        const root = this.element;

        root.querySelectorAll(
            'input[name="startPageBackground"], input[name="detailsPageBackground"]'
        ).forEach(input => input.addEventListener('change', () => this._refreshPreview()));

        root.querySelector('input[name="welcomeMessage"]')
            ?.addEventListener('input', () => this._refreshPreview());

        this._syncThemePanel();
        this._refreshPreview();
        this._refreshScale();

        const preview = root.querySelector('.aspects-preview');
        if (preview) {
            this._resizeObserver = new ResizeObserver(() => this._refreshScale());
            this._resizeObserver.observe(preview);
        }

        this._windowScaleObserver = applyWindowScaling(root, 1700, 1100);
    }

    async close(options = {}) {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this._destroyThemePanel();
        this._destroyPreview();
        cleanupWindowScaling(this._windowScaleObserver);
        this._windowScaleObserver = null;
        const result = await super.close(options);
        releaseForgeStyles(this);
        return result;
    }

    _onActivateTab(_event, target) {
        this._activateTab(target.dataset.tab);
    }

    _activateTab(tab) {
        const root = this.element;
        if (!root) return;

        this._activeSettingsTab = tab;
        root.querySelectorAll('.aspects-tab').forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tab);
        });
        root.querySelectorAll('.aspects-pane').forEach(pane => {
            pane.classList.toggle('active', pane.dataset.pane === tab);
        });
    }

    _onChooseTheme(_event, target) {
        const visualTheme = target.dataset.value;
        if (!visualTheme) return;

        this.element.querySelectorAll('.theme-option').forEach(button => {
            button.classList.toggle('active', button === target);
        });
        this.element.elements.visualTheme.value = visualTheme;

        // 主题带专属页时直接把玩家带过去，避免切完主题还要猜下一步在哪。
        this._activeSettingsTab = getThemePanel(visualTheme) ? 'theme' : 'general';
        this._previewState = {};
        this._previewMode = getThemePreview(visualTheme)?.defaultMode || 'start';
        this._syncThemePanel();
        this._refreshPreview();
    }

    _onChooseFont(_event, target) {
        const value = target.dataset.value;
        if (!value) return;

        this.element.querySelectorAll('.font-option').forEach(tile => {
            tile.classList.toggle('active', tile === target);
        });
        this.element.elements.welcomeMessageFont.value = value;
        this._refreshPreview();
    }

    _onChoosePreviewMode(_event, target) {
        const mode = target.dataset.mode;
        if (!mode || mode === this._previewMode) return;
        this._previewMode = mode;
        this._refreshPreview();
    }

    _onBrowseFile(_event, target) {
        const input = this.element.elements[target.dataset.target];
        if (!input) return;

        const FilePickerApp = foundry.applications.apps.FilePicker.implementation;
        new FilePickerApp({
            type: target.dataset.type || 'imagevideo',
            current: input.value || '',
            callback: path => {
                input.value = path;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }).render(true);
    }

    async _onAddCustomFont(event) {
        event.preventDefault();
        const FilePickerApp = foundry.applications.apps.FilePicker.implementation;

        new FilePickerApp({
            type: 'any',
            current: '',
            callback: async path => {
                const extension = path.split('.').pop()?.toLowerCase();
                if (!['ttf', 'otf', 'woff', 'woff2'].includes(extension)) {
                    ui.notifications.warn('Please select a font file (.ttf, .otf, .woff, .woff2)');
                    return;
                }

                const suggestedName = path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
                const familyName = await DialogV2.prompt({
                    window: {
                        title: game.i18n.localize('ORIGINATE.Settings.CustomFonts.Name')
                    },
                    content: `
                        <p>${game.i18n.localize('ORIGINATE.Settings.CustomFonts.NamePrompt')}</p>
                        <input type="text" name="familyName" value="${foundry.utils.escapeHTML(suggestedName)}">
                    `,
                    ok: {
                        label: game.i18n.localize('ORIGINATE.UI.Button.Confirm'),
                        callback: (_dialogEvent, button) => button.form?.elements?.familyName?.value?.trim() || ''
                    }
                });
                if (!familyName) return;

                const customFonts = foundry.utils.deepClone(
                    game.settings.get('character-forge', 'customFonts') || []
                );
                customFonts.push({ family: familyName, path });
                await game.settings.set('character-forge', 'customFonts', customFonts);
                FontLoader.loadCustomFonts();
                ui.notifications.info(game.i18n.format(
                    'ORIGINATE.Settings.CustomFonts.Added',
                    { name: familyName }
                ));
                this.render();
            }
        }).render(true);
    }

    async _onRemoveCustomFont(event, target) {
        event.preventDefault();
        const index = Number.parseInt(target.dataset.index, 10);
        const customFonts = foundry.utils.deepClone(
            game.settings.get('character-forge', 'customFonts') || []
        );
        const removed = customFonts.splice(index, 1);
        await game.settings.set('character-forge', 'customFonts', customFonts);
        FontLoader.loadCustomFonts();

        if (removed.length) {
            ui.notifications.info(game.i18n.format(
                'ORIGINATE.Settings.CustomFonts.Removed',
                { name: removed[0].family }
            ));
        }
        this.render();
    }

    _syncThemePanel() {
        const visualTheme = this.element.elements.visualTheme.value;
        const panelDef = getThemePanel(visualTheme);
        const tabButton = this.element.querySelector('.aspects-tab-theme');
        const mount = this.element.querySelector('.theme-panel-mount');

        this.element.classList.remove(...themeClasses());
        this.element.classList.add(`theme-${visualTheme}`);
        this._destroyThemePanel();
        if (mount) mount.replaceChildren();

        if (panelDef?.render && mount) {
            tabButton.hidden = false;
            tabButton.textContent = game.i18n?.localize(panelDef.label) ?? panelDef.label;
            this._themePanelHandle = panelDef.render(mount, {
                theme: visualTheme,
                refreshPreview: () => this._refreshPreview(),
                updatePreview: patch => this._updateThemePreview(patch),
                getPreviewMode: () => this._previewMode
            }) || null;
        } else {
            tabButton.hidden = true;
            this._activeSettingsTab = 'general';
        }
        this._activateTab(this._activeSettingsTab);
    }

    _destroyThemePanel() {
        if (this._themePanelHandle?.destroy) {
            try {
                this._themePanelHandle.destroy();
            } catch (error) {
                console.warn('Originate | 主题面板清理失败', error);
            }
        }
        this._themePanelHandle = null;
    }

    _updateThemePreview(patch = {}) {
        this._previewState = {
            ...this._previewState,
            ...foundry.utils.deepClone(patch)
        };
        this._refreshPreview();
    }

    _readPreviewSettings() {
        const form = this.element;
        return {
            visualTheme: form.elements.visualTheme.value,
            startPageBackground: form.elements.startPageBackground.value,
            detailsPageBackground: form.elements.detailsPageBackground.value,
            welcomeMessage: form.elements.welcomeMessage.value,
            welcomeMessageFont: form.elements.welcomeMessageFont.value
        };
    }

    _refreshPreview() {
        if (!this.element) return;

        const settings = this._readPreviewSettings();
        const previewDef = getThemePreview(settings.visualTheme);
        const modes = previewDef?.modes?.length ? previewDef.modes : DEFAULT_PREVIEW_MODES;
        if (!modes.some(mode => mode.id === this._previewMode)) {
            this._previewMode = previewDef?.defaultMode || modes[0].id;
        }

        this._renderPreviewButtons(modes);

        const stage = this.element.querySelector('#aspects-preview-stage');
        if (!stage) return;
        stage.classList.remove(...themeClasses());
        stage.classList.add(`theme-${settings.visualTheme}`);

        const previewKey = `${settings.visualTheme}:${this._previewMode}`;
        const payload = {
            theme: settings.visualTheme,
            mode: this._previewMode,
            settings,
            state: foundry.utils.deepClone(this._previewState),
            pixelRatio: Math.max(0.75, Math.min(window.devicePixelRatio * this._previewScale, 1.5))
        };

        if (previewKey !== this._previewKey) {
            this._destroyPreview();
            stage.replaceChildren();
            try {
                this._previewHandle = previewDef?.render
                    ? previewDef.render(stage, payload)
                    : this._renderDefaultPreview(stage, payload);
                this._previewKey = previewKey;
            } catch (error) {
                console.error('Originate | 主题预览挂载失败，已回退到通用预览', error);
                stage.replaceChildren();
                this._previewHandle = this._renderDefaultPreview(stage, payload);
                this._previewKey = previewKey;
            }
        } else {
            this._previewHandle?.update?.(payload);
        }

        this._refreshScale();
    }

    _renderPreviewButtons(modes) {
        const container = this.element.querySelector('.preview-mode-buttons');
        if (!container) return;

        const signature = modes.map(mode => `${mode.id}:${mode.label}:${mode.icon || ''}`).join('|');
        if (container.dataset.signature !== signature) {
            container.replaceChildren(...modes.map(mode => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'preview-mode-toggle';
                button.dataset.action = 'choosePreviewMode';
                button.dataset.mode = mode.id;

                if (mode.icon) {
                    const icon = document.createElement('i');
                    icon.className = mode.icon;
                    button.appendChild(icon);
                }
                button.append(document.createTextNode(
                    ` ${game.i18n?.localize(mode.label) ?? mode.label}`
                ));
                return button;
            }));
            container.dataset.signature = signature;
        }

        container.querySelectorAll('.preview-mode-toggle').forEach(button => {
            button.classList.toggle('active', button.dataset.mode === this._previewMode);
        });
    }

    _renderDefaultPreview(stage, payload) {
        const root = document.createElement('div');
        root.className = 'default-aspects-preview';
        root.innerHTML = `
            <div class="cinematic-background">
                <div class="preview-bg-container"></div>
                <div class="bg-overlay"></div>
            </div>
            <div class="cinematic-caption">
                <div class="caption-gradient"></div>
                <h1 class="welcome-title"></h1>
                <div class="preview-content"></div>
                <div class="start-btn-container">
                    <button class="start-btn" type="button"></button>
                </div>
            </div>
        `;
        stage.appendChild(root);

        const update = nextPayload => {
            const { settings, mode } = nextPayload;
            const background = mode === 'details'
                ? settings.detailsPageBackground
                : settings.startPageBackground;
            this._renderPreviewBackground(root.querySelector('.preview-bg-container'), background);

            const title = root.querySelector('.welcome-title');
            title.textContent = settings.welcomeMessage;
            title.style.fontFamily = `"${settings.welcomeMessageFont}", serif`;

            const content = root.querySelector('.preview-content');
            const start = root.querySelector('.start-btn-container');
            if (mode === 'details') {
                content.hidden = false;
                content.replaceChildren();
                const box = document.createElement('div');
                box.className = 'details-preview-placeholder';
                const heading = document.createElement('h2');
                heading.textContent = game.i18n.localize("ORIGINATE.Aspects.DetailsPreviewTitle");
                const hint = document.createElement('p');
                hint.textContent = game.i18n.localize("ORIGINATE.Aspects.DetailsPreviewHint");
                box.append(heading, hint);
                content.appendChild(box);
                start.hidden = true;
            } else {
                content.hidden = true;
                start.hidden = false;
                root.querySelector('.start-btn').textContent = game.i18n.localize(
                    "ORIGINATE.UI.Welcome.Start"
                );
            }
        };

        update(payload);
        return { update, destroy() { root.remove(); } };
    }

    _renderPreviewBackground(container, path) {
        container.replaceChildren();
        if (!path) {
            const placeholder = document.createElement('div');
            placeholder.className = 'bg-placeholder';
            container.appendChild(placeholder);
            return;
        }

        if (/\.(webm|mp4)(?:[?#].*)?$/i.test(path)) {
            const video = document.createElement('video');
            video.className = 'bg-video';
            video.autoplay = true;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.src = path;
            container.appendChild(video);
            return;
        }

        const image = document.createElement('img');
        image.className = 'bg-img';
        image.alt = 'Background';
        image.src = path;
        container.appendChild(image);
    }

    _destroyPreview() {
        if (this._previewHandle?.destroy) {
            try {
                this._previewHandle.destroy();
            } catch (error) {
                console.warn('Originate | 主题预览清理失败', error);
            }
        }
        this._previewHandle = null;
        this._previewKey = null;
    }

    _refreshScale() {
        const container = this.element?.querySelector('.aspects-preview');
        const stage = this.element?.querySelector('#aspects-preview-stage');
        if (!container || !stage) return;

        const headerHeight = this.element.querySelector('.preview-header')?.offsetHeight || 40;
        const scaleX = container.clientWidth / 1600;
        const scaleY = (container.clientHeight - headerHeight) / 900;
        const scale = Math.max(0.1, Math.min(scaleX, scaleY) * 0.95);
        stage.style.transform = `translate(-50%, -50%) scale(${scale})`;

        if (Math.abs(scale - this._previewScale) > 0.01) {
            this._previewScale = scale;
            this._previewHandle?.resize?.({
                scale,
                pixelRatio: Math.max(0.75, Math.min(window.devicePixelRatio * scale, 1.5))
            });
        }
    }

    async _onSubmit(_event, _form, formData) {
        let themeBlocked = false;
        for (const [key, value] of Object.entries(formData.object)) {
            if (key === 'visualTheme'
                && value !== game.settings.get('character-forge', 'visualTheme')
                && document.querySelector('#originate-char-gen, .originate-levelup-wizard')) {
                ui.notifications.warn(game.i18n.localize("ORIGINATE.Aspects.ThemeLockedWhileOpen"));
                themeBlocked = true;
                continue;
            }
            await game.settings.set('character-forge', key, value);
        }

        if (!themeBlocked) {
            ui.notifications.info(game.i18n.localize("ORIGINATE.Aspects.Saved"));
        }
    }
}
