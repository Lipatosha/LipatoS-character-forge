import { meetsLevelRequirement } from '../shared/feat-catalog.js';
import { getToolsByCategory, getWeaponLabel, getWeaponMasteryOptions, getToolLabel, getWeaponMasteryInfo, normalizeToolId, normalizeAbilityKey, getClassPrimaryAbilityKey } from '../mapping.js';
import { getThemeClassList } from '../theme-registry.js';
import { cleanDescription, processHtmlDescription, bindTooltips, updateTooltipPosition, traverseLanguageTree, findLanguageLabel, expandWildcardPool, getTraitLabel } from '../shared/progression-renderer.js';
import {
    applySpellConfigToItemData,
    collectWeaponProficiencyKeys,
    normalizeSpellItemData
} from '../shared/advancement-rule-utils.js';
import { resolveItemSourceUuid, stampSourceTracking } from '../shared/resolution-core.js';
import {
    buildSpellBrowserSearchRestriction,
    getSpellClassesForSpell,
    normalizeSpellListId,
    normalizeSpellListIds,
    spellClassSetMatchesAny
} from '../shared/spell-list-filters.js';
import { SpellRules } from '../spell-rules.js';
import { isAvailableSpellLevel, usesSpellBrowser } from '../shared/advancement-choice-rules.js';
import { ensureTraitSet } from '../shared/trait-collections.js';
import { findInvalidSpellSchoolSelections, getSpellRestriction, matchesSpellSchool, spellSchoolHint } from '../shared/spell-school-restrictions.js';
import { resolveStartingEquipmentSelection } from '../shared/starting-equipment.js';

/**
 * UIMixin - 子界面渲染、事件绑定与通用 UI 工具（2900+ 行）
 * 
 * 职责：
 *   - 子界面（Sub Interface）渲染与管理：职业特性选择向导
 *   - 法术浏览器（在创建流程中的嵌入式法术选择）
 *   - 专精步骤渲染与确认（_renderExpertiseStep, _onConfirmExpertise）
 *   - 装备选择与金币处理
 *   - 确认弹窗、音效、动画过渡
 * 
 * 依赖方法（来自其他 Mixin）：
 *   - this._onFinish()                       ← ProgressionMixin — 从创角主流程进入创角 progression / 最终提交
 *   - this._onNextStep()                     ← NavigationMixin — 导航到下一步
 *   - this._onConfirmSelection()             ← SelectionMixin — 确认当前选择
 * 
 * 依赖共享状态：
 *   - this.dataManager                       ← app.js — 数据加载
 *   - this.blueprintData                     ← app.js — 全局蓝图（读写 class/race/background items）
 *   - this.context                           ← app.js — 上下文（classIdentifier, abilities 等）
 *   - this.actor                             ← Foundry — 目标 Actor
 *   - this.element                           ← Foundry — 应用 DOM 根元素
 * 
 * 提供方法（被其他 Mixin/文件调用）：
 *   - this._renderFullSubInterface()         → ProgressionMixin — 渲染职业/种族特性子界面
 *   - this._renderExpertiseStep()            → ProgressionMixin, NavigationMixin — 渲染专精选择
 *   - this._onConfirmExpertise()             → app.js actions — 确认专精并完成
 *   - this._applyFeatureType()               → ProgressionMixin — 设置 item flag
 *   - this._applyTraitToUpdate()             → ProgressionMixin — 应用特质
 *   - this._checkNestedAdvancements()        → ProgressionMixin — 检查嵌套 advancement
 *   - this._insertNestedSteps()              → ProgressionMixin — 插入嵌套步骤
 *   - this._bindTooltips()                   → ProgressionMixin, WizardUIMixin — 绑定 tooltip
 *   - this._showConfirmDialog()              → ProgressionMixin, NavigationMixin — 确认弹窗
 *   - this._playSound()                      → ProgressionMixin — 播放音效
 *   - this._onFinishWizard()                 → 内部 — 子界面向导完成处理
 *   - this._saveWizardStepData()             → 内部 — 保存向导步骤数据
 *   - this._validateWizardStep()             → 内部 — 验证向导步骤
 */
