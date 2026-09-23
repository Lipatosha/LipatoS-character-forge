/**
 * progression-renderer.js — 共享渲染层
 * 
 * Adrian: 这个文件是 P0 重构的核心成果。
 * 把 LevelUpApp 和 ProgressionMixin 里重复的代码都搬到这里，
 * 两边都调用同一份代码，再也不用担心改了一边忘了另一边了。
 * 
 * Phase 1: 工具函数 + Tooltip 系统
 */

import { getToolsByCategory, getWeaponLabel, getWeaponMasteryOptions, getToolLabel } from '../mapping.js';
//  纯工具函数
/**
 * 清理 HTML 描述（截断版），用于卡片摘要
 * @param {string} desc HTML 描述
 * @param {number} maxLength 最大长度，默认 100
 * @returns {string} 纯文本摘要
 */
export function cleanDescription(desc, maxLength = 100) {
    if (!desc) return '';
    let text = desc.replace(/<[^>]*>/g, ' ').replace(/@\w+\[[^\]]*\](\{[^}]*\})?/g, '').replace(/\s+/g, ' ').trim();
    if (maxLength > 0 && text.length > maxLength) {
        return text.substring(0, maxLength) + '...';
    }
    return text;
}

/**
 * 获取描述
 * @param {string} desc HTML 描述
 * @returns {string} 完整纯文本
 */
export function getFullCleanDescription(desc) {
    if (!desc) return '';
    return desc.replace(/<[^>]*>/g, ' ').replace(/@\w+\[[^\]]*\](\{([^}]*)\})?/g, (m, _, label) => label || '').replace(/\[\[\/?\w+[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 处理html
 * @param {string} desc HTML 描述
 * @returns {string} 处理后的文本
 */
export function processHtmlDescription(desc) {
    if (!desc) return '';
    let text = desc;
    // 1. [[/damage 3d6 type=psychic]] -> "3d6 心灵伤害"
    text = text.replace(/\[\[\/(\\w+)\s+([^\]]*)\]\]/g, (match, action, params) => {
        const diceMatch = params.match(/(\d+d\d+(?:\s*\+\s*\d+)?)/);
        const typeMatch = params.match(/type=(\w+)/);
        let result = diceMatch ? diceMatch[1] : params;
        if (typeMatch) {
            const dmgType = typeMatch[1];
            const localizedType = CONFIG.DND5E?.damageTypes?.[dmgType]?.label || dmgType;
            result += ` ${localizedType}`;
        }
        return result;
    });
    // 2. [[/save ability=dex dc=15]] -> "DC 15 敏捷豁免"
    text = text.replace(/\[\[\/save\s+([^\]]*)\]\]/g, (match, params) => {
        const abilityMatch = params.match(/ability=(\w+)/i);
        const dcMatch = params.match(/dc=(\d+)/i);
        let result = '豁免';
        if (abilityMatch) {
            const ab = abilityMatch[1].toLowerCase();
            const labels = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
            result = `${labels[ab] || ab}豁免`;
        }
        if (dcMatch) result = `DC ${dcMatch[1]} ${result}`;
        return result;
    });
    // 3. 其他 [[...]] -> 内部文本
    text = text.replace(/\[\[([^\]]*)\]\]/g, (match, inner) => inner);
    // 4. @UUID[...]{label} -> label
    text = text.replace(/@\w+\[[^\]]*\](\{([^}]*)\})?/g, (match, _, label) => label || '');
    // 5. &Reference[key]{label} -> label
    text = text.replace(/&amp;Reference\[([^\]]*)\]\{([^}]*)\}/g, (match, key, label) => label);
    text = text.replace(/&amp;Reference\[([^\]]*)\]/g, (match, key) => key);
    text = text.replace(/&Reference\[([^\]]*)\]\{([^}]*)\}/g, (match, key, label) => label);
    text = text.replace(/&Reference\[([^\]]*)\]/g, (match, key) => key);
    // 6. 移除 HTML 标签
    text = text.replace(/<[^>]*>/g, ' ');
    // 7. 清理多余空白
    text = text.replace(/\s+/g, ' ').trim();
    // 8. 转义引号
    return text.replace(/"/g, '&quot;');
}

/**
 * 递归遍历语言配置树
 * @param {Object} langObj 语言配置对象
 * @param {Array} results 结果数组
 */
export function traverseLanguageTree(langObj, results) {
    for (const [key, value] of Object.entries(langObj)) {
        if (key === 'label' || key === 'selectable' || key === 'children') continue;
        if (typeof value === 'object' && value !== null) {
            if (value.children) traverseLanguageTree(value.children, results);
            else {
                const label = value.label || key;
                if (key.toLowerCase() === 'common' || label === '通用语') continue;
                if (!results.some(r => r.key === `languages:${key}`)) results.push({ key: `languages:${key}`, label });
            }
        } else if (typeof value === 'string') {
            if (key.toLowerCase() === 'common' || value === '通用语') continue;
            if (!results.some(r => r.key === `languages:${key}`)) results.push({ key: `languages:${key}`, label: value });
        }
    }
}

