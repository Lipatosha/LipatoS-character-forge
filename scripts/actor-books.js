import { acquireForgeStyles, releaseForgeStyles } from './runtime-style.js';
import { bindTooltips } from './shared/progression-renderer.js';
import { resolveItemSourceUuid } from './shared/resolution-core.js';

const OPEN_BOOKS = new Map();

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function norm(value) {
    return String(value ?? '').trim().toLowerCase().replace(/^class:/, '');
}

function sourceUuid(item) {
    return resolveItemSourceUuid(item) || item?.uuid || '';
}

function labelValue(entry, fallback = '') {
    if (entry == null) return fallback;
    if (typeof entry === 'string') {
        try {
            const localized = game.i18n.localize(entry);
            return localized && localized !== entry ? localized : entry;
        } catch {
            return entry;
        }
    }
    const raw = entry.label || entry.name || fallback;
    if (!raw) return fallback;
    try {
        const localized = game.i18n.localize(raw);
        return localized && localized !== raw ? localized : raw;
    } catch {
        return raw;
    }
}

function readSpellSlots(actor) {
    const spells = actor.system?.spells || {};
    const slots = [];

    for (const [key, slot] of Object.entries(spells)) {
        if (!slot || typeof slot !== 'object') continue;
        let level = Number(slot.level);
        if (!Number.isFinite(level)) {
            const match = /^spell(\d+)$/i.exec(key);
            if (match) level = Number(match[1]);
        }
        const max = Number(slot.max ?? slot.override ?? 0);
        const value = Number(slot.value ?? 0);
        if ((!Number.isFinite(max) || max <= 0) && (!Number.isFinite(value) || value <= 0)) continue;

        const pact = key.toLowerCase().includes('pact');
        const levelText = pact
            ? 'Магия договора'
            : (labelValue(CONFIG.DND5E?.spellLevels?.[level], level ? `${level}-й круг` : key));
        slots.push({
            key,
            pact,
            level: Number.isFinite(level) ? level : 99,
            label: levelText,
            value: Number.isFinite(value) ? value : 0,
            max: Number.isFinite(max) ? max : 0
        });
    }

    return slots.sort((a, b) => a.level - b.level || a.label.localeCompare(b.label, game.i18n.lang));
}

function spellPreparationValues() {
    const states = CONFIG.DND5E?.spellPreparationStates || {};
    const read = (keys, fallback) => {
        for (const key of keys) {
            const entry = states[key];
            const value = Number(typeof entry === 'object' ? entry?.value : entry);
            if (Number.isFinite(value)) return value;
        }
        return fallback;
    };
    return {
        unprepared: read(['unprepared', 'none'], 0),
        prepared: read(['prepared'], 1),
        always: read(['always', 'alwaysPrepared'], 2)
    };
}

function spellClassIdentifier(item) {
    const direct = norm(item.system?.classIdentifier || item.system?.sourceClass || '');
    if (direct) return direct;

    const sourceItem = String(item.system?.sourceItem || '');
    const typed = /^(?:class|subclass):(.+)$/i.exec(sourceItem);
    if (typed) return norm(typed[1]);
    return '';
}

function spellPreparationInfo(item) {
    const values = spellPreparationValues();
    const legacyPrep = item.system?.preparation || {};
    const method = String(item.system?.method || legacyPrep.mode || '');

    let state = Number(item.system?.prepared);
    if (!Number.isFinite(state)) {
        if (legacyPrep.mode === 'always') state = values.always;
        else if (legacyPrep.prepared) state = values.prepared;
        else state = values.unprepared;
    }

    const level = Number(item.system?.level ?? 0);
    const model = CONFIG.DND5E?.spellcasting?.[method];
    const canPrepare = !!model?.prepares;
    const always = state === values.always;
    const prepared = state === values.prepared;
    const toggleable = canPrepare && level > 0 && !always;

    return {
        values,
        method,
        level,
        classIdentifier: spellClassIdentifier(item),
        canPrepare,
        toggleable,
        prepared,
        always,
        active: prepared || always
    };
}

function preparationState(item) {
    const info = spellPreparationInfo(item);
    if (info.always) return 'Всегда подготовлено';
    if (info.prepared) return 'Подготовлено';
    if (info.toggleable) return 'Не подготовлено';

    const method = CONFIG.DND5E?.spellcasting?.[info.method];
    const methodLabel = labelValue(method, '');
    return methodLabel || 'Изучено';
}

