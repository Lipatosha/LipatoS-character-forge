/**
 * LevelUpApp - 现有角色的真实升级向导
 *
 * 它和创角 ProgressionMixin 只共用 WizardUIMixin 的步骤渲染与控件事件。
 * 本类持有自己的 pending state，并通过 LevelUpManager 写入现有 Actor；创角则先累积 blueprint，
 * 最后走 CharacterFinalizeService。两边的开始、回退、完成和异常恢复都必须独立维护。
 */

import { DataManager } from './data-manager-v2.js';
import { consumeActorLevelUpGrant } from './creation-grants.js';
import { releaseForgeStyles } from './runtime-style.js';
import { SpellRules } from './spell-rules.js';
import { usesSpellBrowser } from './shared/advancement-choice-rules.js';
import { LevelUpManager } from './levelup-manager.js';
import { getToolsByCategory, getWeaponLabel, getToolLabel, normalizeToolId } from './mapping.js';
import { getThemeClassList } from './theme-registry.js';
import { getAdvancementCount, hasAdvancementEntries } from './utils/advancement-utils.js';
import {
    cleanDescription, getFullCleanDescription, processHtmlDescription,
    traverseLanguageTree, findLanguageLabel, getTraitLabel, expandWildcardPool,
    showConfirmDialog, generateSpellCards,
    bindTooltips, updateTooltipPosition
} from './shared/progression-renderer.js';
import {
    applyPreparedListSpell,
    applySpellConfigToItemData,
    mergeSpellDuplicateData,
    normalizeSpellItemData
} from './shared/advancement-rule-utils.js';
import { resolveItemSourceUuid } from './shared/resolution-core.js';
import { getSpellClassesForSpell, spellClassSetMatchesAny } from './shared/spell-list-filters.js';
import { WizardUIMixin } from './shared/wizard-ui-mixin.js';
import {
    bindButtonSounds,
    LEVELUP_SOUND_SELECTORS,
    playOriginateSound
} from './shared/ui-sounds.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function ensureSpellChoiceRestriction(event) {
    if (!event || event.restriction) return;
    if (event._original?.configuration?.spell) {
        event.restriction = event._original.configuration.spell;
    } else if (event.spellConfig) {
        event.restriction = event.spellConfig;
    }
}

function normalizeTrackedUuid(itemData) {
    const sourceUuid = resolveItemSourceUuid(itemData);
    return sourceUuid?.replace(/\.Item\./, '.') || null;
}

