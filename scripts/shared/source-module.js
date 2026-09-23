function getModuleIdFromCompendiumUuid(uuid) {
    if (typeof uuid !== 'string' || !uuid.startsWith('Compendium.')) return null;
    return uuid.split('.')[1] || null;
}

function getModuleIdFromPack(pack) {
    const collection = typeof pack === 'string' ? pack : pack?.collection;
    if (!collection) return null;
    if (collection.startsWith('Compendium.')) return getModuleIdFromCompendiumUuid(collection);
    return collection.split('.')[0] || null;
}

/**
 * 配置页只需要来源包的拥有者，不必为了这行小字再加载完整文档。
 */
export function getSourceModuleId(itemOrUuid) {
    const item = typeof itemOrUuid === 'string' ? { uuid: itemOrUuid } : (itemOrUuid || {});
    const packModuleId = getModuleIdFromPack(item.packId || item.pack);
    if (packModuleId) return packModuleId;

    const originalUuid = item.sourceId
        || item._stats?.compendiumSource
        || item.flags?.core?.sourceId;
    const originalModuleId = getModuleIdFromCompendiumUuid(originalUuid);
    if (originalModuleId) return originalModuleId;

    const uuidModuleId = getModuleIdFromCompendiumUuid(item.uuid);
    if (uuidModuleId) return uuidModuleId;

    return item.uuid ? 'world' : null;
}
