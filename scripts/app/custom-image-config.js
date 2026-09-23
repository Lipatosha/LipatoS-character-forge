function localize(key) {
    return game.i18n.localize(key);
}

function format(key, data) {
    return game.i18n.format(key, data);
}

function escapeHtml(value) {
    return foundry.utils.escapeHTML(String(value ?? ''));
}

function isVideoPath(path) {
    const cleanPath = String(path || '').split(/[?#]/, 1)[0].toLowerCase();
    return cleanPath.endsWith('.webm') || cleanPath.endsWith('.mp4');
}

function createPreviewMedia(path, fit, className) {
    const media = document.createElement(isVideoPath(path) ? 'video' : 'img');
    media.className = `${className} fit-${fit}`;

    if (media instanceof HTMLVideoElement) {
        media.autoplay = true;
        media.loop = true;
        media.muted = true;
        media.playsInline = true;
        const source = document.createElement('source');
        source.src = path;
        media.append(source);
    } else {
        media.src = path;
        media.alt = '';
    }

    return media;
}

function showFullscreenPreview(path, onClose) {
    if (!path) return null;

    const overlay = document.createElement('div');
    overlay.className = 'originate-image-fullscreen-preview';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', localize('ORIGINATE.Settings.Config.CustomImageFullscreen'));
    overlay.append(createPreviewMedia(path, 'contain', 'custom-image-fullscreen-media'));
    document.body.append(overlay);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        overlay.remove();
        onClose?.();
    };
    overlay.addEventListener('click', close, { once: true });
    overlay.focus();
    return close;
}

/**
 * 图片路径、裁切方式和预览属于同一次选择，放在一个小窗口里才不会让设置散成几步。
 */
export function openCustomImageConfig({ itemName, path = '', fit = 'contain', allowFit = true }) {
    return new Promise(resolve => {
        let selectedFit = fit === 'cover' ? 'cover' : 'contain';
        let closeFullscreen = null;
        let previewTimer = null;

        const overlay = document.createElement('div');
        overlay.className = 'originate-image-config-overlay';
        overlay.innerHTML = `
            <section class="custom-image-config-dialog" role="dialog" aria-modal="true"
                aria-label="${escapeHtml(format('ORIGINATE.Settings.Config.CustomImageDialogTitle', { name: itemName }))}">
                <header class="custom-image-config-header">
                    <h2>${escapeHtml(format('ORIGINATE.Settings.Config.CustomImageDialogTitle', { name: itemName }))}</h2>
                    <button type="button" class="custom-image-dialog-close" data-action="cancel"
                        title="${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageCancel'))}">
                        <i class="fas fa-times"></i>
                    </button>
                </header>
                <div class="custom-image-config-body">
                    <label class="custom-image-path-field">
                        <span>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImagePath'))}</span>
                        <span class="custom-image-path-row">
                            <input type="text" value="${escapeHtml(path)}"
                                placeholder="${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImagePathPlaceholder'))}">
                            <button type="button" data-action="browse">
                                <i class="fas fa-folder-open"></i>
                                ${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageBrowse'))}
                            </button>
                        </span>
                    </label>
                    ${allowFit ? `
                    <fieldset class="custom-image-fit-options">
                        <legend>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageMode'))}</legend>
                        <button type="button" data-fit="contain" title="${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageContainHint'))}">
                            <i class="fas fa-compress"></i>
                            <span>
                                <strong>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageContain'))}</strong>
                                <small>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageContainHint'))}</small>
                            </span>
                        </button>
                        <button type="button" data-fit="cover" title="${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageCoverHint'))}">
                            <i class="fas fa-expand"></i>
                            <span>
                                <strong>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageCover'))}</strong>
                                <small>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageCoverHint'))}</small>
                            </span>
                        </button>
                    </fieldset>` : ''}
                    <div class="custom-image-preview-heading">
                        <span>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImagePreview'))}</span>
                        <button type="button" data-action="fullscreen" disabled>
                            <i class="fas fa-expand"></i>
                            ${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageFullscreen'))}
                        </button>
                    </div>
                    <div class="custom-image-preview-frame"></div>
                </div>
                <footer class="custom-image-config-footer">
                    <button type="button" data-action="cancel">
                        ${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageCancel'))}
                    </button>
                    <button type="button" class="primary" data-action="save" disabled>
                        <i class="fas fa-save"></i>
                        ${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageSave'))}
                    </button>
                </footer>
            </section>`;

        const dialog = overlay.querySelector('.custom-image-config-dialog');
        const pathInput = overlay.querySelector('.custom-image-path-row input');
        const previewFrame = overlay.querySelector('.custom-image-preview-frame');
        const fullscreenButton = overlay.querySelector('[data-action="fullscreen"]');
        const saveButton = overlay.querySelector('[data-action="save"]');
        const fitButtons = Array.from(overlay.querySelectorAll('[data-fit]'));

        const updateFitButtons = () => {
            fitButtons.forEach(button => {
                const active = button.dataset.fit === selectedFit;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', String(active));
            });
        };

        const updatePreview = () => {
            const currentPath = pathInput.value.trim();
            previewFrame.replaceChildren();
            previewFrame.classList.toggle('empty', !currentPath);
            saveButton.disabled = !currentPath;
            fullscreenButton.disabled = !currentPath;

            if (!currentPath) {
                const empty = document.createElement('span');
                empty.className = 'custom-image-empty-preview';
                empty.innerHTML = `<i class="fas fa-image"></i>${escapeHtml(localize('ORIGINATE.Settings.Config.CustomImageEmptyPreview'))}`;
                previewFrame.append(empty);
                return;
            }

            previewFrame.append(createPreviewMedia(currentPath, selectedFit, 'custom-image-preview-media'));
        };

        const finish = result => {
            if (!overlay.isConnected) return;
            clearTimeout(previewTimer);
            closeFullscreen?.();
            document.removeEventListener('keydown', onKeyDown, true);
            overlay.remove();
            resolve(result);
        };

        const onKeyDown = event => {
            if (event.key !== 'Escape') return;
            if (overlay.classList.contains('file-picker-open')) return;
            event.preventDefault();
            if (closeFullscreen) {
                closeFullscreen();
                closeFullscreen = null;
                return;
            }
            finish(null);
        };

        pathInput.addEventListener('input', () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(updatePreview, 180);
        });

        fitButtons.forEach(button => {
            button.addEventListener('click', () => {
                selectedFit = button.dataset.fit;
                updateFitButtons();
                updatePreview();
            });
        });

        overlay.querySelector('[data-action="browse"]').addEventListener('click', async () => {
            const FilePickerApp = foundry.applications.apps?.FilePicker?.implementation;
            if (!FilePickerApp) {
                ui.notifications.warn(localize('ORIGINATE.Settings.Config.CustomImagePickerFailed'));
                return;
            }

            let restoreOverlay = () => {};
            try {
                const picker = new FilePickerApp({
                    type: 'imagevideo',
                    current: pathInput.value.trim(),
                    callback: selectedPath => {
                        pathInput.value = selectedPath;
                        updatePreview();
                        restoreOverlay();
                    }
                });

                const originalClose = picker.close?.bind(picker);
                restoreOverlay = () => overlay.classList.remove('file-picker-open');
                if (originalClose) {
                    picker.close = (...args) => {
                        restoreOverlay();
                        return originalClose(...args);
                    };
                }

                overlay.classList.add('file-picker-open');
                await picker.render(true);
            } catch (error) {
                restoreOverlay();
                console.warn('Originate | 打开自定义图片选择器失败:', error);
                ui.notifications.warn(localize('ORIGINATE.Settings.Config.CustomImagePickerFailed'));
            }
        });

        fullscreenButton.addEventListener('click', () => {
            closeFullscreen?.();
            closeFullscreen = showFullscreenPreview(pathInput.value.trim(), () => {
                closeFullscreen = null;
            });
        });

        overlay.querySelectorAll('[data-action="cancel"]').forEach(button => {
            button.addEventListener('click', () => finish(null));
        });

        saveButton.addEventListener('click', () => {
            const selectedPath = pathInput.value.trim();
            if (!selectedPath) return;
            finish({ path: selectedPath, fit: selectedFit });
        });

        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(null);
        });
        dialog.addEventListener('click', event => event.stopPropagation());
        document.addEventListener('keydown', onKeyDown, true);
        document.body.append(overlay);

        updateFitButtons();
        updatePreview();
        pathInput.focus();
    });
}
