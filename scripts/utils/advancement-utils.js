export function getAdvancementName(advancement, fallback = '') {
    // 6.x 的旧属性 getter 会发兼容警告；新字段有值时不要再读旧字段。
    return advancement?.name || advancement?.title || fallback;
}

export function getAdvancementImage(advancement, fallback = '') {
    return advancement?.img || advancement?.icon || fallback;
}

export function getAdvancementEntries(rawAdvancement) {
    if (!rawAdvancement) return [];
    if (Array.isArray(rawAdvancement)) return rawAdvancement;
    if (rawAdvancement instanceof Map) return Array.from(rawAdvancement.values());

    if (typeof rawAdvancement[Symbol.iterator] === 'function' && typeof rawAdvancement !== 'string') {
        return Array.from(rawAdvancement);
    }

    if (typeof rawAdvancement === 'object') {
        return Object.values(rawAdvancement).filter(Boolean);
    }

    return [];
}

export function getAdvancementCount(rawAdvancement) {
    return getAdvancementEntries(rawAdvancement).length;
}

export function hasAdvancementEntries(rawAdvancement) {
    return getAdvancementCount(rawAdvancement) > 0;
}

export function findAdvancementEntry(rawAdvancement, predicate) {
    return getAdvancementEntries(rawAdvancement).find(predicate) ?? null;
}

function shouldUseObjectSource(rawAdvancement) {
    if (rawAdvancement && !Array.isArray(rawAdvancement)) return true;

    const systemVersion = game?.system?.version ?? game?.system?.data?.version ?? '';
    return foundry?.utils?.isNewerVersion?.(systemVersion, '5.2.99') ?? false;
}

export function setAdvancementSource(rawAdvancement, entries) {
    const list = getAdvancementEntries(entries);
    if (!shouldUseObjectSource(rawAdvancement)) return list;

    return list.reduce((obj, adv) => {
        const id = adv?._id ?? adv?.id;
        if (id) obj[id] = adv;
        return obj;
    }, {});
}

export function appendAdvancementSource(rawAdvancement, advancement) {
    const list = getAdvancementEntries(rawAdvancement);
    const targetId = advancement?._id ?? advancement?.id;

    if (targetId && list.some(adv => (adv?._id ?? adv?.id) === targetId)) {
        return setAdvancementSource(rawAdvancement, list);
    }

    list.push(advancement);
    return setAdvancementSource(rawAdvancement, list);
}
