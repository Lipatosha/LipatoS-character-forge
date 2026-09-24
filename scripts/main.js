import { registerSettings } from './settings-v2.js';
import { OriginateApp } from './app.js';
import { DataManager } from './data-manager-v2.js';
import { FontLoader } from './utils/font-loader.js';
import { getAdvancementEntries } from './utils/advancement-utils.js';
import { isSpellChoiceEvent } from './shared/advancement-choice-rules.js';
import { hasOriginateActorMarkers, resolveItemSourceUuid } from './shared/resolution-core.js';
import { registerTheme as registerOriginateTheme } from './theme-registry.js';
import { acquireForgeStyles, forceUnloadForgeStyles } from './runtime-style.js';
import {
    applyCreationGrantSelection,
    applyLevelUpGrantSelection,
    consumeCurrentCreationGrant,
    getActorLevelUpGrant,
    getGrantableLevelUpActors,
    getGrantableUsers,
    getUserCreationGrant,
    hasActorLevelUpGrant,
    installCreationGrantSocket,
    requestGrantedActor,
    refreshActorDirectory
} from './creation-grants.js';

// 调试开关 - 默认关闭
// 除非你想看我在控制台里碎碎念，否则别打开这个。
// 在控制台输入 window.OriginateDebug = true 即可开启。
window.OriginateDebug = false;

// 调试日志辅助函数
// 只有在 OriginateDebug 为 true 时才会说话，平时它是个哑巴，阿巴阿巴
window.OriginateLog = function (...args) {
    if (window.OriginateDebug) {
        console.log('Originate |', ...args);
    }
};

/**
 * 嘿，这里是 Adrian。
 * 
 * 这里保存着当前应用实例的引用。
 */
let currentOriginateApp = null;

/**
 * 全局 DataManager 实例。
 * 它是我们的大脑，虽然有时候反应慢点，但至少它记得东西。
 */
let globalDataManager = null;
let legacySettingsMigrationPromise = Promise.resolve({ migrated: 0 });

function _resolveActorRef(actorRef) {
    if (!actorRef) return null;
    if (typeof actorRef === 'string') {
        return game.actors.get(actorRef) || game.actors.getName(actorRef) || null;
    }
    return actorRef;
}

function _collectActiveLevelUpApps() {
    const apps = [];
    const seen = new Set();
    const pushIfNew = app => {
        if (!app || app.constructor?.name !== 'LevelUpApp') return;
        const key = app.id || app.appId || app.actor?.id || foundry.utils.randomID();
        if (seen.has(key)) return;
        seen.add(key);
        apps.push(app);
    };

    Object.values(ui.windows || {}).forEach(pushIfNew);

    if (foundry.applications?.instances) {
        for (const app of foundry.applications.instances.values()) {
            pushIfNew(app);
        }
    }

    return apps;
}

function _summarizeSpellItem(item, extra = {}) {
    if (!item || item.type !== 'spell') return null;

    const system = item.system || {};
    return {
        name: item.name || null,
        sourceUuid: resolveItemSourceUuid(item),
        sourceClass: system.sourceClass ?? null,
        method: system.method ?? null,
        preparationMode: system.preparation?.mode ?? null,
        preparationPrepared: system.preparation?.prepared ?? null,
        prepared: system.prepared ?? null,
        advancementOrigin: item.flags?.['hero-genesis']?.advancementOrigin ?? null,
        acquiredAt: item.flags?.['hero-genesis']?.acquiredAt ?? null,
        ...extra
    };
}

function _summarizeSpellItems(items = [], extraBuilder = null) {
    const summaries = [];
    items.forEach((item, index) => {
        const extra = extraBuilder instanceof Function ? (extraBuilder(item, index) || {}) : {};
        const summary = _summarizeSpellItem(item, extra);
        if (summary) summaries.push(summary);
    });
    return summaries;
}

function _summarizeSpellStep(step, index, savedData = null) {
    if (!step) return null;

    const spellConfig = step.event?.spellConfig || step.event?._original?.configuration?.spell || null;
    const isSpellStep = ['spell_choice', 'prepared_spell_grant', 'spell_replacement'].includes(step.type)
        || isSpellChoiceEvent(step.event);

    if (!isSpellStep) return null;

    return {
        index,
        id: step.id || null,
        title: step.title || null,
        type: step.type || null,
        stepType: step.stepType || null,
        classIdentifier: step.classIdentifier || null,
        restriction: step.event?.restriction || null,
        spellConfig,
        savedSpells: Array.isArray(savedData?.spells) ? [...savedData.spells] : []
    };
}

function _collectBlueprintSpellBuckets(blueprintData = {}) {
    const buckets = {};
    ['class', 'subclass', 'race', 'background'].forEach(key => {
        buckets[key] = _summarizeSpellItems(blueprintData?.[key]?.items || []);
    });
    return buckets;
}

