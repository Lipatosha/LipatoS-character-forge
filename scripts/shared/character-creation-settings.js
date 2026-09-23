export const DETAIL_STEPS = Object.freeze(['name', 'alignment', 'appearance', 'personality', 'portrait', 'biography']);

export const DETAIL_STEP_LABELS = Object.freeze({
    name: '姓名',
    alignment: '阵营',
    appearance: '外貌',
    personality: '个性',
    portrait: '立绘',
    biography: '传记'
});

const SKIP_CUSTOM_CHARACTER_STEPS = new Set(['alignment', 'appearance', 'personality', 'biography']);

const SKIP_CUSTOM_CHARACTER_DETAIL_FIELDS = new Set([
    'alignment',
    'faith',
    'gender',
    'age',
    'height',
    'weight',
    'eyes',
    'skin',
    'hair',
    'appearance',
    'trait',
    'ideal',
    'bond',
    'flaw',
    'biography'
]);

export function shouldSkipCustomCharacterDetails() {
    try {
        return !!globalThis.game?.settings?.get?.('character-forge', 'skipCustomCharacterDetails');
    } catch (error) {
        return false;
    }
}

export function getCharacterCreationDetailSteps() {
    if (!shouldSkipCustomCharacterDetails()) return DETAIL_STEPS;
    return DETAIL_STEPS.filter(step => !SKIP_CUSTOM_CHARACTER_STEPS.has(step));
}

export function isCharacterCreationDetailStep(step) {
    return DETAIL_STEPS.includes(step);
}

export function shouldWriteCharacterDetailField(field) {
    return !shouldSkipCustomCharacterDetails() || !SKIP_CUSTOM_CHARACTER_DETAIL_FIELDS.has(field);
}
