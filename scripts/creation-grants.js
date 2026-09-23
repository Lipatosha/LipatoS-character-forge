const MODULE_ID = "character-forge";
const SOCKET_NAME = `module.${MODULE_ID}`;
const GRANT_FLAG = "creationGrant";
const ACTOR_GRANT_FLAG = "creationGrantId";
const ACTOR_PENDING_FLAG = "creationPending";
const ACTOR_USER_FLAG = "creationUserId";

const pendingActorRequests = new Map();
const locallyConsumedGrantIds = new Set();
let socketInstalled = false;

function nowIso() {
    return new Date().toISOString();
}

function randomId() {
    return foundry.utils.randomID(20);
}

function activeGms() {
    return Array.from(game.users || [])
        .filter(user => user.isGM && user.active)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function primaryActiveGm() {
    return activeGms()[0] || null;
}

export function getUserCreationGrant(user = game.user) {
    if (!user) return null;
    const grant = user.getFlag?.(MODULE_ID, GRANT_FLAG) || null;
    if (!grant?.active || !grant.id) return null;
    if (locallyConsumedGrantIds.has(grant.id)) return null;
    return grant;
}

export function hasUserCreationGrant(user = game.user) {
    return !!getUserCreationGrant(user);
}

export function getGrantableUsers() {
    return Array.from(game.users || [])
        .filter(user => !user.isGM)
        .sort((a, b) => {
            if (!!a.active !== !!b.active) return a.active ? -1 : 1;
            return String(a.name || "").localeCompare(String(b.name || ""), game.i18n.lang || "ru");
        });
}

export function refreshActorDirectory() {
    try {
        ui.actors?.render?.();
    } catch (error) {
        console.debug("Character Forge | Не удалось обновить каталог актёров", error);
    }
}

async function setUserGrant(user, active) {
    if (!game.user.isGM || !user || user.isGM) return null;

    const current = user.getFlag?.(MODULE_ID, GRANT_FLAG) || null;
    if (active) {
        if (current?.active && current.id) return current;
        const grant = {
            id: randomId(),
            active: true,
            grantedAt: nowIso(),
            grantedBy: game.user.id,
            actorId: null
        };
        await user.setFlag(MODULE_ID, GRANT_FLAG, grant);
        return grant;
    }

    if (current) await user.unsetFlag(MODULE_ID, GRANT_FLAG);
    return null;
}

export async function applyCreationGrantSelection(selectedUserIds = []) {
    if (!game.user.isGM) return;
    const selected = new Set(selectedUserIds);

    for (const user of getGrantableUsers()) {
        await setUserGrant(user, selected.has(user.id));
    }

    game.socket?.emit?.(SOCKET_NAME, { type: "refresh-directory" });
    refreshActorDirectory();
}

async function createOrReuseGrantedActor(userId, grantId) {
    if (!game.user.isGM) return null;

    const user = game.users.get(userId);
    if (!user || user.isGM) throw new Error("Игрок не найден");

    const grant = user.getFlag?.(MODULE_ID, GRANT_FLAG);
    if (!grant?.active || grant.id !== grantId) {
        throw new Error("Разрешение на создание персонажа больше не активно");
    }

    if (grant.actorId) {
        const existing = game.actors.get(grant.actorId);
        if (existing) return existing;
    }

    const ownership = {
        default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
        [userId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
    };

    const actor = await Actor.create({
        name: game.i18n.localize("ORIGINATE.NewCharacter"),
        type: "character",
        ownership,
        flags: {
            [MODULE_ID]: {
                [ACTOR_GRANT_FLAG]: grantId,
                [ACTOR_PENDING_FLAG]: true,
                [ACTOR_USER_FLAG]: userId
            }
        }
    }, { renderSheet: false });

    if (!actor) throw new Error("Не удалось создать заготовку персонажа");

    await user.setFlag(MODULE_ID, GRANT_FLAG, {
        ...grant,
        actorId: actor.id
    });

    return actor;
}

function waitForActor(actorId, timeoutMs = 5000) {
    const existing = game.actors.get(actorId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            const actor = game.actors.get(actorId);
            if (actor) {
                clearInterval(timer);
                resolve(actor);
                return;
            }
            if ((Date.now() - started) >= timeoutMs) {
                clearInterval(timer);
                reject(new Error("Персонаж создан ГМом, но ещё не синхронизировался с клиентом"));
            }
        }, 50);
    });
}

