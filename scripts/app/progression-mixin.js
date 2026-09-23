import { createCharacterFromFinalizeInput } from '../services/character-finalize-service.js';
import { ensureTraitSet, isTraitCollectionPath } from '../shared/trait-collections.js';
import { getThemeClassList } from '../theme-registry.js';
import { LevelUpManager } from '../levelup-manager.js';
import { WizardUIMixin } from '../shared/wizard-ui-mixin.js';
import {
    bindSubclassSelectionPanel,
    bindTooltips,
    generateSpellCards,
    processHtmlDescription,
    renderSubclassSelectionPanel
} from '../shared/progression-renderer.js';
import {
    applyPreparedListSpell,
    applySpellConfigToItemData,
    collectWeaponProficiencyKeys,
    mergeSpellDuplicateData,
    normalizeSpellItemData
} from '../shared/advancement-rule-utils.js';
import { SpellRules } from '../spell-rules.js';
import { usesSpellBrowser } from '../shared/advancement-choice-rules.js';
import {
    appendAdvancementSource,
    findAdvancementEntry,
    getAdvancementEntries,
    getAdvancementCount,
    hasAdvancementEntries
} from '../utils/advancement-utils.js';
import { normalizeToolId } from '../mapping.js';
import { resolveItemSourceUuid, stampSourceTracking } from '../shared/resolution-core.js';
import { getSpellClassesForSpell, spellClassSetMatchesAny } from '../shared/spell-list-filters.js';
import { shouldWriteCharacterDetailField } from '../shared/character-creation-settings.js';
import {
    getAverageHitPointIncrease,
    isHitPointRollLocked,
    resolveHitPointChoice
} from '../shared/hit-point-choice.js';
import {
    dedupeStatusEntries,
    renderCharacterStatusSnapshot
} from '../shared/character-status-view.js';
import {
    applyInitialEquipmentLedger,
    buildInitialEquipmentSellEntries,
    calculateLedgerDeltaGp,
    canAffordPurchase,
    getBlueprintCurrencyGp,
    getInitialEquipmentCategory,
    hasInitialEquipmentShopChoices,
    INITIAL_EQUIPMENT_ITEM_TYPES,
    INITIAL_EQUIPMENT_SELL_MULTIPLIER,
    isInitialEquipmentItem,
    mergeInitialEquipmentQuantity,
    normalizeSellMultiplier,
    normalizeUuid,
    normalizeShopEntries,
    roundGp,
    splitGpToCurrencyParts
} from '../shared/initial-equipment-ledger.js';

/**
 * ProgressionMixin - 创角内的目标等级展开与最终提交
 *
 * 这里的“progression”是把一个尚未提交的新角色从 1 级逐级展开到目标等级，所有选择先写进 blueprint。
 * 它不是现有角色的升级入口；真实升级由 LevelUpApp 持有独立状态，并通过 LevelUpManager 提交。
 * 两边只共用 WizardUIMixin 的步骤 UI，不能共用开始、回退、完成或异常恢复的生命周期。
 *
 * 职责：
 *   - 创角内逐级展开编排（_startLevelUpProgression, _loadLevelFeatures）
 *   - 各步骤类型的数据保存（spell_choice, prepared_spell_grant, trait_choice, item_choice 等）
 *   - 角色最终写入（_finalizeCharacter → CharacterFinalizeService）
 *   - HP 计算与投骰
 * 
 * 依赖方法（来自其他 Mixin）：
 *   - this._renderFullSubInterface()         ← UIMixin — 渲染子界面（子职/特性选择）
 *   - this._renderExpertiseStep()            ← UIMixin — 渲染专精选择界面
 *   - this._applyFeatureType()               ← UIMixin — 设置 item 的 type flag
 *   - this._applyTraitToUpdate()             ← UIMixin — 应用特质到 blueprint
 *   - this._checkNestedAdvancements()        ← UIMixin — 检查嵌套 advancement
 *   - this._insertNestedSteps()              ← UIMixin — 插入嵌套步骤
 *   - this._bindTooltips()                   ← UIMixin — 绑定物品 tooltip
 *   - this._playSound()                      ← app.js — 播放音效
 *   - this._showConfirmDialog()              ← UIMixin — 自定义确认弹窗
 * 
 * 依赖方法（来自 WizardUIMixin，通过 Object.assign 混入）：
 *   - this._renderCurrentStep()              ← WizardUIMixin — 渲染当前向导步骤
 *   - this._renderSpellChoice()              ← WizardUIMixin — 法术浏览器 UI
 *   - this._renderSpellReplacement()         ← WizardUIMixin — 法术替换 UI
 *   - this._renderPreparedSpellGrant()       ← WizardUIMixin — 准备型法术授予 UI
 *   - this._renderItemChoice()               ← WizardUIMixin — 物品选择 UI
 *   - this._renderTraitChoice()              ← WizardUIMixin — 特质选择 UI
 *   - this._bindSpellBrowserEvents()         ← WizardUIMixin — 法术浏览器事件
 *   - this._bindSpellReplacementEvents()     ← WizardUIMixin — 法术替换事件
 *   - this._bindProgressionEvents()          ← WizardUIMixin — 步骤通用事件
 *   - this._checkProgressionCanProceed()     ← WizardUIMixin — 检查能否继续
 * 
 * 依赖共享状态：
 *   - this.dataManager                       ← app.js — 数据加载（Compendium/法术/特性）
 *   - this.blueprintData                     ← app.js — 全局蓝图（class/race/background/subclass）
 *   - this.context                           ← app.js — 上下文状态（classIdentifier, abilities, details 等）
 *   - this.actor                             ← Foundry — 目标 Actor 实例
 *   - this.characterLevel                    ← LevelMixin — 角色总等级
 *   - this._progressionState                 ← 内部 — 创角逐级展开状态（currentLevel, steps, hpGains）
 * 
 * 提供方法（被其他 Mixin/文件调用）：
 *   - this._onFinish()                       → NavigationMixin（最后一步完成时）
 *   - this._finalizeCharacter()              → 内部（蓝图合并 + 最终结算服务写入）
 *   - this._generateLevel1SpellSteps()       → 内部（1 级法术步骤生成）
 */
