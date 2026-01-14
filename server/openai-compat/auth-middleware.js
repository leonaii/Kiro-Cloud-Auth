/**
 * OpenAI 兼容 API 授权验证中间件
 *
 * 认证方式：
 * 1. JWT Cookie 认证（Web 和 Electron 统一使用）
 * 2. API Key 认证（Bearer token）
 */

import jwt from 'jsonwebtoken'
import { DEFAULT_API_KEY, ELECTRON_AUTH_SECRET } from '../config/index.js'
import { pool } from '../db/index.js'

// JWT 密钥（与 auth.js 保持一致）
const JWT_SECRET = ELECTRON_AUTH_SECRET || 'kiro-jwt-secret-2024'

// 分组 API Key 缓存（避免每次请求都查询数据库）
const groupApiKeyCache = new Map()
const CACHE_TTL = 60 * 1000 // 缓存 60 秒

/**
 * 根据 API Key 查找对应的分组 ID
 * @param {string} apiKey - API Key
 * @returns {Promise<string|null>} - 分组 ID 或 null（表示默认 SK）
 */
async function findGroupByApiKey(apiKey) {
  // 检查缓存
  const cached = groupApiKeyCache.get(apiKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.groupId
  }
  
  try {
    const [rows] = await pool.query(
      'SELECT id FROM `groups` WHERE api_key = ? LIMIT 1',
      [apiKey]
    )
    
    const groupId = rows.length > 0 ? rows[0].id : null
    
    // 更新缓存
    groupApiKeyCache.set(apiKey, {
      groupId,
      expiresAt: Date.now() + CACHE_TTL
    })
    
    return groupId
  } catch (error) {
    console.error('[OpenAI Auth] Failed to query group by API key:', error.message)
    return null
  }
}

/**
 * 清除分组 API Key 缓存（在分组更新时调用）
 */
export function clearGroupApiKeyCache() {
  groupApiKeyCache.clear()
  console.log('[OpenAI Auth] Group API key cache cleared')
}

/**
 * 验证 API Key 中间件
 * 检查请求的 Authorization header 是否包含有效的 Bearer token
 *
 * 认证优先级：
 * 1. JWT Cookie 认证（Web 和 Electron 统一使用）
 * 2. API Key 认证（Bearer token）
 *   - 默认 SK（访问所有账号）
 *   - 分组 SK（只访问分组内账号）
 */
export function validateApiKey(req, res, next) {
  // 检查 JWT token（auth_token cookie）
  // Electron 和 Web 统一使用密码认证（JWT cookie）
  const authToken = req.cookies?.auth_token
  if (authToken) {
    try {
      // 验证 JWT token
      jwt.verify(authToken, JWT_SECRET)
      console.log('[OpenAI Auth] Web client authenticated via JWT token')
      return next()
    } catch (error) {
      // JWT 验证失败（过期或无效），继续尝试其他认证方式
      console.log('[OpenAI Auth] JWT token validation failed:', error.message)
    }
  }
  
  // 如果没有配置默认 API Key，则跳过验证
  if (!DEFAULT_API_KEY) {
    console.warn('[Auth] DEFAULT_API_KEY not configured, skipping authentication')
    return next()
  }

  const authHeader = req.headers.authorization

  // 检查是否提供了 Authorization header
  if (!authHeader) {
    return res.status(401).json({
      error: {
        message: 'Missing Authorization header',
        type: 'authentication_error',
        code: 'missing_authorization'
      }
    })
  }

  // 检查格式是否为 "Bearer <token>"
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: {
        message: 'Invalid Authorization header format. Expected: Bearer <token>',
        type: 'authentication_error',
        code: 'invalid_authorization_format'
      }
    })
  }

  const providedKey = parts[1]

  // 验证 API Key 是否匹配默认 SK
  if (providedKey === DEFAULT_API_KEY) {
    // 默认 SK，可以访问所有账号
    req.groupId = null // null 表示不限制分组
    console.log('[OpenAI Auth] Authenticated with default API key (all accounts)')
    return next()
  }

  // 检查是否为分组 SK
  findGroupByApiKey(providedKey)
    .then(groupId => {
      if (groupId) {
        // 分组 SK，只能访问该分组内的账号
        req.groupId = groupId
        console.log(`[OpenAI Auth] Authenticated with group API key (group: ${groupId})`)
        return next()
      }
      
      // 无效的 API Key
      return res.status(401).json({
        error: {
          message: 'Invalid API key',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      })
    })
    .catch(error => {
      console.error('[OpenAI Auth] Error validating API key:', error)
      return res.status(500).json({
        error: {
          message: 'Internal server error during authentication',
          type: 'server_error',
          code: 'auth_error'
        }
      })
    })
}

export default validateApiKey