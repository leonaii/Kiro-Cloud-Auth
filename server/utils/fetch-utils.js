/**
 * Fetch 相关工具函数
 */

// 默认请求超时时间（毫秒）- 用于 AbortController
export const DEFAULT_REQUEST_TIMEOUT = 600000 // 10分钟

/**
 * 创建带超时的 fetch 请求
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_REQUEST_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}
