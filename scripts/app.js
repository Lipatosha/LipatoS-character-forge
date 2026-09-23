import { DataManager } from './data-manager-v2.js';
import { ContextMixin } from './app/context-mixin.js';
import { CreationTimelineMixin } from './app/creation-timeline.js';
import { NavigationMixin } from './app/navigation-mixin.js';
import { SelectionMixin } from './app/selection-mixin.js';
import { LevelMixin } from './app/level-mixin.js';
import { AbilitiesMixin } from './app/abilities-mixin.js';
import { ProgressionMixin } from './app/progression-mixin.js';
import { UIMixin } from './app/ui-mixin.js';
import { DetailsMixin } from './app/details-mixin.js';
import { isCharacterCreationDetailStep } from './shared/character-creation-settings.js';
import { getThemeClassList } from './theme-registry.js';
import { releaseForgeStyles } from './runtime-style.js';
import {
    bindButtonSounds,
    CHARACTER_CREATION_SOUND_SELECTORS,
    playOriginateSound
} from './shared/ui-sounds.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CHARACTER_FORGE_DRAFT_FLAG = 'wizardState';

function encodeDraftValue(value, seen = new WeakSet()) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;

    if (value instanceof Date) {
        return { __characterForgeType: 'Date', value: value.toISOString() };
    }

    if (value instanceof Set) {
        return {
            __characterForgeType: 'Set',
            value: Array.from(value, entry => encodeDraftValue(entry, seen))
        };
    }

    if (value instanceof Map) {
        return {
            __characterForgeType: 'Map',
            value: Array.from(value.entries(), ([key, entry]) => [
                encodeDraftValue(key, seen),
                encodeDraftValue(entry, seen)
            ])
        };
    }

    if (typeof value.toObject === 'function') {
        try {
            return encodeDraftValue(value.toObject(), seen);
        } catch {
            return null;
        }
    }

    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
        const result = value.map(entry => encodeDraftValue(entry, seen));
        seen.delete(value);
        return result;
    }

    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'function' || entry === undefined) continue;
        result[key] = encodeDraftValue(entry, seen);
    }
    seen.delete(value);
    return result;
}

function decodeDraftValue(value) {
    if (value === null || typeof value !== 'object') return value;

    if (value.__characterForgeType === 'Date') {
        return new Date(value.value);
    }

    if (value.__characterForgeType === 'Set') {
        return new Set((value.value || []).map(decodeDraftValue));
    }

    if (value.__characterForgeType === 'Map') {
        return new Map((value.value || []).map(([key, entry]) => [
            decodeDraftValue(key),
            decodeDraftValue(entry)
        ]));
    }

    if (Array.isArray(value)) return value.map(decodeDraftValue);

    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, decodeDraftValue(entry)])
    );
}

// 这里组合的是创角应用。ProgressionMixin 负责创角内的目标等级展开；
// 现有角色升级使用独立的 LevelUpApp，不在这条 mixin 链里。
const OriginateAppMixin = (Base) =>
    CreationTimelineMixin(
        ContextMixin(
            NavigationMixin(
                SelectionMixin(
                    LevelMixin(
                        DetailsMixin( // Added DetailsMixin here
                            AbilitiesMixin(
                                ProgressionMixin(
                                    UIMixin(Base)
                                )
                            )
                        )
                    )
                )
            )
        )
    );

export class OriginateApp extends HandlebarsApplicationMixin(OriginateAppMixin(ApplicationV2)) {
    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
        this.creationGrantId = options.creationGrantId || actor?.getFlag?.('character-forge', 'creationGrantId') || null;
        this.creationGrantUserId = options.creationGrantUserId || actor?.getFlag?.('character-forge', 'creationUserId') || null;
        this.dataManager = options.dataManager
            || game.modules.get('character-forge')?.api?.dataManager
            || new DataManager();
        this.currentStep = 'welcome'; // 从欢迎界面开始
        this._scrollPos = 0;
        this._currentFolder = null; // 当前浏览的文件夹 ID
        this._leftDrawerExpanded = false;
        this._leftDrawerSwitching = false;
        this._pendingItemData = null; // 待创建的主物品数据，先存着，别弄丢了
        this._pendingFeatures = []; // 待选择的特性列表