function _collectWorkflowSnapshot(app) {
    const actor = app?.actor || app?.document || null;
    const progressionState = app?._progressionState || null;
    const levelState = app?._state || null;
    const wizardState = app?._activeSubInterfaceContext?._wizardState || null;

    const activeState = progressionState || levelState;
    const currentStepIndex = activeState?.currentStepIndex ?? wizardState?.currentStep ?? null;
    const currentStep = Number.isInteger(currentStepIndex)
        ? activeState?.steps?.[currentStepIndex] || wizardState?.steps?.[currentStepIndex] || null
        : null;

    const spellSteps = [];
    const stateSteps = activeState?.steps || [];
    stateSteps.forEach((step, index) => {
        const summary = _summarizeSpellStep(step, index, activeState?.stepData?.[step.id]);
        if (summary) spellSteps.push(summary);
    });

    const wizardSpellSteps = [];
    const wizardSteps = wizardState?.steps || [];
    wizardSteps.forEach((step, index) => {
        const summary = _summarizeSpellStep(step, index, wizardState?.data?.[index]);
        if (summary) wizardSpellSteps.push(summary);
    });

    return {
        appType: app?.constructor?.name || null,
        actor: actor ? {
            id: actor.id,
            name: actor.name,
            uuid: actor.uuid,
            level: actor.system?.details?.level ?? null
        } : null,
        currentStepIndex,
        currentStep: _summarizeSpellStep(
            currentStep,
            currentStepIndex,
            activeState?.stepData?.[currentStep?.id] || wizardState?.data?.[currentStepIndex]
        ),
        spellSteps,
        wizardSpellSteps,
        pendingSpells: _summarizeSpellItems(
            activeState?.pendingItems?.map(entry => entry?.itemData).filter(Boolean) || [],
            (_item, index) => {
                const pending = activeState?.pendingItems?.[index];
                return {
                    pendingIndex: index,
                    advancementId: pending?.advancementId ?? null,
                    level: pending?.level ?? null,
                    stepType: pending?.stepType ?? null
                };
            }
        ),
        blueprintSpells: app?.blueprintData ? _collectBlueprintSpellBuckets(app.blueprintData) : null,
        actorSpells: actor ? _summarizeSpellItems(Array.from(actor.items || [])) : []
    };
}

function _collectActiveWorkflowApps(actorRef = null) {
    const actor = _resolveActorRef(actorRef);
    const apps = [];
    const seen = new Set();
    const pushIfMatch = app => {
        if (!app) return;
        if (actor && app.actor?.id !== actor.id && app.document?.id !== actor.id) return;
        const key = `${app.constructor?.name || 'App'}:${app.id || app.appId || app.actor?.id || Math.random()}`;
        if (seen.has(key)) return;
        seen.add(key);
        apps.push(app);
    };

    pushIfMatch(currentOriginateApp);
    _collectActiveLevelUpApps().forEach(pushIfMatch);

    return { actor, apps };
}


async function migrateLegacyOriginateSettings() {
    const oldNamespace = 'originate';
    const newNamespace = 'character-forge';
    const registered = game.settings?.settings;
    if (!registered?.entries) return { migrated: 0 };

    const readStored = (scope, fullKey) => {
        const storage = game.settings.storage?.get?.(scope);
        if (!storage) return undefined;
        if (typeof storage.get === 'function') return storage.get(fullKey);
        if (typeof storage.getItem === 'function') {
            const raw = storage.getItem(fullKey);
            if (raw == null) return undefined;
            try { return JSON.parse(raw); } catch { return raw; }
        }
        return undefined;
    };

    let migrated = 0;
    for (const [fullKey, config] of registered.entries()) {
        if (!fullKey.startsWith(`${newNamespace}.`)) continue;
        const key = fullKey.slice(newNamespace.length + 1);
        const scope = config?.scope || 'world';
        const currentStored = readStored(scope, fullKey);
        if (currentStored !== undefined && currentStored !== null) continue;

        const legacyStored = readStored(scope, `${oldNamespace}.${key}`);
        if (legacyStored === undefined || legacyStored === null) continue;
        const legacyValue = legacyStored?.value !== undefined ? legacyStored.value : legacyStored;
        try {
            await game.settings.set(newNamespace, key, foundry.utils.deepClone(legacyValue));
            migrated += 1;
        } catch (error) {
            console.warn(`Character Forge | Failed to migrate setting ${key}`, error);
        }
    }
    if (migrated) console.info(`Character Forge | Migrated ${migrated} settings from Originate`);
    return { migrated };
}

Hooks.once('init', () => {
    forceUnloadForgeStyles();
    window.OriginateLog('Originate | 正在初始化角色创建器模块... 希望这次别炸。');
    registerSettings();

    // 主题注册入口要趁早就位。
    // api 完整体是在 ready 里挂的，但外部皮肤 mod（赛博朋克 DLC 那种）也在 ready 里 registerTheme，
    // 两个 ready 钩子谁先跑没法保证。所以这里 init 阶段先把 registerTheme 挂上——
    // init 一定早于所有 ready，DLC 那边就稳了。
    const originateModule = game.modules.get('character-forge');
    if (originateModule) originateModule.api = { registerTheme: registerOriginateTheme };

    // 赋予 DataManager 生命
    globalDataManager = new DataManager();

    // 注册 Handlebars helpers
    // 每次写这些 helper 我都在想，为什么 Handlebars 不内置这些基础功能？
    Handlebars.registerHelper('includes', function (array, value) {
        if (!array) return false;
        if (Array.isArray(array)) {
            return array.includes(value);
        }
        if (array instanceof Set) {
            return array.has(value);
        }
        return false;
    });

    Handlebars.registerHelper('eq', function (a, b) {
        return a === b;
    });

    // 数值加法 - 用于历史记录编号显示
    Handlebars.registerHelper('add', function (a, b) {
        return (Number(a) || 0) + (Number(b) || 0);
    });

    // 数组转字符串 - 用于显示骰点结果
    Handlebars.registerHelper('join', function (array, separator) {
        if (!Array.isArray(array)) return '';
        return array.join(typeof separator === 'string' ? separator : ', ');
    });

    // 字符串拼接 - 用于动态本地化键
    Handlebars.registerHelper('concat', function (...args) {
        // 移除最后一个参数（Handlebars options 对象）
        args.pop();
        return args.join('');
    });

    // 首字母大写 - 用于属性键名格式化
    Handlebars.registerHelper('capitalize', function (str) {
        if (!str || typeof str !== 'string') return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    });

    // 全大写 - 用于属性缩写
    Handlebars.registerHelper('upper', function (str) {
        if (!str || typeof str !== 'string') return '';
        return str.toUpperCase();
    });

    // ========================================
    // 升级向导专用 helpers
    // ========================================

    // 计算进度百分比
    Handlebars.registerHelper('calculateProgress', function (current, total) {
        if (!total || total === 0) return 0;
        return Math.round(((current + 1) / total) * 100);
    });

    // 计算平均 HP
    Handlebars.registerHelper('calculateAverageHP', function (hitDie, conMod) {
        const avg = Math.floor(hitDie / 2) + 1;
        return avg + (Number(conMod) || 0);
    });

    // 获取六大属性列表
    Handlebars.registerHelper('abilities', function () {
        return [
            { id: 'str', label: game.i18n.localize('ORIGINATE.Ability.Str') },
            { id: 'dex', label: game.i18n.localize('ORIGINATE.Ability.Dex') },
            { id: 'con', label: game.i18n.localize('ORIGINATE.Ability.Con') },
            { id: 'int', label: game.i18n.localize('ORIGINATE.Ability.Int') },
            { id: 'wis', label: game.i18n.localize('ORIGINATE.Ability.Wis') },
            { id: 'cha', label: game.i18n.localize('ORIGINATE.Ability.Cha') }
        ];
    });
});

