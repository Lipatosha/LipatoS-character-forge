export class FontLoader {
    static get fontsPath() {
        return "modules/character-forge/fonts";
    }

    /**
     * 加载字体并注入到页面
     * Load fonts and inject into the page
     */
    static async loadFonts() {
        console.log("Originate | Loading custom fonts...");

        // 由于客户端无法直接列出目录文件，我们需要预定义已知字体或使用服务端FilePicker API
        // 这里为了简单起见，我们使用已知的字体列表，或者尝试通过FilePicker浏览
        // Client cannot list files directly, use FilePicker API if possible or hardcoded list
        // Given the user specifically added a folder, we'll assume standard naming conventions or specific known fonts
        // For now, let's try to discover them via FilePicker if possible, otherwise we hardcode the ones we saw.

        // Based on previous `list_dir` tool output:
        // Cinzel_Decorative, Cormorant_SC, Forum, Marcellus
        const fontDefinitions = [
            { family: "Cinzel Decorative", path: "Cinzel_Decorative/CinzelDecorative-Regular.ttf", weight: 400 },
            { family: "Cinzel Decorative", path: "Cinzel_Decorative/CinzelDecorative-Bold.ttf", weight: 700 },
            { family: "Cinzel Decorative", path: "Cinzel_Decorative/CinzelDecorative-Black.ttf", weight: 900 },
            { family: "Cormorant SC", path: "Cormorant_SC/CormorantSC-Regular.ttf", weight: 400 },
            { family: "Cormorant SC", path: "Cormorant_SC/CormorantSC-Bold.ttf", weight: 700 },
            { family: "Forum", path: "Forum/Forum-Regular.ttf", weight: 400 },
            { family: "Marcellus", path: "Marcellus/Marcellus-Regular.ttf", weight: 400 }
        ];

        const styleId = "originate-custom-fonts";
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }

        let cssRules = "";

        for (const font of fontDefinitions) {
            const fontUrl = `${this.fontsPath}/${font.path}`;
            cssRules += `
@font-face {
    font-family: '${font.family}';
    src: url('${fontUrl}') format('truetype');
    font-weight: ${font.weight};
    font-style: normal;
}
`;
        }

        styleEl.textContent = cssRules;
        console.log(`Originate | Registered ${fontDefinitions.length} font faces.`);

        // 加载用户自定义字体
        this.loadCustomFonts();
    }

    /**
     * 加载用户上传的自定义字体
     * Adrian: 用户通过 FilePicker 选的字体文件，我们动态注入 @font-face
     */
    static loadCustomFonts() {
        try {
            const customFonts = game.settings.get('character-forge', 'customFonts') || [];
            if (!customFonts.length) return;

            const styleId = "originate-user-custom-fonts";
            let styleEl = document.getElementById(styleId);
            if (!styleEl) {
                styleEl = document.createElement("style");
                styleEl.id = styleId;
                document.head.appendChild(styleEl);
            }

            let cssRules = "";
            for (const font of customFonts) {
                if (!font.family || !font.path) continue;
                // 检测字体格式
                const ext = font.path.split('.').pop().toLowerCase();
                const formatMap = {
                    'ttf': 'truetype',
                    'otf': 'opentype',
                    'woff': 'woff',
                    'woff2': 'woff2'
                };
                const format = formatMap[ext] || 'truetype';

                cssRules += `
@font-face {
    font-family: '${font.family}';
    src: url('${font.path}') format('${format}');
    font-weight: 400;
    font-style: normal;
}
`;
            }

            styleEl.textContent = cssRules;
            console.log(`Originate | Loaded ${customFonts.length} user custom font(s).`);
        } catch (e) {
            console.warn("Originate | Failed to load custom fonts:", e);
        }
    }

    /**
     * 获取可用字体列表（内置 + 用户自定义）
     * Get available font families
     */
    static getAvailableFonts() {
        const builtIn = [
            "Cinzel", // Default
            "Cinzel Decorative",
            "Cormorant SC",
            "Forum",
            "Marcellus"
        ];

        // 追加用户自定义字体
        try {
            const customFonts = game.settings.get('character-forge', 'customFonts') || [];
            for (const font of customFonts) {
                if (font.family && !builtIn.includes(font.family)) {
                    builtIn.push(font.family);
                }
            }
        } catch (e) {
            // 设置可能尚未注册
        }

        return builtIn;
    }
}
