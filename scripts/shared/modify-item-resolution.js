import { getAdvancementEntries, getAdvancementName } from '../utils/advancement-utils.js';
import { resolveItemSourceUuid } from './source-tracking.js';

function itemId(item) { return item?.id ?? item?._id; }

function findClass(actor, context) {
    return actor.items.get?.(context.classItemId)
        || actor.items.find(item => item.type === 'class' && item.system.identifier === context.classIdentifier);
}

export function collectModifyItemApplications(actor, input, initialItemIds = new Set()) {
    const context = input.context || {};
    const classItem = findClass(actor, context);
    const roots = new Set((input.scaffold?.rootItems || []).map(resolveItemSourceUuid).filter(Boolean));
    const applications = [];
    const seen = new Set();

    for (const item of actor.items) {
        const isNew = !initialItemIds.has(itemId(item))
            || (input.scope === 'character-finalize' && roots.has(resolveItemSourceUuid(item)));
        const root = item.system?.advancementRootItem;
        const linkedClass = root?.class ?? root;
        const isClassLinked = ['class', 'subclass'].includes(root?.type) && item.system?.advancementClassLinked;
        if (!isNew) {
            if (item.type === 'class' && itemId(item) !== itemId(classItem)) continue;
            if (item.type === 'subclass' && itemId(item.class) !== itemId(classItem)) continue;
            if (isClassLinked && itemId(linkedClass) !== itemId(classItem)) continue;
        }

        const workingLevel = Number(item.system?.advancementLevel
            ?? (['class', 'subclass'].includes(item.type) || isClassLinked ? input.level : actor.system?.details?.level));
        if (!Number.isFinite(workingLevel) || workingLevel < 0) continue;
        for (const entry of getAdvancementEntries(item.system?.advancement)) {
            if (entry.type !== 'ModifyItem') continue;
            const advancementId = entry.id ?? entry._id;
            const advancement = item.advancement?.byId?.[advancementId] || entry;
            if (advancement.appliesToClass === false) continue;
            const levels = advancement.levels ?? (advancement.level == null ? [] : [advancement.level]);
            for (const level of levels) {
                if (level < 0 || level > workingLevel || (!isNew && level !== workingLevel)) continue;
                const key = `${itemId(item)}.${advancementId}.${level}`;
                if (seen.has(key)) continue;
                seen.add(key);
                applications.push({ itemId: itemId(item), advancementId, level, name: getAdvancementName(advancement) });
            }
        }
    }
    return applications.sort((a, b) => a.level - b.level);
}

export async function applyModifyItemApplications(clone, applications) {
    const prepared = [];
    // 原生 apply 会静默忽略失效的效果引用；先查完整批次，避免把缺失当作完成。
    for (const application of applications) {
        const item = clone.items.get(application.itemId);
        const advancement = item?.advancement?.byId?.[application.advancementId];
        if (typeof advancement?.apply !== 'function') {
            throw new Error(`ModifyItem API unavailable: ${application.itemId}.${application.advancementId}`);
        }
        for (const change of advancement.configuration.changes) {
            const effect = change.uuid ? await fromUuid(change.uuid) : item.effects.get(change._id);
            if (!effect) throw new Error(`ModifyItem effect missing: ${application.itemId}.${application.advancementId} / ${change.uuid || change._id}`);
        }
        prepared.push({ application, advancement });
    }

    const results = [];
    for (const { application, advancement } of prepared) {
        const before = advancement.value.modified.length;
        await advancement.apply(application.level, {}, {});
        // 6.0 的原生实现会把多个 identifier 命中的同一目标展开多次。
        // 只清理本次 clone 新生成的重复记录，保留已有记录和其他来源的效果。
        const records = advancement.value.toObject().modified;
        const seenTargets = new Set(records.slice(0, before).map(record => `${record.change}.${record.item}`));
        const unique = records.slice(0, before);
        for (const record of records.slice(before)) {
            const key = `${record.change}.${record.item}`;
            if (seenTargets.has(key)) {
                clone.items.get(record.item)?.effects.delete(record.effect);
            } else {
                seenTargets.add(key);
                unique.push(record);
            }
        }
        if (unique.length !== records.length) advancement.updateSource({ 'value.modified': unique });
        results.push({ ...application, modified: advancement.value.modified.length - before });
    }
    return results;
}
