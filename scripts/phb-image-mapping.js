/**
 * PHB 图片映射模块 - 也就是咱的“颜值协会”
 * 
 * 听着，只要你装了 dnd-players-handbook 模块，我就能帮你把那些丑得掉渣的默认图标
 * 换成高清大图。职业、子职、背景、种族……统统给它们“整整容”。
 * 
 * 别问我为什么折腾这个，问就是颜值即正义。谁也不想盯着一张像草稿一样的角色卡看一整晚。
 * 支持自定义路径，但你要是把路带歪了结果满屏破图，我也只能双手一摊了。
 * 
 * - Adrian
 */

/**
 * 获取 PHB 图片基础路径
 * 
 * 从设置里读路径。要是读不到，咱就默认它在老位置。
 * 文件夹名字别乱改啊，我可没那闲工夫去玩什么“猜猜看”的游戏。
 * 
 * @returns {string} 图片路径，或者我的猜测
 */
function getPHBArtPath() {
    try {
        if (typeof game !== 'undefined' && game.settings) {
            return game.settings.get('character-forge', 'phbImageFolder') || 'modules/dnd-players-handbook/assets/journal-art';
        }
    } catch (e) {
        // 设置未注册时使用默认值
    }
    return 'modules/dnd-players-handbook/assets/journal-art';
}

/**
 * 获取自定义图片配置
 * 
 * 想要与众不同？行吧，这里是你自定义的图片配置。
 * 如果你没配置，我就给你个空对象，别指望我会凭空变出图片来。
 * 
 * 这个功能终于派上用场了！用户可以在配置界面里为每个职业、种族、背景、子职
 * 设置自定义的展示图片。自定义图片的优先级最高，比 PHB 图片还高。
 * 
 * @returns {Object} 自定义配置对象
 */
function getCustomImages() {
    try {
        if (typeof game !== 'undefined' && game.settings) {
            return game.settings.get('character-forge', 'customImages') || { class: {}, race: {}, background: {}, subclass: {} };
        }
    } catch (e) {
        // 设置未注册时使用默认值
    }
    return { class: {}, race: {}, background: {}, subclass: {} };
}

export function normalizeCustomImageFit(fit) {
    return fit === 'cover' ? 'cover' : 'contain';
}

export function normalizeCustomImageEntry(entry) {
    if (typeof entry === 'string') {
        return entry ? { path: entry, fit: 'contain' } : null;
    }

    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
        return null;
    }

    return {
        path: entry.path,
        fit: normalizeCustomImageFit(entry.fit)
    };
}

function normalizeCustomImages(customImages = {}) {
    const normalizeType = entries => Object.fromEntries(
        Object.entries(entries || {})
            .map(([uuid, entry]) => [uuid, normalizeCustomImageEntry(entry)])
            .filter(([, entry]) => !!entry)
    );

    return {
        class: normalizeType(customImages.class),
        race: normalizeType(customImages.race),
        background: normalizeType(customImages.background),
        subclass: normalizeType(customImages.subclass)
    };
}

/**
 * 获取自定义图片
 * 
 * Adrian: 这是自定义图片的核心查找函数。
 * 我们用 UUID 作为键来存储和查找自定义图片，因为 UUID 是唯一的。
 * 如果找不到，就返回 null，让后续逻辑去找 PHB 图片或默认图片。
 * 
 * @param {string} type - 类型: 'class', 'race', 'background', 'subclass'
 * @param {string} uuid - Item 的 UUID
 * @returns {string|null} 自定义图片路径，或 null
 */
export function getCustomImage(type, uuid) {
    return getCustomImageConfig(type, uuid)?.path || null;
}

export function getCustomImageConfig(type, uuid) {
    if (!uuid) return null;

    const customImages = getCustomImages();
    return normalizeCustomImageEntry(customImages[type]?.[uuid]);
}

/**
 * 设置自定义图片
 * 
 * Adrian: 保存用户设置的自定义图片。
 * 如果 imagePath 为空或 null，就删除这个配置（恢复默认）。
 * 
 * @param {string} type - 类型: 'class', 'race', 'background', 'subclass'
 * @param {string} uuid - Item 的 UUID
 * @param {string|null} imagePath - 图片路径，或 null 表示删除
 * @param {'contain'|'cover'} fit - 完整适配或裁切填充
 */
export async function setCustomImage(type, uuid, imagePath, fit = 'contain') {
    if (!uuid || !type) return;

    const customImages = getCustomImages();

    if (!customImages[type]) {
        customImages[type] = {};
    }

    if (imagePath) {
        customImages[type][uuid] = {
            path: imagePath,
            fit: normalizeCustomImageFit(fit)
        };
        window.OriginateLog(`设置自定义图片: ${type}/${uuid} -> ${imagePath}`);
    } else {
        delete customImages[type][uuid];
        window.OriginateLog(`删除自定义图片: ${type}/${uuid}`);
    }

    await game.settings.set('character-forge', 'customImages', customImages);
}

