export const DND5E_MAPPING = {
    // 属性映射
    // 力量、敏捷、体质……老生常谈了。
    // 为什么不能直接用中文做 key？
    abilities: {
        "力量": "str",
        "敏捷": "dex",
        "体质": "con",
        "智力": "int",
        "感知": "wis",
        "魅力": "cha"
    },
    // 技能映射
    // 18 个技能，每一个都要手动映射。
    // 好麻烦
    skills: {
        "运动": "ath",
        "体操": "acr",
        "巧手": "slt",
        "隐匿": "ste",
        "奥秘": "arc",
        "历史": "his",
        "调查": "inv",
        "自然": "nat",
        "宗教": "rel",
        "驯兽": "ani",
        "洞悉": "ins",
        "医药": "med",
        "察觉": "prc",
        "求生": "sur",
        "欺瞒": "dec",
        "威吓": "itm",
        "表演": "prf",
        "说服": "per"
    },
    // 熟练项映射
    // 盔甲、武器、工具……
    // 这里的分类逻辑简直是个谜。乐器和工匠工具是类别，盗贼工具却是单独一项？
    // 行吧，你说了算。
    proficiencies: {
        "轻甲": "lgt",
        "中甲": "med",
        "重甲": "hvy",
        "盾牌": "shl",
        "简易武器": "sim",
        "军用武器": "mar",
        "乐器": "music",
        "工匠工具": "art",
        "盗贼工具": "thief"
    },
    // 工匠工具 - 手艺人的家伙事儿
    artisanTools: {
        "alchemist": "ORIGINATE.Tool.Alchemist",
        "brewer": "ORIGINATE.Tool.Brewer",
        "calligrapher": "ORIGINATE.Tool.Calligrapher",
        "carpenter": "ORIGINATE.Tool.Carpenter",
        "cartographer": "ORIGINATE.Tool.Cartographer",
        "cobbler": "ORIGINATE.Tool.Cobbler",
        "cook": "ORIGINATE.Tool.Cook",
        "glassblower": "ORIGINATE.Tool.Glassblower",
        "jeweler": "ORIGINATE.Tool.Jeweler",
        "leatherworker": "ORIGINATE.Tool.Leatherworker",
        "mason": "ORIGINATE.Tool.Mason",
        "painter": "ORIGINATE.Tool.Painter",
        "potter": "ORIGINATE.Tool.Potter",
        "smith": "ORIGINATE.Tool.Smith",
        "tinker": "ORIGINATE.Tool.Tinker",
        "weaver": "ORIGINATE.Tool.Weaver",
        "woodcarver": "ORIGINATE.Tool.Woodcarver"
    },
    // 乐器 - 吟游诗人的吃饭家伙
    musicalInstruments: {
        "bagpipes": "ORIGINATE.Instrument.Bagpipes",
        "drum": "ORIGINATE.Instrument.Drum",
        "dulcimer": "ORIGINATE.Instrument.Dulcimer",
        "flute": "ORIGINATE.Instrument.Flute",
        "horn": "ORIGINATE.Instrument.Horn",
        "lute": "ORIGINATE.Instrument.Lute",
        "lyre": "ORIGINATE.Instrument.Lyre",
        "panflute": "ORIGINATE.Instrument.Panflute",
        "shawm": "ORIGINATE.Instrument.Shawm",
        "viol": "ORIGINATE.Instrument.Viol"
    },
    // 游戏套装 - 赌徒的最爱
    gamingSets: {
        "dice": "ORIGINATE.GamingSet.Dice",
        "card": "ORIGINATE.GamingSet.PlayingCard",
        "chess": "ORIGINATE.GamingSet.Dragonchess"
    },
    // 其他工具 - 剩下的都在这儿
    otherTools: {
        "disg": "ORIGINATE.Tool.Disguise",
        "forg": "ORIGINATE.Tool.Forgery",
        "herb": "ORIGINATE.Tool.Herbalism",
        "navg": "ORIGINATE.Tool.Navigator",
        "pois": "ORIGINATE.Tool.Poisoner",
        "thief": "ORIGINATE.Tool.Thieves",
        "vehicle": "ORIGINATE.Tool.Vehicle"
    },
    // Типы транспорта — отдельные дочерние значения Trait "tool:vehicle:*".
    vehicleTypes: {
        "air": "ORIGINATE.Vehicle.Air",
        "land": "ORIGINATE.Vehicle.Land",
        "space": "ORIGINATE.Vehicle.Space",
        "water": "ORIGINATE.Vehicle.Water"
    },
    // 职业主属性 - 决定你靠什么吃饭
    // 战士靠力量（或者敏捷，但我懒得写判断逻辑了，就当你是力量战士吧）。
    // 武僧靠敏捷和感知，但我只能选一个，所以……敏捷吧。
    classPrimaryAbilities: {
        "barbarian": "str",
        "bard": "cha",
        "cleric": "wis",
        "druid": "wis",
        "fighter": "str",
        "monk": "dex",
        "paladin": "str",
        "ranger": "dex",
        "rogue": "dex",
        "sorcerer": "cha",
        "warlock": "cha",
        "wizard": "int",
        "artificer": "int",
        "bloodhunter": "str"
    },

    // 武器列表 - 杀人越货必备
    // 这里的 key 是系统代码，value 是本地化 key。
    // 别问我为什么火器也在这里，也许你的世界里有枪呢？
    weapons: {
        // 简易近战武器
        "club": "ORIGINATE.Weapon.Club",
        "dagger": "ORIGINATE.Weapon.Dagger",
        "greatclub": "ORIGINATE.Weapon.Greatclub",
        "handaxe": "ORIGINATE.Weapon.Handaxe",
        "javelin": "ORIGINATE.Weapon.Javelin",
        "lighthammer": "ORIGINATE.Weapon.LightHammer",
        "mace": "ORIGINATE.Weapon.Mace",
        "quarterstaff": "ORIGINATE.Weapon.Quarterstaff",
        "sickle": "ORIGINATE.Weapon.Sickle",
        "spear": "ORIGINATE.Weapon.Spear",
        // 简易远程武器
        "lightcrossbow": "ORIGINATE.Weapon.LightCrossbow",
        "dart": "ORIGINATE.Weapon.Dart",
        "shortbow": "ORIGINATE.Weapon.Shortbow",
        "sling": "ORIGINATE.Weapon.Sling",
        // 军用近战武器
        "battleaxe": "ORIGINATE.Weapon.Battleaxe",
        "flail": "ORIGINATE.Weapon.Flail",
        "glaive": "ORIGINATE.Weapon.Glaive",
        "greataxe": "ORIGINATE.Weapon.Greataxe",
        "greatsword": "ORIGINATE.Weapon.Greatsword",
        "halberd": "ORIGINATE.Weapon.Halberd",
        "lance": "ORIGINATE.Weapon.Lance",
        "longsword": "ORIGINATE.Weapon.Longsword",
        "maul": "ORIGINATE.Weapon.Maul",
        "morningstar": "ORIGINATE.Weapon.Morningstar",
        "pike": "ORIGINATE.Weapon.Pike",
        "rapier": "ORIGINATE.Weapon.Rapier",
        "scimitar": "ORIGINATE.Weapon.Scimitar",
        "shortsword": "ORIGINATE.Weapon.Shortsword",
        "trident": "ORIGINATE.Weapon.Trident",
        "warpick": "ORIGINATE.Weapon.Warpick",
        "warhammer": "ORIGINATE.Weapon.Warhammer",
        "whip": "ORIGINATE.Weapon.Whip",
        // 军用远程武器
        "blowgun": "ORIGINATE.Weapon.Blowgun",
        "handcrossbow": "ORIGINATE.Weapon.HandCrossbow",
        "heavycrossbow": "ORIGINATE.Weapon.HeavyCrossbow",
        "longbow": "ORIGINATE.Weapon.Longbow",
        "net": "ORIGINATE.Weapon.Net",
        // 火器 (Firearms)
        "pistol": "ORIGINATE.Weapon.Pistol",
        "musket": "ORIGINATE.Weapon.Musket"
    }
};

