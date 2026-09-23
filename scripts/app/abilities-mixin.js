import { normalizeStandardArrayScores } from '../shared/ability-score-methods.js';

/**
 * AbilitiesMixin - 属性生成功能
 *
 * 这里同时承接自由分配、买点、掷骰和标准数组。掷骰与标准数组只共用数值池分配，
 * 前者的历史记录和确认阶段仍然单独维护，别把两条流程合成一种状态。
 */

// 买点法消耗表
// 从属性值 8 开始，每增加 1 点需要的点数
const POINT_BUY_COSTS = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
    16: 12, 17: 15, 18: 19 // 扩展支持
};

export const AbilitiesMixin = (Base) => class extends Base {

    /**
     * 获取初始属性值（可配置，默认 8）
     * Adrian: 告别硬编码的 8，现在 DM 可以随意设定起始属性了
     */
    _getBaseAbilityScore() {
        try { return game.settings.get('character-forge', 'baseAbilityScore') ?? 8; }
        catch { return 8; }
    }

    _getAbilityAbbreviation(ability) {
        const key = String(ability || '').trim().toLowerCase();
        const suffix = key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
        const localized = suffix ? game.i18n.localize(`ORIGINATE.Ability.Abbr.${suffix}`) : '';
        return localized && !localized.startsWith('ORIGINATE.') ? localized : key.toUpperCase();
    }

    _getPersistedGrantedRollState() {
        if (!this.creationGrantId || !this.actor) return null;
        const stored = this.actor.getFlag?.('character-forge', 'abilityRollLock');
        if (!stored || stored.grantId !== this.creationGrantId) return null;
        return foundry.utils.deepClone(stored);
    }

    async _persistGrantedRollState() {
        if (!this.creationGrantId || !this.actor || !this._rollState) return;

        const payload = {
            grantId: this.creationGrantId,
            history: foundry.utils.deepClone(this._rollState.history || []),
            selectedIndex: this._rollState.selectedIndex ?? -1,
            attemptsUsed: this._rollState.attemptsUsed ?? 0,
            pendingResults: foundry.utils.deepClone(this._rollState.pendingResults || []),
            isRolling: false,
            isAssigning: !!this._rollState.isAssigning,
            assignedValues: foundry.utils.deepClone(this._rollState.assignedValues || null),
            selectedAssignmentValueIndex: this._rollState.selectedAssignmentValueIndex ?? -1,
            assignmentSource: this._rollState.assignmentSource || null,
            assignmentSignature: this._rollState.assignmentSignature || null,
            assignmentComplete: !!this._rollState.assignmentComplete,
            contextAbilities: foundry.utils.deepClone(this.context?.abilities || null)
        };

        try {
            await this.actor.setFlag('character-forge', 'abilityRollLock', payload);
        } catch (error) {
            console.warn('Character Forge | Не удалось сохранить закреплённый бросок характеристик:', error);
        }
    }

    _ensureAbilityGenerationState(abilityMode) {
        if (this._rollState?.abilityMode === abilityMode) return this._rollState;

        if (abilityMode === 'roll') {
            const persisted = this._getPersistedGrantedRollState();
            if (persisted) {
                this._rollState = {
                    abilityMode,
                    history: Array.isArray(persisted.history) ? persisted.history : [],
                    selectedIndex: Number.isInteger(persisted.selectedIndex) ? persisted.selectedIndex : -1,
                    attemptsUsed: Number(persisted.attemptsUsed) || 0,
                    pendingResults: Array.isArray(persisted.pendingResults) ? persisted.pendingResults : [],
                    isRolling: false,
                    isAssigning: !!persisted.isAssigning,
                    assignedValues: persisted.assignedValues || null,
                    selectedAssignmentValueIndex: Number.isInteger(persisted.selectedAssignmentValueIndex)
                        ? persisted.selectedAssignmentValueIndex
                        : -1,
                    assignmentSource: persisted.assignmentSource || null,
                    assignmentSignature: persisted.assignmentSignature || null,
                    assignmentComplete: !!persisted.assignmentComplete
                };

                if (persisted.contextAbilities && this.context) {
                    this.context.abilities = foundry.utils.deepClone(persisted.contextAbilities);
                }
                return this._rollState;
            }
        }

        // 旧字段名继续保留给创角时间线快照使用，里面现在也会装标准数组的分配状态。
        this._rollState = {
            abilityMode,
            history: [],
            selectedIndex: -1,
            attemptsUsed: 0,
            pendingResults: [],
            isRolling: false,
            isAssigning: false,
            assignedValues: null,
            selectedAssignmentValueIndex: -1,
            assignmentSource: null,
            assignmentSignature: null,
            assignmentComplete: false
        };
        return this._rollState;
    }

    /**
     * 准备上下文数据
     */
    async _prepareContext(options) {
        const context = await super._prepareContext(options);

        if (this.currentStep !== 'abilities' && this.currentStep !== 'asiBonus') return context;

        context.classPrimaryAbility = this._getCurrentClassPrimaryAbilityKey?.() || null;

        // asiBonus 步骤：显示基础属性和种族/背景的 ASI 加成
        if (this.currentStep === 'asiBonus') {
            context.asiBonusData = {};
            const bs = this._getBaseAbilityScore();
            const abilities = this.context.abilities || { str: bs, dex: bs, con: bs, int: bs, wis: bs, cha: bs };
            const deferredASIs = this.context.deferredASIs || [];

            // 属性图标和缩写映射（与 level-up ASI 卡片保持一致）
            const abilityIcons = {
                str: 'fa-fist-raised', dex: 'fa-running', con: 'fa-heart',
                int: 'fa-brain', wis: 'fa-eye', cha: 'fa-comments'
            };
            const abilityAbbrs = {
                str: this._getAbilityAbbreviation('str'),
                dex: this._getAbilityAbbreviation('dex'),
                con: this._getAbilityAbbreviation('con'),
                int: this._getAbilityAbbreviation('int'),
                wis: this._getAbilityAbbreviation('wis'),
                cha: this._getAbilityAbbreviation('cha')
            };

            // 分离固定加成和点数分配
            const fixedASIs = deferredASIs.filter(a => a.type === 'fixed');
            const pointsASIs = deferredASIs.filter(a => a.type === 'points');
            const hasPointsToAllocate = pointsASIs.length > 0;

            // 计算固定加成
            const fixedBonuses = {};
            const fixedDetails = {};
            fixedASIs.forEach(asi => {
                if (!fixedBonuses[asi.ability]) fixedBonuses[asi.ability] = 0;
                fixedBonuses[asi.ability] += asi.value;
                if (!fixedDetails[asi.ability]) fixedDetails[asi.ability] = [];
                fixedDetails[asi.ability].push({
                    source: asi.source,
                    sourceType: asi.sourceType,
                    value: asi.value
                });
            });

            // 初始化点数分配状态
            if (!this._asiAllocations) {
                this._asiAllocations = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
            }

            // 计算点数分配信息
            let totalPoints = 0;
            let maxPerAbility = 2; // 默认每项最多 +2
            // 收集所有 locked 属性限制
            // locked 的含义（与 dnd5e 一致）: locked 中列出的属性不可分配点数（被锁定）
            const allLockedAbilities = new Set();
            pointsASIs.forEach(asi => {
                totalPoints += asi.points;
                if (asi.cap) maxPerAbility = asi.cap;
                // 标准化 locked: 可能是 Set、Array 或 Object
                let lockedArr = [];
                if (asi.locked instanceof Set) {
                    lockedArr = Array.from(asi.locked);
                } else if (Array.isArray(asi.locked)) {
                    lockedArr = asi.locked;
                } else if (asi.locked && typeof asi.locked === 'object') {
                    lockedArr = Object.keys(asi.locked);
                }
                lockedArr.forEach(ab => allLockedAbilities.add(ab));
            });

            const usedPoints = Object.values(this._asiAllocations).reduce((sum, v) => sum + v, 0);
            const remainingPoints = totalPoints - usedPoints;

            window.OriginateLog(`Originate | ASI Bonus _prepareContext 调试:`, {
                deferredASIs,
                fixedASIs: fixedASIs.length,
                pointsASIs: pointsASIs.length,
                totalPoints,
                maxPerAbility,
                lockedAbilities: Array.from(allLockedAbilities),
                usedPoints,
                remainingPoints,
                allocations: { ...this._asiAllocations }
            });

            // 构建每个属性的数据
            for (const [key, baseValue] of Object.entries(abilities)) {
                const fixedBonus = fixedBonuses[key] || 0;
                const allocatedBonus = this._asiAllocations[key] || 0;
                const totalBonus = fixedBonus + allocatedBonus;
                const finalValue = baseValue + totalBonus;
                const baseMod = this._getAbilityModifier(baseValue);
                const finalMod = this._getAbilityModifier(finalValue);

                // 判断该属性是否被锁定（不允许分配点数）
                // isLocked = true 时，该属性上的 +/- 按钮被禁用
                // locked 列表表示"被锁定"的属性，这些属性不能分配点数
                const isLocked = hasPointsToAllocate && allLockedAbilities.has(key);

                // 组合来源明细
                const details = [...(fixedDetails[key] || [])];
                if (allocatedBonus > 0) {
                    const pointSource = pointsASIs.map(a => a.source).join(', ');
                    details.push({
                        source: pointSource,
                        sourceType: 'allocated',
                        value: allocatedBonus
                    });
                }

                context.asiBonusData[key] = {
                    base: baseValue,
                    bonus: totalBonus,
                    fixedBonus: fixedBonus,
                    allocatedBonus: allocatedBonus,
                    final: finalValue,
                    baseMod: baseMod,
                    baseModFormatted: this._formatModifier(baseMod),
                    finalMod: finalMod,
                    finalModFormatted: this._formatModifier(finalMod),
                    finalModClass: finalMod > 0 ? 'positive' : (finalMod < 0 ? 'negative' : 'neutral'),
                    details: details,
                    isLocked: isLocked,
                    isPrimary: key === context.classPrimaryAbility,
                    abilityIcon: abilityIcons[key],
                    abilityAbbr: abilityAbbrs[key],
                    canIncrease: hasPointsToAllocate && !isLocked && remainingPoints > 0 && allocatedBonus < maxPerAbility,
                    canDecrease: hasPointsToAllocate && !isLocked && allocatedBonus > 0
                };
            }

            context.deferredASIs = deferredASIs;
            context.hasDeferredASIs = deferredASIs.length > 0;
            context.hasPointsToAllocate = hasPointsToAllocate;
            context.asiPointsTotal = totalPoints;
            context.asiPointsUsed = usedPoints;
            context.asiPointsRemaining = remainingPoints;
            context.asiMaxPerAbility = maxPerAbility;
            context.allPointsAllocated = hasPointsToAllocate ? remainingPoints === 0 : true;
            return context;
        }

        // abilities 步骤的正常逻辑
        const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';
        context.abilityMode = abilityMode;

        this._ensureAbilityGenerationState(abilityMode);

        // 准备属性显示数据
        context.abilityData = {};
        const bs = this._getBaseAbilityScore();
        const abilities = this.context.abilities ||= { str: bs, dex: bs, con: bs, int: bs, wis: bs, cha: bs };

        if (abilityMode === 'standardArray') {
            const scores = normalizeStandardArrayScores(game.settings.get('character-forge', 'standardArrayScores'));
            const signature = scores.join('|');
            const needsFreshPool = this._rollState.assignmentSource !== 'standardArray'
                || this._rollState.assignmentSignature !== signature
                || !this._rollState.assignedValues;
            if (needsFreshPool) this._beginAbilityAssignment(scores, 'standardArray', { render: false });
        }

        // 如果是掷骰模式且有选中结果，且未进入分配阶段，预览显示选中结果
        let previewValues = null;
        if (abilityMode === 'roll' && this._rollState.selectedIndex >= 0 && !this._rollState.isAssigning) {
            const entry = this._rollState.history[this._rollState.selectedIndex];
            if (entry) {
                const keys = Object.keys(abilities);
                previewValues = {};
                keys.forEach((key, index) => {
                    previewValues[key] = entry.values[index];
                });
            }
        }

        for (const [key, value] of Object.entries(abilities)) {
            // 使用预览值或真实值
            const displayValue = previewValues ? previewValues[key] : value;
            const mod = this._getAbilityModifier(displayValue);

            let isAssigned = false;
            if (this._rollState.isAssigning && this._rollState.assignedValues) {
                isAssigned = this._rollState.assignedValues.assigned[key] !== null;
            }

            context.abilityData[key] = {
                value: displayValue,
                mod: mod,
                modFormatted: this._formatModifier(mod),
                modClass: mod > 0 ? 'positive' : (mod < 0 ? 'negative' : 'neutral'),
                isPreview: !!previewValues, // 标记这是预览值
                isAssigned: isAssigned,
                isPrimary: key === context.classPrimaryAbility
            };
        }

        const rollMode = abilityMode === 'roll'
            ? (game.settings.get('character-forge', 'rollMode') || 'free')
            : null;
        context.isStandardArrayMode = abilityMode === 'standardArray';
        context.isAbilityAssignmentPhase = context.isStandardArrayMode
            || (abilityMode === 'roll' && rollMode === 'free' && this._rollState.isAssigning);
        context.isRollSelectionPhase = abilityMode === 'roll' && !context.isAbilityAssignmentPhase;
        context.abilityAssignment = this._rollState.assignedValues;
        context.canConfirmAbilities = !context.isStandardArrayMode || this._rollState.assignmentComplete;

        const assignedMap = this._rollState.assignedValues?.assigned || {};
        context.assignmentModifiers = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key => {
            const assignedValue = assignedMap[key];
            if (assignedValue === null || assignedValue === undefined) {
                return {
                    key,
                    label: this._getAbilityAbbreviation(key),
                    modFormatted: '—',
                    modClass: 'neutral'
                };
            }
            const mod = this._getAbilityModifier(Number(assignedValue));
            return {
                key,
                label: this._getAbilityAbbreviation(key),
                modFormatted: this._formatModifier(mod),
                modClass: mod > 0 ? 'positive' : (mod < 0 ? 'negative' : 'neutral')
            };
        });

        // 模式特定数据
        if (abilityMode === 'pointbuy') {
            const totalPoints = game.settings.get('character-forge', 'pointBuyTotal') || 27;
            const maxScore = game.settings.get('character-forge', 'pointBuyMaxScore') || 15;
            const usedPoints = this._calculateUsedPoints();
            const remainingPoints = totalPoints - usedPoints;

            context.pointBuy = {
                totalPoints,
                maxScore,
                usedPoints,
                remainingPoints,
                costs: POINT_BUY_COSTS
            };
            context.canConfirmAbilities = remainingPoints === 0;
        } else if (abilityMode === 'roll') {
            const rollFormula = game.settings.get('character-forge', 'rollFormula') || '4d6kh3';
            const rollAttempts = game.settings.get('character-forge', 'rollAttempts') || 1;

            const pendingResults = Array.isArray(this._rollState.pendingResults)
                ? this._rollState.pendingResults
                : [];
            const selectedEntry = this._rollState.selectedIndex >= 0
                ? this._rollState.history[this._rollState.selectedIndex]
                : null;
            const visibleValues = pendingResults.length > 0
                ? pendingResults.map(result => result.value)
                : (selectedEntry?.values || []);

            context.roll = {
                formula: rollFormula,
                mode: rollMode,
                totalAttempts: rollAttempts,
                attemptsRemaining: (this.creationGrantId && this._rollState.history.length > 0)
                    ? 0
                    : Math.max(0, rollAttempts - this._rollState.attemptsUsed),
                history: this._rollState.history,
                selectedIndex: this._rollState.selectedIndex,
                isRolling: this._rollState.isRolling,
                hasSelection: this._rollState.selectedIndex >= 0,
                rollsRemainingInSet: Math.max(0, 6 - pendingResults.length),
                slots: Array.from({ length: 6 }, (_, index) => ({
                    index,
                    filled: visibleValues[index] !== undefined && visibleValues[index] !== null,
                    value: visibleValues[index] ?? null,
                    isRolling: this._rollState.isRolling && index === Math.min(pendingResults.length, 5)
                })),

                isAssignmentPhase: context.isAbilityAssignmentPhase,

                // 是否为固定模式 (Fixed mode)
                isFixedMode: rollMode === 'fixed',

                assignedValues: this._rollState.assignedValues,
                selectedAssignmentValueIndex: this._rollState.selectedAssignmentValueIndex
            };
        }

        return context;
    }

    /* ... Helpers ... */
    _calculateUsedPoints() {
        const abilities = this.context.abilities || {};
        let total = 0;
        for (const value of Object.values(abilities)) {
            total += POINT_BUY_COSTS[value] || 0;
        }
        return total;
    }

    _getAbilityModifier(score) {
        return Math.floor((score - 10) / 2);
    }

    _formatModifier(mod) {
        if (mod >= 0) return `+${mod}`;
        return `${mod}`;
    }

    /* ... Event Handlers ... */

    _onSetAbilityScore(event, target) {
        const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';
        if (abilityMode !== 'free') return;
        let value = parseInt(target.value);
        if (isNaN(value)) value = 1;
        if (value < 1) value = 1; if (value > 30) value = 30;
        this.context.abilities[target.dataset.ability] = value;
        this._updateAbilityDisplay(target.dataset.ability, value);
    }

    _onIncrementAbility(event, target) {
        const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';
        const ability = target.dataset.ability;
        let currentValue = this.context.abilities[ability] || this._getBaseAbilityScore();

        if (abilityMode === 'pointbuy') {
            const maxScore = game.settings.get('character-forge', 'pointBuyMaxScore') || 15;
            const totalPoints = game.settings.get('character-forge', 'pointBuyTotal') || 27;
            const remainingPoints = totalPoints - this._calculateUsedPoints();

            if (currentValue >= maxScore) {
                ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Abilities.PointBuy.MaxReached'));
                return;
            }
            const costDiff = (POINT_BUY_COSTS[currentValue + 1] || 0) - (POINT_BUY_COSTS[currentValue] || 0);
            if (costDiff > remainingPoints) {
                ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Abilities.PointBuy.NoPoints'));
                return;
            }
            this.context.abilities[ability] = currentValue + 1;
            this._updateAbilityDisplay(ability, currentValue + 1);
            this._updatePointBuyDisplay();
        } else if (abilityMode === 'free') {
            if (currentValue >= 30) return;
            this.context.abilities[ability] = currentValue + 1;
            this._updateAbilityDisplay(ability, currentValue + 1);
        }
    }

    _onDecrementAbility(event, target) {
        const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';
        const ability = target.dataset.ability;
        let currentValue = this.context.abilities[ability] || this._getBaseAbilityScore();

        if (abilityMode === 'pointbuy') {
            if (currentValue <= this._getBaseAbilityScore()) return;
            this.context.abilities[ability] = currentValue - 1;
            this._updateAbilityDisplay(ability, currentValue - 1);
            this._updatePointBuyDisplay();
        } else if (abilityMode === 'free') {
            if (currentValue <= 1) return;
            this.context.abilities[ability] = currentValue - 1;
            this._updateAbilityDisplay(ability, currentValue - 1);
        }
    }

    _updateAbilityDisplay(ability, value) {
        const container = this.element.querySelector(`.ability-card[data-ability="${ability}"]`);
        if (!container) return;
        const input = container.querySelector('.ability-value-input');
        if (input) input.value = value;
        const valueDisplay = container.querySelector('.ability-value-display');
        if (valueDisplay) valueDisplay.textContent = value;
        const mod = this._getAbilityModifier(value);
        const modDisplay = container.querySelector('.ability-modifier');
        if (modDisplay) {
            modDisplay.textContent = this._formatModifier(mod);
            modDisplay.classList.remove('positive', 'negative', 'neutral');
            if (mod > 0) modDisplay.classList.add('positive');
            else if (mod < 0) modDisplay.classList.add('negative');
            else modDisplay.classList.add('neutral');
        }
    }

    _updatePointBuyDisplay() {
        const totalPoints = game.settings.get('character-forge', 'pointBuyTotal') || 27;
        const remaining = totalPoints - this._calculateUsedPoints();

        const remainingDisplay = this.element.querySelector('.point-buy-remaining');
        if (remainingDisplay) remainingDisplay.textContent = remaining;

        const nextButton = this.element.querySelector('.abilities-footer .abilities-confirm-btn');
        if (nextButton) nextButton.disabled = remaining !== 0;
    }

    /**
     * 执行掷骰 - 带动画
     */
    async _onRollAbilities() {
        // Один клик = одно значение. Полный набор характеристик собирается за шесть бросков.
        if (!this._rollState || this._rollState.isRolling) return false;

        const rollAttempts = game.settings.get('character-forge', 'rollAttempts') || 1;
        const pendingResults = Array.isArray(this._rollState.pendingResults)
            ? this._rollState.pendingResults
            : (this._rollState.pendingResults = []);

        // Игрок, получивший одноразовый допуск от ГМа, получает только один полный набор.
        if (this.creationGrantId && this._rollState.history.length > 0) {
            ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Abilities.Roll.Locked'));
            return false;
        }

        if (this._rollState.attemptsUsed >= rollAttempts && pendingResults.length === 0) {
            ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Abilities.Roll.NoRolls'));
            return false;
        }

        if (pendingResults.length >= 6) return false;

        this._rollState.isRolling = true;
        this.render();

        try {
            const formula = game.settings.get('character-forge', 'rollFormula') || '4d6kh3';
            const roll = new Roll(formula);
            await roll.evaluate();

            // Dice So Nice является обязательной зависимостью модуля.
            // Guard оставлен, чтобы ошибка стороннего API не потеряла сам результат броска.
            if (game.dice3d?.showForRoll) {
                try {
                    await game.dice3d.showForRoll(roll, game.user, true);
                } catch (diceError) {
                    console.warn('Character Forge | Dice So Nice не смог показать бросок:', diceError);
                }
            }

            pendingResults.push({
                value: Number(roll.total),
                formula,
                details: roll.result
            });

            this._rollState.isRolling = false;
            await this._persistGrantedRollState();

            if (pendingResults.length >= 6) {
                const completedSet = pendingResults.slice(0, 6);
                await this._finishRolling(completedSet);
            } else {
                this._renderPreservingScroll();
            }

            return true;
        } catch (error) {
            this._rollState.isRolling = false;
            console.error('Character Forge | Ошибка броска характеристик:', error);
            this._renderPreservingScroll();
            ui.notifications.error(game.i18n.localize('ORIGINATE.UI.Abilities.Roll.RollError'));
            return false;
        }
    }

    async _finishRolling(results) {
        this._rollState.isRolling = false;
        this._rollState.pendingResults = [];

        const historyEntry = {
            id: Date.now(),
            values: results.map(r => r.value),
            total: results.reduce((sum, r) => sum + r.value, 0),
            details: results.map(r => r.details)
        };
        this._rollState.history.push(historyEntry);
        const configuredAttempts = game.settings.get('character-forge', 'rollAttempts') || 1;
        this._rollState.attemptsUsed = this.creationGrantId
            ? configuredAttempts
            : this._rollState.attemptsUsed + 1;

        const rollMode = game.settings.get('character-forge', 'rollMode') || 'free';

        // 固定模式：自动选择并应用
        if (rollMode === 'fixed') {
            this._selectRollResult(this._rollState.history.length - 1, true);
        } else {
            // 自由模式：只选中，但不自动进入分配界面
            // 必须点击 "确定使用" 才能进入
            this._rollState.selectedIndex = this._rollState.history.length - 1;
            this._renderPreservingScroll();
        }

        await this._persistGrantedRollState();
    }

    /**
     * 选择历史记录
     */
    _selectRollResult(index, applyImmediately = false) {
        if (index < 0 || index >= this._rollState.history.length) return;

        this._rollState.selectedIndex = index;
        const entry = this._rollState.history[index];
        const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

        if (applyImmediately) {
            abilities.forEach((ability, i) => {
                this.context.abilities[ability] = entry.values[i];
            });
            this._rollState.assignmentComplete = true;
            this._rollState.isAssigning = false;
        } else {
            // 仅仅是选中，不初始化分配数据，直到点击 "Start Allocation" 按钮
        }
        this._renderPreservingScroll();
        void this._persistGrantedRollState();
    }

    _beginAbilityAssignment(values, source, { render = true } = {}) {
        const scores = [...values].map(Number);
        this._rollState.isAssigning = true;
        this._rollState.assignmentComplete = false;
        this._rollState.selectedAssignmentValueIndex = -1;
        this._rollState.assignmentSource = source;
        this._rollState.assignmentSignature = scores.join('|');
        this._rollState.assignedValues = {
            available: scores.sort((a, b) => b - a),
            assigned: { str: null, dex: null, con: null, int: null, wis: null, cha: null }
        };
        if (render) this._renderPreservingScroll();
        if (source === 'roll') void this._persistGrantedRollState();
    }

    /**
     * 掷骰结果确认后才进入分配，避免选择历史记录时误清空当前结果。
     */
    _startAssignment() {
        if (this._rollState.selectedIndex < 0) return;
        const entry = this._rollState.history[this._rollState.selectedIndex];
        this._beginAbilityAssignment(entry.values, 'roll');
    }

    /**
     * 选择要分配的数值
     */
    _selectAssignmentValue(index) {
        if (this._rollState.selectedAssignmentValueIndex === index) {
            // 取消选择
            this._rollState.selectedAssignmentValueIndex = -1;
        } else {
            this._rollState.selectedAssignmentValueIndex = index;
        }

        // 更新 UI 样式而非整个重绘 (Optimization)
        this.element.querySelectorAll('.available-value').forEach((el, i) => {
            el.classList.toggle('selected', i === this._rollState.selectedAssignmentValueIndex);
        });
    }

    /**
     * 将选中的数值分配给属性
     */
    _assignValueToAbility(ability) {
        if (!this._rollState.assignedValues) return;
        if (this._rollState.selectedAssignmentValueIndex === -1) {
            // 如果点击了已分配的属性，则撤销分配（如果有值）
            const currentValue = this._rollState.assignedValues.assigned[ability];
            if (currentValue !== null) {
                // 归还数值
                this._rollState.assignedValues.available.push(currentValue);
                this._rollState.assignedValues.available.sort((a, b) => b - a);
                this._rollState.assignedValues.assigned[ability] = null;
                this.context.abilities[ability] = this._getBaseAbilityScore(); // 重置为默认
                this._rollState.assignmentComplete = false;
                this._renderPreservingScroll();
                void this._persistGrantedRollState();
            }
            return;
        }

        const valueIndex = this._rollState.selectedAssignmentValueIndex;
        const available = this._rollState.assignedValues.available;
        const assigned = this._rollState.assignedValues.assigned;

        // 获取值
        const value = available[valueIndex];

        // 如果该属性已有值，先归还旧值
        if (assigned[ability] !== null) {
            available.push(assigned[ability]);
        }

        // 移除选中的值
        available.splice(valueIndex, 1);
        available.sort((a, b) => b - a);

        // 赋予新值
        assigned[ability] = value;
        this.context.abilities[ability] = value;

        // 重置选中状态
        this._rollState.selectedAssignmentValueIndex = -1;

        // 检查完成状态
        const allAssigned = Object.values(assigned).every(v => v !== null);
        this._rollState.assignmentComplete = allAssigned;

        this._renderPreservingScroll();
        void this._persistGrantedRollState();
    }

    /**
     * Confirm roll selection and start assignment phase (Free mode)
     * or apply values directly (Fixed mode)
     */
    async _onConfirmRollResult(event, target) {
        if (this._rollState.selectedIndex < 0) {
            ui.notifications.warn(game.i18n.localize("ORIGINATE.UI.Selection.PleaseSelect"));
            return;
        }

        const rollMode = game.settings.get('character-forge', 'rollMode') || 'free';

        if (rollMode === 'fixed') {
            // Fixed mode: Directly assign values in order (STR, DEX, CON, INT, WIS, CHA)
            const entry = this._rollState.history[this._rollState.selectedIndex];
            const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
            keys.forEach((key, index) => {
                this.context.abilities[key] = entry.values[index];
            });
            this._rollState.assignmentComplete = true;
            await this._persistGrantedRollState();
            // Go to next step
            await this._onNextStep(event, target);
        } else {
            // Free mode: Enter assignment phase
            await this._startAssignment();
        }
    }

    /**
     * Cancel assignment and return to selection phase
     */
    async _onCancelAssignment(event, target) {
        this._rollState.isAssigning = false;
        this._rollState.assignedValues = null;
        this._rollState.assignmentComplete = false;
        this._renderPreservingScroll();
        await this._persistGrantedRollState();
    }

    /**
     * 绑定事件
     */
    _bindAbilitiesEvents() {
        if (this.currentStep !== 'abilities') return;
        const container = this.element.querySelector('.abilities-selection-layout');
        if (!container) return;

        const abilityMode = game.settings.get('character-forge', 'abilityMode') || 'free';

        if (abilityMode === 'free') {
            container.querySelectorAll('.ability-value-input').forEach(input => {
                input.addEventListener('change', (e) => this._onSetAbilityScore(e, e.target));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowUp') { e.preventDefault(); this._onIncrementAbility(e, e.target); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); this._onDecrementAbility(e, e.target); }
                });
            });
        }

        // if (abilityMode === 'pointbuy') {
        //     container.querySelectorAll('.ability-inc-btn').forEach(btn => btn.addEventListener('click', (e) => this._onIncrementAbility(e, btn)));
        //     container.querySelectorAll('.ability-dec-btn').forEach(btn => btn.addEventListener('click', (e) => this._onDecrementAbility(e, btn)));
        // }

        if (abilityMode === 'roll') {
            const rollBtn = container.querySelector('.roll-abilities-btn');
            if (rollBtn) rollBtn.addEventListener('click', () => this._onRollAbilities());

            container.querySelectorAll('.roll-history-item').forEach((item, index) => {
                item.addEventListener('click', () => this._selectRollResult(index));
            });
        }

        if (abilityMode === 'roll' || abilityMode === 'standardArray') {
            container.querySelectorAll('.available-value').forEach(btn => {
                btn.addEventListener('click', () => {
                    const valueIndex = parseInt(btn.dataset.valueIndex);
                    this._selectAssignmentValue(valueIndex);
                });
            });

            // 目标属性卡片点击
            container.querySelectorAll('.assignment-target').forEach(target => {
                target.addEventListener('click', () => {
                    const ability = target.dataset.ability;
                    this._assignValueToAbility(ability);
                });
            });
        }
    }

    // ==================== ASI Bonus 点数分配 ====================

    /**
     * Adrian: 获取 ASI 步骤的点数分配信息（公共方法，供增减按钮复用）
     */
    _getAsiPointsInfo() {
        const deferredASIs = this.context.deferredASIs || [];
        const pointsASIs = deferredASIs.filter(a => a.type === 'points');
        let totalPoints = 0;
        let maxPerAbility = 2;
        const lockedAbilities = new Set();
        pointsASIs.forEach(a => {
            totalPoints += a.points;
            if (a.cap) maxPerAbility = a.cap;
            let lockedArr = [];
            if (a.locked instanceof Set) lockedArr = Array.from(a.locked);
            else if (Array.isArray(a.locked)) lockedArr = a.locked;
            else if (a.locked && typeof a.locked === 'object') lockedArr = Object.keys(a.locked);
            lockedArr.forEach(ab => lockedAbilities.add(ab));
        });
        return { totalPoints, maxPerAbility, lockedAbilities, pointsASIs };
    }

    /**
     * 增加属性的 ASI 分配点数
     * Adrian: 不再调用 this.render() 以避免滚动位置重置，改为直接 DOM 更新
     */
    async _onAsiAllocIncrease(event, target) {
        const ability = target.dataset.ability;
        if (!ability || !this._asiAllocations) return;

        const { totalPoints, maxPerAbility, lockedAbilities } = this._getAsiPointsInfo();

        if (lockedAbilities.has(ability)) {
            window.OriginateLog(`Originate | ASI 分配拒绝: ${ability} 被锁定`);
            return;
        }

        const usedPoints = Object.values(this._asiAllocations).reduce((sum, v) => sum + v, 0);
        if (usedPoints >= totalPoints) return;
        if (this._asiAllocations[ability] >= maxPerAbility) return;

        this._asiAllocations[ability]++;
        window.OriginateLog(`Originate | ASI 分配: ${ability} +1, 当前:`, { ...this._asiAllocations });
        this._updateAsiBonusDisplay();
    }

    /**
     * 减少属性的 ASI 分配点数
     * Adrian: 同上，直接 DOM 更新，不 render
     */
    async _onAsiAllocDecrease(event, target) {
        const ability = target.dataset.ability;
        if (!ability || !this._asiAllocations) return;
        if (this._asiAllocations[ability] <= 0) return;

        this._asiAllocations[ability]--;
        window.OriginateLog(`Originate | ASI 分配: ${ability} -1, 当前:`, { ...this._asiAllocations });
        this._updateAsiBonusDisplay();
    }

    /**
     * Adrian: 直接更新 ASI Bonus 页面的 DOM，不触发全量 render
     * 更新内容：每张卡片的分配值、修正值、按钮启用状态、剩余点数、下一步按钮
     */
    _updateAsiBonusDisplay() {
        const bs = this._getBaseAbilityScore();
        const abilities = this.context.abilities || { str: bs, dex: bs, con: bs, int: bs, wis: bs, cha: bs };
        const deferredASIs = this.context.deferredASIs || [];
        const fixedASIs = deferredASIs.filter(a => a.type === 'fixed');
        const { totalPoints, maxPerAbility, lockedAbilities } = this._getAsiPointsInfo();

        // 计算固定加成
        const fixedBonuses = {};
        fixedASIs.forEach(asi => {
            if (!fixedBonuses[asi.ability]) fixedBonuses[asi.ability] = 0;
            fixedBonuses[asi.ability] += asi.value;
        });

        const usedPoints = Object.values(this._asiAllocations).reduce((sum, v) => sum + v, 0);
        const remainingPoints = totalPoints - usedPoints;

        // 更新每张卡片
        for (const [key, baseValue] of Object.entries(abilities)) {
            const card = this.element.querySelector(`.asi-card[data-ability="${key}"]`);
            if (!card) continue;

            const fixedBonus = fixedBonuses[key] || 0;
            const allocatedBonus = this._asiAllocations[key] || 0;
            const totalBonus = fixedBonus + allocatedBonus;
            const finalValue = baseValue + totalBonus;
            const finalMod = this._getAbilityModifier(finalValue);
            const isLocked = lockedAbilities.has(key);

            // 更新分配值显示
            const valueDisplay = card.querySelector('.asi-value');
            if (valueDisplay) {
                valueDisplay.textContent = totalBonus ? `+${totalBonus}` : '0';
            }

            // 更新修正值
            const modDisplay = card.querySelector('.ability-modifier');
            if (modDisplay) {
                modDisplay.textContent = this._formatModifier(finalMod);
                modDisplay.classList.remove('positive', 'negative', 'neutral');
                if (finalMod > 0) modDisplay.classList.add('positive');
                else if (finalMod < 0) modDisplay.classList.add('negative');
                else modDisplay.classList.add('neutral');
            }

            // 更新 +/- 按钮启用状态
            const incBtn = card.querySelector('.asi-increase');
            if (incBtn) {
                incBtn.disabled = isLocked || remainingPoints <= 0 || allocatedBonus >= maxPerAbility;
            }
            const decBtn = card.querySelector('.asi-decrease');
            if (decBtn) {
                decBtn.disabled = isLocked || allocatedBonus <= 0;
            }
        }

        // 更新剩余点数
        const remainingEl = this.element.querySelector('.asi-points-remaining');
        if (remainingEl) {
            remainingEl.textContent = remainingPoints;
            remainingEl.classList.toggle('all-spent', remainingPoints === 0);
        }

        // 更新下一步按钮
        const nextBtn = this.element.querySelector('.asi-bonus-layout .nav-btn');
        if (nextBtn) {
            nextBtn.disabled = remainingPoints !== 0;
        }
    }

    /**
     * 保持滚动位置的 render 包装器
     * Adrian: 直接调用 this.render() 会重建 DOM，导致滚动条回到顶部。
     * 这里在 render 前记录滚动位置，render 完成后恢复。
     */
    async _renderPreservingScroll() {
        // 找到所有可能的可滚动容器并保存其滚动位置
        const scrollData = [];
        const scrollSelectors = [
            '.levelup-content',
            '.sub-interface-content',
            '.originate-wizard-content',
            '.wizard-content',
            '.page-inner'
        ];
        for (const sel of scrollSelectors) {
            const el = this.element?.querySelector?.(sel);
            if (el && el.scrollTop > 0) {
                scrollData.push({ selector: sel, top: el.scrollTop });
            }
        }

        await this.render();

        // 等待一帧让 DOM 更新完成后恢复滚动
        if (scrollData.length > 0) {
            requestAnimationFrame(() => {
                for (const { selector, top } of scrollData) {
                    const el = this.element?.querySelector?.(selector);
                    if (el) el.scrollTop = top;
                }
            });
        }
    }
};
