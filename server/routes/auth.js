/**
 * Web 后台登录认证路由 - JWT 版本
 */

import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { WEB_LOGIN_PASSWORD, ELECTRON_AUTH_SECRET } from '../config/index.js'

const router = Router()

// JWT 密钥（使用 ELECTRON_AUTH_SECRET 或默认值）
const JWT_SECRET = ELECTRON_AUTH_SECRET || 'kiro-jwt-secret-2024'

// JWT 有效期（30天）
const JWT_EXPIRES_IN = '30d'

/**
 * POST /api/auth/login - 登录
 */
router.post('/api/auth/login', async (req, res) => {
  const { password } = req.body

  // 如果未配置密码，则不启用登录验证
  if (!WEB_LOGIN_PASSWORD) {
    return res.json({
      success: true,
      message: '登录验证未启用',
      requireAuth: false
    })
  }

  // 验证密码
  if (password !== WEB_LOGIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: '密码错误'
    })
  }

  // 生成 JWT token
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000 // 30天
  const token = jwt.sign(
    {
      type: 'web_auth',
      createdAt: Date.now(),
      expiresAt
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )

  // 设置 cookie（30天有效期）
  // 注意：httpOnly 设置为 false，允许 JavaScript 访问 cookie
  // 这是为了让 Electron 渲染进程能够获取 token 并传递给主进程
  res.cookie('auth_token', token, {
    httpOnly: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  })

  res.json({
    success: true,
    message: '登录成功',
    expiresAt
  })
})

/**
 * POST /api/auth/logout - 登出
 */
router.post('/api/auth/logout', async (req, res) => {
  res.clearCookie('auth_token', { path: '/' })
  res.json({ success: true, message: '已登出' })
})

/**
 * GET /api/auth/check - 检查登录状态
 */
router.get('/api/auth/check', (req, res) => {
  // 如果未配置密码，则不需要登录
  if (!WEB_LOGIN_PASSWORD) {
    return res.json({
      authenticated: true,
      requireAuth: false
    })
  }

  const token = req.cookies?.auth_token

  if (!token) {
    return res.json({
      authenticated: false,
      requireAuth: true
    })
  }

  try {
    // 验证 JWT token
    const decoded = jwt.verify(token, JWT_SECRET)
    
    res.json({
      authenticated: true,
      requireAuth: true,
      expiresAt: decoded.expiresAt
    })
  } catch (error) {
    // JWT 验证失败（过期或无效）
    res.clearCookie('auth_token', { path: '/' })
    return res.json({
      authenticated: false,
      requireAuth: true
    })
  }
})

export default router