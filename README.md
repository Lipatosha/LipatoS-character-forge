# Character Forge

Private optimized Foundry VTT character creation and level-up module.

## Target

- Foundry VTT 14
- D&D 5e 6.0.x (manifest target: 6.0.5)
- Module id: `character-forge`

## Performance work in 0.1.0

- A single shared `DataManager` is reused by character creation and level-up flows.
- Compendium indexing has an in-flight guard and bounded parallel loading.
- Item type/UUID indexes and option caches avoid rescanning every pack on each step.
- Full document loads are bounded and parallelized where safe.
- Description enrichment is lazy instead of running for every list entry.
- Spell search uses the pre-built spell bucket rather than every indexed item.
- Spell-list journal loading has an in-flight guard and bounded parallel document reads.
- The window resize listener leak is fixed.
- Decorative always-running animations are disabled during the wizard and full-screen blur is reduced.
- Page transition delay reduced from 300 ms to 120 ms.
- Missing smoke-test entry point restored.
- Legacy Originate settings are migrated into the `character-forge` namespace when possible.

## Important

Do not enable Originate and Character Forge at the same time. This build keeps selected legacy flags/internal class names for compatibility with characters previously created by Originate.

Static checks pass, but this build still requires an in-Foundry play test before calling it production-stable.
