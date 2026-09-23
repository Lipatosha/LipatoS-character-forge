export function createTestRunner() {
    return {
        async run(suite = null, options = {}) {
            const module = game.modules.get('character-forge');
            const dataManager = module?.api?.dataManager;
            const checks = [];
            const add = (name, ok, details = null) => checks.push({ name, ok: !!ok, details });

            add('module-active', !!module?.active, module?.version || null);
            add('dnd5e-system', game.system?.id === 'dnd5e', game.system?.version || null);
            add('shared-data-manager', !!dataManager, dataManager?.constructor?.name || null);

            if (!suite || suite === 'index' || suite === 'smoke') {
                try {
                    await dataManager?.loadSourcePacksIndex();
                    add('source-index', !!dataManager?._indexLoaded, {
                        packs: dataManager?._indexCache?.size || 0,
                        types: dataManager?._typeIndex?.size || 0
                    });
                } catch (error) {
                    add('source-index', false, error?.message || String(error));
                }
            }

            const failed = checks.filter(check => !check.ok);
            const result = { ok: failed.length === 0, suite: suite || 'smoke', checks };
            const logger = result.ok ? console.info : console.warn;
            logger('Character Forge | Test result', result);
            if (options.notify !== false) {
                const message = result.ok
                    ? `Character Forge: ${checks.length} checks passed`
                    : `Character Forge: ${failed.length}/${checks.length} checks failed`;
                (result.ok ? ui.notifications.info : ui.notifications.warn)(message);
            }
            return result;
        }
    };
}