// 游戏就绪时预加载数据源索引
// 就像在客人来之前先把地扫干净一样
Hooks.once('ready', () => {
    installCreationGrantSocket();
    window.OriginateLog('Originate | 游戏就绪，正在预加载数据源索引... 稍安勿躁。');
    legacySettingsMigrationPromise = migrateLegacyOriginateSettings();

    // 暴露 API 给那些喜欢折腾的开发者
    // 别把我的 DataManager 玩坏了，好吗？
    // 用 Object.assign 而不是整体覆盖，保住 init 阶段就挂上的 registerTheme。
    Object.assign(game.modules.get('character-forge').api, {
        dataManager: globalDataManager,
        setDebug: (enabled = true) => {
            window.OriginateDebug = !!enabled;
            console.log(`Originate | Debug ${window.OriginateDebug ? 'enabled' : 'disabled'}`);
            return window.OriginateDebug;
        },
        inspectActorAdvancement: async (actorRef) => {
            const actor = typeof actorRef === 'string'
                ? game.actors.get(actorRef) || game.actors.getName(actorRef)
                : actorRef;
            if (!actor) {
                console.warn('Originate | inspectActorAdvancement: actor not found');
                return null;
            }
            const { HeroGenesisWriter } = await import('./actor-writer.js');
            const summary = HeroGenesisWriter._collectActorAdvancementDebug(actor);
            console.log('Originate | Advancement inspection', summary);
            return summary;
        },
        // 控制台急救入口，只给旧角色排障和手工修复用。
        // 正常创角、升级、兼职不要调用它，主链已经改走输入驱动 repair。
        repairActorAdvancement: async (actorRef) => {
            let actor = typeof actorRef === 'string'
                ? game.actors.get(actorRef) || game.actors.getName(actorRef)
                : actorRef;
            if (!actor) {
                console.warn('Originate | repairActorAdvancement: actor not found');
                return null;
            }
            const { HeroGenesisWriter } = await import('./actor-writer.js');
            await HeroGenesisWriter._fixAdvancementValueReferences(actor, new Map(), new Map());
            actor = game.actors.get(actor.id) || actor;
            await HeroGenesisWriter._fixAdvancementOriginFlags(actor);
            actor = game.actors.get(actor.id) || actor;
            const summary = HeroGenesisWriter._collectActorAdvancementDebug(actor);
            console.log('Originate | Advancement repaired', summary);
            return summary;
        },
        dumpActorAdvancement: async (actorRef) => {
            const actor = typeof actorRef === 'string'
                ? game.actors.get(actorRef) || game.actors.getName(actorRef)
                : actorRef;
            if (!actor) {
                console.warn('Originate | dumpActorAdvancement: actor not found');
                return null;
            }
            const { HeroGenesisWriter } = await import('./actor-writer.js');
            const summary = HeroGenesisWriter._collectActorAdvancementDebug(actor);
            console.log('Originate | Advancement inspection', summary);
            HeroGenesisWriter._debugDumpActorState(actor, 'manual-api-dump');
            return summary;
        },
        inspectActiveSpellPipeline: (actorRef = null) => {
            const { actor, apps } = _collectActiveWorkflowApps(actorRef);
            const snapshots = apps.map(_collectWorkflowSnapshot);

            if (!snapshots.length) {
                if (actor) {
                    const actorOnly = {
                        appType: 'actor-only',
                        actor: {
                            id: actor.id,
                            name: actor.name,
                            uuid: actor.uuid,
                            level: actor.system?.details?.level ?? null
                        },
                        actorSpells: _summarizeSpellItems(Array.from(actor.items || []))
                    };
                    console.log('Originate | Spell pipeline inspection', actorOnly);
                    return actorOnly;
                }

                console.warn('Originate | inspectActiveSpellPipeline: no active Originate workflow found');
                return [];
            }

            console.log('Originate | Spell pipeline inspection', snapshots);
            return snapshots;
        },
        reloadIndex: async () => {
            await globalDataManager.reloadIndex();
        },
        openLevelUp: async (actorRef) => {
            const actor = _resolveActorRef(actorRef);
            if (!actor) throw new Error('Character Forge: персонаж не найден');
            return _openOriginateLevelUpApp(actor);
        },
        consumeCreationGrant: async ({ grantId, actorId } = {}) => {
            return consumeCurrentCreationGrant({ grantId, actorId });
        },
        createCharacterFromFinalizeInput: async (input = {}, options = {}) => {
            const { createCharacterFromFinalizeInput } = await import('./services/character-finalize-service.js');
            return createCharacterFromFinalizeInput(input, {
                ...options,
                dataManager: options.dataManager || globalDataManager
            });
        },
        // 集成测试（仅 GM，动态加载零性能影响）
        runTests: async (suite = null, options = {}) => {
            if (!game.user.isGM) {
                console.warn('Originate | 只有 GM 可以运行测试');
                return;
            }
            const { createTestRunner } = await import('./tests/index.js');
            const runner = createTestRunner();
            return runner.run(suite, options);
        }
    });

    // Character Forge работает в ленивом режиме.
    // Никакой фоновой индексации Laaru и загрузки пользовательских шрифтов,
    // пока пользователь сам не запускает создание или повышение уровня.
});

