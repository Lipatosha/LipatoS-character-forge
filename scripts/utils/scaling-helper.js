/**
 * Scaling Helper for Settings Windows
 * 
 * Adrian: 这是一个可复用的缩放工具，让设置窗口在小屏幕上也能正常显示。
 * 原理和主界面的 Hybrid Scaling 一样：强制固定设计尺寸，然后整体缩放。
 */

/**
 * 为 FormApplication 窗口应用自适应缩放
 * 
 * @param {HTMLElement|jQuery} html - 窗口根元素或旧式 jQuery 包装
 * @param {number} designWidth - 设计宽度（像素）
 * @param {number} designHeight - 设计高度（像素）
 * @returns {ResizeObserver|null} - 返回观察者对象，关闭时需要断开
 */
export function applyWindowScaling(html, designWidth, designHeight) {
    // 找到窗口的根元素
    // 新面板直接传 HTMLElement，旧面板仍可能传 jQuery，这里两边都接住。
    const el = html instanceof HTMLElement ? html : html?.[0];
    const form = el?.closest('.application') || el?.closest('.app') || (el?.querySelector('.window-content') ? el : null);
    if (!form) {
        console.warn('[Originate] applyWindowScaling: Could not find window root element');
        return null;
    }

    const content = form.querySelector('.window-content');
    if (!content) {
        console.warn('[Originate] applyWindowScaling: Could not find .window-content');
        return null;
    }

    // 缩放计算函数
    const updateScale = () => {
        const rect = form.getBoundingClientRect();
        const headerHeight = form.querySelector('.window-header')?.offsetHeight || 30;

        const availableWidth = rect.width;
        const availableHeight = rect.height - headerHeight;

        // 计算缩放比例（不放大，最大 1.0）
        const scaleX = availableWidth / designWidth;
        const scaleY = availableHeight / designHeight;
        const scale = Math.min(scaleX, scaleY, 1);

        // 如果缩放接近 1，直接使用原始尺寸避免模糊
        if (scale > 0.99) {
            content.style.transform = '';
            content.style.transformOrigin = '';
            content.style.width = '';
            content.style.height = '';
            content.style.position = '';
            content.style.top = '';
            content.style.left = '';
            return;
        }

        // 计算居中偏移
        const visualWidth = designWidth * scale;
        const visualHeight = designHeight * scale;

        const offsetX = (availableWidth - visualWidth) / 2;
        const offsetY = (availableHeight - visualHeight) / 2;

        // 强制使用绝对定位或通过 transform 修正位置
        // 使用绝对定位脱离文档流，避免因 layout height (1100px) 导致的父容器剪裁问题
        content.style.position = 'absolute';
        content.style.top = '0';
        content.style.left = '0';
        content.style.transformOrigin = 'top left';
        content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
        content.style.width = `${designWidth}px`;
        content.style.height = `${designHeight}px`;

        // 防止出现滚动条 (因为 width/height 变大了)
        // 通常 FormApplication 的 overflow 是 hidden 或 auto，这里可能需要强制 hidden 来自适应
        // 但如果内容真的超出了，我们希望通过 scale 解决，而不是 scroll
        content.style.overflow = 'hidden';
    };

    // 初始化缩放
    updateScale();

    // 监听窗口大小变化
    // 使用 requestAnimationFrame 确保我们的样式在 Foundry 处理完之后应用
    const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
            updateScale();
        });
    });
    observer.observe(form);

    // 也监听 window resize 事件作为备份
    const windowResizeHandler = () => {
        requestAnimationFrame(() => {
            updateScale();
        });
    };
    window.addEventListener('resize', windowResizeHandler);

    // 存储 handler 以便清理
    observer._windowResizeHandler = windowResizeHandler;

    return observer;
}

/**
 * 清理缩放观察者
 * 
 * @param {ResizeObserver|null} observer - 要断开的观察者
 */
export function cleanupWindowScaling(observer) {
    if (observer) {
        observer.disconnect();
        // 清理附加的 window resize handler
        if (observer._windowResizeHandler) {
            window.removeEventListener('resize', observer._windowResizeHandler);
        }
    }
}
