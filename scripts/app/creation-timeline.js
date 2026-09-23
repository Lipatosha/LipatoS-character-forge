import { isCharacterCreationDetailStep } from '../shared/character-creation-settings.js';

const CREATION_CONTEXT_KEYS = [
    'race', 'raceName', 'raceIdentifier',
    'class', 'className', 'classIdentifier',
    'background', 'backgroundName', 'backgroundIdentifier',
    'subclass', 'subclassName', 'subclassIdentifier',
    'abilities', 'pointsRemaining',
    'skills', 'spells', 'feats', 'equipment', 'selections',
    'details', 'deferredASIs', 'deferredAdvancements',
    'characterFinalizeResolution'
];

const WIZARD_CONTEXT_KEYS = [
    'option', 'levelEvents', 'folderFeatures', 'type', 'knowledge',
    'expertiseEvents', '_wizardState'
];

function cloneCreationValue(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (value instanceof Date) return new Date(value);

    if (value instanceof Set) {
        const clone = new Set();
        seen.set(value, clone);
        value.forEach(entry => clone.add(cloneCreationValue(entry, seen)));
        return clone;
    }

    if (value instanceof Map) {
        const clone = new Map();
        seen.set(value, clone);
        value.forEach((entry, key) => {
            clone.set(cloneCreationValue(key, seen), cloneCreationValue(entry, seen));
        });
        return clone;
    }

    // Foundry 给 Set 提供的 toObject 会返回数组；集合必须先于文档序列化处理。
    if (typeof value.toObject === 'function') {
        return cloneCreationValue(value.toObject(), seen);
    }

    const clone = Array.isArray(value) ? [] : {};
    seen.set(value, clone);
    for (const [key, entry] of Object.entries(value)) {
        clone[key] = cloneCreationValue(entry, seen);
    }
    return clone;
}

export class CreationTimeline {
    constructor() {
        this.phase = 'inactive';
        this.history = [];
        this.busy = false;
    }

    get active() {
        return this.phase === 'active';
    }

    get hasBack() {
        return this.active && this.history.length > 0;
    }

    start() {
        this.phase = 'active';
        this.history = [];
    }

    freeze() {
        this.phase = 'frozen';
        this.history = [];
    }

    async forward(checkpoint, transition, restore) {
        if (!this.active) return transition();
        if (this.busy) return false;

        this.busy = true;
        this.history.push(checkpoint);

        try {
            const result = await transition();
            if (result === false && this.active) this._removeCheckpoint(checkpoint);
            return result;
        } catch (error) {
            if (this.active) this._removeCheckpoint(checkpoint);
            await restore(checkpoint);
            throw error;
        } finally {
            this.busy = false;
        }
    }

    async back(restore) {
        if (!this.hasBack || this.busy) return false;

        this.busy = true;
        const checkpoint = this.history.pop();

        try {
            await restore(checkpoint);
            return true;
        } catch (error) {
            this.history.push(checkpoint);
            throw error;
        } finally {
            this.busy = false;
        }
    }

    _removeCheckpoint(checkpoint) {
        const index = this.history.lastIndexOf(checkpoint);
        if (index !== -1) this.history.splice(index, 1);
    }
}