export class LevelUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
        this.dataManager = options.dataManager
            || game.modules.get('character-forge')?.api?.dataManager
            || new DataManager();
        this.levelUpManager = new LevelUpManager(actor, this.dataManager);

        this._state = {
            targetLevel: this.levelUpManager.currentLevel + 1,
            currentStepIndex: 0,
            steps: [],
            stepData: {},
            stepHistory: {},
            hpGain: null,
            hpMethod: null,
            hpRollResult: null,
            hpRollInProgress: false,
            pendingItems: [],
            pendingItemUpdates: [],
            pendingReplacements: [],
            asiChanges: {},
            pendingTraitChanges: [],
            abilityScoreImprovements: [],
            selectedFeats: []
        };
        this._currentStepComplete = false;
        this._cancelLevelUpConfirmOpen = false;
        this._statusDrawerOpen = false;
        this._statusDrawerTab = 'features';
    }

    static DEFAULT_OPTIONS = {
        tag: "div",
        id: "originate-levelup",
        classes: ["originate-app", "originate-levelup-app", "originate-status-host"],
        position: { width: "100%", height: "100%" },
        window: { frame: false, positioned: false },
        actions: {}
    };

    static PARTS = {
        main: { template: "modules/character-forge/templates/levelup.hbs" }
    };

    get title() {
        return game.i18n.format("ORIGINATE.LevelUp.TitleWithLevel", {
            name: this.actor.name, level: this._state.targetLevel
        });
    }

    async _playSound(type) {
        return playOriginateSound(type);
    }

    async _prepareContext(options) {
        return {
            actor: this.actor,
            currentLevel: this.levelUpManager.currentLevel,
            targetLevel: this._state.targetLevel,
            isLoading: this._state.steps.length === 0
        };
    }

    async _onRender(context, options) {
        super._onRender(context, options);
        document.body.classList.add("originate-active");
        this._hideConflictingUI();
        bindButtonSounds(this.element, {
            selectors: LEVELUP_SOUND_SELECTORS,
            playSound: type => this._playSound(type)
        });

        const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
        // 元素跨渲染持久，裸 add 不清旧类的话，切过主题后会双主题共存——先按注册表清一遍
        this.element.classList.remove(...getThemeClassList().split(' '));
        this.element.classList.add('originate-container', `theme-${visualTheme}`);
        const closeButton = this.element.querySelector('.originate-close-btn');
        if (closeButton && closeButton.dataset.levelupCancelBound !== 'true') {
            closeButton.dataset.levelupCancelBound = 'true';
            closeButton.addEventListener('click', event => {
                event.preventDefault();
                void this._onCancelLevelUp();
            });
        }
        this._renderLevelupExitButton();
        this._renderLevelupStatusDrawer();

        if (this._state.steps.length === 0) {
            await this._startLevelUp();
        } else {
            await this._renderCurrentStep();
        }
    }

    _renderLevelupExitButton() {
        const root = this.element;
        if (!root || root.querySelector('.levelup-exit-button')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'levelup-exit-button';
        button.title = game.i18n.localize('ORIGINATE.LevelUp.Cancel.Tooltip');
        button.innerHTML = `<i class="fas fa-arrow-left"></i><span>${game.i18n.localize('ORIGINATE.LevelUp.Cancel.Button')}</span>`;
        button.addEventListener('click', event => {
            event.preventDefault();
            void this._onCancelLevelUp();
        });
        root.appendChild(button);
    }

    async _onCancelLevelUp() {
        if (this._cancelLevelUpConfirmOpen) return;

        this._cancelLevelUpConfirmOpen = true;
        let confirmed = false;
        try {
            confirmed = await this._showConfirmDialog({
                title: game.i18n.localize('ORIGINATE.LevelUp.Cancel.Title'),
                content: `
                    <p>${game.i18n.localize('ORIGINATE.LevelUp.Cancel.Content')}</p>
                    <p>${game.i18n.localize('ORIGINATE.LevelUp.Cancel.Warning')}</p>
                `,
                yesLabel: game.i18n.localize('ORIGINATE.LevelUp.Cancel.Confirm'),
                noLabel: game.i18n.localize('ORIGINATE.LevelUp.Cancel.KeepGoing'),
                defaultYes: false
            });
        } finally {
            this._cancelLevelUpConfirmOpen = false;
        }

        if (!confirmed) return;
        await this.close();
    }

    _renderLevelupStatusDrawer() {
        // 升级步骤本身是 fixed 高层级浮层，抽屉必须挂在 app 根上，不然会被步骤界面盖住。
        const root = this.element;
        if (!root) return;

        let toggle = root.querySelector('.levelup-status-toggle');
        let drawer = root.querySelector('.levelup-status-drawer');

        if (!toggle) {
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'levelup-status-toggle';
            toggle.innerHTML = `<i class="fas fa-id-card"></i><span>${game.i18n.localize('ORIGINATE.LevelUp.Status.Toggle')}</span>`;
            toggle.addEventListener('click', () => {
                this._statusDrawerOpen = !this._statusDrawerOpen;
                this._syncLevelupStatusDrawerState();
            });
            root.appendChild(toggle);
        }

        if (!drawer) {
            drawer = document.createElement('aside');
            drawer.className = 'levelup-status-drawer';
            drawer.innerHTML = `
                <div class="levelup-status-header">
                    <div>
                        <div class="levelup-status-kicker">${game.i18n.localize('ORIGINATE.LevelUp.Status.Kicker')}</div>
                        <h3>${game.i18n.localize('ORIGINATE.LevelUp.Status.Title')}</h3>
                    </div>
                    <button type="button" class="levelup-status-close" title="${game.i18n.localize('ORIGINATE.LevelUp.Status.Close')}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="levelup-status-body"></div>
            `;
            drawer.querySelector('.levelup-status-close')?.addEventListener('click', () => {
                this._statusDrawerOpen = false;
                this._syncLevelupStatusDrawerState();
            });
            drawer.addEventListener('click', event => {
                const tabButton = event.target.closest('[data-status-tab]');
                if (!tabButton) return;
                this._statusDrawerTab = tabButton.dataset.statusTab || 'features';
                this._refreshLevelupStatusDrawer();
            });
            root.appendChild(drawer);
        }

        this._syncLevelupStatusDrawerState();
        this._refreshLevelupStatusDrawer();
    }

    _syncLevelupStatusDrawerState() {
        const drawer = this.element?.querySelector('.levelup-status-drawer');
        const toggle = this.element?.querySelector('.levelup-status-toggle');
        drawer?.classList.toggle('open', this._statusDrawerOpen);
        drawer?.setAttribute('aria-hidden', String(!this._statusDrawerOpen));
        toggle?.classList.toggle('active', this._statusDrawerOpen);
        toggle?.setAttribute('aria-expanded', String(this._statusDrawerOpen));
    }

    _refreshLevelupStatusDrawer() {
        const body = this.element?.querySelector('.levelup-status-body');
        if (!body) return;

        body.innerHTML = this._renderLevelupStatusSnapshot(this._buildLevelupStatusSnapshot());
        this._bindTooltips(body);
    }

    _buildLevelupStatusSnapshot() {
        const actor = this.actor;
        const state = this._state;
        const actorItems = Array.from(actor?.items || []);
        const classes = actorItems
            .filter(item => item.type === 'class')
            .map(item => ({
                name: item.name,
                detail: item.system?.levels ? game.i18n.format('ORIGINATE.LevelUp.Status.LevelCount', { level: item.system.levels }) : ''
            }));
        const subclasses = actorItems
            .filter(item => item.type === 'subclass')
            .map(item => ({ name: item.name, detail: item.system?.classIdentifier || '' }));
        const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key => ({
            key,
            label: game.i18n.localize(`ORIGINATE.Ability.${key.charAt(0).toUpperCase()}${key.slice(1)}`),
            value: actor.system?.abilities?.[key]?.value ?? 10
        }));
        const features = actorItems
            .filter(item => item.type === 'feat')
            .map(item => this._buildLevelupStatusItemEntry(item));
        const spells = actorItems
            .filter(item => item.type === 'spell')
            .sort((a, b) => (a.system?.level ?? 0) - (b.system?.level ?? 0) || a.name.localeCompare(b.name))
            .map(item => this._buildLevelupStatusItemEntry(
                item,
                this._formatLevelupStatusSpellLevel(item.system?.level ?? 0)
            ));

        return {
            actor: {
                name: actor.name,
                img: actor.img,
                currentLevel: this.levelUpManager.currentLevel,
                targetLevel: state.targetLevel,
                classes,
                subclasses,
                abilities,
                features,
                spells
            },
            draft: this._buildLevelupDraftStatus()
        };
    }

    _buildLevelupDraftStatus() {
        const state = this._state;
        const entries = [];
        const push = (kind, label, detail = '', extra = {}) => {
            const text = String(label || '').trim();
            if (!text) return;
            entries.push({ kind, label: text, detail: String(detail || '').trim(), ...extra });
        };

        if (state.hpGain !== null && state.hpGain !== undefined) {
            push('hp', game.i18n.localize('ORIGINATE.LevelUp.Status.HP'), `+${state.hpGain}`);
        }

        for (const [ability, value] of Object.entries(state.asiChanges || {})) {
            if (!value) continue;
            push('asi', this._formatLevelupStatusAbility(ability), `+${value}`);
        }

        for (const entry of state.abilityScoreImprovements || []) {
            for (const [ability, value] of Object.entries(entry.value || {})) {
                if (!value) continue;
                push('asi', this._formatLevelupStatusAbility(ability), `+${value}`);
            }
        }

        for (const feat of state.selectedFeats || []) {
            push('feat', feat.name || feat.uuid, game.i18n.localize('ORIGINATE.LevelUp.Status.SelectedFeat'));
        }

        for (const pending of state.pendingItems || []) {
            const item = pending.itemData || {};
            push(item.type || 'item', item.name, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingItem'), {
                uuid: item.uuid || item._sourceUuid || '',
                img: item.img,
                tooltipHtml: item.system?.description?.value || ''
            });
        }

        for (const change of state.pendingTraitChanges || []) {
            push('trait', this._formatLevelupStatusTrait(change.key), game.i18n.localize('ORIGINATE.LevelUp.Status.PendingTrait'));
        }

        this._collectLiveStepStatus(entries);
        return this._dedupeLevelupStatusEntries(entries);
    }

    _buildLevelupStatusItemEntry(item, detail = '') {
        return {
            name: item.name,
            detail,
            img: item.img,
            uuid: item.uuid,
            tooltipHtml: item.system?.description?.value || ''
        };
    }

    _collectLiveStepStatus(entries) {
        // 这里只读当前步骤的 DOM 草稿，别调用 _syncStepDraftFromOverlay；状态抽屉不能顺手改提交流程。
        const state = this._state;
        const currentStep = state.steps[state.currentStepIndex];
        const overlay = this.element?.querySelector('.originate-progression-wizard');
        if (!currentStep || !overlay) return;

        const push = (kind, label, detail = '') => {
            const text = String(label || '').trim();
            if (!text) return;
            entries.push({ kind, label: text, detail: String(detail || '').trim() });
        };

        if (currentStep.type === 'asi_feat_choice') {
            const checkedFeat = overlay.querySelector('input[name^="feat-choice-"]:checked');
            if (checkedFeat) {
                const card = checkedFeat.closest('.feat-option');
                push('feat', card?.querySelector('.feature-name')?.textContent || checkedFeat.value, game.i18n.localize('ORIGINATE.LevelUp.Status.SelectedFeat'));
            }

            overlay.querySelectorAll('.asi-card').forEach(card => {
                const ability = card.dataset.ability;
                const value = parseInt(card.querySelector(`.asi-value[data-ability="${ability}"]`)?.textContent || '0') || 0;
                if (ability && value > 0) push('asi', this._formatLevelupStatusAbility(ability), `+${value}`);
            });
            return;
        }

        if (currentStep.type === 'spell_choice') {
            overlay.querySelectorAll('.selected-spells-list .spell-card').forEach(card => {
                push('spell', card.querySelector('.spell-name')?.textContent || card.dataset.uuid, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingSpell'));
            });
            return;
        }

        if (currentStep.type === 'item_choice') {
            overlay.querySelectorAll('.item-choices-list input[type="checkbox"]:checked, input[name^="item-choice-"]:checked').forEach(input => {
                const card = input.closest('label') || input.closest('.option-card');
                const name = card?.querySelector('.feature-title, .item-name, .feature-name')?.textContent || input.value;
                push('item', name, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingItem'));
            });
            return;
        }

        if (currentStep.type === 'trait_choice') {
            overlay.querySelectorAll('.trait-choice-section input[type="checkbox"]:checked').forEach(input => {
                const label = input.closest('label')?.textContent || input.value;
                push('trait', label, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingTrait'));
            });
        }
    }

    _dedupeLevelupStatusEntries(entries) {
        const seen = new Set();
        return entries.filter(entry => {
            const key = `${entry.kind}|${entry.label}|${entry.detail}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _renderLevelupStatusSnapshot(snapshot) {
        const actor = snapshot.actor;
        return `
            <section class="levelup-status-hero">
                <img src="${this._escapeLevelupStatusText(actor.img || 'icons/svg/mystery-man.svg')}" alt="">
                <div>
                    <h4>${this._escapeLevelupStatusText(actor.name)}</h4>
                    <div class="levelup-status-subtitle">
                        ${game.i18n.format('ORIGINATE.LevelUp.Status.LevelRange', {
                current: actor.currentLevel,
                target: actor.targetLevel
            })}
                    </div>
                </div>
            </section>
            ${this._renderLevelupStatusSection('ORIGINATE.LevelUp.Status.Classes', actor.classes)}
            ${this._renderLevelupStatusSection('ORIGINATE.LevelUp.Status.Subclasses', actor.subclasses)}
            ${this._renderLevelupStatusAbilities(actor.abilities)}
            ${this._renderLevelupStatusLibrary(actor)}
            ${this._renderLevelupStatusDraft(snapshot.draft)}
        `;
    }

    _renderLevelupStatusLibrary(actor) {
        const activeTab = this._statusDrawerTab === 'spells' ? 'spells' : 'features';
        const tabs = [
            { id: 'features', labelKey: 'ORIGINATE.LevelUp.Status.Features', count: actor.features.length },
            { id: 'spells', labelKey: 'ORIGINATE.LevelUp.Status.Spells', count: actor.spells.length }
        ];
        const entries = activeTab === 'spells' ? actor.spells : actor.features;
        const emptyKey = activeTab === 'spells' ? 'ORIGINATE.LevelUp.Status.NoSpells' : 'ORIGINATE.LevelUp.Status.NoFeatures';

        return `
            <section class="levelup-status-section levelup-status-library">
                <div class="levelup-status-tabs" role="tablist">
                    ${tabs.map(tab => `
                        <button type="button" class="${tab.id === activeTab ? 'active' : ''}"
                            data-status-tab="${tab.id}" role="tab" aria-selected="${tab.id === activeTab}">
                            ${game.i18n.localize(tab.labelKey)}
                            <span>${tab.count}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="levelup-status-list">
                    ${this._renderLevelupStatusRows(entries, emptyKey)}
                </div>
            </section>
        `;
    }

    _renderLevelupStatusSection(titleKey, entries = [], emptyKey = 'ORIGINATE.LevelUp.Status.Empty') {
        return `
            <section class="levelup-status-section">
                <h5>${game.i18n.localize(titleKey)}</h5>
                <div class="levelup-status-list">
                    ${this._renderLevelupStatusRows(entries, emptyKey)}
                </div>
            </section>
        `;
    }

    _renderLevelupStatusRows(entries = [], emptyKey = 'ORIGINATE.LevelUp.Status.Empty') {
        const visibleEntries = entries.slice(0, 40);
        const extraCount = Math.max(0, entries.length - visibleEntries.length);
        const rows = visibleEntries.map(entry => this._renderLevelupStatusRow(entry)).join('');
        const more = extraCount > 0
            ? `<div class="levelup-status-more">${game.i18n.format('ORIGINATE.LevelUp.Status.More', { count: extraCount })}</div>`
            : '';

        return rows
            ? `${rows}${more}`
            : `<div class="levelup-status-empty">${game.i18n.localize(emptyKey)}</div>`;
    }

    _renderLevelupStatusAbilities(abilities) {
        return `
            <section class="levelup-status-section">
                <h5>${game.i18n.localize('ORIGINATE.LevelUp.Status.Abilities')}</h5>
                <div class="levelup-status-abilities">
                    ${abilities.map(ability => `
                        <div class="levelup-status-ability">
                            <span>${this._escapeLevelupStatusText(ability.label)}</span>
                            <strong>${this._escapeLevelupStatusText(ability.value)}</strong>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }

    _renderLevelupStatusDraft(entries) {
        return `
            <section class="levelup-status-section levelup-status-draft">
                <h5>${game.i18n.localize('ORIGINATE.LevelUp.Status.ThisUpgrade')}</h5>
                <div class="levelup-status-list">
                    ${entries.map(entry => this._renderLevelupStatusRow(entry)).join('') || `<div class="levelup-status-empty">${game.i18n.localize('ORIGINATE.LevelUp.Status.NoDraft')}</div>`}
                </div>
            </section>
        `;
    }

    _renderLevelupStatusRow(entry) {
        const uuid = entry.uuid
            ? ` data-uuid="${this._escapeLevelupStatusText(entry.uuid)}"`
            : '';
        const tooltip = entry.tooltipHtml
            ? ` data-originate-tooltip-html="${this._escapeLevelupStatusText(entry.tooltipHtml)}"`
            : '';
        return `
            <div class="levelup-status-row"${tooltip}${uuid}>
                ${entry.img ? `<img src="${this._escapeLevelupStatusText(entry.img)}" alt="">` : ''}
                <div>
                    <span class="feature-title">${this._escapeLevelupStatusText(entry.name || entry.label)}</span>
                    ${entry.detail ? `<small>${this._escapeLevelupStatusText(entry.detail)}</small>` : ''}
                </div>
            </div>
        `;
    }

    _formatLevelupStatusAbility(ability) {
        const key = String(ability || '').toLowerCase();
        return game.i18n.localize(`ORIGINATE.Ability.${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    }

    _formatLevelupStatusSpellLevel(level) {
        const spellLevel = Number(level) || 0;
        if (spellLevel <= 0) return game.i18n.localize('ORIGINATE.LevelUp.Status.Cantrip');
        return game.i18n.format('ORIGINATE.LevelUp.Status.SpellLevel', { level: spellLevel });
    }

    _formatLevelupStatusTrait(key) {
        const [type, value] = String(key || '').split(':');
        if (type === 'skills') return game.i18n.localize(CONFIG.DND5E.skills?.[value]?.label || value);
        if (type === 'tool') return getToolLabel(value);
        if (type === 'weapon') return getWeaponLabel(value);
        return value || key;
    }

    _escapeLevelupStatusText(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    /**
     * 升级入口：检查兼职扩展设置
     * 如果启用了兼职系统，先显示职业选择界面；否则直接走正常流程。
     */
    async _startLevelUp() {
        let useMulticlass = false;
        try {
            useMulticlass = game.settings.get('character-forge', 'useMulticlass');
        } catch (e) { /* 设置不存在时默认关闭 */ }

        if (useMulticlass) {
            const { MulticlassExtension } = await import('./multiclass-extension.js');
            this._multiclass = new MulticlassExtension(this, this.levelUpManager, this.dataManager);
            await this._multiclass.renderClassSelection(this.element);
        } else {
            await this._loadLevelFeatures();
        }
    }

    /**
     * 职业选择完成后的回调（由 MulticlassExtension 调用）
     */
    async _onClassSelected() {
        // 移除职业选择界面
        const overlay = this.element.querySelector('.originate-progression-wizard');
        if (overlay) overlay.remove();

        // 继续正常的升级流程
        await this._loadLevelFeatures();
    }

    // ========================================================================
    // 数据适配层：从 Actor 读取数据（替代 blueprintData/context）
    // ========================================================================

    /**
     * 获取指定属性的当前值（含已分配的 ASI）
     */
    _getCurrentAbilityValue(ab) {
        const baseValue = this.actor.system.abilities?.[ab]?.value || 10;
        const asiBonus = this._state.asiChanges[ab] || 0;

        // 加上 feat ASI 的加成
        let featBonus = 0;
        for (const [stepId, data] of Object.entries(this._state.stepData)) {
            if (data?.featAsi?.[ab]) {
                featBonus += data.featAsi[ab];
            }
        }

        return baseValue + asiBonus + featBonus;
    }

    /**
     * 获取体质调整值（含 ASI 加成）
     */
    _getConstitutionModifier() {
        const conValue = this._getCurrentAbilityValue('con');
        return Math.floor((conValue - 10) / 2);
    }

    /**
     * 获取已知物品名称集合
     */
    _getObtainedItemNames() {
        const names = new Set();
        for (const item of this.actor.items) {
            names.add(item.name);
        }
        // 也包含本次升级待添加的
        for (const pending of this._state.pendingItems) {
            if (pending.itemData?.name) names.add(pending.itemData.name);
        }
        return names;
    }

    /**
     * 获取已知物品 UUID 集合
     */
    _getObtainedItemUuids() {
        const uuids = new Set();
        for (const item of this.actor.items) {
            const sourceId = resolveItemSourceUuid(item);
            if (sourceId) uuids.add(sourceId);
            if (item.uuid) uuids.add(item.uuid);
        }
        return uuids;
    }

    /**
     * 获取已拥有的特质集合
     */
    _getKnownTraits() {
        const known = new Set();
        const traits = this.actor.system?.traits || {};

        // 技能
        if (this.actor.system?.skills) {
            for (const [key, skill] of Object.entries(this.actor.system.skills)) {
                const profLevel = skill.value ?? skill.proficient ?? 0;
                if (profLevel >= 1) known.add(`skills:${key}`);
                if (profLevel >= 2) known.add(`expertise:${key}`);
            }
        }
        // 语言
        if (traits.languages?.value) {
            for (const lang of traits.languages.value) known.add(`languages:${lang}`);
        }
        // 武器/护甲/工具
        if (traits.weaponProf?.value) {
            for (const w of traits.weaponProf.value) known.add(`weapon:${w}`);
        }
        if (traits.weaponProf?.mastery?.value) {
            for (const w of traits.weaponProf.mastery.value) known.add(`weaponMastery:${w}`);
        }
        if (traits.weaponMastery?.value) {
            for (const w of traits.weaponMastery.value) known.add(`weaponMastery:${w}`);
        }
        if (traits.armorProf?.value) {
            for (const a of traits.armorProf.value) known.add(`armor:${a}`);
        }
        if (traits.toolProf?.value) {
            for (const t of traits.toolProf.value) {
                const toolId = normalizeToolId(t);
                if (toolId) known.add(`tool:${toolId}`);
            }
        }
        // pending 变更
        for (const change of this._state.pendingTraitChanges) {
            known.add(change.key);
            if (change.mode === 'expertise' && change.key?.startsWith('skills:')) {
                known.add(`expertise:${change.key.split(':')[1]}`);
            }
        }
        return known;
    }

    _shouldDebugTraitKey(key = '') {
        const normalizedKey = String(key || '');
        return normalizedKey.startsWith('skills:')
            || normalizedKey.startsWith('skill:')
            || normalizedKey.startsWith('tool:')
            || normalizedKey.startsWith('tools:');
    }

    _shouldDebugTraitEvent(event = {}) {
        if (!event) return false;

        const pool = Array.isArray(event.pool)
            ? event.pool
            : Array.from(event.pool || []);
        const grants = Array.isArray(event.grants)
            ? event.grants
            : Array.from(event.grants || []);

        return pool.some(key => this._shouldDebugTraitKey(key))
            || grants.some(key => this._shouldDebugTraitKey(key));
    }

    _logTraitStepDebug(message, payload = undefined) {
        if (payload === undefined) {
            window.OriginateLog(`Originate | [LevelUp][TraitDebug] ${message}`);
            return;
        }

        window.OriginateLog(`Originate | [LevelUp][TraitDebug] ${message}`, payload);
    }

    _snapshotTraitState() {
        const skills = {};
        for (const [key, skill] of Object.entries(this.actor?.system?.skills || {})) {
            const value = Number(skill?.value ?? skill?.proficient ?? 0);
            if (value > 0) skills[key] = value;
        }

        const tools = {};
        for (const [key, tool] of Object.entries(this.actor?.system?.tools || {})) {
            const value = Number(tool?.value ?? 0);
            if (value <= 0) continue;
            tools[key] = {
                value,
                ability: tool?.ability || null
            };
        }

        return {
            skills,
            tools,
            toolProf: Array.from(this.actor?.system?.traits?.toolProf?.value || [])
        };
    }

    /**
     * 获取子职获得等级
     */
    async _getSubclassLevel() {
        const classItem = this.levelUpManager.classItem;
        if (!classItem) return 3;
        const configData = game.settings.get('character-forge', 'data');
        const classIdentifier = classItem.system?.identifier;
        if (classIdentifier) {
            for (const [key, config] of Object.entries(configData.classs || {})) {
                if (config.identifier === classIdentifier && config.subclassLevel !== undefined)
                    return config.subclassLevel;
            }
        }
        return 3;
    }

    _safeNestedStepIdPart(value) {
        return String(value || 'advancement')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'advancement';
    }

    _getAdvancementEventId(event) {
        return event?._original?._id || event?.id || event?.title || 'advancement';
    }

    _buildNestedStepId(prefix, advId, level, parentSourceUuid = null) {
        const parentKey = parentSourceUuid?.split?.('.')?.pop?.() || parentSourceUuid || '';
        return [
            prefix,
            this._safeNestedStepIdPart(advId),
            level,
            parentKey ? this._safeNestedStepIdPart(parentKey) : null
        ].filter(Boolean).join('-');
    }

    _buildNestedAsiStep(event, { parentName, parentSourceUuid, stepType, level }) {
        const fixed = event.fixed || event._original?.configuration?.fixed || {};
        let points = event.points;
        if (points === undefined) {
            points = Object.keys(fixed).length > 0 ? 0 : 1;
        }

        const advId = this._getAdvancementEventId(event);
        return {
            id: this._buildNestedStepId('nested-asi', advId, level, parentSourceUuid),
            type: 'asi_feat_choice',
            title: `${parentName}: ${event.title || game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}`,
            points,
            cap: event.cap || 2,
            locked: Array.from(event.locked || []),
            stepType,
            advId: event.id || event._original?._id,
            parentFeature: parentName,
            parentSourceUuid,
            asiOnly: true,
            fixed
        };
    }

    async _appendNestedAdvancementEventSteps(events, {
        parentName,
        parentSourceUuid,
        stepType,
        level,
        featureBucket,
        stepBucket,
        seen = new Set()
    }) {
        for (const nestedEvent of events || []) {
            const advId = this._getAdvancementEventId(nestedEvent);
            const eventKey = `event:${parentSourceUuid || parentName}:${advId}:${level}`;
            if (seen.has(eventKey)) continue;
            seen.add(eventKey);

            nestedEvent.sourceLevel = nestedEvent.sourceLevel ?? level;
            nestedEvent.parentFeature = nestedEvent.parentFeature || parentName;
            nestedEvent.parentSourceUuid = nestedEvent.parentSourceUuid || parentSourceUuid;

            if (nestedEvent.type === 'features') {
                const nestedItems = Array.isArray(nestedEvent.items) ? nestedEvent.items.filter(Boolean) : [];
                for (const nestedItem of nestedItems) {
                    await this._collectGrantedFeature(nestedItem, {
                        stepType,
                        advancementId: advId,
                        level,
                        featureBucket,
                        stepBucket,
                        spellConfig: nestedEvent.spellConfig || nestedEvent._original?.configuration?.spell || null,
                        parentFeature: parentName,
                        parentSourceUuid,
                        seen
                    });
                }
                continue;
            }

            if (nestedEvent.type === 'trait_choice') {
                stepBucket.push({
                    id: this._buildNestedStepId('nested-trait', advId, level, parentSourceUuid),
                    type: 'trait_choice',
                    title: `${parentName}: ${nestedEvent.title}`,
                    event: nestedEvent,
                    stepType,
                    advId,
                    parentFeature: parentName,
                    parentSourceUuid
                });
                continue;
            }

            if (nestedEvent.type === 'choice') {
                if (usesSpellBrowser(nestedEvent)) {
                    ensureSpellChoiceRestriction(nestedEvent);
                    stepBucket.push({
                        id: this._buildNestedStepId('nested-spell', advId, level, parentSourceUuid),
                        type: 'spell_choice',
                        title: `${parentName}: ${nestedEvent.title}`,
                        event: nestedEvent,
                        stepType,
                        advId,
                        parentFeature: parentName,
                        parentSourceUuid
                    });
                } else {
                    stepBucket.push({
                        id: this._buildNestedStepId('nested-choice', advId, level, parentSourceUuid),
                        type: 'item_choice',
                        title: `${parentName}: ${nestedEvent.title}`,
                        event: nestedEvent,
                        stepType,
                        advId,
                        parentFeature: parentName,
                        parentSourceUuid
                    });
                }
                continue;
            }

            if (nestedEvent.type === 'asi' || nestedEvent.type === 'AbilityScoreImprovement') {
                stepBucket.push(this._buildNestedAsiStep(nestedEvent, {
                    parentName,
                    parentSourceUuid,
                    stepType,
                    level
                }));
                continue;
            }

            if (nestedEvent.type === 'trait_grant') {
                const grants = Array.isArray(nestedEvent.grants) ? nestedEvent.grants : Array.from(nestedEvent.grants || []);
                for (const key of grants) {
                    this._queueTraitChange(key, {
                        source: stepType,
                        advancementId: nestedEvent._original?._id || nestedEvent.id,
                        level,
                        parentFeature: parentName,
                        parentSourceUuid,
                        mode: nestedEvent.mode || nestedEvent._original?.configuration?.mode || 'default'
                    });
                }
            }
        }
    }

    _buildFeatureCantripStep(itemData, {
        sourceUuid = null,
        stepType = 'class',
        level = this._state?.targetLevel,
        parentFeature = itemData?.name || null,
        parentSourceUuid = sourceUuid
    } = {}) {
        const classIdentifier = this.levelUpManager?.getClassIdentifier?.()
            || this.levelUpManager?.classItem?.system?.identifier
            || this._state?.selectedSubclassContext?.classIdentifier
            || null;

        return SpellRules.generateFeatureCantripStep(itemData, {
            classIdentifier,
            level,
            stepType,
            sourceUuid,
            parentFeature,
            parentSourceUuid
        });
    }

    async _collectNestedAdvancementStepsForItem(itemData, {
        sourceUuid = null,
        stepType = 'class',
        level = this._state?.targetLevel,
        seen = new Set()
    } = {}) {
        const parentSourceUuid = sourceUuid || itemData?._sourceUuid || resolveItemSourceUuid(itemData) || itemData?.uuid || null;
        if (!parentSourceUuid || !this.dataManager) return [];

        const sourceKey = `source:${parentSourceUuid}:${level}`;
        if (seen.has(sourceKey)) return [];
        seen.add(sourceKey);

        const parentName = itemData?.name || parentSourceUuid;
        const stepBucket = [];
        const featureCantripStep = this._buildFeatureCantripStep(itemData, {
            sourceUuid: parentSourceUuid,
            stepType,
            level,
            parentFeature: parentName,
            parentSourceUuid
        });
        if (featureCantripStep) stepBucket.push(featureCantripStep);

        const nestedEvents = this.dataManager.getNestedAdvancementEvents
            ? await this.dataManager.getNestedAdvancementEvents(parentSourceUuid, level)
            : await this.dataManager.getLevelAdvancement(parentSourceUuid, level);

        if (!nestedEvents?.length) return stepBucket;

        for (const event of nestedEvents) {
            event.sourceLevel = event.sourceLevel ?? level;
            event.parentFeature = parentName;
            event.parentSourceUuid = parentSourceUuid;
        }
        await this.dataManager.enrichOptions?.(nestedEvents);

        const featureBucket = [];
        await this._appendNestedAdvancementEventSteps(nestedEvents, {
            parentName,
            parentSourceUuid,
            stepType,
            level,
            featureBucket,
            stepBucket,
            seen
        });

        if (featureBucket.length > 0) {
            stepBucket.unshift({
                id: this._buildNestedStepId('nested-features', parentSourceUuid, level, parentSourceUuid),
                type: 'features',
                title: `${parentName}: ${game.i18n.localize('ORIGINATE.UI.Progression.FeaturesTitle')}`,
                items: featureBucket,
                stepType,
                parentFeature: parentName,
                parentSourceUuid
            });
        }

        return stepBucket;
    }

    async _appendNestedFeatureSteps(item, { stepType, level, featureBucket, stepBucket, currentLevelOnly = false, seen = new Set() }) {
        if (!item?.uuid) return;

        const sourceKey = `source:${item.uuid}:${level}:${currentLevelOnly ? 'current' : 'nested'}`;
        if (seen.has(sourceKey)) return;
        seen.add(sourceKey);

        try {
            const doc = await this.dataManager.getDocument(item.uuid);
            if (!doc) return;

            if (!currentLevelOnly) {
                const featureCantripStep = this._buildFeatureCantripStep(doc, {
                    sourceUuid: item.uuid,
                    stepType,
                    level,
                    parentFeature: doc.name,
                    parentSourceUuid: item.uuid
                });
                if (featureCantripStep) stepBucket.push(featureCantripStep);
            }

            if (!hasAdvancementEntries(doc.system?.advancement)) return;

            window.OriginateLog(`Originate | [LevelUp] 检查特性 "${doc.name}" 的嵌套 Advancement (${getAdvancementCount(doc.system.advancement)} 个)`);

            const parentSourceUuid = item.uuid || resolveItemSourceUuid(doc) || doc.uuid || null;
            const nestedEvents = currentLevelOnly
                ? await this.dataManager.getLevelAdvancement(item.uuid, level)
                : (this.dataManager.getNestedAdvancementEvents
                    ? await this.dataManager.getNestedAdvancementEvents(item.uuid, level)
                    : await this.dataManager.getLevelAdvancement(item.uuid, level));

            if (nestedEvents.length === 0) return;

            nestedEvents.forEach(event => {
                event.sourceLevel = event.sourceLevel ?? level;
                event.parentFeature = doc.name;
                event.parentSourceUuid = parentSourceUuid;
            });
            await this.dataManager.enrichOptions(nestedEvents);

            const debugNestedEvents = nestedEvents.filter(event => this._shouldDebugTraitEvent(event));
            if (debugNestedEvents.length > 0) {
                this._logTraitStepDebug('嵌套特性里发现技能/工具 Trait 事件', {
                    feature: doc.name,
                    level,
                    stepType,
                    events: debugNestedEvents.map(event => ({
                        type: event.type,
                        title: event.title,
                        advancementId: event._original?._id || event.id || null,
                        mode: event.mode || event._original?.configuration?.mode || 'default',
                        pool: Array.isArray(event.pool) ? event.pool : Array.from(event.pool || []),
                        grants: Array.isArray(event.grants) ? event.grants : Array.from(event.grants || [])
                    }))
                });
            }

            await this._appendNestedAdvancementEventSteps(nestedEvents, {
                parentName: doc.name,
                parentSourceUuid,
                stepType,
                level,
                featureBucket,
                stepBucket,
                seen
            });
        } catch (error) {
            console.warn(`Originate | [LevelUp] 检查特性 "${item.name}" 嵌套 Advancement 失败:`, error);
        }
    }

    async _appendExistingNestedFeatureSteps({ level, featureBucket, stepBucket }) {
        const seenStepIds = new Set(stepBucket.map(step => step.id).filter(Boolean));
        const items = Array.from(this.actor?.items || []);

        for (const item of items) {
            if (!item || ['class', 'subclass', 'race', 'background'].includes(item.type)) continue;

            const acquiredAt = Number(item.flags?.['hero-genesis']?.acquiredAt);
            if (Number.isFinite(acquiredAt) && acquiredAt >= level) continue;

            const sourceUuid = resolveItemSourceUuid(item);
            if (!sourceUuid) continue;

            const before = stepBucket.length;
            await this._appendNestedFeatureSteps(
                { uuid: sourceUuid, name: item.name },
                {
                    stepType: item.flags?.['hero-genesis']?.stepType || 'class',
                    level,
                    featureBucket,
                    stepBucket,
                    currentLevelOnly: true
                }
            );

            for (let index = stepBucket.length - 1; index >= before; index--) {
                const step = stepBucket[index];
                if (!step?.id) continue;
                if (seenStepIds.has(step.id)) {
                    stepBucket.splice(index, 1);
                } else {
                    seenStepIds.add(step.id);
                }
            }
        }
    }

    async _collectGrantedFeature(item, {
        stepType,
        advancementId,
        level,
        featureBucket,
        stepBucket,
        spellConfig = null,
        parentFeature = null,
        parentSourceUuid = null,
        seen = new Set()
    }) {
        if (!item) return;

        featureBucket.push({
            ...item,
            stepType,
            advancementId,
            parentFeature,
            parentSourceUuid,
            spellConfig
        });

        await this._appendNestedFeatureSteps(item, {
            stepType,
            level,
            featureBucket,
            stepBucket,
            seen
        });
    }

    _queuePendingItem(itemData, {
        advancementId,
        level,
        stepType,
        isSubclass = false,
        parentFeature = null,
        parentSourceUuid = null
    } = {}) {
        const pendingEntry = {
            itemData,
            advancementId,
            level,
            stepType,
            isSubclass,
            parentFeature,
            parentSourceUuid
        };

        if (itemData?.type !== 'spell') {
            this._state.pendingItems.push(pendingEntry);
            return pendingEntry;
        }

        const incomingUuid = normalizeTrackedUuid(itemData);
        const incomingName = itemData.name?.trim().toLowerCase() || null;
        const existing = this._state.pendingItems.find(pending => {
            if (pending.itemData?.type !== 'spell') return false;

            const pendingUuid = normalizeTrackedUuid(pending.itemData);
            if (incomingUuid && pendingUuid === incomingUuid) return true;

            const pendingName = pending.itemData?.name?.trim().toLowerCase() || null;
            return !!incomingName && pendingName === incomingName;
        });

        if (!existing) {
            this._state.pendingItems.push(pendingEntry);
            return pendingEntry;
        }

        mergeSpellDuplicateData(existing.itemData, itemData);

        // spell-rules-prepared-grant 只是“先占个坑”，
        // 后面如果来了真正的授予来源，就让它接管归属。
        if (existing.advancementId === 'spell-rules-prepared-grant'
            && advancementId
            && advancementId !== 'spell-rules-prepared-grant') {
            existing.advancementId = advancementId;
            existing.level = level;
            existing.stepType = stepType;
            existing.parentFeature = parentFeature;
            existing.parentSourceUuid = parentSourceUuid;
        }

        return existing;
    }

    _queueAbilityScoreImprovement(assignments = {}, {
        advancementId,
        level,
        stepType = 'class',
        parentFeature = null,
        parentSourceUuid = null,
        sourceStepId = null
    } = {}) {
        const cleanAssignments = {};
        for (const [ability, value] of Object.entries(assignments || {})) {
            const bonus = Number(value);
            if (!ability || !Number.isFinite(bonus) || bonus <= 0) continue;
            cleanAssignments[ability] = (cleanAssignments[ability] || 0) + bonus;
        }

        if (!advancementId || Object.keys(cleanAssignments).length === 0) return null;

        this._state.abilityScoreImprovements ??= [];
        const entryKey = JSON.stringify({
            advancementId,
            level,
            stepType,
            parentFeature,
            parentSourceUuid,
            sourceStepId
        });

        let entry = this._state.abilityScoreImprovements.find(item => item._entryKey === entryKey);
        if (!entry) {
            entry = {
                _entryKey: entryKey,
                advancementId,
                level,
                stepType,
                parentFeature,
                parentSourceUuid,
                sourceStepId,
                assignments: {}
            };
            this._state.abilityScoreImprovements.push(entry);
        }

        for (const [ability, bonus] of Object.entries(cleanAssignments)) {
            entry.assignments[ability] = (entry.assignments[ability] || 0) + bonus;
        }

        return entry;
    }

    _queuePendingReplacement(oldItemId, newItemData, {
        advancementId,
        level,
        stepType,
        parentFeature = null,
        parentSourceUuid = null
    } = {}) {
        const replacementEntry = {
            oldItemId,
            newItemData,
            advancementId,
            level,
            stepType,
            parentFeature,
            parentSourceUuid
        };

        const existingIndex = this._state.pendingReplacements.findIndex(entry => entry.oldItemId === oldItemId);
        if (existingIndex !== -1) {
            // 同一个旧物品在当前级只该保留最后一次替换决定。
            // 不然步骤来回改几次，提交时就会对着同一个 ID 删好几遍。
            this._state.pendingReplacements[existingIndex] = replacementEntry;
            return replacementEntry;
        }

        this._state.pendingReplacements.push(replacementEntry);
        return replacementEntry;
    }

    _queueTraitChange(key, {
        source,
        advancementId,
        level,
        parentFeature = null,
        parentSourceUuid = null,
        mode = 'default'
    } = {}) {
        const traitChange = {
            key,
            source,
            stepType: source,
            advancementId,
            level,
            parentFeature,
            parentSourceUuid,
            mode
        };

        this._state.pendingTraitChanges.push(traitChange);
        if (this._shouldDebugTraitKey(key)) {
            window.OriginateLog('Originate | [LevelUp][TraitDebug] 记录待提交 Trait', traitChange);
        }
        return traitChange;
    }

    _getCurrentSandboxLevel(state = this._state) {
        const level = Number(state?.targetLevel ?? null);
        return Number.isFinite(level) ? level : null;
    }

    _bindStepToCurrentLevel(step, {
        parentStepId = null,
        level = this._getCurrentSandboxLevel()
    } = {}) {
        if (!step) return step;

        return {
            ...step,
            targetLevel: step.targetLevel ?? level,
            sandboxParentStepId: parentStepId ?? step.sandboxParentStepId ?? null
        };
    }

    _bindStepsToCurrentLevel(steps = [], options = {}) {
        return (steps || []).filter(Boolean).map(step => this._bindStepToCurrentLevel(step, options));
    }

    _replaceDynamicChildSteps(parentStepId, steps = [], {
        level = this._getCurrentSandboxLevel()
    } = {}) {
        if (!parentStepId || !Array.isArray(this._state?.steps)) return [];

        let insertIndex = this._state.steps.findIndex(step => step?.id === parentStepId);
        insertIndex = insertIndex === -1 ? this._state.currentStepIndex + 1 : insertIndex + 1;

        const isCurrentLevelStep = (step) => {
            const stepLevel = Number(step?.targetLevel ?? level);
            if (!Number.isFinite(level) || !Number.isFinite(stepLevel)) return true;
            return stepLevel === level;
        };

        this._state.steps = this._state.steps.filter((step, index) => {
            const shouldRemove = step?.sandboxParentStepId === parentStepId && isCurrentLevelStep(step);
            if (!shouldRemove) return true;

            if (step.id) {
                delete this._state.stepData?.[step.id];
                delete this._state.stepHistory?.[step.id];
            }
            if (index < insertIndex) insertIndex--;
            return false;
        });

        const boundSteps = this._bindStepsToCurrentLevel(steps, { parentStepId, level });
        if (boundSteps.length > 0) {
            this._state.steps.splice(insertIndex, 0, ...boundSteps);
        }
        return boundSteps;
    }

    _keepEntriesForCurrentLevel(entries = [], level = this._getCurrentSandboxLevel()) {
        return (entries || []).filter(entry => {
            const entryLevel = Number(entry?.level ?? level);
            if (!Number.isFinite(level) || !Number.isFinite(entryLevel)) return true;
            return entryLevel === level;
        });
    }

    _getLiveStepIds(steps = this._state?.steps) {
        return new Set((steps || []).map(step => step?.id).filter(Boolean));
    }

    _pickLiveStepData(stepData = {}, liveStepIds = this._getLiveStepIds()) {
        const nextStepData = {};
        for (const [stepId, draft] of Object.entries(stepData || {})) {
            if (!liveStepIds.has(stepId)) continue;
            nextStepData[stepId] = draft;
        }
        return nextStepData;
    }

    _pruneCurrentLevelSandbox(state = this._state) {
        const level = this._getCurrentSandboxLevel(state);
        const liveStepIds = this._getLiveStepIds(state.steps);

        state.pendingItems = this._keepEntriesForCurrentLevel(state.pendingItems, level);
        state.pendingReplacements = this._keepEntriesForCurrentLevel(state.pendingReplacements, level);
        state.pendingTraitChanges = this._keepEntriesForCurrentLevel(state.pendingTraitChanges, level);
        state.selectedFeats = this._keepEntriesForCurrentLevel(state.selectedFeats, level);
        state.abilityScoreImprovements = this._keepEntriesForCurrentLevel(state.abilityScoreImprovements, level);
        state.stepData = this._pickLiveStepData(state.stepData, liveStepIds);

        const nextHistory = {};
        for (const [historyStepId, history] of Object.entries(state.stepHistory || {})) {
            const historyLevel = Number(history?.targetLevel ?? level);
            const isForeignLevel = Number.isFinite(level) && Number.isFinite(historyLevel) && historyLevel !== level;
            if (isForeignLevel || liveStepIds.has(historyStepId)) {
                nextHistory[historyStepId] = history;
            }
        }
        state.stepHistory = nextHistory;
        state.steps = this._bindStepsToCurrentLevel(state.steps);

        return liveStepIds;
    }

    _discardFutureSandboxState(startIndex, state = this._state) {
        const level = this._getCurrentSandboxLevel(state);
        const futureSteps = Array.isArray(state.steps) ? state.steps.slice(startIndex) : [];

        for (const futureStep of futureSteps) {
            if (!futureStep?.id) continue;
            delete state.stepData?.[futureStep.id];

            const historyLevel = Number(state.stepHistory?.[futureStep.id]?.targetLevel ?? level);
            const isCurrentLevelHistory = !Number.isFinite(level) || !Number.isFinite(historyLevel) || historyLevel === level;
            if (isCurrentLevelHistory) {
                delete state.stepHistory?.[futureStep.id];
            }
        }
    }

    // 真实升级的步骤加载：数据来自现有 Actor 和本次 pending state。

    async _loadLevelFeatures() {
        const level = this._state.targetLevel;
        window.OriginateLog(`Originate | [LevelUp] 加载 Level ${level} 升级内容...`);

        try {
            // 检查当前职业是否已有子职（必须匹配 classIdentifier，不能跨职业）
            const classIdentifier = this.levelUpManager.classItem?.system?.identifier;
            const hasSubclass = classIdentifier
                ? this.actor.items.some(i => i.type === 'subclass' && i.system?.classIdentifier === classIdentifier)
                : false;
            const subclassLevel = await this._getSubclassLevel();

            if (!hasSubclass && level >= subclassLevel) {
                // 需要先选子职
                await this._triggerSubclassSelection(level);
                return;
            }

            const isMulti = this._state.isMulticlassNewClass || false;
            const upgrades = await this.levelUpManager.getLevelUpgrades(level, { isMulticlassing: isMulti });

            // 设置 sourceLevel
            const setSourceLevel = (events) => events.forEach(e => { e.sourceLevel = level; });
            setSourceLevel(upgrades.class);
            setSourceLevel(upgrades.subclass);
            setSourceLevel(upgrades.race);
            setSourceLevel(upgrades.background);

            // 丰富事件数据
            if (upgrades.class.length > 0) await this.dataManager.enrichOptions(upgrades.class);
            if (upgrades.subclass.length > 0) await this.dataManager.enrichOptions(upgrades.subclass);
            if (upgrades.race.length > 0) await this.dataManager.enrichOptions(upgrades.race);
            if (upgrades.background.length > 0) await this.dataManager.enrichOptions(upgrades.background);

            // 构建步骤
            const steps = [];

            // 1. HP 步骤
            steps.push({
                id: 'hp',
                type: 'hp',
                title: game.i18n.localize('ORIGINATE.UI.Progression.HPTitle')
            });

            // 处理事件
            const grantedFeatures = [];

            const processEvents = async (events, stepType) => {
                for (const event of events) {
                    if (event.type === 'features') {
                        const validItems = Array.isArray(event.items) ? event.items.filter(Boolean) : [];
                        if (validItems.length === 0) continue;

                        for (const item of validItems) {
                            await this._collectGrantedFeature(item, {
                                stepType,
                                advancementId: event._original?._id || event.id || event.title,
                                level,
                                featureBucket: grantedFeatures,
                                stepBucket: steps,
                                spellConfig: event.spellConfig || event._original?.configuration?.spell || null
                            });
                        }
                    } else if (event.type === 'asi') {
                        steps.push({
                            id: `asi-${level}`,
                            type: 'asi_feat_choice',
                            title: event.title || game.i18n.localize('ORIGINATE.UI.Progression.ASIFeatTitle'),
                            points: event.points || 2,
                            cap: event.cap || 2,
                            stepType,
                            advId: event._original?._id || event.id,
                            event
                        });
                    } else if (event.type === 'choice') {
                        const advId = event._original?._id || event.id || event.title;

                        // 只接管基础职业增长，其他原生选择仍需要独立步骤。
                        if (SpellRules.managesChoice(event, {
                            classIdentifier: this.levelUpManager.classItem?.system?.identifier,
                            subclassIdentifier: this.levelUpManager.subclassItem?.system?.identifier
                        })) {
                            window.OriginateLog(`Originate | [LevelUp] 基础法术 Advancement: ${event.title} (由 SpellRules 管理)`);
                            continue;
                        }

                        if (usesSpellBrowser(event)) {
                            ensureSpellChoiceRestriction(event);
                            steps.push({
                                id: `spell-choice-${advId}-${level}`,
                                type: 'spell_choice',
                                title: event.title,
                                event,
                                stepType,
                                advId
                            });
                        } else {
                            steps.push({
                                id: `choice-${advId}-${level}`,
                                type: 'item_choice',
                                title: event.title,
                                event,
                                stepType,
                                advId
                            });
                        }
                    } else if (event.type === 'trait_choice') {
                        const advId = event._original?._id || event.id || event.title;
                        steps.push({
                            id: `trait-${advId}-${level}`,
                            type: 'trait_choice',
                            title: event.title,
                            event,
                            stepType,
                            advId
                        });
                    } else if (event.type === 'trait_grant') {
                        const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);

                        // allowReplacements: 如果角色已拥有某个被授予的特质，允许选择替代
                        if (event.allowReplacements) {
                            const knownTraits = this._getKnownTraits();
                            const duplicates = grants.filter(key => knownTraits.has(key));
                            const nonDuplicates = grants.filter(key => !knownTraits.has(key));

                            // 非重复的正常授予
                            if (nonDuplicates.length > 0) {
                                for (const key of nonDuplicates) {
                                    this._queueTraitChange(key, {
                                        source: stepType,
                                        advancementId: event._original?._id || event.id,
                                        level,
                                        mode: event.mode || event._original?.configuration?.mode || 'default'
                                    });
                                }
                            }

                            // 重复的转成选择步骤
                            for (const dupKey of duplicates) {
                                const category = dupKey.split(':')[0]; // e.g. 'skills', 'tool', 'languages'
                                const advId = event._original?._id || event.id || event.title;
                                window.OriginateLog(`Originate | [LevelUp] 特质 "${dupKey}" 已拥有，allowReplacements=true，转为选择步骤`);
                                steps.push({
                                    id: `trait-replace-${advId}-${dupKey}-${level}`,
                                    type: 'trait_choice',
                                    title: event.title || game.i18n.localize("ORIGINATE.Advancement.TraitChoice"),
                                    event: {
                                        ...event,
                                        type: 'trait_choice',
                                        count: 1,
                                        pool: new Set([`${category}:*`]), // 同类别通配符，让用户从同类别中选
                                        _replacingGrant: dupKey
                                    },
                                    stepType,
                                    advId
                                });
                            }
                        } else {
                            // 无 allowReplacements，直接授予
                            for (const key of grants) {
                                this._queueTraitChange(key, {
                                    source: stepType,
                                    advancementId: event._original?._id || event.id,
                                    level,
                                    mode: event.mode || event._original?.configuration?.mode || 'default'
                                });
                            }
                        }
                    }
                }
            };

            await processEvents(upgrades.class, 'class');
            await processEvents(upgrades.subclass, 'subclass');
            await processEvents(upgrades.race, 'race');
            await processEvents(upgrades.background, 'background');
            await this._appendExistingNestedFeatureSteps({
                level,
                featureBucket: grantedFeatures,
                stepBucket: steps
            });

            // ========== SpellRules: 生成法术选择步骤 ==========
            // 用 SpellRules 替代原生 Advancement 的法术选择
            // 先尝试主职标识符，若主职无规则则回退到子职标识符（如奥法骑士）
            let spellRulesIdentifier = this.levelUpManager.classItem?.system?.identifier;
            if (spellRulesIdentifier && !SpellRules.getRules(spellRulesIdentifier)) {
                const subId = this.levelUpManager.subclassItem?.system?.identifier;
                if (subId && SpellRules.getRules(subId)) {
                    window.OriginateLog(`Originate | [LevelUp] 主职 "${spellRulesIdentifier}" 无法术规则，使用子职 "${subId}"`);
                    spellRulesIdentifier = subId;
                }
            }
            if (spellRulesIdentifier && SpellRules.getRules(spellRulesIdentifier)) {
                const fromLevel = this._state.isMulticlassNewClass ? 0 : (this.levelUpManager.currentLevel ?? (level - 1));
                window.OriginateLog(`Originate | [LevelUp] SpellRules fromLevel=${fromLevel}, toLevel=${level}, isMulticlassNewClass=${this._state.isMulticlassNewClass}`);
                const spellSteps = SpellRules.generateSpellSteps(spellRulesIdentifier, fromLevel, level, {
                    stepType: 'class', nativeChoices: [...upgrades.class, ...upgrades.subclass]
                });
                if (spellSteps.length > 0) {
                    window.OriginateLog(`Originate | [LevelUp] SpellRules 为 ${spellRulesIdentifier} 生成了 ${spellSteps.length} 个法术步骤:`, spellSteps.map(s => s.title));
                    steps.push(...spellSteps);
                }
            }

            // 自动获得的特性插入到 HP 后面
            if (grantedFeatures.length > 0) {
                steps.splice(1, 0, {
                    id: 'features',
                    type: 'features',
                    title: game.i18n.localize('ORIGINATE.UI.Progression.FeaturesTitle'),
                    items: grantedFeatures
                });
            }

            this._state.steps = this._bindStepsToCurrentLevel(steps);
            this._state.currentStepIndex = 0;
            this._state.stepData = {};
            this._state.stepHistory = {};
            this._currentStepComplete = false;

            window.OriginateLog(`Originate | [LevelUp] 构建了 ${steps.length} 个步骤:`, steps.map(s => s.title));
            await this._renderCurrentStep();

        } catch (error) {
            console.error(`Originate | [LevelUp] 加载升级内容失败:`, error);
            ui.notifications.error(game.i18n.localize("ORIGINATE.Error.LoadLevelUpFailed"));
        }
    }

    // UI 渲染和控件事件来自 WizardUIMixin，下面只保留升级自己的数据收集与导航。

    // ========================================================================
    // 导航：下一步（收集数据 + 前进）
    // ========================================================================

    async _onProgressionNext() {
        const state = this._state;
        const currentStep = state.steps[state.currentStepIndex];
        const overlay = this.element?.querySelector('.originate-progression-wizard');
        if (!overlay || !currentStep) return;

        if (this._removeExcludedSpellSelections(currentStep, overlay)) return;
        if (!await this._validateSpellSchoolDraft(currentStep, overlay)) return;

        // 未完成确认
        if (!this._currentStepComplete) {
            const confirmed = await this._showConfirmDialog({
                title: game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmTitle"),
                content: `<p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmContent")}</p><p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmWarning")}</p>`,
                defaultYes: false
            });
            if (!confirmed) return;
        }

        // 收集当前步骤数据
        await this._saveStepData(currentStep, overlay);

        // 前进
        if (state.currentStepIndex < state.steps.length - 1) {
            state.currentStepIndex++;
            await this._renderCurrentStep();
        } else {
            // 最后一步 → 完成升级
            overlay.remove();
            await this._onFinish();
        }
    }

    async _onProgressionPrev() {
        const state = this._state;
        if (state.currentStepIndex > 0) {
            const currentStep = state.steps[state.currentStepIndex];
            if (currentStep?.id) {
                delete state.stepData[currentStep.id];
            }

            state.currentStepIndex--;
            const prevStep = state.steps[state.currentStepIndex];
            if (prevStep?.id) {
                this._rollbackStep(prevStep.id);
            }

            this._discardFutureSandboxState(state.currentStepIndex + 1, state);
            this._pruneCurrentLevelSandbox(state);
            await this._renderCurrentStep();
        }
    }

    _captureStepHistory(stepId) {
        const state = this._state;
        const activeStepIds = this._getLiveStepIds(state.steps);
        const targetLevel = this._getCurrentSandboxLevel(state);
        return {
            stepId,
            targetLevel,
            activeStepIds: Array.from(activeStepIds),
            pendingItems: foundry.utils.deepClone(this._keepEntriesForCurrentLevel(state.pendingItems, targetLevel)),
            pendingItemUpdates: foundry.utils.deepClone(state.pendingItemUpdates || []),
            pendingReplacements: foundry.utils.deepClone(this._keepEntriesForCurrentLevel(state.pendingReplacements, targetLevel)),
            pendingTraitChanges: foundry.utils.deepClone(this._keepEntriesForCurrentLevel(state.pendingTraitChanges, targetLevel)),
            selectedFeats: foundry.utils.deepClone(this._keepEntriesForCurrentLevel(state.selectedFeats, targetLevel)),
            abilityScoreImprovements: foundry.utils.deepClone(this._keepEntriesForCurrentLevel(state.abilityScoreImprovements, targetLevel)),
            asiChanges: foundry.utils.deepClone(state.asiChanges || {}),
            // 这里要只收当前级还活着的步骤草稿。
            // 不然动态步骤一插一删，旧快照里会混进已经失效的草稿，回退时又把脏状态带回来。
            stepData: foundry.utils.deepClone(this._pickLiveStepData(state.stepData, activeStepIds)),
            // 旧实现只 slice 了一层数组，步骤对象本身还跟着活状态一起漂。
            // 这里改成整份深拷，避免后面插步骤时把历史快照也顺手改掉。
            steps: foundry.utils.deepClone(this._bindStepsToCurrentLevel(state.steps)),
            hpGain: state.hpGain,
            hpMethod: state.hpMethod,
            hpRollResult: state.hpRollResult
        };
    }

    _rollbackStep(stepId) {
        const state = this._state;
        const history = state.stepHistory?.[stepId];
        if (!history) return;
        if (history.targetLevel !== undefined && history.targetLevel !== state.targetLevel) return;

        window.OriginateLog(`Originate | [LevelUp] 回滚步骤 ${stepId} 的已提交数据`, history);

        state.pendingItems = foundry.utils.deepClone(history.pendingItems || []);
        state.pendingItemUpdates = foundry.utils.deepClone(history.pendingItemUpdates || []);
        state.pendingReplacements = foundry.utils.deepClone(history.pendingReplacements || []);
        state.pendingTraitChanges = foundry.utils.deepClone(history.pendingTraitChanges || []);
        state.selectedFeats = foundry.utils.deepClone(history.selectedFeats || []);
        state.abilityScoreImprovements = foundry.utils.deepClone(history.abilityScoreImprovements || []);
        state.asiChanges = foundry.utils.deepClone(history.asiChanges || {});
        state.stepData = foundry.utils.deepClone(history.stepData || {});
        state.steps = Array.isArray(history.steps)
            ? this._bindStepsToCurrentLevel(foundry.utils.deepClone(history.steps))
            : this._bindStepsToCurrentLevel(state.steps);
        state.hpGain = history.hpGain ?? null;
        state.hpMethod = history.hpMethod ?? null;
        state.hpRollResult = history.hpRollResult ?? null;

        this._pruneCurrentLevelSandbox(state);

        delete state.stepHistory[stepId];
    }

    // ========================================================================
    // 收集步骤数据
    // ========================================================================

    async _saveStepData(step, overlay) {
        const state = this._state;
        const level = state.targetLevel;
        const currentDraft = this._syncStepDraftFromOverlay(step, overlay);

        // 这一步如果之前存过，先回到它提交前的样子。
        // 不然来回点几次，pending 里会越堆越离谱。
        this._rollbackStep(step.id);
        if (step?.id && currentDraft) {
            if (!state.stepData) state.stepData = {};
            state.stepData[step.id] = currentDraft;
        }
        this._pruneCurrentLevelSandbox(state);
        if (!state.stepHistory) state.stepHistory = {};
        state.stepHistory[step.id] = this._captureStepHistory(step.id);

        switch (step.type) {
            case 'features':
                for (const item of step.items) {
                    const doc = await this.dataManager.getDocument(item.uuid);
                    if (doc) {
                        const itemData = doc.toObject();
                        itemData._sourceUuid = item.uuid;
                        const spellConfig = item.spellConfig || item._original?.configuration?.spell;
                        const spellSourceClass = this.levelUpManager?.classItem?.system?.identifier || null;
                        if (spellConfig && itemData.type === 'spell') {
                            applySpellConfigToItemData(itemData, spellConfig, {
                                sourceUuid: item.uuid,
                                sourceClass: spellSourceClass
                            });
                        } else if (itemData.type === 'spell') {
                            normalizeSpellItemData(itemData, {
                                sourceUuid: item.uuid,
                                sourceClass: spellSourceClass
                            });
                        }
                        this._queuePendingItem(itemData, {
                            advancementId: item.advancementId,
                            level,
                            stepType: item.stepType,
                            parentFeature: item.parentFeature || null,
                            parentSourceUuid: item.parentSourceUuid || null
                        });
                    }
                }
                break;

            case 'asi_feat_choice': {
                const choiceData = state.stepData[step.id];
                const fixedBonuses = step.fixed && typeof step.fixed === 'object' ? step.fixed : {};
                const hasFixedBonus = Object.values(fixedBonuses).some(value => Number(value) > 0);
                const shouldApplyAsi = choiceData?.type === 'asi' || step.asiOnly || (!choiceData?.type && hasFixedBonus);

                if (shouldApplyAsi) {
                    const assignments = {};
                    const addAsiBonus = (ability, value) => {
                        const addedValue = Number(value);
                        if (!ability || !Number.isFinite(addedValue) || addedValue <= 0) return;
                        state.asiChanges[ability] = (state.asiChanges[ability] || 0) + addedValue;
                        assignments[ability] = (assignments[ability] || 0) + addedValue;
                    };

                    const asiSection = overlay.querySelector('.asi-section');
                    if (asiSection) {
                        asiSection.querySelectorAll('.asi-value').forEach(span => {
                            const ability = span.dataset.ability;
                            const addedValue = parseInt(span.textContent) || 0;
                            addAsiBonus(ability, addedValue);
                        });
                    }

                    // 应用固定属性加成（如巨武器大师 +1 STR）
                    if (hasFixedBonus) {
                        for (const [ability, fixedValue] of Object.entries(fixedBonuses)) {
                            if (fixedValue > 0) {
                                addAsiBonus(ability, fixedValue);
                                window.OriginateLog(`Originate | [LevelUp] 固定 ASI: ${ability} +${fixedValue} (from ${step.title})`);
                            }
                        }
                    }

                    this._queueAbilityScoreImprovement(assignments, {
                        advancementId: step.advId,
                        level,
                        stepType: step.stepType || 'class',
                        parentFeature: step.parentFeature || null,
                        parentSourceUuid: step.parentSourceUuid || null,
                        sourceStepId: step.id
                    });
                } else if (choiceData?.type === 'feat' && choiceData.uuid) {
                    try {
                        const featDoc = await this.dataManager.getDocument(choiceData.uuid);
                        if (featDoc) {
                            const itemData = featDoc.toObject
                                ? featDoc.toObject()
                                : foundry.utils.deepClone(featDoc);
                            itemData._sourceUuid = choiceData.uuid;

                            const nestedSteps = await this._collectNestedAdvancementStepsForItem(itemData, {
                                sourceUuid: choiceData.uuid,
                                level,
                                stepType: step.stepType || 'class'
                            });
                            this._replaceDynamicChildSteps(step.id, nestedSteps, { level });

                            state.selectedFeats.push({
                                level,
                                uuid: choiceData.uuid,
                                name: featDoc.name,
                                sourceStepId: step.id,
                                advancementId: step.advId,
                                stepType: step.stepType || 'class',
                                parentFeature: step.parentFeature || null,
                                parentSourceUuid: step.parentSourceUuid || null
                            });
                        } else {
                            this._replaceDynamicChildSteps(step.id, [], { level });
                        }
                    } catch (e) {
                        console.error("Originate | [LevelUp] 解析 Feat 嵌套 Advancement 失败:", e);
                    }
                }
                break;
            }

            case 'item_choice': {
                const section = overlay.querySelector('.item-choice-section');
                if (!section) break;
                const advId = section.dataset.advId;
                const stepType = section.dataset.stepType || 'class';
                const isPureReplacement = section.dataset.pureReplacement === 'true';
                const spellConfig = step.event?.spellConfig || step.event?._original?.configuration?.spell;
                const spellSourceClass = step.classIdentifier
                    || this.levelUpManager?.getClassIdentifier?.()
                    || this.levelUpManager?.classItem?.system?.identifier
                    || null;
                const nestedSteps = [];
                const collectNestedSteps = async (itemData, sourceUuid) => {
                    const steps = await this._collectNestedAdvancementStepsForItem(itemData, {
                        sourceUuid,
                        level,
                        stepType
                    });
                    nestedSteps.push(...steps);
                };

                if (isPureReplacement) {
                    const modeRadio = section.querySelector('input[name^="replacement-mode-"]:checked');
                    if (modeRadio?.value === 'replace') {
                        const targetRadio = section.querySelector('input[name^="replace-target-"]:checked');
                        const choiceRadio = section.querySelector('input[name^="item-choice-"]:checked');
                        if (targetRadio && choiceRadio) {
                            const doc = await this.dataManager.getDocument(choiceRadio.value);
                            if (doc) {
                                const itemData = doc.toObject();
                                itemData._sourceUuid = choiceRadio.value;
                                if (spellSourceClass && itemData.type === 'spell') {
                                    foundry.utils.setProperty(itemData, 'system.sourceClass', spellSourceClass);
                                }
                                if (spellConfig && itemData.type === 'spell') {
                                    applySpellConfigToItemData(itemData, spellConfig, {
                                        sourceUuid: choiceRadio.value,
                                        sourceClass: spellSourceClass
                                    });
                                } else if (itemData.type === 'spell') {
                                    normalizeSpellItemData(itemData, {
                                        sourceUuid: choiceRadio.value,
                                        sourceClass: spellSourceClass
                                    });
                                }
                                this._queuePendingReplacement(targetRadio.value, itemData, {
                                    advancementId: advId,
                                    level,
                                    stepType,
                                    parentFeature: step.parentFeature || null,
                                    parentSourceUuid: step.parentSourceUuid || null
                                });
                                await collectNestedSteps(itemData, choiceRadio.value);
                            }
                        }
                    }
                } else {
                    const selectedInputs = section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked');
                    const replaceToggle = section.querySelector('.enable-replacement:checked');
                    const replaceTarget = section.querySelector('input[name^="replace-target-"]:checked');

                    for (const input of selectedInputs) {
                        const doc = await this.dataManager.getDocument(input.value);
                        if (doc) {
                            const itemData = doc.toObject();
                            itemData._sourceUuid = input.value;
                            if (spellSourceClass && itemData.type === 'spell') {
                                foundry.utils.setProperty(itemData, 'system.sourceClass', spellSourceClass);
                            }
                            if (spellConfig && itemData.type === 'spell') {
                                applySpellConfigToItemData(itemData, spellConfig, {
                                    sourceUuid: input.value,
                                    sourceClass: spellSourceClass
                                });
                            } else if (itemData.type === 'spell') {
                                normalizeSpellItemData(itemData, {
                                    sourceUuid: input.value,
                                    sourceClass: spellSourceClass
                                });
                            }
                            this._queuePendingItem(itemData, {
                                advancementId: advId,
                                level,
                                stepType,
                                parentFeature: step.parentFeature || null,
                                parentSourceUuid: step.parentSourceUuid || null
                            });
                            await collectNestedSteps(itemData, input.value);
                        }
                    }

                    if (replaceToggle && replaceTarget && state.pendingItems.length > 0) {
                        const lastItem = state.pendingItems.pop();
                        this._queuePendingReplacement(replaceTarget.value, lastItem.itemData, {
                            advancementId: advId,
                            level,
                            stepType,
                            parentFeature: step.parentFeature || null,
                            parentSourceUuid: step.parentSourceUuid || null
                        });
                    }
                }

                this._replaceDynamicChildSteps(step.id, nestedSteps, { level });
                break;
            }

            case 'spell_choice': {
                const section = overlay.querySelector('.spell-browser-section');
                if (!section) break;
                const advId = section.dataset.advId;
                const stepType = section.dataset.stepType || 'class';
                const selectedUuids = [];
                section.querySelectorAll('.selected-spells-list .spell-card').forEach(card => {
                    if (card.dataset.uuid) selectedUuids.push(card.dataset.uuid);
                });
                const spellConfig = step.event?.spellConfig || step.event?._original?.configuration?.spell;
                const spellSourceClass = step.classIdentifier
                    || this.levelUpManager?.getClassIdentifier?.()
                    || this.levelUpManager?.classItem?.system?.identifier
                    || null;
                for (const uuid of selectedUuids) {
                    if (this.dataManager.isItemExcluded(uuid)) continue;
                    const doc = await this.dataManager.getDocument(uuid);
                    if (doc) {
                        const itemData = doc.toObject();
                        itemData._sourceUuid = uuid;
                        if (spellSourceClass && itemData.type === 'spell') {
                            foundry.utils.setProperty(itemData, 'system.sourceClass', spellSourceClass);
                        }
                        if (spellConfig) {
                            applySpellConfigToItemData(itemData, spellConfig, {
                                sourceUuid: uuid,
                                sourceClass: spellSourceClass
                            });
                        } else if (itemData.type === 'spell') {
                            normalizeSpellItemData(itemData, {
                                sourceUuid: uuid,
                                sourceClass: spellSourceClass
                            });
                        }
                        this._queuePendingItem(itemData, {
                            advancementId: advId,
                            level,
                            stepType,
                            parentFeature: step.parentFeature || null,
                            parentSourceUuid: step.parentSourceUuid || null
                        });
                    }
                }
                break;
            }

            case 'spell_replacement': {
                const section = overlay.querySelector('.spell-replacement-section');
                if (!section) break;
                const oldSpellId = section.querySelector('input[name="spell-replace-old"]:checked')?.value;
                const newSpellUuid = section.querySelector('.replacement-new-spell')?.dataset.uuid;
                if (oldSpellId && newSpellUuid && !this.dataManager.isItemExcluded(newSpellUuid)) {
                    const doc = await this.dataManager.getDocument(newSpellUuid);
                    if (doc) {
                        const itemData = doc.toObject();
                        itemData._sourceUuid = newSpellUuid;
                        this._queuePendingReplacement(oldSpellId, itemData, {
                            advancementId: 'spell-rules-replace',
                            level,
                            stepType: step.stepType || 'class',
                            parentFeature: step.parentFeature || null,
                            parentSourceUuid: step.parentSourceUuid || null
                        });
                    }
                }
                break;
            }

            case 'prepared_spell_grant': {
                // 准备型施法者：从法表中加载指定环阶范围的法术并添加到角色
                // minLevel 排除戏法（戏法通过 spell_choice 单独选择）
                try {
                    const classId = step.classIdentifier;
                    const spellList = step.list || [classId];
                    const maxLevel = step.maxLevel || 9;
                    const minLevel = step.minLevel || 1;

                    // 通过 DataManager 获取法表中的法术
                    await this.dataManager.loadSpellListSources();
                    const classSpellMap = await this.dataManager.getClassSpellMap();
                    const results = await this.dataManager.getSpellsByRestriction({ level: 'available' }, '', maxLevel);

                    // 筛选属于该职业法表的法术，并排除低于 minLevel 的法术（如戏法）
                    const classSpells = results.filter(spell => {
                        // 排除低于 minLevel 的法术（戏法 level=0 会被 minLevel=1 排除）
                        const spellLevel = spell.system?.level ?? spell.level ?? 0;
                        if (spellLevel < minLevel) return false;

                        const spellClasses = getSpellClassesForSpell(classSpellMap, spell);
                        if (!spellClasses) return false;
                        return spellClassSetMatchesAny(spellClasses, spellList);
                    });

                    const pendingSpellByUuid = new Map();
                    const pendingSpellByName = new Map();
                    for (const pending of state.pendingItems) {
                        const itemData = pending.itemData;
                        if (itemData?.type !== 'spell') continue;
                        const sourceUuid = resolveItemSourceUuid(itemData);
                        const nameKey = itemData.name?.trim().toLowerCase();
                        if (sourceUuid && !pendingSpellByUuid.has(sourceUuid)) pendingSpellByUuid.set(sourceUuid, itemData);
                        if (nameKey && !pendingSpellByName.has(nameKey)) pendingSpellByName.set(nameKey, itemData);
                    }

                    const actorSpellByUuid = new Map();
                    const actorSpellByName = new Map();
                    for (const item of this.actor.items) {
                        if (item.type !== 'spell') continue;
                        const sourceUuid = resolveItemSourceUuid(item);
                        const nameKey = item.name?.trim().toLowerCase();
                        if (sourceUuid && !actorSpellByUuid.has(sourceUuid)) actorSpellByUuid.set(sourceUuid, item);
                        if (nameKey && !actorSpellByName.has(nameKey)) actorSpellByName.set(nameKey, item);
                    }

                    let skippedPendingCount = 0;
                    let skippedActorCount = 0;
                    let addedCount = 0;

                    for (const spell of classSpells) {
                        const nameKey = spell.name?.trim().toLowerCase();
                        const pendingItem = pendingSpellByUuid.get(spell.uuid) || pendingSpellByName.get(nameKey);
                        if (pendingItem) {
                            skippedPendingCount++;
                            continue;
                        }

                        const actorSpell = actorSpellByUuid.get(spell.uuid) || actorSpellByName.get(nameKey);
                        if (actorSpell) {
                            skippedActorCount++;
                            continue;
                        }

                        const doc = await this.dataManager.getDocument(spell.uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            applyPreparedListSpell(itemData, {
                                sourceUuid: spell.uuid,
                                sourceClass: classId
                            });
                            const pendingEntry = this._queuePendingItem(itemData, {
                                advancementId: 'spell-rules-prepared-grant',
                                level,
                                stepType: step.stepType || 'class'
                            });
                            if (spell.uuid) pendingSpellByUuid.set(spell.uuid, pendingEntry.itemData);
                            if (nameKey && !pendingSpellByName.has(nameKey)) pendingSpellByName.set(nameKey, pendingEntry.itemData);
                            addedCount++;
                        }
                    }

                    window.OriginateLog(`Originate | [LevelUp] 准备型法术获得: ${classId} 法表 ${minLevel}~${maxLevel}环 共 ${classSpells.length} 个法术, 跳过待添加 ${skippedPendingCount} 个, 跳过现有 ${skippedActorCount} 个, 新增 ${addedCount} 个`);
                } catch (e) {
                    console.error('Originate | [LevelUp] 准备型法术获得失败:', e);
                }
                break;
            }

            case 'trait_choice': {
                const section = overlay.querySelector('.trait-choice-section');
                if (!section) break;
                const stepType = section.dataset.stepType || 'class';
                const advId = section.dataset.advId;
                const mode = section.dataset.mode || 'default';
                const checked = section.querySelectorAll('input[type="checkbox"]:checked');
                const checkedKeys = Array.from(checked, cb => cb.value);
                const availableKeys = Array.from(section.querySelectorAll('input[type="checkbox"]'), input => input.value);
                if (availableKeys.some(key => this._shouldDebugTraitKey(key))) {
                    window.OriginateLog('Originate | [LevelUp][TraitDebug] 读取 trait 选择步骤', {
                        title: step.title,
                        advancementId: advId,
                        stepType,
                        parentFeature: step.parentFeature || null,
                        parentSourceUuid: step.parentSourceUuid || null,
                        level,
                        mode,
                        availableKeys,
                        checkedKeys
                    });
                }

                for (const key of checkedKeys) {
                    this._queueTraitChange(key, {
                        source: stepType,
                        advancementId: advId,
                        level,
                        parentFeature: step.parentFeature || null,
                        parentSourceUuid: step.parentSourceUuid || null,
                        mode
                    });
                }
                break;
            }

            case 'subclass_selection': {
                // 选择子职后：加载子职特性 + 补充本级所有其他特性（职业/种族/背景）
                const subclassUuid = state.stepData['subclass-selection']?.selectedSubclass;
                if (subclassUuid) {
                    await this._loadSubclassFeatureSteps(subclassUuid);
                    // 补充加载本级的职业/种族/背景特性（这些在 _triggerSubclassSelection 时被跳过了）
                    await this._loadRemainingLevelFeatures();
                }
                break;
            }
        }
    }

    // ========================================================================
    // 补充加载本级剩余特性（子职选择后调用）
    // ========================================================================

    async _loadRemainingLevelFeatures() {
        const level = this._state.targetLevel;
        const state = this._state;
        window.OriginateLog(`Originate | [LevelUp] 补充加载 Level ${level} 的职业/种族/背景特性...`);

        try {
            const isMulti = this._state.isMulticlassNewClass || false;
            const upgrades = await this.levelUpManager.getLevelUpgrades(level, { isMulticlassing: isMulti });

            const setSourceLevel = (events) => events.forEach(e => { e.sourceLevel = level; });
            setSourceLevel(upgrades.class);
            setSourceLevel(upgrades.race);
            setSourceLevel(upgrades.background);

            if (upgrades.class.length > 0) await this.dataManager.enrichOptions(upgrades.class);
            if (upgrades.race.length > 0) await this.dataManager.enrichOptions(upgrades.race);
            if (upgrades.background.length > 0) await this.dataManager.enrichOptions(upgrades.background);

            const newSteps = [];
            const grantedFeatures = [];

            // 复用 processEvents 逻辑（与 _loadLevelFeatures 一致）
            const processEvents = async (events, stepType) => {
                for (const event of events) {
                    if (event.type === 'features') {
                        const validItems = Array.isArray(event.items) ? event.items.filter(Boolean) : [];
                        if (validItems.length === 0) continue;

                        for (const item of validItems) {
                            await this._collectGrantedFeature(item, {
                                stepType,
                                advancementId: event._original?._id || event.id || event.title,
                                level,
                                featureBucket: grantedFeatures,
                                stepBucket: newSteps,
                                spellConfig: event.spellConfig || event._original?.configuration?.spell || null
                            });
                        }
                    } else if (event.type === 'asi') {
                        newSteps.push({ id: `asi-${level}`, type: 'asi_feat_choice', title: event.title || game.i18n.localize('ORIGINATE.UI.Progression.ASIFeatTitle'), points: event.points || 2, cap: event.cap || 2, stepType, advId: event._original?._id || event.id, event });
                    } else if (event.type === 'choice') {
                        const advId = event._original?._id || event.id || event.title;
                        // 补选入口与正常升级使用同一接管规则。
                        if (SpellRules.managesChoice(event, {
                            classIdentifier: this.levelUpManager.classItem?.system?.identifier,
                            subclassIdentifier: this.levelUpManager.subclassItem?.system?.identifier
                        })) {
                            window.OriginateLog(`Originate | [LevelUp] 基础法术 Advancement: ${event.title} (由 SpellRules 管理)`);
                            continue;
                        }
                        if (usesSpellBrowser(event)) {
                            ensureSpellChoiceRestriction(event);
                            newSteps.push({ id: `spell-choice-${advId}-${level}`, type: 'spell_choice', title: event.title, event, stepType, advId });
                        } else {
                            newSteps.push({ id: `choice-${advId}-${level}`, type: 'item_choice', title: event.title, event, stepType, advId });
                        }
                    } else if (event.type === 'trait_choice') {
                        const advId = event._original?._id || event.id || event.title;
                        newSteps.push({ id: `trait-${advId}-${level}`, type: 'trait_choice', title: event.title, event, stepType, advId });
                    } else if (event.type === 'trait_grant') {
                        const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);
                        for (const key of grants) {
                            this._queueTraitChange(key, {
                                source: stepType,
                                advancementId: event._original?._id || event.id,
                                level,
                                mode: event.mode || event._original?.configuration?.mode || 'default'
                            });
                        }
                    }
                }
            };

            await processEvents(upgrades.class, 'class');
            await processEvents(upgrades.race, 'race');
            await processEvents(upgrades.background, 'background');

            // HP 步骤插入到当前步骤后面
            const insertIndex = state.currentStepIndex + 1;
            const stepsToInsert = [];

            stepsToInsert.push({
                id: 'hp',
                type: 'hp',
                title: game.i18n.localize('ORIGINATE.UI.Progression.HPTitle')
            });

            if (grantedFeatures.length > 0) {
                stepsToInsert.push({
                    id: 'features',
                    type: 'features',
                    title: game.i18n.localize('ORIGINATE.UI.Progression.FeaturesTitle'),
                    items: grantedFeatures
                });
            }

            stepsToInsert.push(...newSteps);

            // ========== SpellRules: 补充生成法术步骤 ==========
            let spellRulesId = this.levelUpManager.classItem?.system?.identifier;
            if (spellRulesId && !SpellRules.getRules(spellRulesId)) {
                const subId = this.levelUpManager.subclassItem?.system?.identifier;
                if (subId && SpellRules.getRules(subId)) {
                    spellRulesId = subId;
                }
            }
            if (spellRulesId && SpellRules.getRules(spellRulesId)) {
                const fromLevel = this._state.isMulticlassNewClass ? 0 : (this.levelUpManager.currentLevel ?? (level - 1));
                const spellSteps = SpellRules.generateSpellSteps(spellRulesId, fromLevel, level, {
                    stepType: 'class', nativeChoices: upgrades.class
                });
                if (spellSteps.length > 0) {
                    window.OriginateLog(`Originate | [LevelUp] SpellRules 补充生成 ${spellSteps.length} 个法术步骤:`, spellSteps.map(s => s.title));
                    stepsToInsert.push(...spellSteps);
                }
            }

            const parentStepId = state.steps[state.currentStepIndex]?.id || null;
            state.steps.splice(insertIndex, 0, ...this._bindStepsToCurrentLevel(stepsToInsert, { parentStepId, level }));
            window.OriginateLog(`Originate | [LevelUp] 补充了 ${stepsToInsert.length} 个步骤:`, stepsToInsert.map(s => s.title));

        } catch (error) {
            console.error(`Originate | [LevelUp] 补充加载特性失败:`, error);
        }
    }

    // ========================================================================
    // 子职特性步骤加载
    // ========================================================================

    async _loadSubclassFeatureSteps(subclassUuid) {
        const level = this._state.targetLevel;
        const doc = await this.dataManager.getDocument(subclassUuid);
        if (doc) {
            const classIdentifier = this.levelUpManager.classItem?.system?.identifier || null;
            this._state.selectedSubclassContext = {
                uuid: subclassUuid,
                identifier: doc.system?.identifier || null,
                classIdentifier
            };
        }

        let subclassAdvs = await this.dataManager.getLevelAdvancement(subclassUuid, level);
        if (!subclassAdvs || subclassAdvs.length === 0) {
            const l0 = await this.dataManager.getLevelAdvancement(subclassUuid, 0);
            const l1 = await this.dataManager.getLevelAdvancement(subclassUuid, 1);
            subclassAdvs = [...l0, ...l1];
        }
        if (!subclassAdvs || subclassAdvs.length === 0) return;
        subclassAdvs.forEach(e => { e.sourceLevel = level; });
        await this.dataManager.enrichOptions(subclassAdvs);

        const debugSubclassTraits = subclassAdvs.filter(event => this._shouldDebugTraitEvent(event));
        if (debugSubclassTraits.length > 0) {
            this._logTraitStepDebug('子职升级里发现技能/工具 Trait 事件', {
                subclassUuid,
                level,
                events: debugSubclassTraits.map(event => ({
                    type: event.type,
                    title: event.title,
                    advancementId: event._original?._id || event.id || null,
                    mode: event.mode || event._original?.configuration?.mode || 'default',
                    pool: Array.isArray(event.pool) ? event.pool : Array.from(event.pool || []),
                    grants: Array.isArray(event.grants) ? event.grants : Array.from(event.grants || [])
                }))
            });
        }

        const newSteps = [];
        const subclassFeatures = [];

        for (const event of subclassAdvs) {
            if (event.type === 'features' && event.items?.length > 0) {
                for (const item of event.items.filter(Boolean)) {
                    await this._collectGrantedFeature(item, {
                        stepType: 'subclass',
                        advancementId: event._original?._id || event.id,
                        level,
                        featureBucket: subclassFeatures,
                        stepBucket: newSteps,
                        spellConfig: event.spellConfig || event._original?.configuration?.spell || null
                    });
                }
            } else if (event.type === 'choice') {
                const advId = event._original?._id || event.id;
                if (SpellRules.managesChoice(event, {
                    classIdentifier: this.levelUpManager.classItem?.system?.identifier,
                    subclassIdentifier: doc?.system?.identifier
                })) continue;
                if (usesSpellBrowser(event)) {
                    ensureSpellChoiceRestriction(event);
                    newSteps.push({ id: `subclass-spell-${advId}-${level}`, type: 'spell_choice', title: event.title, event, stepType: 'subclass', advId });
                } else {
                    newSteps.push({ id: `subclass-choice-${advId}-${level}`, type: 'item_choice', title: event.title, event, stepType: 'subclass', advId });
                }
            } else if (event.type === 'trait_choice') {
                const advId = event._original?._id || event.id;
                if (this._shouldDebugTraitEvent(event)) {
                    this._logTraitStepDebug('子职 Trait 选择步骤已加入升级流程', {
                        title: event.title,
                        advancementId: advId,
                        level,
                        stepType: 'subclass',
                        mode: event.mode || event._original?.configuration?.mode || 'default',
                        pool: Array.isArray(event.pool) ? event.pool : Array.from(event.pool || [])
                    });
                }
                newSteps.push({ id: `subclass-trait-${advId}-${level}`, type: 'trait_choice', title: event.title, event, stepType: 'subclass', advId });
            } else if (event.type === 'asi') {
                newSteps.push({ id: `subclass-asi-${level}`, type: 'asi_feat_choice', title: event.title, points: event.points || 2, cap: event.cap || 2, stepType: 'subclass', advId: event._original?._id || event.id, event });
            } else if (event.type === 'trait_grant') {
                const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);
                for (const key of grants) {
                    this._queueTraitChange(key, {
                        source: 'subclass',
                        advancementId: event._original?._id || event.id,
                        level,
                        parentFeature: event.parentFeature || null,
                        parentSourceUuid: event.parentSourceUuid || null,
                        mode: event.mode || event._original?.configuration?.mode || 'default'
                    });
                }
            }
        }

        if (subclassFeatures.length > 0) {
            newSteps.unshift({ id: 'subclass-features', type: 'features', title: game.i18n.localize('ORIGINATE.UI.Progression.SubclassFeaturesTitle'), items: subclassFeatures, stepType: 'subclass' });
        }

        if (newSteps.length > 0) {
            this._state.steps.splice(
                this._state.currentStepIndex + 1,
                0,
                ...this._bindStepsToCurrentLevel(newSteps, {
                    parentStepId: this._state.steps[this._state.currentStepIndex]?.id || null,
                    level
                })
            );
        }

        // ========== SpellRules: 为子职施法者补充法术步骤 ==========
        // 在初次获得子职的等级（如3级），subclassItem 尚不存在，
        // 但此时已知道选了哪个子职，可以用其 identifier 查找规则
        if (doc) {
            const subIdentifier = doc.system?.identifier;
            if (subIdentifier) {
                const mainClassId = this.levelUpManager.classItem?.system?.identifier;
                // 仅在主职无法术规则、子职有法术规则时生成
                if (!SpellRules.getRules(mainClassId) && SpellRules.getRules(subIdentifier)) {
                    const fromLevel = this.levelUpManager.currentLevel ?? (level - 1);
                    const spellSteps = SpellRules.generateSpellSteps(subIdentifier, fromLevel, level, {
                        stepType: 'subclass', nativeChoices: subclassAdvs
                    });
                    if (spellSteps.length > 0) {
                        window.OriginateLog(`Originate | [LevelUp] 子职 "${subIdentifier}" 生成 ${spellSteps.length} 个法术步骤:`, spellSteps.map(s => s.title));
                        const insertAt = this._state.currentStepIndex + 1 + newSteps.length;
                        this._state.steps.splice(
                            insertAt,
                            0,
                            ...this._bindStepsToCurrentLevel(spellSteps, {
                                parentStepId: this._state.steps[this._state.currentStepIndex]?.id || null,
                                level
                            })
                        );
                    }
                }
            }

            // 同时添加子职物品到 pending
            const itemData = doc.toObject();
            itemData._sourceUuid = subclassUuid;
            foundry.utils.setProperty(itemData, 'system.levels', level);
            const classIdentifier = this.levelUpManager.classItem?.system?.identifier;
            if (classIdentifier && !itemData.system?.classIdentifier) {
                foundry.utils.setProperty(itemData, 'system.classIdentifier', classIdentifier);
            }
            const pendingEntry = this._queuePendingItem(itemData, {
                advancementId: 'subclass-grant',
                level: this._state.targetLevel,
                stepType: 'subclass',
                isSubclass: true
            });

            // 子职选择要尽量排在本级其他待提交物品前面。
            // 原生试点里它决定了后面很多 nested advancement 有没有父节点可挂。
            const pendingIndex = this._state.pendingItems.indexOf(pendingEntry);
            if (pendingIndex > 0) {
                this._state.pendingItems.splice(pendingIndex, 1);
                this._state.pendingItems.unshift(pendingEntry);
            }
        }
    }

    // ========================================================================
    // 完成升级（通过 LevelUpManager 写入 Actor）
    // ========================================================================

    async _collectSelectedFeatPendingItems(state = this._state) {
        const featPendingItems = [];
        for (const feat of state.selectedFeats) {
            const doc = await this.dataManager.getDocument(feat.uuid);
            if (!doc) continue;

            const step = state.steps.find(s => s.id === feat.sourceStepId);
            const itemData = doc.toObject();
            if (feat.uuid) itemData._sourceUuid = feat.uuid;

            featPendingItems.push({
                itemData,
                advancementId: feat.advancementId || step?.advId || 'feat-grant',
                level: state.targetLevel,
                stepType: feat.stepType || step?.stepType || 'class',
                parentFeature: feat.parentFeature || step?.parentFeature || null,
                parentSourceUuid: feat.parentSourceUuid || step?.parentSourceUuid || null
            });
        }

        return featPendingItems;
    }

    async _buildCurrentLevelResolutionInput(state = this._state) {
        this._pruneCurrentLevelSandbox(state);
        const featPendingItems = await this._collectSelectedFeatPendingItems(state);
        const selectedSubclassContext = state.selectedSubclassContext || {};

        // 这里先把本级提交收成一份正式结构。
        // 后面真要切原生执行时，只改这一层，不用再回头从 UI 状态里东拼西凑。
        const levelResolutionInput = this.levelUpManager.createLevelResolutionInput({
            level: state.targetLevel,
            context: {
                classItemId: this.levelUpManager.classItem?.id || null,
                subclassItemId: this.levelUpManager.subclassItem?.id || null,
                classIdentifier: this.levelUpManager.classItem?.system?.identifier || null,
                subclassIdentifier: this.levelUpManager.subclassItem?.system?.identifier || selectedSubclassContext.identifier || null,
                classUuid: this.levelUpManager.classUuid || null,
                subclassUuid: this.levelUpManager.subclassUuid || selectedSubclassContext.uuid || null,
                lockedLevel: state.targetLevel
            },
            hpGain: state.hpGain,
            hpMethod: state.hpMethod,
            pendingItems: [...state.pendingItems, ...featPendingItems],
            pendingItemUpdates: state.pendingItemUpdates,
            pendingReplacements: state.pendingReplacements,
            pendingTraitChanges: state.pendingTraitChanges,
            selectedFeats: state.selectedFeats,
            abilityScoreImprovements: (state.abilityScoreImprovements || []).map(({ _entryKey, ...entry }) => entry),
            asiChanges: state.asiChanges
        });

        const debugTraitChanges = levelResolutionInput.traitChanges.filter(change => this._shouldDebugTraitKey(change.key));
        if (debugTraitChanges.length > 0) {
            window.OriginateLog('Originate | [LevelUp][TraitDebug] 当前级结算输入中的技能/工具 Trait', {
                level: levelResolutionInput.level,
                context: levelResolutionInput.context,
                traitChanges: debugTraitChanges
            });
        }

        return levelResolutionInput;
    }

    async _onFinish() {
        const state = this._state;

        try {
            ui.notifications.info(game.i18n.localize("ORIGINATE.LevelUp.Applying"));

            const levelResolutionInput = await this._buildCurrentLevelResolutionInput(state);
            const initialItemIds = new Set(this.actor.items.map(item => item.id));

            // 1. 增加职业等级
            await this.levelUpManager.increaseClassLevel(levelResolutionInput.level);

            // 2. 更新 HP
            if (levelResolutionInput.hp.gain !== null) {
                await this.levelUpManager.updateHP(
                    levelResolutionInput.hp.gain,
                    levelResolutionInput.hp.method,
                    levelResolutionInput.level
                );
            }

            // 3. 统一处理本级涉及 Item 的写入。
            const resolutionResult = await this.levelUpManager.applyLevelResolutionInput(levelResolutionInput);

            // 4. 处理 ASI，并把 dnd5e 降级要用的 advancement value 一起补齐。
            const abilityScoreRepairs = await this.levelUpManager.applyAbilityScoreImprovementsFromInput(levelResolutionInput);
            if (Object.keys(abilityScoreRepairs.actorUpdate || {}).length > 0
                || (abilityScoreRepairs.abilityScoreImprovements || []).length > 0
                || (abilityScoreRepairs.selectedFeats || []).length > 0) {
                window.OriginateLog('Originate | [LevelUp] 当前级 ASI 配置校准完成', abilityScoreRepairs);
            }

            // 5. 应用特质变更
            if ((resolutionResult.remainingTraitChanges || []).length > 0) {
                this._logTraitStepDebug('开始执行手工 Trait 回退', {
                    remainingTraitChanges: resolutionResult.remainingTraitChanges,
                    beforeState: this._snapshotTraitState(),
                    nativeResolution: resolutionResult.nativeResolution
                });
                const traitFallback = await this.levelUpManager.applyRemainingTraitChanges(
                    resolutionResult.remainingTraitChanges
                );
                if (Object.keys(traitFallback.actorUpdate || {}).length > 0) {
                    this._logTraitStepDebug('手工 Trait 回退已由 manager 写入 Actor', {
                        actorUpdate: traitFallback.actorUpdate,
                        appliedChanges: traitFallback.appliedChanges,
                        skippedChanges: traitFallback.skippedChanges
                    });
                }
                this._logTraitStepDebug('手工 Trait 回退写入完成', {
                    afterState: this._snapshotTraitState()
                });
            } else {
                this._logTraitStepDebug('当前级没有剩余的手工 Trait 回退项', {
                    nativeResolution: resolutionResult.nativeResolution,
                    currentState: this._snapshotTraitState()
                });
            }

            // 升级链路也补一遍原生 advancement 回填。
            // 这里必须只看本次 levelResolutionInput，不再让 writer 全局扫 Actor。
            // 多职业时全局扫描会从旧职业物品反推本级选择，容易把子职和 Fighting Style 写乱。
            try {
                const advancementRepairs = await this.levelUpManager.repairLevelAdvancementsFromInput(levelResolutionInput);
                window.OriginateLog('Originate | [LevelUp] 当前级 advancement 配置校准完成', {
                    itemAdvancements: advancementRepairs.itemAdvancements || [],
                    traitAdvancements: advancementRepairs.traitAdvancements || []
                });
            } catch (repairError) {
                console.warn("Originate | [LevelUp] Advancement repair failed:", repairError);
            }

            try {
                const originRepairs = await this.levelUpManager.repairAdvancementOriginsFromInput(levelResolutionInput);
                window.OriginateLog('Originate | [LevelUp] 当前级 advancement origin 配置校准完成', {
                    origins: originRepairs.origins || [],
                    skipped: originRepairs.skipped || []
                });
            } catch (repairError) {
                console.warn("Originate | [LevelUp] Advancement origin repair failed:", repairError);
            }

            resolutionResult.itemModifications = await this.levelUpManager.applyModifyItemAdvancementsFromInput(
                levelResolutionInput, { initialItemIds }
            );
            if (resolutionResult.itemModifications.status === 'failed') {
                ui.notifications.warn(game.i18n.localize('ORIGINATE.Notification.ItemModificationsIncomplete'), { permanent: true });
            } else {
                ui.notifications.info(game.i18n.format("ORIGINATE.LevelUp.Complete", { name: this.actor.name, level: state.targetLevel }));
            }

            // Разрешение ГМа одноразовое: один выданный уровень = одно завершённое повышение.
            try {
                await consumeActorLevelUpGrant(this.actor);
            } catch (grantError) {
                console.warn('Character Forge | Не удалось снять разрешение на повышение уровня:', grantError);
            }

            await this.close();

            // 升级完成后自动打开角色卡
            this.actor.sheet.render(true);
        } catch (error) {
            console.error("Originate | [LevelUp] 升级失败:", error);
            ui.notifications.error(game.i18n.localize("ORIGINATE.LevelUp.Failed"));
        }
    }

    // ========================================================================
    // 工具方法（从 progression-mixin.js / ui-mixin.js 复制）
    // ========================================================================

    // ========================================================================
    //  以下工具方法委托给 shared/progression-renderer.js
    //  Phase 1 重构：保留方法名兼容调用方，内部转发到共享模块
    // ========================================================================

    _expandWildcardPool(poolArray) {
        return expandWildcardPool(poolArray);
    }

    _traverseLanguageTree(langObj, results) {
        return traverseLanguageTree(langObj, results);
    }

    _getTraitLabel(key) {
        return getTraitLabel(key);
    }

    _findLanguageLabel(langKey, langObj) {
        return findLanguageLabel(langKey, langObj);
    }

    _cleanDescription(desc) {
        return cleanDescription(desc);
    }

    _getFullCleanDescription(desc) {
        return getFullCleanDescription(desc);
    }

    async _showConfirmDialog(options) {
        return showConfirmDialog(options, this.element);
    }

    _processHtmlDescription(desc) {
        return processHtmlDescription(desc);
    }

    _bindTooltips(overlay) {
        return bindTooltips(overlay, this.dataManager);
    }

    _updateTooltipPosition(e, tooltip) {
        return updateTooltipPosition(e, tooltip);
    }
    // ========================================================================
    // 关闭 & UI 隐藏
    // ========================================================================

    async close(options) {
        const result = await super.close(options);
        document.body.classList.remove("originate-active");
        document.querySelectorAll('.originate-hidden-target').forEach(el => {
            el.style.removeProperty('display');
            el.classList.remove('originate-hidden-target');
        });
        // 恢复被降低的 z-index
        document.querySelectorAll('[data-originate-saved-z]').forEach(el => {
            el.style.removeProperty('z-index');
            delete el.dataset.originateSavedZ;
        });
        // 清理可能残留的 tooltip
        document.querySelectorAll('.originate-tooltip, .originate-spell-tooltip').forEach(el => el.remove());

        // После закрытия Level Up тяжёлый CSS полностью удаляется из страницы.
        releaseForgeStyles(this);
        return result;
    }

    /**
     * 为法术卡片绑定悬停 tooltip
     * 可复用于法术浏览器、法术替换等任何包含 .spell-card 的容器
     * @param {HTMLElement} container - 包含 .spell-card 的容器元素
     * @param {Array} spellsRef - 当前法术数组的引用（用于查找法术数据）
     * @param {Function} getSpells - 可选，返回当前法术数组的函数（用于动态刷新场景）
     */
    _bindSpellCardTooltips(container, spellsRef, getSpells = null) {
        if (!container) return;

        container.querySelectorAll('.spell-card').forEach(card => {
            card.addEventListener('pointerenter', async (ev) => {
                const uuid = card.dataset.uuid;
                const spells = getSpells ? getSpells() : spellsRef;
                const spell = spells?.find(s => s.uuid === uuid);
                if (!spell) return;

                if (!spell.description) {
                    try {
                        const doc = await fromUuid(uuid);
                        if (doc) spell.description = doc.system.description?.value || '';
                    } catch (e) {
                        console.warn(`Originate | Failed to load spell for tooltip: ${uuid}`, e);
                    }
                }

                if (spell?.description) {
                    let descText;
                    try {
                        descText = await TextEditor.enrichHTML(spell.description, { async: true });
                    } catch (e) {
                        descText = this._processHtmlDescription(spell.description);
                    }

                    let tooltip = document.querySelector('.originate-spell-tooltip');
                    if (!tooltip) {
                        tooltip = document.createElement('div');
                        tooltip.className = 'originate-spell-tooltip';
                        Object.assign(tooltip.style, {
                            position: 'fixed',
                            zIndex: '100000',
                            maxWidth: '450px',
                            minWidth: '250px',
                            width: 'auto',
                            overflowY: 'auto',
                            background: 'linear-gradient(135deg, rgba(20,18,15,0.97), rgba(35,30,25,0.97))',
                            border: '1px solid rgba(200,163,95,0.4)',
                            borderRadius: '6px',
                            padding: '12px 14px',
                            color: '#e8dcc8',
                            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
                            backdropFilter: 'blur(8px)',
                            pointerEvents: 'auto',
                            fontSize: '0.85rem',
                            lineHeight: '1.6'
                        });
                        tooltip.addEventListener('mouseleave', () => {
                            tooltip.style.display = 'none';
                        });
                        // 只在 tooltip 内容有溢出时才拦截滚轮
                        tooltip.addEventListener('wheel', (e) => {
                            const hasOverflow = tooltip.scrollHeight > tooltip.clientHeight;
                            if (!hasOverflow) return; // 不拦截，让事件冒泡给列表

                            // 检查是否到达滚动边界
                            const atTop = tooltip.scrollTop <= 0 && e.deltaY < 0;
                            const atBottom = (tooltip.scrollTop + tooltip.clientHeight >= tooltip.scrollHeight - 1) && e.deltaY > 0;
                            if (atTop || atBottom) return; // 到达边界，让事件冒泡

                            e.preventDefault();
                            e.stopPropagation();
                            tooltip.scrollTop += e.deltaY;
                        }, { passive: false });
                        document.body.appendChild(tooltip);
                    }

                    tooltip.innerHTML = `
                        <div style="font-weight:bold; color:#c8a35f; font-size:1rem; margin-bottom:0.4rem; border-bottom:1px solid rgba(200,163,95,0.3); padding-bottom:0.3rem;">${spell.name}</div>
                        <div style="color:rgba(200,163,95,0.7); font-size:0.75rem; margin-bottom:0.6rem; font-style:italic;">${CONFIG.DND5E.spellLevels[spell.level] || ''} • ${CONFIG.DND5E.spellSchools[spell.school]?.label || ''}</div>
                        <div style="word-wrap:break-word;">${descText}</div>
                    `;

                    // 先不设 maxHeight，让其自然高度
                    tooltip.style.maxHeight = 'none';
                    tooltip.style.display = 'block';
                    tooltip.scrollTop = 0;

                    const rect = card.getBoundingClientRect();
                    const tooltipRect = tooltip.getBoundingClientRect();

                    let left = rect.right + 12;
                    let top = rect.top;

                    if (left + tooltipRect.width > window.innerWidth - 10) {
                        left = rect.left - tooltipRect.width - 12;
                    }
                    if (left < 10) {
                        left = Math.max(10, (window.innerWidth - tooltipRect.width) / 2);
                    }

                    // 计算可用高度：从 top 到屏幕底部的距离
                    const availableDown = window.innerHeight - top - 10;
                    const availableUp = top - 10;

                    if (tooltipRect.height > availableDown) {
                        // tooltip 太高，超出屏幕底部
                        if (tooltipRect.height <= availableUp) {
                            // 放到卡片上方
                            top = top - tooltipRect.height;
                        } else {
                            // 两边都放不下，限制高度到较大一侧
                            if (availableDown >= availableUp) {
                                tooltip.style.maxHeight = `${availableDown}px`;
                            } else {
                                top = 10;
                                tooltip.style.maxHeight = `${availableUp}px`;
                            }
                        }
                    }
                    if (top < 10) top = 10;

                    tooltip.style.left = `${left}px`;
                    tooltip.style.top = `${top}px`;
                }
            });

            // 卡片上的滚轮：只在 tooltip 有溢出内容时转发
            card.addEventListener('wheel', (e) => {
                const tooltip = document.querySelector('.originate-spell-tooltip');
                if (tooltip && tooltip.style.display === 'block') {
                    const hasOverflow = tooltip.scrollHeight > tooltip.clientHeight;
                    if (hasOverflow) {
                        const atTop = tooltip.scrollTop <= 0 && e.deltaY < 0;
                        const atBottom = (tooltip.scrollTop + tooltip.clientHeight >= tooltip.scrollHeight - 1) && e.deltaY > 0;
                        if (!atTop && !atBottom) {
                            e.preventDefault();
                            tooltip.scrollTop += e.deltaY;
                        }
                    }
                    // 没有溢出或到达边界时，不 preventDefault，让列表滚动
                }
            }, { passive: false });

            card.addEventListener('pointerleave', (e) => {
                const tooltip = document.querySelector('.originate-spell-tooltip');
                if (tooltip) {
                    const tooltipRect = tooltip.getBoundingClientRect();
                    if (e.clientX >= tooltipRect.left && e.clientX <= tooltipRect.right &&
                        e.clientY >= tooltipRect.top && e.clientY <= tooltipRect.bottom) {
                        return;
                    }
                    tooltip.style.display = 'none';
                }
            });
        });
    }

    _hideConflictingUI() {
        const selectors = ["#ui-left", "#ui-top", "#ui-right", "#ui-bottom", "#board", "#bg3-hotbar-container", ".bg3-hud", ".bg3-no-adapter-notice", "[id^='bg3-hud']", ".bg3-hud-dnd5e"];
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                el.style.setProperty('display', 'none', 'important');
                el.classList.add('originate-hidden-target');
            });
        });

        // 隐藏当前角色的角色卡和其他可能遮挡的 ApplicationV2 窗口
        // Foundry V13 的 ApplicationV2 窗口 z-index 可能超过 10000
        try {
            // 关闭当前角色的角色卡
            if (this.actor?.sheet?.rendered) {
                this.actor.sheet.close({ animate: false });
            }

            // 将所有打开的 ApplicationV2 窗口 z-index 降低
            document.querySelectorAll('.application').forEach(el => {
                // 不影响自身和通知
                if (el.id === 'originate-levelup') return;
                if (el.id === 'ui-notifications') return;
                const currentZ = parseInt(el.style.zIndex || window.getComputedStyle(el).zIndex) || 0;
                if (currentZ >= 10000) {
                    el.dataset.originateSavedZ = currentZ;
                    el.style.setProperty('z-index', '1', 'important');
                }
            });
        } catch (e) {
            console.warn("Originate | Failed to hide conflicting windows:", e);
        }
    }
}


// 这里只借用 UI 能力。descriptor 不覆盖 LevelUpApp 已有方法，所以升级的状态和提交入口仍归本类。
const mixinDescriptors = Object.getOwnPropertyDescriptors(WizardUIMixin.prototype);
delete mixinDescriptors.constructor; // 不覆盖 constructor
Object.defineProperties(LevelUpApp.prototype, mixinDescriptors);