/**
 * 检查是否有自定义图片
 * 
 * @param {string} type - 类型
 * @param {string} uuid - UUID
 * @returns {boolean}
 */
export function hasCustomImage(type, uuid) {
    return !!getCustomImage(type, uuid);
}

/**
 * 获取所有自定义图片配置
 * 
 * Adrian: 这个函数用于导出设置时获取完整的自定义图片配置。
 * 返回的是一个深拷贝，防止外部修改影响内部状态。
 * 
 * @returns {Object} 完整的自定义图片配置对象
 */
export function getAllCustomImages() {
    return normalizeCustomImages(getCustomImages());
}

/**
 * 设置所有自定义图片配置
 * 
 * Adrian: 这个函数用于导入设置时批量设置自定义图片配置。
 * 会完全覆盖现有的配置，所以使用时要小心。
 * 
 * @param {Object} customImages - 完整的自定义图片配置对象
 */
export async function setAllCustomImages(customImages) {
    if (!customImages || typeof customImages !== 'object') {
        console.warn('Originate | setAllCustomImages: 无效的配置对象');
        return;
    }

    // 旧导出里只有路径字符串，这里一并抬成新结构，导入后就不用留两套分支了
    const validatedConfig = normalizeCustomImages(customImages);

    window.OriginateLog(`批量设置自定义图片配置:`, validatedConfig);
    await game.settings.set('character-forge', 'customImages', validatedConfig);
}

/**
 * 职业图片映射表
 * 
 * 这是一个纯搬砖的列表，把系统里的 ID 和图片文件名强行对上号。
 * 这一大张表对得我眼冒金星。
 * 看来老子确实该去眯一会儿了，或者玩几把海克斯乱斗，我好想玩一板一眼杰斯啊
 * 
 * 法师那张图叫 "human-wizards-fends-off-peril.webp"？
 * 哇哦，文件名比我的代码还长。
 */
export const CLASS_IMAGES = {
    barbarian: 'barbarian.webp',
    bard: 'bard.webp',
    cleric: 'cleric.webp',
    druid: 'druid.webp',
    fighter: 'fighter.webp',
    monk: 'monk.webp',
    paladin: 'paladin.webp',
    ranger: 'ranger.webp',
    rogue: 'rogue.webp',
    sorcerer: 'sorcerer.webp',
    warlock: 'warlock.webp',
    wizard: 'wizard.webp' // 我说怎么只看到一张法师图片，原来我多打了一个“s”。这种低级错误简直是耻辱。
};

/**
 * 艾伯伦职业图片映射表
 * 目前只有奇械师一个，但谁知道以后会不会加更多呢。
 */
export const EBERRON_CLASS_IMAGES = {
    'artificer': 'artificer.webp'
};

/**
 * 子职图片映射表
 * 
 * 更多的映射。天哪，这简直是体力活。
 * 每一个子职都要对应一张图。如果哪天官方改了 ID，我就得回来修这个表。
 * 真是令人期待（棒读）。
 */