        // 角色等级 (默认 1 级)
        this.characterLevel = 1;
        this.isMulticlass = false;
        this.classLevels = {}; // { classId: level }
        this.primaryClass = null;

        // Blueprint Data Storage (按步骤隔离)
        // 这是我们的蓝图，角色的 DNA 都在这儿了
        this.blueprintData = {
            race: { items: [], system: {} },
            class: { items: [], system: {} },
            background: { items: [], system: {} },
            subclass: { items: [], system: {} },
            pendingExpertise: [] // 待处理的专精事件，留到最后再头疼
        };

        // 上下文数据，或者说“当前状态的大杂烩”
        // Adrian: 初始属性值现在可配置了，不再是铁板一块的 8
        const baseScore = (() => {
            try { return game.settings.get('character-forge', 'baseAbilityScore') ?? 8; }
            catch { return 8; }
        })();
        this.context = {
            race: null,
            class: null,
            background: null,
            abilities: {
                str: baseScore, dex: baseScore, con: baseScore, int: baseScore, wis: baseScore, cha: baseScore
            },
            pointsRemaining: 31, // 购点法，经典的数学游戏
            skills: [],
            spells: [],
            feats: [],
            equipment: null,
            selections: {}, // 存储用户的额外选择 (如技能)，希望他们别选太奇怪的东西
            levelConfig: {
                totalLevel: 1,
                isMulticlass: false,
                classes: [] // [{id, level, isPrimary}]
            },
            // Adrian: 角色细节数据，在这里提前初始化，避免后面的步骤里面搞出 undefined
            details: {
                name: '',
                alignment: '',
                faith: '',
                gender: '',
                age: '',
                height: '',
                weight: '',
                eyes: '',
                skin: '',
                hair: '',
                appearance: '',
                trait: '',
                ideal: '',
                bond: '',
                flaw: '',
                portrait: '',
                biography: ''
            }
        };

        // 持久化的详情背景视频元素，避免切换步骤时重新加载
        this._persistedDetailsVideo = null;
        this._lastDetailsVideoSrc = null;

        // Bind resize once for the lifetime of the application. The original code created a
        // new bound function on every render, leaking one window listener per wizard step.
        this._resizeHandler = this._onResize.bind(this);
        this._resizeBound = false;

        this._draftSaveTimer = null;
        this._skipPersistDraft = false;
        this._resumeWizardContext = null;
        this._resumeWizardStep = 0;
        this._resumeWizardScheduled = false;

