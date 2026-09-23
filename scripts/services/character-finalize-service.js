import { HeroGenesisWriter } from '../actor-writer.js';
import { LevelUpManager } from '../levelup-manager.js';
import { normalizeToolId } from '../mapping.js';

function asArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return Array.from(value);
    if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
    return [value];
}

function resolveFinalizeActor(input = {}, actorRef = null) {
    const ref = actorRef ?? input.context?.actorId;
    if (!ref) {
        throw new Error('character-finalize 需要一个目标 Actor');
    }

    const actor = typeof ref === 'string'
        ? game.actors.get(ref) || game.actors.getName(ref)
        : ref;

    if (!actor) {
        throw new Error(`找不到 character-finalize 目标 Actor: ${ref}`);
    }

    return actor;
}

function normalizeFinalizeActorData(actorData = {}) {
    const data = foundry.utils.deepClone(actorData || {});
    const system = data.system || (data.system = {});
    const toolValues = [
        ...asArray(system['traits.toolProf.value']),
        ...asArray(foundry.utils.getProperty(system, 'traits.toolProf.value'))
    ];

    for (const rawTool of toolValues) {
        const toolId = normalizeToolId(rawTool) || String(rawTool || '').split(':').pop();
        if (!toolId) continue;

        const valuePath = `tools.${toolId}.value`;
        const currentValue = Number(system[valuePath] ?? foundry.utils.getProperty(system, valuePath) ?? 0);
        if (currentValue < 1) system[valuePath] = 1;

        const ability = CONFIG.DND5E?.tools?.[toolId]?.ability;
        const abilityPath = `tools.${toolId}.ability`;
        if (ability && !system[abilityPath] && !foundry.utils.hasProperty(system, abilityPath)) {
            system[abilityPath] = ability;
        }
    }

    // 新版 dnd5e 的工具主状态在 system.tools。这里不再把旧集合写进新角色，
    // 不然用户在角色卡取消工具熟练后，旧集合可能又把它“声明”回来。
    delete system['traits.toolProf.value'];
    if (system.traits?.toolProf) delete system.traits.toolProf.value;

    return data;
}

function buildTraitActorUpdate(actor, traitChanges = [], manager) {
    const actorUpdate = {};
    const byMode = new Map();

    for (const change of traitChanges) {
        if (!change?.key) continue;
        const mode = change.mode || 'default';
        if (!byMode.has(mode)) byMode.set(mode, []);
        byMode.get(mode).push(change.key);
    }

    for (const [mode, keys] of byMode.entries()) {
        const updates = manager._buildTraitActorUpdates(keys, mode, actor);
        Object.assign(actorUpdate, updates);
    }

    return actorUpdate;
}

async function applyRemainingCharacterTraits(actor, traitChanges = [], manager) {
    if (!traitChanges.length) return;

    const actorUpdate = buildTraitActorUpdate(actor, traitChanges, manager);
    if (Object.keys(actorUpdate).length > 0) {
        await actor.update(actorUpdate);
    }
}

function filterMissingCharacterTraits(actor, traitChanges = [], manager) {
    return traitChanges.filter(change => change?.key && !manager._actorHasTraitKey(actor, change.key, change.mode || 'default'));
}

async function runCharacterFinalizeRepairs(actor, manager, resolutionInput, warnings) {
    const repairResult = {
        itemAdvancements: [],
        advancementOrigins: { origins: [], skipped: [] },
        traitGrants: [],
        traitChoices: []
    };

    try {
        repairResult.itemAdvancements = await manager.repairItemAdvancementsFromInput(resolutionInput);
        actor = game.actors.get(actor.id) || actor;
        manager.actor = actor;
        repairResult.advancementOrigins = await manager.repairAdvancementOriginsFromInput(resolutionInput);
    } catch (repairError) {
        warnings.push({
            stage: 'advancement-repair',
            message: repairError?.message || String(repairError)
        });
        console.warn("Originate | [CharacterFinalize] Advancement repair failed:", repairError);
    }

    actor = game.actors.get(actor.id) || actor;
    manager.actor = actor;

    try {
        repairResult.traitGrants = await manager.repairTraitAdvancementGrantsFromInput(resolutionInput);
        repairResult.traitChoices = await manager.repairTraitAdvancementChoicesFromInput(resolutionInput);
    } catch (repairError) {
        warnings.push({
            stage: 'trait-advancement-repair',
            message: repairError?.message || String(repairError)
        });
        console.warn("Originate | [CharacterFinalize] Trait advancement repair failed:", repairError);
    }

    return {
        actor: game.actors.get(actor.id) || actor,
        repairResult
    };
}