export const SUBCLASS_IMAGES = {
    // 野蛮人子职
    'path-of-the-berserker': 'path-of-the-berserker.webp',
    'berserker': 'path-of-the-berserker.webp',
    'path-of-the-wild-heart': 'path-of-the-wild-heart.webp',
    'wild-heart': 'path-of-the-wild-heart.webp',
    'totem-warrior': 'path-of-the-wild-heart.webp', // 旧版名称
    'path-of-the-world-tree': 'path-of-the-world-tree.webp',
    'world-tree': 'path-of-the-world-tree.webp',
    'path-of-the-zealot': 'path-of-the-zealot.webp',
    'zealot': 'path-of-the-zealot.webp',

    // 吟游诗人子职
    'college-of-dance': 'college-of-dance.webp',
    'dance': 'college-of-dance.webp',
    'college-of-glamour': 'college-of-glamour.webp',
    'glamour': 'college-of-glamour.webp',
    'college-of-lore': 'college-of-lore.webp',
    'lore': 'college-of-lore.webp',
    'college-of-valor': 'college-of-valor.webp',
    'valor': 'college-of-valor.webp',

    // 牧师子职 (领域)
    'life-domain': 'life-domain.webp',
    'life': 'life-domain.webp',
    'light-domain': 'light-domain.webp',
    'light': 'light-domain.webp',
    'trickery-domain': 'trickery-domain.webp',
    'trickery': 'trickery-domain.webp',
    'war-domain': 'war-domain.webp',
    'war': 'war-domain.webp',

    // 德鲁伊子职 (结社)
    'circle-of-the-land': 'circle-of-the-land.webp',
    'land': 'circle-of-the-land.webp',
    'circle-of-the-moon': 'circle-of-the-moon.webp',
    'moon': 'circle-of-the-moon.webp',
    'circle-of-the-sea': 'circle-of-the-sea.webp',
    'sea': 'circle-of-the-sea.webp',
    'circle-of-the-stars': 'circle-of-the-stars.webp',
    'stars': 'circle-of-the-stars.webp',

    // 战士子职
    'battle-master': 'battle-master.webp',
    'battlemaster': 'battle-master.webp',
    'champion': 'champion.webp',
    'eldritch-knight': 'eldritch-knight.webp',
    'eldritchknight': 'eldritch-knight.webp',
    'psi-warrior': 'psi-warrior.webp',
    'psiwarrior': 'psi-warrior.webp',

    // 武僧子职
    'warrior-of-mercy': 'warrior-of-mercy.webp',
    'mercy': 'warrior-of-mercy.webp',
    'way-of-mercy': 'warrior-of-mercy.webp',
    'warrior-of-shadow': 'warrior-of-shadow.webp',
    'shadow': 'warrior-of-shadow.webp',
    'way-of-shadow': 'warrior-of-shadow.webp',
    'warrior-of-the-elements': 'warrior-of-the-elements.webp',
    'elements': 'warrior-of-the-elements.webp',
    'way-of-the-four-elements': 'warrior-of-the-elements.webp',
    'four-elements': 'warrior-of-the-elements.webp',
    'warrior-of-the-open-hand': 'warrior-of-the-open-mind.webp',
    'open-hand': 'warrior-of-the-open-mind.webp',
    'way-of-the-open-hand': 'warrior-of-the-open-mind.webp',

    // 圣武士子职 (誓言)
    'oath-of-devotion': 'oath-of-devotion.webp',
    'devotion': 'oath-of-devotion.webp',
    'oath-of-glory': 'oath-of-glory.webp',
    'glory': 'oath-of-glory.webp',
    'oath-of-the-ancients': 'oath-of-the-ancients.webp',
    'ancients': 'oath-of-the-ancients.webp',
    'oath-of-vengeance': 'oath-of-vengeance.webp',
    'vengeance': 'oath-of-vengeance.webp',

    // 游侠子职
    'beast-master': 'beast-master.webp',
    'beastmaster': 'beast-master.webp',
    'fey-wanderer': 'fey-wanderer.webp',
    'feywanderer': 'fey-wanderer.webp',
    'gloom-stalker': 'gloom-stalker.webp',
    'gloomstalker': 'gloom-stalker.webp',
    'hunter': 'hunter.webp',

    // 游荡者子职
    'arcane-trickster': 'arcane-trickster.webp',
    'arcanetrickster': 'arcane-trickster.webp',
    'assassin': 'assassin.webp',
    'soulknife': 'soulknife.webp',
    'thief': 'thief.webp',

    // 术士子职 (血脉)
    'aberrant-mind': 'aberrant.webp',
    'aberrant': 'aberrant.webp',
    'clockwork-soul': 'clockwork.webp',
    'clockwork': 'clockwork.webp',
    'draconic-bloodline': 'draconic.webp',
    'draconic': 'draconic.webp',
    'wild-magic': 'wild-magic.webp',
    'wildmagic': 'wild-magic.webp',

    // 邪术师子职 (宗主)
    'archfey': 'archfey.webp',
    'the-archfey': 'archfey.webp',
    'celestial': 'celestial.webp',
    'the-celestial': 'celestial.webp',
    'fiend': 'fiend.webp',
    'the-fiend': 'fiend.webp',
    'great-old-one': 'great-old-one.webp',
    'the-great-old-one': 'great-old-one.webp',
    'greatoldone': 'great-old-one.webp',

    // 法师子职 (学派)
    'abjuration': 'abjurer.webp',
    'abjurer': 'abjurer.webp',
    'school-of-abjuration': 'abjurer.webp',
    'divination': 'diviner.webp',
    'diviner': 'diviner.webp',
    'school-of-divination': 'diviner.webp',
    'evocation': 'evoker.webp',
    'evoker': 'evoker.webp',
    'school-of-evocation': 'evoker.webp',
    'illusion': 'illusionist.webp',
    'illusionist': 'illusionist.webp',
    'school-of-illusion': 'illusionist.webp'
};

/**
 * 艾伯伦子职图片映射表
 * 奇械师的五个子职，每个都有对应的高清插画。
 */
export const EBERRON_SUBCLASS_IMAGES = {
    'alchemist': 'alchemist-demonstrating.webp',
    'armorer': 'armorer-donning-armor.webp',
    'artillerist': 'artillerist-with-weapon.webp',
    'battle-smith': 'battle-smith.webp',
    'battlesmith': 'battle-smith.webp',
    'cartographer': 'cartographer-painting-in-air.webp'
};

