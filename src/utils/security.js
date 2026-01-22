/**
 * @description 从环境变量中解析允许的 CORS 来源白名单。
 * 预期环境变量 `ALLOWED_ORIGINS` 为 JSON 字符串数组，例如 `'["https://example.com","https://*.example.com"]''`。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @returns {string[]} - 解析后的允许来源数组，如果解析失败则返回空数组。
 */
export function getAllowedOrigins(env) {
    try {
        return JSON.parse(env.ALLOWED_ORIGINS || "[]");
    } catch (e) {
        return [];
    }
}

/**
 * @description 校验请求的 Origin 是否在允许的白名单范围内。
 * 支持子域通配符（例如 `https://*.example.com`）。
 * @param {string} origin - 请求头中的 Origin 字符串。
 * @param {string[]} allowedOrigins - 允许的 Origin 白名单数组。
 * @returns {string|null} - 如果 Origin 合法，则返回实际的 Origin 字符串；否则返回 `null`。
 */
export function validateOrigin(origin, allowedOrigins) {
    if (!origin) return null;

    for (const rule of allowedOrigins) {
        // 精确匹配
        if (rule === origin) return origin;

        // 通配符模式匹配（限制只匹配单层子域名）
        if (rule.includes("*")) {
            const regex = new RegExp("^" + rule
                .replace(/\./g, "\\.") // 转义点
                .replace(/\*/g, "[^.]+") + "$" // 将星号转换为匹配不包含点的字符串（单层子域名）
            );
            if (regex.test(origin)) return origin;
        }
    }
    return null;
}

/**
 * @description 校验目标 URL 的安全性，防止 SSRF（Server-Side Request Forgery）攻击。
 * 允许 HTTP/HTTPS 协议，并禁止访问常见的内网地址。
 * @param {string} targetUrl - 待校验的目标 URL 字符串。
 * @returns {boolean} - 如果 URL 安全则返回 `true`，否则返回 `false`。
 */
export function validateTargetUrl(targetUrl) {
    try {
        const url = new URL(targetUrl);

        // 只允许 HTTP/HTTPS 协议
        if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error("只允许 HTTP/HTTPS 协议");
        }

        const hostname = url.hostname;

        // 禁止访问常见的内网 IP 范围和 localhost
        const forbidden = [
            "127.", "10.", "192.168.", "169.254.", "localhost",
            // 172.16.0.0/12 范围 (172.16.x.x - 172.31.x.x)
            "172.16.", "172.17.", "172.18.", "172.19.",
            "172.20.", "172.21.", "172.22.", "172.23.",
            "172.24.", "172.25.", "172.26.", "172.27.",
            "172.28.", "172.29.", "172.30.", "172.31.",
            // 其他特殊地址
            "0.0.0.0", "0.", "::1", "[::1]"
        ];
        if (forbidden.some((prefix) => hostname.startsWith(prefix) || hostname === prefix.replace(/\.$/, ''))) {
            throw new Error("目标地址不允许访问内网");
        }

        // 额外检查：防止 IPv6 本地地址
        if (hostname.startsWith('[') && (hostname.includes('::1') || hostname.toLowerCase().includes('fe80'))) {
            throw new Error("目标地址不允许访问本地 IPv6");
        }

        return true;
    } catch (err) {
        // 任何解析或校验错误都视为不安全
        return false;
    }
}
