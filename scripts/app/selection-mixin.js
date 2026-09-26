import {
    getAdvancementEntries,
    setAdvancementSource
} from '../utils/advancement-utils.js';
import { isSpellChoiceEvent } from '../shared/advancement-choice-rules.js';
import { buildStartingEquipmentEvent } from '../shared/starting-equipment.js';

function getEquipmentConfigUuid(value) {
    if (typeof value === 'string') return value;
    return value?.id || null;
}

function matchesEquipmentCategory(document, entry, config) {
    const itemType = document?.type;
    const value = document?.system?.type?.value;
    const baseItem = document?.system?.type?.baseItem;

    if (entry.type === 'weapon') {
        if (itemType !== 'weapon') return false;
        if (entry.key in (config.weaponProficiencies || {})) {
            return config.weaponProficienciesMap?.[value] === entry.key;
        }
        return value === entry.key;
    }

    if (entry.type === 'armor') {
        if (itemType !== 'equipment') return false;
        if (entry.key in (config.armorProficiencies || {})) {
            return config.armorProficienciesMap?.[value] === entry.key;
        }
        return value === entry.key || baseItem === entry.key;
    }

    if (entry.type === 'tool') {
        return itemType === 'tool' && (value === entry.key || baseItem === entry.key);
    }

    return entry.type === 'focus';
}