/**
 * 递归查找语言标签
 * @param {string} langKey 语言键名
 * @param {Object} langObj 语言配置对象
 * @returns {string|null} 语言标签
 */
export function findLanguageLabel(langKey, langObj) {
    if (!langObj || typeof langObj !== 'object') return null;
    if (langObj[langKey]) {
        const val = langObj[langKey];
        return typeof val === 'string' ? val : (val.label || langKey);
    }
    for (const [key, value] of Object.entries(langObj)) {
        if (typeof value === 'object' && value !== null) {
            if (value.children) { const found = findLanguageLabel(langKey, value.children); if (found) return found; }
            else if (key !== 'label' && key !== 'selectable') { const found = findLanguageLabel(langKey, value); if (found) return found; }
        }
    }
    return null;
}

/**
 * 获取单个特质的本地化标签
 * @param {string} key 特质 key，如 "skills:arc" 或 "languages:elvish"
 * @returns {string} 标签
 */
function localizeConfigEntry(entry, fallback) {
    const rawLabel = typeof entry === 'string' ? entry : entry?.label;
    if (!rawLabel) return fallback;
    try {
        const localized = game.i18n.localize(rawLabel);
        return localized && localized !== rawLabel ? localized : rawLabel;
    } catch {
        return rawLabel;
    }
}

function localizeModuleKey(key, fallback) {
    try {
        const localized = game.i18n.localize(key);
        if (localized && localized !== key) return localized;
    } catch {
        // Fall through to the system label/key.
    }
    return fallback;
}

