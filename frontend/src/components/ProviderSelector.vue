<template>
    <div class="provider-header">
        <label for="providerSelect">API 提供商</label>
        <div class="header-actions">
            <label class="switch-label" title="启用流式检测 (Stream Mode)">
                <span class="switch-title">流式检测</span>
                <input type="checkbox" v-model="currentConfig.enableStream" :disabled="checkerStore.isChecking">
                <span class="slider"></span>
            </label>
            <button @click="uiStore.openModal('regionSelector')" class="region-btn" title="检测设置"
                :disabled="checkerStore.isChecking">⚙️</button>
        </div>
    </div>

    <div class="custom-provider-select" :class="{ disabled: checkerStore.isChecking }" id="providerSelectWrapper"
        ref="providerSelectWrapper">
        <div class="custom-provider-trigger" :class="{ open: uiStore.providerDropdownOpen }"
            @click="!checkerStore.isChecking && (uiStore.providerDropdownOpen = !uiStore.providerDropdownOpen)"
            role="combobox"
            aria-haspopup="listbox"
            :aria-expanded="uiStore.providerDropdownOpen"
            aria-labelledby="providerSelect providerDisplay">
            <span id="providerDisplay">{{ configStore.providers[configStore.currentProvider].label }}</span>
        </div>
        <div class="custom-provider-dropdown" :class="{ open: uiStore.providerDropdownOpen }" ref="dropdownContainer"
            role="listbox"
            aria-label="API 提供商列表">
            <input type="search" v-model="providerSearchTerm" placeholder="🔍 搜索提供商..." class="provider-search-input" ref="searchInputElement"
                aria-label="搜索提供商">
            <div v-for="(provider, key) in filteredProviders" :key="key" class="provider-option"
                :class="{ selected: key === configStore.currentProvider, highlighted: providerKeys[highlightedIndex] === key }" @click="handleProviderSelect(key)"
                role="option"
                :aria-selected="key === configStore.currentProvider">
                <span class="provider-icon" aria-hidden="true">{{ provider.icon }}</span>
                <span>{{ provider.label }}</span>
            </div>
        </div>
    </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue';
import { useConfigStore } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import { useResultsStore } from '@/stores/results';
import { useCheckerStore } from '@/stores/checker';

const configStore = useConfigStore();
const uiStore = useUiStore();
const resultsStore = useResultsStore();
const checkerStore = useCheckerStore();

const providerSelectWrapper = ref(null);
const providerSearchTerm = ref('');
const searchInputElement = ref(null);
const dropdownContainer = ref(null);
const highlightedIndex = ref(-1);

const providerKeys = computed(() => Object.keys(filteredProviders.value));

/**
 * @description 计算属性，获取当前选中提供商的配置。
 */
const currentConfig = computed(() => {
    return configStore.providerConfigs[configStore.currentProvider] || {};
});

/**
 * @description 计算属性，根据搜索关键词过滤提供商列表。
 */
const filteredProviders = computed(() => {
    const searchTerm = providerSearchTerm.value.toLowerCase();
    const providers = configStore.providers;
    if (!searchTerm) {
        return providers;
    }
    const filtered = {};
    for (const key in providers) {
        const provider = providers[key];
        if (provider.label.toLowerCase().includes(searchTerm)) {
            filtered[key] = provider;
        }
    }
    // 搜索后如果高亮索引超出范围，重置
    const keys = Object.keys(filtered);
    if (highlightedIndex.value >= keys.length) highlightedIndex.value = keys.length - 1;
    return filtered;
});

/**
 * @description 处理提供商选择事件。
 * @param {string} key - 选中的提供商 Key。
 */
const handleProviderSelect = (key) => {
    configStore.selectProvider(key);
    resultsStore.clearResults();
    if (resultsStore.activeTab !== 'valid') {
        resultsStore.activeTab = 'valid';
    }
    providerSearchTerm.value = ''; // 清空搜索词
};

/**
 * @description 点击外部时关闭提供商下拉菜单。
 * @param {Event} e - 点击事件对象。
 */
const closeDropdown = (e) => {
    if (providerSelectWrapper.value && !providerSelectWrapper.value.contains(e.target)) {
        uiStore.providerDropdownOpen = false;
        providerSearchTerm.value = ''; // 清空搜索词
    }
};

/**
 * @description 处理键盘事件，按下 ESC 键关闭下拉菜单。
 * @param {KeyboardEvent} e - 键盘事件对象。
 */
const handleKeyDown = (e) => {
    if (!uiStore.providerDropdownOpen) return;

    if (e.key === 'Escape') {
        uiStore.providerDropdownOpen = false;
        return;
    }

    const keys = providerKeys.value;
    if (!keys.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightedIndex.value = (highlightedIndex.value + 1) % keys.length;
        scrollHighlightedIntoView();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightedIndex.value = (highlightedIndex.value - 1 + keys.length) % keys.length;
        scrollHighlightedIntoView();
    } else if (e.key === 'Enter' || e.key === 'Return') {
        e.preventDefault();
        const key = keys[highlightedIndex.value];
        if (key) {
            handleProviderSelect(key);
            uiStore.providerDropdownOpen = false;
        }
    }
};

/**
 * @description 将高亮项滚动到可视区域内
 */
