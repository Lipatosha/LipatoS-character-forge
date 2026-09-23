/**
 * SpellRulesConfigApp - 法术规则配置独立窗口
 * 
 * 独立于主配置面板的法术规则管理界面。
 * 以表格形式展示每个职业的法术数量配置。
 */

import { SpellRules } from '../spell-rules.js';

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class SpellRulesConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "originate-spell-rules-config",
        classes: ["originate-spell-rules-app"],
        position: {
            width: 960,
            height: 700
        },
        window: {
            title: "ORIGINATE.Settings.SpellRules.TabTitle",
            icon: "fas fa-hat-wizard",
            resizable: true
        },
        actions: {
            saveSpellRule: SpellRulesConfigApp.prototype._onSaveSpellRule,
            resetSpellRule: SpellRulesConfigApp.prototype._onResetSpellRule,
            deleteSpellRule: SpellRulesConfigApp.prototype._onDeleteSpellRule,
            addSpellRule: SpellRulesConfigApp.prototype._onAddSpellRule,
            toggleClassExpand: SpellRulesConfigApp.prototype._onToggleClassExpand
        }
    };

    static PARTS = {
        main: {
            template: "modules/character-forge/templates/spell-rules-config.hbs"
        }
    };

    constructor(options = {}) {
        super(options);
        this._expandedClasses = new Set();
    }

    async _prepareContext(options) {
        const defaultRules = SpellRules.getDefaultRules();
        let customRules = {};
        try { customRules = game.settings.get('character-forge', 'spellRules') || {}; } catch (e) { /* */ }

        const allClassIds = new Set([...Object.keys(defaultRules), ...Object.keys(customRules)]);
        const typeLabels = {
            known: game.i18n.localize('ORIGINATE.Settings.SpellRules.TypeKnown'),
            prepared: game.i18n.localize('ORIGINATE.Settings.SpellRules.TypePrepared'),
            pact: game.i18n.localize('ORIGINATE.Settings.SpellRules.TypePact')
        };
        const progressionLabels = { full: 'Full', half: 'Half', third: 'Third', pact: 'Pact' };

        const classes = [];
        for (const id of allClassIds) {
            const base = defaultRules[id] || {};
            const custom = customRules[id] || {};
            const merged = foundry.utils.mergeObject(base, custom, { inplace: false });

            const cantripsRow = [];
            const knownSpellsRow = [];
            const preparedSpellsRow = [];
            for (let lvl = 1; lvl <= 20; lvl++) {
                cantripsRow.push({ level: lvl, value: merged.cantripsKnown?.[lvl] ?? 0 });
                knownSpellsRow.push({ level: lvl, value: merged.spellsKnown?.[lvl] ?? 0 });
                preparedSpellsRow.push({ level: lvl, value: merged.preparedSpells?.[lvl] ?? 0 });
            }

            const hasKnownSpellsRow = Object.keys(merged.spellsKnown || {}).length > 0;
            const hasPreparedSpellsRow = Object.keys(merged.preparedSpells || {}).length > 0;

            classes.push({
                id,
                label: id.charAt(0).toUpperCase() + id.slice(1),
                type: merged.type || 'known',
                typeLabel: typeLabels[merged.type] || merged.type,
                progression: merged.progression || 'full',
                progressionLabel: progressionLabels[merged.progression] || merged.progression,
                listStr: (merged.list || [id]).join(', '),
                replacementsPerLevel: merged.replacementsPerLevel ?? 0,
                preparedFormula: merged.preparedFormula || '',
                showPreparedFormula: merged.type === 'prepared' && !hasPreparedSpellsRow,
                isCustom: !defaultRules[id] && !!customRules[id],
                isExpanded: this._expandedClasses.has(id),
                cantripsRow,
                knownSpellsRow,
                preparedSpellsRow,
                hasKnownSpellsRow,
                hasPreparedSpellsRow
            });
        }

        classes.sort((a, b) => a.label.localeCompare(b.label));
        const levelColumns = Array.from({ length: 20 }, (_, i) => i + 1);

        return { classes, levelColumns };
    }

    // 交互动作

    _onToggleClassExpand(event, target) {
        const classId = target.dataset.class;
        if (!classId) return;
        if (this._expandedClasses.has(classId)) {
            this._expandedClasses.delete(classId);
        } else {
            this._expandedClasses.add(classId);
        }
        this.render();
    }

    async _onSaveSpellRule(event, target) {
        const classId = target.dataset.class;
        if (!classId) return;

        const card = this.element.querySelector(`.spell-rule-card[data-class-id="${classId}"]`);
        if (!card) return;

        const type = card.querySelector(`[data-field="type"][data-class="${classId}"]`)?.value || 'known';
        const progression = card.querySelector(`[data-field="progression"][data-class="${classId}"]`)?.value || 'full';
        const listStr = card.querySelector(`[data-field="list"][data-class="${classId}"]`)?.value || classId;
        const replacements = parseInt(card.querySelector(`[data-field="replacementsPerLevel"][data-class="${classId}"]`)?.value) || 0;
        const preparedFormula = card.querySelector(`[data-field="preparedFormula"][data-class="${classId}"]`)?.value || '';

        const cantripsKnown = {};
        const spellsKnown = {};
        const preparedSpells = {};
        card.querySelectorAll(`.sr-cell[data-class="${classId}"]`).forEach(input => {
            const lvl = parseInt(input.dataset.level);
            const val = parseInt(input.value) || 0;
            if (input.dataset.row === 'cantrips') cantripsKnown[lvl] = val;
            else if (input.dataset.row === 'spellsKnown') spellsKnown[lvl] = val;
            else if (input.dataset.row === 'preparedSpells') preparedSpells[lvl] = val;
        });

        const rule = {
            type, progression,
            list: listStr.split(/[,;]/).map(s => s.trim()).filter(s => s),
            replacementsPerLevel: replacements,
            cantripsKnown
        };
        if (Object.keys(spellsKnown).length > 0) rule.spellsKnown = spellsKnown;
        if (Object.keys(preparedSpells).length > 0) rule.preparedSpells = preparedSpells;
        if (type === 'prepared' && !Object.keys(preparedSpells).length) rule.preparedFormula = preparedFormula;

        const customRules = foundry.utils.deepClone(game.settings.get('character-forge', 'spellRules') || {});
        customRules[classId] = rule;
        await game.settings.set('character-forge', 'spellRules', customRules);

        ui.notifications.info(`Originate | 法术规则已保存: ${classId}`);
        this.render();
    }

    async _onResetSpellRule(event, target) {
        const classId = target.dataset.class;
        if (!classId) return;

        const confirmed = await DialogV2.confirm({
            window: {
                title: game.i18n.localize('ORIGINATE.Settings.SpellRules.ResetConfirm')
            },
            content: `<p>${game.i18n.localize('ORIGINATE.Settings.SpellRules.ResetConfirmContent')}</p>`
        });
        if (!confirmed) return;

        const customRules = foundry.utils.deepClone(game.settings.get('character-forge', 'spellRules') || {});
        delete customRules[classId];
        await game.settings.set('character-forge', 'spellRules', customRules);

        ui.notifications.info(`Originate | 法术规则已重置: ${classId}`);
        this.render();
    }

    async _onDeleteSpellRule(event, target) {
        const classId = target.dataset.class;
        if (!classId) return;

        const defaultRules = SpellRules.getDefaultRules();
        if (defaultRules[classId]) {
            ui.notifications.warn('不能删除内置职业的法术规则，只能重置为默认值');
            return;
        }

        const confirmed = await DialogV2.confirm({
            window: {
                title: game.i18n.localize('ORIGINATE.Settings.SpellRules.DeleteConfirm')
            },
            content: `<p>${game.i18n.localize('ORIGINATE.Settings.SpellRules.DeleteConfirmContent')}</p>`
        });
        if (!confirmed) return;

        const customRules = foundry.utils.deepClone(game.settings.get('character-forge', 'spellRules') || {});
        delete customRules[classId];
        await game.settings.set('character-forge', 'spellRules', customRules);

        ui.notifications.info(`Originate | 法术规则已删除: ${classId}`);
        this.render();
    }

    async _onAddSpellRule(event, target) {
        const content = `
            <form>
                <div class="form-group">
                    <label>${game.i18n.localize('ORIGINATE.Settings.SpellRules.ClassIdentifier')}</label>
                    <input type="text" name="classId" placeholder="例如: mystic" autofocus>
                    <p class="hint">${game.i18n.localize('ORIGINATE.Settings.SpellRules.ClassIdentifierHint')}</p>
                </div>
            </form>
        `;

        try {
            const classId = await DialogV2.prompt({
                window: {
                    title: game.i18n.localize('ORIGINATE.Settings.SpellRules.AddClass')
                },
                content,
                ok: {
                    label: game.i18n.localize('ORIGINATE.Settings.SpellRules.Add'),
                    callback: (_event, button) => {
                        return button.form?.elements?.classId?.value?.trim()?.toLowerCase() || '';
                    }
                }
            });

            if (classId == null) return;
            if (!classId) {
                ui.notifications.warn('请输入职业标识符');
                return;
            }
            if (!/^[a-z][a-z0-9_-]*$/.test(classId)) {
                ui.notifications.warn('标识符只能包含小写字母、数字、下划线和连字符');
                return;
            }

            const customRules = foundry.utils.deepClone(game.settings.get('character-forge', 'spellRules') || {});
            if (customRules[classId] || SpellRules.getDefaultRules()[classId]) {
                ui.notifications.warn(`${classId} 的法术规则已存在`);
                return;
            }

            customRules[classId] = {
                type: 'known',
                list: [classId],
                progression: 'full',
                replacementsPerLevel: 0,
                cantripsKnown: { 1: 2, 4: 3, 10: 4 },
                spellsKnown: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 12, 13: 13, 14: 13, 15: 14, 16: 14, 17: 15, 18: 15, 19: 15, 20: 15 }
            };
            await game.settings.set('character-forge', 'spellRules', customRules);
            ui.notifications.info(`Originate | 已添加法术规则: ${classId}`);
            this._expandedClasses.add(classId);
            this.render();
        } catch (_error) {
            // 这里基本只兜极端情况，普通关闭会直接返回 null。
        }
    }
}