        this._restorePersistedDraftState();
    }

    _shouldPersistDraftState() {
        if (!this.actor || this._skipPersistDraft) return false;
        return !!(
            this.creationGrantId
            || this.actor.getFlag?.('character-forge', 'creationPending')
        );
    }

    _restorePersistedDraftState() {
        const raw = this.actor?.getFlag?.('character-forge', CHARACTER_FORGE_DRAFT_FLAG);
        if (!raw?.checkpoint) return false;

        try {
            const stored = decodeDraftValue(raw);

            this.characterLevel = Number(stored.characterLevel) || 1;
            this.isMulticlass = !!stored.isMulticlass;
            this.classLevels = stored.classLevels && typeof stored.classLevels === 'object'
                ? stored.classLevels
                : {};
            this.primaryClass = stored.primaryClass ?? null;

            if (this._creationTimeline && stored.timeline) {
                this._creationTimeline.phase = ['inactive', 'active', 'frozen'].includes(stored.timeline.phase)
                    ? stored.timeline.phase
                    : 'inactive';
                this._creationTimeline.history = Array.isArray(stored.timeline.history)
                    ? stored.timeline.history
                    : [];
                this._creationTimeline.busy = false;
            }

            // render:false восстанавливает текущую страницу, context, blueprint,
            // броски и остальные выборы без промежуточного рендера welcome.
            void this._restoreCreationCheckpoint(stored.checkpoint, { render: false });

            if (stored.checkpoint?.screen?.kind === 'wizard' && stored.checkpoint?.draft?.wizardContext) {
                this._resumeWizardContext = stored.checkpoint.draft.wizardContext;
                this._resumeWizardStep = stored.checkpoint.screen.wizardStep ?? 0;
            }

            return true;
        } catch (error) {
            console.warn('Character Forge | Не удалось восстановить сохранённое создание персонажа:', error);
            return false;
        }
    }

    async _persistDraftState() {
        if (!this._shouldPersistDraftState()) return false;

        try {
            this._syncCurrentCreationPageDraft?.();
            const checkpoint = this._captureCreationCheckpoint?.();
            if (!checkpoint) return false;

            const payload = encodeDraftValue({
                version: 1,
                savedAt: Date.now(),
                characterLevel: this.characterLevel,
                isMulticlass: this.isMulticlass,
                classLevels: this.classLevels,
                primaryClass: this.primaryClass,
                timeline: {
                    phase: this._creationTimeline?.phase || 'inactive',
                    history: this._creationTimeline?.history || []
                },
                checkpoint
            });

            await this.actor.setFlag('character-forge', CHARACTER_FORGE_DRAFT_FLAG, payload);
            return true;
        } catch (error) {
            console.warn('Character Forge | Не удалось сохранить прогресс создания персонажа:', error);
            return false;
        }
    }

    _scheduleDraftAutosave() {
        if (!this._shouldPersistDraftState()) return;
        clearTimeout(this._draftSaveTimer);
        this._draftSaveTimer = setTimeout(() => {
            this._draftSaveTimer = null;
            void this._persistDraftState();
        }, 300);
    }

    _resumePersistedWizardIfNeeded() {
        if (!this._resumeWizardContext || this._resumeWizardScheduled) return;
        this._resumeWizardScheduled = true;

        requestAnimationFrame(async () => {
            try {
                const context = foundry.utils.deepClone(this._resumeWizardContext);
                this._resumeWizardContext = null;
                if (context?._wizardState) context._wizardState.currentStep = this._resumeWizardStep;
                await this._renderFullSubInterface?.(context);
            } catch (error) {
                console.warn('Character Forge | Не удалось восстановить внутренний экран выбора:', error);
            } finally {
                this._resumeWizardScheduled = false;
            }
        });
    }

    async _clearPersistedDraftState({ clearRollLock = false } = {}) {
        clearTimeout(this._draftSaveTimer);
        this._draftSaveTimer = null;
        this._skipPersistDraft = true;

        try {
            if (this.actor?.getFlag?.('character-forge', CHARACTER_FORGE_DRAFT_FLAG)) {
                await this.actor.unsetFlag('character-forge', CHARACTER_FORGE_DRAFT_FLAG);
            }
            if (clearRollLock && this.actor?.getFlag?.('character-forge', 'abilityRollLock')) {
                await this.actor.unsetFlag('character-forge', 'abilityRollLock');
            }
        } catch (error) {
            console.warn('Character Forge | Не удалось очистить сохранённый черновик:', error);
        }
    }

    static DEFAULT_OPTIONS = {
        tag: "form",
        id: "originate-char-gen",
        classes: ["originate-app"],
        position: {
            width: "100%",
            height: "100%"
        },
        window: {
            frame: false,
            positioned: false
        },
        actions: {
            start: OriginateApp.prototype._onStartAdventure,
            nextStep: OriginateApp.prototype._onNextStep,
            prevStep: OriginateApp.prototype._onPrevStep,
            selectOption: OriginateApp.prototype._onSelectOption,
            prevOption: OriginateApp.prototype._onPrevOption,
            nextOption: OriginateApp.prototype._onNextOption,
            navigateUp: OriginateApp.prototype._onNavigateUp,
            toggleLeftDrawer: OriginateApp.prototype._onToggleLeftDrawer,
            changeAbility: OriginateApp.prototype._onChangeAbility,
            toggleSkill: OriginateApp.prototype._onToggleSkill,
            toggleSpell: OriginateApp.prototype._onToggleSpell,
            selectEquipment: OriginateApp.prototype._onSelectEquipment,
            confirmSelection: OriginateApp.prototype._onConfirmSelection,
            finish: OriginateApp.prototype._onFinish,
            close: OriginateApp.prototype._onCloseApp,
            // 特性选择操作
            toggleFeature: OriginateApp.prototype._onToggleFeature,
            previewFeature: OriginateApp.prototype._onPreviewFeature,
            confirmFeatures: OriginateApp.prototype._onConfirmFeatures,
            cancelFeatures: OriginateApp.prototype._onCancelFeatures,
            // 专精选择操作
            confirmExpertise: OriginateApp.prototype._onConfirmExpertise,
            // 等级选择操作
            changeTotalLevel: OriginateApp.prototype._onChangeTotalLevel,
            toggleMulticlass: OriginateApp.prototype._onToggleMulticlass,
            addClass: OriginateApp.prototype._onAddClass,
            removeClass: OriginateApp.prototype._onRemoveClass,
            changeClassLevel: OriginateApp.prototype._onChangeClassLevel,
            updateClassSelection: OriginateApp.prototype._onUpdateClassSelection,
            // 属性点操作
            setAbilityScore: OriginateApp.prototype._onSetAbilityScore,
            incrementAbility: OriginateApp.prototype._onIncrementAbility,
            decrementAbility: OriginateApp.prototype._onDecrementAbility,
            // Roll Mode Actions
            confirmRollResult: OriginateApp.prototype._onConfirmRollResult,
            cancelAssignment: OriginateApp.prototype._onCancelAssignment,
            // ASI Bonus 点数分配操作
            asiAllocIncrease: OriginateApp.prototype._onAsiAllocIncrease,
            asiAllocDecrease: OriginateApp.prototype._onAsiAllocDecrease,
            // 网格选择器
            openGridSelector: OriginateApp.prototype._onOpenGridSelector
        }
    };

    static PARTS = {
        header: { template: "modules/character-forge/templates/header.hbs" },
        main: { template: "modules/character-forge/templates/main.hbs" },
        footer: { template: "modules/character-forge/templates/footer.hbs" }
    };

    async _onStartAdventure(event, target) {
        // 冒险开始！
        await this._animateTransition(() => {
            this.currentStep = 'level';
        });
    }

    /*  */
    /*  Rendering                                   */
    /*  */

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = $(this.element);

        // 添加激活类以隐藏原生 UI
        // 我觉得我的UI好看
        document.body.classList.add("originate-active");

        // 处理详情背景视频持久化
        // Adrian: 用户不想每次切换步骤时视频都重新播放，这可以理解
        this._handleDetailsVideoPeristence(html);

        // 应用视觉主题
        // Adrian: 既然用户选了主题，我们得尊重他们的审美
        // 注意：必须加在 .originate-container 上，因为 CSS 是这么写的
        const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';

        // 尝试找到 container（可能是子元素，也可能是自身）
        let container = html.find('.originate-container');
        if (!container.length && html.hasClass('originate-container')) {
            container = html;
        }

        if (container.length) {
            container.removeClass(getThemeClassList());
            container.addClass(`theme-${visualTheme}`);
        }
        // 根元素（#originate-char-gen，含自绘的 header/footer）也打上主题类。
        // 这个 app 是 frame:false，顶栏是自己画的、跟 .originate-container 是兄弟关系，
        // 主题类只挂在 container 上时皮肤够不到顶栏和全屏背景层。挂到根上之后就能 scope 到了。
        html.removeClass(getThemeClassList());
        html.addClass(`theme-${visualTheme}`);

        // 强制隐藏冲突的 UI 元素 (JS 层面双重保障)
        // 有些 UI 就像顽固的污渍，必须用力擦才能去掉
        this._hideConflictingUI();

        // 初始化滚动位置
        if (this._scrollPos) {
            html.find('.nav-track').scrollLeft(this._scrollPos);
        } else {
            // 初始加载时滚动到选中项，贴心吧？
            this._scrollToSelected();
        }

        // 添加横向滚轮支持
        const navTrack = this.element.querySelector('.nav-track');
        if (navTrack) {
            navTrack.addEventListener('wheel', (e) => {
                if (e.deltaY !== 0) {
                    e.preventDefault();
                    navTrack.scrollLeft += e.deltaY;
                }
            }, { passive: false });
        }

        // Сохраняем прогресс игрока с одноразовым разрешением после каждого
        // устойчивого рендера. Это также защищает от закрытия вкладки без вызова close().
        this._scheduleDraftAutosave();

        // 如果是欢迎界面，不需要做额外绑定
        if (this.currentStep === 'welcome') return;

        // 绑定各个模块的事件
        // Adrian: 这些方法可能不存在（取决于 mixin 结构），所以加个保护
        // 注意: _bindProgressionEvents 需要特定参数 (overlay, step)，所以不在这里调用
        // 它会在 progression overlay 显示时被单独调用
        if (typeof this._bindNavigationEvents === 'function') this._bindNavigationEvents();
        if (typeof this._bindSelectionEvents === 'function') this._bindSelectionEvents();
        if (typeof this._bindAbilitiesEvents === 'function') this._bindAbilitiesEvents();
        if (typeof this._bindDetailsEvents === 'function') this._bindDetailsEvents();

        // 阻止右键上下文菜单（干扰体验）绑定 Hero Section 悬浮事件
        html.find('.hero-section').hover(
            () => { }, // 移入无操作，别乱动
            () => {
                // 移出时，如果是查看详情状态，可以考虑自动折叠
                // 但为了防止误操作（或者是我懒得写），暂时不做处理
            }
        );

        // 绑定 Strip Item 的悬浮预览
        html.find('.strip-item').hover((ev) => {
            // 悬浮时，可以在 Hero Section 显示预览（如果需要）
            // 目前 Hero Section 显示的是选中的内容
            // 可以添加一个 preview 模式，显示悬浮的内容
            // 但考虑到性能和复杂性（主要是我的发际线），先保留点击查看
        });

        // 确保选择状态正确反映到 UI
        this._updateSelectionState(html);

        // 重新绑定子界面的事件（如果存在）
        if (this._subInterface) {
            this._bindSubInterfaceEvents(this._subInterface);
        }

        bindButtonSounds(this.element, {
            selectors: CHARACTER_CREATION_SOUND_SELECTORS,
            playSound: type => this._playSound(type)
        });

        // 初始化窗口尺寸检查
        if (!this._resizeBound) {
            window.addEventListener('resize', this._resizeHandler);
            this._resizeBound = true;
        }
        this._fitLeftDrawerToContent();
        this._onResize(); // Initial check

        // 如果网格面板需要保持打开（用户在面板内选择了选项触发 render）
        if (this._gridSelectorKeepOpen) {
            this._gridSelectorKeepOpen = false;
            // 延迟一帧再打开，确保 DOM 已就绪，跳过动画直接显示
            requestAnimationFrame(() => {
                this._onOpenGridSelector?.call(this, null, null, { skipAnimation: true });
            });
        }

        this._resumePersistedWizardIfNeeded();
    }

    /**
     * 播放音效
     * @param {string} type 音效类型 (PAGE_FLIP, CLICK)
     */
    async _playSound(type) {
        return playOriginateSound(type);
    }

    _scrollToSelected() {
        const container = this.element.querySelector('.nav-track');
        const selectedItem = container?.querySelector('.nav-item.selected');

        if (container && selectedItem) {
            // 使用 getBoundingClientRect 进行更精确的计算
            // 数学不会骗人，除非我算错了
            const containerRect = container.getBoundingClientRect();
            const itemRect = selectedItem.getBoundingClientRect();

            // 计算中心点偏差
            const itemCenterX = itemRect.left + itemRect.width / 2;
            const containerCenterX = containerRect.left + containerRect.width / 2;
            const diff = itemCenterX - containerCenterX;

            // 目标滚动位置
            const targetScrollLeft = container.scrollLeft + diff;

            // window.OriginateLog(`Originate | Scrolling to selected: diff=${diff}, target=${targetScrollLeft}`);

            container.scrollTo({
                left: targetScrollLeft,
                behavior: 'smooth'
            });

            this._scrollPos = targetScrollLeft;
        }
    }

    /**
     * 处理详情背景视频持久化
     * 在详情步骤之间切换时，保持视频元素不重新加载
     * @param {jQuery} html - 渲染后的 DOM
     */
    _handleDetailsVideoPeristence(html) {
        const isDetailsStep = isCharacterCreationDetailStep(this.currentStep);
        const bgContainer = html.find('.details-background-media.global-details-bg');

        if (!isDetailsStep) {
            // 不是详情步骤时，清除持久化的视频
            this._persistedDetailsVideo = null;
            this._lastDetailsVideoSrc = null;
            return;
        }

        if (!bgContainer.length) return;

        const newVideo = bgContainer.find('video.bg-video')[0];
        if (!newVideo) return;

        const currentSrc = bgContainer.find('source').first().attr('src');

        // 如果有持久化的视频且视频源相同，用保存的视频替换新渲染的
        if (this._persistedDetailsVideo && this._lastDetailsVideoSrc === currentSrc) {
            // 用保存的视频元素替换新渲染的
            newVideo.parentNode.replaceChild(this._persistedDetailsVideo, newVideo);
            // 恢复播放
            if (this._persistedDetailsVideo.paused) {
                this._persistedDetailsVideo.play().catch(() => { });
            }
        } else {
            // 第一次进入详情步骤，保存视频元素引用
            this._persistedDetailsVideo = newVideo;
            this._lastDetailsVideoSrc = currentSrc;
        }
    }


    /** @override */
    async close(options) {
        clearTimeout(this._draftSaveTimer);
        this._draftSaveTimer = null;

        if (this._shouldPersistDraftState()) {
            await this._persistDraftState();
        }

        // Before the Foundry application DOM is detached, explicitly stop every looping
        // cinematic video. Detached HTMLVideoElements can otherwise keep decoding frames
        // until garbage collection, which is especially noticeable when the actor sheet
        // opens immediately after character creation.
        const root = this.element instanceof HTMLElement ? this.element : this.element?.[0];
        const videos = new Set([
            ...(root?.querySelectorAll?.('video') || []),
            this._persistedDetailsVideo
        ].filter(Boolean));

        for (const video of videos) {
            try {
                video.pause?.();
                video.removeAttribute?.('autoplay');
                video.removeAttribute?.('loop');
                video.removeAttribute?.('src');
                video.querySelectorAll?.('source').forEach(source => source.removeAttribute('src'));
                video.load?.();
            } catch (error) {
                console.debug('Character Forge | Не удалось полностью освободить видео при закрытии', error);
            }
        }

        this._persistedDetailsVideo = null;
        this._lastDetailsVideoSrc = null;

        const result = await super.close(options);
        document.body.classList.remove("originate-active");

        // 恢复被 JS 强制隐藏的元素
        // 好了，把玩具收起来，让原来的 UI 回来吧
        document.querySelectorAll('.originate-hidden-target').forEach(el => {
            el.style.removeProperty('display');
            el.classList.remove('originate-hidden-target');
        });

        // 清理残留 tooltip
        document.querySelectorAll('.originate-spell-tooltip').forEach(tooltip => tooltip.remove());

        if (typeof this._restoreExternalPickerLayer === 'function') {
            this._restoreExternalPickerLayer();
        }

        // 移除 resize 监听
        if (this._resizeHandler && this._resizeBound) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeBound = false;
        }

        // Освобождаем тяжёлое состояние мастера сразу, а не ждём сборщик мусора.
        // На внешний вид это никак не влияет: приложение к этому моменту уже закрыто.
        this._subInterface = null;
        this._gridSelectorKeepOpen = false;
        this._progressionState = null;
        this._state = null;

        // Самое важное для обычных листов Foundry: тяжёлый CSS Character Forge
        // физически удаляется из document и больше не участвует в style recalculation.
        releaseForgeStyles(this);

        return result;
    }

    /**
     * 这里主要是实现了各个分辨率之间的适配，啊哈，毕竟不是每个人都用 4K 显示器的
     */
    _onResize() {
        if (!this.element) return;

        const container = this.element.querySelector('.originate-container');
        if (!container) return;

        const TARGET_WIDTH = 1600;
        const TARGET_HEIGHT = 900;

        const winW = window.innerWidth;
        const winH = window.innerHeight;

        // Check if we need to enter "Scaled Mode"
        // We use a small buffer (2px) to avoid floating point jitter
        const needsScaling = winW < (TARGET_WIDTH - 2) || winH < (TARGET_HEIGHT - 2);

        if (needsScaling) {
            // SCALED MODE: Force fixed dimensions and scale down
            const scaleX = winW / TARGET_WIDTH;
            const scaleY = winH / TARGET_HEIGHT;
            const scale = Math.min(scaleX, scaleY); // fit within functionality

            // Calculate centering offsets
            // Visual Width = 1600 * scale
            // Visual Height = 900 * scale
            // Offset X = (Window Width - Visual Width) / 2
            const visualWidth = TARGET_WIDTH * scale;
            const visualHeight = TARGET_HEIGHT * scale;

            const offsetX = (winW - visualWidth) / 2;
            const offsetY = (winH - visualHeight) / 2;

            // Apply fixed dimensions so flex/grid layout calculates based on standard size
            container.style.width = `${TARGET_WIDTH}px`;
            container.style.height = `${TARGET_HEIGHT}px`;
            container.style.flex = 'none'; // Disable flex shrinking

            // Force origin to top-left so we can accept manual translation
            container.style.transformOrigin = 'top left';

            // Apply scaling and centering
            container.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
        } else {
            // NATIVE MODE: Use fluid layout
            container.style.width = '100%';
            container.style.height = '100%';
            container.style.position = 'relative'; // Restore relative positioning
            container.style.top = 'auto';
            container.style.left = 'auto';
            container.style.flex = '1';
            container.style.transform = 'scale(1)';
        }

        this._fitLeftDrawerToContent();
    }

    _fitLeftDrawerToContent() {
        const drawer = this.element?.querySelector?.('.left-sidebar-drawer');
        const content = drawer?.querySelector?.('.drawer-content');
        if (!drawer || !content || drawer.classList.contains('hidden')) return;

        // 表格类描述最容易被裁，交给 CSS 变量做宽度上限，别在这里硬算视口。
        drawer.style.setProperty('--left-drawer-content-width', `${Math.ceil(content.scrollWidth)}px`);
    }

    /**
     * 强制隐藏冲突的 UI 元素
     * 就像把不想见到的亲戚关在门外，我不喜欢回家过年，总是有很多亲戚上门，以前还有红包拿但现在得我去发红包了，还吵我睡觉，烦死了
     */
    _hideConflictingUI() {
        const selectors = [
            "#ui-left", "#ui-top", "#ui-right", "#ui-bottom", "#board",
            "#bg3-hotbar-container", ".bg3-hud", ".bg3-no-adapter-notice",
            "[id^='bg3-hud']", ".bg3-hud-dnd5e"
        ];

        selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                el.style.setProperty('display', 'none', 'important');
                el.classList.add('originate-hidden-target');
            });
        });
    }
}
