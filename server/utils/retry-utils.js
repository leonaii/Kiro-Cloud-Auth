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

/**
 * 判断是否为账号被封禁错误
 * 包括：Bad credentials（凭证无效）和 BANNED:TEMPORARILY_SUSPENDED（临时封禁）
 * 这类错误应该永久移除账号并标记为封禁状态
 * @param {Error} error - 错误对象
 * @returns {boolean}
 */
export function isBannedError(error) {
  const msg = error.message || ''
  return (
    msg.includes('Bad credentials') ||
    msg.includes('BANNED:TEMPORARILY_SUSPENDED') ||
    msg.includes('BANNED:') ||
    msg.includes('account has been suspended') ||
    msg.includes('account is suspended')
  )
}