/**
 * 背景图片映射表
 * 
 * 你的角色以前是干嘛的？这里有对应的图片。
 * 哪怕你以前是个骗子（charlatan），我也能给你找张像模像样的图。
 */
export const BACKGROUND_IMAGES = {
    'acolyte': 'acolyte-origin.webp',
    'artisan': 'artisan-origin.webp',
    'charlatan': 'charlatan-origin.webp',
    'criminal': 'criminal-origin.webp',
    'entertainer': 'entertainer-origin.webp',
    'farmer': 'farmer-origin.webp',
    'guard': 'guard-origin.webp',
    'hermit': 'hermit.webp',
    'merchant': 'merchant.webp',
    'noble': 'noble.webp',
    'sage': 'sage.webp',
    'sailor': 'sailor.webp',
    'scribe': 'scribe.webp',
    'soldier': 'soldier.webp',
    'wayfarer': 'wayfarer.webp',
    'guide': 'guide.webp'
};

/**
 * 艾伯伦背景图片映射表
 * 龙印家族继承人、考古学家、家族特工……艾伯伦特有的背景故事。
 */
export const EBERRON_BACKGROUND_IMAGES = {
    'aberrant-heir': 'aberrant-heir.webp',
    'archaeologist': 'archaeologist.webp',
    'house-agent': 'house-agent.webp',
    'house-cannith-heir': 'house-cannith-heir.webp',
    'house-deneith-heir': 'house-deneith-heir.webp',
    'house-ghallanda-heir': 'house-ghallanda-heir.webp',
    'house-jorasco-heir': 'house-jorasco-heir.webp',
    'house-kundarak-heir': 'house-kundarak-heir.webp',
    'house-lyrandar-heir': 'house-lyrandar-heir.webp',
    'house-medani-heir': 'house-medani-heir.webp',
    'house-orien-heir': 'house-orien-heir.webp',
    'house-phiarlan-heir': 'house-phiarlan-heir.webp',
    'house-sivis-heir': 'house-sivis-heir.webp',
    'house-tharashk-heir': 'house-tharashk-heir.webp',
    'house-thuranni-heir': 'house-thuranni-heir.webp',
    'house-vadalis-heir': 'house-vadalis-heir.webp',
    'inquisitive': 'inquisitive.webp'
};

/**
 * 种族图片映射表
 * 
 * 各种奇形怪状的生物都在这儿了。帝皇在上，我自己开团都只开人类来着
 * 龙裔、精灵、矮人。
 * 别担心，我会尽量把它们归类好，虽然这工作量简直是在谋杀我的脑细胞。
 */
export const RACE_IMAGES = {
    // 基础种族
    'aasimar': 'aasimar-working.webp',
    'dragonborn': 'dragonborn-meeting.webp',
    'dwarf': 'dwarves-working.webp',
    'elf': 'elves-socializing.webp',
    'gnome': 'gnomes-working-on-armor.webp',
    'goliath': 'goliaths-transporting-stone.webp',
    'halfling': 'halflings-dining.webp',
    'human': 'humans-celebrate.webp',
    'orc': 'orcs-riding.webp',
    'tiefling': 'tieflings-playing-cards.webp',

    // 龙裔亚种 - 全部使用龙裔图片
    'black-dragonborn': 'dragonborn-meeting.webp',
    'blue-dragonborn': 'dragonborn-meeting.webp',
    'brass-dragonborn': 'dragonborn-meeting.webp',
    'bronze-dragonborn': 'dragonborn-meeting.webp',
    'copper-dragonborn': 'dragonborn-meeting.webp',
    'gold-dragonborn': 'dragonborn-meeting.webp',
    'green-dragonborn': 'dragonborn-meeting.webp',
    'red-dragonborn': 'dragonborn-meeting.webp',
    'silver-dragonborn': 'dragonborn-meeting.webp',
    'white-dragonborn': 'dragonborn-meeting.webp',
    'chromatic-dragonborn': 'dragonborn-meeting.webp',
    'metallic-dragonborn': 'dragonborn-meeting.webp',
    'gem-dragonborn': 'dragonborn-meeting.webp',

    // 精灵亚种 - 全部使用精灵图片
    'high-elf': 'elves-socializing.webp',
    'wood-elf': 'elves-socializing.webp',
    'drow': 'elves-socializing.webp',
    'dark-elf': 'elves-socializing.webp',
    'eladrin': 'elves-socializing.webp',
    'sea-elf': 'elves-socializing.webp',
    'shadar-kai': 'elves-socializing.webp',
    'half-elf': 'elves-socializing.webp',

    // 矮人亚种 - 全部使用矮人图片
    'hill-dwarf': 'dwarves-working.webp',
    'mountain-dwarf': 'dwarves-working.webp',
    'duergar': 'dwarves-working.webp',

    // 侏儒亚种 - 全部使用侏儒图片
    'forest-gnome': 'gnomes-working-on-armor.webp',
    'rock-gnome': 'gnomes-working-on-armor.webp',
    'deep-gnome': 'gnomes-working-on-armor.webp',
    'svirfneblin': 'gnomes-working-on-armor.webp',

    // 半身人亚种 - 全部使用半身人图片
    'lightfoot-halfling': 'halflings-dining.webp',
    'stout-halfling': 'halflings-dining.webp',
    'ghostwise-halfling': 'halflings-dining.webp',

    // 提夫林亚种 - 全部使用提夫林图片
    'asmodeus-tiefling': 'tieflings-playing-cards.webp',
    'baalzebul-tiefling': 'tieflings-playing-cards.webp',
    'dispater-tiefling': 'tieflings-playing-cards.webp',
    'fierna-tiefling': 'tieflings-playing-cards.webp',
    'glasya-tiefling': 'tieflings-playing-cards.webp',
    'levistus-tiefling': 'tieflings-playing-cards.webp',
    'mammon-tiefling': 'tieflings-playing-cards.webp',
    'mephistopheles-tiefling': 'tieflings-playing-cards.webp',
    'zariel-tiefling': 'tieflings-playing-cards.webp',
    'infernal-tiefling': 'tieflings-playing-cards.webp',
    'abyssal-tiefling': 'tieflings-playing-cards.webp',

    // 半兽人
    'half-orc': 'orcs-riding.webp',

    // 神裔亚种
    'protector-aasimar': 'aasimar-working.webp',
    'scourge-aasimar': 'aasimar-working.webp',
    'fallen-aasimar': 'aasimar-working.webp'
};

