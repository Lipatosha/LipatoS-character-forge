const GROUP_TYPES = new Set(['AND', 'OR']);
const CATEGORY_TYPES = new Set(['armor', 'focus', 'tool', 'weapon']);

function normalizeCount(value) {
    const count = Number(value ?? 1);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function normalizeWealth(wealth) {
    const formula = String(wealth ?? '').trim();
    if (!formula) return null;
    return { formula, denomination: 'gp' };
}

function getEquipmentTreeSignature(entry) {
    return [
        String(entry?._id || ''),
        String(entry?.type || ''),
        String(entry?.group || '')
    ].join(':');
}

/**
 * 有些官方书籍包会比 dnd5e 系统包少 currency 条目。
 * 只有其余树结构逐项吻合时才补，免得把同 ID 的自定义职业拼成混合数据。
 */
export function mergeStartingEquipmentCurrencyFallback(entries = [], fallbackEntries = []) {
    const source = Array.isArray(entries) ? entries : [];
    const fallback = Array.isArray(fallbackEntries) ? fallbackEntries : [];
    if (source.some(entry => entry?.type === 'currency')) return source;

    const fallbackCurrencies = fallback.filter(entry => entry?.type === 'currency');
    if (!fallbackCurrencies.length) return source;

    const sourceTree = source.map(getEquipmentTreeSignature).sort();
    const fallbackTree = fallback
        .filter(entry => entry?.type !== 'currency')
        .map(getEquipmentTreeSignature)
        .sort();
    if (sourceTree.length !== fallbackTree.length
        || sourceTree.some((signature, index) => signature !== fallbackTree[index])) {
        return source;
    }

    const sourceIds = new Set(source.map(entry => String(entry?._id || '')).filter(Boolean));
    const recovered = fallbackCurrencies
        .filter(entry => entry?._id && entry?.group && sourceIds.has(String(entry.group)))
        .filter(entry => !sourceIds.has(String(entry._id)))
        .map(entry => ({
            type: 'currency',
            count: entry.count,
            key: entry.key,
            requiresProficiency: !!entry.requiresProficiency,
            _id: entry._id,
            group: entry.group,
            sort: entry.sort
        }));

    return recovered.length ? [...source, ...recovered] : source;
}

/**
 * 将 dnd5e 的扁平 startingEquipment 数据还原成原本的逻辑树。
 * 这里不能提前展开 OR，不然后面的界面已经没法知道哪些物品互斥。
 */
export async function buildStartingEquipmentEvent({
    entries = [],
    wealth = null,
    title = '',
    sourceUuid = null,
    sourceName = '',
    resolveLinkedItem = async uuid => ({ uuid, name: uuid, img: '' }),
    resolveCategoryOptions = async () => [],
    getCategoryLabel = entry => `${entry.type}:${entry.key || ''}`
} = {}) {
    const sourceEntries = Array.isArray(entries) ? entries : [];
    const warnings = [];
    const records = sourceEntries.map((entry, index) => ({
        entry: entry || {},
        index,
        id: String(entry?._id || `equipment-entry-${index}`),
        parentId: String(entry?.group || ''),
        sort: Number.isFinite(Number(entry?.sort)) ? Number(entry.sort) : index
    }));
    const recordsById = new Map(records.map(record => [record.id, record]));
    const childrenByParent = new Map();

    for (const record of records) {
        const parentId = recordsById.has(record.parentId) ? record.parentId : '';
        if (record.parentId && !recordsById.has(record.parentId)) {
            warnings.push(`起始装备条目 ${record.id} 找不到父分组 ${record.parentId}`);
        }
        const siblings = childrenByParent.get(parentId) || [];
        siblings.push(record);
        childrenByParent.set(parentId, siblings);
    }

    for (const siblings of childrenByParent.values()) {
        siblings.sort((left, right) => left.sort - right.sort || left.index - right.index);
    }

    const buildNode = async (record, ancestors = new Set()) => {
        const entry = record.entry;
        if (ancestors.has(record.id)) {
            warnings.push(`起始装备分组 ${record.id} 出现循环引用`);
            return null;
        }

        if (GROUP_TYPES.has(entry.type)) {
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(record.id);
            const children = [];
            for (const childRecord of childrenByParent.get(record.id) || []) {
                const child = await buildNode(childRecord, nextAncestors);
                if (child) children.push(child);
            }
            return {
                id: record.id,
                kind: 'group',
                operator: entry.type,
                children
            };
        }

        if (entry.type === 'linked' && entry.key) {
            const resolved = await resolveLinkedItem(entry.key);
            return {
                id: record.id,
                kind: 'item',
                uuid: entry.key,
                name: resolved?.name || entry.key,
                img: resolved?.img || '',
                count: normalizeCount(entry.count),
                requiresProficiency: !!entry.requiresProficiency
            };
        }

        if (CATEGORY_TYPES.has(entry.type)) {
            const options = await resolveCategoryOptions(entry);
            return {
                id: record.id,
                kind: 'category',
                categoryType: entry.type,
                categoryKey: entry.key || '',
                label: getCategoryLabel(entry),
                count: normalizeCount(entry.count),
                requiresProficiency: !!entry.requiresProficiency,
                options: Array.isArray(options) ? options : []
            };
        }

        if (entry.type === 'currency') {
            return {
                id: record.id,
                kind: 'currency',
                denomination: entry.key || 'gp',
                count: normalizeCount(entry.count)
            };
        }

        warnings.push(`起始装备条目 ${record.id} 使用了不支持的类型 ${entry.type || 'unknown'}`);
        return null;
    };

    const roots = [];
    for (const rootRecord of childrenByParent.get('') || []) {
        const root = await buildNode(rootRecord);
        if (root) roots.push(root);
    }

    const normalizedWealth = normalizeWealth(wealth);
    if (roots.length === 0 && !normalizedWealth) return null;

    return {
        type: 'equipment',
        title,
        roots,
        wealth: normalizedWealth,
        warnings,
        _sourceUuid: sourceUuid,
        _sourceName: sourceName
    };
}

/**
 * 根据用户保存的分组选择计算最终装备。这个函数只返回结果，不碰 blueprint，
 * 这样创角界面和测试都不用各自再解释一遍 AND/OR。
 */
export function resolveStartingEquipmentSelection(event, selection = {}) {
    const itemCounts = new Map();
    const currencyCounts = new Map();
    const missing = [];
    const mode = selection.mode || (event?.roots?.length ? 'equipment' : 'wealth');

    const addItem = (uuid, count = 1) => {
        if (!uuid) return;
        itemCounts.set(uuid, (itemCounts.get(uuid) || 0) + normalizeCount(count));
    };

    const visit = node => {
        if (!node) return;

        if (node.kind === 'group') {
            if (node.operator === 'AND') {
                node.children.forEach(visit);
                return;
            }

            const selectedId = selection.choices?.[node.id];
            const selectedNode = node.children.find(child => child.id === selectedId);
            if (!selectedNode) {
                missing.push(`choice:${node.id}`);
                return;
            }
            visit(selectedNode);
            return;
        }

        if (node.kind === 'item') {
            addItem(node.uuid, node.count);
            return;
        }

        if (node.kind === 'category') {
            const selectedUuids = Array.isArray(selection.categories?.[node.id])
                ? selection.categories[node.id]
                : [];
            const allowedUuids = new Set((node.options || []).map(option => option.uuid));
            for (let index = 0; index < node.count; index++) {
                const uuid = selectedUuids[index];
                if (!uuid || !allowedUuids.has(uuid)) {
                    missing.push(`category:${node.id}:${index}`);
                    continue;
                }
                addItem(uuid, 1);
            }
            return;
        }

        if (node.kind === 'currency') {
            const denomination = node.denomination || 'gp';
            currencyCounts.set(denomination, (currencyCounts.get(denomination) || 0) + normalizeCount(node.count));
        }
    };

    let wealth = null;
    if (mode === 'wealth') {
        if (event?.wealth) wealth = { ...event.wealth };
        else missing.push('mode:wealth');
    } else if (mode === 'equipment') {
        for (const root of event?.roots || []) visit(root);
    } else {
        missing.push('mode');
    }

    return {
        items: Array.from(itemCounts, ([uuid, count]) => ({ uuid, count })),
        currencies: Array.from(currencyCounts, ([denomination, count]) => ({ denomination, count })),
        wealth,
        missing
    };
}
