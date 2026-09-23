import { DETAIL_STEPS } from '../shared/character-creation-settings.js';

export const NavigationMixin = (Base) => class extends Base {
    async _onNextStep(event, target) {
        // 检查是否可以继续
        // Adrian: 本来我是想强制你们选完的，但既然有人抱怨太严格，那就加个弹窗吧。
        // 自由是有了，但代价是可能会造出一个缺胳膊少腿的角色。
        let canProceed = true;
        let warningMessage = "";

        // 等级步骤特殊检查
        // 数学不好的人在这里会很痛苦
        if (this.currentStep === 'level') {
            // 验证等级配置
            if (this.context.levelConfig.isMulticlass) {
                // 检查总等级是否匹配
                // 1 + 1 = 2，这么简单的道理，希望用户能懂
                const totalAssigned = this.context.levelConfig.classes.reduce((sum, c) => sum + c.level, 0);
                if (totalAssigned !== this.context.levelConfig.totalLevel) {
                    canProceed = false;
                    warningMessage = `已分配等级 (${totalAssigned}) 不等于总等级 (${this.context.levelConfig.totalLevel})。`;
                }
                // 检查是否选择了主职业
                // 总得有个带头的吧？
                else if (!this.context.levelConfig.classes.some(c => c.isPrimary)) {
                    canProceed = false;
                    warningMessage = game.i18n.localize("ORIGINATE.UI.Level.SelectPrimaryClass");
                }
            }
        } else {
            // 属性步骤特殊检查
            if (this.currentStep === 'abilities') {
                const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';
                if (abilityMode === 'standardArray' && !this._rollState?.assignmentComplete) {
                    ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Abilities.StandardArray.Incomplete'));
                    return false;
                }
                if (abilityMode === 'roll') {
                    const rollMode = game.settings.get('character-forge', 'rollMode') || 'free';
                    // 检查是否有投掷记录
                    if (!this._rollState?.history?.length) {
                        canProceed = false;
                        warningMessage = game.i18n.localize('ORIGINATE.UI.Abilities.Roll.NoRolls');
                    }
                    // 自由分配模式检查是否完成分配
                    else if (rollMode === 'free' && !this._rollState?.assignmentComplete) {
                        canProceed = false;
                        warningMessage = game.i18n.localize('ORIGINATE.UI.Abilities.Roll.IncompleteAssignment');
                    }
                }
            }

            // 其他步骤检查是否已完成选择
            // 这些步骤存的是草稿或派生数据，可以留空，不应该挡住继续流程。
            const detailSteps = [...DETAIL_STEPS, 'asiBonus'];
            if (!detailSteps.includes(this.currentStep) && !this.context[this.currentStep]) {
                canProceed = false;
                warningMessage = game.i18n.localize("ORIGINATE.UI.Navigation.IncompleteStep");
            }
        }

        // 如果检查未通过，弹出确认框
        if (!canProceed) {
            const confirmed = await this._showConfirmDialog({
                title: game.i18n.localize("ORIGINATE.UI.Navigation.ConfirmTitle"),
                content: `<p>${warningMessage}</p><p>${game.i18n.localize("ORIGINATE.UI.Navigation.ConfirmWarning")}</p>`,
                yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm"),
                noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel"),
                defaultYes: false
            });

            // 如果用户怂了（取消），那就停在这里
            if (!confirmed) return false;
        }

        this._syncCurrentCreationPageDraft?.();
        const leavingLevelStep = this.currentStep === 'level';

        if (leavingLevelStep) {
            const advanced = await this._advanceCreationMainStep();
            if (advanced) this._beginCreationTimeline?.();
            return advanced;
        }

        if (this._creationTimeline?.active) {
            return this._runCreationTimelineForward(() => this._advanceCreationMainStep());
        }

        return this._advanceCreationMainStep();
    }

    async _advanceCreationMainStep() {
        // 使用动态步骤列表
        const steps = this._getActiveSteps();
        const idx = steps.indexOf(this.currentStep);

        if (idx === -1) return false;

        if (idx < steps.length - 1) {
            let nextStep = steps[idx + 1];

            // Adrian: asiBonus 步骤自动跳过逻辑
            // 如果没有来自种族/背景的属性加成，就别浪费用户时间了
            if (nextStep === 'asiBonus' && (!this.context.deferredASIs || this.context.deferredASIs.length === 0)) {
                const asiIdx = steps.indexOf('asiBonus');
                if (asiIdx < steps.length - 1) {
                    nextStep = steps[asiIdx + 1];
                }
            }

            await this._animateTransition(() => {
                this.currentStep = nextStep;
                this._scrollPos = 0; // 重置滚动位置，新的一页，新的开始
                this._currentFolder = null; // 退出文件夹，别迷路了
                this._resetLeftDrawerState();
            });
            return true;
        } else {
            // 最后一步完成后，检查是否有待处理的专精事件
            // 就像吃完饭后的甜点，虽然有时候是苦的
            if (this.blueprintData.pendingExpertise && this.blueprintData.pendingExpertise.length > 0) {
                window.OriginateLog("Originate | 进入专精结算步骤。最后的冲刺！");
                await this._renderExpertiseStep();
                this._freezeCreationTimeline?.();
                return true;
            }

            // 执行完成逻辑
            // 终于解脱了
            await this._onFinish();
            this._freezeCreationTimeline?.();
            return true;
        }
    }

    async _onPrevStep(event, target) {
        if (this._creationTimeline?.phase === 'frozen') return false;

        if (this._creationTimeline?.active) {
            return this._goBackCreationTimeline?.();
        }

        // 使用动态步骤列表
        // 后悔药在这里
        const steps = this._getActiveSteps();
        const idx = steps.indexOf(this.currentStep);
        if (idx > 0) {
            let prevStep = steps[idx - 1];

            // Adrian: asiBonus 步骤自动跳过逻辑（向后导航）
            if (prevStep === 'asiBonus' && (!this.context.deferredASIs || this.context.deferredASIs.length === 0)) {
                const asiIdx = steps.indexOf('asiBonus');
                if (asiIdx > 0) {
                    prevStep = steps[asiIdx - 1];
                }
            }

            await this._animateTransition(() => {
                this.currentStep = prevStep;
                this._scrollPos = 0;
                this._currentFolder = null;
                this._resetLeftDrawerState();
            });
            return true;
        }
        return false;
    }

    async _animateTransition(callback) {
        // 加点特效，让用户觉得这软件很高级
        const container = this.element?.[0]?.querySelector('.originate-container');

        // 播放翻页音效
        this._playSound('PAGE_FLIP');

        if (container) {
            container.classList.add('fade-out');
            await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (callback) callback();
        await this.render();
    }

    async _onSelectOption(event, target) {
        const id = target.dataset.id;
        await this._selectOptionById(id);
    }

    async _selectOptionById(id) {
        const type = this.currentStep;
        const previousId = this.context[type];
        this._syncLeftDrawerStateFromDom();

        // 保存当前滚动位置，防止重新渲染时重置
        // 用户体验细节，虽然他们可能根本注意不到
        const navTrack = this.element.querySelector('.nav-track');
        if (navTrack) {
            this._scrollPos = navTrack.scrollLeft;
        }

        const options = await this.dataManager.getOptions(type, this.context, this._currentFolder);
        const option = options.find(o => o.id === id);

        if (!option) return;

        if (option.type === 'folder') {
            // 进入文件夹，就像爱丽丝掉进兔子洞
            this._currentFolder = id;
            this._scrollPos = 0;
            this.render();
        } else {
            // 选中选项
            this.context[type] = id;
            this.context[`${type}Name`] = option.name;
            this._leftDrawerSwitching = type !== 'subclass' && !!this._leftDrawerExpanded && !!previousId && previousId !== id;
            try {
                await this.render();
            } finally {
                this._leftDrawerSwitching = false;
            }

            // 如果是子职步骤，选中后自动渲染详情
            // 省得用户再点一次，我真是太贴心了
            if (type === 'subclass') {
                await this._renderSubclassSelection(option);
            }
        }
    }

    _onToggleLeftDrawer(event, target) {
        const drawer = target?.closest?.('.left-sidebar-drawer');
        if (!drawer || drawer.classList.contains('hidden')) return;

        const shouldExpand = drawer.classList.contains('collapsed');
        this._leftDrawerExpanded = shouldExpand;
        this._leftDrawerSwitching = false;
        drawer.classList.toggle('collapsed', !shouldExpand);
        drawer.classList.remove('switching');
    }

    _syncLeftDrawerStateFromDom() {
        const drawer = this.element?.querySelector?.('.left-sidebar-drawer');
        if (!drawer || drawer.classList.contains('hidden')) return;
        this._leftDrawerExpanded = !drawer.classList.contains('collapsed');
    }

    _resetLeftDrawerState() {
        this._leftDrawerExpanded = false;
        this._leftDrawerSwitching = false;
    }

    async _onPrevOption(event, target) {
        await this._navigateOption(-1);
    }

    async _onNextOption(event, target) {
        await this._navigateOption(1);
    }

    async _navigateOption(direction) {
        // 左右横跳
        const type = this.currentStep;
        const options = await this.dataManager.getOptions(type, this.context, this._currentFolder);
        if (options.length === 0) return;

        const currentId = this.context[type];
        let currentIndex = options.findIndex(o => o.id === currentId);

        if (currentIndex === -1) {
            currentIndex = 0;
        } else {
            currentIndex += direction;
        }

        // 循环导航，转圈圈
        if (currentIndex < 0) currentIndex = options.length - 1;
        if (currentIndex >= options.length) currentIndex = 0;

        const nextOption = options[currentIndex];
        await this._selectOptionById(nextOption.id);
    }

    async _onNavigateUp(event, target) {
        // 返回上一级文件夹
        // 爬出兔子洞
        if (!this._currentFolder) return;

        const sourcePacks = game.settings.get('character-forge', 'sourcePacks');
        const packIds = sourcePacks[this.currentStep] || [];
        if (packIds.length === 0) return;
        const pack = game.packs.get(packIds[0]);
        if (!pack) return;

        const currentFolderObj = pack.folders.get(this._currentFolder);

        if (currentFolderObj && currentFolderObj.folder) {
            this._currentFolder = currentFolderObj.folder._id || currentFolderObj.folder;
        } else {
            this._currentFolder = null;
        }

        this._scrollPos = 0;
        this.render();
    }

    // ================================================================
    // 网格选择器面板
    // Adrian: 选项太多的时候底部那个小横条根本不够用，
    // 所以搞了个大面板出来，带搜索带筛选，高端大气上档次。
    // ================================================================

    /** 抽屉动画时长（ms），与 CSS transition 0.4s 保持同步 */
    static DRAWER_TRANSITION_MS = 400;
    /** cinematic-nav 的 CSS bottom 值 */
    static NAV_BOTTOM_OFFSET = 30;

    /**
     * 打开网格选择器面板（抽屉模式：从导航栏向上展开）
     */
    async _onOpenGridSelector(event, target, { skipAnimation = false } = {}) {
        const root = this.element?.querySelector('.view-selection-root');
        if (!root) return;
        const nav = root.querySelector('.cinematic-nav');
        if (!nav) return;

        // 如果已打开则切换关闭
        if (nav.querySelector('.grid-selector-drawer')) {
            this._closeGridSelector();
            return;
        }

        // 获取当前步骤的所有选项
        const type = this.currentStep;
        const options = await this.dataManager.getOptions(type, this.context, this._currentFolder);
        if (!options || options.length === 0) return;

        // 来源筛选看的是包 ID，不看本地化合集名；这样和 Foundry 侧栏的来源标记对得上。
        const sourceMap = new Map();
        for (const opt of options) {
            if (opt.type === 'folder') continue;
            const sourceId = this._extractSourceId(opt);
            if (!sourceMap.has(sourceId)) sourceMap.set(sourceId, []);
            sourceMap.get(sourceId).push(opt);
        }

        const currentSelectedId = this.context[type];
        const allLabel = game.i18n.localize('ORIGINATE.UI.GridSelector.All');
        const searchPlaceholder = game.i18n.localize('ORIGINATE.UI.GridSelector.Search');

        // 筛选标签
        const sourceIds = [...sourceMap.keys()];
        let filtersHtml = `<button class="grid-filter-tag active" data-source="__all__">${allLabel}</button>`;
        for (const sourceId of sourceIds) {
            filtersHtml += `<button class="grid-filter-tag" data-source="${sourceId}">${sourceId} (${sourceMap.get(sourceId).length})</button>`;
        }

        // 卡片
        const nonFolderOptions = options.filter(o => o.type !== 'folder');
        let cardsHtml = '';
        for (const opt of nonFolderOptions) {
            const optSource = this._extractSourceId(opt);
            const isSelected = opt.id === currentSelectedId;
            const localizedName = game.i18n.has(opt.name) ? game.i18n.localize(opt.name) : opt.name;
            cardsHtml += `
                <div class="grid-selector-card ${isSelected ? 'selected' : ''}" 
                     data-id="${opt.id}" data-source="${optSource}" data-name="${localizedName.toLowerCase()}">
                    <div class="grid-card-icon">
                        ${opt.img ? `<img src="${opt.img}" alt="">` : `<i class="fas fa-question"></i>`}
                    </div>
                    <div class="grid-card-name">${localizedName}</div>
                </div>
            `;
        }

        const drawerHtml = `
            <div class="grid-selector-drawer">
                <div class="grid-selector-header">
                    <div class="grid-selector-search-wrapper">
                        <i class="fas fa-search"></i>
                        <input type="text" class="grid-selector-search" placeholder="${searchPlaceholder}" autocomplete="off">
                    </div>
                    <button type="button" class="grid-selector-close"><i class="fas fa-chevron-down"></i></button>
                </div>
                <div class="grid-selector-filters">${filtersHtml}</div>
                <div class="grid-selector-grid">${cardsHtml}</div>
            </div>
        `;

        // 插入抽屉到 nav-track 之前
        const navTrack = nav.querySelector('.nav-track');
        navTrack.insertAdjacentHTML('beforebegin', drawerHtml);

        // 给 cinematic-nav 添加抽屉展开类
        nav.classList.add('drawer-open');

        // 动画
        const drawer = nav.querySelector('.grid-selector-drawer');
        if (skipAnimation) {
            drawer.style.transition = 'none';
            drawer.classList.add('open');
            requestAnimationFrame(() => { drawer.style.transition = ''; });
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => { drawer.classList.add('open'); });
            });
        }

        // 绑定事件
        this._bindGridSelectorEvents(nav);

        // 动态上浮文字介绍
        const caption = root.querySelector('.cinematic-caption');
        if (caption) {
            const drawerHeight = this._getGridSelectorVisibleHeight(drawer);
            const navTrackHeight = navTrack.offsetHeight;
            const { NAV_BOTTOM_OFFSET } = this.constructor;
            const targetBottom = NAV_BOTTOM_OFFSET + navTrackHeight + drawerHeight + 15;
            caption.style.transition = `bottom ${this.constructor.DRAWER_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
            caption.style.bottom = `${targetBottom}px`;
            // 过渡结束后清理 inline style
            caption.addEventListener('transitionend', () => {
                caption.style.transition = '';
            }, { once: true });
        }
    }

    /**
     * 从选项 UUID 中提取来源包 ID。
     */
    _extractSourceId(opt) {
        const explicitPackId = typeof opt?.packId === 'string' ? opt.packId.trim() : '';
        if (explicitPackId && !explicitPackId.includes('.')) return explicitPackId;
        const source = explicitPackId || opt?.uuid || opt?.id || '';
        const match = source.match(/^(?:Compendium\.)?([^.]+)\.([^.]+)/);
        if (match) return this._getSourcePackageId(`${match[1]}.${match[2]}`, match[1]);
        return globalThis.game?.i18n?.localize?.('ORIGINATE.UI.GridSelector.Other') || 'Other';
    }

    _getSourcePackageId(collectionId, fallbackId) {
        const pack = globalThis.game?.packs?.get?.(collectionId);
        return pack?.metadata?.packageName
            || pack?.metadata?.package
            || pack?.metadata?.packageId
            || fallbackId
            || collectionId;
    }

    _getGridSelectorVisibleHeight(drawer) {
        const viewportHeight = globalThis.innerHeight || globalThis.window?.innerHeight || 0;
        const viewportHalf = Math.floor(viewportHeight * 0.5);
        const contentHeight = drawer?.scrollHeight || 0;
        if (!viewportHalf) return contentHeight;
        return Math.min(contentHeight, viewportHalf);
    }

    /**
     * 绑定网格选择器面板的事件
     */
    _bindGridSelectorEvents(nav) {
        const drawer = nav.querySelector('.grid-selector-drawer');
        if (!drawer) return;

        // 关闭按钮
        drawer.querySelector('.grid-selector-close')?.addEventListener('click', () => {
            this._closeGridSelector();
        });

        // 搜索
        const searchInput = drawer.querySelector('.grid-selector-search');
        searchInput?.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            const activeFilter = drawer.querySelector('.grid-filter-tag.active')?.dataset.source || '__all__';
            this._filterGridCards(drawer, query, activeFilter);
        });
        searchInput?.focus();

        // 合集包筛选标签
        drawer.querySelectorAll('.grid-filter-tag').forEach(tag => {
            tag.addEventListener('click', () => {
                drawer.querySelectorAll('.grid-filter-tag').forEach(t => t.classList.remove('active'));
                tag.classList.add('active');
                const query = searchInput?.value?.toLowerCase().trim() || '';
                this._filterGridCards(drawer, query, tag.dataset.source);
            });
        });

        // 卡片点击
        drawer.querySelectorAll('.grid-selector-card').forEach(card => {
            card.addEventListener('click', async () => {
                const id = card.dataset.id;
                drawer.querySelectorAll('.grid-selector-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this._gridSelectorKeepOpen = true;
                await this._selectOptionById(id);
            });
        });

        // ESC 关闭
        this._gridSelectorEscHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._closeGridSelector();
            }
        };
        document.addEventListener('keydown', this._gridSelectorEscHandler, { capture: true });
    }

    /**
     * 筛选网格卡片
     */
    _filterGridCards(container, query, sourceFilter) {
        container.querySelectorAll('.grid-selector-card').forEach(card => {
            const name = card.dataset.name || '';
            const source = card.dataset.source || '';
            const matchesSearch = !query || name.includes(query);
            const matchesSource = sourceFilter === '__all__' || source === sourceFilter;
            card.style.display = (matchesSearch && matchesSource) ? '' : 'none';
        });
    }

    /**
     * 关闭网格选择器抽屉
     */
    _closeGridSelector() {
        const root = this.element?.querySelector('.view-selection-root');
        if (!root) return;
        const nav = root.querySelector('.cinematic-nav');
        if (!nav) return;

        const drawer = nav.querySelector('.grid-selector-drawer');
        if (!drawer) return;

        // 关闭动画
        drawer.classList.remove('open');

        // 清理事件
        if (this._gridSelectorEscHandler) {
            document.removeEventListener('keydown', this._gridSelectorEscHandler, { capture: true });
            this._gridSelectorEscHandler = null;
        }

        // 等动画结束后移除 DOM 和类
        const ms = this.constructor.DRAWER_TRANSITION_MS;
        setTimeout(() => {
            drawer.remove();
            nav.classList.remove('drawer-open');
        }, ms);

        // 文字介绍平滑回落
        const caption = root.querySelector('.cinematic-caption');
        if (caption) {
            caption.style.transition = `bottom ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
            caption.style.bottom = '';
            caption.addEventListener('transitionend', () => {
                caption.style.transition = '';
            }, { once: true });
        }
    }
};