/**
 * 艾伯伦种族图片映射表
 * 艾伯伦的特有种族。
 */
export const EBERRON_RACE_IMAGES = {
    'changeling': 'species-multiple-faces-in-mirror.webp',
    'kalashtar': 'kalashtar.webp',
    'khoravar': 'khoravar.webp',
    'shifter': 'shifter.webp',
    'warforged': 'warforged.webp'
};

/**
 * 基础种族映射表
 * 
 * 
 */
const BASE_RACE_MAP = {
    'dragonborn': 'dragonborn',
    'elf': 'elf',
    'dwarf': 'dwarf',
    'gnome': 'gnome',
    'halfling': 'halfling',
    'tiefling': 'tiefling',
    'orc': 'orc',
    'aasimar': 'aasimar',
    'human': 'human',
    'goliath': 'goliath'
};

/**
 * 检查 PHB 模块是否活着
 * 
 * 我得确认一下 dnd-players-handbook 模块是不是真的在那儿，而且是激活状态。
 * 如果它不在，那我也变不出图片来，巧妇难为无米之炊嘛
 * 
 * @returns {boolean} 活着就返回 true，否则 false
 */
export function isPHBAvailable() {
    try {
        // 确保 game 对象存在
        if (typeof game === 'undefined' || !game.modules) {
            window.OriginateLog('isPHBAvailable: game 或 game.modules 不存在');
            return false;
        }
        const phbModule = game.modules.get('dnd-players-handbook');
        const isActive = phbModule?.active === true;
        window.OriginateLog(`isPHBAvailable: phbModule=${!!phbModule}, active=${isActive}`);
        return isActive;
    } catch (e) {
        console.warn('Originate | PHB 检查失败:', e);
        return false;
    }
}

/**
 * 检查艾伯伦模块是否活着
 * 
 * 看看 dnd-forge-artificer 模块是不是在且激活。
 * 有了它才能用艾伯伦的高清插画，我觉得艾伯伦的插画比phb好看，我更喜欢这种偏手绘的风格
 * 
 * @returns {boolean} 活着就 true
 */
export function isEberronAvailable() {
    try {
        if (typeof game === 'undefined' || !game.modules) return false;
        const ebModule = game.modules.get('dnd-forge-artificer');
        return ebModule?.active === true;
    } catch (e) {
        return false;
    }
}

/**
 * 获取艾伯伦图片基础路径
 * 
 * @returns {string} 图片路径
 */
function getEberronArtPath() {
    return 'modules/dnd-forge-artificer/assets/journal-art';
}

/**
 * 拼接艾伯伦图片的完整路径
 * 
 * @param {string} filename - 文件名
 * @returns {string} 完整路径
 */
function getEberronFullImagePath(filename) {
    return `${getEberronArtPath()}/${filename}`;
}

/**
 * 检查你是不是在用 PHB 数据源
 * 
 * 看看你的设置里有没有选 PHB。
 * 如果你没选，那我费这劲找图片干嘛？
 * 
 * @returns {boolean} 用了就 true
 */