function readPreparationSummary(actor) {
    const classes = Array.from(actor.items || []).filter(item => item.type === 'class');
    const byClass = new Map();
    let value = 0;
    let max = 0;

    for (const cls of classes) {
        const id = norm(cls.system?.identifier || cls.name);
        if (!id) continue;
        const prep = cls.system?.spellcasting?.preparation || {};
        const clsValue = Math.max(0, Number(prep.value ?? 0) || 0);
        const clsMax = Math.max(0, Number(prep.max ?? 0) || 0);
        byClass.set(id, {
            id,
            name: cls.name,
            value: clsValue,
            max: clsMax
        });
        value += clsValue;
        max += clsMax;
    }

    return { value, max, byClass };
}

async function setSpellPrepared(actor, uuid, prepared) {
    if (!uuid) return false;

    let item = null;
    try {
        item = await fromUuid(uuid);
    } catch {
        item = null;
    }
    if (!item || item.type !== 'spell' || item.parent?.id !== actor.id) return false;

    const info = spellPreparationInfo(item);
    if (!info.toggleable) {
        if (info.always) ui.notifications.info('Это заклинание подготовлено всегда.');
        else ui.notifications.warn('Это заклинание нельзя подготавливать вручную.');
        return false;
    }

    if (prepared && !info.prepared) {
        const summary = readPreparationSummary(actor);
        const classCap = info.classIdentifier ? summary.byClass.get(info.classIdentifier) : null;

        if (classCap?.max > 0 && classCap.value >= classCap.max) {
            ui.notifications.warn(`Достигнут предел подготовленных заклинаний: ${classCap.value} / ${classCap.max}.`);
            return false;
        }
        if (!classCap && summary.max > 0 && summary.value >= summary.max) {
            ui.notifications.warn(`Достигнут предел подготовленных заклинаний: ${summary.value} / ${summary.max}.`);
            return false;
        }
    }

    const next = prepared ? info.values.prepared : info.values.unprepared;
    await item.update({ 'system.prepared': next });
    return true;
}

function featureUsage(item) {
    const candidates = [];
    if (item.system?.uses) candidates.push(item.system.uses);

    const activities = item.system?.activities;
    if (activities?.values instanceof Function) {
        for (const activity of activities.values()) {
            if (activity?.uses) candidates.push(activity.uses);
        }
    } else if (Array.isArray(activities)) {
        for (const activity of activities) if (activity?.uses) candidates.push(activity.uses);
    } else if (activities && typeof activities === 'object') {
        for (const activity of Object.values(activities)) if (activity?.uses) candidates.push(activity.uses);
    }

    for (const uses of candidates) {
        const max = Number(uses.max ?? uses.maxValue ?? 0);
        const value = Number(uses.value ?? uses.remaining ?? 0);
        if (!Number.isFinite(max) || max <= 0) continue;
        return `Использования: ${Number.isFinite(value) ? value : 0}/${max}`;
    }
    return '';
}

function findPane(root, actor, type) {
    const tabs = type === 'spell'
        ? ['spells', 'spellbook']
        : ['features', 'advancement', 'feats'];

    const direct = tabs
        .flatMap(tab => Array.from(root.querySelectorAll(`[data-tab="${tab}"]`)))
        .filter(el => !el.matches('button, a, [role="tab"]'));

    if (direct.length) {
        direct.sort((a, b) => b.querySelectorAll('[data-item-id]').length - a.querySelectorAll('[data-item-id]').length);
        return direct[0];
    }

    const item = Array.from(actor.items || []).find(entry => type === 'spell' ? entry.type === 'spell' : entry.type === 'feat');
    if (!item) return null;
    const row = root.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    if (!row) return null;

    let current = row;
    while (current && current !== root) {
        if (current.dataset?.tab && tabs.includes(current.dataset.tab)) return current;
        if (current.matches?.('.tab, section, .sheet-body > div')) {
            const count = current.querySelectorAll('[data-item-id]').length;
            if (count >= 1) return current;
        }
        current = current.parentElement;
    }
    return null;
}

function makeSheetButton(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `character-forge-sheet-book-button character-forge-sheet-book-button-${kind}`;
    button.innerHTML = `<i class="fas fa-book-open" aria-hidden="true"></i><span>${kind === 'spell' ? 'Книга заклинаний' : 'Книга особенностей'}</span>`;
    button.title = kind === 'spell' ? 'Книга заклинаний' : 'Книга особенностей';
    return button;
}

