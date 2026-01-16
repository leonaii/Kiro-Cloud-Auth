/**
 * 请求处理工具函数
 */

/**
 * 获取客户端 IP
 * @param {object} req - Express 请求对象
 * @returns {string}
 */
export function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress
}

/**
 * 脱敏请求头（移除敏感信息）
 * @param {object} headers - 请求头对象
 * @returns {object}
 */
export function sanitizeHeaders(headers) {
  if (!headers) return {}
  const sanitized = { ...headers }
  // 脱敏 Authorization 头
  if (sanitized.authorization) {
    sanitized.authorization = sanitized.authorization.substring(0, 20) + '...[REDACTED]'
  }
  if (sanitized['x-api-key']) {
    sanitized['x-api-key'] = sanitized['x-api-key'].substring(0, 10) + '...[REDACTED]'
  }
  // 移除 cookie
  delete sanitized.cookie
  return sanitized
}