export const CreationTimelineMixin = (Base) => class extends Base {
    constructor(...args) {
        super(...args);
        this._creationTimeline = new CreationTimeline();
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options) || {};
        context.canCreationTimelineBack = !!this._creationTimeline?.hasBack;
        context.isCreationSelectionStep = ['class', 'subclass', 'race', 'background'].includes(this.currentStep);
        return context;
    }

    _beginCreationTimeline() {
        this._creationTimeline.start();
    }

    _freezeCreationTimeline() {
        this._creationTimeline.freeze();
        this.element?.querySelectorAll?.(
            '.creation-timeline-back-btn, .view-selection-root .cinematic-back-btn[data-action="prevStep"]'
        ).forEach(button => button.remove());
    }

    _isCreationWizardContext(context = this._activeSubInterfaceContext) {
        return !!(
            this._creationTimeline?.active
            && context
            && ['class', 'subclass', 'race', 'background'].includes(context.type)
            && typeof context.onComplete !== 'function'
        );
    }

    _syncCurrentCreationPageDraft() {
        const root = this.element;
        if (!root) return;

        if (isCharacterCreationDetailStep(this.currentStep)) {
            root.querySelectorAll('.detail-input').forEach(input => {
                const field = input.dataset.field || input.name;
                if (field) this.context.details[field] = input.value;
            });
        }

        if (this.currentStep === 'abilities') {
            root.querySelectorAll('.ability-value-input').forEach(input => {
                const ability = input.dataset.ability;
                const value = Number.parseInt(input.value, 10);
                if (ability && Number.isFinite(value)) this.context.abilities[ability] = value;
            });
        }

        this._syncLeftDrawerStateFromDom?.();
        const navTrack = root.querySelector('.nav-track');
        if (navTrack) this._scrollPos = navTrack.scrollLeft;
    }

    _captureCreationCheckpoint() {
        const overlay = this.element?.querySelector?.('.originate-sub-interface');
        const wizardContext = overlay?.isConnected && this._isCreationWizardContext()
            ? this._activeSubInterfaceContext
            : null;

        const screen = wizardContext
            ? {
                kind: 'wizard',
                step: wizardContext.type,
                sourceUuid: wizardContext.option?.uuid || null,
                wizardStep: wizardContext._wizardState?.currentStep ?? 0
            }
            : {
                kind: 'main',
                step: this.currentStep,
                folderId: this._currentFolder ?? null,
                scrollPos: this._scrollPos || 0,
                leftDrawerExpanded: !!this._leftDrawerExpanded
            };

        const context = {};
        for (const key of CREATION_CONTEXT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(this.context, key)) {
                context[key] = cloneCreationValue(this.context[key]);
            }
        }

        return {
            screen,
            draft: {
                context,
                blueprintData: cloneCreationValue(this.blueprintData),
                pendingItemData: cloneCreationValue(this._pendingItemData),
                pendingFeatures: cloneCreationValue(this._pendingFeatures),
                rollState: cloneCreationValue(this._rollState),
                asiAllocations: cloneCreationValue(this._asiAllocations),
                wizardContext: wizardContext ? this._serializeCreationWizardContext(wizardContext) : null
            }
        };
    }

    _serializeCreationWizardContext(context) {
        const snapshot = {};
        for (const key of WIZARD_CONTEXT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(context, key)) {
                snapshot[key] = cloneCreationValue(context[key]);
            }
        }
        return snapshot;
    }

    async _restoreCreationCheckpoint(checkpoint, { render = true } = {}) {
        const { screen, draft } = checkpoint;

        for (const key of CREATION_CONTEXT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(draft.context, key)) {
                this.context[key] = cloneCreationValue(draft.context[key]);
            } else {
                delete this.context[key];
            }
        }

        this.blueprintData = cloneCreationValue(draft.blueprintData);
        this._pendingItemData = cloneCreationValue(draft.pendingItemData);
        this._pendingFeatures = cloneCreationValue(draft.pendingFeatures) || [];

        if (draft.rollState === undefined) delete this._rollState;
        else this._rollState = cloneCreationValue(draft.rollState);

        if (draft.asiAllocations === undefined) delete this._asiAllocations;
        else this._asiAllocations = cloneCreationValue(draft.asiAllocations);

        this.currentStep = screen.step;
        this._currentFolder = screen.kind === 'main' ? screen.folderId : null;
        this._scrollPos = screen.kind === 'main' ? screen.scrollPos : 0;
        this._leftDrawerExpanded = screen.kind === 'main' && !!screen.leftDrawerExpanded;
        this._leftDrawerSwitching = false;
        this._gridSelectorKeepOpen = false;
        this._activeSubInterfaceContext = null;

        this.element?.querySelector?.('.originate-sub-interface')?.remove();
        globalThis.document?.querySelector('.originate-tooltip')?.remove();
        globalThis.document?.querySelector('.originate-spell-tooltip')?.remove();

        if (!render) return;

        await this.render();
        if (screen.kind === 'wizard' && draft.wizardContext) {
            const restoredContext = cloneCreationValue(draft.wizardContext);
            restoredContext._wizardState.currentStep = screen.wizardStep;
            await this._renderFullSubInterface(restoredContext);
        }
    }

    async _runCreationTimelineForward(transition) {
        if (!this._creationTimeline?.active) return transition();
        if (this._creationTimeline.busy) return false;
        const checkpoint = this._captureCreationCheckpoint();
        return this._creationTimeline.forward(
            checkpoint,
            transition,
            failedCheckpoint => this._restoreCreationCheckpoint(failedCheckpoint)
        );
    }

    async _goBackCreationTimeline() {
        if (!this._creationTimeline?.hasBack || this._creationTimeline.busy) return false;
        this._playSound?.('PAGE_FLIP');
        return this._creationTimeline.back(checkpoint => this._restoreCreationCheckpoint(checkpoint));
    }
};
