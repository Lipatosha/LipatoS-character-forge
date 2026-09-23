export function normalizeSpellSchools(value) {
    const entries = value instanceof Set ? Array.from(value) : (Array.isArray(value) ? value : []);
    return [...new Set(entries.filter(entry => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean))];
}

export function getSpellRestriction(event = {}) {
    return event.restriction ?? event._original?.configuration?.restriction
        ?? event._original?.data?.configuration?.restriction
        ?? event._original?.configuration?.spell ?? event.spellConfig ?? {};
}

export function spellSchoolHint(restriction) {
    const schools = normalizeSpellSchools(restriction?.school);
    if (!schools.length) return '';
    const labels = schools.map(school => CONFIG.DND5E.spellSchools?.[school]?.label || school);
    return game.i18n.format('ORIGINATE.UI.Progression.AllowedSpellSchools', { schools: labels.join(', ') });
}

export function matchesSpellSchool(spell, restriction = {}) {
    if (spell?.type && spell.type !== 'spell') return true;
    const schools = normalizeSpellSchools(restriction.school);
    if (!schools.length) return true;
    return schools.includes(spell?.system?.school ?? spell?.school);
}

export async function findInvalidSpellSchoolSelections(uuids, restriction, resolve) {
    if (!normalizeSpellSchools(restriction?.school).length) return [];
    const invalid = [];
    for (const uuid of new Set(uuids || [])) {
        // 草稿和 DOM 中的学派可能已过期，确认时必须重新读取文档。
        let spell;
        try { spell = await resolve(uuid); } catch { spell = null; }
        if (!spell || !matchesSpellSchool(spell, restriction)) invalid.push(uuid);
    }
    return invalid;
}

export async function filterSpellSchoolOptions(options, restriction, resolve, selectedUuids = []) {
    if (!normalizeSpellSchools(restriction?.school).length) return options || [];
    const selected = new Set(selectedUuids);
    const result = [];
    for (const option of options || []) {
        let spell = option;
        if (spell.system?.school == null && spell.school == null) {
            try { spell = await resolve(option.uuid); } catch { spell = null; }
        }
        const invalidSchool = !matchesSpellSchool(spell, restriction);
        // 返回旧步骤时保留不合法的已选卡片，让用户能主动移除，而不是悄悄丢失选择。
        if (!invalidSchool || selected.has(option.uuid)) {
            result.push({ ...option, school: spell?.system?.school ?? spell?.school, invalidSchool });
        }
    }
    return result;
}
