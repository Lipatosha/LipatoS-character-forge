import {
    getAdvancementName,
    getAdvancementEntries,
    hasAdvancementEntries,
    setAdvancementSource
} from './utils/advancement-utils.js';
import {
    applyGrantedSpellConfigs,
    buildItemSourceLookup
} from './shared/advancement-rule-utils.js';
import {
    prepareResolutionItemData,
    resolveItemSourceUuid,
    stampSourceTracking
} from './shared/resolution-core.js';
import { normalizeToolId, toNativeWeaponMasteryKey } from './mapping.js';

export class HeroGenesisWriter {
    static _resolveCreateOptions(options = {}) {
        const itemsMode = options.itemsMode || 'full';
        const isScaffold = itemsMode === 'scaffold';

        // scaffold + 原生结算才是现在的正常创角路径。
        // 这个类名有历史包袱，但 scaffold 模式只负责先搭壳子；新规则别再塞回旧 full writer。
        // full 模式保留给旧蓝图和排障，所以旧 repair 也只默认跟着 full 模式走。
        return {
            itemsMode,
            renderSheet: options.renderSheet ?? true,
            repairTraits: options.repairTraits ?? !isScaffold,
            repairAdvancements: options.repairAdvancements ?? !isScaffold,
            repairOrigins: options.repairOrigins ?? !isScaffold,
            repairHitPoints: options.repairHitPoints ?? !isScaffold,
            prefillAdvancementValues: options.prefillAdvancementValues ?? !isScaffold
        };
    }

