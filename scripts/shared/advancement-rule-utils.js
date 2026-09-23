import { expandWeaponProficiency } from '../mapping.js';
import { getAdvancementEntries } from '../utils/advancement-utils.js';
import { resolveItemSourceUuid, stampSourceTracking } from './source-tracking.js';

export const LEGACY_ALWAYS_PREPARED_VALUE = 2;

function toFiniteNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function ensureSourceUuidFlags(target, sourceUuid) {
    stampSourceTracking(target, sourceUuid);
}

function getTrackedSourceUuid(itemData) {
    return resolveItemSourceUuid(itemData);
}

function addItemLookupEntry(lookup, key, itemData) {
    if (!lookup || !key || lookup.has(key)) return;
    lookup.set(key, itemData);
}

export function buildItemSourceLookup(items = []) {
    const lookup = new Map();

    for (const itemData of items) {
        if (!itemData) continue;

        const sourceUuid = getTrackedSourceUuid(itemData);
        const nameKey = itemData.name?.trim()?.toLowerCase();

        addItemLookupEntry(lookup, sourceUuid, itemData);
        addItemLookupEntry(lookup, nameKey ? `name:${nameKey}` : null, itemData);

        if (sourceUuid?.includes('.Item.')) {
            addItemLookupEntry(lookup, sourceUuid.replace(/\.Item\./, '.'), itemData);
        }

        const itemId = sourceUuid?.split('.')?.pop();
        if (itemId && itemId.length >= 16) {
            addItemLookupEntry(lookup, itemId, itemData);
        }
    }

    return lookup;
}

function ensureUsesRecovery(itemData, usesConfig) {
    if (!usesConfig?.max || !usesConfig?.per) return;

    if (!itemData.system.uses) itemData.system.uses = {};
    itemData.system.uses.max = usesConfig.max;
    itemData.system.uses.recovery = itemData.system.uses.recovery || [];

    const hasRecovery = itemData.system.uses.recovery.some(recovery =>
        recovery?.period === usesConfig.per && recovery?.type === 'recoverAll'
    );
    if (!hasRecovery) {
        itemData.system.uses.recovery.push({
            period: usesConfig.per,
            type: 'recoverAll'
        });
    }
}

function findFreeCastBaseActivity(itemData) {
    const activities = Object.values(itemData?.system?.activities || {});
    if (!activities.length) return null;

    return activities.find(activity => activity?.consumption?.spellSlot)
        || activities.find(activity => !['forward', 'enchant'].includes(activity?.type))
        || null;
}

export function isLegacyAlwaysPrepared(value) {
    return toFiniteNumber(value) === LEGACY_ALWAYS_PREPARED_VALUE;
}

function normalizeLegacyPreparationMode(preparation) {
    if (typeof preparation === 'string') return preparation || null;
    return preparation?.mode || null;
}

function preparationModeFromMethod(method) {
    if (!method) return null;
    return method === 'spell' ? 'prepared' : method;
}

function normalizeSpellcastingMethod(method, preparationMode, sourceClass = null) {
    const rawMethod = method || null;
    if (rawMethod && !['prepared', 'always', 'spell'].includes(rawMethod)) return rawMethod;
    if (sourceClass === 'warlock') return 'pact';
    if (preparationMode && !['prepared', 'always'].includes(preparationMode)) return preparationMode;
    return 'spell';
}

function resolveSpellSourceItem(sourceItem, sourceClass) {
    if (sourceItem) return sourceItem;
    return sourceClass ? `class:${sourceClass}` : null;
}

