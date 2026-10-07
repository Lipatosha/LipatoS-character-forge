function escapeHTML(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function restoreUnresolvedFoundryLinks(html) {
    if (!html) return '';

    const makeLink = (uuid, label) => {
        const safeUuid = escapeHTML(uuid);
        const fallbackLabel = String(uuid || '').split('.').pop() || 'Ссылка';
        const safeLabel = escapeHTML(label || fallbackLabel);
        return '<a class="content-link cf-subclass-link" data-uuid="' + safeUuid
            + '" draggable="true"><i class="fas fa-suitcase"></i>' + safeLabel + '</a>';
    };

    let result = String(html);
    result = result.replace(
        /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g,
        (_match, uuid, label) => makeLink(uuid, label)
    );
    result = result.replace(
        /@Compendium\[([^\]]+)\](?:\{([^}]*)\})?/g,
        (_match, uuid, label) => makeLink(
            String(uuid).startsWith('Compendium.') ? uuid : 'Compendium.' + uuid,
            label
        )
    );
    return result;
}

export async function prepareSubclassOptions(options, dataManager) {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;

    return Promise.all((options || []).map(async option => {
        let doc = null;
        try {
            doc = option?.uuid
                ? (dataManager ? await dataManager.getDocument(option.uuid) : await fromUuid(option.uuid))
                : null;
        } catch {
            doc = null;
        }

        const rawDescription = String(
            doc?.system?.description?.value
            ?? option?.description
            ?? ''
        );
        if (!rawDescription) return { ...option, description: '' };

        let description = rawDescription;
        if (TE?.enrichHTML) {
            try {
                description = await TE.enrichHTML(rawDescription, {
                    async: true,
                    relativeTo: doc || undefined
                });
            } catch (error) {
                console.warn(
                    'Character Forge | Не удалось обработать описание подкласса "' +
                    (option?.name || option?.uuid || '') + '":',
                    error
                );
            }
        }

        // Для всех подклассов убираем остаточный технический @UUID/@Compendium
        // даже если Foundry не смог разрешить старую или стороннюю ссылку.
        description = restoreUnresolvedFoundryLinks(description);
        return { ...option, description };
    }));
}