// 既然你们非要个显眼的按钮，那就给你们一个
// 把它塞进角色目录的头部，希望不会把原本的布局挤爆
async function _openCharacterForgeForActor(actor, { grantId = null, grantUserId = null } = {}) {
    if (!actor) return;

    try { await legacySettingsMigrationPromise; } catch { /* migration errors logged elsewhere */ }

    const laaruModule = game.modules.get('laaru-dnd5-hw');
    if (!laaruModule?.active) {
        ui.notifications.error('Character Forge: включите модуль Laaru (laaru-dnd5-hw).');
        return;
    }

    await FontLoader.loadFonts();

    try {
        currentOriginateApp = new OriginateApp(actor, {
            dataManager: globalDataManager,
            creationGrantId: grantId,
            creationGrantUserId: grantUserId
        });
        await acquireForgeStyles(currentOriginateApp);
        currentOriginateApp.render(true);

        // Не убираем индикатор загрузки в каталоге, пока полноэкранный Forge
        // действительно не появился в DOM.
        await new Promise(resolve => {
            const startedAt = performance.now();
            const waitForRender = () => {
                const element = currentOriginateApp?.element instanceof HTMLElement
                    ? currentOriginateApp.element
                    : currentOriginateApp?.element?.[0];

                if (element?.isConnected || (performance.now() - startedAt) > 5000) {
                    resolve();
                    return;
                }
                requestAnimationFrame(waitForRender);
            };
            requestAnimationFrame(waitForRender);
        });
    } catch (error) {
        console.error("Character Forge | Не удалось открыть создание персонажа:", error);
        ui.notifications.error(game.i18n.localize("ORIGINATE.Error.InitFailed"));
    }
}

let _creationGrantOutsideHandler = null;
let _levelUpGrantOutsideHandler = null;

function _closeCreationGrantPopover() {
    document.querySelectorAll('.character-forge-grant-popover').forEach(el => el.remove());
    if (_creationGrantOutsideHandler) {
        document.removeEventListener('pointerdown', _creationGrantOutsideHandler, true);
        _creationGrantOutsideHandler = null;
    }
}

function _openCreationGrantPopover(anchorButton) {
    _closeCreationGrantPopover();

    const users = getGrantableUsers();
    const popover = document.createElement('div');
    popover.className = 'character-forge-grant-popover';
    Object.assign(popover.style, {
        position: 'absolute',
        zIndex: '1000',
        right: '0',
        top: 'calc(100% + 4px)',
        minWidth: '250px',
        maxWidth: '340px',
        padding: '10px',
        border: '1px solid var(--color-border-light-2, #777)',
        borderRadius: '6px',
        background: 'var(--color-bg, #181818)',
        boxShadow: '0 6px 18px rgba(0,0,0,.45)'
    });

    const title = document.createElement('div');
    title.textContent = game.i18n.localize('ORIGINATE.CreationGrant.Title');
    Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
    popover.appendChild(title);

    const list = document.createElement('div');
    Object.assign(list.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxHeight: '280px',
        overflowY: 'auto'
    });

    if (!users.length) {
        const empty = document.createElement('div');
        empty.textContent = game.i18n.localize('ORIGINATE.CreationGrant.NoPlayers');
        empty.style.opacity = '.75';
        list.appendChild(empty);
    } else {
        for (const user of users) {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                padding: '4px 2px'
            });

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = user.id;
            checkbox.checked = !!getUserCreationGrant(user);

            const name = document.createElement('span');
            name.textContent = user.name;
            name.style.flex = '1';

            const status = document.createElement('span');
            status.textContent = user.active
                ? game.i18n.localize('ORIGINATE.CreationGrant.Online')
                : game.i18n.localize('ORIGINATE.CreationGrant.Offline');
            status.style.opacity = '.6';
            status.style.fontSize = '.85em';

            row.append(checkbox, name, status);
            list.appendChild(row);
        }
    }

    popover.appendChild(list);

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.innerHTML = `<i class="fas fa-check"></i> ${game.i18n.localize('ORIGINATE.CreationGrant.Confirm')}`;
    Object.assign(confirm.style, { width: '100%', marginTop: '10px' });
    confirm.disabled = !users.length;

    confirm.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        confirm.disabled = true;
        const selected = Array.from(popover.querySelectorAll('input[type="checkbox"]:checked'))
            .map(input => input.value);
        try {
            await applyCreationGrantSelection(selected);
            ui.notifications.info(game.i18n.localize('ORIGINATE.CreationGrant.Saved'));
            _closeCreationGrantPopover();
        } catch (error) {
            console.error('Character Forge | Не удалось изменить разрешения игроков:', error);
            ui.notifications.error(error?.message || String(error));
            confirm.disabled = false;
        }
    });

    popover.appendChild(confirm);

    const parent = anchorButton.parentElement;
    if (parent) {
        parent.style.position = 'relative';
        parent.appendChild(popover);
    }

    setTimeout(() => {
        // Если окно уже успели закрыть/перерисовать, не оставляем "мертвый" listener.
        if (!popover.isConnected) return;

        if (_creationGrantOutsideHandler) {
            document.removeEventListener('pointerdown', _creationGrantOutsideHandler, true);
        }

        _creationGrantOutsideHandler = event => {
            if (popover.contains(event.target) || anchorButton.contains(event.target)) return;
            _closeCreationGrantPopover();
        };
        document.addEventListener('pointerdown', _creationGrantOutsideHandler, true);
    }, 0);
}

