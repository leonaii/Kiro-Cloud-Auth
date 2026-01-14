/**
 * Web 后台登录验证中间件 - JWT 版本
 * Electron 和 Web 统一使用密码认证（JWT cookie）
 */

import jwt from 'jsonwebtoken'
import { WEB_LOGIN_PASSWORD, ELECTRON_AUTH_SECRET } from '../config/index.js'

// JWT 密钥（与 auth.js 保持一致）
const JWT_SECRET = ELECTRON_AUTH_SECRET || 'kiro-jwt-secret-2024'

/**
 * 验证登录状态中间件
 * 检查请求的 cookie 是否包含有效的 JWT token
 */
export function requireAuth(req, res, next) {
  // 如果未配置密码，则跳过验证
  if (!WEB_LOGIN_PASSWORD) {
    return next()
  }

  // 允许访问登录相关的 API
  if (req.path.startsWith('/api/auth/')) {
    return next()
  }

  // 允许访问健康检查
  if (req.path === '/api/health') {
    return next()
  }

  // Electron 和 Web 统一使用 JWT cookie 认证
  const token = req.cookies?.auth_token

  // 检查是否提供了 token
  if (!token) {
    return res.status(401).json({
      error: {
        message: 'Unauthorized: Please login first',
        type: 'authentication_error',
        code: 'missing_auth_token'
      }
    })
  }

  try {
    // 验证 JWT token
    jwt.verify(token, JWT_SECRET)
    // 验证通过，继续处理请求
    next()
  } catch (error) {
    // JWT 验证失败（过期或无效）
    return res.status(401).json({
      error: {
        message: 'Unauthorized: Token expired or invalid',
        type: 'authentication_error',
        code: 'token_expired'
      }
    })
  }
}

export default requireAuth