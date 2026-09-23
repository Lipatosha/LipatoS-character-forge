export function getAverageHitPointIncrease(hitDie, constitutionModifier) {
    return Math.floor(Number(hitDie || 0) / 2) + 1 + Number(constitutionModifier || 0);
}

export function isHitPointRollLocked(choice) {
    return choice?.method === 'roll';
}

export async function resolveHitPointChoice({
    currentChoice = null,
    method,
    level,
    hitDie,
    constitutionModifier
}) {
    if (isHitPointRollLocked(currentChoice)) {
        return { choice: currentChoice, changed: false, roll: null };
    }

    if (method === 'average') {
        return {
            choice: {
                level,
                hp: getAverageHitPointIncrease(hitDie, constitutionModifier),
                method: 'average',
                rollResult: null
            },
            changed: true,
            roll: null
        };
    }

    if (method !== 'roll') {
        return { choice: currentChoice, changed: false, roll: null };
    }

    const roll = await new Roll(`1d${hitDie}`).evaluate();
    const rollResult = Number(roll.total) || 0;

    return {
        choice: {
            level,
            hp: Math.max(1, rollResult + Number(constitutionModifier || 0)),
            method: 'roll',
            rollResult
        },
        changed: true,
        roll
    };
}