export const SelectionMixin = (Base) => class extends Base {
    async _onConfirmSelection(event, target) {
        if (this._selectionConfirmInFlight) return false;

        window.OriginateLog("Originate | Confirm selection clicked. 终于下定决心了？");
        const type = this.currentStep;
        const id = this.context[type];

        if (!id) {
            ui.notifications.warn(game.i18n.localize("ORIGINATE.UI.Selection.PleaseSelect"));
            return false;
        }

        const button = target?.closest?.('.cinematic-confirm-btn, .subclass-confirm-btn') || target;
        const originalHtml = button?.innerHTML;
        const wasDisabled = !!button?.disabled;

        this._selectionConfirmInFlight = true;
        if (button) {
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');
            const label = button.textContent?.trim() || game.i18n.localize("ORIGINATE.UI.Navigation.Confirm");
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${label}</span>`;
        }

        try {
            // 获取选项数据
            const options = await this.dataManager.getOptions(type, this.context, this._currentFolder);
            const option = options.find(o => o.id === id);

            if (!option) return false;

            // 进入子界面 (Sub-Interface)
            // 真正的挑战现在才开始
            if (this._creationTimeline?.active) {
                return await this._runCreationTimelineForward(async () => {
                    await this._renderSubInterface(type, option);
                    return true;
                });
            }

            await this._renderSubInterface(type, option);
            return true;
        } finally {
            this._selectionConfirmInFlight = false;
            if (button?.isConnected) {
                button.classList.remove('is-loading');
                button.removeAttribute('aria-busy');
                if (originalHtml !== undefined) button.innerHTML = originalHtml;
                button.disabled = wasDisabled;
            }
        }
    }

    async _renderSubInterface(type, option) {
        if (type === 'background' && option) {
            option = {
                ...option,
                displayName: String(option.displayName || option.name || '')
                    .replace(/\s*\(([A-Z0-9][A-Z0-9&+.'’\- ]{1,24})\)\s*$/u, '')
                    .trim()
            };
        }
        window.OriginateLog(`Originate | _renderSubInterface 开始，type=${type}, option=${option.name}。好戏开场。`);
        window.OriginateLog(`Originate | option.uuid: ${option.uuid}`);

        // 1. 使用新的 AdvancementParser 获取数据
        // 以前我们用静态数据，现在我们直接解析 Advancement。
        // 这就像从看说明书变成了直接拆机器，刺激多了。
        let levelEvents = [];

        if (type === 'class') {
            // 职业：获取 Level 0 和 Level 1 的 Advancement
            // Level 0 包含职业的基础熟练（技能、豁免、武器/护甲熟练等）
            // Level 1 包含职业的初始特性
            // 别问为什么有 Level 0，Foundry 的逻辑有时候就是这么迷
            window.OriginateLog(`Originate | 获取 ${type} 的 Level 0 和 Level 1 advancement`);

            const level0Events = await this.dataManager.getLevelAdvancement(option.uuid, 0);
            const level1Events = await this.dataManager.getLevelAdvancement(option.uuid, 1);

            window.OriginateLog(`Originate | 职业 Level 0 事件数量: ${level0Events.length}, Level 1 事件数量: ${level1Events.length}`);

            // 合并两个等级的事件，并去重
            // 重复的特性就像重复的笑话，一点都不好笑
            const seenIds = new Set();
            levelEvents = [];

            for (const event of [...level0Events, ...level1Events]) {
                // 优先使用 _uid (如果存在)，否则使用 _id
                const uniqueId = event._uid || event._original?._id;

                if (uniqueId) {
                    if (seenIds.has(uniqueId)) {
                        window.OriginateLog(`Originate | 跳过重复的职业 Advancement: ${event.title} (uid=${uniqueId})`);
                        continue;
                    }
                    seenIds.add(uniqueId);
                }
                event.sourceLevel = event.sourceLevel ?? (level0Events.includes(event) ? 0 : 1);
                levelEvents.push(event);
            }

            window.OriginateLog(`Originate | 职业去重后事件数量: ${levelEvents.length}, 类型:`, levelEvents.map(e => e.type));
        } else if (type === 'subclass') {
            // 子职：获取子职获得等级（通常是 Level 3）的 Advancement
            // 从职业数据中动态获取子职获得等级
            let subclassLevel = 3;

            // 尝试从职业选项中获取
            if (this.context.options) {
                // 如果当前在子职步骤，this.context.options 是子职列表，不是职业列表
                // 所以我们需要重新获取职业列表，绕个弯子
                const classOptions = await this.dataManager.getOptions('class');
                const selectedClass = classOptions.find(o => o.id === this.context.class);
                if (selectedClass && selectedClass.subclassLevel !== undefined) {
                    subclassLevel = selectedClass.subclassLevel;
                }
            }

            window.OriginateLog(`Originate | 获取子职 ${option.name} 的 Level ${subclassLevel} advancement`);
            window.OriginateLog(`Originate | 子职 UUID: ${option.uuid}`);

            // 获取子职在该等级的特性
            const events = await this.dataManager.getLevelAdvancement(option.uuid, subclassLevel);
            events.forEach(e => e.sourceLevel = subclassLevel);
            levelEvents = events;

            // 如果没有找到该等级的特性，尝试获取 Level 0、Level 1 和 Level 3 的特性
            // 有时候数据就是这么不靠谱，我们得做多手准备
            if (levelEvents.length === 0) {
                window.OriginateLog(`Originate | 子职 Level ${subclassLevel} 无特性，尝试获取 Level 0, 1, 3。死马当活马医。`);
                const level0Events = await this.dataManager.getLevelAdvancement(option.uuid, 0);
                const level1Events = await this.dataManager.getLevelAdvancement(option.uuid, 1);
                const level3Events = subclassLevel !== 3 ? await this.dataManager.getLevelAdvancement(option.uuid, 3) : [];
                levelEvents = [...level0Events, ...level1Events, ...level3Events];
                levelEvents.forEach(e => e.sourceLevel = e.sourceLevel || subclassLevel);
            }

            window.OriginateLog(`Originate | 子职 ${option.name} 在 Level ${subclassLevel} 的 advancement 事件:`, levelEvents);
        } else {
            // 种族和背景：需要获取 Level 0 和 Level 1 的所有特性
            // 因为某些种族特性（如提夫林的火焰抗性）在 level 1
            const level0Events = await this.dataManager.getLevelAdvancement(option.uuid, 0);
            const level1Events = await this.dataManager.getLevelAdvancement(option.uuid, 1);

            window.OriginateLog(`Originate | ${type} Level 0 事件: ${level0Events.length}, Level 1 事件: ${level1Events.length}`);

            // 合并两个等级的事件，并去重
            // 使用 _uid (如果存在) 或 _original._id 作为唯一标识符进行去重
            const seenIds = new Set();
            levelEvents = [];

            for (const event of [...level0Events, ...level1Events]) {
                const uniqueId = event._uid || event._original?._id;

                if (uniqueId) {
                    if (seenIds.has(uniqueId)) {
                        window.OriginateLog(`Originate | 跳过重复的 Advancement: ${event.title} (uid=${uniqueId})`);
                        continue;
                    }
                    seenIds.add(uniqueId);
                }
                event.sourceLevel = event.sourceLevel ?? (level0Events.includes(event) ? 0 : 1);
                levelEvents.push(event);
            }

            window.OriginateLog(`Originate | ${type} 去重后事件数量: ${levelEvents.length}`);

            // Adrian: 拦截 ASI 事件，延迟到 asiBonus 步骤处理
            // getLevelAdvancement 会从原始 Item 文档解析出 ASI 事件，
            // 我们需要在子界面渲染前把它们拦截下来，否则会作为 sub-step 显示
            const asiEvents = levelEvents.filter(e => e.type === 'asi');
            if (asiEvents.length > 0) {
                window.OriginateLog(`Originate | 拦截到 ${type} 的 ${asiEvents.length} 个 ASI 事件，准备延迟应用。`);

                // 初始化 deferredASIs 容器
                if (!this.context.deferredASIs) this.context.deferredASIs = [];

                // 清除该类型 (Race/Background) 之前的旧数据，防止重复叠加
                this.context.deferredASIs = this.context.deferredASIs.filter(d => d.sourceType !== type);

                // 从 ASI 事件中提取加成信息
                for (const asiEvent of asiEvents) {
                    // 点数分配型 ASI（如背景的 3 点自由分配）
                    if (asiEvent.points > 0) {
                        // 标准化 locked 为数组（可能是 Set、Array 或 Object）
                        let lockedArr = [];
                        if (asiEvent.locked instanceof Set) {
                            lockedArr = Array.from(asiEvent.locked);
                        } else if (Array.isArray(asiEvent.locked)) {
                            lockedArr = asiEvent.locked;
                        } else if (asiEvent.locked && typeof asiEvent.locked === 'object') {
                            lockedArr = Object.keys(asiEvent.locked);
                        }
                        window.OriginateLog(`Originate | ASI 捕获: locked 原始值:`, asiEvent.locked, `标准化后:`, lockedArr);
                        this.context.deferredASIs.push({
                            type: 'points',
                            points: asiEvent.points,
                            cap: asiEvent.cap || 2,
                            fixed: asiEvent.fixed || {},
                            locked: lockedArr,
                            source: option.name,
                            sourceType: type
                        });
                    }
                    // 固定加成型 ASI
                    if (asiEvent.fixed && Object.keys(asiEvent.fixed).length > 0) {
                        for (const [ability, value] of Object.entries(asiEvent.fixed)) {
                            if (value > 0) {
                                this.context.deferredASIs.push({
                                    type: 'fixed',
                                    ability: ability,
                                    value: value,
                                    source: option.name,
                                    sourceType: type
                                });
                            }
                        }
                    }
                }

                window.OriginateLog(`Originate | 已拦截 ${type} ASI 事件。当前 deferredASIs:`, this.context.deferredASIs);

                // Adrian: 无限制 ASI 模式 — 清除 locked 限制，并将 fixed 转为可分配点数
                const unrestrictedASI = game.settings.get('character-forge', 'unrestrictedASI');
                if (unrestrictedASI) {
                    window.OriginateLog(`Originate | 无限制 ASI 模式已启用，正在解除 ${type} 的属性限制...`);

                    // 1. 清除所有 points 类型的 locked 限制
                    for (const asi of this.context.deferredASIs) {
                        if (asi.type === 'points' && asi.sourceType === type) {
                            asi.locked = [];
                        }
                    }

                    // 2. 将 fixed 类型的 ASI 转为 points 类型（合并为一个可分配池）
                    const fixedASIs = this.context.deferredASIs.filter(a => a.type === 'fixed' && a.sourceType === type);
                    if (fixedASIs.length > 0) {
                        const totalFixedPoints = fixedASIs.reduce((sum, a) => sum + a.value, 0);
                        const fixedSource = fixedASIs[0].source;

                        // 移除所有 fixed 类型的 ASI
                        this.context.deferredASIs = this.context.deferredASIs.filter(a => !(a.type === 'fixed' && a.sourceType === type));

                        // 添加一个新的 points 类型 ASI（由 fixed 转换）
                        this.context.deferredASIs.push({
                            type: 'points',
                            points: totalFixedPoints,
                            cap: 2,
                            fixed: {},
                            locked: [],
                            source: fixedSource,
                            sourceType: type
                        });

                        window.OriginateLog(`Originate | 已将 ${fixedASIs.length} 个固定 ASI (共 ${totalFixedPoints} 点) 转为可分配点数`);
                    }
                }

                // 从 levelEvents 中移除 ASI 事件
                levelEvents = levelEvents.filter(e => e.type !== 'asi');
            }
        }

        window.OriginateLog(`Originate | ${type} 总计 Advancement 事件:`, levelEvents);

        // 1.5 丰富事件数据（加载名称和图标）
        if (levelEvents.length > 0) {
            window.OriginateLog(`Originate | 正在丰富 ${levelEvents.length} 个事件的详细信息... 就像给黑白照片上色。`);
            await this.dataManager.enrichOptions(levelEvents);

            // 过滤掉 pool 为空且不是替换模式的 choice 事件
            // 这通常发生在所有选项都因等级不足被过滤掉的情况（例如高等级特性被错误地包含在低等级中）
            // 空的选择框就像空的承诺，没人喜欢
            const originalCount = levelEvents.length;
            levelEvents = levelEvents.filter(e => {
                if (e.type === 'choice' && (!e.pool || e.pool.length === 0) && !e.replacement) {
                    // 法术选择事件没有 pool（法术通过浏览器动态加载），不应被过滤
                    const isSpellChoice = isSpellChoiceEvent(e);
                    if (isSpellChoice) {
                        window.OriginateLog(`Originate | 保留法术选择事件: ${e.title} (通过法术浏览器动态加载)`);
                        return true;
                    }
                    window.OriginateLog(`Originate | 过滤掉空选择事件: ${e.title} (所有选项均不满足条件)。再见。`);
                    return false;
                }
                return true;
            });

            if (levelEvents.length < originalCount) {
                window.OriginateLog(`Originate | 过滤后剩余 ${levelEvents.length} 个事件`);
            }
        }

        // 2. 文件夹查找作为补充 - 但只在 levelEvents 为空时使用
        // 因为文件夹查找会返回所有等级的特性，不适合作为主要数据源
        // 这是最后的救命稻草
        let folderFeatures = [];
        if (levelEvents.length === 0) {
            window.OriginateLog(`Originate | levelEvents 为空，尝试文件夹查找作为回退。希望文件夹里有东西。`);
            folderFeatures = await this.dataManager.getFeatures(type, option.name);
        }

        // 2.5 解析 startingEquipment — 从 dnd5e 原生数据生成装备选择事件
        // 自动追加到当前来源（职业/种族/背景）的向导末尾
        try {
            const equipEvent = await this._parseStartingEquipment(option.uuid);
            if (equipEvent) {
                window.OriginateLog(`Originate | 发现 ${type} 的起始装备数据，追加装备选择步骤`);
                levelEvents.push(equipEvent);
            }
        } catch (err) {
            console.warn(`Originate | 解析 ${type} 起始装备失败:`, err);
        }

        // 3. 准备子界面数据
        const subContext = {
            option: option,
            levelEvents: levelEvents,
            folderFeatures: folderFeatures, // 作为备用或补充
            type: type,
            // 知识库中的额外数据 (作为补充，如装备)
            // 虽然现在基本不用了，但留着也没坏处
            knowledge: this._getKnowledgeData(type, option.name)
        };

        window.OriginateLog(`Originate | 准备渲染子界面，subContext:`, subContext);
        await this._renderFullSubInterface(subContext);
        window.OriginateLog(`Originate | _renderSubInterface 完成。累死我了。`);
        return true;
    }

    async _renderSubclassSelection(option) {
        // 这里不再渲染详情面板，而是更新“下一步”按钮的状态
        // 简单点，说话的方式简单点
        const btn = this.element.querySelector('.subclass-confirm-btn');
        if (btn) {
            btn.dataset.id = option.id;
            btn.disabled = false;
        }
    }

    _getKnowledgeData(type, name) {
        // 新版本不再使用静态知识库数据，所有数据直接从 Compendium 读取
        // 保留此方法以保持向后兼容，但始终返回 null
        // 就像阑尾一样，虽然没用，但切了又怕疼
        return null;
    }

    async _processStandardSelection(type, id, option) {
        // 重置当前步骤的 Blueprint 数据
        this.blueprintData[this.currentStep] = { items: [], system: {} };
        const currentBlueprint = this.blueprintData[this.currentStep];

        // 2. 获取新 Item 数据
        let itemDoc;
        if (option) {
            itemDoc = await this.dataManager.getDocument(option.uuid);
        } else {
            const sourcePacks = game.settings.get('character-forge', 'sourcePacks');
            const packIds = sourcePacks[type] || [];
            if (packIds.length > 0) {
                const pack = game.packs.get(packIds[0]);
                if (pack) {
                    itemDoc = await pack.getDocument(id);
                }
            }
        }

        if (!itemDoc) {
            ui.notifications.error(game.i18n.localize("ORIGINATE.Error.ItemDataNotFound"));
            return;
        }

        const itemData = itemDoc.toObject();
        this._pendingItemData = itemData;

        // 3. 查找关联特性 (Features)
        const features = await this.dataManager.getFeatures(type, itemData.name);

        // Adrian: 属性加成延迟处理 (Attribute Deferral)
        // 用户希望种族和背景的属性加成不要立生效，而是等到属性分配步骤确认后再加。
        // 所以我们在这里把 ASI (Ability Score Improvement) 拦截下来，存到 context 里。
        if (type === 'race' || type === 'background') {
            if (itemData.system?.advancement) {
                const advancements = getAdvancementEntries(itemData.system.advancement);
                const asiAdvancements = advancements.filter(a => a.type === 'AbilityScoreImprovement');

                if (asiAdvancements.length > 0) {
                    window.OriginateLog(`Originate | 拦截到 ${type} 的 ASI Advancement，准备延迟应用。`, asiAdvancements);

                    // 初始化 deferredASIs 容器
                    if (!this.context.deferredASIs) this.context.deferredASIs = [];
                    // 初始化 deferredAdvancements 容器 (存储完整对象以便恢复)
                    if (!this.context.deferredAdvancements) this.context.deferredAdvancements = [];

                    // Adrian: 清除该类型 (Race/Background) 之前的旧数据，防止重复叠加
                    this.context.deferredASIs = this.context.deferredASIs.filter(d => d.sourceType !== type);
                    this.context.deferredAdvancements = this.context.deferredAdvancements.filter(d => d.sourceType !== type);

                    // 提取并存储加成信息
                    asiAdvancements.forEach(adv => {
                        // 存储完整对象
                        this.context.deferredAdvancements.push({
                            advancement: adv,
                            sourceType: type,
                            sourceName: itemData.name
                        });

                        if (adv.value && adv.value.type === 'asi') {
                            // 固定加成 (Fixed)
                            for (const [ability, value] of Object.entries(adv.value.assignments || {})) {
                                this.context.deferredASIs.push({
                                    type: 'fixed',
                                    ability: ability,
                                    value: value,
                                    source: itemData.name,
                                    sourceType: type
                                });
                            }
                        } else if (adv.configuration && adv.configuration.fixed) {
                            // 另一种常见的 DND5E 数据结构
                            for (const [ability, value] of Object.entries(adv.configuration.fixed || {})) {
                                this.context.deferredASIs.push({
                                    type: 'fixed',
                                    ability: ability,
                                    value: value,
                                    source: itemData.name,
                                    sourceType: type
                                });
                            }
                        }
                    });

                    // 暂时移除这些 ASI Advancement，防止创建 Item 时自动应用
                    // 我们会在属性确认步骤后把它们加回来（或者以其他方式应用）
                    const remainingAdvancements = advancements.filter(a => a.type !== 'AbilityScoreImprovement');
                    itemData.system.advancement = setAdvancementSource(itemData.system.advancement, remainingAdvancements);
                    window.OriginateLog(`Originate | 已从 ${itemData.name} 中移除 ASI Advancement。剩余 Advancement 数量: ${remainingAdvancements.length}`);
                }
            }
        }

        if (features.length > 0) {
            window.OriginateLog(`Originate | Found ${features.length} features for ${itemData.name}`);
            this._pendingFeatures = features;

            // 智能检测模式
            // 试图理解策划的意图，虽然通常是徒劳的
            const description = itemData.system.description?.value || "";
            const mode = this._detectSelectionMode(description, features.length);
            window.OriginateLog(`Originate | Detected mode: ${mode} for ${itemData.name}`);

            this._renderFeatureSelectionOverlay(itemData.name, features, mode);
        } else {
            window.OriginateLog(`Originate | No features found, creating item directly.`);
            await this._createItemWithFeatures(itemData, []);
        }
    }

    async _renderSubOptionDialog(option, subOptions) {
        let content = `<div class="sub-option-dialog">
            <h3>${subOptions.title}</h3>
            <div class="sub-option-list">`;

        subOptions.choices.forEach(choice => {
            if (choice.type === 'skill') {
                // 技能选择暂未实现完全交互，仅提示
                content += `<div class="sub-option-item">
                    <label><input type="checkbox" disabled checked> ${choice.label} (将在技能页选择)</label>
                </div>`;
            } else if (choice.type === 'feat') {
                content += `<div class="sub-option-item">
                    <label><input type="checkbox" disabled checked> ${choice.label} (将在专长页选择)</label>
                </div>`;
            } else {
                content += `<div class="sub-option-item">
                    <label>
                        <input type="radio" name="subOption" value="${choice.value}">
                        <span class="option-label">${choice.label}</span>
                        ${choice.desc ? `<div class="option-desc">${choice.desc}</div>` : ''}
                    </label>
                </div>`;
            }
        });
        content += `</div></div>`;

        new Dialog({
            title: `选择 ${option.name} 详情`,
            content: content,
            buttons: {
                confirm: {
                    label: "确认",
                    callback: async (html) => {
                        const selected = html.find('input[name="subOption"]:checked').val();
                        // 记录选择 (这里简化处理，实际可能需要根据选择创建额外 Item)
                        if (selected) {
                            window.OriginateLog(`Originate | User selected sub-option: ${selected}`);
                            this.context.selections[option.name] = selected;
                            // TODO: 根据选择添加特性 (如果数据包中有对应 Item)
                        }
                        // 继续标准流程
                        await this._processStandardSelection(this.currentStep, option.id, option);
                    }
                }
            },
            default: "confirm"
        }).render(true);
    }

    _detectSelectionMode(description, featureCount) {
        // 关键词列表
        // 试图从描述中猜测规则，就像在读天书
        const selectionKeywords = [
            "你选择", "任选", "选择一个", "选择一种", "从下列",
            "choose one", "select one", "choice of", "choose a"
        ];

        // 移除 HTML 标签进行纯文本检查
        const cleanDesc = description.replace(/<[^>]*>/g, "").toLowerCase();

        // 检查是否包含关键词
        const hasKeyword = selectionKeywords.some(k => cleanDesc.includes(k));

        if (hasKeyword) return 'selection';

        // 如果没有关键词，但特性数量 > 1，我们默认为展示模式（全选），但允许用户取消
        // 除非只有一个特性，那肯定是获得的
        return 'display';
    }

    _renderFeatureSelectionOverlay(title, features, mode) {
        let overlay = this.element.querySelector('.originate-advancement-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'originate-advancement-overlay';
            this.element.querySelector('.originate-container').appendChild(overlay);
        }

        // 默认选中状态
        // selection 模式：默认不选
        // display 模式：默认全选
        const isSelected = mode === 'display';
        const promptText = mode === 'selection' ? "请从左侧列表选择一项特性：" : "您将获得以下特性：";

        // 生成特性列表 HTML
        let listHtml = features.map((f, index) => `
            <div class="option-card compact-feature-card feature-list-item ${isSelected ? 'selected' : ''} ${index === 0 ? 'active' : ''}" 
                 data-uuid="${f.uuid}" 
                 data-action="previewFeature">
                <div class="item-checkbox" data-action="toggleFeature">
                    <i class="fas fa-check"></i>
                </div>
                <img src="${f.icon}" class="feature-icon">
                <div class="feature-info-compact">
                    <div class="feature-title">${f.name}</div>
                </div>
            </div>
        `).join('');

        overlay.innerHTML = `
            <div class="overlay-header">
                <h3>${title} 特性</h3>
                <p>${promptText}</p>
            </div>
            <div class="overlay-split-container">
                <div class="feature-selection-list">
                    ${listHtml}
                </div>
                <div class="feature-preview-panel">
                    <!-- 默认显示第一项的预览 -->
                    <div class="preview-placeholder">
                        <i class="fas fa-spinner fa-spin"></i> 正在加载详情...
                    </div>
                </div>
            </div>
            <div class="overlay-actions">
                <button type="button" data-action="cancelFeatures">${game.i18n.localize('ORIGINATE.UI.Button.Cancel')}</button>
                <button type="button" class="confirm-btn" data-action="confirmFeatures" ${mode === 'selection' ? 'disabled' : ''}>${game.i18n.localize('ORIGINATE.UI.Button.ConfirmSelection')}</button>
            </div>
        `;

        // 立即触发第一项的预览
        if (features.length > 0) {
            const firstItem = overlay.querySelector('.feature-list-item');
            this._onPreviewFeature(null, firstItem);
        }
    }

    async _onPreviewFeature(event, target) {
        // 如果是点击复选框触发的，不要切换预览，除非它是当前未激活的项
        if (event && event.target.closest('.item-checkbox')) return;

        const overlay = this.element.querySelector('.originate-advancement-overlay');

        // 更新列表激活状态
        overlay.querySelectorAll('.feature-list-item').forEach(el => el.classList.remove('active'));
        target.classList.add('active');

        const uuid = target.dataset.uuid;
        const previewPanel = overlay.querySelector('.feature-preview-panel');

        // 显示加载状态
        previewPanel.innerHTML = `<div class="preview-placeholder"><i class="fas fa-spinner fa-spin"></i> 正在加载...</div>`;

        try {
            const doc = await this.dataManager.getDocument(uuid);
            if (!doc) {
                previewPanel.innerHTML = `<div class="preview-placeholder">无法加载详情</div>`;
                return;
            }

            previewPanel.innerHTML = `
                <div class="preview-header">
                    <img src="${doc.img}" class="preview-icon">
                    <div class="preview-title">${doc.name}</div>
                </div>
                <div class="preview-body">
                    ${doc.system.description.value}
                </div>
            `;
        } catch (e) {
            console.error("Originate | Failed to load preview:", e);
            previewPanel.innerHTML = `<div class="preview-placeholder">加载失败</div>`;
        }
    }

    _onToggleFeature(event, target) {
        event.stopPropagation(); // 防止触发预览
        const listItem = target.closest('.feature-list-item');
        listItem.classList.toggle('selected');

        // 更新确认按钮状态
        const overlay = this.element.querySelector('.originate-advancement-overlay');
        const hasSelection = overlay.querySelector('.feature-list-item.selected');
        const confirmBtn = overlay.querySelector('.confirm-btn');

        if (confirmBtn) {
            confirmBtn.disabled = !hasSelection;
        }
    }

    async _onConfirmFeatures(event, target) {
        const overlay = this.element.querySelector('.originate-advancement-overlay');
        const selectedEls = overlay.querySelectorAll('.feature-list-item.selected');
        const selectedUUIDs = Array.from(selectedEls).map(el => el.dataset.uuid);

        const selectedFeatures = [];
        for (const uuid of selectedUUIDs) {
            const doc = await this.dataManager.getDocument(uuid);
            if (doc) selectedFeatures.push(doc.toObject());
        }

        this._closeAdvancementOverlay();
        await this._createItemWithFeatures(this._pendingItemData, selectedFeatures);
    }

    _onCancelFeatures(event, target) {
        this._closeAdvancementOverlay();
        this._pendingItemData = null;
        this._pendingFeatures = [];
    }

    _closeAdvancementOverlay() {
        const overlay = this.element.querySelector('.originate-advancement-overlay');
        if (overlay) overlay.remove();
    }

    _updateSelectionState(html) {
        // 移除所有选中状态
        html.find('.strip-item').removeClass('selected');

        // 获取当前步骤的选中项 ID
        const currentId = this.context[this.currentStep];

        if (currentId) {
            // 添加选中状态
            html.find(`.strip-item[data-id="${currentId}"]`).addClass('selected');
            // 兼容 UUID 作为 ID 的情况（处理点号等特殊字符需小心，但 data 属性查找通常没问题）
            // 如果 ID 包含特殊字符，jQuery 选择器可能需要转义，但属性选择器通常可以处理引号内的值
            // 为安全起见，尝试更精确的匹配
            const items = html.find('.strip-item');
            items.each((i, el) => {
                if (el.dataset.id === currentId || el.dataset.uuid === currentId) {
                    el.classList.add('selected');
                }
            });
        }
    }

    async _createItemWithFeatures(itemData, features) {
        try {
            const currentBlueprint = this.blueprintData[this.currentStep];
            const stepType = this.currentStep;

            // 强制设置特性类型
            if (this._applyFeatureType) {
                this._applyFeatureType(itemData, stepType);
            }
            currentBlueprint.items.push(itemData);

            features.forEach(f => {
                // 强制设置特性类型
                if (this._applyFeatureType) {
                    this._applyFeatureType(f, stepType);
                }
                currentBlueprint.items.push(f);
            });

            ui.notifications.info(game.i18n.format("ORIGINATE.UI.Selection.Staged", { name: itemData.name, count: features.length }));

            // 成功后自动进入下一步
            if (this._onNextStep) {
                await this._onNextStep();
            }

        } catch (e) {
            console.error("Originate | Error creating items:", e);
            ui.notifications.error(game.i18n.localize("ORIGINATE.Error.ItemCreateFailed"));
        }
    }

    /**
     * 读取 dnd5e 原生起始装备。这里保留分组树，具体选择交给向导处理。
     */
    async _parseStartingEquipment(uuid) {
        if (!uuid) return null;

        let doc;
        try {
            doc = await fromUuid(uuid);
        } catch (e) {
            return null;
        }
        if (!doc) return null;

        const startingEquipment = Array.isArray(doc.system?.startingEquipment)
            ? doc.system.startingEquipment
            : [];
        const wealth = doc.system?.wealth;
        const categoryOptions = new Map();
        const event = await buildStartingEquipmentEvent({
            entries: startingEquipment,
            wealth,
            title: game.i18n.localize('ORIGINATE.UI.Progression.StartingEquipment'),
            sourceUuid: uuid,
            sourceName: doc.name,
            resolveLinkedItem: async itemUuid => {
                try {
                    return await fromUuid(itemUuid);
                } catch (error) {
                    window.OriginateLog(`Originate | 加载起始装备失败: ${itemUuid}`, error);
                    return null;
                }
            },
            resolveCategoryOptions: entry => {
                const cacheKey = entry.type + ':' + (entry.key || '');
                if (!categoryOptions.has(cacheKey)) {
                    categoryOptions.set(cacheKey, this._getStartingEquipmentCategoryOptions(entry));
                }
                return categoryOptions.get(cacheKey);
            },
            getCategoryLabel: entry => this._getEquipmentCategoryLabel(entry.type, entry.key)
        });

        if (!event) return null;
        for (const warning of event.warnings) console.warn(`Originate | ${warning}`);
        window.OriginateLog(`Originate | 起始装备事件构建完成 (${event.roots.length} 个顶层组):`, event);
        return event;
    }

    async _getStartingEquipmentCategoryOptions(entry) {
        const config = CONFIG.DND5E || {};
        let configuredIds = [];

        if (entry.type === 'weapon') {
            configuredIds = Object.values(config.weaponIds || {});
        } else if (entry.type === 'armor') {
            configuredIds = [
                ...Object.values(config.armorIds || {}),
                ...Object.values(config.shieldIds || {})
            ];
        } else if (entry.type === 'tool') {
            configuredIds = Object.values(config.toolIds || {});
        } else if (entry.type === 'focus') {
            configuredIds = Object.values(config.focusTypes?.[entry.key]?.itemIds || {});
        }

        const uuids = Array.from(new Set(configuredIds.map(getEquipmentConfigUuid).filter(Boolean)));
        const options = [];

        for (const itemUuid of uuids) {
            if (this.dataManager?.isItemExcluded?.(itemUuid)) continue;
            try {
                const item = await fromUuid(itemUuid);
                if (!item || !matchesEquipmentCategory(item, entry, config)) continue;
                options.push({
                    uuid: itemUuid,
                    name: item.name,
                    img: item.img || 'icons/svg/item-bag.svg'
                });
            } catch (error) {
                window.OriginateLog(`Originate | 加载起始装备类别物品失败: ${itemUuid}`, error);
            }
        }

        return options.sort((left, right) => left.name.localeCompare(right.name));
    }

    /**
     * 获取装备类别的显示标签
     * @param {string} type - 类别类型 (tool, weapon, armor...)
     * @param {string} key - 类别键值 (music, simple, martial...)
     * @returns {string} 人类可读的标签
     */
    _getEquipmentCategoryLabel(type, key) {
        const config = CONFIG.DND5E || {};
        const configMaps = {
            tool: [config.toolTypes, config.toolProficiencies],
            weapon: [config.weaponTypes, config.weaponProficiencies],
            armor: [config.armorTypes, config.armorProficiencies],
            focus: [config.focusTypes]
        };

        for (const typeConfig of configMaps[type] || []) {
            const value = key ? typeConfig?.[key] : null;
            const label = typeof value === 'string' ? value : value?.label;
            if (label) return `${label} (${game.i18n.localize('ORIGINATE.UI.Equipment.PlayerChoice')})`;
        }

        // 配置里没有这个键时仍给出原始键，至少别把第三方规则静默吞掉。
        const typeLabels = {
            tool: game.i18n.localize('ORIGINATE.UI.Equipment.Tool') || 'Tool',
            weapon: game.i18n.localize('ORIGINATE.UI.Equipment.Weapon') || 'Weapon',
            armor: game.i18n.localize('ORIGINATE.UI.Equipment.Armor') || 'Armor',
            shield: game.i18n.localize('ORIGINATE.UI.Equipment.Shield') || 'Shield',
            focus: game.i18n.localize('ORIGINATE.UI.Equipment.Focus') || 'Focus'
        };
        const typeLabel = typeLabels[type] || type;
        const keyLabel = key ? ` (${key})` : '';
        return `${typeLabel}${keyLabel}`;
    }
};