const ABILITY_KEYS = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha']);

export function normalizeAbilityKey(value) {
    const key = String(value || '').trim().toLowerCase();
    return ABILITY_KEYS.has(key) ? key : null;
}

export function getClassPrimaryAbilityKey(classData = {}) {
    const system = classData.system || {};
    const spellcastingAbility = normalizeAbilityKey(system.spellcasting?.ability || classData.coreTraits?.spellcasting);
    if (spellcastingAbility) return spellcastingAbility;

    const identifier = String(system.identifier || classData.identifier || '').trim().toLowerCase();
    return normalizeAbilityKey(DND5E_MAPPING.classPrimaryAbilities?.[identifier]);
}

const LEGACY_TOOL_ID_ALIASES = {
    playing: 'card',
    playingcard: 'card',
    dragon: 'chess',
    dragonchess: 'chess'
};

/**
 * 把旧工具 key 收口成 dnd5e 5.3 现在真正认的短 key。
 *
 * 不先在这里揉平，UI、升级、回填就会各自记一套名字，
 * 最后出现“看着选了，写盘却没写进去”的诡异现象。
 *
 * @param {string} rawToolKey
 * @returns {string}
 */
export function normalizeToolId(rawToolKey) {
    const text = String(rawToolKey ?? '').trim().toLowerCase();
    if (!text) return '';

    const toolId = text.split(':').pop();
    return LEGACY_TOOL_ID_ALIASES[toolId] || toolId;
}