function getAbilityTraitLabel(value) {
    const abilityKey = String(value || '').trim().toLowerCase().split(':').pop();
    const suffixes = { str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha' };
    const suffix = suffixes[abilityKey];
    if (suffix) {
        return localizeModuleKey(
            `ORIGINATE.Ability.${suffix}`,
            localizeConfigEntry(CONFIG.DND5E.abilities?.[abilityKey], abilityKey)
        );
    }
    return localizeConfigEntry(CONFIG.DND5E.abilities?.[abilityKey], abilityKey);
}

function getDamageTraitLabel(value) {
    const damageKey = String(value || '').trim().toLowerCase().split(':').pop();
    const suffix = damageKey ? damageKey.charAt(0).toUpperCase() + damageKey.slice(1) : '';
    if (suffix) {
        const ownKey = `ORIGINATE.Damage.${suffix}`;
        const ownLabel = localizeModuleKey(ownKey, null);
        if (ownLabel) return ownLabel;
    }
    return localizeConfigEntry(CONFIG.DND5E.damageTypes?.[damageKey], damageKey);
}

function getConditionTraitLabel(value) {
    const conditionKey = String(value || '').trim().toLowerCase().split(':').pop();
    return localizeConfigEntry(
        CONFIG.DND5E.conditionTypes?.[conditionKey] || CONFIG.DND5E.conditions?.[conditionKey],
        conditionKey
    );
}

function getSizeTraitLabel(value) {
    const sizeKey = String(value || '').trim().toLowerCase().split(':').pop();
    const aliases = {
        tiny: 'Tiny',
        sm: 'Small',
        small: 'Small',
        med: 'Medium',
        medium: 'Medium',
        lg: 'Large',
        large: 'Large',
        huge: 'Huge',
        grg: 'Gargantuan',
        gargantuan: 'Gargantuan'
    };
    const suffix = aliases[sizeKey];
    if (suffix) {
        return localizeModuleKey(
            `ORIGINATE.Size.${suffix}`,
            localizeConfigEntry(CONFIG.DND5E.actorSizes?.[sizeKey], sizeKey)
        );
    }
    return localizeConfigEntry(CONFIG.DND5E.actorSizes?.[sizeKey], sizeKey);
}

export function getTraitLabel(key) {
    if (!key || typeof key !== 'string') return key;
    const parts = key.split(':');
    if (parts.length < 2) return key;
    const type = parts[0];
    const value = parts.slice(1).join(':');

    switch (type) {
        case 'skills': {
            const skillKey = value.includes(':') ? value.split(':').pop() : value;
            return localizeConfigEntry(CONFIG.DND5E.skills?.[skillKey], skillKey);
        }
        case 'saves':
        case 'save':
            return getAbilityTraitLabel(value);
        case 'languages': {
            const langKey = value.includes(':') ? value.split(':').pop() : value;
            const label = findLanguageLabel(langKey, CONFIG.DND5E.languages || {}) || langKey;
            return localizeConfigEntry(label, langKey);
        }
        case 'tool':
            return getToolLabel(value.includes(':') ? value.split(':').pop() : value) || value;
        case 'weapon': {
            const weaponKey = String(value || '').trim().toLowerCase().split(':').pop();
            if (weaponKey === 'sim' || weaponKey === 'simple') {
                return game.i18n.localize('ORIGINATE.Weapon.Simple');
            }
            if (weaponKey === 'mar' || weaponKey === 'martial') {
                return game.i18n.localize('ORIGINATE.Weapon.Martial');
            }
            return getWeaponLabel(value) || value;
        }
        case 'weaponMastery':
            return getWeaponLabel(value) || value;
        case 'armor': {
            const armorKey = String(value || '').trim().toLowerCase().split(':').pop();
            if (armorKey === 'lgt' || armorKey === 'light') return game.i18n.localize('ORIGINATE.Armor.Light');
            if (armorKey === 'med' || armorKey === 'medium') return game.i18n.localize('ORIGINATE.Armor.Medium');
            if (armorKey === 'hvy' || armorKey === 'heavy') return game.i18n.localize('ORIGINATE.Armor.Heavy');
            if (armorKey === 'shl' || armorKey === 'shield') return game.i18n.localize('ORIGINATE.Armor.Shield');
            return armorKey;
        }
        case 'dr':
        case 'di':
        case 'dv':
        case 'damageResistance':
        case 'damageImmunity':
        case 'damageVulnerability':
            return getDamageTraitLabel(value);
        case 'ci':
        case 'conditionImmunity':
            return getConditionTraitLabel(value);
        case 'size':
            return getSizeTraitLabel(value);
        default:
            return value.includes(':') ? value.split(':').pop() : value;
    }
}

/**
 * 展开通配符
 * @param {Array} poolArray 特质 key 数组（可能包含通配符如 'languages:*'）
 * @returns {Array} 展开后的 { key, label } 数组
 */
export function expandWildcardPool(poolArray) {
    const results = [];
    const simpleWeapons = ['club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'lighthammer', 'mace', 'quarterstaff', 'sickle', 'spear', 'lightcrossbow', 'dart', 'shortbow', 'sling'];
    const martialWeapons = ['battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd', 'lance', 'longsword', 'maul', 'morningstar', 'pike', 'rapier', 'scimitar', 'shortsword', 'trident', 'warpick', 'warhammer', 'whip', 'blowgun', 'handcrossbow', 'heavycrossbow', 'longbow', 'net'];
    for (const pattern of poolArray) {
        if (pattern === 'languages:*') {
            const allLangs = CONFIG.DND5E.languages || {};
            traverseLanguageTree(allLangs, results);
        } else if (pattern === 'languages:standard:*') {
            const standardLangs = CONFIG.DND5E.languages?.standard || {};
            if (standardLangs.children) traverseLanguageTree(standardLangs.children, results);
            else traverseLanguageTree(standardLangs, results);
        } else if (pattern === 'languages:exotic:*' || pattern === 'languages:rare:*') {
            const exoticLangs = CONFIG.DND5E.languages?.exotic || CONFIG.DND5E.languages?.rare || {};
            if (exoticLangs.children) traverseLanguageTree(exoticLangs.children, results);
            else traverseLanguageTree(exoticLangs, results);
        } else if (pattern === 'skills:*') {
            const skills = CONFIG.DND5E.skills || {};
            for (const [key, value] of Object.entries(skills)) {
                const label = typeof value === 'string' ? value : (value.label || key);
                results.push({ key: `skills:${key}`, label });
            }
        } else if (pattern === 'tool:*') {
            // 遍历全部分类
            for (const cat of ['art', 'music', 'game']) {
                const catTools = getToolsByCategory(cat);
                results.push(...catTools);
            }
            // 兜底
            const toolProfs = CONFIG.DND5E?.toolProficiencies || {};
            const existingKeys = new Set(results.map(r => r.key));
            for (const [, config] of Object.entries(toolProfs)) {
                if (config.children) {
                    for (const [toolKey, toolLabel] of Object.entries(config.children)) {
                        const key = `tool:${toolKey}`;
                        if (!existingKeys.has(key)) {
                            let label = typeof toolLabel === 'string' ? toolLabel : (toolLabel.label || toolKey);
                            const mappedLabel = getToolLabel(toolKey);
                            if (mappedLabel) label = mappedLabel;
                            results.push({ key, label });
                            existingKeys.add(key);
                        }
                    }
                }
            }
        } else if (pattern.startsWith('tool:') && pattern.endsWith(':*')) {
            const parts = pattern.split(':');
            let category = parts[1];
            if (category === 'gaming_set') category = 'game';
            if (category === 'musical_instrument') category = 'music';
            if (category === 'artisan_tool') category = 'art';
            const mappingTools = getToolsByCategory(category);
            if (mappingTools.length > 0) results.push(...mappingTools);
            else {
                const toolProfs = CONFIG.DND5E.toolProficiencies || {};
                for (const [cat, config] of Object.entries(toolProfs)) {
                    if (config.children && (cat.includes(category) || (category === 'art' && cat.includes('artisan')))) {
                        for (const [toolKey, toolLabel] of Object.entries(config.children)) {
                            let label = typeof toolLabel === 'string' ? toolLabel : (toolLabel.label || toolKey);
                            const mappedLabel = getToolLabel(toolKey);
                            if (mappedLabel) label = mappedLabel;
                            results.push({ key: `tool:${toolKey}`, label });
                        }
                    }
                }
            }
        } else if (pattern === 'weapon:*') {
            const weapons = CONFIG.DND5E.weaponIds || {};
            for (const [key] of Object.entries(weapons)) {
                results.push({ key: `weapon:${key}`, label: getWeaponLabel(key) || key });
            }
        } else if (pattern === 'weaponMastery:sim:*' || pattern === 'weaponMastery:simple:*') {
            simpleWeapons.forEach(key => {
                results.push({ key: `weaponMastery:${key}`, label: getWeaponLabel(key) || key });
            });
        } else if (pattern === 'weaponMastery:mar:*' || pattern === 'weaponMastery:martial:*') {
            martialWeapons.forEach(key => {
                results.push({ key: `weaponMastery:${key}`, label: getWeaponLabel(key) || key });
            });
        } else if (pattern === 'weaponMastery:*') {
            results.push(...getWeaponMasteryOptions());
        } else if (!pattern.endsWith(':*')) {
            results.push({ key: pattern, label: getTraitLabel(pattern) });
        }
    }
    return results;
}


/**
 * 显示自定义确认弹窗
 * 
 * Foundry 原生的z-index 太低，会被我们的 UI 挡住。
 * 所以自己造轮子，把弹窗挂在我们的容器里。
 * 
 * @param {Object} options 弹窗选项
 * @param {HTMLElement} container 弹窗挂载容器（通常是 this.element）
 * @returns {Promise<boolean>} 用户选择
 */
export function showConfirmDialog(options, container) {
    return new Promise((resolve) => {
        const {
            title = game.i18n.localize("ORIGINATE.UI.Dialog.ConfirmContinue"),
            content = "",
            yesLabel = game.i18n.localize("ORIGINATE.UI.Button.Confirm") || "是",
            noLabel = game.i18n.localize("ORIGINATE.UI.Button.Cancel") || "否",
            defaultYes = false
        } = options;

        const dialogOverlay = document.createElement('div');
        dialogOverlay.className = 'originate-confirm-dialog-overlay';

        dialogOverlay.innerHTML = `
            <div class="originate-confirm-dialog">
                <div class="confirm-dialog-header">
                    <h3>${title}</h3>
                    <button type="button" class="confirm-dialog-close"><i class="fas fa-times"></i></button>
                </div>
                <div class="confirm-dialog-content">
                    ${content}
                </div>
                <div class="confirm-dialog-footer">
                    <button type="button" class="confirm-dialog-btn btn-yes ${defaultYes ? 'default' : ''}">
                        <i class="fas fa-check"></i> ${yesLabel}
                    </button>
                    <button type="button" class="confirm-dialog-btn btn-no ${!defaultYes ? 'default' : ''}">
                        <i class="fas fa-times"></i> ${noLabel}
                    </button>
                </div>
            </div>
        `;

        const mountTo = container || document.body;
        mountTo.appendChild(dialogOverlay);

        const closeDialog = (result) => {
            dialogOverlay.remove();
            resolve(result);
        };

        dialogOverlay.querySelector('.confirm-dialog-close').addEventListener('click', () => closeDialog(false));
        dialogOverlay.querySelector('.btn-yes').addEventListener('click', () => closeDialog(true));
        dialogOverlay.querySelector('.btn-no').addEventListener('click', () => closeDialog(false));

        dialogOverlay.addEventListener('click', (e) => {
            if (e.target === dialogOverlay) closeDialog(false);
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                closeDialog(false);
            }
        };
        document.addEventListener('keydown', escHandler);
    });
}


/**
 * 更新 tooltip 位置（带边界检查）
 * @param {MouseEvent} e 鼠标事件
 * @param {HTMLElement} tooltip tooltip 元素
 */
export function updateTooltipPosition(e, tooltip) {
    const x = e.pageX + 15;
    const rect = tooltip.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    let finalX = x;
    let finalY = e.pageY + 10;
    if (finalX + rect.width > winWidth - 10) finalX = winWidth - rect.width - 10;
    if (finalX < 10) finalX = 10;
    if (finalY + rect.height > winHeight - 10) finalY = winHeight - rect.height - 10;
    if (finalY < 10) finalY = 10;
    tooltip.style.left = `${finalX}px`;
    tooltip.style.top = `${finalY}px`;
}

/**
 * 绑定 tooltip 事件
 * 
 * 统一使用 TextEditor.enrichHTML 渲染富文本。
 * 比纯文本版好看多了。
 * 
 * @param {HTMLElement} container 要绑定 tooltip 的容器
 * @param {Object} dataManager DataManager 实例（用于 getDocument）
 */
export function bindTooltips(container, dataManager) {
    document.querySelectorAll('.originate-spell-tooltip, .originate-nested-tooltip').forEach(el => el.remove());

    const tooltip = document.createElement('div');
    tooltip.className = 'originate-spell-tooltip';
    tooltip.dataset.pinned = 'false';
    Object.assign(tooltip.style, {
        position: 'fixed',
        display: 'none',
        maxWidth: '450px',
        minWidth: '250px',
        width: 'auto',
        overflowY: 'auto',
        padding: '12px 14px',
        background: 'linear-gradient(135deg, rgba(20,18,15,0.97), rgba(35,30,25,0.97))',
        border: '1px solid rgba(200,163,95,0.4)',
        borderRadius: '6px',
        color: '#e8dcc8',
        fontSize: '0.85rem',
        lineHeight: '1.6',
        zIndex: '100000',
        pointerEvents: 'auto',
        boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)'
    });
    document.body.appendChild(tooltip);

    let hideTimer = null;
    let currentSourceEl = null;
    let nestedToken = 0;

    const isPinned = () => tooltip.dataset.pinned === 'true';

    const setPinned = (value) => {
        tooltip.dataset.pinned = value ? 'true' : 'false';
        tooltip.classList.toggle('is-pinned', !!value);
        if (value) {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = null;
        }
    };

    const cancelHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
    };

    const hideNestedTooltip = () => {
        nestedToken++;
        document.querySelectorAll('.originate-nested-tooltip').forEach(el => el.remove());
    };

    const hideTooltip = ({ force = false } = {}) => {
        if (!force && isPinned()) return;
        cancelHide();
        hideNestedTooltip();
        tooltip.style.display = 'none';
        currentSourceEl = null;
        setPinned(false);
    };

    const scheduleHide = () => {
        cancelHide();
        if (isPinned()) return;
        hideTimer = setTimeout(() => {
            if (tooltip.matches(':hover')) return;
            if (currentSourceEl?.matches(':hover')) return;
            hideTooltip({ force: true });
        }, 220);
    };

    tooltip.addEventListener('wheel', (e) => {
        const hasOverflow = tooltip.scrollHeight > tooltip.clientHeight;
        if (!hasOverflow) return;
        const atTop = tooltip.scrollTop <= 0 && e.deltaY < 0;
        const atBottom = (tooltip.scrollTop + tooltip.clientHeight >= tooltip.scrollHeight - 1) && e.deltaY > 0;
        if (atTop || atBottom) return;
        e.preventDefault();
        e.stopPropagation();
        tooltip.scrollTop += e.deltaY;
    }, { passive: false });

    tooltip.addEventListener('mouseenter', cancelHide);
    tooltip.addEventListener('mouseleave', scheduleHide);
    tooltip.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        setPinned(!isPinned());
        if (!isPinned()) scheduleHide();
    });

    const positionTooltip = (card) => {
        tooltip.style.maxHeight = 'none';
        tooltip.scrollTop = 0;
        const rect = card.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        let left = rect.right + 12;
        let top = rect.top;
        if (left + tooltipRect.width > window.innerWidth - 10) left = rect.left - tooltipRect.width - 12;
        if (left < 10) left = Math.max(10, (window.innerWidth - tooltipRect.width) / 2);
        const availableDown = window.innerHeight - top - 10;
        const availableUp = top - 10;
        if (tooltipRect.height > availableDown) {
            if (tooltipRect.height <= availableUp) top = top - tooltipRect.height;
            else if (availableDown >= availableUp) tooltip.style.maxHeight = `${availableDown}px`;
            else {
                top = 10;
                tooltip.style.maxHeight = `${availableUp}px`;
            }
        }
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    };

    const showNestedTooltip = async (link) => {
        if (!isPinned()) return;
        const uuid = link?.dataset?.uuid;
        if (!uuid) return;

        const token = ++nestedToken;
        document.querySelectorAll('.originate-nested-tooltip').forEach(el => el.remove());

        let doc = null;
        try {
            doc = dataManager ? await dataManager.getDocument(uuid) : await fromUuid(uuid);
        } catch {
            doc = null;
        }
        if (!doc || token !== nestedToken || !isPinned() || !link.matches(':hover')) return;

        let description = doc.system?.description?.value
            ?? doc.text?.content
            ?? doc.content
            ?? doc.description
            ?? '';
        if (description && typeof description === 'object') description = description.value || '';

        try {
            const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
            description = await TE.enrichHTML(String(description || ''), { async: true, relativeTo: doc });
        } catch {
            description = String(description || '');
        }

        if (token !== nestedToken || !isPinned()) return;

        const nested = document.createElement('div');
        nested.className = 'originate-nested-tooltip';
        nested.innerHTML = `
            <div class="originate-nested-tooltip-title">${doc.name || link.textContent?.trim() || ''}</div>
            <div class="originate-nested-tooltip-body">${description || game.i18n.localize('ORIGINATE.UI.Details.NoDescription')}</div>
        `;
        nested.querySelectorAll('[data-tooltip]').forEach(el => el.removeAttribute('data-tooltip'));
        document.body.appendChild(nested);

        const rect = link.getBoundingClientRect();
        const nestedRect = nested.getBoundingClientRect();
        const margin = 10;
        let left = rect.right + margin;
        if (left + nestedRect.width > window.innerWidth - margin) {
            left = Math.max(margin, rect.left - nestedRect.width - margin);
        }
        let top = rect.top;
        if (top + nestedRect.height > window.innerHeight - margin) {
            top = Math.max(margin, window.innerHeight - nestedRect.height - margin);
        }
        nested.style.left = `${Math.round(left)}px`;
        nested.style.top = `${Math.round(top)}px`;
    };

    const openLinkedDocument = async (link) => {
        if (!isPinned()) return;
        const uuid = link?.dataset?.uuid;
        if (!uuid) return;
        try {
            const doc = dataManager ? await dataManager.getDocument(uuid) : await fromUuid(uuid);
            if (!doc?.sheet) return;
            const result = doc.sheet.render(true);
            if (result?.then instanceof Function) await result;
            requestAnimationFrame(() => {
                doc.sheet.bringToFront?.();
                const element = doc.sheet.element instanceof HTMLElement ? doc.sheet.element : doc.sheet.element?.[0];
                if (element) element.style.setProperty('z-index', '100060', 'important');
            });
        } catch (error) {
            console.warn('Character Forge | Не удалось открыть ссылку из закреплённой подсказки:', error);
        }
    };

    tooltip.addEventListener('pointerover', (event) => {
        const link = event.target?.closest?.('.cf-tooltip-link[data-uuid], .content-link[data-uuid]');
        if (!link || !tooltip.contains(link)) return;
        if (event.relatedTarget && link.contains(event.relatedTarget)) return;
        link.removeAttribute('data-tooltip');
        event.stopPropagation();
        void showNestedTooltip(link);
    }, true);

    tooltip.addEventListener('pointerout', (event) => {
        const link = event.target?.closest?.('.cf-tooltip-link[data-uuid], .content-link[data-uuid]');
        if (!link || !tooltip.contains(link)) return;
        if (event.relatedTarget && link.contains(event.relatedTarget)) return;
        hideNestedTooltip();
    }, true);

    tooltip.addEventListener('click', (event) => {
        const link = event.target?.closest?.('.cf-tooltip-link[data-uuid], .content-link[data-uuid]');
        if (!link || !tooltip.contains(link) || !isPinned()) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void openLinkedDocument(link);
    }, true);

    const showTooltip = async (el) => {
        cancelHide();
        if (isPinned() && currentSourceEl !== el) return;

        currentSourceEl = el;
        let text = el._enrichedTooltip;
        let itemName = el.querySelector('.feature-name, .feature-title, .spell-name')?.textContent || '';

        if (!text) {
            const plainTooltip = el.dataset.originateTooltip;
            if (plainTooltip && plainTooltip !== 'undefined' && plainTooltip.trim()) {
                text = plainTooltip;
                el._enrichedTooltip = text;
            }
        }

        if (!text && el.dataset.uuid) {
            try {
                tooltip.innerHTML = `<div style="color:#888;"><i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize('ORIGINATE.UI.Loading')}</div>`;
                tooltip.style.display = 'block';
                positionTooltip(el);

                const doc = dataManager
                    ? await dataManager.getDocument(el.dataset.uuid)
                    : await fromUuid(el.dataset.uuid);

                if (currentSourceEl !== el) return;

                const rawDescription = doc?.system?.description?.value
                    ?? doc?.text?.content
                    ?? doc?.content
                    ?? '';
                if (rawDescription) {
                    itemName = doc.name || itemName;
                    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
                    const enriched = await TE.enrichHTML(String(rawDescription), {
                        async: true,
                        relativeTo: doc
                    });
                    el._enrichedTooltip = enriched;
                    el._tooltipName = itemName;
                    text = enriched;
                } else {
                    hideTooltip({ force: true });
                    return;
                }
            } catch {
                hideTooltip({ force: true });
                return;
            }
        }

        if (!text) {
            const rawHtmlTooltip = el.dataset.originateTooltipHtml;
            if (rawHtmlTooltip && rawHtmlTooltip !== 'undefined' && rawHtmlTooltip.trim()) {
                const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
                text = await TE.enrichHTML(rawHtmlTooltip, { async: true });
                el._enrichedTooltip = text;
            }
        }

        if (currentSourceEl !== el) return;
        if (!text || text === 'undefined' || !String(text).trim()) {
            hideTooltip({ force: true });
            return;
        }

        itemName = el._tooltipName || itemName;
        tooltip.innerHTML = `
            <div class="originate-tooltip-header">
                <div class="originate-tooltip-title">${itemName}</div>
                <i class="fas fa-thumbtack originate-tooltip-pin-indicator" aria-hidden="true"></i>
            </div>
            <div class="originate-tooltip-content">${text}</div>
        `;

        tooltip.querySelectorAll('[data-tooltip]').forEach(node => node.removeAttribute('data-tooltip'));
        tooltip.querySelectorAll('.content-link').forEach(node => {
            node.removeAttribute('data-tooltip');
            node.removeAttribute('data-tooltip-direction');
            node.classList.remove('content-link');
            node.classList.add('cf-tooltip-link');
            node.style.pointerEvents = 'auto';
            node.style.cursor = 'pointer';
        });

        tooltip.style.display = 'block';
        positionTooltip(el);
    };

    container.querySelectorAll('[data-originate-tooltip], [data-originate-tooltip-html], [data-uuid]').forEach(el => {
        if (el.classList.contains('subclass-anchor-unit')) return;

        el.removeEventListener('pointerenter', el._tooltipEnter);
        el.removeEventListener('pointerleave', el._tooltipLeave);
        el.removeEventListener('auxclick', el._tooltipAuxClick);

        el._tooltipEnter = () => {
            if (!isPinned()) void showTooltip(el);
        };
        el._tooltipLeave = () => scheduleHide();
        el._tooltipAuxClick = async (event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();

            if (isPinned() && currentSourceEl === el) {
                setPinned(false);
                scheduleHide();
                return;
            }

            if (isPinned()) hideTooltip({ force: true });
            await showTooltip(el);
            if (currentSourceEl === el && tooltip.style.display !== 'none') setPinned(true);
        };

        el.addEventListener('pointerenter', el._tooltipEnter);
        el.addEventListener('pointerleave', el._tooltipLeave);
        el.addEventListener('auxclick', el._tooltipAuxClick);
    });
}

