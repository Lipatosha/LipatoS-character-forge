import { getSpellRestriction } from './spell-school-restrictions.js';
import { normalizeSpellListIds } from './spell-list-filters.js';

function getChoiceConfiguration(event) {
    return event?._original?.configuration ?? event?._original?.data?.configuration ?? event?.configuration ?? {};
}

export function isSpellChoiceEvent(event) {
    if (!event || !['choice', 'ItemChoice', undefined].includes(event.type)) return false;
    const config = getChoiceConfiguration(event);
    // 非法术 ItemChoice 也可能带空 level 和旧 spell 配置，明确的文档类型必须优先。
    if (config.type) return config.type === 'spell';
    const restriction = getSpellRestriction(event);
    if (restriction.type) return restriction.type === 'spell';
    if (event.spellConfig || config.spell) return true;
    const level = restriction.level;
    return level !== undefined && level !== null && String(level).trim() !== '';
}

function entries(value) {
    if (value instanceof Map) return [...value.entries()];
    return Object.entries(value || {});
}

function count(value) {
    return value?.size ?? value?.length ?? 0;
}

export function usesSpellBrowser(event) {
    // 固定池必须留在物品选择器，法术浏览器会扩大可选范围。
    return isSpellChoiceEvent(event) && !count(getChoiceConfiguration(event).pool ?? event.pool);
}

export function isAvailableSpellLevel(level) {
    return ['available', 'availableNoCantrips'].includes(level);
}

/** 只接管与职业基础增长表相符的连续选择；无法证明归属时保留原生事件。 */
export function isBaseSpellProgressionChoice(event, { identifier, rules, baseRules = rules } = {}) {
    if (!identifier || !rules || !isSpellChoiceEvent(event) || event._isSpellRules) return false;
    if (event.parentFeature || event.parentSourceUuid) return false;
    const source = event.sourceItem ?? event._original?.item;
    if (!['class', 'subclass'].includes(source?.type)) return false;
    if ((source.identifier ?? source.system?.identifier)?.toLowerCase() !== identifier.toLowerCase()) return false;

    const config = getChoiceConfiguration(event);
    const restriction = getSpellRestriction(event);
    if (count(config.pool ?? event.pool)) return false;
    if (restriction.subtype || (restriction.type && restriction.type !== 'spell')) return false;
    const list = normalizeSpellListIds(restriction.list);
    const expectedList = normalizeSpellListIds(baseRules.list || [identifier]);
    if (!list.length || list.length !== expectedList.length || list.some(id => !expectedList.includes(id))) return false;

    const level = String(restriction.level ?? '').trim();
    const isCantrip = level === '0';
    // 固定环阶或有限次数的选择属于特性本身；基础增长上的学派限制则必须交给生成步骤继续执行。
    if (!isCantrip && !isAvailableSpellLevel(level)) return false;
    const spell = event.spellConfig ?? config.spell;
    if (spell?.uses?.max || ['atwill', 'innate', 'ritual'].includes(spell?.method ?? spell?.preparation)) return false;

    const table = isCantrip ? baseRules.cantripsKnown : baseRules.spellsKnown;
    if (!table) return false;
    const valueAt = level => entries(table).reduce((result, [key, value]) => {
        const candidate = Number(key);
        return candidate <= level && candidate > result.level ? { level: candidate, value: Number(value) || 0 } : result;
    }, { level: -1, value: 0 }).value;
    const choices = entries(config.choices);
    let grantLevels = 0;
    for (const [key, choice] of choices) {
        const level = Number(key);
        if (!Number.isInteger(level) || level < 1) return false;
        const amount = Number(typeof choice === 'number' ? choice : choice?.count) || 0;
        if (amount > 0) grantLevels++;
        if (amount !== Math.max(0, valueAt(level) - valueAt(level - 1))) return false;
    }
    // 单独增加一次戏法或法术的特性，即使恰好与基础增长同量，也要保留自己的选择。
    return grantLevels > 1;
}