    /**
     * 弗兰肯斯坦的实验室 - 角色生成器
     * 
     * 好了，最血腥的部分来了。我要把这一堆蓝图碎片缝合成一个活生生的 Actor。
     * 这过程比你想象的要复杂得多：创建 Actor、塞进物品、修复 ID、处理依赖、计算 HP……
     * 其实我还是得说一句，dnd5的系统...哎，反正我是听说不如PF2的，emmmm小小抱怨一句应该没事
     * 
     * @param {Object} blueprint - 角色蓝图，也就是那堆碎片
     * @param {Actor|null} existingActor - 现有的受害者（可选）
     * @returns {Promise<Actor>} 缝合好的怪物（或者叫角色）
     */
    static async createFromBlueprint(blueprint, existingActor = null, options = {}) {
        const {
            itemsMode,
            renderSheet,
            repairTraits,
            repairAdvancements,
            repairOrigins,
            repairHitPoints,
            prefillAdvancementValues
        } = this._resolveCreateOptions(options);
        window.OriginateLog("Originate | Writing Actor from Blueprint:", blueprint);

        let actor = existingActor;

        // 1. 创造躯壳
        // 如果没有现成的躯壳，我就捏一个。
        // 默认名字叫“新角色”，头像是个神秘人，暂时还没法改头像，好吧主要我担心originate的全屏会和隔壁OV的界面不太搭，暂时就先不弄了，但名字还是可以加的
        if (!actor) {
            const actorData = {
                name: blueprint.name || "新角色",
                type: "character",
                img: blueprint.img || "icons/svg/mystery-man.svg"
            };
            foundry.utils.setProperty(actorData, 'flags.originate.createdBy', 'originate');
            foundry.utils.setProperty(actorData, 'flags.hero-genesis.created', true);
            actor = await Actor.create(actorData);
        } else {
            // 如果有现成的，那就给它整整容
            const updateData = {};
            if (blueprint.name) {
                updateData.name = blueprint.name;
                // 创角先创建了占位角色，Foundry 不会随角色改名同步已有的原型 Token 名称。
                updateData['prototypeToken.name'] = blueprint.name;
            }
            if (blueprint.img) updateData.img = blueprint.img;
            updateData['flags.originate.createdBy'] = 'originate';
            updateData['flags.hero-genesis.created'] = true;
            if (Object.keys(updateData).length > 0) await actor.update(updateData);
        }

        // 2. 填充内脏（物品处理）
        // 这里的逻辑简直是噩梦。我要处理 UUID、Item Data、还有那些该死的 Advancement。
        // 准备好，我们要深入下水道了，我希望DND在未来的更新中不要再改这些东西了，不然我就得再来一次了，真的会死人的
        const uuidToItemData = new Map();
        const itemsToCreate = [];
        const blueprintItems = itemsMode === 'scaffold'
            ? (blueprint.scaffoldItems || blueprint.rootItems || blueprint.items || [])
            : (blueprint.items || []);
        if (blueprintItems.length > 0) {
            for (const itemEntry of blueprintItems) {
                try {
                    let itemData = null;
                    if (typeof itemEntry === 'string') {
                        // 只是个 UUID？懒鬼
                        const item = await fromUuid(itemEntry);
                        if (item) {
                            itemData = item.toObject();
                        } else {
                            console.warn(`Originate | 找不到物品 ${itemEntry}。它是不是私奔了？`);
                        }
                    } else if (typeof itemEntry === 'object') {
                        // 已经是对象了？不错。
                        itemData = foundry.utils.deepClone(itemEntry);

                        // 这里的坑很大：有时候 parser 给我的只是个“摘要”，里面除了名字和 UUID 啥都没有。
                        // 就像给我一张名片让我造个人出来。所以我得去查户口。
                        if (itemData.uuid && (!itemData.system || Object.keys(itemData.system).length < 2)) {
                            try {
                                const fullItem = await fromUuid(itemData.uuid);
                                if (fullItem) {
                                    const fullData = fullItem.toObject();

                                    // 别急，我得先把用户自定义的那些小改动存起来。
                                    // 不然加载完完整数据，用户的改动就被覆盖了，那我肯定会被骂死。
                                    const overrides = {};
                                    if (itemData.flags) overrides.flags = foundry.utils.deepClone(itemData.flags);
                                    if (itemData.system?.preparation) overrides.preparation = foundry.utils.deepClone(itemData.system.preparation);
                                    if (itemData.system?.uses) overrides.uses = foundry.utils.deepClone(itemData.system.uses);
                                    if (itemData.system?.activities) overrides.activities = foundry.utils.deepClone(itemData.system.activities);
                                    if (itemData.system?.method) overrides.method = itemData.system.method;
                                    if (itemData.system?.sourceClass) overrides.sourceClass = itemData.system.sourceClass;
                                    if (itemData.system?.prepared !== undefined) overrides.prepared = itemData.system.prepared;

                                    // 好了，现在用完整数据覆盖那个残废的摘要
                                    // 但别忘了保留 UUID，这可是它的身份证
                                    const originalUuid = itemData.uuid;
                                    itemData = foundry.utils.deepClone(fullData);
                                    if (originalUuid && !itemData.uuid) itemData.uuid = originalUuid;

                                    // 然后把用户的改动贴回去。这叫“无损修复”，学着点。
                                    if (overrides.flags) {
                                        itemData.flags = foundry.utils.mergeObject(itemData.flags || {}, overrides.flags);
                                    }
                                    if (overrides.preparation && itemData.system) {
                                        itemData.system.preparation = foundry.utils.mergeObject(
                                            itemData.system.preparation || {},
                                            overrides.preparation
                                        );
                                    }
                                    if (overrides.uses && itemData.system) {
                                        itemData.system.uses = foundry.utils.mergeObject(
                                            itemData.system.uses || {},
                                            overrides.uses
                                        );
                                    }
                                    if (overrides.activities && itemData.system) {
                                        itemData.system.activities = foundry.utils.mergeObject(
                                            itemData.system.activities || {},
                                            overrides.activities
                                        );
                                    }
                                    if (overrides.method && itemData.system) {
                                        itemData.system.method = overrides.method;
                                    }
                                    if (overrides.sourceClass && itemData.system) {
                                        itemData.system.sourceClass = overrides.sourceClass;
                                    }
                                    if (overrides.prepared !== undefined && itemData.system) {
                                        itemData.system.prepared = overrides.prepared;
                                    }

                                    window.OriginateLog(`Originate | Reloaded full data for ${itemData.name} from ${fullData.uuid || itemEntry.uuid}`);
                                }
                            } catch (e) {
                                console.warn(`Originate | Failed to reload full data for ${itemData.name}:`, e);
                            }
                        }
                    }

                    if (itemData) {
                        // 给我记住这个 ID！待会儿修复引用的时候要用。
            
                        if (itemData._id) {
                            foundry.utils.setProperty(itemData, "flags.originate.originalId", itemData._id);
                        }

                        const sourceUuid = resolveItemSourceUuid(itemData);
                        if (itemData.type === 'spell') {
                            let spellSourceClass = itemData.system?.sourceClass || null;

                            // 创角老链路里有些法术不会把来源职业一路带到底。
                            // 先在这里补上，不然 5.3 会把魔契师法术全扔去普通法术栏。
                            if (!spellSourceClass) {
                                const classItem = itemsToCreate.find(i => i.type === 'class');
                                if (classItem?.system?.identifier) {
                                    spellSourceClass = classItem.system.identifier;
                                    if (!itemData.system) itemData.system = {};
                                    itemData.system.sourceClass = spellSourceClass;
                                    window.OriginateLog(`Originate | 设置法术 ${itemData.name} 的 sourceClass 为 ${spellSourceClass}（回退推断）`);
                                }
                            }
                        }

                        await prepareResolutionItemData(itemData, {
                            sourceUuid,
                            sourceClass: itemData.type === 'spell' ? itemData.system?.sourceClass || null : null,
                            restoreFeatType: itemData.type === 'feat',
                            warnPrefix: 'Originate |'
                        });

                        itemsToCreate.push(itemData);
                    }
                } catch (e) {
                    console.error("Originate | Error processing item for blueprint:", itemEntry, e);
                }
            }
        }

        // ========================================
        // 容器内容解析阶段 - 套组 / 背包等容器类物品的内容物
        // ========================================
        // 在 dnd5e 的合集中，容器的内容物是作为独立的 Item 存储的，
        // 每个子物品通过 system.container 指向父容器的 ID。
        // toObject() 只会获取容器本身，不会携带内容物。
        // 所以我们需要手动从合集中查找并添加这些子物品。
        const containerIdRemap = new Map(); // oldCompendiumId -> 用于后续重映射 system.container
        const containersToProcess = itemsToCreate.filter(i => i.type === 'container');

        for (const containerItem of containersToProcess) {
            const sourceUuid = resolveItemSourceUuid(containerItem);
            if (!sourceUuid) continue;

            try {
                // 从 UUID 中提取合集包信息
                // 格式: Compendium.module.pack.itemId 或 Compendium.module.pack.Item.itemId
                const uuidParts = sourceUuid.split('.');
                if (uuidParts.length < 4 || uuidParts[0] !== 'Compendium') continue;

                const packKey = `${uuidParts[1]}.${uuidParts[2]}`;
                const containerId = uuidParts[uuidParts.length - 1]; // 最后一段始终是 ID
                const pack = game.packs.get(packKey);
                if (!pack) {
                    window.OriginateLog(`Originate | 未找到合集包 ${packKey}，跳过容器 ${containerItem.name}`);
                    continue;
                }

                // 获取合集包的完整索引（包含 system.container 字段）
                await pack.getIndex({ fields: ["system.container"] });
                const index = pack.index;

                // 查找所有 system.container 指向此容器的子物品
                const childEntries = index.filter(entry => entry.system?.container === containerId);

                if (childEntries.length > 0) {
                    window.OriginateLog(`Originate | 容器 ${containerItem.name} 包含 ${childEntries.length} 个内容物，正在加载...`);

                    for (const childEntry of childEntries) {
                        try {
                            const childDoc = await pack.getDocument(childEntry._id);
                            if (childDoc) {
                                const childData = childDoc.toObject();
                                const childUuid = `Compendium.${packKey}.Item.${childEntry._id}`;
                                stampSourceTracking(childData, childUuid);

                                // 记录原始的 container ID，后续会替换为 actor 上的新 ID
                                foundry.utils.setProperty(childData, "flags.originate.pendingContainerId", containerId);

                                // 暂时清空 system.container，等创建后再设置
                                // (因为创建时旧的 compendium ID 在 actor 上不存在)
                                delete childData.system.container;

                                itemsToCreate.push(childData);
                                window.OriginateLog(`Originate | 添加容器内容物: ${childData.name} (来自 ${containerItem.name})`);
                            }
                        } catch (e) {
                            console.warn(`Originate | 无法加载容器内容物 ${childEntry.name}:`, e);
                        }
                    }

                    // 记录容器 ID 映射，用于后续重建 system.container 引用
                    containerIdRemap.set(containerId, containerItem);
                }
            } catch (e) {
                console.warn(`Originate | 处理容器 ${containerItem.name} 的内容物时出错:`, e);
            }
        }
        if (containerIdRemap.size > 0) {
            window.OriginateLog(`Originate | 共发现 ${containerIdRemap.size} 个容器需要重映射内容物`);
        }

        // 呼呼，下一步
        // 预生成 ID 策略 - 核心阶段
        // 
        // 
        // 这是整个修复的关键！我们要在创建物品前就建立完美的引用关系。
        // 
        // 步骤：
        // 1. 为所有物品预生成 ID
        // 2. 建立 sourceUuid -> preGeneratedId 的映射
        // 3. 在内存中填充 Advancement 的 value 字段
        // 4. 然后才创建物品
        //
        // 这样做的好处是：创建时数据就是完整的，不需要后续修复。

        // 步骤 1: 为所有物品预生成 ID
        const sourceUuidToPreGeneratedId = new Map();
        const traitSelections = this._collectTraitSelections(blueprint.system || {});
        const traitClaims = {
            default: new Set(),
            expertise: new Set(),
            mastery: new Set()
        };
        window.OriginateLog(
            "Originate | [TraitSnapshot:blueprint-input]",
            this._debugTraitSnapshot(blueprint.system || {})
        );

        for (const item of itemsToCreate) {
            // 预生成 ID
            item._id = foundry.utils.randomID();

            // 建立 sourceUuid -> preGeneratedId 的映射
            const sourceUuid = resolveItemSourceUuid(item);
            if (sourceUuid) {
                sourceUuidToPreGeneratedId.set(sourceUuid, item._id);
                // 同时记录简化的 UUID
                const simplifiedUuid = sourceUuid.replace(/\.Item\./, '.');
                if (simplifiedUuid !== sourceUuid) {
                    sourceUuidToPreGeneratedId.set(simplifiedUuid, item._id);
                }
                // 记录 Item ID（UUID 的最后一部分）
                const uuidParts = sourceUuid.split('.');
                const itemId = uuidParts[uuidParts.length - 1];
                if (itemId && itemId.length >= 16) {
                    sourceUuidToPreGeneratedId.set(itemId, item._id);
                }
            }
        }
        window.OriginateLog(`Originate | 预生成 ID 映射表 (${sourceUuidToPreGeneratedId.size} 条):`,
            Array.from(sourceUuidToPreGeneratedId.entries()).slice(0, 20));

        // 步骤 2: 建立 advancementOrigin -> items 的映射
        const advancementOriginToItems = new Map();
        for (const item of itemsToCreate) {
            const origin = item.flags?.['hero-genesis']?.advancementOrigin;
            if (origin) {
                if (!advancementOriginToItems.has(origin)) {
                    advancementOriginToItems.set(origin, []);
                }
                advancementOriginToItems.get(origin).push(item);
            }
        }
        window.OriginateLog(`Originate | Advancement Origin 映射:`, Array.from(advancementOriginToItems.entries()).map(([k, v]) => `${k}: ${v.map(i => i.name).join(', ')}`));

        // full writer 内部可以预填 dnd5e.advancementOrigin。
        // 这个字段是 dnd5e 原生字段，格式是 {parentActorItemId}.{advancementId}，不是要删的旧桥。
        // 真正需要隔离的是后面那种全局扫描式 _fixAdvancementOriginFlags。

        // 步骤 2.5.1: 建立 advancementId -> parentItemId 的映射
        const advancementIdToParentId = new Map();
        const parentTypes = ['class', 'race', 'background', 'subclass'];

        for (const item of itemsToCreate) {
            const advancements = getAdvancementEntries(item.system?.advancement);
            if (parentTypes.includes(item.type) && advancements.length) {
                const parentItemId = item._id; // 使用预生成的 ID
                for (const adv of advancements) {
                    if (adv._id) {
                        advancementIdToParentId.set(adv._id, parentItemId);
                    }
                }
            }
        }
        window.OriginateLog(`Originate | Advancement ID -> Parent ID 映射 (${advancementIdToParentId.size} 条):`,
            Array.from(advancementIdToParentId.entries()).slice(0, 20));

        // 步骤 2.5.2: 为每个非父物品设置 dnd5e.advancementOrigin
        let dnd5eOriginSetCount = 0;
        for (const item of itemsToCreate) {
            // 跳过父物品本身
            if (parentTypes.includes(item.type)) continue;

            const heroGenesisOrigin = item.flags?.['hero-genesis']?.advancementOrigin;
            if (heroGenesisOrigin) {
                const parentItemId = advancementIdToParentId.get(heroGenesisOrigin);
                if (parentItemId) {
                    const dnd5eOrigin = `${parentItemId}.${heroGenesisOrigin}`;
                    const parentItem = itemsToCreate.find(candidate => candidate._id === parentItemId);
                    foundry.utils.setProperty(item, "flags.dnd5e.advancementOrigin", dnd5eOrigin);
                    foundry.utils.setProperty(item, "flags.dnd5e.advancementRoot", parentItem?.flags?.dnd5e?.advancementRoot || dnd5eOrigin);
                    dnd5eOriginSetCount++;
                    window.OriginateLog(`Originate | [dnd5e.advancementOrigin] ${item.name}: ${dnd5eOrigin}`);
                } else {
                    window.OriginateLog(`Originate | [警告] 无法为 ${item.name} 找到父物品 (advancementOrigin: ${heroGenesisOrigin})`);
                }
            }
        }
        window.OriginateLog(`Originate | 直接设置了 ${dnd5eOriginSetCount} 个物品的 dnd5e.advancementOrigin`);

        let hitDie = 8; // 默认 d8
        for (const item of itemsToCreate) {
            if (item.type === 'class') {
                // 记录生命骰
                const hitDieStr = item.system?.hd?.denomination || 'd8';
                const denomMatch = String(hitDieStr).match(/d?(\d+)/);
                if (denomMatch) {
                    hitDie = parseInt(denomMatch[1]);
                }

                const classLevel = item.system?.levels || 1;
                window.OriginateLog(`Originate | 职业 ${item.name} 生命骰: d${hitDie}, 等级: ${classLevel}`);

                // 预填充 HP 数据。
                // 但如果蓝图里已经带着玩家选过的结果，就别手欠给它抹成平均值了。
                const advancements = getAdvancementEntries(item.system?.advancement);
                if (prefillAdvancementValues && advancements.length) {
                    const hpAdvancement = advancements.find(a => a.type === 'HitPoints');
                    if (hpAdvancement) {
                        const avgHitDie = Math.ceil((hitDie + 1) / 2);
                        const existingHpValues = foundry.utils.deepClone(hpAdvancement.value || {});
                        const hpValues = {};

                        for (let lvl = 1; lvl <= classLevel; lvl++) {
                            if (existingHpValues[lvl] !== undefined && existingHpValues[lvl] !== null) {
                                hpValues[lvl] = existingHpValues[lvl];
                            } else if (lvl === 1) {
                                hpValues[lvl] = "max"; // 原生格式，别改
                            } else {
                                hpValues[lvl] = avgHitDie;
                            }
                        }

                        hpAdvancement.value = hpValues;
                        window.OriginateLog(`Originate | 职业 ${item.name} 的 HP advancement 已整理好，已有选择会原样保留。`);
                    } else {
                        console.warn(`Originate | 职业 ${item.name} 居然没有 HP advancement？这职业是幽灵吗？`);
                    }
                }

                window.OriginateLog(`Originate | 职业 ${item.name}: 保留所有 ${advancements.length} 个 advancement`);

                // 填充 Advancement 的 value 字段。
                // 如果不填这个，打开角色卡的时候就会看到一堆红色的“未配置”警告。
                // 我可不想被用户投诉说我没干完活。
                if (prefillAdvancementValues && advancements.length) {
                    for (const adv of this._getAdvancementsInBackfillOrder(advancements)) {
                        const relatedItems = advancementOriginToItems.get(adv._id) || [];

                        if (adv.type === 'ItemGrant') {
                            this._prefillItemGrantValue(adv, sourceUuidToPreGeneratedId, item);
                        } else if (adv.type === 'ItemChoice') {
                            // 【预生成 ID 策略】在创建前就填充 value
                            adv.value = {
                                added: {},
                                replaced: {}
                            };

                            // 查找属于此 advancement 的物品
                            const relatedItems = advancementOriginToItems.get(adv._id) || [];
                            for (const relatedItem of relatedItems) {
                                const level = this._resolveItemChoiceLevel(adv, relatedItem.flags?.['hero-genesis']?.acquiredAt);
                                const sourceUuid = resolveItemSourceUuid(relatedItem) || relatedItem.uuid;

                                if (sourceUuid && relatedItem._id) {
                                    if (!adv.value.added[level]) adv.value.added[level] = {};
                                    // 正确格式: actorItemId 作为键, sourceUuid 作为值
                                    adv.value.added[level][relatedItem._id] = sourceUuid;
                                    window.OriginateLog(`Originate | [预填充] ItemChoice ${adv._id}: Level ${level} ${relatedItem._id} -> ${sourceUuid}`);
                                }
                            }
                        } else if (adv.type === 'Trait') {
                            if (!repairTraits) continue;

                            this._populateTraitAdvancementValue(
                                adv,
                                traitSelections,
                                traitClaims,
                                `class:${item.name}:${adv._id}`
                            );
                            continue;
                            // Trait 类型 advancement 处理
                            // 需要填充 value.chosen 字段
                            if (!adv.value) adv.value = {};
                            if (!adv.value.chosen) adv.value.chosen = [];

                            // 情况1: grants 直接授予的特质（如豁免熟练、武器熟练、护甲受训）
                            // 这些不需要选择，grants 中的内容会自动应用
                            // 但 value.chosen 应该保持为空数组（系统会自动处理 grants）
                            this._populateTraitAdvancementValue(
                                adv,
                                traitSelections,
                                traitClaims,
                                `${item.type}:${item.name}:${adv._id}`
                            );
                            continue;
                            if (adv.configuration?.grants?.length > 0 && (!adv.configuration?.choices || adv.configuration.choices.length === 0)) {
                                // 纯 grants 类型，不需要填充 chosen
                                window.OriginateLog(`Originate | Trait ${adv._id} 是纯 grants 类型，无需填充 chosen`);
                            }
                            // 情况2: choices 需要选择的特质（如技能选择、武器精通选择）
                            else if (adv.configuration?.choices?.length > 0) {
                                // 从 blueprint.system 中获取已选择的值
                                // 根据 pool 中的前缀确定要查找的数据路径
                                const pool = adv.configuration.choices[0]?.pool || [];
                                const count = adv.configuration.choices[0]?.count || 1;

                                if (pool.length > 0) {
                                    const sampleKey = pool[0];

                                    // 武器精通 (mode: mastery)
                                    if (adv.configuration.mode === 'mastery' && sampleKey.startsWith('weapon:')) {
                                        // 从 blueprint.system 获取武器精通选择
                                        const masteryValue = blueprint.system?.['traits.weaponProf.mastery.value'] ||
                                            blueprint.system?.['traits.weaponMastery.value'] ||
                                            blueprint.system?.traits?.weaponProf?.mastery?.value || [];
                                        if (masteryValue.length > 0) {
                                            // 只取需要的数量
                                            adv.value.chosen = Array.isArray(masteryValue) ? masteryValue.slice(0, count) : [masteryValue];
                                            window.OriginateLog(`Originate | 填充武器精通 Trait ${adv._id}: ${adv.value.chosen.join(', ')}`);
                                        }
                                    }
                                    // 技能选择
                                    else if (sampleKey.startsWith('skills:')) {
                                        // 从 blueprint.system 获取技能熟练
                                        // 需要找出哪些技能是通过这个 advancement 获得的
                                        // 由于我们没有直接的映射，暂时跳过
                                        window.OriginateLog(`Originate | 跳过技能选择 Trait ${adv._id}（需要从 blueprint 推断）`);
                                    }
                                    // 语言选择
                                    else if (sampleKey.startsWith('languages:')) {
                                        const langValue = blueprint.system?.['traits.languages.value'] ||
                                            blueprint.system?.traits?.languages?.value || [];
                                        if (langValue.length > 0) {
                                            // 过滤出在 pool 中的语言
                                            const validChoices = langValue.filter(l => {
                                                return pool.some(p => p === l || p.endsWith(':*') && l.startsWith(p.replace(':*', ':')));
                                            });
                                            adv.value.chosen = validChoices.slice(0, count);
                                            window.OriginateLog(`Originate | 填充语言选择 Trait ${adv._id}: ${adv.value.chosen.join(', ')}`);
                                        }
                                    }
                                    // 工具熟练选择
                                    else if (sampleKey.startsWith('tool:')) {
                                        // 从 blueprint.system.tools 获取工具熟练
                                        const toolsData = blueprint.system?.tools || {};
                                        const toolKeys = Object.keys(toolsData).filter(k => toolsData[k]?.value > 0);
                                        if (toolKeys.length > 0) {
                                            adv.value.chosen = toolKeys.map(k => `tool:${k}`).slice(0, count);
                                            window.OriginateLog(`Originate | 填充工具熟练 Trait ${adv._id}: ${adv.value.chosen.join(', ')}`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 同样处理种族、背景和子职物品 - 保留所有 advancement 并填充 value
            if (item.type === 'race' || item.type === 'background' || item.type === 'subclass') {
                const advancements = getAdvancementEntries(item.system?.advancement);
                window.OriginateLog(`Originate | ${item.type} ${item.name}: 保留所有 ${advancements.length} 个 advancement`);

                // scaffold 的选择记录交给原生结算，不能在创建根物品时提前覆盖。
                if (prefillAdvancementValues && advancements.length) {
                    for (const adv of this._getAdvancementsInBackfillOrder(advancements)) {
                        const relatedItems = advancementOriginToItems.get(adv._id) || [];

                        if (adv.type === 'ItemGrant') {
                            this._prefillItemGrantValue(adv, sourceUuidToPreGeneratedId, item);
                        } else if (adv.type === 'ItemChoice') {
                            // 【预生成 ID 策略】在创建前就填充 value
                            adv.value = {
                                added: {},
                                replaced: {}
                            };

                            const relatedItems = advancementOriginToItems.get(adv._id) || [];
                            for (const relatedItem of relatedItems) {
                                const level = this._resolveItemChoiceLevel(adv, relatedItem.flags?.['hero-genesis']?.acquiredAt);
                                const sourceUuid = resolveItemSourceUuid(relatedItem) || relatedItem.uuid;

                                if (sourceUuid && relatedItem._id) {
                                    if (!adv.value.added[level]) adv.value.added[level] = {};
                                    // 正确格式: actorItemId 作为键, sourceUuid 作为值
                                    adv.value.added[level][relatedItem._id] = sourceUuid;
                                    window.OriginateLog(`Originate | [预填充] ${item.type} ItemChoice ${adv._id}: Level ${level} ${relatedItem._id} -> ${sourceUuid}`);
                                }
                            }
                        } else if (adv.type === 'Trait') {
                            // Trait 类型 advancement 处理（与职业相同的逻辑）
                            if (!adv.value) adv.value = {};
                            if (!adv.value.chosen) adv.value.chosen = [];

                            // 纯 grants 类型不需要填充 chosen
                            if (adv.configuration?.grants?.length > 0 && (!adv.configuration?.choices || adv.configuration.choices.length === 0)) {
                                window.OriginateLog(`Originate | ${item.type} Trait ${adv._id} 是纯 grants 类型，无需填充 chosen`);
                            }
                            // choices 需要选择的特质
                            else if (adv.configuration?.choices?.length > 0) {
                                const pool = adv.configuration.choices[0]?.pool || [];
                                const count = adv.configuration.choices[0]?.count || 1;

                                if (pool.length > 0) {
                                    const sampleKey = pool[0];

                                    // 语言选择
                                    if (sampleKey.startsWith('languages:')) {
                                        const langValue = blueprint.system?.['traits.languages.value'] ||
                                            blueprint.system?.traits?.languages?.value || [];
                                        if (langValue.length > 0) {
                                            const validChoices = langValue.filter(l => {
                                                return pool.some(p => p === l || (p.endsWith(':*') && l.startsWith(p.replace(':*', ':'))));
                                            });
                                            adv.value.chosen = validChoices.slice(0, count);
                                            window.OriginateLog(`Originate | 填充 ${item.type} 语言选择 Trait ${adv._id}: ${adv.value.chosen.join(', ')}`);
                                        }
                                    }
                                    // 技能选择
                                    else if (sampleKey.startsWith('skills:')) {
                                        window.OriginateLog(`Originate | 跳过 ${item.type} 技能选择 Trait ${adv._id}（需要从 blueprint 推断）`);
                                    }
                                    // 工具熟练选择
                                    else if (sampleKey.startsWith('tool:')) {
                                        const toolsData = blueprint.system?.tools || {};
                                        const toolKeys = Object.keys(toolsData).filter(k => toolsData[k]?.value > 0);
                                        if (toolKeys.length > 0) {
                                            adv.value.chosen = toolKeys.map(k => `tool:${k}`).slice(0, count);
                                            window.OriginateLog(`Originate | 填充 ${item.type} 工具熟练 Trait ${adv._id}: ${adv.value.chosen.join(', ')}`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 记录每个物品的原始 UUID
        for (const item of itemsToCreate) {
            // 尝试获取原始 UUID
            const sourceUuid = resolveItemSourceUuid(item) || item.uuid;
            if (sourceUuid) {
                uuidToItemData.set(sourceUuid, item);
                // 同时记录简化的 UUID（不带 Item. 前缀）
                const simplifiedUuid = sourceUuid.replace(/\.Item\./, '.');
                if (simplifiedUuid !== sourceUuid) {
                    uuidToItemData.set(simplifiedUuid, item);
                }
                // 记录物品名称到数据的映射（作为备用）
                uuidToItemData.set(`name:${item.name}`, item);

                // 提取 Item ID（UUID 的最后一部分）
                const uuidParts = sourceUuid.split('.');
                const itemId = uuidParts[uuidParts.length - 1];
                if (itemId && itemId.length >= 16) {
                    uuidToItemData.set(itemId, item);
                }
            }
        }
        window.OriginateLog(`Originate | UUID 映射表:`, Array.from(uuidToItemData.keys()));

        // 创角和升级都要补这一步，不然嵌套授予的免费施法/始终准备会只好一半。
        applyGrantedSpellConfigs(itemsToCreate, {
            itemLookup: buildItemSourceLookup(itemsToCreate),
            warnPrefix: 'Originate |'
        });

        // 依赖排序。
        // 就像盖房子一样，你得先打地基再盖楼。
        // 如果 A 物品消耗 B 物品的次数，那 B 必须先存在。
        // 这里的逻辑比我奶奶的毛线团还乱，但我已经尽力理顺了。
        const sortedItems = await this._sortItemsByDependency(itemsToCreate, uuidToItemData);
        window.OriginateLog(`Originate | 物品队列 (共 ${sortedItems.length} 个):`, sortedItems.map(i => i.name));

        if (sortedItems.length > 0) {
            // 这里的操作很骚：先清空所有的消耗引用，创建完物品后再填回去。
            // 为什么？因为如果在创建时引用不存在，系统会报错。
            // 就像先把插头拔了，等插座装好了再插上去。
            const itemsWithClearedConsumption = [];
            const originalConsumptionData = new Map();

            for (const item of sortedItems) {
                // 【关键修复】使用 JSON 序列化代替 deepClone
                // foundry.utils.deepClone 会将带点的键（如 "Compendium.xxx"）展开为嵌套对象
                // 这会破坏 advancement.value 的结构，导致系统认为升级未配置
                const itemCopy = JSON.parse(JSON.stringify(item));

                if (itemCopy.system?.activities) {
                    for (const [activityId, activity] of Object.entries(itemCopy.system.activities)) {
                        if (activity?.consumption?.targets?.length > 0) {
                            // 保存原始消耗数据
                            // 使用 sourceUuid 作为稳定键，同时保存 name 备用键
                            const sourceId = resolveItemSourceUuid(item) || item.uuid;
                            const key = sourceId ? `${sourceId}::${activityId}` : `${item.name}::${activityId}`;
                            const clonedTargets = foundry.utils.deepClone(activity.consumption.targets);
                            originalConsumptionData.set(key, clonedTargets);
                            // 同时以 name 为备用键保存，确保恢复时一定能找到
                            const nameKey = `${item.name}::${activityId}`;
                            if (nameKey !== key) {
                                originalConsumptionData.set(nameKey, clonedTargets);
                            }

                            // 只清空需要物品 ID 引用的类型（itemUses, material）
                            // 保留其他类型的原始 target（如 attribute: @scale.ranger.favored-enemy）
                            activity.consumption.targets = activity.consumption.targets.map(t => ({
                                ...t,
                                target: ['itemUses', 'material'].includes(t.type) ? '' : t.target
                            }));

                            window.OriginateLog(`Originate | 临时清空物品 ${item.name} 的 itemUses/material 消耗目标`);
                        }
                    }
                }

                itemsWithClearedConsumption.push(itemCopy);
            }

            window.OriginateLog(`Originate | 正在塞入 ${itemsWithClearedConsumption.length} 个物品...`);
            try {
                // 见证奇迹的时刻。
                // keepId: true -> 使用我们预生成的 ID。这是关键！
                // bypassAdvancement: true -> 系统闭嘴，让我来操作。
                const createdItems = await actor.createEmbeddedDocuments("Item", itemsWithClearedConsumption, {
                    keepId: true,
                    "dnd5e.bypassAdvancement": true
                });

                // 好了，物品进去了。现在我们要搞清楚谁是谁。
                const uuidToActorItemId = new Map();
                const nameToActorItem = new Map();
                const originalIdToNewId = new Map();

                for (const createdItem of createdItems) {
                    // 获取原始 UUID
                    const sourceUuid = resolveItemSourceUuid(createdItem);
                    if (sourceUuid) {
                        uuidToActorItemId.set(sourceUuid, createdItem.id);
                        // 同时记录简化的 UUID
                        const simplifiedUuid = sourceUuid.replace(/\.Item\./, '.');
                        if (simplifiedUuid !== sourceUuid) {
                            uuidToActorItemId.set(simplifiedUuid, createdItem.id);
                        }
                    }
                    // 记录名称到物品的映射
                    nameToActorItem.set(createdItem.name, createdItem);

                    // 记录原始 ID 到新 ID 的映射（用于修复 system.details 引用）
                    const originalId = createdItem.flags?.originate?.originalId;
                    if (originalId) {
                        originalIdToNewId.set(originalId, createdItem.id);
                    }
                }

                window.OriginateLog(`Originate | 原始 ID 映射:`, Array.from(originalIdToNewId.entries()));

                window.OriginateLog(`Originate | Actor 物品 ID 映射:`, Array.from(uuidToActorItemId.entries()));

                // 修复消耗引用。把刚才拔掉的插头插回去。
                await this._fixConsumptionReferences(actor, createdItems, uuidToActorItemId, nameToActorItem, originalConsumptionData, sortedItems);

                // 重新获取 Actor 以确保数据最新
                // 这一步至关重要，因为 createEmbeddedDocuments 可能没有更新 actor.items 缓存
                try {
                    actor = game.actors.get(actor.id);
                } catch (e) {
                    console.warn("Originate | Failed to refresh actor instance:", e);
                }
                this._debugDumpActorState(actor, 'after-create-before-first-repair');

                // 旧 full writer 的 value repair。scaffold 主链已经交给 finalize service / LevelUpManager，
                // 别把这条全局扫描再接回正常创角、升级或兼职流程。
                if (repairAdvancements) {
                    await this._fixAdvancementValueReferences(actor, originalIdToNewId, uuidToActorItemId, {
                        repairTraits
                    });
                }

                // 旧 full writer 的 origin repair。dnd5e.advancementOrigin 本身还要保留，
                // 但正常主链现在只按本次输入精准回填，不再扫全 Actor 猜关系。
                if (repairOrigins) {
                    await this._fixAdvancementOriginFlags(actor);
                }
                if (repairAdvancements || repairOrigins) {
                    actor = game.actors.get(actor.id) || actor;
                    this._debugDumpActorState(actor, 'after-first-repair');
                } else {
                    window.OriginateLog("Originate | scaffold 模式跳过旧 advancement 预修复");
                }

                // ========================================
                // 容器内容物引用修复 - 让子物品回到容器中
                // ========================================
                if (containerIdRemap.size > 0) {
                    const containerUpdates = [];
                    // 刷新 actor 以获取最新数据
                    actor = game.actors.get(actor.id) || actor;

                    for (const [oldCompendiumId, containerItemData] of containerIdRemap.entries()) {
                        // 找到容器在 actor 上的新 ID（通过预生成 ID）
                        const newContainerId = containerItemData._id;

                        // 找到所有标记了 pendingContainerId 的子物品
                        for (const actorItem of actor.items) {
                            if (actorItem.flags?.originate?.pendingContainerId === oldCompendiumId) {
                                containerUpdates.push({
                                    _id: actorItem.id,
                                    "system.container": newContainerId,
                                    "flags.originate.-=pendingContainerId": null // 清除临时标记
                                });
                                window.OriginateLog(`Originate | 将 ${actorItem.name} 放入容器 ${containerItemData.name} (${newContainerId})`);
                            }
                        }
                    }

                    if (containerUpdates.length > 0) {
                        await actor.updateEmbeddedDocuments("Item", containerUpdates);
                        window.OriginateLog(`Originate | 已将 ${containerUpdates.length} 个物品放入对应容器`);
                    }
                }

            } catch (e) {
                console.error("Originate | Failed to create embedded items:", e);
                // 尝试逐个创建以找出问题项
                for (const item of itemsToCreate) {
                    try {
                        await actor.createEmbeddedDocuments("Item", [item], {
                            keepId: false,
                            "dnd5e.bypassAdvancement": true
                        });
                        window.OriginateLog(`Originate | Successfully created: ${item.name}`);
                    } catch (itemError) {
                        console.error(`Originate | Failed to create item ${item.name}:`, itemError);
                    }
                }
            }
        }

        // 记录生命骰到 blueprint 以便后续使用
        blueprint._hitDie = hitDie;

        // 3. 注入灵魂（系统数据处理）
        // 属性、技能、豁免……这些数字决定了你的角色有多强（或者多废）。

        // 既然我们绕过了系统流程，就得自己处理职业豁免。
        // 是的...我几乎重新造了一个升级系统，我还挺牛逼的（求之后别改）
        const classItems = itemsToCreate.filter(i => i.type === 'class');
        for (const classItem of classItems) {
            if (classItem.system?.saves && Array.isArray(classItem.system.saves)) {
                window.OriginateLog(`Originate | 赋予职业 ${classItem.name} 豁免能力:`, classItem.system.saves);
                for (const ability of classItem.system.saves) {
                    if (!blueprint.system) blueprint.system = {};
                    blueprint.system[`abilities.${ability}.proficient`] = 1;
                }
            }
        }

        // 获取 originalIdToNewId 映射（需要从 actor.items 重新构建，因为之前的变量在 try 块内）
        const originalIdToNewId = new Map();
        const uuidToActorItemId = new Map();
        for (const actorItem of actor.items) {
            const originalId = actorItem.flags?.originate?.originalId;
            if (originalId) {
                originalIdToNewId.set(originalId, actorItem.id);
            }
            const sourceUuid = resolveItemSourceUuid(actorItem);
            if (sourceUuid) {
                uuidToActorItemId.set(sourceUuid, actorItem.id);
            }
        }

        if (blueprint.system && Object.keys(blueprint.system).length > 0) {
            window.OriginateLog("Originate | 正在写入系统数据...", blueprint.system);

            // 修复 details 里的引用。
            // 你的种族、背景、职业 ID 都变了，我得把它们更新一下。
            // 否则系统会一脸懵逼地问我：“这 ID 是谁？”
            if (blueprint.system.details) {
                const details = blueprint.system.details;
                const fieldsToFix = ['race', 'background', 'originalClass'];

                for (const field of fieldsToFix) {
                    if (details[field]) {
                        const originalValue = details[field];
                        let newValue = originalValue;

                        if (originalIdToNewId.has(originalValue)) {
                            newValue = originalIdToNewId.get(originalValue);
                        } else if (uuidToActorItemId.has(originalValue)) {
                            newValue = uuidToActorItemId.get(originalValue);
                        }

                        if (newValue !== originalValue) {
                            details[field] = newValue;
                            window.OriginateLog(`Originate | 修正引用 system.details.${field}: ${originalValue} -> ${newValue}`);
                        }
                    }
                }
            }

            // 构建正确的更新对象
            const updateData = {};

            for (const [key, value] of Object.entries(blueprint.system)) {
                // 处理 Set 转换为 Array
                let processedValue = value;

                // 修复点分键结构中的引用
                if (key === 'details.race' || key === 'details.background' || key === 'details.originalClass' ||
                    key === 'system.details.race' || key === 'system.details.background' || key === 'system.details.originalClass') {

                    const originalValue = value;
                    if (originalIdToNewId.has(originalValue)) {
                        processedValue = originalIdToNewId.get(originalValue);
                        window.OriginateLog(`Originate | 修复引用 ${key}: ${originalValue} -> ${processedValue} (Original ID)`);
                    } else if (uuidToActorItemId.has(originalValue)) {
                        processedValue = uuidToActorItemId.get(originalValue);
                        window.OriginateLog(`Originate | 修复引用 ${key}: ${originalValue} -> ${processedValue} (UUID)`);
                    }
                }

                if (value instanceof Set) {
                    processedValue = Array.from(value);
                }

                // 规范化 key：移除重复的 "system." 前缀
                let normalizedKey = key;
                if (key.startsWith('system.system.')) {
                    normalizedKey = key.replace('system.system.', 'system.');
                } else if (!key.startsWith('system.')) {
                    normalizedKey = `system.${key}`;
                }

                // 特殊处理：语言、工具熟练和其他数组类型的特质
                // 需要与现有值合并而不是覆盖
                if (normalizedKey.includes('traits.languages.value') ||
                    normalizedKey.includes('traits.toolProf.value') ||
                    normalizedKey.includes('traits.weaponProf.value') ||
                    normalizedKey.includes('traits.weaponProf.mastery.value') ||
                    normalizedKey.includes('traits.weaponMastery.value') ||
                    normalizedKey.includes('traits.armorProf.value') ||
                    normalizedKey.includes('traits.dr.value') ||
                    normalizedKey.includes('traits.di.value') ||
                    normalizedKey.includes('traits.dv.value') ||
                    normalizedKey.includes('traits.ci.value')) {

                    // 获取现有值
                    const existingPath = normalizedKey.replace('system.', '');
                    const existingValue = foundry.utils.getProperty(actor.system, existingPath) || [];
                    const existingSet = new Set(existingValue);

                    // 合并新值
                    if (Array.isArray(processedValue)) {
                        processedValue.forEach(v => existingSet.add(v));
                    } else if (processedValue) {
                        existingSet.add(processedValue);
                    }

                    processedValue = Array.from(existingSet);
                    window.OriginateLog(`Originate | 合并特质 ${normalizedKey}:`, processedValue);
                }

                foundry.utils.setProperty(updateData, normalizedKey, processedValue);
            }

            window.OriginateLog("Originate | Final update data:", updateData);

            try {
                await actor.update(updateData);
                window.OriginateLog("Originate | System data updated successfully");
                actor = game.actors.get(actor.id) || actor;
                this._debugDumpActorState(actor, 'after-system-update');
            } catch (e) {
                console.error("Originate | Failed to update system data:", e);
                // 尝试逐个更新以找出问题
                for (const [key, value] of Object.entries(updateData)) {
                    try {
                        await actor.update({ [key]: value });
                        window.OriginateLog(`Originate | Successfully updated: ${key}`);
                    } catch (itemError) {
                        console.error(`Originate | Failed to update ${key}:`, itemError);
                    }
                }
            }
        }

        // 4. 生命值处理
        // 活着最重要，对吧？
        // 我们之前已经预填充了 HP Advancement，现在看看系统有没有正确计算出来。
        if (repairHitPoints) {
            try {
                actor = game.actors.get(actor.id);

                const conValue = actor.system.abilities?.con?.value || 10;
                const conMod = Math.floor((conValue - 10) / 2);
                const classItems = actor.items.filter(i => i.type === 'class');
                const calculatedMax = actor.system.attributes?.hp?.max;

                window.OriginateLog(`Originate | 系统算出来的 HP: ${calculatedMax}`);

                if (calculatedMax && calculatedMax > 0) {
                    // 系统算对了！太棒了。
                    // 把当前 HP 设为最大值，但保留 max 的自动计算（不设置覆盖值）。
                    // 这样如果你点了“健壮”专长，血量才会自动涨。
                    await actor.update({
                        "system.attributes.hp.value": calculatedMax,
                        "system.attributes.hp.max": null
                    });
                    window.OriginateLog(`Originate | HP 设置完毕。别死了。`);
                } else if (classItems.length > 0) {
                    // 系统计算失败，使用保底逻辑
                    // 计算总 HP = 所有职业的 HP 贡献 + 总等级 * 体质调整值
                    let totalHp = 0;
                    let totalLevels = 0;

                    for (const classItem of classItems) {
                        const classLevel = classItem.system.levels || 1;
                        const hitDieStr = classItem.system.hd?.denomination || 'd8';
                        const hitDieValue = parseInt(String(hitDieStr).replace('d', ''));
                        const avgHitDie = Math.ceil((hitDieValue + 1) / 2);

                        // 首级满值 + 后续级平均值
                        totalHp += hitDieValue + (classLevel - 1) * avgHitDie;
                        totalLevels += classLevel;
                    }

                    // 加上体质调整值 * 总等级
                    totalHp += conMod * totalLevels;

                    // 确保 HP 至少为 1
                    totalHp = Math.max(1, totalHp);

                    await actor.update({
                        "system.attributes.hp.value": totalHp,
                        "system.attributes.hp.max": totalHp  // 保底情况下设置覆盖值
                    });
                    window.OriginateLog(`Originate | HP 设置完成 (保底计算): ${totalHp}`);
                } else {
                    // 如果没有职业，使用简单的保底逻辑
                    const fallbackMax = Math.max(1, hitDie + conMod);
                    await actor.update({
                        "system.attributes.hp.value": fallbackMax,
                        "system.attributes.hp.max": fallbackMax
                    });
                    window.OriginateLog(`Originate | 无职业，使用保底 HP: ${fallbackMax}`);
                }
            } catch (e) {
                console.error("Originate | Failed to set HP:", e);
                // 最终保底：确保角色至少有一些 HP
                try {
                    const conValue = actor.system.abilities?.con?.value || 10;
                    const conMod = Math.floor((conValue - 10) / 2);
                    const emergencyHp = Math.max(1, hitDie + conMod);
                    await actor.update({
                        "system.attributes.hp.value": emergencyHp,
                        "system.attributes.hp.max": emergencyHp
                    });
                    window.OriginateLog(`Originate | 紧急保底 HP: ${emergencyHp}`);
                } catch (e2) {
                    console.error("Originate | Even emergency HP setting failed:", e2);
                }
            }
        } else {
            window.OriginateLog("Originate | scaffold 模式跳过旧 HP 后处理，最终 HP 交给结算输入和原生 advancement");
        }

        // 5. 打扫战场
        // 把那些临时的标记清理掉。我不喜欢留下垃圾。
        try {
            actor = game.actors.get(actor.id) || actor;
            let repaired = false;
            // 这里仍然是 full writer 的收尾保底；scaffold 正常路径不依赖这两个旧 repair。
            if (repairAdvancements) {
                await this._fixAdvancementValueReferences(actor, originalIdToNewId, uuidToActorItemId, {
                    repairTraits
                });
                repaired = true;
            }
            if (repairOrigins) {
                await this._fixAdvancementOriginFlags(actor);
                repaired = true;
            }
            if (repaired) {
                actor = game.actors.get(actor.id) || actor;
                window.OriginateLog("Originate | Post-system advancement repair completed");
                this._debugDumpActorState(actor, 'after-post-system-repair');
            } else {
                window.OriginateLog("Originate | scaffold 模式跳过旧 advancement 收尾");
            }
        } catch (e) {
            console.error("Originate | Post-system advancement repair failed:", e);
        }

        const itemsToClean = actor.items.filter(i => i.flags?.originate?.originalId);
        if (itemsToClean.length > 0) {
            const cleanupUpdates = itemsToClean.map(i => ({
                _id: i.id,
                "flags.originate.-=originalId": null
            }));
            try {
                await actor.updateEmbeddedDocuments("Item", cleanupUpdates);
                window.OriginateLog(`Originate | 清理了 ${itemsToClean.length} 个临时标记。干得漂亮。`);
            } catch (e) {
                console.warn("Originate | 清理失败。好吧，反正也没人看得到。", e);
            }
        }

        // 6. 见证奇迹
        // 打开角色卡
        if (renderSheet && actor.sheet) {
            actor.sheet.render(true);
        }

        return actor;
    }

    static _prefillItemGrantValue(advancement, sourceUuidToItemId, parentItem) {
        advancement.value = { added: {} };
        for (const configItem of advancement.configuration?.items || []) {
            const sourceUuid = configItem?.uuid;
            // 来源配置可能留下空引用；旧预填只处理可匹配项，不改原配置，便于定位数据问题。
            if (typeof sourceUuid !== 'string' || !sourceUuid.trim()) {
                console.warn('Originate | ItemGrant 预填跳过无效 UUID', {
                    itemName: parentItem.name,
                    itemType: parentItem.type,
                    advancementId: advancement._id,
                    uuid: sourceUuid
                });
                continue;
            }

            const itemId = sourceUuidToItemId.get(sourceUuid)
                || sourceUuidToItemId.get(sourceUuid.replace(/\.Item\./, '.'));
            if (itemId) advancement.value.added[itemId] = sourceUuid;
            window.OriginateLog(`Originate | [预填充] ${parentItem.type} ItemGrant ${advancement._id}: ${sourceUuid} -> ${itemId || '未找到预生成 ID'}`);
        }
    }

    /**
     * Read either flat-path or nested system data.
     * @param {object} systemData
     * @param {string} path
     * @returns {*}
     */
    static _getSystemValue(systemData, path) {
        return foundry.utils.getProperty(systemData, path) ?? systemData?.[path];
    }

    /**
     * Normalize scalar, array, and set values into an array.
     * @param {*} value
     * @returns {Array}
     */
    static _asArray(value) {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length && keys.every(key => /^\d+$/.test(key))) {
                return Object.values(value);
            }
        }
        if (value === undefined || value === null || value === '') return [];
        return [value];
    }

    /**
     * Expand actor-side stored selections into keys that can match native advancement pools.
     * @param {string} prefix
     * @param {*} rawValue
     * @param {string} mode
     * @returns {Set<string>}
     */
    static _expandStoredTraitKeys(prefix, rawValue, mode = 'default') {
        const keys = new Set();
        const text = String(rawValue ?? '');
        if (!text) return keys;

        const addKey = (key) => {
            const normalized = this._canonicalTraitKey(key, mode);
            if (normalized) keys.add(normalized);
        };

        if (prefix === 'languages') {
            const suffix = text.split(':').pop();
            addKey(`languages:${suffix}`);

            const visitLanguageTree = (node, path = []) => {
                for (const [nodeKey, nodeValue] of Object.entries(node ?? {})) {
                    if (!nodeValue || typeof nodeValue !== 'object') continue;
                    const childPath = [...path, nodeKey];
                    if (nodeKey === suffix) addKey(`languages:${childPath.join(':')}`);
                    if (nodeValue.children) {
                        if (nodeValue.children[suffix] !== undefined) {
                            addKey(`languages:${[...childPath, suffix].join(':')}`);
                        }
                        visitLanguageTree(nodeValue.children, childPath);
                    }
                }
            };

            visitLanguageTree(CONFIG.DND5E?.languages ?? {});

            if (text.startsWith('languages:')) addKey(text);
            return keys;
        }

        if (prefix === 'tool') {
            const toolId = normalizeToolId(text);
            if (!toolId) return keys;

            // system.tools 只有短 key，这里顺手补回原生会用到的分组前缀。
            const groupedTools = {
                art: new Set([
                    'alchemist', 'brewer', 'calligrapher', 'carpenter', 'cartographer',
                    'cobbler', 'cook', 'glassblower', 'jeweler', 'leatherworker',
                    'mason', 'painter', 'potter', 'smith', 'tinker', 'weaver', 'woodcarver'
                ]),
                game: new Set(['card', 'chess', 'dice']),
                music: new Set(['bagpipes', 'drum', 'dulcimer', 'flute', 'horn', 'lute', 'lyre', 'panflute', 'shawm', 'viol'])
            };

            addKey(`tool:${toolId}`);
            if (text.startsWith('tool:')) addKey(text);
            if (CONFIG.DND5E?.vehicleTypes?.[toolId]) addKey(`tool:vehicle:${toolId}`);

            for (const [group, toolIds] of Object.entries(groupedTools)) {
                if (toolIds.has(toolId)) addKey(`tool:${group}:${toolId}`);
            }

            return keys;
        }

        if (text.startsWith(`${prefix}:`)) addKey(text);
        else addKey(`${prefix}:${text.split(':').pop()}`);

        return keys;
    }

    /**
     * Normalize trait keys into the format native dnd5e expects.
     * @param {string} key
     * @param {string} mode
     * @returns {string|null}
     */
    static _canonicalTraitKey(key, mode = 'default') {
        if (!key) return null;
        const text = String(key);
        if (mode === 'mastery' || text.startsWith('weaponMastery:')) {
            return toNativeWeaponMasteryKey(text);
        }
        if (mode === 'expertise') {
            // 旧蓝图和早期测试里还留着 expertise:xxx 这种键。
            // 原生 TraitAdvancement 真正认的是 skills:xxx，这里先揉平，
            // 不然修过一轮的“未来等级别抢当前等级”测试又会被旧键名绊倒。
            if (text.startsWith('expertise:')) {
                const suffix = text.split(':').slice(1).join(':');
                return suffix ? `skills:${suffix}` : null;
            }
            if (text.startsWith('skill:')) {
                const suffix = text.split(':').slice(1).join(':');
                return suffix ? `skills:${suffix}` : null;
            }
        }
        return text;
    }

    /**
     * Track claims separately for normal proficiencies, expertise, and mastery.
     * @param {string} mode
     * @returns {string}
     */
    static _traitClaimNamespace(mode = 'default') {
        if (mode === 'mastery') return 'mastery';
        if (mode === 'expertise') return 'expertise';
        return 'default';
    }

    /**
     * 把 systemData 先拍成一张安全快照，别在 5.3 的兼容 getter 上来回踩雷。
     * @param {object} systemData
     * @returns {object}
     */
    static _getSafeSystemSnapshot(systemData = {}) {
        if (!systemData) return {};

        if (typeof systemData.toObject === 'function') {
            return systemData.toObject();
        }

        if (systemData._source && typeof systemData._source === 'object') {
            return foundry.utils.deepClone(systemData._source);
        }

        return foundry.utils.deepClone(systemData);
    }

    /**
     * Build a snapshot of the finalized blueprint traits for inference.
     * @param {object} systemData
     * @returns {{default: Set<string>, expertise: Set<string>, mastery: Set<string>}}
     */
    static _collectTraitSelections(systemData = {}) {
        const safeSystemData = this._getSafeSystemSnapshot(systemData);
        const flatSystem = {
            ...foundry.utils.flattenObject(safeSystemData),
            ...safeSystemData
        };

        const selections = {
            default: new Set(),
            expertise: new Set(),
            mastery: new Set()
        };

        const addPrefixed = (namespace, prefix, values, mode = 'default') => {
            for (const rawValue of this._asArray(values)) {
                const expandedKeys = this._expandStoredTraitKeys(prefix, rawValue, mode);
                for (const key of expandedKeys) {
                    selections[namespace].add(key);
                }
            }
        };

        addPrefixed('default', 'languages', this._getSystemValue(systemData, 'traits.languages.value'));
        addPrefixed('default', 'tool', this._getSystemValue(systemData, 'traits.toolProf.value'));
        addPrefixed('default', 'weapon', this._getSystemValue(systemData, 'traits.weaponProf.value'));
        addPrefixed('default', 'armor', this._getSystemValue(systemData, 'traits.armorProf.value'));
        addPrefixed('default', 'dr', this._getSystemValue(systemData, 'traits.dr.value'));
        addPrefixed('default', 'di', this._getSystemValue(systemData, 'traits.di.value'));
        addPrefixed('default', 'dv', this._getSystemValue(systemData, 'traits.dv.value'));
        addPrefixed('default', 'ci', this._getSystemValue(systemData, 'traits.ci.value'));
        addPrefixed('mastery', 'weapon', this._getSystemValue(systemData, 'traits.weaponProf.mastery.value'), 'mastery');
        addPrefixed('mastery', 'weapon', this._getSystemValue(systemData, 'traits.weaponMastery.value'), 'mastery');

        for (const [path, rawValue] of Object.entries(flatSystem)) {
            if (path.startsWith('tools.') && path.endsWith('.value')) {
                const toolId = path.split('.')[1];
                const value = Number(rawValue ?? 0);

                if (value >= 1) {
                    for (const key of this._expandStoredTraitKeys('tool', toolId)) {
                        selections.default.add(key);
                    }
                }

                if (value >= 2) {
                    for (const key of this._expandStoredTraitKeys('tool', toolId)) {
                        selections.expertise.add(key);
                    }
                }
                continue;
            }

            if (path.startsWith('skills.') && path.endsWith('.value')) {
                const skill = path.split('.')[1];
                const value = Number(rawValue ?? 0);
                if (value >= 1) selections.default.add(`skills:${skill}`);
                if (value >= 2) selections.expertise.add(`skills:${skill}`);
                continue;
            }

            if (path.startsWith('abilities.') && path.endsWith('.proficient')) {
                const ability = path.split('.')[1];
                const value = Number(rawValue ?? 0);
                if (value >= 1) selections.default.add(`saves:${ability}`);
            }
        }

        return selections;
    }

    /**
     * Compare a pool entry against an inferred trait key.
     * @param {string} poolKey
     * @param {string} candidateKey
     * @param {string} mode
     * @returns {boolean}
     */
    static _traitPoolMatches(poolKey, candidateKey, mode = 'default') {
        const normalizedPool = this._canonicalTraitKey(poolKey, mode);
        const normalizedCandidate = this._canonicalTraitKey(candidateKey, mode);

        if (normalizedPool === normalizedCandidate) return true;

        if (mode === 'mastery') {
            const poolParts = normalizedPool.split(':');
            const candidateParts = normalizedCandidate.split(':');
            const weaponId = candidateParts[candidateParts.length - 1];

            if (poolParts[0] === 'weapon' && candidateParts[0] === 'weapon' && weaponId) {
                const simpleWeapons = new Set([
                    'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'lighthammer',
                    'mace', 'quarterstaff', 'sickle', 'spear', 'lightcrossbow', 'dart',
                    'shortbow', 'sling'
                ]);
                const martialWeapons = new Set([
                    'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd',
                    'lance', 'longsword', 'maul', 'morningstar', 'pike', 'rapier',
                    'scimitar', 'shortsword', 'trident', 'warpick', 'warhammer', 'whip',
                    'blowgun', 'handcrossbow', 'heavycrossbow', 'longbow', 'net',
                    'pistol', 'musket'
                ]);

                const poolCategory = poolParts[1];
                if ((poolCategory === 'sim' || poolCategory === 'simple') && simpleWeapons.has(weaponId)) {
                    return true;
                }
                if ((poolCategory === 'mar' || poolCategory === 'martial') && martialWeapons.has(weaponId)) {
                    return true;
                }
            }
        }

        if (normalizedPool.endsWith(':*')) {
            return normalizedCandidate.startsWith(normalizedPool.slice(0, -1));
        }

        return normalizedCandidate.startsWith(`${normalizedPool}:`);
    }

    /**
     * Pick inferred trait choices from the finalized blueprint state.
     * @param {Iterable<string>} pool
     * @param {Set<string>} availableKeys
     * @param {Set<string>} claimedKeys
     * @param {number} count
     * @param {string} mode
     * @returns {string[]}
     */
    static _selectTraitChoices(pool, availableKeys, claimedKeys, count, mode = 'default') {
        const matches = [];
        const seen = new Set();

        for (const rawPoolKey of this._asArray(pool)) {
            for (const candidateKey of availableKeys) {
                const normalizedCandidate = this._canonicalTraitKey(candidateKey, mode);
                if (claimedKeys.has(normalizedCandidate) || seen.has(normalizedCandidate)) continue;
                if (!this._traitPoolMatches(rawPoolKey, normalizedCandidate, mode)) continue;

                matches.push(normalizedCandidate);
                seen.add(normalizedCandidate);

                if (matches.length >= count) return matches;
            }
        }

        return matches;
    }

    static _resolveAdvancementLevel(adv, acquiredAt) {
        // 0 级也是真的等级，别让 || 一口吞了
        return adv?.level ?? acquiredAt ?? 1;
    }

    static _readBackfillLevel(candidate) {
        if (candidate === null || candidate === undefined) return null;
        if (typeof candidate === 'string' && candidate.trim() === '') return null;

        const level = Number(candidate);
        return Number.isFinite(level) ? level : null;
    }

    static _resolveBackfillSortLevel(adv) {
        const directLevel = this._readBackfillLevel(adv?.level);
        if (directLevel !== null) return directLevel;

        if (adv?.type === 'ItemChoice') {
            const rawChoices = adv?.configuration?.choices;
            const choiceLevelKeys =
                rawChoices instanceof Map
                    ? Array.from(rawChoices.keys())
                    : (typeof rawChoices?.keys === 'function' && !Array.isArray(rawChoices)
                        ? Array.from(rawChoices.keys())
                        : Object.keys(rawChoices || {}));

            const choiceLevels = choiceLevelKeys
                .map(level => this._readBackfillLevel(level))
                .filter(level => level !== null);

            if (choiceLevels.length > 0) return Math.min(...choiceLevels);
        }

        return Number.MAX_SAFE_INTEGER;
    }

    /**
     * 原生回填必须按等级顺序跑。
     *
     * 像游侠这种把 9 级专精写在 2 级专精前面的职业，
     * 如果直接按 JSON 原顺序处理，未来等级会先把当前等级的选择抢走。
     *
     * @param {Array} advancements
     * @returns {Array}
     */
    static _getAdvancementsInBackfillOrder(advancements = []) {
        return [...advancements]
            .map((adv, index) => ({
                adv,
                index,
                level: this._resolveBackfillSortLevel(adv)
            }))
            .sort((left, right) => {
                if (left.level !== right.level) return left.level - right.level;
                return left.index - right.index;
            })
            .map(entry => entry.adv);
    }

    static _resolveItemChoiceLevel(adv, acquiredAt) {
        const readLevel = (candidate) => {
            if (candidate === null || candidate === undefined) return null;
            if (typeof candidate === 'string' && candidate.trim() === '') return null;

            const level = Number(candidate);
            return Number.isFinite(level) ? level : null;
        };

        const directLevel = readLevel(adv?.level);
        if (directLevel !== null) return directLevel;

        const rawChoices = adv?.configuration?.choices;
        const choiceLevelKeys =
            rawChoices instanceof Map
                ? Array.from(rawChoices.keys())
                : (typeof rawChoices?.keys === 'function' && !Array.isArray(rawChoices)
                    ? Array.from(rawChoices.keys())
                    : Object.keys(rawChoices || {}));

        const choiceLevels = choiceLevelKeys
            .map(readLevel)
            .filter(level => level !== null);

        // 像人类 Versatile 这种，自己就在 0 级桶里，别再被外面的 acquiredAt 带偏了
        if (choiceLevels.length === 1) return choiceLevels[0];

        // 人类 Versatile 这种只有一个等级桶的，直接认它
        if (choiceLevels.length === 1) return choiceLevels[0];

        const fallbackLevel = readLevel(acquiredAt);
        if (fallbackLevel !== null) return fallbackLevel;

        return choiceLevels[0] ?? 1;
    }

    static _getItemChoiceLevels(adv) {
        const levels = new Set();
        const directLevel = this._readBackfillLevel(adv?.level);
        if (directLevel !== null) levels.add(directLevel);

        const rawChoices = adv?.configuration?.choices;
        const choiceLevelKeys =
            rawChoices instanceof Map
                ? Array.from(rawChoices.keys())
                : (typeof rawChoices?.keys === 'function' && !Array.isArray(rawChoices)
                    ? Array.from(rawChoices.keys())
                    : Object.keys(rawChoices || {}));

        for (const key of choiceLevelKeys) {
            const level = this._readBackfillLevel(key);
            if (level !== null) levels.add(level);
        }

        return Array.from(levels).sort((left, right) => left - right);
    }

    static _isSpellItemChoiceAdvancement(adv) {
        if (adv?.type !== 'ItemChoice') return false;
        const restrictionType = adv?.configuration?.restriction?.type;
        return adv?.configuration?.type === 'spell' || restrictionType === 'spell';
    }

    static _collectLinkedItemChoiceItems(actor, adv) {
        return actor.items.filter(actorItem => {
            const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin
                || actorItem.flags?.dnd5e?.advancementOrigin?.split('.')?.pop();
            return origin === adv._id;
        });
    }

    static _collectSpellRuleItemChoiceItems(actor, parentItem, adv, linkedItems = []) {
        if (!this._isSpellItemChoiceAdvancement(adv)) return [];
        if (parentItem?.type !== 'class') return [];

        const classIdentifier = parentItem.system?.identifier?.toLowerCase?.() || null;
        const choiceLevels = new Set(this._getItemChoiceLevels(adv));
        if (!choiceLevels.size) return [];

        const linkedIds = new Set(linkedItems.map(item => item.id));
        const restrictionLevel = adv?.configuration?.restriction?.level;
        const wantsCantrips = Number(restrictionLevel) === 0;

        return actor.items.filter(actorItem => {
            if (!actorItem || linkedIds.has(actorItem.id)) return false;
            if (actorItem.type !== 'spell') return false;

            const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin || '';
            if (!origin.startsWith('spell-rules-')) return false;

            const acquiredAt = this._readBackfillLevel(actorItem.flags?.['hero-genesis']?.acquiredAt);
            if (acquiredAt === null || !choiceLevels.has(acquiredAt)) return false;

            const spellLevel = Number(actorItem.system?.level ?? 0);
            if (wantsCantrips ? spellLevel !== 0 : spellLevel === 0) return false;

            const sourceClass = actorItem.system?.sourceClass?.toLowerCase?.() || null;
            const originMatchesClass = classIdentifier ? origin.includes(`-${classIdentifier}-`) : true;
            if (classIdentifier && sourceClass && sourceClass !== classIdentifier && !originMatchesClass) return false;
            if (classIdentifier && !sourceClass && !originMatchesClass) return false;

            return true;
        });
    }

    static _rebuildItemChoiceValue(actor, parentItem, adv) {
        const rebuiltValue = {
            added: {},
            replaced: {}
        };
        const linkedItems = this._collectLinkedItemChoiceItems(actor, adv);
        const inferredSpellItems = this._collectSpellRuleItemChoiceItems(actor, parentItem, adv, linkedItems);
        const seenItemIds = new Set();
        const allItems = [...linkedItems, ...inferredSpellItems];

        window.OriginateLog(`Originate | [Rebuild] ItemChoice ${adv._id} (${getAdvancementName(adv)}): linked=${linkedItems.length}, inferredSpellRules=${inferredSpellItems.length}`);

        for (const grantedItem of allItems) {
            if (!grantedItem?.id || seenItemIds.has(grantedItem.id)) continue;

            const level = this._resolveItemChoiceLevel(adv, grantedItem.flags?.['hero-genesis']?.acquiredAt);
            const sourceUuid = resolveItemSourceUuid(grantedItem);
            if (!sourceUuid) continue;

            if (!rebuiltValue.added[level]) rebuiltValue.added[level] = {};
            rebuiltValue.added[level][grantedItem.id] = sourceUuid;
            seenItemIds.add(grantedItem.id);

            window.OriginateLog(`Originate | [Rebuild] ItemChoice ${adv._id}: Level ${level} ${grantedItem.id} -> ${sourceUuid}`);
        }

        return rebuiltValue;
    }

    /**
     * Backfill native Trait advancement values so dnd5e can read them cleanly.
     * @param {object} adv
     * @param {{default: Set<string>, expertise: Set<string>, mastery: Set<string>}} traitSelections
     * @param {{default: Set<string>, expertise: Set<string>, mastery: Set<string>}} traitClaims
     * @param {string} label
     * @returns {string[]}
     */
    static _populateTraitAdvancementValue(adv, traitSelections, traitClaims, label = 'trait') {
        if (!adv) return [];

        if (!adv.value) adv.value = {};

        const mode = adv.configuration?.mode || 'default';
        const namespace = this._traitClaimNamespace(mode);
        const claimedKeys = traitClaims[namespace] ?? new Set();
        traitClaims[namespace] = claimedKeys;
        const availableKeys = traitSelections[namespace] ?? new Set();
        const debugChoices = [];
        const beforeChosen = this._debugSerialize(adv.value?.chosen);

        window.OriginateLog(`Originate | [TraitBackfill:Start] ${label}`, {
            advancementId: adv._id,
            title: getAdvancementName(adv),
            mode,
            namespace,
            beforeChosen,
            grants: this._debugSerialize(adv.configuration?.grants),
            choices: this._debugSerialize(adv.configuration?.choices),
            availableKeys: this._debugSerialize(availableKeys),
            claimedBefore: this._debugSerialize(claimedKeys)
        });

        const chosen = new Set();
        const pushChosen = (key) => {
            const normalized = this._canonicalTraitKey(key, mode);
            if (!normalized) return;
            chosen.add(normalized);
            claimedKeys.add(normalized);
        };

        const grants = this._asArray(adv.configuration?.grants);
        const existingChosen = this._asArray(adv.value?.chosen);

        for (const grant of grants) {
            pushChosen(grant);
        }

        for (const existingKey of existingChosen) {
            const normalized = this._canonicalTraitKey(existingKey, mode);
            if (!normalized) continue;
            if (!availableKeys.has(normalized) && !grants
                .some(grant => this._canonicalTraitKey(grant, mode) === normalized)) {
                continue;
            }
            pushChosen(normalized);
        }

        for (const choice of this._asArray(adv.configuration?.choices)) {
            const count = Number(choice?.count ?? 0);
            if (!count) continue;

            const pool = this._asArray(choice.pool);
            const alreadyChosen = Array.from(chosen)
                .filter(key => pool.some(poolKey => this._traitPoolMatches(poolKey, key, mode)));
            const remainingCount = Math.max(0, count - alreadyChosen.length);
            if (remainingCount <= 0) {
                debugChoices.push({
                    pool: this._debugSerialize(pool),
                    count,
                    preservedChoices: this._debugSerialize(alreadyChosen),
                    inferredChoices: [],
                    claimedAfterChoice: this._debugSerialize(claimedKeys)
                });
                continue;
            }

            const inferredChoices = this._selectTraitChoices(
                pool,
                availableKeys,
                claimedKeys,
                remainingCount,
                mode
            );

            inferredChoices.forEach(pushChosen);

            debugChoices.push({
                pool: this._debugSerialize(pool),
                count,
                preservedChoices: this._debugSerialize(alreadyChosen),
                inferredChoices: this._debugSerialize(inferredChoices),
                claimedAfterChoice: this._debugSerialize(claimedKeys)
            });

            if ((alreadyChosen.length + inferredChoices.length) < count) {
                window.OriginateLog(
                    `Originate | [TraitBackfill] ${label}: inferred ${alreadyChosen.length + inferredChoices.length}/${count} choices`
                );
            }
        }

        adv.value.chosen = Array.from(chosen);

        if (adv.value.chosen.length > 0) {
            window.OriginateLog(`Originate | [TraitBackfill] ${label}: ${adv.value.chosen.join(', ')}`);
        }

        window.OriginateLog(`Originate | [TraitBackfill:Result] ${label}`, {
            advancementId: adv._id,
            title: getAdvancementName(adv),
            mode,
            namespace,
            beforeChosen,
            afterChosen: this._debugSerialize(adv.value.chosen),
            choiceDebug: debugChoices,
            claimedAfter: this._debugSerialize(claimedKeys)
        });

        return adv.value.chosen;
    }

    /**
     * Serialize Sets/Maps for readable console output.
     * @param {*} value
     * @returns {*}
     */
    static _debugSerialize(value) {
        if (value instanceof Set) return Array.from(value);
        if (value instanceof Map) return Object.fromEntries(value.entries());
        if (Array.isArray(value)) return value.map(v => this._debugSerialize(v));
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([key, nestedValue]) => [key, this._debugSerialize(nestedValue)])
            );
        }
        return value;
    }

    /**
     * Build a compact trait snapshot for debugging.
     * @param {object} systemData
     * @returns {object}
     */
    static _debugTraitSnapshot(systemData = {}) {
        const selections = this._collectTraitSelections(systemData);
        const safeSystemData = this._getSafeSystemSnapshot(systemData);
        const flatSystem = {
            ...foundry.utils.flattenObject(safeSystemData),
            ...safeSystemData
        };

        const skills = {};
        const saves = {};
        for (const [path, rawValue] of Object.entries(flatSystem)) {
            if (path.startsWith('skills.') && path.endsWith('.value')) {
                skills[path.split('.')[1]] = rawValue;
            }
            if (path.startsWith('abilities.') && path.endsWith('.proficient')) {
                saves[path.split('.')[1]] = rawValue;
            }
        }

        return {
            languages: this._asArray(this._getSystemValue(systemData, 'traits.languages.value')),
            toolProf: this._asArray(this._getSystemValue(systemData, 'traits.toolProf.value')),
            weaponProf: this._asArray(this._getSystemValue(systemData, 'traits.weaponProf.value')),
            armorProf: this._asArray(this._getSystemValue(systemData, 'traits.armorProf.value')),
            weaponMastery: this._asArray(this._getSystemValue(systemData, 'traits.weaponProf.mastery.value')),
            legacyWeaponMastery: this._asArray(this._getSystemValue(systemData, 'traits.weaponMastery.value')),
            skills,
            saves,
            collected: this._debugSerialize(selections)
        };
    }

    /**
     * Dump advancement state for plain item data or actor items.
     * @param {Iterable<object>} items
     * @param {string} phase
     */
    static _debugDumpAdvancements(items, phase) {
        if (!window.OriginateDebug) return;
        const parentTypes = new Set(['class', 'race', 'background', 'subclass']);

        for (const item of items) {
            if (!parentTypes.has(item?.type)) continue;
            const advancements = getAdvancementEntries(item.system?.advancement);
            if (!advancements.length) continue;

            const summary = advancements.map(adv => ({
                id: adv._id,
                title: getAdvancementName(adv),
                type: adv.type,
                level: adv.level,
                mode: adv.configuration?.mode,
                grants: this._debugSerialize(adv.configuration?.grants),
                choices: this._debugSerialize(adv.configuration?.choices),
                value: this._debugSerialize(adv.value)
            }));

            window.OriginateLog(`Originate | [AdvDump:${phase}] ${item.type}:${item.name}`, summary);
        }
    }

    /**
     * Dump the actor's current trait snapshot and parent advancements.
     * @param {Actor|object} actor
     * @param {string} phase
     */
    static _debugDumpActorState(actor, phase) {
        if (!window.OriginateDebug || !actor) return;
        const systemData = actor.system ?? actor;
        window.OriginateLog(`Originate | [TraitSnapshot:${phase}]`, this._debugTraitSnapshot(systemData));
        if (actor.items) this._debugDumpAdvancements(actor.items, phase);
    }

    /**
     * 检查两个 UUID 是否匹配
     * 支持完整 UUID、简化 UUID (无 .Item.) 和 Item ID 的匹配
     * 
     * @param {string} uuid1 - 第一个 UUID
     * @param {string} uuid2 - 第二个 UUID
     * @returns {boolean} 是否匹配
     */
    /**
     * Build a serializable advancement inspection payload for easier debugging.
     * @param {Actor} actor
     * @returns {object|null}
     */
    static _collectActorAdvancementDebug(actor) {
        if (!actor) return null;

        const parentTypes = new Set(['class', 'race', 'background', 'subclass']);
        const serialize = (value) => {
            if (value?.toObject instanceof Function) return this._debugSerialize(value.toObject());
            return this._debugSerialize(value);
        };

        const result = {
            actor: {
                id: actor.id,
                name: actor.name,
                type: actor.type,
                uuid: actor.uuid
            },
            traitSnapshot: this._debugTraitSnapshot(actor.system ?? {}),
            parentItems: [],
            issues: [],
            activeIssues: [],
            futureIssues: []
        };

        for (const item of actor.items ?? []) {
            if (!parentTypes.has(item?.type)) continue;
            const advancements = getAdvancementEntries(item.system?.advancement);
            if (!advancements.length) continue;

            const currentLevel = item.type === 'class' || item.type === 'subclass'
                ? Number(item.system?.levels ?? 0)
                : 0;

            const advancementDocs = Object.values(item.advancement?.byId ?? {});
            const advancementSummaries = advancementDocs.map((adv) => {
                const levelSet = new Set();
                for (const rawLevel of this._asArray(adv.levels)) {
                    const numericLevel = Number(rawLevel);
                    if (Number.isFinite(numericLevel)) levelSet.add(numericLevel);
                }
                if (!levelSet.size) {
                    const numericLevel = Number(adv.level);
                    if (Number.isFinite(numericLevel)) levelSet.add(numericLevel);
                }

                const configuredByLevel = {};
                const valueByLevel = {};
                for (const level of levelSet) {
                    try {
                        configuredByLevel[level] = !!adv.configuredForLevel(level);
                    } catch (error) {
                        configuredByLevel[level] = `error: ${error.message}`;
                    }

                    if (typeof adv.valueForLevel === 'function') {
                        try {
                            valueByLevel[level] = serialize(adv.valueForLevel(level));
                        } catch (error) {
                            valueByLevel[level] = `error: ${error.message}`;
                        }
                    }
                }

                const linkedItems = actor.items
                    .filter((actorItem) => {
                        const origin =
                            actorItem.flags?.['hero-genesis']?.advancementOrigin
                            || actorItem.flags?.dnd5e?.advancementOrigin?.split('.')?.pop();
                        return origin === adv.id;
                    })
                    .map((actorItem) => ({
                        id: actorItem.id,
                        name: actorItem.name,
                        type: actorItem.type,
                        sourceUuid: resolveItemSourceUuid(actorItem),
                        heroGenesisOrigin: actorItem.flags?.['hero-genesis']?.advancementOrigin ?? null,
                        dnd5eOrigin: actorItem.flags?.dnd5e?.advancementOrigin ?? null,
                        acquiredAt: actorItem.flags?.['hero-genesis']?.acquiredAt ?? null
                    }));

                return {
                    id: adv.id ?? adv._id ?? null,
                    title: getAdvancementName(adv) ?? null,
                    type: adv.type ?? null,
                    level: Number.isFinite(Number(adv.level)) ? Number(adv.level) : null,
                    levels: Array.from(levelSet),
                    mode: adv.configuration?.mode ?? null,
                    grants: serialize(adv.configuration?.grants),
                    choices: serialize(adv.configuration?.choices),
                    items: serialize(adv.configuration?.items),
                    value: serialize(adv.value),
                    valueByLevel,
                    configuredByLevel,
                    linkedItems
                };
            });

            const advancementById = new Map(advancementSummaries.map((summary) => [summary.id, summary]));
            const levelSummaries = [];

            for (const [rawLevel, advancements] of Object.entries(item.advancement?.byLevel ?? {})) {
                if (!Array.isArray(advancements) || !advancements.length) continue;

                const level = Number(rawLevel);
                const advancementStates = advancements.map((adv) => {
                    const summary = advancementById.get(adv.id);
                    let configured = null;
                    try {
                        configured = !!adv.configuredForLevel(level);
                    } catch (error) {
                        configured = `error: ${error.message}`;
                    }

                    let valueForLevel = null;
                    if (typeof adv.valueForLevel === 'function') {
                        try {
                            valueForLevel = serialize(adv.valueForLevel(level));
                        } catch (error) {
                            valueForLevel = `error: ${error.message}`;
                        }
                    }

                    return {
                        id: adv.id,
                        title: adv.titleForLevel?.(level, {}) ?? getAdvancementName(adv) ?? null,
                        baseTitle: getAdvancementName(adv) ?? null,
                        type: adv.type ?? null,
                        configured,
                        valueForLevel,
                        value: summary?.value ?? serialize(adv.value)
                    };
                });

                const unconfigured = advancementStates.filter((state) => state.configured !== true);
                if (unconfigured.length) {
                    for (const state of unconfigured) {
                        const fullSummary = advancementById.get(state.id);
                        const issue = {
                            parentItemId: item.id,
                            parentItemName: item.name,
                            parentItemType: item.type,
                            parentCurrentLevel: currentLevel,
                            level,
                            isActiveLevel: level <= currentLevel,
                            advancementId: state.id,
                            title: state.baseTitle,
                            displayTitle: state.title,
                            advancementType: state.type,
                            configured: state.configured,
                            value: fullSummary?.value ?? state.value,
                            valueForLevel: state.valueForLevel,
                            grants: fullSummary?.grants ?? null,
                            choices: fullSummary?.choices ?? null,
                            items: fullSummary?.items ?? null,
                            linkedItems: fullSummary?.linkedItems ?? []
                        };
                        result.issues.push(issue);
                        if (issue.isActiveLevel) result.activeIssues.push(issue);
                        else result.futureIssues.push(issue);
                    }
                }

                levelSummaries.push({
                    level,
                    configured: unconfigured.length ? 'partial' : 'full',
                    advancements: advancementStates
                });
            }

            result.parentItems.push({
                id: item.id,
                name: item.name,
                type: item.type,
                identifier: item.system?.identifier ?? null,
                currentLevel,
                needingConfiguration: serialize(
                    (item.advancement?.needingConfiguration ?? []).map((adv) => ({
                        id: adv.id,
                        title: getAdvancementName(adv),
                        type: adv.type
                    }))
                ),
                levels: levelSummaries,
                advancements: advancementSummaries
            });
        }

        result.issueCount = result.issues.length;
        result.activeIssueCount = result.activeIssues.length;
        result.futureIssueCount = result.futureIssues.length;
        return result;
    }

    /**
     * Check whether two UUID-like references should be treated as equivalent.
     * @param {string} uuid1
     * @param {string} uuid2
     * @returns {boolean}
     */
    static isUuidMatch(uuid1, uuid2) {
        if (!uuid1 || !uuid2) return false;
        if (uuid1 === uuid2) return true;

        // 简化 UUID 比较 (移除 .Item.)
        const simple1 = uuid1.replace(/\.Item\./, '.');
        const simple2 = uuid2.replace(/\.Item\./, '.');
        if (simple1 === simple2) return true;

        // ID 比较 (取最后一部分)
        const id1 = uuid1.split('.').pop();
        const id2 = uuid2.split('.').pop();
        // 只有当 ID 长度足够长（看起来像有效 ID）时才匹配
        if (id1 === id2 && id1.length >= 16) return true;

        return false;
    }

    /**
     * 依赖排序 - 谁先谁后？
     * 
     * 这是一个拓扑排序问题。如果 A 依赖 B，那 B 必须先出生。
     * 比如“魔力泉涌”必须在“谨慎法术”之前存在，否则“谨慎法术”就不知道该消耗谁的次数。
     * 
     * Claude Opus 4.5 建议我用递归来解决这个问题。听起来很酷，但跑起来直接爆栈了。
     * 还是老办法管用，虽然代码丑了点，但至少不会让浏览器崩溃。
     * 
     * @param {Array} items - 一堆乱序的物品
     * @param {Map} uuidToItemData - 物品数据的字典
     * @returns {Array} 排好队的物品
     */
    static async _sortItemsByDependency(items, uuidToItemData) {
        // 分析每个物品的消耗引用
        const itemDependencies = new Map(); // itemName -> Set of referenced UUIDs/names
        const itemsByName = new Map(); // name -> item
        const itemsByUuid = new Map(); // uuid -> item
        const missingDependencies = new Map(); // uuid -> item data (需要额外添加的物品)

        window.OriginateLog(`Originate | [依赖分析] 开始分析 ${items.length} 个物品的依赖关系`);

        // 首先建立物品索引
        for (const item of items) {
            itemsByName.set(item.name, item);

            const sourceUuid = resolveItemSourceUuid(item) || item.uuid;
            if (sourceUuid) {
                itemsByUuid.set(sourceUuid, item);
                // 简化 UUID
                const simplifiedUuid = sourceUuid.replace(/\.Item\./, '.');
                if (simplifiedUuid !== sourceUuid) {
                    itemsByUuid.set(simplifiedUuid, item);
                }
                // Item ID
                const uuidParts = sourceUuid.split('.');
                const itemId = uuidParts[uuidParts.length - 1];
                if (itemId && itemId.length >= 16) {
                    itemsByUuid.set(itemId, item);
                }
            }
        }

        // 分析每个物品的消耗引用
        for (const item of items) {
            const dependencies = new Set();

            // 检查 activities 中的消耗配置
            if (item.system?.activities) {
                for (const [activityId, activity] of Object.entries(item.system.activities)) {
                    if (activity.consumption?.targets?.length) {
                        window.OriginateLog(`Originate | [依赖分析] 物品 "${item.name}" 有消耗配置:`, activity.consumption.targets);

                        for (const target of activity.consumption.targets) {
                            window.OriginateLog(`Originate | [依赖分析] 消耗目标: type=${target.type}, target=${target.target}`);

                            if (target.type === 'itemUses' && target.target) {
                                const targetUuid = target.target;

                                // 检查目标是否在我们的物品列表中
                                // 尝试多种匹配方式
                                let foundTarget = false;

                                // 1. 直接 UUID 匹配
                                if (itemsByUuid.has(targetUuid)) {
                                    dependencies.add(itemsByUuid.get(targetUuid).name);
                                    foundTarget = true;
                                }

                                // 2. 简化 UUID 匹配
                                if (!foundTarget) {
                                    const simplifiedUuid = targetUuid.replace(/\.Item\./, '.');
                                    if (itemsByUuid.has(simplifiedUuid)) {
                                        dependencies.add(itemsByUuid.get(simplifiedUuid).name);
                                        foundTarget = true;
                                    }
                                }

                                // 3. Item ID 匹配
                                if (!foundTarget && targetUuid.includes('.')) {
                                    const uuidParts = targetUuid.split('.');
                                    const itemId = uuidParts[uuidParts.length - 1];
                                    if (itemsByUuid.has(itemId)) {
                                        dependencies.add(itemsByUuid.get(itemId).name);
                                        foundTarget = true;
                                    }
                                }

                                // 4. 如果没找到，尝试从 Compendium 加载并添加到列表
                                if (!foundTarget && !missingDependencies.has(targetUuid)) {
                                    try {
                                        const depItem = await fromUuid(targetUuid);
                                        if (depItem) {
                                            const depItemData = depItem.toObject();
                                            delete depItemData._id;

                                            // 添加到缺失依赖列表
                                            missingDependencies.set(targetUuid, depItemData);

                                            // 更新索引
                                            itemsByName.set(depItemData.name, depItemData);
                                            itemsByUuid.set(targetUuid, depItemData);

                                            dependencies.add(depItemData.name);
                                            foundTarget = true;

                                            window.OriginateLog(`Originate | 自动添加缺失的依赖物品: ${depItemData.name} (${targetUuid})`);
                                        }
                                    } catch (e) {
                                        console.warn(`Originate | 无法加载依赖物品: ${targetUuid}`, e);
                                    }
                                }

                                // 5. 如果还是没找到，记录 UUID 以便后续处理
                                if (!foundTarget && !missingDependencies.has(targetUuid)) {
                                    dependencies.add(`uuid:${targetUuid}`);
                                }
                            }
                        }
                    }
                }
            }

            itemDependencies.set(item.name, dependencies);
        }

        // 将缺失的依赖物品添加到物品列表
        for (const [uuid, itemData] of missingDependencies) {
            items.push(itemData);
            // 为新添加的物品也创建依赖记录（它们通常没有依赖）
            if (!itemDependencies.has(itemData.name)) {
                itemDependencies.set(itemData.name, new Set());
            }
        }

        window.OriginateLog(`Originate | 物品依赖分析:`, Object.fromEntries(
            Array.from(itemDependencies.entries()).map(([k, v]) => [k, Array.from(v)])
        ));

        // 拓扑排序：被依赖的物品先创建
        const sorted = [];
        const visited = new Set();
        const visiting = new Set(); // 用于检测循环依赖

        const visit = (itemName) => {
            if (visited.has(itemName)) return;
            if (visiting.has(itemName)) {
                // 循环依赖，跳过
                console.warn(`Originate | 检测到循环依赖: ${itemName}`);
                return;
            }

            visiting.add(itemName);

            const deps = itemDependencies.get(itemName) || new Set();
            for (const dep of deps) {
                // 只处理在我们物品列表中的依赖
                if (!dep.startsWith('uuid:') && itemsByName.has(dep)) {
                    visit(dep);
                }
            }

            visiting.delete(itemName);
            visited.add(itemName);

            const item = itemsByName.get(itemName);
            if (item) {
                sorted.push(item);
            }
        };

        // 首先处理没有依赖的物品（被依赖的物品）
        for (const item of items) {
            const deps = itemDependencies.get(item.name) || new Set();
            const hasInternalDeps = Array.from(deps).some(d => !d.startsWith('uuid:') && itemsByName.has(d));
            if (!hasInternalDeps) {
                visit(item.name);
            }
        }

        // 然后处理有依赖的物品
        for (const item of items) {
            visit(item.name);
        }

        // 确保所有物品都被包含
        for (const item of items) {
            if (!visited.has(item.name)) {
                sorted.push(item);
            }
        }

        return sorted;
    }

    /**
     * 修复消耗引用 - 连连看游戏
     * 
     * 物品创建好了，但它们的消耗目标还指向着虚无缥缈的 Compendium UUID。
     * 我得把它们重新指向 Actor 身上真实存在的物品 ID。
     * 
     * 比如战术大师的战技，它得消耗“卓越战技”的骰子。
     * 如果连错了，你的战技就废了。
     * 
     * @param {Actor} actor - 倒霉的角色
     * @param {Array} createdItems - 刚塞进去的物品
     * @param {Map} uuidToActorItemId - UUID 到 ID 的映射表
     * @param {Map} nameToActorItem - 名字到物品的映射表
     * @param {Map} originalConsumptionData - 原始数据的备份
     * @param {Array} sortedItems - 排序后的原始数据
     */
    static async _fixConsumptionReferences(actor, createdItems, uuidToActorItemId, nameToActorItem, originalConsumptionData, sortedItems) {
        const updates = [];

        // 构建更完整的 UUID 映射
        // 包括：完整 UUID、简化 UUID、Item ID、物品名称
        const comprehensiveMap = new Map();

        for (const actorItem of actor.items) {
            const sourceId = resolveItemSourceUuid(actorItem);

            if (sourceId) {
                // 完整 UUID
                comprehensiveMap.set(sourceId, actorItem.id);

                // 简化 UUID（移除 .Item.）
                const simplifiedUuid = sourceId.replace(/\.Item\./, '.');
                if (simplifiedUuid !== sourceId) {
                    comprehensiveMap.set(simplifiedUuid, actorItem.id);
                }

                // 提取 Item ID（UUID 的最后一部分）
                const uuidParts = sourceId.split('.');
                const itemId = uuidParts[uuidParts.length - 1];
                if (itemId && itemId.length >= 16) {
                    comprehensiveMap.set(itemId, actorItem.id);
                }
            }

            // 物品名称映射
            if (actorItem.name) {
                comprehensiveMap.set(`name:${actorItem.name}`, actorItem.id);
            }
        }

        window.OriginateLog(`Originate | 消耗引用映射表 (${comprehensiveMap.size} 条):`, Array.from(comprehensiveMap.keys()).slice(0, 20));
        window.OriginateLog(`Originate | 原始消耗数据:`, Array.from(originalConsumptionData?.entries() || []));

        // 遍历 Actor 上的所有物品
        for (const item of actor.items) {
            // 获取 activities - 可能在 system.activities 或直接在 item 上
            // DND5E 2024 中 activities 是一个 Collection（继承自 Map）
            let activities = item.system?.activities;

            // 将 activities 转换为可遍历的 entries 数组
            // 注意：Foundry Collection 的默认迭代器返回 values，不是 entries
            // 所以必须显式调用 .entries() 方法
            let activityEntries = [];
            if (activities) {
                if (activities instanceof Collection || activities instanceof Map) {
                    // Collection/Map: 使用 .entries() 获取 [key, value] 对
                    activityEntries = Array.from(activities.entries());
                } else if (typeof activities === 'object') {
                    // 普通对象: 使用 Object.entries
                    activityEntries = Object.entries(activities);
                }
            }

            if (activityEntries.length === 0) {
                continue;
            }

            window.OriginateLog(`Originate | 检查物品 ${item.name} 的 activities:`, activityEntries.map(([id]) => id));

            // 检查是否有原始消耗数据需要恢复
            let hasOriginalConsumption = false;
            for (const [activityId, activity] of activityEntries) {
                // 使用与保存时一致的 key 生成逻辑（sourceId::activityId 或 name::activityId）
                const sourceId = resolveItemSourceUuid(item);
                const keyBySource = sourceId ? `${sourceId}::${activityId}` : null;
                const keyByName = `${item.name}::${activityId}`;
                if ((keyBySource && originalConsumptionData?.has(keyBySource)) || originalConsumptionData?.has(keyByName)) {
                    hasOriginalConsumption = true;
                    window.OriginateLog(`Originate | 物品 ${item.name} 的 activity ${activityId} 有原始消耗数据需要恢复 (key: ${keyBySource || keyByName})`);
                }
            }

            if (!hasOriginalConsumption) {
                continue;
            }

            let itemNeedsUpdate = false;
            const activityUpdates = {};

            // 使用之前转换好的 activityEntries 而不是 Object.entries(activities)
            for (const [activityId, activity] of activityEntries) {
                // 从原始消耗数据中获取该 activity 的消耗目标
                // 尝试两种 key 格式：sourceId::activityId 和 name::activityId
                const sourceId = resolveItemSourceUuid(item);
                const keyBySource = sourceId ? `${sourceId}::${activityId}` : null;
                const keyByName = `${item.name}::${activityId}`;
                const originalTargets = (keyBySource && originalConsumptionData?.get(keyBySource)) || originalConsumptionData?.get(keyByName);

                // 如果没有原始消耗数据，跳过
                if (!originalTargets || originalTargets.length === 0) {
                    continue;
                }

                window.OriginateLog(`Originate | 恢复物品 ${item.name} activity ${activityId} 的消耗目标:`, originalTargets);

                const newTargets = [];
                let targetsChanged = false;

                // 使用原始消耗数据而不是当前（已清空的）数据
                for (const target of originalTargets) {
                    // 检查目标类型
                    // type: "itemUses" 表示消耗其他物品的使用次数
                    // type: "activityUses" 表示消耗活动的使用次数
                    // target.target 是目标物品的 UUID 或 ID

                    if (target.type === 'itemUses') {
                        const originalTarget = target.target;
                        let newTargetId = null;

                        // 如果 target 为空或无效，跳过
                        if (!originalTarget || originalTarget === '') {
                            window.OriginateLog(`Originate | 物品 ${item.name} 的消耗目标为空，先跳过。`);
                            newTargets.push(target);
                            continue;
                        }

                        // 1. 直接从映射查找（完整 UUID）
                        if (comprehensiveMap.has(originalTarget)) {
                            newTargetId = comprehensiveMap.get(originalTarget);
                            window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (完整 UUID 匹配)`);
                        }

                        // 2. 简化 UUID 后查找
                        if (!newTargetId) {
                            const simplifiedUuid = originalTarget.replace(/\.Item\./, '.');
                            if (comprehensiveMap.has(simplifiedUuid)) {
                                newTargetId = comprehensiveMap.get(simplifiedUuid);
                                window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (简化 UUID 匹配)`);
                            }
                        }

                        // 3. 提取 Item ID 后查找
                        if (!newTargetId && originalTarget.includes('.')) {
                            const uuidParts = originalTarget.split('.');
                            const itemId = uuidParts[uuidParts.length - 1];
                            if (itemId && comprehensiveMap.has(itemId)) {
                                newTargetId = comprehensiveMap.get(itemId);
                                window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (Item ID 匹配)`);
                            }
                        }

                        // 4. 遍历 Actor 物品，查找源 ID 包含目标 ID 的物品
                        if (!newTargetId && originalTarget.includes('.')) {
                            const uuidParts = originalTarget.split('.');
                            const itemId = uuidParts[uuidParts.length - 1];

                            for (const actorItem of actor.items) {
                                const sourceId = resolveItemSourceUuid(actorItem);
                                if (sourceId) {
                                    // 检查源 ID 是否以目标 Item ID 结尾
                                    if (sourceId.endsWith(itemId) || sourceId.endsWith(`.${itemId}`)) {
                                        newTargetId = actorItem.id;
                                        window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (源 ID 后缀匹配)`);
                                        break;
                                    }
                                    // 检查源 ID 是否包含目标 Item ID
                                    if (sourceId.includes(itemId)) {
                                        newTargetId = actorItem.id;
                                        window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (源 ID 包含匹配)`);
                                        break;
                                    }
                                }
                            }
                        }

                        // 5. 尝试从 Compendium 获取原始物品名称，然后通过名称匹配
                        if (!newTargetId) {
                            try {
                                const originalItem = await fromUuid(originalTarget);
                                if (originalItem && originalItem.name) {
                                    const nameKey = `name:${originalItem.name}`;
                                    if (comprehensiveMap.has(nameKey)) {
                                        newTargetId = comprehensiveMap.get(nameKey);
                                        window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (名称匹配: ${originalItem.name})`);
                                    }
                                }
                            } catch (e) {
                                // fromUuid 失败，尝试从 UUID 中提取可能的名称信息
                                window.OriginateLog(`Originate | fromUuid 失败: ${originalTarget}，尝试其他方法`);
                            }
                        }

                        // 6. 最后尝试：从 UUID 路径中提取 pack 和 id，手动查找
                        if (!newTargetId && originalTarget.startsWith('Compendium.')) {
                            try {
                                const parts = originalTarget.split('.');
                                // 格式: Compendium.module.pack.Item.id 或 Compendium.module.pack.id
                                if (parts.length >= 4) {
                                    const packId = `${parts[1]}.${parts[2]}`;
                                    const itemId = parts[parts.length - 1];

                                    const pack = game.packs.get(packId);
                                    if (pack) {
                                        const packItem = await pack.getDocument(itemId);
                                        if (packItem && packItem.name) {
                                            const nameKey = `name:${packItem.name}`;
                                            if (comprehensiveMap.has(nameKey)) {
                                                newTargetId = comprehensiveMap.get(nameKey);
                                                window.OriginateLog(`Originate | 消耗引用: ${originalTarget} -> ${newTargetId} (Pack 查找名称匹配: ${packItem.name})`);
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                window.OriginateLog(`Originate | Pack 查找失败: ${originalTarget}`);
                            }
                        }

                        if (newTargetId) {
                            newTargets.push({
                                ...target,
                                target: newTargetId
                            });
                            targetsChanged = true;
                        } else {
                            // 无法找到目标物品，尝试从 Compendium 加载并添加到角色
                            console.warn(`Originate | 无法解析消耗引用: ${originalTarget} (物品: ${item.name})`);
                            window.OriginateLog(`Originate | 尝试从 Compendium 加载缺失的消耗目标物品...`);

                            try {
                                const missingItem = await fromUuid(originalTarget);
                                if (missingItem) {
                                    // 创建缺失的物品
                                    const missingItemData = missingItem.toObject();
                                    delete missingItemData._id;

                                    window.OriginateLog(`Originate | 自动添加缺失的消耗目标物品: ${missingItemData.name}`);

                                    const [createdMissingItem] = await actor.createEmbeddedDocuments("Item", [missingItemData], {
                                        keepId: false,
                                        "dnd5e.bypassAdvancement": true
                                    });

                                    if (createdMissingItem) {
                                        // 更新映射
                                        comprehensiveMap.set(originalTarget, createdMissingItem.id);
                                        comprehensiveMap.set(`name:${createdMissingItem.name}`, createdMissingItem.id);

                                        newTargetId = createdMissingItem.id;
                                        newTargets.push({
                                            ...target,
                                            target: newTargetId
                                        });
                                        targetsChanged = true;

                                        window.OriginateLog(`Originate | 成功添加缺失物品 ${createdMissingItem.name}，ID: ${createdMissingItem.id}`);
                                    } else {
                                        // 创建失败，保持原样
                                        newTargets.push(target);
                                    }
                                } else {
                                    // 无法从 Compendium 加载，保持原样
                                    newTargets.push(target);
                                    console.warn(`Originate | 无法从 Compendium 加载: ${originalTarget}`);
                                }
                            } catch (e) {
                                console.error(`Originate | 添加缺失消耗目标物品失败:`, e);
                                newTargets.push(target);
                            }
                        }
                    } else {
                        // 其他类型的目标，保持原样
                        newTargets.push(target);
                    }
                }

                if (targetsChanged) {
                    // 使用点符号路径直接更新特定 activity 的 consumption.targets
                    // 这样可以避免展开 Collection/Map 类型的 activities 对象
                    activityUpdates[activityId] = newTargets;
                    itemNeedsUpdate = true;
                }
            }

            if (itemNeedsUpdate) {
                // 构建使用点符号路径的更新对象
                // 这样可以精确更新每个 activity 的 consumption.targets，而不需要操作整个 activities 容器
                const updateData = { _id: item.id };
                for (const [activityId, newTargets] of Object.entries(activityUpdates)) {
                    updateData[`system.activities.${activityId}.consumption.targets`] = newTargets;
                }
                updates.push(updateData);
            }
        }

        if (updates.length > 0) {
            window.OriginateLog(`Originate | 更新 ${updates.length} 个物品的消耗引用`);
            try {
                await actor.updateEmbeddedDocuments('Item', updates);
                window.OriginateLog(`Originate | 消耗引用更新完成`);
            } catch (e) {
                console.error(`Originate | 更新消耗引用失败:`, e);
            }
        }
    }

    /**
     * 旧 full writer / 调试专用的 Advancement value 修复。
     *
     * 这条路会扫整个 Actor 来猜 ItemGrant / ItemChoice / Trait 的回填值，所以不能再接回
     * 创角、升级、兼职的正常主流程。正常主链必须走 LevelUpManager 的输入驱动 repair，
     * 只修“本次输入”产生的物品和选择。
     *
     * 这里还保留，是为了旧 full writer、控制台急救和旧角色排障。
     * dnd5e 的 advancement value 里有带点的 key，更新时仍要整体替换数组，别改成点路径更新。
     * 
     * @param {Actor} actor - 角色
     * @param {Map} originalIdToNewId - 旧 ID 换新 ID 的汇率表
     * @param {Map} uuidToActorItemId - UUID 换 ID 的汇率表
     */
    static async _fixAdvancementValueReferences(actor, originalIdToNewId, uuidToActorItemId, {
        repairTraits = true
    } = {}) {
        const updates = [];

        // 遍历所有需要修复的物品类型
        const itemTypesToFix = ['class', 'race', 'background', 'subclass'];
        const traitSelections = this._collectTraitSelections(actor.system);
        const traitClaims = {
            default: new Set(),
            expertise: new Set(),
            mastery: new Set()
        };
        window.OriginateLog("Originate | [TraitSnapshot:repair-input]", {
            actor: actor.name,
            snapshot: this._debugTraitSnapshot(actor.system)
        });

        for (const item of actor.items) {
            if (!itemTypesToFix.includes(item.type)) continue;
            if (!hasAdvancementEntries(item.system?.advancement)) continue;

            const serializedItem = item.toObject();
            let itemNeedsUpdate = false;
            // 这里得兼容 5.3 的 source object，别再假定它永远是数组。
            const advancementSource = hasAdvancementEntries(serializedItem?.system?.advancement)
                ? serializedItem.system.advancement
                : item.system.advancement;
            const newAdvancement = foundry.utils.deepClone(getAdvancementEntries(advancementSource));

            for (const adv of this._getAdvancementsInBackfillOrder(newAdvancement)) {

                if (adv.type === 'Trait') {
                    if (!repairTraits) continue;

                    this._populateTraitAdvancementValue(
                        adv,
                        traitSelections,
                        traitClaims,
                        `${item.type}:${item.name}:${adv._id}`
                    );
                    itemNeedsUpdate = true;
                    continue;
                }

                if (adv.type === 'ItemGrant' && adv.configuration?.items) {
                    adv.value = { added: {} };
                    itemNeedsUpdate = true;

                    const configUuids = adv.configuration.items.map(configItem => configItem.uuid);
                    const grantedItems = actor.items.filter(actorItem => {
                        const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin
                            || actorItem.flags?.dnd5e?.advancementOrigin?.split('.')?.pop();
                        return origin === adv._id;
                    });

                    window.OriginateLog(`Originate | [Rebuild] ItemGrant ${adv._id}: found ${grantedItems.length} linked items`);

                    for (const grantedItem of grantedItems) {
                        const sourceUuid = resolveItemSourceUuid(grantedItem);

                        const matchesConfig = configUuids.some(configUuid =>
                            HeroGenesisWriter.isUuidMatch(configUuid, sourceUuid)
                        );

                        if (sourceUuid && matchesConfig) {
                            adv.value.added[grantedItem.id] = sourceUuid;
                            window.OriginateLog(`Originate | [Rebuild] ItemGrant ${adv._id}: ${grantedItem.id} -> ${sourceUuid}`);
                        }
                    }
                    window.OriginateLog(`Originate | [Rebuild:Result] ItemGrant ${item.type}:${item.name}:${adv._id}`, this._debugSerialize(adv.value));
                    continue;
                    // 检查是否有被 Foundry 展开的垃圾数据
                    if (adv.value?.Compendium) {
                        window.OriginateLog(`Originate | [Fix] 检测到 ItemGrant ${adv._id} 有垃圾数据，清理中...`);
                        adv.value = {};
                        itemNeedsUpdate = true;
                    }

                    // 验证和补漏：遍历配置中的每个物品
                    for (const configItem of adv.configuration.items) {
                        const configUuid = configItem.uuid;

                        // 检查当前值是否有效
                        const currentValue = adv.value?.[configUuid];
                        const isCurrentValueValid = currentValue && actor.items.has(currentValue);

                        if (!isCurrentValueValid) {
                            // 预填充失败，尝试修复
                            window.OriginateLog(`Originate | [Fix] ItemGrant ${adv._id} 的 ${configUuid} 需要修复`);

                            // 在 Actor 物品中查找匹配的物品
                            const foundItem = actor.items.find(actorItem => {
                                // 方法1: 检查 advancementOrigin 标记
                                const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin;
                                if (origin === adv._id) {
                                    const sourceUuid = resolveItemSourceUuid(actorItem);
                                    return HeroGenesisWriter.isUuidMatch(configUuid, sourceUuid);
                                }
                                return false;
                            });

                            if (foundItem) {
                                if (!adv.value) adv.value = {};
                                adv.value[configUuid] = foundItem.id;
                                itemNeedsUpdate = true;
                                window.OriginateLog(`Originate | [Fix] 补漏 ItemGrant ${adv._id}: ${configUuid} -> ${foundItem.id} (${foundItem.name})`);
                            } else {
                                // 方法2: 通过 sourceUuid 直接匹配
                                const foundByUuid = actor.items.find(actorItem => {
                                    const sourceUuid = resolveItemSourceUuid(actorItem);
                                    return HeroGenesisWriter.isUuidMatch(configUuid, sourceUuid);
                                });

                                if (foundByUuid) {
                                    if (!adv.value) adv.value = {};
                                    adv.value[configUuid] = foundByUuid.id;
                                    itemNeedsUpdate = true;
                                    window.OriginateLog(`Originate | [Fix] 补漏 ItemGrant ${adv._id}: ${configUuid} -> ${foundByUuid.id} (${foundByUuid.name}) [UUID匹配]`);
                                }
                            }
                        } else {
                            window.OriginateLog(`Originate | [验证] ItemGrant ${adv._id}: ${configUuid} -> ${currentValue} ✓`);
                        }
                    }
                } else if (adv.type === 'ItemChoice') {
                    adv.value = this._rebuildItemChoiceValue(actor, item, adv);
                    itemNeedsUpdate = true;
                    window.OriginateLog(`Originate | [Rebuild:Result] ItemChoice ${item.type}:${item.name}:${adv._id}`, this._debugSerialize(adv.value));
                    continue;
                    // 强制重构 value，确保数据正确
                    // 之前的补漏逻辑可能因为 Foundry 的数据展开问题而失效
                    // 所以这里我们完全清空并重新填充
                    adv.value = {
                        added: {},
                        replaced: {}
                    };
                    itemNeedsUpdate = true;

                    // 查找所有属于此 advancement 的物品
                    // 注意：这里使用 actor.items，确保包含所有物品
                    const grantedItems = actor.items.filter(actorItem => {
                        const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin;
                        return origin === adv._id;
                    });

                    window.OriginateLog(`Originate | [Rebuild] ItemChoice ${adv._id} (${getAdvancementName(adv)}): 找到 ${grantedItems.length} 个关联物品`);

                    for (const grantedItem of grantedItems) {
                        const level = this._resolveItemChoiceLevel(adv, grantedItem.flags?.['hero-genesis']?.acquiredAt);
                        const sourceUuid = resolveItemSourceUuid(grantedItem);

                        if (sourceUuid) {
                            if (!adv.value.added[level]) adv.value.added[level] = {};
                            adv.value.added[level][sourceUuid] = grantedItem.id;
                            window.OriginateLog(`Originate | [Rebuild] ItemChoice ${adv._id}: Level ${level} ${sourceUuid} -> ${grantedItem.id}`);
                        }
                    }
                }
            }

            if (itemNeedsUpdate) {
                // 【关键】整体替换 system.advancement 数组
                // 这样可以避免 Foundry 把带点的键展开成嵌套对象
                updates.push({
                    _id: item.id,
                    "system.advancement": setAdvancementSource(advancementSource, newAdvancement)
                });
            }
        }

        if (updates.length > 0) {
            window.OriginateLog(`Originate | 更新 ${updates.length} 个物品的 advancement.value 引用`);
            try {
                await actor.updateEmbeddedDocuments('Item', updates);
                window.OriginateLog(`Originate | advancement.value 引用更新完成`);
            } catch (e) {
                console.error(`Originate | 更新 advancement.value 引用失败:`, e);
            }
        }
    }

    /**
     * 旧 full writer / 调试专用的 origin 修复。
     *
     * `flags.dnd5e.advancementOrigin` 是 dnd5e 原生字段，本身不是要删除的旧桥。
     * 真正退出主流程的是这里这种“扫全 Actor 再猜父子关系”的修法。
     *
     * 正常创角、升级、兼职现在都应该走 LevelUpManager.repairAdvancementOriginsFromInput()，
     * 只根据本次结算输入回填 origin，避免多职业、旧等级和旧物品互相串线。
     * 
     * @param {Actor} actor - 角色
     */
    static async _fixAdvancementOriginFlags(actor) {
        const updates = [];

        // 1. 建立 Advancement ID 到父物品 ID 的映射
        const advancementToParent = new Map(); // advancementId -> parentActorItemId

        for (const item of actor.items) {
            const advancements = getAdvancementEntries(item.system?.advancement);
            if (advancements.length) {
                for (const adv of advancements) {
                    if (adv._id) {
                        advancementToParent.set(adv._id, item.id);
                    }
                }
            }
        }

        window.OriginateLog(`Originate | Advancement 映射表大小: ${advancementToParent.size}`);

        // 2. 遍历所有物品，检查是否有 hero-genesis.advancementOrigin
        for (const item of actor.items) {
            const originId = item.flags?.['hero-genesis']?.advancementOrigin;

            if (originId) {
                const parentId = advancementToParent.get(originId);
                if (parentId) {
                    const originString = `${parentId}.${originId}`;
                    const parentItem = actor.items.get(parentId);
                    const rootString = parentItem?.flags?.dnd5e?.advancementRoot || originString;
                    const update = { _id: item.id };

                    if (!item.flags?.dnd5e?.advancementOrigin) {
                        update["flags.dnd5e.advancementOrigin"] = originString;
                    }
                    if (!item.flags?.dnd5e?.advancementRoot) {
                        update["flags.dnd5e.advancementRoot"] = rootString;
                    }
                    if (Object.keys(update).length > 1) {
                        updates.push(update);
                        window.OriginateLog(`Originate | 关联特性 ${item.name} -> 父物品 ${parentId} (Adv: ${originId})`);
                    }
                } else {
                    console.warn(`Originate | 无法找到特性 ${item.name} 的父物品 (Adv: ${originId})`);
                }
            }
        }

        if (updates.length > 0) {
            window.OriginateLog(`Originate | 更新 ${updates.length} 个物品的 advancementOrigin 标记`);
            try {
                await actor.updateEmbeddedDocuments("Item", updates);
                window.OriginateLog(`Originate | advancementOrigin 标记更新完成`);
            } catch (e) {
                console.error(`Originate | 更新 advancementOrigin 标记失败:`, e);
            }
        }
    }
}
