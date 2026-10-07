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


const CHARACTER_FORGE_UNOFFICIAL_CLASS_ORDER = Object.freeze([
    ['алхимик', 'alchemist'],
    ['вместилище духа', 'spirit vessel', 'spiritvessel'],
    ['мистик', 'mystic'],
    ['дебошир', 'brawler'],
    ['звездочёт', 'звездочет', 'stargazer'],
    ['инллриггер', 'иллриггер', 'illrigger'],
    ['охотник на монстров', 'monster hunter', 'monsterhunter'],
    ['присон', 'претор', 'praetor'],
    ['неупоконенная душа', 'неупокоенная душа', 'unquiet soul', 'restless soul'],
    ['псион', 'psion'],
    ['предводитель', 'leader'],
    ['страж', 'warden'],
    ['военочальник', 'военачальник', 'warlord'],
    ['магус', 'magus'],
    ['простолюдин', 'commoner'],
    ['савант', 'savant'],
    ['спеллблейд', 'spellblade'],
    ['шаман', 'shaman'],
    ['хранитель рун', 'rune keeper', 'runekeeper'],
    ['оккультист', 'occultist']
]);

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


function getUnofficialClassSortIndex(option = {}) {
    const identifier = normalizeClassIdentifier(option);
    const label = normalizeClassCatalogText(
        option.classNavLabel
        || option.displayName
        || option.name
        || ''
    );

    const compactLabel = label.replace(/[^a-zа-я0-9]+/giu, '');
    const compactIdentifier = identifier.replace(/[^a-zа-я0-9]+/giu, '');

    const index = CHARACTER_FORGE_UNOFFICIAL_CLASS_ORDER.findIndex(aliases =>
        aliases.some(alias => {
            const normalizedAlias = normalizeClassCatalogText(alias);
            const compactAlias = normalizedAlias.replace(/[^a-zа-я0-9]+/giu, '');

            return label === normalizedAlias
                || label.includes(normalizedAlias)
                || compactLabel === compactAlias
                || compactLabel.includes(compactAlias)
                || compactIdentifier.includes(compactAlias);
        })
    );

    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
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
        .replace(/\s*\([^)]*\)/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeBackgroundCatalogText(value) {
    return stripBookSuffix(value)
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[’']/gu, '')
        .replace(/[–—]/gu, '-')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

const BACKGROUND_CATEGORY_DEFINITIONS = Object.freeze([
    {
        id: 'status-society-fame',
        title: 'Статус, общество и известность',
        entries: [
            'Благородный',
            'Наследник',
            'Дипломат',
            'Придворный',
            'Представитель фракции',
            'Народный герой',
            'Награждённый',
            'Артист',
            'Атлет',
            'Потомок знаменитого авантюриста'
        ]
    },
    {
        id: 'war-service-law',
        title: 'Война, служба и закон',
        entries: [
            'Солдат',
            'Ветеран-наёмник',
            'Городской стражник',
            'Морской пехотинец',
            'Рыцарь ордена',
            'Городской охотник за головами',
            'Охранник',
            'Наёмник-рекрут',
            'Всадники Преисподней',
            'Стрелковый корпус Уайтстоуна'
        ]
    },
    {
        id: 'crime-deception',
        title: 'Преступный мир и обман',
        entries: [
            'Преступник',
            'Шарлатан',
            'Контрабандист',
            'Конспиративная личность',
            'Безликий',
            'Азартный игрок',
            'Агент-Волстракер',
            'Двойной агент Чёрных Кулаков',
            'Оперативник Димиров',
            'Шпион — Вера Аугена'
        ]
    },
    {
        id: 'faith-magic-occult',
        title: 'Вера, магия и оккультизм',
        entries: [
            'Послушник',
            'Еретик',
            'Исправившийся культист',
            'Оккультист',
            'Избранный',
            'Хранитель врат',
            'Резчик рун',
            'Маг Высшего Волшебства',
            'Культист Ракдосов',
            'Фанатик Шейдов'
        ]
    },
    {
        id: 'knowledge-investigation',
        title: 'Знания и расследования',
        entries: [
            'Мудрец',
            'Антрополог',
            'Археолог',
            'Следователь',
            'Учёный-затворник',
            'Планарный философ',
            'Детектив',
            'Сыщик',
            'Учащийся лицея',
            'Учёный Симиков'
        ]
    },
    {
        id: 'craft-trade-professions',
        title: 'Ремесло, торговля и профессии',
        entries: [
            'Караванщик',
            'Клановый ремесленник',
            'Корабел',
            'Неудавшийся торговец',
            'Парфюмер',
            'Ремесленник из гильдии',
            'Рыбак',
            'Трактирщик',
            'Инженер Иззетов',
            'Торговец Хиллсфара'
        ]
    },
    {
        id: 'travel-wilderness',
        title: 'Путешествия и дикая местность',
        entries: [
            'Бедуин',
            'Бродяга',
            'Дальний путешественник',
            'Егерь',
            'Отшельник',
            'Охотник за трофеями',
            'Моряк',
            'Чужеземец',
            'Житель леса',
            'Житель дикого космоса'
        ]
    },
    {
        id: 'unusual-fate-origin',
        title: 'Необычная судьба и происхождение',
        entries: [
            'Бывший искатель приключений',
            'Великаний подкидыш',
            'Воспитанный чудовищами',
            'Изувеченный Драконом',
            'Потерявшийся в Царстве Фей',
            'Преследуемый',
            'Разорённый',
            'Таинственное происхождение',
            'Чейнджлинг странник',
            'Астральный скиталец'
        ]
    }
]);

const BACKGROUND_PREFER_PHB_NAMES = Object.freeze([
    'Артист',
    'Благородный',
    'Бродяга',
    'Моряк',
    'Мудрец',
    'Народный герой',
    'Отшельник',
    'Послушник',
    'Преступник',
    'Солдат',
    'Чужеземец',
    'Шарлатан'
]);

const BACKGROUND_PREFER_PHB_KEYS = new Set(
    BACKGROUND_PREFER_PHB_NAMES.map(normalizeBackgroundCatalogText)
);

const BACKGROUND_REQUIRED_TOTAL = BACKGROUND_CATEGORY_DEFINITIONS
    .reduce((sum, category) => sum + category.entries.length, 0);

function extractBackgroundBookCode(rawName) {
    const matches = Array.from(String(rawName || '').matchAll(/\(([^()]*)\)/gu));
    return String(matches.at(-1)?.[1] || '').trim();
}

async function buildExplicitBackgroundSelection(dataManager, options = []) {
    const candidatesByName = new Map();

    options.forEach((option, sourceOrder) => {
        const displayName = stripBookSuffix(option.name);
        const key = normalizeBackgroundCatalogText(displayName);
        if (!key) return;

        if (!candidatesByName.has(key)) candidatesByName.set(key, []);
        candidatesByName.get(key).push({
            ...option,
            displayName,
            backgroundDisplayWords: splitBackgroundDisplayWords(displayName),
            backgroundSourceOrder: sourceOrder
        });
    });

    const selectedOptions = [];
    const selectedIds = new Set();
    const selectedDisplayNames = new Set();
    const backgroundIdCategoryMap = new Map();
    const missingNames = [];

    for (const category of BACKGROUND_CATEGORY_DEFINITIONS) {
        for (let order = 0; order < category.entries.length; order += 1) {
            const requiredName = category.entries[order];
            const key = normalizeBackgroundCatalogText(requiredName);
            const candidates = [...(candidatesByName.get(key) || [])];

            if (!candidates.length) {
                missingNames.push(requiredName);
                continue;
            }

            if (BACKGROUND_PREFER_PHB_KEYS.has(key) && candidates.length > 1) {
                await Promise.all(candidates.map(async candidate => {
                    try {
                        const doc = candidate.uuid ? await dataManager.getDocument(candidate.uuid) : null;
                        candidate._backgroundRawName = doc?.name || candidate.name || '';
                    } catch (_) {
                        candidate._backgroundRawName = candidate.name || '';
                    }
                }));

                candidates.sort((a, b) => {
                    const sourceRank = candidate => {
                        const code = extractBackgroundBookCode(candidate._backgroundRawName);
                        if (/PHB/iu.test(code)) return 0;
                        if (/BGDIA/iu.test(code)) return 100;
                        return 20;
                    };

                    return sourceRank(a) - sourceRank(b)
                        || (a.backgroundSourceOrder ?? 9999) - (b.backgroundSourceOrder ?? 9999);
                });
            } else {
                candidates.sort((a, b) =>
                    (a.backgroundSourceOrder ?? 9999) - (b.backgroundSourceOrder ?? 9999)
                );
            }

            const chosen = candidates.find(candidate =>
                !selectedIds.has(candidate.id)
                && !selectedDisplayNames.has(key)
            );

            if (!chosen) {
                missingNames.push(requiredName);
                continue;
            }

            selectedIds.add(chosen.id);
            selectedDisplayNames.add(key);

            const prepared = {
                ...chosen,
                displayName: requiredName,
                backgroundDisplayWords: splitBackgroundDisplayWords(requiredName),
                backgroundCategoryId: category.id,
                backgroundCategoryOrder: order
            };

            selectedOptions.push(prepared);
            backgroundIdCategoryMap.set(chosen.id, {
                categoryId: category.id,
                order,
                displayName: requiredName
            });
        }
    }

    return {
        selectedOptions,
        backgroundIdCategoryMap,
        missingNames
    };
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


function resolveRaceDisplayName(option = {}) {
    const values = [
        option.raceDisplayName,
        option.displayName,
        option.name,
        option.label,
        option.title
    ].filter(value => typeof value === 'string' && value.trim());

    // Сначала ищем реально локализованное значение. Это тот же источник,
    // из которого Handlebars-helper {{localize ...}} получал русский текст.
    for (const value of values) {
        try {
            const localized = game.i18n.localize(value);
            if (typeof localized === 'string' && localized.trim() && localized !== value) {
                return localized.trim();
            }
        } catch (_) {
            // Не ключ локализации — проверим следующий вариант.
        }
    }

    // Если значение уже русское/готовое, localize вернёт его без изменений.
    return String(values[0] || '').trim();
}

const RACE_CATEGORY_WHITELIST = Object.freeze({
    kingdoms: Object.freeze([
        ['Человек'],
        ['Полуэльф'],
        ['Эльф высший'],
        ['Эльф лесной'],
        ['Эльф морской', 'Морской эльф'],
        ['Эльф тёмный (дроу)', 'Эльф темный (дроу)'],
        ['Полурослик крепкий'],
        ['Полурослик легконогий'],
        ['Полуорк'],
        ['Орк'],
        ['Дварф горный'],
        ['Дварф холмовой'],
        ['Дварф серый (двергар)', 'Дварф серый (дуэргар)'],
        ['Гном скальный'],
        ['Гном лесной'],
        ['Гном глубинный', 'Глубинный гном', 'Глубинный гном (свирфнеблин)'],
        ['Тифлинг Асмодея'],
        ['Тифлинг Мефистофеля'],
        ['Тифлинг Зариэли', 'Тифлинг Зариэль'],
        ['Драконорождённый', 'Драконорожденный']
    ]),
    beast: Object.freeze([
        ['Ааракокра'],
        ['Грунг'],
        ['Кенку'],
        ['Кицунэ'],
        ['Котовец — вольные когти', 'Котовец - вольные когти'],
        ['Леонин'],
        ['Людоворон'],
        ['Людокрыс'],
        ['Людомедведь (Серошкурые)'],
        ['Людоящер'],
        ['Мышинец — крыса', 'Мышинец - крыса'],
        ['Мышинец — полевая мышь', 'Мышинец - полевая мышь'],
        ['Кентавр'],
        ['Локсодон'],
        ['Склизыш'],
        ['Гифф', 'Гиффы', 'Giff'],
        ['Совлин', 'Owlin'],
        ['Табакси'],
        ['Тортл'],
        ['Юань-ти', 'Юань ти']
    ]),
    planar: Object.freeze([
        ['Аасимар-защитник', 'Аасимар защитник'],
        ['Аасимар-каратель', 'Аасимар каратель'],
        ['Аасимар-падший', 'Аасимар падший'],
        ['Гитзерай'],
        ['Гитьянки'],
        ['Дженази воды'],
        ['Дженази воздуха'],
        ['Дженази земли'],
        ['Дженази огня'],
        ['Калаштар']
    ]),
    unusual: Object.freeze([
        ['Ведалкен'],
        ['Гибрид Симиков'],
        ['Грацеза'],
        ['Древан'],
        ['Голиаф'],
        ['Гоблин'],
        ['Кобольд'],
        ['Изменяющийся (Чейнджлинг)', 'Изменяющийся (Чейджлинг)'],
        ['Кованый'],
        ['Липсик'],
        ['Локата'],
        ['Маген воин'],
        ['Маген мистик'],
        ['Минотавр'],
        ['Сатир'],
        ['Теневые феи'],
        ['Тритон'],
        ['Троллеобразные (Каменешкурый)'],
        ['Фирболг'],
        ['Фэйри (альт.)', 'Фейри (альт.)', 'Фэйри (альт)', 'Фейри (альт)'],
        ['Шифтер (Дикий охотник)'],
        ['Энтлинг']
    ]),
    death: Object.freeze([
        ['Дампир'],
        ['Возрождённый', 'Возрожденный', 'Reborn'],
        ['Кадавр'],
        ['Нежить: Мумия'],
        ['Нежить: Призрак'],
        ['Нежить: Ревенант'],
        ['Нежить: Скелет'],
        ['Нежить: Умертвие'],
        ['Нежить: Упырь'],
        ['Пустотный']
    ])
});

function normalizeRaceWhitelistKey(value) {
    let text = String(value || '').trim();

    // Убираем только книжный код в самом конце: (PHB), (XGE), (AAG) и т.п.
    // Содержательные скобки вроде "(дроу)" или "(Каменешкурый)" сохраняются.
    text = text.replace(/\s*\(([A-Z0-9][A-Z0-9&+.'’\- ]{1,24})\)\s*$/u, '');

    return text
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/<[^>]*>/gu, ' ')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
        .replace(/[’']/gu, '')
        .replace(/[–—]/gu, '-')
        .replace(/[^a-zа-я0-9]+/giu, '');
}

const RACE_WHITELIST_INDEX = (() => {
    const index = new Map();

    for (const [category, entries] of Object.entries(RACE_CATEGORY_WHITELIST)) {
        entries.forEach((aliases, order) => {
            for (const alias of aliases) {
                const key = normalizeRaceWhitelistKey(alias);
                if (key) index.set(key, { category, order });
            }
        });
    }

    return index;
})();

function getWhitelistedRaceInfo(option = {}) {
    const displayName = resolveRaceDisplayName(option);
    const key = normalizeRaceWhitelistKey(displayName);
    return RACE_WHITELIST_INDEX.get(key) || null;
}


function isVariantRaceOption(option = {}) {
    const raceDisplayName = String(option.raceDisplayName || resolveRaceDisplayName(option) || '');
    const machine = [
        raceDisplayName,
        option.displayName,
        option.name,
        option.uuid,
        option.identifier,
        option.system?.identifier
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/ё/gu, 'е');

    const approvedVariantFallback = new Set([
        normalizeRaceWhitelistKey('Эльф морской'),
        normalizeRaceWhitelistKey('Морской эльф'),
        normalizeRaceWhitelistKey('Гном глубинный'),
        normalizeRaceWhitelistKey('Глубинный гном'),
        normalizeRaceWhitelistKey('Глубинный гном (свирфнеблин)'),
        normalizeRaceWhitelistKey('Гифф'),
        normalizeRaceWhitelistKey('Гиффы'),
        normalizeRaceWhitelistKey('Giff'),
        normalizeRaceWhitelistKey('Совлин'),
        normalizeRaceWhitelistKey('Owlin'),
        normalizeRaceWhitelistKey('Возрождённый'),
        normalizeRaceWhitelistKey('Возрожденный'),
        normalizeRaceWhitelistKey('Reborn')
    ]);

    const displayKey = normalizeRaceWhitelistKey(raceDisplayName);
    if (approvedVariantFallback.has(displayKey)) return false;

    return machine.includes('.racesmpmm.')
        || /(?:^|[\s(])альт(?:\.|\)|\s|$)/iu.test(machine)
        || machine.includes('альтернатив')
        || machine.includes('вариатив')
        || machine.includes('variant');
}

function splitRaceDisplayWords(value) {
    const raw = String(value || '').trim();
    const key = normalizeRaceWhitelistKey(raw);

    // Ручные переносы для длинных цельных/дефисных названий.
    if (key === normalizeRaceWhitelistKey('Драконорождённый')) {
        return ['Драконо', 'рождённый'];
    }

    if (key === normalizeRaceWhitelistKey('Аасимар-защитник')
        || key === normalizeRaceWhitelistKey('Аасимар защитник')) {
        return ['Аасимар', 'защитник'];
    }

    if (key === normalizeRaceWhitelistKey('Аасимар-каратель')
        || key === normalizeRaceWhitelistKey('Аасимар каратель')) {
        return ['Аасимар', 'каратель'];
    }

    if (key === normalizeRaceWhitelistKey('Аасимар-падший')
        || key === normalizeRaceWhitelistKey('Аасимар падший')) {
        return ['Аасимар', 'падший'];
    }

    return raw
        .split(/\s+/u)
        .filter(Boolean)
        .filter(word => !/^[—–-]+$/u.test(word));
}


function splitBackgroundDisplayWords(value) {
    const raw = String(value || '').trim();
    const key = normalizeBackgroundCatalogText(raw);

    if (key === normalizeBackgroundCatalogText('Потерявшийся в Царстве Фей')) {
        return ['Потерявшийся в', 'Царстве', 'Фей'];
    }

    return raw
        .split(/\s+/u)
        .filter(Boolean)
        .filter(word => !/^[—–-]+$/u.test(word));
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
            let raceBeastOptions = [];
            let racePlanarOptions = [];
            let raceUnusualOptions = [];
            let raceDeathOptions = [];
            let backgroundGroups = [];

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

                // Для рас действует строгий белый список пользователя.
                // Всё, чего нет в таблице категорий, полностью исключается
                // из выбора ещё до построения UI.
                if (this.currentStep === 'race') {
                    const seenRaceNames = new Set();

                    currentOptions = currentOptions
                        .map(option => {
                            const raceDisplayName = resolveRaceDisplayName(option);
                            const normalizedOption = { ...option, raceDisplayName };
                            const whitelistInfo = getWhitelistedRaceInfo(normalizedOption);
                            if (!whitelistInfo) return null;

                            return {
                                ...normalizedOption,
                                raceCategory: whitelistInfo.category,
                                raceOrder: whitelistInfo.order,
                                raceDisplayWords: splitRaceDisplayWords(raceDisplayName)
                            };
                        })
                        .filter(Boolean)
                        .filter(option => !isVariantRaceOption(option))
                        .filter(option => {
                            const key = normalizeRaceWhitelistKey(option.raceDisplayName);
                            if (!key || seenRaceNames.has(key)) return false;
                            seenRaceNames.add(key);
                            return true;
                        });
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
                        .filter(option => !companionIds.has(option.id))
                        .sort((a, b) => {
                            const orderDiff = getUnofficialClassSortIndex(a) - getUnofficialClassSortIndex(b);
                            if (orderDiff !== 0) return orderDiff;

                            return String(a.classNavLabel || '').localeCompare(
                                String(b.classNavLabel || ''),
                                'ru'
                            );
                        });

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
                        beast: [],
                        planar: [],
                        unusual: [],
                        death: []
                    };

                    for (const option of currentOptions) {
                        const bucket = raceBuckets[option.raceCategory];
                        if (bucket) bucket.push(option);
                    }

                    for (const bucket of Object.values(raceBuckets)) {
                        bucket.sort((a, b) => (a.raceOrder ?? 999) - (b.raceOrder ?? 999));
                    }

                    raceKingdomOptions = raceBuckets.kingdoms;
                    raceBeastOptions = raceBuckets.beast;
                    racePlanarOptions = raceBuckets.planar;
                    raceUnusualOptions = raceBuckets.unusual;
                    raceDeathOptions = raceBuckets.death;
                }

                // Предыстории: строгий белый список из 80 записей.
                // Категория не выводится из названия/книги/ID — она задана явно выше.
                // После выбора конкретного Item строится реальная карта Item ID -> категория.
                if (this.currentStep === 'background') {
                    const {
                        selectedOptions,
                        backgroundIdCategoryMap,
                        missingNames
                    } = await buildExplicitBackgroundSelection(this.dataManager, currentOptions);

                    if (missingNames.length > 0 || selectedOptions.length !== BACKGROUND_REQUIRED_TOTAL) {
                        console.warn(
                            `Character Forge | Ожидалось ${BACKGROUND_REQUIRED_TOTAL} происхождений, найдено ${selectedOptions.length}. Отсутствуют:`,
                            missingNames
                        );
                    }

                    this._backgroundIdCategoryMap = backgroundIdCategoryMap;

                    backgroundGroups = BACKGROUND_CATEGORY_DEFINITIONS.map(category => ({
                        id: category.id,
                        title: category.title,
                        options: selectedOptions
                            .filter(option => backgroundIdCategoryMap.get(option.id)?.categoryId === category.id)
                            .sort((a, b) =>
                                (backgroundIdCategoryMap.get(a.id)?.order ?? 999)
                                - (backgroundIdCategoryMap.get(b.id)?.order ?? 999)
                            )
                    }));

                    currentOptions = selectedOptions;
                }

                // 批量检测视频格式
                currentOptions.forEach(opt => {
                    opt.heroImageIsVideo = isVideo(opt.heroImage);
                });

                // UUID — главный идентификатор выбора. _id может совпадать между
                // разными compendium, особенно у скопированных неофициальных материалов.
                const currentSelectedId = this.context[this.currentStep];
                const currentSelectedUuid = this.context[`${this.currentStep}Uuid`] || null;
                window.OriginateLog(`_prepareContext: currentStep=${this.currentStep}, selectedId=${currentSelectedId}, selectedUuid=${currentSelectedUuid}`);

                currentOptions.forEach(option => {
                    option.isCurrentSelection = currentSelectedUuid
                        ? option.uuid === currentSelectedUuid
                        : option.id === currentSelectedId;
                });

                if (currentSelectedId || currentSelectedUuid) {
                    let optionSummary = (currentSelectedUuid
                        ? currentOptions.find(o => o.uuid === currentSelectedUuid)
                        : null)
                        || currentOptions.find(o => o.id === currentSelectedId);
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
                currentSelectedUuid: this.context[`${this.currentStep}Uuid`] || null,
                steps: steps.filter(s => !s.hidden), // 过滤掉隐藏的步骤，别让用户看到不该看的
                options: currentOptions,
                officialClassOptions,
                alternativeClassOptions,
                unofficialClassOptions,
                companionClassOptions,
                raceKingdomOptions,
                raceBeastOptions,
                racePlanarOptions,
                raceUnusualOptions,
                raceDeathOptions,
                backgroundGroups,
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
            const selectedClass = (this.context.classUuid
                ? this.context.options.find(o => o.uuid === this.context.classUuid)
                : null)
                || this.context.options.find(o => o.id === this.context.class);
            if (selectedClass && selectedClass.subclassLevel !== undefined) {
                subclassLevel = selectedClass.subclassLevel;
            }
        } else if (this.context.availableClasses) {
            // 如果 в уровне, сначала ищем точный UUID, и только потом старый id.
            const selectedClass = (this.context.classUuid
                ? this.context.availableClasses.find(o => o.uuid === this.context.classUuid)
                : null)
                || this.context.availableClasses.find(o => o.id === this.context.class);
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
