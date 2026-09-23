const TRAIT_COLLECTION_PATHS = new Set([
    'traits.languages.value',
    'traits.dr.value',
    'traits.di.value',
    'traits.dv.value',
    'traits.ci.value',
    'traits.weaponProf.value',
    'traits.armorProf.value',
    'traits.toolProf.value',
    'traits.weaponProf.mastery.value',
    'traits.weaponMastery.value'
]);

export function isTraitCollectionPath(path) {
    return TRAIT_COLLECTION_PATHS.has(path);
}

export function ensureTraitSet(system, path) {
    const value = system[path];
    if (value instanceof Set) return value;
    // 旧快照或序列化草稿可能保留数组；继续选择和跨来源合并前须恢复集合语义。
    if (value != null && !Array.isArray(value)) {
        throw new TypeError(`Originate | ${path} 应为 Set 或数组，收到 ${typeof value}`);
    }
    return system[path] = new Set(value || []);
}