const SIMPLE_WEAPON_KEYS = [
    'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'lighthammer',
    'mace', 'quarterstaff', 'sickle', 'spear', 'lightcrossbow', 'dart',
    'shortbow', 'sling'
];

const MARTIAL_WEAPON_KEYS = [
    'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd',
    'lance', 'longsword', 'maul', 'morningstar', 'pike', 'rapier',
    'scimitar', 'shortsword', 'trident', 'warpick', 'warhammer', 'whip',
    'blowgun', 'handcrossbow', 'heavycrossbow', 'longbow', 'net',
    'pistol', 'musket'
];

function normalizeWeaponCategory(category) {
    if (category === 'simple') return 'sim';
    if (category === 'martial') return 'mar';
    if (category === 'sim' || category === 'mar') return category;
    return null;
}

export function getWeaponProficiencyCategory(weaponKey) {
    const text = String(weaponKey ?? '')
        .trim()
        .replace(/^weaponMastery:/i, '')
        .replace(/^weapon:/i, '')
        .toLowerCase();
    if (!text) return null;

    const weaponId = text.split(':').filter(Boolean).pop();
    if (!weaponId || weaponId === '*') return null;

    if (SIMPLE_WEAPON_KEYS.includes(weaponId)) return 'sim';
    if (MARTIAL_WEAPON_KEYS.includes(weaponId)) return 'mar';
    return null;
}

export function toNativeWeaponMasteryKey(rawKey, pools = []) {
    const text = String(rawKey ?? '').trim();
    if (!text) return null;

    const cleaned = text
        .replace(/^weaponMastery:/i, '')
        .replace(/^weapon:/i, '');
    const parts = cleaned.split(':').filter(Boolean).map(part => part.toLowerCase());
    if (!parts.length) return null;

    const leaf = parts[parts.length - 1];
    const first = parts[0];
    const explicitCategory = normalizeWeaponCategory(first);

    if (leaf === '*') {
        if (explicitCategory) return `weapon:${explicitCategory}:*`;
        return `weapon:${cleaned.toLowerCase()}`;
    }

    const weaponId = leaf;
    const actualCategory = getWeaponProficiencyCategory(weaponId);
    const poolCategories = new Set(
        pools
            .map(pool => String(pool ?? '').trim().replace(/^weapon:/i, '').toLowerCase().split(':').filter(Boolean))
            .filter(poolParts => poolParts.length >= 2 && poolParts[poolParts.length - 1] === '*')
            .map(poolParts => normalizeWeaponCategory(poolParts[0]))
            .filter(Boolean)
    );

    const category = explicitCategory || actualCategory;
    if (category && (!poolCategories.size || poolCategories.has(category))) {
        return `weapon:${category}:${weaponId}`;
    }

    return `weapon:${weaponId}`;
}

