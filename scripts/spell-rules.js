/**
 * SpellRules - 法术规则系统
 * 
 * 定义每个施法职业每个等级的法术选择规则。
 * DM 可在设置中覆盖默认值。
 * 
 * 用于替代原生 dnd5e Advancement 中的法术选取逻辑，
 * 使法术选择不再依赖 Advancement 事件。
 */

import { isBaseSpellProgressionChoice, isSpellChoiceEvent } from './shared/advancement-choice-rules.js';

// PHB 2024 默认法术规则

function toLevelMap(values) {
    return Object.fromEntries(values.map((value, index) => [index + 1, value]));
}

const ACTIVE_EFFECT_ADD_MODE = globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2;

/**
 * 内置默认规则：PHB 2024 标准职业
 * 
 * type: "known" | "prepared" | "pact"
 *   - known: 已知法术型（法师、部分子职）—— 升级时选固定数量
 *   - prepared: 准备法术型（牧师、德鲁伊、圣武士）—— 获得整个法表
 *   - pact: 契约法术型（邪术师）—— 已知法术但使用契约位
 * 
 * spellsKnown: { level: totalKnown } — 该等级时总共应知道的法术数
 * preparedSpells: { level: totalPrepared } — 2024 准备型职业的准备法术数表
 * cantripsKnown: { level: totalCantrips } — 该等级时总共应知道的戏法数
 * replacementsPerLevel: number — 每次升级可替换的法术数
 * progression: "full" | "half" | "third" | "pact" — 施法进度类型
 * list: string[] — 法表来源标识符
 */
