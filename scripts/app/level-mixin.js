export const LevelMixin = (Base) => class extends Base {
    _onChangeTotalLevel(event, target) {
        window.OriginateLog("Originate | _onChangeTotalLevel triggered. 升级了？还是降级了？", target);
        const delta = parseInt(target.dataset.delta);
        
        if (isNaN(delta)) {
            console.error("Originate | Invalid delta for level change. 数学老师死得早。");
            return;
        }

        // 确保当前等级是数字
        // 别笑，真的有人会把等级存成字符串
        let currentLevel = parseInt(this.context.levelConfig.totalLevel) || 1;
        window.OriginateLog(`Originate | delta: ${delta}, current total: ${currentLevel}`);
        
        let newLevel = currentLevel + delta;
        
        // 限制等级范围，别太贪心
        if (newLevel < 1) newLevel = 1;
        if (newLevel > 20) newLevel = 20; // 20级以后就是神仙打架了，我们管不了
        
        this.context.levelConfig.totalLevel = newLevel;
        this.characterLevel = newLevel;
        
        window.OriginateLog(`Originate | New total level: ${newLevel}`);

        // 更新 UI
        // 局部更新，假装我们很高效
        const display = this.element.querySelector('#total-level-display');
        if (display) {
            display.textContent = newLevel;
        } else {
            // 如果找不到元素，回退到完整渲染
            // 笨办法总是最可靠的
            console.warn("Originate | Could not find #total-level-display, falling back to render. 哎，又得重画。");
            this.render();
            return;
        }
        
        this._updateLevelUI();
    }

    _onToggleMulticlass(event, target) {
        const isMulticlass = target.checked;
        this.context.levelConfig.isMulticlass = isMulticlass;
        
        const panel = this.element.querySelector('#class-distribution-panel');
        if (panel) {
            panel.style.display = isMulticlass ? 'block' : 'none';
        }
        
        // 如果开启兼职且没有职业条目，添加一个默认的
        // 总得给人家一个开始的地方
        if (isMulticlass && this.context.levelConfig.classes.length === 0) {
            this._addClassEntry();
        }
    }

    _onAddClass(event, target) {
        this._addClassEntry();
    }

    _addClassEntry() {
        const idx = this.context.levelConfig.classes.length;
        this.context.levelConfig.classes.push({
            id: "",
            level: 1,
            isPrimary: idx === 0 // 第一个总是老大
        });
        
        // 重新渲染列表（简化处理，实际应该只添加 DOM 元素）
        // 懒得写 DOM 操作了，直接重绘吧
        this.render();
    }

    _onRemoveClass(event, target) {
        const idx = parseInt(target.dataset.idx);
        this.context.levelConfig.classes.splice(idx, 1);
        
        // 确保至少有一个主职业
        // 群龙不能无首
        if (this.context.levelConfig.classes.length > 0 && !this.context.levelConfig.classes.some(c => c.isPrimary)) {
            this.context.levelConfig.classes[0].isPrimary = true;
        }
        
        this.render();
    }

    _onChangeClassLevel(event, target) {
        window.OriginateLog("Originate | _onChangeClassLevel triggered", target);
        const idx = parseInt(target.dataset.idx);
        const delta = parseInt(target.dataset.delta);
        
        if (isNaN(idx) || isNaN(delta)) return;

        window.OriginateLog(`Originate | idx: ${idx}, delta: ${delta}`);
        
        const entry = this.context.levelConfig.classes[idx];
        
        if (entry) {
            let currentLevel = parseInt(entry.level) || 1;
            let newLevel = currentLevel + delta;
            
            if (newLevel < 1) newLevel = 1;
            
            entry.level = newLevel;
            
            // 更新 UI
            const row = target.closest('.class-entry');
            if (row) {
                const valSpan = row.querySelector('.class-level-value');
                if (valSpan) valSpan.textContent = newLevel;
            } else {
                this.render();
                return;
            }
            this._updateLevelUI();
        }
    }

    _onUpdateClassSelection(event, target) {
        const row = target.closest('.class-entry');
        const idx = parseInt(row.dataset.idx);
        const classId = target.value;
        
        if (this.context.levelConfig.classes[idx]) {
            this.context.levelConfig.classes[idx].id = classId;
        }
    }

    _updateLevelUI() {
        const totalAssigned = this.context.levelConfig.classes.reduce((sum, c) => sum + (parseInt(c.level) || 0), 0);
        const targetLevel = parseInt(this.context.levelConfig.totalLevel) || 1;
        
        const assignedSpan = this.element.querySelector('#assigned-level');
        const targetSpan = this.element.querySelector('#target-level');
        
        if (assignedSpan) assignedSpan.textContent = totalAssigned;
        if (targetSpan) targetSpan.textContent = targetLevel;
        
        if (assignedSpan) {
            // 绿色代表通过，橙色代表警告
            // 就像红绿灯一样简单
            assignedSpan.style.color = totalAssigned === targetLevel ? '#4caf50' : '#ff9800';
        }
    }
};