export function interpretSpellConfig(spellConfig = {}, options = {}) {
    const ability = Array.isArray(spellConfig?.ability) ? spellConfig.ability[0] : spellConfig?.ability;
    const rawMethod = spellConfig?.method || null;
    const legacyPrepared = options.forceAlwaysPrepared
        ? LEGACY_ALWAYS_PREPARED_VALUE
        : toFiniteNumber(spellConfig?.prepared);

    let preparationMode = normalizeLegacyPreparationMode(spellConfig?.preparation);
    let preparationPrepared = typeof spellConfig?.preparation === 'object'
        ? spellConfig.preparation.prepared
        : undefined;

    if (!preparationMode && rawMethod) {
        preparationMode = preparationModeFromMethod(rawMethod);
    }

    if (options.forceAlwaysPrepared || isLegacyAlwaysPrepared(legacyPrepared)) {
        preparationMode = 'always';
        preparationPrepared = true;
    }
    if (preparationPrepared === undefined && legacyPrepared !== null) {
        preparationPrepared = isLegacyAlwaysPrepared(legacyPrepared) ? true : Boolean(legacyPrepared);
    }

    const sourceClass = options.sourceClass
        || spellConfig?.sourceClass
        || (rawMethod === 'pact' ? 'warlock' : null);
    const method = normalizeSpellcastingMethod(rawMethod, preparationMode, sourceClass);
    const sourceItem = resolveSpellSourceItem(options.sourceItem || spellConfig?.sourceItem || null, sourceClass);

    return {
        ability,
        method,
        legacyPrepared,
        preparationMode,
        preparationPrepared,
        sourceClass,
        sourceItem,
        sourceUuid: options.sourceUuid || null,
        uses: spellConfig?.uses ?? null,
        needsFreeCastActivity: !!spellConfig?.uses?.max
    };
}

export function getSpellCompatibilityState(itemData, options = {}) {
    const system = itemData?._source?.system ?? itemData?.system ?? itemData ?? {};
    const rawMethod = system?.method || null;
    const legacyPrepared = toFiniteNumber(system?.prepared);
    const legacyPreparation = system?.preparation;
    const legacyPreparationMode = normalizeLegacyPreparationMode(legacyPreparation);
    const legacyPreparationPrepared = typeof legacyPreparation === 'object'
        ? legacyPreparation.prepared
        : undefined;

    let preparationMode = null;
    let preparationPrepared = undefined;
    const sourceItem = options.sourceItem || system?.sourceItem || null;
    let sourceClass = options.sourceClass || system?.sourceClass || null;

    if (!sourceClass && sourceItem?.startsWith?.('class:')) {
        sourceClass = sourceItem.slice('class:'.length) || null;
    }

    if (isLegacyAlwaysPrepared(legacyPrepared)) {
        preparationMode = 'always';
        preparationPrepared = true;
    } else if (rawMethod) {
        preparationMode = preparationModeFromMethod(rawMethod);
    } else if (legacyPreparationMode) {
        preparationMode = legacyPreparationMode;
    }

    if (legacyPrepared === null && legacyPreparationPrepared !== undefined) {
        preparationPrepared = legacyPreparationPrepared;
    }

    if (legacyPrepared === null && rawMethod && legacyPreparationMode === 'always') {
        preparationMode = 'always';
        preparationPrepared = true;
    }

    // 5.3 的法术源文档经常只有 method="spell"，没有 preparation.mode。
    // 这类“普通施法占位值”对魔契师其实不够用，得往 pact 那边拽一下。
    if (sourceClass === 'warlock' && (!preparationMode || preparationMode === 'prepared' || preparationMode === 'spell')) {
        preparationMode = 'pact';
    }

    if (rawMethod === 'pact' && !sourceClass) {
        sourceClass = 'warlock';
    }

    if (preparationMode === 'always' && preparationPrepared === undefined) {
        preparationPrepared = true;
    }
    if (preparationPrepared === undefined && legacyPrepared !== null) {
        preparationPrepared = isLegacyAlwaysPrepared(legacyPrepared) ? true : Boolean(legacyPrepared);
    }

    const method = normalizeSpellcastingMethod(rawMethod, preparationMode, sourceClass);

    return {
        method,
        legacyPrepared,
        preparationMode,
        preparationPrepared,
        sourceClass,
        sourceItem: resolveSpellSourceItem(sourceItem, sourceClass)
    };
}

