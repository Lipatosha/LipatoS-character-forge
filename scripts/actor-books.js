import { acquireForgeStyles, releaseForgeStyles } from './runtime-style.js';
import { SpellRules } from './spell-rules.js';
import { normalizeSpellListId, normalizeSpellListIds } from './shared/spell-list-filters.js';
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

function actorClassProfiles(actor, dataManager) {
    const classes = Array.from(actor.items || []).filter(item => item.type === 'class');
    const subclasses = Array.from(actor.items || []).filter(item => item.type === 'subclass');
    const classById = new Map();
    const profiles = [];

    for (const item of classes) {
        const id = normalizeSpellListId(item.system?.identifier || item.name);
        if (!id) continue;
        const level = Math.max(1, Number(item.system?.levels ?? item.system?.level ?? 1) || 1);
        const rules = SpellRules.getRules(id);
        const progression = rules?.progression || item.system?.spellcasting?.progression || null;
        const lists = normalizeSpellListIds(rules?.list?.length ? rules.list : [id]);
        let maxSpellLevel = null;
        if (progression) {
            const computed = dataManager?.getMaxSpellLevel?.(progression, level);
            if (Number.isFinite(computed)) maxSpellLevel = computed;
        }
        classById.set(id, { id, level, item, progression, maxSpellLevel, lists });
        profiles.push({ id, level, item, progression, maxSpellLevel, lists });
    }

    for (const item of subclasses) {
        const id = normalizeSpellListId(item.system?.identifier || item.name);
        if (!id) continue;
        const classId = normalizeSpellListId(item.system?.classIdentifier || '');
        const parent = classById.get(classId);
        const rules = SpellRules.getRules(id);
        if (!rules && !item.system?.spellcasting?.progression) continue;
        const level = parent?.level || Math.max(1, Number(item.system?.levels ?? 1) || 1);
        const progression = rules?.progression || item.system?.spellcasting?.progression || parent?.progression || null;
        const lists = normalizeSpellListIds(rules?.list?.length ? rules.list : [id]);
        let maxSpellLevel = parent?.maxSpellLevel ?? null;
        if (progression) {
            const computed = dataManager?.getMaxSpellLevel?.(progression, level);
            if (Number.isFinite(computed)) maxSpellLevel = computed;
        }
        profiles.push({ id, level, item, progression, maxSpellLevel, lists });
    }

    return { profiles, classById };
}

