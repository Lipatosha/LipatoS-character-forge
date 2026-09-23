import { normalizeSpellSchools } from './spell-school-restrictions.js';

function cloneRestriction(restriction) {
    if (!restriction || typeof restriction !== 'object') return {};
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(restriction);
    return JSON.parse(JSON.stringify({ ...restriction, school: normalizeSpellSchools(restriction.school) }));
}

function normalizeLookupText(value) {
    return String(value ?? '').trim().toLowerCase();
}

function readPath(value, path) {
    let current = value;
    for (const part of path.split('.')) {
        current = current?.[part];
        if (current === undefined || current === null) return null;
    }
    return current;
}

function extractSpellReferenceUuid(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';

    const paths = [
        'uuid',
        'documentUuid',
        'sourceUuid',
        '_sourceUuid',
        'value.uuid',
        'item.uuid',
        'document.uuid',
        'data.uuid'
    ];

    for (const path of paths) {
        const candidate = readPath(value, path);
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }

    const id = value.id ?? value._id;
    if (typeof id === 'string' && id.includes('.')) return id;
    return '';
}

function extractSpellReferenceName(value) {
    if (!value || typeof value !== 'object') return '';

    const paths = ['name', 'label', 'item.name', 'document.name', 'data.name'];
    for (const path of paths) {
        const candidate = readPath(value, path);
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    return '';
}

function looksLikeSpellReference(value) {
    if (typeof value === 'string') return true;
    if (!value || typeof value !== 'object') return false;
    return !!extractSpellReferenceUuid(value) || !!extractSpellReferenceName(value);
}

export function normalizeSpellListId(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().replace(/^class:/i, '').trim().toLowerCase();
}

export function normalizeSpellListIds(values) {
    if (!values) return [];

    let rawValues;
    if (values instanceof Set) rawValues = Array.from(values);
    else if (Array.isArray(values)) rawValues = values;
    else if (typeof values === 'object') rawValues = Object.values(values);
    else rawValues = [values];

    const ids = rawValues.map(normalizeSpellListId).filter(Boolean);
    return Array.from(new Set(ids));
}

export function normalizeItemUuid(value) {
    const uuid = extractSpellReferenceUuid(value);
    return uuid ? String(uuid).trim().replace(/\.Item\./, '.') : '';
}

export function normalizeSpellUuid(value) {
    return normalizeItemUuid(value);
}

export function normalizeSpellName(value) {
    if (typeof value === 'string') return '';
    return normalizeLookupText(extractSpellReferenceName(value));
}

export function flattenSpellReferences(value, depth = 0) {
    if (!value || depth > 4) return [];
    if (looksLikeSpellReference(value)) return [value];

    if (value instanceof Set || value instanceof Map) {
        return Array.from(value.values()).flatMap(entry => flattenSpellReferences(entry, depth + 1));
    }

    if (Array.isArray(value)) {
        return value.flatMap(entry => flattenSpellReferences(entry, depth + 1));
    }

    if (typeof value === 'object') {
        return Object.values(value).flatMap(entry => flattenSpellReferences(entry, depth + 1));
    }

    return [];
}

export function getSpellLookupKeys(value) {
    const keys = new Set();
    const uuid = normalizeSpellUuid(value);
    if (uuid) keys.add(`uuid:${uuid}`);

    const name = normalizeSpellName(value);
    if (name) keys.add(`name:${name}`);

    return Array.from(keys);
}

export function addSpellClassMapping(classSpellMap, spellRef, classId) {
    const normalizedClassId = normalizeSpellListId(classId);
    if (!classSpellMap || !normalizedClassId) return false;

    const keys = getSpellLookupKeys(spellRef);
    if (keys.length === 0) return false;

    for (const key of keys) {
        if (!classSpellMap.has(key)) classSpellMap.set(key, new Set());
        classSpellMap.get(key).add(normalizedClassId);
    }
    return true;
}

export function getSpellClassesForSpell(classSpellMap, spell) {
    if (!classSpellMap) return null;

    const merged = new Set();
    for (const key of getSpellLookupKeys(spell)) {
        const spellClasses = classSpellMap.get(key);
        if (!spellClasses) continue;
        for (const classId of spellClasses) merged.add(classId);
    }

    return merged.size > 0 ? merged : null;
}

export function spellClassSetMatchesAny(spellClasses, classIds) {
    if (!spellClasses || !classIds) return false;

    const classSet = new Set(normalizeSpellListIds(classIds));
    if (classSet.size === 0) return false;

    for (const classId of spellClasses) {
        if (classSet.has(normalizeSpellListId(classId))) return true;
    }
    return false;
}

export function buildSpellBrowserSearchRestriction(restriction = {}, currentClassFilters = new Set(), restrictedLevel = '') {
    const searchRestriction = cloneRestriction(restriction);
    const selectedClassIds = normalizeSpellListIds(currentClassFilters);

    // 空集合代表用户已经取消全部法表，别再回退到 advancement 默认 list。
    searchRestriction.list = selectedClassIds.map(id => `class:${id}`);

    const isNumericLevel = restrictedLevel !== ''
        && restrictedLevel !== undefined
        && restrictedLevel !== null
        && restrictedLevel !== 'available';
    if (isNumericLevel) searchRestriction.level = restrictedLevel;

    return searchRestriction;
}
