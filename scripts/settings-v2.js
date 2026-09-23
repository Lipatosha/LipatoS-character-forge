/**
 * Originate v2 - Settings
 * 
 * 嘿，这里是 Adrian。
 * 
 * 简化的配置系统：使用 UUID 列表而非复杂的对象结构。
 * 简单就是美，虽然有时候简单也意味着简陋。
 */

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
import { setCustomImage, getCustomImageConfig, hasCustomImage, getAllCustomImages, setAllCustomImages } from './phb-image-mapping.js';
import { acquireForgeStyles, releaseForgeStyles } from './runtime-style.js';
import { AspectsConfigApp } from './app/aspects-config.js';
import { openCustomImageConfig } from './app/custom-image-config.js';
import { PropertiesConfigApp } from './app/properties-config.js';
import { applyWindowScaling, cleanupWindowScaling } from './utils/scaling-helper.js';
import { SpellRules } from './spell-rules.js';
import { SpellRulesConfigApp } from './app/spell-rules-config.js';
import {
    INITIAL_EQUIPMENT_SELL_MULTIPLIER,
    INITIAL_EQUIPMENT_ITEM_TYPES,
    getInitialEquipmentCategory,
    normalizeSellMultiplier,
    normalizeNullablePrice,
    normalizeShopEntries,
    resolveItemPriceGp
} from './shared/initial-equipment-ledger.js';
import {
    getSpellClassesForSpell,
    normalizeSpellListId,
    normalizeSpellUuid
} from './shared/spell-list-filters.js';
import { DEFAULT_STANDARD_ARRAY } from './shared/ability-score-methods.js';
import { getSourceModuleId } from './shared/source-module.js';
import { toCatalogEntry } from './shared/feat-catalog.js';
import { createFeatBrowser, renderFeatBrowser, bindFeatBrowser, renderManagedFeat } from './shared/feat-catalog-browser.js';

function addSourceModule(item) {
    if (!item) return item;
    return {
        ...item,
        sourceModuleId: getSourceModuleId(item)
    };
}

function addSourceModulesToGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return groups.map(group => ({
        ...group,
        spells: (group.spells || []).map(addSourceModule)
    }));
}

function addSourceModulesToCategory(category) {
    return {
        ...category,
        items: (category.items || []).map(addSourceModule),
        groupedClasses: addSourceModulesToGroups(category.groupedClasses),
        groupedSubclasses: addSourceModulesToGroups(category.groupedSubclasses),
        groupedOthers: addSourceModulesToGroups(category.groupedOthers),
        uncategorizedSpells: addSourceModulesToGroups(category.uncategorizedSpells)
    };
}

/**
 * 拖拽式配置应用
 * 允许用户从 Compendium 拖拽 Item 到配置列表。
 * 就像把东西扔进购物车一样简单。
 */