export function injectActorBookButtons(application, dataManager) {
    const actor = application?.actor || application?.document || application?.object;
    const root = application?.element instanceof HTMLElement ? application.element : application?.element?.[0];
    if (!actor || actor.type !== 'character' || !root || !actor.isOwner) return;

    const configs = [
        { kind: 'spell', hasItems: Array.from(actor.items || []).some(item => item.type === 'spell') },
        { kind: 'feature', hasItems: Array.from(actor.items || []).some(item => item.type === 'feat') }
    ];

    for (const config of configs) {
        const selector = `.character-forge-sheet-book-button-${config.kind}`;
        root.querySelectorAll(selector).forEach(button => button.remove());
        if (!config.hasItems) continue;

        const pane = findPane(root, actor, config.kind);
        if (!pane) continue;
        pane.classList.add('character-forge-book-pane');

        const button = makeSheetButton(config.kind);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            void openActorBook(actor, config.kind, dataManager);
        });
        pane.appendChild(button);
    }
}

async function buildSpellEntries(actor) {
    const entries = Array.from(actor.items || [])
        .filter(item => item.type === 'spell')
        .map(item => {
            const info = spellPreparationInfo(item);
            return {
                uuid: item.uuid,
                sourceUuid: sourceUuid(item),
                name: item.name,
                img: item.img,
                level: Number(item.system?.level ?? 0),
                school: item.system?.school || '',
                owned: true,
                prepared: info.prepared,
                alwaysPrepared: info.always,
                activePrepared: info.active,
                toggleable: info.toggleable,
                classIdentifier: info.classIdentifier,
                state: preparationState(item),
                method: info.method
            };
        });

    return entries.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
}