// 武器精通映射表
// 2024 版规则的新花样。每种武器都有个特殊动作。
// 我直接把中文写在这儿了，因为等系统加载完语言包，黄花菜都凉了。
// 这些翻译有一半是 AI 搞的，如果看到奇怪的词，别怪我，怪那个只会说漂亮话的机器人。
export const WEAPON_MASTERY_MAPPING = {
    "battleaxe": { label: "ORIGINATE.Weapon.Battleaxe", property: "ORIGINATE.WeaponMastery.Topple" },
    "blowgun": { label: "ORIGINATE.Weapon.Blowgun", property: "ORIGINATE.WeaponMastery.Vex" },
    "club": { label: "ORIGINATE.Weapon.Club", property: "ORIGINATE.WeaponMastery.Slow" },
    "dagger": { label: "ORIGINATE.Weapon.Dagger", property: "ORIGINATE.WeaponMastery.Nick" },
    "dart": { label: "ORIGINATE.Weapon.Dart", property: "ORIGINATE.WeaponMastery.Vex" },
    "flail": { label: "ORIGINATE.Weapon.Flail", property: "ORIGINATE.WeaponMastery.Sap" },
    "glaive": { label: "ORIGINATE.Weapon.Glaive", property: "ORIGINATE.WeaponMastery.Graze" },
    "greataxe": { label: "ORIGINATE.Weapon.Greataxe", property: "ORIGINATE.WeaponMastery.Cleave" },
    "greatclub": { label: "ORIGINATE.Weapon.Greatclub", property: "ORIGINATE.WeaponMastery.Push" },
    "greatsword": { label: "ORIGINATE.Weapon.Greatsword", property: "ORIGINATE.WeaponMastery.Graze" },
    "halberd": { label: "ORIGINATE.Weapon.Halberd", property: "ORIGINATE.WeaponMastery.Cleave" },
    "handaxe": { label: "ORIGINATE.Weapon.Handaxe", property: "ORIGINATE.WeaponMastery.Vex" },
    "handcrossbow": { label: "ORIGINATE.Weapon.HandCrossbow", property: "ORIGINATE.WeaponMastery.Vex" },
    "heavycrossbow": { label: "ORIGINATE.Weapon.HeavyCrossbow", property: "ORIGINATE.WeaponMastery.Push" },
    "javelin": { label: "ORIGINATE.Weapon.Javelin", property: "ORIGINATE.WeaponMastery.Slow" },
    "lance": { label: "ORIGINATE.Weapon.Lance", property: "ORIGINATE.WeaponMastery.Topple" },
    "lightcrossbow": { label: "ORIGINATE.Weapon.LightCrossbow", property: "ORIGINATE.WeaponMastery.Slow" },
    "lighthammer": { label: "ORIGINATE.Weapon.LightHammer", property: "ORIGINATE.WeaponMastery.Nick" },
    "longbow": { label: "ORIGINATE.Weapon.Longbow", property: "ORIGINATE.WeaponMastery.Slow" },
    "longsword": { label: "ORIGINATE.Weapon.Longsword", property: "ORIGINATE.WeaponMastery.Sap" },
    "mace": { label: "ORIGINATE.Weapon.Mace", property: "ORIGINATE.WeaponMastery.Sap" },
    "maul": { label: "ORIGINATE.Weapon.Maul", property: "ORIGINATE.WeaponMastery.Topple" },
    "morningstar": { label: "ORIGINATE.Weapon.Morningstar", property: "ORIGINATE.WeaponMastery.Sap" },
    "musket": { label: "ORIGINATE.Weapon.Musket", property: "ORIGINATE.WeaponMastery.Slow" },
    "pike": { label: "ORIGINATE.Weapon.Pike", property: "ORIGINATE.WeaponMastery.Push" },
    "pistol": { label: "ORIGINATE.Weapon.Pistol", property: "ORIGINATE.WeaponMastery.Vex" },
    "quarterstaff": { label: "ORIGINATE.Weapon.Quarterstaff", property: "ORIGINATE.WeaponMastery.Topple" },
    "rapier": { label: "ORIGINATE.Weapon.Rapier", property: "ORIGINATE.WeaponMastery.Vex" },
    "scimitar": { label: "ORIGINATE.Weapon.Scimitar", property: "ORIGINATE.WeaponMastery.Nick" },
    "shortbow": { label: "ORIGINATE.Weapon.Shortbow", property: "ORIGINATE.WeaponMastery.Vex" },
    "shortsword": { label: "ORIGINATE.Weapon.Shortsword", property: "ORIGINATE.WeaponMastery.Vex" },
    "sickle": { label: "ORIGINATE.Weapon.Sickle", property: "ORIGINATE.WeaponMastery.Nick" },
    "sling": { label: "ORIGINATE.Weapon.Sling", property: "ORIGINATE.WeaponMastery.Slow" },
    "spear": { label: "ORIGINATE.Weapon.Spear", property: "ORIGINATE.WeaponMastery.Sap" },
    "trident": { label: "ORIGINATE.Weapon.Trident", property: "ORIGINATE.WeaponMastery.Topple" },
    "warpick": { label: "ORIGINATE.Weapon.Warpick", property: "ORIGINATE.WeaponMastery.Sap" },
    "warhammer": { label: "ORIGINATE.Weapon.Warhammer", property: "ORIGINATE.WeaponMastery.Push" },
    "whip": { label: "ORIGINATE.Weapon.Whip", property: "ORIGINATE.WeaponMastery.Slow" },
    "net": { label: "ORIGINATE.Weapon.Net", property: "ORIGINATE.WeaponMastery.None" }
};