export class OriginateConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "originate-config-v2",
        classes: ["originate-config-app"],
        position: {
            width: 1500,
            height: 1000
        },
        window: {
            title: "ORIGINATE.Settings.Config.Title",
            icon: "fas fa-cogs",
            resizable: true
        },
        actions: {
            removeItem: OriginateConfigApp.prototype._onRemoveItem,
            clearCategory: OriginateConfigApp.prototype._onClearCategory,
            importFromPack: OriginateConfigApp.prototype._onImportFromPack,
            toggleSourcePack: OriginateConfigApp.prototype._onToggleSourcePack,
            saveSourcePacks: OriginateConfigApp.prototype._onSaveSourcePacks,
            toggleModuleFolder: OriginateConfigApp.prototype._onToggleModuleFolder,
            toggleModuleAll: OriginateConfigApp.prototype._onToggleModuleAll,
            excludeItem: OriginateConfigApp.prototype._onExcludeItem,
            includeItem: OriginateConfigApp.prototype._onIncludeItem,
            setCustomImage: OriginateConfigApp.prototype._onSetCustomImage,
            clearCustomImage: OriginateConfigApp.prototype._onClearCustomImage,
            editDescription: OriginateConfigApp.prototype._onEditDescription,
            exportSettings: OriginateConfigApp.prototype._onExportSettings,
            importSettings: OriginateConfigApp.prototype._onImportSettings,
            removeCustomSpell: OriginateConfigApp.prototype._onRemoveCustomSpell,
            removeShopItem: OriginateConfigApp.prototype._onRemoveShopItem,
            openSpellRules: OriginateConfigApp.prototype._onOpenSpellRules
        }
    };

    static PARTS = {
        main: {
            template: "modules/character-forge/templates/config-v2.hbs"
        }
    };

    // 类别到 Item 类型的映射
    // 别搞混了，不然程序会哭的
    static CATEGORY_TYPE_MAP = {
        races: 'race',
        classes: 'class',
        subclasses: 'subclass',
        backgrounds: 'background',
        feats: 'feat',
        features: 'feature',
        spells: 'spell',
        items: 'item'
    };

    constructor(options = {}) {
        super(options);
        acquireForgeStyles(this).catch(error => console.warn('Character Forge | Не удалось загрузить стили настроек:', error));
        this._activeTab = 'sources'; // 默认打开数据源标签页，因为那里最热闹
        this._pendingSourcePacks = null; // 暂存的数据源配置，防止手滑
        this._scrollPositions = {}; // 存储滚动位置，用户体验细节
        this._openAccordions = new Set(); // 保存手风琴展开状态
        this._searchTerms = {}; // 各个标签页自己的搜索词，来回切换时别把输入吞掉

        // 防抖的重载函数，避免狂点造成的卡顿
        this._debouncedReloadSpellLists = foundry.utils.debounce(async () => {
            const dataManager = game.modules.get('character-forge')?.api?.dataManager;
            if (dataManager) {
                console.log("Originate | Triggering debounced spell list reload...");
                await dataManager.loadSpellListSources(true);
            }
        }, 500);
    }

    async _prepareContext(options) {
        const sources = game.settings.get('character-forge', 'sources') || this._getDefaultSources();
        // 优先使用暂存的配置，否则使用已保存的配置
        // 就像草稿纸和正式文件的区别
        const sourcePacks = this._pendingSourcePacks !== null ? this._pendingSourcePacks : (game.settings.get('character-forge', 'sourcePacks') || []);

        // 获取可用的 Compendium 包并按 mod 分组
        // 看看我们有什么好东西，然后把它们整理成文件夹
        const allPacks = Array.from(game.packs);
        const itemPacks = allPacks.filter(p => p.documentName === 'Item');

        // 按 mod 分组
        const moduleGroups = this._groupPacksByModule(itemPacks, sourcePacks);

        // 转换为数组并按字母顺序排序
        const availableModules = Object.values(moduleGroups).sort((a, b) =>
            a.moduleName.localeCompare(b.moduleName)
        );

        // 保留旧的扁平列表以兼容其他功能
        const availablePacks = itemPacks.map(p => ({
            id: p.collection,
            label: p.title,
            selected: sourcePacks.includes(p.collection)
        }));

        // 定义类别
        // 分门别类，井井有条
        const categories = [
            { id: 'races', label: game.i18n.localize("ORIGINATE.Settings.Config.Race"), itemType: 'race' },
            { id: 'classes', label: game.i18n.localize("ORIGINATE.Settings.Config.Class"), itemType: 'class' },
            { id: 'subclasses', label: game.i18n.localize("ORIGINATE.Settings.Config.Subclass"), itemType: 'subclass' },
            { id: 'backgrounds', label: game.i18n.localize("ORIGINATE.Settings.Config.Background"), itemType: 'background' },
            { id: 'feats', label: game.i18n.localize("ORIGINATE.Settings.Config.Feat"), itemType: 'feat' },
            { id: 'features', label: game.i18n.localize("ORIGINATE.Settings.Config.Feature"), itemType: 'feature' },
            { id: 'spells', label: game.i18n.localize("ORIGINATE.Settings.Config.Spell"), itemType: 'spell' },
            { id: 'items', label: game.i18n.localize("ORIGINATE.Settings.Config.Item"), itemType: 'item' },
            { id: 'spellLists', label: game.i18n.localize("ORIGINATE.Settings.Config.SpellLists"), itemType: 'journal', isJournal: true }
        ];

        // 获取 DataManager 实例
        // 我们的数据管家
        const dataManager = game.modules.get('character-forge')?.api?.dataManager;

        // 获取被排除的物品列表
        // Adrian: 这些是用户明确不想要的东西
        const excludedItems = game.settings.get('character-forge', 'excludedItems') || [];

        // 为每个类别加载 Item 信息
        // 这可能会花点时间，特别是如果你装了一堆乱七八糟的模组
        const categoriesWithItems = await Promise.all(categories.map(async (cat) => {
            // 特殊处理：法术列表类别
            if (cat.id === 'spellLists') {
                const spellListSources = game.settings.get('character-forge', 'spellListSources') || [];
                const autoScanned = dataManager?._scannedJournals || new Map();

                // 合并手动和自动扫描的来源
                const allUuids = new Set([...spellListSources, ...autoScanned.keys()]);

                const nestedItems = await Promise.all(Array.from(allUuids).map(async (uuid) => {
                    const isManual = spellListSources.includes(uuid);
                    let journalName = "";
                    let journalImg = "icons/svg/book.svg";

                    // 如果在自动扫描缓存中，使用缓存
                    if (autoScanned.has(uuid)) {
                        const cached = autoScanned.get(uuid);
                        journalName = cached.name;
                        journalImg = cached.img;
                        // 注意：缓存的 classes 只是 {id, name}，没有 uuid。我们需要 uuid 来做排除。
                        // 所以这里其实还需要获取 Document 或者在缓存时存 uuid。
                        // 暂时我们尝试重新获取 Document，因为 settings 界面不需要极速
                    }

                    try {
                        const journal = await fromUuid(uuid);
                        if (!journal) {
                            return [{
                                uuid,
                                name: `[${game.i18n.localize("ORIGINATE.Settings.Config.NotFound")}]`,
                                img: "icons/svg/book.svg",
                                desc: "Journal Entry Not Found",
                                isManual,
                                isExcluded: excludedItems.includes(uuid)
                            }];
                        }

                        journalName = journal.name;
                        journalImg = journal.img || "icons/svg/book.svg";

                        // 获取所有法术页面
                        const spellPages = journal.pages.filter(p => p.type === 'spells' && p.system?.identifier);

                        if (spellPages.length === 0) {
                            // 如果是空的（或者没有识别到的页面），作为一个整体条目显示
                            return [{
                                uuid: journal.uuid,
                                name: journal.name,
                                img: journalImg,
                                desc: "Empty or No Valid Pages",
                                isManual,
                                isExcluded: excludedItems.includes(journal.uuid)
                            }];
                        }

                        // 将每个页面作为一个独立的条目返回
                        return spellPages.map(p => ({
                            uuid: p.uuid, // 页面的 UUID，用于单独排除
                            name: p.name,
                            img: p.src || journalImg, // 页面可能有自己的图片
                            desc: journalName, // 显示来源期刊名称作为描述
                            isManual,
                            isExcluded: excludedItems.includes(p.uuid),
                            identifier: p.system.identifier // 用于分组
                        }));

                    } catch (e) {
                        return [{
                            uuid,
                            name: `[${game.i18n.localize("ORIGINATE.Settings.Config.Error")}]`,
                            img: "icons/svg/hazard.svg",
                            desc: e.message,
                            isManual,
                            isExcluded: excludedItems.includes(uuid)
                        }];
                    }
                }));

                const journalItems = nestedItems.flat();

                // 按名称排序
                journalItems.sort((a, b) => a.name.localeCompare(b.name));

                // 分组逻辑
                // 1. 获取已知的职业和子职业标识符
                const classOptions = await dataManager.getOptions('class', {}, { indexOnly: true });
                const subclassOptions = await dataManager.getOptions('subclass', {}, { indexOnly: true });

                console.log('Originate | Class options for grouping:', classOptions.length, classOptions.slice(0, 3));
                console.log('Originate | Subclass options for grouping:', subclassOptions.length, subclassOptions.slice(0, 3));

                const classMap = new Map(classOptions.map(c => [c.identifier, c.name]));
                const subclassMap = new Map(subclassOptions.map(s => [s.identifier, s.name]));

                // 2. 分类容器 (Map<Identifier, {name, items}>)
                const classGroupsMap = new Map();
                const subclassGroupsMap = new Map();
                const otherItems = [];

                for (const item of journalItems) {
                    if (item.identifier && classMap.has(item.identifier)) {
                        const name = classMap.get(item.identifier);
                        if (!classGroupsMap.has(item.identifier)) {
                            classGroupsMap.set(item.identifier, { name, items: [] });
                        }
                        classGroupsMap.get(item.identifier).items.push(item);
                    } else if (item.identifier && subclassMap.has(item.identifier)) {
                        const name = subclassMap.get(item.identifier);
                        if (!subclassGroupsMap.has(item.identifier)) {
                            subclassGroupsMap.set(item.identifier, { name, items: [] });
                        }
                        subclassGroupsMap.get(item.identifier).items.push(item);
                    } else {
                        otherItems.push(item);
                    }
                }

                // 3. 转换为模板所需格式 [{ identifier, name, spells: [Items], allExcluded: boolean }]
                const groupedClasses = Array.from(classGroupsMap.entries()).map(([identifier, group]) => ({
                    identifier,
                    name: group.name,
                    spells: group.items,
                    allExcluded: group.items.every(item => item.isExcluded)
                })).sort((a, b) => a.name.localeCompare(b.name));

                const groupedSubclasses = Array.from(subclassGroupsMap.entries()).map(([identifier, group]) => ({
                    identifier,
                    name: group.name,
                    spells: group.items,
                    allExcluded: group.items.every(item => item.isExcluded)
                })).sort((a, b) => a.name.localeCompare(b.name));

                // 其他项作为一个名为 "Other" 的组 (如果不为空)
                const groupedOthers = [];
                if (otherItems.length > 0) {
                    groupedOthers.push({
                        name: game.i18n.localize("ORIGINATE.Settings.Config.OtherSpells"),
                        spells: otherItems,
                        allExcluded: otherItems.every(item => item.isExcluded)
                    });
                }

                const hasClassGroups = groupedClasses.length > 0;
                const hasSubclassGroups = groupedSubclasses.length > 0;
                const hasOtherGroups = groupedOthers.length > 0;

                return {
                    ...cat,
                    // 不再传递 flat items，而是传递 Group 信息
                    // IMPORTANT: 设置 hasGroups = true 以触发模板的分组渲染逻辑
                    items: [],
                    hasGroups: true, // 触发模板的分组逻辑

                    hasClassGroups,
                    hasSubclassGroups,
                    hasOtherGroups,
                    groupedClasses,
                    groupedSubclasses,
                    groupedOthers,

                    count: journalItems.length,
                    active: cat.id === this._activeTab
                };
            }

            // 特殊处理：法术类别 - 按职业分组显示
            if (cat.id === 'spells') {
                // 获取手动配置的 UUID
                const manualUuids = sources[cat.id] || [];

                // 获取所有法术
                let allOptions = [];
                const knownClassIds = new Set();
                const knownSubclassIds = new Set();

                // 获取已知职业和子职列表以进行分类
                let classes = [];
                let subclasses = [];

                if (dataManager) {
                    allOptions = await dataManager.getOptions(cat.itemType, {}, { indexOnly: true, includeExcluded: true });

                    classes = await dataManager.getOptions('class', {}, { indexOnly: true });
                    subclasses = await dataManager.getOptions('subclass', {}, { indexOnly: true });

                    classes.forEach(c => { const id = normalizeSpellListId(c.identifier); if (id) knownClassIds.add(id); });
                    subclasses.forEach(c => { const id = normalizeSpellListId(c.identifier); if (id) knownSubclassIds.add(id); });
                }

                // 确保法术列表已加载
                await dataManager?.loadSpellListSources();
                const classSpellMap = dataManager?._classSpellMap || new Map();
                const availableClasses = dataManager?._availableClasses || [];

                // 获取自定义覆盖列表（用于区分手动添加和自动扫描的法术）
                const customOverrides = game.settings.get('character-forge', 'customSpellListOverrides') || {};
                const customOverridesByClass = new Map(
                    Object.entries(customOverrides)
                        .map(([classId, uuids]) => [normalizeSpellListId(classId), Array.isArray(uuids) ? uuids : []])
                        .filter(([classId]) => !!classId)
                );

                // 按职业/子职分组法术
                const groups = new Map(); // id -> { id, name, spells: [] }
                const uncategorizedSpells = [];

                // 初始化分组（来自法表数据源）
                for (const cls of availableClasses) {
                    groups.set(cls.id, { id: cls.id, name: cls.name, spells: [] });
                }

                // 自动检测施法职业：从所有已知职业中检测（包括自动扫描和手动添加的）
                // Adrian: 如果用户导入了法师但还没有法表，我们也要显示空分组让他能拖法术进去
                for (const cls of classes) {
                    const knownId = normalizeSpellListId(cls.identifier);
                    if (groups.has(knownId)) continue; // 已经从 availableClasses 中创建了分组
                    try {
                        const classItem = await fromUuid(cls.uuid);
                        if (!classItem) continue;
                        const prog = classItem.system?.spellcasting?.progression;
                        if (prog && prog !== "none") {
                            const id = normalizeSpellListId(classItem.system?.identifier || cls.identifier || classItem.id);
                            if (!groups.has(id)) {
                                groups.set(id, { id, name: classItem.name, spells: [] });
                                knownClassIds.add(id);
                            }
                        }
                    } catch (e) {
                        // 静默跳过无法加载的职业
                    }
                }

                // 同理检测施法子职
                for (const sub of subclasses) {
                    const knownId = normalizeSpellListId(sub.identifier);
                    if (groups.has(knownId)) continue;
                    try {
                        const subItem = await fromUuid(sub.uuid);
                        if (!subItem) continue;
                        const prog = subItem.system?.spellcasting?.progression;
                        if (prog && prog !== "none") {
                            const id = normalizeSpellListId(subItem.system?.identifier || sub.identifier || subItem.id);
                            if (!groups.has(id)) {
                                groups.set(id, { id, name: subItem.name, spells: [] });
                                knownSubclassIds.add(id);
                            }
                        }
                    } catch (e) {
                        // 静默跳过
                    }
                }

                // 构建索引缓存的 level 查找表
                // Adrian: getOptions indexOnly 不包含 level，但索引缓存里有
                const spellLevelMap = new Map();
                if (dataManager?._indexCache) {
                    for (const [, index] of dataManager._indexCache) {
                        for (const [, entry] of index.byId) {
                            if (entry.type === 'spell' && entry.system?.level !== undefined) {
                                spellLevelMap.set(entry.uuid, entry.system.level);
                            }
                        }
                    }
                }

                // 将法术分配到各个分组
                for (const spell of allOptions) {
                    const spellClasses = getSpellClassesForSpell(classSpellMap, spell);
                    const spellLevel = spellLevelMap.get(spell.uuid) ?? spell.system?.level ?? null;
                    const spellKey = normalizeSpellUuid(spell);

                    // 判断是否是通过 customOverrides 手动添加到某个职业的法术
                    const isCustomOverride = Array.from(customOverridesByClass.values()).some(
                        uuids => uuids.some(uuid => normalizeSpellUuid(uuid) === spellKey)
                    );

                    const spellData = {
                        ...spell,
                        level: spellLevel,
                        isManual: manualUuids.some(uuid => normalizeSpellUuid(uuid) === spellKey) || isCustomOverride,
                        isExcluded: excludedItems.some(uuid => normalizeSpellUuid(uuid) === spellKey),
                        hasCustomImage: hasCustomImage(cat.itemType, spell.uuid)
                    };

                    if (spellClasses && spellClasses.size > 0) {
                        for (const groupId of spellClasses) {
                            if (groups.has(groupId)) {
                                // 标记该法术在此职业中是否为手动添加
                                const isCustomInGroup = customOverridesByClass.get(groupId)?.some(uuid => normalizeSpellUuid(uuid) === spellKey);
                                groups.get(groupId).spells.push({
                                    ...spellData,
                                    isCustomInGroup
                                });
                            }
                        }
                    } else {
                        uncategorizedSpells.push(spellData);
                    }
                }

                // 补充加载 customOverrides 中不在 allOptions 里的法术
                // Adrian: 用户可能从世界或未勾选的合集包中拖入法术，这些不在 allOptions 里
                // 我们需要单独加载它们，否则拖进来的法术就"消失"了
                const allOptionUuids = new Set(allOptions.map(o => normalizeSpellUuid(o)));
                for (const [classId, spellUuids] of customOverridesByClass.entries()) {
                    if (!Array.isArray(spellUuids)) continue;
                    if (!groups.has(classId)) continue;

                    for (const spellUuid of spellUuids) {
                        if (allOptionUuids.has(normalizeSpellUuid(spellUuid))) continue; // 已经在 allOptions 中处理过了

                        try {
                            const spellItem = await fromUuid(spellUuid);
                            if (!spellItem) continue;

                            const spellLevel = spellItem.system?.level ?? spellLevelMap.get(spellUuid) ?? null;
                            const spellData = {
                                uuid: spellUuid,
                                name: spellItem.name,
                                img: spellItem.img,
                                type: spellItem.type,
                                level: spellLevel,
                                isManual: true,
                                isCustomInGroup: true,
                                isExcluded: excludedItems.some(uuid => normalizeSpellUuid(uuid) === normalizeSpellUuid(spellUuid)),
                                hasCustomImage: hasCustomImage(cat.itemType, spellUuid)
                            };
                            groups.get(classId).spells.push(spellData);
                        } catch (e) {
                            console.warn(`Originate | 无法加载自定义法术 ${spellUuid}:`, e);
                        }
                    }
                }

                // 分类并排序（不再过滤空分组，让用户能看到并拖入法术）
                const allGroups = Array.from(groups.values());

                const groupedClasses = [];
                const groupedSubclasses = [];
                const groupedOthers = [];

                for (const group of allGroups) {
                    // 排序该组内的法术
                    group.spells.sort((a, b) => a.name.localeCompare(b.name));

                    if (knownClassIds.has(group.id)) {
                        groupedClasses.push(group);
                    } else if (knownSubclassIds.has(group.id)) {
                        groupedSubclasses.push(group);
                    } else {
                        groupedOthers.push(group);
                    }
                }

                // 对分组本身按名称排序
                groupedClasses.sort((a, b) => a.name.localeCompare(b.name));
                groupedSubclasses.sort((a, b) => a.name.localeCompare(b.name));
                groupedOthers.sort((a, b) => a.name.localeCompare(b.name));

                // 构建结果对象
                const totalSpellCount = allGroups.reduce((sum, g) => sum + g.spells.length, 0) + uncategorizedSpells.length;
                const result = {
                    ...cat,
                    items: allOptions.map(opt => {
                        const optKey = normalizeSpellUuid(opt);
                        return {
                            ...opt,
                            level: spellLevelMap.get(opt.uuid) ?? opt.system?.level ?? null,
                            isManual: manualUuids.some(uuid => normalizeSpellUuid(uuid) === optKey),
                            isExcluded: excludedItems.some(uuid => normalizeSpellUuid(uuid) === optKey),
                            hasCustomImage: hasCustomImage(cat.itemType, opt.uuid)
                        };
                    }),

                    groupedClasses,
                    groupedSubclasses,
                    groupedOthers,

                    hasClassGroups: groupedClasses.length > 0,
                    hasSubclassGroups: groupedSubclasses.length > 0,
                    hasOtherGroups: groupedOthers.length > 0,

                    // hasGroups 只要有任何分组都为真
                    hasGroups: (groupedClasses.length + groupedSubclasses.length + groupedOthers.length) > 0,

                    uncategorizedSpells: uncategorizedSpells.length > 0 ? [{
                        id: 'uncategorized',
                        name: game.i18n.localize("ORIGINATE.Settings.Config.Uncategorized"),
                        spells: uncategorizedSpells
                    }] : [],
                    hasUncategorized: uncategorizedSpells.length > 0,

                    count: totalSpellCount,
                    active: cat.id === this._activeTab
                };

                return result;
            }

            // 获取手动配置的 UUID
            const manualUuids = sources[cat.id] || [];

            // 获取所有选项（包括自动扫描的）
            // 注意：这里使用 includeExcluded: true 来获取所有物品（包括被排除的）
            // 因为配置界面需要显示被排除的物品以便用户可以恢复它们
            let allOptions = [];
            if (dataManager) {
                // 始终使用 indexOnly: true 来提高性能
                // 没人想等半天只为了看个列表
                allOptions = await dataManager.getOptions(cat.itemType, {}, { indexOnly: true, includeExcluded: true });
            }

            // 获取自定义描述
            const customDescriptions = game.settings.get('character-forge', 'customDescriptions') || {};
            const typeDescriptions = customDescriptions[cat.itemType] || {};

            // 标记手动配置的项、被排除的项和自定义图片
            const items = allOptions.map(opt => ({
                ...opt,
                isManual: manualUuids.includes(opt.uuid),
                isExcluded: excludedItems.includes(opt.uuid),
                hasCustomImage: hasCustomImage(cat.itemType, opt.uuid),
                customDescription: typeDescriptions[opt.uuid] || ""
            }));

            // 如果 DataManager 不可用或返回空，回退到只显示手动配置
            // 至少还能用，对吧？
            if (items.length === 0 && manualUuids.length > 0) {
                const manualItems = await Promise.all(manualUuids.map(async (uuid) => {
                    try {
                        const item = await fromUuid(uuid);
                        return item ? {
                            uuid: uuid,
                            name: item.name,
                            img: item.img,
                            isManual: true
                        } : {
                            uuid: uuid,
                            name: `[${game.i18n.localize("ORIGINATE.Settings.Config.NotFound")}]`,
                            img: "icons/svg/hazard.svg",
                            isManual: true
                        };
                    } catch (e) {
                        return {
                            uuid: uuid,
                            name: `[${game.i18n.localize("ORIGINATE.Settings.Config.Error")}]`,
                            img: "icons/svg/hazard.svg",
                            isManual: true
                        };
                    }
                }));
                items.push(...manualItems);
            }

            return {
                ...cat,
                items: items,
                count: items.length,
                active: cat.id === this._activeTab
            };
        }));

        // 检查是否有未保存的更改
        // 别忘了保存，不然你会后悔的
        const categoriesWithSearch = categoriesWithItems.map(category => {
            const result = { ...addSourceModulesToCategory(category), searchTerm: this._getSearchTerm(category.id) };
            if (category.id === 'feats') {
                this._managedFeatBrowser = createFeatBrowser(result.items.map(toCatalogEntry), {
                    mode: 'manage', filters: this._managedFeatFilters, renderCard: renderManagedFeat
                });
                result.featBrowser = renderFeatBrowser(this._managedFeatBrowser, 'manage-feats');
            }
            return result;
        });
        const savedSourcePacks = game.settings.get('character-forge', 'sourcePacks') || [];
        const hasChanges = this._pendingSourcePacks !== null &&
            (this._pendingSourcePacks.length !== savedSourcePacks.length ||
                !this._pendingSourcePacks.every(p => savedSourcePacks.includes(p)));

        return {
            categories: categoriesWithSearch,
            availablePacks: availablePacks,
            availableModules: availableModules,
            activeTab: this._activeTab,
            sourcePacks: sourcePacks,
            hasChanges: hasChanges,
            expandedModules: this._expandedModules || {},
            sourceSearchTerm: this._getSearchTerm('sources')
        };
    }

    /**
     * 将 Compendium 包按所属 mod 分组
     * 
     * Adrian: 这就像整理书架，把同一个作者的书放在一起。
     * 包 ID 格式是 "module-id.pack-name"，我们用点号分割取第一部分。
     * 
     * @param {Array} packs - Compendium 包列表
     * @param {Array} selectedPacks - 已选中的包 ID 列表
     * @returns {Object} 按 mod 分组的对象
     */
    _groupPacksByModule(packs, selectedPacks) {
        const groups = {};

        for (const pack of packs) {
            // 包 ID 格式: "module-id.pack-name"
            const packId = pack.collection;
            const moduleId = packId.split('.')[0];

            // 获取 mod 的友好名称
            let moduleName = moduleId;
            const module = game.modules.get(moduleId);
            if (module) {
                moduleName = module.title || moduleId;
            } else if (moduleId === 'dnd5e') {
                // 系统自带的包
                moduleName = game.system.title || 'D&D 5th Edition';
            } else if (moduleId === 'world') {
                // 世界自定义的包
                moduleName = game.i18n.localize("ORIGINATE.Settings.Config.WorldCompendiums");
            }

            // 初始化分组
            if (!groups[moduleId]) {
                groups[moduleId] = {
                    moduleId: moduleId,
                    moduleName: moduleName,
                    packs: [],
                    selectedCount: 0,
                    totalCount: 0,
                    expanded: this._expandedModules?.[moduleId] || false
                };
            }

            // 添加包到分组
            const isSelected = selectedPacks.includes(packId);
            groups[moduleId].packs.push({
                id: packId,
                label: pack.title,
                selected: isSelected
            });

            groups[moduleId].totalCount++;
            if (isSelected) {
                groups[moduleId].selectedCount++;
            }
        }

        // 对每个分组内的包按名称排序
        for (const group of Object.values(groups)) {
            group.packs.sort((a, b) => a.label.localeCompare(b.label));
            // 计算选中状态：全选、部分选、未选
            group.allSelected = group.selectedCount === group.totalCount && group.totalCount > 0;
            group.partialSelected = group.selectedCount > 0 && group.selectedCount < group.totalCount;
        }

        return groups;
    }

    _getDefaultSources() {
        // 空空如也，就像我的钱包
        return {
            races: [],
            classes: [],
            subclasses: [],
            backgrounds: [],
            feats: [],
            features: [],
            spells: [],
            items: []
        };
    }

    async _prepareInitialShopContext() {
        const entries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || []);
        const groups = new Map();
        const labels = this._getInitialShopCategoryLabels();

        for (const entry of entries) {
            let item = null;
            try {
                item = await fromUuid(entry.uuid);
            } catch (error) {
                console.warn(`Originate | 初始商店商品加载失败: ${entry.uuid}`, error);
            }

            const type = item?.type || 'other';
            const category = getInitialEquipmentCategory(type);
            if (!groups.has(category)) {
                groups.set(category, {
                    id: category,
                    label: labels[category] || labels.other,
                    items: []
                });
            }

            const sourceModuleId = getSourceModuleId(item || entry.uuid);
            groups.get(category).items.push({
                ...entry,
                name: item?.name || game.i18n.localize('ORIGINATE.InitialShop.MissingItem'),
                img: item?.img || 'icons/svg/item-bag.svg',
                type,
                category,
                sourceModuleId,
                purchasePriceText: entry.purchasePriceGp ?? '',
                sellPriceText: entry.sellPriceGp ?? '',
                canPurchase: entry.canPurchase && entry.purchasePriceGp !== null,
                missing: !item,
                searchText: `${item?.name || entry.uuid} ${type} ${sourceModuleId || ''}`
            });
        }

        const orderedGroups = ['weapon', 'equipment', 'consumable', 'tool', 'container', 'loot', 'other']
            .filter(id => groups.has(id))
            .map(id => groups.get(id));

        for (const group of orderedGroups) {
            group.items.sort((a, b) => a.name.localeCompare(b.name));
        }

        return {
            count: entries.length,
            groups: orderedGroups,
            hasGroups: orderedGroups.length > 0,
            sellRatePercent: Math.round(normalizeSellMultiplier(
                game.settings.get('character-forge', 'initialEquipmentShopSellMultiplier'),
                INITIAL_EQUIPMENT_SELL_MULTIPLIER
            ) * 100),
            active: this._activeTab === 'initialShop',
            searchTerm: this._getSearchTerm('initialShop')
        };
    }

    _getInitialShopCategoryLabels() {
        return {
            weapon: game.i18n.localize('ORIGINATE.InitialShop.Category.Weapon'),
            equipment: game.i18n.localize('ORIGINATE.InitialShop.Category.Equipment'),
            consumable: game.i18n.localize('ORIGINATE.InitialShop.Category.Consumable'),
            tool: game.i18n.localize('ORIGINATE.InitialShop.Category.Tool'),
            container: game.i18n.localize('ORIGINATE.InitialShop.Category.Container'),
            loot: game.i18n.localize('ORIGINATE.InitialShop.Category.Loot'),
            other: game.i18n.localize('ORIGINATE.InitialShop.Category.Other')
        };
    }

    /** @override - 保存手风琴状态后再重新渲染 */
    render(options = {}, _options = {}) {
        if (this.element) {
            this._openAccordions = new Set();
            this.element.querySelectorAll('details.spell-group[open]').forEach(d => {
                const id = d.querySelector('summary')?.dataset?.classId;
                if (id) this._openAccordions.add(id);
            });
        }
        return super.render(options, _options);
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);

        const html = this.element;

        // 恢复滚动位置
        // 贴心的小细节
        const content = html.querySelector('.config-content');
        if (content && this._scrollPositions['content']) {
            content.scrollTop = this._scrollPositions['content'];
        }

        const sourcesList = html.querySelector('.sources-list');
        if (sourcesList && this._scrollPositions['sources-list']) {
            sourcesList.scrollTop = this._scrollPositions['sources-list'];
        }

        // 恢复当前活动类别的 drop-zone 滚动位置
        // Adrian: 这是为了解决排除/恢复物品时滚动位置重置的问题
        const activeCategory = html.querySelector('.config-category.active');
        if (activeCategory) {
            const categoryId = activeCategory.dataset.category;
            const dropZone = activeCategory.querySelector('.config-drop-zone');
            if (dropZone && this._scrollPositions[`dropzone-${categoryId}`]) {
                dropZone.scrollTop = this._scrollPositions[`dropzone-${categoryId}`];
            }
        }

        // 恢复手风琴展开状态
        if (this._openAccordions && this._openAccordions.size > 0) {
            html.querySelectorAll('details.spell-group').forEach(d => {
                const id = d.querySelector('summary')?.dataset?.classId;
                if (id && this._openAccordions.has(id)) {
                    d.setAttribute('open', '');
                }
            });
        }

        // 绑定滚动事件以记录位置
        if (content) {
            content.addEventListener('scroll', () => {
                this._scrollPositions['content'] = content.scrollTop;
            });
        }
        if (sourcesList) {
            sourcesList.addEventListener('scroll', () => {
                this._scrollPositions['sources-list'] = sourcesList.scrollTop;
            });
        }

        // 绑定 drop-zone 滚动事件
        html.querySelectorAll('.config-drop-zone').forEach(zone => {
            const categorySection = zone.closest('.config-category');
            if (categorySection) {
                const categoryId = categorySection.dataset.category;
                zone.addEventListener('scroll', () => {
                    this._scrollPositions[`dropzone-${categoryId}`] = zone.scrollTop;
                });
            }
        });

        // 绑定标签切换
        html.querySelectorAll('.config-tab').forEach(tab => {
            tab.addEventListener('click', (ev) => {
                this._activeTab = ev.currentTarget.dataset.tab;
                this.render();
            });
        });

        // 绑定拖放
        // 现代化的交互方式，虽然有时候不太灵敏
        html.querySelectorAll('.config-drop-zone').forEach(zone => {
            zone.addEventListener('dragover', this._onDragOver.bind(this));
            zone.addEventListener('drop', this._onDrop.bind(this));
        });

        // 绑定双击打开物品卡
        // Adrian: 双击查看物品详情，就像在合集包里一样
        html.querySelectorAll('.config-item').forEach(item => {
            if (item.closest('[data-feat-catalog]')) return;
            item.addEventListener('dblclick', this._onDoubleClickItem.bind(this));
        });

        // 绑定法术分组的拖放功能
        // Adrian: 拖拽法术到职业分组上来添加到该职业的法表
        html.querySelectorAll('.spell-drop-target').forEach(target => {
            target.addEventListener('dragover', this._onSpellGroupDragOver.bind(this));
            target.addEventListener('drop', this._onSpellGroupDrop.bind(this));
            target.addEventListener('dragleave', this._onSpellGroupDragLeave.bind(this));
        });

        // 绑定环阶筛选按钮
        // Adrian: 纯前端过滤，不需要重新渲染
        html.querySelectorAll('.spell-level-filter .filter-btn').forEach(btn => {
            btn.addEventListener('click', this._onSpellLevelFilter.bind(this));
        });

        // 搜索也是纯前端过滤，尽量别让用户每敲一个字就等一轮重渲染
        html.querySelectorAll('.config-search-input').forEach(input => {
            input.addEventListener('input', this._onCategorySearchInput.bind(this));
            input.addEventListener('search', this._onCategorySearchInput.bind(this));
        });

        html.querySelectorAll('.btn-clear-search').forEach(btn => {
            btn.addEventListener('click', this._onClearSearchClick.bind(this));
        });

        html.querySelectorAll('.initial-shop-price').forEach(input => {
            input.addEventListener('change', this._onInitialShopPriceChange.bind(this));
        });

        html.querySelectorAll('.initial-shop-purchase-toggle').forEach(input => {
            input.addEventListener('change', this._onInitialShopPurchaseToggle.bind(this));
        });

        html.querySelector('.initial-shop-sell-rate')?.addEventListener('change', this._onInitialShopSellRateChange.bind(this));

        this._initializeItemFilterState(html);
        this._applyStoredSearchFilters(html);

        const featBrowser = html.querySelector('[data-feat-catalog="manage-feats"]');
        if (featBrowser && this._managedFeatBrowser) {
            bindFeatBrowser(featBrowser, this._managedFeatBrowser, {
                onFilters: filters => { this._managedFeatFilters = filters; }
            });
            // 翻页会更换行，双击委托给稳定容器；ApplicationV2 的 data-action 仍处理启用与排除。
            featBrowser.addEventListener('dblclick', event => {
                if (event.target.closest('button')) return;
                const row = event.target.closest('.config-item');
                if (row) this._onDoubleClickItem({ currentTarget: row });
            });
        }

        // 窗口自适应缩放
        this._windowScaleObserver = applyWindowScaling($(html), 1500, 950);
    }

    async close(options) {
        cleanupWindowScaling(this._windowScaleObserver);
        this._windowScaleObserver = null;
        const result = await super.close(options);
        releaseForgeStyles(this);
        return result;
    }

    /**
     * 双击物品打开物品卡
     * 
     * Adrian: 用户双击配置项时，打开对应物品的只读预览。
     * 这样可以快速查看物品详情而不需要去合集包里翻找。
     */
    async _onDoubleClickItem(event) {
        const itemEl = event.currentTarget;
        const uuid = itemEl.querySelector('[data-uuid]')?.dataset?.uuid ||
            itemEl.querySelector('button[data-uuid]')?.dataset?.uuid;

        if (!uuid) return;

        try {
            const doc = await fromUuid(uuid);
            if (doc) {
                // 打开物品卡（只读模式，合集包物品默认只读）
                doc.sheet.render(true);
            }
        } catch (e) {
            console.error("Originate | 无法打开物品卡:", e);
            ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.Config.CannotOpenItem"));
        }
    }

    /**
     * 法术分组拖放处理 - Drag Over
     * Adrian: 允许接受拖放的法术
     */
    _onSpellGroupDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.add('drag-over-spell');
    }

    /**
     * 法术分组拖放处理 - Drag Leave
     * Adrian: 离开时移除高亮
     */
    _onSpellGroupDragLeave(event) {
        event.currentTarget.classList.remove('drag-over-spell');
    }

    /**
     * 法术分组拖放处理 - Drop
     * Adrian: 将拖放的法术添加到目标职业法表
     */
    async _onSpellGroupDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.remove('drag-over-spell');

        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        if (!data || data.type !== 'Item') {
            ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.Config.DragSpell"));
            return;
        }

        const classId = normalizeSpellListId(
            event.currentTarget.dataset.classId
            || event.target?.closest('[data-class-id]')?.dataset?.classId
        );
        if (!classId) {
            console.warn("Originate | 法术分组拖放未找到职业 ID，尝试作为普通拖放处理");
            // 回退到通用 _onDrop 处理
            return this._onDrop(event);
        }

        try {
            // 验证是否为法术
            const item = await fromUuid(data.uuid);
            if (!item || item.type !== 'spell') {
                ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.Config.OnlySpells"));
                return;
            }

            // 获取当前覆盖设置
            const customOverrides = game.settings.get('character-forge', 'customSpellListOverrides') || {};

            // 初始化职业的法术数组（如果不存在）
            if (!customOverrides[classId]) {
                customOverrides[classId] = [];
            }

            // 检查是否已存在
            if (customOverrides[classId].includes(data.uuid)) {
                ui.notifications.info(game.i18n.format("ORIGINATE.Settings.Config.AlreadyInList", { name: item.name }));
                return;
            }

            // 添加法术
            customOverrides[classId].push(data.uuid);
            await game.settings.set('character-forge', 'customSpellListOverrides', customOverrides);

            // 刷新法术列表数据
            this._debouncedReloadSpellLists();

            ui.notifications.info(game.i18n.format("ORIGINATE.Settings.Config.SpellAdded", { name: item.name }));

            // 重新渲染以显示新法术
            this.render();
        } catch (e) {
            console.error("Originate | 添加法术失败:", e);
            ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.AddSpellFailed"));
        }
    }

    _onDragOver(event) {
        event.preventDefault();
        event.currentTarget.classList.add('drag-over');
    }

    async _onDrop(event) {
        event.preventDefault();
        event.currentTarget.classList.remove('drag-over');

        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        if (!data) return;

        // 获取目标类别
        const category = event.currentTarget.dataset.category;
        if (!category) return;

        if (category === 'initialShop') {
            await this._onInitialShopDrop(data);
            return;
        }

        // 特殊处理：法术列表类别
        if (category === 'spellLists') {
            if (data.type !== 'JournalEntry') {
                ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.Config.InvalidJournal") || game.i18n.localize("ORIGINATE.Settings.Config.DragJournal"));
                return;
            }

            const uuid = data.uuid;
            if (!uuid) return;

            // 添加到法术列表来源
            const spellListSources = game.settings.get('character-forge', 'spellListSources') || [];

            if (spellListSources.includes(uuid)) {
                ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.AlreadyExists"));
                return;
            }

            spellListSources.push(uuid);
            await game.settings.set('character-forge', 'spellListSources', spellListSources);

            // 重新加载 DataManager 的法术列表
            const dataManager = game.modules.get('character-forge')?.api?.dataManager;
            if (dataManager) {
                await dataManager.loadSpellListSources(true);
            }

            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ItemAdded"));
            this.render();
            return;
        }

        // 原有的 Item 处理逻辑
        if (data.type !== 'Item') return;

        const uuid = data.uuid;
        if (!uuid) return;

        // 验证 Item 类型
        // 别把苹果放进橘子篮里
        const item = await fromUuid(uuid);
        if (!item) {
            ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.InvalidItem"));
            return;
        }

        // 检查 Item 类型是否匹配
        const expectedType = OriginateConfigApp.CATEGORY_TYPE_MAP[category];
        if (item.type !== expectedType) {
            ui.notifications.warn(game.i18n.format("ORIGINATE.Settings.Config.TypeMismatch", {
                expected: expectedType,
                actual: item.type
            }));
            return;
        }

        // 添加到配置
        await this._addItemToCategory(category, uuid);
        this.render();
    }

    async _onInitialShopDrop(data) {
        if (!data || data.type !== 'Item') return;

        const uuid = data.uuid;
        if (!uuid) return;

        const item = await fromUuid(uuid);
        if (!item) {
            ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.InvalidItem"));
            return;
        }

        if (!INITIAL_EQUIPMENT_ITEM_TYPES.has(item.type)) {
            ui.notifications.warn(game.i18n.format("ORIGINATE.InitialShop.InvalidItemType", { type: item.type }));
            return;
        }

        const entries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || []);
        const normalizedUuid = uuid.replace(/\.Item\./, '.');
        if (entries.some(entry => entry.uuid.replace(/\.Item\./, '.') === normalizedUuid)) {
            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.AlreadyExists"));
            return;
        }

        const price = resolveItemPriceGp(item);
        entries.push({
            uuid,
            purchasePriceGp: price,
            sellPriceGp: null,
            canPurchase: price !== null
        });

        await game.settings.set('character-forge', 'initialEquipmentShop', entries);
        ui.notifications.info(game.i18n.localize("ORIGINATE.InitialShop.ItemAdded"));
        this.render();
    }

    async _onRemoveShopItem(event, target) {
        const uuid = target.dataset.uuid;
        if (!uuid) return;

        const normalizedUuid = uuid.replace(/\.Item\./, '.');
        const entries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || [])
            .filter(entry => entry.uuid.replace(/\.Item\./, '.') !== normalizedUuid);

        await game.settings.set('character-forge', 'initialEquipmentShop', entries);
        this.render();
    }

    async _onInitialShopPriceChange(event) {
        const input = event.currentTarget;
        const uuid = input.dataset.uuid;
        const field = input.dataset.field;
        if (!uuid || !field) return;

        const entries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || []);
        const normalizedUuid = uuid.replace(/\.Item\./, '.');
        const entry = entries.find(item => item.uuid.replace(/\.Item\./, '.') === normalizedUuid);
        if (!entry) return;

        if (field === 'purchasePriceGp') {
            entry.purchasePriceGp = normalizeNullablePrice(input.value);
            if (entry.purchasePriceGp === null) entry.canPurchase = false;
        } else if (field === 'sellPriceGp') {
            entry.sellPriceGp = normalizeNullablePrice(input.value);
        }

        await game.settings.set('character-forge', 'initialEquipmentShop', entries);
        this.render();
    }

    async _onInitialShopPurchaseToggle(event) {
        const input = event.currentTarget;
        const uuid = input.dataset.uuid;
        if (!uuid) return;

        const entries = normalizeShopEntries(game.settings.get('character-forge', 'initialEquipmentShop') || []);
        const normalizedUuid = uuid.replace(/\.Item\./, '.');
        const entry = entries.find(item => item.uuid.replace(/\.Item\./, '.') === normalizedUuid);
        if (!entry) return;

        if (entry.purchasePriceGp === null && input.checked) {
            ui.notifications.warn(game.i18n.localize("ORIGINATE.InitialShop.PriceRequired"));
            input.checked = false;
            return;
        }

        entry.canPurchase = input.checked;
        await game.settings.set('character-forge', 'initialEquipmentShop', entries);
        this.render();
    }

    async _onInitialShopSellRateChange(event) {
        const rawValue = event.currentTarget.value;
        const percent = Number(rawValue);
        const multiplier = normalizeSellMultiplier(
            rawValue !== '' && Number.isFinite(percent) ? percent / 100 : null,
            INITIAL_EQUIPMENT_SELL_MULTIPLIER
        );
        await game.settings.set('character-forge', 'initialEquipmentShopSellMultiplier', multiplier);
        this.render();
    }

    async _addItemToCategory(category, uuid) {
        const sources = game.settings.get('character-forge', 'sources') || this._getDefaultSources();

        if (!sources[category]) {
            sources[category] = [];
        }

        // 检查是否已存在
        // 别重复添加，浪费空间
        if (sources[category].includes(uuid)) {
            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.AlreadyExists"));
            return;
        }

        sources[category].push(uuid);
        await game.settings.set('character-forge', 'sources', sources);

        ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ItemAdded"));
    }

    async _onRemoveItem(event, target) {
        const uuid = target.dataset.uuid;
        const category = target.dataset.category;

        if (!uuid || !category) return;

        // 特殊处理：法术列表类别
        if (category === 'spellLists') {
            let spellListSources = game.settings.get('character-forge', 'spellListSources') || [];

            // 尝试直接匹配（Journal Entry UUID）
            if (spellListSources.includes(uuid)) {
                spellListSources = spellListSources.filter(u => u !== uuid);
            } else {
                // 页面 UUID 的情况：找到包含此页面的父 Journal Entry UUID
                // 页面 UUID 格式: ...JournalEntry.XXX.JournalEntryPage.YYY
                // 父 UUID 格式: ...JournalEntry.XXX
                const parentUuid = spellListSources.find(u => uuid.startsWith(u));
                if (parentUuid) {
                    spellListSources = spellListSources.filter(u => u !== parentUuid);
                }
            }

            await game.settings.set('character-forge', 'spellListSources', spellListSources);

            // 重新加载 DataManager 的法术列表
            const dataManager = game.modules.get('character-forge')?.api?.dataManager;
            if (dataManager) {
                await dataManager.loadSpellListSources(true);
            }

            this.render();
            return;
        }

        // 原有 Item 移除逻辑
        const sources = game.settings.get('character-forge', 'sources') || this._getDefaultSources();

        if (sources[category]) {
            sources[category] = sources[category].filter(u => u !== uuid);
            await game.settings.set('character-forge', 'sources', sources);
        }

        this.render();
    }

    /**
     * 移除手动添加到职业法表的法术
     * Adrian: 用户拖进去的法术，当然也要能删掉
     */
    async _onRemoveCustomSpell(event, target) {
        const uuid = target.dataset.uuid;
        const classId = normalizeSpellListId(target.dataset.classId);

        if (!uuid || !classId) return;

        const customOverrides = game.settings.get('character-forge', 'customSpellListOverrides') || {};

        if (customOverrides[classId] && Array.isArray(customOverrides[classId])) {
            customOverrides[classId] = customOverrides[classId].filter(u => u !== uuid);

            // 如果该职业下没有自定义法术了，删除这个键
            if (customOverrides[classId].length === 0) {
                delete customOverrides[classId];
            }

            await game.settings.set('character-forge', 'customSpellListOverrides', customOverrides);

            // 重新加载法术列表
            const dataManager = game.modules.get('character-forge')?.api?.dataManager;
            if (dataManager) {
                await dataManager.loadSpellListSources(true);
            }

            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ItemRemoved") || "Item removed");
            this.render();
        }
    }

    /**
     * 环阶筛选按钮点击处理
     * Adrian: 纯 DOM 操作，速度飞快
     */
    _onSpellLevelFilter(event) {
        const btn = event.currentTarget;
        const level = btn.dataset.level;
        const filterContainer = btn.closest('.spell-level-filter');
        const spellGroup = btn.closest('.spell-group');
        if (!spellGroup) return;

        // 更新按钮激活状态
        filterContainer.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // 过滤法术列表
        const spellItems = spellGroup.querySelectorAll('.config-item');
        spellItems.forEach(item => {
            const itemLevel = item.dataset.spellLevel;
            const levelHidden = level !== 'all' && itemLevel !== level;
            item.dataset.levelHidden = levelHidden ? 'true' : 'false';
            this._syncItemFilterVisibility(item);
        });

        const categorySection = btn.closest('.config-category');
        if (categorySection) {
            this._applyCategorySearch(categorySection, this._getSearchTerm(categorySection.dataset.category));
        }
    }

    _getSearchTerm(categoryId) {
        return this._searchTerms?.[categoryId] || '';
    }

    _normalizeSearchText(text) {
        return String(text || '')
            .trim()
            .toLocaleLowerCase();
    }

    _onCategorySearchInput(event) {
        const input = event.currentTarget;
        const categoryId = input.dataset.categorySearch;
        if (!categoryId) return;

        this._searchTerms[categoryId] = input.value || '';

        const section = input.closest('.config-category');
        if (section) {
            this._applyCategorySearch(section, input.value);
        }
    }

    _onClearSearchClick(event) {
        const button = event.currentTarget;
        const categoryId = button.dataset.categorySearch;
        if (!categoryId) return;

        const section = button.closest('.config-category');
        const input = section?.querySelector(`.config-search-input[data-category-search="${categoryId}"]`);
        if (!input) return;

        input.value = '';
        this._searchTerms[categoryId] = '';
        this._applyCategorySearch(section, '');
        input.focus();
    }

    _initializeItemFilterState(html) {
        html.querySelectorAll('.config-item').forEach(item => {
            if (!('searchHidden' in item.dataset)) {
                item.dataset.searchHidden = 'false';
            }
            if (!('levelHidden' in item.dataset)) {
                item.dataset.levelHidden = 'false';
            }
            this._syncItemFilterVisibility(item);
        });
    }

    _applyStoredSearchFilters(html) {
        html.querySelectorAll('.config-category').forEach(section => {
            this._applyCategorySearch(section, this._getSearchTerm(section.dataset.category));
        });
    }

    _applyCategorySearch(section, rawTerm = '') {
        if (!section) return;
        if (section.querySelector('[data-feat-catalog]')) return;

        const categoryId = section.dataset.category;
        const term = this._normalizeSearchText(rawTerm);
        const clearButton = section.querySelector('.btn-clear-search');
        if (clearButton) {
            clearButton.hidden = !term;
        }

        if (categoryId === 'sources') {
            this._applySourcesSearch(section, term);
            return;
        }

        if (section.querySelector('.spell-groups-container')) {
            this._applyGroupedItemSearch(section, term);
            return;
        }

        this._applyFlatItemSearch(section, term);
    }

    _applySourcesSearch(section, term) {
        const folders = Array.from(section.querySelectorAll('.module-folder'));
        let hasVisibleFolder = false;

        folders.forEach(folder => {
            const moduleName = this._normalizeSearchText(folder.dataset.searchText);
            const moduleMatched = !term || moduleName.includes(term);
            let hasVisiblePack = false;

            folder.querySelectorAll('.pack-item-nested').forEach(pack => {
                const packMatched = moduleMatched || this._normalizeSearchText(pack.dataset.searchText).includes(term);
                pack.hidden = !packMatched;
                hasVisiblePack = hasVisiblePack || packMatched;
            });

            const shouldShowFolder = !term || moduleMatched || hasVisiblePack;
            folder.hidden = !shouldShowFolder;
            folder.classList.toggle('search-expanded', Boolean(term) && hasVisiblePack);
            hasVisibleFolder = hasVisibleFolder || shouldShowFolder;
        });

        this._toggleSearchEmpty(section, Boolean(term) && !hasVisibleFolder);
    }

    _applyFlatItemSearch(section, term) {
        const items = Array.from(section.querySelectorAll('.config-item'));
        let visibleCount = 0;

        items.forEach(item => {
            const matches = !term || this._normalizeSearchText(item.dataset.searchText).includes(term);
            item.dataset.searchHidden = matches ? 'false' : 'true';
            if (this._syncItemFilterVisibility(item)) {
                visibleCount += 1;
            }
        });

        this._toggleSearchEmpty(section, Boolean(term) && items.length > 0 && visibleCount === 0);
    }

    _applyGroupedItemSearch(section, term) {
        const groupsContainer = section.querySelector('.spell-groups-container');
        if (!groupsContainer) return;

        let visibleItemCount = 0;

        groupsContainer.querySelectorAll('.spell-group').forEach(group => {
            const groupName = this._normalizeSearchText(group.dataset.groupName);
            const groupMatched = Boolean(term) && groupName.includes(term);
            let groupVisibleCount = 0;

            group.querySelectorAll('.config-item').forEach(item => {
                const itemMatched = groupMatched || !term || this._normalizeSearchText(item.dataset.searchText).includes(term);
                item.dataset.searchHidden = itemMatched ? 'false' : 'true';
                if (this._syncItemFilterVisibility(item)) {
                    groupVisibleCount += 1;
                }
            });

            visibleItemCount += groupVisibleCount;

            if (!term) {
                if (group.dataset.searchOriginalOpen !== undefined) {
                    group.open = group.dataset.searchOriginalOpen === 'true';
                    delete group.dataset.searchOriginalOpen;
                }
                group.hidden = false;
                return;
            }

            group.hidden = groupVisibleCount === 0;

            if (groupVisibleCount > 0) {
                if (group.dataset.searchOriginalOpen === undefined) {
                    group.dataset.searchOriginalOpen = group.open ? 'true' : 'false';
                }
                group.open = true;
            }
        });

        this._syncGroupDividerVisibility(groupsContainer, Boolean(term));
        this._toggleSearchEmpty(section, Boolean(term) && visibleItemCount === 0);
    }

    _syncGroupDividerVisibility(container, hasActiveSearch) {
        let currentDivider = null;
        let hasVisibleGroup = false;

        const flushDivider = () => {
            if (currentDivider) {
                currentDivider.hidden = hasActiveSearch ? !hasVisibleGroup : false;
            }
        };

        Array.from(container.children).forEach(child => {
            if (child.matches('.group-divider')) {
                flushDivider();
                currentDivider = child;
                hasVisibleGroup = false;
                return;
            }

            if (child.matches('.spell-group') && !child.hidden) {
                hasVisibleGroup = true;
            }
        });

        flushDivider();
    }

    _toggleSearchEmpty(section, shouldShow) {
        const emptyState = section.querySelector('.config-search-empty');
        if (!emptyState) return;
        emptyState.hidden = !shouldShow;
    }

    _syncItemFilterVisibility(item) {
        const hiddenBySearch = item.dataset.searchHidden === 'true';
        const hiddenByLevel = item.dataset.levelHidden === 'true';
        const shouldHide = hiddenBySearch || hiddenByLevel;
        item.classList.toggle('filtered-hidden', shouldHide);
        return !shouldHide;
    }

    async _onClearCategory(event, target) {
        const category = target.dataset.category;
        if (!category) return;

        const confirmed = await DialogV2.confirm({
            window: { title: game.i18n.localize("ORIGINATE.Settings.Config.ClearConfirmTitle") },
            content: game.i18n.format("ORIGINATE.Settings.Config.ClearConfirmContent", { category })
        });

        if (!confirmed) return;

        // 特殊处理：法术列表类别
        if (category === 'spellLists') {
            await game.settings.set('character-forge', 'spellListSources', []);
            const dataManager = game.modules.get('character-forge')?.api?.dataManager;
            if (dataManager) {
                await dataManager.loadSpellListSources(true);
            }
            this.render();
            return;
        }

        const sources = game.settings.get('character-forge', 'sources') || this._getDefaultSources();
        sources[category] = [];
        await game.settings.set('character-forge', 'sources', sources);

        this.render();
    }

    async _onImportFromPack(event, target) {
        const packId = this.element.querySelector('.pack-selector')?.value;
        const category = this._activeTab;

        if (!packId || !category) return;

        const pack = game.packs.get(packId);
        if (!pack) return;

        // 获取包中所有匹配类型的 Item
        // 一次性导入，爽快
        const expectedType = OriginateConfigApp.CATEGORY_TYPE_MAP[category];
        const index = await pack.getIndex();

        const matchingItems = index.filter(i => i.type === expectedType);

        if (matchingItems.length === 0) {
            ui.notifications.warn(game.i18n.format("ORIGINATE.Settings.Config.NoMatchingItems", {
                type: expectedType,
                pack: pack.title
            }));
            return;
        }

        // 批量添加
        const sources = game.settings.get('character-forge', 'sources') || this._getDefaultSources();
        if (!sources[category]) sources[category] = [];

        let addedCount = 0;
        for (const item of matchingItems) {
            const uuid = `Compendium.${packId}.Item.${item._id}`;
            if (!sources[category].includes(uuid)) {
                sources[category].push(uuid);
                addedCount++;
            }
        }

        await game.settings.set('character-forge', 'sources', sources);

        ui.notifications.info(game.i18n.format("ORIGINATE.Settings.Config.ImportedItems", {
            count: addedCount
        }));

        this.render();
    }

    async _onToggleSourcePack(event, target) {
        // 保存当前滚动位置
        const content = this.element.querySelector('.config-content');
        if (content) this._scrollPositions['content'] = content.scrollTop;

        const sourcesList = this.element.querySelector('.sources-list');
        if (sourcesList) this._scrollPositions['sources-list'] = sourcesList.scrollTop;

        const packId = target.dataset.pack;
        const checked = target.checked;

        // 如果还没有暂存状态，初始化为当前保存的设置
        if (this._pendingSourcePacks === null) {
            this._pendingSourcePacks = [...(game.settings.get('character-forge', 'sourcePacks') || [])];
        }

        if (checked) {
            if (!this._pendingSourcePacks.includes(packId)) {
                this._pendingSourcePacks.push(packId);
            }
        } else {
            const index = this._pendingSourcePacks.indexOf(packId);
            if (index > -1) {
                this._pendingSourcePacks.splice(index, 1);
            }
        }

        this.render();
    }

    async _onSaveSourcePacks(event, target) {
        if (this._pendingSourcePacks === null) return;

        await game.settings.set('character-forge', 'sourcePacks', this._pendingSourcePacks);
        this._pendingSourcePacks = null; // 清除暂存状态

        // 重新加载数据管理器索引
        // 告诉 DataManager 有新东西了
        try {
            const api = game.modules.get('character-forge')?.api;
            if (api?.reloadIndex) {
                await api.reloadIndex();
                ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.SourcesUpdated"));
            } else {
                ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.SourcesSavedRefresh"));
            }
        } catch (e) {
            console.error("Originate | 更新数据源索引失败:", e);
            ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.SourcesSavedIndexError"));
        }

        this.render();
    }

    /**
     * 切换文件夹展开/折叠状态
     * 
     * Adrian: 点一下展开，再点一下折叠。简单粗暴。
     */
    _onToggleModuleFolder(event, target) {
        const moduleId = target.dataset.module;
        if (!moduleId) return;

        // 初始化展开状态存储
        if (!this._expandedModules) {
            this._expandedModules = {};
        }

        // 切换状态
        this._expandedModules[moduleId] = !this._expandedModules[moduleId];
        const isExpanded = this._expandedModules[moduleId];

        // 直接更新 DOM，不重新渲染
        // 找到父级 li 元素
        const folderLi = target.closest('.module-folder');
        if (folderLi) {
            if (isExpanded) {
                folderLi.classList.add('expanded');
            } else {
                folderLi.classList.remove('expanded');
            }

            // 更新图标
            const icon = target.querySelector('i');
            if (icon) {
                icon.className = isExpanded ? 'fas fa-folder-open' : 'fas fa-folder';
            }

            // 更新提示
            target.title = game.i18n.localize(isExpanded ? 'ORIGINATE.Settings.Config.Collapse' : 'ORIGINATE.Settings.Config.Expand');
        }
    }

    /**
     * 切换整个 mod 的所有包
     * 
     * Adrian: 一键全选/全不选，懒人福音。
     * 如果当前是部分选中或全不选，就全选；如果已经全选，就全不选。
     */
    _onToggleModuleAll(event, target) {
        const moduleId = target.dataset.module;
        if (!moduleId) return;

        // 保存滚动位置
        const sourcesList = this.element.querySelector('.sources-list');
        if (sourcesList) this._scrollPositions['sources-list'] = sourcesList.scrollTop;

        // 如果还没有暂存状态，初始化为当前保存的设置
        if (this._pendingSourcePacks === null) {
            this._pendingSourcePacks = [...(game.settings.get('character-forge', 'sourcePacks') || [])];
        }

        // 获取该 mod 下的所有包
        const allPacks = Array.from(game.packs).filter(p => p.documentName === 'Item');
        const modulePacks = allPacks.filter(p => p.collection.split('.')[0] === moduleId);
        const modulePackIds = modulePacks.map(p => p.collection);

        // 检查当前是否全选
        const allSelected = modulePackIds.every(id => this._pendingSourcePacks.includes(id));

        if (allSelected) {
            // 全不选：移除该 mod 的所有包
            this._pendingSourcePacks = this._pendingSourcePacks.filter(id => !modulePackIds.includes(id));
        } else {
            // 全选：添加该 mod 的所有包
            for (const packId of modulePackIds) {
                if (!this._pendingSourcePacks.includes(packId)) {
                    this._pendingSourcePacks.push(packId);
                }
            }
        }

        this.render();
    }

    /**
     * 排除一个自动扫描的物品
     * 
     * Adrian: 有时候合集里有些东西你就是不想要，比如那些测试用的垃圾数据。
     * 这个功能让你可以把它们踢出去，眼不见心不烦。
     */
    async _onExcludeItem(event, target) {
        const uuid = target.dataset.uuid;
        if (!uuid) return;

        // 保存当前活动类别的 drop-zone 滚动位置
        this._saveDropZoneScrollPosition();

        const excludedItems = game.settings.get('character-forge', 'excludedItems') || [];

        if (!excludedItems.includes(uuid)) {
            excludedItems.push(uuid);
            await game.settings.set('character-forge', 'excludedItems', excludedItems);

            // 刷新法术列表数据 (防抖)
            this._debouncedReloadSpellLists();

            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ItemExcluded"));

            // 乐观更新 UI
            const itemEl = target.closest('.config-item');
            if (itemEl) {
                itemEl.classList.add('excluded');

                // 更新按钮
                target.classList.remove('btn-exclude');
                target.classList.add('btn-include');
                target.dataset.action = 'includeItem';
                target.title = game.i18n.localize('ORIGINATE.Settings.Config.Include');
                target.innerHTML = '<i class="fas fa-undo"></i>';

                // 检查是否需要更新分组状态
                const groupEl = itemEl.closest('.spell-group');
                if (groupEl) {
                    const listEl = groupEl.querySelector('.spell-group-list');
                    if (listEl) {
                        const hasActiveItems = Array.from(listEl.querySelectorAll('.config-item')).some(el => !el.classList.contains('excluded'));
                        if (!hasActiveItems) groupEl.classList.add('all-excluded');
                    }
                }
            }
        }
    }

    /**
     * 恢复一个被排除的物品
     * 
     * Adrian: 后悔了？没关系，点一下就能把它请回来。
     */
    async _onIncludeItem(event, target) {
        const uuid = target.dataset.uuid;
        if (!uuid) return;

        // 保存当前活动类别的 drop-zone 滚动位置
        this._saveDropZoneScrollPosition();

        let excludedItems = game.settings.get('character-forge', 'excludedItems') || [];

        excludedItems = excludedItems.filter(u => u !== uuid);
        await game.settings.set('character-forge', 'excludedItems', excludedItems);

        // 刷新法术列表数据 (防抖)
        this._debouncedReloadSpellLists();

        ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ItemIncluded"));

        // 乐观更新 UI
        const itemEl = target.closest('.config-item');
        if (itemEl) {
            itemEl.classList.remove('excluded');

            // 更新按钮
            target.classList.remove('btn-include');
            target.classList.add('btn-exclude');
            target.dataset.action = 'excludeItem';
            target.title = game.i18n.localize('ORIGINATE.Settings.Config.Exclude');
            target.innerHTML = '<i class="fas fa-ban"></i>';

            // 检查是否需要更新分组状态 (肯定不为空了，所以移除 greyed-out)
            const groupEl = itemEl.closest('.spell-group');
            if (groupEl) {
                groupEl.classList.remove('all-excluded');
            }
        }
    }

    /**
     * 保存当前活动类别的 drop-zone 滚动位置
     * 
     * Adrian: 用户体验细节，别让人每次操作都要重新滚动找位置。
     */
    _saveDropZoneScrollPosition() {
        const activeCategory = this.element.querySelector('.config-category.active');
        if (activeCategory) {
            const dropZone = activeCategory.querySelector('.config-drop-zone');
            if (dropZone) {
                const categoryId = activeCategory.dataset.category;
                this._scrollPositions[`dropzone-${categoryId}`] = dropZone.scrollTop;
            }
        }
    }

    /**
     * 设置自定义展示图片
     * 
     * 图片路径、展示方式和预览放在一起，用户选完就能知道最终会不会裁掉边缘。
     */
    async _onSetCustomImage(event, target) {
        const uuid = target.dataset.uuid;
        const category = target.dataset.category;
        const itemName = target.dataset.name || 'Unknown';

        if (!uuid || !category) return;

        // 获取 Item 类型（用于存储）
        const itemType = OriginateConfigApp.CATEGORY_TYPE_MAP[category];
        if (!itemType) return;

        // 保存滚动位置
        this._saveDropZoneScrollPosition();

        const currentImage = getCustomImageConfig(itemType, uuid);
        const result = await openCustomImageConfig({
            itemName,
            path: currentImage?.path || '',
            fit: currentImage?.fit || 'contain',
            allowFit: ['class', 'race', 'background'].includes(itemType)
        });

        if (!result) return;

        await setCustomImage(itemType, uuid, result.path, result.fit);
        ui.notifications.info(game.i18n.format("ORIGINATE.Settings.Config.CustomImageSet", { name: itemName }));
        this.render();
    }

    /**
     * 清除自定义展示图片
     * 
     * Adrian: 后悔了？没关系，点一下就能恢复默认。
     */
    async _onClearCustomImage(event, target) {
        const uuid = target.dataset.uuid;
        const category = target.dataset.category;
        const itemName = target.dataset.name || 'Unknown';

        if (!uuid || !category) return;

        // 获取 Item 类型
        const itemType = OriginateConfigApp.CATEGORY_TYPE_MAP[category];
        if (!itemType) return;

        // 保存滚动位置
        this._saveDropZoneScrollPosition();

        // 清除自定义图片
        await setCustomImage(itemType, uuid, null);
        ui.notifications.info(game.i18n.format("ORIGINATE.Settings.Config.CustomImageCleared", { name: itemName }));

        this.render();
    }

    /**
     * 编辑自定义描述
     * 
     * Adrian: 既然 DND5E 的源数据有时候写得那叫一个语焉不详，我就给你留了个可以自己动手的地方。
     * 你想给这职业写点多“带劲”的内容都行，全看你心情。
     * 顺手我也帮大家把第一段预览文字给抠出来了，如果你实在懒得敲字，就先凑合用着吧。
     */
    async _onEditDescription(event, target) {
        const uuid = target.dataset.uuid;
        const category = target.dataset.category;
        const itemName = target.dataset.name || 'Unknown';

        if (!uuid || !category) return;

        // 获取 Item 类型
        const itemType = OriginateConfigApp.CATEGORY_TYPE_MAP[category];
        if (!itemType) return;

        // 1. 尝试获取现有的自定义描述
        const customDescriptions = game.settings.get('character-forge', 'customDescriptions') || {};
        const typeDescriptions = customDescriptions[itemType] || {};
        let descriptionToEdit = typeDescriptions[uuid];

        // 2. 如果没有自定义描述，尝试加载 Item 的原始描述并提取第一段纯文本
        if (!descriptionToEdit) {
            try {
                const item = await fromUuid(uuid);
                if (item && item.system?.description?.value) {
                    let rawDesc = item.system.description.value;

                    // 移除 UUID 引用
                    rawDesc = rawDesc.replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, '$1')
                        .replace(/@UUID\[[^\]]*\]/g, '')
                        .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, '$1')
                        .replace(/@\w+\[[^\]]*\]/g, '');

                    // 转换为纯文本 (保留换行)
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = rawDesc;
                    descriptionToEdit = tempDiv.innerText.trim();
                }
            } catch (e) {
                console.warn("Originate | Failed to load default description:", e);
            }
        }

        // 确保不为 undefined
        descriptionToEdit = descriptionToEdit || "";

        // 弹出编辑对话框
        const content = `
            <div class="form-group">
                <label>${game.i18n.localize("ORIGINATE.Settings.Config.DescriptionLabel")}</label>
                <textarea name="description" style="width: 100%; height: 400px; resize: vertical; font-family: inherit;">${descriptionToEdit}</textarea>
                <p class="notes">${game.i18n.localize("ORIGINATE.Settings.Config.DescriptionHint")}</p>
            </div>
        `;

        new Dialog({
            title: game.i18n.format("ORIGINATE.Settings.Config.EditDescriptionTitle", { name: itemName }),
            content: content,
            buttons: {
                save: {
                    icon: '<i class="fas fa-save"></i>',
                    label: game.i18n.localize("ORIGINATE.Settings.Config.Save"),
                    callback: async (html) => {
                        const newDesc = html.find('[name="description"]').val();

                        // 保存描述
                        const customDescriptions = game.settings.get('character-forge', 'customDescriptions') || {};

                        if (!customDescriptions[itemType]) {
                            customDescriptions[itemType] = {};
                        }

                        if (newDesc.trim()) {
                            customDescriptions[itemType][uuid] = newDesc.trim();
                        } else {
                            // 如果为空，删除条目
                            delete customDescriptions[itemType][uuid];
                        }

                        await game.settings.set('character-forge', 'customDescriptions', customDescriptions);

                        // 保存滚动位置并刷新
                        this._saveDropZoneScrollPosition();
                        this.render();

                        ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.DescriptionSaved"));
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("ORIGINATE.Settings.Config.Cancel")
                }
            },
            default: "save"
        }, {
            classes: ["originate-dialog", "originate-dark-theme"],
            width: 910,
            height: 780,
            resizable: true
        }).render(true);
    }

    /**
     * 导出设置到 JSON 文件
     * 
     * Adrian: 终于来了！用户可以把辛辛苦苦配置的设置导出来，
     * 然后在其他世界导入，省得每次都要重新配置。
     * 这就像是给你的配置做个备份，以防万一。
     * 
     * 注意：在 Foundry/Electron 环境中，blob URL 不能直接下载，
     * 所以我们使用 Foundry 内置的 saveDataToFile 方法。
     */
    async _onExportSettings(event, target) {
        try {
            // 收集所有需要导出的设置
            const exportData = {
                version: 2, // v2 的自定义图片会同时保存路径和展示方式
                exportDate: new Date().toISOString(),
                moduleName: 'character-forge',
                settings: {
                    // 数据源合集包配置
                    sourcePacks: game.settings.get('character-forge', 'sourcePacks') || [],
                    // UUID 列表（种族、职业等）
                    sources: game.settings.get('character-forge', 'sources') || this._getDefaultSources(),
                    // 排除的物品列表
                    excludedItems: game.settings.get('character-forge', 'excludedItems') || [],
                    // 自定义图片映射
                    customImages: getAllCustomImages(),
                    // 自定义描述
                    customDescriptions: game.settings.get('character-forge', 'customDescriptions') || {},
                    initialEquipmentShop: game.settings.get('character-forge', 'initialEquipmentShop') || [],
                    initialEquipmentShopSellMultiplier: game.settings.get('character-forge', 'initialEquipmentShopSellMultiplier') ?? INITIAL_EQUIPMENT_SELL_MULTIPLIER,
                    // PHB 图片文件夹路径
                    phbImageFolder: game.settings.get('character-forge', 'phbImageFolder') || '',
                    // 欢迎语设置
                    welcomeMessage: game.settings.get('character-forge', 'welcomeMessage') || ''
                }
            };

            // 生成文件名
            const worldName = game.world.id || 'unknown';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `character-forge-settings-${worldName}-${timestamp}.json`;

            // 使用 Foundry 内置的 saveDataToFile 方法
            const jsonStr = JSON.stringify(exportData, null, 2);
            saveDataToFile(jsonStr, 'application/json', filename);

            ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ExportSuccess"));
        } catch (e) {
            console.error("Originate | 导出设置失败:", e);
            ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.ExportError"));
        }
    }

    /**
     * 从 JSON 文件导入设置
     * 
     * Adrian: 导入功能来了！选择之前导出的 JSON 文件，
     * 一键恢复所有配置。再也不用每个世界都重新配置了。
     * 
     * 注意：导入会覆盖当前的设置，所以会先弹个确认框。
     */
    async _onImportSettings(event, target) {
        // 创建文件输入元素
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const importData = JSON.parse(text);

                // 验证导入数据的格式
                if (!importData.moduleName || !['character-forge', 'originate'].includes(importData.moduleName)) {
                    ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.ImportInvalidFile"));
                    return;
                }

                if (!importData.settings) {
                    ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.ImportInvalidFormat"));
                    return;
                }

                const confirmed = await DialogV2.confirm({
                    window: {
                        title: game.i18n.localize("ORIGINATE.Settings.Config.ImportConfirmTitle")
                    },
                    content: `
                        <p>${game.i18n.localize("ORIGINATE.Settings.Config.ImportConfirmContent")}</p>
                        <p><strong>${game.i18n.localize("ORIGINATE.Settings.Config.ImportConfirmWarning")}</strong></p>
                        <ul>
                            <li>${game.i18n.localize("ORIGINATE.Settings.Config.ImportInfo.SourcePacks")}: ${importData.settings.sourcePacks?.length || 0}</li>
                            <li>${game.i18n.localize("ORIGINATE.Settings.Config.ImportInfo.ExcludedItems")}: ${importData.settings.excludedItems?.length || 0}</li>
                            <li>${game.i18n.localize("ORIGINATE.Settings.Config.ImportInfo.CustomImages")}: ${this._countCustomImages(importData.settings.customImages)}</li>
                            <li>${game.i18n.localize("ORIGINATE.InitialShop.Title")}: ${importData.settings.initialEquipmentShop?.length || 0}</li>
                        </ul>
                        <p><small>${game.i18n.format("ORIGINATE.Settings.Config.ImportInfo.ExportDate", { date: importData.exportDate || 'Unknown' })}</small></p>
                    `
                });

                if (!confirmed) return;

                // 执行导入
                await this._applyImportedSettings(importData.settings);

                ui.notifications.info(game.i18n.localize("ORIGINATE.Settings.Config.ImportSuccess"));

                // 重新加载数据管理器索引
                try {
                    const api = game.modules.get('character-forge')?.api;
                    if (api?.reloadIndex) {
                        await api.reloadIndex();
                    }
                } catch (e) {
                    console.warn("Originate | 更新数据源索引失败:", e);
                }

                // 刷新界面
                this.render();

            } catch (e) {
                console.error("Originate | 导入设置失败:", e);
                ui.notifications.error(game.i18n.localize("ORIGINATE.Settings.Config.ImportError"));
            }
        };

        input.click();
    }

    /**
     * 统计自定义图片数量
     * 
     * Adrian: 辅助函数，用于在导入确认框中显示自定义图片的数量。
     */
    _countCustomImages(customImages) {
        if (!customImages) return 0;
        let count = 0;
        for (const type of Object.values(customImages)) {
            if (type && typeof type === 'object') {
                count += Object.keys(type).length;
            }
        }
        return count;
    }

    /**
     * 应用导入的设置
     * 
     * Adrian: 把导入的数据写入到 Foundry 的设置系统中。
     * 这里要小心处理，确保每个设置都正确写入。
     */
    async _applyImportedSettings(settings) {
        // 导入数据源合集包配置
        if (settings.sourcePacks !== undefined) {
            await game.settings.set('character-forge', 'sourcePacks', settings.sourcePacks);
            this._pendingSourcePacks = null; // 清除暂存状态
        }

        // 导入 UUID 列表
        if (settings.sources !== undefined) {
            await game.settings.set('character-forge', 'sources', settings.sources);
        }

        // 导入排除的物品列表
        if (settings.excludedItems !== undefined) {
            await game.settings.set('character-forge', 'excludedItems', settings.excludedItems);
        }

        // 导入自定义图片映射
        if (settings.customImages !== undefined) {
            await setAllCustomImages(settings.customImages);
        }

        // 导入自定义描述
        if (settings.customDescriptions !== undefined) {
            await game.settings.set('character-forge', 'customDescriptions', settings.customDescriptions);
        }

        if (settings.initialEquipmentShop !== undefined) {
            await game.settings.set('character-forge', 'initialEquipmentShop', settings.initialEquipmentShop);
        }

        if (settings.initialEquipmentShopSellMultiplier !== undefined) {
            await game.settings.set(
                'character-forge',
                'initialEquipmentShopSellMultiplier',
                normalizeSellMultiplier(settings.initialEquipmentShopSellMultiplier, INITIAL_EQUIPMENT_SELL_MULTIPLIER)
            );
        }

        // 导入 PHB 图片文件夹路径
        if (settings.phbImageFolder !== undefined) {
            await game.settings.set('character-forge', 'phbImageFolder', settings.phbImageFolder);
        }

        // 导入欢迎语设置
        if (settings.welcomeMessage !== undefined) {
            await game.settings.set('character-forge', 'welcomeMessage', settings.welcomeMessage);
        }
    }

    /**
     * 打开法术规则配置窗口
     */
    _onOpenSpellRules(event, target) {
        new SpellRulesConfigApp().render(true);
    }
}


