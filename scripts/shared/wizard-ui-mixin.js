/**
 * WizardUIMixin - 创角 progression 与真实升级共用的步骤 UI
 *
 * 这里共享的是 step → HTML、草稿同步、控件事件和完成度检查，不共享流程生命周期：
 *   - ProgressionMixin 在新角色蓝图里逐级展开，最后通过 CharacterFinalizeService 一次性写入 Actor。
 *   - LevelUpApp 读取现有 Actor，只处理本次升级的 pending state，最后交给 LevelUpManager 写入。
 *
 * 因此“最后一步之后做什么”必须留在各自宿主的 _onProgressionNext()，不要收进这个类。
 * 两边长得像，不代表能共用状态、回退规则或最终提交。
 *
 * 职责：
 *   - 向导步骤内容渲染（HP/特性/ASI/法术/特质/子职选择）
 *   - 法术浏览器完整 UI（搜索/过滤/选择/拖放）
 *   - 法术替换 UI
 *   - 各步骤的事件绑定与验证
 * 
 * 宿主类约定（通过 prototype descriptors 混入，宿主必须提供）：
 *   - this._state                            ← ProgressionMixin / LevelUpApp — 当前步骤/等级状态
 *   - this._getCurrentAbilityValue(ab)       ← ProgressionMixin / LevelUpApp — 获取属性当前值
 *   - this._getConstitutionModifier()        ← ProgressionMixin / LevelUpApp — 获取体质调整值
 *   - this._getObtainedItemNames()           ← ProgressionMixin / LevelUpApp — 已获得物品名集合
 *   - this._getObtainedItemUuids()           ← ProgressionMixin / LevelUpApp — 已获得物品 UUID 集合
 *   - this._getKnownTraits()                 ← ProgressionMixin / LevelUpApp — 已知特质集合
 *   - this._onProgressionNext()              ← ProgressionMixin / LevelUpApp — 下一步回调
 *   - this._onProgressionPrev()              ← ProgressionMixin / LevelUpApp — 上一步回调
 *   - this._currentStepComplete              ← ProgressionMixin / LevelUpApp — 当前步骤是否完成
 *   - this._showConfirmDialog()              ← UIMixin — 确认弹窗
 *   - this._bindTooltips()                   ← UIMixin — 物品 tooltip
 *   - this._expandWildcardPool()             ← 来自 progression-renderer.js
 *   - this._getTraitLabel()                  ← 来自 progression-renderer.js
 *   - this.dataManager                       ← app.js / LevelUpApp — 数据加载
 *   - this.actor                             ← Foundry — 目标 Actor
 *   - this.levelUpManager                    ← LevelUpApp 专用 — 升级管理器
 * 
 * 提供方法（被 ProgressionMixin / LevelUpApp 调用）：
 *   - this._renderCurrentStep()              → 渲染当前向导步骤
 *   - this._renderStepContent()              → 渲染步骤内容（switch on step.type）
 *   - this._renderSpellChoice()              → 法术选择浏览器
 *   - this._renderSpellReplacement()         → 法术替换界面
 *   - this._renderPreparedSpellGrant()       → 准备型法术授予
 *   - this._renderItemChoice()               → 物品选择
 *   - this._renderTraitChoice()              → 特质选择
 *   - this._renderASIFeatChoice()            → ASI/专长选择
 *   - this._renderSubclassSelection()        → 子职选择
 *   - this._bindProgressionEvents()          → 步骤通用事件绑定
 *   - this._bindSpellBrowserEvents()         → 法术浏览器事件
 *   - this._bindSpellReplacementEvents()     → 法术替换事件
 *   - this._checkProgressionCanProceed()     → 检查能否前进到下一步
 */


import {
    bindSubclassSelectionPanel,
    renderSubclassSelectionPanel
} from './progression-renderer.js';
import { getThemeClassList } from '../theme-registry.js';
import { SpellRules } from '../spell-rules.js';
import { collectWeaponProficiencyKeys } from './advancement-rule-utils.js';
import { resolveItemSourceUuid } from './resolution-core.js';
import {
    buildSpellBrowserSearchRestriction,
    getSpellClassesForSpell,
    normalizeSpellListId,
    normalizeSpellListIds,
    spellClassSetMatchesAny
} from './spell-list-filters.js';
import { getClassPrimaryAbilityKey } from '../mapping.js';
import { filterSpellSchoolOptions, findInvalidSpellSchoolSelections, getSpellRestriction, matchesSpellSchool, normalizeSpellSchools, spellSchoolHint } from './spell-school-restrictions.js';
import { isAvailableSpellLevel } from './advancement-choice-rules.js';
import {
    getAverageHitPointIncrease,
    isHitPointRollLocked,
    resolveHitPointChoice
} from './hit-point-choice.js';

import { catalogText, getRequiredLevel, isPlayerFeat, meetsLevelRequirement, normalizePrerequisites, toCatalogEntry } from './feat-catalog.js';
import { createFeatBrowser, renderFeatBrowser, bindFeatBrowser, escapeCatalogHTML } from './feat-catalog-browser.js';

export class WizardUIMixin {
    _getFeatSelectionLevel(level) {
        // 升级向导的 level 是职业等级；普通专长要求的是本次升级后的角色总等级。
        if (!this.levelUpManager) return Math.max(1, Number(level) || 1);
        const total = Number(this.actor?.system?.details?.level) || Number(this.levelUpManager.currentLevel) || 1;
        return Math.max(1, total - Number(this.levelUpManager.currentLevel || 1) + Number(level || 1));
    }

    _isFeatDraftAvailable(stepId, uuid) {
        const model = this._featBrowsers?.get(stepId);
        return !!uuid && !!model?.entries.some(feat => feat.uuid === uuid && !feat.locked);
    }

    _getActorFeatPrerequisiteKeys() {
        const keys = new Set();
        const addItem = item => {
            if (!item) return;
            const identifier = String(item.system?.identifier || '').trim();
            if (!identifier) return;

            keys.add(identifier);
            if (item.type) keys.add(`${item.type}:${identifier}`);
            const featureType = String(item.system?.type?.value || '').trim();
            if (featureType) keys.add(`${featureType}:${identifier}`);
        };

        for (const item of Array.from(this.actor?.items || [])) addItem(item);
        for (const pending of this._state?.pendingItems || []) addItem(pending?.itemData);
        return keys;
    }

    _featMatchesActorPrerequisites(feat) {
        const rawItems = feat?.system?.prerequisites?.items ?? feat?.prerequisites?.items;
        let required = [];
        if (rawItems instanceof Set || Array.isArray(rawItems)) {
            required = Array.from(rawItems);
        } else if (rawItems && typeof rawItems?.[Symbol.iterator] === 'function') {
            required = Array.from(rawItems);
        } else if (rawItems && typeof rawItems === 'object') {
            required = Object.values(rawItems);
        }
        required = required.map(value => String(value || '').trim()).filter(Boolean);

        if (!required.length) return true;

        const owned = this._getActorFeatPrerequisiteKeys();
        return required.some(value => {
            const key = String(value || '').trim();
            if (!key) return false;
            if (owned.has(key)) return true;

            const short = key.includes(':') ? key.split(':').at(-1) : key;
            return owned.has(short);
        });
    }

    async _prepareFeatOptions(level, names, uuids) {
        const selectionLevel = this._getFeatSelectionLevel(level);
        const options = await this.dataManager.getOptions('feat', {}, { indexOnly: true });
        return options
            .filter(feat =>
                isPlayerFeat(feat)
                && meetsLevelRequirement(feat, selectionLevel)
                && this._featMatchesActorPrerequisites(feat)
            )
            .map(feat => {
                const selectedCount = this._getFeatAlreadySelectedCount(feat, names, uuids);
                const repeatable = this._isRepeatableFeatOption(feat);
                return toCatalogEntry({
                    ...normalizePrerequisites(feat),
                    repeatable,
                    selectedCount,
                    isSelected: selectedCount > 0,
                    locked: selectedCount > 0 && !repeatable
                });
            });
    }

    _renderFeatSelection(feats, level, savedChoice, stepId) {
        this._featBrowserFilters ??= new Map();
        this._featBrowsers ??= new Map();

        const e = escapeCatalogHTML;
        const query = String(this._featBrowserFilters.get(stepId)?.query || '');
        const model = createFeatBrowser(feats, {
            filters: { query },
            selected: savedChoice?.uuid ? [savedChoice.uuid] : [],
            level: this._getFeatSelectionLevel(level)
        });
        this._featBrowsers.set(stepId, model);

        const cards = model.entries.map(feat => {
            const locked = !!feat.locked;
            const selected = savedChoice?.uuid === feat.uuid;
            const hint = locked
                ? game.i18n.localize('ORIGINATE.UI.CannotSelectAgain')
                : catalogText('RequiredLevel', { level: getRequiredLevel(feat) || 1 });
            const searchText = [
                feat.name,
                feat.categoryLabel,
                feat.source,
                feat.packLabel,
                feat.requirements
            ].filter(Boolean).join(' ').toLocaleLowerCase();

            return `
                <label class="option-card feat-option simple-feat-option${locked ? ' disabled selected-previously' : ''}${feat.repeatable ? ' repeatable-feat' : ''}${selected ? ' selected' : ''}"
                    data-feat-uuid="${e(feat.uuid)}"
                    data-feat-search="${e(searchText)}">
                    <input type="radio"
                        name="feat-choice-${level}"
                        value="${e(feat.uuid)}"
                        data-feat-uuid="${e(feat.uuid)}"
                        ${selected ? 'checked' : ''}
                        ${locked ? 'disabled' : ''}>
                    <img src="${e(feat.img)}" class="feature-icon" loading="lazy" alt="">
                    <div class="feature-info">
                        <div class="feature-name">${e(feat.name)}</div>
                        <div class="feature-desc">${e(hint)}${feat.categoryLabel ? ` · ${e(feat.categoryLabel)}` : ''}</div>
                        ${this._renderRepeatableFeatHint(feat)}
                    </div>
                </label>
            `;
        }).join('');

        return `
            <div class="levelup-feat-choice-layout">
                <section class="levelup-feat-browser-pane">
                    <div class="simple-feat-browser" data-simple-feat-browser="${e(stepId)}">
                        <div class="simple-feat-search">
                            <i class="fas fa-search" aria-hidden="true"></i>
                            <input type="search"
                                data-simple-feat-search
                                value="${e(query)}"
                                placeholder="${e(catalogText('SearchPlaceholder'))}"
                                aria-label="${e(catalogText('SearchPlaceholder'))}"
                                autocomplete="off">
                            <button type="button" data-simple-feat-clear
                                aria-label="${e(catalogText('ClearSearch'))}"
                                ${query ? '' : 'hidden'}>
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                        <div class="simple-feat-list" data-simple-feat-list>
                            ${cards}
                        </div>
                        <p class="feat-search-empty" data-simple-feat-empty hidden>${e(catalogText('Empty'))}</p>
                    </div>
                </section>
                <aside class="levelup-feat-preview" data-feat-preview>
                    <div class="levelup-feat-preview-placeholder">
                        <i class="fas fa-star"></i>
                        <h3>${game.i18n.localize('ORIGINATE.FeatCatalog.PreviewTitle')}</h3>
                        <p>${game.i18n.localize('ORIGINATE.FeatCatalog.PreviewHint')}</p>
                    </div>
                </aside>
            </div>
        `;
    }

    async _showFeatPreview(root, uuid) {
        const preview = root?.closest('.levelup-feat-choice-layout')?.querySelector('[data-feat-preview]');
        if (!preview || !uuid) return;

        const token = String(foundry.utils.randomID?.(8) || Date.now());
        preview.dataset.previewToken = token;
        preview.innerHTML = `
            <div class="levelup-feat-preview-loading">
                <i class="fas fa-spinner fa-spin"></i>
                ${game.i18n.localize('ORIGINATE.UI.Loading')}
            </div>
        `;

        try {
            const doc = this.dataManager?.getDocument
                ? await this.dataManager.getDocument(uuid)
                : await fromUuid(uuid);
            if (!doc || preview.dataset.previewToken !== token) return;

            const raw = doc.system?.description?.value || '';
            let description = raw;
            try {
                const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
                if (TE?.enrichHTML) {
                    description = await TE.enrichHTML(String(raw), { async: true, relativeTo: doc });
                }
            } catch {
                description = raw;
            }

            if (preview.dataset.previewToken !== token) return;

            const requirement = doc.system?.requirements || '';
            preview.innerHTML = `
                <div class="levelup-feat-preview-header">
                    <img src="${escapeCatalogHTML(doc.img || 'icons/svg/item-bag.svg')}" alt="">
                    <div>
                        <h3>${escapeCatalogHTML(doc.name || '')}</h3>
                        ${requirement ? `<div class="levelup-feat-preview-requirement">${escapeCatalogHTML(requirement)}</div>` : ''}
                    </div>
                </div>
                <div class="levelup-feat-preview-body">
                    ${description || `<p class="levelup-feat-preview-empty">${game.i18n.localize('ORIGINATE.UI.Details.NoDescription')}</p>`}
                </div>
            `;
        } catch (error) {
            if (preview.dataset.previewToken !== token) return;
            preview.innerHTML = `<p class="levelup-feat-preview-empty">${game.i18n.localize('ORIGINATE.UI.Details.NoDescription')}</p>`;
        }
    }

    _getCurrentClassPrimaryAbilityKey() {
        const classItem = this.levelUpManager?.classItem
            || Array.from(this.actor?.items || []).find(item => item?.type === 'class');
        return getClassPrimaryAbilityKey(classItem);
    }

    _getPrimaryAbilityCardClass(ability) {
        return this._getCurrentClassPrimaryAbilityKey() === ability ? ' primary-ability' : '';
    }

    _isBrokenDisplayValue(value) {
        if (this.dataManager?._isBrokenDisplayValue instanceof Function) {
            return this.dataManager._isBrokenDisplayValue(value);
        }

        if (value === null || value === undefined) return true;
        if (typeof value !== 'string') return false;

        const text = value.trim().toLowerCase();
        if (!text || text === 'null' || text === 'undefined') return true;

        // 第三方包有时会把 pool 项先命名成 Unnamed Item，真正的名字要靠 UUID 回源。
        return ['unnamed item', '未命名条目'].includes(text);
    }

