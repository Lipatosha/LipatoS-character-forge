function firstSourceUuid(candidates = [], options = {}) {
    for (const value of candidates) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (options.compendiumOnly && !trimmed.startsWith('Compendium.')) continue;
        if (options.itemSourceOnly && !/^(?:Item\.[^.]+|Compendium\.[^.]+\.[^.]+\.(?:Item\.)?[^.]+)$/.test(trimmed)) continue;
        if (trimmed) return trimmed;
    }
    return null;
}

function itemSourceCandidates(itemData) {
    return [
        itemData?.flags?.originate?.sourceUuid,
        itemData?._stats?.compendiumSource,
        itemData?.flags?.['hero-genesis']?.sourceUuid,
        itemData?._sourceUuid,
        itemData?.uuid,
        // 这两个旧字段只给旧角色和第三方旧数据兜底，新逻辑别再把它们当主锚点。
        itemData?.flags?.core?.sourceId,
        itemData?.flags?.dnd5e?.sourceId
    ];
}

export function resolveItemSourceUuid(itemData, options = {}) {
    return firstSourceUuid(itemSourceCandidates(itemData), options);
}

export function resolveAdvancementItemSourceUuid(itemData, preferredSources = []) {
    // 原生 ItemGrant / ItemChoice 禁止内嵌 UUID；不能把角色里的副本当作来源写回。
    // 先保留原生记录或本次选择，再查物品标记；旧合集 UUID 的短格式仍然有效。
    return firstSourceUuid([...preferredSources, ...itemSourceCandidates(itemData)], { itemSourceOnly: true });
}

export function stampSourceTracking(target, sourceUuid, options = {}) {
    if (!target || !sourceUuid) return;

    const normalizedSourceUuid = firstSourceUuid([sourceUuid]);
    if (!normalizedSourceUuid) return;

    if (!target.uuid) target.uuid = normalizedSourceUuid;
    if (!target._sourceUuid) target._sourceUuid = normalizedSourceUuid;

    foundry.utils.setProperty(target, '_stats.compendiumSource', normalizedSourceUuid);
    foundry.utils.setProperty(target, 'flags.originate.sourceUuid', normalizedSourceUuid);
    foundry.utils.setProperty(target, 'flags.hero-genesis.sourceUuid', normalizedSourceUuid);

    // 默认不再写旧 sourceId，只有迁移、排障或旧 full writer 明确要镜像时才打开。
    if (options.writeLegacy === true) {
        foundry.utils.setProperty(target, 'flags.core.sourceId', normalizedSourceUuid);
        foundry.utils.setProperty(target, 'flags.dnd5e.sourceId', normalizedSourceUuid);
    }
}
