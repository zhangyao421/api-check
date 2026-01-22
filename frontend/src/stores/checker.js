import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useConfigStore } from './config';
import { useResultsStore } from './results';
import { categorizeTokenError } from '@/api';
import { MAX_KEYS_LIMIT } from '@/constants';

/**
 * @description 每个批次发送到后端的 Key 的数量。
 */
const BATCH_SIZE = 500;

/**
 * @description checker Store 用于管理 API Key 检测的核心逻辑和状态。
 * 采用内存优先的存储策略，避免 localStorage 配额超限问题。
 */
export const useCheckerStore = defineStore('checker', () => {
    const configStore = useConfigStore();
    const resultsStore = useResultsStore();

    // --- 会话管理 (Session Management) ---
    /** @type {Ref<string|null>} 当前浏览器标签页的唯一会话 ID。*/
    const sessionId = ref(null);

    // --- 状态 (State) ---
    /** @type {Ref<boolean>} 检测任务是否正在进行中。*/
    const isChecking = ref(false);
    /** @type {Ref<boolean>} 检测任务是否处于暂停状态。*/
    const isPaused = ref(false);
    /** @type {Ref<number>} 已完成检测的 Key 数量。*/
    const completedCount = ref(0);
    /** @type {Ref<number>} 待检测 Key 的总数。*/
    const totalTasks = ref(0);
    /** @type {Ref<WebSocket|null>} 当前批次的 WebSocket 连接实例。*/
    const socket = ref(null);
    /** @type {Ref<object|null>} 用于向 UI 层传递状态消息的对象。*/
    const lastStatusMessage = ref(null);
    /** @type {number} WebSocket 重连尝试次数。*/
    let reconnectAttempts = 0;
    /** @type {number} 最大重连尝试次数。*/
    const MAX_RECONNECT_ATTEMPTS = 3;
    /** @type {Array<object>|null} 当前正在处理的批次，用于重连时恢复。*/
    let currentBatch = null;

    // --- 内存任务队列 (Memory-based Job Queue) ---
    /**
     * @description 任务队列存储在内存中，避免 localStorage 配额限制。
     * @type {object|null}
     */
    let jobQueue = null;

    // --- 结果缓冲区 (Result Buffer) ---
    /** @type {Array<{res: object, order: number}>} 结果缓冲区，用于批量添加结果。*/
    let resultBuffer = [];
    /** @type {number|null} 缓冲区刷新定时器 ID。*/
    let flushTimerId = null;
    /** @type {number} 缓冲区刷新间隔（毫秒）。*/
    const BUFFER_FLUSH_INTERVAL = 100;
    /** @type {number} 缓冲区最大容量，超过此值立即刷新。*/
    const BUFFER_MAX_SIZE = 50;

    // --- 计算属性 (Getters) ---
    /** @type {ComputedRef<number>} 检测进度百分比。*/
    const progress = computed(() => {
        if (totalTasks.value === 0) return 0;
        return Math.round((completedCount.value / totalTasks.value) * 100);
    });

    // --- 私有方法 (Private Methods) ---
    /**
     * @description 向 UI 层发布状态消息。
     * @param {string} text - 消息文本。
     * @param {string} [type='info'] - 消息类型（如 'info', 'warning', 'error', 'success'）。
     * @param {number} [duration=3000] - 消息显示时长（毫秒）。
     */
    function _postStatus(text, type = 'info', duration = 3000) {
        lastStatusMessage.value = { text, type, duration, id: Date.now() };
    }

    /**
     * @description 主调度函数，从内存队列读取任务状态，处理下一个批次或完成任务。
     */
    function processNextBatch() {
        if (isPaused.value) {
            return; // 如果处于暂停状态，则不启动新批次
        }

        // 重置重连计数器（新批次开始）
        reconnectAttempts = 0;

        if (!jobQueue || jobQueue.remainingKeys.length === 0) {
            finishCheck();
            return;
        }

        const batch = jobQueue.remainingKeys.slice(0, BATCH_SIZE);
        const remaining = jobQueue.remainingKeys.slice(BATCH_SIZE);

        // 保存当前批次以便重连时恢复
        currentBatch = { batch, providerConfig: jobQueue.providerConfig, concurrency: jobQueue.concurrency };

        // 更新队列
        jobQueue.remainingKeys = remaining;

        _postStatus(`正在处理 ${totalTasks.value - remaining.length} / ${totalTasks.value} 个 Key...`, "info");

        _connectWebSocket(jobQueue.providerConfig, batch, jobQueue.concurrency);
    }

    /**
     * @description 创建 WebSocket 连接。
     * @param {object} providerConfig - 当前任务的提供商配置。
     * @param {Array<object>} batch - 当前要处理的 Key 批次。
     * @param {number} concurrency - 并发数。
     */
    function _connectWebSocket(providerConfig, batch, concurrency) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        socket.value = new WebSocket(`${protocol}//${host}/check`);
        setupSocketListeners(providerConfig, batch, concurrency);
    }

    /**
     * @description 为单个批次的 WebSocket 连接设置监听器。
     * @param {object} providerConfig - 当前任务的提供商配置。
     * @param {Array<object>} batch - 当前要处理的 Key 批次。
     * @param {number} concurrency - 并发数。
     */
    function setupSocketListeners(providerConfig, batch, concurrency) {
        if (!socket.value) return;

        socket.value.onopen = () => {
            socket.value.send(JSON.stringify({
                command: 'start',
                data: {
                    tokens: batch,
                    providerConfig,
                    concurrency,
                }
            }));
        };

        socket.value.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'result') {
                processResult(message.data);
                // 从当前批次中移除已处理的 Key
                if (currentBatch) {
                    currentBatch.batch = currentBatch.batch.filter(k => k.order !== message.data.order);
                }
            } else if (message.type === 'done') {
                currentBatch = null; // 批次完成，清空缓存
                socket.value.close(1000, 'Batch done, processing next.');
                setTimeout(processNextBatch, 100);
            } else if (message.type === 'error') {
                 _postStatus(`后端错误: ${message.message}`, "error");
                 stopCheck();
            }
        };

        socket.value.onclose = (event) => {
            // 仅当任务未暂停且非正常关闭时，才视为意外中断
            if (event.code !== 1000 && isChecking.value && !isPaused.value) {
                // 尝试重连
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && currentBatch && currentBatch.batch.length > 0) {
                    reconnectAttempts++;
                    _postStatus(`连接断开，正在重试 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, "warning");
                    setTimeout(() => {
                        if (isChecking.value && !isPaused.value) {
                            _connectWebSocket(currentBatch.providerConfig, currentBatch.batch, currentBatch.concurrency);
                        }
                    }, 1000 * reconnectAttempts); // 指数退避
                } else {
                    _postStatus("检测连接意外关闭，重连失败，任务已停止。", "error");
                    stopCheck();
                }
            }
        };

        socket.value.onerror = (event) => {
            console.error("WebSocket Error:", event);
            // onerror 后通常会触发 onclose，所以这里只记录日志
            // 实际的重连逻辑在 onclose 中处理
        };
    }

    /**
     * @description 刷新结果缓冲区，批量添加结果到 store。
     */
    function flushResultBuffer() {
        if (resultBuffer.length === 0) return;

        // 复制缓冲区并清空
        const itemsToAdd = resultBuffer;
        resultBuffer = [];

        // 清除定时器
        if (flushTimerId !== null) {
            clearTimeout(flushTimerId);
            flushTimerId = null;
        }

        // 批量添加到 store
        resultsStore.addResults(itemsToAdd);
    }

    /**
     * @description 将结果添加到缓冲区，并在适当时机刷新。
     * @param {object} res - 处理后的结果对象。
     * @param {number} order - 结果顺序。
     */
    function bufferResult(res, order) {
        resultBuffer.push({ res, order });

        // 如果缓冲区达到最大容量，立即刷新
        if (resultBuffer.length >= BUFFER_MAX_SIZE) {
            flushResultBuffer();
            return;
        }

        // 否则，设置延迟刷新（如果尚未设置）
        if (flushTimerId === null) {
            flushTimerId = setTimeout(flushResultBuffer, BUFFER_FLUSH_INTERVAL);
        }
    }

    /**
     * @description 处理单个 Key 的检测结果，更新进度并缓冲结果。
     * @param {object} res - 单个 Key 的检测结果数据。
     */
    function processResult(res) {
        if (!res) return;
        completedCount.value++;
        const { category } = categorizeTokenError(res);
        res.finalCategory = category;

        if (res.isValid && configStore.providers[configStore.currentProvider].hasBalance) {
            if (res.balance === 0) res.finalCategory = 'zeroBalance';
            else if (res.balance < configStore.threshold) res.finalCategory = 'lowBalance';
            else res.finalCategory = 'valid';
        }

        // 使用缓冲区而非直接添加
        bufferResult(res, res.order);
    }

    /**
     * @description 完成所有检测任务后的收尾工作。
     */
    function finishCheck() {
        // 刷新缓冲区中剩余的结果
        flushResultBuffer();

        isChecking.value = false;
        // 清理内存队列
        jobQueue = null;
        currentBatch = null;

        // 定义分类 ID 到中文名称的映射
        const categoryMap = {
            valid: '有效',
            lowBalance: '低额',
            zeroBalance: '零额',
            noQuota: '无额',
            rateLimit: '限流',
            invalid: '无效',
            duplicate: '重复'
        };

        const summaryParts = [];
        // 遍历映射，按顺序生成摘要部分
        for (const category in categoryMap) {
            const count = resultsStore.results[category].length;
            if (count > 0) {
                summaryParts.push(`${categoryMap[category]} ${count}`);
            }
        }

        const summaryString = summaryParts.join('，');
        const finalMessage = summaryString ? `检测完成！${summaryString}` : '检测完成！没有有效结果。';

        _postStatus(finalMessage, "success", 8000); // 延长显示时间以便用户阅读
    }

    // --- 公开动作 (Public Actions) ---
    /**
     * @description 初始化会话，在应用根组件加载时调用。
     * 为当前浏览器标签页分配一个唯一的 ID，存储在 sessionStorage 中。
     */
    function initSession() {
        let existingSessionId = sessionStorage.getItem('llm_checker_session_id');
        if (!existingSessionId) {
            existingSessionId = crypto.randomUUID();
            sessionStorage.setItem('llm_checker_session_id', existingSessionId);
        }
        sessionId.value = existingSessionId;
    }

    /**
     * @description 开始一个全新的检测任务。
     */
    function startCheck() {
        if (configStore.tokensInput.trim() === '') {
            _postStatus("请输入至少一个 API KEY", "warning");
            return;
        }

        // 清理旧任务
        jobQueue = null;
        resultsStore.clearResults();
        completedCount.value = 0;

        const tokensRaw = configStore.tokensInput.trim().split(/[,;\n\r]+/).map(t => t.trim()).filter(Boolean);

        // 检查 Key 数量限制
        if (tokensRaw.length > MAX_KEYS_LIMIT) {
            _postStatus(`Key 数量超过限制（最多 ${MAX_KEYS_LIMIT.toLocaleString()} 个），请分批检测`, "error", 5000);
            return;
        }

        const uniqueTokens = new Set();
        const allKeys = tokensRaw.map((token, index) => ({ token, order: index }));

        const keysToProcess = [];
        const duplicateResults = [];

        allKeys.forEach(keyObj => {
            if (uniqueTokens.has(keyObj.token)) {
                duplicateResults.push({ res: { token: keyObj.token, finalCategory: 'duplicate' }, order: keyObj.order });
            } else {
                uniqueTokens.add(keyObj.token);
                keysToProcess.push(keyObj);
            }
        });

        // 批量添加重复 Key 到结果
        if (duplicateResults.length > 0) {
            resultsStore.addResults(duplicateResults);
            _postStatus(`已过滤 ${duplicateResults.length} 个重复 Key`, "info", 2000);
        }

        if (keysToProcess.length === 0) {
            _postStatus("没有需要检测的 KEY（已去除重复项）", "info");
            return;
        }

        isChecking.value = true;
        isPaused.value = false;
        totalTasks.value = keysToProcess.length;

        const currentProviderKey = configStore.currentProvider;
        const providerSettings = configStore.providerConfigs[currentProviderKey];
        const providerConfig = {
            provider: currentProviderKey,
            baseUrl: providerSettings.baseUrl,
            model: providerSettings.model,
            enableStream: providerSettings.enableStream,
            region: configStore.currentRegion,
            validationPrompt: configStore.validationPrompt,
            validationMaxTokens: configStore.validationMaxTokens,
            validationMaxOutputTokens: configStore.validationMaxOutputTokens,
        };

        // 存储到内存队列
        jobQueue = {
            remainingKeys: keysToProcess,
            providerConfig,
            concurrency: configStore.concurrency,
        };

        _postStatus(`开始检测 ${keysToProcess.length} 个 Key...`, "info");
        processNextBatch();
    }

    /**
     * @description 停止当前检测任务，清理会话状态。
     */
    function stopCheck() {
        // 刷新缓冲区中剩余的结果
        flushResultBuffer();

        isChecking.value = false;
        isPaused.value = false;
        // 清理内存队列
        jobQueue = null;
        currentBatch = null;
        if (socket.value) {
            socket.value.onclose = null;
            socket.value.close(1000, 'User stopped the job.');
            socket.value = null;
        }
        _postStatus("检测已手动停止", "info");
    }

    /**
     * @description 暂停当前检测任务。
     * 通过关闭当前 WebSocket 连接来立即中断后端的批处理。
     * 未完成的批次会被保存回任务队列，以便恢复时继续处理。
     */
    function pauseCheck() {
        if (!isChecking.value || isPaused.value) return;

        // 刷新缓冲区中剩余的结果
        flushResultBuffer();

        isPaused.value = true;

        // 将当前未完成的批次放回队列头部
        if (currentBatch && currentBatch.batch.length > 0 && jobQueue) {
            jobQueue.remainingKeys = [...currentBatch.batch, ...jobQueue.remainingKeys];
        }

        _postStatus("检测已暂停", "info");

        if (socket.value) {
            socket.value.onclose = null;
            socket.value.close(1000, 'User paused the job.');
            socket.value = null;
        }

        // 清理当前批次缓存
        currentBatch = null;
    }

    /**
     * @description 恢复暂停的检测任务。
     */
    function resumeCheck() {
        if (!isChecking.value || !isPaused.value) return;

        isPaused.value = false;
        _postStatus("检测已恢复", "info");

        processNextBatch();
    }

    return {
        initSession,
        isChecking,
        isPaused,
        completedCount,
        totalTasks,
        progress,
        lastStatusMessage,
        startCheck,
        pauseCheck,
        resumeCheck,
        stopCheck,
    };
});