export const ProgressionMixin = (Base) => {
    const _ProgClass = class extends Base {
        // 别名: WizardUIMixin 使用 this._state
        get _state() { return this._progressionState; }
        set _state(v) { this._progressionState = v; }
        async _onFinish() {
            // 传记页完成后还要继续跑 progression。这个锁要一直留到整条创角链结束，
            // 不然底页意外露出来时再点一次，就会把已经完成的法术步骤重新初始化。
            if (this._creationCompletionStarted) {
                console.warn('Originate | 创角完成流程已经启动，忽略重复调用');
                return false;
            }
            this._creationCompletionStarted = true;

            try {
                // 检查是否需要逐级升级流程
                // 如果你只是个 1 级菜鸟，那就简单多了
                const totalLevel = this.characterLevel || 1;
                console.log(`Originate | [DEBUG] _onFinish called! totalLevel=${totalLevel}, characterLevel=${this.characterLevel}`);

                if (totalLevel > 1) {
                    // 启动逐级升级向导
                    await this._startLevelUpProgression();
                    return true;
                }

                // 1 级角色：先检查是否需要选择法术
                const level1SpellSteps = await this._generateLevel1SpellSteps();
                if (level1SpellSteps.length > 0) {
                    // 有法术步骤，启动一个迷你向导
                    this._progressionState = {
                        currentLevel: 1,
                        targetLevel: 1,
                        hpGains: [{ level: 1, hp: 0, method: 'max' }],
                        steps: level1SpellSteps,
                        currentStepIndex: 0,
                        stepData: {},
                        stepHistory: {},
                        classUuid: null,
                        hitDie: 8,
                        isLevel1SpellOnly: true // 标记：完成后直接 finalize
                    };
                    // 设置 classUuid
                    const classItem = this.blueprintData.class?.items?.find(i => i.type === 'class');
                    if (classItem) {
                        this._progressionState.classUuid = resolveItemSourceUuid(classItem);
                        this._progressionState.hitDie = parseInt(String(classItem.system?.hd?.denomination || '8').replace(/\D/g, '')) || 8;
                    }
                    await this._renderCurrentStep();
                    return true;
                }

                // 无法术步骤，第一次完成就是最终提交；失败时允许用户在原页面重试。
                const finalized = await this._finalizeCharacter();
                if (!finalized) this._creationCompletionStarted = false;
                return finalized;
            } catch (error) {
                this._creationCompletionStarted = false;
                throw error;
            }
        }

        /**
         * 启动创角内的逐级展开。
         * 方法名是历史遗留，但这里不会读取或升级一个已经完成的 Actor。
         */
        async _startLevelUpProgression() {
            window.OriginateLog("Originate | [Creation] 启动创角逐级展开流程。");

            // Adrian: 先把"步骤完成"标记设为 false，防止用户一进来就能跳过
            // 这个变量是门卫的小本本，记录你有没有做完作业
            this._currentStepComplete = false;

            // 这些只是最终提交前的创角草稿，真实 Actor 要到 _finalizeCharacter 才会写入。
            this._progressionState = {
                currentLevel: 2, // 从 2 级开始（1 级已在基础配置中处理，别问为什么）
                targetLevel: this.characterLevel,
                hpGains: [], // 记录每级的 HP 增益，血条就是命根子
                selectedFeats: [], // 记录选择的专长，虽然大部分人只会选那几个强力的
                classUuid: null, // 当前职业的 UUID，别弄丢了
                hitDie: 8, // 生命骰，默认 d8，中规中矩

                // 步骤管理
                steps: [], // 当前等级的步骤列表，就像任务清单
                currentStepIndex: 0, // 当前步骤索引，别迷路了
                stepData: {}, // 存储各步骤的选择数据，临时的家
                stepHistory: {} // Adrian: 记录每个步骤产生的副作用（物品、属性等），用于回滚
            };

            // 获取职业信息
            // 尝试从 blueprintData 获取，希望它还在那里
            const classItem = this.blueprintData.class?.items?.find(i => i.type === 'class');
            if (classItem) {
                // 尝试从 system.hd.denomination 获取生命骰
                // 正则表达式是程序员最好的朋友，也是最大的噩梦
                if (classItem.system?.hd?.denomination) {
                    const match = String(classItem.system.hd.denomination).match(/d?(\d+)/);
                    if (match) {
                        this._progressionState.hitDie = parseInt(match[1]);
                    }
                } else {
                    this._progressionState.hitDie = this.blueprintData.class?.hitDie || 8;
                }

                // 尝试获取 UUID
                // 就像找身份证一样，翻箱倒柜
                this._progressionState.classUuid = resolveItemSourceUuid(classItem) || classItem._id;
                window.OriginateLog(`Originate | 从 Blueprint 获取职业 UUID: ${this._progressionState.classUuid}`);

                // 【修复】设置 classIdentifier，确保后续特性分类逻辑能获取到正确的子类型
                if (!this.context.classIdentifier) {
                    if (classItem.system?.identifier) {
                        this.context.classIdentifier = classItem.system.identifier;
                        window.OriginateLog(`Originate | 设置 classIdentifier (from item): ${classItem.system.identifier}`);
                    } else if (this.context.class) {
                        // 尝试从配置中获取
                        const configData = game.settings.get('character-forge', 'data');
                        const classConfig = configData.classs?.[this.context.class];
                        if (classConfig?.identifier) {
                            this.context.classIdentifier = classConfig.identifier;
                            window.OriginateLog(`Originate | 设置 classIdentifier (from config): ${classConfig.identifier}`);
                        } else {
                            // 尝试从 UUID 获取
                            const classUuid = this._progressionState.classUuid;
                            if (classUuid) {
                                try {
                                    const doc = await this.dataManager.getDocument(classUuid);
                                    if (doc?.system?.identifier) {
                                        this.context.classIdentifier = doc.system.identifier;
                                        window.OriginateLog(`Originate | 设置 classIdentifier (from doc): ${doc.system.identifier}`);
                                    }
                                } catch (e) {
                                    console.warn("Originate | Failed to fetch class doc for identifier:", e);
                                }
                            }
                        }
                    }
                }
            }

            // 计算 1 级的 HP（最大值 + 体质调整值）
            // 1 级总是满血，这是规矩
            const conMod = this._getConstitutionModifier();
            const level1HP = this._progressionState.hitDie + conMod;
            this._progressionState.hpGains.push({ level: 1, hp: level1HP, method: 'max' });

            window.OriginateLog(`Originate | 1 级 HP: ${level1HP} (d${this._progressionState.hitDie} max + ${conMod} CON)`);

            // ========== Level 1 法术步骤 ==========
            // 升级流程从 Level 2 开始，Level 1 的法术需要单独处理
            const level1SpellSteps = await this._generateLevel1SpellSteps();
            if (level1SpellSteps.length > 0) {
                // 先展示 Level 1 的法术步骤
                this._progressionState.currentLevel = 1;
                this._progressionState.steps = level1SpellSteps;
                this._progressionState.currentStepIndex = 0;
                this._progressionState.isLevel1SpellPhase = true; // 标记：完成后进入 level 2
                await this._renderCurrentStep();
            } else {
                // 无 Level 1 法术步骤，直接加载 Level 2
                await this._loadLevelFeatures(this._progressionState.currentLevel);
            }
        }

        /**
         * 生成 Level 1 的法术步骤（用于角色创建时）
         * @returns {Array} 法术步骤数组
         */
        async _generateLevel1SpellSteps() {
            console.log(`Originate | [Creation] _generateLevel1SpellSteps called`);
            console.log(`Originate | [Creation]   context.classIdentifier = "${this.context?.classIdentifier}"`);
            console.log(`Originate | [Creation]   _progressionState?.classUuid = "${this._progressionState?.classUuid}"`);

            let classIdentifier = this.context.classIdentifier;

            // 回退路径 1: 直接从 blueprintData 的 class item 获取 identifier
            if (!classIdentifier) {
                const classItem = this.blueprintData?.class?.items?.find(i => i.type === 'class');
                console.log(`Originate | [Creation]   blueprintData classItem:`, classItem?.name, `identifier:`, classItem?.system?.identifier, `uuid:`, classItem?.uuid);
                if (classItem?.system?.identifier) {
                    classIdentifier = classItem.system.identifier;
                    this.context.classIdentifier = classIdentifier;
                    console.log(`Originate | [Creation]   从 blueprintData class item 获取 identifier: ${classIdentifier}`);
                }
            }

            // 回退路径 2: 从 classUuid 异步获取
            if (!classIdentifier) {
                const classItem = this.blueprintData?.class?.items?.find(i => i.type === 'class');
                const classUuid = this._progressionState?.classUuid || resolveItemSourceUuid(classItem);
                console.log(`Originate | [Creation]   尝试从 classUuid 获取: ${classUuid}`);
                if (classUuid) {
                    try {
                        const doc = await this.dataManager.getDocument(classUuid);
                        if (doc?.system?.identifier) {
                            classIdentifier = doc.system.identifier;
                            this.context.classIdentifier = classIdentifier;
                            console.log(`Originate | [Creation]   从 doc 获取 identifier: ${classIdentifier}`);
                        }
                    } catch (e) {
                        console.warn(`Originate | [Creation]   获取 class doc 失败:`, e);
                    }
                }
            }

            // 回退路径 3: 从 context.class 配置获取
            if (!classIdentifier && this.context?.class) {
                try {
                    const configData = game.settings.get('character-forge', 'data');
                    const classConfig = configData.classs?.[this.context.class];
                    if (classConfig?.identifier) {
                        classIdentifier = classConfig.identifier;
                        this.context.classIdentifier = classIdentifier;
                        console.log(`Originate | [Creation]   从 config 获取 identifier: ${classIdentifier}`);
                    }
                } catch (e) { /* 静默 */ }
            }

            if (!classIdentifier) {
                console.warn(`Originate | [Creation]   无法获取 classIdentifier，跳过法术步骤`);
                return [];
            }

            console.log(`Originate | [Creation]   最终 classIdentifier = "${classIdentifier}"`);

            // 检查主职规则，无则回退到子职
            let spellRulesId = classIdentifier;
            if (!SpellRules.getRules(spellRulesId)) {
                const subItem = this.blueprintData.subclass?.items?.find(i => i.type === 'subclass');
                const subId = subItem?.system?.identifier;
                console.log(`Originate | [Creation]   主职无规则，检查子职: ${subId}`);
                if (subId && SpellRules.getRules(subId)) spellRulesId = subId;
                else {
                    console.log(`Originate | [Creation]   无可用法术规则`);
                    return [];
                }
            }

            const sourceItem = [...(this.blueprintData.class?.items || []), ...(this.blueprintData.subclass?.items || [])]
                .find(item => ['class', 'subclass'].includes(item.type) && item.system?.identifier === spellRulesId);
            const nativeChoices = this.dataManager._convertAdvancementsToUI?.(
                getAdvancementEntries(sourceItem?.system?.advancement).filter(adv => adv.type === 'ItemChoice'), sourceItem, 1
            ) || [];
            let spellSteps = SpellRules.generateSpellSteps(spellRulesId, 0, 1, { stepType: 'class', nativeChoices });
            // 创建角色时过滤掉 spell_replacement（没有已有法术可替换）
            spellSteps = spellSteps.filter(s => s.type !== 'spell_replacement');
            console.log(`Originate | [Creation]   SpellRules.generateSpellSteps("${spellRulesId}", 0, 1) = ${spellSteps.length} 步骤:`, spellSteps.map(s => s.title));
            return spellSteps;
        }

        /**
         * 获取体质调整值
         * 
         * 体质很重要，活着才有输出。
         * 
         * Adrian: 这个方法需要考虑三个来源的体质值：
         * 1. 用户在属性步骤设置的初始值 (this.context.abilities.con)
         * 2. 种族/背景给的加成 (blueprintData.*.system['abilities.con.value'])
         * 3. 升级流程中的 ASI 加成 (blueprintData.class.system['abilities.con.value'])
         */
        _getConstitutionModifier() {
            // 1. 获取用户设定的基础体质值
            // 如果用户还没设（虽然不太可能到这一步还没设），就用 Actor 的当前值或默认值 10
            const userBaseValue = this.context.abilities?.con || this.actor.system.abilities?.con?.value || 10;

            // 2. 获取 Actor 的系统基础值（通常是 10）
            // 我们需要用这个值来计算种族和背景提供的"增量"
            const actorBaseValue = this.actor.system.abilities?.con?.value || 10;

            // 3. 累加所有来源的加成
            // Adrian: 这是一个简单的数学题：最终值 = 用户设定值 + (种族值 - 系统基准) + (背景值 - 系统基准) + ...
            let totalBonus = 0;

            // 种族加成
            if (this.blueprintData.race?.system?.['abilities.con.value']) {
                const raceConValue = this.blueprintData.race.system['abilities.con.value'];
                // 如果种族值 > 系统基准，说明有加成
                if (raceConValue > actorBaseValue) {
                    totalBonus += raceConValue - actorBaseValue;
                }
            }

            // 背景加成
            if (this.blueprintData.background?.system?.['abilities.con.value']) {
                const bgConValue = this.blueprintData.background.system['abilities.con.value'];
                if (bgConValue > actorBaseValue) {
                    totalBonus += bgConValue - actorBaseValue;
                }
            }

            // 职业 ASI 加成（升级流程中选择的）
            if (this.blueprintData.class?.system?.['abilities.con.value']) {
                const classConValue = this.blueprintData.class.system['abilities.con.value'];
                if (classConValue > actorBaseValue) {
                    totalBonus += classConValue - actorBaseValue;
                }
            }

            const finalConValue = userBaseValue + totalBonus;
            window.OriginateLog(`Originate | 体质计算: 用户基准=${userBaseValue}, 系统基准=${actorBaseValue}, 累积加成=${totalBonus}, 最终值=${finalConValue}, 调整值=${Math.floor((finalConValue - 10) / 2)}`);

            return Math.floor((finalConValue - 10) / 2);
        }

        /**
         * 获取已拥有的物品名称集合（角色创建上下文）
         * Adrian: WizardUIMixin._renderItemChoice 需要这个方法来标记已选物品
         * 创建流程中我们从 blueprintData 和 pending items 获取
         */
        _getObtainedItemNames() {
            const names = new Set();
            // 从 blueprintData 中收集已有物品
            for (const stepType of ['race', 'class', 'background', 'subclass']) {
                const items = this.blueprintData?.[stepType]?.items || [];
                for (const item of items) {
                    if (item.name) names.add(item.name);
                }
            }
            // 从 pending items 收集
            const pendingItems = this._progressionState?.pendingItems || [];
            for (const pending of pendingItems) {
                if (pending.itemData?.name) names.add(pending.itemData.name);
            }
            return names;
        }

        /**
         * 获取已拥有的物品 UUID 集合（角色创建上下文）
         */
        _getObtainedItemUuids() {
            const uuids = new Set();
            for (const stepType of ['race', 'class', 'background', 'subclass']) {
                const items = this.blueprintData?.[stepType]?.items || [];
                for (const item of items) {
                    if (item.uuid) uuids.add(item.uuid);
                    const sourceUuid = resolveItemSourceUuid(item);
                    if (sourceUuid) uuids.add(sourceUuid);
                }
            }
            const pendingItems = this._progressionState?.pendingItems || [];
            for (const pending of pendingItems) {
                if (pending.itemData?._sourceUuid) uuids.add(pending.itemData._sourceUuid);
            }
            return uuids;
        }

        /**
         * 获取已拥有的特质集合（角色创建上下文）
         */
        _getKnownTraits() {
            const known = new Set();
            // 从 blueprintData 的特质收集
            for (const stepType of ['race', 'class', 'background', 'subclass']) {
                const system = this.blueprintData?.[stepType]?.system || {};
                // 技能
                if (system.skills) {
                    for (const [key, skill] of Object.entries(system.skills)) {
                        const profLevel = skill.value ?? skill.proficient ?? 0;
                        if (profLevel >= 1) known.add(`skills:${key}`);
                    }
                }
                // 语言
                if (system['traits.languages.value']) {
                    for (const lang of system['traits.languages.value']) known.add(`languages:${lang}`);
                }
                if (system['traits.toolProf.value']) {
                    for (const tool of system['traits.toolProf.value']) {
                        const toolId = normalizeToolId(tool);
                        if (toolId) known.add(`tool:${toolId}`);
                    }
                }
                if (system['traits.weaponProf.value']) {
                    for (const weapon of system['traits.weaponProf.value']) known.add(`weapon:${weapon}`);
                }
                if (system['traits.weaponProf.mastery.value']) {
                    for (const mastery of system['traits.weaponProf.mastery.value']) known.add(`weaponMastery:${mastery}`);
                }
                if (system['traits.weaponMastery.value']) {
                    for (const mastery of system['traits.weaponMastery.value']) known.add(`weaponMastery:${mastery}`);
                }
                if (system['traits.armorProf.value']) {
                    for (const armor of system['traits.armorProf.value']) known.add(`armor:${armor}`);
                }
            }
            // 从 pending trait changes 收集
            const pendingTraitChanges = this._progressionState?.pendingTraitChanges || [];
            for (const change of pendingTraitChanges) {
                if (change.key) known.add(change.key);
            }
            return known;
        }

        /**
         * 获取可替换的物品候选列表（角色创建上下文）
         * 镜像 levelup-manager.js 的 getReplacementCandidates，
         * 但从 blueprintData 中搜索而非 actor.items
         */
        _getReplacementCandidates(event) {
            const candidates = [];

            // 解析限制条件
            let targetFeatType = event.restriction?.type || null;
            let targetSubtype = event.restriction?.subtype || null;

            // 如果没有显式限制，从 pool 推断
            if (!targetFeatType && !targetSubtype && event.pool?.length > 0) {
                const sample = event.pool.find(i => i.system?.type);
                if (sample) {
                    targetFeatType = sample.system?.type?.value;
                    targetSubtype = sample.system?.type?.subtype;
                }
            }

            window.OriginateLog(`Originate | [Creation] 查找可替换物品: featType=${targetFeatType}, subtype=${targetSubtype}`);

            // 从 blueprintData 各板块搜索
            for (const stepType of ['race', 'class', 'background', 'subclass']) {
                const items = this.blueprintData?.[stepType]?.items || [];
                for (const item of items) {
                    // 跳过核心物品
                    if (['class', 'subclass', 'race', 'background'].includes(item.type)) continue;

                    // 类型匹配
                    if (targetFeatType) {
                        const itemFeatType = item.system?.type?.value;
                        if (itemFeatType !== targetFeatType) continue;
                    }

                    // 子类型匹配
                    if (targetSubtype) {
                        const itemSubtype = item.system?.type?.subtype;
                        if (itemSubtype !== targetSubtype) continue;
                    }

                    // 构造一个兼容 wizard-ui-mixin 期望格式的对象
                    candidates.push({
                        id: item._id || item.uuid || item.name,
                        name: item.name,
                        img: item.img || 'icons/svg/item-bag.svg',
                        type: item.type,
                        system: item.system,
                        flags: item.flags
                    });
                }
            }

            window.OriginateLog(`Originate | [Creation] 找到 ${candidates.length} 个可替换物品:`, candidates.map(i => i.name));
            return candidates;
        }

        async _appendExistingNestedFeatureSteps(level, steps) {
            const seenStepIds = new Set(steps.map(step => step.id).filter(Boolean));

            for (const stepType of ['class', 'subclass', 'race', 'background']) {
                const items = this.blueprintData?.[stepType]?.items || [];
                for (const itemData of items) {
                    if (!itemData || ['class', 'subclass', 'race', 'background'].includes(itemData.type)) continue;

                    const acquiredAt = Number(itemData.flags?.['hero-genesis']?.acquiredAt);
                    if (Number.isFinite(acquiredAt) && acquiredAt >= level) continue;

                    const sourceUuid = resolveItemSourceUuid(itemData) || itemData._sourceUuid || itemData.uuid;
                    if (!sourceUuid) continue;

                    let events = await this.dataManager.getLevelAdvancement(sourceUuid, level);
                    if (!events.length) continue;

                    await this.dataManager.enrichOptions(events);

                    const parentSourceUuid = resolveItemSourceUuid(itemData) || itemData._sourceUuid || itemData.uuid || sourceUuid;
                    for (const event of events) {
                        event.sourceLevel = level;
                        event.parentFeature = itemData.name || null;
                        event.parentSourceUuid = parentSourceUuid;

                        const advId = event._original?._id || event.id || event.title;
                        let step = null;

                        if (event.type === 'trait_choice') {
                            step = {
                                id: `nested-trait-${advId}-${level}`,
                                type: 'trait_choice',
                                title: `${itemData.name}: ${event.title}`,
                                event,
                                stepType,
                                advId,
                                parentFeature: itemData.name || null,
                                parentSourceUuid
                            };
                        } else if (event.type === 'choice') {
                            const isSpellChoice = usesSpellBrowser(event);

                            if (isSpellChoice && !event.restriction) {
                                event.restriction = event._original?.configuration?.spell || event.spellConfig || event.restriction;
                            }

                            step = {
                                id: `${isSpellChoice ? 'nested-spell' : 'nested-choice'}-${advId}-${level}`,
                                type: isSpellChoice ? 'spell_choice' : 'item_choice',
                                title: `${itemData.name}: ${event.title}`,
                                event,
                                stepType,
                                advId,
                                parentFeature: itemData.name || null,
                                parentSourceUuid
                            };
                        } else if (event.type === 'asi') {
                            // ⚠ 同步点：嵌套 ASI 的 points/cap 兜底逻辑和 levelup-app.js _appendNestedFeatureSteps() 里的 asi 分支必须一致
                            //   那边有 points undefined → 根据 fixed 兜底、cap || 2；这边直接透传，没有兜底——确认这是否故意
                            step = {
                                id: `nested-asi-${advId || itemData.name}-${level}`,
                                type: 'asi_feat_choice',
                                title: `${itemData.name}: ${event.title || game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}`,
                                points: event.points,
                                cap: event.cap,
                                locked: Array.from(event.locked || []),
                                stepType,
                                parentFeature: itemData.name || null,
                                parentSourceUuid,
                                advId: event.id || event._original?._id,
                                asiOnly: true,
                                fixed: event.fixed || event._original?.configuration?.fixed || {}
                            };
                        } else if (event.type === 'trait_grant') {
                            const targetBlueprint = this.blueprintData[stepType] || this.blueprintData.class;
                            if (!targetBlueprint.system) targetBlueprint.system = {};
                            const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);
                            grants.forEach(key => this._applyTraitToUpdate?.(key, targetBlueprint.system, event.mode || event._original?.configuration?.mode || 'default'));
                        }

                        if (!step || seenStepIds.has(step.id)) continue;
                        seenStepIds.add(step.id);
                        steps.push(step);
                    }
                }
            }
        }

        /**
         * 获取创角目标等级在这一等级应展开的内容。
         *
         * @param {number} level 等级
         * @returns {Promise<Object>} 各板块的创角 progression 内容
         */
        async _getLevelUpgrades(level) {
            const upgrades = {
                class: [],
                subclass: [],
                race: [],
                background: []
            };

            window.OriginateLog(`Originate | _getLevelUpgrades 开始，level=${level}。看看有什么惊喜。`);
            window.OriginateLog(`Originate | blueprintData.subclass:`, this.blueprintData.subclass);

            // 获取子职获得等级（用于判断是否跳过子职初始特性）
            // 尝试从当前职业选项中获取
            let subclassLevel = 3;

            // 尝试从职业选项中获取
            const classOptions = await this.dataManager.getOptions('class');
            const selectedClass = classOptions.find(o => o.id === this.context.class);
            if (selectedClass && selectedClass.subclassLevel !== undefined) {
                subclassLevel = selectedClass.subclassLevel;
            }

            // 1. 职业升级
            // 这是大头
            if (this._progressionState.classUuid) {
                upgrades.class = await this.dataManager.getLevelAdvancement(this._progressionState.classUuid, level);
            }

            // 2. 子职升级
            // 注意：如果当前等级是子职获得等级，跳过子职特性的获取
            // 因为子职初始特性已经在子职选择步骤中添加到 blueprintData.subclass 了
            // 别贪心，不能拿两份
            if (this.blueprintData.subclass?.items?.length > 0) {
                const subclassItem = this.blueprintData.subclass.items.find(i => i.type === 'subclass');
                window.OriginateLog(`Originate | 找到子职物品:`, subclassItem);

                if (subclassItem) {
                    // 检查是否是子职获得等级
                    // 如果是，跳过子职特性（已在子职选择步骤中处理）
                    if (level === subclassLevel) {
                        window.OriginateLog(`Originate | 跳过子职 Level ${level} 特性（已在子职选择步骤中处理）。别急，以后还有。`);
                    } else {
                        // 尝试多种方式获取子职 UUID
                        // 就像在垃圾堆里找宝贝
                        let subclassUuid = resolveItemSourceUuid(subclassItem);

                        // 如果还是没有，尝试从 context 中获取
                        if (!subclassUuid && this.context.subclass) {
                            const subclassConfig = configData.subclasss?.[this.context.subclass];
                            if (subclassConfig?.sourceUuid) {
                                subclassUuid = subclassConfig.sourceUuid;
                                window.OriginateLog(`Originate | 从配置获取子职 UUID: ${subclassUuid}`);
                            }
                        }

                        window.OriginateLog(`Originate | 子职 UUID: ${subclassUuid}`);

                        if (subclassUuid) {
                            const subclassEvents = await this.dataManager.getLevelAdvancement(subclassUuid, level);
                            window.OriginateLog(`Originate | 子职 Level ${level} 升级事件:`, subclassEvents);
                            upgrades.subclass = subclassEvents;
                        } else {
                            console.warn(`Originate | 无法获取子职 UUID，子职物品:`, subclassItem);
                        }
                    }
                }
            } else {
                window.OriginateLog(`Originate | 没有子职数据，blueprintData.subclass.items 为空或不存在。也许你还没选子职？`);
            }

            // 3. 种族升级 (通常较少，但可能有)
            // 比如提夫林的法术，或者阿斯莫的变身
            if (this.context.race) {
                const raceItem = this.blueprintData.race?.items?.find(i => i.type === 'race');
                if (raceItem) {
                    const raceUuid = resolveItemSourceUuid(raceItem);
                    if (raceUuid) {
                        upgrades.race = await this.dataManager.getLevelAdvancement(raceUuid, level);
                    }
                }
            }

            // 4. 背景升级 (通常没有，但为了完整性)
            // 谁知道以后会不会有呢？
            if (this.context.background) {
                const bgItem = this.blueprintData.background?.items?.find(i => i.type === 'background');
                if (bgItem) {
                    const bgUuid = resolveItemSourceUuid(bgItem);
                    if (bgUuid) {
                        upgrades.background = await this.dataManager.getLevelAdvancement(bgUuid, level);
                    }
                }
            }

            window.OriginateLog(`Originate | _getLevelUpgrades 完成，upgrades:`, upgrades);
            return upgrades;
        }

        _getCreationAbilityValue(ability) {
            const baseValue = this.context?.abilities?.[ability] || 8;
            let totalBonus = 0;

            for (const section of ['race', 'background', 'class']) {
                const value = this.blueprintData?.[section]?.system?.[`abilities.${ability}.value`];
                if (value > baseValue) totalBonus += value - baseValue;
                else if (value > 0 && value <= 5) totalBonus += value;
            }

            for (const asi of (this.context?.deferredASIs || []).filter(entry => entry.type === 'fixed')) {
                totalBonus += Number(asi.fixed?.[ability] || 0);
            }
            totalBonus += Number(this._asiAllocations?.[ability] || 0);

            return baseValue + totalBonus;
        }

        _syncCreationStatusTheme(host) {
            if (!host) return;

            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
            const themeClasses = getThemeClassList().split(' ').filter(Boolean);
            host.classList.remove(...themeClasses);
            host.classList.add(`theme-${visualTheme}`);

            const themeSource = this.element?.querySelector?.('.originate-container');
            if (!themeSource || typeof globalThis.getComputedStyle !== 'function') return;

            const sourceStyle = globalThis.getComputedStyle(themeSource);
            const colorTokens = [
                '--originate-theme-accent-color',
                '--originate-theme-accent-rgb',
                '--originate-accent',
                '--originate-accent-glow'
            ];

            for (const token of colorTokens) {
                const value = sourceStyle.getPropertyValue(token).trim();
                if (value) host.style.setProperty(token, value);
                else host.style.removeProperty(token);
            }
        }

        _renderCreationStatusDrawer() {
            const state = this._progressionState;
            const root = this.element;
            if (!root || !state || Number(state.targetLevel || 1) <= 1) {
                this._removeCreationStatusDrawer();
                return;
            }

            let host = root.querySelector('.originate-creation-status-host');
            if (!host) {
                host = document.createElement('div');
                host.className = 'originate-status-host originate-creation-status-host';
                host.innerHTML = `
                    <button type="button" class="levelup-status-toggle">
                        <i class="fas fa-id-card"></i>
                        <span>${game.i18n.localize('ORIGINATE.LevelUp.Status.Toggle')}</span>
                    </button>
                    <aside class="levelup-status-drawer">
                        <div class="levelup-status-header">
                            <div>
                                <div class="levelup-status-kicker">${game.i18n.localize('ORIGINATE.Creation.Status.Kicker')}</div>
                                <h3>${game.i18n.localize('ORIGINATE.Creation.Status.Title')}</h3>
                            </div>
                            <button type="button" class="levelup-status-close" title="${game.i18n.localize('ORIGINATE.LevelUp.Status.Close')}">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                        <div class="levelup-status-body"></div>
                    </aside>
                `;

                host.querySelector('.levelup-status-toggle')?.addEventListener('click', () => {
                    this._creationStatusDrawerOpen = !this._creationStatusDrawerOpen;
                    this._syncCreationStatusDrawerState();
                });
                host.querySelector('.levelup-status-close')?.addEventListener('click', () => {
                    this._creationStatusDrawerOpen = false;
                    this._syncCreationStatusDrawerState();
                });
                host.querySelector('.levelup-status-drawer')?.addEventListener('click', event => {
                    const tab = event.target.closest('[data-status-tab]');
                    if (!tab) return;
                    this._creationStatusDrawerTab = tab.dataset.statusTab || 'features';
                    this._refreshLevelupStatusDrawer();
                });

                root.appendChild(host);
            }

            this._creationStatusDrawerOpen ??= false;
            this._creationStatusDrawerTab ??= 'features';
            this._syncCreationStatusDrawerState();
            this._refreshLevelupStatusDrawer();
        }

        _syncCreationStatusDrawerState() {
            const host = this.element?.querySelector?.('.originate-creation-status-host');
            this._syncCreationStatusTheme(host);
            const drawer = host?.querySelector('.levelup-status-drawer');
            const toggle = host?.querySelector('.levelup-status-toggle');
            const isOpen = !!this._creationStatusDrawerOpen;

            drawer?.classList.toggle('open', isOpen);
            drawer?.setAttribute('aria-hidden', String(!isOpen));
            toggle?.classList.toggle('active', isOpen);
            toggle?.setAttribute('aria-expanded', String(isOpen));
        }

        _refreshLevelupStatusDrawer() {
            const body = this.element
                ?.querySelector?.('.originate-creation-status-host')
                ?.querySelector?.('.levelup-status-body');
            if (!body || !this._progressionState) return;

            body.innerHTML = renderCharacterStatusSnapshot(this._buildCreationStatusSnapshot(), {
                activeTab: this._creationStatusDrawerTab
            });
            this._bindTooltips?.(body);
        }

        _buildCreationStatusSnapshot() {
            const state = this._progressionState;
            const blueprintSections = ['class', 'subclass', 'race', 'background'];
            const items = blueprintSections.flatMap(section => this.blueprintData?.[section]?.items || []);
            const classConfigs = this.context?.levelConfig?.classes || [];
            const toStatusItem = item => ({
                name: item.name,
                img: item.img,
                uuid: resolveItemSourceUuid(item) || item.uuid || '',
                tooltipHtml: item.system?.description?.value || ''
            });
            const uniqueItems = entries => {
                const seen = new Set();
                return entries.filter(entry => {
                    const key = resolveItemSourceUuid(entry) || entry.uuid || entry._id || `${entry.type}:${entry.name}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            };

            let classes = items
                .filter(item => item.type === 'class')
                .map((item, index) => {
                    const configured = classConfigs.find(entry =>
                        entry.id === item._id
                        || entry.id === item.id
                        || entry.id === item.system?.identifier
                    ) || classConfigs[index];
                    const level = Number(configured?.level || item.system?.levels || (index === 0 ? this.characterLevel : 0));
                    return {
                        name: item.name,
                        detail: level > 0
                            ? game.i18n.format('ORIGINATE.LevelUp.Status.LevelCount', { level })
                            : ''
                    };
                });

            if (!classes.length && this.context?.className) {
                classes = [{
                    name: this.context.className,
                    detail: game.i18n.format('ORIGINATE.LevelUp.Status.LevelCount', { level: this.characterLevel || 1 })
                }];
            }

            let subclasses = items
                .filter(item => item.type === 'subclass')
                .map(item => ({ name: item.name, detail: item.system?.classIdentifier || '' }));
            if (!subclasses.length && this.context?.subclassName) {
                subclasses = [{ name: this.context.subclassName, detail: this.context?.className || '' }];
            }

            const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key => {
                return {
                    key,
                    label: game.i18n.localize(`ORIGINATE.Ability.${key.charAt(0).toUpperCase()}${key.slice(1)}`),
                    value: this._getCreationAbilityValue(key)
                };
            });

            const features = uniqueItems(items.filter(item => item.type === 'feat')).map(toStatusItem);
            const spells = uniqueItems(items.filter(item => item.type === 'spell'))
                .sort((a, b) => (a.system?.level ?? 0) - (b.system?.level ?? 0) || a.name.localeCompare(b.name))
                .map(item => ({
                    ...toStatusItem(item),
                    detail: item.system?.level > 0
                        ? game.i18n.format('ORIGINATE.LevelUp.Status.SpellLevel', { level: item.system.level })
                        : game.i18n.localize('ORIGINATE.LevelUp.Status.Cantrip')
                }));

            const draft = [];
            for (const hp of state.hpGains || []) {
                if (!hp || hp.hp === undefined) continue;
                draft.push({
                    kind: 'hp',
                    label: game.i18n.localize('ORIGINATE.LevelUp.Status.HP'),
                    detail: `${game.i18n.format('ORIGINATE.LevelUp.Status.LevelCount', { level: hp.level })} · +${hp.hp}`
                });
            }
            for (const feat of state.selectedFeats || []) {
                draft.push({
                    kind: 'feat',
                    label: feat.name || feat.uuid,
                    detail: game.i18n.localize('ORIGINATE.LevelUp.Status.SelectedFeat')
                });
            }
            this._collectCreationLiveStatus(draft);

            return {
                actor: {
                    name: this.context?.details?.name || this.actor?.name || game.i18n.localize('ORIGINATE.NewCharacter'),
                    img: this.context?.details?.portrait || this.actor?.img || 'icons/svg/mystery-man.svg',
                    classes,
                    subclasses,
                    abilities,
                    features,
                    spells
                },
                subtitle: game.i18n.format('ORIGINATE.Creation.Status.LevelProgress', {
                    current: state.currentLevel,
                    target: state.targetLevel
                }),
                draft: dedupeStatusEntries(draft),
                draftTitleKey: 'ORIGINATE.Creation.Status.CurrentBuild'
            };
        }

        _collectCreationLiveStatus(entries) {
            const state = this._progressionState;
            const step = state?.steps?.[state.currentStepIndex];
            const overlay = this.element?.querySelector?.('.originate-progression-wizard');
            if (!step || !overlay) return;

            const push = (kind, label, detail = '') => {
                const text = String(label || '').trim();
                if (text) entries.push({ kind, label: text, detail });
            };

            if (step.type === 'asi_feat_choice') {
                const checkedFeat = overlay.querySelector('input[name^="feat-choice-"]:checked');
                if (checkedFeat) {
                    const card = checkedFeat.closest('.feat-option');
                    push('feat', card?.querySelector('.feature-name')?.textContent || checkedFeat.value, game.i18n.localize('ORIGINATE.LevelUp.Status.SelectedFeat'));
                }
                overlay.querySelectorAll('.asi-card').forEach(card => {
                    const ability = card.dataset.ability;
                    const value = parseInt(card.querySelector(`.asi-value[data-ability="${ability}"]`)?.textContent || '0') || 0;
                    if (ability && value > 0) {
                        push('asi', game.i18n.localize(`ORIGINATE.Ability.${ability.charAt(0).toUpperCase()}${ability.slice(1)}`), `+${value}`);
                    }
                });
                return;
            }

            if (step.type === 'spell_choice') {
                overlay.querySelectorAll('.selected-spells-list .spell-card').forEach(card => {
                    push('spell', card.querySelector('.spell-name')?.textContent || card.dataset.uuid, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingSpell'));
                });
                return;
            }

            if (step.type === 'item_choice') {
                overlay.querySelectorAll('.item-choices-list input[type="checkbox"]:checked, input[name^="item-choice-"]:checked').forEach(input => {
                    const card = input.closest('label') || input.closest('.option-card');
                    push('item', card?.querySelector('.feature-title, .item-name, .feature-name')?.textContent || input.value, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingItem'));
                });
                return;
            }

            if (step.type === 'trait_choice') {
                overlay.querySelectorAll('.trait-choice-section input[type="checkbox"]:checked').forEach(input => {
                    push('trait', input.closest('label')?.textContent || input.value, game.i18n.localize('ORIGINATE.LevelUp.Status.PendingTrait'));
                });
            }
        }

        _removeCreationStatusDrawer() {
            this.element?.querySelector?.('.originate-creation-status-host')?.remove();
            this._creationStatusDrawerOpen = false;
        }

        /**
         * 渲染当前步骤
         */
        async _renderCurrentStep() {
            const state = this._progressionState;
            const currentStep = state.steps[state.currentStepIndex];

            if (!currentStep) {
                console.error("Originate | 无效的步骤索引:", state.currentStepIndex);
                return;
            }

            // Adrian: 检查是否应该禁用上一步按钮
            // 用户反馈：专长选择一旦确定，不可返回，防止数据回滚导致的错误
            const prevStep = state.steps[state.currentStepIndex - 1];
            // 如果上一步是 ASI/专长选择，或者是嵌套的 ASI/专长选择（通常由专长触发），则禁止返回
            const isPrevStepFeat = prevStep && (prevStep.type === 'asi_feat_choice');
            const disablePrev = state.currentStepIndex === 0 || isPrevStepFeat;
            const prevBtnTitle = isPrevStepFeat ? (game.i18n.localize('ORIGINATE.UI.Progression.CannotGoBackFeat') || "专长/属性选择一旦确定不可更改") : "";

            let overlay = this.element.querySelector('.originate-progression-wizard');
            if (!overlay) {
                overlay = document.createElement('div');
                // 添加 originate-container 以继承主题 CSS 变量
                const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
                overlay.className = `originate-progression-wizard originate-sub-interface originate-container theme-${visualTheme}`;
                this.element.appendChild(overlay);
            } else {
                // 确保已有的 overlay 也有正确的主题类
                const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
                overlay.classList.add('originate-container');
                // 清主题类走注册表：硬编码清单漏掉外部皮肤（比如 theme-cyberpunk），复用 overlay 会双主题共存
                overlay.classList.remove(...getThemeClassList().split(' '));
                overlay.classList.add(`theme-${visualTheme}`);
            }

            // 渲染框架
            overlay.innerHTML = `
            <div class="sub-interface-header">
                <h2>${game.i18n.format('ORIGINATE.UI.Progression.LevelUpTitle', { level: state.currentLevel })}</h2>
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
                <!-- 步骤内容将在这里渲染 -->
            </div>
            <div class="sub-interface-footer">
                <button type="button" class="back-btn" id="progression-prev-btn" ${disablePrev ? 'disabled' : ''} title="${prevBtnTitle}">
                    <i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.UI.Button.Back')}
                </button>
                <button type="button" class="confirm-btn" id="progression-next-btn" disabled>
                    ${(state.currentStepIndex === state.steps.length - 1 && state.currentLevel === state.targetLevel) ? game.i18n.localize('ORIGINATE.UI.Button.FinishCreation') : game.i18n.localize('ORIGINATE.UI.Button.Next')} <i class="fas fa-arrow-right"></i>
                </button>
            </div>
        `;

            // 渲染步骤内容
            const contentContainer = overlay.querySelector('#progression-step-content');
            contentContainer.innerHTML = await this._renderStepContent(currentStep);

            // 绑定事件
            this._bindProgressionEvents(overlay, currentStep);

            // 绑定 tooltip（如果有 _bindTooltips 则调用，否则用内置简易版本）
            if (typeof this._bindTooltips === 'function') {
                this._bindTooltips(overlay);
            } else {
                this._bindProgressionTooltips(overlay);
            }

            // 检查是否可以继续（恢复之前的选择状态）
            this._checkProgressionCanProceed(overlay);
            this._renderCreationStatusDrawer();
        }

        /**
         * 渲染步骤内容 HTML
         */
        async _renderStepContent(step) {
            const state = this._progressionState;

            switch (step.type) {
                case 'hp':
                    const hitDie = state.hitDie;
                    const conMod = this._getConstitutionModifier();
                    const avgHP = getAverageHitPointIncrease(hitDie, conMod);
                    const savedHP = state.hpGains[state.currentLevel - 1];
                    const rollLocked = isHitPointRollLocked(savedHP);

                    return `
                    <div class="progression-hp-container">
                        <div class="hp-header">
                            <div class="hp-level-badge">LEVEL ${state.currentLevel}</div>
                            <h3>${game.i18n.localize('ORIGINATE.UI.Progression.HPTitle')}</h3>
                            <div class="hp-subtitle">${game.i18n.format('ORIGINATE.UI.Progression.HPSubtitle', { die: hitDie, mod: conMod })}</div>
                        </div>
                        
                        <div class="hp-options-wrapper ${rollLocked ? 'hp-options-wrapper--locked' : ''}">
                            <!-- 平均值选项 -->
                            <div class="hp-option-card ${savedHP?.method === 'average' ? 'selected' : ''}" data-method="average" data-hp="${avgHP}" aria-disabled="${rollLocked}">
                                <div class="hp-option-icon"><i class="fas fa-shield-alt"></i></div>
                                <div class="hp-option-title">${game.i18n.localize('ORIGINATE.UI.Progression.HPAverage')}</div>
                                <div class="hp-option-value">+${avgHP}</div>
                                <div class="hp-option-desc">${game.i18n.localize('ORIGINATE.UI.Progression.HPAverageDesc')}<br>${game.i18n.format('ORIGINATE.UI.Progression.HPAverageCalc', { avg: Math.floor(hitDie / 2) + 1, mod: conMod })}</div>
                                <div class="hp-selection-indicator"><i class="fas fa-check"></i></div>
                            </div>
                            
                            <!-- 投掷选项 -->
                            <div class="hp-option-card ${savedHP?.method === 'roll' ? 'selected' : ''}" data-method="roll" aria-disabled="${rollLocked}">
                                <div class="hp-option-icon"><i class="fas fa-dice-d20"></i></div>
                                <div class="hp-option-title">${game.i18n.localize('ORIGINATE.UI.Progression.HPRoll')}</div>
                                <div class="hp-option-value">1d${hitDie} + ${conMod}</div>
                                <div class="hp-option-desc">${game.i18n.localize('ORIGINATE.UI.Progression.HPRollDesc')}<br>${game.i18n.format('ORIGINATE.UI.Progression.HPRollRange', { min: 1 + conMod, max: hitDie + conMod })}</div>
                                <div class="hp-selection-indicator"><i class="fas fa-check"></i></div>
                            </div>
                        </div>
                        
                        <div class="hp-roll-result-container" style="display: ${savedHP?.method === 'roll' ? 'flex' : 'none'};">
                            <div class="hp-roll-animation">
                                <i class="fas fa-dice-d20"></i>
                            </div>
                            <div class="hp-roll-text">
                                ${savedHP?.method === 'roll' ? game.i18n.format('ORIGINATE.UI.Progression.HPRollResult', { roll: savedHP.rollResult ?? savedHP.hp - conMod, mod: conMod, total: savedHP.hp }) : ''}
                            </div>
                        </div>
                    </div>
                `;

                case 'features':
                    return `
                    <div class="progression-feature-group page-wrapper">
                        <div class="options-container features-granted-list">
                            ${step.items.map(f => `
                                <div class="option-card progression-feature-item" data-uuid="${f.uuid || ''}" data-originate-tooltip="${this._processHtmlDescription ? this._processHtmlDescription(f.description) : (this._cleanDescription ? this._cleanDescription(f.description) : '')}">
                                    <img src="${f.img || 'icons/svg/item-bag.svg'}" class="feature-icon">
                                    <div class="feature-info">
                                        <div class="feature-name">${f.name}</div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        <div class="selection-hint">${game.i18n.localize('ORIGINATE.UI.Progression.AutoAddHint')}</div>
                    </div>
                `;

                case 'asi_feat_choice':
                    // 检查之前的选择状态
                    const savedChoice = state.stepData[step.id];

                    // Adrian: 如果是纯 ASI（如专长内部的属性提升），直接显示 ASI 界面
                    // 不需要让用户选"属性提升"还是"专长"，因为没得选
                    if (step.asiOnly) {
                        if (!state.stepData[step.id]) state.stepData[step.id] = { type: 'asi' };
                    }

                    const showASI = savedChoice?.type === 'asi' || step.asiOnly;
                    const showFeat = savedChoice?.type === 'feat';
                    const showSelection = !showASI && !showFeat;

                    // 准备专长列表
                    // 使用 DataManager 获取所有专长
                    // 注意：getOptions 返回的是 Promise，需要 await
                    // 但 _renderStepContent 是 async 的，所以没问题
                    let eligibleFeats = [];

                    // Adrian: 收集已选择的专长（用于过滤和标记）。
                    // 可重复专长是 dnd5e 原生规则，不能被这个“已拥有”标记顺手锁死。
                    const selectedFeatNames = new Set();
                    const selectedFeatNameCounts = new Map();
                    const selectedFeatUuidCounts = new Map();
                    const addSelectedFeatMark = ({ name = null, uuid = null } = {}) => {
                        if (name) {
                            selectedFeatNames.add(name);
                            selectedFeatNameCounts.set(name, (selectedFeatNameCounts.get(name) || 0) + 1);
                        }
                        if (uuid) {
                            selectedFeatUuidCounts.set(uuid, (selectedFeatUuidCounts.get(uuid) || 0) + 1);
                        }
                    };

                    // 1. 从 blueprintData 收集已有的专长
                    // 翻遍你的口袋，看看里面已经有什么了
                    for (const stepType of ['race', 'class', 'background', 'subclass']) {
                        const stepData = this.blueprintData[stepType];
                        if (stepData?.items) {
                            stepData.items.forEach(item => {
                                // Adrian: 检查是否是当前步骤添加的
                                // 如果是当前步骤添加的，说明是用户刚才选的，不应该算作"已选择且不可更改"
                                // 这样用户返回上一步时，就可以重新选择或撤销
                                const origin = item.flags?.['hero-genesis']?.advancementOrigin;
                                if (origin === (step.advId || step.id)) return;

                                if (item?.type === 'feat') {
                                    const sourceUuid = resolveItemSourceUuid(item);
                                    addSelectedFeatMark({ name: item.name, uuid: sourceUuid || item.uuid });
                                }
                            });
                        }
                    }

                    // 2. 从升级流程中已选择的专长收集
                    // 别忘了你刚才在这一级选了什么
                    if (state.selectedFeats) {
                        state.selectedFeats.forEach(f => {
                            // Adrian: 如果这个专长是当前步骤选的，不要把它算作"已选择"（因为我们正在重新做这个选择）
                            if (f.sourceStepId === step.id) return;

                            addSelectedFeatMark({ name: f.name, uuid: f.uuid });
                        });
                    }

                    window.OriginateLog(`Originate | 已选择的专长: ${selectedFeatNames.size} 个`, Array.from(selectedFeatNames));

                    try {
                        if (!step.asiOnly) eligibleFeats = await this._prepareFeatOptions(state.currentLevel, selectedFeatNameCounts, selectedFeatUuidCounts);
                    } catch (e) {
                        console.error("Originate | 获取专长列表失败:", e);
                    }

                    const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                    const abilityLabels = {
                        str: game.i18n.localize('ORIGINATE.Ability.Str'),
                        dex: game.i18n.localize('ORIGINATE.Ability.Dex'),
                        con: game.i18n.localize('ORIGINATE.Ability.Con'),
                        int: game.i18n.localize('ORIGINATE.Ability.Int'),
                        wis: game.i18n.localize('ORIGINATE.Ability.Wis'),
                        cha: game.i18n.localize('ORIGINATE.Ability.Cha')
                    };

                    // 属性卡和右侧状态栏必须走同一套累计规则，不然玩家会看到两组不同的数值。
                    const getCurrentAbilityValue = ability => this._getCreationAbilityValue(ability);

                    // 计算调整值
                    const getAbilityModifier = (score) => Math.floor((score - 10) / 2);
                    const formatModifier = (mod) => mod >= 0 ? `+${mod}` : `${mod}`;

                    // 属性图标映射
                    const abilityIcons = {
                        str: 'fa-fist-raised',
                        dex: 'fa-running',
                        con: 'fa-heart',
                        int: 'fa-brain',
                        wis: 'fa-eye',
                        cha: 'fa-comments'
                    };

                    // 属性缩写映射
                    const abilityAbbrs = {
                        str: 'STR', dex: 'DEX', con: 'CON',
                        int: 'INT', wis: 'WIS', cha: 'CHA'
                    };

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
                        
                        <!-- ASI 界面 - 使用与初始属性界面相同的卡片式布局 -->
                        <div class="asi-content" style="display: ${showASI ? 'block' : 'none'}; width: 100%;">
                            ${!step.asiOnly ? `<button type="button" class="back-to-selection-btn" style="margin-bottom: 1rem;"><i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.ASI.BackToSelection')}</button>` : ''}
                            <div class="sub-section asi-section" data-type="asi" data-points="${step.points !== undefined ? step.points : (step.asiOnly ? 0 : 2)}" data-cap="${step.cap || 2}" data-locked="${Array.from(step.locked || []).join(',')}">
                                <div class="asi-header">
                                    <h3 class="asi-title">${game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}</h3>
                                    ${(step.points !== undefined ? step.points : (step.asiOnly ? 0 : 2)) > 0 ?
                            `<div class="asi-remaining">${game.i18n.localize('ORIGINATE.ASI.RemainingPoints')}: <span class="asi-points-remaining">${step.points !== undefined ? step.points : 2}</span></div>` :
                            `<div class="asi-remaining" style="color: #888;">${game.i18n.localize('ORIGINATE.UI.Fixed') || 'Fixed'}</div>`
                        }
                                </div>
                                <div class="abilities-grid asi-grid">
                                    ${abilities.map(ab => {
                            // Adrian: 考虑固定属性提升
                            const fixedValue = (step.fixed && step.fixed[ab]) || 0;
                            const currentValue = getCurrentAbilityValue(ab) + fixedValue;

                            const mod = getAbilityModifier(currentValue);
                            const modFormatted = formatModifier(mod);
                            const modClass = mod > 0 ? 'positive' : (mod < 0 ? 'negative' : 'neutral');
                            // Adrian: 修复 locked 可能是 Set 导致的 includes is not a function 错误
                            const isLocked = Array.from(step.locked || []).includes(ab);
                            const primaryAbilityClass = this._getPrimaryAbilityCardClass?.(ab) || '';
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
                                            <div class="ability-modifier ${modClass}" data-ability="${ab}">
                                                ${modFormatted}
                                            </div>
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
                                ${this._renderFeatSelection(eligibleFeats, state.currentLevel, savedChoice, step.id)}
                            </div>
                        </div>
                    </div>
                `;

                case 'item_choice':
                    return await this._renderItemChoice(step.event, state.currentLevel, step.stepType, step.id);

                case 'spell_choice':
                    return this._renderSpellChoice(step);

                case 'spell_replacement':
                    // 法术替换：创建时通常不需要（没有已有法术可替换）
                    // 实际由 _renderSpellReplacement 处理（如果存在）
                    if (this._renderSpellReplacement) return this._renderSpellReplacement(step);
                    return `<div class="progression-feature-group page-wrapper"><h4><i class="fas fa-exchange-alt"></i> ${step.title}</h4><p style="text-align:center;color:#888;padding:2rem;">${game.i18n.localize('ORIGINATE.SpellRules.NoReplacementOnCreate')}</p></div>`;

                case 'prepared_spell_grant':
                    return await this._renderPreparedSpellGrant(step);

                case 'trait_choice':
                    return this._renderTraitChoice(step.event, state.currentLevel, step.stepType, step.id);

                default:
                    return `<p>${game.i18n.format('ORIGINATE.UI.Error.UnknownStepType', { type: step.type })}</p>`;
            }
        }

        // _renderPreparedSpellGrant → 由 WizardUIMixin 提供

        /**
         * 绑定升级向导事件
         */
        _bindProgressionEvents(overlay, step) {
            const state = this._progressionState;

            // 导航按钮
            const nextBtn = overlay.querySelector('#progression-next-btn');
            const prevBtn = overlay.querySelector('#progression-prev-btn');

            if (nextBtn) nextBtn.addEventListener('click', () => this._runProgressionNavAction('next', () => this._onProgressionNext()));
            if (prevBtn) prevBtn.addEventListener('click', () => this._runProgressionNavAction('prev', () => this._onProgressionPrev()));

            // 步骤特定事件
            if (step.type === 'hp') {
                overlay.querySelectorAll('.hp-option-card').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const currentChoice = state.hpGains[state.currentLevel - 1];
                        if (isHitPointRollLocked(currentChoice) || state.hpRollInProgress) return;

                        const method = btn.dataset.method;
                        const hitDie = state.hitDie;
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
                                level: state.currentLevel,
                                hitDie,
                                constitutionModifier: conMod
                            });
                            if (!result.changed) return;

                            const choice = result.choice;
                            state.hpGains[state.currentLevel - 1] = choice;

                            overlay.querySelectorAll('.hp-option-card').forEach(card => {
                                card.classList.toggle('selected', card.dataset.method === choice.method);
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
                                overlay.querySelectorAll('.hp-option-card').forEach(card => card.setAttribute('aria-disabled', 'true'));
                                result.roll?.toMessage({
                                    speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                                    flavor: game.i18n.format('ORIGINATE.UI.Progression.ClassLevelHPRoll', { className: this.context.className, level: state.currentLevel })
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

                        // 切换界面
                        overlay.querySelector('.asi-feat-selection').style.display = 'none';
                        if (type === 'asi') {
                            overlay.querySelector('.asi-content').style.display = 'block';
                        } else {
                            overlay.querySelector('.feat-content').style.display = 'block';
                        }

                        // 记录选择类型
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

                        // 清除选择类型
                        if (state.stepData[step.id]) state.stepData[step.id].type = null;

                        this._checkProgressionCanProceed(overlay);
                    });
                });

                // ASI 控制 - 使用专门的升级流程版本
                // Adrian: 这里不能用 UIMixin 的 _bindASIControls，因为那个不会触发 _checkProgressionCanProceed
                this._bindProgressionASIControls(overlay, step);
                this._bindFeatSearch(overlay);

                // 专长选择
                overlay.querySelector('.feat-content')?.addEventListener('change', event => {
                    const input = event.target;
                    if (!input.matches('input[name^="feat-choice-"]') || input.disabled) return;
                    if (!state.stepData[step.id]) state.stepData[step.id] = {};
                    state.stepData[step.id].uuid = input.dataset.uuid;
                    this._checkProgressionCanProceed(overlay);
                });
            } else if (step.type === 'item_choice') {
                this._bindProgressionItemChoices(overlay, step);
            } else if (step.type === 'spell_choice') {
                this._bindSpellBrowserEvents(overlay, step);
            } else if (step.type === 'spell_replacement') {
                if (this._bindSpellReplacementEvents) this._bindSpellReplacementEvents(overlay, step);
            } else if (step.type === 'prepared_spell_grant') {
                // 准备型法表自动获得，无需用户交互，直接标记完成
                this._currentStepComplete = true;
            } else if (step.type === 'trait_choice') {
                this._bindProgressionTraitChoices(overlay, step);
            }
        }

        // _bindProgressionASIControls → 由 WizardUIMixin 提供

        /**
         * 检查是否可以进入下一步
         * 
         * Adrian: 这个方法是升级流程的"门卫"。
         * 它会检查你当前步骤是否完成，然后决定是否放你过去。
         * 以前我会直接把按钮禁用掉，但现在我学聪明了——
         * 按钮永远亮着，但如果你没选完就点，我会弹窗问你是不是真的想跳过。
         * 毕竟，有些人就是喜欢裸奔，我管不着。
         */
        _checkProgressionCanProceed(overlay) {
            const state = this._progressionState;
            const currentStep = state.steps[state.currentStepIndex];
            const nextBtn = overlay.querySelector('#progression-next-btn');

            // Adrian: 如果连步骤都没有，那就别玩了
            if (!currentStep || !nextBtn) {
                this._currentStepComplete = false;
                return;
            }

            let canProceed = false;

            switch (currentStep.type) {
                case 'hp':
                    canProceed = state.hpGains[state.currentLevel - 1] !== undefined;
                    break;

                case 'features':
                    // 自动获得，总是可以继续
                    canProceed = true;
                    break;

                case 'asi_feat_choice':
                    const choiceData = state.stepData[currentStep.id];
                    if (choiceData?.type === 'asi') {
                        // 检查 ASI 点数是否用完
                        const asiSection = overlay.querySelector('.asi-section');
                        if (asiSection) {
                            // Adrian: 这里的 points 可能是 1 (专长) 也可能是 2 (职业)
                            // 必须从 dataset 读取，不能想当然
                            const maxPoints = parseInt(asiSection.dataset.points);
                            let usedPoints = 0;
                            asiSection.querySelectorAll('.asi-value').forEach(span => {
                                usedPoints += parseInt(span.textContent) || 0;
                            });
                            canProceed = usedPoints === maxPoints;
                        }
                    } else if (choiceData?.type === 'feat') {
                        // 检查是否选择了专长
                        canProceed = this._isFeatDraftAvailable(currentStep.id, choiceData.uuid);
                        // Adrian: 如果选了专长，就不需要检查 ASI 点数了
                        // 专长本身就是一种选择，选了它就等于完成了这一步
                    } else {
                        // 尚未选择类型
                        canProceed = false;
                    }
                    break;

                case 'item_choice':
                    const section = overlay.querySelector('.item-choice-section');
                    if (section) {
                        // Adrian: 检查是否是纯替换模式
                        const isPureReplacement = section.dataset.pureReplacement === 'true';

                        if (isPureReplacement) {
                            const modeRadio = section.querySelector('input[name^="replacement-mode-"]:checked');
                            const mode = modeRadio ? modeRadio.value : 'none';

                            if (mode === 'none') {
                                // 选择不替换，直接通过
                                canProceed = true;
                            } else {
                                // 选择替换，必须同时选中旧物品和新物品
                                const replaceTarget = section.querySelector('input[name^="replace-target-"]:checked');
                                const newItem = section.querySelector('input[name^="item-choice-"]:checked');
                                canProceed = !!replaceTarget && !!newItem;
                            }
                        } else {
                            const max = parseInt(section.dataset.count);
                            const checked = section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked').length;

                            // 检查是否开启了替换
                            const replacementToggle = section.querySelector('.enable-replacement');
                            const isReplacing = replacementToggle?.checked || false;

                            let required = max;
                            if (isReplacing) {
                                required += 1; // 额外选一个
                                const replaceTarget = section.querySelector('input[name^="replace-target-"]:checked');
                                if (!replaceTarget) {
                                    canProceed = false;
                                    break;
                                }
                            }

                            canProceed = checked === required;
                        }
                    }
                    break;

                case 'trait_choice':
                    const traitSection = overlay.querySelector('.trait-choice-section');
                    if (traitSection) {
                        const max = parseInt(traitSection.dataset.count);
                        const checked = traitSection.querySelectorAll('.skill-chips-container input[type="checkbox"]:checked').length;
                        canProceed = checked === max;
                    }
                    break;

                case 'spell_choice':
                    const spellSection = overlay.querySelector('.spell-browser-section');
                    if (spellSection) {
                        const max = parseInt(spellSection.dataset.count) || 1;
                        const selected = spellSection.querySelectorAll('.selected-spells-list .spell-card').length;
                        canProceed = selected >= max;
                    }
                    break;

                case 'prepared_spell_grant':
                    // 准备型法表自动获得，始终可以继续
                    canProceed = true;
                    break;

                case 'spell_replacement':
                    // 法术替换是可选的，始终可以继续
                    canProceed = true;
                    break;
            }

            // Adrian: 以前我会在这里把按钮禁用掉，防止你们手滑。
            // 但现在，我把选择权交给你们。按钮永远是亮的，但如果你没选完就点，我会弹窗警告你。
            // 别说我没给过你机会。
            nextBtn.disabled = false;

            // 记录当前步骤是否完成，供下一步点击时检查
            this._currentStepComplete = canProceed;
        }

        /**
         * 加载指定等级的特性并构建步骤
         */
        async _loadLevelFeatures(level) {
            try {
                // 【修复】确保 classIdentifier 在处理特性之前被正确设置
                // Adrian: 这是为了解决高等级角色创建时，特性被错误归类到"其他特性"的问题
                // 如果 classIdentifier 没设置好，_applyFeatureType 就不知道该把特性往哪儿放
                if (!this.context.classIdentifier) {
                    // 1. 尝试从 blueprintData.class.items 中的职业物品获取
                    const classItem = this.blueprintData.class?.items?.find(i => i.type === 'class');
                    if (classItem?.system?.identifier) {
                        this.context.classIdentifier = classItem.system.identifier;
                        window.OriginateLog(`Originate | _loadLevelFeatures: 从 classItem 设置 classIdentifier: ${this.context.classIdentifier}`);
                    }
                    // 2. 尝试从 progressionState.classUuid 获取文档
                    else if (this._progressionState?.classUuid) {
                        try {
                            const doc = await this.dataManager.getDocument(this._progressionState.classUuid);
                            if (doc?.system?.identifier) {
                                this.context.classIdentifier = doc.system.identifier;
                                window.OriginateLog(`Originate | _loadLevelFeatures: 从 classUuid 文档设置 classIdentifier: ${this.context.classIdentifier}`);
                            }
                        } catch (e) {
                            console.warn("Originate | _loadLevelFeatures: 获取职业文档失败:", e);
                        }
                    }
                    // 3. 尝试从配置获取
                    else if (this.context.class) {
                        const configData = game.settings.get('character-forge', 'data');
                        const classConfig = configData.classs?.[this.context.class];
                        if (classConfig?.identifier) {
                            this.context.classIdentifier = classConfig.identifier;
                            window.OriginateLog(`Originate | _loadLevelFeatures: 从配置设置 classIdentifier: ${this.context.classIdentifier}`);
                        }
                    }
                }

                // 检查是否需要触发子职选择
                // 获取子职选取等级
                const classOptions = await this.dataManager.getOptions('class');
                const selectedClass = classOptions.find(o => o.id === this.context.class);
                const subclassLevel = selectedClass?.subclassLevel ?? 3;

                // 如果当前等级 >= 子职获得等级，且尚未选择子职
                if (level >= subclassLevel && (!this.blueprintData.subclass?.items || this.blueprintData.subclass.items.length === 0)) {
                    window.OriginateLog(`Originate | Level ${level} >= 子职获得等级 ${subclassLevel}，且未选择子职，触发子职选择`);
                    await this._triggerSubclassSelection(level);
                    return; // 等待子职选择完成后再继续
                }

                // 获取所有板块的升级内容
                const upgrades = await this._getLevelUpgrades(level);
                window.OriginateLog(`Originate | Level ${level} upgrades:`, upgrades);

                // 为每个升级事件设置 sourceLevel
                const setSourceLevel = (events) => {
                    events.forEach(e => e.sourceLevel = level);
                };

                setSourceLevel(upgrades.class);
                setSourceLevel(upgrades.subclass);
                setSourceLevel(upgrades.race);
                setSourceLevel(upgrades.background);

                // 丰富事件数据
                if (upgrades.class.length > 0) await this.dataManager.enrichOptions(upgrades.class);
                if (upgrades.subclass.length > 0) await this.dataManager.enrichOptions(upgrades.subclass);
                if (upgrades.race.length > 0) await this.dataManager.enrichOptions(upgrades.race);
                if (upgrades.background.length > 0) await this.dataManager.enrichOptions(upgrades.background);

                // 构建步骤列表
                const steps = [];

                // 1. HP 提升 (总是第一步)
                steps.push({
                    id: 'hp',
                    type: 'hp',
                    title: game.i18n.localize('ORIGINATE.UI.Progression.HPTitle')
                });

                // 辅助函数：处理事件并添加到步骤
                const processEvents = async (events, stepType) => {
                    // 收集所有自动获得的特性
                    const grantedFeatures = [];

                    for (const event of events) {
                        if (event.type === 'features') {
                            const validItems = Array.isArray(event.items) ? event.items.filter(Boolean) : [];
                            if (validItems.length === 0) continue;

                            grantedFeatures.push(...validItems);

                            // 自动添加到 blueprint (保持原有逻辑)
                            for (const item of validItems) {
                                try {
                                    const doc = await this.dataManager.getDocument(item.uuid);
                                    if (doc) {
                                        const itemData = doc.toObject();
                                        // Adrian: 关键修复！toObject() 不会复制 uuid 属性，
                                        // 但 actor-writer 需要它来匹配 Advancement。
                                        itemData.uuid = item.uuid;

                                        // 【修复】使用 event.id 或 _original._id 作为 Advancement ID
                                        const advOrigin = event.id || event._original?._id || event.title;
                                        foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advOrigin);
                                        foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", level);
                                        this._stampCharacterFinalizeItemMeta(itemData, {
                                            sourceUuid: item.uuid,
                                            advancementId: advOrigin,
                                            level,
                                            stepType
                                        });

                                        // 法术/特性配置处理
                                        // 从 Advancement 的 spell 字段提取配置（可用于法术和特性）
                                        const spellConfig = event.spellConfig || event._original?.configuration?.spell;
                                        const spellSourceClass = this.context.classIdentifier
                                            || this.blueprintData.class?.items?.find(i => i.type === 'class')?.system?.identifier
                                            || null;

                                        // 调试日志：检查 spell 配置来源
                                        window.OriginateLog(`Originate | [DEBUG] 物品: ${itemData.name}, event._original?.configuration?.spell:`, event._original?.configuration?.spell);
                                        window.OriginateLog(`Originate | [DEBUG] spellConfig:`, spellConfig);

                                        const isSpell = doc.type === 'spell' || item.itemType === 'spell';

                                        if (spellConfig) {
                                            applySpellConfigToItemData(itemData, spellConfig, {
                                                sourceClass: isSpell ? (itemData.system?.sourceClass || spellSourceClass) : null
                                            });
                                        } else if (isSpell) {
                                            normalizeSpellItemData(itemData, { sourceClass: spellSourceClass });
                                        }

                                        // 特性类型处理
                                        if (this._applyFeatureType) this._applyFeatureType(itemData, stepType);

                                        // 添加到 blueprint
                                        if (stepType === 'class' || stepType === 'subclass') this.blueprintData.class.items.push(itemData);
                                        else if (stepType === 'race') this.blueprintData.race.items.push(itemData);
                                        else if (stepType === 'background') this.blueprintData.background.items.push(itemData);

                                        // Adrian: 检查特性内部是否有需要选择的 Advancement
                                        // 就像俄罗斯套娃，打开一个特性，里面可能还藏着更多选择
                                        // 比如"技艺专家"专长，选了它还得选技能专精，没完没了
                                        if (hasAdvancementEntries(doc.system?.advancement)) {
                                            window.OriginateLog(`Originate | 检查特性 "${doc.name}" 的嵌套 Advancement (${getAdvancementCount(doc.system.advancement)} 个)。套娃警告。`);

                                            // 获取该特性在当前等级的 Advancement
                                            const nestedEvents = await this.dataManager.getLevelAdvancement(item.uuid, level);

                                            // 如果没有当前等级的，尝试获取 Level 0 和 Level 1 的
                                            let allNestedEvents = nestedEvents;
                                            if (nestedEvents.length === 0) {
                                                const level0Events = await this.dataManager.getLevelAdvancement(item.uuid, 0);
                                                const level1Events = await this.dataManager.getLevelAdvancement(item.uuid, 1);
                                                allNestedEvents = [...level0Events, ...level1Events];
                                            }

                                            if (allNestedEvents.length > 0) {
                                                // 丰富事件数据
                                                await this.dataManager.enrichOptions(allNestedEvents);

                                                // 处理嵌套事件
                                                for (const nestedEvent of allNestedEvents) {
                                                    // 设置来源信息
                                                    nestedEvent.sourceLevel = level;
                                                    nestedEvent.parentFeature = doc.name;
                                                    nestedEvent.parentSourceUuid = this._getFinalBlueprintSourceUuid(itemData) || item.uuid || null;

                                                    if (nestedEvent.type === 'trait_choice') {
                                                        // 特质选择（如工具熟练）
                                                        const advId = nestedEvent._original?._id || nestedEvent.id || nestedEvent.title;
                                                        window.OriginateLog(`Originate | 发现嵌套特质选择: ${doc.name} -> ${nestedEvent.title}`);
                                                        steps.push({
                                                            id: `nested-trait-${advId}-${level}`,
                                                            type: 'trait_choice',
                                                            title: `${doc.name}: ${nestedEvent.title}`,
                                                            event: nestedEvent,
                                                            stepType: stepType,
                                                            parentFeature: doc.name,
                                                            parentSourceUuid: nestedEvent.parentSourceUuid
                                                        });
                                                    } else if (nestedEvent.type === 'choice') {
                                                        // 物品选择
                                                        const advId = nestedEvent._original?._id || nestedEvent.id || nestedEvent.title;
                                                        window.OriginateLog(`Originate | 发现嵌套物品选择: ${doc.name} -> ${nestedEvent.title}`);
                                                        steps.push({
                                                            id: `nested-choice-${advId}-${level}`,
                                                            type: usesSpellBrowser(nestedEvent) ? 'spell_choice' : 'item_choice',
                                                            title: `${doc.name}: ${nestedEvent.title}`,
                                                            event: nestedEvent,
                                                            stepType: stepType,
                                                            parentFeature: doc.name,
                                                            parentSourceUuid: nestedEvent.parentSourceUuid
                                                        });
                                                    } else if (nestedEvent.type === 'asi') {
                                                        // ASI 选择
                                                        window.OriginateLog(`Originate | 发现嵌套 ASI: ${doc.name} -> ${nestedEvent.title}`);
                                                        steps.push({
                                                            id: `nested-asi-${level}`,
                                                            type: 'asi_feat_choice',
                                                            title: `${doc.name}: ${nestedEvent.title || game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}`,
                                                            points: nestedEvent.points,
                                                            cap: nestedEvent.cap,
                                                            // Adrian: 确保 locked 是数组
                                                            locked: Array.from(nestedEvent.locked || []),
                                                            stepType: stepType,
                                                            parentFeature: doc.name,
                                                            parentSourceUuid: nestedEvent.parentSourceUuid,
                                                            advId: nestedEvent.id || nestedEvent._original?._id // Adrian: 保存原始 ID
                                                        });
                                                    } else if (nestedEvent.type === 'trait_grant') {
                                                        // 自动获得的特质，直接应用
                                                        if (nestedEvent.grants) {
                                                            const targetBlueprint = this.blueprintData[stepType] || this.blueprintData.class;
                                                            if (!targetBlueprint.system) targetBlueprint.system = {};
                                                            nestedEvent.grants.forEach(key => {
                                                                if (this._applyTraitToUpdate) {
                                                                    this._applyTraitToUpdate(key, targetBlueprint.system);
                                                                }
                                                            });
                                                            window.OriginateLog(`Originate | 应用嵌套固定特质: ${doc.name} -> ${Array.from(nestedEvent.grants).join(', ')}`);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error(`Originate | 添加特性失败: ${item.uuid}`, e);
                                }
                            }
                        } else if (event.type === 'asi') {
                            // ASI/专长选择作为单独步骤
                            steps.push({
                                id: `asi-${level}`,
                                type: 'asi_feat_choice',
                                title: event.title || game.i18n.localize('ORIGINATE.UI.Progression.ASIFeatTitle'),
                                points: event.points,
                                cap: event.cap,
                                stepType: stepType,
                                advId: event.id || event._original?._id // Adrian: 保存原始 Advancement ID
                            });
                        } else if (event.type === 'choice') {
                            // 物品选择作为单独步骤
                            // 使用 _original._id 作为 ID 的一部分，确保唯一性且可追溯
                            const advId = event._original?._id || event.id || event.title;

                            // 跳过原生法术 Advancement（由 SpellRules 接管）
                            if (SpellRules.managesChoice(event, {
                                classIdentifier: this.context.classIdentifier,
                                subclassIdentifier: this.blueprintData.subclass?.items?.find(i => i.type === 'subclass')?.system?.identifier
                            })) {
                                window.OriginateLog(`Originate | 跳过基础法术 Advancement: ${event.title} (由 SpellRules 管理)`);
                                continue;
                            }

                            // Adrian: 检测是否为法术选择
                            const isSpellChoice = usesSpellBrowser(event);

                            if (isSpellChoice) {
                                window.OriginateLog(`Originate | 发现法术选择步骤: ${event.title}`);
                                if (!event.restriction && event._original?.configuration?.spell) {
                                    event.restriction = event._original.configuration.spell;
                                }
                                steps.push({
                                    id: `spell-choice-${advId}-${level}`,
                                    type: 'spell_choice',
                                    title: event.title,
                                    event: event,
                                    stepType: stepType
                                });
                            } else {
                                steps.push({
                                    id: `choice-${advId}-${level}`,
                                    type: 'item_choice',
                                    title: event.title,
                                    event: event,
                                    stepType: stepType
                                });
                            }
                        } else if (event.type === 'trait_choice') {
                            // 特质选择（如技能熟练、专精）作为单独步骤
                            const advId = event._original?._id || event.id || event.title;
                            steps.push({
                                id: `trait-${advId}-${level}`,
                                type: 'trait_choice',
                                title: event.title,
                                event: event,
                                stepType: stepType
                            });
                        }
                    }

                    // 如果有自动获得的特性，添加一个展示步骤
                    if (grantedFeatures.length > 0) {
                        // 检查是否已经有 features 步骤，如果有则合并，否则新建
                        // 这里我们选择每个来源（职业、子职等）单独展示，或者合并展示
                        // 为了简洁，我们合并所有自动获得的特性到一个步骤中
                        // 但由于 processEvents 是按顺序调用的，我们需要在外部处理合并
                        return grantedFeatures;
                    }
                    return [];
                };

                const allGrantedFeatures = [];

                // 按顺序处理
                if (upgrades.class.length > 0) allGrantedFeatures.push(...await processEvents(upgrades.class, 'class'));
                if (upgrades.subclass.length > 0) allGrantedFeatures.push(...await processEvents(upgrades.subclass, 'subclass'));
                if (upgrades.race.length > 0) allGrantedFeatures.push(...await processEvents(upgrades.race, 'race'));
                if (upgrades.background.length > 0) allGrantedFeatures.push(...await processEvents(upgrades.background, 'background'));
                await this._appendExistingNestedFeatureSteps(level, steps);

                // 如果有自动获得的特性，插入到 HP 之后
                if (allGrantedFeatures.length > 0) {
                    steps.splice(1, 0, {
                        id: 'features',
                        type: 'features',
                        title: game.i18n.localize('ORIGINATE.UI.Progression.FeaturesTitle'),
                        items: allGrantedFeatures
                    });
                }

                // ========== SpellRules: 生成法术选择步骤 ==========
                {
                    // 确保 classIdentifier 可用（level 1 时可能尚未设置）
                    let spellRulesId = this.context.classIdentifier;
                    if (!spellRulesId && this._progressionState?.classUuid) {
                        try {
                            const doc = await this.dataManager.getDocument(this._progressionState.classUuid);
                            if (doc?.system?.identifier) {
                                spellRulesId = doc.system.identifier;
                                this.context.classIdentifier = spellRulesId;
                                window.OriginateLog(`Originate | [Creation] SpellRules: 从 classUuid 获取 classIdentifier: ${spellRulesId}`);
                            }
                        } catch (e) { /* 静默 */ }
                    }
                    // 主职无规则时，回退到子职（如奥法骑士）
                    if (spellRulesId && !SpellRules.getRules(spellRulesId)) {
                        const subclassItem = this.blueprintData.subclass?.items?.find(i => i.type === 'subclass');
                        const subId = subclassItem?.system?.identifier;
                        if (subId && SpellRules.getRules(subId)) {
                            window.OriginateLog(`Originate | [Creation] 主职 "${spellRulesId}" 无法术规则，使用子职 "${subId}"`);
                            spellRulesId = subId;
                        }
                    }
                    if (spellRulesId && SpellRules.getRules(spellRulesId)) {
                        const fromLevel = level - 1;
                        const spellSteps = SpellRules.generateSpellSteps(spellRulesId, fromLevel, level, {
                            stepType: 'class', nativeChoices: [...upgrades.class, ...upgrades.subclass]
                        })
                            .filter(s => s.type !== 'spell_replacement'); // 创建角色时无需替换
                        if (spellSteps.length > 0) {
                            window.OriginateLog(`Originate | [Creation] SpellRules 为 ${spellRulesId} 生成了 ${spellSteps.length} 个法术步骤:`, spellSteps.map(s => s.title));
                            steps.push(...spellSteps);
                        }
                    }
                }

                // 更新状态并渲染
                this._progressionState.steps = steps;
                this._progressionState.currentStepIndex = 0;
                this._progressionState.stepData = {}; // 重置步骤数据
                this._progressionState.stepHistory = {}; // 新等级重新记账，别把上一级的回退快照带过来

                // Adrian: 进入新等级时，重置"步骤完成"标记
                // 不然上一级的完成状态会被带到这一级，导致用户可以直接跳过
                this._currentStepComplete = false;

                await this._renderCurrentStep();

            } catch (error) {
                console.error(`Originate | Failed to load level ${level} features:`, error);
                const container = this.element?.querySelector('.originate-progression-wizard');
                if (container) container.innerHTML = '<div class="sub-interface-content"><p>加载特性失败。</p></div>';
            }
        }

        // _bindProgressionItemChoices → 由 WizardUIMixin 提供

        // _renderASIOrFeatChoice → 由 WizardUIMixin 提供

        /**
         * 处理创角 progression 的下一步。
         * 这里收集的是 blueprint 草稿；最后一步只能进入创角最终提交，不能转去 LevelUpApp 的写入链。
         */
        async _onProgressionNext() {
            // Adrian: 播放点击音效，给用户一点反馈
            if (this._playSound) {
                this._playSound('CLICK');
            }

            const state = this._progressionState;

            if (!state || !state.steps || state.steps.length === 0) {
                console.error("Originate | _onProgressionNext: 无效的创角 progression 状态");
                return;
            }

            const currentStep = state.steps[state.currentStepIndex];
            const overlay = this.element?.querySelector('.originate-progression-wizard');

            if (!overlay) {
                console.error("Originate | _onProgressionNext: 找不到创角 progression overlay");
                return;
            }

            if (this._removeExcludedSpellSelections(currentStep, overlay)) return;
            if (!await this._validateSpellSchoolDraft(currentStep, overlay)) return;

            // 检查是否完成当前步骤
            if (!this._currentStepComplete) {
                // ... (省略确认对话框代码，保持不变)
                // 检查 _showConfirmDialog 方法是否存在
                if (typeof this._showConfirmDialog !== 'function') {
                    console.error("Originate | _showConfirmDialog 方法不存在，回退到原生 Dialog");
                    const confirmed = await Dialog.confirm({
                        title: game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmTitle") || "确认继续",
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmContent") || "您尚未完成当前步骤的选择。"}</p><p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmWarning") || "确定要继续吗？这可能会导致角色数据不完整。"}</p>`,
                        yes: () => true,
                        no: () => false,
                        defaultYes: false
                    });
                    if (!confirmed) return;
                } else {
                    const confirmed = await this._showConfirmDialog({
                        title: game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmTitle") || "确认继续",
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmContent") || "您尚未完成当前步骤的选择。"}</p><p>${game.i18n.localize("ORIGINATE.UI.Progression.SkipConfirmWarning") || "确定要继续吗？这可能会导致角色数据不完整。"}</p>`,
                        yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm") || "是",
                        noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel") || "否",
                        defaultYes: false
                    });

                    if (!confirmed) return;
                }
            }

            // Adrian: 关键修复！在保存新数据之前，先回滚该步骤可能存在的旧数据。
            // 防止用户反复点击下一步导致数据重复叠加。
            const currentDraft = this._syncStepDraftFromOverlay(currentStep, overlay);
            this._rollbackStep(currentStep.id);
            if (currentStep?.id && currentDraft) {
                if (!state.stepData) state.stepData = {};
                state.stepData[currentStep.id] = currentDraft;
            }

            // 初始化当前步骤的 history
            if (!state.stepHistory) state.stepHistory = {};
            state.stepHistory[currentStep.id] = {
                blueprints: {
                    race: foundry.utils.deepClone(this.blueprintData.race || { items: [], system: {} }),
                    class: foundry.utils.deepClone(this.blueprintData.class || { items: [], system: {} }),
                    background: foundry.utils.deepClone(this.blueprintData.background || { items: [], system: {} }),
                    subclass: foundry.utils.deepClone(this.blueprintData.subclass || { items: [], system: {} })
                },
                pendingExpertiseSnapshot: foundry.utils.deepClone(this.blueprintData.pendingExpertise || []),
                hpGainsSnapshot: foundry.utils.deepClone(state.hpGains || []),
                selectedFeatsSnapshot: foundry.utils.deepClone(state.selectedFeats || []),
                stepDataSnapshot: foundry.utils.deepClone(state.stepData || {}),
                characterFinalizeSnapshot: foundry.utils.deepClone(this.context.characterFinalizeResolution || null),
                stepsSnapshot: state.steps.slice(),
                items: [], // 记录添加的物品 UUID
                asi: {},   // 记录修改的属性值 { key: delta }
                feats: []  // 记录 selectedFeats 中的条目
            };
            const history = state.stepHistory[currentStep.id];

            // 处理当前步骤的数据保存
            if (currentStep.type === 'asi_feat_choice') {
                const choiceData = state.stepData[currentStep.id];

                if (choiceData.type === 'asi') {
                    // 收集 ASI 分配
                    const asiSection = overlay.querySelector('.asi-section');
                    asiSection.querySelectorAll('.asi-value').forEach(span => {
                        const ability = span.dataset.ability;
                        const addedValue = parseInt(span.textContent) || 0;
                        if (addedValue > 0) {
                            const key = `abilities.${ability}.value`;
                            const currentValue = this.blueprintData.class.system[key] ||
                                this.actor.system.abilities[ability]?.value || 10;
                            this.blueprintData.class.system[key] = currentValue + addedValue;

                            // 记录 history
                            history.asi[key] = (history.asi[key] || 0) + addedValue;

                            window.OriginateLog(`Originate | ASI Level ${state.currentLevel}: ${ability} +${addedValue}`);
                        }
                    });

                    // 应用固定属性加成（如巨武器大师 +1 STR）
                    if (currentStep.fixed && typeof currentStep.fixed === 'object') {
                        for (const [ability, fixedValue] of Object.entries(currentStep.fixed)) {
                            if (fixedValue > 0) {
                                const key = `abilities.${ability}.value`;
                                const currentValue = this.blueprintData.class.system[key] ||
                                    this.actor.system.abilities[ability]?.value || 10;
                                this.blueprintData.class.system[key] = currentValue + fixedValue;

                                history.asi[key] = (history.asi[key] || 0) + fixedValue;

                                window.OriginateLog(`Originate | 固定 ASI Level ${state.currentLevel}: ${ability} +${fixedValue} (from ${currentStep.title})`);
                            }
                        }
                    }
                } else if (choiceData.type === 'feat') {
                    // 收集专长选择
                    const featUuid = choiceData.uuid;
                    if (featUuid) {
                        const doc = await this.dataManager.getDocument(featUuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            const origin = currentStep.advId || currentStep.id;
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", origin);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", state.currentLevel);
                            itemData.uuid = featUuid;
                            this._stampCharacterFinalizeItemMeta(itemData, {
                                sourceUuid: featUuid,
                                advancementId: origin,
                                level: state.currentLevel,
                                stepType: currentStep.stepType || 'class',
                                parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                                parentSourceUuid: currentStep.parentSourceUuid || null
                            });

                            this.blueprintData.class.items.push(itemData);

                            // 记录 history
                            history.items.push(itemData.uuid); // 注意：这里记录的是原始 UUID，可能不够唯一，但在 blueprint 中我们通常用 uuid 匹配

                            const featRecord = {
                                level: state.currentLevel,
                                uuid: featUuid,
                                name: doc.name,
                                sourceStepId: currentStep.id
                            };
                            state.selectedFeats.push(featRecord);
                            history.feats.push(featRecord); // 记录以便回滚

                            window.OriginateLog(`Originate | Feat Level ${state.currentLevel}: ${doc.name}`);

                            // 检查嵌套 Advancement
                            const nestedSteps = await this._checkNestedAdvancements(itemData, 'class');
                            if (nestedSteps.length > 0) {
                                window.OriginateLog(`Originate | 专长 "${doc.name}" 包含 ${nestedSteps.length} 个嵌套步骤，插入到升级流程`);
                                this._insertNestedSteps(nestedSteps);
                            }
                        }
                    }
                }
            } else if (currentStep.type === 'item_choice') {
                // 收集物品选择
                const section = overlay.querySelector('.item-choice-section');
                const advId = section.dataset.advId;
                const stepType = section.dataset.stepType || 'class';

                // 检查是否启用了替换
                const replacementToggle = section.querySelector('.enable-replacement');
                const isReplacing = replacementToggle?.checked || false;

                if (isReplacing) {
                    // 处理替换逻辑
                    const replaceTargetRadio = section.querySelector('input[name^="replace-target-"]:checked');
                    const newItemCheckbox = section.querySelector('.item-choices-list input[type="checkbox"]:checked');

                    if (replaceTargetRadio && newItemCheckbox) {
                        const oldItemId = replaceTargetRadio.value;
                        const newItemUuid = newItemCheckbox.value;

                        // 从 blueprint 中移除旧物品
                        const oldItemIndex = this.blueprintData.class.items.findIndex(i =>
                            (i._id === oldItemId) || (i.uuid === oldItemId) || (resolveItemSourceUuid(i) === oldItemId)
                        );

                        if (oldItemIndex !== -1) {
                            const removedItem = this.blueprintData.class.items.splice(oldItemIndex, 1)[0];
                            window.OriginateLog(`Originate | 替换 - 移除旧物品: ${removedItem.name}`);
                            // TODO: 记录移除的物品以便回滚？这比较复杂，暂时略过，假设用户不会反复替换同一个
                        }

                        // 添加新物品
                        const newDoc = await this.dataManager.getDocument(newItemUuid);
                        if (newDoc) {
                            const itemData = newDoc.toObject();
                            itemData.uuid = newItemUuid;
                            // 【修复】确保使用正确的 Advancement ID
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advId);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.replacedAt", state.currentLevel);
                            this._stampCharacterFinalizeItemMeta(itemData, {
                                sourceUuid: newItemUuid,
                                advancementId: advId,
                                level: state.currentLevel,
                                stepType,
                                parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                                parentSourceUuid: currentStep.parentSourceUuid || null
                            });
                            this.blueprintData.class.items.push(itemData);

                            history.items.push(itemData.uuid);

                            window.OriginateLog(`Originate | 替换 - 添加新物品: ${newDoc.name} (Level ${state.currentLevel})`);

                            // 检查嵌套 Advancement
                            const nestedSteps = await this._checkNestedAdvancements(itemData, stepType);
                            if (nestedSteps.length > 0) {
                                this._insertNestedSteps(nestedSteps);
                            }
                        }
                    }
                }

                // Adrian: 检查是否是纯替换模式
                const isPureReplacement = section.dataset.pureReplacement === 'true';

                if (isPureReplacement) {
                    const modeRadio = section.querySelector('input[name^="replacement-mode-"]:checked');
                    const mode = modeRadio ? modeRadio.value : 'none';

                    if (mode === 'replace') {
                        // 处理纯替换逻辑
                        const replaceTargetRadio = section.querySelector('input[name^="replace-target-"]:checked');
                        const newItemRadio = section.querySelector('input[name^="item-choice-"]:checked');

                        if (replaceTargetRadio && newItemRadio) {
                            const oldItemId = replaceTargetRadio.value;
                            const newItemUuid = newItemRadio.value;

                            // 从 blueprint 中移除旧物品
                            const oldItemIndex = this.blueprintData.class.items.findIndex(i =>
                                (i._id === oldItemId) || (i.uuid === oldItemId) || (resolveItemSourceUuid(i) === oldItemId)
                            );

                            if (oldItemIndex !== -1) {
                                const removedItem = this.blueprintData.class.items.splice(oldItemIndex, 1)[0];
                                window.OriginateLog(`Originate | 纯替换 - 移除旧物品: ${removedItem.name}`);
                            }

                            // 添加新物品
                            const newDoc = await this.dataManager.getDocument(newItemUuid);
                            if (newDoc) {
                                const itemData = newDoc.toObject();
                                itemData.uuid = newItemUuid;
                                // 【修复】确保使用正确的 Advancement ID
                                foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advId);
                                foundry.utils.setProperty(itemData, "flags.hero-genesis.replacedAt", state.currentLevel);
                                this._stampCharacterFinalizeItemMeta(itemData, {
                                    sourceUuid: newItemUuid,
                                    advancementId: advId,
                                    level: state.currentLevel,
                                    stepType,
                                    parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                                    parentSourceUuid: currentStep.parentSourceUuid || null
                                });
                                this.blueprintData.class.items.push(itemData);

                                history.items.push(itemData.uuid);

                                window.OriginateLog(`Originate | 纯替换 - 添加新物品: ${newDoc.name} (Level ${state.currentLevel})`);

                                // 检查嵌套 Advancement
                                const nestedSteps = await this._checkNestedAdvancements(itemData, stepType);
                                if (nestedSteps.length > 0) {
                                    this._insertNestedSteps(nestedSteps);
                                }
                            }
                        }
                    }
                } else {
                    // 处理正常的物品选择
                    const checked = section.querySelectorAll('.item-choices-list input[type="checkbox"]:checked');
                    const max = parseInt(section.dataset.count) || 0;
                    let addedCount = 0;

                    for (const cb of checked) {
                        if (isReplacing && addedCount === 0) {
                            addedCount++;
                            continue;
                        }
                        if (addedCount >= max && !isReplacing) break;

                        const uuid = cb.value;
                        const doc = await this.dataManager.getDocument(uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            itemData.uuid = uuid;
                            // 【修复】确保使用正确的 Advancement ID
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advId);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", state.currentLevel);
                            this._stampCharacterFinalizeItemMeta(itemData, {
                                sourceUuid: uuid,
                                advancementId: advId,
                                level: state.currentLevel,
                                stepType,
                                parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                                parentSourceUuid: currentStep.parentSourceUuid || null
                            });

                            if (itemData.type === 'spell') {
                                normalizeSpellItemData(itemData, {
                                    sourceUuid: uuid,
                                    sourceClass: currentStep.classIdentifier || this.context.classIdentifier || null
                                });
                            }

                            if (this._applyFeatureType) this._applyFeatureType(itemData, stepType);

                            if (stepType === 'class' || stepType === 'subclass') this.blueprintData.class.items.push(itemData);
                            else if (stepType === 'race') this.blueprintData.race.items.push(itemData);
                            else if (stepType === 'background') this.blueprintData.background.items.push(itemData);
                            else this.blueprintData.class.items.push(itemData);

                            history.items.push(itemData.uuid);

                            // 检查嵌套 Advancement
                            const nestedSteps = await this._checkNestedAdvancements(itemData, stepType);
                            if (nestedSteps.length > 0) {
                                this._insertNestedSteps(nestedSteps);
                            }

                            addedCount++;
                        }
                    }
                }
            } else if (currentStep.type === 'spell_choice') {
                // 收集法术选择
                const section = overlay.querySelector('.spell-browser-section');
                const selectedUuids = [];
                section.querySelectorAll('.selected-spells-list .spell-card').forEach(card => {
                    if (card.dataset.uuid) selectedUuids.push(card.dataset.uuid);
                });

                if (selectedUuids.length > 0) {
                    const event = currentStep.event;
                    const stepType = currentStep.stepType || 'class';
                    const spellConfig = event.spellConfig || event._original?.configuration?.spell;
                    const advId = event._original?._id || event.id || event.title;

                    for (const uuid of selectedUuids) {
                        if (this.dataManager.isItemExcluded(uuid)) continue;
                        const doc = await this.dataManager.getDocument(uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            itemData.uuid = uuid;
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advId);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", state.currentLevel);
                            this._stampCharacterFinalizeItemMeta(itemData, {
                                sourceUuid: uuid,
                                advancementId: advId,
                                level: state.currentLevel,
                                stepType,
                                parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                                parentSourceUuid: currentStep.parentSourceUuid || null
                            });

                            // 设置法术来源职业（用于准备法术计数）
                            const spellSourceClass = currentStep.classIdentifier || this.context.classIdentifier;
                            if (spellSourceClass && itemData.type === 'spell') {
                                foundry.utils.setProperty(itemData, "system.sourceClass", spellSourceClass);
                            }

                            if (spellConfig) {
                                applySpellConfigToItemData(itemData, spellConfig, {
                                    sourceClass: spellSourceClass
                                });
                            } else {
                                normalizeSpellItemData(itemData, { sourceClass: spellSourceClass });
                            }

                            // 添加到 blueprint
                            if (stepType === 'class' || stepType === 'subclass') this.blueprintData.class.items.push(itemData);
                            else if (stepType === 'race') this.blueprintData.race.items.push(itemData);
                            else if (stepType === 'background') this.blueprintData.background.items.push(itemData);
                            else this.blueprintData.class.items.push(itemData);

                            history.items.push(itemData.uuid);
                            window.OriginateLog(`Originate | Added Spell Choice: ${itemData.name} (${itemData.uuid})`);
                        }
                    }
                }
            } else if (currentStep.type === 'prepared_spell_grant') {
                // ========== 准备型法术获得：加载法表法术并添加到 blueprint ==========
                try {
                    const classId = currentStep.classIdentifier;
                    const spellList = currentStep.list || [classId];
                    const maxLevel = currentStep.maxLevel || 9;
                    const minLevel = currentStep.minLevel || 1;
                    const stepType = currentStep.stepType || 'class';

                    await this.dataManager.loadSpellListSources();
                    const classSpellMap = await this.dataManager.getClassSpellMap();
                    const results = await this.dataManager.getSpellsByRestriction({ level: 'available' }, '', maxLevel);

                    const classSpells = results.filter(spell => {
                        const spellLevel = spell.system?.level ?? spell.level ?? 0;
                        if (spellLevel < minLevel) return false;
                        if (!classSpellMap || !(classSpellMap instanceof Map)) return true;
                        const spellClasses = getSpellClassesForSpell(classSpellMap, spell);
                        if (!spellClasses) return false;
                        return spellClassSetMatchesAny(spellClasses, spellList);
                    });

                    const targetItems = stepType === 'race'
                        ? this.blueprintData.race.items
                        : stepType === 'background'
                            ? this.blueprintData.background.items
                            : this.blueprintData.class.items;

                    const existingSpellByUuid = new Map();
                    const existingSpellByName = new Map();
                    ['class', 'race', 'background'].forEach(key => {
                        (this.blueprintData[key]?.items || []).forEach(item => {
                            if (item.type !== 'spell') return;
                            const sourceUuid = resolveItemSourceUuid(item);
                            const nameKey = item.name?.trim().toLowerCase();
                            if (sourceUuid && !existingSpellByUuid.has(sourceUuid)) existingSpellByUuid.set(sourceUuid, item);
                            if (nameKey && !existingSpellByName.has(nameKey)) existingSpellByName.set(nameKey, item);
                        });
                    });

                    let skippedCount = 0;
                    let addedCount = 0;

                    for (const spell of classSpells) {
                        const nameKey = spell.name?.trim().toLowerCase();
                        const existingItem = existingSpellByUuid.get(spell.uuid) || existingSpellByName.get(nameKey);

                        if (existingItem) {
                            skippedCount++;
                            continue;
                        }

                        const doc = await this.dataManager.getDocument(spell.uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            applyPreparedListSpell(itemData, {
                                sourceUuid: spell.uuid,
                                sourceClass: classId
                            });
                            this._applyFeatureType(itemData, stepType);
                            targetItems.push(itemData);
                            if (spell.uuid) existingSpellByUuid.set(spell.uuid, itemData);
                            if (nameKey && !existingSpellByName.has(nameKey)) existingSpellByName.set(nameKey, itemData);
                            addedCount++;
                        }
                    }

                    window.OriginateLog(`Originate | [Creation] 准备型法术获得: ${classId} 法表 ${minLevel}~${maxLevel}环, 跳过已有 ${skippedCount} 个, 新增 ${addedCount} 个`);
                } catch (e) {
                    console.error('Originate | [Creation] 准备型法术获得失败:', e);
                }
            } else if (currentStep.type === 'trait_choice') {
                // 收集特质选择
                const section = overlay.querySelector('.trait-choice-section');
                const stepType = section.dataset.stepType || 'class';
                const mode = section.dataset.mode || 'default';
                const advancementId = section.dataset.advId || currentStep.event?._original?._id || currentStep.event?.id || currentStep.event?.title || null;

                const checked = section.querySelectorAll('input[type="checkbox"]:checked');

                for (const cb of checked) {
                    const value = cb.value; // e.g., "skills:acr", "languages:common"

                    // 确定目标 blueprint 部分
                    const targetData = this.blueprintData[stepType];
                    if (!targetData.system) targetData.system = {};

                    if (this._applyTraitToUpdate) {
                        this._applyTraitToUpdate(value, targetData.system, mode);
                        this._recordCharacterTraitChange({
                            key: value,
                            advancementId,
                            level: state.currentLevel,
                            stepType,
                            mode,
                            parentFeature: currentStep.parentFeature || currentStep.parentFeat || null,
                            parentSourceUuid: currentStep.parentSourceUuid || null
                        });
                        window.OriginateLog(`Originate | Trait Choice Level ${state.currentLevel}: ${value}`);
                    }
                }
            }

            // 导航逻辑
            if (state.currentStepIndex < state.steps.length - 1) {
                // 进入下一步骤
                state.currentStepIndex++;
                await this._renderCurrentStep();
            } else {
                // 当前等级完成

                // Level 1 法术阶段完成 → 进入正常升级流程
                if (state.isLevel1SpellPhase) {
                    state.isLevel1SpellPhase = false;
                    state.currentLevel = 2;
                    state.stepData = {};
                    await this._loadLevelFeatures(state.currentLevel);
                    return;
                }

                // Level 1 纯法术向导完成（1级角色）→ 直接完成
                if (state.isLevel1SpellOnly) {
                    await this._finalizeCharacter();
                    return;
                }

                if (state.currentLevel >= state.targetLevel) {
                    // 真正写 Actor 前继续占住这一层，底下的传记页不能在异步提交时重新露出来。
                    await this._finalizeCharacter();
                } else {
                    // 进入下一级
                    state.currentLevel++;
                    await this._loadLevelFeatures(state.currentLevel);
                }
        }
        }

        /**
         * 回滚指定步骤的副作用
         * @param {string} stepId 步骤 ID
         */
        _rollbackStep(stepId) {
            const state = this._progressionState;
            if (!state.stepHistory || !state.stepHistory[stepId]) return;

            const history = state.stepHistory[stepId];
            window.OriginateLog(`Originate | 回滚步骤 ${stepId} 的副作用`, history);

            if (history.blueprints) {
                this.blueprintData.race = foundry.utils.deepClone(history.blueprints.race || { items: [], system: {} });
                this.blueprintData.class = foundry.utils.deepClone(history.blueprints.class || { items: [], system: {} });
                this.blueprintData.background = foundry.utils.deepClone(history.blueprints.background || { items: [], system: {} });
                this.blueprintData.subclass = foundry.utils.deepClone(history.blueprints.subclass || { items: [], system: {} });
            }

            this.blueprintData.pendingExpertise = foundry.utils.deepClone(history.pendingExpertiseSnapshot || []);
            state.hpGains = foundry.utils.deepClone(history.hpGainsSnapshot || []);

            if (history.selectedFeatsSnapshot) {
                state.selectedFeats = foundry.utils.deepClone(history.selectedFeatsSnapshot);
            }

            if (history.stepDataSnapshot) {
                state.stepData = foundry.utils.deepClone(history.stepDataSnapshot);
            }

            if (history.characterFinalizeSnapshot) {
                this.context.characterFinalizeResolution = foundry.utils.deepClone(history.characterFinalizeSnapshot);
            } else if (this.context?.characterFinalizeResolution) {
                delete this.context.characterFinalizeResolution;
            }

            if (history.stepsSnapshot) {
                state.steps = history.stepsSnapshot.slice();
            }

            const liveStepIds = new Set((state.steps || []).map(step => step?.id).filter(Boolean));
            for (const historyStepId of Object.keys(state.stepHistory || {})) {
                if (historyStepId === stepId) continue;
                if (!liveStepIds.has(historyStepId)) {
                    delete state.stepHistory[historyStepId];
                }
            }

            delete state.stepHistory[stepId];
        }

        /**
         * 处理创角 progression 的上一步。
         * 回退会撤销当前草稿产生的副作用，但不会触碰真实 Actor。
         */
        async _onProgressionPrev() {
            const state = this._progressionState;

            if (state.currentStepIndex > 0) {
                // 1. 清理当前步骤（B）的临时数据
                const currentStep = state.steps[state.currentStepIndex];
                this._clearStepData(currentStep, state.currentLevel);
                if (currentStep?.id) {
                    delete state.stepData[currentStep.id];
                }

                // 2. 回退索引
                state.currentStepIndex--;

                // 3. 获取上一步骤（A）并回滚其副作用
                // Adrian: 既然回到了上一步，那上一步之前提交的副作用（如添加的专长）也得撤销
                // 不然用户重新选的时候，之前的选择还会占着茅坑不拉屎（显示为已选择）
                const prevStep = state.steps[state.currentStepIndex];
                this._rollbackStep(prevStep.id);

                for (const futureStep of state.steps.slice(state.currentStepIndex + 1)) {
                    if (!futureStep?.id) continue;
                    delete state.stepData[futureStep.id];
                    delete state.stepHistory?.[futureStep.id];
                }

                // 4. 重新渲染上一步骤
                await this._renderCurrentStep();
            }
        }

        /**
         * 插入嵌套步骤到当前流程
         * 
         * Adrian: 这个方法负责把 _checkNestedAdvancements 返回的步骤转换成
         * progression-mixin 能理解的格式，然后插入到当前流程中。
         * 
         * _checkNestedAdvancements 返回的步骤类型是 'choice'，但我们需要根据
         * event.type 转换成更具体的类型（如 'asi_feat_choice'、'trait_choice' 等）。
         * 
         * @param {Array} newSteps 新步骤列表
         */
        _insertNestedSteps(newSteps) {
            if (!newSteps || newSteps.length === 0) return;

            const state = this._progressionState;

            // 转换步骤类型并生成唯一 ID
            newSteps.forEach((step, i) => {
                if (!step.id) step.id = `nested-${Date.now()}-${i}`;

                // Adrian: 统一处理 ASI 类型的嵌套步骤
                // 无论是原始的 'choice' (type='asi') 还是已经是 'asi'/'asi_feat_choice'
                // 这样可以防止某些步骤因为类型已经是 asi 而跳过处理逻辑
                const isASI = (step.type === 'choice' && step.event?.type === 'asi') ||
                    step.type === 'asi' ||
                    step.type === 'asi_feat_choice';

                if (isASI) {
                    step.type = 'asi_feat_choice';

                    // 获取事件对象（可能是 step.event 或 step 本身）
                    const event = step.event || step;

                    // Adrian: 提取固定属性提升 (Fixed ASI)
                    const fixed = event.fixed || event._original?.configuration?.fixed || {};
                    step.fixed = fixed;

                    // Adrian: 修复固定属性提升 (points=0) 被错误默认为 1 的问题
                    // 优先使用 event.points，如果未定义，检查是否有 fixed，如果有则为 0，否则为 1
                    if (event.points !== undefined) {
                        step.points = event.points;
                    } else if (Object.keys(fixed).length > 0) {
                        step.points = 0;
                    } else {
                        step.points = 1; // 默认为 1（专长通常是 +1）
                    }

                    step.cap = event.cap || 2;
                    step.locked = Array.from(event.locked || []);
                    step.stepType = step.stepType || 'class';
                    step.asiOnly = true;
                    step.advId = event.id || event._original?._id;

                    window.OriginateLog(`Originate | 转换嵌套步骤: ${step.title} -> asi_feat_choice (points=${step.points}, fixed=${JSON.stringify(step.fixed)})`);
                }
                // 处理其他类型
                else if (step.type === 'choice' && step.event) {
                    const eventType = step.event.type;
                    const event = step.event;

                    // 【新增】检测嵌套的法术选择
                    // 魔法学徒等专长会产生嵌套的法术选择
                    const isSpellChoice = usesSpellBrowser(event);

                    if (isSpellChoice) {
                        // 法术选择 -> spell_choice
                        step.type = 'spell_choice';
                        step.stepType = step.stepType || 'class';

                        // 【修复】确保 restriction 数据完整
                        if (!event.restriction) {
                            if (event._original?.configuration?.spell) {
                                event.restriction = event._original.configuration.spell;
                            } else if (event.spellConfig) {
                                event.restriction = event.spellConfig;
                            }
                        }

                        window.OriginateLog(`Originate | 转换嵌套步骤: ${step.title} -> spell_choice`);
                    } else if (eventType === 'trait_choice') {
                        // 特质选择 -> trait_choice
                        step.type = 'trait_choice';
                        step.stepType = step.stepType || 'class';
                        window.OriginateLog(`Originate | 转换嵌套步骤: ${step.title} -> trait_choice (mode=${step.event.mode}, count=${step.event.count})`);
                    } else if (eventType === 'choice') {
                        // 物品选择 -> item_choice
                        step.type = 'item_choice';
                        step.stepType = step.stepType || 'class';
                        window.OriginateLog(`Originate | 转换嵌套步骤: ${step.title} -> item_choice`);
                    }
                    // 其他类型保持不变
                }
            });

            window.OriginateLog(`Originate | 插入 ${newSteps.length} 个嵌套步骤到当前流程`);

            // 插入到当前步骤之后
            state.steps.splice(state.currentStepIndex + 1, 0, ...newSteps);

            // 通知用户
            ui.notifications.info(game.i18n.format('ORIGINATE.Notification.NewStepsAdded', { count: newSteps.length }));
        }

        /**
         * 清理指定步骤的数据
         * 
         * Adrian: 这个方法负责把某个步骤产生的数据清理干净。
         * 就像吃了后悔药，之前做的选择统统作废。
         * 
         * @param {Object} step 步骤对象
         * @param {number} level 当前等级
         */
        _clearStepData(step, level) {
            if (!step) return;

            window.OriginateLog(`Originate | 清理步骤数据: ${step.id} (Level ${level})。后悔药生效中...`);

            const state = this._progressionState;

            switch (step.type) {
                case 'hp':
                    // 清理 HP 选择
                    // Adrian: 删掉这一级的 HP 记录，让用户重新选
                    if (state.hpGains[level - 1]) {
                        window.OriginateLog(`Originate | 清理 Level ${level} 的 HP 选择`);
                        delete state.hpGains[level - 1];
                    }
                    break;

                case 'asi_feat_choice':
                    // 清理 ASI/专长选择
                    // Adrian: 这个比较复杂，要把加到 blueprint 里的属性加成和专长都删掉
                    if (state.stepData[step.id]) {
                        const choiceData = state.stepData[step.id];

                        if (choiceData.type === 'asi') {
                            // 清理 ASI 加成
                            // Adrian: 遍历所有属性，把这一步加的值减回去
                            // 但这里有个问题：我们没有记录具体加了多少
                            // 所以只能把 stepData 清掉，让用户重新选
                            window.OriginateLog(`Originate | 清理 ASI 选择数据`);
                        } else if (choiceData.type === 'feat' && choiceData.uuid) {
                            // 清理专长
                            // 先按这一步的来源删。可重复专长会有同一个 UUID 的多份副本，
                            // 只按 UUID 找很容易把早就拿到的那份误删掉。
                            const stepOrigin = step.advId || step.id;
                            const featIndex = this.blueprintData.class.items.findIndex(
                                i => {
                                    const sameSource = i.uuid === choiceData.uuid || resolveItemSourceUuid(i) === choiceData.uuid;
                                    if (!sameSource) return false;

                                    const origin = i.flags?.['hero-genesis']?.advancementOrigin;
                                    const acquiredAt = Number(i.flags?.['hero-genesis']?.acquiredAt);
                                    return origin === stepOrigin && acquiredAt === level;
                                }
                            );
                            if (featIndex !== -1) {
                                const removed = this.blueprintData.class.items.splice(featIndex, 1)[0];
                                window.OriginateLog(`Originate | 清理专长: ${removed.name}`);
                            }

                            // 从 selectedFeats 记录中删除
                            const featRecordIndex = state.selectedFeats.findIndex(
                                f => f.level === level && f.uuid === choiceData.uuid
                            );
                            if (featRecordIndex !== -1) {
                                state.selectedFeats.splice(featRecordIndex, 1);
                            }
                        }

                        delete state.stepData[step.id];
                    }
                    break;

                case 'item_choice':
                    // 清理物品选择
                    // Adrian: 把这一步选的物品从 blueprint 里删掉
                    // 通过 acquiredAt 标记来识别
                    const advId = step.event?._original?._id || step.event?.title;
                    const stepType = step.stepType || 'class';

                    // 从对应的 blueprint 中删除
                    const targetBlueprint = this.blueprintData[stepType] || this.blueprintData.class;
                    if (targetBlueprint?.items) {
                        const beforeCount = targetBlueprint.items.length;
                        targetBlueprint.items = targetBlueprint.items.filter(item => {
                            const origin = item.flags?.['hero-genesis']?.advancementOrigin;
                            const acquiredAt = item.flags?.['hero-genesis']?.acquiredAt;

                            // 如果是这个步骤在这个等级添加的，删掉
                            if (origin === advId && acquiredAt === level) {
                                window.OriginateLog(`Originate | 清理物品: ${item.name}`);
                                return false;
                            }
                            return true;
                        });
                        window.OriginateLog(`Originate | 清理了 ${beforeCount - targetBlueprint.items.length} 个物品`);
                    }
                    break;

                case 'trait_choice':
                    // 清理特质选择
                    // Adrian: 这个比较麻烦，因为特质是直接写到 system 里的
                    // 我们需要记录每个步骤选了什么，但目前没有这个机制
                    // 暂时只能清理 stepData，让用户重新选
                    // TODO: 实现更精确的特质清理
                    window.OriginateLog(`Originate | 特质选择清理（需要用户重新选择）`);
                    break;

                case 'features':
                    // 自动获得的特性不需要清理，因为它们是固定的
                    // Adrian: 这些是白送的，不用还
                    break;
            }
        }

        /**
         * 触发子职选择界面
         * 
         * Adrian: 子职选择是个大事，不能让用户手滑就定了终身。
         * 所以我加了个确认按钮，先选中再确认，给你反悔的机会。
         * 
         * @param {number} level 当前等级
         */
        async _triggerSubclassSelection(level) {
            // 防护：异步操作期间窗口可能已关闭或重新渲染
            if (!this.element) {
                console.warn('Originate | _triggerSubclassSelection: this.element is null, aborting.');
                return;
            }

            // 1. 获取所有可用子职
            // Adrian: 这里会根据你选的职业过滤子职，别想着法师选狂战士子职
            const subclassOptions = await this.dataManager.getOptions('subclass', this.context);

            // 2. 渲染子职选择界面 (使用统一的图三样式)
            let overlay = this.element.querySelector('.originate-progression-wizard');
            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = `originate-progression-wizard originate-sub-interface originate-container theme-${visualTheme}`;
                this.element.appendChild(overlay);
            } else {
                // 确保已有的 overlay 也有正确的主题类
                overlay.classList.add('originate-container');
                // 清主题类走注册表：硬编码清单漏掉外部皮肤（比如 theme-cyberpunk），复用 overlay 会双主题共存
                overlay.classList.remove(...getThemeClassList().split(' '));
                overlay.classList.add(`theme-${visualTheme}`);
            }

            // Adrian: 临时变量，记录当前选中的子职
            // 点击卡片只是"相中"，点确认才是"定亲"
            let selectedSubclassOption = null;

            overlay.innerHTML = `
                <div class="sub-interface-header">
                    <h2>${game.i18n.format('ORIGINATE.UI.Progression.SubclassSelectionTitle', { level: level })}</h2>
                    <div class="step-indicator">${game.i18n.localize('ORIGINATE.UI.Progression.SelectSubclass')}</div>
                </div>
                ${renderSubclassSelectionPanel(subclassOptions)}
                <div class="sub-interface-footer single-action">
                    <button type="button" class="confirm-btn" id="progression-subclass-confirm" disabled>
                        ${game.i18n.localize('ORIGINATE.UI.Button.ConfirmSelection')} <i class="fas fa-check"></i>
                    </button>
                </div>
            `;

            const confirmBtn = overlay.querySelector('#progression-subclass-confirm');

            bindSubclassSelectionPanel(overlay, subclassOptions, {
                onSelect: option => {
                    selectedSubclassOption = option;
                    if (confirmBtn) confirmBtn.disabled = false;
                }
            });

            // 绑定确认按钮 - 真正进入下一步
            // Adrian: 点了确认才算数，这才是真正的承诺
            if (confirmBtn) {
                confirmBtn.addEventListener('click', async () => {
                    if (!selectedSubclassOption) {
                        ui.notifications.warn(game.i18n.localize('ORIGINATE.UI.Progression.SubclassSelectWarn'));
                        return;
                    }

                    // 进入子职详情和确认界面
                    await this._renderSubInterfaceForProgression(selectedSubclassOption, level, async () => {
                        // 子职选择完成后的回调
                        // 1. 记录子职选择
                        this.context.subclass = selectedSubclassOption.id;
                        this.context.subclassName = selectedSubclassOption.name;
                        this.context.subclassIdentifier = selectedSubclassOption.identifier || this.context.subclassIdentifier || null;

                        // 2. 将子职 Item 添加到 blueprint
                        const doc = await this.dataManager.getDocument(selectedSubclassOption.uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            itemData.uuid = selectedSubclassOption.uuid; // Adrian: 修复 UUID 缺失
                            // 设置 classIdentifier
                            const classOptions = await this.dataManager.getOptions('class');
                            const selectedClass = classOptions.find(o => o.id === this.context.class);
                            if (selectedClass) {
                                foundry.utils.setProperty(itemData, "system.classIdentifier", selectedClass.identifier);
                            }
                            this.context.subclassIdentifier = this.context.subclassIdentifier || itemData.system?.identifier || selectedSubclassOption.name;
                            this._stampCharacterFinalizeItemMeta(itemData, {
                                sourceUuid: selectedSubclassOption.uuid,
                                level,
                                stepType: 'subclass',
                                isSubclass: true
                            });

                            this.blueprintData.subclass.items.push(itemData);
                        }

                        // 3. 继续加载当前等级的其他特性
                        await this._loadLevelFeatures(level);
                    });
                });
            }
        }

        /**
         * 清理子职相关数据
         * 
         * Adrian: 这个方法专门用来擦屁股。
         * 当用户在子职选择界面点返回时，要把之前可能选过的子职数据清掉。
         * 不然会出现特性叠加的灵异事件，用户会以为自己中了彩票，实际上是 bug。
         */
        _clearSubclassData() {
            window.OriginateLog("Originate | 清理子职数据。擦屁股时间到。");

            // 清理上下文中的子职选择
            this.context.subclass = null;
            this.context.subclassName = null;

            // 清理蓝图中的子职数据
            // Adrian: 这是关键，不清这个的话，之前选的子职特性还会被带到最终角色里
            this.blueprintData.subclass = { items: [], system: {} };

            window.OriginateLog("Originate | 子职数据已清理。干干净净，重新做人。");
        }

        /**
         * 为创角 progression 渲染子职配置页面
         * @param {Object} option 子职选项
         * @param {number} targetLevel 当前等级
         * @param {Function} onComplete 完成后的回调
         */
        async _renderSubInterfaceForProgression(option, targetLevel, onComplete) {
            window.OriginateLog(`Originate | _renderSubInterfaceForProgression 开始，option=${option.name}, targetLevel=${targetLevel}`);

            // 获取子职获得等级
            let subclassLevel = 3;
            const classOptions = await this.dataManager.getOptions('class');
            const selectedClass = classOptions.find(o => o.id === this.context.class);
            if (selectedClass && selectedClass.subclassLevel !== undefined) {
                subclassLevel = selectedClass.subclassLevel;
            }

            let allEvents = [];

            // 检查是否是首次选择子职（包括补选情况）
            const isFirstSelection = !this.blueprintData.subclass?.items || this.blueprintData.subclass.items.length === 0;

            // 如果是子职获得等级，或者虽然等级更高但尚未选择子职（补选）
            if (targetLevel === subclassLevel || (targetLevel > subclassLevel && isFirstSelection)) {
                window.OriginateLog(`Originate | 获取子职初始特性 (Level ${subclassLevel})`);
                // 首次获得子职，获取子职获得等级的特性
                const events = await this.dataManager.getLevelAdvancement(option.uuid, subclassLevel);
                events.forEach(e => e.sourceLevel = subclassLevel);
                allEvents = events;

                // 如果没有找到该等级的特性，尝试获取 Level 0、Level 1 的特性
                if (allEvents.length === 0) {
                    window.OriginateLog(`Originate | 子职 Level ${subclassLevel} 无特性，尝试获取 Level 0, 1`);
                    const level0Events = await this.dataManager.getLevelAdvancement(option.uuid, 0);
                    const level1Events = await this.dataManager.getLevelAdvancement(option.uuid, 1);
                    allEvents = [...level0Events, ...level1Events];
                    allEvents.forEach(e => e.sourceLevel = e.sourceLevel || subclassLevel);
                }

                // 如果是补选 (targetLevel > subclassLevel)，我们是否也应该获取当前等级的特性？
                // 策略：这里只处理初始特性。当前等级的特性将在回调后的 _loadLevelFeatures -> _getLevelUpgrades 中处理。
                // 这样可以保持逻辑清晰，虽然可能会导致用户先选初始特性，关闭窗口，然后再弹出当前等级特性的选择。
            } else {
                // 升级流程中，只获取当前等级的特性
                const events = await this.dataManager.getLevelAdvancement(option.uuid, targetLevel);
                events.forEach(e => e.sourceLevel = targetLevel);
                allEvents = events;
            }

            window.OriginateLog(`Originate | 子职 ${option.name} 在 Level ${targetLevel} 的 advancement 事件:`, allEvents);

            // 丰富事件数据（加载名称和图标）
            if (allEvents.length > 0) {
                await this.dataManager.enrichOptions(allEvents);
            }

            // 准备子界面数据
            const subContext = {
                option: option,
                levelEvents: allEvents,
                folderFeatures: [],
                type: 'subclass',
                knowledge: null,
                onComplete: onComplete, // 传递回调
                onCancel: async () => {
                    // 这里别再掉回前一级了，老老实实留在当前等级重选子职。
                    this._clearSubclassData();
                    await this._triggerSubclassSelection(targetLevel);
                },
                keepOverlayAfterComplete: true // 子职这条会直接接着渲染升级页，别手滑把壳删了
            };

            await this._renderFullSubInterface(subContext);
        }

        /**
         * 渲染特质选择 (TraitChoice)
         */
        _renderTraitChoice(event, level, stepType, stepId = null) {
            let poolArray = Array.from(event.pool);
            let displayOptions = [];
            const chosen = new Set(this._getStepDraft(stepId)?.chosen || []);

            // 展开通配符
            if (poolArray.some(p => p.endsWith(':*'))) {
                // 使用 UIMixin 中的 _expandWildcardPool 方法
                // 注意：ProgressionMixin 组合了 UIMixin，所以可以直接调用
                if (this._expandWildcardPool) {
                    displayOptions = this._expandWildcardPool(poolArray);
                } else {
                    console.warn("Originate | _expandWildcardPool not found in ProgressionMixin context");
                    // 简单的回退逻辑
                    if (poolArray.some(p => p === 'skills:*')) {
                        const skills = CONFIG.DND5E.skills;
                        Object.entries(skills).forEach(([k, v]) => {
                            displayOptions.push({ key: `skills:${k}`, label: v.label || v });
                        });
                    }
                }
            } else {
                // 使用 UIMixin 中的 _getTraitLabels 方法
                if (this._getTraitLabels) {
                    const labels = this._getTraitLabels(poolArray);
                    displayOptions = poolArray.map((key, i) => ({ key, label: labels[i] || key }));
                } else {
                    displayOptions = poolArray.map(key => ({ key, label: key }));
                }
            }

            // 过滤逻辑
            if (event.mode === 'expertise') {
                // 专精模式：只能选择已熟练但未专精的技能
                const proficientSkills = new Set();
                const expertSkills = new Set();

                // 1. Actor 现有熟练度
                if (this.actor?.system?.skills) {
                    Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                        if (v.value >= 1) proficientSkills.add(`skills:${k}`);
                        if (v.value >= 2) expertSkills.add(`skills:${k}`);
                    });
                }

                // 2. Blueprint 累积熟练度
                ['race', 'class', 'background', 'subclass'].forEach(step => {
                    const stepData = this.blueprintData[step];
                    if (stepData?.system) {
                        Object.keys(stepData.system).forEach(k => {
                            if (k.startsWith('skills.') && k.endsWith('.value')) {
                                const skill = k.split('.')[1];
                                const val = stepData.system[k];
                                if (val >= 1) proficientSkills.add(`skills:${skill}`);
                                if (val >= 2) expertSkills.add(`skills:${skill}`);
                            }
                        });
                    }
                });

                // 3. 当前升级流程中新获得的熟练度 (TODO: 如果有的话)
                // 目前 _progressionState 没有存储中间状态的熟练度，这可能是一个限制
                // 但通常专精是在获得熟练度之后很久才获得的，或者同时获得
                // 如果是同时获得（如吟游诗人 3 级），顺序很重要

                displayOptions = displayOptions.filter(opt => {
                    // 必须是技能
                    if (!opt.key.startsWith('skills:')) return false;
                    // 必须已熟练
                    if (!proficientSkills.has(opt.key)) return false;
                    // 不能已专精
                    if (expertSkills.has(opt.key)) return false;
                    return true;
                });

            } else {
                // 普通模式：过滤已获得的特质
                const knownTraits = new Set();

                // 1. Actor 现有特质
                if (this.actor?.system?.traits?.languages?.value) {
                    this.actor.system.traits.languages.value.forEach(l => knownTraits.add(`languages:${l}`));
                }
                if (this.actor?.system?.traits?.toolProf?.value) {
                    this.actor.system.traits.toolProf.value.forEach(t => {
                        const toolId = normalizeToolId(t);
                        if (toolId) knownTraits.add(`tool:${toolId}`);
                    });
                }
                if (this.actor?.system?.traits?.weaponProf?.value) {
                    this.actor.system.traits.weaponProf.value.forEach(w => knownTraits.add(`weapon:${w}`));
                }
                if (this.actor?.system?.traits?.weaponProf?.mastery?.value) {
                    this.actor.system.traits.weaponProf.mastery.value.forEach(w => knownTraits.add(`weaponMastery:${w}`));
                }
                if (this.actor?.system?.traits?.weaponMastery?.value) {
                    this.actor.system.traits.weaponMastery.value.forEach(w => knownTraits.add(`weaponMastery:${w}`));
                }
                if (this.actor?.system?.traits?.armorProf?.value) {
                    this.actor.system.traits.armorProf.value.forEach(a => knownTraits.add(`armor:${a}`));
                }
                if (this.actor?.system?.skills) {
                    Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                        if (v.value >= 1) knownTraits.add(`skills:${k}`);
                    });
                }

                // 2. Blueprint 累积特质
                ['race', 'class', 'background', 'subclass'].forEach(step => {
                    const stepData = this.blueprintData[step];
                    if (stepData?.system) {
                        if (stepData.system['traits.languages.value']) {
                            stepData.system['traits.languages.value'].forEach(l => knownTraits.add(`languages:${l}`));
                        }
                        if (stepData.system['traits.toolProf.value']) {
                            stepData.system['traits.toolProf.value'].forEach(t => {
                                const toolId = normalizeToolId(t);
                                if (toolId) knownTraits.add(`tool:${toolId}`);
                            });
                        }
                        if (stepData.system['traits.weaponProf.value']) {
                            stepData.system['traits.weaponProf.value'].forEach(w => knownTraits.add(`weapon:${w}`));
                        }
                        if (stepData.system['traits.weaponProf.mastery.value']) {
                            stepData.system['traits.weaponProf.mastery.value'].forEach(w => knownTraits.add(`weaponMastery:${w}`));
                        }
                        if (stepData.system['traits.weaponMastery.value']) {
                            stepData.system['traits.weaponMastery.value'].forEach(w => knownTraits.add(`weaponMastery:${w}`));
                        }
                        if (stepData.system['traits.armorProf.value']) {
                            stepData.system['traits.armorProf.value'].forEach(a => knownTraits.add(`armor:${a}`));
                        }
                        Object.keys(stepData.system).forEach(k => {
                            if (k.startsWith('skills.') && k.endsWith('.value')) {
                                const skill = k.split('.')[1];
                                if (stepData.system[k] >= 1) knownTraits.add(`skills:${skill}`);
                            }
                        });
                    }
                });

                const proficientWeapons = collectWeaponProficiencyKeys({
                    actor: this.actor,
                    blueprintData: this.blueprintData,
                    stepStates: this._progressionState?.steps || [],
                    extraGrants: event.associatedGrants
                });

                displayOptions = displayOptions.filter(opt => {
                    if (opt.key.startsWith('weaponMastery:')) {
                        const weaponKey = opt.key.split(':').pop().toLowerCase();
                        if (!proficientWeapons.has(weaponKey)) return false;
                    }
                    return !knownTraits.has(opt.key);
                });
            }

            return `
            <div class="progression-feature-group trait-choice-section page-wrapper" data-type="trait-choice" data-count="${event.count}" data-adv-id="${event.id || event._original?._id || event.title}" data-step-type="${stepType}" data-mode="${event.mode || 'default'}">
                <h4><i class="fas fa-tasks"></i> ${event.title} ${event.count > 0 ? `(${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })})` : ''}</h4>
                
                ${event.mode === 'expertise' ? `<div class="selection-hint">${game.i18n.localize('ORIGINATE.UI.Hint.SelectExpertise')}</div>` : ''}
                
                <div class="options-container skill-chips-container">
                    ${displayOptions.length > 0 ? displayOptions.map(item => `
                        <label class="option-card card-skill ${chosen.has(item.key) ? 'selected' : ''}">
                            <input type="checkbox" name="trait-choice-${level}-${event._original?._id || event.id || 'temp'}" value="${item.key}" ${chosen.has(item.key) ? 'checked' : ''}> 
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

        /**
         * 绑定升级向导中的特质选择限制
         */
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

        _getCharacterFinalizeLedger() {
            if (!this.context) this.context = {};
            if (!this.context.characterFinalizeResolution) {
                this.context.characterFinalizeResolution = { traitChanges: [] };
            }
            if (!Array.isArray(this.context.characterFinalizeResolution.traitChanges)) {
                this.context.characterFinalizeResolution.traitChanges = [];
            }
            return this.context.characterFinalizeResolution;
        }

        _recordCharacterTraitChange({
            key,
            advancementId = null,
            level = null,
            stepType = 'class',
            mode = 'default',
            parentFeature = null,
            parentSourceUuid = null
        } = {}) {
            if (!key) return null;

            const ledger = this._getCharacterFinalizeLedger();
            const entry = {
                key,
                advancementId,
                level: level ?? this._progressionState?.currentLevel ?? this.characterLevel ?? 1,
                stepType: stepType || 'class',
                mode: mode || 'default',
                parentFeature: parentFeature || null,
                parentSourceUuid: parentSourceUuid || null
            };

            ledger.traitChanges.push(entry);
            return entry;
        }

        _stampCharacterFinalizeItemMeta(itemData, {
            sourceUuid = null,
            advancementId = null,
            level = null,
            stepType = 'class',
            parentFeature = null,
            parentSourceUuid = null,
            isSubclass = false
        } = {}) {
            if (!itemData) return itemData;

            const resolvedSourceUuid = sourceUuid || resolveItemSourceUuid(itemData);
            if (resolvedSourceUuid) {
                stampSourceTracking(itemData, resolvedSourceUuid);
            }

            if (advancementId) foundry.utils.setProperty(itemData, 'flags.hero-genesis.advancementOrigin', advancementId);
            if (level !== null && level !== undefined) foundry.utils.setProperty(itemData, 'flags.hero-genesis.acquiredAt', level);
            if (stepType) foundry.utils.setProperty(itemData, 'flags.hero-genesis.stepType', stepType);
            if (parentFeature) foundry.utils.setProperty(itemData, 'flags.hero-genesis.parentFeature', parentFeature);
            if (parentSourceUuid) foundry.utils.setProperty(itemData, 'flags.hero-genesis.parentSourceUuid', parentSourceUuid);
            if (isSubclass) foundry.utils.setProperty(itemData, 'flags.hero-genesis.isSubclassSelection', true);

            return itemData;
        }

        _clearFinalizeTooltips() {
            document.querySelectorAll('.originate-spell-tooltip').forEach(el => el.remove());
        }

        _restoreDeferredAdvancements() {
            if (!this.context.deferredAdvancements?.length) return;

            window.OriginateLog(`Originate | 正在恢复 ${this.context.deferredAdvancements.length} 个延迟的 ASI Advancement...`);
            this.context.deferredAdvancements.forEach(deferred => {
                const type = deferred.sourceType;
                const stepData = this.blueprintData[type];
                if (!stepData?.items) return;

                const item = stepData.items.find(i => i.type === type);
                if (!item) return;

                const beforeCount = getAdvancementCount(item.system.advancement);
                item.system.advancement = appendAdvancementSource(item.system.advancement, deferred.advancement);
                if (getAdvancementCount(item.system.advancement) !== beforeCount) {
                    window.OriginateLog(`Originate | 已恢复 ${type} Item (${item.name}) 的 ASI Advancement:`, deferred.advancement);
                }
            });
        }

        _createFinalBlueprintShell() {
            const portrait = String(this.context.details?.portrait || '').trim();
            return {
                name: this.context.details?.name || this.actor.name || "新角色",
                img: portrait || this.actor.img,
                items: [],
                system: {}
            };
        }

        _applyDetailsToFinalBlueprint(finalBlueprint) {
            if (!this.context.details) return;

            const details = this.context.details;
            window.OriginateLog("Originate | 写入角色细节:", details);

            if (shouldWriteCharacterDetailField('alignment') && details.alignment) finalBlueprint.system['details.alignment'] = details.alignment;
            if (shouldWriteCharacterDetailField('faith') && details.faith) finalBlueprint.system['details.faith'] = details.faith;
            if (shouldWriteCharacterDetailField('gender') && details.gender) finalBlueprint.system['details.gender'] = details.gender;
            if (shouldWriteCharacterDetailField('age') && details.age) finalBlueprint.system['details.age'] = details.age;
            if (shouldWriteCharacterDetailField('height') && details.height) finalBlueprint.system['details.height'] = details.height;
            if (shouldWriteCharacterDetailField('weight') && details.weight) finalBlueprint.system['details.weight'] = details.weight;
            if (shouldWriteCharacterDetailField('eyes') && details.eyes) finalBlueprint.system['details.eyes'] = details.eyes;
            if (shouldWriteCharacterDetailField('skin') && details.skin) finalBlueprint.system['details.skin'] = details.skin;
            if (shouldWriteCharacterDetailField('hair') && details.hair) finalBlueprint.system['details.hair'] = details.hair;
            if (shouldWriteCharacterDetailField('appearance') && details.appearance) finalBlueprint.system['details.appearance'] = details.appearance;
            if (shouldWriteCharacterDetailField('trait') && details.trait) finalBlueprint.system['details.trait'] = details.trait;
            if (shouldWriteCharacterDetailField('ideal') && details.ideal) finalBlueprint.system['details.ideal'] = details.ideal;
            if (shouldWriteCharacterDetailField('bond') && details.bond) finalBlueprint.system['details.bond'] = details.bond;
            if (shouldWriteCharacterDetailField('flaw') && details.flaw) finalBlueprint.system['details.flaw'] = details.flaw;
            if (shouldWriteCharacterDetailField('biography') && details.biography) finalBlueprint.system['details.biography.value'] = details.biography;
        }

        _getFinalBlueprintSourceUuid(item) {
            return resolveItemSourceUuid(item) || item?._sourceUuid || item?.uuid || null;
        }

        _mergeFinalBlueprintItems(finalBlueprint) {
            const allItems = [
                ...(this.blueprintData.class?.items || []),
                ...(this.blueprintData.subclass?.items || []),
                ...(this.blueprintData.race?.items || []),
                ...(this.blueprintData.background?.items || [])
            ];

            window.OriginateLog("Originate | allItems 合并后:", allItems.map(i => i?.name));

            const seenItems = new Map();
            for (const item of allItems) {
                const sourceUuid = this._getFinalBlueprintSourceUuid(item);
                const normalizedSourceUuid = sourceUuid?.replace(/\.Item\./, '.') || null;
                const normalizedName = item?.name?.trim().toLowerCase();
                const nameKey = normalizedName ? `name:${item?.type || 'unknown'}:${normalizedName}` : null;
                const itemKey = normalizedSourceUuid ? `uuid:${normalizedSourceUuid}` : nameKey;
                const existingItem = (itemKey ? seenItems.get(itemKey) : null) || (nameKey ? seenItems.get(nameKey) : null);

                if (!existingItem) {
                    if (itemKey) seenItems.set(itemKey, item);
                    if (nameKey) seenItems.set(nameKey, item);
                    finalBlueprint.items.push(item);
                    continue;
                }

                if (existingItem.type === 'spell' && item.type === 'spell') {
                    mergeSpellDuplicateData(existingItem, item);
                    continue;
                }

                if (mergeInitialEquipmentQuantity(existingItem, item)) continue;

                // 容器不能靠 quantity 表示多件，D&D5e 写盘时会把它压回 1，所以要保留成两份物品。
                if (isInitialEquipmentItem(existingItem) && isInitialEquipmentItem(item)) {
                    finalBlueprint.items.push(item);
                }
            }

            window.OriginateLog(`Originate | Final blueprint items (${finalBlueprint.items.length}):`, finalBlueprint.items.map(i => i.name));
        }

        _applyAbilitiesToFinalBlueprint(finalBlueprint) {
            if (!this.context.abilities) return;

            window.OriginateLog("Originate | 写入初始属性值:", this.context.abilities);
            for (const [ability, value] of Object.entries(this.context.abilities)) {
                finalBlueprint.system[`abilities.${ability}.value`] = value;
            }
        }

        _mergeSystemDataIntoFinalBlueprint(finalBlueprint) {
            const allSystems = [
                this.blueprintData.class?.system || {},
                this.blueprintData.subclass?.system || {},
                this.blueprintData.race?.system || {},
                this.blueprintData.background?.system || {}
            ];

            window.OriginateLog("Originate | allSystems:", allSystems);

            for (const sys of allSystems) {
                if (!sys || Object.keys(sys).length === 0) continue;
                for (const [key, value] of Object.entries(sys)) {
                    if (value instanceof Set || (isTraitCollectionPath(key) && Array.isArray(value))) {
                        const combined = ensureTraitSet(finalBlueprint.system, key);
                        value.forEach(v => combined.add(v));
                    } else if (key.includes('abilities') && key.includes('value') && typeof value === 'number') {
                        if (finalBlueprint.system[key] !== undefined) {
                            const abilityKey = key.match(/abilities\.(\w+)\.value/)?.[1];
                            const baseValue = this.actor.system.abilities[abilityKey]?.value || 10;
                            const previousBonus = finalBlueprint.system[key] - baseValue;
                            const currentBonus = value - baseValue;
                            finalBlueprint.system[key] = baseValue + previousBonus + currentBonus;
                        } else {
                            finalBlueprint.system[key] = value;
                        }
                    } else if (key.startsWith('skills.') && key.endsWith('.value')) {
                        const currentValue = finalBlueprint.system[key] || 0;
                        finalBlueprint.system[key] = Math.max(currentValue, value);
                    } else if (key.startsWith('currency.')) {
                        finalBlueprint.system[key] = (finalBlueprint.system[key] || 0) + value;
                    } else {
                        finalBlueprint.system[key] = value;
                    }
                }
            }
        }

        _applyDeferredAsiBonuses(finalBlueprint) {
            const deferredASIs = this.context.deferredASIs || [];
            const asiAllocations = this._asiAllocations || {};
            if (!deferredASIs.length && !Object.values(asiAllocations).some(v => v > 0)) return;

            window.OriginateLog("Originate | 写入 ASI Bonus 加成:", { deferredASIs, asiAllocations });
            const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
            const fixedBonuses = {};

            for (const asi of deferredASIs.filter(a => a.type === 'fixed')) {
                if (!asi.fixed) continue;
                for (const [ab, val] of Object.entries(asi.fixed)) {
                    fixedBonuses[ab] = (fixedBonuses[ab] || 0) + val;
                }
            }

            for (const ab of abilities) {
                const fixedBonus = fixedBonuses[ab] || 0;
                const allocatedBonus = asiAllocations[ab] || 0;
                const totalBonus = fixedBonus + allocatedBonus;
                if (totalBonus <= 0) continue;

                const key = `abilities.${ab}.value`;
                const currentValue = finalBlueprint.system[key] || this.context.abilities?.[ab] || 8;
                finalBlueprint.system[key] = currentValue + totalBonus;
                window.OriginateLog(`Originate | ASI Bonus: ${ab} += ${totalBonus} (fixed: ${fixedBonus}, allocated: ${allocatedBonus}) => ${finalBlueprint.system[key]}`);
            }
        }

        _resolveFinalHitDie(finalBlueprint) {
            const configData = game.settings.get('character-forge', 'data');
            const classId = this.context.class;
            const classConfig = configData.classs?.[classId];
            let hitDie = null;

            if (classConfig?.hitDie) {
                hitDie = classConfig.hitDie;
                window.OriginateLog(`Originate | 从配置获取生命骰: d${hitDie}`);
            }

            if (!hitDie && this.blueprintData.class?.hitDie) {
                hitDie = this.blueprintData.class.hitDie;
                window.OriginateLog(`Originate | 从 blueprintData 获取生命骰: d${hitDie}`);
            }

            if (!hitDie) {
                for (const item of finalBlueprint.items) {
                    if (item.type !== 'class' || !item.system?.hd?.denomination) continue;

                    const denomMatch = String(item.system.hd.denomination).match(/d?(\d+)/i);
                    if (!denomMatch) continue;

                    hitDie = parseInt(denomMatch[1]);
                    window.OriginateLog(`Originate | 从职业物品提取生命骰: d${hitDie}`);
                    break;
                }
            }

            if (!hitDie) {
                hitDie = 8;
                window.OriginateLog(`Originate | 使用默认生命骰: d${hitDie}`);
            }

            return hitDie;
        }

        _applyClassLevelAndHitPoints(finalBlueprint, hitDie) {
            for (const item of finalBlueprint.items) {
                if (item.type !== 'class') continue;

                if (!item.system.hd) item.system.hd = {};
                item.system.hd.denomination = `d${hitDie}`;
                item.system.levels = this.characterLevel;
                window.OriginateLog(`Originate | 设置职业 ${item.name} 的生命骰为 d${hitDie}，等级为 ${this.characterLevel}`);
                break;
            }

            const classItemForHP = finalBlueprint.items.find(i => i.type === 'class');
            if (this._progressionState?.hpGains?.length > 0) {
                const totalHP = this._progressionState.hpGains.reduce((sum, g) => sum + g.hp, 0);
                finalBlueprint.system['attributes.hp.value'] = totalHP;
                window.OriginateLog(`Originate | 总 HP: ${totalHP} (来自 ${this._progressionState.hpGains.length} 级)`);

                if (classItemForHP?.system?.advancement) {
                    const hpAdv = findAdvancementEntry(classItemForHP.system.advancement, a => a.type === 'HitPoints');
                    if (hpAdv) {
                        if (!hpAdv.value) hpAdv.value = {};
                        const conMod = this._getConstitutionModifier();
                        for (const gain of this._progressionState.hpGains) {
                            hpAdv.value[gain.level] = gain.level === 1 ? 'max' : gain.hp - conMod;
                        }
                        window.OriginateLog(`Originate | 写入 HitPoints Advancement value:`, hpAdv.value);
                    }
                }
            } else if (this.characterLevel === 1) {
                const conMod = this._getConstitutionModifier();
                const totalHP = hitDie + conMod;
                finalBlueprint.system['attributes.hp.value'] = totalHP;
                window.OriginateLog(`Originate | 1 级 HP: ${totalHP} (d${hitDie} max + ${conMod} CON)`);

                if (classItemForHP?.system?.advancement) {
                    const hpAdv = findAdvancementEntry(classItemForHP.system.advancement, a => a.type === 'HitPoints');
                    if (hpAdv) {
                        if (!hpAdv.value) hpAdv.value = {};
                        hpAdv.value[1] = 'max';
                        window.OriginateLog(`Originate | 写入 HitPoints Advancement value:`, hpAdv.value);
                    }
                }
            }
        }

        _buildFinalBlueprint() {
            window.OriginateLog("Originate | _finalizeCharacter 开始");
            window.OriginateLog("Originate | blueprintData.class:", this.blueprintData.class);
            window.OriginateLog("Originate | blueprintData.race:", this.blueprintData.race);
            window.OriginateLog("Originate | blueprintData.background:", this.blueprintData.background);

            const finalBlueprint = this._createFinalBlueprintShell();
            this._applyDetailsToFinalBlueprint(finalBlueprint);
            this._mergeFinalBlueprintItems(finalBlueprint);
            this._applyAbilitiesToFinalBlueprint(finalBlueprint);
            this._mergeSystemDataIntoFinalBlueprint(finalBlueprint);
            this._applyDeferredAsiBonuses(finalBlueprint);

            window.OriginateLog("Originate | Final blueprint system:", finalBlueprint.system);

            const hitDie = this._resolveFinalHitDie(finalBlueprint);
            this._applyClassLevelAndHitPoints(finalBlueprint, hitDie);

            return finalBlueprint;
        }

        _getCharacterFinalizeClassItem(finalBlueprint) {
            return finalBlueprint.items.find(item => item?.type === 'class') || null;
        }

        _getCharacterFinalizeSubclassItem(finalBlueprint) {
            return finalBlueprint.items.find(item => item?.type === 'subclass') || null;
        }

        _getNativeSubclassAdvancementId(classItem) {
            const advancement = getAdvancementEntries(classItem?.system?.advancement)
                .find(adv => adv?.type === 'Subclass');
            return advancement?._id || advancement?.id || null;
        }

        _getFinalizeItemStepType(item) {
            return item?.flags?.['hero-genesis']?.stepType
                || (item?.type === 'race' ? 'race' : null)
                || (item?.type === 'background' ? 'background' : null)
                || (item?.type === 'subclass' ? 'subclass' : null)
                || 'class';
        }

        _isFinalizeRootItem(item) {
            return ['class', 'race', 'background'].includes(item?.type);
        }

        _shouldKeepFinalizeItemManual(item, advancementId, sourceUuid) {
            if (!sourceUuid || !advancementId) return true;
            if (advancementId.startsWith('spell-rules-') || advancementId === 'feat-grant') return true;
            return ['container', 'backpack', 'equipment', 'weapon', 'consumable', 'tool', 'loot'].includes(item?.type);
        }

        _toFinalizePendingItem(item, {
            advancementId = null,
            level = null,
            stepType = null,
            parentFeature = null,
            parentSourceUuid = null,
            isSubclass = false
        } = {}) {
            const itemData = foundry.utils.deepClone(item);
            const resolvedStepType = stepType || this._getFinalizeItemStepType(itemData);
            const resolvedLevel = level
                ?? itemData.flags?.['hero-genesis']?.acquiredAt
                ?? this.characterLevel
                ?? 1;

            return {
                itemData,
                advancementId: advancementId ?? itemData.flags?.['hero-genesis']?.advancementOrigin ?? null,
                level: resolvedLevel,
                stepType: resolvedStepType,
                parentFeature: parentFeature ?? itemData.flags?.['hero-genesis']?.parentFeature ?? null,
                parentSourceUuid: parentSourceUuid ?? itemData.flags?.['hero-genesis']?.parentSourceUuid ?? null,
                isSubclass: isSubclass || !!itemData.flags?.['hero-genesis']?.isSubclassSelection,
                sourceClass: itemData.system?.sourceClass || this.context.classIdentifier || null
            };
        }

        _buildCharacterFinalizeResolutionInput(finalBlueprint) {
            const rootItems = [];
            const pendingItems = [];
            const manualItems = [];
            const classItem = this._getCharacterFinalizeClassItem(finalBlueprint);
            const subclassItem = this._getCharacterFinalizeSubclassItem(finalBlueprint);
            const subclassAdvancementId = this._getNativeSubclassAdvancementId(classItem);
            const classUuid = this._getFinalBlueprintSourceUuid(classItem);
            const subclassUuid = this._getFinalBlueprintSourceUuid(subclassItem);

            for (const item of finalBlueprint.items) {
                if (!item) continue;

                if (this._isFinalizeRootItem(item)) {
                    rootItems.push(foundry.utils.deepClone(item));
                    continue;
                }

                const advancementId = item.flags?.['hero-genesis']?.advancementOrigin || null;
                const sourceUuid = this._getFinalBlueprintSourceUuid(item);

                if (item.type === 'subclass') {
                    if (subclassAdvancementId && sourceUuid) {
                        pendingItems.push(this._toFinalizePendingItem(item, {
                            advancementId: subclassAdvancementId,
                            stepType: 'class',
                            isSubclass: true
                        }));
                    } else {
                        manualItems.push(this._toFinalizePendingItem(item, {
                            advancementId,
                            stepType: 'subclass',
                            isSubclass: true
                        }));
                    }
                    continue;
                }

                const pendingItem = this._toFinalizePendingItem(item, { advancementId });
                if (this._shouldKeepFinalizeItemManual(item, advancementId, sourceUuid)) {
                    manualItems.push(pendingItem);
                } else {
                    pendingItems.push(pendingItem);
                }
            }

            const traitChanges = foundry.utils.deepClone(this._getCharacterFinalizeLedger().traitChanges || []);
            const actorData = {
                name: finalBlueprint.name,
                img: finalBlueprint.img,
                system: foundry.utils.deepClone(finalBlueprint.system || {})
            };

            return {
                scope: 'character-finalize',
                level: this.characterLevel || 1,
                context: {
                    actorId: this.actor?.id ?? null,
                    classIdentifier: this.context.classIdentifier || classItem?.system?.identifier || null,
                    subclassIdentifier: this.context.subclassIdentifier || subclassItem?.system?.identifier || null,
                    classUuid,
                    subclassUuid,
                    lockedLevel: this.characterLevel || 1
                },
                scaffold: {
                    actorData,
                    rootItems
                },
                itemChanges: {
                    pendingItems,
                    pendingItemUpdates: [],
                    pendingReplacements: []
                },
                traitChanges,
                manualItems
            };
        }

        async _applyCharacterFinalizeResolution(resolutionInput) {
            const result = await createCharacterFromFinalizeInput(resolutionInput, {
                actor: this.actor,
                dataManager: this.dataManager,
                deferRepairs: true
            });

            this.actor = game.actors.get(result.actor.id) || result.actor;

            return {
                actor: this.actor,
                resolutionResult: result.resolutionResult,
                warnings: result.warnings || [],
                deferredFinalize: result.deferredFinalize || null
            };
        }

        async _maybeRunInitialEquipmentShop(finalBlueprint) {
            const shopEntries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || []);
            const sellMultiplier = normalizeSellMultiplier(
                game.settings.get('character-forge', 'initialEquipmentShopSellMultiplier'),
                INITIAL_EQUIPMENT_SELL_MULTIPLIER
            );
            const sellEntries = buildInitialEquipmentSellEntries(finalBlueprint, shopEntries, { sellMultiplier });
            const purchaseEntries = await this._loadInitialShopPurchaseEntries(shopEntries);

            if (!hasInitialEquipmentShopChoices(sellEntries, purchaseEntries)) return finalBlueprint;

            const result = await this._renderInitialEquipmentShop({
                finalBlueprint,
                shopEntries,
                sellEntries,
                purchaseEntries
            });

            if (!result?.applied) return finalBlueprint;

            return applyInitialEquipmentLedger(finalBlueprint, {
                shopEntries,
                soldIds: Array.from(result.soldIds),
                soldEntries: sellEntries.filter(entry => result.soldIds.has(entry.id)),
                purchaseEntries: Array.from(result.purchases.values()).map(entry => ({
                    uuid: entry.uuid,
                    name: entry.name,
                    purchasePriceGp: entry.purchasePriceGp
                })),
                purchasedItems: Array.from(result.purchases.values()).flatMap(entry => entry.itemDataList || [entry.itemData])
            });
        }

        async _loadInitialShopPurchaseEntries(shopEntries = []) {
            const entries = [];

            for (const entry of shopEntries) {
                if (!entry.canPurchase || entry.purchasePriceGp === null) continue;

                try {
                    const doc = await fromUuid(entry.uuid);
                    if (!doc || !INITIAL_EQUIPMENT_ITEM_TYPES.has(doc.type)) continue;

                    const itemData = doc.toObject();
                    const sourceUuid = resolveItemSourceUuid(itemData, { compendiumOnly: true }) || entry.uuid;
                    stampSourceTracking(itemData, sourceUuid);
                    this._stampInitialShopPurchaseItem(itemData);
                    const itemDataList = await this._expandInitialShopPurchaseItems(itemData);
                    entries.push({
                        ...entry,
                        name: doc.name,
                        img: doc.img || 'icons/svg/item-bag.svg',
                        type: doc.type,
                        category: getInitialEquipmentCategory(doc.type),
                        itemData,
                        itemDataList
                    });
                } catch (error) {
                    console.warn(`Originate | 初始商店商品加载失败: ${entry.uuid}`, error);
                }
            }

            return entries.sort((a, b) => a.name.localeCompare(b.name));
        }

        _stampInitialShopPurchaseItem(itemData) {
            if (!itemData) return itemData;

            foundry.utils.setProperty(itemData, 'flags.hero-genesis.advancementOrigin', 'initial-equipment-shop');
            foundry.utils.setProperty(itemData, 'flags.hero-genesis.acquiredAt', this.characterLevel || 1);
            foundry.utils.setProperty(itemData, 'flags.hero-genesis.stepType', 'class');
            return itemData;
        }

        async _expandInitialShopPurchaseItems(itemData) {
            if (!['container', 'backpack'].includes(itemData?.type)) return [itemData];

            const manager = new LevelUpManager(this.actor, this.dataManager);
            const resolutionOptions = {
                stepType: 'class',
                actor: this.actor,
                classItem: null,
                subclassItem: null,
                advancementId: 'initial-equipment-shop',
                level: this.characterLevel || 1,
                sourceClass: this.context?.classIdentifier || null,
                restoreFeatType: true,
                forceFeatTypeFromSource: true,
                warnPrefix: 'Originate | [InitialShop]'
            };
            const { itemsData } = await manager._expandContainerContents([itemData], resolutionOptions);
            return itemsData?.length ? itemsData : [itemData];
        }

        _renderInitialEquipmentShop({ finalBlueprint, sellEntries, purchaseEntries }) {
            return new Promise(resolve => {
                const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
                const overlay = document.createElement('div');
                overlay.className = `originate-initial-shop-overlay theme-${visualTheme}`;
                const purchaseGroups = this._groupInitialShopPurchaseEntries(purchaseEntries);
                const state = {
                    soldIds: new Set(),
                    purchases: new Map(),
                    searchTerm: '',
                    openGroups: new Set(purchaseGroups.map(group => group.id)),
                    scrollPositions: { sell: 0, buy: 0 }
                };

                const close = applied => {
                    overlay.remove();
                    resolve({
                        applied,
                        soldIds: state.soldIds,
                        purchases: state.purchases
                    });
                };

                const render = () => {
                    this._captureInitialShopViewState(overlay, state);
                    overlay.innerHTML = this._renderInitialShopHtml(finalBlueprint, sellEntries, purchaseEntries, state);
                    this._restoreInitialShopViewState(overlay, state);
                };

                overlay.addEventListener('click', event => {
                    const button = event.target.closest?.('[data-action]');
                    if (!button) return;

                    const action = button.dataset.action;
                    if (action === 'initialShopToggleSell') {
                        const id = button.dataset.sellId;
                        if (!id) return;
                        if (state.soldIds.has(id)) state.soldIds.delete(id);
                        else state.soldIds.add(id);
                        const adjusted = this._pruneInitialShopPurchases(finalBlueprint, sellEntries, state);
                        if (adjusted) ui.notifications.warn(game.i18n.localize('ORIGINATE.InitialShop.PurchaseAdjusted'));
                        render();
                        return;
                    }

                    if (action === 'initialShopBuy') {
                        const uuid = button.dataset.uuid;
                        const entry = this._findInitialShopPurchaseEntry(purchaseEntries, uuid);
                        if (!entry) {
                            ui.notifications.warn(game.i18n.localize('ORIGINATE.InitialShop.MissingPurchaseEntry'));
                            return;
                        }
                        if (state.purchases.has(entry.uuid)) {
                            state.purchases.delete(entry.uuid);
                            render();
                            return;
                        }
                        if (!canAffordPurchase(getBlueprintCurrencyGp(finalBlueprint), this._getInitialShopLedgerSnapshot(sellEntries, state), entry.purchasePriceGp)) {
                            ui.notifications.warn(game.i18n.localize('ORIGINATE.InitialShop.NotEnoughFunds'));
                            return;
                        }
                        state.purchases.set(entry.uuid, entry);
                        render();
                        return;
                    }

                    if (action === 'initialShopUndoBuy') {
                        this._deleteInitialShopPurchase(state, button.dataset.uuid);
                        render();
                        return;
                    }

                    if (action === 'initialShopClearSearch') {
                        state.searchTerm = '';
                        const searchInput = overlay.querySelector('[data-initial-shop-search]');
                        if (searchInput) {
                            searchInput.value = '';
                            searchInput.focus();
                        }
                        this._applyInitialShopSearch(overlay, state);
                        return;
                    }

                    if (action === 'initialShopConfirm') {
                        const adjusted = this._pruneInitialShopPurchases(finalBlueprint, sellEntries, state);
                        if (adjusted) {
                            ui.notifications.warn(game.i18n.localize('ORIGINATE.InitialShop.PurchaseAdjusted'));
                            render();
                            return;
                        }
                        close(true);
                        return;
                    }

                    if (action === 'initialShopSkip') close(false);
                });

                overlay.addEventListener('input', event => {
                    if (!event.target.matches?.('[data-initial-shop-search]')) return;
                    state.searchTerm = event.target.value;
                    this._applyInitialShopSearch(overlay, state);
                });

                overlay.addEventListener('toggle', event => {
                    const group = event.target.closest?.('[data-shop-group]');
                    if (!group || this._normalizeInitialShopSearch(state.searchTerm)) return;
                    if (group.open) state.openGroups.add(group.dataset.shopGroup);
                    else state.openGroups.delete(group.dataset.shopGroup);
                }, true);

                const root = this.element;
                // 最终提交时 progression 壳会继续留着挡住传记页。商店必须挂到这个壳里，
                // 否则它会落在 fixed overlay 后面，看起来就像整个创角卡住了。
                const progressionOverlay = root?.querySelector?.('.originate-progression-wizard');
                const host = progressionOverlay || (root?.classList?.contains?.('originate-container')
                    ? root
                    : root?.querySelector?.('.originate-container'));
                if (!host) {
                    resolve({ applied: false, soldIds: state.soldIds, purchases: state.purchases });
                    return;
                }

                host.appendChild(overlay);
                render();
            });
        }

        _captureInitialShopViewState(overlay, state) {
            const searchInput = overlay.querySelector('[data-initial-shop-search]');
            if (searchInput) state.searchTerm = searchInput.value;

            overlay.querySelectorAll('[data-shop-list]').forEach(list => {
                state.scrollPositions[list.dataset.shopList] = list.scrollTop;
            });

            if (this._normalizeInitialShopSearch(state.searchTerm)) return;
            const groups = Array.from(overlay.querySelectorAll('[data-shop-group]'));
            if (!groups.length) return;
            state.openGroups = new Set(
                groups
                    .filter(group => group.open)
                    .map(group => group.dataset.shopGroup)
            );
        }

        _restoreInitialShopViewState(overlay, state) {
            this._applyInitialShopSearch(overlay, state);
            overlay.querySelectorAll('[data-shop-list]').forEach(list => {
                list.scrollTop = Number(state.scrollPositions[list.dataset.shopList] || 0);
            });
        }

        _applyInitialShopSearch(overlay, state) {
            const input = overlay.querySelector('[data-initial-shop-search]');
            if (input && input.value !== state.searchTerm) input.value = state.searchTerm;

            const query = this._normalizeInitialShopSearch(state.searchTerm);
            let matchCount = 0;
            overlay.querySelectorAll('[data-shop-group]').forEach(group => {
                let groupMatchCount = 0;
                group.querySelectorAll('[data-shop-entry]').forEach(row => {
                    const matches = !query || row.dataset.searchText?.includes(query);
                    row.hidden = !matches;
                    if (matches) groupMatchCount += 1;
                });

                group.hidden = !!query && groupMatchCount === 0;
                group.open = query && groupMatchCount > 0
                    ? true
                    : state.openGroups.has(group.dataset.shopGroup);
                matchCount += groupMatchCount;
            });

            const empty = overlay.querySelector('[data-initial-shop-search-empty]');
            if (empty) empty.hidden = !query || matchCount > 0;
            const clear = overlay.querySelector('[data-action="initialShopClearSearch"]');
            if (clear) clear.hidden = !query;
        }

        _normalizeInitialShopSearch(value) {
            return String(value || '').trim().toLocaleLowerCase();
        }

        _findInitialShopPurchaseEntry(purchaseEntries = [], uuid = '') {
            const normalizedUuid = normalizeUuid(uuid);
            return purchaseEntries.find(entry =>
                entry.uuid === uuid || normalizeUuid(entry.uuid) === normalizedUuid
            ) || null;
        }

        _deleteInitialShopPurchase(state, uuid = '') {
            const normalizedUuid = normalizeUuid(uuid);
            for (const key of state.purchases.keys()) {
                if (key === uuid || normalizeUuid(key) === normalizedUuid) {
                    state.purchases.delete(key);
                    return true;
                }
            }
            return false;
        }

        _pruneInitialShopPurchases(finalBlueprint, sellEntries, state) {
            let changed = false;
            const currentGp = getBlueprintCurrencyGp(finalBlueprint);
            while (state.purchases.size) {
                const ledger = this._getInitialShopLedgerSnapshot(sellEntries, state);
                if (roundGp(currentGp + calculateLedgerDeltaGp(ledger)) >= 0) break;
                const lastKey = Array.from(state.purchases.keys()).at(-1);
                state.purchases.delete(lastKey);
                changed = true;
            }
            return changed;
        }

        _getInitialShopLedgerSnapshot(sellEntries, state) {
            return {
                soldEntries: sellEntries.filter(entry => state.soldIds.has(entry.id)),
                purchaseEntries: Array.from(state.purchases.values()).map(entry => ({
                    purchasePriceGp: entry.purchasePriceGp
                }))
            };
        }

        _renderInitialShopHtml(finalBlueprint, sellEntries, purchaseEntries, state) {
            const baseGp = getBlueprintCurrencyGp(finalBlueprint);
            const ledger = this._getInitialShopLedgerSnapshot(sellEntries, state);
            const income = ledger.soldEntries.reduce((sum, entry) => sum + Number(entry.totalSellPriceGp || 0), 0);
            const spending = ledger.purchaseEntries.reduce((sum, entry) => sum + Number(entry.purchasePriceGp || 0), 0);
            const finalGp = roundGp(baseGp + calculateLedgerDeltaGp(ledger));
            const groupedPurchases = this._groupInitialShopPurchaseEntries(purchaseEntries);

            return `
                <div class="initial-shop-shell">
                    <header class="initial-shop-header">
                        <div>
                            <h2>${game.i18n.localize('ORIGINATE.InitialShop.Title')}</h2>
                            <p>${game.i18n.localize('ORIGINATE.InitialShop.Subtitle')}</p>
                        </div>
                        <div class="initial-shop-wallet">
                            <span>${game.i18n.localize('ORIGINATE.InitialShop.StartingGold')}: ${this._formatGp(baseGp)}</span>
                            <span>${game.i18n.localize('ORIGINATE.InitialShop.SellIncome')}: ${this._formatGp(income)}</span>
                            <span>${game.i18n.localize('ORIGINATE.InitialShop.BuyCost')}: ${this._formatGp(spending)}</span>
                            <strong>${game.i18n.localize('ORIGINATE.InitialShop.FinalGold')}: ${this._formatGp(finalGp)}</strong>
                        </div>
                    </header>
                    <main class="initial-shop-panels">
                        <section class="initial-shop-panel">
                            <h3>${game.i18n.localize('ORIGINATE.InitialShop.SellPanel')}</h3>
                            <div class="initial-shop-list" data-shop-list="sell">
                                ${sellEntries.length ? sellEntries.map(entry => this._renderInitialShopSellRow(entry, state)).join('') : this._renderInitialShopEmpty('ORIGINATE.InitialShop.NoSellItems')}
                            </div>
                        </section>
                        <section class="initial-shop-panel">
                            <header class="initial-shop-panel-heading">
                                <h3>${game.i18n.localize('ORIGINATE.InitialShop.BuyPanel')}</h3>
                                <div class="initial-shop-search">
                                    <i class="fas fa-search" aria-hidden="true"></i>
                                    <input type="search" data-initial-shop-search
                                        value="${this._escapeInitialShopText(state.searchTerm)}"
                                        placeholder="${game.i18n.localize('ORIGINATE.InitialShop.SearchPlaceholder')}"
                                        aria-label="${game.i18n.localize('ORIGINATE.InitialShop.SearchPlaceholder')}"
                                        autocomplete="off">
                                    <button type="button" data-action="initialShopClearSearch"
                                        title="${game.i18n.localize('ORIGINATE.InitialShop.ClearSearch')}"
                                        ${this._normalizeInitialShopSearch(state.searchTerm) ? '' : 'hidden'}>
                                        <i class="fas fa-times" aria-hidden="true"></i>
                                    </button>
                                </div>
                            </header>
                            <div class="initial-shop-list" data-shop-list="buy">
                                ${groupedPurchases.length ? groupedPurchases.map(group => this._renderInitialShopBuyGroup(group, state, finalBlueprint, sellEntries)).join('') : this._renderInitialShopEmpty('ORIGINATE.InitialShop.NoBuyItems')}
                                <div class="initial-shop-empty initial-shop-search-empty" data-initial-shop-search-empty hidden>
                                    ${game.i18n.localize('ORIGINATE.InitialShop.NoSearchResults')}
                                </div>
                            </div>
                        </section>
                    </main>
                    <footer class="initial-shop-footer">
                        <div class="initial-shop-purchases">
                            ${Array.from(state.purchases.values()).map(entry => `
                                <button type="button" data-action="initialShopUndoBuy" data-uuid="${this._escapeInitialShopText(entry.uuid)}">
                                    ${this._escapeInitialShopText(entry.name)} - ${this._formatGp(entry.purchasePriceGp)}
                                </button>
                            `).join('')}
                        </div>
                        <div class="initial-shop-actions">
                            <button type="button" class="initial-shop-secondary" data-action="initialShopSkip">${game.i18n.localize('ORIGINATE.InitialShop.Skip')}</button>
                            <button type="button" class="initial-shop-primary" data-action="initialShopConfirm">${game.i18n.localize('ORIGINATE.InitialShop.Confirm')}</button>
                        </div>
                    </footer>
                </div>
            `;
        }

        _renderInitialShopSellRow(entry, state) {
            const selected = state.soldIds.has(entry.id);
            const price = entry.canSell ? this._formatGp(entry.totalSellPriceGp) : game.i18n.localize('ORIGINATE.InitialShop.NoPrice');
            return `
                <article class="initial-shop-row ${selected ? 'selected' : ''} ${entry.canSell ? '' : 'initial-shop-row--muted'}">
                    <img src="${this._escapeInitialShopText(entry.img)}" alt="${this._escapeInitialShopText(entry.name)}">
                    <div class="initial-shop-row-main">
                        <strong>${this._escapeInitialShopText(entry.name)}</strong>
                        <span>${this._escapeInitialShopText(entry.type)}${entry.quantity > 1 ? ` x${entry.quantity}` : ''}</span>
                    </div>
                    <span class="initial-shop-price">${price}</span>
                    <button type="button" data-action="initialShopToggleSell" data-sell-id="${this._escapeInitialShopText(entry.id)}" ${entry.canSell ? '' : 'disabled'}>
                        ${game.i18n.localize(selected ? 'ORIGINATE.InitialShop.UndoSell' : 'ORIGINATE.InitialShop.Sell')}
                    </button>
                </article>
            `;
        }

        _renderInitialShopBuyGroup(group, state, finalBlueprint, sellEntries) {
            const open = !state.openGroups || state.openGroups.has(group.id) ? ' open' : '';
            return `
                <details class="initial-shop-buy-group" data-shop-group="${this._escapeInitialShopText(group.id)}"${open}>
                    <summary>${this._escapeInitialShopText(group.label)}</summary>
                    ${group.items.map(entry => this._renderInitialShopBuyRow(entry, state, finalBlueprint, sellEntries, group.label)).join('')}
                </details>
            `;
        }

        _renderInitialShopBuyRow(entry, state, finalBlueprint, sellEntries, groupLabel = '') {
            const alreadyPurchased = state.purchases.has(entry.uuid);
            const affordable = canAffordPurchase(
                getBlueprintCurrencyGp(finalBlueprint),
                this._getInitialShopLedgerSnapshot(sellEntries, state),
                entry.purchasePriceGp
            );
            const rowStateClass = [
                alreadyPurchased ? 'selected' : '',
                !alreadyPurchased && !affordable ? 'initial-shop-row--muted' : ''
            ].filter(Boolean).join(' ');
            const searchText = this._normalizeInitialShopSearch(`${entry.name} ${entry.type} ${groupLabel}`);
            return `
                <article class="initial-shop-row ${rowStateClass}" data-shop-entry
                    data-search-text="${this._escapeInitialShopText(searchText)}">
                    <img src="${this._escapeInitialShopText(entry.img)}" alt="${this._escapeInitialShopText(entry.name)}">
                    <div class="initial-shop-row-main">
                        <strong>${this._escapeInitialShopText(entry.name)}</strong>
                        <span>${this._escapeInitialShopText(entry.type)}</span>
                    </div>
                    <span class="initial-shop-price">${this._formatGp(entry.purchasePriceGp)}</span>
                    <button type="button" data-action="initialShopBuy" data-uuid="${this._escapeInitialShopText(entry.uuid)}">
                        ${game.i18n.localize(alreadyPurchased ? 'ORIGINATE.InitialShop.UndoBuy' : (affordable ? 'ORIGINATE.InitialShop.Buy' : 'ORIGINATE.InitialShop.NotEnoughFunds'))}
                    </button>
                </article>
            `;
        }

        _groupInitialShopPurchaseEntries(entries = []) {
            const labels = {
                weapon: game.i18n.localize('ORIGINATE.InitialShop.Category.Weapon'),
                equipment: game.i18n.localize('ORIGINATE.InitialShop.Category.Equipment'),
                consumable: game.i18n.localize('ORIGINATE.InitialShop.Category.Consumable'),
                tool: game.i18n.localize('ORIGINATE.InitialShop.Category.Tool'),
                container: game.i18n.localize('ORIGINATE.InitialShop.Category.Container'),
                loot: game.i18n.localize('ORIGINATE.InitialShop.Category.Loot'),
                other: game.i18n.localize('ORIGINATE.InitialShop.Category.Other')
            };
            const groups = new Map();
            for (const entry of entries) {
                if (!groups.has(entry.category)) {
                    groups.set(entry.category, { id: entry.category, label: labels[entry.category] || labels.other, items: [] });
                }
                groups.get(entry.category).items.push(entry);
            }
            return ['weapon', 'equipment', 'consumable', 'tool', 'container', 'loot', 'other']
                .filter(id => groups.has(id))
                .map(id => groups.get(id));
        }

        _renderInitialShopEmpty(key) {
            return `<div class="initial-shop-empty">${game.i18n.localize(key)}</div>`;
        }

        _formatGp(value) {
            const parts = splitGpToCurrencyParts(roundGp(value));
            const labels = {
                gp: game.i18n.localize('ORIGINATE.InitialShop.Currency.Gp'),
                sp: game.i18n.localize('ORIGINATE.InitialShop.Currency.Sp'),
                cp: game.i18n.localize('ORIGINATE.InitialShop.Currency.Cp')
            };
            const text = [];
            if (parts.gp) text.push(`${parts.gp} ${labels.gp}`);
            if (parts.sp) text.push(`${parts.sp} ${labels.sp}`);
            if (parts.cp) text.push(`${parts.cp} ${labels.cp}`);
            return text.length ? text.join(' ') : `0 ${labels.gp}`;
        }

        _escapeInitialShopText(value) {
            const div = document.createElement('div');
            div.textContent = String(value ?? '');
            return div.innerHTML;
        }

        /**
         * 最终完成角色创建
         */
        async _finalizeCharacter() {
            // 这是最后一道数据防线。遮罩能挡住鼠标，但挡不住重复事件或其他调用方。
            if (this._characterFinalizePromise) return this._characterFinalizePromise;

            this._removeCreationStatusDrawer();
            const finalizePromise = this._runCharacterFinalize();
            this._characterFinalizePromise = finalizePromise;

            try {
                return await finalizePromise;
            } finally {
                if (this._characterFinalizePromise === finalizePromise) {
                    this._characterFinalizePromise = null;
                }
            }
        }

        _getOrCreateCharacterFinalizeOverlay() {
            let overlay = this.element?.querySelector?.('.originate-progression-wizard');
            if (!overlay && this.element) {
                overlay = document.createElement('div');
                this.element.appendChild(overlay);
            }
            if (!overlay) return null;

            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
            overlay.className = `originate-progression-wizard originate-sub-interface originate-container theme-${visualTheme}`;
            return overlay;
        }

        _renderCharacterFinalizingState() {
            const overlay = this._getOrCreateCharacterFinalizeOverlay();
            if (!overlay) return null;

            overlay.dataset.originateFinalizing = 'true';
            overlay.setAttribute('aria-busy', 'true');
            overlay.innerHTML = `
                <div class="character-finalizing-state" role="status" aria-live="polite">
                    <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                    <h2>${game.i18n.localize('ORIGINATE.Notification.Finalizing')}</h2>
                    <p>${game.i18n.localize('ORIGINATE.UI.Finalizing.Hint')}</p>
                </div>
            `;
            return overlay;
        }

        async _restoreCharacterFinalizeUI() {
            const overlay = this.element?.querySelector?.('.originate-progression-wizard');
            if (overlay) {
                delete overlay.dataset.originateFinalizing;
                overlay.removeAttribute('aria-busy');
            }

            const state = this._progressionState;
            if (state?.steps?.length && state.steps[state.currentStepIndex]) {
                await this._renderCurrentStep();
                return;
            }

            // 没有 progression 的 1 级角色要回到原来的最后一页，允许用户重新提交。
            overlay?.remove();
        }

        async _runCharacterFinalize() {
            try {
                this._clearFinalizeTooltips();
                this._renderCharacterFinalizingState();
                this._restoreDeferredAdvancements();
                let finalBlueprint = this._buildFinalBlueprint();
                finalBlueprint = await this._maybeRunInitialEquipmentShop(finalBlueprint);
                const resolutionInput = this._buildCharacterFinalizeResolutionInput(finalBlueprint);

                ui.notifications.info(game.i18n.localize('ORIGINATE.Notification.Finalizing'));
                const result = await this._applyCharacterFinalizeResolution(resolutionInput);

                if (result.resolutionResult?.itemModifications?.status === 'failed') {
                    ui.notifications.warn(game.i18n.localize('ORIGINATE.Notification.ItemModificationsIncomplete'), { permanent: true });
                } else {
                    ui.notifications.success(game.i18n.localize('ORIGINATE.Notification.Complete'));
                }

                this._clearFinalizeTooltips();
                const actorToOpen = result.actor || this.actor;
                const deferredFinalize = result.deferredFinalize;

                // Одноразовый допуск игрока расходуется только после успешного создания.
                // До этого момента кнопку можно закрывать/открывать сколько угодно, а бросок
                // характеристик остаётся закреплён за тем же grantId.
                if (this.creationGrantId) {
                    try {
                        await game.modules.get('character-forge')?.api?.consumeCreationGrant?.({
                            grantId: this.creationGrantId,
                            actorId: actorToOpen?.id
                        });
                    } catch (grantError) {
                        console.warn('Character Forge | Не удалось подтвердить расход разрешения:', grantError);
                    }
                }

                try {
                    // Финальный экран не анимируем: персонаж уже создан, здесь важнее
                    // как можно быстрее освободить полноэкранный Forge перед листом.
                    await this.close({ animate: false });
                } catch (closeError) {
                    console.error('Character Forge | Персонаж создан, но окно мастера не удалось закрыть:', closeError);
                    this.element?.querySelector?.('.originate-progression-wizard')?.remove();
                }

                // Без двойного requestAnimationFrame: видео уже остановлены в close(),
                // поэтому сразу запускаем рендер листа в этом же цикле событий.
                let sheetRenderResult = null;
                try {
                    sheetRenderResult = actorToOpen?.sheet?.render(true);
                } catch (error) {
                    console.warn('Character Forge | Персонаж создан, но лист не удалось открыть:', error);
                }

                // Служебные repair/ModifyItem запускаются только после первого рендера
                // и только когда браузер даст idle-время. Они больше не задерживают
                // появление листа персонажа.
                if (typeof deferredFinalize === 'function') {
                    const runDeferredFinalize = async () => {
                        try {
                            const deferredResult = await deferredFinalize();
                            if (deferredResult?.itemModifications?.status === 'failed') {
                                ui.notifications.warn(
                                    game.i18n.localize('ORIGINATE.Notification.ItemModificationsIncomplete'),
                                    { permanent: true }
                                );
                            }
                        } catch (error) {
                            console.warn('Character Forge | Отложенный ремонт персонажа завершился с ошибкой:', error);
                        }
                    };

                    const scheduleDeferred = () => {
                        if (globalThis.requestIdleCallback) {
                            globalThis.requestIdleCallback(
                                () => runDeferredFinalize(),
                                { timeout: 1000 }
                            );
                        } else {
                            setTimeout(runDeferredFinalize, 150);
                        }
                    };

                    if (sheetRenderResult?.then instanceof Function) {
                        Promise.resolve(sheetRenderResult).finally(scheduleDeferred);
                    } else {
                        setTimeout(scheduleDeferred, 0);
                    }
                }

                return true;
            } catch (error) {
                console.error("Originate | Character creation failed:", error);
                ui.notifications.error(game.i18n.localize('ORIGINATE.Error.CreationFailed'));
                try {
                    await this._restoreCharacterFinalizeUI();
                } catch (restoreError) {
                    console.error('Originate | 创角提交失败后恢复界面也失败了:', restoreError);
                }
                return false;
            }
        }

        // _renderSpellChoice → 由 WizardUIMixin 提供（含环阶筛选功能）
        // ========================================================================
        //  以下方法委托给 shared/progression-renderer.js
        //  Phase 1 重构：统一 tooltip 和工具函数
        // ========================================================================

        _generateSpellCards(spells) {
            return generateSpellCards(spells);
        }

        _processHtmlDescription(desc) {
            return processHtmlDescription(desc);
        }

        _bindProgressionTooltips(overlay) {
            return bindTooltips(overlay, this.dataManager);
        }

        /**
         * 生成法术卡片 HTML，支持已选择法术变灰
         */
        _generateSpellCardsWithDisabled(spells) {
            if (!spells || spells.length === 0) {
                return `< div class="no-results" > ${game.i18n.localize('ORIGINATE.UI.NoResults')}</div > `;
            }
            return spells.map(spell => {
                const disabled = spell._alreadySelected;
                const disabledClass = disabled ? ' already-selected' : '';
                const disabledStyle = disabled ? 'opacity:0.4; pointer-events:none; cursor:not-allowed;' : '';
                const icon = disabled
                    ? '<div class="add-icon"><i class="fas fa-check" style="color:#666;"></i></div>'
                    : '<div class="add-icon"><i class="fas fa-plus-circle"></i></div>';

                let classTagsHtml = '';
                if (spell.sourceClass) {
                    const classes = spell.sourceClass.split(/[,;|\/]/).map(c => c.trim()).filter(c => c);
                    if (classes.length > 0) {
                        classTagsHtml = `< div class="spell-class-tags" >
    ${classes.map(c => `<span class="spell-class-tag">${c}</span>`).join('')}
                    </div > `;
                    }
                }

                return `
    < div class="spell-card${disabledClass}" data - uuid="${spell.uuid}" draggable = "${!disabled}" style = "${disabledStyle}" >
        <img src="${spell.img}" class="spell-icon">
            <div class="spell-info">
                <div class="spell-name" title="${spell.name}">${spell.name}</div>
                <div class="spell-meta">
                    ${CONFIG.DND5E.spellLevels[spell.level] || ''} &bull; ${CONFIG.DND5E.spellSchools[spell.school]?.label || ''}
                </div>
                ${classTagsHtml}
            </div>
            ${icon}
        </div>`;
            }).join('');
        }

        // _bindSpellBrowserEvents → 由 WizardUIMixin 提供
    };

    // 这里只补共享 UI 方法，不覆盖创角自己的导航和提交；这层边界不能拿来合并 LevelUpApp 生命周期。
    const _desc = Object.getOwnPropertyDescriptors(WizardUIMixin.prototype);
    delete _desc.constructor;
    for (const [key, desc] of Object.entries(_desc)) {
        if (!(key in _ProgClass.prototype)) {
            Object.defineProperty(_ProgClass.prototype, key, desc);
        }
    }
    return _ProgClass;
};
