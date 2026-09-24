/**
 * Originate v2 - DataManager
 * 
 * 嘿，我是 Adrian。
 * 
 * 这儿是咱整个数据驱动架构的心脏。咱现在直接去翻 Compendium 的 Item 数据，
 * 总算是彻底甩掉了 knowledge-data.js 那个破产版的静态配置，还有那些要把人整秃头的文本解析逻辑。
 * 
 * 老话说得好，不破不立，很庆幸我当时决定推倒重来
 */

import { DND5E_MAPPING } from './mapping.js';
import { getRequiredLevel, isPlayerFeat, normalizePrerequisites } from './shared/feat-catalog.js';
import { matchesSpellSchool, normalizeSpellSchools } from './shared/spell-school-restrictions.js';
import { isAvailableSpellLevel } from './shared/advancement-choice-rules.js';
import {
    findAdvancementEntry,
    getAdvancementEntries,
    getAdvancementName,
    hasAdvancementEntries
} from './utils/advancement-utils.js';
import {
    addSpellClassMapping,
    flattenSpellReferences,
    getSpellClassesForSpell,
    normalizeItemUuid,
    normalizeSpellListId,
    normalizeSpellListIds,
    spellClassSetMatchesAny
} from './shared/spell-list-filters.js';

const CHARACTER_FORGE_IO_CONCURRENCY = 6;

const DND5E_SOURCE_PACK_NAMES = Object.freeze([
    'classes',
    'subclasses',
    'races',
    'backgrounds',
    'classfeatures',
    'spells',
    'items',
    'tradegoods'
]);

const LIPATOS_LIBRARY_MODULE_ID = 'lipatos-dnd5e-ru-library';
const LIPATOS_LIBRARY_PACK_OVERRIDES = Object.freeze({
    classes: `${LIPATOS_LIBRARY_MODULE_ID}.classes`
});

function getDnd5ePackIds() {
    const packs = Array.from(game.packs || []);
    const byLower = new Map(
        packs.map(pack => [String(pack.collection || '').toLowerCase(), pack.collection])
    );

    return DND5E_SOURCE_PACK_NAMES
        .map(name => {
            const override = LIPATOS_LIBRARY_PACK_OVERRIDES[name];
            if (override) {
                if (game.packs.get(override)) return override;
                const resolvedOverride = byLower.get(override.toLowerCase());
                if (resolvedOverride) return resolvedOverride;
            }

            const expected = `dnd5e.${name}`;
            if (game.packs.get(expected)) return expected;
            return byLower.get(expected.toLowerCase()) || null;
        })
        .filter(Boolean);
}