const DEFAULT_SPELL_RULES = {
    bard: {
        type: "known",
        list: ["bard"],
        progression: "full",
        replacementsPerLevel: 0,
        cantripsKnown: toLevelMap([2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]),
        spellsKnown: toLevelMap([4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22])
    },

    sorcerer: {
        type: "known",
        list: ["sorcerer"],
        progression: "full",
        replacementsPerLevel: 0,
        cantripsKnown: toLevelMap([4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]),
        spellsKnown: toLevelMap([2, 4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22])
    },

    warlock: {
        type: "pact",
        list: ["warlock"],
        progression: "pact",
        replacementsPerLevel: 1,
        cantripsKnown: {
            1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4,
            11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4
        },
        spellsKnown: {
            1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 10,
            11: 11, 12: 11, 13: 12, 14: 12, 15: 13, 16: 13, 17: 14, 18: 14, 19: 15, 20: 15
        }
    },

    ranger: {
        type: "known",
        list: ["ranger"],
        progression: "half",
        replacementsPerLevel: 0,
        // 2024 游侠没有戏法，这里故意全留 0，别再让 UI 给它多生一排戏法选择。
        cantripsKnown: toLevelMap(new Array(20).fill(0)),
        spellsKnown: toLevelMap([2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15])
    },

    cleric: {
        type: "prepared",
        list: ["cleric"],
        progression: "full",
        replacementsPerLevel: 0,
        cantripsKnown: {
            1: 3, 2: 3, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 5,
            11: 5, 12: 5, 13: 5, 14: 5, 15: 5, 16: 5, 17: 5, 18: 5, 19: 5, 20: 5
        },
        // prepared 类型：preparedFormula 定义准备数量，spellsKnown 不用
        preparedFormula: "level + wis"
    },

    druid: {
        type: "prepared",
        list: ["druid"],
        progression: "full",
        replacementsPerLevel: 0,
        cantripsKnown: {
            1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4,
            11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4
        },
        preparedFormula: "level + wis"
    },

    paladin: {
        type: "prepared",
        list: ["paladin"],
        progression: "half",
        replacementsPerLevel: 0,
        cantripsKnown: {},
        preparedFormula: "half_level + cha"
    },

    wizard: {
        type: "known",
        list: ["wizard"],
        progression: "full",
        replacementsPerLevel: 0,
        cantripsKnown: toLevelMap([3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),
        // 法师每级获得 2 个法术（抄写到法术书）
        spellsKnown: {
            1: 6, 2: 8, 3: 10, 4: 12, 5: 14, 6: 16, 7: 18, 8: 20, 9: 22, 10: 24,
            11: 26, 12: 28, 13: 30, 14: 32, 15: 34, 16: 36, 17: 38, 18: 40, 19: 42, 20: 44
        }
    },

    artificer: {
        type: "known",
        list: ["artificer"],
        progression: "half",
        replacementsPerLevel: 0,
        cantripsKnown: {
            1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3,
            11: 3, 12: 3, 13: 3, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4
        },
        spellsKnown: toLevelMap([2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15])
    },

    // 子职施法者

    "eldritch-knight": {
        type: "known",
        list: ["wizard"],
        progression: "third",
        replacementsPerLevel: 1,
        cantripsKnown: {
            1: 0, 2: 0, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3,
            11: 3, 12: 3, 13: 3, 14: 3, 15: 3, 16: 3, 17: 3, 18: 3, 19: 3, 20: 3
        },
        spellsKnown: {
            1: 0, 2: 0, 3: 3, 4: 4, 5: 4, 6: 4, 7: 5, 8: 6, 9: 6, 10: 7,
            11: 8, 12: 8, 13: 9, 14: 10, 15: 10, 16: 11, 17: 11, 18: 11, 19: 12, 20: 13
        }
    },

    trickster: {
        type: "known",
        list: ["wizard"],
        progression: "third",
        replacementsPerLevel: 1,
        cantripsKnown: {
            1: 0, 2: 0, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4,
            11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4, 20: 4
        },
        spellsKnown: {
            1: 0, 2: 0, 3: 3, 4: 4, 5: 4, 6: 4, 7: 5, 8: 6, 9: 6, 10: 7,
            11: 8, 12: 8, 13: 9, 14: 10, 15: 10, 16: 11, 17: 11, 18: 11, 19: 12, 20: 13
        }
    }
};


// SpellRules 类

export class SpellRules {

    /**
     * 获取某职业的法术规则（DM 自定义优先，否则用内置默认值）
     * @param {string} classIdentifier - 职业标识符（如 "bard", "cleric"）
     * @returns {Object|null} 法术规则对象，未找到则返回 null
     */
    static getRules(classIdentifier) {
        if (!classIdentifier) return null;
        const id = classIdentifier.toLowerCase();

        // 1. 尝试读取 DM 自定义规则
        try {
            const customRules = game.settings.get('character-forge', 'spellRules') || {};
            if (customRules[id]) {
                return foundry.utils.mergeObject(
                    DEFAULT_SPELL_RULES[id] || {},
                    customRules[id],
                    { inplace: false }
                );
            }
        } catch (e) {
            // 设置未注册时静默回退
        }

        // 2. 使用内置默认值
        return DEFAULT_SPELL_RULES[id] || null;
    }

    /**
     * 获取所有有法术规则的职业列表
     * @returns {string[]} 职业标识符列表
     */
    static getAllConfiguredClasses() {
        const classes = new Set(Object.keys(DEFAULT_SPELL_RULES));
        try {
            const customRules = game.settings.get('character-forge', 'spellRules') || {};
            Object.keys(customRules).forEach(k => classes.add(k));
        } catch (e) { /* 静默 */ }
        return Array.from(classes);
    }

    /**
     * 获取所有默认规则（用于设置界面）
     * @returns {Object}
     */
    static getDefaultRules() {
        return foundry.utils.deepClone(DEFAULT_SPELL_RULES);
    }

    /**
     * 计算升级时需要新选/新增的法术数量
     * 
     * @param {string} classIdentifier - 职业标识符
     * @param {number} fromLevel - 旧等级（升级前）
     * @param {number} toLevel - 新等级（升级后）
     * @returns {Object|null} { newSpells, newCantrips, replacements, maxLevel, list, type } 或 null
     */
    static getLevelUpSpellChanges(classIdentifier, fromLevel, toLevel) {
        const rules = this.getRules(classIdentifier);
        if (!rules) return null;

        const result = {
            type: rules.type,
            list: rules.list || [classIdentifier],
            progression: rules.progression || "full",
            newSpells: 0,
            newCantrips: 0,
            replacements: 0,
            maxLevel: 0,
            oldMaxLevel: 0,
            isPrepared: rules.type === "prepared"
        };

        // 计算最大法术环阶（旧和新）
        result.oldMaxLevel = fromLevel > 0 ? this._getMaxSpellLevel(rules.progression, fromLevel) : 0;
        result.maxLevel = this._getMaxSpellLevel(rules.progression, toLevel);

        if (rules.type === "prepared") {
            // 准备型施法者：不需要在升级时逐个选法术
            // 但戏法仍需选择
            const oldCantrips = this._getValueForLevel(rules.cantripsKnown, fromLevel);
            const newCantrips = this._getValueForLevel(rules.cantripsKnown, toLevel);
            result.newCantrips = Math.max(0, newCantrips - oldCantrips);
        } else {
            // 已知法术型 / 契约型：计算新增法术数
            if (rules.spellsKnown) {
                const oldKnown = this._getValueForLevel(rules.spellsKnown, fromLevel);
                const newKnown = this._getValueForLevel(rules.spellsKnown, toLevel);
                result.newSpells = Math.max(0, newKnown - oldKnown);
            }

            // 新增戏法数
            if (rules.cantripsKnown) {
                const oldCantrips = this._getValueForLevel(rules.cantripsKnown, fromLevel);
                const newCantrips = this._getValueForLevel(rules.cantripsKnown, toLevel);
                result.newCantrips = Math.max(0, newCantrips - oldCantrips);
            }

            // 可替换数
            result.replacements = rules.replacementsPerLevel || 0;
        }

        return result;
    }

    /**
     * 读取特性物品上会转移到角色的戏法数量加值。
     * @param {Object} itemData - 特性物品数据
     * @param {string} classIdentifier - 当前职业标识符
     * @returns {number} 需要额外选择的戏法数量
     */
    static getFeatureCantripBonus(itemData, classIdentifier) {
        const normalizedClass = String(classIdentifier || '').trim().toLowerCase();
        if (!normalizedClass) return 0;

        const rawEffects = itemData?.effects;
        const effects = Array.isArray(rawEffects)
            ? rawEffects
            : (typeof rawEffects?.values === 'function'
                ? Array.from(rawEffects.values())
                : Object.values(rawEffects || {}));
        const expectedKey = `system.scale.${normalizedClass}.cantrips-known.value`;

        let bonus = 0;
        for (const effect of effects) {
            if (!effect || effect.disabled || effect.transfer !== true) continue;

            const rawChanges = effect.changes;
            const changes = Array.isArray(rawChanges)
                ? rawChanges
                : (typeof rawChanges?.values === 'function'
                    ? Array.from(rawChanges.values())
                    : Object.values(rawChanges || {}));

            for (const change of changes) {
                if (String(change?.key || '').toLowerCase() !== expectedKey) continue;
                if (Number(change?.mode) !== ACTIVE_EFFECT_ADD_MODE) continue;

                const value = Math.trunc(Number(change?.value));
                if (Number.isFinite(value) && value > 0) bonus += value;
            }
        }

        return bonus;
    }

    /**
     * 把特性给予的戏法数量加值转成现有法术选择步骤。
     * @param {Object} itemData - 特性物品数据
     * @param {Object} options - 步骤上下文
     * @returns {Object|null} 法术选择步骤
     */
    static generateFeatureCantripStep(itemData, options = {}) {
        const classIdentifier = String(options.classIdentifier || '').trim().toLowerCase();
        const count = this.getFeatureCantripBonus(itemData, classIdentifier);
        if (count <= 0) return null;

        const rules = this.getRules(classIdentifier);
        const list = rules?.list?.length ? rules.list : [classIdentifier];
        const level = Math.max(0, Number(options.level) || 0);
        const source = options.sourceUuid
            || itemData?._sourceUuid
            || itemData?.uuid
            || itemData?._id
            || itemData?.name
            || 'feature';
        const sourceKey = String(source)
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            || 'feature';
        const title = game.i18n.format('ORIGINATE.SpellRules.SelectCantrips', { count });

        return {
            id: `spell-rules-feature-cantrip-${classIdentifier}-${sourceKey}-${level}`,
            type: 'spell_choice',
            classIdentifier,
            title,
            event: {
                id: 'feat-grant',
                type: 'choice',
                title,
                count,
                restriction: {
                    type: 'spell',
                    level: 0,
                    list: list.map(identifier => `class:${identifier}`)
                },
                spellConfig: null,
                _isSpellRules: true,
                _isFeatureCantripEffect: true
            },
            stepType: options.stepType || 'class',
            advId: 'feat-grant',
            parentFeature: options.parentFeature || itemData?.name || null,
            parentSourceUuid: options.parentSourceUuid || options.sourceUuid || itemData?._sourceUuid || itemData?.uuid || null
        };
    }

    /**
     * 检查原生法术选择类型；是否由职业规则接管必须另用 managesChoice 判断。
     * @param {Object} event - _convertAdvancementsToUI 产生的事件
     * @returns {boolean}
     */
    static isNativeSpellAdvancement(event) {
        return event?.type === 'choice' && isSpellChoiceEvent(event);
    }

    static getProgressionIdentifier(classIdentifier, subclassIdentifier) {
        return [classIdentifier, subclassIdentifier].find(identifier => this.getRules(identifier)) || null;
    }

    static managesChoice(event, { classIdentifier, subclassIdentifier } = {}) {
        const identifier = this.getProgressionIdentifier(classIdentifier, subclassIdentifier);
        if (!identifier) return false;
        return isBaseSpellProgressionChoice(event, {
            identifier,
            rules: this.getRules(identifier),
            // 自定义数量仍覆盖基础职业规则；识别原生来源时使用该职业原有的增长表。
            baseRules: DEFAULT_SPELL_RULES[identifier.toLowerCase()] || this.getRules(identifier)
        });
    }

    /**
     * 根据法术规则为升级生成 spell_choice 步骤
     * 
     * 这是核心方法：替代原本从 Advancement 检测法术选择的逻辑。
     * 生成的步骤结构与现有 spell_choice 完全一致，可直接被
     * _renderSpellChoice / _bindSpellBrowserEvents 复用。
     * 
     * @param {string} classIdentifier - 职业标识符
     * @param {number} fromLevel - 旧等级
     * @param {number} toLevel - 新等级
     * @param {Object} options - 可选配置
     * @param {string} options.stepType - 步骤类型，默认 'class'
     * @param {Array} options.nativeChoices - 本级原生事件，用于传递被接管选择的来源和限制
     * @returns {Array} 步骤数组
     */
    static generateSpellSteps(classIdentifier, fromLevel, toLevel, options = {}) {
        const changes = this.getLevelUpSpellChanges(classIdentifier, fromLevel, toLevel);
        if (!changes) return [];

        const steps = [];
        const stepType = options.stepType || 'class';

        // 1. 准备型施法者：当获得新的法术环阶时，授予该环阶的法表法术
        //    注意：minLevel=1 排除戏法（戏法通过 spell_choice 单独选择）
        if (changes.isPrepared && changes.maxLevel > changes.oldMaxLevel) {
            steps.push({
                id: `spell-rules-prepared-grant-${classIdentifier}-${toLevel}`,
                type: 'prepared_spell_grant',
                title: game.i18n.format('ORIGINATE.SpellRules.PreparedGrant', {
                    class: this._getLocalizedClassName(classIdentifier)
                }),
                classIdentifier: classIdentifier,
                list: changes.list,
                minLevel: changes.oldMaxLevel + 1,
                maxLevel: changes.maxLevel,
                stepType
            });
        }

        // 2. 新增戏法选择
        if (changes.newCantrips > 0) {
            steps.push({
                id: `spell-rules-cantrip-${classIdentifier}-${toLevel}`,
                type: 'spell_choice',
                classIdentifier,
                title: game.i18n.format('ORIGINATE.SpellRules.SelectCantrips', {
                    count: changes.newCantrips
                }),
                event: {
                    type: 'choice',
                    title: game.i18n.format('ORIGINATE.SpellRules.SelectCantrips', {
                        count: changes.newCantrips
                    }),
                    count: changes.newCantrips,
                    restriction: {
                        level: 0,
                        list: changes.list.map(l => `class:${l}`)
                    },
                    spellConfig: null,
                    _isSpellRules: true
                },
                stepType
            });
        }

        // 3. 新增法术选择（已知型 / 契约型）
        if (changes.newSpells > 0) {
            steps.push({
                id: `spell-rules-spell-${classIdentifier}-${toLevel}`,
                type: 'spell_choice',
                classIdentifier,
                title: game.i18n.format('ORIGINATE.SpellRules.SelectSpells', {
                    count: changes.newSpells
                }),
                event: {
                    type: 'choice',
                    title: game.i18n.format('ORIGINATE.SpellRules.SelectSpells', {
                        count: changes.newSpells
                    }),
                    count: changes.newSpells,
                    restriction: {
                        level: 'available',
                        list: changes.list.map(l => `class:${l}`)
                    },
                    spellConfig: null,
                    _isSpellRules: true,
                    _maxLevel: changes.maxLevel
                },
                stepType
            });
        }

        // 4. 法术替换步骤
        if (changes.replacements > 0) {
            steps.push({
                id: `spell-rules-replace-${classIdentifier}-${toLevel}`,
                type: 'spell_replacement',
                title: game.i18n.format('ORIGINATE.SpellRules.ReplaceSpells', {
                    count: changes.replacements
                }),
                classIdentifier: classIdentifier,
                count: changes.replacements,
                list: changes.list,
                maxLevel: changes.maxLevel,
                stepType
            });
        }

        return this._preserveNativeChoiceConstraints(steps, options.nativeChoices || [], classIdentifier);
    }

    static _preserveNativeChoiceConstraints(steps, nativeChoices, identifier) {
        const ownedChoices = nativeChoices.filter(event => this.managesChoice(event, { classIdentifier: identifier }));
        for (const step of steps) {
            if (!['spell_choice', 'spell_replacement'].includes(step.type)) continue;
            const isCantrip = step.type === 'spell_choice' && String(step.event?.restriction?.level) === '0';
            const matches = ownedChoices.filter(event => {
                if ((String(event.restriction?.level) === '0') !== isCantrip) return false;
                return step.type === 'spell_replacement' ? event.replacement : event.count > 0;
            });
            if (matches.length !== 1) continue;
            const native = matches[0];
            const restriction = foundry.utils.deepClone(native.restriction);
            restriction.list = step.event?.restriction?.list || (step.list || []).map(id => `class:${id}`);
            // 保留原生来源和硬限制，但数量仍由用户配置的职业规则决定，避免再多出一组基础法术。
            step.event = {
                ...native,
                ...step.event,
                restriction,
                spellConfig: native.spellConfig ?? null
            };
        }
        return steps;
    }

    // 内部辅助方法

    /**
     * 从等级映射表中获取指定等级的值（支持稀疏映射，取最近的≤level的值）
     * @param {Object} levelMap - { level: value } 映射
     * @param {number} level - 目标等级
     * @returns {number}
     */
    static _getValueForLevel(levelMap, level) {
        if (!levelMap || typeof levelMap !== 'object') return 0;
        if (level <= 0) return 0;

        // 直接匹配
        if (levelMap[level] !== undefined) return levelMap[level];

        // 找最近的 ≤ level 的键
        let bestLevel = 0;
        let bestValue = 0;
        for (const [k, v] of Object.entries(levelMap)) {
            const l = parseInt(k);
            if (l <= level && l > bestLevel) {
                bestLevel = l;
                bestValue = v;
            }
        }
        return bestValue;
    }

    /**
     * 根据施法进度类型和职业等级计算最大法术环阶
     * @param {string} progression - 施法进度类型
     * @param {number} classLevel - 职业等级
     * @returns {number} 最大环阶 (0-9)
     */
    static _getMaxSpellLevel(progression, classLevel) {
        if (!progression || !classLevel || classLevel < 1) return 0;
        const level = Math.min(classLevel, 20);

        switch (progression) {
            case 'full':
                if (level >= 17) return 9;
                if (level >= 15) return 8;
                if (level >= 13) return 7;
                if (level >= 11) return 6;
                if (level >= 9) return 5;
                if (level >= 7) return 4;
                if (level >= 5) return 3;
                if (level >= 3) return 2;
                return 1;
            case 'half':
                if (level >= 17) return 5;
                if (level >= 13) return 4;
                if (level >= 9) return 3;
                if (level >= 5) return 2;
                return 1; // PHB 2024: 半施法者1级即可施法
            case 'third':
                if (level >= 19) return 4;
                if (level >= 13) return 3;
                if (level >= 7) return 2;
                if (level >= 3) return 1;
                return 0;
            case 'pact':
                if (level >= 9) return 5;
                if (level >= 7) return 4;
                if (level >= 5) return 3;
                if (level >= 3) return 2;
                return 1;
            default:
                return this._getMaxSpellLevel('full', level);
        }
    }

    /**
     * 获取职业的本地化名称
     * @param {string} classIdentifier - 职业标识符（如 "artificer"）
     * @returns {string} 本地化的职业名称
     */
    static _getLocalizedClassName(classIdentifier) {
        if (!classIdentifier) return '';
        const id = classIdentifier.toLowerCase();

        // 1. 尝试从 CONFIG.DND5E 获取
        const classConfig = CONFIG.DND5E?.classes?.[id];
        if (classConfig?.label) {
            const localized = game.i18n.localize(classConfig.label);
            if (localized !== classConfig.label) return localized;
            return classConfig.label;
        }

        // 2. 子职施法者标识符映射
        const subclassMap = {
            'eldritch-knight': 'ORIGINATE.Subclass.EldritchKnight',
            'trickster': 'ORIGINATE.Subclass.ArcaneTrickster'
        };
        if (subclassMap[id]) {
            const localized = game.i18n.localize(subclassMap[id]);
            if (localized !== subclassMap[id]) return localized;
        }

        // 3. 回退：首字母大写
        return classIdentifier.charAt(0).toUpperCase() + classIdentifier.slice(1);
    }
}
