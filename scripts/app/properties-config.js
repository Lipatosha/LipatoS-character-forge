import { applyWindowScaling, cleanupWindowScaling } from "../utils/scaling-helper.js";
import {
    normalizeStandardArrayScores,
    parseStandardArrayScores
} from "../shared/ability-score-methods.js";

export class PropertiesConfigApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "originate-properties-config",
            title: game.i18n.localize("ORIGINATE.Properties.Title"),
            template: "modules/character-forge/templates/properties-config.hbs",
            width: 1700,
            height: 1000,
            resizable: true,
            classes: ["originate-properties-config", "originate-aspects-config"] // Reuse aspects styles for consistency
        });
    }

    getData() {
        const standardArrayScores = normalizeStandardArrayScores(
            game.settings.get('character-forge', 'standardArrayScores')
        );

        return {
            abilityMode: game.settings.get('character-forge', 'abilityMode'),
            abilityModes: {
                "free": "ORIGINATE.Settings.AbilityMode.Free",
                "pointbuy": "ORIGINATE.Settings.AbilityMode.PointBuy",
                "roll": "ORIGINATE.Settings.AbilityMode.Roll",
                "standardArray": "ORIGINATE.Settings.AbilityMode.StandardArray"
            },
            abilityStepPosition: game.settings.get('character-forge', 'abilityStepPosition') || 'late',
            abilityStepPositions: {
                "early": "ORIGINATE.Settings.AbilityStepPosition.Early",
                "late": "ORIGINATE.Settings.AbilityStepPosition.Late"
            },
            standardArrayInputs: standardArrayScores.map((value, index) => ({
                field: `standardArrayScore${index}`,
                value
            })),
            pointBuyTotal: game.settings.get('character-forge', 'pointBuyTotal'),
            pointBuyMaxScore: game.settings.get('character-forge', 'pointBuyMaxScore'),
            rollFormula: game.settings.get('character-forge', 'rollFormula'),
            rollMode: game.settings.get('character-forge', 'rollMode'),
            rollModes: {
                "fixed": "ORIGINATE.Settings.RollMode.Fixed",
                "free": "ORIGINATE.Settings.RollMode.Free"
            },
            rollAttempts: game.settings.get('character-forge', 'rollAttempts'),
            unrestrictedASI: game.settings.get('character-forge', 'unrestrictedASI'),
            baseAbilityScore: game.settings.get('character-forge', 'baseAbilityScore') ?? 8
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        // Handle button clicks for radio-like behavior
        html.find('.config-option-btn').click(ev => {
            const btn = $(ev.currentTarget);
            const value = btn.data('value');
            const name = btn.data('name');

            // Update UI
            btn.siblings().removeClass('active');
            btn.addClass('active');

            // Update hidden input
            html.find(`input[name="${name}"]`).val(value);
        });

        // 窗口自适应缩放
        this._windowScaleObserver = applyWindowScaling(html, 1700, 950);
    }

    async close(options) {
        cleanupWindowScaling(this._windowScaleObserver);
        this._windowScaleObserver = null;
        return super.close(options);
    }

    async _updateObject(event, formData) {
        const scoreFields = Array.from({ length: 6 }, (_, index) => `standardArrayScore${index}`);
        const standardArrayScores = parseStandardArrayScores(scoreFields.map(field => formData[field]));
        if (!standardArrayScores) {
            ui.notifications.warn(game.i18n.localize("ORIGINATE.Settings.StandardArrayScores.Invalid"));
            return;
        }

        for (const field of scoreFields) delete formData[field];
        for (const [key, value] of Object.entries(formData)) {
            await game.settings.set('character-forge', key, value);
        }
        await game.settings.set('character-forge', 'standardArrayScores', standardArrayScores);
        ui.notifications.info(game.i18n.localize("ORIGINATE.Properties.Saved"));
    }
}
