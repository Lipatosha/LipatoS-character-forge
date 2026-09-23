function escapeStatusText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function renderStatusRow(entry = {}) {
    const uuid = entry.uuid ? ` data-uuid="${escapeStatusText(entry.uuid)}"` : '';
    const tooltip = entry.tooltipHtml
        ? ` data-originate-tooltip-html="${escapeStatusText(entry.tooltipHtml)}"`
        : '';

    return `
        <div class="levelup-status-row"${tooltip}${uuid}>
            ${entry.img ? `<img src="${escapeStatusText(entry.img)}" alt="">` : ''}
            <div>
                <span class="feature-title">${escapeStatusText(entry.name || entry.label)}</span>
                ${entry.detail ? `<small>${escapeStatusText(entry.detail)}</small>` : ''}
            </div>
        </div>
    `;
}

function renderStatusRows(entries = [], emptyKey = 'ORIGINATE.LevelUp.Status.Empty') {
    const visibleEntries = entries.slice(0, 40);
    const extraCount = Math.max(0, entries.length - visibleEntries.length);
    const rows = visibleEntries.map(renderStatusRow).join('');
    const more = extraCount > 0
        ? `<div class="levelup-status-more">${game.i18n.format('ORIGINATE.LevelUp.Status.More', { count: extraCount })}</div>`
        : '';

    return rows
        ? `${rows}${more}`
        : `<div class="levelup-status-empty">${game.i18n.localize(emptyKey)}</div>`;
}

function renderStatusSection(titleKey, entries = [], emptyKey = 'ORIGINATE.LevelUp.Status.Empty') {
    return `
        <section class="levelup-status-section">
            <h5>${game.i18n.localize(titleKey)}</h5>
            <div class="levelup-status-list">
                ${renderStatusRows(entries, emptyKey)}
            </div>
        </section>
    `;
}

function renderStatusAbilities(abilities = []) {
    return `
        <section class="levelup-status-section">
            <h5>${game.i18n.localize('ORIGINATE.LevelUp.Status.Abilities')}</h5>
            <div class="levelup-status-abilities">
                ${abilities.map(ability => `
                    <div class="levelup-status-ability">
                        <span>${escapeStatusText(ability.label)}</span>
                        <strong>${escapeStatusText(ability.value)}</strong>
                    </div>
                `).join('')}
            </div>
        </section>
    `;
}

function renderStatusLibrary(actor, activeTab) {
    const tab = activeTab === 'spells' ? 'spells' : 'features';
    const tabs = [
        { id: 'features', labelKey: 'ORIGINATE.LevelUp.Status.Features', count: actor.features.length },
        { id: 'spells', labelKey: 'ORIGINATE.LevelUp.Status.Spells', count: actor.spells.length }
    ];
    const entries = tab === 'spells' ? actor.spells : actor.features;
    const emptyKey = tab === 'spells'
        ? 'ORIGINATE.LevelUp.Status.NoSpells'
        : 'ORIGINATE.LevelUp.Status.NoFeatures';

    return `
        <section class="levelup-status-section levelup-status-library">
            <div class="levelup-status-tabs" role="tablist">
                ${tabs.map(item => `
                    <button type="button" class="${item.id === tab ? 'active' : ''}"
                        data-status-tab="${item.id}" role="tab" aria-selected="${item.id === tab}">
                        ${game.i18n.localize(item.labelKey)}
                        <span>${item.count}</span>
                    </button>
                `).join('')}
            </div>
            <div class="levelup-status-list">
                ${renderStatusRows(entries, emptyKey)}
            </div>
        </section>
    `;
}

export function dedupeStatusEntries(entries = []) {
    const seen = new Set();
    return entries.filter(entry => {
        const key = `${entry.kind || ''}|${entry.name || entry.label || ''}|${entry.detail || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function renderCharacterStatusSnapshot(snapshot, { activeTab = 'features' } = {}) {
    const actor = snapshot.actor;
    const draftTitleKey = snapshot.draftTitleKey || 'ORIGINATE.LevelUp.Status.ThisUpgrade';

    return `
        <section class="levelup-status-hero">
            <img src="${escapeStatusText(actor.img || 'icons/svg/mystery-man.svg')}" alt="">
            <div>
                <h4>${escapeStatusText(actor.name)}</h4>
                <div class="levelup-status-subtitle">${escapeStatusText(snapshot.subtitle || '')}</div>
            </div>
        </section>
        ${renderStatusSection('ORIGINATE.LevelUp.Status.Classes', actor.classes)}
        ${renderStatusSection('ORIGINATE.LevelUp.Status.Subclasses', actor.subclasses)}
        ${renderStatusAbilities(actor.abilities)}
        ${renderStatusLibrary(actor, activeTab)}
        <section class="levelup-status-section levelup-status-draft">
            <h5>${game.i18n.localize(draftTitleKey)}</h5>
            <div class="levelup-status-list">
                ${snapshot.draft.map(renderStatusRow).join('') || `<div class="levelup-status-empty">${game.i18n.localize('ORIGINATE.LevelUp.Status.NoDraft')}</div>`}
            </div>
        </section>
    `;
}