async function buildFeatureEntries(actor) {
    const entries = Array.from(actor.items || [])
        .filter(item => item.type === 'feat')
        .map(item => {
            const sourceType = norm(item.system?.type?.value) || 'feature';
            const sourceLabel = norm(item.system?.type?.subtype || item.system?.sourceClass || '');
            return {
                uuid: item.uuid,
                sourceUuid: sourceUuid(item),
                name: item.name,
                img: item.img,
                owned: true,
                state: 'Получено',
                sourceType,
                sourceLabel,
                uses: featureUsage(item)
            };
        });

    return entries.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

function renderSlots(slots) {
    if (!slots.length) return '<div class="character-forge-book-slots-empty">Ячейки заклинаний отсутствуют</div>';
    return slots.map(slot => {
        const max = Math.max(0, slot.max);
        const value = Math.max(0, Math.min(slot.value, max || slot.value));
        const pips = max > 0 && max <= 12
            ? `<div class="character-forge-book-slot-pips">${Array.from({ length: max }, (_, index) =>
                `<span class="${index < value ? 'available' : 'spent'}"></span>`
            ).join('')}</div>`
            : '';
        return `
            <div class="character-forge-book-slot">
                <div class="character-forge-book-slot-label">${esc(slot.label)}</div>
                <div class="character-forge-book-slot-count">${value} / ${max}</div>
                ${pips}
            </div>
        `;
    }).join('');
}

function spellCard(entry) {
    const school = labelValue(CONFIG.DND5E?.spellSchools?.[entry.school], entry.school);
    const level = entry.level === 0 ? 'Фокус' : labelValue(CONFIG.DND5E?.spellLevels?.[entry.level], `${entry.level}-й круг`);
    const badges = [entry.state, entry.classIdentifier].filter(Boolean);
    const prepareIcon = entry.alwaysPrepared
        ? 'fa-lock'
        : (entry.prepared ? 'fa-check' : (entry.toggleable ? 'fa-plus' : 'fa-bookmark'));
    const prepareTitle = entry.alwaysPrepared
        ? 'Всегда подготовлено'
        : (entry.prepared ? 'Убрать из подготовленных' : (entry.toggleable ? 'Подготовить заклинание' : entry.state));

    return `
        <article class="character-forge-book-card spell-card is-owned ${entry.activePrepared ? 'is-prepared' : ''} ${entry.alwaysPrepared ? 'is-always-prepared' : ''}"
                 data-uuid="${esc(entry.uuid)}"
                 data-name="${esc(entry.name.toLowerCase())}"
                 data-level="${entry.level}"
                 data-school="${esc(entry.school)}"
                 data-owned="true"
                 data-prepared="${entry.prepared ? 'true' : 'false'}"
                 data-active-prepared="${entry.activePrepared ? 'true' : 'false'}"
                 data-toggleable="${entry.toggleable ? 'true' : 'false'}"
                 ${entry.toggleable ? 'draggable="true"' : ''}>
            <img src="${esc(entry.img || 'icons/svg/book.svg')}" alt="">
            <div class="character-forge-book-card-main">
                <div class="character-forge-book-card-name">${esc(entry.name)}</div>
                <div class="character-forge-book-card-meta">${esc(level)}${school ? ` • ${esc(school)}` : ''}</div>
                <div class="character-forge-book-card-badges">
                    ${badges.map(text => `<span>${esc(text)}</span>`).join('')}
                </div>
            </div>
            <button type="button"
                    class="character-forge-book-prepare-toggle ${entry.prepared ? 'is-selected' : ''}"
                    data-prepare-action="${entry.prepared ? 'remove' : 'add'}"
                    data-uuid="${esc(entry.uuid)}"
                    ${entry.toggleable ? '' : 'disabled'}
                    title="${esc(prepareTitle)}"
                    aria-label="${esc(prepareTitle)}">
                <i class="fas ${prepareIcon}" aria-hidden="true"></i>
            </button>
        </article>
    `;
}

function featureCard(entry) {
    const sourceLabels = {
        class: 'Класс',
        race: 'Раса',
        background: 'Предыстория',
        feat: 'Черта',
        feature: 'Особенность'
    };
    const source = sourceLabels[entry.sourceType] || 'Особенность';

    return `
        <article class="character-forge-book-card feature-card ${entry.owned ? 'is-owned' : 'is-available'}"
                 data-uuid="${esc(entry.uuid)}"
                 data-name="${esc(entry.name.toLowerCase())}"
                 data-source="${esc(entry.sourceType)}"
                 data-owned="${entry.owned ? 'true' : 'false'}">
            <img src="${esc(entry.img || 'icons/svg/book.svg')}" alt="">
            <div class="character-forge-book-card-main">
                <div class="character-forge-book-card-name">${esc(entry.name)}</div>
                <div class="character-forge-book-card-meta">${esc(source)}${entry.sourceLabel ? ` • ${esc(entry.sourceLabel)}` : ''}</div>
                <div class="character-forge-book-card-badges">
                    <span>${esc(entry.state)}</span>
                    ${entry.uses ? `<span>${esc(entry.uses)}</span>` : ''}
                </div>
            </div>
            <i class="fas ${entry.owned ? 'fa-bookmark' : 'fa-book-open'} character-forge-book-card-state" aria-hidden="true"></i>
        </article>
    `;
}

function mountFilters(overlay, kind) {
    const search = overlay.querySelector('[data-book-search]');
    const stateButtons = Array.from(overlay.querySelectorAll('[data-book-state]'));
    const levelButtons = Array.from(overlay.querySelectorAll('[data-book-level]'));
    const schoolButtons = Array.from(overlay.querySelectorAll('[data-book-school]'));
    const sourceButtons = Array.from(overlay.querySelectorAll('[data-book-source]'));
    const cards = Array.from(overlay.querySelectorAll('.character-forge-book-card'));
    const count = overlay.querySelector('[data-book-count]');

    let state = 'all';
    let level = 'all';
    let school = 'all';
    let source = 'all';

    const selectOne = (buttons, clicked) => {
        buttons.forEach(button => button.classList.toggle('active', button === clicked));
    };

    const apply = () => {
        const query = (search?.value || '').trim().toLowerCase();
        let visible = 0;

        for (const card of cards) {
            const matchesSearch = !query || card.dataset.name.includes(query);
            const matchesState = state === 'all'
                || (kind === 'spell' && state === 'prepared' && card.dataset.activePrepared === 'true')
                || (kind === 'spell' && state === 'unprepared' && card.dataset.activePrepared !== 'true')
                || (kind !== 'spell' && state === 'owned' && card.dataset.owned === 'true');
            const matchesLevel = kind !== 'spell' || level === 'all' || card.dataset.level === level;
            const matchesSchool = kind !== 'spell' || school === 'all' || card.dataset.school === school;
            const matchesSource = kind !== 'feature' || source === 'all' || card.dataset.source === source;
            const show = matchesSearch && matchesState && matchesLevel && matchesSchool && matchesSource;
            card.hidden = !show;
            if (show) visible++;
        }

        if (count) count.textContent = String(visible);
    };

    search?.addEventListener('input', apply);
    stateButtons.forEach(button => button.addEventListener('click', () => {
        state = button.dataset.bookState;
        selectOne(stateButtons, button);
        apply();
    }));
    levelButtons.forEach(button => button.addEventListener('click', () => {
        level = button.dataset.bookLevel;
        selectOne(levelButtons, button);
        apply();
    }));
    schoolButtons.forEach(button => button.addEventListener('click', () => {
        school = button.dataset.bookSchool;
        selectOne(schoolButtons, button);
        apply();
    }));
    sourceButtons.forEach(button => button.addEventListener('click', () => {
        source = button.dataset.bookSource;
        selectOne(sourceButtons, button);
        apply();
    }));

    apply();
}

function renderPreparedZone(entries, summary) {
    const prepared = entries.filter(entry => entry.activePrepared && entry.level > 0);
    const countText = summary.max > 0 ? `${summary.value} / ${summary.max}` : String(summary.value);

    return `
        <section class="character-forge-book-prepared-panel">
            <div class="character-forge-book-prepared-header">
                <span><i class="fas fa-bookmark"></i> Подготовленные</span>
                <strong>${esc(countText)}</strong>
            </div>
            <div class="character-forge-book-prepared-zone" data-prepared-dropzone="true">
                ${prepared.length ? prepared.map(entry => `
                    <div class="character-forge-book-prepared-item ${entry.alwaysPrepared ? 'is-locked' : ''}"
                         data-uuid="${esc(entry.uuid)}"
                         ${entry.toggleable ? 'draggable="true"' : ''}>
                        <img src="${esc(entry.img || 'icons/svg/book.svg')}" alt="">
                        <span title="${esc(entry.name)}">${esc(entry.name)}</span>
                        ${entry.toggleable ? `
                            <button type="button" data-unprepare-uuid="${esc(entry.uuid)}" title="Убрать из подготовленных" aria-label="Убрать из подготовленных">
                                <i class="fas fa-times"></i>
                            </button>
                        ` : '<i class="fas fa-lock" title="Всегда подготовлено"></i>'}
                    </div>
                `).join('') : `
                    <div class="character-forge-book-prepared-empty">
                        <i class="fas fa-hand-pointer"></i>
                        <span>Перетащите сюда заклинание или нажмите <b>+</b> на его карточке</span>
                    </div>
                `}
            </div>
        </section>
    `;
}

function bindSpellPreparationControls(overlay, actor) {
    const zone = overlay.querySelector('[data-prepared-dropzone]');
    const grid = overlay.querySelector('.character-forge-book-grid');
    if (!zone || !grid) return;

    const readPayload = event => {
        try {
            return JSON.parse(event.dataTransfer?.getData('application/x-character-forge-spell')
                || event.dataTransfer?.getData('text/plain') || 'null');
        } catch {
            return null;
        }
    };

    const writePayload = (event, uuid, prepared) => {
        const payload = JSON.stringify({ characterForgeSpell: true, uuid, prepared: !!prepared });
        event.dataTransfer?.setData('application/x-character-forge-spell', payload);
        event.dataTransfer?.setData('text/plain', payload);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };

    overlay.querySelectorAll('.spell-card[draggable="true"]').forEach(card => {
        card.addEventListener('dragstart', event => {
            writePayload(event, card.dataset.uuid, card.dataset.prepared === 'true');
        });
    });

    overlay.querySelectorAll('.character-forge-book-prepared-item[draggable="true"]').forEach(item => {
        item.addEventListener('dragstart', event => {
            writePayload(event, item.dataset.uuid, true);
        });
    });

    zone.addEventListener('dragover', event => {
        event.preventDefault();
        zone.classList.add('is-drag-over');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    zone.addEventListener('dragleave', event => {
        if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-drag-over');
    });
    zone.addEventListener('drop', event => {
        event.preventDefault();
        zone.classList.remove('is-drag-over');
        const payload = readPayload(event);
        if (payload?.characterForgeSpell && payload.uuid) {
            void setSpellPrepared(actor, payload.uuid, true);
        }
    });

    grid.addEventListener('dragover', event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    grid.addEventListener('drop', event => {
        const payload = readPayload(event);
        if (!payload?.characterForgeSpell || !payload.uuid || !payload.prepared) return;
        event.preventDefault();
        void setSpellPrepared(actor, payload.uuid, false);
    });

    overlay.querySelectorAll('[data-prepare-action][data-uuid]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const shouldPrepare = button.dataset.prepareAction === 'add';
            void setSpellPrepared(actor, button.dataset.uuid, shouldPrepare);
        });
    });

    overlay.querySelectorAll('[data-unprepare-uuid]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            void setSpellPrepared(actor, button.dataset.unprepareUuid, false);
        });
    });
}