/**
 * Wiki 跳转桩类
 * 
 * Foundry 的 registerMenu 需要一个 Application 类型，
 * 所以我们创建一个"打开即跳转"的桩类：render 时直接打开外部链接。
 */
class WikiRedirectApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "originate-wiki-redirect",
            title: "Originate Wiki",
            template: "templates/setup/blank.html",
            width: 1,
            height: 1
        });
    }

    async _render(force, options) {
        window.open("https://ionian-arch-c39.notion.site/Originate-3153fec7727d80cc9f56e524bdf70c09?source=copy_link", "_blank");
        return;
    }

    async _updateObject() { }
}

/**
 * 注册所有设置
 * 
 * 就像在市政厅登记一样，虽然繁琐，但是必须的。
 */
export function registerSettings() {
    // 1. 数据源配置 (Data Sources) - 永远排在第一位
    game.settings.registerMenu('character-forge', 'configMenu', {
        name: "ORIGINATE.Settings.ConfigMenu.Name",
        label: "ORIGINATE.Settings.ConfigMenu.Label",
        hint: "ORIGINATE.Settings.ConfigMenu.Hint",
        icon: "fas fa-cogs",
        type: OriginateConfigApp,
        restricted: true
    });

    // 2. 外观配置面板 (Aspects Configuration)
    game.settings.registerMenu("character-forge", "aspectsMenu", {
        name: "ORIGINATE.Aspects.Title",
        label: "ORIGINATE.Aspects.Button",
        hint: "ORIGINATE.Aspects.Hint",
        icon: "fas fa-paint-brush",
        type: AspectsConfigApp,
        restricted: true
    });

    // 3. 属性规则配置 (Properties Configuration) - 新增
    game.settings.registerMenu("character-forge", "propertiesMenu", {
        name: "ORIGINATE.Properties.Title",
        label: "ORIGINATE.Properties.Button",
        hint: "ORIGINATE.Properties.Hint",
        icon: "fas fa-dice-d20",
        type: PropertiesConfigApp,
        restricted: true
    });

    // 4. Wiki / 文档 (Documentation)
    game.settings.registerMenu('character-forge', 'wikiMenu', {
        name: "ORIGINATE.Wiki.Title",
        label: "ORIGINATE.Wiki.Button",
        hint: "ORIGINATE.Wiki.Hint",
        icon: "fas fa-book",
        type: WikiRedirectApp,
        restricted: false
    });

    // ========== 隐藏的配置项 (由上述菜单管理) ==========

    // 欢迎语设置
    game.settings.register('character-forge', 'welcomeMessage', {
        name: "ORIGINATE.Settings.WelcomeMessage.Name",
        scope: 'world',
        config: false, // 隐藏
        type: String,
        default: "Ready to embark on your journey, adventurer?"
    });

    // 属性生成模式
    game.settings.register('character-forge', 'abilityMode', {
        name: "ORIGINATE.Settings.AbilityMode.Name",
        hint: "ORIGINATE.Settings.AbilityMode.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: String,
        choices: {
            "free": "ORIGINATE.Settings.AbilityMode.Free",
            "pointbuy": "ORIGINATE.Settings.AbilityMode.PointBuy",
            "roll": "ORIGINATE.Settings.AbilityMode.Roll",
            "standardArray": "ORIGINATE.Settings.AbilityMode.StandardArray"
        },
        default: "free"
    });

    game.settings.register('character-forge', 'standardArrayScores', {
        name: "ORIGINATE.Settings.StandardArrayScores.Name",
        hint: "ORIGINATE.Settings.StandardArrayScores.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: [...DEFAULT_STANDARD_ARRAY]
    });

    // 属性步骤位置
    // Adrian: 有些 DM 喜欢先让玩家定属性再选职业，有些喜欢反过来。
    // 给他们一个选择的权利，省得吵架。
    game.settings.register('character-forge', 'abilityStepPosition', {
        name: "ORIGINATE.Settings.AbilityStepPosition.Name",
        hint: "ORIGINATE.Settings.AbilityStepPosition.Hint",
        scope: 'world',
        config: false,
        type: String,
        choices: {
            "early": "ORIGINATE.Settings.AbilityStepPosition.Early",
            "late": "ORIGINATE.Settings.AbilityStepPosition.Late"
        },
        default: "late"
    });

    // 买点法总点数
    game.settings.register('character-forge', 'pointBuyTotal', {
        name: "ORIGINATE.Settings.PointBuyTotal.Name",
        hint: "ORIGINATE.Settings.PointBuyTotal.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: Number,
        default: 27,
        range: {
            min: 15,
            max: 50,
            step: 1
        }
    });

    // 买点法属性上限
    game.settings.register('character-forge', 'pointBuyMaxScore', {
        name: "ORIGINATE.Settings.PointBuyMaxScore.Name",
        hint: "ORIGINATE.Settings.PointBuyMaxScore.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: Number,
        default: 15,
        range: {
            min: 13,
            max: 18,
            step: 1
        }
    });

    // 初始属性值
    // Adrian: 不是所有 DM 都喜欢 8 作为起始值，给他们一个选择的机会
    game.settings.register('character-forge', 'baseAbilityScore', {
        name: "ORIGINATE.Settings.BaseAbilityScore.Name",
        hint: "ORIGINATE.Settings.BaseAbilityScore.Hint",
        scope: 'world',
        config: false, // 隐藏，由 PropertiesConfigApp 管理
        type: Number,
        default: 8,
        range: {
            min: 1,
            max: 20,
            step: 1
        }
    });

    // 掷骰公式
    game.settings.register('character-forge', 'rollFormula', {
        name: "ORIGINATE.Settings.RollFormula.Name",
        hint: "ORIGINATE.Settings.RollFormula.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: String,
        default: "4d6kh3"
    });

    // 掷骰子模式
    game.settings.register('character-forge', 'rollMode', {
        name: "ORIGINATE.Settings.RollMode.Name",
        hint: "ORIGINATE.Settings.RollMode.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: String,
        choices: {
            "fixed": "ORIGINATE.Settings.RollMode.Fixed",
            "free": "ORIGINATE.Settings.RollMode.Free"
        },
        default: "free"
    });

    // 可掷骰次数
    game.settings.register('character-forge', 'rollAttempts', {
        name: "ORIGINATE.Settings.RollAttempts.Name",
        hint: "ORIGINATE.Settings.RollAttempts.Hint",
        scope: 'world',
        config: false, // 隐藏
        type: Number,
        default: 1,
        range: {
            min: 1,
            max: 10,
            step: 1
        }
    });

    // 视觉主题设置
    game.settings.register('character-forge', 'visualTheme', {
        name: "ORIGINATE.Settings.VisualTheme.Name",
        hint: "ORIGINATE.Settings.VisualTheme.Hint",
        scope: 'client',
        config: false,
        type: String,
        choices: {
            "gold": "ORIGINATE.Settings.VisualTheme.Gold",
            "silver": "ORIGINATE.Settings.VisualTheme.Silver"
        },
        default: "gold",
        onChange: () => {
            // 兜底：视觉设置面板在界面开着时会拒绝切主题（aspects-config._updateObject），
            // 这里只接绕过面板（宏/控制台 settings.set）的情况。
            // 旧写法在 ui.windows 里找 "originate-app"——本应用是 ApplicationV2，
            // 根本不进 ui.windows，而且 id 其实是 originate-char-gen，双重找不到，纯死代码。
            foundry.applications.instances.get('originate-char-gen')?.render();
        }
    });

    game.settings.register('character-forge', 'startPageBackground', {
        name: "ORIGINATE.Settings.StartPageBackground.Name",
        hint: "ORIGINATE.Settings.StartPageBackground.Hint",
        scope: 'world',
        config: false,
        type: String,
        default: "",
        filePicker: 'imagevideo'
    });

    // 角色详情页面背景（名字、阵营、外貌、个性、传记）
    game.settings.register('character-forge', 'detailsPageBackground', {
        name: "ORIGINATE.Settings.DetailsPageBackground.Name",
        hint: "ORIGINATE.Settings.DetailsPageBackground.Hint",
        scope: 'world',
        config: false,
        type: String,
        default: "",
        filePicker: 'imagevideo'
    });

    game.settings.register('character-forge', 'welcomeMessageFont', {
        name: "ORIGINATE.Settings.WelcomeMessageFont.Name",
        hint: "ORIGINATE.Settings.WelcomeMessageFont.Hint",
        scope: 'world',
        config: false,
        type: String,
        default: "Cinzel"
    });

    // 自定义字体列表
    // Adrian: 用户可以上传自己的字体文件，然后在欢迎语字体选项中使用
    game.settings.register('character-forge', 'customFonts', {
        name: "ORIGINATE.Settings.CustomFonts.Name",
        hint: "ORIGINATE.Settings.CustomFonts.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: []
    });

    // ========== 其他无需隐藏的设置 ==========

    // 5R 专长规则开关 (已废弃/隐藏)
    game.settings.register('character-forge', 'use5RFeatRules', {
        name: "ORIGINATE.Settings.Use5RFeatRules.Name",
        hint: "ORIGINATE.Settings.Use5RFeatRules.Hint",
        scope: 'world',
        config: false,
        type: Boolean,
        default: false
    });

    // 无限制 ASI 分配
    // 开启后，种族和背景的 ASI 不再受属性限制，玩家可以自由分配到任意属性
    game.settings.register('character-forge', 'unrestrictedASI', {
        name: "ORIGINATE.Settings.UnrestrictedASI.Name",
        hint: "ORIGINATE.Settings.UnrestrictedASI.Hint",
        scope: 'world',
        config: false,
        type: Boolean,
        default: false
    });

    // 纯净语言模式 (已废弃/隐藏)
    game.settings.register('character-forge', 'pureLanguage', {
        name: "ORIGINATE.Settings.PureLanguage.Name",
        hint: "ORIGINATE.Settings.PureLanguage.Hint",
        scope: 'client',
        config: false,
        type: Boolean,
        default: false
    });

    // 是否使用 Originate 进行角色升级
    game.settings.register('character-forge', 'useLevelUp', {
        name: "ORIGINATE.Settings.UseLevelUp.Name",
        hint: "ORIGINATE.Settings.UseLevelUp.Hint",
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });

    // 跳过角色自定义细节
    game.settings.register('character-forge', 'skipCustomCharacterDetails', {
        name: "ORIGINATE.Settings.SkipCustomCharacter.Name",
        hint: "ORIGINATE.Settings.SkipCustomCharacter.Hint",
        scope: 'world',
        config: true,
        type: Boolean,
        default: false,
        onChange: () => {
            const app = Object.values(ui.windows).find(w => w.id === "originate-app");
            if (!app) return;

            const activeSteps = typeof app._getActiveSteps === 'function' ? app._getActiveSteps() : [];
            if (activeSteps.length && !activeSteps.includes(app.currentStep)) {
                app.currentStep = activeSteps.at(-1);
            }
            app.render();
        }
    });

    // 兼职系统开关
    game.settings.register('character-forge', 'useMulticlass', {
        name: "ORIGINATE.Settings.UseMulticlass.Name",
        hint: "ORIGINATE.Settings.UseMulticlass.Hint",
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    // PHB 图片文件夹路径
    game.settings.register('character-forge', 'phbImageFolder', {
        name: "ORIGINATE.Settings.PHBImageFolder.Name",
        hint: "ORIGINATE.Settings.PHBImageFolder.Hint",
        scope: 'world',
        config: true,
        type: String,
        default: "modules/dnd-players-handbook/assets/journal-art",
        filePicker: 'folder'
    });

    // 自定义图片映射配置
    game.settings.register('character-forge', 'customImages', {
        name: "ORIGINATE.Settings.CustomImages.Name",
        hint: "ORIGINATE.Settings.CustomImages.Hint",
        scope: 'world',
        config: false,
        type: Object,
        default: {
            class: {},
            race: {},
            background: {},
            subclass: {}
        }
    });

    // 自定义描述配置
    game.settings.register('character-forge', 'customDescriptions', {
        name: "ORIGINATE.Settings.CustomDescriptions.Name",
        hint: "ORIGINATE.Settings.CustomDescriptions.Hint",
        scope: 'world',
        config: false,
        type: Object,
        default: {
            class: {},
            subclass: {}
        }
    });

    // 新的简化配置：UUID 列表
    game.settings.register('character-forge', 'sources', {
        name: "ORIGINATE.Settings.Sources.Name",
        hint: "ORIGINATE.Settings.Sources.Hint",
        scope: 'world',
        config: false,
        type: Object,
        default: {
            races: [],
            classes: [],
            subclasses: [],
            backgrounds: [],
            feats: [],
            spells: [],
            items: []
        }
    });

    // 数据源合集包配置
    game.settings.register('character-forge', 'sourcePacks', {
        name: "ORIGINATE.Settings.SourcePacks.Name",
        hint: "ORIGINATE.Settings.SourcePacks.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: []
    });

    // 排除的物品列表
    game.settings.register('character-forge', 'excludedItems', {
        name: "ORIGINATE.Settings.ExcludedItems.Name",
        hint: "ORIGINATE.Settings.ExcludedItems.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: []
    });

    // 法术列表期刊来源
    game.settings.register('character-forge', 'spellListSources', {
        name: "ORIGINATE.Settings.SpellListSources.Name",
        hint: "ORIGINATE.Settings.SpellListSources.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: []
    });

    // 自定义法术列表覆盖
    game.settings.register('character-forge', 'customSpellListOverrides', {
        name: "ORIGINATE.Settings.CustomSpellListOverrides.Name",
        hint: "ORIGINATE.Settings.CustomSpellListOverrides.Hint",
        scope: 'world',
        config: false,
        type: Object,
        default: {}
    });

    game.settings.register('character-forge', 'initialEquipmentShop', {
        name: "ORIGINATE.InitialShop.Settings.Name",
        hint: "ORIGINATE.InitialShop.Settings.Hint",
        scope: 'world',
        config: false,
        type: Array,
        default: []
    });

    game.settings.register('character-forge', 'initialEquipmentShopSellMultiplier', {
        name: "ORIGINATE.InitialShop.SellRate",
        hint: "ORIGINATE.InitialShop.SellRateHint",
        scope: 'world',
        config: false,
        type: Number,
        default: INITIAL_EQUIPMENT_SELL_MULTIPLIER
    });

    // 法术规则覆盖（DM 自定义的法术规则，覆盖内置默认值）
    game.settings.register('character-forge', 'spellRules', {
        name: "ORIGINATE.Settings.SpellRules.Name",
        hint: "ORIGINATE.Settings.SpellRules.Hint",
        scope: 'world',
        config: false,
        type: Object,
        default: {}
    });

    // 保留旧配置以便迁移
    game.settings.register('character-forge', 'data', {
        name: "ORIGINATE.Settings.Data.Name",
        scope: 'world',
        config: false,
        type: Object,
        default: {}
    });
}