function _closeLevelUpGrantPopover() {
    document.querySelectorAll('.character-forge-levelup-grant-popover').forEach(el => el.remove());
    if (_levelUpGrantOutsideHandler) {
        document.removeEventListener('pointerdown', _levelUpGrantOutsideHandler, true);
        _levelUpGrantOutsideHandler = null;
    }
}

function _openLevelUpGrantPopover(anchorButton) {
    _closeLevelUpGrantPopover();
    _closeCreationGrantPopover();

    const actors = getGrantableLevelUpActors();
    const popover = document.createElement('div');
    popover.className = 'character-forge-levelup-grant-popover';
    Object.assign(popover.style, {
        position: 'absolute',
        zIndex: '1000',
        right: '0',
        top: 'calc(100% + 4px)',
        minWidth: '280px',
        maxWidth: '380px',
        padding: '10px',
        border: '1px solid var(--color-border-light-2, #777)',
        borderRadius: '6px',
        background: 'var(--color-bg, #181818)',
        boxShadow: '0 6px 18px rgba(0,0,0,.45)'
    });

    const title = document.createElement('div');
    title.textContent = game.i18n.localize('ORIGINATE.LevelUpGrant.Title');
    Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
    popover.appendChild(title);

    const list = document.createElement('div');
    Object.assign(list.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxHeight: '320px',
        overflowY: 'auto'
    });

    if (!actors.length) {
        const empty = document.createElement('div');
        empty.textContent = game.i18n.localize('ORIGINATE.LevelUpGrant.NoCharacters');
        empty.style.opacity = '.75';
        list.appendChild(empty);
    } else {
        for (const actor of actors) {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                padding: '5px 2px'
            });

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = actor.id;
            checkbox.checked = hasActorLevelUpGrant(actor);

            const info = document.createElement('span');
            info.style.flex = '1';

            const name = document.createElement('div');
            name.textContent = actor.name;

            const ownership = actor.ownership || {};
            const owners = Object.entries(ownership)
                .filter(([userId, level]) =>
                    userId !== 'default'
                    && Number(level) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                )
                .map(([userId]) => game.users.get(userId)?.name)
                .filter(Boolean);

            const owner = document.createElement('div');
            owner.textContent = owners.length
                ? game.i18n.format('ORIGINATE.LevelUpGrant.Owner', { owners: owners.join(', ') })
                : game.i18n.localize('ORIGINATE.LevelUpGrant.NoOwner');
            Object.assign(owner.style, { opacity: '.6', fontSize: '.82em' });

            info.append(name, owner);
            row.append(checkbox, info);
            list.appendChild(row);
        }
    }

    popover.appendChild(list);

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.innerHTML = `<i class="fas fa-check"></i> ${game.i18n.localize('ORIGINATE.LevelUpGrant.Confirm')}`;
    Object.assign(confirm.style, { width: '100%', marginTop: '10px' });
    confirm.disabled = !actors.length;

    confirm.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        confirm.disabled = true;

        const selected = Array.from(popover.querySelectorAll('input[type="checkbox"]:checked'))
            .map(input => input.value);

        try {
            await applyLevelUpGrantSelection(selected);
            ui.notifications.info(game.i18n.localize('ORIGINATE.LevelUpGrant.Saved'));
            _closeLevelUpGrantPopover();
        } catch (error) {
            console.error('Character Forge | Не удалось выдать повышение уровня:', error);
            ui.notifications.error(error?.message || String(error));
            confirm.disabled = false;
        }
    });

    popover.appendChild(confirm);

    const parent = anchorButton.parentElement;
    if (parent) {
        parent.style.position = 'relative';
        parent.appendChild(popover);
    }

    setTimeout(() => {
        // Старый document-listener обязательно снимается вместе со старым popover.
        // Иначе он считает клики внутри нового окна "внешними" и тут же закрывает его.
        if (!popover.isConnected) return;

        if (_levelUpGrantOutsideHandler) {
            document.removeEventListener('pointerdown', _levelUpGrantOutsideHandler, true);
        }

        _levelUpGrantOutsideHandler = event => {
            if (popover.contains(event.target) || anchorButton.contains(event.target)) return;
            _closeLevelUpGrantPopover();
        };
        document.addEventListener('pointerdown', _levelUpGrantOutsideHandler, true);
    }, 0);
}

