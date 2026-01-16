/**
 * Kiro-Cloud-Auth  - 服务器入口
 */
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// 配置
import { APP_VERSION, SERVER_ID, PORT } from './config/index.js'
import { pool, getConnectionWithRetry } from './config/database.js'

// 数据库
import { initDatabase } from './db/init.js'
import { migrateDatabase, validateDatabase } from './db/migrate.js'
import { fixClientSecretColumn } from './db/fix-client-secret.js'

// 路由
import {
  healthRoutes,
  accountRoutes,
  accountV2Routes,
  groupRoutes,
  groupV2Routes,
  tagRoutes,
  tagV2Routes,
  settingRoutes,
  settingV2Routes,
  machineIdRoutes,
  dataRoutes,
  syncRoutes,
  monitoringRoutes
} from './routes/index.js'

// 监控模块的 TokenRefresher 设置函数
import { setTokenRefresher as setMonitoringTokenRefresher } from './routes/monitoring.js'

// 登录认证
import authRoutes from './routes/auth.js'
import { requireAuth } from './middleware/auth-middleware.js'

// OpenAI 兼容 API
import { initOpenAIRoutes } from './openai-compat/openai-routes.js'

// Claude 兼容 API
import { initClaudeRoutes } from './openai-compat/claude-routes.js'

// 账号池管理
import AccountPool from './openai-compat/account-pool.js'

// Token 刷新服务
import TokenRefresher from './token-refresher.js'

// 系统日志
import SystemLogger, { initSystemLogger } from './openai-compat/system-logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 创建 Express 应用
const app = express()

// 中间件
app.use(cors())
// 增加 JSON 解析器限制以支持大上下文请求（200k tokens ≈ 800KB 文本，加上 JSON 结构可能更大）
app.use(express.json({ limit: '100mb' }))
app.use(cookieParser())

// 注册登录路由（不需要认证）
app.use(authRoutes)

// 应用登录验证中间件（保护所有 API 路由）
app.use('/api', requireAuth)

// 注册路由（需要认证）
app.use(healthRoutes)
app.use(accountRoutes)
app.use(accountV2Routes)  // v2 账号接口（带版本控制）
app.use(groupRoutes)
app.use(groupV2Routes)    // v2 分组接口（带版本控制）
app.use(tagRoutes)
app.use(tagV2Routes)      // v2 标签接口（带版本控制）
app.use(settingRoutes)
app.use(settingV2Routes)  // v2 设置接口（带版本控制）
app.use(machineIdRoutes)
app.use(dataRoutes)
app.use(syncRoutes)
app.use('/api/monitoring', monitoringRoutes)  // 监控仪表板API

// 系统日志实例（全局，使用单例模式）
const systemLogger = initSystemLogger(pool)

// Token 刷新服务实例（全局，用于获取下次检测时间）
let tokenRefresher = null

// 账号池实例（全局，用于活跃池管理）
// 在模块加载时创建，以便路由可以使用
let accountPool = new AccountPool(pool, systemLogger)

// 获取 Token 刷新服务实例
export function getTokenRefresher() {
  return tokenRefresher
}

// 获取账号池实例
export function getAccountPool() {
  return accountPool
}

// OpenAI 兼容 API（传入共享的 accountPool）
const openaiRoutes = initOpenAIRoutes(pool, systemLogger, accountPool)
app.use(openaiRoutes)

// Claude 兼容 API（传入共享的 accountPool）
const claudeRoutes = initClaudeRoutes(pool, systemLogger, accountPool)
app.use(claudeRoutes)