    _bindFeatSearch(overlay) {
        overlay.querySelectorAll('[data-simple-feat-browser]').forEach(root => {
            if (root.dataset.simpleFeatBound === 'true') return;
            root.dataset.simpleFeatBound = 'true';

            const key = root.dataset.simpleFeatBrowser;
            const input = root.querySelector('[data-simple-feat-search]');
            const clear = root.querySelector('[data-simple-feat-clear]');
            const empty = root.querySelector('[data-simple-feat-empty]');
            const cards = () => Array.from(root.querySelectorAll('.simple-feat-option'));

            const applySearch = () => {
                const query = String(input?.value || '').trim().toLocaleLowerCase();
                let visible = 0;
                for (const card of cards()) {
                    const matches = !query || String(card.dataset.featSearch || '').includes(query);
                    card.hidden = !matches;
                    if (matches) visible++;
                }
                if (clear) clear.hidden = !query;
                if (empty) empty.hidden = visible > 0;
                this._featBrowserFilters.set(key, { query });
            };

            input?.addEventListener('input', applySearch);
            clear?.addEventListener('click', event => {
                event.preventDefault();
                if (!input) return;
                input.value = '';
                input.focus();
                applySearch();
            });

            const showPreview = event => {
                const card = event.target?.closest?.('.simple-feat-option[data-feat-uuid]');
                if (!card || !root.contains(card)) return;
                void this._showFeatPreview(root, card.dataset.featUuid);
            };

            root.addEventListener('click', showPreview);
            root.addEventListener('pointerover', event => {
                const card = event.target?.closest?.('.simple-feat-option[data-feat-uuid]');
                if (!card || !root.contains(card)) return;
                if (event.relatedTarget && card.contains(event.relatedTarget)) return;
                void this._showFeatPreview(root, card.dataset.featUuid);
            });

            root.addEventListener('change', event => {
                const inputEl = event.target;
                if (!inputEl.matches?.('input[name^="feat-choice-"]')) return;
                for (const card of cards()) {
                    card.classList.toggle('selected', !!card.querySelector('input:checked'));
                }
                const selectedCard = inputEl.closest('.simple-feat-option');
                if (selectedCard?.dataset.featUuid) {
                    void this._showFeatPreview(root, selectedCard.dataset.featUuid);
                }
            });

            applySearch();

            const selected = root.querySelector('.simple-feat-option input:checked')?.closest('.simple-feat-option');
            if (selected?.dataset.featUuid) void this._showFeatPreview(root, selected.dataset.featUuid);
        });
    }

    _isRepeatableFeatOption(option = {}) {
        return !!(
            option.repeatable
            || option.prerequisites?.repeatable
            || option.system?.repeatable
            || option.system?.prerequisites?.repeatable
        );
    }

    _getFeatAlreadySelectedCount(feat, selectedFeatNameCounts = new Map(), selectedFeatUuidCounts = new Map()) {
        const nameCount = feat?.name ? (selectedFeatNameCounts.get(feat.name) || 0) : 0;
        const uuidCount = feat?.uuid ? (selectedFeatUuidCounts.get(feat.uuid) || 0) : 0;
        return Math.max(nameCount, uuidCount);
    }

    _renderRepeatableFeatHint(feat) {
        if (!this._isRepeatableFeatOption(feat)) return '';

        const selectedCount = Number(feat.selectedCount || 0);
        const countText = selectedCount > 0
            ? ` · ${game.i18n.format('ORIGINATE.UI.RepeatableCount', { count: selectedCount })}`
            : '';
        return `<div class="feat-repeatable-hint"><i class="fas fa-redo"></i> ${game.i18n.localize('ORIGINATE.UI.Repeatable')}${countText}</div>`;
    }

    async _renderCurrentStep() {
        const state = this._state;
        const currentStep = state.steps[state.currentStepIndex];

        if (!currentStep) {
            console.error("Originate | [LevelUp] 无效的步骤索引:", state.currentStepIndex);
            return;
        }

        // 检查上一步是否为 ASI/专长选择（禁止返回，不然会很麻烦，不想处理这个了）
        const prevStep = state.steps[state.currentStepIndex - 1];
        const isPrevStepFeat = prevStep && prevStep.type === 'asi_feat_choice';
        const disablePrev = state.currentStepIndex === 0 || isPrevStepFeat;
        const prevBtnTitle = isPrevStepFeat ? game.i18n.localize('ORIGINATE.UI.Progression.CannotGoBackFeat') : "";

        let overlay = this.element.querySelector('.originate-progression-wizard');
        if (!overlay) {
            overlay = document.createElement('div');
            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
            overlay.className = `originate-progression-wizard originate-sub-interface originate-container theme-${visualTheme}`;
            this.element.appendChild(overlay);
        } else {
            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
            overlay.classList.add('originate-container');
            // 清主题类走注册表：硬编码清单漏掉外部皮肤（比如 theme-cyberpunk），复用 overlay 会双主题共存
            overlay.classList.remove(...getThemeClassList().split(' '));
            overlay.classList.add(`theme-${visualTheme}`);
        }

        const isLast = state.currentStepIndex === state.steps.length - 1;

        overlay.innerHTML = `
        <div class="sub-interface-header">
            <h2>${game.i18n.format('ORIGINATE.UI.Progression.LevelUpTitle', { level: state.targetLevel })}</h2>
            <div class="step-indicator">
                ${game.i18n.format('ORIGINATE.UI.Step.IndicatorWithTitle', { current: state.currentStepIndex + 1, total: state.steps.length, title: currentStep.title })}
            </div>
            <div class="progression-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${((state.currentStepIndex + 1) / state.steps.length) * 100}%"></div>
                </div>
            </div>
        </div>
        <div class="sub-interface-content" id="progression-step-content">
        </div>
        <div class="sub-interface-footer">
            <button type="button" class="back-btn" id="progression-prev-btn" ${disablePrev ? 'disabled' : ''} title="${prevBtnTitle}">
                <i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.UI.Button.Back')}
            </button>
            <button type="button" class="confirm-btn" id="progression-next-btn" disabled>
                ${isLast ? game.i18n.localize('ORIGINATE.UI.Button.FinishCreation') : game.i18n.localize('ORIGINATE.UI.Button.Next')} <i class="fas fa-arrow-right"></i>
            </button>
        </div>
    `;

        const contentContainer = overlay.querySelector('#progression-step-content');
        contentContainer.innerHTML = await this._renderStepContent(currentStep);

        this._bindProgressionEvents(overlay, currentStep);
        this._autoSelectForcedItemChoices(overlay, currentStep);
        this._bindTooltips(overlay);
        this._checkProgressionCanProceed(overlay);
        this._refreshLevelupStatusDrawer?.();
    }

    _autoSelectForcedItemChoices(overlay, step) {
        if (!overlay || step?.type !== 'item_choice') return false;

        const section = overlay.querySelector('.item-choice-section[data-type="item-choice"]');
        if (!section || section.dataset.pureReplacement === 'true') return false;

        const required = Number.parseInt(section.dataset.count || step.event?.count || step.count || '0', 10);
        if (!Number.isFinite(required) || required <= 0) return false;

        const inputs = Array.from(section.querySelectorAll('.item-choices-list input[type="checkbox"][name^="item-choice-"]'))
            .filter(input => !input.disabled)
            .filter(input => input.closest('.option-card')?.getAttribute('aria-invalid') !== 'true');

        if (inputs.length !== required) return false;

        let changed = false;
        for (const input of inputs) {
            if (!input.checked) {
                input.checked = true;
                changed = true;
            }
            input.closest('.option-card')?.classList.add('selected');
        }

        if (changed) this._syncStepDraftFromOverlay?.(step, overlay);
        return changed;
    }

    // 共享步骤内容渲染。这里只读宿主状态，选择结果仍由各宿主自己的下一步回调保存。

    async _renderStepContent(step) {
        const state = this._state;
        const level = state.targetLevel;

        switch (step.type) {
            case 'hp': {
                const hitDie = this.levelUpManager.hitDie;
                const conMod = this._getConstitutionModifier();
                const avgHP = getAverageHitPointIncrease(hitDie, conMod);
                const savedHP = state.hpGain !== null
                    ? { hp: state.hpGain, method: state.hpMethod, rollResult: state.hpRollResult }
                    : null;
                const rollLocked = isHitPointRollLocked(savedHP);

                return `
                <div class="progression-hp-container">
                    <div class="hp-header">
                        <div class="hp-level-badge">LEVEL ${level}</div>
                        <h3>${game.i18n.localize('ORIGINATE.UI.Progression.HPTitle')}</h3>
                        <div class="hp-subtitle">${game.i18n.format('ORIGINATE.UI.Progression.HPSubtitle', { die: hitDie, mod: conMod })}</div>
                        ${this.levelUpManager ? `
                        <div class="hp-permanent-roll-warning">
                            <i class="fas fa-lock"></i>
                            <span>${game.i18n.localize('ORIGINATE.UI.Progression.HPRollPermanent')}</span>
                        </div>
                        ` : ''}
                    </div>
                    <div class="hp-roll-result-container hp-roll-result-above" style="display: ${savedHP?.method === 'roll' ? 'flex' : 'none'};">
                        <div class="hp-roll-animation"><i class="fas fa-dice-d20"></i></div>
                        <div class="hp-roll-text">
                            ${savedHP?.method === 'roll' ? game.i18n.format('ORIGINATE.UI.Progression.HPRollResult', { roll: savedHP.rollResult ?? savedHP.hp - conMod, mod: conMod, total: savedHP.hp }) : ''}
                        </div>
                    </div>
                    <div class="hp-options-wrapper ${rollLocked ? 'hp-options-wrapper--locked' : ''} ${this.levelUpManager ? 'hp-roll-only' : ''}">
                        <div class="hp-option-card ${savedHP?.method === 'average' ? 'selected' : ''}" data-method="average" data-hp="${avgHP}" aria-disabled="${rollLocked}">
                            <div class="hp-option-icon"><i class="fas fa-shield-alt"></i></div>
                            <div class="hp-option-title">${game.i18n.localize('ORIGINATE.UI.Progression.HPAverage')}</div>
                            <div class="hp-option-value">+${avgHP}</div>
                            <div class="hp-option-desc">${game.i18n.localize('ORIGINATE.UI.Progression.HPAverageDesc')}<br>${game.i18n.format('ORIGINATE.UI.Progression.HPAverageCalc', { avg: Math.floor(hitDie / 2) + 1, mod: conMod })}</div>
                            <div class="hp-selection-indicator"><i class="fas fa-check"></i></div>
                        </div>
                        <div class="hp-option-card ${savedHP?.method === 'roll' ? 'selected roll-locked' : ''}" data-method="roll" aria-disabled="${rollLocked}">
                            <div class="hp-option-icon"><i class="fas fa-dice-d20"></i></div>
                            <div class="hp-option-title">${game.i18n.localize('ORIGINATE.UI.Progression.HPRoll')}</div>
                            <div class="hp-option-value">1d${hitDie} + ${conMod}</div>
                            <div class="hp-option-desc">${game.i18n.localize('ORIGINATE.UI.Progression.HPRollDesc')}<br>${game.i18n.format('ORIGINATE.UI.Progression.HPRollRange', { min: 1 + conMod, max: hitDie + conMod })}</div>
                            <div class="hp-selection-indicator"><i class="fas fa-check"></i></div>
                        </div>
                    </div>
                </div>
            `;
            }

            case 'features': {
                const features = await Promise.all((step.items || []).map(async feature => {
                    let description = feature.description || feature.system?.description?.value || '';
                    let uuid = feature.uuid
                        || feature._sourceUuid
                        || resolveItemSourceUuid(feature)
                        || feature.flags?.core?.sourceId
                        || '';
                    let img = feature.img || 'icons/svg/item-bag.svg';
                    let name = feature.name || '';

                    if (uuid && (!description || !name || !img)) {
                        try {
                            const doc = this.dataManager?.getDocument
                                ? await this.dataManager.getDocument(uuid)
                                : await fromUuid(uuid);
                            if (doc) {
                                description ||= doc.system?.description?.value || '';
                                img ||= doc.img;
                                name ||= doc.name;
                            }
                        } catch {
                            // Карточка всё равно останется доступной по имеющимся данным.
                        }
                    }

                    return { ...feature, uuid, img, name, description };
                }));

                return `
                <div class="progression-feature-group page-wrapper">
                    <div class="options-container features-granted-list">
                        ${features.map(f => {
                            const tooltipText = f.description
                                ? (this._getFullCleanDescription?.(f.description) || this._cleanDescription(f.description))
                                : '';
                            return `
                            <div class="option-card progression-feature-item"
                                data-uuid="${f.uuid || ''}"
                                ${tooltipText ? `data-originate-tooltip="${escapeCatalogHTML(tooltipText)}"` : ''}>
                                <img src="${f.img || 'icons/svg/item-bag.svg'}" class="feature-icon">
                                <div class="feature-info">
                                    <div class="feature-name">${f.name}</div>
                                    ${f.description ? `<div class="feature-desc progression-feature-desc">${this._cleanDescription(f.description)}</div>` : ''}
                                </div>
                            </div>
                        `;
                        }).join('')}
                    </div>
                    <div class="selection-hint">${game.i18n.localize('ORIGINATE.UI.Progression.AutoAddHint')}</div>
                </div>
            `;
            }

            case 'asi_feat_choice':
                return await this._renderASIFeatChoice(step, level);

            case 'item_choice':
                return await this._renderItemChoice(step.event || step, level, step.stepType || 'class', step.id);

            case 'spell_choice':
                return await this._renderSpellChoice(step);

            case 'spell_replacement':
                return await this._renderSpellReplacement(step);

            case 'prepared_spell_grant':
                return await this._renderPreparedSpellGrant(step);

            case 'trait_choice':
                return this._renderTraitChoice(step.event || step, level, step.stepType || 'class', step.id);

            case 'subclass_selection':
                return await this._renderSubclassSelection(step, level);

            default:
                return `<p>${game.i18n.format('ORIGINATE.UI.Error.UnknownStepType', { type: step.type })}</p>`;
        }
    }

    // ASI/专长只共享显示和草稿；创角写 blueprint，升级写 pending state，这个边界别顺手合并。

