import regionsData from '../../config/regions.json';
import providersData from '../../config/providers.json';

/**
 * @description 区域数据，从配置文件加载。
 */
export const REGIONS = regionsData;
/**
 * @description 提供商数据，从配置文件加载。
 */
export const PROVIDERS = providersData;

/**
 * @description 调用后端 /models 接口，获取指定提供商的可用模型列表。
 * @param {string} token - 用于认证的 API Key。
 * @param {object} providerConfig - 提供商的配置信息，包含当前提供商、基础URL和区域。
 * @returns {Promise<string[]>} - 可用模型ID的数组。
 * @throws {Error} - 如果请求失败或返回无效数据。
 */
export async function fetchModels(token, providerConfig) {
    const body = {
        token,
        providerConfig: {
            provider: providerConfig.currentProvider,
            baseUrl: providerConfig.baseUrl,
            region: providerConfig.currentRegion,
        },
    };
    const response = await fetch('/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'An unknown error occurred' }));
        throw new Error(err.error || `HTTP error! status: ${response.status}`);
    }
    return response.json();
}

/**
 * @description 根据 API Key 检测结果的原始响应，将其归类到不同的错误类别。
 * @param {object} res - API Key 检测的原始结果对象。
 * @returns {{category: string, simpleMessage: string}} - 包含分类和简单消息的对象。
 */
export function categorizeTokenError(res) {
    if (!res || res.isValid) return { category: "valid", simpleMessage: "有效" };

    const { rawError, message } = res;
    const status = rawError?.status || 0;
    const lowerCaseMessage = (message || JSON.stringify(rawError) || "").toLowerCase();
    // 修复：rawError 的结构是 { status, content }，所以需要从 content 中提取
    const errorContent = rawError?.content || {};
    const errorCode = errorContent?.error?.code || errorContent?.code;
    const errorType = errorContent?.error?.type || errorContent?.type;

    if (status === 401 || errorCode === 'invalid_api_key' || errorType === 'invalid_api_key') {
        return { category: "invalid", simpleMessage: "API_KEY 无效" };
    }
    if (errorType === 'access_terminated') {
        return { category: "invalid", simpleMessage: "账户已被封禁或停用" };
    }
    if (status === 402) {
        return { category: "noQuota", simpleMessage: "额度不足 (Payment Required)" };
    }
    if (errorCode === 'insufficient_quota' || errorType === 'insufficient_quota') {
        return { category: "noQuota", simpleMessage: "额度已耗尽或超出配额" };
    }
    if (lowerCaseMessage.includes("doesn't have a free quota tier")) {
        return { category: 'noQuota', simpleMessage: '该模型没有免费额度' };
    }
    const quotaKeywords = ['insufficient', 'credit', 'quota', 'balance', 'billing', 'paid', 'top up'];
    if (quotaKeywords.some(kw => lowerCaseMessage.includes(kw))) {
        return { category: 'noQuota', simpleMessage: '额度/余额不足' };
    }
    if (status === 429) {
        return { category: "rateLimit", simpleMessage: "请求频繁 (Rate Limit)" };
    }
    if (lowerCaseMessage.includes('location is not supported')) {
        return { category: "invalid", simpleMessage: "区域不支持" };
    }
    if (lowerCaseMessage.includes('permissiondenied')) {
        return { category: "invalid", simpleMessage: "API未在项目中启用" };
    }
    if (errorCode === 'model_not_found' || lowerCaseMessage.includes('model is not supported')) {
        return { category: 'invalid', simpleMessage: '模型不存在或不可用' };
    }
    if (status === 403) {
        return { category: "invalid", simpleMessage: "访问被拒绝 (Forbidden)" };
    }

    return { category: "invalid", simpleMessage: "验证失败" };
}
