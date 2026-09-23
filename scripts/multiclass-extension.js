/**
 * MulticlassExtension - 兼职系统扩展
 * 
 * Adrian: 这是一个独立的扩展模块，可通过设置开关启用/禁用。
 * 启用后，升级时会先显示职业选择界面，用户可以选择为哪个职业升级，
 * 或者添加一个全新的职业（兼职）。
 * 
 * 关闭设置 → 不加载此文件 → 升级行为完全不变。
 */

import { getThemeClassList } from './theme-registry.js';

export class MulticlassExtension {
    /**
     * @param {LevelUpApp} levelUpApp - 升级向导应用实例
     * @param {LevelUpManager} levelUpManager - 升级管理器实例
     * @param {DataManager} dataManager - 数据管理器实例
     */
    constructor(levelUpApp, levelUpManager, dataManager) {
        this.app = levelUpApp;
        this.manager = levelUpManager;
        this.dataManager = dataManager;
        this._showNewClassList = false;
    }

    // ========================================================================
    // 职业选择界面
    // ========================================================================

    /**
     * 渲染职业选择界面
     * 显示角色当前所有职业 + "添加新职业"按钮
     * @param {HTMLElement} container - 应用的根元素
     */
    async renderClassSelection(container) {
        const classes = this.manager.getActorClasses();
        const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';

        // 构建或获取 overlay
        let overlay = container.querySelector('.originate-progression-wizard');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = `originate-progression-wizard originate-sub-interface originate-container theme-${visualTheme}`;
            container.appendChild(overlay);
        } else {
            // 复用分支同样按注册表清一遍主题类再补当前主题——和其它 overlay 入口同一条规则
            overlay.classList.remove(...getThemeClassList().split(' '));
            overlay.classList.add(`theme-${visualTheme}`);
        }

        if (this._showNewClassList) {
            overlay.innerHTML = await this._renderNewClassList();
        } else {
            overlay.innerHTML = this._renderClassCards(classes);
        }