export async function requestGrantedActor() {
    const grant = getUserCreationGrant(game.user);
    if (!grant) throw new Error(game.i18n.localize("ORIGINATE.CreationGrant.NoPermission"));

    if (grant.actorId) {
        const existing = game.actors.get(grant.actorId);
        if (existing) return existing;
    }

    const gm = primaryActiveGm();
    if (!gm) throw new Error(game.i18n.localize("ORIGINATE.CreationGrant.GmRequired"));

    const requestId = randomId();

    const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingActorRequests.delete(requestId);
            reject(new Error(game.i18n.localize("ORIGINATE.CreationGrant.RequestTimeout")));
        }, 8000);

        pendingActorRequests.set(requestId, { resolve, reject, timer });
    });

    game.socket.emit(SOCKET_NAME, {
        type: "request-granted-actor",
        requestId,
        userId: game.user.id,
        grantId: grant.id,
        gmId: gm.id
    });

    const actorId = await response;
    return waitForActor(actorId);
}

async function consumeGrantOnGm({ userId, grantId, actorId }) {
    if (!game.user.isGM) return;

    const user = game.users.get(userId);
    if (!user) return;

    const grant = user.getFlag?.(MODULE_ID, GRANT_FLAG);
    if (!grant?.active || grant.id !== grantId) return;

    await user.unsetFlag(MODULE_ID, GRANT_FLAG);

    const actor = actorId ? game.actors.get(actorId) : (grant.actorId ? game.actors.get(grant.actorId) : null);
    if (actor) {
        await actor.update({
            [`flags.${MODULE_ID}.${ACTOR_PENDING_FLAG}`]: false
        }, { render: false });
    }

    game.socket?.emit?.(SOCKET_NAME, {
        type: "grant-consumed",
        userId,
        grantId
    });
}

export async function consumeCurrentCreationGrant({ grantId, actorId } = {}) {
    if (!grantId) return;

    locallyConsumedGrantIds.add(grantId);
    refreshActorDirectory();

    if (game.user.isGM) return;

    const gm = primaryActiveGm();
    if (!gm) return;

    game.socket.emit(SOCKET_NAME, {
        type: "consume-grant",
        gmId: gm.id,
        userId: game.user.id,
        grantId,
        actorId
    });
}

export function installCreationGrantSocket() {
    if (socketInstalled) return;
    socketInstalled = true;

    game.socket.on(SOCKET_NAME, async payload => {
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "refresh-directory") {
            refreshActorDirectory();
            return;
        }

        if (payload.type === "actor-ready" && payload.userId === game.user.id) {
            const pending = pendingActorRequests.get(payload.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingActorRequests.delete(payload.requestId);
            if (payload.error) pending.reject(new Error(payload.error));
            else pending.resolve(payload.actorId);
            return;
        }

        if (payload.type === "grant-consumed" && payload.userId === game.user.id) {
            locallyConsumedGrantIds.add(payload.grantId);
            refreshActorDirectory();
            return;
        }

        if (payload.gmId !== game.user.id || !game.user.isGM) return;

        if (payload.type === "request-granted-actor") {
            try {
                const actor = await createOrReuseGrantedActor(payload.userId, payload.grantId);
                game.socket.emit(SOCKET_NAME, {
                    type: "actor-ready",
                    requestId: payload.requestId,
                    userId: payload.userId,
                    actorId: actor.id
                });
            } catch (error) {
                game.socket.emit(SOCKET_NAME, {
                    type: "actor-ready",
                    requestId: payload.requestId,
                    userId: payload.userId,
                    error: error?.message || String(error)
                });
            }
            return;
        }

        if (payload.type === "consume-grant") {
            await consumeGrantOnGm(payload);
        }
    });

    Hooks.on("updateUser", (user, changes) => {
        const flagPath = changes?.flags?.[MODULE_ID];
        if (flagPath !== undefined || user.id === game.user.id) refreshActorDirectory();
    });
}
