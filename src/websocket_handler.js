import * as checker from './checkers.js';
import * as providersData from '../config/providers.json';

/**
 * @description TaskManager 类负责处理单个、有限大小的批次。
 * 它在一个独立的 WebSocket 会话中完成一个批次的处理。
 */
class TaskManager {
    /**
     * @param {object} env - Cloudflare Worker 的环境变量。
     * @param {object} callbacks - 包含 onResult, onStatus, onError, onDone 等回调函数。
     */
    constructor(env, { onResult, onStatus, onError, onDone }) {
        this.env = env;
        this.callbacks = { onResult, onStatus, onError, onDone };

        this.queue = [];
        this.currentIndex = 0; // 使用索引替代 shift() 避免竞争条件
        this.isStopped = false;
        this.concurrency = 5;
        this.providerMeta = null;
        this.providerConfig = null;
    }

    /**
     * @description 线程安全地获取下一个任务项。
     * @returns {object|null} - 下一个任务项，如果队列为空则返回 null。
     */
    getNextItem() {
        if (this.currentIndex >= this.queue.length) return null;
        return this.queue[this.currentIndex++];
    }

    /**
     * @description 开始处理接收到的一个批次任务。
     * @param {object} initialData - 包含 tokens, providerConfig, concurrency 的初始数据。
     */
    start(initialData) {
        const { tokens, providerConfig, concurrency } = initialData;

        if (!tokens || !Array.isArray(tokens) || !providerConfig) {
            this.callbacks.onError('Invalid initial data for a batch');
            return;
        }

        // 使用前端传来的 tokens 数组。
        this.queue = tokens;

        this.concurrency = concurrency || 5;
        this.providerConfig = providerConfig;
        this.providerMeta = providersData.default[providerConfig.provider];

        if (!this.providerMeta) {
            this.callbacks.onError(`Provider '${providerConfig.provider}' not found`);
            return;
        }
        
        this.runWorkerPool();
    }

    /**
     * @description 创建并运行一个并发工作池来处理当前批次的任务。
     */
    async runWorkerPool() {
        const workerPromises = [];
        for (let i = 0; i < this.concurrency; i++) {
            const worker = async () => {
                while (true) {
                    if (this.isStopped) break;

                    const item = this.getNextItem();
                    if (!item) break;

                    await this.runCheck(item);

                    await new Promise(r => setTimeout(r, 0));
                }
            };
            workerPromises.push(worker());
        }

        await Promise.all(workerPromises);

        if (!this.isStopped) {
            this.callbacks.onDone('Batch processing complete');
        }
    }

    /**
     * @description 运行单个 Key 的检测。
     * @param {object} item - 包含 token 和 order 的任务项。
     */
    async runCheck(item) {
        if (this.isStopped) return;
        try {
            // 从 item 对象中正确地取出 token 字符串进行检测
            const result = await checker.checkToken(item.token, this.providerMeta, this.providerConfig, this.env);
            this.callbacks.onResult({ ...result, order: item.order });
        } catch (e) {
            this.callbacks.onResult({ token: item.token, message: e.message, error: true, order: item.order });
        }
    }

    /**
     * @description 停止当前批次的任务。
     */
    stop() {
        this.isStopped = true;
    }
}

/**
 * @description 处理 WebSocket 会话的入口函数。每个会话处理一个批次的检测任务。
 * @param {WebSocket} ws - WebSocket 服务器端实例。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @returns {Promise<void>}
 */
export function handleWebSocketSession(ws, env) {
    ws.accept();

    const taskManager = new TaskManager(env, {
        onResult: (result) => ws.send(JSON.stringify({ type: 'result', data: result })),
        onStatus: (message) => ws.send(JSON.stringify({ type: 'status', message })),
        onError: (message) => {
            ws.send(JSON.stringify({ type: 'error', message }));
            ws.close(1011, message);
        },
        onDone: (message) => {
            ws.send(JSON.stringify({ type: 'done', message }));
            ws.close(1000, 'Work complete');
        },
    });

    return new Promise((resolve, reject) => {
        ws.addEventListener('message', event => {
            try {
                const message = JSON.parse(event.data);
                if (message.command === 'start') {
                    taskManager.start(message.data);
                } else if (message.command === 'stop') {
                    taskManager.stop();
                    ws.close(1000, 'Client requested stop');
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Unknown command for this session' }));
                }
            } catch (e) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
            }
        });

        const closeOrErrorHandler = (err) => {
            taskManager.stop();
            if (err) {
                console.error('WebSocket error:', err);
                reject(err);
            } else {
                resolve();
            }
        };

        ws.addEventListener('close', () => closeOrErrorHandler());
        ws.addEventListener('error', (err) => closeOrErrorHandler(err));
    });
}
