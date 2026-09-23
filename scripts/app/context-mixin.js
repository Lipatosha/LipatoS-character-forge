import { enhanceOptionsWithPHBImages, enhanceOptionWithPHBImage, isPHBAvailable, isUsingPHBSource } from '../phb-image-mapping.js';
import {
    DETAIL_STEP_LABELS,
    getCharacterCreationDetailSteps,
    isCharacterCreationDetailStep
} from '../shared/character-creation-settings.js';

export const ContextMixin = (Base) => class extends Base {
    async _prepareContext(options) {
        try {
            // 首先调用父类的 _prepareContext，让其他 Mixin 有机会处理
            // Adrian: 这一步很重要，不然其他 Mixin 的 _prepareContext 就白写了
            let baseContext = {};
            if (super._prepareContext) {
                baseContext = await super._prepareContext(options) || {};
            }

            // 获取欢迎语，虽然我觉得没人会认真看
            const welcomeMessage = game.settings.get('character-forge', 'welcomeMessage');
            const welcomeMessageFont = game.settings.get('character-forge', 'welcomeMessageFont') || "Cinzel";

            // 获取视觉主题
            // Adrian: 给那些挑剔的家伙准备的换肤功能
            const visualTheme = game.settings.get('character-forge', 'visualTheme') || 'gold';

            // 获取自定义背景设置
            // Adrian: 每个人都有自己的品味，虽然有些人的品味……一言难尽。
            const startPageBackground = game.settings.get('character-forge', 'startPageBackground');
            const detailsPageBackground = game.settings.get('character-forge', 'detailsPageBackground');

            // 视频检测辅助函数
            const isVideo = (path) => {
                if (!path) return false;
                return path.endsWith('.webm') || path.endsWith('.mp4');
            };

            const startPageBackgroundIsVideo = isVideo(startPageBackground);

            // 动态构建步骤列表
            // 就像人生一样，一步一个脚印，虽然有时候会踩到狗屎
            // 基础步骤先铺机械选择，角色细节步骤再按设置追加
            const steps = [
                { id: 'welcome', label: '欢迎', active: this.currentStep === 'welcome', hidden: true }, // 在导航栏中隐藏，保持神秘感
                { id: 'level', label: '等级', active: this.currentStep === 'level' },
                { id: 'class', label: '职业', active: this.currentStep === 'class' }
            ];
            const detailSteps = getCharacterCreationDetailSteps();

            // 检查是否需要显示子职步骤
            // 有些职业天生就比别人早熟（比如术士），1级就要选子职
            if (this._shouldShowSubclassStep()) {
                steps.push({ id: 'subclass', label: '子职', active: this.currentStep === 'subclass' });
            }

            steps.push(
                { id: 'race', label: '种族', active: this.currentStep === 'race' },
                { id: 'background', label: '背景', active: this.currentStep === 'background' },
                { id: 'abilities', label: '属性', active: this.currentStep === 'abilities' },
                { id: 'asiBonus', label: '属性加成', active: this.currentStep === 'asiBonus' }
            );

            for (const stepId of detailSteps) {
                steps.push({
                    id: stepId,
                    label: DETAIL_STEP_LABELS[stepId] || stepId,
                    active: this.currentStep === stepId
                });
            }

            // 如果是等级选择步骤，不需要获取选项
            // 毕竟等级就是数字，不需要从 Compendium 里拉取
            let currentOptions = [];
            let selectedOption = null;
            let availableClasses = [];

            if (this.currentStep === 'level') {
                // 获取所有可用职业供选择
                // 兼职狂魔的最爱
                availableClasses = await this.dataManager.getOptions('class');
                // 应用 PHB 图片增强，让它们看起来更顺眼
                availableClasses = enhanceOptionsWithPHBImages(availableClasses, 'class');
            } else if (['abilities', 'asiBonus'].includes(this.currentStep) || isCharacterCreationDetailStep(this.currentStep)) {
                // 这些步骤不需要获取选项，数据都在 context.details 或 context.abilities 里
                // 就像自力更生一样，不需要靠别人
            } else if (this.currentStep !== 'welcome') { // 欢迎步骤不需要获取选项，只需要微笑
                currentOptions = await this.dataManager.getOptions(this.currentStep, this.context);
                // 应用 PHB 图片增强
                currentOptions = enhanceOptionsWithPHBImages(currentOptions, this.currentStep);

                // 批量检测视频格式
                currentOptions.forEach(opt => {
                    opt.heroImageIsVideo = isVideo(opt.heroImage);
                });

                // 获取当前选中的 ID
                const currentSelectedId = this.context[this.currentStep];
                window.OriginateLog(`_prepareContext: currentStep=${this.currentStep}, selectedId=${currentSelectedId}`);

                if (currentSelectedId) {
                    let optionSummary = currentOptions.find(o => o.id === currentSelectedId);
                    window.OriginateLog(`_prepareContext: found optionSummary=`, optionSummary);

                    if (optionSummary) {
                        await this.dataManager.enrichOptionDescription?.(optionSummary);
                        // 清理描述中的 UUID 引用
                        // Foundry 的富文本链接在纯文本环境下就是一团乱码，得清理干净
                        let cleanedDescription = optionSummary.description || '';
                        // 移除 @UUID[...]{...} 格式的引用，保留显示文本
                        cleanedDescription = cleanedDescription.replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, '$1');
                        // 移除 @UUID[...] 格式的引用（无显示文本）
                        cleanedDescription = cleanedDescription.replace(/@UUID\[[^\]]*\]/g, '');
                        // 移除其他 Foundry 引用格式，统统干掉
                        cleanedDescription = cleanedDescription.replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, '$1');
                        cleanedDescription = cleanedDescription.replace(/@\w+\[[^\]]*\]/g, '');

                        selectedOption = {
                            ...optionSummary,
                            description: cleanedDescription,
                            features: [] // 预览时不显示特性，点击确认后在子界面显示，保持清爽
                        };
                        // 确保 PHB 图片已应用
                        selectedOption = enhanceOptionWithPHBImage(selectedOption, this.currentStep);

                        // 如果没有特定的背景图，使用默认背景


                        // 检测是否为视频
                        selectedOption.heroImageIsVideo = isVideo(selectedOption.heroImage);
                    }
                }
            }

            const activeStepLabel = steps.find(s => s.active)?.label || '';

            // 合并基础上下文和当前上下文
            // Adrian: 先让其他 Mixin 处理，然后我们再加上自己的东西
            const context = {
                ...baseContext,
                ...this.context,
                ...this.context,
                welcomeMessage,
                welcomeMessageFont,
                visualTheme,
                startPageBackground,
                startPageBackgroundIsVideo,
                detailsPageBackground,
                detailsPageBackgroundIsVideo: isVideo(detailsPageBackground),
                isDetailsStep: isCharacterCreationDetailStep(this.currentStep),
                isAsiBonusStep: this.currentStep === 'asiBonus',

                currentStep: this.currentStep,
                currentSelectedId: this.context[this.currentStep],
                steps: steps.filter(s => !s.hidden), // 过滤掉隐藏的步骤，别让用户看到不该看的
                options: currentOptions,
                availableClasses, // 传递给等级选择界面
                activeStepLabel,
                selectedOption,
                leftDrawerExpanded: !!selectedOption && !!this._leftDrawerExpanded,
                leftDrawerSwitching: !!selectedOption && !!this._leftDrawerSwitching,
                isWelcomeStep: this.currentStep === 'welcome',
                isLevelStep: this.currentStep === 'level',
                isAbilitiesStep: this.currentStep === 'abilities',
                isNameStep: this.currentStep === 'name',
                isAlignmentStep: this.currentStep === 'alignment',
                isAppearanceStep: this.currentStep === 'appearance',
                isPersonalityStep: this.currentStep === 'personality',
                isPortraitStep: this.currentStep === 'portrait',
                isBiographyStep: this.currentStep === 'biography',
                characterLevel: this.characterLevel,
                isFirstStep: this.currentStep === 'level' || this.currentStep === 'welcome',
                isLastStep: this.currentStep === this._getActiveSteps().at(-1),
                canProceed: this._canProceed(),
                summary: {
                    raceName: this.context.raceName || "未选择",
                    className: this.context.className || "未选择",
                    backgroundName: this.context.backgroundName || "未选择",
                    level: this.characterLevel
                },
                currentFolder: this._currentFolder,
                canNavigateUp: !!this._currentFolder
            };

            window.OriginateLog(`_prepareContext: final context summary=`, context.summary);
            return context;
        } catch (error) {
            console.error("Originate | Error preparing context:", error);
            return this.context;
        }
    }

    _canProceed() {
        // 只要你想，随时可以前进。当然，后果自负。
        return true;
    }

    /**
     * 检查是否需要显示子职步骤
     * 条件：已选择职业 且 该职业在 1 级获得子职
     * 注意：如果子职在 2 级或更高等级获得，将由升级流程 (ProgressionMixin) 处理，不在此处显示
     * 
     * 简而言之：术士、牧师这种早熟的职业在这里选，其他的以后再说。
     */
    _shouldShowSubclassStep() {
        // 如果还没选择职业，不显示子职步骤
        // 连职业都没有，选什么子职？
        if (!this.context.class) return false;

        // 获取当前选中的职业数据
        // 默认子职获得等级为 3，这是大多数职业的标准
        let subclassLevel = 3;

        // 尝试从当前选项中查找（如果当前步骤是 class）
        if (this.currentStep === 'class' && this.context.options) {
            const selectedClass = this.context.options.find(o => o.id === this.context.class);
            if (selectedClass && selectedClass.subclassLevel !== undefined) {
                subclassLevel = selectedClass.subclassLevel;
            }
        } else if (this.context.availableClasses) {
            // 如果在等级步骤，尝试从 availableClasses 中查找
            const selectedClass = this.context.availableClasses.find(o => o.id === this.context.class);
            if (selectedClass && selectedClass.subclassLevel !== undefined) {
                subclassLevel = selectedClass.subclassLevel;
            }
        }

        // 只有当子职获得等级为 1 时，才在初始流程中显示子职步骤
        // 其他情况（如 3 级获得子职）将在升级流程中处理
        return subclassLevel === 1;
    }

    /**
     * 获取当前有效的步骤列表
     * 
     * 就像一份购物清单，告诉我们要去哪。
     */
    _getActiveSteps() {
        const steps = ['welcome', 'level'];

        // Adrian: 属性步骤位置可配置
        // 'early' = 在选职业之前先定属性（先决定你是什么料）
        // 'late'  = 经典流程，选完种族背景再定属性（默认）
        const abilityPosition = game.settings.get('character-forge', 'abilityStepPosition') || 'late';

        if (abilityPosition === 'early') {
            steps.push('abilities');
        }

        steps.push('class');

        // 如果需要显示子职步骤
        if (this._shouldShowSubclassStep()) {
            steps.push('subclass');
        }

        steps.push('race', 'background');

        if (abilityPosition !== 'early') {
            steps.push('abilities');
        }

        // asiBonus 永远在 abilities 之后（先分配基础属性，再看种族/背景的 ASI 加成）
        steps.push('asiBonus');

        steps.push(...getCharacterCreationDetailSteps());
        return steps;
    }
};