        this._bindEvents(overlay);
    }

    /**
     * 生成职业卡片 HTML
     * @param {Array<Item>} classes - 职业物品列表
     * @returns {string} HTML
     */
    _renderClassCards(classes) {
        const title = game.i18n.localize('ORIGINATE.LevelUp.SelectClass');
        const desc = game.i18n.localize('ORIGINATE.LevelUp.SelectClassDesc');

        const classCardsHtml = classes.map(cls => {
            const level = cls.system?.levels || 1;
            const levelLabel = game.i18n.format('ORIGINATE.LevelUp.CurrentLevel', { level });
            const img = cls.img || 'icons/svg/item-bag.svg';

            return `
                <div class="wizard-option-card multiclass-class-card" data-class-id="${cls.id}" 
                     style="flex-direction: column; padding: 2rem; min-width: 220px; cursor: pointer;">
                    <img src="${img}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid var(--originate-accent);">
                    <div class="feature-name" style="font-size: 1.3rem; margin-top: 0.8rem;">${cls.name}</div>
                    <div class="feature-desc" style="opacity: 0.7;">${levelLabel}</div>
                </div>
            `;
        }).join('');

        const addNewHtml = `
            <div class="wizard-option-card multiclass-add-new" 
                 style="flex-direction: column; padding: 2rem; min-width: 220px; cursor: pointer; border-style: dashed;">
                <div class="feature-icon-placeholder" style="font-size: 3rem; width: 80px; height: 80px;">
                    <i class="fas fa-plus"></i>
                </div>
                <div class="feature-name" style="font-size: 1.3rem; margin-top: 0.8rem;">
                    ${game.i18n.localize('ORIGINATE.LevelUp.AddNewClass')}
                </div>
                <div class="feature-desc" style="opacity: 0.7;">
                    ${game.i18n.localize('ORIGINATE.LevelUp.AddNewClassDesc')}
                </div>
            </div>
        `;

        return `
            <div class="sub-interface-header">
                <h2>${title}</h2>
                <div class="step-indicator" style="opacity: 0.7;">${desc}</div>
            </div>
            <div class="sub-interface-content" style="display: flex; justify-content: center; align-items: center;">
                <div style="display: flex; flex-wrap: wrap; gap: 2rem; justify-content: center; padding: 2rem;">
                    ${classCardsHtml}
                    ${addNewHtml}
                </div>
            </div>
        `;
    }

    // ========================================================================
    // 新职业选择列表
    // ========================================================================

    /**
     * 生成新职业列表 HTML
     * @returns {Promise<string>} HTML
     */
    async _renderNewClassList() {
        const title = game.i18n.localize('ORIGINATE.LevelUp.SelectNewClass');
        const backLabel = game.i18n.localize('ORIGINATE.LevelUp.BackToClasses');

        // 获取所有可用职业
        let allClasses = [];
        try {
            allClasses = await this.dataManager.getOptions('class');
        } catch (e) {
            console.error("Originate | [Multiclass] 获取职业列表失败:", e);
        }

        // 过滤掉已拥有的职业
        const ownedIdentifiers = new Set();
        for (const cls of this.manager.getActorClasses()) {
            const id = cls.system?.identifier;
            if (id) ownedIdentifiers.add(id);
        }

        const availableClasses = allClasses.filter(cls => {
            // 通过 identifier 或名称去重
            if (cls.identifier && ownedIdentifiers.has(cls.identifier)) return false;
            return true;
        });

        const searchPlaceholder = game.i18n.localize('ORIGINATE.UI.GridSelector.Search') || 'Search...';

        const cardsHtml = availableClasses.map(cls => {
            const img = cls.img || 'icons/svg/item-bag.svg';
            return `
                <div class="wizard-option-card multiclass-new-class-card" data-uuid="${cls.uuid}" data-name="${(cls.name || '').toLowerCase()}"
                     style="flex-direction: column; padding: 1.5rem; min-width: 180px; cursor: pointer;">
                    <img src="${img}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; border: 2px solid var(--originate-accent);">
                    <div class="feature-name" style="font-size: 1.1rem; margin-top: 0.6rem;">${cls.name}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="sub-interface-header">
                <h2>${title}</h2>
                <div style="margin-top: 0.5rem;">
                    <button type="button" class="multiclass-back-btn" style="background: transparent; border: 1px solid rgba(255,255,255,0.2); color: inherit; padding: 0.4rem 1rem; cursor: pointer; border-radius: 4px;">
                        <i class="fas fa-arrow-left"></i> ${backLabel}
                    </button>
                </div>
            </div>
            <div class="sub-interface-content" style="display: flex; flex-direction: column; align-items: center; overflow-y: auto;">
                <div style="width: 100%; max-width: 500px; padding: 0.5rem 2rem;">
                    <div style="position: relative;">
                        <i class="fas fa-search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: 0.5;"></i>
                        <input type="text" class="multiclass-search" placeholder="${searchPlaceholder}" autocomplete="off"
                               style="width: 100%; padding: 0.6rem 0.6rem 0.6rem 2rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: inherit; border-radius: 4px; font-size: 1rem;">
                    </div>
                </div>
                <div class="multiclass-new-class-grid" style="display: flex; flex-wrap: wrap; gap: 1.5rem; justify-content: center; padding: 1rem 2rem 2rem;">
                    ${availableClasses.length > 0 ? cardsHtml : `<p style="opacity: 0.5;">${game.i18n.localize('ORIGINATE.UI.Progression.NoFeatsAvailable')}</p>`}
                </div>
            </div>
        `;
    }

    // ========================================================================
    // 事件绑定
    // ========================================================================

    /**
     * 绑定所有事件
     * @param {HTMLElement} overlay - wizard overlay 元素
     */
    _bindEvents(overlay) {
        // 现有职业卡片点击 → 选择该职业升级
        overlay.querySelectorAll('.multiclass-class-card').forEach(card => {
            card.addEventListener('click', async () => {
                const classItemId = card.dataset.classId;
                window.OriginateLog(`Originate | [Multiclass] 用户选择升级职业: ${classItemId}`);
                this.manager.setTargetClass(classItemId);
                // 更新 targetLevel：必须基于新选中职业的实际等级
                this.app._state.targetLevel = this.manager.currentLevel + 1;
                this.app._state.isMulticlassNewClass = false;
                window.OriginateLog(`Originate | [Multiclass] 目标等级更新为: ${this.app._state.targetLevel}`);
                await this.app._onClassSelected();
            });
        });

        // "添加新职业"按钮
        const addNewBtn = overlay.querySelector('.multiclass-add-new');
        if (addNewBtn) {
            addNewBtn.addEventListener('click', async () => {
                window.OriginateLog('Originate | [Multiclass] 用户点击添加新职业');
                this._showNewClassList = true;
                await this.renderClassSelection(overlay.parentElement);
            });
        }

        // 返回按钮
        const backBtn = overlay.querySelector('.multiclass-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', async () => {
                this._showNewClassList = false;
                await this.renderClassSelection(overlay.parentElement);
            });
        }

        // 新职业卡片点击 → 添加新职业
        overlay.querySelectorAll('.multiclass-new-class-card').forEach(card => {
            card.addEventListener('click', async () => {
                const classUuid = card.dataset.uuid;
                window.OriginateLog(`Originate | [Multiclass] 用户选择新职业: ${classUuid}`);
                await this._addNewClass(classUuid);
            });
        });

        // 搜索框
        const searchInput = overlay.querySelector('.multiclass-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase().trim();
                overlay.querySelectorAll('.multiclass-new-class-card').forEach(card => {
                    const name = card.dataset.name || '';
                    card.style.display = (!query || name.includes(query)) ? '' : 'none';
                });
            });
            searchInput.focus();
        }
    }

    // ========================================================================
    // 添加新职业
    // ========================================================================

    /**
     * 添加新职业到 Actor 并开始升级
     * @param {string} classUuid - Compendium 中职业的 UUID
     */
    async _addNewClass(classUuid) {
        try {
            // 加载职业文档
            const classDoc = await fromUuid(classUuid);
            if (!classDoc) {
                console.error(`Originate | [Multiclass] 无法加载职业: ${classUuid}`);
                ui.notifications.error("Failed to load class");
                return;
            }

            const classData = classDoc.toObject();
            classData.system.levels = 1;

            const classResolutionInput = this.manager.createInitialClassResolutionInput({
                classData,
                sourceUuid: classUuid,
                multiclassed: true,
                hitPointMode: 'avg'
            });
            const { createdItem: created } = await this.manager.applyInitialClassResolutionInput(classResolutionInput);

            window.OriginateLog(`Originate | [Multiclass] 成功添加新职业: ${created.name} (id: ${created.id})`);
            ui.notifications.info(game.i18n.format('ORIGINATE.LevelUp.ClassAdded', { name: created.name }));

            // 设置为目标职业并继续
            this.manager.setTargetClass(created.id);

            // 更新 state 中的 targetLevel 为新职业的等级（即 1）
            // 但 LevelUpApp 的 targetLevel 是基于旧职业 currentLevel + 1 的
            // 新职业是 level 1，所以 features 应该查 level 1
            this.app._state.targetLevel = 1;
            this.app._state.isMulticlassNewClass = true;

            await this.app._onClassSelected();

        } catch (e) {
            console.error("Originate | [Multiclass] 添加新职业失败:", e);
            ui.notifications.error("Failed to add new class: " + e.message);
        }
    }
}
