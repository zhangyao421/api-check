import { corsHeaders, handleOptions } from './utils/cors.js';
import { handleWebSocketSession } from './websocket_handler.js';
import * as modelFetcher from './model_fetchers.js';
import * as providersData from '../config/providers.json';

/**
 * @description Durable Object (DO) 用于从指定的 Cloudflare 区域发起网络请求。
 * 它接收一个内部请求，解析出真正的目标 URL 和参数，然后从该 DO 所在的区域发起 fetch。
 */
export class RegionalFetcher {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const { targetUrl, method, headers, body } = await request.json();
        const upstreamRequest = new Request(targetUrl, {
            method,
            headers,
            body: typeof body === 'object' ? JSON.stringify(body) : body
        });
        return fetch(upstreamRequest);
    }
}

/**
 * @description 处理 /models API 请求，用于获取指定提供商的可用模型列表。
 * @param {Request} request - 传入的请求对象。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @returns {Promise<Response>} - 包含模型列表或错误信息的响应。
 */
async function handleModelsRequest(request, env) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let requestBody;
    try {
        requestBody = await request.json();
    } catch (e) {
        return new Response('Invalid JSON in request body', { status: 400 });
    }

    const { token, providerConfig } = requestBody;
    if (!token || !providerConfig) {
        return new Response('Invalid request body', { status: 400 });
    }

    const providerMeta = providersData.default[providerConfig.provider];
    if (!providerMeta) {
        return new Response(`Provider '${providerConfig.provider}' not found`, { status: 400 });
    }

    try {
        const models = await modelFetcher.getModels(providerMeta, token, providerConfig, env);
        const responseHeaders = corsHeaders(request, env);
        responseHeaders['Content-Type'] = 'application/json';
        return new Response(JSON.stringify(models), { headers: responseHeaders });
    } catch (error) {
        const responseHeaders = corsHeaders(request, env);
        responseHeaders['Content-Type'] = 'application/json';
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: responseHeaders,
        });
    }
}

/**
 * @description Cloudflare Worker 的主入口点。
 * 它处理所有传入的 HTTP 请求，并根据路径路由到不同的处理器。
 */
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 处理 CORS 预检请求
        if (request.method === 'OPTIONS') {
            return handleOptions(request, env);
        }

        // /check 路径用于 WebSocket 连接，处理实时检测任务
        if (pathname === '/check') {
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return new Response('Expected a WebSocket upgrade request', { status: 426 });
            }

            const [client, server] = Object.values(new WebSocketPair());
            
            // 将 WebSocket 会话处理委托给 handler，并确保 Worker 在会话期间保持活动状态
            ctx.waitUntil(handleWebSocketSession(server, env));

            const responseHeaders = corsHeaders(request, env);

            // 返回 101 响应，升级连接到 WebSocket
            return new Response(null, {
                status: 101,
                webSocket: client,
                headers: responseHeaders,
            });
        }

        // /models 路径用于获取模型列表
        if (pathname === '/models') {
            return handleModelsRequest(request, env);
        }

        // 默认情况下，尝试提供静态资源（前端应用）
        try {
            return await env.ASSETS.fetch(request);
        } catch (e) {
            return new Response("静态资源服务配置错误，请检查 wrangler.toml。", { status: 500 });
        }
    },
};