/**
 * 生成法术卡片 HTML
 * @param {Array} spells 法术列表
 * @returns {string} HTML 字符串
 */
export function generateSpellCards(spells) {
    if (!spells || spells.length === 0) {
        return `<div class="no-results">${game.i18n.localize('ORIGINATE.UI.NoResults')}</div>`;
    }

    return spells.map(spell => {
        let classTagsHtml = '';
        if (spell.sourceClass) {
            const classes = spell.sourceClass.split(/[,;|\/]/).map(c => c.trim()).filter(c => c);
            if (classes.length > 0) {
                classTagsHtml = `<div class="spell-class-tags">
                    ${classes.map(c => {
                    const classConfig = CONFIG.DND5E.classFeatures?.[c.toLowerCase()] || CONFIG.DND5E.spellLists?.[c.toLowerCase()];
                    const label = classConfig?.label || (c.charAt(0).toUpperCase() + c.slice(1));
                    return `<span class="spell-class-tag">${label}</span>`;
                }).join('')}
                </div>`;
            }
        }

        return `
        <div class="spell-card" data-uuid="${spell.uuid}" draggable="true">
            <img src="${spell.img}" class="spell-icon">
            <div class="spell-info">
                <div class="spell-name" title="${spell.name}">${spell.name}</div>
                <div class="spell-meta">
                    ${CONFIG.DND5E.spellLevels[spell.level] || ''} &bull; ${CONFIG.DND5E.spellSchools[spell.school]?.label || ''}
                </div>
                ${classTagsHtml}
            </div>
            <div class="add-icon"><i class="fas fa-plus-circle"></i></div>
        </div>
    `}).join('');
}