export function ensureFreeCastActivity(itemData) {
    if (!itemData?.system?.activities) return false;

    const activities = itemData.system.activities;
    const baseActivity = findFreeCastBaseActivity(itemData);
    if (!baseActivity) return false;

    const freeCastKey = 'DND5E.ADVANCEMENT.SPELLCONFIG.FreeCasting';
    const localizedFreeCast = game.i18n.localize(freeCastKey);
    const freeCastLabel = localizedFreeCast && localizedFreeCast !== freeCastKey
        ? localizedFreeCast
        : (game.i18n.lang?.startsWith('zh') ? '免费施法' : 'Free Casting');
    const forwardName = `${baseActivity.name || itemData.name} (${freeCastLabel})`;

    const hasForward = Object.values(activities).some(activity => {
        if (activity?.type !== 'forward') return false;
        if (activity?.activity?.id && baseActivity?._id) {
            return activity.activity.id === baseActivity._id;
        }
        return activity?.name === forwardName;
    });
    if (hasForward) return false;

    const forwardId = foundry.utils.randomID();
    activities[forwardId] = {
        _id: forwardId,
        type: 'forward',
        name: forwardName,
        img: itemData.img,
        sort: (baseActivity.sort ?? 0) + 1,
        activity: {
            id: baseActivity._id
        },
        consumption: {
            targets: [{
                type: 'itemUses',
                target: '',
                value: '1'
            }],
            scaling: { allowed: false },
            spellSlot: true
        },
        activation: {
            type: baseActivity.activation?.type || 'action',
            override: false
        },
        description: {},
        flags: {},
        uses: {
            spent: 0,
            recovery: []
        }
    };

    return true;
}

export function normalizeSpellItemData(itemData, options = {}) {
    if (itemData?.type !== 'spell' || !itemData.system) return null;

    if (options.sourceUuid) {
        ensureSourceUuidFlags(itemData, options.sourceUuid);
    }

    const state = getSpellCompatibilityState(itemData, options);
    if (!itemData.system.preparation) itemData.system.preparation = {};

    // 5.3 起 method 是施法来源分组，prepared=2 才是“始终准备”。
    // 旧 preparation 只当兼容镜像，别再把 always 写成 method。
    if (state.preparationMode === 'always') {
        itemData.system.method = state.method || 'spell';
        itemData.system.prepared = LEGACY_ALWAYS_PREPARED_VALUE;
    } else if (state.preparationMode === 'prepared') {
        itemData.system.method = 'spell';
        if (state.legacyPrepared === null && state.preparationPrepared !== undefined) {
            itemData.system.prepared = Number(state.preparationPrepared);
        }
    } else if (state.preparationMode) {
        itemData.system.method = state.preparationMode;
    }

    if (state.preparationMode) {
        itemData.system.preparation.mode = state.preparationMode;
    }
    if (state.preparationPrepared !== undefined) {
        itemData.system.preparation.prepared = state.preparationPrepared;
    }
    if (state.sourceClass && !itemData.system.sourceClass) {
        itemData.system.sourceClass = state.sourceClass;
    }
    if (state.sourceItem && !itemData.system.sourceItem) {
        itemData.system.sourceItem = state.sourceItem;
    }

    return state;
}

export function applySpellConfigToItemData(itemData, spellConfig = {}, options = {}) {
    if (!itemData?.system) itemData.system = {};

    const config = interpretSpellConfig(spellConfig, options);

    if (config.sourceUuid) {
        ensureSourceUuidFlags(itemData, config.sourceUuid);
    }

    if (itemData.type === 'spell') {
        if (config.ability) {
            itemData.system.ability = config.ability;
        }
        if (config.method) {
            itemData.system.method = config.method;
        }
        if (config.legacyPrepared !== null) {
            itemData.system.prepared = config.legacyPrepared;
        }
        if (config.preparationMode || config.preparationPrepared !== undefined) {
            if (!itemData.system.preparation) itemData.system.preparation = {};
            if (config.preparationMode) itemData.system.preparation.mode = config.preparationMode;
            if (config.preparationPrepared !== undefined) itemData.system.preparation.prepared = config.preparationPrepared;
        }
        if (config.sourceClass && !itemData.system.sourceClass) {
            itemData.system.sourceClass = config.sourceClass;
        }
        if (config.sourceItem && !itemData.system.sourceItem) {
            itemData.system.sourceItem = config.sourceItem;
        }
    }

    if (config.uses?.max && config.uses?.per) {
        ensureUsesRecovery(itemData, config.uses);
        ensureFreeCastActivity(itemData);
    }

    if (itemData.type === 'spell') {
        normalizeSpellItemData(itemData, {
            sourceUuid: config.sourceUuid,
            sourceClass: config.sourceClass,
            sourceItem: config.sourceItem
        });
    }

    return config;
}

export function applyAlwaysPreparedSpell(itemData, options = {}) {
    return applySpellConfigToItemData(
        itemData,
        {
            prepared: LEGACY_ALWAYS_PREPARED_VALUE,
            preparation: {
                mode: 'always',
                prepared: true
            }
        },
        {
            ...options,
            forceAlwaysPrepared: true
        }
    );
}

