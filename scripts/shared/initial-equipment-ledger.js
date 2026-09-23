import { resolveItemSourceUuid as resolveTrackedItemSourceUuid } from './source-tracking.js';

export const INITIAL_EQUIPMENT_ITEM_TYPES = new Set([
    'container',
    'backpack',
    'equipment',
    'weapon',
    'consumable',
    'tool',
    'loot'
]);

const STACKABLE_INITIAL_EQUIPMENT_ITEM_TYPES = new Set([
    'equipment',
    'weapon',
    'consumable',
    'tool',
    'loot'
]);

export const INITIAL_EQUIPMENT_SELL_MULTIPLIER = 0.5;

function getStackQuantity(item) {
    const quantity = Number(item?.system?.quantity ?? 1);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

export function mergeInitialEquipmentQuantity(target, incoming) {
    if (!target || !incoming
        || target.type !== incoming.type
        || !STACKABLE_INITIAL_EQUIPMENT_ITEM_TYPES.has(target.type)) {
        return false;
    }

    target.system ||= {};
    target.system.quantity = getStackQuantity(target) + getStackQuantity(incoming);
    return true;
}

const CURRENCY_TO_GP = {
    pp: 10,
    gp: 1,
    ep: 0.5,
    sp: 0.1,
    cp: 0.01
};

export function getInitialEquipmentCategory(type) {
    if (type === 'weapon') return 'weapon';
    if (type === 'equipment') return 'equipment';
    if (type === 'consumable') return 'consumable';
    if (type === 'tool') return 'tool';
    if (type === 'container' || type === 'backpack') return 'container';
    if (type === 'loot') return 'loot';
    return 'other';
}

export function normalizeShopEntries(rawEntries = []) {
    if (!Array.isArray(rawEntries)) return [];

    return rawEntries
        .map(entry => ({
            uuid: String(entry?.uuid || '').trim(),
            purchasePriceGp: normalizeNullablePrice(entry?.purchasePriceGp),
            sellPriceGp: normalizeNullablePrice(entry?.sellPriceGp),
            canPurchase: entry?.canPurchase !== false
        }))
        .filter(entry => entry.uuid);
}

export function buildShopEntryMap(rawEntries = []) {
    const entries = normalizeShopEntries(rawEntries);
    return new Map(entries.map(entry => [normalizeUuid(entry.uuid), entry]));
}

export function normalizePriceNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return roundGp(number);
}

export function normalizeNullablePrice(value) {
    if (value === '' || value === null || value === undefined) return null;
    return normalizePriceNumber(value);
}

export function roundGp(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

export function normalizeSellMultiplier(value, fallback = INITIAL_EQUIPMENT_SELL_MULTIPLIER) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.round(number * 10000) / 10000;
}

export function splitGpToCurrencyParts(value = 0) {
    let totalCopper = Math.max(0, Math.round((Number(value) || 0) * 100));
    const gp = Math.floor(totalCopper / 100);
    totalCopper -= gp * 100;
    const sp = Math.floor(totalCopper / 10);
    const cp = totalCopper - sp * 10;
    return { gp, sp, cp };
}

export function resolveItemSourceUuid(item = {}) {
    return resolveTrackedItemSourceUuid(item);
}

export function normalizeUuid(uuid) {
    return uuid ? String(uuid).replace(/\.Item\./, '.').trim() : '';
}

export function resolveItemPriceGp(item = {}) {
    const price = item.system?.price ?? item.system?.cost ?? null;
    if (typeof price === 'number') return normalizePriceNumber(price);
    if (typeof price === 'string') return normalizePriceNumber(price);
    if (!price || typeof price !== 'object') return null;

    const denomination = price.denomination || price.currency || 'gp';
    const value = price.value ?? price.amount ?? price.quantity ?? 0;
    const rate = CURRENCY_TO_GP[String(denomination || 'gp').toLowerCase()] ?? 1;
    return normalizePriceNumber(Number(value) * rate);
}

export function resolveItemQuantity(item = {}) {
    const quantity = Number(item.system?.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) return 1;
    return quantity;
}

export function isInitialEquipmentItem(item = {}) {
    return INITIAL_EQUIPMENT_ITEM_TYPES.has(item?.type);
}

export function resolveSellPriceGp(item = {}, shopEntry = null, {
    sellMultiplier = INITIAL_EQUIPMENT_SELL_MULTIPLIER
} = {}) {
    if (shopEntry?.sellPriceGp !== null && shopEntry?.sellPriceGp !== undefined) {
        return normalizePriceNumber(shopEntry.sellPriceGp);
    }

    const basePrice = resolveItemPriceGp(item);
    if (basePrice === null) return null;

    return roundGp(basePrice * sellMultiplier);
}

export function getBlueprintCurrencyGp(blueprint = {}) {
    const system = blueprint.system || {};
    const readCurrency = denomination => Number(system[`currency.${denomination}`] ?? system.currency?.[denomination] ?? 0);
    const total = Object.entries(CURRENCY_TO_GP).reduce((sum, [denomination, rate]) => {
        const amount = readCurrency(denomination);
        return Number.isFinite(amount) ? sum + amount * rate : sum;
    }, 0);
    return roundGp(total);
}

