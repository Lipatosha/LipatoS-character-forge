// 视觉主题注册表
// -----
// 原来 gold/silver 这套主题是散落写死的：aspects-config 的 themeChoices 里写一遍，
// app.js / aspects-config 切换时的 removeClass('theme-gold theme-silver ...') 里又各写一遍。
// 加一个主题得改五六处还容易漏（obsidian/ethereal 当年就是只补了 CSS、没进选择面板的半截子状态）。
//
// 收口到这里之后：内置主题在这登记一次，外部皮肤 mod（比如赛博朋克 DLC）通过
// api.registerTheme 登记一次，选择面板的选项、切换时的 class 清理、按主题切换的音效，
// 全都自动跟上，不用再回去摸那几处硬编码。
//
// 这个文件刻意不 import 任何 originate 内部模块，只摸 game.i18n / game.settings 这种全局，
// 避免跟 ui-sounds / main / aspects-config 之间绕出循环依赖（那种环 node --check 还查不出来）。

const _themes = new Map();

function _register({ id, label, selectable = true, sounds = null, panel = null, preview = null } = {}) {
    if (!id) return null;
    const def = {
        id,
        label: label ?? id,
        selectable: !!selectable,
        // sounds 形如 { CLICK: 'modules/xxx/a.ogg', PAGE_FLIP: '...' }，没传就保持 null，调用方回退默认音效
        sounds: sounds || null,
        // panel：该主题在外观面板左栏里的专属设置页，形如 { label, render(mount, api) }。
        // 本体只给一个标签和空容器，具体控件/存取全由登记主题的皮肤 mod 在 render 里自己做——
        // 这样本体不用认识"色调""里程碑"这类某个皮肤才有的概念。没登记就是 null，不出专属标签。
        panel: panel || null,
        // preview：主题可选的右侧实时预览定义，形如 { modes, render(mount, api) }。
        // 本体只负责场景切换和生命周期，具体场景仍归主题自己维护。
        preview: preview || null
    };
    _themes.set(id, def);
    return def;
}

// 内置主题。
// obsidian / ethereal 只有 CSS、没在面板里露过脸，所以 selectable:false——
// 不进选择列表，但保留在册，好让切换时的 class 清理不漏（历史存档里可能还存着这俩值）。
_register({ id: 'gold', label: 'ORIGINATE.Settings.VisualTheme.Gold' });
_register({ id: 'silver', label: 'ORIGINATE.Settings.VisualTheme.Silver' });
_register({ id: 'obsidian', label: 'obsidian', selectable: false });
_register({ id: 'ethereal', label: 'ethereal', selectable: false });

/**
 * 登记一个视觉主题。外部皮肤 mod 的唯一入口。
 * @param {object} def - { id, label?, selectable?, sounds?, panel?, preview? }
 *   - id: 主题标识，会拼成 .originate-container.theme-<id>，CSS 按这个选择器上色
 *   - label: i18n key 或直接的显示文案，显示在视觉设置的主题选择里
 *   - sounds: 可选，按类型覆盖交互音效，{ CLICK, PAGE_FLIP }
 *   - panel: 可选，外观面板里的专属设置页 { label, render(mount, api) }。选中该主题时
 *            左栏会多出一个标签，切过去时调 render 把控件填进 mount；控件的存取由皮肤 mod 自理
 *   - preview: 可选，外观面板右侧实时预览 { modes, render(mount, api) }。本体负责切换和清理，
 *              主题负责实际场景与动态引擎
 */
export function registerTheme(def) {
    const result = _register(def);
    if (result) {
        console.log(`Originate | 已登记视觉主题：${result.id}`);
        _syncSettingChoices();
    }
    return result;
}

// 把可选主题同步进 visualTheme 设置的 choices。
// 设置是在 init 时静态注册的，那会儿外部皮肤还没登记；这里在 registerTheme 之后补一次，
// 让标准设置面板也能看到完整选项，顺带避免某些版本对「set 了不在 choices 里的值」发警告。
// 视觉设置那个面板本来就是动态读注册表的，不依赖这步，所以同步失败也不影响主流程。
function _syncSettingChoices() {
    try {
        const setting = game.settings?.settings?.get('character-forge.visualTheme');
        if (setting) setting.choices = getThemeChoices();
    } catch (e) { /* 设置还没就绪就算了 */ }
}

export function getTheme(id) {
    return _themes.get(id) || null;
}

/**
 * 给视觉设置面板用：只返回能让用户选的主题，形如 { gold: '辉金', silver: '秘银', cyberpunk: '赛博朋克' }。
 * label 在这里才本地化——注册时存的是 i18n key，等到真正要显示时 game.i18n 已经就绪。
 */
export function getThemeChoices() {
    const out = {};
    for (const def of _themes.values()) {
        if (!def.selectable) continue;
        out[def.id] = game.i18n?.localize(def.label) ?? def.label;
    }
    return out;
}

/**
 * 给切换 / 重渲染用：所有在册主题的 class 串成一行，
 * 切主题前先把这一串 removeClass 掉，避免上一个主题的 class 残留（赛博切回辉金时尤其要紧）。
 */
export function getThemeClassList() {
    return [..._themes.keys()].map(id => `theme-${id}`).join(' ');
}

/**
 * 给 ui-sounds 用：返回某主题覆盖的音效集，没覆盖就返回 null（调用方回退到默认音效）。
 */
export function getThemeSounds(id) {
    return _themes.get(id)?.sounds || null;
}

/**
 * 给外观面板用：返回某主题登记的专属设置页 { label, render } 或 null。
 * 面板据此决定要不要给这个主题多出一个专属标签、切过去时找谁来填内容。
 */
export function getThemePanel(id) {
    return _themes.get(id)?.panel || null;
}

/**
 * 给外观面板用：返回某主题登记的实时预览定义 { modes, render } 或 null。
 */
export function getThemePreview(id) {
    return _themes.get(id)?.preview || null;
}