// 系统日志 API
app.get('/api/system-logs', async (req, res) => {
  try {
    const { page, pageSize, type, level, serverId, startTime, endTime } = req.query
    console.log('[API] /api/system-logs query:', { page, pageSize, type, level, serverId })
    const result = await systemLogger.getLogs({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      type: type || undefined,
      level: level || undefined,
      serverId: serverId || undefined,
      startTime,
      endTime
    })
    console.log('[API] /api/system-logs result:', { dataLength: result.data?.length, pagination: result.pagination })
    res.json(result)
  } catch (error) {
    console.error('[API] /api/system-logs error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/system-logs/stats', async (req, res) => {
  try {
    const stats = await systemLogger.getStats()
    res.json(stats)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 清空系统日志
app.delete('/api/system-logs', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM system_logs')
    res.json({ success: true, deleted: result.affectedRows })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 获取日志中的服务器 ID 列表
app.get('/api/server-ids', async (req, res) => {
  try {
    const [systemServers] = await pool.query(
      'SELECT DISTINCT server_id FROM system_logs WHERE server_id IS NOT NULL ORDER BY server_id'
    )
    const [requestServers] = await pool.query(
      'SELECT DISTINCT server_id FROM api_request_logs WHERE server_id IS NOT NULL ORDER BY server_id'
    )
    const serverIds = [...new Set([
      ...systemServers.map(r => r.server_id),
      ...requestServers.map(r => r.server_id)
    ])].sort()
    res.json({ serverIds })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 第三方 OpenAI API 代理（用于 AI 生成提示词功能）
app.post('/api/proxy/openai', async (req, res) => {
  try {
    const { apiUrl, apiKey, model, messages, stream } = req.body

    if (!apiUrl || !apiKey) {
      return res.status(400).json({ error: '缺少 apiUrl 或 apiKey' })
    }

    // 智能处理 URL：去除尾部斜杠，如果不包含 /v1 则自动添加
    let baseUrl = apiUrl.replace(/\/+$/, '')
    if (!baseUrl.includes('/v1')) {
      baseUrl = `${baseUrl}/v1`
    }
    const endpoint = `${baseUrl}/chat/completions`
    console.log('[Proxy] Request endpoint:', endpoint)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream })
    })

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(response.status).json({ error: errorText })
    }

    if (stream) {
      // 流式响应
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          res.write(chunk)
        }
      } finally {
        res.end()
      }
    } else {
      const data = await response.json()
      res.json(data)
    }
  } catch (error) {
    console.error('[Proxy] OpenAI request failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// 第三方 OpenAI API 模型列表代理
app.post('/api/proxy/openai/models', async (req, res) => {
  try {
    const { apiUrl, apiKey } = req.body

    if (!apiUrl || !apiKey) {
      return res.status(400).json({ error: '缺少 apiUrl 或 apiKey' })
    }

    // 智能处理 URL：去除尾部斜杠，如果不包含 /v1 则自动添加
    let baseUrl = apiUrl.replace(/\/+$/, '')
    if (!baseUrl.includes('/v1')) {
      baseUrl = `${baseUrl}/v1`
    }
    const endpoint = `${baseUrl}/models`

    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(response.status).json({ error: errorText })
    }

    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error('[Proxy] OpenAI models request failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// 静态文件服务
app.use(express.static(join(__dirname, '../dist/webui')))
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/webui/index.html'))
})

// HTTP 服务器实例（用于优雅关闭）
let server = null
let isShuttingDown = false

// 优雅关闭函数
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`[Server] Already shutting down, ignoring ${signal}`)
    return
  }
  isShuttingDown = true
  console.log(`[Server] ${signal} received, starting graceful shutdown...`)

  // 停止接受新连接
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed, no longer accepting connections')
    })
  }

  // 停止 Token 刷新服务
  if (tokenRefresher) {
    tokenRefresher.stop()
    console.log('[Server] Token refresher stopped')
  }

  // 停止账号池监控
  if (accountPool) {
    accountPool.stopActivePoolMonitor()
    accountPool.stopHealthMonitor()
    console.log('[Server] Account pool monitors stopped')
  }

  // 停止系统日志清理
  systemLogger.stopCleanupTask()
  console.log('[Server] System logger cleanup stopped')

  // 等待现有请求完成（最多等待 10 秒）
  const shutdownTimeout = 10000
  const startTime = Date.now()

  // 给现有请求一些时间完成
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 关闭数据库连接池
  try {
    await pool.end()
    console.log('[Server] Database pool closed')
  } catch (error) {
    console.error('[Server] Error closing database pool:', error.message)
  }

  const elapsed = Date.now() - startTime
  console.log(`[Server] Graceful shutdown completed in ${elapsed}ms`)
  process.exit(0)
}

// 注册信号处理
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// 启动服务器
async function start() {
  console.log(`[Server] Version: ${APP_VERSION}`)
  console.log(`[Server] ID: ${SERVER_ID}`)

  try {
    // 初始化数据库
    const conn = await getConnectionWithRetry({ operationName: 'server_init' })
    try {
      await initDatabase(conn)
      await migrateDatabase(conn)
      await validateDatabase(conn)
    } finally {
      conn.release()
    }

    // 修复字段长度问题
    await fixClientSecretColumn()

    // 启动系统日志清理任务
    systemLogger.startCleanupTask()

    // 记录服务启动日志
    await systemLogger.logSystem({
      action: 'server_start',
      message: `服务启动成功 (版本: ${APP_VERSION}, ID: ${SERVER_ID})`,
      details: { version: APP_VERSION, serverId: SERVER_ID }
    })

    // 启动账号池监控（accountPool 已在模块加载时创建）
    accountPool.startHealthMonitor()
    accountPool.startActivePoolMonitor()
    console.log(`✓ Account pool initialized (active pool enabled: ${accountPool.activePoolConfig.enabled}, limit: ${accountPool.activePoolConfig.limit})`)

    // 启动 Token 自动刷新服务（可通过环境变量禁用）
    const disableTokenRefresh = process.env.DISABLE_TOKEN_REFRESH === 'true'
    if (!disableTokenRefresh) {
      tokenRefresher = new TokenRefresher(pool, systemLogger, accountPool)
      tokenRefresher.start()
      // 将 tokenRefresher 实例传递给监控模块
      setMonitoringTokenRefresher(tokenRefresher)
    }

    // 启动 HTTP 服务器
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Server [${SERVER_ID}] running on http://0.0.0.0:${PORT}`)
      console.log(`✓ Database: ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}`)
      console.log(`✓ Token auto-refresh: ${disableTokenRefresh ? 'DISABLED' : 'enabled'}`)
      console.log(`✓ Active pool: ${accountPool.activePoolConfig.enabled ? `enabled (limit: ${accountPool.activePoolConfig.limit})` : 'DISABLED'}`)
      console.log(`✓ OpenAI compatible API: http://0.0.0.0:${PORT}/v1/chat/completions`)
      console.log(`✓ Pool status: http://0.0.0.0:${PORT}/v1/pool/status`)
      console.log(`✓ Accounts V2 API: http://0.0.0.0:${PORT}/api/v2/accounts`)
      console.log(`✓ Groups V2 API: http://0.0.0.0:${PORT}/api/v2/groups`)
      console.log(`✓ Tags V2 API: http://0.0.0.0:${PORT}/api/v2/tags`)
      console.log(`✓ Settings V2 API: http://0.0.0.0:${PORT}/api/v2/settings`)
      console.log(`✓ Monitoring API: http://0.0.0.0:${PORT}/api/monitoring`)
      console.log(`✓ Graceful shutdown: enabled (SIGTERM/SIGINT)`)
    })

    // 设置服务器超时
    server.keepAliveTimeout = 65000  // 比 nginx 的 keepalive_timeout 稍长
    server.headersTimeout = 66000
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

start()
