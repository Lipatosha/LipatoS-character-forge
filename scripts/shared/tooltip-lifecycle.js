let installed = false;
let pointerFrame = 0;

function hideTooltip(tooltip, { remove = false } = {}) {
    if (!tooltip) return;
    tooltip.dataset.pinned = 'false';
    tooltip.classList.remove('is-pinned');
    tooltip.style.pointerEvents = 'none';
    tooltip.style.display = 'none';
    document.querySelectorAll('.originate-nested-tooltip').forEach(el => el.remove());
    if (remove) tooltip.remove();
}

function getOwner(tooltip) {
    const ownerId = tooltip?.dataset?.characterForgeTooltipOwner;
    if (!ownerId) return null;
    try {
        return document.querySelector('[data-character-forge-tooltip-owner="' + CSS.escape(ownerId) + '"]');
    } catch {
        return null;
    }
}

function pruneOrphans() {
    document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => {
        const ownerId = tooltip.dataset.characterForgeTooltipOwner;
        if (!ownerId) return;
        const owner = getOwner(tooltip);
        if (!owner?.isConnected) hideTooltip(tooltip, { remove: true });
    });

    if (!document.querySelector('.originate-spell-tooltip[style*="display: block"]')) {
        document.querySelectorAll('.originate-nested-tooltip').forEach(el => el.remove());
    }
}

function sourceIsHovered(owner) {
    if (!owner?.isConnected) return false;
    try {
        return !!owner.querySelector(
            '[data-originate-tooltip]:hover, [data-originate-tooltip-html]:hover, [data-uuid]:hover'
        );
    } catch {
        return false;
    }
}

function closeUnpinnedWithoutSource() {
    pruneOrphans();

    document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => {
        if (tooltip.style.display === 'none') return;
        if (tooltip.dataset.pinned === 'true') return;

        const owner = getOwner(tooltip);
        if (!owner || !sourceIsHovered(owner)) hideTooltip(tooltip);
    });
}

export function closeAllForgeTooltips({ remove = false } = {}) {
    document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => {
        hideTooltip(tooltip, { remove });
    });
    document.querySelectorAll('.originate-nested-tooltip').forEach(el => el.remove());
}

export function installForgeTooltipLifecycle() {
    if (installed) return;
    installed = true;

    document.addEventListener('pointermove', () => {
        if (pointerFrame) return;
        pointerFrame = requestAnimationFrame(() => {
            pointerFrame = 0;
            closeUnpinnedWithoutSource();
        });
    }, { passive: true, capture: true });

    document.addEventListener('pointerdown', event => {
        pruneOrphans();
        document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => {
            if (tooltip.style.display === 'none') return;
            if (tooltip.contains(event.target)) return;

            const owner = getOwner(tooltip);
            const clickedSource = owner?.contains(event.target)
                && event.target.closest?.('[data-originate-tooltip], [data-originate-tooltip-html], [data-uuid]');
            if (clickedSource) return;

            // Даже закреплённая подсказка закрывается обычным кликом вне неё.
            // Так она не может остаться висеть поверх следующего экрана.
            hideTooltip(tooltip);
        });
    }, true);

    document.addEventListener('scroll', () => {
        pruneOrphans();
        document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => {
            if (tooltip.dataset.pinned !== 'true') hideTooltip(tooltip);
        });
    }, true);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeAllForgeTooltips();
    }, true);

    window.addEventListener('blur', () => closeAllForgeTooltips());

    const observer = new MutationObserver(() => pruneOrphans());
    observer.observe(document.body, { childList: true, subtree: true });
}