async function openOwnedItem(uuid) {
    if (!uuid) return;
    try {
        const doc = await fromUuid(uuid);
        if (!doc?.parent || doc.parent.documentName !== 'Actor') return;
        doc.sheet?.render?.(true);
    } catch {
        // Tooltip remains available even when a linked sheet cannot be opened.
    }
}

function closeBook(actorId) {
    const state = OPEN_BOOKS.get(actorId);
    if (!state) return;
    state.overlay?.remove();
    releaseForgeStyles(state.ownerKey);
    OPEN_BOOKS.delete(actorId);
}

async function renderBook(actor, kind, dataManager, overlay) {
    overlay.classList.add('is-loading');
    const slots = kind === 'spell' ? readSpellSlots(actor) : [];
    const entries = kind === 'spell'
        ? await buildSpellEntries(actor)
        : await buildFeatureEntries(actor);

    const spellLevels = kind === 'spell'
        ? Array.from(new Set(entries.map(entry => entry.level))).sort((a, b) => a - b)
        : [];
    const spellSchools = kind === 'spell'
        ? Array.from(new Set(entries.map(entry => entry.school).filter(Boolean))).sort()
        : [];
    const featureSources = kind === 'feature'
        ? Array.from(new Set(entries.map(entry => entry.sourceType).filter(Boolean))).sort()
        : [];

    const preparationSummary = kind === 'spell' ? readPreparationSummary(actor) : null;

    const title = kind === 'spell' ? 'Книга заклинаний' : 'Книга особенностей';
    const icon = kind === 'spell' ? 'fa-hat-wizard' : 'fa-shield-halved';

    overlay.innerHTML = `
        <div class="character-forge-book-shell">
            <header class="character-forge-book-header">
                <div class="character-forge-book-heading">
                    <i class="fas fa-book-open" aria-hidden="true"></i>
                    <div>
                        <h2>${title}</h2>
                        <div class="character-forge-book-actor">${esc(actor.name)}</div>
                    </div>
                </div>
                <button type="button" class="character-forge-book-close" title="Закрыть" aria-label="Закрыть"><i class="fas fa-times"></i></button>
            </header>

            ${kind === 'spell' ? `
                <section class="character-forge-book-slots">
                    <div class="character-forge-book-section-title"><i class="fas fa-gem"></i> Ячейки заклинаний</div>
                    <div class="character-forge-book-slot-grid">${renderSlots(slots)}</div>
                </section>
            ` : ''}

            <div class="character-forge-book-body">
                <aside class="character-forge-book-sidebar">
                    <div class="character-forge-book-search">
                        <i class="fas fa-search"></i>
                        <input type="text" data-book-search placeholder="Поиск...">
                    </div>

                    <div class="character-forge-book-filter-group">
                        <div class="character-forge-book-filter-label">Показать</div>
                        <div class="character-forge-book-filter-buttons">
                            <button type="button" class="active" data-book-state="all">Все</button>
                            ${kind === 'spell' ? `
                                <button type="button" data-book-state="prepared">Подготовленные</button>
                                <button type="button" data-book-state="unprepared">Неподготовленные</button>
                            ` : '<button type="button" data-book-state="owned">Полученные</button>'}
                        </div>
                    </div>

                    ${kind === 'spell' && spellLevels.length ? `
                        <div class="character-forge-book-filter-group">
                            <div class="character-forge-book-filter-label">Круг</div>
                            <div class="character-forge-book-filter-buttons">
                                <button type="button" class="active" data-book-level="all">Все</button>
                                ${spellLevels.map(level => `<button type="button" data-book-level="${level}">${level === 0 ? 'Фокусы' : level}</button>`).join('')}
                            </div>
                        </div>
                    ` : ''}

                    ${kind === 'spell' && spellSchools.length ? `
                        <div class="character-forge-book-filter-group">
                            <div class="character-forge-book-filter-label">Школа</div>
                            <div class="character-forge-book-filter-buttons">
                                <button type="button" class="active" data-book-school="all">Все</button>
                                ${spellSchools.map(school => `<button type="button" data-book-school="${esc(school)}">${esc(labelValue(CONFIG.DND5E?.spellSchools?.[school], school))}</button>`).join('')}
                            </div>
                        </div>
                    ` : ''}

                    ${kind === 'feature' && featureSources.length ? `
                        <div class="character-forge-book-filter-group">
                            <div class="character-forge-book-filter-label">Источник</div>
                            <div class="character-forge-book-filter-buttons">
                                <button type="button" class="active" data-book-source="all">Все</button>
                                ${featureSources.map(source => `<button type="button" data-book-source="${esc(source)}">${esc(({ class: 'Класс', race: 'Раса', background: 'Предыстория', feat: 'Черта', feature: 'Особенность' })[source] || source)}</button>`).join('')}
                            </div>
                        </div>
                    ` : ''}

                    ${kind === 'spell' ? renderPreparedZone(entries, preparationSummary) : ''}
                </aside>

                <main class="character-forge-book-main">
                    <div class="character-forge-book-main-head">
                        <div><i class="fas ${icon}"></i> ${kind === 'spell' ? 'Заклинания и фокусы персонажа' : 'Особенности персонажа'}</div>
                        <div>Показано: <span data-book-count>${entries.length}</span></div>
                    </div>
                    <div class="character-forge-book-grid">
                        ${entries.length
                            ? entries.map(entry => kind === 'spell' ? spellCard(entry) : featureCard(entry)).join('')
                            : '<div class="character-forge-book-empty">Нет доступных записей</div>'}
                    </div>
                </main>
            </div>
        </div>
    `;

    overlay.querySelector('.character-forge-book-close')?.addEventListener('click', () => closeBook(actor.id));
    overlay.onclick = event => {
        if (event.target === overlay) closeBook(actor.id);
    };
    overlay.onkeydown = event => {
        if (event.key === 'Escape') closeBook(actor.id);
    };

    overlay.querySelectorAll('.character-forge-book-card[data-owned="true"]').forEach(card => {
        card.addEventListener('dblclick', () => void openOwnedItem(card.dataset.uuid));
    });

    mountFilters(overlay, kind);
    if (kind === 'spell') bindSpellPreparationControls(overlay, actor);
    bindTooltips(overlay.querySelector('.character-forge-book-grid'), dataManager);
    overlay.classList.remove('is-loading');
}