function escapeSubclassText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function getSubclassOptionKey(option = {}) {
    return String(option.uuid || option.id || '');
}

/**
 * 生成子职选择卡片 HTML
 *
 * 两个升级入口共用卡片和详情抽屉，选中结果仍交给各自宿主保存。
 *
 * @param {Array} options 子职选项数组 [{ id, uuid, img, name, description }]
 * @param {Object} config 渲染配置
 * @param {string|null} config.selectedUuid 已选子职 UUID
 * @returns {string} 卡片区域 HTML（不含 header/footer）
 */
export function renderSubclassCards(options, { selectedUuid = null } = {}) {
    if (!options || options.length === 0) {
        return `<p style="color: #888; text-align: center; width: 100%;">${game.i18n.localize('ORIGINATE.UI.Progression.NoSubclassAvailable')}</p>`;
    }

    const selectedKey = String(selectedUuid || '');
    return options.map(opt => {
        const isSelected = !!selectedKey && (selectedKey === String(opt.uuid || '') || selectedKey === String(opt.id || ''));
        return `
        <div class="subclass-anchor-unit${isSelected ? ' selected' : ''}"
            data-id="${escapeSubclassText(opt.id)}" data-uuid="${escapeSubclassText(opt.uuid)}"
            role="button" tabindex="0" aria-pressed="${isSelected}">
            <div class="subclass-image-wrapper">
                <img src="${escapeSubclassText(opt.img || 'icons/svg/mystery-man.svg')}" class="subclass-standing-art" alt="${escapeSubclassText(opt.name)}">
                <div class="subclass-info-caption">
                    <h3 class="subclass-name">${escapeSubclassText(opt.name)}</h3>
                    <div class="subclass-tagline">${escapeSubclassText(getFullCleanDescription(opt.description))}</div>
                </div>
            </div>
        </div>
    `;
    }).join('');
}