/**
 * 翻译工具名称
 * 
 * 给我一个 key，我给你一个人类能看懂的名字。
 * 我得遍历所有的工具列表才能找到它。效率？别跟我谈效率。
 * 
 * @param {string} toolKey - 那个晦涩难懂的代码
 * @returns {string} 人话
 */
export function getToolLabel(toolKey) {
    const rawKey = String(toolKey ?? '').trim().toLowerCase();
    const parts = rawKey.split(':').filter(Boolean);
    const normalizedKey = normalizeToolId(rawKey);

    const vehicleType = parts.includes('vehicle')
        ? parts[parts.length - 1]
        : (DND5E_MAPPING.vehicleTypes[normalizedKey] ? normalizedKey : null);
    if (vehicleType && DND5E_MAPPING.vehicleTypes[vehicleType]) {
        return game.i18n.localize(DND5E_MAPPING.vehicleTypes[vehicleType]);
    }

    if (DND5E_MAPPING.artisanTools[normalizedKey]) {
        return game.i18n.localize(DND5E_MAPPING.artisanTools[normalizedKey]);
    }
    if (DND5E_MAPPING.musicalInstruments[normalizedKey]) {
        return game.i18n.localize(DND5E_MAPPING.musicalInstruments[normalizedKey]);
    }
    if (DND5E_MAPPING.gamingSets[normalizedKey]) {
        return game.i18n.localize(DND5E_MAPPING.gamingSets[normalizedKey]);
    }
    if (DND5E_MAPPING.otherTools[normalizedKey]) {
        return game.i18n.localize(DND5E_MAPPING.otherTools[normalizedKey]);
    }

    return normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1).replace(/([A-Z])/g, ' $1');
}

/**
 * 按类别批发工具
 * 
 * 你要所有的乐器？行，给你打包。
 * 
 * @param {string} category - 类别 (art, music, game)
 * @returns {Array} 工具列表
 */
export function getToolsByCategory(category) {
    const results = [];
    
    if (category === 'art' || category === 'artisan') {
        for (const [key, label] of Object.entries(DND5E_MAPPING.artisanTools)) {
            results.push({ key: `tool:${key}`, label: game.i18n.localize(label) });
        }
    } else if (category === 'music' || category === 'musical') {
        for (const [key, label] of Object.entries(DND5E_MAPPING.musicalInstruments)) {
            results.push({ key: `tool:${key}`, label: game.i18n.localize(label) });
        }
    } else if (category === 'game' || category === 'gaming') {
        for (const [key, label] of Object.entries(DND5E_MAPPING.gamingSets)) {
            results.push({ key: `tool:${key}`, label: game.i18n.localize(label) });
        }
    } else if (category === 'vehicle') {
        for (const [key, label] of Object.entries(DND5E_MAPPING.vehicleTypes)) {
            results.push({ key: `tool:vehicle:${key}`, label: game.i18n.localize(label) });
        }
    }
    
    return results;
}

