import { getThemeSounds } from '../theme-registry.js';

const SOUND_SOURCES = {
    PAGE_FLIP: 'modules/character-forge/assets/page turn.ogg',
    CLICK: 'modules/character-forge/assets/hover.ogg'
};

// 解析某类型音效的实际文件：当前视觉主题如果带了自己的音效集（赛博皮肤换电子音那种），优先用它，
// 否则回退到默认那套。读 setting 可能在早期还没就绪，包一层 try 静默兜底，别为个音效在控制台刷红。
function resolveSoundSrc(type) {
    try {
        const theme = game.settings?.get('character-forge', 'visualTheme');
        const themeSounds = getThemeSounds(theme);
        if (themeSounds && themeSounds[type]) return themeSounds[type];
    } catch (e) { /* 设置没就绪就走默认 */ }
    return SOUND_SOURCES[type] || null;
}

const SOUND_HANDLER_KEY = Symbol('originateButtonSoundHandler');

export const CHARACTER_CREATION_SOUND_SELECTORS = [
    'button[data-action="nextStep"]',
    'button[data-action="finish"]',
    'button[data-action="start"]',
    'button[data-action="nextWizardStep"]',
    'button[data-action="finishSubInterface"]',
    'button[data-action="confirmExpertise"]'
];

export const LEVELUP_SOUND_SELECTORS = [
    '#progression-next-btn',
    '#progression-prev-btn',
    '.levelup-exit-button',
    '.levelup-status-toggle',
    '.levelup-status-close',
    '.confirm-dialog-btn',
    '.confirm-dialog-close'
];

export function getButtonSoundSelector(selectors = CHARACTER_CREATION_SOUND_SELECTORS) {
    return selectors.filter(Boolean).join(', ');
}

export function findButtonSoundTarget(target, selectors = CHARACTER_CREATION_SOUND_SELECTORS) {
    const selector = getButtonSoundSelector(selectors);
    if (!selector || !target?.closest) return null;
    return target.closest(selector);
}

export function bindButtonSounds(root, {
    selectors = CHARACTER_CREATION_SOUND_SELECTORS,
    playSound = playOriginateSound
} = {}) {
    const element = root?.[0] ?? root;
    if (!element?.addEventListener) return;

    if (element[SOUND_HANDLER_KEY]) {
        element.removeEventListener('click', element[SOUND_HANDLER_KEY]);
    }

    const handler = event => {
        const targetButton = findButtonSoundTarget(event.target, selectors);
        if (!targetButton) return;
        if (targetButton.disabled || targetButton.getAttribute('aria-disabled') === 'true') return;
        playSound('CLICK');
    };

    element.addEventListener('click', handler);
    element[SOUND_HANDLER_KEY] = handler;
}

export async function playOriginateSound(type) {
    const src = resolveSoundSrc(type);
    if (!src) return;

    try {
        foundry.audio.AudioHelper.play({ src, volume: 0.8, autoplay: true, loop: false }, false);
    } catch (err) {
        console.warn(`Originate | Failed to play sound ${type}:`, err);
    }
}