export function applyPreparedListSpell(itemData, options = {}) {
    if (!itemData?.system) itemData.system = {};

    if (options.sourceUuid) {
        ensureSourceUuidFlags(itemData, options.sourceUuid);
    }

    if (itemData.type !== 'spell') return null;

    if (options.sourceClass && !itemData.system.sourceClass) {
        itemData.system.sourceClass = options.sourceClass;
    }

    const state = getSpellCompatibilityState(itemData);
    if (!itemData.system.preparation) itemData.system.preparation = {};

    // 这是普通法表法术，不该顺手升格成“始终准备”。
    // 但如果它本来就已经是 always 了（比如子职法术撞名），那就别瞎降级。
    if (!state.preparationMode) {
        itemData.system.preparation.mode = 'prepared';
    }

    return normalizeSpellItemData(itemData, {
        sourceUuid: options.sourceUuid,
        sourceClass: options.sourceClass
    });
}

export function applyGrantedSpellConfigs(items = [], options = {}) {
    const itemLookup = options.itemLookup instanceof Map
        ? options.itemLookup
        : buildItemSourceLookup(items);
    const warnPrefix = options.warnPrefix || 'Originate';

    let appliedCount = 0;

    for (const originItem of items) {
        const advancements = getAdvancementEntries(originItem?.system?.advancement);
        if (!advancements.length) continue;

        for (const adv of advancements) {
            if (adv?.type !== 'ItemGrant' || !adv.configuration?.spell) continue;

            const spellConfig = adv.configuration.spell;
            const grantedItems = Array.isArray(adv.configuration.items) ? adv.configuration.items : [];

            for (const configItem of grantedItems) {
                const targetUuid = configItem?.uuid;
                if (!targetUuid) continue;

                const targetItem = itemLookup.get(targetUuid)
                    || itemLookup.get(targetUuid.replace(/\.Item\./, '.'))
                    || itemLookup.get(targetUuid.split('.').pop());

                if (!targetItem || targetItem.type !== 'spell') continue;

                applySpellConfigToItemData(targetItem, spellConfig, {
                    sourceUuid: targetUuid,
                    sourceClass: targetItem.system?.sourceClass || null,
                    sourceItem: targetItem.system?.sourceItem || null
                });
                appliedCount++;
            }
        }
    }

    if (appliedCount > 0) {
        window.OriginateLog?.(`${warnPrefix} 应用了 ${appliedCount} 个授予法术配置覆盖`);
    }

    return appliedCount;
}