export async function openActorBook(actor, kind, dataManager) {
    if (!actor || actor.type !== 'character' || !dataManager) return;

    const existing = OPEN_BOOKS.get(actor.id);
    if (existing) closeBook(actor.id);

    const ownerKey = `actor-book-${actor.id}-${kind}`;
    await acquireForgeStyles(ownerKey);

    const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';
    const overlay = document.createElement('div');
    overlay.className = `character-forge-book-overlay originate-container theme-${visualTheme}`;
    overlay.tabIndex = -1;
    document.body.appendChild(overlay);
    OPEN_BOOKS.set(actor.id, { actor, kind, dataManager, overlay, ownerKey });

    overlay.innerHTML = '<div class="character-forge-book-loading"><i class="fas fa-spinner fa-spin"></i> Загрузка...</div>';
    overlay.focus();

    try {
        await renderBook(actor, kind, dataManager, overlay);
    } catch (error) {
        console.error('Character Forge | Ошибка открытия книги персонажа', error);
        overlay.innerHTML = `
            <div class="character-forge-book-error">
                <i class="fas fa-triangle-exclamation"></i>
                <div>Не удалось открыть ${kind === 'spell' ? 'книгу заклинаний' : 'книгу особенностей'}.</div>
                <button type="button">Закрыть</button>
            </div>
        `;
        overlay.querySelector('button')?.addEventListener('click', () => closeBook(actor.id));
    }
}

export function refreshOpenActorBook(actor, dataManager) {
    const state = actor ? OPEN_BOOKS.get(actor.id) : null;
    if (!state || state.overlay?.isConnected !== true) return;
    void renderBook(actor, state.kind, dataManager || state.dataManager, state.overlay);
}