function actorSourceIdentifiers(actor) {
    const result = {
        class: new Map(),
        race: new Map(),
        background: new Map()
    };

    for (const item of actor.items || []) {
        if (item.type === 'class') {
            const id = norm(item.system?.identifier || item.name);
            if (id) result.class.set(id, Math.max(1, Number(item.system?.levels ?? item.system?.level ?? 1) || 1));
        } else if (item.type === 'race') {
            const id = norm(item.system?.identifier || item.name);
            if (id) result.race.set(id, 20);
        } else if (item.type === 'background') {
            const id = norm(item.system?.identifier || item.name);
            if (id) result.background.set(id, 20);
        }
    }
    return result;
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

function preparationState(item) {
    const prep = item.system?.preparation || {};
    if (prep.mode === 'always') return 'Всегда подготовлено';
    if (prep.prepared) return 'Подготовлено';
    if (prep.mode === 'prepared') return 'В книге';
    if (prep.mode === 'known') return 'Изучено';
    return 'Выбрано';
}

function featureUsage(item) {
    const uses = item.system?.uses;
    if (!uses) return '';
    const max = Number(uses.max ?? 0);
    const value = Number(uses.value ?? 0);
    if (!Number.isFinite(max) || max <= 0) return '';
    return `Использования: ${Number.isFinite(value) ? value : 0}/${max}`;
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

async function buildSpellEntries(actor, dataManager) {
    const ownedItems = Array.from(actor.items || []).filter(item => item.type === 'spell');
    const ownedBySource = new Map();
    const ownedByName = new Map();
    for (const item of ownedItems) {
        const src = sourceUuid(item);
        if (src) ownedBySource.set(src, item);
        ownedByName.set(item.name.toLowerCase(), item);
    }

    const { profiles } = actorClassProfiles(actor, dataManager);
    const availableMap = new Map();

    for (const profile of profiles) {
        if (!profile.lists.length) continue;
        const restriction = { list: profile.lists.map(id => `class:${id}`) };
        let spells = [];
        try {
            spells = await dataManager.getSpellsByRestriction(restriction, '', profile.maxSpellLevel);
        } catch (error) {
            console.warn('Character Forge | Не удалось загрузить список заклинаний персонажа', error);
        }
        for (const spell of spells) {
            const key = spell.uuid || spell.name.toLowerCase();
            const existing = availableMap.get(key);
            if (!existing) {
                availableMap.set(key, { ...spell, sourceClasses: new Set([profile.id]) });
            } else {
                existing.sourceClasses.add(profile.id);
            }
        }
    }

    const entries = [];
    const seenOwned = new Set();

    for (const spell of availableMap.values()) {
        const owned = ownedBySource.get(spell.uuid) || ownedByName.get(spell.name.toLowerCase()) || null;
        if (owned) seenOwned.add(owned.id);
        entries.push({
            uuid: owned?.uuid || spell.uuid,
            sourceUuid: spell.uuid,
            name: owned?.name || spell.name,
            img: owned?.img || spell.img,
            level: Number(owned?.system?.level ?? spell.level ?? 0),
            school: owned?.system?.school ?? spell.school ?? '',
            owned: !!owned,
            prepared: !!owned?.system?.preparation?.prepared || owned?.system?.preparation?.mode === 'always',
            state: owned ? preparationState(owned) : 'Доступно',
            classes: Array.from(spell.sourceClasses || [])
        });
    }

    for (const item of ownedItems) {
        if (seenOwned.has(item.id)) continue;
        entries.push({
            uuid: item.uuid,
            sourceUuid: sourceUuid(item),
            name: item.name,
            img: item.img,
            level: Number(item.system?.level ?? 0),
            school: item.system?.school || '',
            owned: true,
            prepared: !!item.system?.preparation?.prepared || item.system?.preparation?.mode === 'always',
            state: preparationState(item),
            classes: normalizeSpellListIds(item.system?.sourceClass)
        });
    }

    return entries.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
}

async function buildFeatureEntries(actor, dataManager) {
    const ownedItems = Array.from(actor.items || []).filter(item => item.type === 'feat');
    const ownedBySource = new Map();
    const ownedByName = new Map();
    for (const item of ownedItems) {
        const src = sourceUuid(item);
        if (src) ownedBySource.set(src, item);
        ownedByName.set(item.name.toLowerCase(), item);
    }

    const sources = actorSourceIdentifiers(actor);
    let options = [];
    try {
        options = await dataManager.getOptions('feature', {}, { indexOnly: true });
    } catch (error) {
        console.warn('Character Forge | Не удалось загрузить доступные особенности', error);
    }

    const entries = [];
    const seenOwned = new Set();

    for (const option of options) {
        const system = option.system || {};
        const sourceType = norm(system.type?.value);
        const subtype = norm(system.type?.subtype || system.sourceClass || option.classIdentifier || '');
        const requiredLevel = Number(system.prerequisites?.level ?? option.prerequisites?.level ?? 0) || 0;

        let available = false;
        let sourceLabel = '';

        if (sourceType === 'class') {
            const classLevel = sources.class.get(subtype);
            available = Number.isFinite(classLevel) && classLevel >= requiredLevel;
            sourceLabel = subtype;
        } else if (sourceType === 'race') {
            available = sources.race.has(subtype);
            sourceLabel = subtype;
        } else if (sourceType === 'background') {
            available = sources.background.has(subtype);
            sourceLabel = subtype;
        }

        if (!available) continue;

        const owned = ownedBySource.get(option.uuid) || ownedByName.get(option.name.toLowerCase()) || null;
        if (owned) seenOwned.add(owned.id);

        entries.push({
            uuid: owned?.uuid || option.uuid,
            sourceUuid: option.uuid,
            name: owned?.name || option.name,
            img: owned?.img || option.img,
            owned: !!owned,
            state: owned ? 'Получено' : 'Доступно',
            sourceType: sourceType || 'feature',
            sourceLabel,
            uses: owned ? featureUsage(owned) : ''
        });
    }

    for (const item of ownedItems) {
        if (seenOwned.has(item.id)) continue;
        entries.push({
            uuid: item.uuid,
            sourceUuid: sourceUuid(item),
            name: item.name,
            img: item.img,
            owned: true,
            state: 'Получено',
            sourceType: norm(item.system?.type?.value) || 'feature',
            sourceLabel: norm(item.system?.type?.subtype || ''),
            uses: featureUsage(item)
        });
    }

    return entries.sort((a, b) => {
        if (a.owned !== b.owned) return a.owned ? -1 : 1;
        return a.name.localeCompare(b.name, game.i18n.lang);
    });
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
    const badges = [
        entry.state,
        entry.prepared ? 'Подготовлено' : '',
        entry.classes.length ? entry.classes.join(', ') : ''
    ].filter(Boolean);

    return `
        <article class="character-forge-book-card spell-card ${entry.owned ? 'is-owned' : 'is-available'} ${entry.prepared ? 'is-prepared' : ''}"
                 data-uuid="${esc(entry.uuid)}"
                 data-name="${esc(entry.name.toLowerCase())}"
                 data-level="${entry.level}"
                 data-school="${esc(entry.school)}"
                 data-owned="${entry.owned ? 'true' : 'false'}">
            <img src="${esc(entry.img || 'icons/svg/book.svg')}" alt="">
            <div class="character-forge-book-card-main">
                <div class="character-forge-book-card-name">${esc(entry.name)}</div>
                <div class="character-forge-book-card-meta">${esc(level)}${school ? ` • ${esc(school)}` : ''}</div>
                <div class="character-forge-book-card-badges">
                    ${badges.map(text => `<span>${esc(text)}</span>`).join('')}
                </div>
            </div>
            <i class="fas ${entry.owned ? 'fa-bookmark' : 'fa-book-open'} character-forge-book-card-state" aria-hidden="true"></i>
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
                || (state === 'owned' && card.dataset.owned === 'true')
                || (state === 'available' && card.dataset.owned !== 'true');
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
        ? await buildSpellEntries(actor, dataManager)
        : await buildFeatureEntries(actor, dataManager);

    const spellLevels = kind === 'spell'
        ? Array.from(new Set(entries.map(entry => entry.level))).sort((a, b) => a - b)
        : [];
    const spellSchools = kind === 'spell'
        ? Array.from(new Set(entries.map(entry => entry.school).filter(Boolean))).sort()
        : [];
    const featureSources = kind === 'feature'
        ? Array.from(new Set(entries.map(entry => entry.sourceType).filter(Boolean))).sort()
        : [];

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
                            <button type="button" data-book-state="owned">${kind === 'spell' ? 'Выбранные' : 'Полученные'}</button>
                            <button type="button" data-book-state="available">Доступные</button>
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
                </aside>

                <main class="character-forge-book-main">
                    <div class="character-forge-book-main-head">
                        <div><i class="fas ${icon}"></i> ${kind === 'spell' ? 'Заклинания и фокусы' : 'Особенности персонажа'}</div>
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
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeBook(actor.id);
    });
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeBook(actor.id);
    });

    overlay.querySelectorAll('.character-forge-book-card[data-owned="true"]').forEach(card => {
        card.addEventListener('dblclick', () => void openOwnedItem(card.dataset.uuid));
    });

    mountFilters(overlay, kind);
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