// 武器中文名称映射表
// 又是硬编码。为了解决那个该死的“本地化时机”问题。
// 如果系统还没准备好，我就只能自己动手丰衣足食了。
export const WEAPON_LABELS = {
    // 简易近战武器
    "club": "ORIGINATE.Weapon.Club",
    "dagger": "ORIGINATE.Weapon.Dagger",
    "greatclub": "ORIGINATE.Weapon.Greatclub",
    "handaxe": "ORIGINATE.Weapon.Handaxe",
    "javelin": "ORIGINATE.Weapon.Javelin",
    "lighthammer": "ORIGINATE.Weapon.LightHammer",
    "mace": "ORIGINATE.Weapon.Mace",
    "quarterstaff": "ORIGINATE.Weapon.Quarterstaff",
    "sickle": "ORIGINATE.Weapon.Sickle",
    "spear": "ORIGINATE.Weapon.Spear",
    // 简易远程武器
    "lightcrossbow": "ORIGINATE.Weapon.LightCrossbow",
    "dart": "ORIGINATE.Weapon.Dart",
    "shortbow": "ORIGINATE.Weapon.Shortbow",
    "sling": "ORIGINATE.Weapon.Sling",
    // 军用近战武器
    "battleaxe": "ORIGINATE.Weapon.Battleaxe",
    "flail": "ORIGINATE.Weapon.Flail",
    "glaive": "ORIGINATE.Weapon.Glaive",
    "greataxe": "ORIGINATE.Weapon.Greataxe",
    "greatsword": "ORIGINATE.Weapon.Greatsword",
    "halberd": "ORIGINATE.Weapon.Halberd",
    "lance": "ORIGINATE.Weapon.Lance",
    "longsword": "ORIGINATE.Weapon.Longsword",
    "maul": "ORIGINATE.Weapon.Maul",
    "morningstar": "ORIGINATE.Weapon.Morningstar",
    "pike": "ORIGINATE.Weapon.Pike",
    "rapier": "ORIGINATE.Weapon.Rapier",
    "scimitar": "ORIGINATE.Weapon.Scimitar",
    "shortsword": "ORIGINATE.Weapon.Shortsword",
    "trident": "ORIGINATE.Weapon.Trident",
    "warpick": "ORIGINATE.Weapon.Warpick",
    "warhammer": "ORIGINATE.Weapon.Warhammer",
    "whip": "ORIGINATE.Weapon.Whip",
    // 军用远程武器
    "blowgun": "ORIGINATE.Weapon.Blowgun",
    "handcrossbow": "ORIGINATE.Weapon.HandCrossbow",
    "heavycrossbow": "ORIGINATE.Weapon.HeavyCrossbow",
    "longbow": "ORIGINATE.Weapon.Longbow",
    "net": "ORIGINATE.Weapon.Net",
    // 火器
    "pistol": "ORIGINATE.Weapon.Pistol",
    "musket": "ORIGINATE.Weapon.Musket"
};

/**
 * 把武器熟练 key 拆成武器精通过滤能看懂的形式。
 *
 * 5e 这边的 key 有时候是 `mar`，有时候是 `mar:rapier`，
 * 还有时候是完整的 `weapon:martial:rapier`。
 * 不先揉平，UI 很容易当场装傻。
 *
 * @param {string} rawKey
 * @returns {string[]}
 */
export function expandWeaponProficiency(rawKey) {
    const text = String(rawKey ?? '').trim().toLowerCase();
    if (!text) return [];

    const cleaned = text
        .replace(/^weaponmastery:/, '')
        .replace(/^weapon:/, '');

    const parts = cleaned.split(':').filter(Boolean);
    if (parts.length === 0) return [];

    const head = parts[0];
    const results = new Set();
    const addCategory = (primary, secondary, weapons) => {
        results.add(primary);
        results.add(secondary);

        const tail = parts[parts.length - 1];
        if (parts.length > 1 && tail !== '*' && tail !== head) {
            results.add(tail);
            return;
        }

        weapons.forEach(weapon => results.add(weapon));
    };

    if (head === 'sim' || head === 'simple') {
        addCategory('sim', 'simple', SIMPLE_WEAPON_KEYS);
        return Array.from(results);
    }

    if (head === 'mar' || head === 'martial') {
        addCategory('mar', 'martial', MARTIAL_WEAPON_KEYS);
        return Array.from(results);
    }

    results.add(parts[parts.length - 1]);
    return Array.from(results);
}