const scrollHighlightedIntoView = () => {
    nextTick(() => {
        const container = dropdownContainer.value;
        if (!container) return;
        const options = container.querySelectorAll('.provider-option');
        const idx = highlightedIndex.value;
        if (idx < 0 || idx >= options.length) return;
        const el = options[idx];
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        const viewTop = container.scrollTop;
        const viewBottom = viewTop + container.clientHeight;
        if (elTop < viewTop) {
            container.scrollTop = elTop;
        } else if (elBottom > viewBottom) {
            container.scrollTop = elBottom - container.clientHeight;
        }
    });
};

/**
 * @description 组件挂载时添加事件监听器。
 */
onMounted(() => {
    document.addEventListener('click', closeDropdown);
    document.addEventListener('keydown', handleKeyDown);
});

/**
 * @description 组件卸载前移除事件监听器。
 */
onBeforeUnmount(() => {
    document.removeEventListener('click', closeDropdown);
    document.removeEventListener('keydown', handleKeyDown);
});

/**
 * @description 监听下拉菜单的打开状态，并在打开时自动聚焦搜索框。
 */
watch(() => uiStore.providerDropdownOpen, (isOpen) => {
    if (isOpen) {
        highlightedIndex.value = -1;
        nextTick(() => {
            setTimeout(() => {
                searchInputElement.value?.focus();
            }, 100); // 延迟以确保动画完成
        });
    }
});
</script>

<style scoped>
    .provider-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
    }

    .provider-header label {
        margin-bottom: 0;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .region-btn {
        background: transparent;
        border: none;
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        opacity: 0.6;
        transition: all 0.2s ease;
    }

    .region-btn:hover {
        opacity: 1;
        transform: rotate(15deg);
    }

    .custom-provider-select {
        position: relative;
        width: 100%;
    }

    .custom-provider-trigger {
        width: 100%;
        height: 48px;
        padding: 0 40px 0 16px;
        background: var(--bg-surface);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        font-size: 15px;
        font-family: var(--font-sans);
        cursor: pointer;
        display: flex;
        align-items: center;
        transition: all 0.2s ease;
    }

    .custom-provider-trigger:hover {
        border-color: var(--border-color-focus);
    }

    .custom-provider-trigger.open {
        border-color: var(--border-color-focus);
        box-shadow: var(--shadow-focus);
    }

    .custom-provider-trigger::after {
        content: '';
        position: absolute;
        right: 16px;
        top: 50%;
        width: 10px;
        height: 10px;
        border-left: 2px solid var(--text-tertiary);
        border-bottom: 2px solid var(--text-tertiary);
        transform: translateY(-60%) rotate(-45deg);
        transition: transform 0.2s ease;
    }

    .custom-provider-trigger.open::after {
        transform: translateY(-40%) rotate(135deg);
    }

    .custom-provider-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: var(--bg-surface);
        border-radius: var(--radius-md);
        border: 1px solid var(--border-color-light);
        box-shadow: var(--shadow-medium);
        z-index: 100;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-10px);
        transition: all 0.2s ease;
        max-height: 300px;
        overflow-y: auto;
    }

    .custom-provider-dropdown.open {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
    }

    .provider-search-input {
        width: calc(100% - 32px);
        margin: 8px 16px;
        height: 40px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        padding: 0 12px;
        font-size: 15px;
        font-family: var(--font-sans);
    }

    .provider-option {
        padding: 12px 16px;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 15px;
        font-family: var(--font-sans);
        border-bottom: 1px solid var(--border-color-light);
    }

    .provider-option:last-child {
        border-bottom: none;
    }

    .provider-option:hover {
        background: var(--bg-tertiary);
    }

    .provider-option.selected {
        background-color: var(--bg-selected);
        color: var(--accent-primary);
        font-weight: 600;
    }

    .provider-option.highlighted {
        outline: 2px solid var(--accent-primary);
        outline-offset: -2px;
        background: var(--bg-tertiary);
    }

    .provider-option .provider-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        background: var(--accent-dark);
        color: white;
        border-radius: 4px;
    }

    .region-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: none;
    }

    .custom-provider-select.disabled {
        opacity: 0.6;
        pointer-events: none;
        background-color: var(--bg-secondary);
    }

    .switch-label {
        display: inline-flex;
        align-items: center;
        cursor: pointer;
        gap: 8px;
        user-select: none;
    }

    .switch-label input[type="checkbox"] {
        display: none;
    }

    .slider {
        position: relative;
        width: 44px;
        height: 24px;
        background-color: var(--bg-tertiary);
        border-radius: 12px;
        transition: background-color 0.2s;
        flex-shrink: 0;
        border: 1px solid var(--border-color);
    }

    .slider::before {
        content: '';
        position: absolute;
        height: 20px;
        width: 20px;
        left: 2px;
        bottom: 2px;
        background-color: white;
        border-radius: 50%;
        transition: transform 0.2s;
    }

    .switch-label input:checked+.slider {
        background-color: var(--accent-primary);
        border-color: var(--accent-primary);
    }

    .switch-label input:checked+.slider::before {
        transform: translateX(20px);
    }

    .switch-title {
        font-weight: 600;
        color: var(--text-secondary);
        font-size: 0.9rem;
    }

    .switch-label:has(input:disabled) {
        cursor: not-allowed;
        opacity: 0.6;
    }

    @media (max-width: 480px) {
        .custom-provider-dropdown {
            max-height: 60vh;
        }
    }
</style>