    async _renderASIFeatChoice(step, level) {
        const state = this._state;
        const savedChoice = state.stepData[step.id];

        // 纯 ASI 模式（如专长内部的属性提升）
        if (step.asiOnly) {
            if (!state.stepData[step.id]) state.stepData[step.id] = { type: 'asi' };
        }

        const showASI = savedChoice?.type === 'asi' || step.asiOnly;
        const showFeat = savedChoice?.type === 'feat';
        const showSelection = !showASI && !showFeat;

        // 收集已选专长
        const selectedFeatNameCounts = new Map();
        const selectedFeatUuidCounts = new Map();
        const addSelectedFeatMark = ({ name = null, uuid = null } = {}) => {
            if (name) {
                selectedFeatNameCounts.set(name, (selectedFeatNameCounts.get(name) || 0) + 1);
            }
            if (uuid) {
                selectedFeatUuidCounts.set(uuid, (selectedFeatUuidCounts.get(uuid) || 0) + 1);
            }
        };

        for (const item of this.actor.items) {
            if (item.type === 'feat') {
                const sourceId = resolveItemSourceUuid(item);
                addSelectedFeatMark({ name: item.name, uuid: sourceId });
            }
        }
        if (state.selectedFeats) {
            state.selectedFeats.forEach(f => {
                if (f.sourceStepId === step.id) return;
                addSelectedFeatMark({ name: f.name, uuid: f.uuid });
            });
        }

        // 获取专长列表
        let eligibleFeats = [];
        try {
            if (!step.asiOnly) eligibleFeats = await this._prepareFeatOptions(level, selectedFeatNameCounts, selectedFeatUuidCounts);
        } catch (e) {
            console.error("Originate | [LevelUp] 获取专长列表失败:", e);
        }

        const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
        const abilityLabels = {
            str: game.i18n.localize('ORIGINATE.Ability.Str'), dex: game.i18n.localize('ORIGINATE.Ability.Dex'),
            con: game.i18n.localize('ORIGINATE.Ability.Con'), int: game.i18n.localize('ORIGINATE.Ability.Int'),
            wis: game.i18n.localize('ORIGINATE.Ability.Wis'), cha: game.i18n.localize('ORIGINATE.Ability.Cha')
        };
        const abilityIcons = {
            str: 'fa-fist-raised', dex: 'fa-running', con: 'fa-heart',
            int: 'fa-brain', wis: 'fa-eye', cha: 'fa-comments'
        };
        const abilityAbbrs = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
        const getModifier = (score) => Math.floor((score - 10) / 2);
        const formatMod = (mod) => mod >= 0 ? `+${mod}` : `${mod}`;

        const maxPoints = step.points !== undefined ? step.points : (step.asiOnly ? 0 : 2);

        return `
        <div class="progression-feature-group asi-or-feat-section page-wrapper" data-step-id="${step.id}">
            <!-- 初始选择界面 -->
            <div class="asi-feat-selection" style="display: ${showSelection ? 'flex' : 'none'}; gap: 2rem; justify-content: center;">
                <div class="wizard-option-card asi-feat-type-btn" data-type="asi" style="flex-direction: column; padding: 3rem; min-width: 300px;">
                    <div class="feature-icon-placeholder" style="font-size: 4rem; width: 100px; height: 100px;"><i class="fas fa-arrow-up"></i></div>
                    <div class="feature-name" style="font-size: 1.5rem;">${game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}</div>
                    <div class="feature-desc">${game.i18n.localize('ORIGINATE.ASI.ImproveAbilityDesc')}</div>
                </div>
                <div class="wizard-option-card asi-feat-type-btn" data-type="feat" style="flex-direction: column; padding: 3rem; min-width: 300px;">
                    <div class="feature-icon-placeholder" style="font-size: 4rem; width: 100px; height: 100px;"><i class="fas fa-star"></i></div>
                    <div class="feature-name" style="font-size: 1.5rem;">${game.i18n.localize('ORIGINATE.ASI.SelectFeat')}</div>
                    <div class="feature-desc">${game.i18n.localize('ORIGINATE.ASI.SelectFeatDesc')}</div>
                </div>
            </div>
            
            <!-- ASI 界面 -->
            <div class="asi-content" style="display: ${showASI ? 'block' : 'none'}; width: 100%;">
                ${!step.asiOnly ? `<button type="button" class="back-to-selection-btn" style="margin-bottom: 1rem;"><i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.ASI.BackToSelection')}</button>` : ''}
                <div class="sub-section asi-section" data-type="asi" data-points="${maxPoints}" data-cap="${step.cap || 2}" data-locked="${Array.from(step.locked || []).join(',')}">
                    <div class="asi-header">
                        <h3 class="asi-title">${game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}</h3>
                        ${maxPoints > 0 ?
                `<div class="asi-remaining">${game.i18n.localize('ORIGINATE.ASI.RemainingPoints')}: <span class="asi-points-remaining">${maxPoints}</span></div>` :
                `<div class="asi-remaining" style="color: #888;">${game.i18n.localize('ORIGINATE.UI.Fixed') || 'Fixed'}</div>`
            }
                    </div>
                    <div class="abilities-grid asi-grid">
                        ${abilities.map(ab => {
                const fixedValue = (step.fixed && step.fixed[ab]) || 0;
                const currentValue = this._getCurrentAbilityValue(ab) + fixedValue;
                const mod = getModifier(currentValue);
                const modFormatted = formatMod(mod);
                const modClass = mod > 0 ? 'positive' : (mod < 0 ? 'negative' : 'neutral');
                const isLocked = Array.from(step.locked || []).includes(ab);
                const primaryAbilityClass = this._getPrimaryAbilityCardClass(ab);
                return `
                                <div class="ability-card asi-card ${isLocked ? 'locked' : ''}${primaryAbilityClass}" data-ability="${ab}">
                                    <div class="ability-icon"><i class="fas ${abilityIcons[ab]}"></i></div>
                                    <div class="ability-name">${abilityLabels[ab]}</div>
                                    <div class="ability-abbr">${abilityAbbrs[ab]}</div>
                                    <div class="ability-current-value">${game.i18n.localize('ORIGINATE.ASI.CurrentValue')}: ${currentValue}</div>
                                    <div class="ability-value-wrapper asi-controls">
                                        <button type="button" class="ability-btn decrement asi-decrease" data-ability="${ab}" ${isLocked ? 'disabled' : ''}>
                                            <i class="fas fa-minus"></i>
                                        </button>
                                        <span class="asi-value ability-value-display" data-ability="${ab}">0</span>
                                        <button type="button" class="ability-btn increment asi-increase" data-ability="${ab}" ${isLocked ? 'disabled' : ''}>
                                            <i class="fas fa-plus"></i>
                                        </button>
                                    </div>
                                    <div class="ability-modifier ${modClass}" data-ability="${ab}">${modFormatted}</div>
                                    ${fixedValue > 0 ? `<div class="fixed-indicator" style="color: #4caf50; font-size: 0.8em; margin-top: 0.2rem;"><i class="fas fa-arrow-up"></i> +${fixedValue} (${game.i18n.localize('ORIGINATE.UI.Fixed')})</div>` : ''}
                                    ${isLocked ? `<div class="locked-indicator"><i class="fas fa-lock"></i> ${game.i18n.localize('ORIGINATE.ASI.Locked')}</div>` : ''}
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            </div>
            
            <!-- 专长界面 -->
            <div class="feat-content" style="display: ${showFeat ? 'block' : 'none'}; width: 100%;">
                <div class="feat-panel">
                    <div class="feat-panel-back">${!savedChoice?.uuid ? `<button type="button" class="back-to-selection-btn"><i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.ASI.BackToSelection')}</button>` : ''}</div>
                    ${this._renderFeatSelection(eligibleFeats, level, savedChoice, step.id)}
                </div>
            </div>
        </div>
    `;
    }

    // 共享物品选择渲染

    async _renderItemChoice(event, level, stepType, stepId = null) {
        // ⚠ 同步点：replacement → count 的兜底规则和 data-manager-v2.js _convertItemChoice() 里一致，改这里要一起改
        if (event.count === null || event.count === undefined) {
            event.count = (event.replacement ? 0 : 1);
        }

        const savedChoice = stepId ? this._getStepDraft(stepId) : null;
        const hasBrokenDisplayValue = (value) => this._isBrokenDisplayValue(value);
        const fallbackName = game.i18n.lang?.startsWith('zh') ? '未命名条目' : 'Unnamed Item';
        const fallbackImage = 'icons/svg/item-bag.svg';

        // === DEBUG: 追踪 ItemChoice 数据 ===
        console.log(`Originate | [ItemChoice DEBUG] _renderItemChoice called`, {
            title: event.title,
            poolLength: event.pool?.length,
            pool: event.pool,
            restriction: event.restriction,
            originalRestriction: event._original?.configuration?.restriction,
            originalPool: event._original?.configuration?.pool,
            count: event.count,
            replacement: event.replacement,
            allowDrops: event.allowDrops,
            level,
            stepType
        });

        // 确保池中的物品数据已加载（嵌套 ItemChoice 的 pool 可能只有 UUID）
        if (event.pool?.length > 0) {
            for (const opt of event.pool) {
                if ((hasBrokenDisplayValue(opt.name) || hasBrokenDisplayValue(opt.img)) && opt.uuid) {
                    try {
                        const doc = this.dataManager?.getDocument
                            ? await this.dataManager.getDocument(opt.uuid, hasBrokenDisplayValue(opt.name) ? null : opt.name)
                            : await fromUuid(opt.uuid);
                        if (doc) {
                            if (hasBrokenDisplayValue(opt.name)) opt.name = doc.name;
                            if (hasBrokenDisplayValue(opt.img)) opt.img = doc.img;
                            opt.type = doc.type;
                            opt.system = doc.system;
                        }
                    } catch (e) {
                        console.warn(`Originate | 无法加载 ItemChoice 池物品: ${opt.uuid}`, e);
                    }
                }

                if (hasBrokenDisplayValue(opt.name)) opt.name = fallbackName;
                if (hasBrokenDisplayValue(opt.img)) opt.img = fallbackImage;
            }
        }

        // 动态池：如果 pool 为空但有 restriction，从合集包中查询匹配物品
        const hasRestriction = !!(event.restriction || event._original?.configuration?.restriction);
        const poolEmpty = !event.pool || event.pool.length === 0;
        console.log(`Originate | [ItemChoice DEBUG] 动态池检查: poolEmpty=${poolEmpty}, hasRestriction=${hasRestriction}`);

        if (poolEmpty && hasRestriction) {
            const restriction = event.restriction || event._original?.configuration?.restriction;
            // configuration.type 是 Item.type 过滤（如 'feat'），与 restriction.type（system.type.value）不同
            const itemType = event._original?.configuration?.type || null;
            console.log(`Originate | [ItemChoice DEBUG] 开始动态查询, restriction:`, restriction, `itemType:`, itemType);
            const dynamicItems = await this.dataManager.getItemsByRestriction(restriction, itemType, this._getFeatSelectionLevel(level));
            console.log(`Originate | [ItemChoice DEBUG] 动态查询结果: ${dynamicItems.length} 个物品`);
            if (dynamicItems.length > 0) {
                event.pool = dynamicItems;
            }
        }

        if (this.dataManager?.normalizeChoiceOption) {
            event.pool = await Promise.all((event.pool || []).map(item => this.dataManager.normalizeChoiceOption(item)));
        }
        const obtainedNames = this._getObtainedItemNames();
        const obtainedUuids = this._getObtainedItemUuids();

        const schoolPool = await filterSpellSchoolOptions(event.pool, getSpellRestriction(event), uuid => fromUuid(uuid),
            savedChoice?.selectedUuids || (savedChoice?.selectedUuid ? [savedChoice.selectedUuid] : []));
        const availablePool = schoolPool.filter(opt => {
            const choiceLevel = opt.system?.type?.value === 'class' ? level : this._getFeatSelectionLevel(level);
            const isRepeatable = this._isRepeatableFeatOption(opt);
            if (!meetsLevelRequirement(opt, choiceLevel)) return false;
            if (obtainedNames.has(opt.name) && !isRepeatable) return false;
            if (opt.uuid && obtainedUuids.has(opt.uuid) && !isRepeatable) return false;
            return true;
        });

        const canReplace = event.replacement;
        // 从宿主类或 LevelUpManager 中查找可替换的物品
        // 创建流程使用 _getReplacementCandidates（搜索 blueprintData），升级流程使用 levelUpManager
        const existingItems = canReplace
            ? (typeof this._getReplacementCandidates === 'function'
                ? this._getReplacementCandidates(event)
                : (this.levelUpManager?.getReplacementCandidates(event) || []))
            : [];
        const isPureReplacement = event.count === 0 && canReplace;
        const advId = event._original?._id || event.id || event.title;

        if (isPureReplacement) {
            const replacementMode = savedChoice?.replacementMode || 'none';
            const replaceTargetId = savedChoice?.replaceTargetId || '';
            const selectedUuid = savedChoice?.selectedUuid || savedChoice?.selectedUuids?.[0] || '';
            return `
            <div class="progression-feature-group item-choice-section page-wrapper" data-type="item-choice" data-count="${event.count}" data-adv-id="${advId}" data-step-type="${stepType}" data-pure-replacement="true">
                <h4><i class="fas fa-exchange-alt"></i> ${event.title} (${game.i18n.localize('ORIGINATE.UI.Progression.OptionalReplacement')})</h4>
                ${spellSchoolHint(getSpellRestriction(event)) ? `<p class="selection-hint">${spellSchoolHint(getSpellRestriction(event))}</p>` : ''}
                <p data-school-error role="alert" hidden>${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')}</p>
                <div class="replacement-mode-selection" style="display: flex; gap: 2rem; margin-bottom: 2rem; justify-content: center;">
                    <label class="option-card mode-card ${replacementMode === 'none' ? 'selected' : ''}" style="flex: 1; text-align: center; padding: 2rem; display: flex; flex-direction: column; align-items: center; justify-content: center; max-width: 300px;">
                        <input type="radio" name="replacement-mode-${level}-${advId}" value="none" ${replacementMode === 'none' ? 'checked' : ''} style="display: none;">
                        <div class="mode-icon" style="font-size: 2.5rem; margin-bottom: 1rem;"><i class="fas fa-times-circle"></i></div>
                        <div class="mode-title" style="font-weight: bold; font-size: 1.1em; margin-bottom: 0.5rem;">${game.i18n.localize('ORIGINATE.UI.Progression.NoReplacement')}</div>
                        <div class="mode-desc" style="color: #888; font-size: 0.9em;">${game.i18n.localize('ORIGINATE.UI.Progression.NoReplacementDesc')}</div>
                    </label>
                    <label class="option-card mode-card ${replacementMode === 'replace' ? 'selected' : ''}" style="flex: 1; text-align: center; padding: 2rem; display: flex; flex-direction: column; align-items: center; justify-content: center; max-width: 300px;">
                        <input type="radio" name="replacement-mode-${level}-${advId}" value="replace" ${replacementMode === 'replace' ? 'checked' : ''} style="display: none;">
                        <div class="mode-icon" style="font-size: 2.5rem; margin-bottom: 1rem;"><i class="fas fa-exchange-alt"></i></div>
                        <div class="mode-title" style="font-weight: bold; font-size: 1.1em; margin-bottom: 0.5rem;">${game.i18n.localize('ORIGINATE.UI.Progression.DoReplacement')}</div>
                        <div class="mode-desc" style="color: #888; font-size: 0.9em;">${game.i18n.localize('ORIGINATE.UI.Progression.DoReplacementDesc')}</div>
                    </label>
                </div>
                <div class="replacement-interface" style="display: ${replacementMode === 'replace' ? 'block' : 'none'};">
                    <div class="replacement-columns" style="display: flex; gap: 2rem;">
                        <div class="replacement-column" style="flex: 1;">
                            <h5>${game.i18n.localize('ORIGINATE.UI.Progression.SelectToRemove')}</h5>
                            <div class="options-container existing-items-list">
                                ${existingItems.length > 0 ? existingItems.map(item => `
                                    <label class="option-card compact-feature-card existing-item ${replaceTargetId === item.id ? 'selected' : ''}" data-uuid="${resolveItemSourceUuid(item) || ''}">
                                        <input type="radio" name="replace-target-${level}-${advId}" value="${item.id}" ${replaceTargetId === item.id ? 'checked' : ''}>
                                        <img src="${item.img}" class="feature-icon">
                                        <div class="feature-info-compact"><div class="feature-title">${item.name}</div></div>
                                    </label>
                                `).join('') : `<p>${game.i18n.localize('ORIGINATE.UI.Progression.NoItemsToReplace')}</p>`}
                            </div>
                        </div>
                        <div class="replacement-column" style="flex: 1;">
                            <h5>${game.i18n.localize('ORIGINATE.UI.Progression.SelectToAdd')}</h5>
                            <div class="options-container item-choices-list">
                                ${availablePool.map(opt => `
                                    <label class="option-card compact-feature-card ${selectedUuid === opt.uuid ? 'selected' : ''}" data-uuid="${opt.uuid || ''}" data-school="${opt.school || ''}" aria-invalid="${!!opt.invalidSchool}">
                                        <input type="radio" name="item-choice-${level}-${advId}" value="${opt.uuid}" ${selectedUuid === opt.uuid ? 'checked' : ''}>
                                        <img src="${opt.img}" class="feature-icon">
                                        <div class="feature-info-compact"><div class="feature-title">${opt.name}</div></div>
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        }

        // 普通选择模式
        const selectedUuids = new Set(savedChoice?.selectedUuids || []);
        const replacementEnabled = !!savedChoice?.replacementEnabled;
        const replaceTargetId = savedChoice?.replaceTargetId || '';

        let replacementHtml = '';
        if (canReplace && existingItems.length > 0) {
            replacementHtml = `
            <div class="replacement-toggle">
                <label>
                    <input type="checkbox" class="enable-replacement" data-section-id="${advId}" ${replacementEnabled ? 'checked' : ''}>
                    ${game.i18n.localize('ORIGINATE.UI.Progression.ReplacementToggle')}
                </label>
            </div>
            <div class="replacement-selection" style="display: ${replacementEnabled ? 'block' : 'none'};">
                <h5>${game.i18n.localize('ORIGINATE.UI.Progression.SelectReplacement')}</h5>
                <div class="existing-items-list">
                    ${existingItems.map(item => `
                        <label class="option-card compact-feature-card existing-item ${replaceTargetId === item.id ? 'selected' : ''}">
                            <input type="radio" name="replace-target-${level}-${advId}" value="${item.id}" ${replaceTargetId === item.id ? 'checked' : ''}>
                            <img src="${item.img}" class="feature-icon">
                            <div class="feature-info-compact"><div class="feature-title">${item.name}</div></div>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
        }

        return `
        <div class="progression-feature-group item-choice-section page-wrapper" data-type="item-choice" data-count="${event.count}" data-adv-id="${advId}" data-step-type="${stepType}">
            <h4><i class="fas fa-list-ul"></i> ${event.title} ${event.count > 0 ? `(${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })})` : ''}</h4>
            ${spellSchoolHint(getSpellRestriction(event)) ? `<p class="selection-hint">${spellSchoolHint(getSpellRestriction(event))}</p>` : ''}
            <p data-school-error role="alert" hidden>${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')}</p>
            ${replacementHtml}
            <div class="options-container item-choices-list">
                ${availablePool.map(opt => {
            let repeatableHint = '';
            const isRepeatable = this._isRepeatableFeatOption(opt);
            if (isRepeatable) {
                const ownedCount = this.actor?.items?.filter(i => i.name === opt.name)?.length || 0;
                repeatableHint = `<div class="feat-repeatable-hint"><i class="fas fa-redo"></i> ${game.i18n.localize('ORIGINATE.UI.Repeatable')}${ownedCount > 0 ? ` · ${game.i18n.format('ORIGINATE.UI.RepeatableCount', { count: ownedCount })}` : ''}</div>`;
            }
            return `
                    <label class="option-card compact-feature-card${isRepeatable ? ' repeatable-feat' : ''}${selectedUuids.has(opt.uuid) ? ' selected' : ''}" data-uuid="${opt.uuid || ''}" data-school="${opt.school || ''}" aria-invalid="${!!opt.invalidSchool}">
                        <input type="checkbox" name="item-choice-${level}-${advId}" value="${opt.uuid}" ${selectedUuids.has(opt.uuid) ? 'checked' : ''}>
                        <img src="${opt.img}" class="feature-icon">
                        <div class="feature-info-compact"><div class="feature-title">${opt.name}</div>${repeatableHint}</div>
                    </label>`;
        }).join('')}
            </div>
            <div class="selection-hint" style="margin-top: 30px;">
                <p>${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })}</p>
            </div>
        </div>
    `;
    }

    // 共享特质选择渲染

    _renderTraitChoice(event, level, stepType, stepId = null) {
        let poolArray = Array.from(event.pool || []);
        let displayOptions = [];
        const chosen = new Set(this._getStepDraft(stepId)?.chosen || []);

        if (poolArray.some(p => typeof p === 'string' && p.endsWith(':*'))) {
            displayOptions = this._expandWildcardPool(poolArray);
        } else {
            displayOptions = poolArray.map(key => ({ key, label: this._getTraitLabel(key) }));
        }

        const knownTraits = this._getKnownTraits();
        const proficientWeapons = collectWeaponProficiencyKeys({
            actor: this.actor,
            pendingTraitChanges: this._state?.pendingTraitChanges || []
        });

        const unfilteredDisplayOptions = displayOptions.map(item => ({ ...item }));

        if (event.mode === 'expertise') {
            displayOptions = displayOptions.filter(opt => {
                if (!opt.key.startsWith('skills:')) return false;
                if (!knownTraits.has(opt.key)) return false;
                const skillKey = opt.key.split(':')[1];
                if (knownTraits.has(`expertise:${skillKey}`)) return false;
                return true;
            });
        } else {
            displayOptions = displayOptions.filter(opt => {
                if (opt.key.startsWith('weaponMastery:')) {
                    const weaponKey = opt.key.split(':').pop().toLowerCase();
                    if (!proficientWeapons.has(weaponKey)) return false;
                }
                return !knownTraits.has(opt.key);
            });
        }

        if (event.mode === 'mastery' && displayOptions.length === 0 && unfilteredDisplayOptions.length > 0) {
            window.OriginateLog('Originate | [LevelUp] 武器精通被过滤空了，先把原始列表放出来。', {
                title: event.title,
                pool: poolArray,
                proficientWeapons: Array.from(proficientWeapons)
            });
            displayOptions = unfilteredDisplayOptions;
        }

        const advId = event._original?._id || event.id || event.title;

        return `
        <div class="progression-feature-group trait-choice-section page-wrapper" data-type="trait-choice" data-count="${event.count}" data-adv-id="${advId}" data-step-type="${stepType}" data-mode="${event.mode || 'default'}">
            <h4><i class="fas fa-tasks"></i> ${event.title} ${event.count > 0 ? `(${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })})` : ''}</h4>
            ${event.mode === 'expertise' ? `<div class="selection-hint">${game.i18n.localize('ORIGINATE.UI.Hint.SelectExpertise')}</div>` : ''}
            ${event._replacingGrant ? `<div class="selection-hint" style="color: var(--accent-color, #d4a849); margin-bottom: 1rem;"><i class="fas fa-info-circle"></i> ${game.i18n.format('ORIGINATE.UI.Hint.TraitReplacement', { trait: this._getTraitLabel(event._replacingGrant) })}</div>` : ''}
            <div class="options-container skill-chips-container">
                ${displayOptions.length > 0 ? displayOptions.map(item => `
                    <label class="option-card card-skill ${chosen.has(item.key) ? 'selected' : ''}">
                        <input type="checkbox" name="trait-choice-${level}-${advId}" value="${item.key}" ${chosen.has(item.key) ? 'checked' : ''}>
                        <span class="chip-label">${item.label}</span>
                    </label>
                `).join('') : `<div class="no-options">${game.i18n.localize('ORIGINATE.UI.Progression.NoOptionsAvailable')}</div>`}
            </div>
            <div class="selection-hint" style="margin-top: 30px;">
                <p>${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })}</p>
            </div>
        </div>
    `;
    }

    // 共享法术选择渲染

    async _renderSpellChoice(step) {
        const event = step.event;
        const advId = event._original?._id || event.id || event.title;
        const count = event.count || 1;
        const savedChoice = this._getStepDraft(step.id);
        const savedSpells = Array.isArray(savedChoice?.selectedSpells) ? savedChoice.selectedSpells : [];
        const selectedSpells = savedSpells.filter(spell => !this.dataManager?.isItemExcluded?.(spell));
        if (selectedSpells.length !== savedSpells.length) {
            this._setStepDraft(step.id, {
                ...savedChoice,
                selectedUuids: selectedSpells.map(spell => spell.uuid),
                selectedSpells
            });
        }

        const restriction = getSpellRestriction(event);
        if (normalizeSpellSchools(restriction.school).length) {
            for (const spell of selectedSpells) {
                try { spell.school = (await fromUuid(spell.uuid))?.system?.school || ''; }
                catch { spell.school = ''; }
            }
        }

        const schools = Object.entries(CONFIG.DND5E.spellSchools).map(([k, v]) => ({ key: k, label: v.label }));
        const restrictedLevel = restriction?.level ?? '';

        return `
        <div class="progression-feature-group spell-browser-section page-wrapper" data-type="spell_choice" data-count="${count}" data-adv-id="${advId}" data-step-type="${step.stepType}" data-restriction-level="${restrictedLevel}">
            <h4><i class="fas fa-magic"></i> ${step.title || game.i18n.localize('ORIGINATE.UI.SelectSpells')} (${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: count })})</h4>
            ${spellSchoolHint(restriction) ? `<p class="selection-hint">${spellSchoolHint(restriction)}</p>` : ''}
            <p data-school-error role="alert" hidden>${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')}</p>
            <div class="spell-browser-container">
                <div class="spell-browser-sidebar">
                    <div class="search-box">
                        <input type="text" class="spell-search-input" placeholder="${game.i18n.localize('ORIGINATE.UI.Search')}">
                    </div>
                    <div class="filter-group">
                        <label>${game.i18n.localize('DND5E.School')}</label>
                        <div class="filter-buttons school-filters">
                            <button class="filter-btn school-btn active" data-school="">${game.i18n.localize('ORIGINATE.UI.All')}</button>
                            ${schools.map(s => `<button class="filter-btn school-btn" data-school="${s.key}">${s.label}</button>`).join('')}
                        </div>
                    </div>
                    <div class="filter-group">
                        <label>${game.i18n.localize('ORIGINATE.UI.SpellLevel')}</label>
                        <div class="filter-buttons level-filters"></div>
                    </div>
                    <div class="filter-group class-filter-group">
                        <label>${game.i18n.localize('ORIGINATE.UI.ClassSpellList')}</label>
                        <div class="class-filter-container">
                            <div class="spell-filter-list primary-classes">
                                <div class="loading-placeholder-small"><i class="fas fa-spinner fa-spin"></i></div>
                            </div>
                            <div class="subclass-section collapsed">
                                <div class="subclass-toggle">
                                    <i class="fas fa-caret-right"></i>
                                    <span>${game.i18n.localize('ORIGINATE.UI.SubclassSpellList')}</span>
                                </div>
                                <div class="spell-filter-list subclass-classes" style="display: none;"></div>
                            </div>
                        </div>
                    </div>
                    <div class="drag-drop-hint">
                        <i class="fas fa-hand-pointer"></i>
                        <span>${game.i18n.localize('ORIGINATE.UI.DragDropHint')}</span>
                    </div>
                </div>
                <div class="spell-browser-main">
                    <div class="spell-results-list">
                        <div class="loading-placeholder">
                            <i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize('ORIGINATE.UI.Loading')}
                        </div>
                    </div>
                    <div class="selected-spells-area">
                        <div class="selection-header">
                            ${game.i18n.localize('ORIGINATE.UI.Selected')}: <span class="selection-count">${selectedSpells.length}</span> / ${count}
                        </div>
                        <div class="selected-spells-list">
                            ${selectedSpells.map(spell => `
                                <div class="spell-card selected" data-uuid="${spell.uuid}" data-level="${spell.level ?? 0}" data-school="${spell.school || ''}" aria-invalid="${!matchesSpellSchool(spell, restriction)}">
                                    <img src="${spell.img || 'icons/svg/item-bag.svg'}" class="spell-icon">
                                    <div class="spell-name">${spell.name}</div>
                                    <div class="remove-icon"><i class="fas fa-times"></i></div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    }

    // ========================================================================
    // 法术替换渲染（SpellRules 新增）法术规则是我最伟大的发明
    // ========================================================================

    async _renderSpellReplacement(step) {
        const classIdentifier = step.classIdentifier;
        const count = step.count || 1;
        const maxLevel = step.maxLevel || 9;
        const savedChoice = this._getStepDraft(step.id);
        const oldSpellId = savedChoice?.oldSpellId || '';
        const newSpell = savedChoice?.newSpell || null;
        if (newSpell && normalizeSpellSchools(getSpellRestriction(step.event || step).school).length) {
            try { newSpell.school = (await fromUuid(newSpell.uuid))?.system?.school || ''; }
            catch { newSpell.school = ''; }
        }

        // 获取职业法术映射表，用于过滤
        const classSpellMap = await this.dataManager.getClassSpellMap();
        const classIds = normalizeSpellListIds(step.list || [classIdentifier]);

        // 获取角色当前拥有的法术
        const currentSpells = this.actor.items.filter(i => {
            if (i.type !== 'spell' || i.system?.level <= 0) return false;

            // 通过统一来源字段查找此法术是否属于当前职业法表
            const sourceUuid = resolveItemSourceUuid(i);
            if (!sourceUuid) return false;

            const spellClasses = getSpellClassesForSpell(classSpellMap, { uuid: sourceUuid, name: i.name });
            if (!spellClasses) return false;

            
            return spellClassSetMatchesAny(spellClasses, classIds);
        }).map(s => ({
            id: s.id,
            name: s.name,
            img: s.img,
            level: s.system.level,
            school: s.system.school
        }));

        // 按等级分组
        const spellsByLevel = {};
        currentSpells.forEach(s => {
            if (!spellsByLevel[s.level]) spellsByLevel[s.level] = [];
            spellsByLevel[s.level].push(s);
        });

        const schools = Object.entries(CONFIG.DND5E.spellSchools).map(([k, v]) => ({ key: k, label: v.label }));
        const listRestriction = (step.list || [classIdentifier]).map(l => `class:${l}`);

        return `
        <div class="progression-feature-group spell-replacement-section page-wrapper"
             data-type="spell_replacement"
             data-class="${classIdentifier}"
             data-count="${count}"
             data-max-level="${maxLevel}">
            <h4><i class="fas fa-exchange-alt"></i> ${step.title}</h4>
            <p class="selection-hint">${game.i18n.localize('ORIGINATE.SpellRules.ReplacementHint')}</p>
            ${spellSchoolHint(getSpellRestriction(step.event || step)) ? `<p class="selection-hint">${spellSchoolHint(getSpellRestriction(step.event || step))}</p>` : ''}
            <p data-school-error role="alert" hidden>${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')}</p>

            <div class="spell-replacement-container">
                <!-- 左侧：选择要替换的旧法术 -->
                <div class="replacement-old-spells">
                    <h5>${game.i18n.localize('ORIGINATE.SpellRules.OldSpell')}</h5>
                    <div class="old-spells-list">
                        ${Object.entries(spellsByLevel).sort(([a], [b]) => a - b).map(([lvl, spells]) => `
                            <div class="spell-level-group">
                                <div class="level-label">${CONFIG.DND5E.spellLevels[lvl] || game.i18n.format('ORIGINATE.SpellRules.SpellLevel', { level: lvl })}</div>
                                ${spells.map(s => `
                                    <label class="old-spell-option ${oldSpellId === s.id ? 'selected' : ''}">
                                        <input type="radio" name="spell-replace-old" value="${s.id}" ${oldSpellId === s.id ? 'checked' : ''}>
                                        <img src="${s.img}" class="spell-icon-sm">
                                        <span>${s.name}</span>
                                    </label>
                                `).join('')}
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- 右侧：选择新法术（迷你法术浏览器） -->
                <div class="replacement-new-spell-browser">
                    <h5>${game.i18n.localize('ORIGINATE.SpellRules.NewSpell')}</h5>
                    <div class="mini-spell-browser" data-restriction='${JSON.stringify(listRestriction)}' data-max-level="${maxLevel}">
                        <div class="search-box">
                            <input type="text" class="spell-search-input" placeholder="${game.i18n.localize('ORIGINATE.UI.Search')}">
                        </div>
                        <div class="filter-buttons school-filters">
                            <button class="filter-btn school-btn active" data-school="">${game.i18n.localize('ORIGINATE.UI.All')}</button>
                            ${schools.map(s => `<button class="filter-btn school-btn" data-school="${s.key}">${s.label}</button>`).join('')}
                        </div>
                        <div class="filter-buttons level-filters">
                            <button class="filter-btn level-btn active" data-level="">${game.i18n.localize('ORIGINATE.UI.AllLevels')}</button>
                            ${Array.from({ length: maxLevel }, (_, i) => `<button class="filter-btn level-btn" data-level="${i + 1}">${game.i18n.format('ORIGINATE.SpellRules.SpellLevel', { level: i + 1 })}</button>`).join('')}
                        </div>
                        <div class="replacement-spell-results"></div>
                        <div class="replacement-selected">
                            <div class="replacement-new-spell" data-uuid="${newSpell?.uuid || ''}" data-level="${newSpell?.level ?? 0}" data-school="${newSpell?.school || ''}" style="display:${newSpell ? 'flex' : 'none'};">
                                ${newSpell ? `
                                    <img src="${newSpell.img || 'icons/svg/item-bag.svg'}" class="spell-icon">
                                    <div class="spell-name">${newSpell.name}</div>
                                    <div class="remove-icon"><i class="fas fa-times"></i></div>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    }

    // ========================================================================
    // 准备型法术获得渲染（SpellRules 新增）
    // ========================================================================

    async _renderPreparedSpellGrant(step) {
        const classIdentifier = step.classIdentifier;
        const minLevel = step.minLevel || 1;
        const maxLevel = step.maxLevel || 0;
        const levelRange = minLevel === 1 ? game.i18n.format('ORIGINATE.SpellRules.LevelRangeBelow', { level: maxLevel }) : game.i18n.format('ORIGINATE.SpellRules.LevelRange', { min: minLevel, max: maxLevel });

        // 加载将要授予的法术列表
        let spellCards = '';
        let totalCount = 0;
        try {
            const spellList = step.list || [classIdentifier];
            await this.dataManager.loadSpellListSources();
            const classSpellMap = await this.dataManager.getClassSpellMap();
            console.log('Originate | [PreparedGrant] classSpellMap:', classSpellMap ? `Map(${classSpellMap.size})` : 'null/undefined');
            const results = await this.dataManager.getSpellsByRestriction({ level: 'available' }, '', maxLevel);
            console.log(`Originate | [PreparedGrant] getSpellsByRestriction returned ${results?.length ?? 0} spells for maxLevel=${maxLevel}`);

            let classSpells;
            if (!classSpellMap || !(classSpellMap instanceof Map)) {
                console.warn('Originate | [PreparedGrant] classSpellMap is not a valid Map, falling back to showing all spells');
                classSpells = results.filter(spell => {
                    const spellLevel = spell.system?.level ?? spell.level ?? 0;
                    return spellLevel >= minLevel;
                });
            } else {
                classSpells = results.filter(spell => {
                    const spellLevel = spell.system?.level ?? spell.level ?? 0;
                    if (spellLevel < minLevel) return false;
                    const spellClasses = getSpellClassesForSpell(classSpellMap, spell);
                    if (!spellClasses) return false;
                    return spellClassSetMatchesAny(spellClasses, spellList);
                });
            }
            console.log(`Originate | [PreparedGrant] 过滤后: ${classSpells.length} spells for class=${classIdentifier}, spellList=[${spellList}]`);

            const existingSpellNames = new Set(
                this.actor.items.filter(i => i.type === 'spell').map(i => i.name.toLowerCase())
            );
            // 标记已拥有的法术，不过滤
            classSpells.forEach(s => { s._owned = existingSpellNames.has(s.name.toLowerCase()); });
            totalCount = classSpells.filter(s => !s._owned).length;

            // 按环阶分组
            const grouped = {};
            for (const spell of classSpells) {
                const lvl = spell.system?.level ?? spell.level ?? 0;
                if (!grouped[lvl]) grouped[lvl] = [];
                grouped[lvl].push(spell);
            }

            const sortedLevels = Object.keys(grouped).map(Number).sort((a, b) => a - b);
            for (const lvl of sortedLevels) {
                const spells = grouped[lvl].sort((a, b) => a.name.localeCompare(b.name));
                const newCount = spells.filter(s => !s._owned).length;
                spellCards += `<div class="grant-level-group">`;
                spellCards += `<h5 class="grant-level-label">${game.i18n.format('ORIGINATE.SpellRules.SpellLevelCount', { level: lvl, newCount: newCount, totalCount: spells.length })}</h5>`;
                spellCards += `<div class="grant-spells-grid">`;
                for (const spell of spells) {
                    const ownedClass = spell._owned ? ' owned-spell' : '';
                    spellCards += `
                    <div class="option-card progression-feature-item${ownedClass}" data-uuid="${spell.uuid || ''}">
                        <img src="${spell.img || 'icons/svg/item-bag.svg'}" class="feature-icon">
                        <div class="feature-info">
                            <div class="feature-name">${spell.name}</div>
                        </div>
                    </div>`;
                }
                spellCards += `</div></div>`;
            }

            if (classSpells.length === 0) {
                spellCards = `<p class="selection-hint">${game.i18n.localize('ORIGINATE.SpellRules.NoNewSpells')}</p>`;
            }
        } catch (e) {
            console.error('Originate | 加载准备型法术列表失败:', e);
            spellCards = `<p class="selection-hint">${game.i18n.localize('ORIGINATE.SpellRules.LoadError')}</p>`;
        }

        return `
        <div class="progression-feature-group prepared-spell-grant-section page-wrapper"
             data-type="prepared_spell_grant"
             data-class="${classIdentifier}">
            <div class="grant-info">
                <div class="grant-icon"><i class="fas fa-book-open"></i></div>
                <h4>${step.title}</h4>
                <p class="selection-hint">
                    ${game.i18n.format('ORIGINATE.SpellRules.PreparedGrantDesc', { class: SpellRules._getLocalizedClassName(classIdentifier), maxLevel: maxLevel })}
                </p>
                <div class="grant-note">
                    <i class="fas fa-info-circle"></i>
                    ${game.i18n.localize('ORIGINATE.SpellRules.PreparedNote')}
                </div>
            </div>
            <div class="grant-spell-list">
                ${spellCards}
            </div>
        </div>
    `;
    }

    // 法术替换事件绑定（SpellRules 新增）

    _bindSpellReplacementEvents(overlay, step) {
        const section = overlay.querySelector('.spell-replacement-section');
        if (!section) return;

        const browser = section.querySelector('.mini-spell-browser');
        if (!browser) return;

        const maxLevel = parseInt(section.dataset.maxLevel) || 9;
        const listRestriction = JSON.parse(browser.dataset.restriction || '[]');
        const searchInput = browser.querySelector('.spell-search-input');
        const schoolButtons = browser.querySelectorAll('.school-btn');
        const levelButtons = browser.querySelectorAll('.level-btn');
        const resultsContainer = browser.querySelector('.replacement-spell-results');
        const selectedContainer = browser.querySelector('.replacement-new-spell');

        // 获取角色已拥有的法术名称集合
        const existingSpellNames = new Set(
            this.actor.items.filter(i => i.type === 'spell').map(i => i.name.toLowerCase())
        );

        let currentSchool = '';
        let currentLevel = '';
        let currentSpells = [];
        const saveDraft = () => this._syncStepDraftFromOverlay(step, overlay);

        const syncSelectedState = () => {
            const selectedUuid = selectedContainer.dataset.uuid || '';
            resultsContainer.querySelectorAll('.spell-card').forEach(card => {
                card.classList.toggle('spell-selected', !!selectedUuid && card.dataset.uuid === selectedUuid);
            });
        };

        const bindSelectedContainer = () => {
            const removeBtn = selectedContainer.querySelector('.remove-icon');
            if (!removeBtn) return;

            removeBtn.onclick = (e) => {
                e.stopPropagation();
                selectedContainer.style.display = 'none';
                selectedContainer.dataset.uuid = '';
                selectedContainer.dataset.level = '0';
                selectedContainer.dataset.school = '';
                selectedContainer.innerHTML = '';
                syncSelectedState();
                saveDraft();
            };
        };

        const refreshResults = async () => {
            const searchText = searchInput?.value || '';
            const restriction = { ...getSpellRestriction(step.event || step), list: listRestriction };

            const spells = await this.dataManager.getSpellsByRestriction(restriction, searchText, maxLevel);

            // 过滤掉戏法（替换不含戏法）+ 学派 + 环阶
            currentSpells = spells.filter(s => {
                if (s.level === 0) return false;
                if (currentSchool && s.school !== currentSchool) return false;
                if (currentLevel && s.level !== parseInt(currentLevel)) return false;
                return true;
            });

            // 标记已拥有的法术
            currentSpells.forEach(s => {
                s._owned = existingSpellNames.has(s.name.toLowerCase());
            });

            resultsContainer.innerHTML = this._generateSpellCards(currentSpells);

            // Подсказки заклинаний загружают полное описание по UUID.
            this._bindTooltips(resultsContainer);

            // 绑定点击（跳过已拥有的）
            resultsContainer.querySelectorAll('.spell-card').forEach(card => {
                if (card.classList.contains('owned-spell')) return;
                card.addEventListener('click', () => {
                    const uuid = card.dataset.uuid;
                    const spell = currentSpells.find(s => s.uuid === uuid);
                    if (!spell) return;

                    selectedContainer.style.display = 'flex';
                    selectedContainer.dataset.uuid = uuid;
                    selectedContainer.dataset.level = spell.level ?? 0;
                    selectedContainer.dataset.school = spell.school || '';
                    selectedContainer.innerHTML = `
                    <img src="${spell.img}" class="spell-icon">
                    <div class="spell-name">${spell.name}</div>
                    <div class="remove-icon"><i class="fas fa-times"></i></div>
                `;
                    bindSelectedContainer();
                    syncSelectedState();
                    saveDraft();
                });
            });
            syncSelectedState();
        };

        let searchTimeout;
        searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(refreshResults, 300);
        });
        schoolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                schoolButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentSchool = btn.dataset.school;
                refreshResults();
            });
        });
        levelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                levelButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentLevel = btn.dataset.level;
                refreshResults();
            });
        });
        section.querySelectorAll('input[name="spell-replace-old"]').forEach(radio => {
            radio.addEventListener('change', () => {
                section.querySelectorAll('.old-spell-option').forEach(option => option.classList.remove('selected'));
                radio.closest('.old-spell-option')?.classList.add('selected');
                saveDraft();
            });
        });
        bindSelectedContainer();
        saveDraft();
        refreshResults();
    }

    // 子职选择渲染

    async _renderSubclassSelection(step, level) {
        const classIdentifier = this.levelUpManager.getClassIdentifier();
        const subclassOptions = await this.dataManager.getOptions('subclass', { classIdentifier });
        const selectedUuid = this._state.stepData[step.id]?.selectedSubclass || null;
        step.subclassOptions = subclassOptions;

        return renderSubclassSelectionPanel(subclassOptions, { selectedUuid });
    }

    async _triggerSubclassSelection(level) {
        // 将子职选择作为第一个步骤
        this._state.steps = [{
            id: 'subclass-selection',
            type: 'subclass_selection',
            title: game.i18n.localize('ORIGINATE.UI.Progression.SelectSubclass')
        }];
        this._state.currentStepIndex = 0;
        this._state.stepData = {};
        this._state.stepHistory = {};
        this._currentStepComplete = false;
        await this._renderCurrentStep();
    }

    // 这里只绑定共享控件；前进和后退仍回调各自宿主，避免 UI 层接管提交生命周期。

    async _runProgressionNavAction(action, task) {
        if (this._progressionNavAction) return;
        const overlay = this.element?.querySelector('.originate-progression-wizard');
        this._progressionNavAction = action;
        this._setProgressionNavBusy(overlay, action, true);

        try {
            return await task();
        } finally {
            this._setProgressionNavBusy(overlay, action, false);
            this._progressionNavAction = null;
        }
    }

    _getStepDraft(stepId) {
        if (!stepId) return null;
        return this._state?.stepData?.[stepId] || null;
    }

    _setStepDraft(stepId, draft) {
        if (!stepId) return null;
        if (!this._state.stepData) this._state.stepData = {};

        if (draft == null) {
            delete this._state.stepData[stepId];
            return null;
        }

        this._state.stepData[stepId] = foundry.utils.deepClone(draft);
        return this._state.stepData[stepId];
    }

    _readItemChoiceDraft(section) {
        if (!section) return null;

        const isPureReplacement = section.dataset.pureReplacement === 'true';
        const replaceTargetId = section.querySelector('input[name^="replace-target-"]:checked')?.value || null;

        if (isPureReplacement) {
            const selectedUuid = section.querySelector('input[name^="item-choice-"]:checked')?.value || null;
            return {
                replacementMode: section.querySelector('input[name^="replacement-mode-"]:checked')?.value || 'none',
                replaceTargetId,
                selectedUuid,
                selectedUuids: selectedUuid ? [selectedUuid] : []
            };
        }

        return {
            replacementEnabled: !!section.querySelector('.enable-replacement:checked'),
            replaceTargetId,
            selectedUuids: Array.from(section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked')).map(input => input.value)
        };
    }

    _readTraitChoiceDraft(section) {
        if (!section) return null;

        return {
            chosen: Array.from(section.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value)
        };
    }

    _readSpellChoiceDraft(section) {
        if (!section) return null;

        const selectedSpells = Array.from(section.querySelectorAll('.selected-spells-list .spell-card'))
            .map(card => {
                const uuid = card.dataset.uuid;
                if (!uuid) return null;

                return {
                    uuid,
                    name: card.querySelector('.spell-name')?.textContent?.trim() || '',
                    img: card.querySelector('.spell-icon')?.getAttribute('src') || '',
                    level: Number(card.dataset.level || '') || 0,
                    school: card.dataset.school || ''
                };
            })
            .filter(Boolean);

        return {
            selectedUuids: selectedSpells.map(spell => spell.uuid),
            selectedSpells
        };
    }

    _removeExcludedSpellSelections(step, overlay) {
        if (step?.type !== 'spell_choice' || !overlay || !this.dataManager?.isItemExcluded) return false;

        const section = overlay.querySelector('.spell-browser-section');
        if (!section) return false;

        const excludedCards = Array.from(section.querySelectorAll('.selected-spells-list .spell-card'))
            .filter(card => this.dataManager.isItemExcluded(card.dataset.uuid));
        if (excludedCards.length === 0) return false;

        // 设置可能在向导开着时被改掉，提交前再挡一次，别让旧卡片穿过查询层。
        excludedCards.forEach(card => card.remove());
        this._syncStepDraftFromOverlay(step, overlay);
        this._checkProgressionCanProceed(overlay);
        ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Progression.ExcludedSpellRemoved'));
        return true;
    }

    _readSpellReplacementDraft(section) {
        if (!section) return null;

        const selectedContainer = section.querySelector('.replacement-new-spell');
        const newSpellUuid = selectedContainer?.dataset.uuid || null;

        return {
            oldSpellId: section.querySelector('input[name="spell-replace-old"]:checked')?.value || null,
            newSpellUuid,
            newSpell: newSpellUuid ? {
                uuid: newSpellUuid,
                name: selectedContainer.querySelector('.spell-name')?.textContent?.trim() || '',
                img: selectedContainer.querySelector('.spell-icon')?.getAttribute('src') || '',
                level: Number(selectedContainer.dataset.level || '') || 0,
                school: selectedContainer.dataset.school || ''
            } : null
        };
    }

    async _validateSpellSchoolDraft(step, overlay) {
        if (!['spell_choice', 'item_choice', 'spell_replacement'].includes(step?.type)) return true;
        const restriction = getSpellRestriction(step.event || step);
        if (!normalizeSpellSchools(restriction.school).length) return true;
        const draft = this._syncStepDraftFromOverlay(step, overlay);
        const uuids = draft?.replacementMode === 'none' ? []
            : (draft?.selectedUuids || (draft?.newSpellUuid ? [draft.newSpellUuid] : []));
        const invalid = await findInvalidSpellSchoolSelections(uuids, restriction, uuid => fromUuid(uuid));
        if (!invalid.length) return true;
        ui.notifications.warn(`${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')} ${spellSchoolHint(restriction)}`);
        return false;
    }

    _syncStepDraftFromOverlay(step, overlay) {
        if (!step?.id || !overlay) {
            return step?.id ? foundry.utils.deepClone(this._getStepDraft(step.id)) : null;
        }

        let draft = null;
        switch (step.type) {
            case 'item_choice':
                draft = this._readItemChoiceDraft(overlay.querySelector('.item-choice-section'));
                break;
            case 'trait_choice':
                draft = this._readTraitChoiceDraft(overlay.querySelector('.trait-choice-section'));
                break;
            case 'spell_choice':
                draft = this._readSpellChoiceDraft(overlay.querySelector('.spell-browser-section'));
                break;
            case 'spell_replacement':
                draft = this._readSpellReplacementDraft(overlay.querySelector('.spell-replacement-section'));
                break;
            default:
                draft = this._getStepDraft(step.id);
                break;
        }

        this._setStepDraft(step.id, draft);
        return foundry.utils.deepClone(draft);
    }

    _setProgressionNavBusy(overlay, action, active) {
        if (!overlay) return;

        const nextBtn = overlay.querySelector('#progression-next-btn');
        const prevBtn = overlay.querySelector('#progression-prev-btn');
        const targetBtn = action === 'prev' ? prevBtn : nextBtn;
        const buttons = [prevBtn, nextBtn].filter(Boolean);

        if (active) {
            buttons.forEach(button => {
                if (button.dataset.originateBusyDisabled == null) {
                    button.dataset.originateBusyDisabled = button.disabled ? '1' : '0';
                }
                button.disabled = true;
            });

            if (!targetBtn) return;

            if (!targetBtn.dataset.originateBusyHtml) {
                targetBtn.dataset.originateBusyHtml = targetBtn.innerHTML;
                targetBtn.dataset.originateBusyLabel = targetBtn.textContent.trim();
            }

            const label = targetBtn.dataset.originateBusyLabel || targetBtn.textContent.trim() || 'Please wait';
            targetBtn.classList.add('is-loading');
            targetBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${label}`;
            return;
        }

        buttons.forEach(button => {
            if (button.dataset.originateBusyDisabled != null) {
                button.disabled = button.dataset.originateBusyDisabled === '1';
                delete button.dataset.originateBusyDisabled;
            }

            if (button.dataset.originateBusyHtml) {
                button.innerHTML = button.dataset.originateBusyHtml;
                delete button.dataset.originateBusyHtml;
                delete button.dataset.originateBusyLabel;
            }

            button.classList.remove('is-loading');
        });
    }

    _bindProgressionEvents(overlay, step) {
        const state = this._state;

        // 导航按钮
        const nextBtn = overlay.querySelector('#progression-next-btn');
        const prevBtn = overlay.querySelector('#progression-prev-btn');

        if (nextBtn) nextBtn.addEventListener('click', () => this._runProgressionNavAction('next', () => this._onProgressionNext()));
        if (prevBtn) prevBtn.addEventListener('click', () => this._runProgressionNavAction('prev', () => this._onProgressionPrev()));

        if (step.type === 'hp') {
            overlay.querySelectorAll('.hp-option-card').forEach(card => {
                card.addEventListener('click', async () => {
                    const currentChoice = state.hpGain !== null
                        ? { hp: state.hpGain, method: state.hpMethod, rollResult: state.hpRollResult }
                        : null;
                    if (isHitPointRollLocked(currentChoice) || state.hpRollInProgress) return;

                    const method = card.dataset.method;
                    if (this.levelUpManager && method === 'average') return;
                    const hitDie = this.levelUpManager.hitDie;
                    const conMod = this._getConstitutionModifier();
                    const wrapper = overlay.querySelector('.hp-options-wrapper');

                    if (method === 'roll') {
                        state.hpRollInProgress = true;
                        wrapper?.classList.add('hp-options-wrapper--rolling');
                    }

                    try {
                        const result = await resolveHitPointChoice({
                            currentChoice,
                            method,
                            level: state.targetLevel,
                            hitDie,
                            constitutionModifier: conMod
                        });
                        if (!result.changed) return;

                        const choice = result.choice;
                        state.hpGain = choice.hp;
                        state.hpMethod = choice.method;
                        state.hpRollResult = choice.rollResult;

                        if (choice.method === 'roll' && typeof this._persistLockedHitPointRoll === 'function') {
                            await this._persistLockedHitPointRoll(choice);
                        }

                        overlay.querySelectorAll('.hp-option-card').forEach(option => {
                            option.classList.toggle('selected', option.dataset.method === choice.method);
                        });

                        const resultDiv = overlay.querySelector('.hp-roll-result-container');
                        if (resultDiv) {
                            resultDiv.style.display = choice.method === 'roll' ? 'flex' : 'none';
                            if (choice.method === 'roll') {
                                resultDiv.querySelector('.hp-roll-text').innerHTML =
                                    game.i18n.format('ORIGINATE.UI.Progression.HPRollResult', {
                                        roll: choice.rollResult,
                                        mod: conMod,
                                        total: choice.hp
                                    });
                            }
                        }

                        if (choice.method === 'roll') {
                            wrapper?.classList.add('hp-options-wrapper--locked');
                            overlay.querySelectorAll('.hp-option-card').forEach(option => option.setAttribute('aria-disabled', 'true'));
                            result.roll?.toMessage({
                                speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                                flavor: game.i18n.format('ORIGINATE.UI.Progression.ClassLevelHPRoll', { className: this.levelUpManager.classItem?.name || 'Level', level: state.targetLevel })
                            });
                        }

                        this._checkProgressionCanProceed(overlay);
                        this._refreshLevelupStatusDrawer?.();
                    } finally {
                        state.hpRollInProgress = false;
                        wrapper?.classList.remove('hp-options-wrapper--rolling');
                    }
                });
            });
        } else if (step.type === 'asi_feat_choice') {
            // ASI/专长类型选择
            overlay.querySelectorAll('.asi-feat-type-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const type = btn.dataset.type;
                    overlay.querySelector('.asi-feat-selection').style.display = 'none';
                    if (type === 'asi') {
                        overlay.querySelector('.asi-content').style.display = 'block';
                    } else {
                        overlay.querySelector('.feat-content').style.display = 'block';
                    }
                    if (!state.stepData[step.id]) state.stepData[step.id] = {};
                    state.stepData[step.id].type = type;
                    this._checkProgressionCanProceed(overlay);
                });
            });
            // 返回选择按钮
            overlay.querySelectorAll('.back-to-selection-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    overlay.querySelector('.asi-content').style.display = 'none';
                    overlay.querySelector('.feat-content').style.display = 'none';
                    overlay.querySelector('.asi-feat-selection').style.display = 'flex';
                    if (state.stepData[step.id]) state.stepData[step.id].type = null;
                    this._checkProgressionCanProceed(overlay);
                });
            });
            // ASI 控制
            this._bindProgressionASIControls(overlay, step);
            this._bindFeatSearch(overlay);
            // 专长选择
            overlay.querySelector('.feat-content')?.addEventListener('change', event => {
                const input = event.target;
                if (!input.matches('input[name^="feat-choice-"]') || input.disabled) return;
                if (!state.stepData[step.id]) state.stepData[step.id] = {};
                state.stepData[step.id].uuid = input.dataset.featUuid || input.value;
                this._checkProgressionCanProceed(overlay);
            });
        } else if (step.type === 'item_choice') {
            this._bindProgressionItemChoices(overlay, step);
        } else if (step.type === 'spell_choice') {
            this._bindSpellBrowserEvents(overlay, step);
        } else if (step.type === 'spell_replacement') {
            this._bindSpellReplacementEvents(overlay, step);
        } else if (step.type === 'prepared_spell_grant') {
            // 准备型法表自动获得，无需用户交互
        } else if (step.type === 'trait_choice') {
            this._bindProgressionTraitChoices(overlay, step);
        } else if (step.type === 'subclass_selection') {
            bindSubclassSelectionPanel(overlay, step.subclassOptions, {
                selectedUuid: state.stepData[step.id]?.selectedSubclass || null,
                onSelect: option => {
                    if (!state.stepData[step.id]) state.stepData[step.id] = {};
                    state.stepData[step.id].selectedSubclass = option.uuid;
                    this._checkProgressionCanProceed(overlay);
                }
            });
        } else if (step.type === 'features') {
            // 自动获得特性 — 悬停预览由 _bindTooltips() 统一处理
        }
    }

    // ASI 控件绑定

    _bindProgressionASIControls(overlay, step) {
        const state = this._state;

        overlay.querySelectorAll('.asi-section').forEach(section => {
            const maxPoints = parseInt(section.dataset.points);
            const cap = parseInt(section.dataset.cap) || 2;
            const lockedStr = section.dataset.locked || '';
            const lockedAbilities = lockedStr ? lockedStr.split(',').filter(s => s) : [];

            const getUsedPoints = () => {
                let total = 0;
                section.querySelectorAll('.asi-value').forEach(span => {
                    total += parseInt(span.textContent) || 0;
                });
                return total;
            };

            const updateRemaining = () => {
                const remaining = maxPoints - getUsedPoints();
                const remainingSpan = section.querySelector('.asi-points-remaining');
                if (remainingSpan) {
                    remainingSpan.textContent = remaining;
                    remainingSpan.style.color = remaining === 0 ? '#4caf50' : (remaining < 0 ? '#f44336' : '');
                }
            };

            const updateModifierDisplay = (ability, addedValue) => {
                const card = section.querySelector(`.asi-card[data-ability="${ability}"]`);
                if (!card) return;
                const currentValueText = card.querySelector('.ability-current-value').textContent;
                const baseValue = parseInt(currentValueText.split(': ')[1]);
                const totalValue = baseValue + addedValue;
                const mod = Math.floor((totalValue - 10) / 2);
                const modDisplay = card.querySelector('.ability-modifier');
                if (modDisplay) {
                    modDisplay.textContent = mod >= 0 ? `+${mod}` : `${mod}`;
                    modDisplay.classList.remove('positive', 'negative', 'neutral');
                    if (mod > 0) modDisplay.classList.add('positive');
                    else if (mod < 0) modDisplay.classList.add('negative');
                    else modDisplay.classList.add('neutral');
                }
            };

            // 更新所有 ASI 增减按钮的 disabled 状态
            const updateButtonStates = () => {
                const remaining = maxPoints - getUsedPoints();
                section.querySelectorAll('.asi-card').forEach(card => {
                    const ability = card.dataset.ability;
                    const isLocked = lockedAbilities.includes(ability);
                    const valueSpan = card.querySelector(`.asi-value[data-ability="${ability}"]`);
                    const currentValue = parseInt(valueSpan?.textContent) || 0;

                    const incBtn = card.querySelector('.asi-increase');
                    if (incBtn) {
                        incBtn.disabled = isLocked || remaining <= 0 || currentValue >= cap;
                    }
                    const decBtn = card.querySelector('.asi-decrease');
                    if (decBtn) {
                        decBtn.disabled = isLocked || currentValue <= 0;
                    }
                });
            };

            section.querySelectorAll('.asi-increase').forEach(btn => {
                btn.addEventListener('click', () => {
                    const ability = btn.dataset.ability;
                    if (lockedAbilities.includes(ability)) return;
                    const valueSpan = section.querySelector(`.asi-value[data-ability="${ability}"]`);
                    const currentValue = parseInt(valueSpan.textContent) || 0;
                    if (getUsedPoints() >= maxPoints) return;
                    if (currentValue >= cap) return;
                    const newValue = currentValue + 1;
                    valueSpan.textContent = newValue;
                    updateRemaining();
                    updateModifierDisplay(ability, newValue);
                    updateButtonStates();
                    this._checkProgressionCanProceed(overlay);
                });
            });

            section.querySelectorAll('.asi-decrease').forEach(btn => {
                btn.addEventListener('click', () => {
                    const ability = btn.dataset.ability;
                    const valueSpan = section.querySelector(`.asi-value[data-ability="${ability}"]`);
                    const currentValue = parseInt(valueSpan.textContent) || 0;
                    if (currentValue <= 0) return;
                    const newValue = currentValue - 1;
                    valueSpan.textContent = newValue;
                    updateRemaining();
                    updateModifierDisplay(ability, newValue);
                    updateButtonStates();
                    this._checkProgressionCanProceed(overlay);
                });
            });

            // 初始化
            updateButtonStates();
        });
    }

    // 物品选择限制绑定

    _bindProgressionItemChoices(overlay, step = null) {
        overlay.querySelectorAll('.item-choice-section').forEach(section => {
            const isPureReplacement = section.dataset.pureReplacement === 'true';
            const syncDraft = () => {
                if (step) this._syncStepDraftFromOverlay(step, overlay);
            };

            if (isPureReplacement) {
                const modeRadios = section.querySelectorAll('input[name^="replacement-mode-"]');
                const interfaceDiv = section.querySelector('.replacement-interface');
                modeRadios.forEach(radio => {
                    radio.addEventListener('change', () => {
                        section.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
                        radio.closest('.mode-card')?.classList.add('selected');
                        if (interfaceDiv) interfaceDiv.style.display = radio.value === 'replace' ? 'block' : 'none';
                        syncDraft();
                        this._checkProgressionCanProceed(overlay);
                    });
                });
                section.querySelectorAll('input[type="radio"]').forEach(radio => {
                    if (radio.name.startsWith('replacement-mode-')) return;
                    radio.addEventListener('change', () => {
                        const container = radio.closest('.options-container');
                        if (container) {
                            container.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
                            radio.closest('.option-card')?.classList.add('selected');
                        }
                        syncDraft();
                        this._checkProgressionCanProceed(overlay);
                    });
                });
            } else {
                const max = parseInt(section.dataset.count);
                const checkboxes = section.querySelectorAll('.item-choices-list input[type="checkbox"]');
                const replacementToggle = section.querySelector('.enable-replacement');
                const replacementSelection = section.querySelector('.replacement-selection');

                if (replacementToggle) {
                    replacementToggle.addEventListener('change', () => {
                        if (replacementSelection) replacementSelection.style.display = replacementToggle.checked ? 'block' : 'none';
                        syncDraft();
                        this._checkProgressionCanProceed(overlay);
                    });
                    section.querySelectorAll('input[name^="replace-target-"]').forEach(radio => {
                        radio.addEventListener('change', () => {
                            section.querySelectorAll('.existing-item').forEach(c => c.classList.remove('selected'));
                            radio.closest('.existing-item')?.classList.add('selected');
                            syncDraft();
                            this._checkProgressionCanProceed(overlay);
                        });
                    });
                }

                checkboxes.forEach(cb => {
                    cb.addEventListener('change', () => {
                        const checked = section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked').length;
                        let allowed = max;
                        if (replacementToggle?.checked) allowed += 1;
                        if (checked > allowed) {
                            cb.checked = false;
                            ui.notifications.warn(game.i18n.format('ORIGINATE.UI.Progression.MaxSelectWarn', { count: allowed }));
                        } else {
                            if (cb.checked) cb.closest('.option-card')?.classList.add('selected');
                            else cb.closest('.option-card')?.classList.remove('selected');
                        }
                        syncDraft();
                        this._checkProgressionCanProceed(overlay);
                    });
                });
            }

            syncDraft();
        });
    }

    // 特质选择限制绑定

    _bindProgressionTraitChoices(overlay, step = null) {
        overlay.querySelectorAll('.trait-choice-section').forEach(section => {
            const max = parseInt(section.dataset.count);
            const checkboxes = section.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    const checked = section.querySelectorAll('input[type="checkbox"]:checked').length;
                    if (checked > max) {
                        cb.checked = false;
                        ui.notifications.warn(game.i18n.format('ORIGINATE.UI.Progression.MaxSelectWarn', { count: max }));
                    }
                    if (cb.checked) cb.closest('.option-card')?.classList.add('selected');
                    else cb.closest('.option-card')?.classList.remove('selected');
                    if (step) this._syncStepDraftFromOverlay(step, overlay);
                    this._checkProgressionCanProceed(overlay);
                });
            });
            if (step) this._syncStepDraftFromOverlay(step, overlay);
        });
    }

    // 法术浏览器事件绑定

    _bindSpellBrowserEvents(overlay, step) {
        const section = overlay.querySelector('.spell-browser-section');
        if (!section) return;

        const searchInput = section.querySelector('.spell-search-input');
        const schoolButtons = section.querySelectorAll('.school-btn');
        const classFilterContainer = section.querySelector('.class-filter-container');
        const resultsList = section.querySelector('.spell-results-list');
        const selectedList = section.querySelector('.selected-spells-list');
        const selectionCount = section.querySelector('.selection-count');
        const maxCount = parseInt(section.dataset.count);
        const restrictedLevel = section.dataset.restrictionLevel;

        let restriction = getSpellRestriction(step.event || step);

        // 这里先把各种来源的 list 收成统一 key，后面勾选扩展才不会被大小写坑到。
        if (restriction?.list) {
            restriction.list = normalizeSpellListIds(restriction.list).map(id => `class:${id}`);
        }

        let currentSchool = '';
        let currentLevel = '';
        let currentClassFilters = new Set();
        let currentSpells = [];
        const levelFilterContainer = section.querySelector('.level-filters');
        const levelButtons = section.querySelectorAll('.level-btn');
        const saveDraft = () => this._syncStepDraftFromOverlay(step, overlay);

        const attachSelectedSpellCard = (card) => {
            if (!card) return;
            const removeBtn = card.querySelector('.remove-icon');
            if (!removeBtn) return;

            removeBtn.onclick = (ev) => {
                ev.stopPropagation();
                card.remove();
                updateCount();
                syncSelectedState();
                saveDraft();
            };
        };

        // 初始化默认选择
        if (restriction.list && restriction.list.length > 0) {
            normalizeSpellListIds(restriction.list).forEach(id => currentClassFilters.add(id));
        }

        // 加载法表
        if (classFilterContainer) {
            (async () => {
                try {
                    const primaryContainer = classFilterContainer.querySelector('.primary-classes');
                    const subclassContainer = classFilterContainer.querySelector('.subclass-classes');
                    const subclassSection = classFilterContainer.querySelector('.subclass-section');
                    const subclassToggle = classFilterContainer.querySelector('.subclass-toggle');

                    const [spellClasses, classOptions, subclassOptions] = await Promise.all([
                        this.dataManager.getAvailableSpellClasses(),
                        this.dataManager.getOptions('class', {}, { indexOnly: true }),
                        this.dataManager.getOptions('subclass', {}, { indexOnly: true })
                    ]);

                    if (!spellClasses || spellClasses.length === 0) {
                        primaryContainer.innerHTML = `<div class="empty-hint">${game.i18n.localize('ORIGINATE.UI.NoSpellLists')}</div>`;
                        return;
                    }

                    const primaryMap = new Map(classOptions.map(c => [c.identifier, c]));
                    const primaryList = [];
                    const subclassList = [];
                    for (const cls of spellClasses) {
                        if (primaryMap.has(cls.id)) primaryList.push(cls);
                        else subclassList.push(cls);
                    }

                    const renderCheckbox = (cls) => {
                        const isRestricted = restriction.list && restriction.list.length > 0;
                        const filterId = normalizeSpellListId(cls.id);
                        const cleanList = isRestricted ? normalizeSpellListIds(restriction.list) : [];
                        const isInList = isRestricted ? cleanList.includes(filterId) : false;
                        let isChecked = currentClassFilters.has(filterId);
                        if (isInList) { isChecked = true; currentClassFilters.add(filterId); }
                        return `<label class="spell-filter-checkbox">
                        <input type="checkbox" value="${filterId}" ${isChecked ? 'checked' : ''}>
                        <span style="display:flex; flex-direction:column; line-height:1.2;">
                            <span>${cls.name}</span>
                            <span style="font-size: 0.7em; color: #888; font-family: monospace;">ID: ${filterId}</span>
                        </span>
                    </label>`;
                    };

                    primaryContainer.innerHTML = primaryList.map(renderCheckbox).join('');
                    subclassContainer.innerHTML = subclassList.map(renderCheckbox).join('');
                    if (subclassList.length === 0) subclassSection.style.display = 'none';
                    else {
                        subclassToggle?.addEventListener('click', () => {
                            const isCollapsed = subclassSection.classList.contains('collapsed');
                            subclassSection.classList.toggle('collapsed');
                            subclassContainer.style.display = isCollapsed ? 'flex' : 'none';
                            subclassToggle.querySelector('i').className = isCollapsed ? 'fas fa-caret-down' : 'fas fa-caret-right';
                        });
                    }

                    classFilterContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                        cb.addEventListener('change', () => {
                            if (cb.checked) currentClassFilters.add(cb.value);
                            else currentClassFilters.delete(cb.value);
                            refreshResults();
                        });
                    });

                    if (currentClassFilters.size > 0) refreshResults();
                } catch (e) {
                    console.error("Originate | [LevelUp] Failed to load spell class list:", e);
                }
            })();
        }

        const refreshResults = async () => {
            if (currentClassFilters.size === 0) {
                currentSpells = [];
                resultsList.innerHTML = `<div class="no-results">${game.i18n.localize('ORIGINATE.UI.SelectSpellListPrompt')}</div>`;
                return;
            }

            const searchRestriction = buildSpellBrowserSearchRestriction(restriction, currentClassFilters, restrictedLevel);
            // 'available' 是 DnD5e 的 "任意可使用等级" 特殊值，不应作为具体环阶传递
            const isNumericLevel = (restrictedLevel !== '' && restrictedLevel !== undefined && !isAvailableSpellLevel(restrictedLevel));

            // 当 restriction.level 未指定或为 'available' 时，自动推断最大可学环阶
            let computedMaxLevel = null;
            const hasExplicitLevel = isNumericLevel || (searchRestriction.level !== undefined && searchRestriction.level !== null && searchRestriction.level !== '' && !isAvailableSpellLevel(searchRestriction.level));
            if (!hasExplicitLevel) {
                // 优先使用 SpellRules 提供的 _maxLevel（已按正确的 progression 计算）
                if (step.event?._maxLevel != null) {
                    computedMaxLevel = step.event._maxLevel;
                    console.log(`Originate | [LevelUp] 使用 SpellRules._maxLevel=${computedMaxLevel}`);
                } else {
                    try {
                        const classItem = this.levelUpManager?.classItem;
                        const spellcastingType = classItem?.system?.spellcasting?.progression;
                        const charLevel = this._state?.targetLevel || this.levelUpManager?.currentLevel || 1;
                        console.log(`Originate | [LevelUp] 法术环阶推断: classItem="${classItem?.name}", spellcasting.progression="${spellcastingType}", charLevel=${charLevel}`);
                        if (spellcastingType) {
                            computedMaxLevel = this.dataManager.getMaxSpellLevel(spellcastingType, charLevel);
                            console.log(`Originate | [LevelUp] Auto-detected maxLevel=${computedMaxLevel} for "${spellcastingType}" caster at level ${charLevel}`);
                        } else {
                            computedMaxLevel = this.dataManager.getMaxSpellLevel('full', charLevel);
                            console.log(`Originate | [LevelUp] No spellcastingType found, fallback maxLevel=${computedMaxLevel} (full caster at level ${charLevel})`);
                        }
                    } catch (e) {
                        console.warn("Originate | [LevelUp] Failed to auto-detect max spell level:", e);
                    }
                }
            }

            try {
                let results = await this.dataManager.getSpellsByRestriction(searchRestriction, searchInput?.value, computedMaxLevel);

                // 标记已拥有的法术（变灰但不隐藏）
                // 同时检查 actor 已有法术和 blueprintData 中已选法术（跨步骤去重）
                // 使用名称和 UUID 双重检查，防止 Babele 翻译导致名称不匹配
                const existingSpellNames = new Set(
                    this.actor.items.filter(i => i.type === 'spell').map(i => i.name.toLowerCase())
                );
                if (typeof this._getObtainedItemNames === 'function') {
                    for (const name of this._getObtainedItemNames()) {
                        existingSpellNames.add(name.toLowerCase());
                    }
                }
                const existingSpellUuids = new Set(
                    this.actor.items.filter(i => i.type === 'spell').map(i =>
                        resolveItemSourceUuid(i)
                    ).filter(Boolean)
                );
                if (typeof this._getObtainedItemUuids === 'function') {
                    for (const uuid of this._getObtainedItemUuids()) {
                        existingSpellUuids.add(uuid);
                    }
                }
                results.forEach(s => {
                    s._owned = existingSpellNames.has(s.name.toLowerCase()) || existingSpellUuids.has(s.uuid);
                });

                // 非戏法步骤时过滤掉戏法（戏法有独立的选择步骤）
                // 必须检查闭包变量 restriction.level 而非 dataset 字符串，避免 0 的 falsy 问题
                const isCantrip = restriction.level === 0 || restriction.level === '0';
                if (!isCantrip) {
                    results = results.filter(s => {
                        const spellLevel = s.system?.level ?? s.level ?? 0;
                        return spellLevel > 0;
                    });
                }

                if (currentSchool) results = results.filter(s => s.school === currentSchool);
                if (currentLevel) results = results.filter(s => (s.system?.level ?? s.level ?? 0) === parseInt(currentLevel));
                if (currentClassFilters.size > 0) {
                    const classSpellMap = await this.dataManager.getClassSpellMap();
                    results = results.filter(s => {
                        const spellClasses = getSpellClassesForSpell(classSpellMap, s);
                        if (!spellClasses) return false;
                        return spellClassSetMatchesAny(spellClasses, currentClassFilters);
                    });
                }
                currentSpells = results;
                resultsList.innerHTML = this._generateSpellCards(results);
                bindCardEvents();
                this._bindTooltips(resultsList);
                syncSelectedState();
            } catch (e) {
                console.error("Originate | [LevelUp] Spell search error:", e);
                resultsList.innerHTML = `<div style="text-align:center;padding:2rem;color:#a44;">${game.i18n.format('ORIGINATE.UI.Error.SearchFailed', { error: e.message })}</div>`;
            }
        };

        const bindCardEvents = () => {
            resultsList.querySelectorAll('.spell-card').forEach(card => {
                card.addEventListener('dragstart', (ev) => {
                    ev.dataTransfer.setData("text/plain", JSON.stringify({
                        uuid: card.dataset.uuid,
                        type: "Item"
                    }));
                });

                card.addEventListener('click', () => addSelection(card.dataset.uuid));

                // Описание заклинания обрабатывается общим tooltip-механизмом по data-uuid.
            });
        };

        const addSelection = async (uuid) => {
            if (this.dataManager.isItemExcluded(uuid)) return;
            if (selectedList.children.length >= maxCount) {
                ui.notifications.warn(game.i18n.format('ORIGINATE.UI.Progression.MaxSelectWarn', { count: maxCount }));
                return;
            }
            if (selectedList.querySelector(`[data-uuid="${uuid}"]`)) return;
            // 检查是否已在之前步骤中选过（blueprintData 去重）
            if (typeof this._getObtainedItemUuids === 'function' && this._getObtainedItemUuids().has(uuid)) {
                ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.CannotSelectAgain') || '该法术已在之前的步骤中选择');
                return;
            }
            let spell = currentSpells.find(s => s.uuid === uuid);
            if (!spell) {
                const doc = await this.dataManager.getDocument(uuid);
                if (doc?.type === 'spell') spell = { uuid: doc.uuid, name: doc.name, img: doc.img, level: doc.system.level, school: doc.system.school };
            }
            if (!spell) return;
            if (!matchesSpellSchool(spell, restriction)) {
                ui.notifications.warn(spellSchoolHint(restriction));
                return;
            }
            // 按名称进行二次检查（UUID 不同但同名法术也应去重）
            if (typeof this._getObtainedItemNames === 'function' && this._getObtainedItemNames().has(spell.name)) {
                ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.CannotSelectAgain') || '该法术已在之前的步骤中选择');
                return;
            }
            const el = document.createElement('div');
            el.className = 'spell-card selected';
            el.dataset.uuid = uuid;
            el.dataset.level = spell.level ?? 0;
            el.dataset.school = spell.school || '';
            el.innerHTML = `<img src="${spell.img}" class="spell-icon"><div class="spell-name">${spell.name}</div><div class="remove-icon"><i class="fas fa-times"></i></div>`;
            attachSelectedSpellCard(el);
            selectedList.appendChild(el);
            this._bindTooltips(selectedList);
            updateCount();
            syncSelectedState();
            saveDraft();
        };

        // 同步浏览列表中的已选高亮状态 + 标记已拥有法术
        const syncSelectedState = () => {
            const selectedUuids = new Set(
                Array.from(selectedList.querySelectorAll('.spell-card')).map(c => c.dataset.uuid)
            );
            // 构建已拥有法术的 UUID 和名称集合（跨步骤去重）
            const ownedUuids = new Set();
            const ownedNames = new Set();
            if (typeof this._getObtainedItemUuids === 'function') {
                for (const uuid of this._getObtainedItemUuids()) ownedUuids.add(uuid);
            }
            if (typeof this._getObtainedItemNames === 'function') {
                for (const name of this._getObtainedItemNames()) ownedNames.add(name.toLowerCase());
            }
            // 也加入 actor 已有法术
            this.actor.items.filter(i => i.type === 'spell').forEach(i => {
                ownedNames.add(i.name.toLowerCase());
                const src = resolveItemSourceUuid(i);
                if (src) ownedUuids.add(src);
            });

            resultsList.querySelectorAll('.spell-card').forEach(card => {
                const uuid = card.dataset.uuid;
                const name = card.querySelector('.spell-name')?.textContent?.toLowerCase() || '';
                const isOwned = ownedUuids.has(uuid) || ownedNames.has(name);
                card.classList.toggle('spell-selected', selectedUuids.has(uuid));
                card.classList.toggle('owned-spell', isOwned && !selectedUuids.has(uuid));
            });
        };

        const updateCount = () => {
            selectionCount.textContent = selectedList.children.length;
            this._checkProgressionCanProceed(overlay);
        };

        let searchTimeout;
        searchInput?.addEventListener('input', () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(refreshResults, 300); });
        schoolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                schoolButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentSchool = btn.dataset.school;
                refreshResults();
            });
        });
        // 环阶筛选按钮（动态生成，等 computedMaxLevel 计算完后再渲染）
        const initLevelFilters = async () => {
            // 计算最大环阶
            let maxLvl = 9;
            try {
                const classItem = this.levelUpManager?.classItem;
                const spellcastingType = classItem?.system?.spellcasting?.progression;
                const charLevel = this._state?.targetLevel || this.levelUpManager?.currentLevel || 1;
                if (spellcastingType) {
                    maxLvl = this.dataManager.getMaxSpellLevel(spellcastingType, charLevel) || 9;
                }
            } catch (e) { /* fallback to 9 */ }

            if (levelFilterContainer) {
                // 如果是限定环阶，不显示筛选
                const isNumericLevel = (restrictedLevel !== '' && restrictedLevel !== undefined && !isAvailableSpellLevel(restrictedLevel));
                if (isNumericLevel) {
                    levelFilterContainer.closest('.filter-group')?.style.setProperty('display', 'none');
                } else {
                    let btns = `<button class="filter-btn level-btn active" data-level="">${game.i18n.localize('ORIGINATE.UI.AllLevels')}</button>`;
                    for (let i = 1; i <= maxLvl; i++) {
                        btns += `<button class="filter-btn level-btn" data-level="${i}">${game.i18n.format('ORIGINATE.SpellRules.SpellLevel', { level: i })}</button>`;
                    }
                    levelFilterContainer.innerHTML = btns;
                    levelFilterContainer.querySelectorAll('.level-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            levelFilterContainer.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
                            btn.classList.add('active');
                            currentLevel = btn.dataset.level;
                            refreshResults();
                        });
                    });
                }
            }
        };
        initLevelFilters();
        selectedList.querySelectorAll('.spell-card').forEach(attachSelectedSpellCard);
        updateCount();
        saveDraft();
        refreshResults();

        // 拖放支持
        section.addEventListener('dragover', (ev) => ev.preventDefault());
        section.addEventListener('drop', async (ev) => {
            ev.preventDefault();
            let data;
            try {
                data = JSON.parse(ev.dataTransfer.getData("text/plain"));
            } catch (e) { return; }

            if (data && data.uuid) {
                const item = await fromUuid(data.uuid);
                if (item && item.type === 'spell') {
                    addSelection(data.uuid);
                }
            }
        });
    }

    _generateSpellCards(spells) {
        if (!spells || spells.length === 0) {
            return `<div class="no-results">${game.i18n.localize('ORIGINATE.UI.NoResults')}</div>`;
        }

        return spells.map(spell => {
            // 处理职业标识
            let classTagsHtml = '';
            if (spell.sourceClass) {
                const classes = spell.sourceClass.split(/[,;|\/]/).map(c => c.trim()).filter(c => c);
                if (classes.length > 0) {
                    classTagsHtml = `<div class="spell-class-tags">
                    ${classes.map(c => {
                        const classConfig = CONFIG.DND5E.classFeatures?.[c.toLowerCase()] || CONFIG.DND5E.spellLists?.[c.toLowerCase()];
                        const label = classConfig?.label || (c.charAt(0).toUpperCase() + c.slice(1));
                        return `<span class="spell-class-tag">${label}</span>`;
                    }).join('')}
                </div>`;
                }
            }

            return `
        <div class="spell-card${spell._owned ? ' owned-spell' : ''}" data-uuid="${spell.uuid}" draggable="true">
            <img src="${spell.img}" class="spell-icon">
            <div class="spell-info">
                <div class="spell-name" title="${spell.name}">${spell.name}</div>
                <div class="spell-meta">
                    ${CONFIG.DND5E.spellLevels[spell.level] || ''} &bull; ${CONFIG.DND5E.spellSchools[spell.school]?.label || ''}
                </div>
                ${classTagsHtml}
            </div>
            <div class="add-icon"><i class="fas fa-plus-circle"></i></div>
        </div>
    `}).join('');
    }

    // 完成度只描述当前步骤，不能在这里决定创角或升级是否应该提交。

    _checkProgressionCanProceed(overlay) {
        const state = this._state;
        const currentStep = state.steps[state.currentStepIndex];
        const nextBtn = overlay.querySelector('#progression-next-btn');
        if (!currentStep || !nextBtn) {
            this._currentStepComplete = false;
            this._refreshLevelupStatusDrawer?.();
            return;
        }

        let canProceed = false;

        switch (currentStep.type) {
            case 'hp':
                canProceed = state.hpGain !== null;
                break;
            case 'features':
                canProceed = true;
                break;
            case 'asi_feat_choice': {
                const choiceData = state.stepData[currentStep.id];
                if (choiceData?.type === 'asi') {
                    const asiSection = overlay.querySelector('.asi-section');
                    if (asiSection) {
                        const maxPoints = parseInt(asiSection.dataset.points);
                        let usedPoints = 0;
                        asiSection.querySelectorAll('.asi-value').forEach(span => { usedPoints += parseInt(span.textContent) || 0; });
                        canProceed = usedPoints === maxPoints;
                    }
                } else if (choiceData?.type === 'feat') {
                    canProceed = this._isFeatDraftAvailable(currentStep.id, choiceData.uuid);
                }
                break;
            }
            case 'item_choice': {
                const section = overlay.querySelector('.item-choice-section');
                if (section) {
                    const isPureReplacement = section.dataset.pureReplacement === 'true';
                    if (isPureReplacement) {
                        const modeRadio = section.querySelector('input[name^="replacement-mode-"]:checked');
                        if (modeRadio?.value === 'none') canProceed = true;
                        else {
                            const replaceTarget = section.querySelector('input[name^="replace-target-"]:checked');
                            const newItem = section.querySelector('input[name^="item-choice-"]:checked');
                            canProceed = !!replaceTarget && !!newItem;
                        }
                    } else {
                        const max = parseInt(section.dataset.count);
                        const checked = section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked').length;
                        const replacementToggle = section.querySelector('.enable-replacement');
                        let required = max;
                        if (replacementToggle?.checked) {
                            required += 1;
                            if (!section.querySelector('input[name^="replace-target-"]:checked')) { canProceed = false; break; }
                        }
                        canProceed = checked === required;
                    }
                }
                break;
            }
            case 'trait_choice': {
                const traitSection = overlay.querySelector('.trait-choice-section');
                if (traitSection) {
                    const max = parseInt(traitSection.dataset.count);
                    const checked = traitSection.querySelectorAll('.skill-chips-container input[type="checkbox"]:checked').length;
                    canProceed = checked === max;
                }
                break;
            }
            case 'spell_choice': {
                const spellSection = overlay.querySelector('.spell-browser-section');
                if (spellSection) {
                    const max = parseInt(spellSection.dataset.count) || 1;
                    const selected = spellSection.querySelectorAll('.selected-spells-list .spell-card').length;
                    canProceed = selected >= max;
                }
                break;
            }
            case 'spell_replacement': {
                // 替换是可选的，用户可以选择跳过
                canProceed = true;
                break;
            }
            case 'prepared_spell_grant': {
                // 准备型法表自动获得，始终可以继续
                canProceed = true;
                break;
            }
            case 'subclass_selection':
                canProceed = !!state.stepData['subclass-selection']?.selectedSubclass;
                break;
        }

        const schoolRestriction = getSpellRestriction(currentStep.event || currentStep);
        const noReplacement = overlay.querySelector('[data-pure-replacement="true"] input[name^="replacement-mode-"]:checked')?.value === 'none';
        const selectedCards = noReplacement ? [] : overlay.querySelectorAll('.selected-spells-list .spell-card, .replacement-new-spell[data-uuid], .item-choices-list label:has(input:checked)');
        const invalidSchool = normalizeSpellSchools(schoolRestriction.school).length > 0
            && Array.from(selectedCards).some(card => card.dataset.uuid && !matchesSpellSchool({ school: card.dataset.school }, schoolRestriction));
        for (const card of selectedCards) {
            card.setAttribute('aria-invalid', String(!!card.dataset.uuid && !matchesSpellSchool({ school: card.dataset.school }, schoolRestriction)));
        }
        nextBtn.disabled = invalidSchool;
        overlay.querySelectorAll('[data-school-error]').forEach(message => { message.hidden = !invalidSchool; });
        if (invalidSchool) canProceed = false;
        this._currentStepComplete = canProceed;
        this._refreshLevelupStatusDrawer?.();
    }
}