export function isUsingPHBSource() {
    try {
        // 确保 game 对象和 settings 存在
        if (typeof game === 'undefined' || !game.settings) {
            window.OriginateLog('isUsingPHBSource: game 或 game.settings 不存在');
            return false;
        }
        const sourcePacks = game.settings.get('character-forge', 'sourcePacks') || [];
        const hasPHB = sourcePacks.some(packId => packId.startsWith('dnd-players-handbook'));
        window.OriginateLog(`isUsingPHBSource: sourcePacks=${JSON.stringify(sourcePacks)}, hasPHB=${hasPHB}`);
        return hasPHB;
    } catch (e) {
        console.warn('Originate | 数据源检查失败:', e);
        return false;
    }
}

/**
 * 拼凑完整的图片路径
 * 
 * 把基础路径和文件名拼在一起。
 * 这大概是整个文件里最简单的函数了，希望能一直保持这样。
 * 
 * @param {string} filename - 文件名
 * @returns {string} 完整的路径字符串
 */
export function getFullImagePath(filename) {
    const basePath = getPHBArtPath();
    return `${basePath}/${filename}`;
}

/**
 * 标识符整形手术
 * 
 * 把那些乱七八糟的标识符统一格式：小写、连字符分隔、去掉怪字符。
 * 这样我就不用担心大小写或者空格的问题了。
 * 
 * 这段正则处理起字符串来倒是挺干脆。
 * 虽然看着像是一堆乱码，但它处理这种枯燥替换的速度可比我那个昏昏欲睡的大脑要清醒得多。
 * 凑合用吧，只要不出错就行。
 * 
 * @param {string} identifier - 原始那坨东西
 * @returns {string} 整形后的漂亮字符串
 */
function normalizeIdentifier(identifier) {
    if (!identifier) return '';
    return identifier
        .toLowerCase()
        .replace(/\s+/g, '-')      // 空格转连字符
        .replace(/_/g, '-')         // 下划线转连字符
        .replace(/[^a-z0-9-]/g, '') // 移除特殊字符
        .replace(/-+/g, '-')        // 合并多个连字符
        .replace(/^-|-$/g, '');     // 移除首尾连字符
}

/**
 * 找职业图片
 * 
 * 给我一个职业对象，我给你找张图。
 * 找不到？那就返回 null，你自己看着办。
 * 
 * @param {Object} classItem - 职业数据
 * @returns {string|null} 图片路径
 */
export function getClassImage(classItem) {
    const identifier = classItem.identifier || classItem.system?.identifier;
    const name = classItem.name;
    const normalizedId = normalizeIdentifier(identifier);
    const normalizedName = normalizeIdentifier(name);

    // PHB 优先
    if (isPHBAvailable()) {
        const filename = CLASS_IMAGES[normalizedId] || CLASS_IMAGES[normalizedName];
        if (filename) return getFullImagePath(filename);
    }

    // 艾伯伦兜底
    if (isEberronAvailable()) {
        const ebFilename = EBERRON_CLASS_IMAGES[normalizedId] || EBERRON_CLASS_IMAGES[normalizedName];
        if (ebFilename) return getEberronFullImagePath(ebFilename);
    }

    return null;
}

/**
 * 找子职图片
 * 
 * 暂时禁用了。为什么？因为子职的映射太乱了，我还没理清楚。
 * 等我有空（或者心情好）的时候再来修这个。
 * 现在统统返回 null，别来烦我。
 * 
 * @param {Object} subclassItem - 子职数据
 * @returns {string|null} 永远是 null
 */
export function getSubclassImage(subclassItem) {
    // 暂时禁用子职图片映射
    // TODO: 子职图片需要更精确的映射，暂时返回 null
    return null;

    /*
    if (!isPHBAvailable()) return null;
    
    const identifier = subclassItem.identifier || subclassItem.system?.identifier;
    const name = subclassItem.name;
    
    const normalizedId = normalizeIdentifier(identifier);
    const normalizedName = normalizeIdentifier(name);
    
    const filename = SUBCLASS_IMAGES[normalizedId] || SUBCLASS_IMAGES[normalizedName];
    
    if (filename) {
        return getFullImagePath(filename);
    }
    
    return null;
    */
}

/**
 * 找背景图片
 * 
 * 看看你的背景故事能配上什么图。
 * 
 * @param {Object} backgroundItem - 背景数据
 * @returns {string|null} 图片路径
 */
