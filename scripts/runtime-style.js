const STYLE_ID = 'character-forge-runtime-style';
const STYLE_PATH = 'modules/character-forge/styles/originate.css';

const owners = new Set();
let loadingPromise = null;

function getStyleHref() {
    const version = game.modules?.get('character-forge')?.version || 'dev';
    return `${STYLE_PATH}?v=${encodeURIComponent(version)}`;
}

function ownerKey(owner) {
    if (!owner) return 'anonymous';
    if (typeof owner === 'string') return owner;
    return owner.appId || owner.id || owner.constructor?.name || 'anonymous';
}

export async function acquireForgeStyles(owner) {
    const key = ownerKey(owner);
    owners.add(key);

    const desiredHref = new URL(getStyleHref(), document.baseURI).href;
    let link = document.getElementById(STYLE_ID);

    // После обновления модуля нельзя оставлять уже загруженный CSS старой версии.
    // JS Foundry обновляет корректно, а статический stylesheet браузер мог держать в кеше.
    if (link && link.href !== desiredHref) {
        link.remove();
        link = null;
        loadingPromise = null;
    }

    if (link?.sheet) return link;
    if (loadingPromise) return loadingPromise;

    if (!link) {
        link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        link.href = desiredHref;
        document.head.appendChild(link);
    }

    loadingPromise = new Promise((resolve, reject) => {
        if (link.sheet) {
            resolve(link);
            return;
        }
        const done = () => {
            link.removeEventListener('load', done);
            link.removeEventListener('error', fail);
            loadingPromise = null;
            resolve(link);
        };
        const fail = () => {
            link.removeEventListener('load', done);
            link.removeEventListener('error', fail);
            loadingPromise = null;
            reject(new Error('Character Forge: не удалось загрузить стили'));
        };
        link.addEventListener('load', done, { once: true });
        link.addEventListener('error', fail, { once: true });
    });

    return loadingPromise;
}

export function releaseForgeStyles(owner) {
    owners.delete(ownerKey(owner));
    if (owners.size > 0) return;

    const link = document.getElementById(STYLE_ID);
    if (link) link.remove();
    loadingPromise = null;
}

export function forceUnloadForgeStyles() {
    owners.clear();
    const link = document.getElementById(STYLE_ID);
    if (link) link.remove();
    loadingPromise = null;
}