export const UIMixin = (Base) => class extends Base {
    _getCurrentClassPrimaryAbilityKey() {
        const contextAbility = normalizeAbilityKey(this.context?.classPrimaryAbility);
        if (contextAbility) return contextAbility;

        const classItem = this.blueprintData?.class?.items?.find(item => item?.type === 'class');
        const itemAbility = getClassPrimaryAbilityKey(classItem);
        if (itemAbility) return itemAbility;

        const contextClass = getClassPrimaryAbilityKey({
            identifier: this.context?.classIdentifier || this.context?.class,
            coreTraits: { spellcasting: this.context?.classSpellcastingAbility }
        });
        return contextClass || null;
    }

    _getPrimaryAbilityCardClass(ability) {
        return this._getCurrentClassPrimaryAbilityKey() === ability ? ' primary-ability' : '';
    }

    /**
     * 显示自定义确认弹窗
     * 
     * Adrian: 别问我为什么要自己写弹窗。Foundry 原生的 Dialog.confirm() 
     * 那个 z-index 简直低到地心里去了，经常被我精心装修的 UI 挡得死死的。
     * 为了不让你们对着卡死的界面发呆，我只能撸起袖子自己造轮子了。
     * 
     * @param {Object} options 弹窗选项
     * @param {string} options.title 标题
     * @param {string} options.content 内容 HTML
     * @param {string} [options.yesLabel] 确认按钮文字
     * @param {string} [options.noLabel] 取消按钮文字
     * @param {boolean} [options.defaultYes] 默认选中确认按钮
     * @returns {Promise<boolean>} 用户选择
     */
    async _showConfirmDialog(options) {
        return new Promise((resolve) => {
            const {
                title = game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue"),
                content = "",
                yesLabel = game.i18n.localize("ORIGINATE.UI.Button.Confirm"),
                noLabel = game.i18n.localize("ORIGINATE.UI.Button.Cancel"),
                defaultYes = false
            } = options;

            // 创建弹窗容器
            const dialogOverlay = document.createElement('div');
            dialogOverlay.className = 'originate-confirm-dialog-overlay';

            dialogOverlay.innerHTML = `
                <div class="originate-confirm-dialog">
                    <div class="confirm-dialog-header">
                        <h3>${title}</h3>
                        <button type="button" class="confirm-dialog-close"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="confirm-dialog-content">
                        ${content}
                    </div>
                    <div class="confirm-dialog-footer">
                        <button type="button" class="confirm-dialog-btn btn-yes ${defaultYes ? 'default' : ''}">
                            <i class="fas fa-check"></i> ${yesLabel}
                        </button>
                        <button type="button" class="confirm-dialog-btn btn-no ${!defaultYes ? 'default' : ''}">
                            <i class="fas fa-times"></i> ${noLabel}
                        </button>
                    </div>
                </div>
            `;

            // 添加到我们的 UI 容器中，而不是 document.body
            // 这样可以确保弹窗在我们的 UI 层级内
            const container = this.element || document.body;
            container.appendChild(dialogOverlay);

            // 绑定事件
            const closeDialog = (result) => {
                dialogOverlay.remove();
                resolve(result);
            };

            dialogOverlay.querySelector('.confirm-dialog-close').addEventListener('click', () => closeDialog(false));
            dialogOverlay.querySelector('.btn-yes').addEventListener('click', () => closeDialog(true));
            dialogOverlay.querySelector('.btn-no').addEventListener('click', () => closeDialog(false));

            // 点击遮罩层关闭（视为取消）
            dialogOverlay.addEventListener('click', (e) => {
                if (e.target === dialogOverlay) closeDialog(false);
            });

            // ESC 键关闭
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', escHandler);
                    closeDialog(false);
                }
            };
            document.addEventListener('keydown', escHandler);
        });
    }

    async _renderFullSubInterface(context) {
        // 调试时要看现场，这里记一下当前子向导上下文。
        this._activeSubInterfaceContext = context;

        let overlay = this.element.querySelector('.originate-sub-interface');
        const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = `originate-sub-interface originate-container theme-${visualTheme}`;
            this.element.appendChild(overlay);
        } else {
            // 确保已有的 overlay 也有正确的主题类
            overlay.classList.add('originate-container');
            // 清主题类走注册表：硬编码清单漏掉外部皮肤（比如 theme-cyberpunk），复用 overlay 会双主题共存
            overlay.classList.remove(...getThemeClassList().split(' '));
            overlay.classList.add(`theme-${visualTheme}`);
        }

        // 初始化或获取子界面的状态
        // 就像给新房子装修一样，先得有个计划。
        // 虽然我经常一边装修一边改计划，但这次我保证逻辑是通的。
        if (!context._wizardState) {
            context._wizardState = {
                currentStep: 0,
                steps: [],
                data: {} // 存储各步骤的临时选择数据，别弄丢了
            };

            // 步骤 0: 固定特性 (Features + Fixed ASI + Size)
            // 也就是那些你没得选的东西。生活就是这样，有些东西是注定的，接受现实吧。
            context._wizardState.steps.push({
                type: 'fixed',
                title: game.i18n.localize('ORIGINATE.UI.Step.Title'),
                events: [] // 稍后填充
            });

            // 【修复】预加载固定特性的详细信息 (name, img, description)
            // 避免渲染出空卡片，那太尴尬了
            const featuresEvents = context.levelEvents.filter(e => e.type === 'features');
            if (featuresEvents.length > 0) {
                window.OriginateLog(`预加载 ${featuresEvents.length} 个固定特性事件的物品详情... 稍等片刻。`);
                for (const event of featuresEvents) {
                    if (event.items && event.items.length > 0) {
                        await Promise.all(event.items.map(async (item) => {
                            if (!item.name && item.uuid) {
                                try {
                                    const doc = await this.dataManager.getDocument(item.uuid);
                                    if (doc) {
                                        item.name = doc.name;
                                        item.img = doc.img;
                                        item.description = doc.system.description?.value || '';
                                    }
                                } catch (e) {
                                    console.warn(`Originate | 预加载物品失败: ${item.uuid}。这东西是不是不存在？`, e);
                                }
                            }
                        }));
                    }
                }
            }

            // 后续步骤: 动态生成选择步骤
            // 收集 Advancement 事件
            window.OriginateLog(`_renderFullSubInterface: 处理 ${context.levelEvents.length} 个 levelEvents。好多啊。`);

            // 【新增】收集需要延迟处理的嵌套步骤
            const pendingNestedSteps = [];

            for (let idx = 0; idx < context.levelEvents.length; idx++) {
                const event = context.levelEvents[idx];
                window.OriginateLog(`Event ${idx}: type=${event.type}, title=${event.title}`);
                if (event.type === 'features') {
                    // 固定特性 -> 步骤 0
                    // 过滤逻辑保持不变
                    const displayItems = event.items.filter(f => {
                        if (f.itemType === 'proficiency') return false;
                        // 【修复】现在 name 已经加载，可以安全过滤
                        if (!f.name) return false;
                        const nameLower = f.name.toLowerCase();
                        if (nameLower.includes('武器精通') ||
                            nameLower.includes('weapon mastery') ||
                            nameLower.includes('weaponmastery')) {
                            return false;
                        }
                        return true;
                    });
                    if (displayItems.length > 0) {
                        context._wizardState.steps[0].events.push({ ...event, displayItems });
                    }

                    // 【新增】检查每个特性是否有嵌套的 Advancement
                    // Adrian: 这是关键修复！像"巧匠"这样的专长，内部可能包含工具熟练选择
                    for (const item of event.items) {
                        if (item.hasNestedAdvancement && item.nestedAdvancements && item.nestedAdvancements.length > 0) {
                            window.OriginateLog(`发现特性 "${item.name}" 包含 ${item.nestedAdvancements.length} 个嵌套 Advancement`);

                            for (const nestedEvent of item.nestedAdvancements) {
                                // 设置来源信息
                                nestedEvent.sourceLevel = event.sourceLevel ?? 1;
                                nestedEvent.parentFeature = item.name;

                                if (nestedEvent.type === 'trait_choice') {
                                    // 特质选择（如工具熟练）
                                    window.OriginateLog(`添加嵌套特质选择步骤: ${item.name} -> ${nestedEvent.title}`);
                                    pendingNestedSteps.push({
                                        type: 'choice',
                                        title: `${item.name}: ${nestedEvent.title}`,
                                        event: nestedEvent,
                                        idx: `nested-${idx}-${pendingNestedSteps.length}`,
                                        parentFeature: item.name
                                    });
                                } else if (nestedEvent.type === 'choice') {
                                    // 物品选择
                                    window.OriginateLog(`添加嵌套物品选择步骤: ${item.name} -> ${nestedEvent.title}`);
                                    pendingNestedSteps.push({
                                        type: 'choice',
                                        title: `${item.name}: ${nestedEvent.title}`,
                                        event: nestedEvent,
                                        idx: `nested-${idx}-${pendingNestedSteps.length}`,
                                        parentFeature: item.name
                                    });
                                } else if (nestedEvent.type === 'asi') {
                                    // ASI 选择
                                    window.OriginateLog(`添加嵌套 ASI 步骤: ${item.name} -> ${nestedEvent.title}`);
                                    pendingNestedSteps.push({
                                        type: 'choice',
                                        title: `${item.name}: ${nestedEvent.title || game.i18n.localize("ORIGINATE.Advancement.ASI")}`,
                                        event: nestedEvent,
                                        idx: `nested-${idx}-${pendingNestedSteps.length}`,
                                        parentFeature: item.name
                                    });
                                } else if (nestedEvent.type === 'trait_grant') {
                                    // 自动获得的特质，直接应用到步骤 0 的事件中
                                    window.OriginateLog(`添加嵌套固定特质到步骤 0: ${item.name} -> ${nestedEvent.title}`);
                                    context._wizardState.steps[0].events.push({
                                        ...nestedEvent,
                                        parentFeature: item.name
                                    });
                                }
                            }
                        }
                    }
                } else if (event.type === 'hp') {
                    context._wizardState.steps[0].events.push(event);
                } else if (event.type === 'trait_grant') {
                    // allowReplacements: 如果角色已有某个被授予的特质，转为选择步骤
                    if (event.allowReplacements) {
                        const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);

                        // 收集已知特质
                        const knownTraits = new Set();
                        if (this.actor?.system?.skills) {
                            Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                                if ((v.value ?? v.proficient ?? 0) >= 1) knownTraits.add(`skills:${k}`);
                            });
                        }
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
                        if (this.actor?.system?.traits?.armorProf?.value) {
                            this.actor.system.traits.armorProf.value.forEach(a => knownTraits.add(`armor:${a}`));
                        }
                        // 从蓝图中收集
                        ['race', 'class', 'background', 'subclass'].forEach(step => {
                            const stepData = this.blueprintData[step];
                            if (stepData?.system) {
                                if (stepData.system['traits.languages.value']) stepData.system['traits.languages.value'].forEach(l => knownTraits.add(`languages:${l}`));
                                if (stepData.system['traits.toolProf.value']) {
                                    stepData.system['traits.toolProf.value'].forEach(t => {
                                        const toolId = normalizeToolId(t);
                                        if (toolId) knownTraits.add(`tool:${toolId}`);
                                    });
                                }
                                if (stepData.system['traits.weaponProf.value']) stepData.system['traits.weaponProf.value'].forEach(w => knownTraits.add(`weapon:${w}`));
                                if (stepData.system['traits.armorProf.value']) stepData.system['traits.armorProf.value'].forEach(a => knownTraits.add(`armor:${a}`));
                                Object.keys(stepData.system).forEach(k => {
                                    if (k.startsWith('skills.') && k.endsWith('.value')) {
                                        knownTraits.add(`skills:${k.split('.')[1]}`);
                                    }
                                });
                            }
                        });
                        // 从其他 trait_grant 事件中收集（排除当前事件自身）
                        context.levelEvents.forEach(e => {
                            if (e !== event && e.type === 'trait_grant' && e.grants) {
                                const g = Array.isArray(e.grants) ? e.grants : Array.from(e.grants);
                                g.forEach(k => knownTraits.add(k));
                            }
                        });

                        const duplicates = grants.filter(key => knownTraits.has(key));
                        const nonDuplicates = grants.filter(key => !knownTraits.has(key));

                        // 非重复的放入步骤 0 作为固定特质
                        if (nonDuplicates.length > 0) {
                            context._wizardState.steps[0].events.push({
                                ...event,
                                grants: new Set(nonDuplicates)
                            });
                        }

                        // 重复的转成选择步骤
                        for (const dupKey of duplicates) {
                            const category = dupKey.split(':')[0];
                            window.OriginateLog(`Originate | 特质 "${dupKey}" 已拥有，allowReplacements=true，转为选择步骤`);
                            pendingNestedSteps.push({
                                type: 'choice',
                                title: event.title || game.i18n.localize("ORIGINATE.Advancement.TraitChoice"),
                                event: {
                                    ...event,
                                    type: 'trait_choice',
                                    count: 1,
                                    pool: new Set([`${category}:*`]),
                                    _replacingGrant: dupKey
                                },
                                idx: `trait-replace-${idx}-${dupKey}`,
                                parentFeature: null
                            });
                        }
                    } else {
                        context._wizardState.steps[0].events.push(event);
                    }
                } else if (event.type === 'size' && Array.from(event.size).length === 1) {
                    context._wizardState.steps[0].events.push(event);
                } else if (event.type === 'asi') {
                    // ASI 可能同时包含 Fixed 和 Choice 部分
                    // 1. 如果有 Fixed 部分，添加到步骤 0
                    if (event.fixed && Object.keys(event.fixed).length > 0) {
                        context._wizardState.steps[0].events.push({ ...event, isFixed: true });
                    }

                    // 2. 如果有 Choice 部分 (points > 0)，添加独立步骤
                    // 但要避免重复添加 (如果已经通过下面的 else if 添加了) - 这里我们显式处理 ASI
                    if (event.points > 0) {
                        context._wizardState.steps.push({
                            type: 'choice',
                            title: event.title,
                            event: event,
                            idx: idx
                        });
                    }
                } else if (['choice', 'trait_choice', 'equipment', 'size'].includes(event.type)) {
                    // 选择类特性 -> 独立步骤
                    // 注意：需要去重逻辑
                    let shouldAdd = !SpellRules.managesChoice(event, {
                        classIdentifier: context.type === 'class' ? event.sourceItem?.identifier : this.context?.classIdentifier,
                        subclassIdentifier: context.type === 'subclass' ? event.sourceItem?.identifier : null
                    });
                    if (event.type === 'trait_choice') {
                        // 检查是否是专精 (Expertise)
                        if (event.mode === 'expertise') {
                            window.OriginateLog(`发现专精事件: ${event.title}，推迟到专精结算阶段。好饭不怕晚。`);
                            // 将专精事件添加到待处理列表
                            if (!context.expertiseEvents) context.expertiseEvents = [];
                            context.expertiseEvents.push(event);
                            shouldAdd = false;
                        }

                        // 过滤掉武器精通选项（暂时禁用）
                        const poolArray = Array.from(event.pool || []);
                        const hasWeaponMastery = poolArray.some(p => {
                            const pStr = String(p);
                            return pStr.startsWith('weaponMastery:') || pStr.includes('weaponMastery');
                        });
                        if (hasWeaponMastery) {
                            window.OriginateLog(`跳过武器精通事件: ${event.title}（暂时禁用）。太复杂了，以后再说。`, poolArray);
                            shouldAdd = false;
                        }

                        // 检查事件标题是否包含武器精通关键词
                        const titleLower = (event.title || '').toLowerCase();
                        if (titleLower.includes('武器精通') || titleLower.includes('weapon mastery') || titleLower.includes('weaponmastery')) {
                            window.OriginateLog(`跳过武器精通事件（标题匹配）: ${event.title}`);
                            shouldAdd = false;
                        }
                    }

                    if (!shouldAdd && event.type === 'trait_choice') {
                        const poolArray = Array.from(event.pool || []);
                        const hasWeaponMastery = poolArray.some(p => String(p).includes('weaponMastery'));
                        const titleLower = (event.title || '').toLowerCase();
                        if (event.mode === 'mastery' || hasWeaponMastery || titleLower.includes('weapon mastery') || titleLower.includes('weaponmastery')) {
                            shouldAdd = true;
                        }
                    }

                    if (shouldAdd) {
                        window.OriginateLog(`添加选择步骤: ${event.title} (${event.type})`);
                        context._wizardState.steps.push({
                            type: 'choice',
                            title: event.title,
                            event: event,
                            idx: idx
                        });
                    } else {
                        window.OriginateLog(`跳过选择步骤: ${event.title} (${event.type})`);
                    }
                } else {
                    window.OriginateLog(`未处理的事件类型: ${event.type}。这是什么鬼？`);
                }
            }

            // 【新增】将收集的嵌套步骤添加到向导
            if (pendingNestedSteps.length > 0) {
                window.OriginateLog(`添加 ${pendingNestedSteps.length} 个嵌套步骤到向导`);
                context._wizardState.steps.push(...pendingNestedSteps);
            }

            // 文件夹查找的特性 -> 步骤 0
            if (context.folderFeatures && context.folderFeatures.length > 0) {
                const existingNames = new Set();
                context.levelEvents.forEach(e => {
                    if (e.type === 'features') e.items.forEach(i => existingNames.add(i.name));
                });
                const newFeatures = context.folderFeatures.filter(f => !existingNames.has(f.name));
                if (newFeatures.length > 0) {
                    context._wizardState.steps[0].events.push({
                        type: 'folder_features',
                        items: newFeatures
                    });
                }
            }

            // 知识库装备/亚种 -> 独立步骤
            if (context.knowledge?.equipment && !context.levelEvents.some(e => e.type === 'equipment')) {
                context._wizardState.steps.push({
                    type: 'knowledge_equipment',
                    title: game.i18n.localize("ORIGINATE.UI.Progression.StartingEquipment"),
                    data: context.knowledge.equipment
                });
            }

            const isExactMatch = context.knowledge && (context.option.name === context.knowledge.name || context.option.name === context.knowledge.nameEN);
            if (context.knowledge?.subOptions && isExactMatch) {
                context._wizardState.steps.push({
                    type: 'knowledge_suboption',
                    title: context.knowledge.subOptions.title,
                    data: context.knowledge.subOptions
                });
            }

            // 如果步骤 0 没有内容，且总步骤数 > 1，则移除步骤 0
            // 如果总步骤数只有 1 (就是步骤 0)，则保留显示"无额外特性"
            // 别让用户看空页面，那太傻了
            if (context._wizardState.steps[0].events.length === 0 && context._wizardState.steps.length > 1) {
                context._wizardState.steps.shift();
            }
        }

        this._renderWizardStep(overlay, context);
    }

    _renderWizardStep(overlay, context) {
        const state = context._wizardState;

        // Safety Check: Ensure step index is valid
        if (state.currentStep < 0) state.currentStep = 0;
        if (state.steps.length > 0 && state.currentStep >= state.steps.length) {
            console.warn(`Originate | Wizard step index ${state.currentStep} out of bounds (max ${state.steps.length - 1}), resetting.`);
            state.currentStep = state.steps.length - 1;
        }

        const currentStepData = state.steps[state.currentStep];
        const totalSteps = state.steps.length;
        const hasBrokenDisplayValue = (value) => {
            if (this.dataManager?._isBrokenDisplayValue instanceof Function) {
                return this.dataManager._isBrokenDisplayValue(value);
            }

            if (value === null || value === undefined) return true;
            if (typeof value !== 'string') return false;

            const text = value.trim().toLowerCase();
            if (!text || text === 'null' || text === 'undefined') return true;

            return ['unnamed item', '未命名条目'].includes(text);
        };
        const getSafeDisplayName = (value) => hasBrokenDisplayValue(value)
            ? (game.i18n.lang?.startsWith('zh') ? '未命名条目' : 'Unnamed Item')
            : value;
        const getSafeDisplayImage = (value) => hasBrokenDisplayValue(value)
            ? 'icons/svg/item-bag.svg'
            : value;

        if (!currentStepData) {
            overlay.innerHTML = `<div class="error-state">Error: Wizard step data missing for index ${state.currentStep}</div>`;
            return;
        }

        window.OriginateLog(`Originate | Rendering Wizard Step ${state.currentStep + 1}/${totalSteps}: ${currentStepData.title}`);

        let contentHtml = '';

        // 渲染当前步骤内容。
        // 这里的逻辑比我早上的咖啡还苦，但我还是把它理顺了。
        if (currentStepData.type === 'fixed') {
            // 固定特性展示
            let featuresHtml = '';
            currentStepData.events.forEach(event => {
                if (event.type === 'features') {
                    featuresHtml += event.displayItems.map(f => `
                        <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${this._processHtmlDescription(f.description)}" data-uuid="${f.uuid || ''}">
                            <img src="${f.img}" class="feature-icon">
                            <div class="feature-info">
                                <div class="feature-name">${f.name}</div>
                            </div>
                        </div>
                    `).join('');
                } else if (event.type === 'folder_features') {
                    featuresHtml += event.items.map(f => `
                        <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${this._processHtmlDescription(f.description)}" data-uuid="${f.uuid || ''}">
                            <img src="${f.icon || f.img}" class="feature-icon">
                            <div class="feature-info">
                                <div class="feature-name">${f.name}</div>
                            </div>
                        </div>
                    `).join('');
                } else if (event.type === 'hp') {
                    // ... HP ...
                    let hitDieValue = 8;
                    if (event.denomination) {
                        const match = String(event.denomination).match(/d?(\d+)/i);
                        if (match) hitDieValue = parseInt(match[1]);
                    }
                    const hpDesc = game.i18n.format('ORIGINATE.UI.Tooltip.HitDie', { value: hitDieValue });
                    featuresHtml += `
                        <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${hpDesc}">
                            <div class="feature-icon-placeholder"><i class="fas fa-heart"></i></div>
                            <div class="feature-info">
                                <div class="feature-name">${event.title}</div>
                            </div>
                        </div>
                    `;
                } else if (event.type === 'trait_grant') {
                    let desc = "";
                    try {
                        const grants = Array.isArray(event.grants) ? event.grants : Array.from(event.grants || []);
                        desc = this._getTraitLabels(grants).join(', ');
                    } catch (e) {
                        console.error("Originate | Error processing trait labels:", e);
                        desc = game.i18n.localize("ORIGINATE.UI.Error.TraitProcessing");
                    }

                    featuresHtml += `
                        <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${desc}">
                            <div class="feature-icon-placeholder"><i class="fas fa-shield-alt"></i></div>
                            <div class="feature-info">
                                <div class="feature-name">${event.title}</div>
                            </div>
                        </div>
                    `;
                } else if (event.type === 'size') {
                    // ... Size ...
                    const sizeArray = Array.from(event.size);
                    const sizeDesc = game.i18n.format('ORIGINATE.UI.Tooltip.Size', { size: sizeArray.join(', ') });
                    featuresHtml += `
                        <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${sizeDesc}">
                            <div class="feature-icon-placeholder"><i class="fas fa-ruler-vertical"></i></div>
                            <div class="feature-info">
                                <div class="feature-name">${event.title}</div>
                            </div>
                        </div>
                    `;
                } else if (event.isFixed) { // Fixed ASI
                    // 过滤全0的属性提升
                    const hasNonZero = Object.values(event.fixed).some(v => v !== 0);
                    if (hasNonZero) {
                        const desc = Object.entries(event.fixed).map(([k, v]) => `${k.toUpperCase()} +${v}`).join(', ');
                        featuresHtml += `
                            <div class="wizard-feature-card option-card card-feature" data-originate-tooltip="${desc}">
                                <div class="feature-icon-placeholder"><i class="fas fa-arrow-up"></i></div>
                                <div class="feature-info">
                                    <div class="feature-name">${event.title}</div>
                                </div>
                            </div>
                        `;
                    }
                }
            });

            if (!featuresHtml) featuresHtml = `<div class="no-features">${game.i18n.localize('ORIGINATE.UI.Message.NoFixedFeatures')}</div>`;

            contentHtml = `
                <div class="wizard-step-content fixed-features">
                    <div class="page-wrapper">
                        <div class="options-container features-grid">
                            ${featuresHtml}
                        </div>
                    </div>
                </div>
            `;

        } else if (currentStepData.type === 'choice') {
            // 选择项展示
            const event = currentStepData.event;
            const idx = currentStepData.idx;

            // 复用之前的渲染逻辑，但只渲染单个 event
            let choiceHtml = '';

            // 这里需要将之前 _renderFullSubInterface 中对 choice/trait_choice/asi/equipment 的渲染逻辑提取出来
            // 为了简化，我在这里直接内联重写针对单个 event 的渲染，复用之前的逻辑

            if (event.type === 'choice') {
                const isSpellChoice = usesSpellBrowser(event);

                // 调试日志，方便排查
                if (window.OriginateDebug) {
                    console.log(`Originate | Is Spell Choice? ${isSpellChoice}`, event);
                }

                if (isSpellChoice) {
                    // 法术选择 - 使用法术浏览器 UI
                    window.OriginateLog(`Originate | 渲染法术浏览器: ${event.title}, restriction:`, event.restriction);
                    const count = event.count || 1;
                    const advId = event._original?._id || event.id || event.title;
                    const restrictedLevel = event.restriction?.level;

                    // 构建过滤器选项
                    const schools = Object.entries(CONFIG.DND5E.spellSchools).map(([k, v]) => ({ key: k, label: v.label }));

                    // 注意：DnD5e 系统中法术没有 sourceClass 字段
                    // 因此移除职业筛选功能，只保留搜索和学派筛选
                    const restriction = event.restriction || {};

                    choiceHtml += `
                        <div class="page-wrapper spell-browser-section" data-type="spell_choice" data-count="${count}" data-adv-id="${advId}" data-step-type="background" data-idx="${idx}" data-restriction-level="${restrictedLevel || ''}">
                            <h4><i class="fas fa-magic"></i> ${event.title || game.i18n.localize('ORIGINATE.UI.SelectSpells')} (${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: count })})</h4>
                            ${spellSchoolHint(restriction) ? `<p class="selection-hint">${spellSchoolHint(restriction)}</p><p data-school-error role="alert" hidden>${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')}</p>` : ''}
                            <div class="spell-browser-container">
                                <!-- 侧边栏过滤器 -->
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

                                    <div class="filter-group class-filter-group">
                                        <label>${game.i18n.localize('ORIGINATE.UI.ClassSpellList')}</label>
                                        <div class="class-filter-container">
                                            <!-- 主职业列表 -->
                                            <div class="spell-filter-list primary-classes">
                                                <div class="loading-placeholder-small"><i class="fas fa-spinner fa-spin"></i></div>
                                            </div>
                                            
                                            <!-- 子职业列表 (折叠) -->
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
                                
                                <!-- 主列表区域 -->
                                <div class="spell-browser-main">
                                    <div class="spell-results-list">
                                        <div class="loading-placeholder">
                                            <i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize('ORIGINATE.UI.Loading')}
                                        </div>
                                    </div>
                                    
                                    <div class="selected-spells-area">
                                        <div class="selection-header">
                                            ${game.i18n.localize('ORIGINATE.UI.Selected')}: <span class="selection-count">0</span> / ${count}
                                        </div>
                                        <div class="selected-spells-list">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                } else {
                    // 普通物品选择 ItemChoice
                    const canReplace = event.replacement || false;
                    const isPureReplacementMode = event.count === 0 && canReplace;
                    // ... 获取 availablePool ... (简化，假设已过滤)
                    const savedChoice = context._wizardState?.data?.[context._wizardState.currentStep];
                    const savedItems = [...(savedChoice?.items || []), savedChoice?.replacement?.newItemUuid].filter(Boolean);
                    const availablePool = (event.pool || []).map(opt => ({ ...opt, invalidSchool: !matchesSpellSchool(opt, getSpellRestriction(event)) }))
                        .filter(opt => !opt.invalidSchool || savedItems.includes(opt.uuid));

                    // 重新实现过滤逻辑
                    // 这里是显示过滤，不是最终写回；0 级种族/背景别把选项全筛没了。
                    const currentLevel = Math.max(1, Number(event.sourceLevel ?? this.characterLevel ?? 1));
                    const obtainedFeatureNames = new Set(); // 需要重新收集
                    // ... 收集 obtainedFeatureNames ...
                    for (const stepType of ['race', 'class', 'background', 'subclass']) {
                        const stepData = this.blueprintData[stepType];
                        if (stepData?.items) {
                            stepData.items.forEach(item => { if (item?.name) obtainedFeatureNames.add(item.name); });
                        }
                    }

                    const filteredPool = availablePool.filter(opt => {
                        if (!meetsLevelRequirement(opt, currentLevel)) return false;
                        if (obtainedFeatureNames.has(getSafeDisplayName(opt.name)) && !opt.repeatable) return false;
                        return true;
                    });

                    // ... 渲染 HTML ...
                    choiceHtml += `
                        <div class="page-wrapper">
                            <div class="options-container item-choices-list sub-section" data-type="item-choice" data-count="${event.count}" data-idx="${idx}" data-can-replace="${canReplace}" data-pure-replacement="${isPureReplacementMode}" data-adv-id="${event._original?._id || event.id || event.title}">
                                ${spellSchoolHint(getSpellRestriction(event)) ? `<p class="selection-hint">${spellSchoolHint(getSpellRestriction(event))}</p>` : ''}
                                ${filteredPool.map(opt => `
                                    <label class="option-card compact-feature-card" data-tooltip="${this._cleanDescription(opt.description)}" data-uuid="${opt.uuid}" aria-invalid="${!!opt.invalidSchool}">
                                        <input type="checkbox" name="item-choice-${idx}" value="${opt.uuid}" data-adv-id="${event._original?._id || event.id || event.title}">
                                        <img src="${getSafeDisplayImage(opt.img)}" class="feature-icon">
                                        <div class="feature-info-compact">
                                            <div class="feature-title">${getSafeDisplayName(opt.name)}</div>
                                        </div>
                                    </label>
                                `).join('')}
                            </div>
                            <div class="selection-hint">
                                <p>${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })}</p>
                            </div>
                        </div>
                     `;
                }
            } else if (event.type === 'trait_choice') {
                // TraitChoice
                let poolArray = Array.from(event.pool);
                window.OriginateLog(`Originate | _renderWizardStep trait_choice: event.title=${event.title}, poolArray.length=${poolArray.length}, poolArray=`, poolArray);
                // ... 展开通配符 ...
                const hasWildcard = poolArray.some(p => p.endsWith(':*'));
                let displayOptions = [];

                if (hasWildcard) {
                    displayOptions = this._expandWildcardPool(poolArray);
                    window.OriginateLog(`Originate | 通配符展开结果: ${displayOptions.length} 项`);
                } else {
                    const labels = this._getTraitLabels(poolArray);
                    displayOptions = poolArray.map((key, i) => {
                        const label = labels[i] || key;
                        let desc = "";
                        if (key.startsWith('weaponMastery:')) {
                            const info = getWeaponMasteryInfo(key);
                            desc = info.desc;
                        }
                        return { key, label, desc };
                    });
                }

                // 收集已获得的特质以进行过滤
                const knownTraits = new Set();

                // 【新增】扫描当前向导中的所有固定特质 (Trait Grants)
                // 这解决了不同 Advancement 之间的依赖问题（例如：一个 Advancement 给通用语，另一个让选语言）
                if (context._wizardState && context._wizardState.steps) {
                    context._wizardState.steps.forEach(step => {
                        // 检查 step.events (用于 fixed 步骤)
                        if (step.events) {
                            step.events.forEach(e => {
                                if (e.type === 'trait_grant' && e.grants) {
                                    e.grants.forEach(g => knownTraits.add(g));
                                }
                            });
                        }
                        // 检查 step.event (用于 choice 步骤，虽然不太可能在 choice 步骤中有 grant，但为了完整性)
                        if (step.event && step.event.type === 'trait_grant' && step.event.grants) {
                            step.event.grants.forEach(g => knownTraits.add(g));
                        }
                    });
                }

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
                // 技能通常是对象结构，需要特殊处理
                if (this.actor?.system?.skills) {
                    Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                        if (v.value >= 1) knownTraits.add(`skills:${k}`);
                    });
                }

                // 2. 蓝图中已有的特质 (来自之前的步骤)
                ['race', 'class', 'background', 'subclass'].forEach(step => {
                    const stepData = this.blueprintData[step];
                    if (stepData?.system) {
                        // 语言
                        if (stepData.system['traits.languages.value']) {
                            stepData.system['traits.languages.value'].forEach(l => knownTraits.add(`languages:${l}`));
                        }
                        // 工具
                        if (stepData.system['traits.toolProf.value']) {
                            stepData.system['traits.toolProf.value'].forEach(t => {
                                const toolId = normalizeToolId(t);
                                if (toolId) knownTraits.add(`tool:${toolId}`);
                            });
                        }
                        // 武器
                        if (stepData.system['traits.weaponProf.value']) {
                            stepData.system['traits.weaponProf.value'].forEach(w => knownTraits.add(`weapon:${w}`));
                        }
                        // 护甲
                        if (stepData.system['traits.weaponProf.mastery.value']) {
                            stepData.system['traits.weaponProf.mastery.value'].forEach(w => knownTraits.add(`weaponMastery:${w}`));
                        }
                        if (stepData.system['traits.weaponMastery.value']) {
                            stepData.system['traits.weaponMastery.value'].forEach(w => knownTraits.add(`weaponMastery:${w}`));
                        }
                        if (stepData.system['traits.armorProf.value']) {
                            stepData.system['traits.armorProf.value'].forEach(a => knownTraits.add(`armor:${a}`));
                        }
                        // 技能 (格式 skills.arc.value = 1)
                        Object.keys(stepData.system).forEach(k => {
                            if (k.startsWith('skills.') && k.endsWith('.value')) {
                                const skill = k.split('.')[1];
                                knownTraits.add(`skills:${skill}`);
                            }
                        });
                    }
                });

                // 收集已熟练的武器（用于武器精通过滤）
                const proficientWeapons = collectWeaponProficiencyKeys({
                    actor: this.actor,
                    blueprintData: this.blueprintData,
                    stepStates: context._wizardState?.steps || [],
                    extraGrants: event.associatedGrants
                });

                window.OriginateLog(`Originate | 已熟练的武器:`, Array.from(proficientWeapons));

                const unfilteredDisplayOptions = displayOptions.map(item => ({ ...item }));

                // 统一过滤和标记逻辑
                displayOptions = displayOptions.map(item => {
                    const key = item.key;
                    let disabled = false;
                    let disabledReason = '';

                    // 1. 过滤不需要显示的语言占位符
                    if (key.startsWith('languages:')) {
                        const langKey = key.split(':').pop();

                        // 硬编码排除通用语 (Common)。
                        // 大家都默认会说通用语，没必要再选一次，除非你想当个复读机。
                        if (langKey.toLowerCase() === 'common' || item.label === '通用语') {
                            return null;
                        }

                        // 使用新的过滤逻辑。
                        // 别把那些分类标题也当成语言给选了，那会出大问题的。
                        if (this._isLikelyLanguageCategory(langKey, item.label)) {
                            return null; // 完全移除
                        }
                    }

                    // 2. 武器精通过滤：只显示已熟练的武器
                    if (key.startsWith('weaponMastery:')) {
                        const weaponKey = key.split(':').pop().toLowerCase();
                        // 检查是否已熟练该武器
                        if (!proficientWeapons.has(weaponKey)) {
                            window.OriginateLog(`Originate | 过滤武器精通 ${weaponKey}：未熟练`);
                            return null; // 完全移除
                        }
                    }

                    // 3. 标记已获得的特质（不过滤，而是禁用）
                    // 标准化 key 用于比较
                    let checkKey = key;
                    let simpleVal = key;
                    if (key.startsWith('languages:') || key.startsWith('tool:') || key.startsWith('weapon:') || key.startsWith('armor:')) {
                        simpleVal = key.split(':').pop();
                        const type = key.split(':')[0];
                        checkKey = `${type}:${simpleVal}`;
                    }

                    // 检查完整 Key 或 简单值
                    // associatedGrants 通常只包含值（如 'common'），而 knownTraits 可能包含完整 Key（如 'languages:common'）
                    if (knownTraits.has(checkKey) || knownTraits.has(simpleVal)) {
                        // 用户反馈：已获得的特质（如通用语）不需要显示在列表中
                        return null;
                    }

                    // 检查技能是否已熟练
                    if (key.startsWith('skills:')) {
                        const skillKey = key.split(':')[1];
                        if (knownTraits.has(`skills:${skillKey}`)) {
                            // 已熟练的技能也不显示
                            return null;
                        }
                    }

                    return { ...item, disabled, disabledReason };
                }).filter(item => item !== null); // 移除 null 项

                if (event.mode === 'mastery' && displayOptions.length === 0 && unfilteredDisplayOptions.length > 0) {
                    window.OriginateLog('Originate | 武器精通被过滤空了，先回退显示原始列表看看是哪段还在捣乱。', {
                        title: event.title,
                        pool: poolArray,
                        associatedGrants: Array.from(event.associatedGrants || []),
                        proficientWeapons: Array.from(proficientWeapons)
                    });
                    displayOptions = unfilteredDisplayOptions.map(item => ({
                        ...item,
                        disabled: false,
                        disabledReason: ''
                    }));
                }

                choiceHtml += `
                    <div class="page-wrapper">
                        ${event._replacingGrant ? `<div class="selection-hint" style="color: var(--accent-color, #d4a849); margin-bottom: 1rem;"><i class="fas fa-info-circle"></i> ${game.i18n.format('ORIGINATE.UI.Hint.TraitReplacement', { trait: this._getTraitLabel ? this._getTraitLabel(event._replacingGrant) : event._replacingGrant })}</div>` : ''}
                        <div class="options-container skill-chips-container sub-section" data-type="trait-choice" data-count="${event.count}" data-idx="${idx}">
                            ${displayOptions.map(item => {
                    // 构建更详细的 tooltip 内容
                    let tooltipContent = item.label;
                    if (item.disabledReason) {
                        tooltipContent = `${item.label} (${item.disabledReason})`;
                    } else if (item.desc && item.desc !== item.label) {
                        tooltipContent = `<strong>${item.label}</strong><br>${item.desc}`;
                    }
                    const disabledClass = item.disabled ? 'disabled' : '';
                    const disabledAttr = item.disabled ? 'disabled' : '';
                    return `
                                <label class="option-card card-skill ${disabledClass}" data-tooltip="${this._escapeHtml(tooltipContent)}">
                                    <input type="checkbox" name="trait-${idx}" value="${item.key}" ${disabledAttr}> 
                                    <span class="chip-label">${item.label}${item.disabled ? ` <span class="disabled-tag">(${item.disabledReason})</span>` : ''}</span>
                                </label>
                            `;
                }).join('')}
                        </div>
                        <div class="selection-hint">
                            <p>${game.i18n.format('ORIGINATE.UI.Hint.SelectCount', { count: event.count })}</p>
                        </div>
                    </div>
                `;
            } else if (event.type === 'asi') {
                // ASI - 使用与 progression-mixin 一致的卡片式布局
                const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                const abilityLabels = {
                    str: game.i18n.localize('ORIGINATE.Ability.Str'),
                    dex: game.i18n.localize('ORIGINATE.Ability.Dex'),
                    con: game.i18n.localize('ORIGINATE.Ability.Con'),
                    int: game.i18n.localize('ORIGINATE.Ability.Int'),
                    wis: game.i18n.localize('ORIGINATE.Ability.Wis'),
                    cha: game.i18n.localize('ORIGINATE.Ability.Cha')
                };

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

                // 获取锁定的属性列表
                let lockedAbilities = [];
                if (event.locked instanceof Set) {
                    lockedAbilities = Array.from(event.locked);
                } else if (Array.isArray(event.locked)) {
                    lockedAbilities = event.locked;
                } else if (event.locked && typeof event.locked === 'object') {
                    lockedAbilities = Object.keys(event.locked);
                }
                const cap = event.cap || 2;

                // 计算每个属性的当前值
                const getCurrentAbilityValue = (ab) => {
                    // 基础值：用户在属性步骤设置的初始值，默认 8
                    const baseValue = this.context?.abilities?.[ab] || 8;

                    // 累加所有来源的加成
                    let totalBonus = 0;

                    // 种族加成
                    const raceValue = this.blueprintData?.race?.system?.[`abilities.${ab}.value`];
                    if (raceValue !== undefined) {
                        if (raceValue > baseValue) {
                            totalBonus += raceValue - baseValue;
                        } else if (raceValue > 0 && raceValue <= 5) {
                            totalBonus += raceValue;
                        }
                    }

                    // 背景加成
                    const bgValue = this.blueprintData?.background?.system?.[`abilities.${ab}.value`];
                    if (bgValue !== undefined) {
                        if (bgValue > baseValue) {
                            totalBonus += bgValue - baseValue;
                        } else if (bgValue > 0 && bgValue <= 5) {
                            totalBonus += bgValue;
                        }
                    }

                    return baseValue + totalBonus;
                };

                // 计算调整值
                const getAbilityModifier = (score) => Math.floor((score - 10) / 2);
                const formatModifier = (mod) => mod >= 0 ? `+${mod}` : `${mod}`;

                choiceHtml += `
                    <div class="sub-section asi-section wizard-choice-container" data-type="asi" data-points="${event.points}" data-cap="${cap}" data-locked="${lockedAbilities.join(',')}" data-idx="${idx}">
                        <div class="asi-header">
                            <h3 class="asi-title">${event.title || game.i18n.localize('ORIGINATE.ASI.ImproveAbility')}</h3>
                            <div class="asi-remaining">${game.i18n.localize('ORIGINATE.ASI.RemainingPoints')}: <span class="asi-points-remaining">${event.points}</span></div>
                        </div>
                        <div class="abilities-grid asi-grid">
                            ${abilities.map(ab => {
                    const currentValue = getCurrentAbilityValue(ab);
                    const mod = getAbilityModifier(currentValue);
                    const modFormatted = formatModifier(mod);
                    const modClass = mod > 0 ? 'positive' : (mod < 0 ? 'negative' : 'neutral');
                    const isLocked = lockedAbilities.includes(ab);
                    return `
                                <div class="ability-card asi-card ${isLocked ? 'locked' : ''}" data-ability="${ab}">
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
                                    ${isLocked ? `<div class="locked-indicator"><i class="fas fa-lock"></i> ${game.i18n.localize('ORIGINATE.ASI.Locked')}</div>` : ''}
                                </div>
                            `;
                }).join('')}
                        </div>
                    </div>
                `;
            } else if (event.type === 'equipment') {
                choiceHtml += this._renderStartingEquipmentEvent(event, idx);
            } else if (event.type === 'size') {
                // Size Choice
                const sizeArray = Array.from(event.size);
                const sizeLabels = {
                    'tiny': game.i18n.localize('ORIGINATE.Size.Tiny'),
                    'sm': game.i18n.localize('ORIGINATE.Size.Small'),
                    'med': game.i18n.localize('ORIGINATE.Size.Medium'),
                    'lg': game.i18n.localize('ORIGINATE.Size.Large'),
                    'huge': game.i18n.localize('ORIGINATE.Size.Huge'),
                    'grg': game.i18n.localize('ORIGINATE.Size.Gargantuan')
                };
                choiceHtml += `
                        <div class="sub-section size-choice-section wizard-choice-container" data-type="size-choice" data-idx="${idx}">
                            <div class="size-choices">
                                ${sizeArray.map((size, sizeIdx) => `
                                    <label class="size-choice wizard-option-card small">
                                        <input type="radio" name="size-choice-${idx}" value="${size}" ${sizeIdx === 0 ? 'checked' : ''}>
                                        <span class="choice-label">${sizeLabels[size] || size}</span>
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    `;
            }

            contentHtml = `
                <div class="wizard-step-content choice-step">
                    ${choiceHtml}
                </div>
            `;

        } else if (currentStepData.type === 'knowledge_equipment') {
            // 知识库装备
            contentHtml = `
                <div class="wizard-step-content choice-step">
                    <div class="sub-section wizard-choice-container">
                        <div class="equipment-choices">
                            ${currentStepData.data.map((e, idx) => `
                                <label class="equipment-choice wizard-option-card">
                                    <input type="radio" name="equipment" value="${idx}" ${idx === 0 ? 'checked' : ''}>
                                    <div class="eq-content">
                                        <span class="eq-label">${game.i18n.format('ORIGINATE.UI.Equipment.Option', { label: e.label })}</span>
                                        <div class="eq-desc">${e.items}</div>
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        } else if (currentStepData.type === 'knowledge_suboption') {
            // 亚种
            contentHtml = `
                <div class="wizard-step-content choice-step">
                     <div class="sub-section wizard-choice-container">
                        <div class="sub-choices">
                            ${currentStepData.data.choices.map(c => `
                                <label class="sub-choice wizard-option-card">
                                    <input type="radio" name="subOption" value="${c.value}">
                                    <div class="sub-content">
                                        <span class="choice-label">${c.label}</span>
                                        ${c.desc ? `<div class="sub-desc">${c.desc}</div>` : ''}
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }

        const usesCreationTimeline = this._isCreationWizardContext?.(context) === true;
        const hasTimelineBack = usesCreationTimeline && !!this._creationTimeline?.hasBack;
        const showPrevious = hasTimelineBack || state.currentStep > 0;

        // 渲染外壳
        overlay.innerHTML = `
            <div class="sub-interface-header">
                <h2>${context.option.name} - ${currentStepData.title}</h2>
                <div class="step-indicator">${game.i18n.format('ORIGINATE.UI.Step.Indicator', { current: state.currentStep + 1, total: totalSteps })}</div>
            </div>
            
            <div class="sub-interface-content wizard-layout">
                ${contentHtml}
            </div>
            
            <div class="sub-interface-footer">
                ${showPrevious ?
                `<button type="button" class="back-btn" data-action="prevWizardStep"><i class="fas fa-arrow-left"></i> ${game.i18n.localize('ORIGINATE.UI.Button.Previous')}</button>` :
                `<button type="button" class="back-btn" data-action="closeSubInterface"><i class="fas fa-times"></i> ${game.i18n.localize('ORIGINATE.UI.Button.Cancel')}</button>`
            }
                
                ${state.currentStep < totalSteps - 1 ?
                `<button type="button" class="confirm-btn" data-action="nextWizardStep">${game.i18n.localize('ORIGINATE.UI.Button.Next')} <i class="fas fa-arrow-right"></i></button>` :
                `<button type="button" class="confirm-btn" data-action="finishSubInterface">${game.i18n.localize('ORIGINATE.UI.Button.Finish')} <i class="fas fa-check"></i></button>`
            }
            </div>
        `;

        // 绑定事件
        const closeBtn = overlay.querySelector('[data-action="closeSubInterface"]');
        if (closeBtn) {
            closeBtn.onclick = async () => {
                if (typeof context.onCancel === 'function') {
                    await context.onCancel();
                    return;
                }
                overlay.remove();
            };
        }

        const prevBtn = overlay.querySelector('[data-action="prevWizardStep"]');
        if (prevBtn) prevBtn.onclick = async () => {
            if (usesCreationTimeline) {
                await this._goBackCreationTimeline?.();
                return;
            }

            state.currentStep--;
            this._renderWizardStep(overlay, context);
        };

        const nextBtn = overlay.querySelector('[data-action="nextWizardStep"]');
        if (nextBtn) {
            nextBtn.onclick = async () => {
                if (usesCreationTimeline && this._creationTimeline?.busy) return;

                // 验证当前步骤的选择（现在是异步的，会弹出确认弹窗）
                if (await this._validateWizardStep(overlay, currentStepData)) {
                    this._saveWizardStepData(overlay, currentStepData, context);
                    const advance = async () => {
                        state.currentStep++;
                        this._renderWizardStep(overlay, context);
                        return true;
                    };

                    if (usesCreationTimeline) await this._runCreationTimelineForward(advance);
                    else await advance();
                }
            };
        }

        const finishBtn = overlay.querySelector('[data-action="finishSubInterface"]');
        if (finishBtn) {
            finishBtn.onclick = async () => {
                if (finishBtn.dataset.busy === '1') return;
                if (usesCreationTimeline && this._creationTimeline?.busy) return;

                const idleHtml = finishBtn.innerHTML;
                const label = finishBtn.textContent.trim();
                let shouldRestore = true;

                finishBtn.dataset.busy = '1';
                finishBtn.disabled = true;
                finishBtn.classList.add('is-loading');
                finishBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${label}`;

                try {
                    if (!(await this._validateWizardStep(overlay, currentStepData))) return;

                    this._saveWizardStepData(overlay, currentStepData, context);
                    if (usesCreationTimeline) {
                        await this._runCreationTimelineForward(async () => {
                            await this._onFinishWizard(context);
                            return true;
                        });
                    } else {
                        await this._onFinishWizard(context);
                    }
                    shouldRestore = false;
                } catch (error) {
                    console.error("Originate | finishSubInterface failed:", error);
                } finally {
                    delete finishBtn.dataset.busy;

                    if (shouldRestore && finishBtn.isConnected) {
                        finishBtn.disabled = false;
                        finishBtn.classList.remove('is-loading');
                        finishBtn.innerHTML = idleHtml;
                    }
                }
            };
        }

        const savedStepData = this._restoreWizardStepData(overlay, currentStepData, context);

        this._bindStartingEquipmentControls(overlay);

        // 绑定复选框限制和 ASI 逻辑
        this._bindCheckboxLimits(overlay);
        this._bindASIControls(overlay);

        // 绑定法术浏览器事件
        this._bindSpellBrowserEventsWizard(overlay, currentStepData, savedStepData?.spells || []);

        // 绑定 Tooltip
        this._bindTooltips(overlay);
    }

    _renderStartingEquipmentEvent(event, idx) {
        const roots = Array.isArray(event.roots) ? event.roots : [];
        const hasEquipment = roots.length > 0;
        const hasWealth = !!event.wealth?.formula;
        const equipmentChecked = hasEquipment ? 'checked' : '';
        const wealthChecked = !hasEquipment && hasWealth ? 'checked' : '';

        const modeChoices = `
            ${hasEquipment ? `
                <label class="equipment-mode-choice wizard-option-card">
                    <input type="radio" name="equipment-mode-${idx}" value="equipment" data-equipment-mode ${equipmentChecked}>
                    <span class="eq-label">${game.i18n.localize('ORIGINATE.UI.Equipment.TakeEquipment')}</span>
                </label>
            ` : ''}
            ${hasWealth ? `
                <label class="equipment-mode-choice wizard-option-card">
                    <input type="radio" name="equipment-mode-${idx}" value="wealth" data-equipment-mode ${wealthChecked}>
                    <span class="eq-label">${game.i18n.localize('ORIGINATE.UI.Equipment.TakeWealth')}</span>
                    <span class="eq-desc">${this._escapeHtml(event.wealth.formula)} ${event.wealth.denomination.toUpperCase()}</span>
                </label>
            ` : ''}
        `;

        return `
            <div class="sub-section equipment-section starting-equipment-tree wizard-choice-container" data-type="equipment" data-idx="${idx}">
                <div class="equipment-mode-choices">${modeChoices}</div>
                <div class="equipment-mode-panel" data-equipment-mode-panel="equipment">
                    ${roots.map((root, rootIndex) => `
                        <section class="equipment-root-group">
                            <h5>${game.i18n.format('ORIGINATE.UI.Equipment.Group', { index: rootIndex + 1 })}</h5>
                            ${this._renderStartingEquipmentNode(root, idx, 0)}
                        </section>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _renderStartingEquipmentNode(node, idx, depth = 0) {
        if (!node) return '';

        if (node.kind === 'group' && node.operator === 'AND') {
            return `
                <div class="equipment-and-group" data-equipment-node-id="${this._escapeHtml(node.id)}">
                    ${node.children.map(child => this._renderStartingEquipmentNode(child, idx, depth + 1)).join('')}
                </div>
            `;
        }

        if (node.kind === 'group' && node.operator === 'OR') {
            const groupId = this._escapeHtml(node.id);
            return `
                <div class="equipment-choice-group" data-equipment-choice-group="${groupId}">
                    <div class="equipment-branches">
                        ${node.children.map((child, optionIndex) => {
                            const optionLabel = optionIndex < 26
                                ? String.fromCharCode(65 + optionIndex)
                                : String(optionIndex + 1);
                            return `
                                <div class="equipment-branch${optionIndex === 0 ? ' is-selected' : ''}" data-equipment-branch data-equipment-branch-id="${this._escapeHtml(child.id)}">
                                    <label class="equipment-branch-choice">
                                        <input type="radio" name="equipment-choice-${idx}-${groupId}" value="${this._escapeHtml(child.id)}"
                                            data-equipment-choice-id="${groupId}" ${optionIndex === 0 ? 'checked' : ''}>
                                        <span>${game.i18n.format('ORIGINATE.UI.Equipment.Option', { label: optionLabel })}</span>
                                    </label>
                                    <div class="equipment-branch-details">
                                        ${this._renderStartingEquipmentNode(child, idx, depth + 1)}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }

        if (node.kind === 'item') {
            const count = node.count > 1 ? `${node.count}× ` : '';
            return `
                <div class="equipment-fixed-item" data-equipment-node-id="${this._escapeHtml(node.id)}">
                    ${node.img ? `<img src="${this._escapeHtml(node.img)}" alt="">` : ''}
                    <span>${count}${this._escapeHtml(node.name)}</span>
                </div>
            `;
        }

        if (node.kind === 'category') {
            const categoryId = this._escapeHtml(node.id);
            const options = Array.isArray(node.options) ? node.options : [];
            return `
                <div class="equipment-category-choice" data-equipment-node-id="${categoryId}">
                    <span class="equipment-category-label">${this._escapeHtml(node.label)}</span>
                    ${Array.from({ length: node.count }, (_, slotIndex) => `
                        <select data-equipment-category-id="${categoryId}" data-equipment-slot="${slotIndex}">
                            ${options.length > 0
                                ? options.map(option => `<option value="${this._escapeHtml(option.uuid)}">${this._escapeHtml(option.name)}</option>`).join('')
                                : `<option value="">${game.i18n.localize('ORIGINATE.UI.Equipment.NoAvailableItems')}</option>`}
                        </select>
                    `).join('')}
                </div>
            `;
        }

        if (node.kind === 'currency') {
            return `
                <div class="equipment-currency" data-equipment-node-id="${this._escapeHtml(node.id)}">
                    ${node.count} ${this._escapeHtml(node.denomination.toUpperCase())}
                </div>
            `;
        }

        return '';
    }

    _readStartingEquipmentSelection(section, previous = null) {
        const mode = section.querySelector('input[data-equipment-mode]:checked')?.value
            || (section.querySelector('input[data-equipment-mode][value="equipment"]') ? 'equipment' : 'wealth');
        const choices = {};
        const categories = {};

        section.querySelectorAll('input[data-equipment-choice-id]:checked:not(:disabled)').forEach(input => {
            choices[input.dataset.equipmentChoiceId] = input.value;
        });
        section.querySelectorAll('select[data-equipment-category-id]:not(:disabled)').forEach(select => {
            const categoryId = select.dataset.equipmentCategoryId;
            const slot = Number(select.dataset.equipmentSlot);
            const values = categories[categoryId] ||= [];
            values[slot] = select.value;
        });

        const selection = { mode, choices, categories };
        if (Number.isFinite(previous?.wealthGp)) selection.wealthGp = previous.wealthGp;
        return selection;
    }

    _bindStartingEquipmentControls(overlay) {
        overlay.querySelectorAll('.starting-equipment-tree').forEach(section => {
            const update = () => this._updateStartingEquipmentControls(section);
            section.querySelectorAll('input[data-equipment-mode], input[data-equipment-choice-id]').forEach(input => {
                input.addEventListener('change', update);
            });
            update();
        });
    }

    _updateStartingEquipmentControls(section) {
        const panel = section.querySelector('[data-equipment-mode-panel="equipment"]');
        if (!panel) return;

        const mode = section.querySelector('input[data-equipment-mode]:checked')?.value || 'equipment';
        const equipmentActive = mode === 'equipment';
        panel.classList.toggle('is-inactive', !equipmentActive);
        panel.setAttribute('aria-hidden', String(!equipmentActive));
        panel.querySelectorAll('input, select').forEach(input => {
            input.disabled = !equipmentActive;
        });
        if (!equipmentActive) return;

        panel.querySelectorAll('[data-equipment-branch]').forEach(branch => {
            const ownRadio = branch.querySelector(':scope > .equipment-branch-choice > input[data-equipment-choice-id]');
            branch.classList.toggle('is-selected', !!ownRadio?.checked);
        });
        panel.querySelectorAll('[data-equipment-branch]:not(.is-selected) .equipment-branch-details input, [data-equipment-branch]:not(.is-selected) .equipment-branch-details select').forEach(input => {
            input.disabled = true;
        });
    }


    _cleanDescription(desc) {
        return cleanDescription(desc);
    }

    _processHtmlDescription(desc) {
        return processHtmlDescription(desc);
    }

    _escapeHtml(text) {
        if (!text) return "";
        // 转义 HTML 特殊字符用于 data-tooltip 属性
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }


    _bindTooltips(overlay) {
        return bindTooltips(overlay, this.dataManager);
    }


    _updateTooltipPosition(e, tooltip) {
        return updateTooltipPosition(e, tooltip);
    }

    /**
     * 验证向导步骤的选择
     * 
     * Adrian: 这个方法现在是异步的了，因为我得等你们在确认弹窗里点那个该死的按钮。
     * 如果你没选完就想跑，我会拦住你问一句：“你确定吗？”
     * 虽然我知道你们通常都会点“确定”，但我得尽到提醒的义务。
     * 
     * @param {HTMLElement} overlay 向导覆盖层
     * @param {Object} stepData 步骤数据
     * @returns {Promise<boolean>} 是否可以继续
     */
    async _validateWizardStep(overlay, stepData) {
        const restriction = getSpellRestriction(stepData.event || stepData);
        const selected = Array.from(overlay.querySelectorAll('.selected-spells-list .spell-card, .item-choices-list input:checked'))
            .map(element => element.dataset.uuid || element.value).filter(Boolean);
        const invalid = await findInvalidSpellSchoolSelections(selected, restriction, uuid => fromUuid(uuid));
        if (invalid.length) {
            ui.notifications.warn(`${game.i18n.localize('ORIGINATE.UI.Progression.InvalidSpellSchool')} ${spellSchoolHint(restriction)}`);
            return false;
        }
        if (stepData.type === 'choice') {
            const event = stepData.event;

            // 统一获取 section 并进行空值检查
            const sectionSelector = `.sub-section[data-idx="${stepData.idx}"]`;
            const section = overlay.querySelector(sectionSelector);

            // 检查选择数量
            if (event.type === 'trait_choice') {
                if (!section) {
                    window.OriginateLog(`Originate | Validation Error: Cannot find section with selector "${sectionSelector}"`);
                    return false;
                }
                const max = parseInt(section.dataset.count);
                const checked = section.querySelectorAll('input:checked');
                if (checked.length !== max) {
                    // 弹出确认弹窗询问是否跳过
                    const confirmed = await this._showConfirmDialog({
                        title: game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue") || "确认继续",
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Dialog.IncompleteSelection") || "您尚未完成当前步骤的选择。"}</p>
                                  <p>${game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmSkipWarning") || "确定要继续吗？这可能会导致角色数据不完整。"}</p>`,
                        yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm") || "是",
                        noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel") || "否",
                        defaultYes: false
                    });
                    return confirmed;
                }
            } else if (event.type === 'choice') {
                // Adrian: 先检查是否为法术选择
                const spellSection = overlay.querySelector('.spell-browser-section');
                if (spellSection) {
                    // 法术选择验证
                    const max = parseInt(spellSection.dataset.count) || 1;
                    const selectedCards = spellSection.querySelectorAll('.selected-spells-list .spell-card');
                    const selectedCount = selectedCards.length;

                    window.OriginateLog(`Originate | Spell validation: ${selectedCount}/${max}`);

                    if (selectedCount !== max) {
                        const confirmed = await this._showConfirmDialog({
                            title: game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue"),
                            content: `<p>${game.i18n.format("ORIGINATE.UI.Dialog.IncompleteSpellSelection", { selected: selectedCount, required: max })}</p>
                                      <p>${game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmSkipWarning")}</p>`,
                            yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm"),
                            noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel"),
                            defaultYes: false
                        });
                        return confirmed;
                    }
                    // 法术选择完成，可以继续
                    return true;
                }

                // 普通物品选择验证
                const sectionSelector2 = `.sub-section[data-idx="${stepData.idx}"]`;
                const section = overlay.querySelector(sectionSelector2);
                if (!section) {
                    window.OriginateLog(`Originate | Validation Error: Cannot find section with selector "${sectionSelector2}"`);
                    return true; // 如果找不到 section，允许继续
                }
                const max = parseInt(section.dataset.count) || 0;
                const canReplace = section.dataset.canReplace === 'true';

                // 修正选择器
                const checked = section.querySelectorAll('input[type="checkbox"]:checked');
                const replacementRadio = section.querySelector('.replacement-section input[type="radio"]:checked');
                const isReplacing = replacementRadio && replacementRadio.value !== 'none';

                let requiredCount = max;
                if (isReplacing) requiredCount = max + 1;

                if (checked.length !== requiredCount) {
                    // 弹出确认弹窗询问是否跳过
                    const confirmed = await this._showConfirmDialog({
                        title: game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue") || "确认继续",
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Dialog.IncompleteSelection") || "您尚未完成当前步骤的选择。"}</p>
                                  <p>${game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmSkipWarning") || "确定要继续吗？这可能会导致角色数据不完整。"}</p>`,
                        yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm") || "是",
                        noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel") || "否",
                        defaultYes: false
                    });
                    return confirmed;
                }
            }
            if (event.type === 'equipment') {
                if (!section) return false;
                const selection = this._readStartingEquipmentSelection(section);
                const result = resolveStartingEquipmentSelection(event, selection);
                if (result.missing.length > 0) {
                    return this._showConfirmDialog({
                        title: game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue"),
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Dialog.IncompleteSelection")}</p>
                                  <p>${game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmSkipWarning")}</p>`,
                        yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm"),
                        noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel"),
                        defaultYes: false
                    });
                }
            }
            // ASI points check
            if (event.type === 'asi' && event.points > 0) {
                const asiSection = overlay.querySelector('.asi-section');
                const remaining = parseInt(asiSection.querySelector('.asi-points-remaining').textContent);
                if (remaining !== 0) {
                    // 弹出确认弹窗询问是否跳过
                    const confirmed = await this._showConfirmDialog({
                        title: game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue") || "确认继续",
                        content: `<p>${game.i18n.localize("ORIGINATE.UI.Dialog.IncompleteASI") || "您尚未分配所有属性点。"}</p>
                                  <p>${game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmSkipWarning") || "确定要继续吗？这可能会导致角色数据不完整。"}</p>`,
                        yesLabel: game.i18n.localize("ORIGINATE.UI.Button.Confirm") || "是",
                        noLabel: game.i18n.localize("ORIGINATE.UI.Button.Cancel") || "否",
                        defaultYes: false
                    });
                    return confirmed;
                }
            }
        }
        return true;
    }

    _saveWizardStepData(overlay, stepData, context) {
        // 将当前步骤的选择保存到 context._wizardState.data 可以在 _onFinishWizard 中统一处理
        // 或者直接在这里不做处理，因为 _onFinishWizard 会重新扫描所有 steps 的数据？
        // 不，overlay 只包含当前步骤的 DOM。
        // 我们必须在每一步保存数据。

        // 简化：这里我们不做复杂的 DOM 解析保存，而是假设 _onFinishWizard 会根据保存的数据来执行。
        // 但问题是 DOM 会被移除。
        // 所以必须保存数据。

        // 我们使用一个简单的策略：在 _onFinishWizard 时，并不从 DOM 读取，而是从 _wizardState.data 读取。
        // 所以 _saveWizardStepData 必须负责将当前 DOM 的状态写入 _wizardState.data。

        // 数据结构: data[stepIndex] = { ... selections ... }
        const stepIndex = context._wizardState.currentStep;
        const data = {};

        if (stepData.type === 'choice') {
            const idx = stepData.idx;
            const event = stepData.event;
            if (event.type === 'trait_choice') {
                const checked = overlay.querySelectorAll(`input[name="trait-${idx}"]:checked`);
                data.traits = Array.from(checked).map(cb => cb.value);
            } else if (event.type === 'choice') {
                // 检测是否为法术选择
                const spellSection = overlay.querySelector('.spell-browser-section');
                if (spellSection) {
                    // 法术选择
                    const selectedSpells = [];
                    spellSection.querySelectorAll('.selected-spells-list .spell-card').forEach(card => {
                        if (card.dataset.uuid && !this.dataManager.isItemExcluded(card.dataset.uuid)) {
                            selectedSpells.push(card.dataset.uuid);
                        }
                    });
                    data.spells = selectedSpells;
                    data.isSpellChoice = true;
                    window.OriginateLog(`Originate | 保存法术选择: ${selectedSpells.length} 个法术`);
                } else {
                    // 普通物品选择
                    // 修正选择器
                    const checked = overlay.querySelectorAll(`.item-choices-list input[type="checkbox"]:checked, .feature-grid-list input[type="checkbox"]:checked`);
                    data.items = Array.from(checked).map(cb => cb.value);
                    // Replacement data...
                    const replacementRadio = overlay.querySelector(`.replacement-section input[type="radio"]:checked`);
                    if (replacementRadio && replacementRadio.value !== 'none') {
                        data.replacement = {
                            oldItemId: replacementRadio.dataset.itemId,
                            newItemUuid: checked[0]?.value // Assumes first checked is replacement
                        };
                        // Remove replacement from items list
                        if (data.items.length > 0) data.items.shift();
                    }
                }
            } else if (event.type === 'asi') {
                const values = {};
                overlay.querySelectorAll('.asi-value').forEach(span => {
                    const val = parseInt(span.textContent);
                    if (val > 0) values[span.dataset.ability] = val;
                });
                data.asi = values;
            } else if (event.type === 'size') {
                const checked = overlay.querySelector(`input[name="size-choice-${idx}"]:checked`);
                if (checked) data.size = checked.value;
            } else if (event.type === 'equipment') {
                const section = overlay.querySelector(`.sub-section[data-idx="${idx}"]`);
                if (section) {
                    const previous = context._wizardState.data?.[stepIndex]?.equipmentSelection;
                    data.equipmentSelection = this._readStartingEquipmentSelection(section, previous);
                }
            }
        } else if (stepData.type === 'knowledge_equipment') {
            const checked = overlay.querySelector(`input[name="equipment"]:checked`);
            if (checked) data.equipmentOption = parseInt(checked.value);
        } else if (stepData.type === 'knowledge_suboption') {
            const checked = overlay.querySelector(`input[name="subOption"]:checked`);
            if (checked) data.subOption = checked.value;
        }

        context._wizardState.data[stepIndex] = data;
    }

    _restoreWizardStepData(overlay, stepData, context) {
        const stepIndex = context._wizardState.currentStep;
        const data = context._wizardState.data?.[stepIndex];
        if (!data) return null;

        const setCheckedValues = (selector, values = []) => {
            const selected = new Set(values);
            overlay.querySelectorAll(selector).forEach(input => {
                input.checked = selected.has(input.value);
            });
        };

        if (stepData.type === 'choice') {
            const idx = stepData.idx;
            const event = stepData.event;

            if (event.type === 'trait_choice') {
                setCheckedValues(`input[name="trait-${idx}"]`, data.traits);
            } else if (event.type === 'choice' && !data.isSpellChoice) {
                const selectedItems = [...(data.items || [])];
                if (data.replacement?.newItemUuid) selectedItems.push(data.replacement.newItemUuid);
                setCheckedValues(
                    '.item-choices-list input[type="checkbox"], .feature-grid-list input[type="checkbox"]',
                    selectedItems
                );

                if (data.replacement?.oldItemId) {
                    overlay.querySelectorAll('.replacement-section input[type="radio"]').forEach(input => {
                        input.checked = input.dataset.itemId === data.replacement.oldItemId;
                    });
                }
            } else if (event.type === 'asi') {
                overlay.querySelectorAll('.asi-value').forEach(span => {
                    span.textContent = data.asi?.[span.dataset.ability] || 0;
                });
            } else if (event.type === 'size') {
                setCheckedValues(`input[name="size-choice-${idx}"]`, data.size ? [data.size] : []);
            } else if (event.type === 'equipment') {
                const selection = data.equipmentSelection;
                if (selection) {
                    overlay.querySelectorAll('input[data-equipment-mode]').forEach(input => {
                        input.checked = input.value === selection.mode;
                    });
                    overlay.querySelectorAll('input[data-equipment-choice-id]').forEach(input => {
                        const savedValue = selection.choices?.[input.dataset.equipmentChoiceId];
                        if (savedValue !== undefined) input.checked = savedValue === input.value;
                    });
                    overlay.querySelectorAll('select[data-equipment-category-id]').forEach(select => {
                        const values = selection.categories?.[select.dataset.equipmentCategoryId] || [];
                        const savedValue = values[Number(select.dataset.equipmentSlot)];
                        if (savedValue !== undefined) select.value = savedValue;
                    });
                }
            }
        } else if (stepData.type === 'knowledge_equipment') {
            setCheckedValues(
                'input[name="equipment"]',
                data.equipmentOption === undefined ? [] : [String(data.equipmentOption)]
            );
        } else if (stepData.type === 'knowledge_suboption') {
            setCheckedValues('input[name="subOption"]', data.subOption ? [data.subOption] : []);
        }

        return data;
    }

    _resolveWizardSourceLevel(stepType, event = null, fallbackLevel = null) {
        const candidates = [
            event?.sourceLevel,
            event?._original?.level,
            event?.level,
            fallbackLevel
        ];

        for (const candidate of candidates) {
            if (candidate === null || candidate === undefined) continue;
            if (typeof candidate === 'string' && candidate.trim() === '') continue;

            const level = Number(candidate);
            if (Number.isFinite(level)) return level;
        }

        if (stepType === 'race' || stepType === 'background') return 0;
        return 1;
    }

    async _rollStartingEquipmentWealth(formula) {
        const roll = new Roll(String(formula));
        await roll.evaluate();
        const total = Number(roll.total);
        if (!Number.isFinite(total)) {
            throw new Error('Originate | 起始资金公式没有得到有效结果: ' + formula);
        }
        return Math.max(0, Math.floor(total));
    }

    async _applyStartingEquipmentSelection(currentBlueprint, event, selection = {}) {
        const result = resolveStartingEquipmentSelection(event, selection);
        if (result.missing.length > 0) {
            window.OriginateLog('Originate | 起始装备选择不完整，按用户确认保留已选部分:', result.missing);
        }

        for (const item of result.items) {
            const document = await this.dataManager.getDocument(item.uuid);
            if (!document) {
                console.warn('Originate | 找不到起始装备物品: ' + item.uuid);
                continue;
            }

            const itemData = document.toObject();
            stampSourceTracking(itemData, item.uuid);
            if (item.count > 1) {
                foundry.utils.setProperty(itemData, 'system.quantity', item.count);
            }
            currentBlueprint.items.push(itemData);
        }

        for (const currency of result.currencies) {
            const key = 'currency.' + currency.denomination;
            currentBlueprint.system[key] = (currentBlueprint.system[key] || 0) + currency.count;
        }

        if (result.wealth) {
            const savedWealth = Number(selection.wealthGp);
            const hasSavedWealth = selection.wealthGp !== null
                && selection.wealthGp !== undefined
                && Number.isFinite(savedWealth);
            const amount = hasSavedWealth
                ? Math.max(0, Math.floor(savedWealth))
                : await this._rollStartingEquipmentWealth(result.wealth.formula);
            selection.wealthGp = amount;

            const key = 'currency.' + (result.wealth.denomination || 'gp');
            currentBlueprint.system[key] = (currentBlueprint.system[key] || 0) + amount;
        }

        return result;
    }

    async _onFinishWizard(context) {
        const overlay = this.element.querySelector('.originate-sub-interface');
        const stepType = context.type;

        // 初始化 blueprintData (如果尚未初始化)
        if (!this.blueprintData[stepType]) {
            this.blueprintData[stepType] = { items: [], system: {} };
        }
        const currentBlueprint = this.blueprintData[stepType];
        const getWizardSpellSourceClass = () =>
            this.context.classIdentifier
            || currentBlueprint.items?.find(i => i.type === 'class')?.system?.identifier
            || this.blueprintData.class?.items?.find(i => i.type === 'class')?.system?.identifier
            || null;

        // 收集专精事件
        if (context.expertiseEvents && context.expertiseEvents.length > 0) {
            window.OriginateLog(`Originate | 收集到 ${context.expertiseEvents.length} 个专精事件`);
            const expertiseEvents = context.expertiseEvents.map(event => ({
                ...event,
                stepType: event.stepType || stepType,
                sourceLevel: this._resolveWizardSourceLevel(stepType, event)
            }));
            this.blueprintData.pendingExpertise.push(...expertiseEvents);
        }

        // 【关键修复】先设置标识符，确保 _applyFeatureType 能正确获取
        // 这必须在处理任何特性之前完成
        if (!context._wizardState.identifierSet) {
            let optionId = context.option.id;
            if (!optionId && context.option.uuid) {
                const uuidParts = context.option.uuid.split('.');
                optionId = uuidParts[uuidParts.length - 1];
            }
            if (!optionId) optionId = context.option.name;

            // 获取标识符 - 优先从选项数据获取，其次从配置获取，最后生成
            let identifier = context.option.identifier;
            if (!identifier) {
                // 尝试从配置中获取
                const configData = game.settings.get('character-forge', 'data');
                const configKey = stepType === 'class' ? 'classs' : (stepType + 's');
                const itemConfig = configData[configKey]?.[optionId];
                if (itemConfig?.identifier) {
                    identifier = itemConfig.identifier;
                }
            }
            if (!identifier) {
                // 尝试从主物品文档获取
                const mainItemDoc = await this.dataManager.getDocument(context.option.uuid);
                if (mainItemDoc?.system?.identifier) {
                    identifier = mainItemDoc.system.identifier;
                }
            }
            if (!identifier) {
                // 最后回退：从名称生成
                identifier = context.option.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            }

            // 【关键】立即设置到 context 中，确保后续 _applyFeatureType 能使用
            if (stepType !== 'subclass') {
                this.context[stepType] = optionId;
                this.context[`${stepType}Name`] = context.option.name;
                this.context[`${stepType}Identifier`] = identifier;
            } else {
                this.context.subclass = optionId;
                this.context.subclassName = context.option.name;
                this.context.subclassIdentifier = identifier;
                // 子职特性归类为职业特性，需要确保 classIdentifier 存在
                if (!this.context.classIdentifier && this.context.class) {
                    const configData = game.settings.get('character-forge', 'data');
                    const classConfig = configData.classs?.[this.context.class];
                    if (classConfig?.identifier) {
                        this.context.classIdentifier = classConfig.identifier;
                    }
                }
            }

            window.OriginateLog(`Originate | _onFinishWizard: 设置标识符 ${stepType}Identifier = ${identifier}`);
            context._wizardState.identifierSet = true;
        }

        // 1. 获取主 Item (只处理一次)
        if (!context._wizardState.initialProcessed) {
            const mainItemDoc = await this.dataManager.getDocument(context.option.uuid);
            if (mainItemDoc) {
                const mainItemData = mainItemDoc.toObject();
                if (context.option.uuid) {
                    stampSourceTracking(mainItemData, context.option.uuid);
                }
                this._stampCharacterFinalizeItemMeta?.(mainItemData, {
                    sourceUuid: context.option.uuid,
                    level: this._resolveWizardSourceLevel(stepType, null),
                    stepType,
                    isSubclass: stepType === 'subclass'
                });
                currentBlueprint.items.push(mainItemData);
            }

            // 处理步骤 0 (固定特性)
            const steps = context._wizardState.steps;
            if (steps[0] && steps[0].type === 'fixed') {
                for (const event of steps[0].events) {
                    if (event.type === 'features' || event.type === 'folder_features') {
                        const items = event.type === 'features' ? event.displayItems : event.items;
                        for (const item of items) {
                            const doc = await this.dataManager.getDocument(item.uuid);
                            if (doc) {
                                const itemData = doc.toObject();

                                // 【修复】保留源 UUID
                                if (item.uuid) {
                                    stampSourceTracking(itemData, item.uuid);
                                }

                                // 【修复】标记来源 - 优先使用 event.id（DataManager 转换时添加），其次是 _original._id
                                const advOrigin = event.id || event._original?._id || event.title;
                                foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advOrigin);
                                const sourceLevel = this._resolveWizardSourceLevel(stepType, event);
                                foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", sourceLevel);
                                this._stampCharacterFinalizeItemMeta?.(itemData, {
                                    sourceUuid: item.uuid,
                                    advancementId: advOrigin,
                                    level: sourceLevel,
                                    stepType
                                });

                                // 法术配置处理
                                const isSpell = doc.type === 'spell' || item.itemType === 'spell';
                                if (isSpell) {
                                    const spellConfig = event.spellConfig || event._original?.configuration?.spell;
                                    const spellSourceClass = getWizardSpellSourceClass();
                                    if (spellConfig) {
                                        applySpellConfigToItemData(itemData, spellConfig, {
                                            sourceUuid: item.uuid,
                                            sourceClass: spellSourceClass
                                        });
                                    } else {
                                        normalizeSpellItemData(itemData, {
                                            sourceUuid: item.uuid,
                                            sourceClass: spellSourceClass
                                        });
                                    }
                                }

                                this._applyFeatureType(itemData, stepType);
                                currentBlueprint.items.push(itemData);

                                // 【新增】检查并处理嵌套的 Advancement (自动获得部分)
                                // 注意：这里我们只处理自动获得的，因为步骤 0 是固定特性
                                // 如果有需要选择的，理论上应该在 _renderFullSubInterface 初始化时就发现
                                // 但为了保险，我们可以在这里检查
                                const nestedSteps = await this._checkNestedAdvancements(itemData, stepType);
                                if (nestedSteps.length > 0) {
                                    window.OriginateLog(`Originate | 步骤 0 发现 ${nestedSteps.length} 个嵌套步骤`);
                                    // 将新步骤添加到向导状态
                                    const startIndex = context._wizardState.steps.length;
                                    nestedSteps.forEach((step, idx) => {
                                        step.idx = startIndex + idx;
                                        context._wizardState.steps.push(step);
                                    });
                                }
                            }
                        }
                    } else if (event.type === 'hp') {
                        let hitDie = 8;
                        if (event.denomination) {
                            const match = String(event.denomination).match(/d?(\d+)/i);
                            if (match) hitDie = parseInt(match[1]);
                        }
                        currentBlueprint.hitDie = hitDie;
                        if (stepType === 'class') this.blueprintData.class.hitDie = hitDie;
                    } else if (event.type === 'trait_grant') {
                        event.grants.forEach(key => this._applyTraitToUpdate(key, currentBlueprint.system));
                    } else if (event.type === 'size') {
                        currentBlueprint.system['traits.size'] = Array.from(event.size)[0];
                    } else if (event.type === 'asi' && event.fixed) {
                        for (const [ability, value] of Object.entries(event.fixed)) {
                            const key = `abilities.${ability}.value`;
                            const baseValue = currentBlueprint.system[key] !== undefined
                                ? currentBlueprint.system[key]
                                : (this.actor.system.abilities[ability]?.value || 10);
                            currentBlueprint.system[key] = baseValue + value;
                        }
                    }
                }
            }

            context._wizardState.initialProcessed = true;
        }

        // 2. 处理选择步骤 (增量处理)
        const wizardData = context._wizardState.data;
        const steps = context._wizardState.steps;
        const newSteps = [];

        // 确定起始处理索引
        if (!context._wizardState.processedCount) context._wizardState.processedCount = 1; // 跳过步骤 0
        const startIndex = context._wizardState.processedCount;
        const currentStepsLength = steps.length;

        for (let i = startIndex; i < currentStepsLength; i++) {
            const step = steps[i];
            const data = wizardData[i];
            if (!data) continue;

            if (step.type === 'choice') {
                if (data.traits) {
                    const advancementId = step.event?._original?._id || step.event?.id || step.event?.title || null;
                    const sourceLevel = this._resolveWizardSourceLevel(stepType, step.event);
                    const mode = step.event?.mode || 'default';
                    data.traits.forEach(key => {
                        this._applyTraitToUpdate(key, currentBlueprint.system, mode);
                        this._recordCharacterTraitChange?.({
                            key,
                            advancementId,
                            level: sourceLevel,
                            stepType,
                            mode,
                            parentFeature: step.parentFeature || step.parentFeat || null,
                            parentSourceUuid: step.parentSourceUuid || null
                        });
                    });
                }
                // 法术选择处理
                if (data.spells && data.spells.length > 0) {
                    window.OriginateLog(`Originate | 处理法术选择: ${data.spells.length} 个法术`);
                    const spellConfig = step.event?.spellConfig || step.event?._original?.configuration?.spell;
                    const advOrigin = step.event?._original?._id || step.event?.id || step.event?.title;

                    for (const uuid of data.spells) {
                        const doc = await this.dataManager.getDocument(uuid);
                        if (doc) {
                            const itemData = doc.toObject();
                            stampSourceTracking(itemData, uuid);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advOrigin);
                            const sourceLevel = this._resolveWizardSourceLevel(stepType, step.event);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", sourceLevel);
                            this._stampCharacterFinalizeItemMeta?.(itemData, {
                                sourceUuid: uuid,
                                advancementId: advOrigin,
                                level: sourceLevel,
                                stepType,
                                parentFeature: step.parentFeature || step.parentFeat || null,
                                parentSourceUuid: step.parentSourceUuid || null
                            });

                            // 设置法术来源职业（用于准备法术计数）
                            const spellSourceClass = getWizardSpellSourceClass();
                            if (spellSourceClass && itemData.type === 'spell') {
                                foundry.utils.setProperty(itemData, "system.sourceClass", spellSourceClass);
                            }

                            if (spellConfig) {
                                applySpellConfigToItemData(itemData, spellConfig, {
                                    sourceUuid: uuid,
                                    sourceClass: spellSourceClass
                                });
                            } else {
                                normalizeSpellItemData(itemData, {
                                    sourceUuid: uuid,
                                    sourceClass: spellSourceClass
                                });
                            }

                            currentBlueprint.items.push(itemData);
                            window.OriginateLog(`Originate | 添加法术到 blueprint: ${itemData.name}`);
                        }
                    }
                }
                if (data.items) {
                    for (const uuid of data.items) {
                        const doc = await this.dataManager.getDocument(uuid);
                        if (doc) {
                            const itemData = doc.toObject();

                            // 【修复】保留源 UUID
                            if (uuid) {
                                stampSourceTracking(itemData, uuid);
                            }

                            // 标记来源
                            const advOrigin = step.event._original?._id || step.event.id || step.event._uid || step.event.title;
                            window.OriginateLog(`[Originate Debug] Setting advancementOrigin for ${itemData.name}: ${advOrigin} (Event ID: ${step.event.id}, Original ID: ${step.event._original?._id})`);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.advancementOrigin", advOrigin);
                            const sourceLevel = this._resolveWizardSourceLevel(stepType, step.event);
                            foundry.utils.setProperty(itemData, "flags.hero-genesis.acquiredAt", sourceLevel);
                            this._stampCharacterFinalizeItemMeta?.(itemData, {
                                sourceUuid: uuid,
                                advancementId: advOrigin,
                                level: sourceLevel,
                                stepType,
                                parentFeature: step.parentFeature || step.parentFeat || null,
                                parentSourceUuid: step.parentSourceUuid || null
                            });

                            if (itemData.type === 'spell') {
                                normalizeSpellItemData(itemData, {
                                    sourceUuid: uuid,
                                    sourceClass: getWizardSpellSourceClass()
                                });
                            }

                            this._applyFeatureType(itemData, stepType);
                            currentBlueprint.items.push(itemData);

                            // 【新增】检查并处理嵌套的 Advancement
                            const nestedSteps = await this._checkNestedAdvancements(itemData, stepType);
                            if (nestedSteps.length > 0) {
                                newSteps.push(...nestedSteps);
                            }
                        }
                    }
                }
                if (data.asi) {
                    for (const [ability, val] of Object.entries(data.asi)) {
                        const key = `abilities.${ability}.value`;
                        const baseValue = currentBlueprint.system[key] !== undefined
                            ? currentBlueprint.system[key]
                            : (this.actor.system.abilities[ability]?.value || 10);
                        currentBlueprint.system[key] = baseValue + val;
                    }
                }
                if (data.size) {
                    currentBlueprint.system['traits.size'] = data.size;
                }
                if (data.equipmentSelection) {
                    await this._applyStartingEquipmentSelection(
                        currentBlueprint,
                        step.event,
                        data.equipmentSelection
                    );
                }
            } else if (step.type === 'knowledge_equipment') {
                // ... logic for knowledge equipment ...
            }
        }

        // 更新已处理计数
        context._wizardState.processedCount = currentStepsLength;

        // 如果有新的嵌套步骤，追加并重新渲染
        if (newSteps.length > 0) {
            window.OriginateLog(`Originate | 发现 ${newSteps.length} 个嵌套步骤，追加到向导`);

            const startIndex = context._wizardState.steps.length;
            newSteps.forEach((step, idx) => {
                step.idx = startIndex + idx;
                context._wizardState.steps.push(step);
            });

            // 移动到第一个新步骤
            context._wizardState.currentStep = startIndex;

            // 重新渲染向导
            this._renderWizardStep(overlay, context);

            // 提示用户
            ui.notifications.info(game.i18n.localize("ORIGINATE.Notification.NewOptionsAvailable"));

            return; // 中断完成流程
        }


        // 移除 tooltip
        if (context.onComplete) await context.onComplete();
        else if (this._isCreationWizardContext?.(context)) await this._advanceCreationMainStep();
        else await this._onNextStep();

        if (!context.keepOverlayAfterComplete && overlay?.isConnected) {
            overlay.remove();
        }
        if (!context.keepOverlayAfterComplete && this._activeSubInterfaceContext === context) {
            this._activeSubInterfaceContext = null;
        }

        const tooltip = document.querySelector('.originate-tooltip');
        if (tooltip) tooltip.remove();
    }

    /**
     * 检查物品是否有嵌套的 Advancement
     * 
     * Adrian: 这是专长解析的核心逻辑，也是我最头疼的地方。
     * 像“技艺专家”这种专长，简直就是套娃！
     * 它里面塞了一个属性提升、一个技能熟练还有一个技能专精。
     * 我得像剥洋葱一样把它们一个个剥出来，再变成向导步骤塞给你们。
     * 如果这里出错了，那一定是系统的数据结构太反人类了，绝对不是我的锅。
     * 
     * @param {Object} itemData 物品数据
     * @param {string} stepType 步骤类型
     * @returns {Promise<Array>} 新的步骤列表
     */
    async _checkNestedAdvancements(itemData, stepType) {
        const newSteps = [];
        const sourceLevel = this._resolveWizardSourceLevel(stepType, null, itemData.flags?.['hero-genesis']?.acquiredAt);
        const parentSourceUuid = resolveItemSourceUuid(itemData) || itemData?._sourceUuid || itemData?.uuid || null;
        const classIdentifier = this.context?.classIdentifier
            || this.blueprintData?.class?.items?.find(item => item?.type === 'class')?.system?.identifier
            || null;
        const featureCantripStep = SpellRules.generateFeatureCantripStep(itemData, {
            classIdentifier,
            level: sourceLevel,
            stepType,
            sourceUuid: parentSourceUuid,
            parentFeature: itemData?.name,
            parentSourceUuid
        });

        if (featureCantripStep) {
            newSteps.push({
                ...featureCantripStep,
                type: 'choice',
                event: {
                    ...featureCantripStep.event,
                    sourceLevel
                },
                parentFeat: itemData?.name
            });
        }

        let events = [];
        if (itemData.uuid && this.dataManager?.getNestedAdvancementEvents) {
            events = await this.dataManager.getNestedAdvancementEvents(itemData.uuid, sourceLevel);
            if (events.length > 0) {
                window.OriginateLog(`Originate | 读取 ${itemData.name} 的嵌套 Advancement: ${events.length} 个 (level=${sourceLevel})`);
                await this.dataManager.enrichOptions(events);
            }
        }

        if (events.length === 0 && itemData.hasNestedAdvancement && itemData.nestedAdvancements && itemData.nestedAdvancements.length > 0) {
            events = foundry.utils.deepClone(itemData.nestedAdvancements);
            window.OriginateLog(`Originate | 使用预加载的嵌套 Advancement: ${itemData.name} (${events.length} 个)`);
        }

        if (events.length === 0) return newSteps;

        // 处理事件
        for (const event of events) {
            event.sourceLevel = event.sourceLevel ?? this._resolveWizardSourceLevel(stepType, event, itemData.flags?.['hero-genesis']?.acquiredAt);
            if (event.type === 'features') {
                // 自动获得的特性：直接添加到 blueprint，并递归检查
                for (const item of event.items) {
                    const doc = await this.dataManager.getDocument(item.uuid);
                    if (doc) {
                        const newItemData = doc.toObject();

                        // 【修复】保留源 UUID
                        if (item.uuid) {
                            stampSourceTracking(newItemData, item.uuid);
                        }

                        const advancementId = event._original?._id || event.id || event.title;
                        const nestedSourceLevel = this._resolveWizardSourceLevel(stepType, event, itemData.flags?.['hero-genesis']?.acquiredAt);
                        foundry.utils.setProperty(newItemData, "flags.hero-genesis.advancementOrigin", advancementId);
                        foundry.utils.setProperty(newItemData, "flags.hero-genesis.acquiredAt", nestedSourceLevel);
                        this._stampCharacterFinalizeItemMeta?.(newItemData, {
                            sourceUuid: item.uuid,
                            advancementId,
                            level: nestedSourceLevel,
                            stepType,
                            parentFeature: itemData.name,
                            parentSourceUuid
                        });

                        if (newItemData.type === 'spell') {
                            const spellConfig = event.spellConfig || event._original?.configuration?.spell;
                            const spellSourceClass = this.context.classIdentifier
                                || this.blueprintData.class?.items?.find(i => i.type === 'class')?.system?.identifier
                                || null;

                            if (spellConfig) {
                                applySpellConfigToItemData(newItemData, spellConfig, {
                                    sourceUuid: item.uuid,
                                    sourceClass: spellSourceClass
                                });
                            } else {
                                normalizeSpellItemData(newItemData, {
                                    sourceUuid: item.uuid,
                                    sourceClass: spellSourceClass
                                });
                            }
                        }

                        this._applyFeatureType(newItemData, stepType);
                        this.blueprintData[stepType].items.push(newItemData);

                        // 递归检查
                        const nested = await this._checkNestedAdvancements(newItemData, stepType);
                        newSteps.push(...nested);
                    }
                }
            } else if (event.type === 'asi') {
                // ASI 选择
                newSteps.push({
                    type: 'choice',
                    title: `${itemData.name}: ${event.title || game.i18n.localize('ORIGINATE.Advancement.ASI')}`,
                    event: event,
                    parentFeat: itemData.name,
                    parentSourceUuid
                });
            } else if (event.type === 'trait_choice') {
                // 特质选择
                newSteps.push({
                    type: 'choice',
                    title: `${itemData.name}: ${event.title || game.i18n.localize('ORIGINATE.Advancement.TraitChoice')}`,
                    event: event,
                    parentFeat: itemData.name,
                    parentSourceUuid
                });
            } else if (['choice', 'equipment', 'size'].includes(event.type)) {
                // 需要选择的特性：转换为步骤
                newSteps.push({
                    type: 'choice',
                    title: `${itemData.name}: ${event.title}`,
                    event: event,
                    parentFeat: itemData.name,
                    parentSourceUuid
                });
            } else if (event.type === 'trait_grant') {
                // 自动获得的特质
                event.grants.forEach(key => this._applyTraitToUpdate(key, this.blueprintData[stepType].system));
            }
        }

        return newSteps;
    }


    _traverseLanguageTree(langObj, results, parentKey = '') {
        return traverseLanguageTree(langObj, results);
    }

    _findLanguageLabel(langKey, langObj) {
        return findLanguageLabel(langKey, langObj);
    }

    /**
     * 判断是否是语言类别而非具体语言
     * 
     * Adrian: 这是一个玄学函数。我得猜这个节点到底是一个可以选的语言，
     * 还是一个只是用来装语言的篮子。
     * 如果我猜错了，你们要么选到一个叫“标准语言”的奇怪语言，
     * 要么就发现费伦语言全失踪了。
     * 
     * @param {string} key 键名
     * @param {string} label 显示名称
     * @returns {boolean}
     */
    _isLikelyLanguageCategory(key, label) {
        const languageCategoryKeywords = [
            'standard', 'exotic', 'rare', 'primordial', 'regional',
            'languages', 'selectable', 'faerun', 'dragonlance', 'undercommon',
            '标准', '异域', '稀有', '原初', '地区', '语言', '可选', '费伦', '龙枪', '幽暗地域'
        ];

        const keyLower = (key || '').toLowerCase();
        const labelLower = (label || '').toLowerCase();

        // 排除具体的通用语 (Common) 被误判
        if (keyLower === 'common' || labelLower === 'common' || label === '通用语') return false;

        // 1. 检查 label 是否包含明确的类别标识
        if (labelLower.includes('languages') || labelLower.includes('语言')) return true;
        if (labelLower.includes('dialects') || labelLower.includes('方言')) return true;

        // 2. 检查 key 是否完全匹配关键词
        if (languageCategoryKeywords.includes(keyLower)) return true;

        // 3. 检查 label 是否完全匹配关键词
        if (languageCategoryKeywords.includes(labelLower)) return true;

        // 4. 特殊检查：key 包含关键词且看起来像组合词
        for (const keyword of languageCategoryKeywords) {
            if (keyLower.includes(keyword)) {
                // 如果 key 就是关键词本身，或者是 keyword_xxx, xxx_keyword 格式
                if (keyLower === keyword) return true;
                if (keyLower.startsWith(keyword + '_') || keyLower.startsWith(keyword + '-')) return true;
                if (keyLower.endsWith('_' + keyword) || keyLower.endsWith('-' + keyword)) return true;
            }
        }

        return false;
    }

    _expandWildcardPool(poolArray) {
        return expandWildcardPool(poolArray);
    }

    /**
     * 检查工具是否属于特定类别
     * @param {string} toolKey 工具 key
     * @param {string} category 类别 (art, music, game, etc.)
     * @returns {boolean}
     */
    _isToolInCategory(toolKey, category) {
        // 工匠工具类别映射
        const artisanTools = [
            'alchemist', 'brewer', 'calligrapher', 'carpenter', 'cartographer',
            'cobbler', 'cook', 'glassblower', 'jeweler', 'leatherworker',
            'mason', 'painter', 'potter', 'smith', 'tinker', 'weaver', 'woodcarver'
        ];

        // 乐器类别
        const musicalInstruments = [
            'bagpipes', 'drum', 'dulcimer', 'flute', 'horn', 'lute', 'lyre',
            'panflute', 'shawm', 'viol'
        ];

        // 游戏工具
        const gamingSets = [
            'chess', 'dice', 'card', 'dragonchess', 'playingcard', 'threedragon'
        ];

        const checkMatch = (key, list) => {
            const lowerKey = key.toLowerCase();

            // 显式排除常见的魔法物品关键词和特定物品
            const excludeTerms = [
                'magic', 'wand', 'scroll', 'figurine', 'deck',
                'horn_of_valhalla', 'horn_of_blasting',
                'pipes_of_haunting', 'pipes_of_the_sewers',
                'instrument_of_the_bards'
            ];
            if (excludeTerms.some(term => lowerKey.includes(term))) return false;

            return list.some(t => {
                // 完全匹配
                if (lowerKey === t) return true;

                // 单词边界匹配 (兼容 snake_case 或 kebab-case)
                // 匹配以下情况：
                // 1. key 以 t_ 开头 (例如 "horn_tool")
                // 2. key 以 _t 结尾 (例如 "long_horn" - 虽然这可能不应该匹配，但在 DND key 中通常没问题)
                // 3. key 包含 _t_ (例如 "my_horn_tool")
                // 使用正则确保匹配的是完整单词
                const regex = new RegExp(`(^|_|-)${t}(_|-|$)`);
                return regex.test(lowerKey);
            });
        };

        if (category === 'art' || category === 'artisan') {
            return checkMatch(toolKey, artisanTools);
        } else if (category === 'music' || category === 'musical') {
            return checkMatch(toolKey, musicalInstruments);
        } else if (category === 'game' || category === 'gaming') {
            return checkMatch(toolKey, gamingSets);
        }

        return false;
    }

    /**
     * 获取工具的本地化标签
     * @param {string} toolKey 工具 key
     * @returns {string} 本地化标签
     */
    _getToolLabel(toolKey) {
        // 策略调整：优先使用本地映射（因为我们有完整的中文翻译），其次是系统翻译

        // 1. 尝试使用本地映射
        const mappedLabel = getToolLabel(toolKey);
        if (mappedLabel && /[^\x00-\x7F]/.test(mappedLabel)) {
            return mappedLabel;
        }

        // 2. 尝试从 CONFIG.DND5E.toolProficiencies 的 children 中获取
        const toolProfs = CONFIG.DND5E.toolProficiencies || {};
        for (const [category, config] of Object.entries(toolProfs)) {
            if (config.children && config.children[toolKey]) {
                const label = config.children[toolKey];
                const labelStr = typeof label === 'string' ? label : (label.label || toolKey);
                // 如果系统配置是中文，直接使用
                if (/[^\x00-\x7F]/.test(labelStr)) return labelStr;
            }
        }

        // 3. 尝试从 CONFIG.DND5E.tools 获取
        const tools = CONFIG.DND5E.tools || {};
        if (tools[toolKey]) {
            const config = tools[toolKey];
            const labelStr = typeof config === 'string' ? config : (config.label || toolKey);
            // 如果系统配置是中文，直接使用
            if (/[^\x00-\x7F]/.test(labelStr)) return labelStr;
        }

        // 4. 如果都没有中文，回退到系统英文标签
        for (const [category, config] of Object.entries(toolProfs)) {
            if (config.children && config.children[toolKey]) {
                const label = config.children[toolKey];
                const labelStr = typeof label === 'string' ? label : (label.label || toolKey);
                if (labelStr !== toolKey) return labelStr;
            }
        }
        if (tools[toolKey]) {
            const config = tools[toolKey];
            const labelStr = typeof config === 'string' ? config : (config.label || toolKey);
            if (labelStr !== toolKey) return labelStr;
        }

        // 5. 如果系统只返回 Key，尝试本地英文映射
        if (mappedLabel) return mappedLabel;

        // 6. 最后回退：格式化 key
        return toolKey.charAt(0).toUpperCase() + toolKey.slice(1).replace(/([A-Z])/g, ' $1');
    }

    /**
     * 获取特质标签数组
     * @param {Array} poolArray 特质 key 数组
     * @returns {Array} 标签数组
     */
    _getTraitLabels(poolArray) {
        return poolArray.map(key => this._getTraitLabel(key));
    }

    _getTraitLabel(key) {
        return getTraitLabel(key);
    }

    _bindASIControls(overlay) {
        overlay.querySelectorAll('.asi-section').forEach(section => {
            const maxPoints = parseInt(section.dataset.points);
            const cap = parseInt(section.dataset.cap) || 2;
            // 获取锁定的属性列表
            const lockedStr = section.dataset.locked || '';
            const lockedAbilities = lockedStr ? lockedStr.split(',').filter(s => s) : [];

            // 禁用锁定的属性 - 支持新旧两种布局
            lockedAbilities.forEach(ab => {
                // 新布局: .asi-card
                const cardDiv = section.querySelector(`.asi-card[data-ability="${ab}"]`);
                if (cardDiv) {
                    cardDiv.classList.add('locked');
                    cardDiv.querySelector('.asi-increase')?.setAttribute('disabled', 'true');
                    cardDiv.querySelector('.asi-decrease')?.setAttribute('disabled', 'true');
                }
                // 旧布局: .asi-choice (保持兼容)
                const choiceDiv = section.querySelector(`.asi-choice[data-ability="${ab}"]`);
                if (choiceDiv) {
                    choiceDiv.classList.add('locked');
                    choiceDiv.querySelector('.asi-increase')?.setAttribute('disabled', 'true');
                    choiceDiv.querySelector('.asi-decrease')?.setAttribute('disabled', 'true');
                }
            });

            // 获取所有属性的当前分配值
            const getUsedPoints = () => {
                let total = 0;
                section.querySelectorAll('.asi-value').forEach(span => {
                    total += parseInt(span.textContent) || 0;
                });
                return total;
            };

            // 更新剩余点数显示
            const updateRemaining = () => {
                const usedPoints = getUsedPoints();
                const remaining = maxPoints - usedPoints;
                const remainingSpan = section.querySelector('.asi-points-remaining');
                if (remainingSpan) {
                    remainingSpan.textContent = remaining;
                    remainingSpan.style.color = remaining === 0 ? '#4caf50' : (remaining < 0 ? '#f44336' : '');
                }
            };

            // 更新调整值显示的辅助函数（新布局专用）
            const updateModifierDisplay = (ability, addedValue) => {
                const card = section.querySelector(`.asi-card[data-ability="${ability}"]`);
                if (!card) return;

                // 获取当前基础值（从 HTML 中解析）
                const currentValueText = card.querySelector('.ability-current-value')?.textContent;
                if (!currentValueText) return;

                const baseValue = parseInt(currentValueText.split(': ')[1]) || 8;
                const totalValue = baseValue + addedValue;

                const mod = Math.floor((totalValue - 10) / 2);
                const modDisplay = card.querySelector('.ability-modifier');
                if (modDisplay) {
                    modDisplay.textContent = mod >= 0 ? `+${mod}` : mod;
                    modDisplay.classList.remove('positive', 'negative', 'neutral');
                    if (mod > 0) modDisplay.classList.add('positive');
                    else if (mod < 0) modDisplay.classList.add('negative');
                    else modDisplay.classList.add('neutral');
                }
            };

            // 绑定增减按钮
            section.querySelectorAll('.asi-increase').forEach(btn => {
                btn.addEventListener('click', () => {
                    const ability = btn.dataset.ability;

                    // 检查是否被锁定
                    if (lockedAbilities.includes(ability)) {
                        ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.AbilityLockedWarn", { ability: ability.toUpperCase() }));
                        return;
                    }

                    const valueSpan = section.querySelector(`.asi-value[data-ability="${ability}"]`);
                    const currentValue = parseInt(valueSpan.textContent) || 0;

                    // 检查是否还有剩余点数
                    if (getUsedPoints() >= maxPoints) {
                        ui.notifications.warn(game.i18n.localize("ORIGINATE.UI.Progression.NoPointsWarn"));
                        return;
                    }

                    // 单个属性最多 +cap (通常是 2)
                    if (currentValue >= cap) {
                        ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.MaxPerAbilityWarn", { cap: cap }));
                        return;
                    }

                    const newValue = currentValue + 1;
                    valueSpan.textContent = newValue;
                    updateRemaining();
                    updateModifierDisplay(ability, newValue);
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
                });
            });

            // 回到这一步时数值已经从草稿灌回 DOM，这里顺手把派生显示也对齐。
            updateRemaining();
            section.querySelectorAll('.asi-value').forEach(span => {
                updateModifierDisplay(span.dataset.ability, parseInt(span.textContent) || 0);
            });
        });
    }

    _bindCheckboxLimits(overlay) {
        // 特质选择限制 (技能、语言等)
        overlay.querySelectorAll('.sub-section[data-type="trait-choice"]').forEach(section => {
            const max = parseInt(section.dataset.count);
            const checkboxes = section.querySelectorAll('input[type="checkbox"]');

            // 单选优化：如果 max === 1，实现点击其他项目直接切换的行为
            if (max === 1) {
                checkboxes.forEach(cb => {
                    cb.addEventListener('change', () => {
                        if (cb.checked) {
                            // 取消其他所有选中的项
                            checkboxes.forEach(other => {
                                if (other !== cb && other.checked) {
                                    other.checked = false;
                                }
                            });
                        }
                    });
                });
            } else {
                // 多选限制
                checkboxes.forEach(cb => {
                    cb.addEventListener('change', () => {
                        const checked = section.querySelectorAll('input[type="checkbox"]:checked').length;
                        if (checked > max) {
                            cb.checked = false;
                            ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.MaxSelectWarn", { count: max }));
                        }
                    });
                });
            }
        });

        // 物品选择限制（支持替换）
        overlay.querySelectorAll('.sub-section[data-type="item-choice"]').forEach(section => {
            const baseMax = parseInt(section.dataset.count) || 0;
            const canReplace = section.dataset.canReplace === 'true';
            const isPureReplacement = section.dataset.pureReplacement === 'true';
            // 支持 .item-choices-list 和 .feature-grid-list（紧凑视图）
            const checkboxes = section.querySelectorAll('.item-choices-list input[type="checkbox"], .feature-grid-list input[type="checkbox"]');
            const replacementRadios = section.querySelectorAll('.replacement-section input[type="radio"]');
            const replacementTargetList = section.querySelector('.replacement-target-list');

            if (isPureReplacement) {
                // 纯替换模式：当选择要替换的物品时，显示新物品选择列表
                replacementRadios.forEach(radio => {
                    radio.addEventListener('change', () => {
                        const isReplacing = radio.value !== 'skip';
                        if (replacementTargetList) {
                            replacementTargetList.style.display = isReplacing ? 'block' : 'none';
                        }
                    });
                });
            } else {
                // 选择+可替换模式
                // 计算当前允许的最大选择数
                const getAllowedMax = () => {
                    if (!canReplace) return baseMax;
                    // 检查是否选择了替换模式
                    const selectedReplacement = section.querySelector('.replacement-section input[type="radio"]:checked');
                    if (selectedReplacement && selectedReplacement.value !== 'none') {
                        // 选择了替换，允许额外选择 1 个
                        return baseMax + 1;
                    }
                    return baseMax;
                };

                // 绑定替换模式切换
                replacementRadios.forEach(radio => {
                    radio.addEventListener('change', () => {
                        const isReplacing = radio.value !== 'none';
                        // 更新选择限制提示
                        const max = getAllowedMax();
                        const checked = Array.from(checkboxes).filter(cb => cb.checked).length;

                        // 如果切换到非替换模式，且已选择超过限制，取消多余的选择
                        if (!isReplacing && checked > baseMax) {
                            const toUncheck = checked - baseMax;
                            const checkedBoxes = Array.from(checkboxes).filter(cb => cb.checked);
                            for (let i = 0; i < toUncheck; i++) {
                                checkedBoxes[checkedBoxes.length - 1 - i].checked = false;
                            }
                            ui.notifications.info(game.i18n.format('ORIGINATE.UI.Message.AutoUncheck', { count: toUncheck }));
                        }
                    });
                });

                // 优化单选体验
                if (baseMax === 1 && !canReplace) {
                    checkboxes.forEach(cb => {
                        cb.addEventListener('change', () => {
                            if (cb.checked) {
                                // 取消其他所有选中的项
                                checkboxes.forEach(other => {
                                    if (other !== cb && other.checked) {
                                        other.checked = false;
                                    }
                                });
                            }
                        });
                    });
                } else {
                    // 多选限制
                    checkboxes.forEach(cb => {
                        cb.addEventListener('change', () => {
                            const max = getAllowedMax();
                            const checked = Array.from(checkboxes).filter(cb => cb.checked).length;
                            if (checked > max) {
                                cb.checked = false;
                                if (canReplace && max === baseMax) {
                                    ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.MaxSelectWithReplaceWarn", { count: max }));
                                } else {
                                    ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.MaxSelectWarn", { count: max }));
                                }
                            }
                        });
                    });
                }
            }
        });
    }

    _onChangeAbility(event, target) {
        const ability = target.dataset.ability;
        const action = target.dataset.actionType;
        const currentValue = this.context.abilities[ability];
        let newValue = currentValue;

        if (action === 'increase' && currentValue < 17) newValue++;
        if (action === 'decrease' && currentValue > 8) newValue--;
        if (newValue === currentValue) return;

        const currentCost = this.dataManager.COST_TABLE[currentValue];
        const newCost = this.dataManager.COST_TABLE[newValue];
        const costDiff = newCost - currentCost;

        if (this.context.pointsRemaining - costDiff >= 0) {
            this.context.abilities[ability] = newValue;
            this.context.pointsRemaining -= costDiff;
            this.render();
        }
    }

    async _onToggleSkill(event, target) { /* ... */ }
    _onToggleSpell(event, target) { /* ... */ }
    _onSelectEquipment(event, target) { /* ... */ }

    _onCloseApp() {
        this.close();
    }

    /**
     * 获取指定步骤类型的标识符
     * @param {string} stepType 步骤类型 (race, class, background)
     * @returns {string} 标识符
     */
    _getIdentifierForStepType(stepType) {
        let identifier = '';

        if (stepType === 'class') {
            identifier = this.context.classIdentifier || this.context.class || '';
        } else if (stepType === 'race') {
            identifier = this.context.raceIdentifier || this.context.race || '';
        } else if (stepType === 'background') {
            identifier = this.context.backgroundIdentifier || this.context.background || '';
        }

        // 如果是 UUID 格式，尝试提取
        if (identifier && identifier.includes('.')) {
            const configData = game.settings.get('character-forge', 'data');
            if (stepType === 'class' && configData.classs?.[identifier]?.identifier) {
                identifier = configData.classs[identifier].identifier;
            } else if (stepType === 'race' && configData.races?.[identifier]?.identifier) {
                identifier = configData.races[identifier].identifier;
            } else if (stepType === 'background' && configData.backgrounds?.[identifier]?.identifier) {
                identifier = configData.backgrounds[identifier].identifier;
            } else {
                const parts = identifier.split('.');
                identifier = parts[parts.length - 1];
            }
        }

        return identifier;
    }

    /**
     * 根据当前步骤类型强制设置特性的分类
     * @param {Object} itemData 物品数据
     * @param {string} stepType 当前步骤类型 (race, class, subclass, background)
     */
    _applyFeatureType(itemData, stepType) {
        // 只处理 feat 类型的物品
        if (itemData.type !== 'feat') return;

        // 确保 system.type 结构存在
        if (!itemData.system) itemData.system = {};
        if (!itemData.system.type) itemData.system.type = { value: '', subtype: '' };

        // 获取当前的类型值
        const currentType = itemData.system.type.value;
        const currentSubtype = itemData.system.type.subtype;

        // 【修复】如果已经有有效的主类型，优先保留
        if (currentType && ['race', 'class', 'background'].includes(currentType)) {
            // subtype 也存在，完全保留
            if (currentSubtype) {
                window.OriginateLog(`Originate | 保留原有分类 ${itemData.name}: ${currentType}/${currentSubtype}`);
                return;
            }
            // 只有 type 没有 subtype，尝试补充，但不改变 type
            // 只有在能获取到有效 identifier 时才补充
            let identifier = this._getIdentifierForStepType(currentType);
            if (identifier) {
                itemData.system.type.subtype = identifier.toLowerCase().replace(/\s+/g, '-');
                window.OriginateLog(`Originate | 补充 subtype ${itemData.name}: ${currentType}/${itemData.system.type.subtype}`);
                return;
            } else {
                window.OriginateLog(`Originate | 现有分类无 identifier，尝试强制分类逻辑 ${itemData.name}: ${currentType}/`);
            }
        }

        // 如果已经是专长 (feat)，通常不需要修改（例如背景给予的专长）
        if (currentType === 'feat') return;

        // 根据步骤类型设置对应的特性类型和子类型
        // race -> race, subtype = 种族标识符
        // background -> background, subtype = 背景标识符
        // class/subclass -> class, subtype = 职业标识符
        const targetType = (stepType === 'subclass') ? 'class' : stepType;

        if (['race', 'background', 'class'].includes(targetType)) {
            // 设置主类型
            itemData.system.type.value = targetType;

            // 设置子类型（identifier）
            // 从 context 中获取对应的标识符
            let subtype = '';
            if (targetType === 'class') {
                // 职业特性：使用职业标识符
                // 优先使用 classIdentifier，其次从 context.class 推断
                subtype = this.context.classIdentifier || this.context.class || '';
                // 如果是子职特性，可能需要使用子职标识符
                if (stepType === 'subclass' && this.context.subclassIdentifier) {
                    // 子职特性仍然归类为职业特性，但可以保留子职信息
                    // DND5E 系统中子职特性的 subtype 通常是职业标识符
                    subtype = this.context.classIdentifier || this.context.class || '';
                }
            } else if (targetType === 'race') {
                // 种族特性：使用种族标识符
                subtype = this.context.raceIdentifier || this.context.race || '';
            } else if (targetType === 'background') {
                // 背景特性：使用背景标识符
                subtype = this.context.backgroundIdentifier || this.context.background || '';
            }

            // 如果 subtype 是 UUID 格式，尝试提取标识符部分
            if (subtype && subtype.includes('.')) {
                // 可能是 UUID，尝试从配置中获取真正的标识符
                const configData = game.settings.get('character-forge', 'data');
                if (targetType === 'class' && configData.classs?.[subtype]?.identifier) {
                    subtype = configData.classs[subtype].identifier;
                } else if (targetType === 'race' && configData.races?.[subtype]?.identifier) {
                    subtype = configData.races[subtype].identifier;
                } else if (targetType === 'background' && configData.backgrounds?.[subtype]?.identifier) {
                    subtype = configData.backgrounds[subtype].identifier;
                } else {
                    // 从 UUID 中提取最后一部分作为备用
                    const parts = subtype.split('.');
                    subtype = parts[parts.length - 1];
                }
            }

            // 转换为小写并移除空格（标准化标识符格式）
            if (subtype) {
                subtype = subtype.toLowerCase().replace(/\s+/g, '-');
            }

            itemData.system.type.subtype = subtype;

            window.OriginateLog(`Originate | 强制分类 ${itemData.name}: ${currentType || 'none'} -> ${targetType}/${subtype}`);
        }
    }

    async _renderExpertiseStep() {
        let overlay = this.element.querySelector('.originate-sub-interface');
        const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = `originate-sub-interface originate-container theme-${visualTheme}`;
            this.element.appendChild(overlay);
        } else {
            // 确保已有的 overlay 也有正确的主题类
            overlay.classList.add('originate-container');
            // 清主题类走注册表：硬编码清单漏掉外部皮肤（比如 theme-cyberpunk），复用 overlay 会双主题共存
            overlay.classList.remove(...getThemeClassList().split(' '));
            overlay.classList.add(`theme-${visualTheme}`);
        }

        const expertiseEvents = this.blueprintData.pendingExpertise;

        // 收集当前已熟练的技能
        const proficientSkills = new Set();

        // 1. Actor 基础熟练
        if (this.actor?.system?.skills) {
            Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                if (v.value >= 1) proficientSkills.add(k);
            });
        }

        // 2. Blueprint 累积熟练
        ['race', 'class', 'background', 'subclass'].forEach(step => {
            const stepData = this.blueprintData[step];
            if (stepData?.system) {
                Object.keys(stepData.system).forEach(k => {
                    if (k.startsWith('skills.') && k.endsWith('.value')) {
                        const skill = k.split('.')[1];
                        if (stepData.system[k] >= 1) proficientSkills.add(skill);
                    }
                });
            }
        });

        let contentHtml = '';

        expertiseEvents.forEach((event, idx) => {
            let poolArray = Array.from(event.pool);
            let displayOptions = [];

            if (poolArray.some(p => p === 'skills:*')) {
                const skills = CONFIG.DND5E.skills;
                Object.entries(skills).forEach(([k, v]) => {
                    displayOptions.push({ key: k, label: v.label || v });
                });
            } else {
                poolArray.forEach(key => {
                    if (key.startsWith('skills:')) {
                        const skillKey = key.split(':')[1];
                        const label = CONFIG.DND5E.skills[skillKey]?.label || skillKey;
                        displayOptions.push({ key: skillKey, label });
                    }
                });
            }

            // 检查是否已经是专精
            const expertSkills = new Set();
            if (this.actor?.system?.skills) {
                Object.entries(this.actor.system.skills).forEach(([k, v]) => {
                    if (v.value >= 2) expertSkills.add(k);
                });
            }
            ['race', 'class', 'background', 'subclass'].forEach(step => {
                const stepData = this.blueprintData[step];
                if (stepData?.system) {
                    Object.keys(stepData.system).forEach(k => {
                        if (k.startsWith('skills.') && k.endsWith('.value')) {
                            const skill = k.split('.')[1];
                            if (stepData.system[k] >= 2) expertSkills.add(skill);
                        }
                    });
                }
            });

            displayOptions = displayOptions.filter(opt => {
                return proficientSkills.has(opt.key) && !expertSkills.has(opt.key);
            });

            contentHtml += `
                <div class="sub-section expertise-section" data-idx="${idx}" data-count="${event.count}">
                    <h3>${event.title || game.i18n.localize("ORIGINATE.UI.Progression.ExpertiseChoice")}</h3>
                    <div class="selection-hint">${game.i18n.localize('ORIGINATE.UI.Hint.SelectExpertise')}</div>
                    <div class="options-container skill-chips-container">
                        ${displayOptions.length > 0 ? displayOptions.map(item => `
                            <label class="option-card card-skill">
                                <input type="checkbox" name="expertise-${idx}" value="${item.key}"> 
                                <span class="chip-label">${item.label}</span>
                            </label>
                        `).join('') : `<div class="no-options">${game.i18n.localize("ORIGINATE.UI.Progression.NoExpertiseOptions")}</div>`}
                    </div>
                </div>
            `;
        });

        overlay.innerHTML = `
            <div class="sub-interface-header">
                <h2>${game.i18n.localize("ORIGINATE.UI.Progression.ExpertiseTitle")}</h2>
                <div class="step-indicator">${game.i18n.localize("ORIGINATE.UI.Progression.ExpertiseStepIndicator")}</div>
            </div>
            
            <div class="sub-interface-content wizard-layout">
                <div class="wizard-step-content choice-step">
                    ${contentHtml}
                </div>
            </div>
            
            <div class="sub-interface-footer">
                <button type="button" class="back-btn" data-action="closeSubInterface"><i class="fas fa-times"></i> ${game.i18n.localize('ORIGINATE.UI.Button.Cancel')}</button>
                <button type="button" class="confirm-btn" data-action="confirmExpertise">${game.i18n.localize('ORIGINATE.UI.Button.FinishCreation')} <i class="fas fa-check"></i></button>
            </div>
        `;

        const closeBtn = overlay.querySelector('[data-action="closeSubInterface"]');
        if (closeBtn) closeBtn.onclick = () => overlay.remove();

        overlay.querySelectorAll('.expertise-section').forEach(section => {
            const max = parseInt(section.dataset.count);
            const checkboxes = section.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    const checked = section.querySelectorAll('input[type="checkbox"]:checked').length;
                    if (checked > max) {
                        cb.checked = false;
                        ui.notifications.warn(game.i18n.format("ORIGINATE.UI.MaxSelectWarn", { count: max }));
                    }
                });
            });
        });
    }

    async _onConfirmExpertise(eventOrOverlay, target) {
        // Adrian: 这个方法有两种调用方式：
        // 1. 作为 Foundry action handler: (event, target) — app.js 注册的
        // 2. 直接调用: (overlay) — ui-mixin.js 里的 confirmBtn.onclick
        // 得两个都兼容，不然就炸了
        let overlay;
        if (eventOrOverlay instanceof Event || eventOrOverlay?.originalEvent) {
            // Foundry action handler 模式
            overlay = target?.closest('.originate-sub-interface')
                || this.element?.querySelector('.originate-sub-interface')
                || this.element;
        } else {
            // 直接传入 overlay
            overlay = eventOrOverlay;
        }
        const expertiseEvents = this.blueprintData.pendingExpertise;
        let isValid = true;
        const selections = [];

        expertiseEvents.forEach((event, idx) => {
            const section = overlay.querySelector(`.expertise-section[data-idx="${idx}"]`);
            const max = parseInt(section.dataset.count);
            const checked = section.querySelectorAll('input:checked');
            const availableOptions = section.querySelectorAll('input').length;
            const required = Math.min(max, availableOptions);

            if (checked.length !== required) {
                ui.notifications.warn(game.i18n.format("ORIGINATE.UI.Progression.SelectRequiredWarn", { title: event.title, count: required }));
                isValid = false;
            }

            selections.push({
                event: event,
                skills: Array.from(checked).map(cb => cb.value)
            });
        });

        if (!isValid) return;

        selections.forEach(sel => {
            const event = sel.event || {};
            const stepType = event.stepType || 'class';
            const advancementId = event._original?._id || event.id || event.title || null;
            const sourceLevel = this._resolveWizardSourceLevel?.(stepType, event) ?? 1;

            sel.skills.forEach(skill => {
                let found = false;
                ['race', 'class', 'background', 'subclass'].forEach(step => {
                    const stepData = this.blueprintData[step];
                    if (stepData?.system && stepData.system[`skills.${skill}.value`] === 1) {
                        stepData.system[`skills.${skill}.value`] = 2;
                        found = true;
                    }
                });

                if (!found) {
                    if (!this.blueprintData[stepType]) this.blueprintData[stepType] = { items: [], system: {} };
                    if (!this.blueprintData[stepType].system) this.blueprintData[stepType].system = {};
                    this.blueprintData[stepType].system[`skills.${skill}.value`] = 2;
                }

                this._recordCharacterTraitChange?.({
                    key: `skills:${skill}`,
                    advancementId,
                    level: sourceLevel,
                    stepType,
                    mode: 'expertise',
                    parentFeature: event.parentFeature || event.parentFeat || null,
                    parentSourceUuid: event.parentSourceUuid || null
                });
            });
        });

        this.blueprintData.pendingExpertise = [];
        overlay.remove();
        await this._onFinish();
    }

    _applyTraitToUpdate(key, updateData, mode = 'default') {
        // Adrian: 这里的逻辑是把你们选好的特质塞进角色卡的数据包里。
        // key 格式: "type:value" 如 "skills:arc" 或 "languages:elvish"。
        // 如果你发现选了特质但角色卡没反应，那多半是这里的映射又被系统更新给背刺了。
        const parts = key.split(':');
        if (parts.length < 2) {
            console.warn(`Originate | Invalid trait key format: ${key}`);
            return;
        }

        const type = parts[0];
        // 对于多级 key（如 tool:art:carpenter 或 languages:standard:common），取后面所有部分
        let value = parts.slice(1).join(':');

        if (!type || !value) return;

        // 伤害类型中文转英文映射 (解决种族抗性失效问题)
        if (['dr', 'di', 'dv'].includes(type)) {
            const damageTypeMapping = {
                "酸": "acid", "酸性": "acid",
                "钝击": "bludgeoning",
                "寒冷": "cold", "冰冻": "cold",
                "火焰": "fire", "火": "fire",
                "力场": "force",
                "闪电": "lightning", "电": "lightning",
                "黯蚀": "necrotic", "死灵": "necrotic",
                "穿刺": "piercing",
                "毒素": "poison", "毒": "poison",
                "心灵": "psychic", "精神": "psychic",
                "光耀": "radiant", "光": "radiant",
                "挥砍": "slashing",
                "雷鸣": "thunder", "雷": "thunder"
            };

            // 尝试全匹配或包含匹配
            if (damageTypeMapping[value]) {
                value = damageTypeMapping[value];
            } else {
                // 如果值包含中文，尝试查找
                for (const [cn, en] of Object.entries(damageTypeMapping)) {
                    if (value.includes(cn)) {
                        value = en;
                        break;
                    }
                }
            }
        }

        window.OriginateLog(`Originate | Applying trait: ${type}:${value}`);

        if (type === 'skills') {
            // 技能熟练度: 1 = Proficient, 2 = Expertise
            updateData[`skills.${value}.value`] = mode === 'expertise' ? 2 : 1;
        } else if (type === 'languages') {
            // 处理多级格式如 languages:standard:common -> common
            const langKey = value.includes(':') ? value.split(':').pop() : value;
            ensureTraitSet(updateData, 'traits.languages.value').add(langKey);
        } else if (type === 'saves') {
            // 豁免熟练度
            updateData[`abilities.${value}.proficient`] = 1;
        } else if (type === 'dr') {
            // 伤害抗性
            ensureTraitSet(updateData, 'traits.dr.value').add(value);
        } else if (type === 'di') {
            // 伤害免疫
            ensureTraitSet(updateData, 'traits.di.value').add(value);
        } else if (type === 'dv') {
            // 伤害易伤
            ensureTraitSet(updateData, 'traits.dv.value').add(value);
        } else if (type === 'ci') {
            // 状态免疫
            ensureTraitSet(updateData, 'traits.ci.value').add(value);
        } else if (type === 'weapon') {
            // 武器熟练
            ensureTraitSet(updateData, 'traits.weaponProf.value').add(value);
        } else if (type === 'armor') {
            // 护甲熟练
            ensureTraitSet(updateData, 'traits.armorProf.value').add(value);
        } else if (type === 'tool') {
            const toolValues = ensureTraitSet(updateData, 'traits.toolProf.value');
            const toolName = normalizeToolId(value);

            // 如果是专精模式，工具熟练度处理可能不同
            // DND5E 系统中工具专精通常通过 item.system.proficient = 2 来实现
            // 但这里我们只处理 traits.toolProf.value，它只是一个字符串集合
            // 真正的工具专精需要在创建工具物品时设置
            // 这里我们只添加熟练度标记

            const toolProficiencies = CONFIG.DND5E.toolProficiencies || {};
            const toolIds = CONFIG.DND5E.toolIds || {};
            if (toolName && toolProficiencies[toolName]) {
                toolValues.add(toolName);
            } else if (toolName && toolIds[toolName]) {
                toolValues.add(toolName);
            } else if (toolName) {
                const matchedTool = Object.keys(toolIds).find(k =>
                    k.toLowerCase().includes(toolName.toLowerCase()) ||
                    toolName.toLowerCase().includes(k.toLowerCase())
                );
                if (matchedTool) {
                    toolValues.add(matchedTool);
                } else {
                    toolValues.add(toolName || value);
                }
            } else {
                toolValues.add(value);
            }
        } else if (type === 'weaponMastery') {
            // 武器精通 (DND5E 2024)
            ensureTraitSet(updateData, 'traits.weaponProf.mastery.value').add(value);
        } else {
            console.warn(`Originate | Unknown trait type: ${type}`);
        }
    }

    /**
     * 绑定向导中的法术浏览器事件
     */
    _bindSpellBrowserEventsWizard(overlay, stepData, selectedSpells = []) {
        const section = overlay.querySelector('.spell-browser-section');
        if (!section) return;

        window.OriginateLog(`Originate | Binding spell browser events for wizard step`);

        const searchInput = section.querySelector('.spell-search-input');
        const schoolButtons = section.querySelectorAll('.school-btn');
        // const classFilter = section.querySelector('.spell-class-filter'); // Removed
        const classFilterContainer = section.querySelector('.class-filter-container');
        const resultsList = section.querySelector('.spell-results-list');
        const selectedList = section.querySelector('.selected-spells-list');
        const selectionCount = section.querySelector('.selection-count');
        const maxCount = parseInt(section.dataset.count);
        const restrictedLevel = section.dataset.restrictionLevel || '';

        // 获取 restriction 从 stepData.event
        const event = stepData.event;
        // Fix: restriction may be in event.restriction OR event._original.configuration.restriction
        // Adrian: 增强获取逻辑，确保万无一失
        let restriction = event?.restriction;
        if (!restriction && event?._original?.configuration?.restriction) {
            restriction = event._original.configuration.restriction;
        }
        // 某些旧数据结构可能在 data 下
        if (!restriction && event?._original?.data?.configuration?.restriction) {
            restriction = event._original.data.configuration.restriction;
        }
        restriction = restriction || {};

        // 旧入口也统一成同一套法表 key，避免创角和升级筛选口径分叉。
        if (restriction?.list) {
            restriction.list = normalizeSpellListIds(restriction.list).map(id => `class:${id}`);
        }

        if (window.OriginateDebug) {
            console.log("Originate | Spell Browser Restriction:", restriction);
        }

        // 当前筛选状态
        let currentSchool = '';
        let currentClassFilters = new Set(); // Stores selected class IDs

        // 加载职业法表列表并填充 (Checkbox Version)
        if (classFilterContainer) {
            (async () => {
                try {
                    const primaryContainer = classFilterContainer.querySelector('.primary-classes');
                    const subclassContainer = classFilterContainer.querySelector('.subclass-classes');
                    const subclassSection = classFilterContainer.querySelector('.subclass-section');
                    const subclassToggle = classFilterContainer.querySelector('.subclass-toggle');

                    // 1. 获取所有数据
                    const [spellClasses, classOptions, subclassOptions] = await Promise.all([
                        this.dataManager.getAvailableSpellClasses(),
                        this.dataManager.getOptions('class', {}, { indexOnly: true }),
                        this.dataManager.getOptions('subclass', {}, { indexOnly: true })
                    ]);

                    if (!spellClasses || spellClasses.length === 0) {
                        primaryContainer.innerHTML = `<div class="empty-hint">${game.i18n.localize('ORIGINATE.UI.NoSpellLists')}</div>`;
                        return;
                    }

                    // 2. 分类
                    const primaryMap = new Map(classOptions.map(c => [c.identifier, c]));
                    const subclassMap = new Map(subclassOptions.map(c => [c.identifier, c]));

                    const primaryList = [];
                    const subclassList = [];

                    for (const cls of spellClasses) {
                        if (primaryMap.has(cls.id)) {
                            primaryList.push(cls);
                        } else {
                            subclassList.push(cls); // 默认为子职业或其他
                        }
                    }

                    // 3. 渲染辅助函数

                    const renderCheckbox = (cls) => {
                        // Strict Restriction Logic
                        const isRestricted = restriction.list && restriction.list.length > 0;
                        const filterId = normalizeSpellListId(cls.id);
                        const cleanList = isRestricted ? normalizeSpellListIds(restriction.list) : [];
                        const isInList = isRestricted ? cleanList.includes(filterId) : false;

                        let isChecked = currentClassFilters.has(filterId);

                        if (isInList) {
                            isChecked = true;
                            currentClassFilters.add(filterId);
                        }

                        return `
                        <label class="spell-filter-checkbox">
                            <input type="checkbox" value="${filterId}" ${isChecked ? 'checked' : ''}>
                            <span style="display:flex; flex-direction:column; line-height:1.2;">
                                <span>${cls.name}</span>
                                <span style="font-size: 0.7em; color: #888; font-family: monospace;">ID: ${filterId}</span>
                            </span>
                        </label>`;
                    };


                    // 3.5 Initialize Default Selection (Only if restricted)
                    // Adrian: 确保在渲染前初始化过滤器，这样 refreshResults 才能正确工作
                    if (restriction.list && restriction.list.length > 0) {
                        normalizeSpellListIds(restriction.list).forEach(id => currentClassFilters.add(id));
                        window.OriginateLog(`Originate | Initialized class filters from restriction:`, Array.from(currentClassFilters));
                    }

                    // 4. 填充 DOM
                    primaryContainer.innerHTML = primaryList.map(renderCheckbox).join('');
                    subclassContainer.innerHTML = subclassList.map(renderCheckbox).join('');



                    // 5. 处理子职业显示
                    if (subclassList.length === 0) {
                        subclassSection.style.display = 'none';
                    } else {
                        // Toggle Logic
                        subclassToggle.addEventListener('click', () => {
                            const isCollapsed = subclassSection.classList.contains('collapsed');
                            if (isCollapsed) {
                                subclassSection.classList.remove('collapsed');
                                subclassContainer.style.display = 'flex'; // grid or flex
                                subclassToggle.querySelector('i').className = 'fas fa-caret-down';
                            } else {
                                subclassSection.classList.add('collapsed');
                                subclassContainer.style.display = 'none';
                                subclassToggle.querySelector('i').className = 'fas fa-caret-right';
                            }
                        });
                    }

                    // 6. 绑定事件
                    classFilterContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                        cb.addEventListener('change', (e) => {
                            if (e.target.checked) {
                                currentClassFilters.add(e.target.value);
                            } else {
                                currentClassFilters.delete(e.target.value);
                            }
                            refreshResults();
                        });
                    });

                    // Initial Refresh if we define defaults
                    if (currentClassFilters.size > 0) refreshResults();

                } catch (e) {
                    console.error("Originate | Failed to load spell class list:", e);
                }
            })();
        }

        let currentSpells = [];

        // 生成法术卡片 HTML
        const generateSpellCards = (spells) => {
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
                            // 尝试获取职业名称的本地化，如果没有则首字母大写
                            const classConfig = CONFIG.DND5E.classFeatures?.[c.toLowerCase()] || CONFIG.DND5E.spellLists?.[c.toLowerCase()];
                            const label = classConfig?.label || (c.charAt(0).toUpperCase() + c.slice(1));
                            return `<span class="spell-class-tag">${label}</span>`;
                        }).join('')}
                        </div>`;
                    }
                }

                return `
                <div class="spell-card" data-uuid="${spell.uuid}" draggable="true">
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
        };

        // 刷新搜索结果
        const refreshResults = async () => {
            if (currentClassFilters.size === 0) {
                currentSpells = [];
                resultsList.innerHTML = `<div class="no-results">${game.i18n.localize('ORIGINATE.UI.SelectSpellListPrompt')}</div>`;
                return;
            }

            const searchRestriction = buildSpellBrowserSearchRestriction(restriction, currentClassFilters, restrictedLevel);
            // 'available' 是 DnD5e 的 "任意可使用等级" 特殊值，不应作为具体环阶传递
            const isNumericLevel = restrictedLevel && !isAvailableSpellLevel(restrictedLevel);

            // 当 restriction.level 未指定或为 'available' 时，自动推断最大可学环阶
            let computedMaxLevel = null;
            if (!isNumericLevel && (searchRestriction.level === undefined || isAvailableSpellLevel(searchRestriction.level))) {
                try {
                    const classOptions = await this.dataManager.getOptions('class', {}, { indexOnly: true });
                    const selectedClass = classOptions?.find(o => o.id === this.context?.class);
                    const spellcastingType = selectedClass?.coreTraits?.spellcastingType;
                    // Phase 1 基础选择（职业/种族/背景）固定使用等级 1
                    // 不能用 this.characterLevel，它是目标总等级（如创建5级角色时=5）
                    // 基础选择只包含 Level 0-1 的 Advancement，法术环阶应按 1 级计算
                    const charLevel = 1;
                    console.log(`Originate | [ui-mixin] 基础选择法术环推断: charLevel=${charLevel} (固定1级), spellcastingType="${spellcastingType}"`);
                    if (spellcastingType) {
                        computedMaxLevel = this.dataManager.getMaxSpellLevel(spellcastingType, charLevel);
                        console.log(`Originate | [ui-mixin] Auto-detected maxLevel=${computedMaxLevel}`);
                    } else {
                        console.log(`Originate | [ui-mixin] spellcastingType is falsy, defaulting to full caster`);
                        computedMaxLevel = this.dataManager.getMaxSpellLevel('full', charLevel);
                        console.log(`Originate | [ui-mixin] Fallback maxLevel=${computedMaxLevel} (full caster at level ${charLevel})`);
                    }
                } catch (e) {
                    console.warn("Originate | [ui-mixin] Failed to auto-detect max spell level:", e);
                }
            }

            const searchText = searchInput.value;

            try {
                let results = await this.dataManager.getSpellsByRestriction(searchRestriction, searchText, computedMaxLevel);

                if (currentSchool) {
                    results = results.filter(s => s.school === currentSchool);
                }

                // 3. 职业筛选 (多选)
                if (currentClassFilters.size > 0) {
                    const classSpellMap = await this.dataManager.getClassSpellMap();
                    results = results.filter(s => {
                        const spellClasses = getSpellClassesForSpell(classSpellMap, s);
                        if (!spellClasses) return false;
                        return spellClassSetMatchesAny(spellClasses, currentClassFilters);
                    });
                }

                currentSpells = results;
                resultsList.innerHTML = generateSpellCards(results);
                bindCardEvents();
            } catch (e) {
                console.error("Originate | Spell search error:", e);
                resultsList.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: #a44;">${game.i18n.format('ORIGINATE.UI.Error.SearchFailed', { error: e.message })}</div>`;
            }
        };

        // 绑定卡片事件
        const bindCardEvents = () => {
            resultsList.querySelectorAll('.spell-card').forEach(card => {
                card.addEventListener('dragstart', (ev) => {
                    ev.dataTransfer.setData("text/plain", JSON.stringify({
                        uuid: card.dataset.uuid,
                        type: "Item"
                    }));
                });

                card.addEventListener('click', () => {
                    addSelection(card.dataset.uuid);
                });

                // 悬停预览 - 使用自定义 tooltip 避免被容器裁剪
                card.addEventListener('pointerenter', async (ev) => {
                    const uuid = card.dataset.uuid;
                    const spell = currentSpells.find(s => s.uuid === uuid);

                    // 如果没有描述，尝试异步加载
                    if (!spell.description) {
                        try {
                            const doc = await fromUuid(uuid);
                            if (doc) spell.description = doc.system.description?.value || '';
                        } catch (e) {
                            console.warn(`Originate | Failed to load spell for tooltip: ${uuid}`, e);
                        }
                    }

                    if (spell?.description) {
                        const descText = this._processHtmlDescription(spell.description);

                        // 获取或创建自定义 tooltip
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
                                maxHeight: '350px',
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
                            tooltip.addEventListener('wheel', (e) => {
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

                        // 定位 tooltip
                        const rect = card.getBoundingClientRect();
                        tooltip.style.display = 'block';
                        tooltip.scrollTop = 0;

                        // 获取 tooltip 实际尺寸
                        const tooltipRect = tooltip.getBoundingClientRect();

                        let left = rect.right + 12;
                        let top = rect.top;

                        // 右侧空间不够，放左侧
                        if (left + tooltipRect.width > window.innerWidth - 10) {
                            left = rect.left - tooltipRect.width - 12;
                        }
                        // 如果左侧也不够，居中显示
                        if (left < 10) {
                            left = Math.max(10, (window.innerWidth - tooltipRect.width) / 2);
                        }
                        // 底部边界检查
                        if (top + tooltipRect.height > window.innerHeight - 10) {
                            top = window.innerHeight - tooltipRect.height - 10;
                        }
                        if (top < 10) top = 10;

                        tooltip.style.left = `${left}px`;
                        tooltip.style.top = `${top}px`;
                    }
                });

                card.addEventListener('wheel', (e) => {
                    const tooltip = document.querySelector('.originate-spell-tooltip');
                    if (tooltip && tooltip.style.display === 'block') {
                        e.preventDefault();
                        tooltip.scrollTop += e.deltaY;
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
        };

        // 添加到已选
        const addSelection = async (uuid, { restoring = false } = {}) => {
            if (this.dataManager.isItemExcluded(uuid)) return;
            const currentCount = selectedList.children.length;
            if (currentCount >= maxCount) {
                ui.notifications.warn(game.i18n.format("ORIGINATE.UI.MaxSelectWarn", { count: maxCount }));
                return;
            }

            if (selectedList.querySelector(`[data-uuid="${uuid}"]`)) return;

            let spell = currentSpells.find(s => s.uuid === uuid);
            if (!spell) {
                const doc = await this.dataManager.getDocument(uuid);
                if (doc?.type === 'spell') spell = { uuid: doc.uuid, name: doc.name, img: doc.img, level: doc.system.level, school: doc.system.school };
            }
            if (!spell) return;
            if (!restoring && !matchesSpellSchool(spell, restriction)) {
                ui.notifications.warn(spellSchoolHint(restriction));
                return;
            }

            const el = document.createElement('div');
            el.className = 'spell-card selected';
            el.dataset.uuid = uuid;
            el.dataset.school = spell.school || '';
            el.setAttribute('aria-invalid', String(!matchesSpellSchool(spell, restriction)));
            el.innerHTML = `
                <img src="${spell.img}" class="spell-icon">
                <div class="spell-name">${spell.name}</div>
                <div class="remove-icon"><i class="fas fa-times"></i></div>
            `;

            el.querySelector('.remove-icon').addEventListener('click', () => {
                el.remove();
                updateCount();
            });

            selectedList.appendChild(el);
            updateCount();
        };

        const updateCount = () => {
            const count = selectedList.children.length;
            selectionCount.textContent = count;
            const invalid = Array.from(selectedList.children).some(card => !matchesSpellSchool({ school: card.dataset.school }, restriction));
            section.querySelectorAll('[data-school-error]').forEach(message => { message.hidden = !invalid; });
        };

        // 事件监听
        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(refreshResults, 300);
        });

        // 学派按钮切换（单选）
        schoolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                schoolButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentSchool = btn.dataset.school;
                refreshResults();
            });
        });

        // 初始加载
        refreshResults();

        if (selectedSpells.length > 0) {
            const confirmButton = overlay.querySelector('.confirm-btn');
            if (confirmButton) confirmButton.disabled = true;
            Promise.all(selectedSpells.map(uuid => addSelection(uuid, { restoring: true }))).catch(error => {
                console.warn('Originate | 恢复向导法术选择失败:', error);
            }).finally(() => {
                if (confirmButton?.isConnected) confirmButton.disabled = false;
            });
        }

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
};
