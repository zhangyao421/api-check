import { validateTargetUrl } from './security.js';
import { UserAgentManager } from './userAgent.js';

/**
 * @description 单例 UserAgentManager 实例，避免每次请求都创建新实例。
 */
const uaManager = new UserAgentManager();

/**
 * @description 安全地发起代理请求的通用函数。它会根据配置决定是否通过 Durable Object 进行区域代理。
 * @param {string} url - 目标 URL。
 * @param {RequestInit} options - fetch 请求的选项。
 * @param {string} region - 指定的区域名称，用于 Durable Object 代理。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @returns {Promise<Response>} - fetch 请求的响应。
 */
export async function secureProxiedFetch(url, options, region, env) {
    if (!validateTargetUrl(url)) {
        return new Response(JSON.stringify({ error: { message: 'Invalid or forbidden target URL' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const enableUaRandomization = env.ENABLE_UA_RANDOMIZATION !== 'false';
    const enableAcceptLanguageRandomization = env.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION !== 'false';

    const finalHeaders = { ...options.headers };

    if (enableUaRandomization) {
        const randomUA = uaManager.getRandomUserAgent();
        if (randomUA) finalHeaders['user-agent'] = randomUA;
    }

    if (enableAcceptLanguageRandomization) {
        const randomAcceptLanguage = uaManager.getRandomAcceptLanguage();
        if (randomAcceptLanguage) finalHeaders['accept-language'] = randomAcceptLanguage;
    }

    const finalOptions = { ...options, headers: finalHeaders };

    // 如果没有指定区域或没有 Durable Object 绑定，则直接发起请求
    if (!region || !env.REGIONAL_FETCHER) {
        return fetch(url, finalOptions);
    }

    // 通过 Durable Object 进行区域代理
    try {
        const doId = env.REGIONAL_FETCHER.idFromName(region);
        const doStub = env.REGIONAL_FETCHER.get(doId, { location: region });

        // 将请求的详细信息作为 payload 发送给 Durable Object
        const payload = {
            targetUrl: url,
            method: finalOptions.method,
            headers: finalOptions.headers,
            body: finalOptions.body,
        };
        
        // 【优化】为了让内部代理请求的日志更具可读性，将目标主机名添加到内部 URL 中。
        // 这会将日志条目从 "POST http://do.internal/proxy" 变为类似 "POST http://do.internal/proxy/api.openai.com"
        // 这不会影响 Durable Object 的功能，因为 DO stub 的 fetch 调用不关心这个内部 URL 的路径。
        const targetHostname = new URL(url).hostname;
        const internalUrl = `http://do.internal/proxy/${targetHostname}`;

        const proxyRequestToDO = new Request(internalUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        return doStub.fetch(proxyRequestToDO);
    } catch (error) {
        console.error(`Durable Object fetch failed for region ${region}:`, error);
        // 如果 Durable Object 调用失败，则回退到直接发起请求
        return fetch(url, finalOptions);
    }
}