/**
 * 翻译武器名称
 * 
 * 这个函数比看起来要复杂。
 * 我得处理前缀、大小写、空格，还要在多个映射表里查找。
 * 为了让你看到 "长剑" 而不是 "longsword"，我可是操碎了心。
 * 
 * @param {string} weaponKey - 武器代码
 * @returns {string} 武器名称
 */
export function getWeaponLabel(weaponKey) {
    // 先把那些烦人的前缀去掉
    const rawKey = String(weaponKey ?? '');
    const cleanKey = rawKey.replace(/^weapon:/, '').replace(/^weaponMastery:/, '').toLowerCase().split(':').pop();
    if (!cleanKey) return rawKey;
    
    // 查表
    if (WEAPON_LABELS[cleanKey]) {
        return game.i18n.localize(WEAPON_LABELS[cleanKey]);
    }
    
    // 模糊匹配。因为总有人喜欢把 "Light Crossbow" 写成 "lightcrossbow"。
    const normalizedKey = cleanKey.replace(/\s+/g, '').toLowerCase();
    for (const [key, label] of Object.entries(WEAPON_LABELS)) {
        if (key.toLowerCase() === normalizedKey || 
            key.replace(/\s+/g, '').toLowerCase() === normalizedKey) {
            return game.i18n.localize(label);
        }
    }
    
    // 还没找到？试试系统的映射表。
    if (DND5E_MAPPING.weapons[cleanKey]) {
        try {
            const localized = game.i18n.localize(DND5E_MAPPING.weapons[cleanKey]);
            if (localized && localized !== DND5E_MAPPING.weapons[cleanKey]) {
                return localized;
            }
        } catch (e) {
            // 算了，当我没说。
        }
    }
    
    // 彻底放弃。直接把 key 给你看吧。
    return rawKey.charAt(0).toUpperCase() + rawKey.slice(1).replace(/([A-Z])/g, ' $1');
}

/**
 * 获取武器精通详情
 * 
 * 告诉你这把武器有什么特殊技巧。
 * 比如战斧能把人击倒（Topple）。
 * 
 * @param {string} weaponKey - 武器代码
 * @returns {Object} { label: 名称, desc: 效果 }
 */
export function getWeaponMasteryInfo(weaponKey) {
    const cleanKey = weaponKey.replace(/^weaponMastery:/, '').toLowerCase();
    const info = WEAPON_MASTERY_MAPPING[cleanKey];
    
    if (info) {
        // label 已经是中文字符串，直接返回
        return {
            label: game.i18n.localize(info.label),
            desc: game.i18n.localize(info.property)
        };
    }
    
    // 回退
    return {
        label: getWeaponLabel(cleanKey),
        desc: ""
    };
}

/**
 * 批发所有武器
 * 
 * 给你一个包含所有武器的列表。
 * 别拿去干坏事。
 * 
 * @returns {Array} 武器列表
 */
export function getAllWeapons() {
    const results = [];
    for (const [key, label] of Object.entries(DND5E_MAPPING.weapons)) {
        results.push({ key: `weapon:${key}`, label: game.i18n.localize(label) });
    }
    return results;
}

/**
 * 批发所有武器精通
 * 
 * 跟上面那个差不多，只不过 key 带了个 "weaponMastery:" 前缀。
 * 
 * @returns {Array} 精通列表
 */
export function getWeaponMasteryOptions() {
    const results = [];
    for (const [key, label] of Object.entries(DND5E_MAPPING.weapons)) {
        results.push({ key: `weaponMastery:${key}`, label: game.i18n.localize(label) });
    }
    return results;
}