Hooks.on('renderActorDirectory', (_app, html) => {
    const isGm = game.user.isGM;
    const grant = isGm ? null : getUserCreationGrant(game.user);

    // ГМ всегда видит создание персонажа. Игрок — только при активном одноразовом допуске.
    if (!isGm && !grant) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    const headerActions = root.querySelector('.directory-header .header-actions');
    if (!headerActions) return;

    root.querySelectorAll('.character-forge-create-row').forEach(el => el.remove());

    const row = document.createElement('div');
    row.className = 'character-forge-create-row';
    Object.assign(row.style, {
        display: 'flex',
        width: '100%',
        gap: '4px',
        position: 'relative'
    });

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'create-originate-actor';
    createButton.style.flex = '1';
    createButton.innerHTML = `<i class="fas fa-bolt"></i> ${game.i18n.localize('ORIGINATE.Button.Create')}`;

    createButton.addEventListener('click', async event => {
        event.preventDefault();

        if (createButton.disabled) return;

        const idleHtml = createButton.innerHTML;
        createButton.disabled = true;
        createButton.classList.add('character-forge-loading');
        createButton.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize('ORIGINATE.Button.Loading')}`;

        try {
            let actor;
            let creationGrantId = null;
            let creationGrantUserId = null;

            if (game.user.isGM) {
                actor = await Actor.create({
                    name: game.i18n.localize("ORIGINATE.NewCharacter"),
                    type: "character"
                }, { renderSheet: false });
            } else {
                const activeGrant = getUserCreationGrant(game.user);
                if (!activeGrant) {
                    ui.notifications.warn(game.i18n.localize('ORIGINATE.CreationGrant.NoPermission'));
                    refreshActorDirectory();
                    return;
                }

                actor = await requestGrantedActor();
                creationGrantId = activeGrant.id;
                creationGrantUserId = game.user.id;
            }

            if (actor) {
                await _openCharacterForgeForActor(actor, {
                    grantId: creationGrantId,
                    grantUserId: creationGrantUserId
                });
            }
        } catch (error) {
            console.error('Character Forge | Ошибка запуска создания персонажа:', error);
            ui.notifications.error(error?.message || String(error));
        } finally {
            createButton.disabled = false;
            createButton.classList.remove('character-forge-loading');
            createButton.innerHTML = idleHtml;
        }
    });

    row.appendChild(createButton);

    if (isGm) {
        const levelGrantButton = document.createElement('button');
        levelGrantButton.type = 'button';
        levelGrantButton.className = 'character-forge-levelup-grant-button';
        levelGrantButton.title = game.i18n.localize('ORIGINATE.LevelUpGrant.Manage');
        levelGrantButton.setAttribute('aria-label', game.i18n.localize('ORIGINATE.LevelUpGrant.Manage'));
        levelGrantButton.innerHTML = '<i class="fas fa-chevron-up"></i>';
        Object.assign(levelGrantButton.style, {
            flex: '0 0 36px',
            width: '36px',
            padding: '0'
        });
        levelGrantButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const existing = row.querySelector('.character-forge-levelup-grant-popover');
            if (existing) _closeLevelUpGrantPopover();
            else _openLevelUpGrantPopover(levelGrantButton);
        });
        row.appendChild(levelGrantButton);

        const grantButton = document.createElement('button');
        grantButton.type = 'button';
        grantButton.className = 'character-forge-grant-button';
        grantButton.title = game.i18n.localize('ORIGINATE.CreationGrant.Manage');
        grantButton.setAttribute('aria-label', game.i18n.localize('ORIGINATE.CreationGrant.Manage'));
        grantButton.innerHTML = '<i class="fas fa-plus"></i>';
        Object.assign(grantButton.style, {
            flex: '0 0 36px',
            width: '36px',
            padding: '0'
        });
        grantButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const existing = row.querySelector('.character-forge-grant-popover');
            if (existing) _closeCreationGrantPopover();
            else _openCreationGrantPopover(grantButton);
        });
        row.appendChild(grantButton);
    }

    headerActions.appendChild(row);
});


// 监听应用关闭以清理引用
// 就像派对结束后的打扫卫生
Hooks.on('closeOriginateApp', (app) => {
    if (currentOriginateApp && app.id === currentOriginateApp.id) {
        currentOriginateApp = null;
    }
});

// ========================================
// 自定义降级功能
// ========================================
// 
// 既然 DND5E 原生的降级机制跟我们过不去，
// 那我们就自己动手，丰衣足食。
// 
// 原理：监听职业等级变化，当检测到降级时，
// 根据我们的 hero-genesis标记找出对应等级的物品并删除。

/**
 * 预更新阶段：检测降级并记录信息
 * 
 * 这里我们只是侦察兵，记录下降级的信息，
 * 真正的删除操作在updateItem 里进行。
 */
Hooks.on('preUpdateItem', (item, changes, options, userId) => {
    // 只关心职业物品
    if (item.type !== 'class') return;
    // 只处理有 parent（属于Actor）的物品
    if (!item.parent) return;

    const oldLevel = item.system?.levels;
    const newLevel = changes.system?.levels;

    // 检测降级（新等级小于旧等级）
    if (newLevel !== undefined && newLevel < oldLevel) {
        const hasOriginateItems = hasOriginateActorMarkers(item.parent);

        if (hasOriginateItems) {
            // 在options 中记录降级信息，传递给 updateItem hook
            options.originate = {
                levelDown: true,
                fromLevel: oldLevel,
                toLevel: newLevel,
                classItemId: item.id,
                className: item.name
            };

            window.OriginateLog(`Originate | [降级检测] ${item.name}: ${oldLevel} -> ${newLevel}`);
        }
    }
});

/**
 * 更新完成阶段：执行降级物品删除
 * 
 * 好了，侦察兵报告收到，现在该动手了。
 * 根据 hero-genesis 标记找出那些应该随着等级一起消失的物品。
 */
Hooks.on('updateItem', async (item, changes, options, userId) => {
    // 只处理我们标记过的降级操作
    if (!options.originate?.levelDown) return;
    // 只有触发更新的用户才执行删除，避免多人同时删
    if (game.userId !== userId) return;

    const { fromLevel, toLevel, classItemId, className } = options.originate;
    // Foundry/dnd5e 在同一轮升降级里会把 options 继续带给后续物品更新。
    // 旧降级钩子只能响应最初那个职业物品，不然每个被联动更新的物品都会进来扫一遍。
    if (item.type !== 'class' || item.id !== classItemId) return;

    const actor = item.parent;
    if (!actor) return;

    window.OriginateLog(`Originate | [降级处理] 开始处理 ${className} 从 ${fromLevel} 级降到 ${toLevel} 级`);

    // 收集这个职业的所有 advancement ID
    // 我们需要知道哪些 advancement 属于这个职业
    const classAdvancementIds = new Set();
    const classAdvancements = getAdvancementEntries(item.system?.advancement);
    if (classAdvancements.length) {
        for (const adv of classAdvancements) {
            if (adv._id) {
                classAdvancementIds.add(adv._id);
            }
        }
    }

    // 也收集嵌套特性的 advancement ID（如 Replicate Magic Item 的 ItemChoice）
    // 这些特性是通过职业 ItemGrant 获得的，它们的 advancement ID 不在职业本身上
    for (const actorItem of actor.items) {
        // 如果这个物品的 advancementOrigin 属于该职业的 advancement
        const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin;
        if (origin && classAdvancementIds.has(origin)) {
            // 收集这个物品自身的 advancement IDs
            const nestedAdvancements = getAdvancementEntries(actorItem.system?.advancement);
            if (nestedAdvancements.length) {
                for (const adv of nestedAdvancements) {
                    if (adv._id) {
                        classAdvancementIds.add(adv._id);
                    }
                }
            }
        }
    }

    window.OriginateLog(`Originate | [降级处理] 职业 ${className} 的 advancement IDs (含嵌套):`, Array.from(classAdvancementIds));

    // 找到所有需要删除的物品
    const itemsToDelete = [];

    for (const actorItem of actor.items) {
        //跳过职业物品本身
        if (actorItem.id === classItemId) continue;

        const origin = actorItem.flags?.['hero-genesis']?.advancementOrigin;
        const acquiredAt = actorItem.flags?.['hero-genesis']?.acquiredAt;

        // 检查条件：
        // 1. 有 advancementOrigin 标记
        // 2. advancementOrigin 属于这个职业的 advancement（含嵌套特性的）
        // 3. 获得等级在降级范围内 (toLevel < acquiredAt <= fromLevel)
        if (origin && classAdvancementIds.has(origin) && acquiredAt !== undefined) {
            if (acquiredAt > toLevel && acquiredAt <= fromLevel) {
                itemsToDelete.push(actorItem); window.OriginateLog(`Originate | [降级处理] 标记删除: ${actorItem.name} (获得于 ${acquiredAt} 级, origin: ${origin})`);
            }
        }
    }

    // 执行删除
    if (itemsToDelete.length > 0) {
        const itemNames = itemsToDelete.map(i => i.name).join(', ');
        const itemIds = itemsToDelete.map(i => i.id);

        window.OriginateLog(`Originate | [降级处理] 即将删除 ${itemsToDelete.length} 个物品: ${itemNames}`);

        try {
            await actor.deleteEmbeddedDocuments('Item', itemIds);

            // 通知用户
            ui.notifications.info(
                game.i18n.format("ORIGINATE.Notification.LevelDownItemsRemoved", {
                    count: itemsToDelete.length,
                    className: className,
                    fromLevel: fromLevel,
                    toLevel: toLevel
                })
            );

            window.OriginateLog(`Originate | [降级处理] 成功删除 ${itemsToDelete.length} 个物品`);
        } catch (e) {
            console.error("Originate | [降级处理] 删除物品失败:", e);
            ui.notifications.error(game.i18n.localize("ORIGINATE.Error.DowngradeFailed"));
        }
    } else {
        window.OriginateLog(`Originate | [降级处理] 没有找到需要删除的物品`);
    }
});

// ========================================
// 升级功能入口 (通过角色卡按钮)
// 
// 
// Adrian: 用户通过角色卡标题栏的 🧙 按钮触发 Originate 升级。
// 不再拦截原生 AdvancementManager，避免干扰原生升级流程。
// 

async function _openOriginateLevelUpApp(actor) {
    if (!actor || actor.type !== 'character') return;

    if (!game.user.isGM && !hasActorLevelUpGrant(actor)) {
        ui.notifications.warn(game.i18n.localize('ORIGINATE.LevelUpGrant.NoPermission'));
        return;
    }

    if (!game.user.isGM && !actor.isOwner) {
        ui.notifications.warn(game.i18n.localize('ORIGINATE.LevelUpGrant.NotOwner'));
        return;
    }

    const laaruModule = game.modules.get('laaru-dnd5-hw');
    if (!laaruModule?.active) {
        ui.notifications.error('Character Forge: включите модуль Laaru (laaru-dnd5-hw).');
        return;
    }

    await FontLoader.loadFonts();

    const { LevelUpApp } = await import('./levelup-app.js');

    let existing = Object.values(ui.windows || {}).find(w =>
        w.constructor.name === 'LevelUpApp' && w.actor?.id === actor.id
    );
    if (!existing && foundry.applications?.instances) {
        for (const inst of foundry.applications.instances.values()) {
            if (inst.constructor.name === 'LevelUpApp' && inst.actor?.id === actor.id) {
                existing = inst;
                break;
            }
        }
    }

    if (existing) {
        existing.bringToFront();
    } else {
        const app = new LevelUpApp(actor);
        await acquireForgeStyles(app);
        app.render(true);
    }
}

// ВАЖНО: Character Forge больше НЕ подписывается ни на один render*ActorSheet hook.
// Обычное открытие персонажа не вызывает код Forge вообще.
//
// Повышение уровня доступно через контекстное меню персонажа в каталоге Actor.
// Проверка маркеров выполняется только когда пользователь открывает это меню.
function _resolveActorSheetDocument(application) {
    const candidates = [
        application?.actor,
        application?.document,
        application?.object
    ];
    return candidates.find(candidate =>
        candidate?.documentName === 'Actor' && candidate?.type === 'character'
    ) || null;
}

function _canShowGrantedLevelUpControl(application) {
    const actor = _resolveActorSheetDocument(application);
    if (!actor || !actor.isOwner || !hasActorLevelUpGrant(actor)) return null;

    const appName = application?.constructor?.name || '';
    if (['OriginateApp', 'LevelUpApp'].includes(appName)) return null;

    try {
        if (!game.settings.get('character-forge', 'useLevelUp')) return null;
    } catch {
        return null;
    }

    return actor;
}

Hooks.on('getHeaderControlsCharacterActorSheet', (application, controls) => {
    const actor = _canShowGrantedLevelUpControl(application);
    if (!actor || !Array.isArray(controls)) return;
    if (controls.some(control => control?.action === 'character-forge-level-up')) return;

    controls.unshift({
        action: 'character-forge-level-up',
        icon: 'fa-solid fa-arrow-up',
        label: game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip'),
        visible: true,
        onClick: () => void _openOriginateLevelUpApp(actor)
    });
});

Hooks.on('getHeaderControlsApplicationV2', (application, controls) => {
    const actor = _canShowGrantedLevelUpControl(application);
    if (!actor || !Array.isArray(controls)) return;
    if (controls.some(control => control?.action === 'character-forge-level-up')) return;

    controls.unshift({
        action: 'character-forge-level-up',
        icon: 'fa-solid fa-arrow-up',
        label: game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip'),
        visible: true,
        onClick: () => void _openOriginateLevelUpApp(actor)
    });
});

Hooks.on('getApplicationV1HeaderButtons', (application, buttons) => {
    const actor = _canShowGrantedLevelUpControl(application);
    if (!actor || !Array.isArray(buttons)) return;
    if (buttons.some(button => button?.class === 'character-forge-level-up')) return;

    buttons.unshift({
        label: game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip'),
        class: 'character-forge-level-up',
        icon: 'fas fa-arrow-up',
        onclick: () => void _openOriginateLevelUpApp(actor)
    });
});

// Дополнительный legacy-hook: не мешает v13, но сохраняет кнопку на старых листах dnd5e.
Hooks.on('getActorSheetHeaderButtons', (application, buttons) => {
    const actor = _canShowGrantedLevelUpControl(application);
    if (!actor || !Array.isArray(buttons)) return;
    if (buttons.some(button => button?.class === 'character-forge-level-up')) return;

    buttons.unshift({
        label: game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip'),
        class: 'character-forge-level-up',
        icon: 'fas fa-arrow-up',
        onclick: () => void _openOriginateLevelUpApp(actor)
    });
});

function _injectGrantedLevelUpSheetButton(application) {
    const root = application?.element instanceof HTMLElement
        ? application.element
        : application?.element?.[0];
    if (!root) return;

    const actor = _canShowGrantedLevelUpControl(application);
    const existingButton = root.querySelector('.character-forge-levelup-sheet-button');
    if (!actor) {
        existingButton?.remove();
        return;
    }
    if (existingButton) return;

    let buttons = root.querySelector('.sheet-header .sheet-header-buttons');
    if (!buttons) {
        const host = root.querySelector('.sheet-header > .right > div');
        if (!host) return;
        buttons = document.createElement('div');
        buttons.className = 'sheet-header-buttons character-forge-levelup-buttons';
        host.prepend(buttons);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'character-forge-levelup-sheet-button gold-button';
    button.setAttribute('data-tooltip', '');
    button.setAttribute('aria-label', game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip'));
    button.title = game.i18n.localize('ORIGINATE.LevelUpGrant.ButtonTooltip');
    button.innerHTML = '<i class="fas fa-arrow-up"></i>';
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void _openOriginateLevelUpApp(actor);
    });
    buttons.appendChild(button);
}

// D&D5e 6.x использует CharacterActorSheet на ApplicationV2.
// Кнопку рисуем прямо рядом с кнопками отдыха, чтобы она была видна без меню «⋮».
Hooks.on('renderCharacterActorSheet', application => {
    _injectGrantedLevelUpSheetButton(application);
});

// Резерв для сборок Foundry, где система не вызывает именованный render-hook.
Hooks.on('renderApplicationV2', application => {
    if (application?.constructor?.name !== 'CharacterActorSheet') return;
    _injectGrantedLevelUpSheetButton(application);
});

Hooks.on('getActorDirectoryEntryContext', (_html, options) => {
    options.push({
        name: game.i18n.localize('ORIGINATE.LevelUp.ButtonTooltip'),
        icon: '<i class="fas fa-hat-wizard"></i>',
        condition: li => {
            try {
                if (!game.settings.get('character-forge', 'useLevelUp')) return false;
            } catch {
                return false;
            }

            const element = li instanceof HTMLElement ? li : li?.[0];
            const actorId = element?.dataset?.documentId
                || element?.dataset?.entryId
                || element?.dataset?.entityId
                || li?.data?.('documentId')
                || li?.data?.('entryId')
                || li?.data?.('entityId');
            const actor = actorId ? game.actors.get(actorId) : null;
            return !!actor
                && actor.type === 'character'
                && hasOriginateActorMarkers(actor)
                && (game.user.isGM || hasActorLevelUpGrant(actor));
        },
        callback: async li => {
            const element = li instanceof HTMLElement ? li : li?.[0];
            const actorId = element?.dataset?.documentId
                || element?.dataset?.entryId
                || element?.dataset?.entityId
                || li?.data?.('documentId')
                || li?.data?.('entryId')
                || li?.data?.('entityId');
            const actor = actorId ? game.actors.get(actorId) : null;
            if (!actor) return;

            try {
                await _openOriginateLevelUpApp(actor);
            } catch (error) {
                console.error('Character Forge | Не удалось открыть повышение уровня:', error);
                ui.notifications.error(game.i18n.localize('ORIGINATE.LevelUp.OpenFailed'));
            }
        }
    });
});

