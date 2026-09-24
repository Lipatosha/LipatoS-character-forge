/**
 * LevelUpManager - 升级逻辑管理器
 * 
 * 这是升级功能的核心。
 * 与角色创建不同，这里我们直接操作 Actor，采用增量式方法。
 * 不再使用 Blueprint 作为中间层，避免"欺骗系统"导致的各种 bug，曾经我以为升级很简单，哎
 */

import { DataManager } from './data-manager-v2.js';
import { applyModifyItemApplications, collectModifyItemApplications } from './shared/modify-item-resolution.js';
import { getAdvancementName, getAdvancementEntries, hasAdvancementEntries, setAdvancementSource } from './utils/advancement-utils.js';
import {
    hasOriginateActorMarkers,
    prepareResolutionItemData,
    prepareResolutionItemsData,
    resolveItemSourceUuid,
    stampSourceTracking
} from './shared/resolution-core.js';
import {
    applyGrantedSpellConfigs,
    getSpellCompatibilityState,
    LEGACY_ALWAYS_PREPARED_VALUE,
    mergeSpellDuplicateData
} from './shared/advancement-rule-utils.js';
import { normalizeToolId, toNativeWeaponMasteryKey } from './mapping.js';
import { resolveAdvancementItemSourceUuid } from './shared/source-tracking.js';

const DAMAGE_TYPE_ALIASES = {
    '酸': 'acid',
    '酸性': 'acid',
    '钝击': 'bludgeoning',
    '寒冷': 'cold',
    '冰冻': 'cold',
    '火焰': 'fire',
    '火': 'fire',
    '力场': 'force',
    '闪电': 'lightning',
    '电': 'lightning',
    '黯蚀': 'necrotic',
    '死灵': 'necrotic',
    '穿刺': 'piercing',
    '毒素': 'poison',
    '毒': 'poison',
    '心灵': 'psychic',
    '精神': 'psychic',
    '光耀': 'radiant',
    '光': 'radiant',
    '挥砍': 'slashing',
    '雷鸣': 'thunder',
    '雷': 'thunder'
};

function normalizeDamageTraitValue(value = '') {
    const text = String(value || '').trim();
    if (!text) return null;
    if (DAMAGE_TYPE_ALIASES[text]) return DAMAGE_TYPE_ALIASES[text];

    for (const [alias, nativeKey] of Object.entries(DAMAGE_TYPE_ALIASES)) {
        if (text.includes(alias)) return nativeKey;
    }

    return text.toLowerCase();
}

export class LevelUpManager {
    /**
     * @param {Actor} actor - 要升级的角色
     * @param {DataManager} dataManager - 数据管理器实例（可选，不传则创建新的）
     */
    constructor(actor, dataManager = null) {
        this.actor = actor;
        this.dataManager = dataManager || new DataManager();

        // 缓存职业信息
        this._classItem = null;
        this._subclassItem = null;
        this._classUuid = null;
        this._subclassUuid = null;
        this._targetClassItemId = null; // 多职业时指定操作目标
    }

    /**
     * 设置目标职业（多职业支持）
     * @param {string} classItemId - Actor 上的 class Item ID
     */
    setTargetClass(classItemId) {
        this._targetClassItemId = classItemId;
        // 清缓存，下次访问时重新查找
        this._classItem = null;
        this._subclassItem = null;
        this._classUuid = null;
        this._subclassUuid = null;
    }

    /**
     * 获取 Actor 身上所有职业物品
     * @returns {Array<Item>}
     */
    getActorClasses() {
        return this.actor.items.filter(i => i.type === 'class');
    }

    /**
     * 获取职业物品
     * @returns {Item|null}
     */
    get classItem() {
        if (!this._classItem) {
            // 优先使用指定的目标职业
            if (this._targetClassItemId) {
                this._classItem = this.actor.items.get(this._targetClassItemId);
            }
            // 回退：取第一个 class（单职业兼容）
            if (!this._classItem) {
                this._classItem = this.actor.items.find(i => i.type === 'class');
            }
        }
        return this._classItem;
    }

    /**
     * 获取子职物品
     * @returns {Item|null}
     */
    get subclassItem() {
        if (!this._subclassItem) {
            // 根据目标职业的 identifier 查找关联的 subclass
            const classIdentifier = this.classItem?.system?.identifier;
            if (classIdentifier) {
                this._subclassItem = this.actor.items.find(i =>
                    i.type === 'subclass' && i.system?.classIdentifier === classIdentifier
                );
            }
            // 注意：不再回退到"取第一个 subclass"
            // 兼职场景下，跨职业匹配子职会导致严重错误
        }
        return this._subclassItem;
    }

    /**
     * 获取职业 UUID（用于查询 Advancement）
     * @returns {string|null}
     */
    get classUuid() {
        if (!this._classUuid && this.classItem) {
            this._classUuid = resolveItemSourceUuid(this.classItem)
                || resolveItemSourceUuid(this.classItem._source);

            // 终极回退：从 Compendium index 中按名称+类型查找。
            // 旧角色或旧 writer 写出的父物品可能缺来源标记，不能再默认假设 sourceId 是主字段。
            if (!this._classUuid) {
                this._classUuid = this._findCompendiumUuid(this.classItem.name, 'class', this.classItem.system?.identifier);
            }

            window.OriginateLog(`Originate | [LevelUp] classUuid resolved: ${this._classUuid}`);
            if (!this._classUuid) {
                console.warn(`Originate | [LevelUp] 无法解析职业 UUID! classItem:`, {
                    name: this.classItem.name,
                    id: this.classItem.id,
                    flags: JSON.stringify(this.classItem.flags),
                    _stats: this.classItem._stats
                });
            }
        }
        return this._classUuid;
    }

    /**
     * 获取子职 UUID
     * @returns {string|null}
     */
    get subclassUuid() {
        if (!this._subclassUuid && this.subclassItem) {
            this._subclassUuid = resolveItemSourceUuid(this.subclassItem);

            // 回退2：从物品本身的 uuid（仅 Compendium UUID 有效）
            if (!this._subclassUuid && this.subclassItem.uuid) {
                const uuid = this.subclassItem.uuid;
                if (uuid.startsWith('Compendium.')) {
                    this._subclassUuid = uuid;
                }
            }

            // 回退3：从 _source 中查找
            if (!this._subclassUuid) {
                this._subclassUuid = resolveItemSourceUuid(this.subclassItem._source);
            }

            // 终极回退：从 Compendium index 中按名称+类型查找。
            // 旧角色或旧 writer 写出的父物品可能缺来源标记，不能再默认假设 sourceId 是主字段。
            if (!this._subclassUuid) {
                this._subclassUuid = this._findCompendiumUuid(this.subclassItem.name, 'subclass', this.subclassItem.system?.identifier);
            }

            window.OriginateLog(`Originate | [LevelUp] subclassUuid resolved: ${this._subclassUuid}`);
            if (!this._subclassUuid) {
                console.warn(`Originate | [LevelUp] 无法解析子职 UUID! subclassItem:`, {
                    name: this.subclassItem.name,
                    id: this.subclassItem.id,
                    uuid: this.subclassItem.uuid,
                    flags: JSON.stringify(this.subclassItem.flags),
                    _stats: this.subclassItem._stats
                });
            }
        }
        return this._subclassUuid;
    }

    /**
     * 从 Compendium index 中按名称+类型查找物品的 UUID
     * 
     * 这是终极回退方案：当 Actor 上的物品缺少所有来源标记时，
     * 通过 Compendium 的已加载 index 进行名称匹配。
     * 正常数据应该优先靠 resolveItemSourceUuid()，这里只是为了旧数据别直接断链。
     * 
     * @param {string} name - 物品名称
     * @param {string} type - 物品类型 ('class', 'subclass', 'race', 'background')
     * @returns {string|null} Compendium UUID
     * @private
     */
    _findCompendiumUuid(name, type, identifier = null) {
        if (!name || !type) return null;

        // 第一轮：精确名称 + 类型匹配
        for (const pack of game.packs) {
            if (pack.documentName !== 'Item') continue;
            const entry = pack.index.find(e => e.name === name && e.type === type);
            if (entry) {
                const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
                window.OriginateLog(`Originate | [LevelUp] 通过 Compendium index（精确名称）找到 ${type} "${name}": ${uuid}`);
                return uuid;
            }
        }

        // 第二轮：通过 identifier 匹配（如果提供了）
        // 应对本地化名称不一致的情况（如 Babele 翻译后 Actor 上的名称 ≠ Compendium 原始名称）
        if (identifier) {
            for (const pack of game.packs) {
                if (pack.documentName !== 'Item') continue;
                const entry = pack.index.find(e => e.type === type && e.system?.identifier === identifier);
                if (entry) {
                    const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
                    window.OriginateLog(`Originate | [LevelUp] 通过 Compendium index（identifier: ${identifier}）找到 ${type} "${entry.name}": ${uuid}`);
                    return uuid;
                }
            }
        }

        // 第三轮：仅类型匹配，模糊名称（包含关系）
        // 处理名称末尾有额外空格或括号标注的情况
        for (const pack of game.packs) {
            if (pack.documentName !== 'Item') continue;
            const entry = pack.index.find(e => e.type === type && (e.name?.includes(name) || name.includes(e.name)));
            if (entry) {
                const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
                window.OriginateLog(`Originate | [LevelUp] 通过 Compendium index（模糊名称）找到 ${type} "${entry.name}": ${uuid}`);
                return uuid;
            }
        }

        window.OriginateLog(`Originate | [LevelUp] Compendium index 中未找到 ${type} "${name}" (identifier: ${identifier})`);
        return null;
    }

    /**
     * 获取当前职业等级
     * @returns {number}
     */
    get currentLevel() {
        return this.classItem?.system?.levels || 1;
    }

    /**
     * 获取生命骰
     * @returns {number}
     */
    get hitDie() {
        const hdStr = this.classItem?.system?.hd?.denomination || 'd8';
        const match = String(hdStr).match(/d?(\d+)/);
        return match ? parseInt(match[1]) : 8;
    }

    /**
     * 获取体质调整值
     * @returns {number}
     */
    getConstitutionModifier() {
        const conValue = this.actor.system.abilities?.con?.value || 10;
        return Math.floor((conValue - 10) / 2);
    }

    _getAdvancementParentItem(stepType = 'class') {
        if (stepType === 'subclass') return this.subclassItem;
        if (stepType === 'race') return this.actor.items.find(i => i.type === 'race');
        if (stepType === 'background') return this.actor.items.find(i => i.type === 'background');
        return this.classItem;
    }

    _buildResolutionOptions(advancementId, level, options = {}) {
        const { stepType = 'class' } = options;

        return {
            stepType,
            actor: this.actor,
            classItem: this.classItem,
            subclassItem: this.subclassItem,
            advancementId,
            level,
            sourceClass: options.sourceClass || this.classItem?.system?.identifier || null,
            restoreFeatType: true,
            forceFeatTypeFromSource: true,
            warnPrefix: 'Originate | [LevelUp]'
        };
    }

    async _prepareItemsForResolution(itemsData, advancementId, level, options = {}) {
        const resolutionOptions = this._buildResolutionOptions(advancementId, level, options);
        const preparedItems = await prepareResolutionItemsData(itemsData, resolutionOptions);

        applyGrantedSpellConfigs(preparedItems, {
            warnPrefix: 'Originate | [LevelUp]',
            defaultSourceClass: resolutionOptions.sourceClass || null
        });

        return preparedItems;
    }

    _getContainerSourceParts(itemData) {
        const sourceUuid = this._resolveContainerSourceUuid(itemData);
        if (!sourceUuid) return null;

        const uuidParts = sourceUuid.split('.');
        if (uuidParts.length < 4 || uuidParts[0] !== 'Compendium') return null;

        return {
            sourceUuid,
            packKey: `${uuidParts[1]}.${uuidParts[2]}`,
            containerId: uuidParts[uuidParts.length - 1]
        };
    }

    _resolveContainerSourceUuid(itemData) {
        return resolveItemSourceUuid(itemData, { compendiumOnly: true });
    }

    _normalizeSourceUuid(sourceUuid) {
        return sourceUuid?.replace(/\.Item\./, '.') || null;
    }

    _findPreparedItemBySource(itemsData = [], sourceUuid = null) {
        const normalizedSourceUuid = this._normalizeSourceUuid(sourceUuid);
        if (!normalizedSourceUuid) return null;

        return itemsData.find(item =>
            this._normalizeSourceUuid(this._resolveContainerSourceUuid(item)) === normalizedSourceUuid
        ) || null;
    }

    _findPreparedContainerChild(itemsData = [], sourceData = {}) {
        const sourceIdentifier = sourceData.system?.identifier || null;
        const sourceName = sourceData.name?.trim()?.toLowerCase() || null;

        return itemsData.find(item => {
            if (!item || item.type !== sourceData.type) return false;
            if (sourceIdentifier && item.system?.identifier === sourceIdentifier) return true;

            const itemName = item.name?.trim()?.toLowerCase() || null;
            return !!sourceName && itemName === sourceName;
        }) || null;
    }

    _getContainerDescriptionUuids(containerItem = {}) {
        const description = containerItem.system?.description?.value || '';
        const uuids = [];
        const pattern = /@UUID\[(Compendium\.[^\]]+)\]/g;
        let match;

        while ((match = pattern.exec(description)) !== null) {
            uuids.push(match[1]);
        }

