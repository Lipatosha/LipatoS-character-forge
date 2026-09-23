import { normalizeSpellItemData } from './advancement-rule-utils.js';
import { resolveItemSourceUuid, stampSourceTracking } from './source-tracking.js';

export { resolveItemSourceUuid, stampSourceTracking } from './source-tracking.js';

export function hasOriginateItemMarker(itemData) {
    const marker = itemData?.flags?.['hero-genesis'];
    if (!marker) return false;

    return !!marker.advancementOrigin
        || !!marker.sourceUuid
        || marker.acquiredAt !== undefined
        || !!marker.stepType
        || !!marker.isSubclassSelection
        || marker.created === true;
}

export function hasOriginateActorMarkers(actor) {
    if (!actor) return false;

    if (actor.flags?.originate?.createdBy === 'originate'
        || actor.flags?.['hero-genesis']?.created) {
        return true;
    }

    const items = actor.items?.contents
        || (Array.isArray(actor.items) ? actor.items : null)
        || (actor.items instanceof Map ? Array.from(actor.items.values()) : null)
        || (typeof actor.items?.[Symbol.iterator] === 'function' ? Array.from(actor.items) : []);

    return items.some(hasOriginateItemMarker);
}

export function resolveAdvancementParentItem(actor, { stepType = 'class', classItem = null, subclassItem = null } = {}) {
    if (stepType === 'subclass') return subclassItem || null;
    if (stepType === 'class') return classItem || null;
    if (!actor) return null;
    if (stepType === 'race') return actor.items?.find?.(i => i.type === 'race') || null;
    if (stepType === 'background') return actor.items?.find?.(i => i.type === 'background') || null;

    return classItem || null;
}

export function buildAdvancementOrigin(actor, advancementId, options = {}) {
    if (!advancementId) return null;

    const parentItem = resolveAdvancementParentItem(actor, options);
    if (!parentItem?.id) return null;

    return `${parentItem.id}.${advancementId}`;
}

export function buildAdvancementRoot(actor, advancementOrigin, options = {}) {
    if (!advancementOrigin) return null;

    const parentItem = resolveAdvancementParentItem(actor, options);
    return parentItem?.flags?.dnd5e?.advancementRoot || advancementOrigin;
}

export async function restoreFeatTypeFromSource(itemData, sourceUuid, options = {}) {
    if (!itemData || itemData.type !== 'feat' || !sourceUuid || typeof fromUuid !== 'function') return false;

    try {
        const sourceItem = await fromUuid(sourceUuid);
        if (!sourceItem?.system?.type) return false;

        if (!itemData.system) itemData.system = {};
        if (!itemData.system.type) itemData.system.type = {};

        const originalValue = itemData.system.type.value;
        const originalSubtype = itemData.system.type.subtype;
        const sourceValue = sourceItem.system.type.value;
        const sourceSubtype = sourceItem.system.type.subtype;

        let typeChanged = false;

        if (sourceValue) {
            if (options.force || !originalValue || (originalValue === 'feat' && ['race', 'class', 'background'].includes(sourceValue))) {
                itemData.system.type.value = sourceValue;
                typeChanged = originalValue !== sourceValue;
            }
        }

        if (sourceSubtype) {
            if (options.force || !originalSubtype || (originalSubtype.includes('.') && !sourceSubtype.includes('.'))) {
                itemData.system.type.subtype = sourceSubtype;
                typeChanged = typeChanged || originalSubtype !== sourceSubtype;
            }
        }

        return typeChanged;
    } catch (e) {
        if (options.warnPrefix) {
            console.warn(`${options.warnPrefix} 无法恢复特性 ${itemData.name} 的类型信息`);
        }
        return false;
    }
}

export async function prepareResolutionItemData(itemData, options = {}) {
    if (!itemData) return { itemData, sourceUuid: null, advancementOrigin: null };

    const {
        actor = null,
        classItem = null,
        subclassItem = null,
        advancementId = null,
        level = null,
        stepType = 'class',
        sourceUuid = resolveItemSourceUuid(itemData),
        sourceClass = null,
        restoreFeatType = true,
        forceFeatTypeFromSource = false,
        replacedItem = null,
        warnPrefix = null
    } = options;

    if (advancementId) {
        foundry.utils.setProperty(itemData, 'flags.hero-genesis.advancementOrigin', advancementId);
    }
    if (level !== null && level !== undefined) {
        foundry.utils.setProperty(itemData, 'flags.hero-genesis.acquiredAt', level);
    }
    if (replacedItem) {
        foundry.utils.setProperty(itemData, 'flags.hero-genesis.replacedAt', level);
        foundry.utils.setProperty(itemData, 'flags.hero-genesis.replacedItem', replacedItem);
    }

    const advancementOrigin = buildAdvancementOrigin(actor, advancementId, {
        stepType,
        classItem,
        subclassItem
    });
    if (advancementOrigin) {
        foundry.utils.setProperty(itemData, 'flags.dnd5e.advancementOrigin', advancementOrigin);
        foundry.utils.setProperty(itemData, 'flags.dnd5e.advancementRoot', buildAdvancementRoot(actor, advancementOrigin, {
            stepType,
            classItem,
            subclassItem
        }));
    }

    if (sourceUuid) {
        stampSourceTracking(itemData, sourceUuid);
    }

    if (restoreFeatType && itemData.type === 'feat' && sourceUuid) {
        await restoreFeatTypeFromSource(itemData, sourceUuid, {
            force: forceFeatTypeFromSource,
            warnPrefix
        });
    }

    if (itemData.type === 'spell') {
        normalizeSpellItemData(itemData, {
            sourceUuid,
            sourceClass
        });
    }

    return {
        itemData,
        sourceUuid,
        advancementOrigin
    };
}

export async function prepareResolutionItemsData(itemsData, options = {}) {
    const preparedItems = [];

    for (const itemData of itemsData || []) {
        const prepared = options.clone === false
            ? itemData
            : foundry.utils.deepClone(itemData);

        await prepareResolutionItemData(prepared, options);
        preparedItems.push(prepared);
    }

    return preparedItems;
}
