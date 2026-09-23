import { getSourceModuleId } from './source-module.js';

const NON_FEAT_TYPES = new Set(['class', 'monster', 'background', 'race', 'species', 'lineage', 'subrace', 'supernaturalGift', 'enchantment']);
const FEAT_CATEGORIES = new Set(['general', 'origin', 'fightingStyle', 'epicBoon']);

export function isPlayerFeat(item = {}) {
    if (item.type && !['feat', 'item'].includes(item.type)) return false;

    const value = String(item.system?.type?.value || '').trim();
    const subtype = String(item.system?.type?.subtype || '').trim();

    // В dnd5e 6.x обычные особенности класса/расы тоже являются Item типа "feat".
    // Настоящие выбираемые черты помечены feature type = "feat".
    // Старый широкий фильтр пропускал сюда полторы тысячи обычных особенностей.
    if (value === 'feat') return true;

    // Небольшой legacy-fallback для старых источников, где категория черты лежала прямо в value/subtype.
    if (FEAT_CATEGORIES.has(value)) return true;
    if (!value && FEAT_CATEGORIES.has(subtype)) return true;

    return false;
}

export function getRequiredLevel(item = {}) {
    // 旧池用 minLevel，索引用 system，完整选项用顶层 prerequisites；不能让缺省 0 覆盖真实限制。
    const levels = [item.system?.prerequisites?.level, item.prerequisites?.level, item.minLevel]
        .map(value => Number(value)).filter(value => Number.isFinite(value) && value >= 0);
    return Math.max(0, ...levels);
}

export function normalizePrerequisites(item = {}) {
    if (item.system?.prerequisites?.level == null && item.prerequisites?.level == null && item.minLevel == null) return { ...item };
    const level = getRequiredLevel(item);
    return {
        ...item,
        prerequisites: { ...item.system?.prerequisites, ...item.prerequisites, level },
        minLevel: level
    };
}

export function meetsLevelRequirement(item, level) {
    return getRequiredLevel(item) <= Math.max(1, Number(level) || 1);
}

export function getFeatCategory(item = {}) {
    const value = item.system?.type?.value;
    const subtype = item.system?.type?.subtype;
    if (value === 'feat') return FEAT_CATEGORIES.has(subtype) ? subtype : (subtype ? 'other' : 'general');
    // 兼容旧包把专长分类放在 value 中；缺字段时不按名称猜类别。
    if (FEAT_CATEGORIES.has(value)) return value;
    return NON_FEAT_TYPES.has(value) ? value : 'unclassified';
}

export function normalizeCatalogSearch(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function catalogText(key, data) {
    const fullKey = `ORIGINATE.FeatCatalog.${key}`;
    return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

export function toCatalogEntry(item) {
    const source = getSourceModuleId(item) || 'world';
    const uuid = item.uuid || '';
    const packId = item.packId || (uuid.startsWith('Compendium.') ? uuid.split('.').slice(1, 3).join('.') : 'world');
    const pack = globalThis.game?.packs?.get?.(packId);
    const packLabel = pack?.metadata?.label || pack?.title || packId;
    const category = getFeatCategory(item);
    const categoryLabel = catalogText(`Category.${category}`);
    const level = getRequiredLevel(item);
    const entry = { ...item, source, packId, packLabel, category, categoryLabel, minLevel: level };
    entry.searchText = normalizeCatalogSearch([item.name, source, packLabel, packId, categoryLabel, item.system?.identifier].join(' '));
    return entry;
}

export const CATALOG_PAGE_SIZE = 60;

export function queryCatalog(entries, filters = {}) {
    const tokens = normalizeCatalogSearch(filters.query).split(' ').filter(Boolean);
    const maxLevel = filters.maxLevel === '' || filters.maxLevel == null ? Infinity : Number(filters.maxLevel);
    const matches = entries.filter(item =>
        tokens.every(token => item.searchText.includes(token))
        && (!filters.source || item.source === filters.source)
        && (!filters.pack || item.packId === filters.pack)
        && (!filters.category || item.category === filters.category)
        && item.minLevel <= maxLevel
        && (filters.status !== 'available' || !item.locked)
        && (filters.status !== 'repeatable' || item.repeatable)
        && (filters.status !== 'included' || !item.isExcluded)
        && (filters.status !== 'excluded' || item.isExcluded)
    );
    const collator = new Intl.Collator(globalThis.game?.i18n?.lang || undefined, { numeric: true, sensitivity: 'base' });
    matches.sort((a, b) => {
        const name = collator.compare(a.name, b.name) || collator.compare(a.uuid, b.uuid);
        if (filters.sort === 'level') return a.minLevel - b.minLevel || name;
        if (filters.sort === 'source') return collator.compare(a.source, b.source) || collator.compare(a.packLabel, b.packLabel) || name;
        return filters.sort === 'nameDesc' ? -name : name;
    });
    const pages = Math.max(1, Math.ceil(matches.length / CATALOG_PAGE_SIZE));
    const page = Math.min(pages - 1, Math.max(0, Number(filters.page) || 0));
    return { matches, page, pages, visible: matches.slice(page * CATALOG_PAGE_SIZE, (page + 1) * CATALOG_PAGE_SIZE) };
}