export function mergeSpellDuplicateData(target, incoming) {
    if (!target?.system || !incoming?.system) return target;

    const targetState = getSpellCompatibilityState(target);
    const incomingState = getSpellCompatibilityState(incoming);

    if (!target.system.method && incoming.system.method) {
        target.system.method = incoming.system.method;
    }

    if (incomingState.legacyPrepared !== null
        && (targetState.legacyPrepared === null || incomingState.legacyPrepared > targetState.legacyPrepared)) {
        target.system.prepared = incomingState.legacyPrepared;
    }

    const targetPreparation = target.system.preparation || (target.system.preparation = {});

    if (incomingState.preparationMode === 'always' && targetPreparation.mode !== 'always') {
        target.system.method = incomingState.method || targetState.method || target.system.method || 'spell';
        targetPreparation.mode = 'always';
    } else if (!targetPreparation.mode && incomingState.preparationMode) {
        targetPreparation.mode = incomingState.preparationMode;
    }

    if (incomingState.preparationPrepared === true) {
        targetPreparation.prepared = true;
    } else if (targetPreparation.prepared === undefined && incomingState.preparationPrepared !== undefined) {
        targetPreparation.prepared = incomingState.preparationPrepared;
    }

    if (!target.system.sourceClass && incoming.system.sourceClass) {
        target.system.sourceClass = incoming.system.sourceClass;
    }
    if (!target.system.sourceItem && incoming.system.sourceItem) {
        target.system.sourceItem = incoming.system.sourceItem;
    }

    if (!target.system.ability && incoming.system.ability) {
        target.system.ability = incoming.system.ability;
    }

    if (incoming.system.uses?.max) {
        if (!target.system.uses) {
            target.system.uses = foundry.utils.deepClone(incoming.system.uses);
        } else {
            if (!target.system.uses.max) target.system.uses.max = incoming.system.uses.max;
            const targetRecovery = target.system.uses.recovery || (target.system.uses.recovery = []);
            for (const recovery of incoming.system.uses.recovery || []) {
                const exists = targetRecovery.some(r => r.period === recovery.period && r.type === recovery.type);
                if (!exists) targetRecovery.push(foundry.utils.deepClone(recovery));
            }
        }
    }

    if (incoming.system.activities) {
        if (!target.system.activities) target.system.activities = {};
        for (const [activityId, activity] of Object.entries(incoming.system.activities)) {
            const duplicate = Object.values(target.system.activities).some(existingActivity => {
                if (!existingActivity || existingActivity.type !== activity?.type) return false;
                return existingActivity.name === activity?.name;
            });
            if (!duplicate) {
                target.system.activities[activityId] = foundry.utils.deepClone(activity);
            }
        }
    }

    if (!target.flags?.['hero-genesis']?.advancementOrigin && incoming.flags?.['hero-genesis']?.advancementOrigin) {
        foundry.utils.setProperty(target, 'flags.hero-genesis.advancementOrigin', incoming.flags['hero-genesis'].advancementOrigin);
    }
    if (target.flags?.['hero-genesis']?.acquiredAt == null && incoming.flags?.['hero-genesis']?.acquiredAt != null) {
        foundry.utils.setProperty(target, 'flags.hero-genesis.acquiredAt', incoming.flags['hero-genesis'].acquiredAt);
    }
    if (!target.flags?.dnd5e?.advancementOrigin && incoming.flags?.dnd5e?.advancementOrigin) {
        foundry.utils.setProperty(target, 'flags.dnd5e.advancementOrigin', incoming.flags.dnd5e.advancementOrigin);
    }
    if (!target.flags?.dnd5e?.advancementRoot && incoming.flags?.dnd5e?.advancementRoot) {
        foundry.utils.setProperty(target, 'flags.dnd5e.advancementRoot', incoming.flags.dnd5e.advancementRoot);
    }

    const sourceUuid = getTrackedSourceUuid(target) || getTrackedSourceUuid(incoming);
    if (sourceUuid) {
        ensureSourceUuidFlags(target, sourceUuid);
    }

    normalizeSpellItemData(target);
    return target;
}

function addWeaponGrant(target, grants) {
    const grantList = Array.isArray(grants) ? grants : Array.from(grants || []);
    for (const grant of grantList) {
        if (typeof grant !== 'string' || !grant.startsWith('weapon:')) continue;
        for (const key of expandWeaponProficiency(grant)) {
            target.add(key);
        }
    }
}

function addWeaponProfFromSystem(target, system) {
    if (!system) return;

    const rawValues = [
        ...(system?.traits?.weaponProf?.value || []),
        ...(system?.['traits.weaponProf.value'] || [])
    ];

    for (const rawKey of rawValues) {
        for (const key of expandWeaponProficiency(rawKey)) {
            target.add(key);
        }
    }
}

export function collectWeaponProficiencyKeys({
    actor = null,
    blueprintData = null,
    stepTypes = ['race', 'class', 'background', 'subclass'],
    systems = [],
    stepStates = [],
    pendingTraitChanges = [],
    extraGrants = []
} = {}) {
    const proficientWeapons = new Set();

    addWeaponProfFromSystem(proficientWeapons, actor?.system);

    if (blueprintData) {
        for (const stepType of stepTypes) {
            addWeaponProfFromSystem(proficientWeapons, blueprintData?.[stepType]?.system);
        }
    }

    for (const system of systems) {
        addWeaponProfFromSystem(proficientWeapons, system);
    }

    for (const change of pendingTraitChanges) {
        if (!change?.key?.startsWith('weapon:')) continue;
        for (const key of expandWeaponProficiency(change.key)) {
            proficientWeapons.add(key);
        }
    }

    for (const step of stepStates || []) {
        if (Array.isArray(step?.events)) {
            for (const event of step.events) {
                if (event?.type === 'trait_grant') addWeaponGrant(proficientWeapons, event.grants);
            }
        }

        if (step?.event?.type === 'trait_grant') {
            addWeaponGrant(proficientWeapons, step.event.grants);
        }
        if (step?.event?.associatedGrants) {
            addWeaponGrant(proficientWeapons, step.event.associatedGrants);
        }
    }

    addWeaponGrant(proficientWeapons, extraGrants);
    return proficientWeapons;
}
