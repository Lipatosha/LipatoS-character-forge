# Changelog

## 0.1.0 — 2026-09-23

- Renamed runtime module to Character Forge (`character-forge`).
- Added legacy Originate settings migration.
- Shared one DataManager across creation and level-up.
- Added index/type/UUID/option caches and guarded concurrent loading.
- Parallelized safe compendium and journal reads with bounded concurrency.
- Made description enrichment lazy.
- Optimized spell search to a spell-only index.
- Fixed accumulating window resize listeners.
- Reduced page transition delay and expensive always-on visual effects.
- Restored the missing test runner entry point.
- Removed duplicate action declarations.
- Updated manifest target to Foundry VTT 14 / D&D5e 6.0.5.