export async function createCharacterFromFinalizeInput(input = {}, options = {}) {
    if (input?.scope !== 'character-finalize') {
        throw new Error('createCharacterFromFinalizeInput 只接受 character-finalize 输入');
    }

    let actor = resolveFinalizeActor(input, options.actor);
    const initialItemIds = new Set(actor.items.map(item => item.id));
    const dataManager = options.dataManager || game.modules.get('character-forge')?.api?.dataManager;
    if (!dataManager) {
        throw new Error('createCharacterFromFinalizeInput 需要可用的 Originate DataManager');
    }

    const warnings = [];
    const scaffoldBlueprint = {
        ...normalizeFinalizeActorData(input.scaffold?.actorData || {}),
        items: foundry.utils.deepClone(input.scaffold?.rootItems || [])
    };

    // 这里借用旧 writer 只是在搭 actor 壳子和根物品，真正的创角结算在下面交给 LevelUpManager。
    // 后面如果要补职业、特性或 ASI 规则，优先去 resolution input / native plan 那边找位置。
    actor = await HeroGenesisWriter.createFromBlueprint(scaffoldBlueprint, actor, {
        itemsMode: 'scaffold',
        renderSheet: false,
        repairTraits: false,
        repairAdvancements: false,
        repairOrigins: false,
        repairHitPoints: false,
        prefillAdvancementValues: false
    });
    actor = game.actors.get(actor.id) || actor;

    const manager = new LevelUpManager(actor, dataManager);
    const resolutionResult = await manager.applyCharacterFinalizeResolutionInput(input);
    actor = game.actors.get(actor.id) || actor;
    manager.actor = actor;

    // Владения, которые не были обработаны native-планом, нужны на листе сразу.
    // Это маленькое точечное обновление и оно остаётся в критическом пути.
    const missingTraitChanges = filterMissingCharacterTraits(
        actor,
        resolutionResult.remainingTraitChanges || [],
        manager
    );
    await applyRemainingCharacterTraits(actor, missingTraitChanges, manager);
    actor = game.actors.get(actor.id) || actor;
    manager.actor = actor;

    // Быстрый режим используется интерфейсом Character Forge: после записи основных
    // данных не держим пользователя на финальном экране ради служебного ремонта
    // advancement.value/origin и ModifyItem. Эти операции запускаются после первого
    // рендера листа, когда браузер получит idle-время.
    if (options.deferRepairs === true) {
        const actorId = actor.id;

        const deferredFinalize = async () => {
            let liveActor = game.actors.get(actorId);
            if (!liveActor) {
                return {
                    actor: null,
                    itemModifications: { status: 'skipped', reason: 'actor-not-found' },
                    finalizeRepairs: null,
                    warnings
                };
            }

            const deferredManager = new LevelUpManager(liveActor, dataManager);
            const repairState = await runCharacterFinalizeRepairs(
                liveActor,
                deferredManager,
                input,
                warnings
            );

            liveActor = repairState.actor || game.actors.get(actorId) || liveActor;
            deferredManager.actor = liveActor;

            const itemModifications = await deferredManager.applyModifyItemAdvancementsFromInput(
                input,
                { initialItemIds }
            );
            if (itemModifications.status === 'failed') {
                warnings.push({
                    ...itemModifications,
                    phase: itemModifications.stage,
                    stage: 'modify-item'
                });
            }

            return {
                actor: game.actors.get(actorId) || liveActor,
                itemModifications,
                finalizeRepairs: repairState.repairResult,
                warnings
            };
        };

        return {
            actor,
            resolutionResult: {
                ...resolutionResult,
                itemModifications: { status: 'deferred' },
                remainingTraitChanges: missingTraitChanges,
                finalizeRepairs: { status: 'deferred' }
            },
            warnings,
            deferredFinalize
        };
    }

    const repairState = await runCharacterFinalizeRepairs(actor, manager, input, warnings);
    actor = repairState.actor;
    manager.actor = actor;

    const itemModifications = await manager.applyModifyItemAdvancementsFromInput(input, { initialItemIds });
    if (itemModifications.status === 'failed') {
        warnings.push({
            ...itemModifications,
            phase: itemModifications.stage,
            stage: 'modify-item'
        });
    }
    actor = game.actors.get(actor.id) || actor;

    return {
        actor,
        resolutionResult: {
            ...resolutionResult,
            itemModifications,
            remainingTraitChanges: missingTraitChanges,
            finalizeRepairs: repairState.repairResult
        },
        warnings
    };
}
