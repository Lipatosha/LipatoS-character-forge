# Character Forge — Originate 2.7.2 static audit

The supplied build contained at least 19 concrete defects or high-risk implementation points. Eleven can directly contribute to lag/stalls, five are architecture/maintenance risks, and three are functional/compatibility defects.

## Performance / responsiveness

1. Character creation instantiated a new DataManager instead of reusing the preloaded global manager.
2. Level-up instantiated another DataManager, duplicating the same caches/index work.
3. Compendium index loading had no shared in-flight promise, allowing duplicate concurrent indexing.
4. Compendium indexes were loaded sequentially.
5. `getOptions()` scanned every indexed entry in every configured pack on repeated calls.
6. Full item documents were loaded serially for many option lists.
7. Every option description was passed through async `TextEditor.enrichHTML`, even when never selected.
8. Selection/navigation paths could fetch the same option collection again immediately during render.
9. Spell-list journal discovery could rescan/load many Journal documents and had no in-flight guard.
10. Spell filtering walked all indexed items on each search operation rather than a spell-only index.
11. Every application render attached a new `window.resize` handler; only the last reference was removed, producing an accumulating listener leak.
12. Page changes contained a deliberate 300 ms delay.
13. The UI uses multiple full-screen 30–40 px blurs plus infinite glow/particle/card animations, creating avoidable GPU/compositor load.

## Architecture / maintenance

14. Character-creation, progression and level-up behavior is spread across several multi-thousand-line mixins/files with overlapping responsibilities.
15. Source-pack data is treated as a flat array in the data layer but as per-step keyed data in one navigation path.
16. Runtime settings/asset paths were hard-coded to the old module id in many places.
17. The action table contained duplicate keys (`nextStep`, `incrementAbility`), masking earlier declarations.

## Functional / compatibility

18. `main.js` dynamically imported `./tests/index.js`, but that file did not exist in the archive.
19. The supplied manifest was verified against D&D5e 5.3.0 rather than the requested 6.0.5 target, so 6.x compatibility was not declared or assured.

## What 0.1.0 changes

The first Character Forge build fixes the hot-path indexing/cache/listener problems above, moves the runtime namespace to `character-forge`, migrates legacy settings when available, adds the missing test entry point, and applies a conservative performance profile to the visual effects.

This is a static code audit. Actual frame time, compendium load time and end-to-end creation/level-up behavior must still be measured inside the user's Foundry world with the real module set and compendiums.
