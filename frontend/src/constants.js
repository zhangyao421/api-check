/**
 * @description 应用程序的全局常量配置。
 */

/**
 * @description 单次检测支持的最大 Key 数量。
 * 超过此限制会提示用户分批处理。
 */
export const MAX_KEYS_LIMIT = 50000;

/**
 * @description 文件导入的最大大小（字节）。
 * 10MB 足以容纳 5 万个 Key。
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
