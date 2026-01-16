/**
 * 重试逻辑工具函数
 */

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 判断是否为可重试的错误
 * @param {Error} error - 错误对象
 * @returns {boolean}
 */
export function isRetryableError(error) {
  const msg = error.message || ''
  return (
    msg === 'TOKEN_EXPIRED' ||
    msg.includes('403') ||
    msg.includes('401') ||
    msg.includes('token') ||
    msg.includes('expired') ||
    msg.includes('unauthorized')
  )
}

/**
 * 判断是否为配额耗尽错误 (402)
 * 402 错误表示账号配额已用完，次月1日才会恢复，不应重试
 * @param {Error} error - 错误对象
 * @returns {boolean}
 */
export function isQuotaExhaustedError(error) {
  const msg = error.message || ''
  return msg.includes('402') || msg.includes('quota') || msg.includes('Payment Required')
}