        return uuids;
    }

    async _collectContainerChildRefs(containerItem, sourceParts, pack) {
        const refs = new Map();

        await pack.getIndex({ fields: ["system.container"] });
        for (const entry of [...pack.index].filter(entry => entry.system?.container === sourceParts.containerId)) {
            refs.set(`Compendium.${sourceParts.packKey}.Item.${entry._id}`, {
                uuid: `Compendium.${sourceParts.packKey}.Item.${entry._id}`,
                id: entry._id,
                name: entry.name || ''
            });
        }

        // PHB 2024 的套组更像“描述里列 UUID 的商品包”，不一定有反向 container 索引。
        // 如果这些内容物已经被装备步骤单独放进 pending，这里也要给它们补挂载标记。
        for (const uuid of this._getContainerDescriptionUuids(containerItem)) {
            const uuidParts = uuid.split('.');
            refs.set(uuid, {
                uuid,
                id: uuidParts[uuidParts.length - 1],
                name: ''
            });
        }

        return [...refs.values()];
    }

    async _expandContainerContents(preparedItems = [], resolutionOptions = {}) {
        const expandedItems = [...preparedItems];
        const existingSources = new Set(expandedItems
            .map(item => this._normalizeSourceUuid(this._resolveContainerSourceUuid(item)))
            .filter(Boolean));
        const containerIdRemap = new Map();

        for (const containerItem of preparedItems) {
            if (!['container', 'backpack'].includes(containerItem?.type)) continue;

            const sourceParts = this._getContainerSourceParts(containerItem);
            if (!sourceParts) continue;

            const pack = resolutionOptions.packLookup
                ? resolutionOptions.packLookup(sourceParts.packKey)
                : game.packs.get(sourceParts.packKey);
            if (!pack) {
                window.OriginateLog?.(`Originate | [LevelUp] 未找到合集包 ${sourceParts.packKey}，跳过容器 ${containerItem.name}`);
                continue;
            }

            try {
                const childRefs = await this._collectContainerChildRefs(containerItem, sourceParts, pack);
                if (!childRefs.length) continue;

                containerIdRemap.set(sourceParts.containerId, containerItem);

                for (const childRef of childRefs) {
                    const normalizedChildUuid = this._normalizeSourceUuid(childRef.uuid);
                    const existingItem = this._findPreparedItemBySource(expandedItems, childRef.uuid);
                    if (existingItem) {
                        foundry.utils.setProperty(existingItem, 'flags.originate.pendingContainerId', sourceParts.containerId);
                        if (existingItem.system) delete existingItem.system.container;
                        continue;
                    }
                    if (existingSources.has(normalizedChildUuid)) continue;

                    const childDoc = childRef.uuid.startsWith(`Compendium.${sourceParts.packKey}.`)
                        ? await pack.getDocument(childRef.id)
                        : await fromUuid(childRef.uuid);
                    if (!childDoc) continue;

                    const childData = childDoc.toObject();
                    const existingByShape = this._findPreparedContainerChild(expandedItems, childData);
                    if (existingByShape) {
                        foundry.utils.setProperty(existingByShape, 'flags.originate.pendingContainerId', sourceParts.containerId);
                        if (existingByShape.system) delete existingByShape.system.container;
                        existingSources.add(normalizedChildUuid);
                        continue;
                    }

                    stampSourceTracking(childData, childRef.uuid);
                    foundry.utils.setProperty(childData, 'flags.originate.pendingContainerId', sourceParts.containerId);
                    if (childData.system) delete childData.system.container;

                    await prepareResolutionItemData(childData, {
                        ...resolutionOptions,
                        sourceUuid: childRef.uuid
                    });
                    expandedItems.push(childData);
                    existingSources.add(normalizedChildUuid);
                }
            } catch (error) {
                console.warn(`Originate | [LevelUp] 处理容器 ${containerItem.name} 内容物失败:`, error);
            }
        }

        return { itemsData: expandedItems, containerIdRemap };
    }

    _splitSpellUpdates(preparedItems) {
        const itemsToCreate = [];
        const pendingSpellUpdates = [];
        const pendingCreateByUuid = new Map();
        const pendingCreateByName = new Map();
        const pendingUpdateById = new Map();

        const getSpellKeys = item => ({
            sourceUuid: this._normalizeResolutionSourceUuid(item),
            nameKey: item?.name?.trim?.().toLowerCase?.() || null
        });

        const indexPendingCreate = item => {
            const { sourceUuid, nameKey } = getSpellKeys(item);
            if (sourceUuid) pendingCreateByUuid.set(sourceUuid, item);
            if (nameKey) pendingCreateByName.set(nameKey, item);
        };

        const findPendingCreate = item => {
            const { sourceUuid, nameKey } = getSpellKeys(item);
            return (sourceUuid ? pendingCreateByUuid.get(sourceUuid) : null)
                || (nameKey ? pendingCreateByName.get(nameKey) : null)
                || null;
        };

        for (const item of preparedItems) {
            if (item?.type !== 'spell') {
                itemsToCreate.push(item);
                continue;
            }

            const existingSpell = this._findMatchingActorSpell(item);
            if (existingSpell) {
                let updateData = pendingUpdateById.get(existingSpell.id);
                if (!updateData) {
                    updateData = existingSpell.toObject();
                    updateData._id = existingSpell.id;
                    pendingUpdateById.set(existingSpell.id, updateData);
                    pendingSpellUpdates.push(updateData);
                }
                mergeSpellDuplicateData(updateData, item);
                continue;
            }

            const pendingCreate = findPendingCreate(item);
            if (pendingCreate) {
                mergeSpellDuplicateData(pendingCreate, item);
                indexPendingCreate(pendingCreate);
                continue;
            }

            itemsToCreate.push(item);
            indexPendingCreate(item);
        }

        return {
            itemsToCreate,
            pendingSpellUpdates
        };
    }

    _collectSpellDedupeKeysFromInputs(inputs = []) {
        const inputList = Array.isArray(inputs) ? inputs : [inputs];
        const names = new Set();
        const sourceUuids = new Set();

        const collect = itemData => {
            if (itemData?.type !== 'spell') return;
            const sourceUuid = this._normalizeResolutionSourceUuid(itemData);
            const nameKey = itemData.name?.trim?.().toLowerCase?.() || null;
            if (sourceUuid) sourceUuids.add(sourceUuid);
            if (nameKey) names.add(nameKey);
        };

        for (const input of inputList) {
            const itemChanges = input?.itemChanges || {};
            for (const pending of itemChanges.pendingItems || []) collect(pending.itemData);
            for (const replacement of itemChanges.pendingReplacements || []) collect(replacement.newItemData);
            for (const manualItem of input?.manualItems || []) {
                collect(manualItem?.itemData || manualItem);
            }
        }

        return { names, sourceUuids };
    }

    _getSpellDedupeKeys(item) {
        if (item?.type !== 'spell') return null;
        return {
            sourceUuid: this._normalizeResolutionSourceUuid(item),
            nameKey: item.name?.trim?.().toLowerCase?.() || null
        };
    }

    _getSpellDedupeScore(item) {
        const state = getSpellCompatibilityState(item);
        let score = 0;
        if (Number(state.legacyPrepared) === LEGACY_ALWAYS_PREPARED_VALUE || state.preparationMode === 'always') score += 100;
        if (item?.flags?.dnd5e?.advancementOrigin) score += 10;
        const origin = item?.flags?.['hero-genesis']?.advancementOrigin || '';
        if (origin && !origin.startsWith('spell-rules-')) score += 5;
        return score;
    }

    _replaceAdvancementValueItemRefs(value = {}, replacements = new Map()) {
        const nextValue = foundry.utils.deepClone(value || {});
        let changed = false;

        const replaceFlatRefs = refs => {
            if (!refs || typeof refs !== 'object') return false;
            let localChanged = false;
            for (const [oldId, keptId] of replacements.entries()) {
                if (!Object.prototype.hasOwnProperty.call(refs, oldId)) continue;
                if (!Object.prototype.hasOwnProperty.call(refs, keptId)) {
                    refs[keptId] = refs[oldId];
                }
                delete refs[oldId];
                localChanged = true;
            }
            return localChanged;
        };

        const replaceMaybeNestedRefs = refs => {
            if (!refs || typeof refs !== 'object') return false;
            const values = Object.values(refs);
            const looksNested = values.some(item => item && typeof item === 'object' && !Array.isArray(item));
            if (!looksNested) return replaceFlatRefs(refs);

            let localChanged = false;
            for (const levelRefs of Object.values(refs)) {
                if (replaceFlatRefs(levelRefs)) localChanged = true;
            }
            return localChanged;
        };

        if (replaceMaybeNestedRefs(nextValue.added)) changed = true;
        if (replaceMaybeNestedRefs(nextValue.replaced)) changed = true;
        if (replaceFlatRefs(nextValue.feat)) changed = true;

        return { value: nextValue, changed };
    }

    async _replaceAdvancementItemReferences(replacements = new Map()) {
        if (!replacements.size) return [];

        const repaired = [];
        for (const parentItem of this.actor?.items || []) {
            const advancementSource = parentItem?.system?.advancement;
            if (!hasAdvancementEntries(advancementSource) || !(parentItem?.update instanceof Function)) continue;

            const entries = foundry.utils.deepClone(getAdvancementEntries(advancementSource));
            let changed = false;

            for (const entry of entries) {
                const result = this._replaceAdvancementValueItemRefs(entry.value || {}, replacements);
                if (!result.changed) continue;
                entry.value = result.value;
                changed = true;
            }

            if (!changed) continue;

            await parentItem.update({
                'system.advancement': setAdvancementSource(advancementSource, entries)
            });
            repaired.push(parentItem.name || parentItem.id || parentItem._id || 'unknown');
        }

        return repaired;
    }

    async repairDuplicateSpellsFromInputs(inputs = []) {
        const dedupeKeys = this._collectSpellDedupeKeysFromInputs(inputs);
        if (!dedupeKeys.names.size && !dedupeKeys.sourceUuids.size) {
            return { merged: [], deletedIds: [], repairedAdvancements: [] };
        }

        const groups = new Map();
        const addToGroup = (key, item) => {
            if (!key) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        };

        for (const item of this.actor?.items || []) {
            const keys = this._getSpellDedupeKeys(item);
            if (!keys) continue;
            if (keys.sourceUuid && dedupeKeys.sourceUuids.has(keys.sourceUuid)) {
                addToGroup(`source:${keys.sourceUuid}`, item);
            }
            if (keys.nameKey && dedupeKeys.names.has(keys.nameKey)) {
                addToGroup(`name:${keys.nameKey}`, item);
            }
        }

        const deletedIds = new Set();
        const replacements = new Map();
        const updateMap = new Map();
        const merged = [];

        for (const [groupKey, groupItems] of groups.entries()) {
            const activeItems = groupItems.filter(item => !deletedIds.has(item.id));
            if (activeItems.length < 2) continue;

            const keeper = activeItems
                .slice()
                .sort((left, right) => this._getSpellDedupeScore(right) - this._getSpellDedupeScore(left))[0];
            const keeperId = keeper.id || keeper._id;
            if (!keeperId) continue;

            const updateData = updateMap.get(keeperId)
                || (keeper.toObject instanceof Function ? keeper.toObject() : foundry.utils.deepClone(keeper));
            updateData._id = keeperId;

            const duplicates = activeItems.filter(item => (item.id || item._id) !== keeperId);
            for (const duplicate of duplicates) {
                const duplicateId = duplicate.id || duplicate._id;
                if (!duplicateId || deletedIds.has(duplicateId)) continue;

                const duplicateData = duplicate.toObject instanceof Function
                    ? duplicate.toObject()
                    : foundry.utils.deepClone(duplicate);
                mergeSpellDuplicateData(updateData, duplicateData);
                replacements.set(duplicateId, keeperId);
                deletedIds.add(duplicateId);
            }

            updateMap.set(keeperId, updateData);
            merged.push({
                groupKey,
                keptId: keeperId,
                keptName: keeper.name || updateData.name || null,
                removedIds: duplicates.map(item => item.id || item._id).filter(Boolean)
            });
        }

        if (!deletedIds.size) {
            return { merged: [], deletedIds: [], repairedAdvancements: [] };
        }

        const updates = Array.from(updateMap.values());
        if (updates.length > 0) {
            await this.actor.updateEmbeddedDocuments('Item', updates, {
                diff: false,
                recursive: false,
                isAdvancement: true
            });
        }

        const repairedAdvancements = await this._replaceAdvancementItemReferences(replacements);
        await this.actor.deleteEmbeddedDocuments('Item', Array.from(deletedIds), { isAdvancement: true });

        this._logTraitDebug('本次结算重复法术已合并', {
            merged,
            deletedIds: Array.from(deletedIds),
            repairedAdvancements
        });

        return {
            merged,
            deletedIds: Array.from(deletedIds),
            repairedAdvancements
        };
    }

    _detachConsumptionTargets(itemsToCreate) {
        const originalConsumptionData = new Map();

        for (const item of itemsToCreate) {
            if (!item.system?.activities) continue;

            for (const [activityId, activity] of Object.entries(item.system.activities)) {
                if (!activity?.consumption?.targets?.length) continue;

                const key = `${item.name}::${activityId}`;
                originalConsumptionData.set(key, foundry.utils.deepClone(activity.consumption.targets));
                activity.consumption.targets = activity.consumption.targets.map(target => ({
                    ...target,
                    target: ['itemUses', 'material'].includes(target.type) ? '' : target.target
                }));
            }
        }

        return originalConsumptionData;
    }

    async _repairContainerContentLinks(createdItems = [], containerIdRemap = new Map()) {
        if (!containerIdRemap.size || !createdItems.length) return createdItems;

        const createdContainerByOriginalId = new Map();
        for (const item of createdItems) {
            const originalContainerId = this._getContainerSourceParts(item)?.containerId;
            if (originalContainerId && containerIdRemap.has(originalContainerId)) {
                createdContainerByOriginalId.set(originalContainerId, item.id);
            }
        }

        if (!createdContainerByOriginalId.size) return createdItems;

        const updates = [];
        for (const actorItem of createdItems) {
            const pendingContainerId = actorItem.flags?.originate?.pendingContainerId;
            const newContainerId = createdContainerByOriginalId.get(pendingContainerId);
            if (!newContainerId) continue;

            updates.push({
                _id: actorItem.id,
                'system.container': newContainerId,
                'flags.originate.-=pendingContainerId': null
            });
        }

        if (!updates.length) return createdItems;

        const updatedItems = await this.actor.updateEmbeddedDocuments('Item', updates);
        const updatedById = new Map(updatedItems.map(item => [item.id, item]));
        window.OriginateLog?.(`Originate | [LevelUp] 已把 ${updates.length} 个容器内容物放回容器`);

        return createdItems.map(item => updatedById.get(item.id) || item);
    }

    _findPreparedSourceForPersistedItem(item, preparedItems = [], index = -1) {
        if (!item) return null;

        const sourceUuid = this._normalizeResolutionSourceUuid(item);
        const nameKey = item.name?.trim()?.toLowerCase() || null;

        if (sourceUuid) {
            const bySource = preparedItems.find(prepared =>
                this._sameSourceUuid(this._normalizeResolutionSourceUuid(prepared), sourceUuid)
            );
            if (bySource) return bySource;
        }

        if (nameKey) {
            const byName = preparedItems.find(prepared =>
                prepared?.name?.trim()?.toLowerCase() === nameKey
            );
            if (byName) return byName;
        }

        return preparedItems[index] || null;
    }

    _buildPersistedSpellStateUpdate(item, preparedSource) {
        if (!item || item.type !== 'spell' || preparedSource?.type !== 'spell') return null;

        const desired = getSpellCompatibilityState(preparedSource, {
            sourceClass: preparedSource.system?.sourceClass || null
        });
        const update = { _id: item.id };
        let changed = false;
        const itemData = item._source
            ? foundry.utils.deepClone(item._source)
            : (item.toObject instanceof Function
                ? item.toObject()
                : foundry.utils.deepClone(item));

        const setIfChanged = (path, value, { force = false } = {}) => {
            if (value === undefined) return;
            const current = foundry.utils.getProperty(itemData, path);
            if (!force && current === value) return;
            update[path] = value;
            changed = true;
        };

        if (desired.preparationMode === 'always') {
            setIfChanged('system.method', desired.method || 'spell', { force: true });
            setIfChanged('system.prepared', LEGACY_ALWAYS_PREPARED_VALUE, { force: true });
            setIfChanged('system.preparation.mode', 'always', { force: true });
            setIfChanged('system.preparation.prepared', true, { force: true });
        } else {
            if (desired.method) setIfChanged('system.method', desired.method);
            if (desired.legacyPrepared !== null) setIfChanged('system.prepared', desired.legacyPrepared);
            if (desired.preparationMode) setIfChanged('system.preparation.mode', desired.preparationMode);
            if (desired.preparationPrepared !== undefined) {
                setIfChanged('system.preparation.prepared', desired.preparationPrepared);
            }
        }

        if (desired.sourceItem) setIfChanged('system.sourceItem', desired.sourceItem);
        if (desired.sourceClass) setIfChanged('system.sourceClass', desired.sourceClass);
        return changed ? update : null;
    }

    _mirrorLegacySpellStateSource(item, updateData = {}) {
        if (!item || item.type !== 'spell' || typeof item.updateSource !== 'function') return;

        const sourceUpdate = {};
        for (const key of [
            'system.preparation.mode',
            'system.preparation.prepared',
            'system.sourceClass'
        ]) {
            if (updateData[key] !== undefined) sourceUpdate[key] = updateData[key];
        }

        if (Object.keys(sourceUpdate).length === 0) return;

        // 写盘后顺手把旧字段镜像回 source，5.3 以下和测试里的 toObject() 才不会看到两套状态。
        item.updateSource(sourceUpdate);
    }

    async _repairPersistedSpellStates(persistedItems = [], preparedItems = []) {
        if (!persistedItems.length || !preparedItems.length) return persistedItems;

        const updates = [];
        persistedItems.forEach((item, index) => {
            const preparedSource = this._findPreparedSourceForPersistedItem(item, preparedItems, index);
            const update = this._buildPersistedSpellStateUpdate(item, preparedSource);
            if (update) updates.push(update);
        });

        if (!updates.length) return persistedItems;

        const updatedItems = await this.actor.updateEmbeddedDocuments('Item', updates);
        window.OriginateLog(`Originate | [LevelUp] 校准 ${updatedItems.length} 个法术写盘后的准备状态`);

        const updatedById = new Map(updatedItems.map(item => [item.id, item]));
        for (const update of updates) {
            const updatedItem = updatedById.get(update._id);
            if (updatedItem) this._mirrorLegacySpellStateSource(updatedItem, update);
        }

        return persistedItems.map(item => updatedById.get(item.id) || item);
    }

    async _createItems(itemsData, options = {}) {
        if (!itemsData?.length) return [];

        const {
            keepId = false,
            bypassAdvancement = true
        } = options;

        const createOptions = {};
        if (keepId) createOptions.keepId = true;

        // 这里暂时仍走手工写盘，但把真正的落点收敛到一层。
        // 后面要试原生执行时，只改这一层，不再回头拆三份重复逻辑。
        if (bypassAdvancement) {
            createOptions["dnd5e.bypassAdvancement"] = true;
        }

        return this.actor.createEmbeddedDocuments("Item", itemsData, createOptions);
    }

    createLevelResolutionInput({
        level = null,
        context = {},
        itemChanges = null,
        pendingItems = [],
        pendingItemUpdates = [],
        pendingReplacements = [],
        pendingTraitChanges = [],
        selectedFeats = [],
        abilityScoreImprovements = [],
        asiChanges = {},
        hpGain = null,
        hpMethod = null
    } = {}) {
        const normalizedItemChanges = itemChanges
            ? {
                pendingItems: foundry.utils.deepClone(itemChanges.pendingItems || []),
                pendingItemUpdates: foundry.utils.deepClone(itemChanges.pendingItemUpdates || []),
                pendingReplacements: foundry.utils.deepClone(itemChanges.pendingReplacements || [])
            }
            : {
                pendingItems: foundry.utils.deepClone(pendingItems || []),
                pendingItemUpdates: foundry.utils.deepClone(pendingItemUpdates || []),
                pendingReplacements: foundry.utils.deepClone(pendingReplacements || [])
            };

        return {
            scope: 'level-up',
            level: level ?? context.level ?? null,
            context: {
                actorId: context.actorId ?? this.actor?.id ?? null,
                classItemId: context.classItemId ?? this.classItem?.id ?? null,
                subclassItemId: context.subclassItemId ?? this.subclassItem?.id ?? null,
                classIdentifier: context.classIdentifier ?? this.classItem?.system?.identifier ?? null,
                subclassIdentifier: context.subclassIdentifier ?? this.subclassItem?.system?.identifier ?? null,
                classUuid: context.classUuid ?? this.classUuid ?? null,
                subclassUuid: context.subclassUuid ?? this.subclassUuid ?? null,
                lockedLevel: context.lockedLevel ?? null
            },
            hp: {
                gain: hpGain ?? null,
                method: hpMethod ?? null
            },
            itemChanges: normalizedItemChanges,
            traitChanges: foundry.utils.deepClone(pendingTraitChanges || []),
            selectedFeats: foundry.utils.deepClone(selectedFeats || []),
            abilityScoreImprovements: foundry.utils.deepClone(abilityScoreImprovements || []),
            asiChanges: foundry.utils.deepClone(asiChanges || {})
        };
    }

    createCharacterFinalizeResolutionInput({
        level = null,
        context = {},
        scaffold = {},
        itemChanges = {},
        pendingItems = [],
        pendingItemUpdates = [],
        pendingReplacements = [],
        traitChanges = [],
        manualItems = []
    } = {}) {
        return this._normalizeCharacterFinalizeResolutionInput({
            scope: 'character-finalize',
            level,
            context,
            scaffold,
            itemChanges: {
                pendingItems,
                pendingItemUpdates,
                pendingReplacements,
                ...itemChanges
            },
            traitChanges,
            manualItems
        });
    }

    createInitialClassResolutionInput({
        classData = null,
        sourceUuid = null,
        multiclassed = false,
        hitPointMode = 'avg',
        context = {}
    } = {}) {
        return {
            scope: 'initial-class',
            context: {
                actorId: context.actorId ?? this.actor?.id ?? null,
                sourceUuid: context.sourceUuid ?? sourceUuid ?? null
            },
            classItem: {
                data: foundry.utils.deepClone(classData || {}),
                sourceUuid,
                multiclassed: !!multiclassed,
                hitPointMode
            }
        };
    }

    _normalizeInitialClassResolutionInput(input = {}) {
        if (input?.scope === 'initial-class') {
            return {
                scope: 'initial-class',
                context: {
                    actorId: input.context?.actorId ?? this.actor?.id ?? null,
                    sourceUuid: input.context?.sourceUuid ?? input.classItem?.sourceUuid ?? null
                },
                classItem: {
                    data: foundry.utils.deepClone(input.classItem?.data || input.classData || {}),
                    sourceUuid: input.classItem?.sourceUuid ?? input.sourceUuid ?? input.context?.sourceUuid ?? null,
                    multiclassed: !!(input.classItem?.multiclassed ?? input.multiclassed),
                    hitPointMode: input.classItem?.hitPointMode ?? input.hitPointMode ?? 'avg'
                }
            };
        }

        return this.createInitialClassResolutionInput(input);
    }

    _normalizeCharacterFinalizeResolutionInput(input = {}) {
        const itemChanges = input.itemChanges || {};

        return {
            scope: 'character-finalize',
            level: input.level ?? input.context?.lockedLevel ?? null,
            context: {
                actorId: input.context?.actorId ?? this.actor?.id ?? null,
                classItemId: input.context?.classItemId ?? this.classItem?.id ?? null,
                subclassItemId: input.context?.subclassItemId ?? this.subclassItem?.id ?? null,
                classIdentifier: input.context?.classIdentifier ?? this.classItem?.system?.identifier ?? null,
                subclassIdentifier: input.context?.subclassIdentifier ?? this.subclassItem?.system?.identifier ?? null,
                classUuid: input.context?.classUuid ?? this.classUuid ?? null,
                subclassUuid: input.context?.subclassUuid ?? this.subclassUuid ?? null,
                lockedLevel: input.context?.lockedLevel ?? input.level ?? null
            },
            scaffold: {
                actorData: foundry.utils.deepClone(input.scaffold?.actorData || {}),
                rootItems: foundry.utils.deepClone(input.scaffold?.rootItems || [])
            },
            hp: foundry.utils.deepClone(input.hp || {}),
            itemChanges: {
                pendingItems: foundry.utils.deepClone(itemChanges.pendingItems || input.pendingItems || []),
                pendingItemUpdates: foundry.utils.deepClone(itemChanges.pendingItemUpdates || input.pendingItemUpdates || []),
                pendingReplacements: foundry.utils.deepClone(itemChanges.pendingReplacements || input.pendingReplacements || [])
            },
            traitChanges: foundry.utils.deepClone(input.traitChanges || input.pendingTraitChanges || []),
            manualItems: foundry.utils.deepClone(input.manualItems || [])
        };
    }

    _createManualResolutionInput(normalizedInput = {}) {
        return {
            scope: normalizedInput.scope || 'level-up',
            level: normalizedInput.level ?? normalizedInput.context?.lockedLevel ?? null,
            context: foundry.utils.deepClone(normalizedInput.context || {}),
            hp: foundry.utils.deepClone(normalizedInput.hp || {}),
            itemChanges: {
                pendingItems: [],
                pendingItemUpdates: foundry.utils.deepClone(normalizedInput.itemChanges?.pendingItemUpdates || []),
                pendingReplacements: []
            },
            traitChanges: [],
            selectedFeats: foundry.utils.deepClone(normalizedInput.selectedFeats || []),
            abilityScoreImprovements: foundry.utils.deepClone(normalizedInput.abilityScoreImprovements || []),
            asiChanges: foundry.utils.deepClone(normalizedInput.asiChanges || {})
        };
    }

    _normalizeLevelResolutionInput(levelInput = {}) {
        if (levelInput?.scope === 'character-finalize') {
            return this._normalizeCharacterFinalizeResolutionInput(levelInput);
        }

        if (levelInput?.scope === 'level-up') {
            const itemChanges = levelInput.itemChanges || {};
            return {
                scope: 'level-up',
                level: levelInput.level ?? levelInput.context?.lockedLevel ?? null,
                context: {
                    actorId: levelInput.context?.actorId ?? this.actor?.id ?? null,
                    classItemId: levelInput.context?.classItemId ?? this.classItem?.id ?? null,
                    subclassItemId: levelInput.context?.subclassItemId ?? this.subclassItem?.id ?? null,
                    classIdentifier: levelInput.context?.classIdentifier ?? this.classItem?.system?.identifier ?? null,
                    subclassIdentifier: levelInput.context?.subclassIdentifier ?? this.subclassItem?.system?.identifier ?? null,
                    classUuid: levelInput.context?.classUuid ?? this.classUuid ?? null,
                    subclassUuid: levelInput.context?.subclassUuid ?? this.subclassUuid ?? null,
                    lockedLevel: levelInput.context?.lockedLevel ?? null
                },
                hp: {
                    gain: levelInput.hp?.gain ?? levelInput.hpGain ?? null,
                    method: levelInput.hp?.method ?? levelInput.hpMethod ?? null
                },
                itemChanges: {
                    pendingItems: foundry.utils.deepClone(itemChanges.pendingItems || levelInput.pendingItems || []),
                    pendingItemUpdates: foundry.utils.deepClone(itemChanges.pendingItemUpdates || levelInput.pendingItemUpdates || []),
                    pendingReplacements: foundry.utils.deepClone(itemChanges.pendingReplacements || levelInput.pendingReplacements || [])
                },
                // 这里不能再走 createLevelResolutionInput 重新拼一遍。
                // 已经是正式结算输入时，traitChanges / hp 这些字段名已经定型了，
                // 再按旧入口重建会把它们当成“未知字段”直接吞掉。
                traitChanges: foundry.utils.deepClone(levelInput.traitChanges || levelInput.pendingTraitChanges || []),
                selectedFeats: foundry.utils.deepClone(levelInput.selectedFeats || []),
                abilityScoreImprovements: foundry.utils.deepClone(levelInput.abilityScoreImprovements || []),
                asiChanges: foundry.utils.deepClone(levelInput.asiChanges || {})
            };
        }

        if (levelInput?.itemChanges || levelInput?.context) {
            return this.createLevelResolutionInput({
                ...levelInput,
                pendingTraitChanges: levelInput.traitChanges ?? levelInput.pendingTraitChanges ?? [],
                hpGain: levelInput.hp?.gain ?? levelInput.hpGain ?? null,
                hpMethod: levelInput.hp?.method ?? levelInput.hpMethod ?? null
            });
        }

        return this.createLevelResolutionInput(levelInput);
    }

    _normalizeResolutionSourceUuid(itemData) {
        const sourceUuid = resolveItemSourceUuid(itemData)
            || itemData?._sourceUuid
            || itemData?.uuid
            || null;

        return sourceUuid?.replace(/\.Item\./, '.') || null;
    }

    _resetResolutionCaches() {
        this._classItem = null;
        this._subclassItem = null;
        this._classUuid = null;
        this._subclassUuid = null;
    }

    _assertCurrentLevelSandbox(levelInput = {}) {
        const expectedLevel = Number(levelInput?.level ?? levelInput?.context?.lockedLevel ?? null);
        if (!Number.isFinite(expectedLevel)) return;

        const mismatches = [];
        // 这里先把“跨级脏数据”拦在提交入口外面。
        // 不然阶段 2 一边试原生执行，一边又混进别的等级的 pending，后面根本没法判断是谁写坏了。
        const collect = (entries = [], label) => {
            for (const entry of entries) {
                const entryLevel = Number(entry?.level ?? expectedLevel);
                if (!Number.isFinite(entryLevel) || entryLevel === expectedLevel) continue;
                mismatches.push(`${label}:${entryLevel}`);
            }
        };

        const itemChanges = levelInput?.itemChanges || {};
        collect(itemChanges.pendingItems, 'pendingItems');
        collect(itemChanges.pendingReplacements, 'pendingReplacements');
        collect(levelInput.traitChanges, 'traitChanges');
        collect(levelInput.selectedFeats, 'selectedFeats');
        collect(levelInput.abilityScoreImprovements, 'abilityScoreImprovements');

        if (!mismatches.length) return;

        throw new Error(`Originate | [LevelUp] 当前级结算输入混入了其他等级的数据: ${mismatches.join(', ')}`);
    }

    _findItemByName(actor, name, predicate = null) {
        if (!actor?.items || !name) return null;

        const normalizedName = name.trim().toLowerCase();
        const items = actor.items.filter(item => {
            if (!item?.name || item.name.trim().toLowerCase() !== normalizedName) return false;
            return predicate ? predicate(item) : true;
        });

        return items.length ? items[items.length - 1] : null;
    }

    _sameSourceUuid(left, right) {
        const normalize = value => value?.replace?.(/\.Item\./, '.') || null;
        const normalizedLeft = normalize(left);
        const normalizedRight = normalize(right);
        return !!normalizedLeft && normalizedLeft === normalizedRight;
    }

    _readActorItemSourceUuid(item) {
        return resolveItemSourceUuid(item, { compendiumOnly: true });
    }

    _findItemBySourceUuid(actor, sourceUuid, predicate = null) {
        if (!actor?.items || !sourceUuid) return null;

        const items = actor.items.filter(item => {
            if (predicate && !predicate(item)) return false;

            const itemSourceUuid = this._readActorItemSourceUuid(item);
            return this._sameSourceUuid(itemSourceUuid, sourceUuid);
        });

        return items.length ? items[items.length - 1] : null;
    }

    _getResolutionClassIdentifier(actor = this.actor, context = {}) {
        if (context.classIdentifier) return context.classIdentifier;

        const classItem = actor?.items?.get?.(context.classItemId)
            || actor?.items?.find?.(item => item.type === 'class' && item.id === this._targetClassItemId)
            || actor?.items?.find?.(item => item.type === 'class');

        return classItem?.system?.identifier || this.classItem?.system?.identifier || null;
    }

    _findResolutionParentItem(stepType = 'class', {
        actor = this.actor,
        context = {},
        parentFeature = null,
        parentSourceUuid = null
    } = {}) {
        if (!actor?.items) return null;

        if (parentFeature || parentSourceUuid) {
            const classIdentifier = this._getResolutionClassIdentifier(actor, context);
            const predicate = item => {
                if (!['feat', 'subclass', 'class'].includes(item.type)) return false;
                if (!classIdentifier) return true;
                return !item.system?.sourceClass || item.system.sourceClass === classIdentifier || item.system?.classIdentifier === classIdentifier;
            };

            // 嵌套 Advancement 的父节点优先按来源找。
            // 显示名会受翻译影响，兼职子职里用名字回找很容易踩空。
            const bySource = this._findItemBySourceUuid(actor, parentSourceUuid, predicate);
            if (bySource) return bySource;

            return this._findItemByName(actor, parentFeature, predicate);
        }

        if (stepType === 'subclass') {
            const classIdentifier = this._getResolutionClassIdentifier(actor, context);
            const subclassIdentifier = context.subclassIdentifier || null;
            const belongsToClass = item => !classIdentifier || item.system?.classIdentifier === classIdentifier;
            const bySource = this._findItemBySourceUuid(actor, context.subclassUuid, item => {
                if (item.type !== 'subclass') return false;
                return belongsToClass(item) || (subclassIdentifier && item.system?.identifier === subclassIdentifier);
            });

            return actor.items.get?.(context.subclassItemId)
                || bySource
                || actor.items.find?.(item => item.type === 'subclass'
                    && subclassIdentifier
                    && item.system?.identifier === subclassIdentifier
                    && belongsToClass(item))
                || actor.items.find?.(item => item.type === 'subclass' && belongsToClass(item))
                || null;
        }

        if (stepType === 'race') {
            return actor.items.find?.(item => item.type === 'race') || null;
        }

        if (stepType === 'background') {
            return actor.items.find?.(item => item.type === 'background') || null;
        }

        return actor.items.get?.(context.classItemId)
            || (this._targetClassItemId ? actor.items.get?.(this._targetClassItemId) : null)
            || actor.items.find?.(item => item.type === 'class')
            || null;
    }

    _isManualOnlyAdvancementId(advancementId) {
        if (!advancementId) return true;
        return advancementId.startsWith('spell-rules-') || advancementId === 'feat-grant';
    }

    _getItemAdvancement(parentItem, advancementId, { documentOnly = false } = {}) {
        if (!parentItem || !advancementId) return null;

        const documentAdvancement = parentItem.advancement?.get?.(advancementId)
            || parentItem.system?.advancement?.get?.(advancementId)
            || null;
        if (documentAdvancement) return documentAdvancement;
        if (documentOnly) return null;

        const rawAdvancement = parentItem.system?.advancement;
        if (rawAdvancement?.[advancementId]) return rawAdvancement[advancementId];

        return getAdvancementEntries(rawAdvancement)
            .find(entry => (entry?._id || entry?.id) === advancementId)
            || null;
    }

    _getNativeAdvancement(parentItem, advancementId) {
        const advancement = this._getItemAdvancement(parentItem, advancementId, { documentOnly: true });
        if (!advancement) return null;
        if (!['ItemGrant', 'ItemChoice', 'Trait'].includes(advancement.type)) return null;
        return advancement;
    }

    _shouldDebugTraitKey(key = '') {
        const normalizedKey = String(key || '');
        return normalizedKey.startsWith('skills:')
            || normalizedKey.startsWith('skill:')
            || normalizedKey.startsWith('tool:')
            || normalizedKey.startsWith('tools:');
    }

    _logTraitDebug(message, payload = undefined) {
        if (payload === undefined) {
            window.OriginateLog(`Originate | [LevelUp][TraitDebug] ${message}`);
            return;
        }

        window.OriginateLog(`Originate | [LevelUp][TraitDebug] ${message}`, payload);
    }

    _snapshotTraitState(actor = this.actor) {
        const skills = {};
        for (const [key, skill] of Object.entries(actor?.system?.skills || {})) {
            const value = Number(skill?.value ?? skill?.proficient ?? 0);
            if (value > 0) skills[key] = value;
        }

        const tools = {};
        for (const [key, tool] of Object.entries(actor?.system?.tools || {})) {
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
            toolProf: Array.from(actor?.system?.traits?.toolProf?.value || [])
        };
    }

    _getAdvancementChosenKeys(advancement) {
        const chosen = advancement?.value?.chosen;
        if (!chosen) return [];
        if (Array.isArray(chosen)) return [...chosen];
        if (chosen instanceof Set) return Array.from(chosen);
        if (typeof chosen[Symbol.iterator] === 'function') return Array.from(chosen);
        return [];
    }

    _asArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Set) return Array.from(value);
        if (value instanceof Map) return Array.from(value.values());
        if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
        if (typeof value === 'object') return Object.values(value);
        return [value];
    }

    _getTraitAdvancementPools(advancement = null) {
        const pools = [
            ...this._asArray(advancement?.configuration?.grants)
        ];
        for (const choice of this._asArray(advancement?.configuration?.choices)) {
            pools.push(...this._asArray(choice?.pool));
        }
        return pools;
    }

    _normalizeTraitKeyForAdvancement(key = '', advancement = null) {
        const text = String(key || '');
        const mode = advancement?.configuration?.mode || 'default';
        if (!text) return null;

        if (mode === 'mastery' || text.startsWith('weaponMastery:')) {
            return toNativeWeaponMasteryKey(text, this._getTraitAdvancementPools(advancement));
        }

        if (mode === 'expertise') {
            if (text.startsWith('expertise:') || text.startsWith('skill:')) {
                const suffix = text.split(':').slice(1).join(':');
                return suffix ? `skills:${suffix}` : null;
            }
        }

        if (text.startsWith('tools:')) {
            const suffix = text.split(':').slice(1).join(':');
            return suffix ? `tool:${suffix}` : null;
        }

        const parts = text.split(':');
        const category = parts[0];
        if (['dr', 'di', 'dv'].includes(category)) {
            const normalizedDamage = normalizeDamageTraitValue(parts.slice(1).join(':'));
            return normalizedDamage ? `${category}:${normalizedDamage}` : null;
        }

        if (category === 'weapons') {
            const suffix = parts.slice(1).join(':');
            return suffix ? `weapon:${suffix}` : null;
        }

        return text;
    }

    _traitPoolMatchesKey(poolKey, key, advancement = null) {
        const normalizedPool = this._normalizeTraitKeyForAdvancement(poolKey, advancement);
        const normalizedKey = this._normalizeTraitKeyForAdvancement(key, advancement);
        if (!normalizedPool || !normalizedKey) return false;
        if (normalizedPool === normalizedKey) return true;
        if (normalizedPool.endsWith(':*')) return normalizedKey.startsWith(normalizedPool.slice(0, -1));
        return normalizedKey.startsWith(`${normalizedPool}:`);
    }

    _getWeaponCategoryTraitValue(value = '') {
        const parts = String(value || '').toLowerCase().split(':').filter(Boolean);
        if (parts.length < 2 || parts[parts.length - 1] !== '*') return null;

        const category = parts[0];
        if (category === 'mar' || category === 'martial') return 'mar';
        if (category === 'sim' || category === 'simple') return 'sim';
        return null;
    }

    _hasWeaponCategoryTrait(actor, category) {
        if (!category) return false;

        const aliases = category === 'mar'
            ? new Set(['mar', 'martial'])
            : new Set(['sim', 'simple']);
        const weaponValues = this._asArray(foundry.utils.getProperty(actor, 'system.traits.weaponProf.value'));
        return weaponValues.some(value => aliases.has(String(value || '').toLowerCase()));
    }

    _actorHasTraitKey(actor, key, mode = 'default') {
        const normalizedKey = this._normalizeTraitKeyForAdvancement(key, { configuration: { mode } });
        if (!actor || !normalizedKey) return false;

        const parts = normalizedKey.split(':');
        const category = parts.shift();
        const value = parts.join(':');
        const leafValue = parts[parts.length - 1];
        if (!category || !value) return false;

        if (category === 'saves') {
            const saveValue = Number(foundry.utils.getProperty(actor, `system.abilities.${leafValue}.proficient`) ?? 0);
            return saveValue >= 1;
        }

        if (category === 'skills' || category === 'skill') {
            const skillValue = Number(foundry.utils.getProperty(actor, `system.skills.${leafValue}.value`) ?? 0);
            return skillValue >= (mode === 'expertise' ? 2 : 1);
        }

        if (category === 'expertise') {
            const skillValue = Number(foundry.utils.getProperty(actor, `system.skills.${leafValue}.value`) ?? 0);
            return skillValue >= 2;
        }

        if (category === 'tool') {
            const toolId = normalizeToolId(value) || leafValue;
            const toolValue = Number(foundry.utils.getProperty(actor, `system.tools.${toolId}.value`) ?? 0);
            if (toolValue >= (mode === 'expertise' ? 2 : 1)) return true;

            const storedTools = this._asArray(foundry.utils.getProperty(actor, 'system.traits.toolProf.value'));
            return storedTools.some(tool => (normalizeToolId(tool) || tool) === toolId);
        }

        if (category === 'weapon') {
            const masteryValues = this._asArray(foundry.utils.getProperty(actor, 'system.traits.weaponProf.mastery.value'));
            if (mode === 'mastery') return masteryValues.includes(leafValue);

            const weaponCategory = this._getWeaponCategoryTraitValue(value);
            if (weaponCategory) return this._hasWeaponCategoryTrait(actor, weaponCategory);

            const weaponValues = this._asArray(foundry.utils.getProperty(actor, 'system.traits.weaponProf.value'));
            return weaponValues.includes(value) || weaponValues.includes(leafValue);
        }

        const pathMap = {
            languages: 'system.traits.languages.value',
            language: 'system.traits.languages.value',
            armor: 'system.traits.armorProf.value',
            dr: 'system.traits.dr.value',
            di: 'system.traits.di.value',
            dv: 'system.traits.dv.value',
            ci: 'system.traits.ci.value'
        };
        const path = pathMap[category];
        if (!path) return false;
        const storedValues = this._asArray(foundry.utils.getProperty(actor, path));
        return storedValues.includes(value) || storedValues.includes(leafValue);
    }

    _buildTraitActorUpdates(keys = [], mode = 'default', actor = this.actor) {
        const updates = {};
        const addSetValue = (path, value) => {
            const existing = this._asArray(foundry.utils.getProperty(actor, path));
            updates[path] = Array.from(new Set([...existing, value]));
        };
        const setMinimumNumber = (path, minimum) => {
            const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
            if (current >= minimum) return;
            updates[path] = minimum;
        };

        for (const key of keys) {
            const normalizedKey = this._normalizeTraitKeyForAdvancement(key, { configuration: { mode } });
            if (!normalizedKey) continue;

            const parts = normalizedKey.split(':');
            const category = parts.shift();
            const value = parts.join(':');
            const leafValue = parts[parts.length - 1];
            if (!category || !value) continue;

            if (category === 'saves') {
                setMinimumNumber(`system.abilities.${leafValue}.proficient`, 1);
                continue;
            }

            if (category === 'skills' || category === 'skill') {
                setMinimumNumber(`system.skills.${leafValue}.value`, mode === 'expertise' ? 2 : 1);
                continue;
            }

            if (category === 'expertise') {
                setMinimumNumber(`system.skills.${leafValue}.value`, 2);
                continue;
            }

            if (category === 'tool') {
                const toolId = normalizeToolId(value) || value.split(':').pop();
                setMinimumNumber(`system.tools.${toolId}.value`, mode === 'expertise' ? 2 : 1);

                const ability = CONFIG.DND5E?.tools?.[toolId]?.ability;
                const abilityPath = `system.tools.${toolId}.ability`;
                if (ability && !foundry.utils.hasProperty(actor, abilityPath)) {
                    updates[abilityPath] = ability;
                }
                continue;
            }

            if (category === 'weaponMastery' || (category === 'weapon' && mode === 'mastery')) {
                addSetValue('system.traits.weaponProf.mastery.value', leafValue);
                continue;
            }

            if (category === 'weapon') {
                const weaponCategory = this._getWeaponCategoryTraitValue(value);
                addSetValue('system.traits.weaponProf.value', weaponCategory || leafValue);
                continue;
            }

            const pathMap = {
                languages: 'system.traits.languages.value',
                language: 'system.traits.languages.value',
                weapons: 'system.traits.weaponProf.value',
                armor: 'system.traits.armorProf.value',
                dr: 'system.traits.dr.value',
                di: 'system.traits.di.value',
                dv: 'system.traits.dv.value',
                ci: 'system.traits.ci.value'
            };
            const path = pathMap[category];
            if (path) addSetValue(path, leafValue);
        }

        return updates;
    }

    _mergeTraitActorUpdates(target = {}, updates = {}) {
        for (const [path, value] of Object.entries(updates || {})) {
            const current = target[path];
            if (Array.isArray(current) || Array.isArray(value)) {
                target[path] = Array.from(new Set([
                    ...this._asArray(current),
                    ...this._asArray(value)
                ]));
                continue;
            }

            if (typeof current === 'number' || typeof value === 'number') {
                const currentNumber = Number(current ?? 0);
                const nextNumber = Number(value ?? 0);
                target[path] = Math.max(
                    Number.isFinite(currentNumber) ? currentNumber : 0,
                    Number.isFinite(nextNumber) ? nextNumber : 0
                );
                continue;
            }

            if (current === undefined) target[path] = value;
        }

        return target;
    }

    async applyRemainingTraitChanges(changes = []) {
        const groups = new Map();
        const appliedChanges = [];
        const skippedChanges = [];

        for (const change of this._asArray(changes)) {
            if (!change?.key) continue;
            const mode = change.mode || 'default';
            if (this._actorHasTraitKey(this.actor, change.key, mode)) {
                skippedChanges.push({
                    ...foundry.utils.deepClone(change),
                    reason: 'already-present'
                });
                continue;
            }
            if (!groups.has(mode)) groups.set(mode, []);
            groups.get(mode).push(change);
        }

        const actorUpdate = {};
        const orderedModes = [
            'default',
            'expertise',
            'mastery',
            ...Array.from(groups.keys()).filter(mode => !['default', 'expertise', 'mastery'].includes(mode))
        ];

        for (const mode of orderedModes) {
            const group = groups.get(mode) || [];
            if (!group.length) continue;
            const updates = this._buildTraitActorUpdates(group.map(change => change.key), mode, this.actor);
            this._mergeTraitActorUpdates(actorUpdate, updates);
            appliedChanges.push(...group.map(change => foundry.utils.deepClone(change)));
        }

        if (Object.keys(actorUpdate).length > 0) {
            await this.actor.update(actorUpdate);
        }

        return {
            actorUpdate,
            appliedChanges,
            skippedChanges
        };
    }

    _traitKeyBelongsToAdvancement(key, advancement = null) {
        const normalizedKey = this._normalizeTraitKeyForAdvancement(key, advancement);
        if (!normalizedKey || advancement?.type !== 'Trait') return false;

        const grants = this._asArray(advancement.configuration?.grants);
        if (grants.some(grant => this._normalizeTraitKeyForAdvancement(grant, advancement) === normalizedKey)) {
            return true;
        }

        for (const choice of this._asArray(advancement.configuration?.choices)) {
            const pool = this._asArray(choice?.pool);
            if (pool.some(poolKey => this._traitPoolMatchesKey(poolKey, normalizedKey, advancement))) {
                return true;
            }
        }

        return false;
    }

    _normalizeAdvancementChosenKeys(keys = [], advancement = null) {
        const chosen = [];
        for (const key of keys) {
            const normalizedKey = this._normalizeTraitKeyForAdvancement(key, advancement);
            if (!normalizedKey || chosen.includes(normalizedKey)) continue;
            chosen.push(normalizedKey);
        }
        return chosen;
    }

    _traitChosenNeedsRewrite(beforeChosen = [], afterChosen = []) {
        if (beforeChosen.length !== afterChosen.length) return true;
        return beforeChosen.some((key, index) => key !== afterChosen[index]);
    }

    _getTraitAdvancementLevel(advancement = null) {
        const level = Number(advancement?.level ?? advancement?.configuration?.level);
        return Number.isFinite(level) ? level : null;
    }

    _shouldRepairTraitGrantForInput(advancement = null, normalizedInput = {}) {
        const advancementLevel = this._getTraitAdvancementLevel(advancement);
        const lockedLevel = Number(normalizedInput.context?.lockedLevel ?? normalizedInput.level);
        if (advancementLevel === null || !Number.isFinite(lockedLevel)) return true;
        return advancementLevel <= lockedLevel;
    }

    _getTraitRepairCandidateScore(item, group = {}, context = {}) {
        let score = 0;
        const itemSourceUuid = this._readActorItemSourceUuid(item);
        const classIdentifier = this._getResolutionClassIdentifier(this.actor, context);
        const subclassIdentifier = context.subclassIdentifier || null;

        if (this._sameSourceUuid(itemSourceUuid, group.parentSourceUuid)) score += 100;
        if (group.parentFeature && item?.name === group.parentFeature) score += 40;
        if (subclassIdentifier && item?.system?.identifier === subclassIdentifier) score += 80;
        if (item?.type === 'feat') score += 10;

        const itemClass = item?.system?.sourceClass || item?.system?.classIdentifier || null;
        if (!classIdentifier || !itemClass || itemClass === classIdentifier) score += 5;

        return score;
    }

    async _updateTraitAdvancementValue(parentItem, advancement, nextValue, advancementIdFallback = null) {
        const advancementId = advancement?._id || advancement?.id || advancementIdFallback;
        const advancementSource = parentItem?.system?.advancement;
        const entries = getAdvancementEntries(advancementSource).map(entry => {
            if (entry?.toObject instanceof Function) return entry.toObject();
            return foundry.utils.deepClone(entry);
        });
        const target = entries.find(entry => (entry?._id || entry?.id) === advancementId);

        if (target && parentItem?.update instanceof Function) {
            target.value = nextValue;
            await parentItem.update({
                "system.advancement": setAdvancementSource(advancementSource, entries)
            });

            const afterWholeUpdate = this._getItemAdvancement(parentItem, advancementId);
            const afterChosen = new Set(this._getAdvancementChosenKeys(afterWholeUpdate));
            const expectedChosen = this._asArray(nextValue?.chosen);
            const wholeUpdateWorked = expectedChosen.every(key => afterChosen.has(key));
            if (wholeUpdateWorked) return 'item';

            // Foundry 的 advancement 是 DataModel 集合，整包替换在少数链路里会被吃掉。
            // 这里再用精确路径补一次，只碰当前 advancement 的 value，避免又把别的等级猜乱。
            await parentItem.update({
                [`system.advancement.${advancementId}.value`]: nextValue
            });
            return 'item-path';
        }

        if (advancement?.update instanceof Function) {
            await advancement.update({ value: nextValue });
            return 'advancement';
        }

        throw new Error(`无法写回 Trait advancement value: ${advancementId || 'unknown'}`);
    }

    _findTraitAdvancementRepairTarget(group = {}, context = {}) {
        const parentItem = this._findResolutionParentItem(group.stepType, {
            actor: this.actor,
            context,
            parentFeature: group.parentFeature,
            parentSourceUuid: group.parentSourceUuid
        });
        const parentAdvancement = this._getItemAdvancement(parentItem, group.advancementId);
        if (parentAdvancement?.type === 'Trait'
            && group.keys.some(key => this._traitKeyBelongsToAdvancement(key, parentAdvancement))) {
            return {
                parentItem,
                advancement: parentAdvancement,
                via: 'parent'
            };
        }

        const candidates = [];
        for (const item of this.actor?.items || []) {
            if (!['class', 'subclass', 'race', 'background', 'feat'].includes(item?.type)) continue;

            const advancement = this._getItemAdvancement(item, group.advancementId);
            if (advancement?.type !== 'Trait') continue;
            if (!group.keys.some(key => this._traitKeyBelongsToAdvancement(key, advancement))) continue;

            candidates.push({
                parentItem: item,
                advancement,
                score: this._getTraitRepairCandidateScore(item, group, context)
            });
        }

        candidates.sort((left, right) => right.score - left.score);
        const best = candidates[0];
        if (!best) return {
            parentItem,
            advancement: parentAdvancement || null,
            via: 'missing',
            candidates: []
        };

        if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
            this._logTraitDebug('Trait 配置校准找到多个候选，使用第一个最高分候选', {
                advancementId: group.advancementId,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                candidates: candidates.map(candidate => ({
                    itemName: candidate.parentItem?.name || null,
                    itemId: candidate.parentItem?.id || null,
                    sourceUuid: this._readActorItemSourceUuid(candidate.parentItem),
                    score: candidate.score
                }))
            });
        }

        return {
            parentItem: best.parentItem,
            advancement: best.advancement,
            via: 'scan',
            candidates
        };
    }

    async repairTraitAdvancementChoicesFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const traitGroups = new Map();

        for (const change of normalizedInput.traitChanges || []) {
            if (!change?.key || this._isManualOnlyAdvancementId(change.advancementId)) continue;
            this._addNativeTraitGroup(traitGroups, change);
        }

        const debugGroups = Array.from(traitGroups.values())
            .filter(group => group.keys.some(key => this._shouldDebugTraitKey(key)));
        if (debugGroups.length > 0) {
            this._logTraitDebug('Trait 配置校准开始', {
                level: normalizedInput.level,
                groups: debugGroups.map(group => ({
                    advancementId: group.advancementId,
                    stepType: group.stepType,
                    parentFeature: group.parentFeature || null,
                    parentSourceUuid: group.parentSourceUuid || null,
                    keys: [...group.keys]
                }))
            });
        }

        const repaired = [];
        for (const group of traitGroups.values()) {
            const target = this._findTraitAdvancementRepairTarget(group, normalizedInput.context);
            const { parentItem, advancement } = target;
            if (!advancement || advancement.type !== 'Trait') {
                if (group.keys.some(key => this._shouldDebugTraitKey(key))) {
                    this._logTraitDebug('Trait 配置校准跳过：找不到对应原生 Trait advancement', {
                        advancementId: group.advancementId,
                        stepType: group.stepType,
                        parentFeature: group.parentFeature || null,
                        parentSourceUuid: group.parentSourceUuid || null,
                        parentItem: parentItem?.name || null,
                        keys: [...group.keys],
                        lookupVia: target?.via || 'missing'
                    });
                }
                continue;
            }

            const beforeChosen = this._getAdvancementChosenKeys(advancement);
            const normalizedBeforeChosen = this._normalizeAdvancementChosenKeys(beforeChosen, advancement);
            const nextChosen = new Set(normalizedBeforeChosen);
            const added = [];
            const skipped = [];
            const acceptedKeys = [];

            for (const key of group.keys) {
                const normalizedKey = this._normalizeTraitKeyForAdvancement(key, advancement);
                if (!this._traitKeyBelongsToAdvancement(normalizedKey, advancement)) {
                    skipped.push(key);
                    continue;
                }
                acceptedKeys.push(normalizedKey);
                if (nextChosen.has(normalizedKey)) continue;
                nextChosen.add(normalizedKey);
                added.push(normalizedKey);
            }

            const mode = advancement.configuration?.mode || 'default';
            const missingActorKeys = acceptedKeys.filter(key => !this._actorHasTraitKey(this.actor, key, mode));
            const actorUpdate = this.actor?.update instanceof Function
                ? this._buildTraitActorUpdates(missingActorKeys, mode)
                : {};
            const hasActorUpdate = Object.keys(actorUpdate).length > 0;
            const afterChosen = Array.from(nextChosen);
            const needsChosenRewrite = added.length || this._traitChosenNeedsRewrite(beforeChosen, afterChosen);

            if (!needsChosenRewrite && !hasActorUpdate) {
                if (group.keys.some(key => this._shouldDebugTraitKey(key))) {
                    this._logTraitDebug('Trait 配置校准没有可写入的 key', {
                        advancementId: group.advancementId,
                        parentItem: parentItem?.name || null,
                        beforeChosen,
                        skipped,
                        keys: [...group.keys],
                        missingActorKeys,
                        lookupVia: target.via
                    });
                }
                continue;
            }

            if (hasActorUpdate) {
                this._logTraitDebug('Trait 配置校准补写 Actor 熟练状态', {
                    advancementId: group.advancementId,
                    parentItem: parentItem?.name || null,
                    missingActorKeys,
                    actorUpdate,
                    beforeState: this._snapshotTraitState(this.actor)
                });
                await this.actor.update(actorUpdate, { isAdvancement: true });
                this._logTraitDebug('Trait 配置校准补写 Actor 完成', {
                    advancementId: group.advancementId,
                    afterState: this._snapshotTraitState(this.actor)
                });
            }

            let updateVia = null;
            if (needsChosenRewrite) {
                const nextValue = advancement.value?.toObject instanceof Function
                    ? advancement.value.toObject()
                    : foundry.utils.deepClone(advancement.value || {});
                nextValue.chosen = afterChosen;
                updateVia = await this._updateTraitAdvancementValue(parentItem, advancement, nextValue, group.advancementId);
            }
            repaired.push({
                advancementId: group.advancementId,
                parentItem: parentItem?.name || null,
                added,
                beforeChosen,
                afterChosen,
                missingActorKeys,
                actorUpdate,
                lookupVia: target.via,
                updateVia
            });
        }

        if (repaired.length > 0) {
            this._logTraitDebug('Trait 配置校准完成：按本次选择补齐 advancement chosen', repaired);
        } else if (debugGroups.length > 0) {
            this._logTraitDebug('Trait 配置校准结束：没有实际写回项', {
                level: normalizedInput.level,
                groups: debugGroups.map(group => ({
                    advancementId: group.advancementId,
                    stepType: group.stepType,
                    parentFeature: group.parentFeature || null,
                    parentSourceUuid: group.parentSourceUuid || null,
                    keys: [...group.keys]
                }))
            });
        }

        return repaired;
    }

    async repairTraitAdvancementGrantsFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const repaired = [];

        for (const parentItem of this.actor?.items || []) {
            if (!['class', 'subclass', 'race', 'background', 'feat'].includes(parentItem?.type)) continue;

            for (const entry of getAdvancementEntries(parentItem.system?.advancement)) {
                const advancementId = entry?._id || entry?.id;
                const advancement = this._getItemAdvancement(parentItem, advancementId) || entry;
                if (!advancement || advancement.type !== 'Trait') continue;
                if (!this._shouldRepairTraitGrantForInput(advancement, normalizedInput)) continue;

                const grants = this._asArray(advancement.configuration?.grants)
                    .map(grant => this._normalizeTraitKeyForAdvancement(grant, advancement))
                    .filter(Boolean);

                const beforeChosen = this._getAdvancementChosenKeys(advancement);
                const normalizedBeforeChosen = this._normalizeAdvancementChosenKeys(beforeChosen, advancement);
                if (!grants.length && !this._traitChosenNeedsRewrite(beforeChosen, normalizedBeforeChosen)) continue;

                const nextChosen = new Set(normalizedBeforeChosen);
                const added = [];

                for (const grant of grants) {
                    if (nextChosen.has(grant)) continue;
                    nextChosen.add(grant);
                    added.push(grant);
                }

                const afterChosen = Array.from(nextChosen);
                const mode = advancement.configuration?.mode || 'default';
                const missingActorKeys = grants.filter(key => !this._actorHasTraitKey(this.actor, key, mode));
                const actorUpdate = this.actor?.update instanceof Function
                    ? this._buildTraitActorUpdates(missingActorKeys, mode)
                    : {};
                const hasActorUpdate = Object.keys(actorUpdate).length > 0;
                const needsChosenRewrite = added.length || this._traitChosenNeedsRewrite(beforeChosen, afterChosen);

                if (!needsChosenRewrite && !hasActorUpdate) continue;

                if (hasActorUpdate) {
                    await this.actor.update(actorUpdate, { isAdvancement: true });
                }

                let updateVia = null;
                if (needsChosenRewrite) {
                    const nextValue = advancement.value?.toObject instanceof Function
                        ? advancement.value.toObject()
                        : foundry.utils.deepClone(advancement.value || {});
                    nextValue.chosen = afterChosen;
                    updateVia = await this._updateTraitAdvancementValue(parentItem, advancement, nextValue, advancementId);
                }

                repaired.push({
                    advancementId,
                    parentItem: parentItem.name || null,
                    added,
                    beforeChosen,
                    afterChosen,
                    missingActorKeys,
                    actorUpdate,
                    updateVia
                });
            }
        }

        if (repaired.length > 0) {
            this._logTraitDebug('Trait 固定 grants 配置校准完成', repaired);
        }

        return repaired;
    }

    _readAdvancementBackfillLevel(candidate) {
        if (candidate === null || candidate === undefined) return null;
        if (typeof candidate === 'string' && candidate.trim() === '') return null;

        const level = Number(candidate);
        return Number.isFinite(level) ? level : null;
    }

    _getItemChoiceBackfillLevels(advancement) {
        const levels = new Set();
        const directLevel = this._readAdvancementBackfillLevel(advancement?.level);
        if (directLevel !== null) levels.add(directLevel);

        const rawChoices = advancement?.configuration?.choices;
        const choiceLevelKeys =
            rawChoices instanceof Map
                ? Array.from(rawChoices.keys())
                : (typeof rawChoices?.keys === 'function' && !Array.isArray(rawChoices)
                    ? Array.from(rawChoices.keys())
                    : Object.keys(rawChoices || {}));

        for (const key of choiceLevelKeys) {
            const level = this._readAdvancementBackfillLevel(key);
            if (level !== null) levels.add(level);
        }

        return Array.from(levels).sort((left, right) => left - right);
    }

    _resolveItemChoiceBackfillLevel(advancement, acquiredAt) {
        const directLevel = this._readAdvancementBackfillLevel(advancement?.level);
        if (directLevel !== null) return directLevel;

        const choiceLevels = this._getItemChoiceBackfillLevels(advancement);
        if (choiceLevels.length === 1) return choiceLevels[0];

        const fallbackLevel = this._readAdvancementBackfillLevel(acquiredAt);
        if (fallbackLevel !== null) return fallbackLevel;

        return null;
    }

    _collectItemAdvancementRepairEntries(normalizedInput = {}) {
        const entries = [];
        const collect = (entry, kind = 'pendingItems') => {
            const itemData = kind === 'pendingReplacements'
                ? entry?.newItemData
                : entry?.itemData;
            if (!itemData) return;

            const sourceUuid = this._normalizeResolutionSourceUuid(itemData);
            if (!sourceUuid) return;

            const explicitLevel = entry.level ?? itemData.flags?.['hero-genesis']?.acquiredAt ?? null;
            const levelSource = entry.level != null
                ? 'entry'
                : (itemData.flags?.['hero-genesis']?.acquiredAt != null ? 'item' : 'input');

            entries.push({
                kind,
                itemData,
                sourceUuid,
                rawSourceUuid: resolveItemSourceUuid(itemData) || itemData?._sourceUuid || itemData?.uuid || sourceUuid,
                advancementId: entry.advancementId || itemData.flags?.['hero-genesis']?.advancementOrigin || null,
                level: explicitLevel ?? normalizedInput.level,
                levelSource,
                stepType: entry.stepType || itemData.flags?.['hero-genesis']?.stepType || 'class',
                parentFeature: entry.parentFeature || itemData.flags?.['hero-genesis']?.parentFeature || null,
                parentSourceUuid: entry.parentSourceUuid || itemData.flags?.['hero-genesis']?.parentSourceUuid || null,
                sourceClass: entry.sourceClass || itemData.system?.sourceClass || normalizedInput.context?.classIdentifier || null,
                itemName: itemData.name || null,
                itemType: itemData.type || null
            });
        };

        for (const entry of normalizedInput.itemChanges?.pendingItems || []) collect(entry, 'pendingItems');
        for (const entry of normalizedInput.itemChanges?.pendingReplacements || []) collect(entry, 'pendingReplacements');
        for (const entry of normalizedInput.manualItems || []) collect(entry, 'manualItems');

        return entries;
    }

    _collectAdvancementOriginRepairEntries(normalizedInput = {}) {
        const entries = this._collectItemAdvancementRepairEntries(normalizedInput);

        for (const feat of normalizedInput.selectedFeats || []) {
            const sourceUuid = this._normalizeResolutionSourceUuid({ uuid: feat.uuid });
            if (!sourceUuid || !feat.advancementId) continue;

            entries.push({
                kind: 'selectedFeats',
                itemData: null,
                sourceUuid,
                rawSourceUuid: feat.uuid,
                advancementId: feat.advancementId,
                level: feat.level ?? normalizedInput.level,
                levelSource: feat.level != null ? 'entry' : 'input',
                stepType: feat.stepType || 'class',
                parentFeature: feat.parentFeature || null,
                parentSourceUuid: feat.parentSourceUuid || null,
                sourceClass: normalizedInput.context?.classIdentifier || null,
                itemName: feat.name || null,
                itemType: 'feat'
            });
        }

        return entries;
    }

    _getItemAdvancementRepairGroup(groupMap, entry, advancementId = entry.advancementId) {
        if (!advancementId) return null;

        const groupKey = [
            entry.stepType || 'class',
            advancementId,
            entry.level ?? '',
            entry.parentFeature || '',
            entry.parentSourceUuid || ''
        ].join('::');

        let group = groupMap.get(groupKey);
        if (!group) {
            group = {
                advancementId,
                level: entry.level,
                stepType: entry.stepType || 'class',
                parentFeature: entry.parentFeature || null,
                parentSourceUuid: entry.parentSourceUuid || null,
                entries: []
            };
            groupMap.set(groupKey, group);
        }

        group.entries.push(entry);
        return group;
    }

    _getActorItemAdvancementOrigin(item) {
        return item?.flags?.['hero-genesis']?.advancementOrigin
            || item?.flags?.dnd5e?.advancementOrigin?.split('.')?.pop()
            || null;
    }

    _getActorItemAcquiredAt(item) {
        const level = Number(item?.flags?.['hero-genesis']?.acquiredAt);
        return Number.isFinite(level) ? level : null;
    }

    _pickBestRepairActorItem(candidates = [], { advancementId = null, level = null } = {}) {
        if (!candidates.length) return null;

        const expectedLevel = Number(level);
        const hasExpectedLevel = Number.isFinite(expectedLevel);
        const exact = candidates.find(item => {
            const originMatches = advancementId
                ? this._getActorItemAdvancementOrigin(item) === advancementId
                : true;
            const levelMatches = hasExpectedLevel
                ? this._getActorItemAcquiredAt(item) === expectedLevel
                : true;
            return originMatches && levelMatches;
        });
        if (exact) return exact;

        if (advancementId) {
            const sameOrigin = candidates.find(item => this._getActorItemAdvancementOrigin(item) === advancementId);
            if (sameOrigin) return sameOrigin;
        }

        if (hasExpectedLevel) {
            const sameLevel = candidates.find(item => this._getActorItemAcquiredAt(item) === expectedLevel);
            if (sameLevel) return sameLevel;
        }

        return candidates[0] || null;
    }

    _findActorItemForRepairEntry(entry, advancementId = null) {
        const normalizedEntryName = entry.itemName?.trim?.().toLowerCase?.() || null;

        const candidates = (this.actor?.items || []).filter(item => {
            if (!item) return false;
            if (entry.itemType && item.type !== entry.itemType) return false;

            const itemSourceUuid = this._normalizeResolutionSourceUuid(item);
            const sourceMatches = this._sameSourceUuid(itemSourceUuid, entry.sourceUuid);

            const origin = this._getActorItemAdvancementOrigin(item);
            if (advancementId && sourceMatches && origin === advancementId) return true;

            const normalizedItemName = item.name?.trim?.().toLowerCase?.() || null;
            return sourceMatches || (!!normalizedEntryName && normalizedItemName === normalizedEntryName);
        });

        return this._pickBestRepairActorItem(candidates, {
            advancementId,
            level: entry.level
        });
    }

    _queueAdvancementOriginRepair(updateMap, actorItem, {
        originString,
        rootString,
        entry,
        parentItem
    } = {}) {
        const itemId = actorItem?.id || actorItem?._id;
        if (!itemId || !originString) return null;

        const existingUpdate = updateMap.get(itemId);
        if (existingUpdate && existingUpdate.originString !== originString) {
            return {
                skipped: true,
                reason: 'conflicting-origin',
                itemId,
                itemName: actorItem.name || null,
                existingOrigin: existingUpdate.originString,
                requestedOrigin: originString,
                advancementId: entry?.advancementId || null
            };
        }
        if (existingUpdate) return null;

        const currentOrigin = actorItem.flags?.dnd5e?.advancementOrigin || null;
        const currentRoot = actorItem.flags?.dnd5e?.advancementRoot || null;
        const nextRoot = rootString || originString;
        const update = existingUpdate?.update || { _id: itemId };

        if (currentOrigin !== originString) {
            update['flags.dnd5e.advancementOrigin'] = originString;
        }
        if (currentRoot !== nextRoot) {
            update['flags.dnd5e.advancementRoot'] = nextRoot;
        }
        if (Object.keys(update).length <= 1) return null;

        const repaired = existingUpdate?.repaired || {
            itemId,
            itemName: actorItem.name || null,
            itemType: actorItem.type || null,
            sourceUuid: resolveItemSourceUuid(actorItem) || entry?.rawSourceUuid || entry?.sourceUuid || null,
            advancementId: entry?.advancementId || null,
            parentItem: parentItem?.name || null,
            parentItemId: parentItem?.id || parentItem?._id || null,
            before: {
                advancementOrigin: currentOrigin,
                advancementRoot: currentRoot
            },
            after: {
                advancementOrigin: originString,
                advancementRoot: nextRoot
            }
        };

        updateMap.set(itemId, {
            update,
            repaired,
            originString
        });

        return { repaired };
    }

    async repairAdvancementOriginsFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const repairEntries = this._collectAdvancementOriginRepairEntries(normalizedInput);
        const updateMap = new Map();
        const repaired = [];
        const skipped = [];

        for (const entry of repairEntries) {
            if (!entry.advancementId || this._isManualOnlyAdvancementId(entry.advancementId)) continue;

            const parentItem = this._findResolutionParentItem(entry.stepType, {
                context: normalizedInput.context,
                parentFeature: entry.parentFeature,
                parentSourceUuid: entry.parentSourceUuid
            });
            const advancement = this._getItemAdvancement(parentItem, entry.advancementId);
            if (!parentItem?.id || !advancement) {
                skipped.push({
                    reason: 'missing-parent-advancement',
                    advancementId: entry.advancementId,
                    itemName: entry.itemName || null,
                    sourceUuid: entry.rawSourceUuid || entry.sourceUuid || null
                });
                continue;
            }

            const actorItem = this._findActorItemForRepairEntry(entry, entry.advancementId);
            if (!actorItem) {
                skipped.push({
                    reason: 'missing-actor-item',
                    advancementId: entry.advancementId,
                    itemName: entry.itemName || null,
                    sourceUuid: entry.rawSourceUuid || entry.sourceUuid || null
                });
                continue;
            }

            const originString = `${parentItem.id}.${entry.advancementId}`;
            const rootString = parentItem.flags?.dnd5e?.advancementRoot || originString;
            const queued = this._queueAdvancementOriginRepair(updateMap, actorItem, {
                originString,
                rootString,
                entry,
                parentItem
            });

            if (queued?.repaired) repaired.push(queued.repaired);
            if (queued?.skipped) skipped.push(queued);
        }

        const updates = Array.from(updateMap.values()).map(entry => entry.update);
        if (updates.length > 0) {
            if (this.actor?.updateEmbeddedDocuments instanceof Function) {
                await this.actor.updateEmbeddedDocuments('Item', updates);
            } else {
                for (const update of updates) {
                    const item = this.actor?.items?.get?.(update._id);
                    if (item?.update instanceof Function) {
                        const { _id, ...itemUpdate } = update;
                        await item.update(itemUpdate);
                    }
                }
            }

            this._logTraitDebug('Advancement origin 配置校准完成：按本次输入补齐 dnd5e origin', repaired);
        }

        return { origins: repaired, skipped };
    }

    _collectItemGrantRepairItems(group, advancement) {
        const seen = new Set();
        const items = [];
        const pushItem = (item, sourceUuid) => {
            const itemId = item?.id || item?._id;
            sourceUuid = resolveAdvancementItemSourceUuid(item, [advancement.value?.added?.[itemId], sourceUuid]);
            if (!itemId || seen.has(itemId) || !sourceUuid) return;
            seen.add(itemId);
            items.push({ item, itemId, sourceUuid });
        };

        for (const entry of group.entries || []) {
            const item = this._findActorItemForRepairEntry(entry, group.advancementId);
            if (item) pushItem(item, resolveAdvancementItemSourceUuid(item, [entry.rawSourceUuid, entry.sourceUuid]));
        }

        const configUuids = this._asArray(advancement?.configuration?.items)
            .map(item => this._normalizeResolutionSourceUuid({ uuid: item?.uuid }))
            .filter(Boolean);
        if (!configUuids.length) return items;

        for (const actorItem of this.actor?.items || []) {
            const origin = this._getActorItemAdvancementOrigin(actorItem);
            if (origin !== group.advancementId) continue;

            const actorSourceUuid = resolveItemSourceUuid(actorItem);
            const normalizedActorSourceUuid = this._normalizeResolutionSourceUuid(actorItem);
            if (!normalizedActorSourceUuid) continue;
            if (!configUuids.some(configUuid => this._sameSourceUuid(configUuid, normalizedActorSourceUuid))) continue;

            pushItem(actorItem, actorSourceUuid || normalizedActorSourceUuid);
        }

        return items;
    }

    _isSpellItemChoiceAdvancement(advancement) {
        if (advancement?.type !== 'ItemChoice') return false;
        const restrictionType = advancement?.configuration?.restriction?.type;
        return advancement?.configuration?.type === 'spell' || restrictionType === 'spell';
    }

    _itemChoiceAcceptsSpellRuleEntry(parentItem, advancement, entry) {
        if (!this._isSpellItemChoiceAdvancement(advancement)) return false;
        if (parentItem?.type !== 'class' || entry.itemType !== 'spell') return false;
        if (!entry.advancementId?.startsWith?.('spell-rules-')) return false;

        const classIdentifier = parentItem.system?.identifier?.toLowerCase?.() || null;
        const sourceClass = entry.sourceClass?.toLowerCase?.() || null;
        const originMatchesClass = classIdentifier ? entry.advancementId.includes(`-${classIdentifier}-`) : true;
        if (classIdentifier && sourceClass && sourceClass !== classIdentifier && !originMatchesClass) return false;
        if (classIdentifier && !sourceClass && !originMatchesClass) return false;

        const choiceLevels = new Set(this._getItemChoiceBackfillLevels(advancement));
        if (choiceLevels.size && !choiceLevels.has(Number(entry.level))) return false;

        const restrictionLevel = advancement?.configuration?.restriction?.level;
        const wantsCantrips = Number(restrictionLevel) === 0;
        const spellLevel = Number(entry.itemData?.system?.level ?? 0);
        return wantsCantrips ? spellLevel === 0 : spellLevel !== 0;
    }

    _addSpellRuleItemChoiceRepairGroups(groupMap, entries = []) {
        const spellRuleEntries = entries.filter(entry => entry.advancementId?.startsWith?.('spell-rules-'));
        if (!spellRuleEntries.length) return;

        for (const parentItem of this.actor?.items || []) {
            if (parentItem?.type !== 'class') continue;

            for (const entry of getAdvancementEntries(parentItem.system?.advancement)) {
                const advancementId = entry?._id || entry?.id;
                const advancement = this._getItemAdvancement(parentItem, advancementId) || entry;
                if (!this._isSpellItemChoiceAdvancement(advancement)) continue;

                for (const spellEntry of spellRuleEntries) {
                    if (!this._itemChoiceAcceptsSpellRuleEntry(parentItem, advancement, spellEntry)) continue;
                    this._getItemAdvancementRepairGroup(groupMap, {
                        ...spellEntry,
                        stepType: 'class',
                        parentFeature: null,
                        parentSourceUuid: null
                    }, advancementId);
                }
            }
        }
    }

    _collectItemChoiceRepairItems(group, advancement) {
        const seen = new Set();
        const items = [];

        for (const entry of group.entries || []) {
            const item = this._findActorItemForRepairEntry(entry, group.advancementId)
                || this._findActorItemForRepairEntry(entry, null);
            const itemId = item?.id || item?._id;
            if (!itemId || seen.has(itemId)) continue;

            const acquiredAt = item.flags?.['hero-genesis']?.acquiredAt
                ?? (entry.levelSource === 'input' ? null : entry.level);
            const level = this._resolveItemChoiceBackfillLevel(advancement, acquiredAt);
            if (level === null) continue;
            const sourceUuid = resolveAdvancementItemSourceUuid(item, [
                advancement.value?.added?.[level]?.[itemId], entry.rawSourceUuid, entry.sourceUuid
            ]);
            if (!sourceUuid) continue;
            seen.add(itemId);

            items.push({
                item,
                itemId,
                sourceUuid,
                level
            });
        }

        return items;
    }

    async _updateItemAdvancementValue(parentItem, advancement, nextValue, advancementId) {
        const serializedItem = parentItem?.toObject instanceof Function
            ? parentItem.toObject()
            : parentItem;
        const advancementSource = hasAdvancementEntries(serializedItem?.system?.advancement)
            ? serializedItem.system.advancement
            : parentItem?.system?.advancement;

        if (hasAdvancementEntries(advancementSource) && parentItem?.update instanceof Function) {
            const entries = foundry.utils.deepClone(getAdvancementEntries(advancementSource));
            const target = entries.find(entry => (entry?._id || entry?.id) === advancementId);
            if (target) {
                target.value = nextValue;
                await parentItem.update({
                    'system.advancement': setAdvancementSource(advancementSource, entries)
                });
                if (advancement && typeof advancement === 'object') {
                    advancement.value = nextValue;
                }
                return 'item';
            }
        }

        if (advancement?.update instanceof Function) {
            await advancement.update({ value: nextValue });
            if (advancement && typeof advancement === 'object') {
                advancement.value = nextValue;
            }
            return 'advancement';
        }

        if (parentItem?.update instanceof Function) {
            await parentItem.update({
                [`system.advancement.${advancementId}.value`]: nextValue
            });
            if (advancement && typeof advancement === 'object') {
                advancement.value = nextValue;
            }
            return 'item-path';
        }

        throw new Error(`无法写回 Item advancement value: ${advancementId || 'unknown'}`);
    }

    async repairItemAdvancementsFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const repairEntries = this._collectItemAdvancementRepairEntries(normalizedInput);
        const groupMap = new Map();

        for (const entry of repairEntries) {
            if (!entry.advancementId || this._isManualOnlyAdvancementId(entry.advancementId)) continue;
            this._getItemAdvancementRepairGroup(groupMap, entry);
        }
        this._addSpellRuleItemChoiceRepairGroups(groupMap, repairEntries);

        const repaired = [];
        for (const group of groupMap.values()) {
            const parentItem = this._findResolutionParentItem(group.stepType, {
                context: normalizedInput.context,
                parentFeature: group.parentFeature,
                parentSourceUuid: group.parentSourceUuid
            });
            const advancement = this._getItemAdvancement(parentItem, group.advancementId);
            if (!advancement || !['ItemGrant', 'ItemChoice'].includes(advancement.type)) continue;

            const nextValue = advancement.value?.toObject instanceof Function
                ? advancement.value.toObject()
                : foundry.utils.deepClone(advancement.value || {});
            const addedItems = advancement.type === 'ItemGrant'
                ? this._collectItemGrantRepairItems(group, advancement)
                : this._collectItemChoiceRepairItems(group, advancement);

            let changed = false;
            if (advancement.type === 'ItemGrant') {
                if (!nextValue.added || typeof nextValue.added !== 'object') nextValue.added = {};
                for (const item of addedItems) {
                    if (nextValue.added[item.itemId] === item.sourceUuid) continue;
                    nextValue.added[item.itemId] = item.sourceUuid;
                    changed = true;
                }
            } else {
                if (!nextValue.added || typeof nextValue.added !== 'object') nextValue.added = {};
                if (!nextValue.replaced || typeof nextValue.replaced !== 'object') nextValue.replaced = {};
                for (const item of addedItems) {
                    const level = item.level ?? group.level ?? normalizedInput.level ?? 1;
                    if (!nextValue.added[level]) nextValue.added[level] = {};
                    if (nextValue.added[level][item.itemId] === item.sourceUuid) continue;
                    nextValue.added[level][item.itemId] = item.sourceUuid;
                    changed = true;
                }
            }

            if (!changed) continue;

            const updateVia = await this._updateItemAdvancementValue(parentItem, advancement, nextValue, group.advancementId);
            repaired.push({
                advancementId: group.advancementId,
                advancementType: advancement.type,
                parentItem: parentItem?.name || null,
                added: addedItems.map(item => ({
                    itemId: item.itemId,
                    sourceUuid: item.sourceUuid,
                    level: item.level ?? group.level ?? normalizedInput.level ?? null
                })),
                updateVia
            });
        }

        if (repaired.length > 0) {
            this._logTraitDebug('Item advancement 配置校准完成：按本次输入补齐 value.added', repaired);
        }

        return repaired;
    }

    _cleanAbilityAssignments(assignments = {}) {
        const clean = {};
        for (const [ability, value] of Object.entries(assignments || {})) {
            const bonus = Number(value);
            if (!ability || !Number.isFinite(bonus) || bonus <= 0) continue;
            clean[ability] = (clean[ability] || 0) + bonus;
        }
        return clean;
    }

    _getAbilityScoreImprovementGroup(groupMap, entry, kind = 'asi') {
        const advancementId = entry?.advancementId;
        if (!advancementId || this._isManualOnlyAdvancementId(advancementId)) return null;

        const groupKey = [
            kind,
            advancementId,
            entry.level ?? null,
            entry.stepType || 'class',
            entry.parentFeature || '',
            entry.parentSourceUuid || ''
        ].join('|');

        let group = groupMap.get(groupKey);
        if (!group) {
            group = {
                kind,
                advancementId,
                level: entry.level ?? null,
                stepType: entry.stepType || 'class',
                parentFeature: entry.parentFeature || null,
                parentSourceUuid: entry.parentSourceUuid || null,
                assignments: {},
                selectedFeats: []
            };
            groupMap.set(groupKey, group);
        }
        return group;
    }

    _collectAbilityScoreImprovementGroups(normalizedInput = {}) {
        const groupMap = new Map();

        for (const entry of normalizedInput.abilityScoreImprovements || []) {
            const assignments = this._cleanAbilityAssignments(entry.assignments);
            if (Object.keys(assignments).length === 0) continue;

            const group = this._getAbilityScoreImprovementGroup(groupMap, entry, 'asi');
            if (!group) continue;

            for (const [ability, bonus] of Object.entries(assignments)) {
                group.assignments[ability] = (group.assignments[ability] || 0) + bonus;
            }
        }

        for (const feat of normalizedInput.selectedFeats || []) {
            const group = this._getAbilityScoreImprovementGroup(groupMap, {
                advancementId: feat.advancementId,
                level: feat.level ?? normalizedInput.level,
                stepType: feat.stepType || 'class',
                parentFeature: feat.parentFeature || null,
                parentSourceUuid: feat.parentSourceUuid || null
            }, 'feat');
            if (!group) continue;

            group.selectedFeats.push({
                uuid: feat.uuid,
                name: feat.name || null,
                advancementId: feat.advancementId || null,
                level: feat.level ?? normalizedInput.level
            });
        }

        return Array.from(groupMap.values());
    }

    _findSelectedFeatActorItem(feat = {}) {
        const sourceUuid = this._normalizeResolutionSourceUuid({ uuid: feat.uuid });
        const normalizedName = feat.name?.trim?.().toLowerCase?.() || null;
        const candidates = (this.actor?.items || []).filter(item => {
            if (item?.type !== 'feat') return false;

            const itemSourceUuid = this._normalizeResolutionSourceUuid(item);
            if (sourceUuid && this._sameSourceUuid(itemSourceUuid, sourceUuid)) return true;

            const itemName = item.name?.trim?.().toLowerCase?.() || null;
            return !!normalizedName && itemName === normalizedName;
        });

        return this._pickBestRepairActorItem(candidates, {
            advancementId: feat.advancementId || null,
            level: feat.level ?? null
        });
    }

    async repairAbilityScoreImprovementsFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const groups = this._collectAbilityScoreImprovementGroups(normalizedInput);
        const repairedAsi = [];
        const repairedFeats = [];

        for (const group of groups) {
            const parentItem = this._findResolutionParentItem(group.stepType, {
                context: normalizedInput.context,
                parentFeature: group.parentFeature,
                parentSourceUuid: group.parentSourceUuid
            });
            const advancement = this._getItemAdvancement(parentItem, group.advancementId);
            if (!advancement || advancement.type !== 'AbilityScoreImprovement') continue;

            if (group.kind === 'asi') {
                const assignments = this._cleanAbilityAssignments(group.assignments);
                if (Object.keys(assignments).length === 0) continue;

                const nextValue = {
                    type: 'asi',
                    assignments
                };
                const updateVia = await this._updateItemAdvancementValue(parentItem, advancement, nextValue, group.advancementId);
                repairedAsi.push({
                    advancementId: group.advancementId,
                    parentItem: parentItem?.name || null,
                    assignments,
                    updateVia
                });
                continue;
            }

            const featValue = {};
            for (const feat of group.selectedFeats) {
                const actorItem = this._findSelectedFeatActorItem(feat);
                const actorItemId = actorItem?.id || actorItem?._id;
                const sourceUuid = feat.uuid || this._readActorItemSourceUuid(actorItem);
                if (!actorItemId || !sourceUuid) continue;
                featValue[actorItemId] = sourceUuid;
            }
            if (Object.keys(featValue).length === 0) continue;

            const nextValue = {
                type: 'feat',
                feat: featValue
            };
            const updateVia = await this._updateItemAdvancementValue(parentItem, advancement, nextValue, group.advancementId);
            repairedFeats.push({
                advancementId: group.advancementId,
                parentItem: parentItem?.name || null,
                feat: featValue,
                updateVia
            });
        }

        return {
            abilityScoreImprovements: repairedAsi,
            selectedFeats: repairedFeats
        };
    }

    async applyAbilityScoreImprovementsFromInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const actorUpdate = {};

        for (const [ability, value] of Object.entries(normalizedInput.asiChanges || {})) {
            const bonus = Number(value);
            if (!ability || !Number.isFinite(bonus) || bonus <= 0) continue;

            const currentRaw = foundry.utils.getProperty(this.actor, `system.abilities.${ability}.value`);
            const currentValue = Number.isFinite(Number(currentRaw)) ? Number(currentRaw) : 10;
            actorUpdate[`system.abilities.${ability}.value`] = currentValue + bonus;
        }

        if (Object.keys(actorUpdate).length > 0) {
            await this.actor.update(actorUpdate);
        }

        const repairs = await this.repairAbilityScoreImprovementsFromInput(normalizedInput);
        return {
            actorUpdate,
            ...repairs
        };
    }

    async repairLevelAdvancementsFromInput(levelInput = {}) {
        const itemAdvancements = await this.repairItemAdvancementsFromInput(levelInput);
        const traitAdvancements = await this.repairTraitAdvancementChoicesFromInput(levelInput);

        return {
            itemAdvancements,
            traitAdvancements
        };
    }

    _canDeferSubclassParentLookup(entry = {}, nativeSubclassSelection = null) {
        if (!nativeSubclassSelection) return false;
        if (entry?.parentFeature || entry?.parentSourceUuid) return false;
        return (entry.stepType || entry.source) === 'subclass';
    }

    _addNativeItemGroup(groupMap, entry, kind = 'pendingItems') {
        const groupKey = [
            kind,
            entry.stepType || 'class',
            entry.advancementId || '',
            entry.level ?? '',
            entry.parentFeature || '',
            entry.parentSourceUuid || '',
            kind === 'pendingReplacements' ? entry.oldItemId || '' : ''
        ].join('::');

        let group = groupMap.get(groupKey);
        if (!group) {
            group = {
                kind,
                advancementId: entry.advancementId,
                level: entry.level,
                stepType: entry.stepType || 'class',
                parentFeature: entry.parentFeature || null,
                parentSourceUuid: entry.parentSourceUuid || null,
                sourceUuids: [],
                entries: []
            };
            groupMap.set(groupKey, group);
        }

        const sourceUuid = kind === 'pendingReplacements'
            ? this._normalizeResolutionSourceUuid(entry.newItemData)
            : this._normalizeResolutionSourceUuid(entry.itemData);

        if (sourceUuid && !group.sourceUuids.includes(sourceUuid)) {
            group.sourceUuids.push(sourceUuid);
        }

        group.entries.push(foundry.utils.deepClone(entry));
        return group;
    }

    _getNativeItemGroupApplyPriority(clone, group, context = {}) {
        const parentItem = this._findResolutionParentItem(group.stepType, {
            actor: clone,
            context,
            parentFeature: group.parentFeature,
            parentSourceUuid: group.parentSourceUuid
        });
        const advancement = this._getNativeAdvancement(parentItem, group.advancementId);

        if (advancement?.type === 'ItemGrant') return 0;
        if (advancement?.type === 'ItemChoice') return 1;
        return 2;
    }

    _sortNativeItemGroupsForApply(clone, groups = [], context = {}) {
        return groups
            .map((group, index) => ({
                group,
                index,
                priority: this._getNativeItemGroupApplyPriority(clone, group, context)
            }))
            .sort((left, right) => (left.priority - right.priority) || (left.index - right.index))
            .map(entry => entry.group);
    }

    _addNormalizedSourceUuid(list, sourceUuid) {
        const normalizedSourceUuid = this._normalizeResolutionSourceUuid({ uuid: sourceUuid });
        if (!normalizedSourceUuid) return;
        if (list.some(existing => this._sameSourceUuid(existing, normalizedSourceUuid))) return;
        list.push(normalizedSourceUuid);
    }

    _buildNativeItemGrantSelection(advancement, sourceUuids = []) {
        const selected = [];
        for (const sourceUuid of sourceUuids || []) {
            this._addNormalizedSourceUuid(selected, sourceUuid);
        }

        if (advancement?.type !== 'ItemGrant' || advancement.configuration?.optional) return selected;

        for (const configItem of this._asArray(advancement.configuration?.items)) {
            if (!configItem?.uuid || configItem.optional) continue;
            this._addNormalizedSourceUuid(selected, configItem.uuid);
        }

        return selected;
    }

    _addNativeTraitGroup(groupMap, change) {
        const groupKey = [
            change.stepType || change.source || 'class',
            change.advancementId || '',
            change.level ?? '',
            change.parentFeature || '',
            change.parentSourceUuid || ''
        ].join('::');

        let group = groupMap.get(groupKey);
        if (!group) {
            group = {
                advancementId: change.advancementId,
                level: change.level,
                stepType: change.stepType || change.source || 'class',
                parentFeature: change.parentFeature || null,
                parentSourceUuid: change.parentSourceUuid || null,
                keys: [],
                entries: []
            };
            groupMap.set(groupKey, group);
        }

        if (change.key && !group.keys.includes(change.key)) {
            group.keys.push(change.key);
        }

        group.entries.push(foundry.utils.deepClone(change));
        return group;
    }

    _getPlannedSpellKeys(itemData = {}) {
        if (itemData?.type !== 'spell') return null;
        return {
            sourceUuid: this._normalizeResolutionSourceUuid(itemData),
            nameKey: itemData.name?.trim?.().toLowerCase?.() || null
        };
    }

    _isPlannedNativeSpellDuplicate(itemData = {}, plannedSpells = { sourceUuids: new Set(), names: new Set() }) {
        const keys = this._getPlannedSpellKeys(itemData);
        if (!keys) return false;
        return (!!keys.sourceUuid && plannedSpells.sourceUuids.has(keys.sourceUuid))
            || (!!keys.nameKey && plannedSpells.names.has(keys.nameKey));
    }

    _markPlannedNativeSpell(itemData = {}, plannedSpells = { sourceUuids: new Set(), names: new Set() }) {
        const keys = this._getPlannedSpellKeys(itemData);
        if (!keys) return;
        if (keys.sourceUuid) plannedSpells.sourceUuids.add(keys.sourceUuid);
        if (keys.nameKey) plannedSpells.names.add(keys.nameKey);
    }

    _buildNativeResolutionPlan(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const manualInput = normalizedInput.scope === 'character-finalize'
            ? this._createManualResolutionInput(normalizedInput)
            : this.createLevelResolutionInput(normalizedInput);
        const nativeItemGroups = new Map();
        const nativeTraitGroups = new Map();
        const plannedNativeSpells = { sourceUuids: new Set(), names: new Set() };
        let nativeSubclassSelection = null;

        manualInput.itemChanges.pendingItems = [];
        manualInput.itemChanges.pendingReplacements = [];
        manualInput.traitChanges = [];

        for (const pending of normalizedInput.itemChanges?.pendingItems || []) {
            const sourceUuid = this._normalizeResolutionSourceUuid(pending.itemData);

            if (pending?.itemData?.type === 'subclass' && pending.isSubclass && sourceUuid) {
                // Нативному SubclassAdvancement нужен реальный UUID для fromUuid(), а не
                // сокращённый ключ, который Character Forge использует только для сравнений.
                const nativeSourceUuid = resolveItemSourceUuid(pending.itemData)
                    || pending.itemData?._sourceUuid
                    || pending.itemData?.uuid
                    || sourceUuid;
                nativeSubclassSelection = {
                    level: pending.level ?? normalizedInput.level,
                    stepType: pending.stepType || 'class',
                    sourceUuid: nativeSourceUuid,
                    entry: foundry.utils.deepClone(pending)
                };
                continue;
            }

            const isSpellDuplicate = pending?.itemData?.type === 'spell'
                && (this._findMatchingActorSpell(pending.itemData)
                    || this._isPlannedNativeSpellDuplicate(pending.itemData, plannedNativeSpells));
            if (!sourceUuid || isSpellDuplicate || this._isManualOnlyAdvancementId(pending.advancementId)) {
                manualInput.itemChanges.pendingItems.push(foundry.utils.deepClone(pending));
                continue;
            }

            const canDeferParentLookup = this._canDeferSubclassParentLookup(pending, nativeSubclassSelection);
            const hasParentHint = !!pending.parentFeature || !!pending.parentSourceUuid;
            if (!hasParentHint && !canDeferParentLookup) {
                const parentItem = this._findResolutionParentItem(pending.stepType, {
                    context: normalizedInput.context,
                    parentFeature: pending.parentFeature,
                    parentSourceUuid: pending.parentSourceUuid
                });
                if (!this._getNativeAdvancement(parentItem, pending.advancementId)) {
                    manualInput.itemChanges.pendingItems.push(foundry.utils.deepClone(pending));
                    continue;
                }
            }

            if (canDeferParentLookup) {
                this._logTraitDebug('子职根节点物品先进入原生计划，等 clone 上的子职挂好后再解析父节点', {
                    advancementId: pending.advancementId,
                    stepType: pending.stepType || 'subclass',
                    itemName: pending.itemData?.name || null,
                    parentSourceUuid: pending.parentSourceUuid || null,
                    level: pending.level
                });
            }

            this._addNativeItemGroup(nativeItemGroups, pending, 'pendingItems');
            this._markPlannedNativeSpell(pending.itemData, plannedNativeSpells);
        }

        for (const replacement of normalizedInput.itemChanges?.pendingReplacements || []) {
            const sourceUuid = this._normalizeResolutionSourceUuid(replacement.newItemData);
            const isSpellDuplicate = replacement?.newItemData?.type === 'spell'
                && (this._findMatchingActorSpell(replacement.newItemData)
                    || this._isPlannedNativeSpellDuplicate(replacement.newItemData, plannedNativeSpells));
            if (!sourceUuid || isSpellDuplicate || this._isManualOnlyAdvancementId(replacement.advancementId)) {
                manualInput.itemChanges.pendingReplacements.push(foundry.utils.deepClone(replacement));
                continue;
            }

            const canDeferParentLookup = this._canDeferSubclassParentLookup(replacement, nativeSubclassSelection);
            const hasParentHint = !!replacement.parentFeature || !!replacement.parentSourceUuid;
            if (!hasParentHint && !canDeferParentLookup) {
                const parentItem = this._findResolutionParentItem(replacement.stepType, {
                    context: normalizedInput.context,
                    parentFeature: replacement.parentFeature,
                    parentSourceUuid: replacement.parentSourceUuid
                });
                if (!this._getNativeAdvancement(parentItem, replacement.advancementId)) {
                    manualInput.itemChanges.pendingReplacements.push(foundry.utils.deepClone(replacement));
                    continue;
                }
            }

            if (canDeferParentLookup) {
                this._logTraitDebug('子职根节点替换先进入原生计划，等 clone 上的子职挂好后再解析父节点', {
                    advancementId: replacement.advancementId,
                    stepType: replacement.stepType || 'subclass',
                    oldItemId: replacement.oldItemId || null,
                    newItemName: replacement.newItemData?.name || null,
                    parentSourceUuid: replacement.parentSourceUuid || null,
                    level: replacement.level
                });
            }

            this._addNativeItemGroup(nativeItemGroups, replacement, 'pendingReplacements');
            this._markPlannedNativeSpell(replacement.newItemData, plannedNativeSpells);
        }

        for (const change of normalizedInput.traitChanges || []) {
            if (this._isManualOnlyAdvancementId(change.advancementId)) {
                if (this._shouldDebugTraitKey(change.key)) {
                    this._logTraitDebug('Trait 继续留在手工链，因为它本来就是手工专用入口', {
                        key: change.key,
                        advancementId: change.advancementId,
                        stepType: change.stepType || change.source || 'class',
                        parentFeature: change.parentFeature || null,
                        level: change.level,
                        mode: change.mode || 'default'
                    });
                }
                manualInput.traitChanges.push(foundry.utils.deepClone(change));
                continue;
            }

            const canDeferParentLookup = this._canDeferSubclassParentLookup(change, nativeSubclassSelection);
            const hasParentHint = !!change.parentFeature || !!change.parentSourceUuid;
            if (!hasParentHint && !canDeferParentLookup) {
                const parentItem = this._findResolutionParentItem(change.stepType || change.source, {
                    context: normalizedInput.context,
                    parentFeature: change.parentFeature,
                    parentSourceUuid: change.parentSourceUuid
                });
                const advancement = this._getItemAdvancement(parentItem, change.advancementId);
                if (!advancement || advancement.type !== 'Trait') {
                    if (this._shouldDebugTraitKey(change.key)) {
                        this._logTraitDebug('Trait 暂时回退到手工链，因为当前父节点上还找不到原生 Trait advancement', {
                            key: change.key,
                            advancementId: change.advancementId,
                            stepType: change.stepType || change.source || 'class',
                            parentItem: parentItem?.name || null,
                            parentSourceUuid: change.parentSourceUuid || null,
                            level: change.level,
                            mode: change.mode || 'default'
                        });
                    }
                    manualInput.traitChanges.push(foundry.utils.deepClone(change));
                    continue;
                }
            }

            if (canDeferParentLookup && this._shouldDebugTraitKey(change.key)) {
                this._logTraitDebug('子职根节点 Trait 先进入原生计划，等 clone 上的子职挂好后再解析父节点', {
                    key: change.key,
                    advancementId: change.advancementId,
                    stepType: change.stepType || change.source || 'subclass',
                    parentSourceUuid: change.parentSourceUuid || null,
                    level: change.level,
                    mode: change.mode || 'default'
                });
            }

            const group = this._addNativeTraitGroup(nativeTraitGroups, change);
            if (this._shouldDebugTraitKey(change.key)) {
                this._logTraitDebug('Trait 已并入原生计划', {
                    key: change.key,
                    advancementId: change.advancementId,
                    stepType: change.stepType || change.source || 'class',
                    parentFeature: change.parentFeature || null,
                    parentSourceUuid: change.parentSourceUuid || null,
                    level: change.level,
                    mode: change.mode || 'default',
                    groupedKeys: [...group.keys]
                });
            }
        }

        return {
            nativeSubclassSelection,
            nativeItemGroups: Array.from(nativeItemGroups.values()),
            nativeTraitGroups: Array.from(nativeTraitGroups.values()),
            manualInput
        };
    }

    async _applyNativeSubclassSelection(clone, selection, context = {}) {
        const classItem = this._findResolutionParentItem('class', { actor: clone, context });
        const advancement = classItem?.advancement?.byType?.Subclass?.[0];
        if (!advancement || !selection?.sourceUuid) {
            this._logTraitDebug('原生子职选择没法执行', {
                classItem: classItem?.name || null,
                hasAdvancement: !!advancement,
                sourceUuid: selection?.sourceUuid || null,
                level: selection?.level ?? context.lockedLevel ?? this.currentLevel + 1
            });
            return false;
        }

        const itemData = selection.entry?.itemData || {};
        const rawCandidates = [
            selection.sourceUuid,
            resolveItemSourceUuid(itemData),
            itemData?._sourceUuid,
            itemData?.uuid,
            itemData?._stats?.compendiumSource,
            itemData?.flags?.originate?.sourceUuid,
            itemData?.flags?.['hero-genesis']?.sourceUuid
        ].filter(Boolean);

        const candidates = [];
        for (const candidate of rawCandidates) {
            if (!candidates.includes(candidate)) candidates.push(candidate);
            if (candidate.startsWith('Compendium.') && !candidate.includes('.Item.')) {
                const parts = candidate.split('.');
                if (parts.length >= 4) {
                    const canonical = [...parts.slice(0, -1), 'Item', parts.at(-1)].join('.');
                    if (!candidates.includes(canonical)) candidates.push(canonical);
                }
            }
        }

        let sourceUuid = null;
        for (const candidate of candidates) {
            try {
                const source = await fromUuid(candidate);
                if (source?.type === 'subclass') {
                    sourceUuid = source.uuid || candidate;
                    break;
                }
            } catch (error) {
                console.warn('Originate | [LevelUp] Не удалось разрешить UUID подкласса:', candidate, error);
            }
        }

        if (!sourceUuid) {
            console.warn('Originate | [LevelUp] Подкласс не найден по UUID; используем ручной fallback.', {
                classItem: classItem?.name || null,
                candidates,
                itemName: itemData?.name || null
            });
            return false;
        }

        this._logTraitDebug('开始执行原生子职选择', {
            classItem: classItem?.name || null,
            subclassUuid: sourceUuid,
            level: selection.level ?? context.lockedLevel ?? this.currentLevel + 1
        });

        try {
            await advancement.apply(selection.level ?? context.lockedLevel ?? this.currentLevel + 1, {
                uuid: sourceUuid
            });
        } catch (error) {
            // D&D5e 6.0.x обращается к itemData.flags до собственной null-проверки.
            // Не позволяем этой системной ошибке оборвать всё повышение.
            console.warn('Originate | [LevelUp] Нативное применение подкласса не удалось; используем ручной fallback.', {
                sourceUuid,
                itemName: itemData?.name || null,
                error
            });
            return false;
        }

        this._logTraitDebug('原生子职选择执行完成', {
            classItem: classItem?.name || null,
            subclassAdvancementId: advancement.id || advancement._id || null,
            subclassValue: advancement.value?.toObject instanceof Function ? advancement.value.toObject() : foundry.utils.deepClone(advancement.value || {}),
            cloneSubclassItems: clone.items
                .filter(item => item.type === 'subclass')
                .map(item => ({
                    id: item.id,
                    name: item.name,
                    classIdentifier: item.system?.classIdentifier || null
                }))
        });
        return true;
    }

    async _applyNativeItemGroup(clone, group, context = {}) {
        const parentItem = this._findResolutionParentItem(group.stepType, {
            actor: clone,
            context,
            parentFeature: group.parentFeature,
            parentSourceUuid: group.parentSourceUuid
        });
        const advancement = this._getNativeAdvancement(parentItem, group.advancementId);
        if (!advancement || !['ItemGrant', 'ItemChoice'].includes(advancement.type)) {
            this._logTraitDebug('原生物品组暂时没法执行', {
                advancementId: group.advancementId,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                parentItem: parentItem?.name || null,
                sourceUuids: [...group.sourceUuids]
            });
            return false;
        }

        const selectedSourceUuids = advancement.type === 'ItemGrant'
            ? this._buildNativeItemGrantSelection(advancement, group.sourceUuids)
            : group.sourceUuids;
        const applicationData = { selected: selectedSourceUuids };
        if (group.kind === 'pendingReplacements') {
            const replacement = group.entries[0];
            if (!replacement?.oldItemId || !selectedSourceUuids.length) return false;
            applicationData.replace = replacement.oldItemId;
        }

        this._logTraitDebug('开始执行原生物品组', {
            advancementId: group.advancementId,
            advancementType: advancement.type,
            stepType: group.stepType,
            parentFeature: group.parentFeature || null,
            parentSourceUuid: group.parentSourceUuid || null,
            parentItem: parentItem?.name || null,
            sourceUuids: [...selectedSourceUuids],
            originalSourceUuids: [...group.sourceUuids]
        });
        await advancement.apply(group.level ?? context.lockedLevel ?? this.currentLevel + 1, applicationData);
        this._logTraitDebug('原生物品组执行完成', {
            advancementId: group.advancementId,
            advancementType: advancement.type,
            parentItem: parentItem?.name || null,
            advancementValue: advancement.value?.toObject instanceof Function ? advancement.value.toObject() : foundry.utils.deepClone(advancement.value || {})
        });
        return true;
    }

    async _applyNativeTraitGroup(clone, group, context = {}) {
        const parentItem = this._findResolutionParentItem(group.stepType, {
            actor: clone,
            context,
            parentFeature: group.parentFeature,
            parentSourceUuid: group.parentSourceUuid
        });
        const advancement = this._getNativeAdvancement(parentItem, group.advancementId);
        if (!advancement || advancement.type !== 'Trait' || !group.keys.length) {
            if (group.keys.some(key => this._shouldDebugTraitKey(key))) {
                this._logTraitDebug('原生 Trait 组暂时没法执行，先留在待处理队列里', {
                    advancementId: group.advancementId,
                    stepType: group.stepType,
                    parentFeature: group.parentFeature || null,
                    parentSourceUuid: group.parentSourceUuid || null,
                    parentItem: parentItem?.name || null,
                    keys: [...group.keys]
                });
            }
            return false;
        }

        const shouldDebug = group.keys.some(key => this._shouldDebugTraitKey(key));
        const beforeState = shouldDebug ? this._snapshotTraitState(clone) : null;
        const beforeChosen = shouldDebug ? this._getAdvancementChosenKeys(advancement) : null;
        const requestedKeys = this._normalizeAdvancementChosenKeys(group.keys, advancement);

        await advancement.apply(group.level ?? context.lockedLevel ?? this.currentLevel + 1, {
            chosen: requestedKeys
        });

        const mode = advancement.configuration?.mode || 'default';
        const afterChosen = this._getAdvancementChosenKeys(advancement);
        const normalizedChosen = new Set(
            afterChosen
                .map(key => this._normalizeTraitKeyForAdvancement(key, advancement))
                .filter(Boolean)
        );
        const missingChosenKeys = requestedKeys.filter(key => {
            const normalizedKey = this._normalizeTraitKeyForAdvancement(key, advancement);
            return normalizedKey && !normalizedChosen.has(normalizedKey);
        });
        const missingActorKeys = requestedKeys.filter(key => !this._actorHasTraitKey(clone, key, mode));

        if (shouldDebug) {
            this._logTraitDebug('原生 Trait 已应用到 clone', {
                advancementId: group.advancementId,
                advancementTitle: getAdvancementName(advancement) || null,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                parentItem: parentItem?.name || null,
                requestedKeys,
                beforeChosen,
                afterChosen,
                beforeState,
                afterState: this._snapshotTraitState(clone),
                missingChosenKeys,
                missingActorKeys
            });
        }

        if (missingChosenKeys.length || missingActorKeys.length) {
            if (shouldDebug) {
                this._logTraitDebug('原生 Trait 执行后验收未通过，转入手工兜底', {
                    advancementId: group.advancementId,
                    parentItem: parentItem?.name || null,
                    requestedKeys,
                    missingChosenKeys,
                    missingActorKeys
                });
            }
            return false;
        }

        return true;
    }

    async _commitResolutionClone(clone) {
        const actorTraitState = this._snapshotTraitState(this.actor);
        const cloneTraitState = this._snapshotTraitState(clone);
        if (JSON.stringify(actorTraitState) !== JSON.stringify(cloneTraitState)) {
            this._logTraitDebug('Подготовка изменённых владений из clone', {
                actor: actorTraitState,
                clone: cloneTraitState
            });
        }

        const cloneData = clone.toObject();
        const cloneItems = clone.items?.map?.(item => item.toObject())
            || cloneData.items
            || [];
        delete cloneData.items;

        // Старый код на каждом native/ModifyItem commit полностью переписывал Actor
        // и КАЖДЫЙ его Item. Для персонажа с десятками заклинаний это заставляло
        // dnd5e заново готовить весь набор документов и занимало секунды.
        // Сравниваем снимки и отправляем только реально изменившиеся документы.
        const liveActorData = this.actor.toObject();
        delete liveActorData.items;

        const actorChanges = {};
        for (const [key, value] of Object.entries(cloneData)) {
            if (JSON.stringify(liveActorData[key]) !== JSON.stringify(value)) {
                actorChanges[key] = value;
            }
        }

        const cloneItemIds = new Set();
        const toCreate = [];
        const toUpdate = [];

        for (const itemData of cloneItems) {
            const itemId = itemData._id;
            if (itemId) cloneItemIds.add(itemId);

            const liveItem = itemId ? this.actor.items.get(itemId) : null;
            if (!liveItem) {
                toCreate.push(itemData);
                continue;
            }

            // Полную замену сохраняем только для действительно изменившихся Item.
            // Это сохраняет корректность удалённых вложенных полей, но не трогает
            // десятки/сотни неизменившихся заклинаний и особенностей.
            const liveItemData = liveItem.toObject();
            if (JSON.stringify(liveItemData) !== JSON.stringify(itemData)) {
                toUpdate.push(itemData);
            }
        }

        const toDelete = this.actor.items
            .filter(item => !cloneItemIds.has(item.id))
            .map(item => item.id);

        const fastContext = { isAdvancement: true, render: false };

        const actorUpdate = Object.keys(actorChanges).length
            ? await this.actor.update(actorChanges, fastContext)
            : null;
        const deletedItems = toDelete.length
            ? await this.actor.deleteEmbeddedDocuments('Item', toDelete, fastContext)
            : [];
        const updatedItems = toUpdate.length
            ? await this.actor.updateEmbeddedDocuments('Item', toUpdate, {
                ...fastContext,
                diff: false,
                recursive: false
            })
            : [];
        const createdItems = toCreate.length
            ? await this.actor.createEmbeddedDocuments('Item', toCreate, {
                ...fastContext,
                keepId: true
            })
            : [];

        if (actorUpdate || toCreate.length || toUpdate.length || toDelete.length) {
            this._resetResolutionCaches();
        }

        window.OriginateLog?.(
            `Character Forge | fast clone commit: actor=${Object.keys(actorChanges).length ? 1 : 0}, ` +
            `create=${toCreate.length}, update=${toUpdate.length}, delete=${toDelete.length}`
        );

        return {
            toCreate,
            toUpdate,
            toDelete,
            actorUpdate,
            createdItems,
            updatedItems,
            deletedItems
        };
    }

    async applyModifyItemAdvancementsFromInput(input, { initialItemIds = new Set() } = {}) {
        let applications = [];
        let stage = 'collect';
        try {
            const normalized = this._normalizeLevelResolutionInput(input);
            applications = collectModifyItemApplications(this.actor, normalized, initialItemIds);
            if (!applications.length) return { status: 'not-needed', applications: [] };
            stage = 'apply';
            const clone = this.actor.clone({}, { keepId: true });
            const results = await applyModifyItemApplications(clone, applications);
            if (results.some(result => result.modified > 0)) {
                stage = 'commit';
                await this._commitResolutionClone(clone);
            }
            return { status: 'complete', applications: results };
        } catch (error) {
            // 前面的等级、HP 和物品已经保存。这里只报告本阶段，不能诱导用户重跑整个升级。
            console.error('Originate | ModifyItem 阶段未完成', { stage, applications, error });
            return { status: 'failed', stage, applications, message: error?.message || String(error) };
        }
    }

    _applyNativeGrantedSpellConfigs(clone, context = {}) {
        if (!clone?.items?.length) return 0;

        return applyGrantedSpellConfigs(clone.items.contents, {
            warnPrefix: 'Originate | [LevelUp][Native]',
            defaultSourceClass: this._getResolutionClassIdentifier(clone, context)
        });
    }

    async _applyNativeResolutionPlan(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        const plan = this._buildNativeResolutionPlan(normalizedInput);
        this._logTraitDebug('原生计划汇总', {
            level: normalizedInput.level,
            hasSubclassSelection: !!plan.nativeSubclassSelection,
            nativeItemGroups: plan.nativeItemGroups.map(group => ({
                advancementId: group.advancementId,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                sourceUuids: [...group.sourceUuids]
            })),
            nativeTraitGroups: plan.nativeTraitGroups.map(group => ({
                advancementId: group.advancementId,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                keys: [...group.keys]
            })),
            manualTraitChanges: foundry.utils.deepClone(plan.manualInput.traitChanges || [])
        });
        const nativeResolution = {
            usedNativeExecution: false,
            handledSubclassSelection: false,
            handledItemGroups: [],
            handledTraitGroups: []
        };

        let clone = null;
        const ensureClone = () => {
            clone ??= this.actor.clone({}, { keepId: true });
            return clone;
        };

        if (plan.nativeSubclassSelection) {
            const handled = await this._applyNativeSubclassSelection(ensureClone(), plan.nativeSubclassSelection, normalizedInput.context);
            if (handled) {
                nativeResolution.usedNativeExecution = true;
                nativeResolution.handledSubclassSelection = true;
            } else {
                plan.manualInput.itemChanges.pendingItems.unshift(foundry.utils.deepClone(plan.nativeSubclassSelection.entry));
            }
        }

        const pendingItemGroups = [...plan.nativeItemGroups];
        const pendingTraitGroups = [...plan.nativeTraitGroups];
        let progressed = true;

        // 有 parentFeature 的组一开始可能还找不到父节点。
        // 这里故意循环吃计划，等前面的原生授予先把父特性挂进 clone，再回来吃嵌套项。
        // 同级如果既授予父特性又选择子项，ItemChoice 要排在 ItemGrant 后面，不然 dnd5e 的前置校验会先撞墙。
        while (progressed && (pendingItemGroups.length || pendingTraitGroups.length)) {
            progressed = false;

            const itemGroupsThisPass = this._sortNativeItemGroupsForApply(ensureClone(), pendingItemGroups, normalizedInput.context);
            for (const group of itemGroupsThisPass) {
                const index = pendingItemGroups.indexOf(group);
                if (index < 0) continue;

                const handled = await this._applyNativeItemGroup(ensureClone(), group, normalizedInput.context);
                if (!handled) continue;

                nativeResolution.usedNativeExecution = true;
                nativeResolution.handledItemGroups.push({
                    advancementId: group.advancementId,
                    stepType: group.stepType,
                    parentFeature: group.parentFeature || null,
                    parentSourceUuid: group.parentSourceUuid || null
                });
                pendingItemGroups.splice(index, 1);
                progressed = true;
            }

            for (let index = pendingTraitGroups.length - 1; index >= 0; index--) {
                const group = pendingTraitGroups[index];
                const handled = await this._applyNativeTraitGroup(ensureClone(), group, normalizedInput.context);
                if (!handled) continue;

                nativeResolution.usedNativeExecution = true;
                nativeResolution.handledTraitGroups.push({
                    advancementId: group.advancementId,
                    stepType: group.stepType,
                    parentFeature: group.parentFeature || null,
                    parentSourceUuid: group.parentSourceUuid || null
                });
                pendingTraitGroups.splice(index, 1);
                progressed = true;
            }
        }

        for (const group of pendingItemGroups) {
            if (group.kind === 'pendingReplacements') {
                plan.manualInput.itemChanges.pendingReplacements.push(...group.entries.map(entry => foundry.utils.deepClone(entry)));
            } else {
                plan.manualInput.itemChanges.pendingItems.push(...group.entries.map(entry => foundry.utils.deepClone(entry)));
            }
        }

        for (const group of pendingTraitGroups) {
            plan.manualInput.traitChanges.push(...group.entries.map(entry => foundry.utils.deepClone(entry)));
        }

        if (clone && nativeResolution.usedNativeExecution) {
            this._applyNativeGrantedSpellConfigs(clone, normalizedInput.context);
        }

        this._logTraitDebug('原生计划执行结束', {
            usedNativeExecution: nativeResolution.usedNativeExecution,
            handledSubclassSelection: nativeResolution.handledSubclassSelection,
            handledItemGroups: nativeResolution.handledItemGroups,
            handledTraitGroups: nativeResolution.handledTraitGroups,
            fallbackItemGroups: pendingItemGroups.map(group => ({
                advancementId: group.advancementId,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null
            })),
            fallbackTraitGroups: pendingTraitGroups.map(group => ({
                advancementId: group.advancementId,
                stepType: group.stepType,
                parentFeature: group.parentFeature || null,
                parentSourceUuid: group.parentSourceUuid || null,
                keys: [...group.keys]
            })),
            manualTraitChanges: foundry.utils.deepClone(plan.manualInput.traitChanges || [])
        });

        if (nativeResolution.usedNativeExecution && clone) {
            await this._commitResolutionClone(clone);
        }

        return {
            manualInput: plan.manualInput,
            nativeResolution
        };
    }

    _groupPendingItems(pendingItems = []) {
        const groups = [];
        const groupMap = new Map();

        for (const pending of pendingItems) {
            if (!pending?.itemData) continue;

            const key = [
                pending.isSubclass ? 'subclass' : 'normal',
                pending.stepType || 'class',
                pending.advancementId || '',
                pending.level ?? '',
                pending.sourceClass || pending.itemData?.system?.sourceClass || ''
            ].join('::');

            let group = groupMap.get(key);
            if (!group) {
                group = {
                    advancementId: pending.advancementId,
                    level: pending.level,
                    stepType: pending.stepType || 'class',
                    isSubclass: !!pending.isSubclass,
                    sourceClass: pending.sourceClass || pending.itemData?.system?.sourceClass || null,
                    itemsData: []
                };
                groupMap.set(key, group);
                groups.push(group);
            }

            group.itemsData.push(pending.itemData);
        }

        return groups;
    }

    _findMatchingActorSpell(itemData) {
        if (itemData?.type !== 'spell') return null;

        const sourceUuid = resolveItemSourceUuid(itemData);
        const normalizedSourceUuid = sourceUuid?.replace(/\.Item\./, '.') || null;
        const normalizedName = itemData.name?.trim().toLowerCase() || null;

        return this.actor.items.find(actorItem => {
            if (actorItem.type !== 'spell') return false;

            const actorSourceUuid = resolveItemSourceUuid(actorItem);
            const normalizedActorSourceUuid = actorSourceUuid?.replace(/\.Item\./, '.') || null;
            if (normalizedSourceUuid && normalizedActorSourceUuid === normalizedSourceUuid) return true;

            const actorName = actorItem.name?.trim().toLowerCase() || null;
            return !!normalizedName && actorName === normalizedName;
        }) || null;
    }

    /**
     * 增加职业等级
     * @param {number} newLevel - 新等级（默认当前等级 + 1）
     * @returns {Promise<void>}
     */
    async increaseClassLevel(newLevel = null) {
        if (!this.classItem) {
            throw new Error("角色没有职业物品，无法升级");
        }

        const targetLevel = newLevel || (this.currentLevel + 1);
        window.OriginateLog(`Originate | [LevelUp] 升级职业等级: ${this.currentLevel} -> ${targetLevel}`);

        await this.classItem.update({
            "system.levels": targetLevel
        });

        // 清除缓存，下次访问时会重新获取
        this._classItem = null;
    }

    /**
     * 更新 HP
     * 
     * Adrian: DND5e 的 HP 计算逻辑：
     * 总 HP = sum(每个等级的 HP 贡献) + (职业等级 × 体质调整值)
     * 
     * HitPoints Advancement 的 value 格式：
     * { 1: "max", 2: 7, 3: 5, ... }
     * - "max" 表示取最大值（一级通常是这个）
     * - 数字表示纯骰子/平均值结果（不含体质，系统自动加）
     * 
     * DND5e v4 注意：advancement 是 Collection，不是数组！
     * 更新时需要使用 Advancement 对象的 update 方法。
     * 
     * @param {number} hpGain - 用户看到的增加 HP（含体质调整值）
     * @param {string} method - 方式 ('max', 'average', 'roll')
     * @param {number} level - 获得等级
     * @returns {Promise<void>}
     */
    async updateHP(hpGain, method, level) {
        window.OriginateLog(`Originate | [LevelUp] 更新 HP: +${hpGain} (${method}) at level ${level}`);

        if (!this.classItem?.advancement) {
            console.warn("Originate | [LevelUp] 找不到职业或 advancement，无法更新 HP");
            return;
        }

        // 计算纯 HP 值（不含体质调整值，系统会自动加）
        const conMod = this.getConstitutionModifier();
        let hpValue;

        if (method === 'max') {
            hpValue = 'max';
        } else {
            // 存储的是纯骰子/平均值，不含体质
            hpValue = hpGain - conMod;
        }

        // DND5e v4: advancement 是 Collection，使用 byType 获取
        const hpAdvancement = this.classItem.advancement.byType?.HitPoints?.[0];

        if (!hpAdvancement) {
            console.warn("Originate | [LevelUp] 找不到 HitPoints Advancement");
            return;
        }

        // 直接使用 Advancement 对象的 update 方法
        try {
            const newValue = foundry.utils.deepClone(hpAdvancement.value || {});
            newValue[level] = hpValue;

            await hpAdvancement.update({ value: newValue });

            window.OriginateLog(`Originate | [LevelUp] 更新 HitPoints Advancement value:`, newValue);
            window.OriginateLog(`Originate | [LevelUp] HP 将由系统自动计算`);
        } catch (e) {
            console.warn("Originate | [LevelUp] 更新 HitPoints Advancement 失败:", e.message);
            // 尝试回退方案：直接更新 Actor HP
            try {
                const currentMax = this.actor.system.attributes?.hp?.max || 0;
                const currentValue = this.actor.system.attributes?.hp?.value || 0;
                await this.actor.update({
                    "system.attributes.hp.max": currentMax + hpGain,
                    "system.attributes.hp.value": currentValue + hpGain
                });
                window.OriginateLog(`Originate | [LevelUp] 回退方案：直接更新 Actor HP`);
            } catch (e2) {
                console.error("Originate | [LevelUp] HP 更新完全失败:", e2);
            }
        }
    }

    /**
     * 添加物品到角色（带正确的溯源标记）
     * 
     * @param {Array<Object>} itemsData - 物品数据数组（toObject() 格式）
     * @param {string} advancementId - Advancement ID（用于溯源）
     * @param {number} level - 获得等级
     * @param {Object} options - 额外选项
     * @param {string} options.stepType - 步骤类型 ('class', 'subclass', 'race', 'background')
     * @returns {Promise<Array<Item>>} 创建的物品
     */
    async addItems(itemsData, advancementId, level, options = {}) {
        const { stepType = 'class', sourceClass = null } = options;

        window.OriginateLog(`Originate | [LevelUp] 添加 ${itemsData.length} 个物品, advId: ${advancementId}, level: ${level}`);

        const preparedItems = await this._prepareItemsForResolution(itemsData, advancementId, level, {
            ...options,
            sourceClass
        });
        const resolutionOptions = this._buildResolutionOptions(advancementId, level, {
            ...options,
            sourceClass
        });
        const { itemsData: expandedItems, containerIdRemap } = await this._expandContainerContents(preparedItems, resolutionOptions);
        const { itemsToCreate, pendingSpellUpdates } = this._splitSpellUpdates(expandedItems);

        let updatedSpellItems = [];
        if (pendingSpellUpdates.length > 0) {
            updatedSpellItems = await this.actor.updateEmbeddedDocuments('Item', pendingSpellUpdates);
            updatedSpellItems = await this._repairPersistedSpellStates(updatedSpellItems, pendingSpellUpdates);
            window.OriginateLog(`Originate | [LevelUp] 复用 ${updatedSpellItems.length} 个已有法术:`, updatedSpellItems.map(i => i.name));
        }

        const originalConsumptionData = this._detachConsumptionTargets(itemsToCreate);

        let createdItems = await this._createItems(itemsToCreate);
        createdItems = await this._repairPersistedSpellStates(createdItems, itemsToCreate);
        createdItems = await this._repairContainerContentLinks(createdItems, containerIdRemap);

        window.OriginateLog(`Originate | [LevelUp] 成功创建 ${createdItems.length} 个物品:`, createdItems.map(i => i.name));

        // 修复消耗引用（将 Compendium UUID 替换为 Actor 物品 ID）
        if (originalConsumptionData.size > 0) {
            try {
                await this._fixConsumptionReferences(createdItems, originalConsumptionData);
            } catch (e) {
                console.warn("Originate | [LevelUp] 修复消耗引用失败:", e.message);
            }
        }

        // 尝试更新 Advancement.value（可能失败但不影响核心功能）
        try {
            await this._updateAdvancementValue(advancementId, [...createdItems, ...updatedSpellItems], stepType);
        } catch (e) {
            console.warn("Originate | [LevelUp] 更新 Advancement value 失败:", e.message);
        }

        return [...createdItems, ...updatedSpellItems];
    }

    /**
     * 替换物品
     * 
     * @param {Item|string} oldItem - 要替换的旧物品（Item 对象或 ID）
     * @param {Object} newItemData - 新物品数据
     * @param {string} advancementId - Advancement ID
     * @param {number} level - 替换等级
     * @param {Object} options - 额外选项
     * @returns {Promise<Item>} 创建的新物品
     */
    async replaceItem(oldItem, newItemData, advancementId, level, options = {}) {
        const { stepType = 'class', sourceClass = null } = options;

        // 解析旧物品
        const oldItemDoc = typeof oldItem === 'string'
            ? this.actor.items.get(oldItem)
            : oldItem;

        if (!oldItemDoc) {
            throw new Error(`找不到要替换的物品: ${oldItem}`);
        }

        const liveOldItem = this.actor.items.get(oldItemDoc.id);
        if (!liveOldItem) {
            console.warn(`Originate | [LevelUp] 跳过重复替换，旧物品已经不存在: ${oldItemDoc.id}`);
            return null;
        }

        window.OriginateLog(`Originate | [LevelUp] 替换物品: ${oldItemDoc.name} -> ${newItemData.name}`);

        // 准备新物品数据
        const prepared = foundry.utils.deepClone(newItemData);
        await prepareResolutionItemData(prepared, {
            ...this._buildResolutionOptions(advancementId, level, {
                ...options,
                sourceClass
            }),
            replacedItem: {
                name: oldItemDoc.name,
                uuid: resolveItemSourceUuid(oldItemDoc) || oldItemDoc.uuid
            }
        });

        // 删除旧物品
        await liveOldItem.delete();
        window.OriginateLog(`Originate | [LevelUp] 已删除旧物品: ${liveOldItem.name}`);

        // 创建新物品
        const [createdItem] = await this._createItems([prepared]);

        window.OriginateLog(`Originate | [LevelUp] 已创建新物品: ${createdItem.name}`);

        // 尝试更新 Advancement.value（替换记录）
        try {
            await this._updateAdvancementValueForReplacement(advancementId, liveOldItem, createdItem, level, stepType);
        } catch (e) {
            console.warn("Originate | [LevelUp] 更新 Advancement 替换记录失败:", e.message);
        }

        return createdItem;
    }

    async applyPendingItems(pendingItems = []) {
        const groupedItems = this._groupPendingItems(pendingItems);
        const resolvedItems = [];

        for (const group of groupedItems) {
            const createdOrUpdated = await this.addItems(group.itemsData, group.advancementId, group.level, {
                stepType: group.stepType,
                sourceClass: group.sourceClass
            });
            resolvedItems.push(...createdOrUpdated);

            if (group.isSubclass) {
                this._subclassItem = null;
                this._subclassUuid = null;
            }
        }

        return resolvedItems;
    }

    async applyPendingReplacements(pendingReplacements = []) {
        const replacedItems = [];
        const handledOldItemIds = new Set();

        for (const replacement of pendingReplacements) {
            if (!replacement?.oldItemId) continue;

            // 同一个旧物品在同一轮结算里只能被替一次。
            // 一旦队列里叠了重复项，后面的 delete 只会把日志刷爆，不会带来新结果。
            if (handledOldItemIds.has(replacement.oldItemId)) {
                console.warn(`Originate | [LevelUp] 跳过重复替换请求: ${replacement.oldItemId}`);
                continue;
            }
            handledOldItemIds.add(replacement.oldItemId);

            const createdItem = await this.replaceItem(
                replacement.oldItemId,
                replacement.newItemData,
                replacement.advancementId,
                replacement.level,
                {
                    stepType: replacement.stepType,
                    sourceClass: replacement.sourceClass || replacement.newItemData?.system?.sourceClass || null
                }
            );
            if (createdItem) replacedItems.push(createdItem);
        }

        return replacedItems;
    }

    async applyLevelResolutionInput(levelInput = {}) {
        const normalizedInput = this._normalizeLevelResolutionInput(levelInput);
        this._assertCurrentLevelSandbox(normalizedInput);

        const { manualInput, nativeResolution } = await this._applyNativeResolutionPlan(normalizedInput);
        const {
            pendingItems = [],
            pendingItemUpdates = [],
            pendingReplacements = []
        } = manualInput.itemChanges || {};

        const createdOrUpdatedItems = await this.applyPendingItems(pendingItems);

        let updatedExistingItems = [];
        if (pendingItemUpdates.length > 0) {
            updatedExistingItems = await this.actor.updateEmbeddedDocuments('Item', pendingItemUpdates);
        }

        const replacedItems = await this.applyPendingReplacements(pendingReplacements);
        const duplicateSpellRepair = await this.repairDuplicateSpellsFromInputs([normalizedInput, manualInput]);

        const result = {
            createdOrUpdatedItems,
            updatedExistingItems,
            replacedItems,
            duplicateSpellRepair,
            resolutionInput: normalizedInput,
            remainingTraitChanges: manualInput.traitChanges || [],
            nativeResolution
        };

        this._logTraitDebug('当前级结算结果', {
            level: normalizedInput.level,
            createdOrUpdatedItems: createdOrUpdatedItems.map(item => item?.name || item?._id || 'unknown'),
            updatedExistingItems: updatedExistingItems.map(item => item?.name || item?._id || 'unknown'),
            replacedItems: replacedItems.map(item => item?.name || item?._id || 'unknown'),
            duplicateSpellRepair,
            remainingTraitChanges: foundry.utils.deepClone(result.remainingTraitChanges || []),
            nativeResolution
        });

        return result;
    }

    async applyCharacterFinalizeResolutionInput(input = {}) {
        const normalizedInput = this._normalizeCharacterFinalizeResolutionInput(input);
        const { manualInput, nativeResolution } = await this._applyNativeResolutionPlan(normalizedInput);
        const pendingItems = [
            ...(manualInput.itemChanges?.pendingItems || []),
            ...(normalizedInput.manualItems || [])
        ];
        const pendingItemUpdates = manualInput.itemChanges?.pendingItemUpdates || [];
        const pendingReplacements = manualInput.itemChanges?.pendingReplacements || [];

        const createdOrUpdatedItems = await this.applyPendingItems(pendingItems);

        let updatedExistingItems = [];
        if (pendingItemUpdates.length > 0) {
            updatedExistingItems = await this.actor.updateEmbeddedDocuments('Item', pendingItemUpdates);
        }

        const replacedItems = await this.applyPendingReplacements(pendingReplacements);
        const duplicateSpellRepair = await this.repairDuplicateSpellsFromInputs([normalizedInput, manualInput]);

        const result = {
            createdOrUpdatedItems,
            updatedExistingItems,
            replacedItems,
            duplicateSpellRepair,
            resolutionInput: normalizedInput,
            remainingTraitChanges: manualInput.traitChanges || [],
            nativeResolution
        };

        this._logTraitDebug('创角最终结算结果', {
            level: normalizedInput.level,
            createdOrUpdatedItems: createdOrUpdatedItems.map(item => item?.name || item?._id || 'unknown'),
            updatedExistingItems: updatedExistingItems.map(item => item?.name || item?._id || 'unknown'),
            replacedItems: replacedItems.map(item => item?.name || item?._id || 'unknown'),
            duplicateSpellRepair,
            remainingTraitChanges: foundry.utils.deepClone(result.remainingTraitChanges || []),
            nativeResolution
        });

        return result;
    }

    async applyLevelItemChanges(levelInput = {}) {
        // 这里先保留旧入口，避免现有调用一夜之间全断。
        // 等阶段 2 后面真正把提交链切干净，再决定要不要彻底删掉这层兼容壳。
        return this.applyLevelResolutionInput(levelInput);
    }

    async _prepareInitialClassResolutionItem(input = {}) {
        const normalizedInput = this._normalizeInitialClassResolutionInput(input);
        const {
            data,
            sourceUuid,
            multiclassed,
            hitPointMode
        } = normalizedInput.classItem;

        const prepared = foundry.utils.deepClone(data);
        if (!prepared?.type) {
            throw new Error('新增职业结算缺少职业物品数据');
        }

        prepared.system = prepared.system || {};
        prepared.system.levels = Number(prepared.system.levels || 1) || 1;

        await prepareResolutionItemData(prepared, {
            sourceUuid,
            level: prepared.system.levels,
            restoreFeatType: false,
            warnPrefix: 'Originate | [LevelUp]'
        });

        if (multiclassed) {
            foundry.utils.setProperty(prepared, "flags.originate.multiclassed", true);
        }

        if (prepared.system?.advancement) {
            const advancements = getAdvancementEntries(prepared.system.advancement);
            let changed = false;

            for (const adv of advancements) {
                if (adv.type !== 'HitPoints') continue;
                adv.value = {
                    ...(adv.value || {}),
                    1: hitPointMode
                };
                changed = true;
            }

            if (changed) {
                prepared.system.advancement = setAdvancementSource(prepared.system.advancement, advancements);
            }
        }

        return {
            prepared,
            resolutionInput: normalizedInput
        };
    }

    async applyInitialClassResolutionInput(input = {}) {
        const { prepared, resolutionInput } = await this._prepareInitialClassResolutionItem(input);
        const sourceUuid = this._normalizeResolutionSourceUuid(prepared);
        const existingClassItem = this.actor.items.find(item => item.type === 'class'
            && (
                (sourceUuid && this._normalizeResolutionSourceUuid(item) === sourceUuid)
                || item.system?.identifier && item.system.identifier === prepared.system?.identifier
            ));

        if (existingClassItem) {
            return {
                createdItem: existingClassItem,
                resolutionInput,
                nativeResolution: {
                    usedSharedResolutionCore: true,
                    reusedExistingClassItem: true,
                    createdClassItemId: existingClassItem.id
                }
            };
        }

        const itemData = foundry.utils.deepClone(prepared);
        delete itemData._id;

        this._logTraitDebug('准备创建新增副职职业物品', {
            itemName: itemData.name || null,
            sourceUuid,
            identifier: itemData.system?.identifier || null,
            actorClassesBefore: this.actor.items
                .filter(item => item.type === 'class')
                .map(item => ({
                    id: item.id,
                    name: item.name,
                    sourceUuid: this._normalizeResolutionSourceUuid(item),
                    identifier: item.system?.identifier || null
                }))
        });

        const [createdItem] = await this.actor.createEmbeddedDocuments("Item", [itemData], {
            isAdvancement: true
        });

        if (!createdItem) {
            this._logTraitDebug('新增副职 createEmbeddedDocuments 没有返回创建结果', {
                itemName: itemData.name || null,
                sourceUuid,
                actorClassesAfter: this.actor.items
                    .filter(item => item.type === 'class')
                    .map(item => ({
                        id: item.id,
                        name: item.name,
                        sourceUuid: this._normalizeResolutionSourceUuid(item),
                        identifier: item.system?.identifier || null
                    }))
            });
            throw new Error(`新增职业创建没有返回结果: ${prepared.name || 'unknown'}`);
        }

        this._resetResolutionCaches();
        this._logTraitDebug('新增副职职业物品创建完成', {
            id: createdItem.id,
            name: createdItem.name,
            sourceUuid: this._normalizeResolutionSourceUuid(createdItem),
            identifier: createdItem.system?.identifier || null
        });

        return {
            createdItem,
            resolutionInput,
            nativeResolution: {
                usedSharedResolutionCore: true,
                usedInitialClassCreate: true,
                createdClassItemId: createdItem.id
            }
        };
    }

    async addInitialClassItem(classData, options = {}) {
        // 兼容旧调用，但实际已经不再让新增副职直接落到 _createItems 老入口。
        const result = await this.applyInitialClassResolutionInput(
            this.createInitialClassResolutionInput({
                classData,
                ...options
            })
        );
        return result.createdItem;
    }

    /**
     * 更新 Advancement.value 记录
     * @private
     */
    async _updateAdvancementValue(advancementId, createdItems, stepType) {
        const parentItem = this._getAdvancementParentItem(stepType);
        const adv = this._getItemAdvancement(parentItem, advancementId);
        if (!adv) {
            window.OriginateLog(`Originate | [LevelUp] Advancement ${advancementId} 未找到`);
            return;
        }

        const newValue = foundry.utils.deepClone(adv.value || {});

        // 根据 Advancement 类型更新
        if (adv.type === 'ItemGrant') {
            if (!newValue.added) newValue.added = {};
            for (const item of createdItems) {
                const sourceUuid = resolveAdvancementItemSourceUuid(item, [newValue.added[item.id]]);
                if (sourceUuid) {
                    newValue.added[item.id] = sourceUuid;
                }
            }
        } else if (adv.type === 'ItemChoice') {
            const level = createdItems[0]?.flags?.['hero-genesis']?.acquiredAt || 1;
            if (!newValue.added) newValue.added = {};
            if (!newValue.added[level]) newValue.added[level] = {};

            for (const item of createdItems) {
                const sourceUuid = resolveAdvancementItemSourceUuid(item, [newValue.added[level][item.id]]);
                if (sourceUuid) {
                    newValue.added[level][item.id] = sourceUuid;
                }
            }
        }

        // DND5e v4: 使用 Advancement 对象的 update 方法
        try {
            if (adv.update instanceof Function) await adv.update({ value: newValue });
            else await parentItem.update({ [`system.advancement.${advancementId}.value`]: newValue });
            window.OriginateLog(`Originate | [LevelUp] 更新 Advancement ${advancementId} value:`, newValue);
        } catch (e) {
            // 回退：尝试通过 Item.update
            window.OriginateLog(`Originate | [LevelUp] Advancement update 失败，尝试回退方案`);
        }
    }

    /**
     * 更新 Advancement.value（替换记录）
     * @private
     */
    async _updateAdvancementValueForReplacement(advancementId, oldItem, newItem, level, stepType) {
        const parentItem = this._getAdvancementParentItem(stepType);
        const adv = this._getItemAdvancement(parentItem, advancementId);
        if (!adv) {
            window.OriginateLog(`Originate | [LevelUp] Advancement ${advancementId} 未找到 (替换)`);
            return;
        }

        const newValue = foundry.utils.deepClone(adv.value || {});

        if (adv.type === 'ItemChoice') {
            if (!newValue.replaced) newValue.replaced = {};
            if (!newValue.replaced[level]) newValue.replaced[level] = {};

            const oldSourceUuid = resolveAdvancementItemSourceUuid(oldItem);
            const newSourceUuid = resolveAdvancementItemSourceUuid(newItem, [newValue.added?.[level]?.[newItem.id]]);

            if (oldSourceUuid && newSourceUuid) {
                // 格式: replaced[level][newItemId] = [oldSourceUuid, newSourceUuid]
                newValue.replaced[level][newItem.id] = [oldSourceUuid, newSourceUuid];
            }

            // 同时添加到 added
            if (!newValue.added) newValue.added = {};
            if (!newValue.added[level]) newValue.added[level] = {};
            if (newSourceUuid) newValue.added[level][newItem.id] = newSourceUuid;
        }

        // DND5e v4: 使用 Advancement 对象的 update 方法
        try {
            if (adv.update instanceof Function) await adv.update({ value: newValue });
            else await parentItem.update({ [`system.advancement.${advancementId}.value`]: newValue });
            window.OriginateLog(`Originate | [LevelUp] 更新 Advancement ${advancementId} 替换记录:`, newValue);
        } catch (e) {
            window.OriginateLog(`Originate | [LevelUp] Advancement 替换更新失败`);
        }
    }

    /**
     * 获取下一级的升级内容
     * @param {number} level - 目标等级
     * @returns {Promise<Object>} 升级内容
     */
    async getLevelUpgrades(level, context = {}) {
        const upgrades = {
            class: [],
            subclass: [],
            race: [],
            background: []
        };

        // 1. 职业升级（使用职业等级）
        if (this.classUuid) {
            upgrades.class = await this.dataManager.getLevelAdvancement(this.classUuid, level, context);
        }

        // 2. 子职升级（使用职业等级）
        if (this.subclassUuid) {
            upgrades.subclass = await this.dataManager.getLevelAdvancement(this.subclassUuid, level);
        }

        // 种族和背景使用总角色等级（所有职业等级之和），而非单个职业等级
        // 公式：(Actor 上所有职业等级之和) - (当前职业在 Actor 上的等级) + (目标等级)
        // 这样无论 increaseClassLevel 是否已执行，结果都是正确的
        const existingTotal = this.actor.items
            .filter(i => i.type === 'class')
            .reduce((sum, cls) => sum + (cls.system?.levels || 0), 0);
        const currentClassLevel = this.classItem?.system?.levels || 0;
        const totalCharacterLevel = existingTotal - currentClassLevel + level;

        window.OriginateLog(`Originate | [LevelUp] 职业等级=${level}, 当前职业等级=${currentClassLevel}, Actor总等级=${existingTotal}, 总角色等级=${totalCharacterLevel}`);

        // 辅助：过滤已被应用过的 Advancement（防止兼职时重复给予）
        const filterAppliedAdvancements = (events, parentItem) => {
            if (!hasAdvancementEntries(parentItem?.system?.advancement) && !parentItem?.advancement) return events;
            return events.filter(event => {
                const advId = event._original?._id || event.id;
                if (!advId) return true;
                // 检查该 Advancement 是否已经有 value.added 记录
                try {
                    const adv = this._getItemAdvancement(parentItem, advId);
                    if (adv?.value?.added && Object.keys(adv.value.added).length > 0) {
                        window.OriginateLog(`Originate | [LevelUp] 跳过已应用的 Advancement: ${event.title} (${advId})`);
                        return false;
                    }
                } catch (e) { /* 安全忽略 */ }
                return true;
            });
        };

        // 3. 种族升级（使用总角色等级）
        const raceItem = this.actor.items.find(i => i.type === 'race');
        if (raceItem) {
            let raceUuid = resolveItemSourceUuid(raceItem);
            // 终极回退：Compendium index 名称 + identifier 匹配
            if (!raceUuid) {
                raceUuid = this._findCompendiumUuid(raceItem.name, 'race', raceItem.system?.identifier);
            }
            if (raceUuid) {
                let raceEvents = await this.dataManager.getLevelAdvancement(raceUuid, totalCharacterLevel);
                raceEvents = filterAppliedAdvancements(raceEvents, raceItem);
                upgrades.race = raceEvents;
            }
        }

        // 4. 背景升级（使用总角色等级）
        const bgItem = this.actor.items.find(i => i.type === 'background');
        if (bgItem) {
            let bgUuid = resolveItemSourceUuid(bgItem);
            // 终极回退：Compendium index 名称 + identifier 匹配
            if (!bgUuid) {
                bgUuid = this._findCompendiumUuid(bgItem.name, 'background', bgItem.system?.identifier);
            }
            if (bgUuid) {
                let bgEvents = await this.dataManager.getLevelAdvancement(bgUuid, totalCharacterLevel);
                bgEvents = filterAppliedAdvancements(bgEvents, bgItem);
                upgrades.background = bgEvents;
            }
        }

        window.OriginateLog(`Originate | [LevelUp] Level ${level} 升级内容 (总等级=${totalCharacterLevel}):`, upgrades);
        return upgrades;
    }

    /**
     * 获取可替换的现有物品（根据 Advancement 类型筛选）
     * 
     * Adrian: 这个方法用于查找角色卡中可以被替换的物品。
     * 比如战士二级可以替换战斗风格，我们需要找到之前选的战斗风格。
     * 
     * @param {Object} event - Advancement 事件
     * @returns {Array<Item>} 可替换的物品列表
     */
    getReplacementCandidates(event) {
        const candidates = [];

        // 解析限制条件
        // restriction.type 在 DND5e 中是 feat 的 system.type.value（如 "class", "feat" 等），
        // 不是 Foundry 文档类型（如 "feat", "spell" 等）
        // restriction.subtype 是 system.type.subtype（如 "maneuver", "eldritchInvocation" 等）
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

        window.OriginateLog(`Originate | [LevelUp] 查找可替换物品: featType=${targetFeatType}, subtype=${targetSubtype}`);

        // 从 Actor 物品中筛选
        for (const item of this.actor.items) {
            // 跳过核心物品（class, subclass, race, background）
            if (['class', 'subclass', 'race', 'background'].includes(item.type)) continue;

            // 【修复】类型匹配：restriction.type 对应 item.system.type.value（feat 子类型）
            // 而不是 item.type（Foundry 文档类型）
            if (targetFeatType) {
                const itemFeatType = item.system?.type?.value;
                if (itemFeatType !== targetFeatType) continue;
            }

            // 子类型匹配：restriction.subtype 对应 item.system.type.subtype
            if (targetSubtype) {
                const itemSubtype = item.system?.type?.subtype;
                if (itemSubtype !== targetSubtype) continue;
            }

            candidates.push(item);
        }

        window.OriginateLog(`Originate | [LevelUp] 找到 ${candidates.length} 个可替换物品:`, candidates.map(i => i.name));
        return candidates;
    }

    /**
     * 检查角色是否是 Originate 创建的
     * @returns {boolean}
     */
    isOriginateActor() {
        return hasOriginateActorMarkers(this.actor);
    }

    /**
     * 获取职业标识符
     * @returns {string|null}
     */
    getClassIdentifier() {
        return this.classItem?.system?.identifier || null;
    }

    /**
     * 获取子职标识符
     * @returns {string|null}
     */
    getSubclassIdentifier() {
        return this.subclassItem?.system?.identifier || null;
    }

    /**
     * 修复消耗引用 - 将 Compendium UUID 替换为 Actor 物品 ID
     * 
     * 与 actor-writer.js 的 _fixConsumptionReferences 逻辑一致。
     * 物品的 activities 中的 itemUses 消耗目标指向 Compendium UUID，
     * 需要替换为 Actor 上对应物品的实际 ID。
     * 
     * @param {Array<Item>} createdItems - 刚创建的物品
     * @param {Map} originalConsumptionData - 原始消耗数据 (key: "itemName::activityId")
     * @private
     */
    async _fixConsumptionReferences(createdItems, originalConsumptionData) {
        // 构建全面的 UUID -> Actor Item ID 映射
        const comprehensiveMap = new Map();

        for (const actorItem of this.actor.items) {
            const sourceId = resolveItemSourceUuid(actorItem);

            if (sourceId) {
                // 完整 UUID
                comprehensiveMap.set(sourceId, actorItem.id);
                // 简化 UUID（移除 .Item.）
                const simplifiedUuid = sourceId.replace(/\.Item\./, '.');
                if (simplifiedUuid !== sourceId) {
                    comprehensiveMap.set(simplifiedUuid, actorItem.id);
                }
                // Item ID（UUID 最后一部分）
                const uuidParts = sourceId.split('.');
                const itemId = uuidParts[uuidParts.length - 1];
                if (itemId && itemId.length >= 16) {
                    comprehensiveMap.set(itemId, actorItem.id);
                }
            }
            // 名称映射（备用）
            if (actorItem.name) {
                comprehensiveMap.set(`name:${actorItem.name}`, actorItem.id);
            }
        }

        window.OriginateLog(`Originate | [LevelUp] 消耗引用映射表 (${comprehensiveMap.size} 条)`);

        const updates = [];

        for (const item of createdItems) {
            // DND5e v4: activities 可能是 Collection
            let activityEntries = [];
            const activities = item.system?.activities;
            if (activities) {
                if (activities instanceof Collection || activities instanceof Map) {
                    activityEntries = Array.from(activities.entries());
                } else if (typeof activities === 'object') {
                    activityEntries = Object.entries(activities);
                }
            }

            if (activityEntries.length === 0) continue;

            let itemNeedsUpdate = false;
            const activityUpdates = {};

            for (const [activityId, activity] of activityEntries) {
                const key = `${item.name}::${activityId}`;
                const originalTargets = originalConsumptionData.get(key);
                if (!originalTargets || originalTargets.length === 0) continue;

                window.OriginateLog(`Originate | [LevelUp] 恢复物品 ${item.name} activity ${activityId} 的消耗目标`);

                const newTargets = [];
                let targetsChanged = false;

                for (const target of originalTargets) {
                    if (target.type === 'itemUses' && target.target) {
                        const originalTarget = target.target;
                        let newTargetId = null;

                        // 1. 直接 UUID 匹配
                        if (comprehensiveMap.has(originalTarget)) {
                            newTargetId = comprehensiveMap.get(originalTarget);
                        }
                        // 2. 简化 UUID 匹配
                        if (!newTargetId) {
                            const simplifiedUuid = originalTarget.replace(/\.Item\./, '.');
                            if (comprehensiveMap.has(simplifiedUuid)) {
                                newTargetId = comprehensiveMap.get(simplifiedUuid);
                            }
                        }
                        // 3. Item ID 匹配
                        if (!newTargetId && originalTarget.includes('.')) {
                            const uuidParts = originalTarget.split('.');
                            const itemId = uuidParts[uuidParts.length - 1];
                            if (itemId && comprehensiveMap.has(itemId)) {
                                newTargetId = comprehensiveMap.get(itemId);
                            }
                        }
                        // 4. 通过名称匹配（从 Compendium 获取名称）
                        if (!newTargetId) {
                            try {
                                const originalItem = await fromUuid(originalTarget);
                                if (originalItem?.name) {
                                    const nameKey = `name:${originalItem.name}`;
                                    if (comprehensiveMap.has(nameKey)) {
                                        newTargetId = comprehensiveMap.get(nameKey);
                                    }
                                }
                            } catch (e) {
                                // 静默失败
                            }
                        }

                        if (newTargetId) {
                            newTargets.push({ ...target, target: newTargetId });
                            targetsChanged = true;
                            window.OriginateLog(`Originate | [LevelUp] 消耗引用: ${originalTarget} -> ${newTargetId}`);
                        } else {
                            newTargets.push(target);
                            console.warn(`Originate | [LevelUp] 无法解析消耗引用: ${originalTarget} (物品: ${item.name})`);
                        }
                    } else {
                        newTargets.push(target);
                    }
                }

                if (targetsChanged) {
                    activityUpdates[activityId] = newTargets;
                    itemNeedsUpdate = true;
                }
            }

            if (itemNeedsUpdate) {
                const updateData = { _id: item.id };
                for (const [activityId, newTargets] of Object.entries(activityUpdates)) {
                    updateData[`system.activities.${activityId}.consumption.targets`] = newTargets;
                }
                updates.push(updateData);
            }
        }

        if (updates.length > 0) {
            window.OriginateLog(`Originate | [LevelUp] 更新 ${updates.length} 个物品的消耗引用`);
            await this.actor.updateEmbeddedDocuments('Item', updates);
            window.OriginateLog(`Originate | [LevelUp] 消耗引用更新完成`);
        }
    }
}
