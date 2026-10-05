import { enhanceOptionsWithPHBImages, enhanceOptionWithPHBImage, isPHBAvailable, isUsingPHBSource } from '../phb-image-mapping.js';
import {
    DETAIL_STEP_LABELS,
    getCharacterCreationDetailSteps,
    isCharacterCreationDetailStep
} from '../shared/character-creation-settings.js';

const CHARACTER_FORGE_OFFICIAL_CLASS_ORDER = [
    'fighter',
    'barbarian',
    'rogue',
    'ranger',
    'monk',
    'blood-hunter',
    'paladin',
    'bard',
    'druid',
    'wizard',
    'sorcerer',
    'warlock',
    'artificer',
    'cleric'
];

const CHARACTER_FORGE_ALTERNATIVE_CLASS_ORDER = [
    'fighter',
    'barbarian',
    'rogue',
    'ranger',
    'monk',
    'blood-hunter',
    'paladin',
    'bard',
    'druid',
    'wizard',
    'sorcerer',
    'warlock',
    'artificer'
];

const CHARACTER_FORGE_CLASS_LABELS_RU = Object.freeze({
    fighter: 'Воин',
    barbarian: 'Варвар',
    rogue: 'Плут',
    ranger: 'Следопыт',
    monk: 'Монах',
    'blood-hunter': 'Кровавый охотник',
    paladin: 'Паладин',
    bard: 'Бард',
    druid: 'Друид',
    wizard: 'Волшебник',
    sorcerer: 'Чародей',
    warlock: 'Колдун',
    artificer: 'Изобретатель',
    cleric: 'Жрец'
});

// Короткие подписи на странице выбора класса. Правила в библиотеке не изменяем.
const CHARACTER_FORGE_CLASS_TAGLINES = {
    "paladin": "Благородный рыцарь, который сначала читает врагу мораль, а потом добавляет к ней сияющую кару.",
    "barbarian": "Решает большинство проблем топором, а остальные проблемы просто ещё не встретили его топор.",
    "artificer": "Способен превратить любую идею в реальность, даже если реальность категорически против.",
    "monk": "Может пробежать по стене, поймать стрелу рукой и победить вооружённого рыцаря, оставаясь при этом без денег.",
    "sorcerer": "Просто родился волшебным и этим ежедневно раздражает волшебника, который учился двадцать лет.",
    "wizard": "Потратил годы на изучение магии, чтобы однажды забыть подготовить именно то заклинание, которое сейчас нужно.",
    "warlock": "Продал душу за могущество, а потом выяснил, что это был только первоначальный взнос.",
    "ranger": "Может найти след дракона недельной давности, но трактир через две улицы всё равно приходится искать всей группой.",
    "druid": "Может говорить с животными, потому что разговоры с группой давно перестали приносить результат.",
    "rogue": "Считает скрытность искусством, а чужие карманы просто благодарной аудиторией.",
    "cleric": "Хотел служить богам, но по распределению попал в группу, которую приходится спасать даже от собственных планов.",
    "fighter": "Самый классический класс. Настолько классический, что даже название придумывать не стали.",
    "bard": "Единственный, кто смотрит на финального босса и думает не о победе, а о том, насколько тот одинок."
};

function normalizeClassIdentifier(option = {}) {
    return String(
        option.identifier
        || option.system?.identifier
        || ''
    ).trim().toLowerCase();
}