export function getBackgroundImage(backgroundItem) {
    const identifier = backgroundItem.identifier || backgroundItem.system?.identifier;
    const name = backgroundItem.name;
    const normalizedId = normalizeIdentifier(identifier);
    const normalizedName = normalizeIdentifier(name);

    // PHB 优先
    if (isPHBAvailable()) {
        const filename = BACKGROUND_IMAGES[normalizedId] || BACKGROUND_IMAGES[normalizedName];
        if (filename) return getFullImagePath(filename);
    }

    // 艾伯伦兜底
    if (isEberronAvailable()) {
        const ebFilename = EBERRON_BACKGROUND_IMAGES[normalizedId] || EBERRON_BACKGROUND_IMAGES[normalizedName];
        if (ebFilename) return getEberronFullImagePath(ebFilename);
    }

    return null;
}

/**
 * 找种族图片
 * 
 * 这个比较麻烦，因为种族名字千奇百怪。
 * 我得试着提取基础种族，还要处理中文名。
 * 如果我能找到图，算你走运；找不到，那我也尽力了。
 * 
 * @param {Object} raceItem - 种族数据
 * @returns {string|null} 图片路径
 */
export function getRaceImage(raceItem) {
    const identifier = raceItem.identifier || raceItem.system?.identifier;
    const name = raceItem.name || '';
    const normalizedId = normalizeIdentifier(identifier);
    const normalizedName = normalizeIdentifier(name);

    // 对于种族，还需要检查基础种族
    const baseRaceFromNormalized = extractBaseRace(normalizedName);
    const baseRaceFromOriginal = extractBaseRace(name);

    window.OriginateLog(`getRaceImage: name="${name}", normalizedName="${normalizedName}", baseRaceFromNormalized="${baseRaceFromNormalized}", baseRaceFromOriginal="${baseRaceFromOriginal}"`);

    // PHB 优先
    if (isPHBAvailable()) {
        const filename = RACE_IMAGES[normalizedId] ||
            RACE_IMAGES[normalizedName] ||
            RACE_IMAGES[baseRaceFromNormalized] ||
            RACE_IMAGES[baseRaceFromOriginal];
        if (filename) {
            window.OriginateLog(`getRaceImage: 找到 PHB 图片 ${filename}`);
            return getFullImagePath(filename);
        }
    }

    // 艾伯伦兜底
    if (isEberronAvailable()) {
        const ebFilename = EBERRON_RACE_IMAGES[normalizedId] ||
            EBERRON_RACE_IMAGES[normalizedName] ||
            EBERRON_RACE_IMAGES[baseRaceFromNormalized] ||
            EBERRON_RACE_IMAGES[baseRaceFromOriginal];
        if (ebFilename) {
            window.OriginateLog(`getRaceImage: 找到艾伯伦图片 ${ebFilename}`);
            return getEberronFullImagePath(ebFilename);
        }
    }

    window.OriginateLog(`getRaceImage: 未找到图片`);
    return null;
}

/**
 * 种族名称侦探
 * 
 * 试图从一堆乱七八糟的种族名称里找出它的本质。
 * "High Elf"？那是 Elf。"精灵（木精灵）"？那也是 Elf。
 * 这段代码里塞满了硬编码的映射，简直是维护的噩梦。
 * 但为了支持中文和各种奇怪的格式，我还能怎么办呢？
 * 
 * @param {string} raceName - 种族名称
 * @returns {string} 基础种族名称
 */