/**
 * 子职选择区连同左侧详情抽屉。外层流程只需要补自己的 header 和 footer。
 */
export function renderSubclassSelectionPanel(options, { selectedUuid = null } = {}) {
    const detailsLabel = escapeSubclassText(game.i18n.localize('ORIGINATE.UI.Details.Toggle'));

    return `
        <div class="subclass-selection-container" id="progression-subclass-content">
            <div class="subclass-cards-wrapper">
                ${renderSubclassCards(options, { selectedUuid })}
            </div>
            <aside class="subclass-detail-drawer collapsed hidden" data-subclass-detail-drawer aria-hidden="true">
                <button type="button" class="subclass-detail-handle" data-subclass-detail-toggle
                    aria-expanded="false" title="${detailsLabel}">
                    <i class="fas fa-info-circle"></i>
                    <span>${detailsLabel}</span>
                    <i class="fas fa-chevron-left subclass-detail-toggle-icon"></i>
                </button>
                <div class="subclass-detail-content drawer-content" data-subclass-detail-content aria-hidden="true"></div>
            </aside>
        </div>
    `;
}

/**
 * 绑定卡片、键盘选择和抽屉。这里只管展示，宿主通过 onSelect 保存自己的草稿。
 */
export function bindSubclassSelectionPanel(root, options, { selectedUuid = null, onSelect = null } = {}) {
    const panel = root?.querySelector?.('#progression-subclass-content');
    const drawer = panel?.querySelector?.('[data-subclass-detail-drawer]');
    const content = drawer?.querySelector?.('[data-subclass-detail-content]');
    const toggle = drawer?.querySelector?.('[data-subclass-detail-toggle]');
    if (!panel || !drawer || !content || !toggle) return null;

    const optionByKey = new Map();
    for (const option of options || []) {
        if (option?.uuid) optionByKey.set(String(option.uuid), option);
        if (option?.id) optionByKey.set(String(option.id), option);
    }

    const cards = Array.from(panel.querySelectorAll('.subclass-anchor-unit'));
    let currentKey = '';

    const syncDrawerState = () => {
        const expanded = !drawer.classList.contains('collapsed');
        toggle.setAttribute('aria-expanded', String(expanded));
        content.setAttribute('aria-hidden', String(!expanded));
    };

    const showDetails = (option, { expand = false } = {}) => {
        if (!option) return;

        const nextKey = getSubclassOptionKey(option);
        const isSwitching = !!currentKey && currentKey !== nextKey && !drawer.classList.contains('collapsed');
        currentKey = nextKey;

        content.innerHTML = `
            <h2 class="subclass-detail-title drawer-title">${escapeSubclassText(option.name)}</h2>
            <div class="subclass-detail-body drawer-body">${option.description || ''}</div>
        `;
        drawer.classList.remove('hidden');
        drawer.setAttribute('aria-hidden', 'false');
        if (expand) drawer.classList.remove('collapsed');

        drawer.classList.remove('switching');
        if (isSwitching) {
            void drawer.offsetWidth;
            drawer.classList.add('switching');
        }
        syncDrawerState();
    };

    const selectCard = (card, { notify = true, expand = false } = {}) => {
        if (!card) return null;
        const option = optionByKey.get(card.dataset.uuid) || optionByKey.get(card.dataset.id);
        if (!option) return null;

        for (const otherCard of cards) {
            const selected = otherCard === card;
            otherCard.classList.toggle('selected', selected);
            otherCard.setAttribute('aria-pressed', String(selected));
        }

        // 选中只露出详情操作柄；玩家主动展开后，切换子职才保持当前展开状态。
        showDetails(option, { expand });
        if (notify && typeof onSelect === 'function') onSelect(option, card);
        return option;
    };

    toggle.addEventListener('click', () => {
        drawer.classList.toggle('collapsed');
        drawer.classList.remove('switching');
        syncDrawerState();
    });

    for (const card of cards) {
        card.addEventListener('click', () => selectCard(card));
        card.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectCard(card);
        });
    }

    const selectedKey = String(selectedUuid || '');
    const selectedCard = cards.find(card =>
        card.classList.contains('selected')
        || (!!selectedKey && (card.dataset.uuid === selectedKey || card.dataset.id === selectedKey))
    );
    if (selectedCard) selectCard(selectedCard, { notify: false, expand: false });

    syncDrawerState();
    return { selectCard };
}