function normalizeClassCatalogText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[’']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getClassCatalogInfo(option = {}) {
    const identifier = normalizeClassIdentifier(option);
    const name = normalizeClassCatalogText(option.displayName || option.name || '');
    const altByName = /\((?:альт\.?|alt\.?)\)|\bальт\.?\b|\balternative\b/u.test(name);
    const altByIdentifier = /(?:^|[-_.])(alt|alternative)(?:$|[-_.])/i.test(identifier);
    const isAlternative = altByName || altByIdentifier;

    const baseName = name
        .replace(/\((?:альт\.?|alt\.?)\)/gu, '')
        .replace(/\bальт\.?\b/gu, '')
        .replace(/\balternative\b/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const compactId = identifier.replace(/[^a-z0-9а-я]+/giu, '');
    const compactName = baseName.replace(/[^a-z0-9а-я]+/giu, '');

    const aliases = [
        ['blood-hunter', ['bloodhunter', 'кровавыйохотник']],
        ['fighter', ['fighter', 'воин']],
        ['barbarian', ['barbarian', 'варвар']],
        ['rogue', ['rogue', 'плут']],
        ['ranger', ['ranger', 'следопыт']],
        ['monk', ['monk', 'монах']],
        ['paladin', ['paladin', 'паладин']],
        ['bard', ['bard', 'бард']],
        ['druid', ['druid', 'друид']],
        ['wizard', ['wizard', 'волшебник']],
        ['sorcerer', ['sorcerer', 'чародей']],
        ['warlock', ['warlock', 'колдун']],
        ['artificer', ['artificer', 'изобретатель']],
        ['cleric', ['cleric', 'жрец']]
    ];

    const match = aliases.find(([, values]) => values.some(alias =>
        compactId.includes(alias) || compactName === alias || compactName.startsWith(alias)
    ));

    return {
        key: match?.[0] || null,
        isAlternative
    };
}

function isHiddenPsionicClass(option = {}) {
    const identifier = normalizeClassIdentifier(option);
    const label = normalizeClassCatalogText(option.displayName || option.name || '');
    const compact = label.replace(/\s+/g, '');
    return (
        (compact.includes('псионик') && compact.includes('ua') && compact.includes('hb'))
        || (/psionic/i.test(identifier) && /(?:ua|hb)/i.test(identifier))
    );
}

function isCompanionClass(option = {}) {
    const identifier = normalizeClassIdentifier(option);
    const displayName = normalizeClassCatalogText(option.displayName || '');
    const sourceName = normalizeClassCatalogText(option.name || '');
    const label = `${displayName} ${sourceName}`.trim();

    return label.includes('напарник')
        || label.includes('скакун')
        || label.includes('собакен')
        || /(?:^|[-_.])(sidekick|companion)(?:$|[-_.])/i.test(identifier)
        || /(?:mount|dog|hound)/i.test(identifier);
}

function buildClassCatalogGroup(options, order, isAlternative) {
    const byKey = new Map();

    for (const option of options) {
        const info = getClassCatalogInfo(option);
        if (!info.key || info.isAlternative !== isAlternative || !order.includes(info.key)) continue;
        if (byKey.has(info.key)) continue;

        const baseLabel = CHARACTER_FORGE_CLASS_LABELS_RU[info.key] || option.displayName || option.name;
        const classNavLabel = isAlternative ? `${baseLabel} (альт.)` : baseLabel;
        const isBloodHunter = info.key === 'blood-hunter';

        byKey.set(info.key, {
            ...option,
            classCatalogKey: info.key,
            classNavLabel,
            classNavLine1: isBloodHunter ? 'Кровавый' : (isAlternative ? baseLabel : null),
            classNavLine2: isBloodHunter ? 'охотник' : (isAlternative ? '(альт.)' : null),
            classNavLine3: isBloodHunter && isAlternative ? '(альт.)' : null
        });
    }

    return order.map(key => byKey.get(key)).filter(Boolean);
}

function stripBookSuffix(name) {
    return String(name || '')
        .replace(/\s*\(([A-Z0-9][A-Z0-9&+.'’\- ]{1,24})\)\s*$/u, '')
        .trim();
}


function normalizeRaceCatalogText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[’']/gu, '')
        .replace(/[–—]/gu, '-')
        .replace(/\s+/gu, ' ')
        .trim();
}

function getRaceCatalogNames(option = {}) {
    const values = [
        option.displayName,
        option.name,
        option.label,
        option.title
    ].filter(value => typeof value === 'string' && value.trim());

    const names = new Set(values);

    for (const value of values) {
        try {
            const localized = game.i18n.localize(value);
            if (typeof localized === 'string' && localized.trim()) names.add(localized);
        } catch (_) {
            // Если это не ключ локализации, достаточно исходного значения.
        }
    }

    return Array.from(names)
        .map(normalizeRaceCatalogText)
        .filter(Boolean);
}

function raceNameIncludes(option, aliases) {
    const names = getRaceCatalogNames(option);
    return aliases.some(alias => {
        const needle = normalizeRaceCatalogText(alias);
        return names.some(name => name.includes(needle));
    });
}

function isUndeadRace(option = {}) {
    const names = getRaceCatalogNames(option);
    const label = names.join(' ');
    const typeValue = normalizeRaceCatalogText(
        option.coreTraits?.type
        || option.system?.type?.value
        || option.system?.type
        || ''
    );

    if (typeValue === 'undead' || typeValue.includes('нежить')) return true;

    return /\b(?:undead|skeleton|zombie|mummy|ghost|wight|wraith|lich|revenant|dhampir|reborn)\b/i.test(label)
        || /\b(?:нежить|скелет|зомби|мумия|призрак|упырь|вурдалак|лич|ревенант|дампир|возрожденн\w*)\b/iu.test(label);
}

function getRaceCatalogCategory(option = {}) {
    // Нежить имеет высший приоритет: дампир/возрождённый не должны
    // попадать в общие гуманоидные категории.
    if (isUndeadRace(option)) return 'death';

    // Шадар-кай, эладрины и прочие эльфийские варианты держим вместе,
    // даже если у них есть выраженная планарная связь.
    if (raceNameIncludes(option, [
        'эльф', 'elf', 'дроу', 'drow', 'шадар', 'shadar',
        'полуэльф', 'half-elf', 'half elf', 'эладрин', 'eladrin'
    ])) return 'elf';

    if (raceNameIncludes(option, [
        'дварф', 'dwarf', 'дуэргар', 'duergar', 'полудварф', 'half-dwarf', 'half dwarf',
        'гном', 'gnome', 'полурослик', 'halfling', 'голиаф', 'goliath'
    ])) return 'mountain';

    if (raceNameIncludes(option, [
        'драконорожден', 'dragonborn', 'драконокров', 'dragonkin',
        'кобольд', 'kobold', 'полудракон', 'half-dragon', 'half dragon'
    ])) return 'dragon';

    if (raceNameIncludes(option, [
        'аасимар', 'асимар', 'aasimar', 'тифлинг', 'tiefling',
        'дженази', 'genasi', 'гитьянки', 'githyanki', 'гитзерай', 'githzerai',
        'калаштар', 'kalashtar'
    ])) return 'planar';

    if (raceNameIncludes(option, [
        'орк', 'orc', 'полуорк', 'half-orc', 'half orc',
        'гоблин', 'goblin', 'хобгоблин', 'hobgoblin',
        'багбер', 'багбир', 'bugbear', 'вердан', 'verdan'
    ])) return 'fang';

    if (raceNameIncludes(option, [
        'ааракокра', 'aarakocra', 'кенку', 'kenku', 'людоворон', 'crowfolk',
        'табакси', 'tabaxi', 'леонин', 'leonin', 'локсодонт', 'loxodon',
        'кицун', 'kitsune', 'котов', 'catfolk', 'мышин', 'mousefolk',
        'людокрыс', 'ratfolk', 'людомедвед', 'bearfolk',
        'людоящер', 'lizardfolk', 'тортл', 'tortle', 'грунг', 'grung',
        'юань-ти', 'юань ти', 'yuan-ti', 'yuan ti'
    ])) return 'beast';

    if (raceNameIncludes(option, [
        'человек', 'human', 'получеловек'
    ])) return 'kingdoms';

    if (raceNameIncludes(option, [
        'фирболг', 'firbolg', 'сатир', 'satyr', 'фэйри', 'фейри', 'fairy',
        'кентавр', 'centaur', 'минотавр', 'minotaur',
        'чейнджлинг', 'чейджлинг', 'changeling', 'изменяющийся',
        'шифтер', 'shifter', 'гибрид симиков', 'simic hybrid',
        'кован', 'warforged', 'маген', 'magen', 'ведалкен', 'vedalken',
        'энтлинг', 'entling'
    ])) return 'unusual';

    // Всё редкое, искусственное и хоумбрю, которое не совпало с явными
    // правилами выше, отправляем сюда, чтобы ни одна раса не потерялась.
    return 'unusual';
}


function isHiddenRaceAfterDisplayEnhancement(option = {}) {
    const baseValues = [
        option.displayName,
        option.name,
        option.label,
        option.title
    ].filter(value => typeof value === 'string' && value.trim());

    const values = new Set(baseValues);

    // В шаблоне имя выводится через {{localize this.name}}.
    // Повторяем ровно эту операцию здесь, ДО построения групп рас.
    for (const value of baseValues) {
        try {
            const localized = game.i18n.localize(value);
            if (typeof localized === 'string' && localized.trim()) values.add(localized);
        } catch (_) {
            // Оставляем сырой вариант, если ключ локализации некорректен.
        }
    }

    for (const value of values) {
        const normalized = normalizeRaceCatalogText(value)
            .replace(/<[^>]*>/gu, ' ')
            .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim();
        const compact = normalized.replace(/[^a-zа-я0-9]+/giu, '');

        if (/(?:^|\s)метка(?:\s|$)/iu.test(normalized)
            || /(?:^|\s)mark\s+of(?:\s|$)/iu.test(normalized)) {
            return true;
        }

        if (compact.includes('гнол') || compact.includes('gnoll')) return true;
        if (normalized.includes('мидгард') || normalized.includes('midgard')) return true;
        if (compact.includes('стиктиккал') || compact.includes('stiktikkal')) return true;
    }

    return false;
}

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
            const configuredWelcomeMessage = String(
                game.settings.get('character-forge', 'welcomeMessage') || ''
            ).trim();
            const legacyWelcomeMessage = 'Ready to embark on your journey, adventurer?';
            const welcomeMessage = (!configuredWelcomeMessage || configuredWelcomeMessage === legacyWelcomeMessage)
                ? game.i18n.localize('ORIGINATE.UI.Welcome.Message')
                : configuredWelcomeMessage;
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
            let officialClassOptions = [];
            let alternativeClassOptions = [];
            let unofficialClassOptions = [];
            let companionClassOptions = [];
            let raceKingdomOptions = [];
            let raceElfOptions = [];
            let raceMountainOptions = [];
            let raceFangOptions = [];
            let raceBeastOptions = [];
            let raceDragonOptions = [];
            let racePlanarOptions = [];
            let raceUnusualOptions = [];
            let raceDeathOptions = [];

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

                // Повторная обязательная фильтрация рас уже после формирования
                // displayName. Это не даёт меткам, гноллам и Мидгарду пройти
                // через различия между исходным и отображаемым названием.
                if (this.currentStep === 'race') {
                    currentOptions = currentOptions.filter(option => !isHiddenRaceAfterDisplayEnhancement(option));
                }

                // Class selector: show only the requested official and alternative catalogs,
                // in a deterministic order independent of compendium order.
                if (this.currentStep === 'class') {
                    const enriched = currentOptions.map(option => {
                        const identifier = getClassCatalogInfo(option).key || normalizeClassIdentifier(option);
                        return {
                            ...option,
                            tagline: CHARACTER_FORGE_CLASS_TAGLINES[identifier] ?? option.tagline
                        };
                    });

                    officialClassOptions = buildClassCatalogGroup(
                        enriched,
                        CHARACTER_FORGE_OFFICIAL_CLASS_ORDER,
                        false
                    );
                    alternativeClassOptions = buildClassCatalogGroup(
                        enriched,
                        CHARACTER_FORGE_ALTERNATIVE_CLASS_ORDER,
                        true
                    );

                    const catalogIds = new Set([
                        ...officialClassOptions.map(option => option.id),
                        ...alternativeClassOptions.map(option => option.id)
                    ]);

                    const residualClassOptions = enriched
                        .filter(option => !catalogIds.has(option.id))
                        .filter(option => !isHiddenPsionicClass(option))
                        .map(option => ({
                            ...option,
                            classNavLabel: String(option.displayName || option.name || '').trim()
                        }));

                    companionClassOptions = residualClassOptions
                        .filter(option => isCompanionClass(option));

                    const companionIds = new Set(companionClassOptions.map(option => option.id));

                    unofficialClassOptions = residualClassOptions
                        .filter(option => !companionIds.has(option.id));

                    currentOptions = [
                        ...officialClassOptions,
                        ...alternativeClassOptions,
                        ...unofficialClassOptions,
                        ...companionClassOptions
                    ];
                }

                if (this.currentStep === 'race') {
                    const raceBuckets = {
                        kingdoms: [],
                        elf: [],
                        mountain: [],
                        fang: [],
                        beast: [],
                        dragon: [],
                        planar: [],
                        unusual: [],
                        death: []
                    };

                    for (const option of currentOptions) {
                        const category = getRaceCatalogCategory(option);
                        (raceBuckets[category] || raceBuckets.unusual).push(option);
                    }

                    raceKingdomOptions = raceBuckets.kingdoms;
                    raceElfOptions = raceBuckets.elf;
                    raceMountainOptions = raceBuckets.mountain;
                    raceFangOptions = raceBuckets.fang;
                    raceBeastOptions = raceBuckets.beast;
                    raceDragonOptions = raceBuckets.dragon;
                    racePlanarOptions = raceBuckets.planar;
                    raceUnusualOptions = raceBuckets.unusual;
                    raceDeathOptions = raceBuckets.death;
                }

                // У предысторий скрываем книжные суффиксы вроде "(EGW)", но не меняем сам Item.
                if (this.currentStep === 'background') {
                    currentOptions = currentOptions.map(option => ({
                        ...option,
                        displayName: stripBookSuffix(option.name)
                    }));
                }

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

                        if (this.currentStep === 'class') {
                            // The class detail icon comes from the installed Laaru compendium.
                            selectedOption.classIcon = selectedOption.classIcon || selectedOption.img || null;
                        }

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
                officialClassOptions,
                alternativeClassOptions,
                unofficialClassOptions,
                companionClassOptions,
                raceKingdomOptions,
                raceElfOptions,
                raceMountainOptions,
                raceFangOptions,
                raceBeastOptions,
                raceDragonOptions,
                racePlanarOptions,
                raceUnusualOptions,
                raceDeathOptions,
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
