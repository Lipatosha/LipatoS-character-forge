const DEFAULT_PORTRAIT = 'icons/svg/mystery-man.svg';

export const DetailsMixin = (Base) => class extends Base {

    /**
     * 准备详情页面的上下文数据
     */
    async _prepareContext(options) {
        const context = await super._prepareContext(options);

        // 确保 details 对象存在
        if (!this.context.details) {
            this.context.details = {};
        }

        // 绑定数据到上下文，方便模板访问
        context.details = this.context.details;

        // 根据当前步骤准备特定数据
        if (this.currentStep === 'alignment') {
            // 准备阵营数据
            // Adrian: 九宫格阵营，经典的 D&D 设定。
            // 使用 ORIGINATE 的翻译键，确保显示全称
            context.alignments = [
                { key: 'lg', label: "ORIGINATE.Alignment.LG" }, { key: 'ng', label: "ORIGINATE.Alignment.NG" }, { key: 'cg', label: "ORIGINATE.Alignment.CG" },
                { key: 'ln', label: "ORIGINATE.Alignment.LN" }, { key: 'tn', label: "ORIGINATE.Alignment.TN" }, { key: 'cn', label: "ORIGINATE.Alignment.CN" },
                { key: 'le', label: "ORIGINATE.Alignment.LE" }, { key: 'ne', label: "ORIGINATE.Alignment.NE" }, { key: 'ce', label: "ORIGINATE.Alignment.CE" }
            ].map(a => ({
                key: a.key,
                label: game.i18n.localize(a.label),
                active: this.context.details.alignment === a.key
            }));
        }

        if (this.currentStep === 'biography') {
            // 传记编辑器配置
            // Adrian: 我们现在用简单的 textarea，不需要 enrichHTML 了
            // 之前的 TextEditor.enrichHTML 在新版 Foundry 中被弃用了
            context.biographyHTML = this.context.details.biography || "";
        }

        if (this.currentStep === 'portrait') {
            context.portraitPreview = this._getPortraitPreviewPath();
            context.hasPortrait = !!this.context.details.portrait;
        }

        // 添加步骤标记，方便模板判断
        // Adrian: 虽然 context-mixin 已经做了一些，但为了保险起见（而且我有点强迫症），这里再明确一下
        context.isNameStep = this.currentStep === 'name';
        context.isAlignmentStep = this.currentStep === 'alignment';
        context.isAppearanceStep = this.currentStep === 'appearance';
        context.isPersonalityStep = this.currentStep === 'personality';
        context.isPortraitStep = this.currentStep === 'portrait';
        context.isBiographyStep = this.currentStep === 'biography';

        context.canContinueName = !!String(this.context.details?.name || '').trim();
        context.canContinueAlignment = !!String(this.context.details?.alignment || '').trim();
        context.canContinuePortrait = !!String(this.context.details?.portrait || '').trim();

        return context;
    }

    /**
     * 绑定详情页面的事件监听器
     */
    _bindDetailsEvents() {
        // 通用输入框更新. Для обязательных полей состояние «Далее»
        // должно меняться сразу при вводе, а не только после потери фокуса.
        this.element.querySelectorAll('.detail-input').forEach(input => {
            input.addEventListener('change', (e) => this._onUpdateDetail(e));
            input.addEventListener('input', (e) => this._onUpdateDetail(e));
        });

        this.element.querySelectorAll('.portrait-path-input').forEach(input => {
            input.addEventListener('input', (e) => this._onUpdateDetail(e));
        });

        // 阵营选择按钮
        this.element.querySelectorAll('.alignment-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this._onSelectAlignment(e));
        });

        // 专门处理传记编辑器（如果是 textarea）
        const bioInput = this.element.querySelector('.biography-input');
        if (bioInput) {
            bioInput.addEventListener('change', (e) => this._onUpdateDetail(e));
        }

        this.element.querySelectorAll('.portrait-picker-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this._onPickPortrait(e));
        });

        this.element.querySelectorAll('.portrait-clear-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this._onClearPortrait(e));
        });
    }

    /**
     * 处理详情字段更新
     */
    _onUpdateDetail(event) {
        event.preventDefault();
        const field = event.target.dataset.field || event.target.name;
        const value = event.target.value;

        if (field) {
            this.context.details[field] = value;
            // Adrian: 这种小改动就不用重新渲染整个页面了，太浪费资源
            // 除非是某些关联 UI 的变动...不过这里应该没有
            if (field === 'portrait') {
                this._syncPortraitPreview(value);
            }
            this._updateDetailStepNavigationState();
        }
    }

    _updateDetailStepNavigationState() {
        const button = this.element?.querySelector?.('.step-footer .nav-btn.next-btn');
        if (!button) return;

        let complete = true;
        if (this.currentStep === 'name') {
            complete = !!String(this.context.details?.name || '').trim();
        } else if (this.currentStep === 'alignment') {
            complete = !!String(this.context.details?.alignment || '').trim();
        } else if (this.currentStep === 'portrait') {
            complete = !!String(this.context.details?.portrait || '').trim();
        }

        button.disabled = !complete;
    }

    _getPortraitPreviewPath() {
        return this.context.details?.portrait || this.actor?.img || DEFAULT_PORTRAIT;
    }

    _setPortraitPath(path) {
        const normalizedPath = String(path || '').trim();
        if (!this.context.details) this.context.details = {};
        this.context.details.portrait = normalizedPath;

        const input = this.element?.querySelector?.('.portrait-path-input');
        if (input) input.value = normalizedPath;

        this._syncPortraitPreview(normalizedPath);
        this._updateDetailStepNavigationState();
    }

    _syncPortraitPreview(path = '') {
        const previewPath = String(path || '').trim() || this.actor?.img || DEFAULT_PORTRAIT;
        const img = this.element?.querySelector?.('.portrait-preview-img');
        if (img) img.setAttribute('src', previewPath);

        const frame = this.element?.querySelector?.('.portrait-preview-frame');
        if (frame) frame.classList.toggle('has-portrait', !!String(path || '').trim());

        const clearBtn = this.element?.querySelector?.('.portrait-clear-btn');
        if (clearBtn) clearBtn.disabled = !String(path || '').trim();
    }

    _getFilePickerClass() {
        return globalThis.foundry?.applications?.apps?.FilePicker?.implementation
            || globalThis.foundry?.applications?.api?.FilePicker
            || globalThis.FilePicker
            || null;
    }

    _getApplicationRoot() {
        const element = this.element;
        if (!element) return document.getElementById('originate-char-gen');
        if (element.id === 'originate-char-gen') return element;
        if (typeof element.closest === 'function') {
            return element.closest('#originate-char-gen') || document.getElementById('originate-char-gen');
        }
        return document.getElementById('originate-char-gen');
    }

    _restoreExternalPickerLayer() {
        const state = this._externalPickerLayerState;
        if (!state || state.restored) return;

        state.restored = true;
        const { root, zIndex, zIndexPriority, pointerEvents, pointerEventsPriority } = state;
        if (zIndex) root.style.setProperty('z-index', zIndex, zIndexPriority || '');
        else root.style.removeProperty('z-index');
        if (pointerEvents) root.style.setProperty('pointer-events', pointerEvents, pointerEventsPriority || '');
        else root.style.removeProperty('pointer-events');
        root.classList.remove('originate-external-picker-open');
        this._externalPickerLayerState = null;
    }

    _withExternalPickerLayer(filePicker) {
        const root = this._getApplicationRoot();
        if (!root) return () => {};

        if (!this._externalPickerLayerState) {
            this._externalPickerLayerState = {
                root,
                zIndex: root.style.getPropertyValue('z-index'),
                zIndexPriority: root.style.getPropertyPriority('z-index'),
                pointerEvents: root.style.getPropertyValue('pointer-events'),
                pointerEventsPriority: root.style.getPropertyPriority('pointer-events'),
                restored: false
            };

            // 这里故意让 Originate 退一层。OV 接管 FilePicker 时会另开窗口，
            // 如果我们还钉在 10000，上面的素材库就可能被全屏创角界面吃掉。
            root.classList.add('originate-external-picker-open');
            root.style.setProperty('z-index', '1', 'important');
            root.style.setProperty('pointer-events', 'none', 'important');
        }

        const restore = () => this._restoreExternalPickerLayer();
        if (filePicker && typeof filePicker.close === 'function' && !filePicker._originateLayerClosePatched) {
            const originalClose = filePicker.close.bind(filePicker);
            filePicker.close = (...args) => {
                restore();
                return originalClose(...args);
            };
            filePicker._originateLayerClosePatched = true;
        }

        return restore;
    }

    async _onPickPortrait(event) {
        event.preventDefault();
        const FilePickerClass = this._getFilePickerClass();
        if (!FilePickerClass) {
            ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Portrait.FilePickerUnavailable'));
            return;
        }

        let restoreLayer = () => {};
        try {
            const current = this.context.details?.portrait || this.actor?.img || '';
            const picker = new FilePickerClass({
                type: 'image',
                current,
                callback: (path) => {
                    this._setPortraitPath(path);
                    restoreLayer();
                }
            });

            restoreLayer = this._withExternalPickerLayer(picker);
            await picker.render(true);
        } catch (error) {
            restoreLayer();
            console.warn('Originate | 打开角色立绘 FilePicker 失败:', error);
            ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Portrait.FilePickerFailed'));
        }
    }

    _onClearPortrait(event) {
        event.preventDefault();
        this._setPortraitPath('');
    }

    /**
     * 处理阵营选择
     */
    _onSelectAlignment(event) {
        event.preventDefault();
        const btn = event.currentTarget;
        const alignment = btn.dataset.key;

        // 更新数据
        this.context.details.alignment = alignment;

        // 更新 UI 选中状态
        this.element.querySelectorAll('.alignment-btn').forEach(b => {
            b.classList.toggle('selected', b.dataset.key === alignment);
        });
        this._updateDetailStepNavigationState();
    }

    /**
     * 激活富文本编辑器
     * Adrian: 如果我们要用 TinyMCE，得在渲染后手动激活它
     */
    async _activateEditors(html) {
        if (super._activateEditors) await super._activateEditors(html);

        // 如果在传记页，激活编辑器
        if (this.currentStep === 'biography') {
            // 这里的 'biography' 对应模板中 editor helper 的 target
            // 但在向导模式下，直接由 FormApplication 处理可能有点问题，因为我们不是标准的 FormApplication 提交流程
            // 不过我们可以手动处理 save
        }
    }
    async _onNextStep(event) {
        // 如果离开传记页，保存传记内容
        // Adrian: textarea 比较老实，直接从 data-field 找就行
        if (this.currentStep === 'biography') {
            const bioTextarea = this.element.querySelector('.biography-textarea');
            if (bioTextarea) {
                this.context.details.biography = bioTextarea.value;
            }
        }

        await super._onNextStep(event);
    }
};