function extractBaseRace(raceName) {
    if (!raceName) return '';

    // 中文种族名到英文标识符的映射
    const chineseToEnglish = {
        '龙裔': 'dragonborn',
        '精灵': 'elf',
        '矮人': 'dwarf',
        '侏儒': 'gnome',
        '半身人': 'halfling',
        '提夫林': 'tiefling',
        '兽人': 'orc',
        '半兽人': 'orc',
        '神裔': 'aasimar',
        '人类': 'human',
        '歌利亚': 'goliath',
        '巨灵': 'goliath'
    };

    // 1. 检查中文括号格式: "精灵（木精灵）" 或 "精灵(木精灵)"
    const chineseBracketMatch = raceName.match(/^([^（(]+)[（(]/);
    if (chineseBracketMatch) {
        const chineseBase = chineseBracketMatch[1].trim();
        // 尝试转换为英文
        if (chineseToEnglish[chineseBase]) {
            return chineseToEnglish[chineseBase];
        }
    }

    // 2. 检查纯中文名称（无括号）
    for (const [chinese, english] of Object.entries(chineseToEnglish)) {
        if (raceName.includes(chinese)) {
            return english;
        }
    }

    // 3. 英文前缀格式处理
    const prefixes = [
        'high-', 'wood-', 'dark-', 'hill-', 'mountain-', 'forest-', 'rock-',
        'lightfoot-', 'stout-', 'ghostwise-', 'deep-', 'sea-', 'shadar-',
        'black-', 'blue-', 'brass-', 'bronze-', 'copper-', 'gold-', 'green-',
        'red-', 'silver-', 'white-', 'chromatic-', 'metallic-', 'gem-',
        'protector-', 'scourge-', 'fallen-',
        'asmodeus-', 'baalzebul-', 'dispater-', 'fierna-', 'glasya-',
        'levistus-', 'mammon-', 'mephistopheles-', 'zariel-', 'infernal-', 'abyssal-'
    ];

    for (const prefix of prefixes) {
        if (raceName.startsWith(prefix)) {
            return raceName.substring(prefix.length);
        }
    }

    // 4. 检查是否包含基础种族名称（用于处理复合名称）
    for (const baseRace of Object.keys(BASE_RACE_MAP)) {
        if (raceName.includes(baseRace)) {
            return baseRace;
        }
    }

    return raceName;
}

/**
 * 自动找图总入口
 * 
 * 你给我类型和物品，我帮你分发给对应的处理函数。
 * 就像个交通指挥员，只不过指挥的是图片路径。
 * 
 * @param {string} type - 类型
 * @param {Object} item - 物品数据
 * @returns {string|null} 图片路径
 */
export function getPHBImage(type, item) {
    switch (type) {
        case 'class':
            return getClassImage(item);
        case 'subclass':
            return getSubclassImage(item);
        case 'background':
            return getBackgroundImage(item);
        case 'race':
            return getRaceImage(item);
        default:
            return null;
    }
}

/**
 * 给选项"整容"
 * 
 * Adrian: 图片优先级从高到低：
 * 1. 自定义图片（用户在配置界面设置的）
 * 2. PHB 高清图片（如果 PHB 模块可用）
 * 3. Item 自带的图片
 * 
 * 如果你的选项图片太丑（默认图标）或者根本没有，我就试着用更好的图片替换它。
 * 这叫"增强"，懂吗？让你的界面看起来不那么寒酸。
 * 
 * @param {Object} option - 原始选项
 * @param {string} type - 类型
 * @returns {Object} 整容后的选项
 */
export function enhanceOptionWithPHBImage(option, type) {
    // 1. 首先检查是否有自定义图片（最高优先级）
    const customImage = getCustomImageConfig(type, option.uuid);
    if (customImage) {
        window.OriginateLog(`使用自定义图片: ${option.name} -> ${customImage.path}`);
        return {
            ...option,
            heroImage: customImage.path,
            heroImageFit: customImage.fit,
            _customImageApplied: true
        };
    }

    const phbAvailable = isPHBAvailable();

    window.OriginateLog(`PHB 图片增强: type=${type}, name=${option.name}, identifier=${option.identifier}, heroImage=${option.heroImage}, phbAvailable=${phbAvailable}`);

    // 只检查 PHB 模块是否可用，不再检查数据源
    // 这样即使用户没有将 PHB 添加到数据源，也可以使用 PHB 图片
    const eberronAvailable = isEberronAvailable();

    if (!phbAvailable && !eberronAvailable) {
        window.OriginateLog(`图片增强跳过: PHB 和艾伯伦模块均未安装或未激活`);
        return option;
    }

    // 尝试获取映射图片（PHB 或艾伯伦）
    const mappedImage = getPHBImage(type, option);

    window.OriginateLog(`图片查找结果: type=${type}, identifier=${option.identifier}, mappedImage=${mappedImage}`);

    if (!mappedImage) {
        // 没有映射图片，保持原样
        return option;
    }

    // 检查当前图片是否已经是高清大图（journal-art 目录下的图片）
    // 如果已经是，就不需要替换了
    const currentImage = option.heroImage || '';
    const isAlreadyHDImage = currentImage.includes('/journal-art/') && !currentImage.includes('-icon.');
    if (isAlreadyHDImage) {
        window.OriginateLog(`图片增强跳过: 已有高清图片 ${option.heroImage}`);
        return option;
    }

    window.OriginateLog(`图片增强应用: ${option.name} -> ${mappedImage}`);
    return {
        ...option,
        heroImage: mappedImage,
        _phbImageApplied: true
    };
}

/**
 * 批量整容服务
 * 
 * 一次性处理一堆选项。效率！
 * 如果 PHB 模块没装，我就直接把原样退回给你。
 * 
 * @param {Array} options - 选项数组
 * @param {string} type - 类型
 * @returns {Array} 处理完的数组
 */
export function enhanceOptionsWithPHBImages(options, type) {
    // 安全检查：确保 options 是数组
    if (!options || !Array.isArray(options)) {
        return options || [];
    }

    try {
        window.OriginateLog(`enhanceOptionsWithPHBImages: 开始增强 ${options.length} 个 ${type} 选项`);
        return options.map(opt => enhanceOptionWithPHBImage(opt, type));
    } catch (e) {
        console.warn('Originate | PHB 图片增强失败:', e);
        return options;
    }
}