export function setBlueprintCurrencyGp(blueprint = {}, gp = 0) {
    if (!blueprint.system) blueprint.system = {};
    const parts = splitGpToCurrencyParts(gp);
    blueprint.system['currency.pp'] = 0;
    blueprint.system['currency.gp'] = parts.gp;
    blueprint.system['currency.ep'] = 0;
    blueprint.system['currency.sp'] = parts.sp;
    blueprint.system['currency.cp'] = parts.cp;
    if (blueprint.system.currency) {
        blueprint.system.currency.pp = 0;
        blueprint.system.currency.gp = parts.gp;
        blueprint.system.currency.ep = 0;
        blueprint.system.currency.sp = parts.sp;
        blueprint.system.currency.cp = parts.cp;
    }
}

export function buildInitialEquipmentSellEntries(blueprint = {}, shopEntries = [], options = {}) {
    const shopMap = shopEntries instanceof Map ? shopEntries : buildShopEntryMap(shopEntries);

    return (blueprint.items || [])
        .map((item, index) => {
            if (!isInitialEquipmentItem(item)) return null;

            const sourceUuid = resolveItemSourceUuid(item);
            const shopEntry = sourceUuid ? shopMap.get(normalizeUuid(sourceUuid)) : null;
            const unitSellPriceGp = resolveSellPriceGp(item, shopEntry, options);
            const quantity = resolveItemQuantity(item);

            return {
                id: getLedgerItemId(item, index),
                index,
                item,
                sourceUuid,
                name: item.name || globalThis.game?.i18n?.localize?.('ORIGINATE.InitialShop.UnknownItem') || 'Unknown Item',
                img: item.img || 'icons/svg/item-bag.svg',
                type: item.type || 'item',
                category: getInitialEquipmentCategory(item.type),
                quantity,
                unitSellPriceGp,
                totalSellPriceGp: unitSellPriceGp === null ? null : roundGp(unitSellPriceGp * quantity),
                canSell: unitSellPriceGp !== null
            };
        })
        .filter(Boolean);
}

export function hasInitialEquipmentShopChoices(sellEntries = [], purchaseEntries = []) {
    return sellEntries.some(entry => entry?.canSell) || purchaseEntries.length > 0;
}

export function getLedgerItemId(item = {}, index = 0) {
    return [
        normalizeUuid(resolveItemSourceUuid(item)),
        item._id || '',
        item.name || '',
        item.type || '',
        index
    ].join('|');
}

export function applyInitialEquipmentLedger(blueprint = {}, ledger = {}) {
    const soldIds = new Set(ledger.soldIds || []);
    const purchasedItems = Array.isArray(ledger.purchasedItems) ? ledger.purchasedItems : [];
    const finalBlueprint = cloneData(blueprint);
    const sellEntries = buildInitialEquipmentSellEntries(finalBlueprint, ledger.shopEntries || []);
    const soldIndexes = new Set();

    for (const entry of sellEntries) {
        if (!soldIds.has(entry.id) || !entry.canSell) continue;
        soldIndexes.add(entry.index);
        collectContainerChildIndexes(finalBlueprint.items || [], entry.item, soldIndexes);
    }

    finalBlueprint.items = (finalBlueprint.items || []).filter((_item, index) => !soldIndexes.has(index));
    finalBlueprint.items.push(...purchasedItems.map(item => cloneData(item)));

    const baseGp = getBlueprintCurrencyGp(finalBlueprint);
    setBlueprintCurrencyGp(finalBlueprint, baseGp + calculateLedgerDeltaGp(ledger));

    return finalBlueprint;
}

export function calculateLedgerDeltaGp(ledger = {}) {
    const soldEntries = Array.isArray(ledger.soldEntries) ? ledger.soldEntries : [];
    const purchaseEntries = Array.isArray(ledger.purchaseEntries) ? ledger.purchaseEntries : [];
    const income = soldEntries.reduce((sum, entry) => sum + Number(entry.totalSellPriceGp || 0), 0);
    const spending = purchaseEntries.reduce((sum, entry) => sum + Number(entry.purchasePriceGp || 0), 0);
    return roundGp(income - spending);
}

export function canAffordPurchase(currentGp, ledger = {}, priceGp = 0) {
    if (priceGp === null || priceGp === undefined) return false;
    const available = roundGp(Number(currentGp || 0) + calculateLedgerDeltaGp(ledger));
    return available >= roundGp(priceGp);
}

function collectContainerChildIndexes(items = [], containerItem = {}, soldIndexes) {
    const sourceUuid = resolveItemSourceUuid(containerItem);
    const sourceId = sourceUuid?.split('.')?.pop();
    const localId = containerItem._id || sourceId;
    if (!localId) return;

    items.forEach((item, index) => {
        const container = item?.system?.container || item?.flags?.originate?.pendingContainerId;
        if (container && (container === localId || container === sourceId)) {
            soldIndexes.add(index);
        }
    });
}

function cloneData(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    return JSON.parse(JSON.stringify(value));
}