async function mapWithConcurrency(items, limit, worker) {
    const source = Array.from(items || []);
    if (!source.length) return [];
    const results = new Array(source.length);
    let cursor = 0;
    const count = Math.max(1, Math.min(Number(limit) || 1, source.length));
    const runners = Array.from({ length: count }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= source.length) return;
            results[index] = await worker(source[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

export class DataManager {
    constructor() {
        // 缓存已加载的 Item 数据，因为重复加载真的很蠢
        this._cache = new Map();

        // 索引缓存：按名称和 ID 索引的物品查找表
        // 就像图书馆的目录卡片，虽然现在没人用那玩意儿了
        this._indexCache = new Map(); // packId -> { byName: Map, byId: Map }
        this._indexLoaded = false;
        this._indexLoadPromise = null;
        this._typeIndex = new Map();
        this._uuidIndex = new Map();
        this._optionsCache = new Map();

        // 法术列表缓存
        // Adrian: 这里存储从 Journal Entry 解析出的职业法表
        // classSpellMap: 规范化查找键 -> Set<ClassIdentifier>
        // availableClasses: [{ id, name }, ...]
        this._classSpellMap = null;
        this._availableClasses = null;
        this._spellListsLoaded = false;
        this._spellListLoadPromise = null;

        // 属性值购点表
        // 经典的 D&D 数学，我一直不喜欢购点，因为Roll出来的点数总是更高，我还记得我的那张神魂术，有4个18的属性哈哈
        this.COST_TABLE = {
            8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5,
            14: 7, 15: 9, 16: 12, 17: 15
        };
    }

    static TYPE_TO_KEY = {
        race: 'races',
        class: 'classes',
        subclass: 'subclasses',
        background: 'backgrounds'
    };

    /**
     * 检查是否有任何数据源配置
     * @returns {boolean} 是否有数据
     */
    hasAnyData() {
        return getDnd5ePackIds().length > 0;
    }

    getExcludedItemUuidSet() {
        const configuredItems = game.settings.get('character-forge', 'excludedItems') || [];
        const values = configuredItems instanceof Set ? Array.from(configuredItems) : configuredItems;
        if (!Array.isArray(values)) return new Set();

        return new Set(values.map(normalizeItemUuid).filter(Boolean));
    }

    isItemExcluded(item, excludedItemUuids = this.getExcludedItemUuidSet()) {
        const itemUuid = normalizeItemUuid(item);
        return !!itemUuid && excludedItemUuids.has(itemUuid);
    }

    /**
     * 根据纯净语言设置清理名称
     * 
     * 有些人喜欢 "精灵 (Elf)"，有些人只想要 "精灵"。
     * 这个函数就是为了满足那些强迫症患者的。
     * 
     * @param {string} name - 原始名称，可能包含各种乱七八糟的后缀
     * @returns {string} 清理后的名称，干净得像刚洗过一样
     */
    _cleanName(name) {
        if (!name) return name;
        const text = String(name).trim();
        const russianPart = text.split(/\s*\/\s*/u)[0]?.trim() || text;

        // Книжные метки в конце названия нужны в базе, но не в интерфейсе:
        // «Археолог (TOA)» -> «Археолог», «Что-то (EGW)» -> «Что-то».
        // Удаляем только кодоподобные суффиксы в верхнем регистре, чтобы не трогать
        // содержательные скобки в настоящем названии.
        return russianPart
            .replace(/\s*\(([A-Z0-9][A-Z0-9&+.'’\- ]{1,24})\)\s*$/u, '')
            .trim();
    }

    _getLocalizedAbilityLabel(ability) {
        const key = String(ability || '').trim().toLowerCase();
        const suffix = key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
        const ownKey = suffix ? `ORIGINATE.Ability.${suffix}` : '';
        const ownLabel = ownKey ? game.i18n.localize(ownKey) : '';
        if (ownLabel && ownLabel !== ownKey) return ownLabel;

        const configLabel = CONFIG.DND5E?.abilities?.[key]?.label;
        if (configLabel) {
            const localized = game.i18n.localize(configLabel);
            if (localized && localized !== configLabel) return localized;
        }

        return key;
    }

    _localizeAbilityTokensInHtml(html) {
        if (!html || typeof html !== 'string') return html;
        if (!game.i18n.lang?.toLowerCase?.().startsWith('ru')) return html;

        try {
            const root = document.createElement('div');
            root.innerHTML = html;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const regex = /\b(str|dex|con|int|wis|cha)\b/gi;
            let node = walker.nextNode();
            while (node) {
                let text = String(node.nodeValue || '');
                text = text.replace(/Умения\s+в\s+испытаниях/giu, 'Спасброски');
                node.nodeValue = text.replace(regex, (_match, ability) =>
                    this._getLocalizedAbilityLabel(ability)
                );
                node = walker.nextNode();
            }
            return root.innerHTML;
        } catch {
            return html;
        }
    }

    _isBrokenDisplayValue(value) {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'string') return false;

        const text = value.trim().toLowerCase();
        if (!text || text === 'null' || text === 'undefined') return true;

        // 有些第三方包会在 advancement pool 里先塞占位名，真实名称只能靠 UUID 回源拿。
        // 这里把占位名也当成坏值，不然列表会信了它，hover 反而能显示真名。
        return ['unnamed item', '未命名条目'].includes(text);
    }

    _getFallbackOptionName() {
        if (game.i18n.lang?.startsWith('ru')) return 'Безымянный объект';
        return game.i18n.lang?.startsWith('zh') ? '未命名条目' : 'Unnamed Item';
    }

    _getSafeOptionName(name) {
        if (this._isBrokenDisplayValue(name)) return this._getFallbackOptionName();

        const cleaned = this._cleanName(String(name).trim());
        return this._isBrokenDisplayValue(cleaned) ? this._getFallbackOptionName() : cleaned;
    }

    _getSafeOptionImage(img) {
        return this._isBrokenDisplayValue(img) ? 'icons/svg/item-bag.svg' : img;
    }

    async _normalizeOptionDisplay(option = {}) {
        const normalized = { ...option };
        const needsName = this._isBrokenDisplayValue(normalized.name);
        const needsImg = this._isBrokenDisplayValue(normalized.img);

        if ((needsName || needsImg) && normalized.uuid) {
            try {
                const doc = await this.getDocument(normalized.uuid, needsName ? null : normalized.name);
                if (doc) {
                    if (needsName && !this._isBrokenDisplayValue(doc.name)) normalized.name = doc.name;
                    if (needsImg && !this._isBrokenDisplayValue(doc.img)) normalized.img = doc.img;
                    if (!normalized.type && doc.type) normalized.type = doc.type;
                    if (!normalized.system && doc.system) normalized.system = doc.system;
                    if (!normalized.identifier && doc.system?.identifier) normalized.identifier = doc.system.identifier;
                }
            } catch (e) {
                console.warn(`Originate | 选项显示数据回源失败: ${normalized.uuid}`, e);
            }
        }

        normalized.name = this._getSafeOptionName(normalized.name);
        normalized.img = this._getSafeOptionImage(normalized.img);

        if (this._isBrokenDisplayValue(normalized.heroImage)) {
            normalized.heroImage = normalized.img;
        }

        normalized.repeatable = !!(
            normalized.repeatable
            || normalized.prerequisites?.repeatable
            || normalized.system?.repeatable
            || normalized.system?.prerequisites?.repeatable
        );

        return normalizePrerequisites(normalized);
    }

    async normalizeChoiceOption(item = {}) {
        const hasLevel = item.system?.prerequisites?.level != null
            || item.prerequisites?.level != null || item.minLevel != null;
        // 名称已经齐全不代表规则齐全；只在缺规则时回源，不能用名称决定是否读取先决条件。
        if (!hasLevel && item.uuid && (!item.type || item.type === 'feat')) {
            const doc = await this.getDocument(item.uuid);
            if (doc) item = {
                ...item, type: doc.type, system: doc.system,
                name: this._isBrokenDisplayValue(item.name) ? doc.name : item.name,
                img: this._isBrokenDisplayValue(item.img) ? doc.img : item.img
            };
        }
        return this._normalizeOptionDisplay(item);
    }

    async _enrichNestedChoiceDisplays(events = []) {
        for (const event of events || []) {
            if (event?.type !== 'choice' || !event.pool) continue;

            const pool = Array.isArray(event.pool) ? event.pool : Array.from(event.pool || []);
            event.pool = await Promise.all(pool.map(item => this.normalizeChoiceOption(item)));
        }
    }

    /**
     * 获取指定类型的选项列表
     * 
     * 这是一个大工程。我们会先像猎犬一样在配置的合集包里嗅探，众神之父赐予我视野！
     * 然后再把手动配置的列表加进来。
     * 
     * @param {string} type - 类型: 'race', 'class', 'subclass', 'background'
     * @param {Object} context - 上下文，用于过滤（比如别给野蛮人推荐法师子职）
     * @param {Object} options - 额外选项
     * @param {boolean} options.indexOnly - 是否只返回索引数据（不加载完整文档），为了速度！
     * @param {boolean} options.includeExcluded - 是否包含被排除的物品（配置界面需要显示它们）
     * @returns {Promise<Array>} 选项列表
     */
    async getOptions(type, context = {}, options = {}) {
        await this.loadSourcePacksIndex();

        const safeOptions = (options && typeof options === 'object') ? options : {};
        const indexOnly = !!safeOptions.indexOnly;
        const includeExcluded = !!safeOptions.includeExcluded;
        const classIdentifier = context?.classIdentifier || null;
        const cacheKey = JSON.stringify([type, indexOnly, includeExcluded, classIdentifier]);
        const cached = this._optionsCache.get(cacheKey);
        if (cached) return cached;

        const excludedItemUuids = includeExcluded ? new Set() : this.getExcludedItemUuidSet();
        let searchTypes;
        if (type === 'feature' || type === 'feat') searchTypes = ['feat'];
        else if (type === 'item') searchTypes = ['equipment', 'weapon', 'consumable', 'tool', 'loot', 'backpack'];
        else searchTypes = [type];

        const candidateMap = new Map();
        for (const searchType of searchTypes) {
            for (const entry of this._typeIndex.get(searchType) || []) {
                if (entry.type === 'feat') {
                    const subtype = entry.system?.type?.value;
                    if (type === 'feat' && !isPlayerFeat(entry)) continue;
                    if (type === 'feature' && subtype === 'feat') continue;
                }
                if (this.isItemExcluded(entry, excludedItemUuids)) continue;
                candidateMap.set(entry.uuid, entry);
            }
        }

        // Subclasses can now be filtered from the compendium index on dnd5e 6.x.
        // Only fall back to loading a document when a third-party pack omitted classIdentifier.
        let candidates = Array.from(candidateMap.values());
        if (type === 'subclass' && classIdentifier) {
            const filtered = await mapWithConcurrency(candidates, CHARACTER_FORGE_IO_CONCURRENCY, async entry => {
                const indexedClass = entry.system?.classIdentifier;
                if (indexedClass != null) return indexedClass === classIdentifier ? entry : null;
                const doc = await this.getDocument(entry.uuid);
                return doc?.system?.classIdentifier === classIdentifier ? entry : null;
            });
            candidates = filtered.filter(Boolean);
        }

        const optionsMap = new Map();
        const loaded = await mapWithConcurrency(candidates, CHARACTER_FORGE_IO_CONCURRENCY, async entry => {
            try {
                if (indexOnly) {
                    return await this._normalizeOptionDisplay({
                        uuid: entry.uuid,
                        id: entry._id,
                        name: entry.name,
                        img: entry.img,
                        type: entry.type,
                        identifier: entry.system?.identifier,
                        classIdentifier: entry.system?.classIdentifier,
                        system: entry.system,
                        repeatable: !!(entry.system?.repeatable || entry.system?.prerequisites?.repeatable)
                    });
                }
                return await this._loadOption(entry.uuid, type);
            } catch (error) {
                console.error(`Character Forge | Failed to load option ${entry.uuid}`, error);
                return null;
            }
        });
        for (const option of loaded) if (option?.uuid) optionsMap.set(option.uuid, option);

        // Manual sources are usually a small list. Reuse the global UUID index before touching documents.
        const sources = game.settings.get('character-forge', 'sources') || {};
        const configKey = DataManager.TYPE_TO_KEY[type] || `${type}s`;
        const manualUuids = sources[configKey] || [];
        const manualLoaded = await mapWithConcurrency(manualUuids, CHARACTER_FORGE_IO_CONCURRENCY, async uuid => {
            if (!includeExcluded && this.isItemExcluded(uuid, excludedItemUuids)) return null;
            try {
                if (indexOnly) {
                    const entry = this._uuidIndex.get(normalizeItemUuid(uuid)) || this._uuidIndex.get(uuid);
                    if (entry) {
                        return await this._normalizeOptionDisplay({
                            uuid,
                            id: entry._id,
                            name: entry.name,
                            img: entry.img,
                            type: entry.type,
                            identifier: entry.system?.identifier,
                            classIdentifier: entry.system?.classIdentifier,
                            system: entry.system,
                            repeatable: !!(entry.system?.repeatable || entry.system?.prerequisites?.repeatable)
                        });
                    }
                    const item = await fromUuid(uuid);
                    if (!item) return null;
                    return await this._normalizeOptionDisplay({
                        uuid,
                        id: item.id,
                        name: this._cleanName(item.name),
                        img: item.img,
                        type: item.type,
                        identifier: item.system?.identifier,
                        classIdentifier: item.system?.classIdentifier,
                        system: item.system,
                        repeatable: !!(item.system?.repeatable || item.system?.prerequisites?.repeatable)
                    });
                }
                const option = await this._loadOption(uuid, type);
                if (type === 'subclass' && classIdentifier && option?.classIdentifier && option.classIdentifier !== classIdentifier) return null;
                return option;
            } catch (error) {
                console.error(`Character Forge | Failed to load manual option ${uuid}`, error);
                return null;
            }
        });
        for (const option of manualLoaded) if (option?.uuid) optionsMap.set(option.uuid, option);

        const result = Array.from(optionsMap.values())
            .filter(option => type !== 'feat' || isPlayerFeat(option))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        this._optionsCache.set(cacheKey, result);
        return result;
    }

    /**
     * 加载单个选项的数据
     * 
     * 就像把一个包裹拆开，看看里面到底有什么。
     * 
     * @param {string} uuid - Item 的 UUID
     * @param {string} type - 类型
     * @returns {Promise<Object|null>} 选项数据
     */
    async _loadOption(uuid, type) {
        // 检查缓存
        if (this._cache.has(uuid)) {
            return this._cache.get(uuid);
        }

        const item = await fromUuid(uuid);
        if (!item) {
            console.warn(`Originate | Unable to load Item: ${uuid}`);
            return null;
        }

        // 获取自定义描述
        const customDescriptions = game.settings.get('character-forge', 'customDescriptions') || {};
        const typeDescriptions = customDescriptions[type] || {};
        const customDesc = typeDescriptions[uuid];

        // Keep list loading cheap. Enriching every description during a list scan is one of the
        // most expensive operations in the original module; enrichment is now lazy and happens
        // only for the selected option.
        const rawDesc = item.system.description?.value || '';
        const enrichedDesc = rawDesc;

        // 构建选项数据 - 直接从 Item 读取，不再硬编码
        // 终于不用手动维护那些该死的 JSON 文件了！
        const option = {
            id: item.id,
            uuid: uuid,
            name: this._cleanName(item.name),
            img: item.img,
            type: 'item',

            // 描述 - 始终使用 item 原始描述（经 enrichHTML 渲染）
            // 自定义描述不覆盖详情面板，只影响 tagline
            description: enrichedDesc,

            // 自定义描述（仅用于 tagline 等摘要场景）
            customDescription: customDesc || '',

            // 升级数据 - 直接引用，不做转换
            advancement: getAdvancementEntries(item.system.advancement),

            // 用于 UI 显示的增强数据
            // heroImage 优先使用 Item 自带的图片，PHB 图片增强将在 context-mixin 中处理
            heroImage: item.img,
            tagline: customDesc ? this._extractTagline({ system: { description: { value: customDesc } }, type: item.type }) : this._extractTagline(item),
            coreTraits: this._extractCoreTraits(item, type),

            // 子职专用：职业标识符
            classIdentifier: item.system.classIdentifier || null,

            // 职业专用：标识符（用于子职匹配和 PHB 图片映射）
            identifier: item.system.identifier || item.id,

            // 职业专用：子职选取等级
            subclassLevel: type === 'class' ? (findAdvancementEntry(item.system.advancement, a => a.type === 'Subclass')?.level ?? 3) : undefined,

            // 先决条件（用于等级过滤）
            // 确保 level 是数字，别让字符串混进来
            prerequisites: {
                ...item.system.prerequisites,
                level: item.system.prerequisites?.level ? parseInt(item.system.prerequisites.level) : 0
            },
            // 列表筛选依赖结构化类型；完整加载不能丢掉索引里已有的分类。
            system: { type: item.system.type, prerequisites: item.system.prerequisites },

            // dnd5e 原生专长页上的“可重复选择”勾选在这里。UI 层只认这个扁平字段，
            // 不然同一份规则会在 ASI 专长、ItemChoice 专长里各自猜一遍。
            repeatable: !!(item.system.repeatable || item.system.prerequisites?.repeatable)
        };

        const normalizedOption = await this._normalizeOptionDisplay(option);

        // 缓存
        this._cache.set(uuid, normalizedOption);

        return normalizedOption;
    }

    /**
     * 加载配置的数据源合集索引
     * 用于后备查找（当 UUID 失效时按名称搜索）
     * 
     * 这是一个备用计划，因为 UUID 有时候比我前女友的心变得还快，也许，没那么慢
     */
    async loadSourcePacksIndex() {
        if (this._indexLoaded) return;
        if (this._indexLoadPromise) return this._indexLoadPromise;

        this._indexLoadPromise = (async () => {
            const sourcePacks = getDnd5ePackIds();

            this._indexCache.clear();
            this._typeIndex.clear();
            this._uuidIndex.clear();
            this._optionsCache.clear();

            const fields = [
                'name', 'type', 'img', 'system.type.value', 'system.type.subtype',
                'system.prerequisites.level', 'system.prerequisites.items', 'system.prerequisites.repeatable', 'system.repeatable',
                'system.level', 'system.school', 'system.sourceItem', 'system.sourceClass', 'system.identifier',
                'system.classIdentifier'
            ];

            await mapWithConcurrency(sourcePacks, Math.min(4, CHARACTER_FORGE_IO_CONCURRENCY), async packId => {
                const pack = game.packs.get(packId);
                if (!pack) {
                    console.warn(`Character Forge | Compendium pack not found: ${packId}`);
                    return;
                }
                try {
                    const index = await pack.getIndex({ fields });
                    const byName = new Map();
                    const byId = new Map();
                    for (const sourceEntry of index) {
                        const entry = {
                            ...sourceEntry,
                            name: this._cleanName(sourceEntry.name),
                            uuid: `Compendium.${packId}.Item.${sourceEntry._id}`,
                            packId
                        };
                        const nameLower = String(entry.name || '').toLowerCase();
                        if (!byName.has(nameLower)) byName.set(nameLower, []);
                        byName.get(nameLower).push(entry);
                        byId.set(entry._id, entry);
                        this._uuidIndex.set(entry.uuid, entry);
                        this._uuidIndex.set(normalizeItemUuid(entry.uuid), entry);
                        if (!this._typeIndex.has(entry.type)) this._typeIndex.set(entry.type, []);
                        this._typeIndex.get(entry.type).push(entry);
                    }
                    this._indexCache.set(packId, { byName, byId });
                } catch (error) {
                    console.error(`Character Forge | Failed to index ${packId}`, error);
                }
            });

            this._indexLoaded = true;
        })();

        try {
            return await this._indexLoadPromise;
        } finally {
            this._indexLoadPromise = null;
        }
    }

    /**
     * 按名称在数据源中查找物品
     * @param {string} name - 物品名称
     * @param {string} type - 可选的物品类型过滤
     * @returns {Promise<Object|null>} 找到的物品索引条目（包含 uuid）
     */
    async findByName(name, type = null) {
        await this.loadSourcePacksIndex();

        const nameLower = name.toLowerCase();

        for (const [packId, index] of this._indexCache) {
            const matches = index.byName.get(nameLower);
            if (matches && matches.length > 0) {
                // 如果指定了类型，过滤匹配
                if (type) {
                    const typeMatch = matches.find(m => m.type === type);
                    if (typeMatch) return typeMatch;
                } else {
                    return matches[0];
                }
            }
        }

        return null;
    }

    /**
     * 按 ID 在数据源中查找物品
     * @param {string} id - 物品 ID
     * @returns {Promise<Object|null>} 找到的物品索引条目（包含 uuid）
     */
    async findById(id) {
        await this.loadSourcePacksIndex();

        for (const [packId, index] of this._indexCache) {
            if (index.byId.has(id)) {
                return index.byId.get(id);
            }
        }

        return null;
    }

    /**
     * 加载法术列表数据源
     * 
     * Adrian: 这是法表解析的核心。我们从配置的日志文本中读取职业法表，
     * 建立法术 UUID 到职业 ID 的映射。支持完整合集和单独职业法表。
     * 
     * @returns {Promise<void>}
     */
    async loadSpellListSources(forceReload = false) {
        if (this._spellListsLoaded && !forceReload) return;
        if (this._spellListLoadPromise && !forceReload) return this._spellListLoadPromise;
        if (forceReload && this._spellListLoadPromise) {
            try { await this._spellListLoadPromise; } catch { /* retry below */ }
        }

        const task = this._loadSpellListSourcesInternal(forceReload);
        this._spellListLoadPromise = task;
        try {
            return await task;
        } finally {
            if (this._spellListLoadPromise === task) this._spellListLoadPromise = null;
        }
    }

    async _loadSpellListSourcesInternal(forceReload = false) {
        if (this._spellListsLoaded && !forceReload) return;

        // 强制刷新时重置标志
        if (forceReload) {
            this._spellListsLoaded = false;
        }

        window.OriginateLog?.('Originate | 加载法术列表数据源...');

        const spellListSources = game.settings.get('character-forge', 'spellListSources') || [];
        const excludedItems = new Set(game.settings.get('character-forge', 'excludedItems') || []);
        const sourcePacks = getDnd5ePackIds();

        // 初始化映射
        const classSpellMap = new Map(); // SpellUUID -> Set<ClassIdentifier>
        const classesMap = new Map(); // ClassIdentifier -> ClassName
        this._scannedJournals = new Map(); // UUID -> JournalInfo

        // 辅助函数：解析单个 Journal Entry
        const parseJournal = async (journal) => {
            if (!journal) return 0;

            // 记录到已扫描列表
            const spellPages = journal.pages.filter(p => p.type === 'spells' && p.system?.identifier);
            if (spellPages.length === 0) return 0;

            this._scannedJournals.set(journal.uuid, {
                uuid: journal.uuid,
                name: journal.name,
                img: journal.img,
                classCount: spellPages.length,
                classes: spellPages.map(p => ({ id: p.system.identifier, name: p.name }))
            });

            for (const page of spellPages) {
                if (excludedItems.has(page.uuid)) {
                    continue;
                }

                const classId = normalizeSpellListId(page.system.identifier);
                if (!classId) continue;
                const className = this._cleanName(page.name);
                const spellRefs = flattenSpellReferences(page.system.spells || []);

                // 记录职业信息（后来的会覆盖先前的，实现去重）
                classesMap.set(classId, className);

                // Foundry 的 spell list 页不保证永远给纯字符串 UUID，这里统一收成可匹配的查找键。
                for (const spellRef of spellRefs) {
                    addSpellClassMapping(classSpellMap, spellRef, classId);
                }
            }

            return spellPages.length;
        };

        // 1. 智能扫描：根据已选数据源推断相关模块的法术列表期刊
        // 策略：找出活越模块，遍历其下的 Journal 合集，筛选名称包含关键词的期刊
        const activeModules = new Set();
        for (const packId of sourcePacks) {
            const pack = game.packs.get(packId);
            if (pack) {
                const moduleId = pack.metadata.packageName || pack.metadata.package;
                if (moduleId) activeModules.add(moduleId);
            }
        }

        window.OriginateLog?.(`Originate | 法表扫描模块: ${Array.from(activeModules).join(', ')}`);

        // KEYWORDS unused
        // const KEYWORDS = ...;

        for (const pack of game.packs) {
            if (pack.documentName !== 'JournalEntry') continue;

            const moduleId = pack.metadata.packageName || pack.metadata.package;
            const isFromActiveModule = activeModules.has(moduleId);
            const isExplicitlySelected = sourcePacks.includes(pack.collection);

            if (isFromActiveModule || isExplicitlySelected) {
                try {
                    // 获取索引以进行名称过滤
                    const index = await pack.getIndex();

                    // 筛选可能的法术列表期刊
                    // 不再过滤名称，扫描所有期刊
                    // 将 Collection 转换为 Array 以确保 .length 属性可用
                    const candidateEntries = Array.from(index);
                    let matchedJournalCount = 0;
                    let spellPageCount = 0;

                    if (candidateEntries.length > 0) {
                        const pageCounts = await mapWithConcurrency(candidateEntries, CHARACTER_FORGE_IO_CONCURRENCY, async entry => {
                            const journal = await pack.getDocument(entry._id);
                            return await parseJournal(journal);
                        });
                        matchedJournalCount = pageCounts.filter(count => count > 0).length;
                        spellPageCount = pageCounts.reduce((sum, count) => sum + (count || 0), 0);
                    }

                    window.OriginateLog?.(
                        `Originate | 法表扫描完成: ${pack.metadata.label} (${pack.collection})，` +
                        `检查 ${candidateEntries.length} 篇，命中 ${matchedJournalCount} 篇，` +
                        `跳过 ${candidateEntries.length - matchedJournalCount} 篇，法表页 ${spellPageCount} 个`
                    );
                } catch (error) {
                    console.error(`Originate | 扫描期刊合集失败 ${pack.collection}:`, error);
                }
            }
        }

        // 2. 处理手动配置的法术列表来源（如果有的话，会覆盖自动扫描的）
        for (const journalUuid of spellListSources) {
            try {
                const journal = await fromUuid(journalUuid);
                if (!journal || journal.documentName !== 'JournalEntry') {
                    console.warn(`Originate | 无效的 Journal Entry UUID: ${journalUuid}`);
                    continue;
                }

                window.OriginateLog?.(`Originate | 解析手动配置期刊: ${journal.name}`);
                await parseJournal(journal);
            } catch (error) {
                console.error(`Originate | 加载期刊失败 ${journalUuid}:`, error);
            }
        }

        // 3. 合并用户自定义的法术列表覆盖
        // Adrian: 用户通过拖拽或右键菜单手动添加的法术
        const customOverrides = game.settings.get('character-forge', 'customSpellListOverrides') || {};
        for (const [rawClassId, spellUuids] of Object.entries(customOverrides)) {
            if (!Array.isArray(spellUuids)) continue;
            const classId = normalizeSpellListId(rawClassId);
            if (!classId) continue;

            for (const spellUuid of spellUuids) {
                addSpellClassMapping(classSpellMap, spellUuid, classId);
            }

            // 确保职业在可用列表中
            if (!classesMap.has(classId)) {
                // 尝试从已知职业中查找名称
                const knownClass = (await this.getOptions('class', {}, { indexOnly: true }))
                    .find(c => normalizeSpellListId(c.identifier) === classId);
                classesMap.set(classId, knownClass?.name || classId);
            }
        }
        window.OriginateLog?.(`Originate | 自定义覆盖合并完成: ${Object.keys(customOverrides).length} 个职业有自定义法术`);

        // 转换为数组
        this._availableClasses = Array.from(classesMap.entries()).map(([id, name]) => ({ id, name }));
        this._classSpellMap = classSpellMap;
        this._spellListsLoaded = true;

        window.OriginateLog?.(`Originate | 法术列表加载完成: ${this._availableClasses.length} 个职业, ${classSpellMap.size} 个法术`);
    }

    async enrichOptionDescription(option) {
        if (!option || option._descriptionEnriched) return option?.description || '';
        const raw = option.description || '';
        if (!raw) {
            option._descriptionEnriched = true;
            return '';
        }
        try {
            const doc = option.uuid ? await this.getDocument(option.uuid) : null;
            const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
            option.description = await TE.enrichHTML(raw, { async: true, relativeTo: doc || undefined });
            option.description = this._localizeAbilityTokensInHtml(option.description);
        } catch (error) {
            console.warn('Character Forge | Description enrichment failed; using raw HTML', error);
            option.description = this._localizeAbilityTokensInHtml(raw);
        }
        option._descriptionEnriched = true;
        return option.description || this._localizeAbilityTokensInHtml(raw);
    }

    /**
     * 获取可用的法表职业列表
     * @returns {Promise<Array>} [{ id, name }, ...]
     */
    async getAvailableSpellClasses() {
        await this.loadSpellListSources();
        return this._availableClasses || [];
    }

    /**
     * 检查法术是否属于指定职业
     * @param {string} spellUuid - 法术 UUID
     * @param {Set|Array} classIds - 职业ID集合或数组
     * @returns {Promise<boolean>}
     */
    async isSpellInClasses(spellUuid, classIds) {
        await this.loadSpellListSources();
        const spellClasses = getSpellClassesForSpell(this._classSpellMap, spellUuid);
        return spellClassSetMatchesAny(spellClasses, classIds);
    }

    /**
     * 获取职业法术映射表
     * Adrian: 暴露给 UI 用于按职业筛选法术
     * @returns {Promise<Map<string, Set<string>>>} 规范化法术查找键 -> Set of classIds
     */
    async getClassSpellMap() {
        await this.loadSpellListSources();
        return this._classSpellMap;
    }

    /**
     * 获取 Item 文档
     * 如果 UUID 查找失败，尝试在数据源中按名称/ID 查找
     * @param {string} uuid - Item 的 UUID
     * @param {string} fallbackName - 可选的后备名称（用于当 UUID 失效时）
     * @returns {Promise<Item|null>}
     */
    async getDocument(uuid, fallbackName = null) {
        // 首先尝试直接通过 UUID 获取
        try {
            const doc = await fromUuid(uuid);
            if (doc) return doc;
        } catch (e) {
            console.warn(`Originate | Direct UUID lookup failed: ${uuid}`);
        }

        // UUID 失败，尝试从 UUID 中提取 ID
        if (uuid && uuid.includes('.')) {
            const parts = uuid.split('.');
            const itemId = parts[parts.length - 1];

            // 尝试在数据源中按 ID 查找
            const byIdMatch = await this.findById(itemId);
            if (byIdMatch) {
                window.OriginateLog(`Fallback lookup by ID successful: ${itemId} -> ${byIdMatch.uuid}`);
                try {
                    return await fromUuid(byIdMatch.uuid);
                } catch (e) {
                    console.error(`Originate | Fallback UUID load failed: ${byIdMatch.uuid}`, e);
                }
            }
        }

        // 如果有后备名称，尝试按名称查找
        if (fallbackName) {
            const byNameMatch = await this.findByName(fallbackName);
            if (byNameMatch) {
                window.OriginateLog(`Fallback lookup by name successful: ${fallbackName} -> ${byNameMatch.uuid}`);
                try {
                    return await fromUuid(byNameMatch.uuid);
                } catch (e) {
                    console.error(`Originate | Fallback UUID load failed: ${byNameMatch.uuid}`, e);
                }
            }
        }

        console.error(`Originate | Unable to get document: ${uuid}${fallbackName ? ` (fallback name: ${fallbackName})` : ''}`);
        return null;
    }

    /**
     * 获取指定等级的升级数据
     * @param {string} uuid - Item 的 UUID
     * @param {number} level - 目标等级
     * @returns {Promise<Array>} 升级事件列表
     */
    async getAdvancement(uuid, level = 1, context = {}) {
        const item = await this.getDocument(uuid);
        if (!item) return [];

        const advancements = getAdvancementEntries(item.system.advancement);

        window.OriginateLog(`getAdvancement: uuid=${uuid}, level=${level}, total advancements=${advancements.length}`);

        // 过滤出当前等级的升级
        // 包括：
        // 1. level 属性等于当前等级的 Advancement
        // 2. 多等级配置的 Advancement（如 ItemChoice、Trait），在 configuration.choices 中有当前等级的配置
        const levelAdvancements = advancements.filter(a => {
            // 1. 直接匹配等级
            if (a.level === level) {
                window.OriginateLog(`getAdvancement: Matched ${a.type} "${getAdvancementName(a)}" (level=${a.level})`);
                return true;
            }

            // 2. 如果 Advancement 没有 level 属性，且请求的是 Level 0，则包含它 (兼容性处理)
            // 注意：不再将 level=undefined 视为 Level 1，因为调用方会分别获取 Level 0 和 Level 1
            if (a.level === undefined && level === 0) {
                // 【修复】对于多等级配置类型（ItemChoice, Trait），不要默认视为 Level 0
                // 它们应该通过后续的多等级配置检查来决定是否包含
                // 这防止了像术士超魔法这样的多等级特性被错误地视为 Level 0 特性
                if (a.type !== 'ItemChoice' && a.type !== 'Trait') {
                    window.OriginateLog(`getAdvancement: Matched ${a.type} "${getAdvancementName(a)}" (level=undefined, treated as Level 0)`);
                    return true;
                }
            }

            // 3. 检查多等级配置（ItemChoice 和某些 Trait）
            // 只有当 Advancement 没有明确的 level 属性，或者 level 属性不匹配时，才检查多等级配置

            // 【修复】如果 level 属性已设置且不为 0，说明这个 Advancement 有明确的触发等级，不应该通过多等级配置被包含
            // 这防止了像术士超魔法（level=2）这样的特性在 Level 1 被错误包含
            if (a.level !== undefined && a.level !== 0 && a.level !== level) {
                return false;
            }

            if (a.type === 'ItemChoice' || a.type === 'Trait') {
                const choices = a.configuration?.choices;
                // 如果 choices 是一个对象（按等级映射），检查是否有当前等级的配置
                if (choices && typeof choices === 'object' && !Array.isArray(choices) && !(choices instanceof Set)) {
                    // 检查是否有当前等级的键
                    const levelConfig = choices[String(level)];

                    if (levelConfig !== undefined) {
                        // 检查替换配置：DnD5e 使用 levelConfig.replacement
                        const replacement = levelConfig.replacement === true;

                        // 对于 ItemChoice：
                        // - count > 0 表示可以选择新的物品
                        // - replacement === true 表示可以替换之前的选择
                        // 如果是替换模式且没有指定 count，默认为 0
                        // 使用 ?? 运算符处理 null/undefined
                        // ⚠ 同步点：wizard-ui-mixin.js _renderItemChoice() 里有同样的兜底逻辑，改这里要一起改
                        const count = levelConfig.count ?? (replacement ? 0 : 1);

                        if (count > 0 || replacement) {
                            window.OriginateLog(`getAdvancement: Matched ${a.type} "${getAdvancementName(a)}" (level=${level}, count=${count}, replacement=${replacement})`);
                            return true;
                        } else {
                            window.OriginateLog(`getAdvancement: Skipped ${a.type} "${getAdvancementName(a)}" (level=${level}, count=${count}, replacement=${replacement})`);
                        }
                    }
                }
            }

            return false;
        });

        window.OriginateLog(`getAdvancement: ${levelAdvancements.length} advancements after filtering`);

        // 转换为 UI 可用的格式，传入当前等级以便正确提取配置
        return this._convertAdvancementsToUI(levelAdvancements, item, level, context);
    }

    /**
     * getLevelAdvancement 的别名，保持向后兼容
     * @param {string} uuid - Item 的 UUID
     * @param {number} level - 目标等级
     * @returns {Promise<Array>} 升级事件列表
     */
    async getLevelAdvancement(uuid, level = 1, context = {}) {
        return this.getAdvancement(uuid, level, context);
    }

    /**
     * 读取嵌套 Advancement 时，优先看当前触发等级，再补 0/1 级的基础配置。
     * 有些特性像套娃一样，当前等级有一层选择，0/1 级还有一层底座，不一起看就容易漏。
     * 
     * @param {string} uuid - Item UUID
     * @param {number} level - 当前触发等级
     * @param {Object} context - Advancement 上下文
     * @returns {Promise<Array>} 合并后的事件列表
     */
    async getNestedAdvancementEvents(uuid, level = 1, context = {}) {
        const levels = [];
        const pushLevel = (value) => {
            const num = Number(value);
            if (!Number.isFinite(num) || num < 0) return;
            if (!levels.includes(num)) levels.push(num);
        };

        // 当前等级优先，同一个 Advancement 如果跨等级复用，先吃当前这份配置。
        pushLevel(level);
        pushLevel(0);
        pushLevel(1);

        const merged = [];
        const seen = new Set();

        for (const targetLevel of levels) {
            const events = await this.getLevelAdvancement(uuid, targetLevel, context);
            for (const event of events) {
                const advId = event?._original?._id || event?.id || event?.title || `level-${targetLevel}`;
                const key = `${advId}::${event?.type || 'unknown'}`;
                if (seen.has(key)) continue;
                seen.add(key);
                event.sourceLevel ??= targetLevel;
                merged.push(event);
            }
        }

        return merged;
    }

    /**
     * 将系统 Advancement 数据转换为 UI 格式
     * @param {Array} advancements - 原始 advancement 数组
     * @param {Item} sourceItem - 来源 Item
     * @param {number} level - 当前等级（用于提取多等级配置）
     * @param {Object} context - 上下文信息（用于过滤，如 isMulticlassing）
     * @returns {Array} UI 格式的事件列表
     */
    _convertAdvancementsToUI(advancements, sourceItem, level = 1, context = {}) {
        const results = [];

        for (const adv of advancements) {
            // 统一 classRestriction 过滤（适用于所有 Advancement 类型）
            const restriction = adv.classRestriction || adv.configuration?.classRestriction;
            if (restriction) {
                const isMulti = context.isMulticlassing || false;
                if (restriction === 'secondary' && !isMulti) {
                    window.OriginateLog(`_convertAdvancementsToUI: Skipping ${adv.type} "${getAdvancementName(adv)}" (multiclass only, currently primary)`);
                    continue;
                }
                if (restriction === 'primary' && isMulti) {
                    window.OriginateLog(`_convertAdvancementsToUI: Skipping ${adv.type} "${getAdvancementName(adv)}" (primary only, currently multiclassing)`);
                    continue;
                }
            }

            switch (adv.type) {
                case 'ItemGrant':
                    results.push(this._convertItemGrant(adv));
                    break;

                case 'ItemChoice':
                    {
                        const choice = this._convertItemChoice(adv, level);
                        if (choice) {
                            // 保留实际持有 advancement 的物品，不能把职业授予的特性误当成职业基础选择。
                            choice.sourceItem = {
                                type: sourceItem?.type,
                                identifier: sourceItem?.system?.identifier,
                                uuid: sourceItem?.uuid
                            };
                            results.push(choice);
                        }
                    }
                    break;

                case 'Trait':
                    results.push(...this._convertTrait(adv, level, context));
                    break;

                case 'AbilityScoreImprovement':
                    results.push(this._convertASI(adv));
                    break;

                case 'Size':
                    results.push(this._convertSize(adv));
                    break;

                case 'HitPoints':
                    results.push(this._convertHitPoints(adv, sourceItem));
                    break;

                case 'Subclass':
                    results.push({
                        type: 'subclass',
                        title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.Subclass"),
                        classIdentifier: sourceItem.system.identifier
                    });
                    break;

                case 'ScaleValue':
                    // ScaleValue 不需要 UI 交互，但需要保留
                    results.push({
                        type: 'scaleValue',
                        title: getAdvancementName(adv),
                        identifier: adv.configuration?.identifier,
                        _original: adv
                    });
                    break;

                case 'ModifyItem':
                    // 自动效果要等本次物品和专长全部取得后，由最终结算阶段处理。
                    break;

                default:
                    window.OriginateLog(`Unhandled advancement type: ${adv.type}`);
            }
        }

        for (const entry of results) {
            if (!entry) continue;
            entry.sourceLevel ??= level;
        }

        return results;
    }

    /**
     * 转换 ItemGrant 类型
     * 
     * 这里是专长解析的重灾区。
     * 以前我们只是把专长当成普通物品扔进去，完全无视了它内部的 Advancement。
     * 结果就是"技艺专家"这种需要选择技能熟练和专精的专长，用户根本没机会选。
     * 
     * 现在我们要做的是：检测授予的物品是否是专长，如果是，就把它的 Advancement 也挖出来。
     * 这就像拆俄罗斯套娃，一层套一层，烦死了。
     */
    _convertItemGrant(adv) {
        const configItems = adv.configuration?.items;
        const itemsArray = configItems instanceof Set ? Array.from(configItems) : (configItems || []);

        const items = itemsArray.map(entry => {
            // entry 可能是 UUID 字符串或对象 {uuid, optional}
            const uuid = typeof entry === 'string' ? entry : entry.uuid;
            const optional = typeof entry === 'object' ? entry.optional : false;

            return {
                uuid: uuid,
                optional: optional,
                // name 和 img 将在渲染时异步加载
                name: null,
                img: null,
                // Adrian: 新增字段，标记这个物品是否需要进一步处理其内部 Advancement
                // 这个标记会在 enrichOptions 中被填充
                hasNestedAdvancement: false,
                nestedAdvancements: []
            };
        });

        return {
            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
            type: 'features',
            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.Features"),
            items: items,
            _original: adv
        };
    }

    /**
     * 转换 ItemChoice 类型
     * @param {Object} adv - Advancement 数据
     * @param {number} level - 当前等级
     */
    _convertItemChoice(adv, level = 1) {
        const config = adv.configuration || {};

        // 处理多等级配置
        // choices 可能是：
        // 1. 简单对象 { count: 1 }
        // 2. 按等级映射的对象 { "1": { count: 1 }, "2": { count: 2 }, ... }
        let count = 1;
        let replacement = config.allowReplacement || false; // 默认值

        if (config.choices) {
            if (typeof config.choices === 'object' && !Array.isArray(config.choices)) {
                // 检查是否是按等级映射
                const levelConfig = config.choices[String(level)];
                const hasSimpleChoiceConfig = config.choices.count !== undefined
                    || config.choices.replacement !== undefined
                    || config.choices.pool !== undefined;
                const isLevelMappedChoice = !hasSimpleChoiceConfig
                    && Object.keys(config.choices).some(key => Number.isInteger(Number(key)));
                if (levelConfig) {
                    // 如果 levelConfig 存在，优先使用其中的配置
                    if (levelConfig.replacement !== undefined) {
                        replacement = levelConfig.replacement;
                    }

                    // 如果是替换模式且没有指定 count，默认为 0
                    // 使用 ?? 运算符处理 null/undefined
                    count = levelConfig.count ?? (replacement ? 0 : 1);
                } else if (config.choices.count !== undefined) {
                    // 简单对象格式
                    count = config.choices.count;
                } else if (isLevelMappedChoice) {
                    return null;
                }
            }
        }

        if (count <= 0 && !replacement) return null;

        // 处理 pool - 可能是 UUID 字符串数组或对象数组
        const configPool = config.pool;
        const poolArray = configPool instanceof Set ? Array.from(configPool) : (configPool || []);

        const pool = poolArray.map(entry => {
            const uuid = typeof entry === 'string' ? entry : entry.uuid;
            return {
                uuid: uuid,
                name: null,
                img: null
            };
        });

        // 规范化 restriction.list
        // Foundry 有时会将数组序列化为对象（类数组对象），导致 Array.isArray 检查失败
        let restriction = config.restriction ? foundry.utils.deepClone(config.restriction) : null;
        if (restriction?.school != null) restriction.school = normalizeSpellSchools(restriction.school);
        if (restriction && restriction.list) {
            if (restriction.list instanceof Set) {
                restriction.list = Array.from(restriction.list);
            } else if (typeof restriction.list === 'object' && !Array.isArray(restriction.list)) {
                // 处理类数组对象 {0: "class:cleric", 1: "class:druid"}
                // 或者是普通对象，我们取其值
                restriction.list = Object.values(restriction.list);
            } else if (typeof restriction.list === 'string') {
                restriction.list = [restriction.list];
            }
        }

        return {
            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
            type: 'choice',
            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.Choice"),
            count: count,
            replacement: replacement,
            pool: pool,
            allowDrops: config.allowDrops || false,
            restriction: restriction,
            spellConfig: config.spell || null,
            _original: adv
        };
    }

    /**
     * 根据 restriction 配置动态查询匹配的物品
     * 用于 ItemChoice 没有静态 pool 而使用 restriction 过滤的情况
     * @param {Object} restriction - 限制条件 { type, subtype, level }
     *   - type: 对应 system.type.value（如 'class', 'feat' 等）
     *   - subtype: 对应 system.type.subtype（如 'artificerInfusion'）
     * @param {string} itemType - Item 文档类型过滤（如 'feat', 'spell'），来自 configuration.type
     * @param {number} characterLevel - 角色当前等级
     * @returns {Promise<Array>} 匹配的物品数组
     */
    async getItemsByRestriction(restriction, itemType = null, characterLevel = 20) {
        await this.loadSourcePacksIndex();

        const results = [];
        const seenUuids = new Set();

        if (!restriction && !itemType) return results;

        // restriction.type → system.type.value（如 'class'）
        // restriction.subtype → system.type.subtype（如 'artificerInfusion'）
        // itemType → Item.type（如 'feat'）
        const filterTypeValue = restriction?.type;    // system.type.value
        const filterSubtype = restriction?.subtype;   // system.type.subtype

        window.OriginateLog?.(`Originate | [getItemsByRestriction] 查询参数: itemType=${itemType}, typeValue=${filterTypeValue}, subtype=${filterSubtype}`);

        for (const [packId, index] of this._indexCache) {
            for (const [id, entry] of index.byId) {
                // 1. Item.type 过滤（如 'feat', 'spell'）
                if (itemType && entry.type !== itemType) continue;
                if (itemType === 'feat' && !filterTypeValue && !filterSubtype && !isPlayerFeat(entry)) continue;
                if (entry.type === 'spell' && !matchesSpellSchool(entry, restriction || {})) continue;

                // 2. system.type.value 过滤（如 'class'）
                if (filterTypeValue && entry.system?.type?.value !== filterTypeValue) continue;

                // 3. system.type.subtype 过滤（如 'artificerInfusion'）
                if (filterSubtype && entry.system?.type?.subtype !== filterSubtype) continue;

                // 4. 等级限制过滤（system.prerequisites.level）
                const prereqLevel = getRequiredLevel(entry);
                if (prereqLevel && prereqLevel > characterLevel) continue;

                // 5. 避免重复
                if (seenUuids.has(entry.uuid)) continue;
                seenUuids.add(entry.uuid);

                results.push(await this._normalizeOptionDisplay({
                    uuid: entry.uuid,
                    name: entry.name,
                    img: entry.img,
                    type: entry.type,
                    system: entry.system,
                    repeatable: !!(entry.system?.repeatable || entry.system?.prerequisites?.repeatable)
                }));
            }
        }

        // Character Forge работает только с официальными индексами D&D5e.
        // Запасной проход по всем Item-компендиумам мира намеренно не используется:
        // он мог повторно индексировать большие сторонние библиотеки и давать заметную нагрузку.
       
        results.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        window.OriginateLog?.(`Originate | [getItemsByRestriction] 找到 ${results.length} 个匹配物品 (itemType=${itemType}, typeValue=${filterTypeValue}, subtype=${filterSubtype})`);
        return results;
    }

    /**
     * 转换 Trait 类型
     * @param {Object} adv - Advancement 数据
     * @param {number} level - 当前等级
     * @param {Object} context - 上下文信息（用于过滤）
     */
    _convertTrait(adv, level = 1, context = {}) {
        const results = [];
        const config = adv.configuration || {};

        // 获取职业限制（classRestriction）
        // 可能的值: 'primary' (仅原始职业), 'secondary' (仅兼职), 或 undefined (无限制)
        const classRestriction = adv.classRestriction || config.classRestriction;

        // 获取模式（mode）
        // 可能的值: 'default', 'expertise', 'upgrade' 等
        const mode = config.mode || 'default';
        const normalizeTraitGrants = (grants) => {
            if (!grants) return [];
            if (Array.isArray(grants)) return grants;
            if (grants instanceof Set) return Array.from(grants);
            if (typeof grants === 'string') return [grants];
            if (typeof grants?.[Symbol.iterator] === 'function') return Array.from(grants);
            if (typeof grants === 'object') return Object.values(grants);
            return [];
        };
        const normalizeTraitPool = (pool) => {
            const safePool = Array.isArray(pool) ? pool : [];
            if (mode !== 'mastery') return safePool;

            return safePool.map(entry => {
                if (typeof entry !== 'string') return entry;
                if (entry === 'weapon:*') return 'weaponMastery:*';
                if (entry.startsWith('weapon:')) return `weaponMastery:${entry.slice('weapon:'.length)}`;
                return entry;
            });
        };

        // 根据上下文过滤：如果是创建角色（非兼职），过滤掉 'secondary' 的特质
        // 如果是兼职，过滤掉 'primary' 的特质
        const isMulticlassing = context.isMulticlassing || false;

        if (classRestriction) {
            if (classRestriction === 'secondary' && !isMulticlassing) {
                window.OriginateLog(`_convertTrait: Skipping "${getAdvancementName(adv)}" (multiclass only, currently primary class)`);
                return results; // 返回空数组，跳过此 Advancement
            }
            if (classRestriction === 'primary' && isMulticlassing) {
                window.OriginateLog(`_convertTrait: Skipping "${getAdvancementName(adv)}" (primary class only, currently multiclassing)`);
                return results;
            }
        }

        // 获取全局 pool（可能是 Set、数组或类 Set 对象）
        // 在 DnD5e 系统中，pool 通常在 configuration 级别定义
        // 注意：Foundry VTT 在序列化/反序列化时可能会将 Set 转换为其他格式
        let globalPool = [];
        if (config.pool) {
            if (config.pool instanceof Set) {
                globalPool = Array.from(config.pool);
            } else if (Array.isArray(config.pool)) {
                globalPool = config.pool;
            } else if (typeof config.pool === 'object') {
                // 可能是类似 Set 的对象（序列化后的 Set），尝试获取其值
                // 检查是否有 Symbol.iterator（可迭代对象）
                if (typeof config.pool[Symbol.iterator] === 'function') {
                    globalPool = Array.from(config.pool);
                } else {
                    // 普通对象，获取其值
                    globalPool = Object.values(config.pool);
                }
            } else if (typeof config.pool === 'string') {
                // 单个字符串值
                globalPool = [config.pool];
            }
        }
        globalPool = normalizeTraitPool(globalPool);

        window.OriginateLog(`_convertTrait: name=${getAdvancementName(adv)}, level=${level}, mode=${mode}, classRestriction=${classRestriction}`);
        window.OriginateLog(`_convertTrait: globalPool.length=${globalPool.length}, config.pool type=${config.pool?.constructor?.name}`, config.pool);
        window.OriginateLog(`_convertTrait: config.choices=`, config.choices);
        window.OriginateLog(`_convertTrait: config.grants=`, config.grants);

     
        const grantList = normalizeTraitGrants(config.grants);
        const hasGrants = grantList.length > 0;

        if (hasGrants) {
            const resistancePrefixes = new Set([
                'dr', 'di', 'dv', 'ci',
                'damageResistance', 'damageImmunity', 'damageVulnerability',
                'conditionImmunity'
            ]);
            const isResistanceGrant = grantList.length > 0 && grantList.every(grant => {
                const prefix = String(grant || '').split(':')[0];
                return resistancePrefixes.has(prefix);
            });

            results.push({
                id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
                type: 'trait_grant',
                title: isResistanceGrant
                    ? game.i18n.localize("ORIGINATE.Advancement.Resistances")
                    : (getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.Traits")),
                grants: new Set(grantList),
                mode: mode,
                classRestriction: classRestriction,
                allowReplacements: config.allowReplacements || false,
                _original: adv,
                _uid: `${adv._id}_grant` // 唯一标识符，用于去重
            });
        }

        // 可选择的特质
        // choices 可能是数组或按等级映射的对象
        if (config.choices) {
            if (Array.isArray(config.choices)) {
                // 数组格式：直接处理
                config.choices.forEach((choice, index) => {
                    // 优先使用 choice.pool，否则使用全局 pool
                    let choicePool = [];
                    if (choice.pool && Array.isArray(choice.pool) && choice.pool.length > 0) {
                        choicePool = choice.pool instanceof Set ? Array.from(choice.pool) : choice.pool;
                    } else if (choice.pool instanceof Set && choice.pool.size > 0) {
                        choicePool = Array.from(choice.pool);
                    } else {
                        // choice.pool 为空或不存在，使用全局 pool
                        choicePool = globalPool;
                    }
                    choicePool = normalizeTraitPool(choicePool);

                    // 只有当 pool 不为空且 count > 0 时才添加 trait_choice
                    const count = choice.count || 1;
                    if (choicePool.length > 0 && count > 0) {
                        results.push({
                            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
                            type: 'trait_choice',
                            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.TraitChoice"),
                            count: count,
                            pool: new Set(choicePool),
                            mode: mode,
                            classRestriction: classRestriction,
                            associatedGrants: hasGrants ? new Set(grantList) : null, // 传递关联的固定特质
                            _original: adv,
                            _uid: `${adv._id}_choice_${index}` // 唯一标识符
                        });
                    } else {
                        window.OriginateLog(`_convertTrait: Skipping choices[${index}], pool is empty or count=0`);
                    }
                });
            } else if (config.choices instanceof Set) {
                // Set 格式 (虽然不常见，但为了健壮性)
                let index = 0;
                for (const choice of config.choices) {
                    let choicePool = [];
                    if (choice.pool && Array.isArray(choice.pool) && choice.pool.length > 0) {
                        choicePool = choice.pool;
                    } else if (choice.pool instanceof Set && choice.pool.size > 0) {
                        choicePool = Array.from(choice.pool);
                    } else {
                        choicePool = globalPool;
                    }
                    choicePool = normalizeTraitPool(choicePool);

                    const count = choice.count || 1;
                    if (choicePool.length > 0 && count > 0) {
                        results.push({
                            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
                            type: 'trait_choice',
                            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.TraitChoice"),
                            count: count,
                            pool: new Set(choicePool),
                            mode: mode,
                            classRestriction: classRestriction,
                            associatedGrants: hasGrants ? new Set(grantList) : null, // 传递关联的固定特质
                            _original: adv,
                            _uid: `${adv._id}_choice_${index++}`
                        });
                    }
                }
            } else if (typeof config.choices === 'object') {
                // 按等级映射的对象格式
                // 例如: { "1": { count: 2 }, "2": { count: 1 } }
                const levelConfig = config.choices[String(level)];
                if (levelConfig) {
                    // 优先使用 levelConfig.pool，否则使用全局 pool
                    let choicePool = [];
                    if (levelConfig.pool) {
                        if (levelConfig.pool instanceof Set) {
                            choicePool = Array.from(levelConfig.pool);
                        } else if (Array.isArray(levelConfig.pool)) {
                            choicePool = levelConfig.pool;
                        } else if (typeof levelConfig.pool === 'object') {
                            // 可能是类似 Set 的对象
                            if (typeof levelConfig.pool[Symbol.iterator] === 'function') {
                                choicePool = Array.from(levelConfig.pool);
                            } else {
                                choicePool = Object.values(levelConfig.pool);
                            }
                        }
                    }

                    // 如果 levelConfig.pool 为空，使用全局 pool
                    if (choicePool.length === 0) {
                        choicePool = globalPool;
                    }
                    choicePool = normalizeTraitPool(choicePool);

                    window.OriginateLog(`_convertTrait: levelConfig found for level ${level}, count=${levelConfig.count}, choicePool.length=${choicePool.length}`);

                    // 只有当 pool 不为空时才添加 trait_choice
                    if (choicePool.length > 0) {
                        results.push({
                            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
                            type: 'trait_choice',
                            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.TraitChoice"),
                            count: levelConfig.count || 1,
                            pool: new Set(choicePool),
                            mode: mode,
                            classRestriction: classRestriction,
                            associatedGrants: hasGrants ? new Set(grantList) : null, // 传递关联的固定特质
                            _original: adv,
                            _uid: `${adv._id}_choice_level${level}` // 唯一标识符
                        });
                    } else {
                        console.warn(`Originate | _convertTrait: Skipping "${getAdvancementName(adv)}" because pool is empty`);
                    }
                }
            }
        }

        return results;
    }

    /**
     * 转换 AbilityScoreImprovement 类型
     */
    _convertASI(adv) {
        const config = adv.configuration || {};

        return {
            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
            type: 'asi',
            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.ASI"),
            points: config.points || 0,
            fixed: config.fixed || {},
            cap: config.cap || 2,
            locked: config.locked || [],
            _original: adv
        };
    }

    /**
     * 转换 Size 类型
     */
    _convertSize(adv) {
        const config = adv.configuration || {};

        return {
            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
            type: 'size',
            title: getAdvancementName(adv) || game.i18n.localize("ORIGINATE.Advancement.Size"),
            size: new Set(config.sizes || ['med']),  // 使用 'size' 而不是 'sizes' 以匹配 UI 代码
            _original: adv
        };
    }

    /**
     * 转换 HitPoints 类型
     */
    _convertHitPoints(adv, sourceItem) {
        // 从职业获取生命骰
        const hitDie = sourceItem.system.hd?.denomination || 8;

        return {
            id: adv._id, // 【修复】保留原始 Advancement ID，用于链接
            type: 'hp',
            title: game.i18n.localize("ORIGINATE.Advancement.HitPoints"),
            denomination: String(hitDie).replace('d', ''),
            _original: adv
        };
    }

    /**
     * 从 Item 提取标语（用于 UI 显示）其实这玩意肯定无法照顾到所有资源
     * 根据类型提取不同位置的段落：
     * - 背景 : 取最后一段
     * - 种族 : 取第一段（优先级最高，跳过表格处理）
     * - 职业 : 智能提取描述性段落
     * @param {Item} item
     * @returns {string}
     */
    _extractTagline(item) {
        const desc = item.system.description?.value || '';
        const itemType = item.type;

        // 移除 UUID 引用
        let cleanDesc = desc
            .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, '$1')
            .replace(/@UUID\[[^\]]*\]/g, '')
            .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, '$1')
            .replace(/@\w+\[[^\]]*\]/g, '');

        // 提取段落文本的辅助函数（移除所有 HTML 标签）
        const extractText = (html) => {
            // 移除所有 HTML 标签
            let text = html.replace(/<[^>]+>/g, '');
            // 清理多余空白
            text = text.replace(/\s+/g, ' ').trim();
            return text;
        };

        let tagline = '';

        // Adrian: 对于种族，我们优先取第一段介绍文本，而不是表格后的内容。
        // 因为种族的描述通常开头就是介绍，表格只是辅助信息。
        // 精灵的问题就是因为之前的逻辑优先取了表格后的段落，导致显示的不是开篇介绍。

        // 匹配所有段落（先提取，后面根据类型决定取哪一段）
        const paragraphMatches = cleanDesc.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);

        if (paragraphMatches && paragraphMatches.length > 0) {
            // 过滤掉空段落和包含表格/列表的段落
            const validParagraphs = paragraphMatches
                .filter(p => !p.includes('<table') && !p.includes('<li'))
                .map(p => extractText(p))
                .filter(text => text.length > 10 && !text.startsWith('Level') && !text.startsWith('等级'));

            if (validParagraphs.length > 0) {
                if (itemType === 'race') {
                    // 种族：优先取第一段，这是种族的介绍文本
                    // Adrian: 精灵、矮人这些种族的描述开头都是介绍，表格在后面
                    tagline = validParagraphs[0];
                } else if (itemType === 'background') {
                    // 背景：取最后一段
                    tagline = validParagraphs[validParagraphs.length - 1];
                } else if (itemType === 'class') {
                    // 职业：尝试找到包含描述性词汇的段落
                    const descriptiveKeywords = ['是', '能够', '使用', '拥有', 'is', 'can', 'use', 'have'];
                    const descriptiveParagraph = validParagraphs.find(p =>
                        descriptiveKeywords.some(kw => p.includes(kw)) && p.length > 20
                    );
                    tagline = descriptiveParagraph || validParagraphs[0];
                } else {
                    // 其他类型：取第一段
                    tagline = validParagraphs[0];
                }
            }
        }

        // 如果常规提取失败，且描述中包含表格，尝试提取表格后的第一段（作为后备）
        // Adrian: 这个逻辑只对非种族类型生效，种族类型已经在上面处理完了
        if (!tagline && itemType !== 'race' && cleanDesc.includes('<table')) {
            // 找到最后一个表格结束标签的位置
            const lastTableEnd = cleanDesc.lastIndexOf('</table>');
            if (lastTableEnd !== -1) {
                // 截取表格后的内容
                const contentAfterTable = cleanDesc.substring(lastTableEnd + 8);
                // 匹配第一个段落
                const match = contentAfterTable.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
                if (match) {
                    const text = extractText(match[1]);
                    if (text.length > 10) {
                        tagline = text;
                    }
                }
            }
        }

        // 如果还是没有提取到，尝试直接移除所有标签取前 200 字
        if (!tagline) {
            tagline = extractText(cleanDesc);
        }

        // 限制长度，避免过长的描述
        if (tagline.length > 200) {
            tagline = tagline.substring(0, 197) + '...';
        }

        return tagline;
    }

    /**
     * 从 Item 提取核心特性（用于 UI 显示）
     * @param {Item} item
     * @param {string} type
     * @returns {Object|null}
     */
    _extractCoreTraits(item, type) {
        if (type === 'class') {
            const rawHitDie = String(item.system.hd?.denomination || '').trim();
            const hitDie = rawHitDie
                ? (rawHitDie.toLowerCase().startsWith('d') ? rawHitDie : `d${rawHitDie}`)
                : null;

            return {
                primary: this._getPrimaryAbility(item),
                hitDie,
                saves: this._getSavingThrows(item),
                spellcasting: item.system.spellcasting?.ability || null,
                spellcastingType: item.system.spellcasting?.progression || null
            };
        }

        if (type === 'race') {
            return {
                speed: item.system.movement?.walk || 30,
                size: item.system.traits?.size || 'med',
                type: item.system.type?.value || 'humanoid'
            };
        }

        return null;
    }

    /**
     * 获取职业的主要属性
     */
    _getPrimaryAbility(item) {
        // 1. 从 spellcasting 推断
        if (item.system.spellcasting?.ability) {
            return this._getLocalizedAbilityLabel(item.system.spellcasting.ability) || null;
        }

        // 2. 使用预定义映射表
        if (item.system.identifier && DND5E_MAPPING.classPrimaryAbilities) {
            const abilityKey = DND5E_MAPPING.classPrimaryAbilities[item.system.identifier];
            if (abilityKey) {
                return this._getLocalizedAbilityLabel(abilityKey) || null;
            }
        }

        // 3. 从 Advancement 中推断 (查找 ASI 或 Trait)
        // 暂时略过，因为映射表应该覆盖大多数情况

        // 4. 从豁免熟练推断 (取第一个豁免属性)
        const saves = this._getSavingThrows(item);
        if (saves) {
            // saves 是 "力量, 体质" 这样的字符串
            const firstSave = saves.split(/,|，/)[0].trim();
            return firstSave;
        }

        return null;
    }

    /**
     * 获取职业的豁免熟练
     */
    _getSavingThrows(item) {
        const saves = [];
        const advancement = getAdvancementEntries(item.system.advancement);

        for (const adv of advancement) {
            if (adv.type === 'Trait' && adv.configuration?.grants) {
                for (const grant of adv.configuration.grants) {
                    if (grant.startsWith('saves:')) {
                        const ability = grant.split(':')[1];
                        const label = this._getLocalizedAbilityLabel(ability);
                        if (label) saves.push(label);
                    }
                }
            }
        }

        return saves.length > 0 ? saves.join(', ') : null;
    }

    /**
     * 获取特性列表（向后兼容方法）
     * 新版本不再使用文件夹查找，所有特性通过 Advancement 系统获取
     * @param {string} type - 类型
     * @param {string} name - 名称
     * @returns {Promise<Array>} 空数组（保持向后兼容）
     */
    async getFeatures(type, name) {
        // 新版本不再使用文件夹查找特性
        // 所有特性数据通过 Item 的 Advancement 系统获取
        window.OriginateLog(`getFeatures is deprecated, features are obtained through the Advancement system`);
        return [];
    }

    /**
     * 清除缓存
     */
    clearCache() {
        this._cache.clear();
        this._indexCache.clear();
        this._typeIndex.clear();
        this._uuidIndex.clear();
        this._optionsCache.clear();
        this._indexLoaded = false;
        this._spellListsLoaded = false;
        this._classSpellMap = null;
        this._availableClasses = null;
    }

    /**
     * 重新加载数据源索引
     * 当用户更改数据源配置时调用
     */
    async reloadIndex() {
        this._indexCache.clear();
        this._typeIndex.clear();
        this._uuidIndex.clear();
        this._optionsCache.clear();
        this._indexLoaded = false;
        await this.loadSourcePacksIndex();

        // 同时刷新法术列表数据
        await this.loadSpellListSources(true);
    }

    /**
     * 预加载选项的详细信息（用于 UI 显示）
     * 
     * Adrian: 这个方法是数据加载的最后一道工序。
     * 它负责把那些只有 UUID 的骨架填充成有血有肉的数据。
     * 
     * 重点来了：专长的嵌套 Advancement 也在这里被挖出来。
     * 比如"技艺专家"这种专长，它内部有 ASI、技能熟练、专精三个 Advancement，
     * 以前我们直接无视了，现在终于要正视它们了。
     * 
     * @param {Array} options - 选项列表
     * @returns {Promise<Array>} 增强后的选项列表
     */
    async enrichOptions(options) {
        // ============================================================
        // 🎯 功能开关：特性描述悬停提示 (Feature Description Tooltip)
        // ============================================================
        // 设置为 true 启用特性描述加载，鼠标悬停时显示特性介绍
        // 设置为 false 禁用此功能
        // 
        // 启用方法：将下面的 false 改为 true 即可
        // ============================================================
        const ENABLE_DESCRIPTION_TOOLTIP = false;
        const excludedItemUuids = this.getExcludedItemUuidSet();

        return Promise.all(options.map(async (option) => {
            // 跳过 trait_choice 和 trait_grant 类型
            // 它们的 pool 是字符串集合（如 "skills:acr"），不需要加载 Item
            if (option.type === 'trait_choice' || option.type === 'trait_grant') {
                return option;
            }

            // 如果 items 中有未加载的数据，加载它们
            if (option.items) {
                option.items = await Promise.all(option.items.map(async (item) => {
                    if (this._isBrokenDisplayValue(item.name) && item.uuid) {
                        const doc = await this.getDocument(item.uuid);
                        if (doc) {
                            item.name = this._cleanName(doc.name);
                            item.img = doc.img;
                            item.itemType = doc.type; // Adrian: 记录物品类型，用于后续判断
                            item.repeatable = !!(item.repeatable || doc.system?.repeatable || doc.system?.prerequisites?.repeatable);

                            // 特性描述悬停提示功能
                            if (ENABLE_DESCRIPTION_TOOLTIP) {
                                item.description = doc.system.description?.value || '';
                            }

                            // ============================================================
                            // 🎯 专长嵌套 Advancement 检测
                            // ============================================================
                            // Adrian: 这里是重头戏。如果授予的物品是专长（feat），
                            // 我们需要检查它是否有内部的 Advancement（如 ASI、Trait 等）。
                            // 如果有，就把它们挖出来，让 UI 层知道需要额外处理。
                            // 
                            // 这就像拆快递，外面是个盒子（专长），里面还有小盒子（Advancement）。
                            // 以前我们只拆外面那层，现在要一层层拆到底。
                            // ============================================================
                            if (doc.type === 'feat' && hasAdvancementEntries(doc.system.advancement)) {
                                const nestedAdvs = getAdvancementEntries(doc.system.advancement);

                                // 检查是否有需要用户交互的 Advancement
                                // 这些类型需要用户做选择，不能自动处理
                                const interactiveTypes = ['AbilityScoreImprovement', 'Trait', 'ItemChoice'];
                                const hasInteractive = nestedAdvs.some(a => interactiveTypes.includes(a.type));

                                if (hasInteractive) {
                                    item.hasNestedAdvancement = true;
                                    // 转换嵌套的 Advancement 为 UI 格式
                                    // 注意：这里我们传入 level=0，因为专长的 Advancement 通常都是 level 0
                                    item.nestedAdvancements = this._convertAdvancementsToUI(nestedAdvs, doc, 0);
                                    await this._enrichNestedChoiceDisplays(item.nestedAdvancements);
                                    window.OriginateLog(`Detected feat "${doc.name}" contains ${item.nestedAdvancements.length} nested Advancements:`,
                                        item.nestedAdvancements.map(a => `${a.type}: ${a.title}`));
                                }
                            }
                        }
                    }
                    return item;
                }));
            }

            // 只处理 choice 类型的 pool
            // choice 类型的 pool 是包含 {uuid, name, img} 对象的数组
            if (option.pool && option.type === 'choice') {
                const loadedPool = await Promise.all(option.pool.map(async (item) => {
                    // Adrian: 修复 item.name 可能为 undefined 的情况
                    // 之前只检查了 === null，导致 undefined 的情况被跳过
                    if ((this._isBrokenDisplayValue(item.name)
                        || (normalizeSpellSchools(option.restriction?.school).length > 0 && item.system?.school == null && item.school == null)) && item.uuid) {
                        const doc = await this.getDocument(item.uuid);
                        if (doc) {
                            window.OriginateLog(`Originate | [enrichOptions] 加载池物品成功: ${item.uuid} -> ${doc.name}`);
                            item.name = this._cleanName(doc.name);
                            item.img = doc.img;
                            item.type = doc.type;
                            // 保存部分 system 数据用于类型检查
                            item.system = { ...item.system, type: doc.system?.type, school: doc.system?.school, level: doc.system?.level };

                            // 读取先决条件（用于等级筛选）
                            item.prerequisites = doc.system.prerequisites || {};
                            item.repeatable = !!(item.repeatable || doc.system?.repeatable || item.prerequisites?.repeatable);

                            // 特性描述悬停提示功能
                            if (ENABLE_DESCRIPTION_TOOLTIP) {
                                item.description = doc.system.description?.value || '';
                            }

                            // Adrian: 对于 ItemChoice 池中的专长，也检测嵌套 Advancement
                            // 这样用户在选择专长时就能知道它需要额外配置
                            if (doc.type === 'feat' && hasAdvancementEntries(doc.system.advancement)) {
                                const nestedAdvs = getAdvancementEntries(doc.system.advancement);
                                const interactiveTypes = ['AbilityScoreImprovement', 'Trait', 'ItemChoice'];
                                const hasInteractive = nestedAdvs.some(a => interactiveTypes.includes(a.type));

                                if (hasInteractive) {
                                    item.hasNestedAdvancement = true;
                                    // 确保 _convertAdvancementsToUI 存在
                                    if (this._convertAdvancementsToUI) {
                                        item.nestedAdvancements = this._convertAdvancementsToUI(nestedAdvs, doc, 0);
                                        await this._enrichNestedChoiceDisplays(item.nestedAdvancements);
                                    }
                                }
                            }
                        }
                    }
                    return this.normalizeChoiceOption(item);
                }));

                window.OriginateLog(`Originate | [enrichOptions] 加载完成: ${loadedPool.length} 项, 有名称的: ${loadedPool.filter(i => i.name).length} 项, 无名称的: ${loadedPool.filter(i => !i.name).length} 项`);
                if (loadedPool.filter(i => !i.name).length > 0) {
                    window.OriginateLog(`Originate | [enrichOptions] 加载失败的 UUID:`, loadedPool.filter(i => !i.name).map(i => i.uuid));
                }

                // 只在数据层移除无法读取和被全局排除的选项。
                option.pool = loadedPool.filter(item => {
                    // 如果加载失败（没有名称），过滤掉
                    if (!item.name) return false;

                    // Advancement 的直接池不经过 getOptions，这里得补上同一条全局排除规则。
                    if (this.isItemExcluded(item, excludedItemUuids)) return false;

                    // 此处只补数据；等级留到渲染时按本次选择等级判断，避免嵌套 0 级和多职业提前丢项。
                    return true;
                });

                window.OriginateLog(`Originate | [enrichOptions] 过滤后池大小: ${option.pool.length}`);
            }

            return option;
        }));
    }

    /**
     * 获取专长的嵌套 Advancement
     * 
     * 这是一个便捷方法，专门用于获取专长内部的 Advancement。
     * 当用户选择了一个专长后，我们需要知道它里面有什么需要配置的。
     * 
     * @param {string} uuid - 专长的 UUID
     * @returns {Promise<Array>} 嵌套的 Advancement 列表（已转换为 UI 格式）
     */
    async getFeatAdvancements(uuid) {
        const doc = await this.getDocument(uuid);
        if (!doc || doc.type !== 'feat') {
            console.warn(`Originate | getFeatAdvancements: ${uuid} is not a feat or cannot be loaded`);
            return [];
        }

        const advancements = getAdvancementEntries(doc.system.advancement);
        if (advancements.length === 0) {
            return [];
        }

        // 转换为 UI 格式
        const uiAdvancements = this._convertAdvancementsToUI(advancements, doc, 0);

        // 丰富数据（加载名称、图标等）
        await this.enrichOptions(uiAdvancements);

        window.OriginateLog(`getFeatAdvancements: Feat "${doc.name}" contains ${uiAdvancements.length} Advancements`);
        return uiAdvancements;
    }

    /**
     * 根据施法类型和职业等级计算最大可施法术环阶
     * @param {string} spellcastingType - 施法类型 ('full', 'half', 'third', 'pact')
     * @param {number} classLevel - 职业等级 (1-20)
     * @returns {number} 最大可学法术环阶 (0-9)，0 表示只能学戏法
     */
    getMaxSpellLevel(spellcastingType, classLevel) {
        if (!spellcastingType || !classLevel || classLevel < 1) return 0;

        const level = Math.min(classLevel, 20);

        switch (spellcastingType) {
            case 'full':
                if (level >= 17) return 9;
                if (level >= 15) return 8;
                if (level >= 13) return 7;
                if (level >= 11) return 6;
                if (level >= 9) return 5;
                if (level >= 7) return 4;
                if (level >= 5) return 3;
                if (level >= 3) return 2;
                return 1;

            case 'half':
                if (level >= 17) return 5;
                if (level >= 13) return 4;
                if (level >= 9) return 3;
                if (level >= 5) return 2;
                if (level >= 2) return 1;
                return 0;

            case 'third':
                if (level >= 19) return 4;
                if (level >= 13) return 3;
                if (level >= 7) return 2;
                if (level >= 3) return 1;
                return 0;

            case 'pact':
                if (level >= 9) return 5;
                if (level >= 7) return 4;
                if (level >= 5) return 3;
                if (level >= 3) return 2;
                return 1;

            default:
                console.warn(`Originate | Unknown spellcasting type: ${spellcastingType}, falling back to full caster`);
                return this.getMaxSpellLevel('full', level);
        }
    }

    /**
     * 根据限制获取法术列表
     * @param {Object} restriction - 限制条件 { level: "0", list: ["class:cleric"] }
     * @param {string} searchText - 搜索文本
     * @param {number|null} maxLevel - 最大可学法术环阶（当 restriction.level 未指定时生效）
     * @returns {Promise<Array>} 符合条件的法术列表
     */
    async getSpellsByRestriction(restriction = {}, searchText = "", maxLevel = null) {
        await this.loadSourcePacksIndex();
        const excludedItemUuids = this.getExcludedItemUuidSet();
        // 当有列表限制时，确保法术列表数据已加载
        if (restriction.list?.length > 0) {
            await this.loadSpellListSources();
        }

        window.OriginateLog?.(`Originate | [getSpellsByRestriction] CALLED - restriction:`, restriction, `searchText: "${searchText}", maxLevel: ${maxLevel}`);

        // 解析限制条件
        // level: 可能是 "0", "1", 数字 0, 1, 或特殊值 "available" (DnD5e 的 "任意可使用等级")
        const isAvailable = isAvailableSpellLevel(restriction.level);
        const minimumLevel = restriction.level === 'availableNoCantrips' ? 1 : 0;
        const targetLevels = new Set();
        if (restriction.level !== undefined && restriction.level !== null && restriction.level !== '' && !isAvailable) {
            const parsed = parseInt(restriction.level);
            if (!isNaN(parsed)) {
                targetLevels.add(parsed);
            } else {
                console.warn(`Originate | [getSpellsByRestriction] Unrecognized level value: "${restriction.level}", treating as no level filter`);
            }
        }

        // 当 level 为 'available' 且调用者未传入 maxLevel 时，设置安全默认值
        if (isAvailable && (maxLevel === null || maxLevel === undefined)) {
            maxLevel = 1;
            window.OriginateLog?.(`Originate | [getSpellsByRestriction] level='available' with no maxLevel from caller, defaulting maxLevel=${maxLevel}`);
        }

        // list: 法术列表限制，如 ["class:cleric", "class:druid"]
        const targetLists = new Set();
        if (restriction.list && Array.isArray(restriction.list)) {
            normalizeSpellListIds(restriction.list).forEach(listId => targetLists.add(listId));
        }

        window.OriginateLog?.(`Originate | [getSpellsByRestriction] Target levels: [${[...targetLevels]}], maxLevel: ${maxLevel}`);

        const results = [];
        const searchLower = searchText.toLowerCase();

        // Search the pre-built spell bucket instead of walking every item in every pack on each keystroke.
        for (const entry of this._typeIndex.get('spell') || []) {
            if (!matchesSpellSchool(entry, restriction)) continue;
            if (this.isItemExcluded(entry, excludedItemUuids)) continue;

            if (searchText && !entry.name.toLowerCase().includes(searchLower)) continue;

            const spellLevel = entry.system?.level ?? -1;
            if (spellLevel < minimumLevel) continue;
            if (targetLevels.size > 0) {
                if (!targetLevels.has(spellLevel)) continue;
            } else if (maxLevel !== null && maxLevel !== undefined) {
                if (spellLevel < 0 || spellLevel > maxLevel) continue;
            }

            if (targetLists.size > 0 && this._classSpellMap) {
                const spellClasses = getSpellClassesForSpell(this._classSpellMap, entry);
                if (!spellClasses || !spellClassSetMatchesAny(spellClasses, targetLists)) continue;
            }

            results.push({
                uuid: entry.uuid,
                name: entry.name,
                img: entry.img,
                level: entry.system?.level,
                school: entry.system?.school,
                sourceItem: entry.system?.sourceItem,
                sourceClass: entry.system?.sourceClass
                    || (typeof entry.system?.sourceItem === 'string' && entry.system.sourceItem.startsWith('class:')
                        ? entry.system.sourceItem.slice(6)
                        : null),
                description: ""
            });
        }

        // 补充加载 customSpellListOverrides 中不在索引缓存里的法术
        // Adrian: 用户可能从世界物品或未勾选的合集包中手动添加法术
        // 这些法术不在 _indexCache 里，但应该出现在法术选择器中
        const resultUuids = new Set(results.map(r => r.uuid));
        const customOverrides = game.settings.get('character-forge', 'customSpellListOverrides') || {};
        for (const spellUuids of Object.values(customOverrides)) {
            if (!Array.isArray(spellUuids)) continue;
            for (const spellUuid of spellUuids) {
                if (this.isItemExcluded(spellUuid, excludedItemUuids)) continue;
                if (resultUuids.has(spellUuid)) continue;
                try {
                    const item = await fromUuid(spellUuid);
                    if (!item || item.type !== 'spell') continue;
                    if (!matchesSpellSchool(item, restriction)) continue;

                    const spellLevel = item.system?.level ?? -1;
                    if (spellLevel < minimumLevel) continue;

                    // 应用同样的搜索文本过滤
                    if (searchText && !item.name.toLowerCase().includes(searchLower)) continue;

                    // 应用同样的环阶过滤
                    if (targetLevels.size > 0) {
                        if (!targetLevels.has(spellLevel)) continue;
                    } else if (maxLevel !== null && maxLevel !== undefined) {
                        if (spellLevel < 0 || spellLevel > maxLevel) continue;
                    }

                    // 应用同样的法术列表过滤
                    if (targetLists.size > 0 && this._classSpellMap) {
                        const spellClasses = getSpellClassesForSpell(this._classSpellMap, { uuid: spellUuid, name: item.name });
                        if (!spellClasses) continue;
                        if (!spellClassSetMatchesAny(spellClasses, targetLists)) continue;
                    }

                    results.push({
                        uuid: spellUuid,
                        name: this._cleanName(item.name),
                        img: item.img,
                        level: item.system?.level,
                        school: item.system?.school,
                        sourceItem: item.system?.sourceItem,
                        sourceClass: item.system?.sourceClass
                            || (typeof item.system?.sourceItem === 'string' && item.system.sourceItem.startsWith('class:')
                                ? item.system.sourceItem.slice(6)
                                : null),
                        description: ""
                    });
                    resultUuids.add(spellUuid);
                } catch (e) {
                    // 静默跳过无法加载的法术
                }
            }
        }

        // 排序：先按环阶，再按名称
        results.sort((a, b) => {
            const levelDiff = (a.level || 0) - (b.level || 0);
            if (levelDiff !== 0) return levelDiff;
            return a.name.localeCompare(b.name, game.i18n.lang);
        });

        window.OriginateLog?.(`Originate | [getSpellsByRestriction] Found ${results.length} spells matching filters`);
        return results;
    }
}
