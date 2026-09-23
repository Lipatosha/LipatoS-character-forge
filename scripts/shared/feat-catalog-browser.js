import { catalogText as t, queryCatalog } from './feat-catalog.js';

export const escapeCatalogHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const e = escapeCatalogHTML;

export function createFeatBrowser(entries, { filters = {}, selected = [], mode = 'choice', level = 1, renderCard } = {}) {
    return { entries, filters: { query: '', source: '', pack: '', category: '', maxLevel: '', status: '', sort: 'name', page: 0, ...filters }, selected: new Set(selected), mode, level, renderCard };
}

function facetOptions(model, field, labelField = field, source = '') {
    const values = new Map();
    for (const item of model.entries) {
        if (source && item.source !== source) continue;
        if (!values.has(item[field])) values.set(item[field], { label: item[labelField], count: 0 });
        values.get(item[field]).count++;
    }
    return [...values].sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([value, { label, count }]) =>
        `<option value="${e(value)}" ${model.filters[field === 'packId' ? 'pack' : field] === value ? 'selected' : ''}>${e(label)} (${count})</option>`).join('');
}

function selectControl(key, title, options, value = '') {
    return `<label class="feat-catalog-field"><span>${e(t(title))}</span><select data-catalog-filter="${key}" aria-label="${e(t(title))}">${options.map(([id, label]) => `<option value="${e(id)}" ${String(value) === String(id) ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>`;
}

function renderControls(model) {
    const f = model.filters;
    const facet = (key, title, field, label) => `<label class="feat-catalog-field"><span>${e(t(title))}</span><select data-catalog-filter="${key}" aria-label="${e(t(title))}"><option value="">${e(t('All'))}</option>${facetOptions(model, field, label, key === 'pack' ? f.source : '')}</select></label>`;
    const levels = [...new Set(model.entries.map(item => item.minLevel))].sort((a, b) => a - b);
    const statuses = model.mode === 'manage'
        ? [['', t('All')], ['included', t('Included')], ['excluded', t('Excluded')]]
        : [['', t('All')], ['available', t('Selectable')], ['repeatable', t('Repeatable')]];
    return `<div class="feat-catalog-toolbar">
        <div class="feat-catalog-search"><i class="fas fa-search" aria-hidden="true"></i>
            <input type="search" class="feat-search-input" data-catalog-query value="${e(f.query)}" placeholder="${e(t('SearchPlaceholder'))}" aria-label="${e(t('SearchPlaceholder'))}" autocomplete="off">
            <button type="button" data-catalog-clear aria-label="${e(t('ClearSearch'))}" ${f.query ? '' : 'hidden'}><i class="fas fa-times" aria-hidden="true"></i></button>
        </div>
        <div class="feat-catalog-filters">
            ${facet('source', 'Source', 'source', 'source')}${facet('pack', 'Pack', 'packId', 'packLabel')}${facet('category', 'CategoryLabel', 'category', 'categoryLabel')}
            ${selectControl('maxLevel', 'MaxLevel', [['', t('All')], ...levels.map(level => [level, level ? t('LevelUpTo', { level }) : t('NoLevelRequirement')])], f.maxLevel)}
            ${selectControl('status', 'Status', statuses, f.status)}
            ${selectControl('sort', 'Sort', [['name', t('NameAsc')], ['nameDesc', t('NameDesc')], ['level', t('LevelAsc')], ['source', t('Source')]], f.sort)}
        </div>
        <div class="feat-catalog-summary"><div><span data-catalog-count role="status" aria-live="polite"></span>${model.mode === 'choice' ? `<span class="feat-catalog-level-scope">${e(t('LevelScope', { level: model.level }))}</span>` : ''}</div><button type="button" data-catalog-reset>${e(t('Reset'))}</button></div>
    </div>`;
}

function pageCards(model, result) {
    const visible = new Set(result.visible.map(item => item.uuid));
    // 保留跨页的已选 input，让现有草稿读取、radio 互斥和提交始终看到完整选择。
    const retained = model.entries.filter(item => model.selected.has(item.uuid) && !visible.has(item.uuid));
    const card = (item, hidden) => model.renderCard(item, model.selected.has(item.uuid), hidden);
    return result.visible.map(item => card(item, false)).join('') + retained.map(item => card(item, true)).join('');
}

export function renderFeatBrowser(model, key = 'feats') {
    const result = queryCatalog(model.entries, model.filters);
    model.filters.page = result.page;
    const tag = model.mode === 'manage' ? 'ul' : 'div';
    return `<div class="feat-catalog" data-feat-catalog="${e(key)}">
        ${renderControls(model)}
        <div class="feat-catalog-selection" data-catalog-selection ${model.selected.size ? '' : 'hidden'}></div>
        <div class="feat-catalog-viewport"><div class="feat-catalog-body" data-catalog-body>
            <${tag} class="${model.mode === 'manage' ? 'config-item-list' : 'options-container feat-selection-list'}" data-catalog-results>${pageCards(model, result)}</${tag}>
            <p class="feat-search-empty" data-catalog-empty ${result.matches.length ? 'hidden' : ''}>${e(t('Empty'))}</p>
        </div></div>
        <nav class="feat-catalog-pages" aria-label="${e(t('Pagination'))}"><button type="button" data-catalog-prev>${e(t('Previous'))}</button><span data-catalog-page></span><button type="button" data-catalog-next>${e(t('Next'))}</button></nav>
    </div>`;
}

export function bindFeatBrowser(root, model, { onRender = () => {}, onFilters = () => {} } = {}) {
    if (!root || root.dataset.catalogBound) return;
    root.dataset.catalogBound = 'true';
    const list = root.querySelector('[data-catalog-results]');
    const body = root.querySelector('[data-catalog-body]');
    const viewport = root.querySelector('.feat-catalog-viewport');
    const query = root.querySelector('[data-catalog-query]');
    const updateScrollEdges = () => {
        const remaining = body.scrollHeight - body.clientHeight - body.scrollTop;
        // 靠近首尾时逐步收短渐隐，避免滚动一像素就突然遮住整段内容。
        viewport.style.setProperty('--catalog-fade-top', `${Math.min(24, Math.max(0, body.scrollTop))}px`);
        viewport.style.setProperty('--catalog-fade-bottom', `${Math.min(24, Math.max(0, remaining))}px`);
    };
    const updateSummary = result => {
        root.querySelector('[data-catalog-count]').textContent = t('Results', { count: result.matches.length, total: model.entries.length });
        root.querySelector('[data-catalog-page]').textContent = t('Page', { page: result.page + 1, pages: result.pages });
        root.querySelector('[data-catalog-prev]').disabled = result.page === 0;
        root.querySelector('[data-catalog-next]').disabled = result.page === result.pages - 1;
        root.querySelector('[data-catalog-empty]').hidden = result.matches.length > 0;
        root.querySelector('[data-catalog-clear]').hidden = !query.value;
        const selection = root.querySelector('[data-catalog-selection]');
        const names = model.entries.filter(item => model.selected.has(item.uuid)).map(item => item.name).join(', ');
        selection.hidden = !names;
        selection.textContent = names ? t('Selected', { names }) : '';
        selection.title = selection.textContent;
    };
    const refresh = () => {
        const result = queryCatalog(model.entries, model.filters);
        model.filters.page = result.page;
        list.innerHTML = pageCards(model, result);
        body.scrollTop = 0;
        updateSummary(result);
        onRender(list);
        updateScrollEdges();
        onFilters({ ...model.filters });
    };
    const changeFilters = () => { model.filters.page = 0; refresh(); };
    // 搜索仅遍历轻量索引，DOM 始终只渲染一页，不随资料库大小增长。
    query.addEventListener('input', event => {
        if (event.isComposing) return;
        model.filters.query = query.value;
        changeFilters();
    });
    query.addEventListener('compositionend', () => { model.filters.query = query.value; changeFilters(); });
    query.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    root.addEventListener('change', event => {
        const filter = event.target.dataset.catalogFilter;
        if (filter) {
            model.filters[filter] = event.target.value;
            if (filter === 'source') {
                model.filters.pack = '';
                root.querySelector('[data-catalog-filter="pack"]').innerHTML = `<option value="">${e(t('All'))}</option>${facetOptions(model, 'packId', 'packLabel', model.filters.source)}`;
            }
            changeFilters();
        } else if (event.target.matches('input[name^="feat-choice-"]')) {
            model.selected.clear();
            if (event.target.checked) model.selected.add(event.target.value);
            list.querySelectorAll('.feat-option').forEach(card => card.classList.toggle('selected', !!card.querySelector('input:checked')));
            updateSummary(queryCatalog(model.entries, model.filters));
        }
    });
    root.querySelector('[data-catalog-clear]').addEventListener('click', () => { query.value = ''; model.filters.query = ''; changeFilters(); query.focus(); });
    root.querySelector('[data-catalog-reset]').addEventListener('click', () => {
        Object.assign(model.filters, { query: '', source: '', pack: '', category: '', maxLevel: '', status: '', sort: 'name', page: 0 });
        query.value = '';
        root.querySelectorAll('[data-catalog-filter]').forEach(select => { select.value = model.filters[select.dataset.catalogFilter]; });
        root.querySelector('[data-catalog-filter="pack"]').innerHTML = `<option value="">${e(t('All'))}</option>${facetOptions(model, 'packId', 'packLabel')}`;
        refresh();
    });
    for (const [selector, delta] of [['prev', -1], ['next', 1]]) {
        root.querySelector(`[data-catalog-${selector}]`).addEventListener('click', () => {
            model.filters.page += delta;
            refresh();
            // 选择页只滚动卡片区，不能把外层居中面板一起拉到视口顶部。
            if (model.mode === 'manage') root.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
    }
    updateSummary(queryCatalog(model.entries, model.filters));
    body.addEventListener('scroll', updateScrollEdges, { passive: true });
    body.addEventListener('load', updateScrollEdges, true);
    if (globalThis.ResizeObserver) {
        const observer = new ResizeObserver(() => {
            // 换步骤后释放旧面板的观察器；图片加载、窗口缩放和列表变短都需要重算边界。
            if (!root.isConnected) { observer.disconnect(); return; }
            updateScrollEdges();
        });
        observer.observe(body);
        observer.observe(list);
    }
    updateScrollEdges();
}

export function renderManagedFeat(item, _selected, hidden) {
    const action = item.isManual ? 'removeItem' : (item.isExcluded ? 'includeItem' : 'excludeItem');
    const label = item.isManual ? 'Remove' : (item.isExcluded ? 'Include' : 'Exclude');
    const icon = item.isManual ? 'times' : (item.isExcluded ? 'undo' : 'ban');
    return `<li class="config-item ${item.isManual ? '' : 'auto-scanned'} ${item.isExcluded ? 'excluded' : ''}" ${hidden ? 'hidden' : ''} data-uuid="${e(item.uuid)}">
        <img src="${e(item.img)}" alt="" class="item-img" loading="lazy">
        <div class="item-info"><span class="item-name">${e(item.name)}</span><span class="item-source-id">${e(item.source)} · ${e(item.packLabel)}</span><span class="feat-catalog-meta">${e(item.categoryLabel)} · ${e(t('RequiredLevel', { level: item.minLevel || 1 }))}</span></div>
        <div class="item-actions"><button type="button" class="btn-${item.isManual ? 'remove' : (item.isExcluded ? 'include' : 'exclude')}" data-action="${action}" data-uuid="${e(item.uuid)}" data-category="feats" title="${e(game.i18n.localize(`ORIGINATE.Settings.Config.${label}`))}" aria-label="${e(game.i18n.localize(`ORIGINATE.Settings.Config.${label}`))}"><i class="fas fa-${icon}" aria-hidden="true"></i></button></div>
    </li>`;
}
