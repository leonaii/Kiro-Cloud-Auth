/**
 * 完整数据 API 路由
 * 兼容 account.json 格式的导入导出
 * 包含增强的 syncDelete 安全检查机制
 */
import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import { rowToAccount, insertAccount, rowToGroup, rowToTag, rowToSetting } from '../models/account.js'
import {
  ErrorType,
  createErrorResponse,
  createSuccessResponse,
  withTransaction,
  withConnection,
  sendErrorResponse,
  sendSuccessResponse,
  classifyDatabaseError,
  getDatabaseErrorMessage,
  validateArrayLength,
  generateRequestId
} from '../utils/error-handler.js'
import {
  validateRequest,
  validateRequestOptional,
  syncDeleteSchema,
  importDataSchema
} from '../validators/schemas.js'

const router = Router()

// 设置键列表
const SETTINGS_KEYS = [
  'activeAccountId',
  'autoRefreshEnabled',
  'autoRefreshInterval',
  'statusCheckInterval',
  'privacyMode',
  'proxyEnabled',
  'proxyUrl',
  'autoSwitchEnabled',
  'autoSwitchThreshold',
  'autoSwitchInterval',
  'theme',
  'darkMode',
  'machineIdConfig'
]

// 最大允许的账号数量（用于syncDelete安全检查）
const MAX_SYNC_DELETE_ACCOUNTS = 10000

// syncDelete 限流配置
const SYNC_DELETE_RATE_LIMIT = {
  windowMs: 5 * 60 * 1000, // 5分钟窗口
  maxRequests: 1 // 每个窗口最多1次
}

// syncDelete 限流记录（按客户端IP）
const syncDeleteRateLimitMap = new Map()

// 数据一致性检查阈值
const SYNC_DELETE_CONSISTENCY_THRESHOLD = 0.5 // 如果前端账号数量 < 服务器的50%，发出警告

/**
 * 检查 syncDelete 限流
 * @param {string} clientIp - 客户端IP
 * @returns {{allowed: boolean, retryAfter?: number}} 是否允许执行
 */
function checkSyncDeleteRateLimit(clientIp) {
  const now = Date.now()
  const lastExecution = syncDeleteRateLimitMap.get(clientIp)
  
  if (lastExecution && (now - lastExecution) < SYNC_DELETE_RATE_LIMIT.windowMs) {
    const retryAfter = Math.ceil((SYNC_DELETE_RATE_LIMIT.windowMs - (now - lastExecution)) / 1000)
    return { allowed: false, retryAfter }
  }
  
  return { allowed: true }
}

/**
 * 记录 syncDelete 执行时间
 * @param {string} clientIp - 客户端IP
 */
function recordSyncDeleteExecution(clientIp) {
  syncDeleteRateLimitMap.set(clientIp, Date.now())
  
  // 清理过期记录（每100次记录清理一次）
  if (syncDeleteRateLimitMap.size > 100) {
    const now = Date.now()
    for (const [ip, time] of syncDeleteRateLimitMap.entries()) {
      if (now - time > SYNC_DELETE_RATE_LIMIT.windowMs) {
        syncDeleteRateLimitMap.delete(ip)
      }
    }
  }
}

/**
 * 验证 syncDelete 数据一致性
 * @param {object} conn - 数据库连接
 * @param {string[]} frontendAccountIds - 前端账号ID列表
 * @returns {Promise<{valid: boolean, warning?: string, serverCount: number, toDeleteCount: number}>}
 */
async function validateSyncDeleteConsistency(conn, frontendAccountIds) {
  // 查询服务器现有账号数量
  const [countResult] = await conn.query(
    'SELECT COUNT(*) as count FROM accounts WHERE is_del = FALSE OR is_del IS NULL'
  )
  const serverCount = countResult[0].count
  
  // 计算将被删除的账号数量
  let toDeleteCount = 0
  if (frontendAccountIds.length > 0 && serverCount > 0) {
    const placeholders = frontendAccountIds.map(() => '?').join(',')
    const [deleteCountResult] = await conn.query(
      `SELECT COUNT(*) as count FROM accounts WHERE id NOT IN (${placeholders}) AND (is_del = FALSE OR is_del IS NULL)`,
      frontendAccountIds
    )
    toDeleteCount = deleteCountResult[0].count
  }
  
  // 检查是否会删除过多数据
  if (serverCount > 0 && frontendAccountIds.length < serverCount * SYNC_DELETE_CONSISTENCY_THRESHOLD) {
    return {
      valid: false,
      warning: `前端账号数量(${frontendAccountIds.length})少于服务器账号数量(${serverCount})的${SYNC_DELETE_CONSISTENCY_THRESHOLD * 100}%，这可能导致大量数据丢失`,
      serverCount,
      toDeleteCount
    }
  }
  
  return { valid: true, serverCount, toDeleteCount }
}

// 获取完整数据
router.get('/api/data', async (req, res) => {
  try {
    // 解析 includeDeleted 参数，默认为 false（不显示已删除账号）
    const includeDeleted = req.query.includeDeleted === 'true' || req.query.includeDeleted === true

    // 获取账号（按创建时间降序排列，最新的在前面）
    // 根据 includeDeleted 参数决定是否过滤已删除账号
    let accountQuery = 'SELECT * FROM accounts'
    if (!includeDeleted) {
      accountQuery += ' WHERE is_del = FALSE OR is_del IS NULL'
    }
    accountQuery += ' ORDER BY created_at DESC'
    
    const [accountRows] = await pool.query(accountQuery)
    const accounts = {}
    for (const row of accountRows) {
      accounts[row.id] = rowToAccount(row)
    }

    // 获取所有分组（使用提取的公共函数）
    const [groupRows] = await pool.query('SELECT * FROM `groups`')
    const groups = {}
    for (const row of groupRows) {
      groups[row.id] = rowToGroup(row)
    }

    // 获取所有标签（使用提取的公共函数）
    const [tagRows] = await pool.query('SELECT * FROM tags')
    const tags = {}
    for (const row of tagRows) {
      tags[row.id] = rowToTag(row)
    }

    // 获取设置（使用提取的公共函数）
    const [settingRows] = await pool.query('SELECT * FROM settings')
    const settings = {}
    for (const row of settingRows) {
      const setting = rowToSetting(row)
      settings[setting.key] = setting.value
    }

    // 获取账号机器码绑定
    const [bindingRows] = await pool.query('SELECT * FROM account_machine_ids')
    const accountMachineIds = {}
    for (const row of bindingRows) {
      accountMachineIds[row.account_id] = row.machine_id
    }

    // 获取机器码历史
    const [historyRows] = await pool.query('SELECT * FROM machine_id_history ORDER BY timestamp DESC')
    const machineIdHistory = historyRows.map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      timestamp: row.timestamp,
      action: row.action
    }))

    sendSuccessResponse(res, {
      accounts,
      groups,
      tags,
      accountMachineIds,
      machineIdHistory,
      ...settings
    })
  } catch (error) {
    console.error('[Data API] Get data error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'get_data',
      code: error.code
    })
  }
})

// syncDelete 预览接口 - 返回将被删除的账号列表
router.post('/api/data/sync-delete-preview', validateRequest(syncDeleteSchema, 'body'), async (req, res) => {
  const requestId = generateRequestId()
  console.log(`[Data API] [${requestId}] POST /api/data/sync-delete-preview`)
  
  const { accounts = {} } = req.body
  const frontendAccountIds = Object.keys(accounts)
  
  if (frontendAccountIds.length === 0) {
    return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
      '需要提供账号列表以预览删除操作', {
        requestId,
        operation: 'sync_delete_preview'
      })
  }
  
  try {
    const placeholders = frontendAccountIds.map(() => '?').join(',')
    const [toDeleteRows] = await pool.query(
      `SELECT id, email, status, created_at FROM accounts
       WHERE id NOT IN (${placeholders}) AND (is_del = FALSE OR is_del IS NULL)
       LIMIT 100`,
      frontendAccountIds
    )
    
    const [totalCountResult] = await pool.query(
      `SELECT COUNT(*) as count FROM accounts
       WHERE id NOT IN (${placeholders}) AND (is_del = FALSE OR is_del IS NULL)`,
      frontendAccountIds
    )
    
    const [serverCountResult] = await pool.query(
      'SELECT COUNT(*) as count FROM accounts WHERE is_del = FALSE OR is_del IS NULL'
    )
    
    sendSuccessResponse(res, {
      preview: {
        toDelete: toDeleteRows.map(row => ({
          id: row.id,
          email: row.email,
          status: row.status,
          createdAt: row.created_at
        })),
        totalToDelete: totalCountResult[0].count,
        serverTotal: serverCountResult[0].count,
        frontendTotal: frontendAccountIds.length,
        hasMore: totalCountResult[0].count > 100
      },
      requestId
    }, '删除预览生成成功')
  } catch (error) {
    console.error(`[Data API] [${requestId}] Sync delete preview error:`, error.message)
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      requestId,
      operation: 'sync_delete_preview',
      code: error.code
    })
  }
})

// 保存完整数据 (增量更新，可选同步删除)
router.post('/api/data', validateRequest(syncDeleteSchema, 'body'), async (req, res) => {
  const requestId = generateRequestId()
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown'
  const userAgent = req.headers['user-agent'] || 'unknown'
  
  console.log(`[Data API] [${requestId}] POST /api/data - Starting save operation`)
  console.log(`[Data API] [${requestId}] Client IP: ${clientIp}, User-Agent: ${userAgent.substring(0, 50)}`)
  console.log(`[Data API] [${requestId}] Request body keys:`, Object.keys(req.body || {}))
  console.log(`[Data API] [${requestId}] Accounts count:`, Object.keys(req.body?.accounts || {}).length)
  console.log(`[Data API] [${requestId}] Groups count:`, Object.keys(req.body?.groups || {}).length)
  console.log(`[Data API] [${requestId}] Tags count:`, Object.keys(req.body?.tags || {}).length)
  
  const data = req.body
  // syncDelete: 是否同步删除服务器上不存在于前端的数据
  // 默认 false，防止误删数据（Web 版本或新客户端启动时）
  const syncDelete = data.syncDelete === true

  // 获取前端传来的账号 ID 列表
  const frontendAccountIds = Object.keys(data.accounts || {})

  // syncDelete 增强安全检查
  if (syncDelete) {
    // 1. 验证 frontendAccountIds 不为空
    if (frontendAccountIds.length === 0) {
      console.warn(`[Data API] [${requestId}] syncDelete requested but no accounts provided - rejecting to prevent data loss`)
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        'syncDelete 模式需要提供至少一个账号，以防止误删所有数据', {
          requestId,
          operation: 'save_data',
          hint: '如果确实需要删除所有账号，请使用覆盖导入功能'
        })
    }
    
    // 2. 验证账号数量合理
    const arrayValidation = validateArrayLength(frontendAccountIds, 'accounts', { max: MAX_SYNC_DELETE_ACCOUNTS })
    if (arrayValidation) {
      console.warn(`[Data API] [${requestId}] syncDelete rejected: too many accounts (${frontendAccountIds.length})`)
      return res.status(400).json({ ...arrayValidation, requestId })
    }
    
    // 3. 二次确认机制 - 检查请求头
    const confirmHeader = req.headers['x-confirm-sync-delete']
    if (confirmHeader !== 'true') {
      console.warn(`[Data API] [${requestId}] syncDelete rejected: missing X-Confirm-Sync-Delete header`)
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        'syncDelete 模式需要在请求头中添加 X-Confirm-Sync-Delete: true', {
          requestId,
          operation: 'save_data',
          hint: '这是为了防止意外删除数据的安全措施'
        })
    }
    
    // 4. 二次确认机制 - 检查请求体
    if (data.confirmSyncDelete !== true) {
      console.warn(`[Data API] [${requestId}] syncDelete rejected: missing confirmSyncDelete in body`)
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        'syncDelete 模式需要在请求体中添加 confirmSyncDelete: true', {
          requestId,
          operation: 'save_data',
          hint: '这是为了防止意外删除数据的安全措施'
        })
    }
    
    // 5. 限流检查
    const rateLimitCheck = checkSyncDeleteRateLimit(clientIp)
    if (!rateLimitCheck.allowed) {
      console.warn(`[Data API] [${requestId}] syncDelete rate limited for IP: ${clientIp}`)
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        `syncDelete 操作过于频繁，请在 ${rateLimitCheck.retryAfter} 秒后重试`, {
          requestId,
          operation: 'save_data',
          retryAfter: rateLimitCheck.retryAfter
        })
    }
  }

  let conn
  let currentOperation = 'init'
  let syncDeleteStats = null
  
  try {
    console.log(`[Data API] [${requestId}] Getting database connection...`)
    conn = await getConnectionWithRetry({ operationName: 'save_data' })
    console.log(`[Data API] [${requestId}] Database connection acquired`)
    
    await conn.beginTransaction()
    console.log(`[Data API] [${requestId}] Transaction started`)

    // 只有明确指定 syncDelete=true 且有账号数据时才删除
    if (syncDelete && frontendAccountIds.length > 0) {
      currentOperation = 'sync_delete_consistency_check'
      
      // 6. 数据一致性检查
      const consistencyCheck = await validateSyncDeleteConsistency(conn, frontendAccountIds)
      if (!consistencyCheck.valid) {
        // 如果没有强制确认，拒绝操作
        if (data.forceSync !== true) {
          await conn.rollback()
          conn.release()
          console.warn(`[Data API] [${requestId}] syncDelete rejected: ${consistencyCheck.warning}`)
          return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
            consistencyCheck.warning, {
              requestId,
              operation: 'save_data',
              serverCount: consistencyCheck.serverCount,
              frontendCount: frontendAccountIds.length,
              toDeleteCount: consistencyCheck.toDeleteCount,
              hint: '如果确定要执行此操作，请添加 forceSync: true 到请求体'
            })
        }
        console.warn(`[Data API] [${requestId}] syncDelete forced despite consistency warning`)
      }
      
      currentOperation = 'sync_delete_accounts'
      
      // 记录将被删除的账号（前10个）
      const placeholders = frontendAccountIds.map(() => '?').join(',')
      const [toDeleteRows] = await conn.query(
        `SELECT id, email FROM accounts WHERE id NOT IN (${placeholders}) AND (is_del = FALSE OR is_del IS NULL) LIMIT 10`,
        frontendAccountIds
      )
      
      // 执行删除
      const [deleteResult] = await conn.query(
        `DELETE FROM accounts WHERE id NOT IN (${placeholders})`,
        frontendAccountIds
      )
      await conn.query(
        `DELETE FROM account_machine_ids WHERE account_id NOT IN (${placeholders})`,
        frontendAccountIds
      )
      
      // 记录限流
      recordSyncDeleteExecution(clientIp)
      
      // 记录统计信息
      syncDeleteStats = {
        deletedCount: deleteResult.affectedRows,
        keptCount: frontendAccountIds.length,
        deletedSample: toDeleteRows.map(r => ({ id: r.id, email: r.email }))
      }
      
      console.log(`[Data API] [${requestId}] Sync delete completed:`, {
        deletedCount: syncDeleteStats.deletedCount,
        keptCount: syncDeleteStats.keptCount,
        clientIp,
        userAgent: userAgent.substring(0, 50),
        deletedSample: syncDeleteStats.deletedSample.slice(0, 5)
      })
    }
    // 不再支持删除所有账号的操作，防止误删

    // 增量更新账号
    currentOperation = 'update_accounts'
    const accountEntries = Object.entries(data.accounts || {})
    console.log(`[Data API] Processing ${accountEntries.length} accounts...`)
    
    for (const [id, acc] of accountEntries) {
      try {
        console.log(`[Data API] Inserting/updating account: ${id} (${acc.email || 'no email'})`)
        await insertAccount(conn, id, acc)
      } catch (accountError) {
        console.error(`[Data API] ❌ Error inserting account ${id}:`, accountError.message)
        console.error(`[Data API] Account data:`, JSON.stringify(acc, null, 2).substring(0, 500))
        // 添加账号ID到错误信息
        accountError.accountId = id
        accountError.accountEmail = acc.email
        throw accountError
      }
    }
    console.log('[Data API] ✅ All accounts processed')

    // 同步删除分组（仅在 syncDelete=true 时）
    currentOperation = 'sync_delete_groups'
    const frontendGroupIds = Object.keys(data.groups || {})
    if (syncDelete && frontendGroupIds.length > 0) {
      const placeholders = frontendGroupIds.map(() => '?').join(',')
      await conn.query(`DELETE FROM \`groups\` WHERE id NOT IN (${placeholders})`, frontendGroupIds)
      console.log(`[Data] Sync delete: removed groups not in frontend list (${frontendGroupIds.length} groups kept)`)
    }

    // 增量更新分组
    currentOperation = 'update_groups'
    for (const [id, group] of Object.entries(data.groups || {})) {
      await conn.query(
        'INSERT INTO `groups` (id, name, color, `order`, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color), `order`=VALUES(`order`)',
        [id, group.name, group.color, group.order || 0, group.createdAt || Date.now()]
      )
    }

    // 同步删除标签（仅在 syncDelete=true 时）
    currentOperation = 'sync_delete_tags'
    const frontendTagIds = Object.keys(data.tags || {})
    if (syncDelete && frontendTagIds.length > 0) {
      const placeholders = frontendTagIds.map(() => '?').join(',')
      await conn.query(`DELETE FROM tags WHERE id NOT IN (${placeholders})`, frontendTagIds)
      console.log(`[Data] Sync delete: removed tags not in frontend list (${frontendTagIds.length} tags kept)`)
    }

    // 增量更新标签
    currentOperation = 'update_tags'
    for (const [id, tag] of Object.entries(data.tags || {})) {
      await conn.query(
        'INSERT INTO tags (id, name, color) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color)',
        [id, tag.name, tag.color]
      )
    }

    // 更新设置
    currentOperation = 'update_settings'
    for (const key of SETTINGS_KEYS) {
      if (data[key] !== undefined) {
        const value = typeof data[key] === 'object' ? JSON.stringify(data[key]) : String(data[key])
        const valueType = typeof data[key] === 'object' ? 'json' : typeof data[key]
        await conn.query(
          'INSERT INTO settings (`key`, value, value_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value), value_type=VALUES(value_type)',
          [key, value, valueType]
        )
      }
    }

    // 增量更新账号机器码绑定
    currentOperation = 'update_machine_ids'
    for (const [accountId, machineId] of Object.entries(data.accountMachineIds || {})) {
      await conn.query(
        'INSERT INTO account_machine_ids (account_id, machine_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE machine_id=VALUES(machine_id)',
        [accountId, machineId]
      )
    }

    // 增量更新机器码历史
    currentOperation = 'update_machine_history'
    for (const record of data.machineIdHistory || []) {
      await conn.query(
        'INSERT IGNORE INTO machine_id_history (id, machine_id, timestamp, action) VALUES (?, ?, ?, ?)',
        [record.id, record.machineId, record.timestamp, record.action]
      )
    }

    await conn.commit()
    console.log(`[Data API] [${requestId}] ✅ Transaction committed successfully`)
    
    const responseData = { saved: true, requestId }
    if (syncDeleteStats) {
      responseData.syncDeleteStats = syncDeleteStats
    }
    
    sendSuccessResponse(res, responseData, '数据保存成功')
  } catch (error) {
    console.error(`[Data API] [${requestId}] ❌ Save data error:`, error.message)
    console.error(`[Data API] [${requestId}] Failed at operation:`, currentOperation)
    console.error(`[Data API] [${requestId}] Error stack:`, error.stack)
    console.error(`[Data API] [${requestId}] Error code:`, error.code)
    console.error(`[Data API] [${requestId}] SQL state:`, error.sqlState)
    console.error(`[Data API] [${requestId}] SQL message:`, error.sqlMessage)
    
    if (conn) {
      try {
        await conn.rollback()
        console.log(`[Data API] [${requestId}] Transaction rolled back`)
      } catch (rollbackError) {
        console.error(`[Data API] [${requestId}] Rollback error:`, rollbackError.message)
      }
    }
    
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    
    sendErrorResponse(res, errorType, userMessage, {
      requestId,
      operation: 'save_data',
      failedAt: currentOperation,
      code: error.code,
      sqlState: error.sqlState,
      accountId: error.accountId,
      accountEmail: error.accountEmail
    })
  } finally {
    if (conn) {
      conn.release()
      console.log(`[Data API] [${requestId}] Database connection released`)
    }
  }
})

// 导入数据
// mode: 'merge'(默认，增量合并) | 'overwrite'(覆盖，需要 confirmOverwrite=true)
router.post('/api/import', validateRequest(importDataSchema, 'body'), async (req, res) => {
  const data = req.body
  const mode = data.mode || 'merge' // 默认增量模式

  // 覆盖模式需要确认
  if (mode === 'overwrite') {
    if (data.confirmOverwrite !== true) {
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        '覆盖模式会清空所有现有数据，请传递 confirmOverwrite: true 确认操作', {
          operation: 'import',
          hint: '如需增量导入，请使用 mode: "merge" 或不传 mode 参数'
        })
    }
    
    // 二次确认：检查请求头
    const confirmHeader = req.headers['x-confirm-overwrite']
    if (confirmHeader !== 'true') {
      return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
        '覆盖模式需要在请求头中添加 X-Confirm-Overwrite: true', {
          operation: 'import',
          hint: '这是为了防止意外覆盖数据的安全措施'
        })
    }
  }

  let conn
  let currentOperation = 'init'
  
  try {
    conn = await getConnectionWithRetry({ operationName: 'import_data' })
    await conn.beginTransaction()

    // 覆盖模式：先清空所有表
    if (mode === 'overwrite') {
      console.log('[Data] Import (overwrite) - clearing all existing data')
      console.warn('[Data] ⚠️ OVERWRITE MODE: All existing data will be deleted')
      
      currentOperation = 'clear_accounts'
      await conn.query('DELETE FROM accounts')
      
      currentOperation = 'clear_groups'
      await conn.query('DELETE FROM `groups`')
      
      currentOperation = 'clear_tags'
      await conn.query('DELETE FROM tags')
      
      currentOperation = 'clear_settings'
      await conn.query('DELETE FROM settings')
      
      currentOperation = 'clear_machine_ids'
      await conn.query('DELETE FROM account_machine_ids')
      
      currentOperation = 'clear_machine_history'
      await conn.query('DELETE FROM machine_id_history')
      
      console.log('[Data] All tables cleared')
    } else {
      console.log('[Data] Import (merge) - merging with existing data')
    }

    // 导入账号（增量模式用 ON DUPLICATE KEY UPDATE）
    currentOperation = 'import_accounts'
    for (const [id, acc] of Object.entries(data.accounts || {})) {
      await insertAccount(conn, id, acc)
    }

    // 导入分组
    currentOperation = 'import_groups'
    for (const [id, group] of Object.entries(data.groups || {})) {
      await conn.query(
        'INSERT INTO `groups` (id, name, color, `order`, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color), `order`=VALUES(`order`)',
        [id, group.name, group.color, group.order || 0, group.createdAt || Date.now()]
      )
    }

    // 导入标签
    currentOperation = 'import_tags'
    for (const [id, tag] of Object.entries(data.tags || {})) {
      await conn.query(
        'INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color)',
        [id, tag.name, tag.color, tag.createdAt || Date.now()]
      )
    }

    // 导入设置
    currentOperation = 'import_settings'
    for (const key of SETTINGS_KEYS) {
      if (data[key] !== undefined) {
        const value = typeof data[key] === 'object' ? JSON.stringify(data[key]) : String(data[key])
        const valueType = typeof data[key] === 'object' ? 'json' : typeof data[key]
        await conn.query(
          'INSERT INTO settings (`key`, value, value_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value), value_type=VALUES(value_type)',
          [key, value, valueType]
        )
      }
    }

    // 导入账号机器码绑定
    currentOperation = 'import_machine_ids'
    for (const [accountId, machineId] of Object.entries(data.accountMachineIds || {})) {
      await conn.query(
        'INSERT INTO account_machine_ids (account_id, machine_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE machine_id=VALUES(machine_id)',
        [accountId, machineId]
      )
    }

    // 导入机器码历史
    currentOperation = 'import_machine_history'
    for (const record of data.machineIdHistory || []) {
      await conn.query(
        'INSERT IGNORE INTO machine_id_history (id, machine_id, timestamp, action) VALUES (?, ?, ?, ?)',
        [record.id, record.machineId, record.timestamp, record.action]
      )
    }

    await conn.commit()
    const modeText = mode === 'overwrite' ? '覆盖导入' : '增量导入'
    const importStats = {
      accounts: Object.keys(data.accounts || {}).length,
      groups: Object.keys(data.groups || {}).length,
      tags: Object.keys(data.tags || {}).length
    }
    sendSuccessResponse(res, { imported: true, stats: importStats }, `${modeText}成功`)
  } catch (error) {
    if (conn) {
      try {
        await conn.rollback()
      } catch (rollbackError) {
        console.error('[Data API] Import rollback error:', rollbackError.message)
      }
    }
    console.error('[Data API] Import error:', error.message, { failedAt: currentOperation })
    
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'import',
      mode: mode,
      failedAt: currentOperation,
      code: error.code
    })
  } finally {
    if (conn) {
      conn.release()
    }
  }
})

// 导出数据
router.get('/api/export', async (req, res) => {
  try {
    // 复用 /api/data 的逻辑（按创建时间降序排列，最新的在前面）
    const [accountRows] = await pool.query('SELECT * FROM accounts ORDER BY created_at DESC')
    const accounts = {}
    for (const row of accountRows) {
      accounts[row.id] = rowToAccount(row)
    }

    // 获取所有分组（使用提取的公共函数）
    const [groupRows] = await pool.query('SELECT * FROM `groups`')
    const groups = {}
    for (const row of groupRows) {
      groups[row.id] = rowToGroup(row)
    }

    // 获取所有标签（使用提取的公共函数）
    const [tagRows] = await pool.query('SELECT * FROM tags')
    const tags = {}
    for (const row of tagRows) {
      tags[row.id] = rowToTag(row)
    }

    // 获取设置（使用提取的公共函数）
    const [settingRows] = await pool.query('SELECT * FROM settings')
    const settings = {}
    for (const row of settingRows) {
      const setting = rowToSetting(row)
      settings[setting.key] = setting.value
    }

    const [bindingRows] = await pool.query('SELECT * FROM account_machine_ids')
    const accountMachineIds = {}
    for (const row of bindingRows) {
      accountMachineIds[row.account_id] = row.machine_id
    }

    const [historyRows] = await pool.query('SELECT * FROM machine_id_history ORDER BY timestamp DESC')
    const machineIdHistory = historyRows.map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      timestamp: row.timestamp,
      action: row.action
    }))

    sendSuccessResponse(res, {
      accounts,
      groups,
      tags,
      accountMachineIds,
      machineIdHistory,
      ...settings
    })
  } catch (error) {
    console.error('[Data API] Export error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'export',
      code: error.code
    })
  }
})

// 统计信息
router.get('/api/stats', async (req, res) => {
  try {
    const [accountCount] = await pool.query('SELECT COUNT(*) as count FROM accounts WHERE (is_del = FALSE OR is_del IS NULL)')
    const [statusActiveCount] = await pool.query("SELECT COUNT(*) as count FROM accounts WHERE status = 'active' AND (is_del = FALSE OR is_del IS NULL)")
    const [groupCount] = await pool.query('SELECT COUNT(*) as count FROM `groups`')
    const [tagCount] = await pool.query('SELECT COUNT(*) as count FROM tags')
    const [usageSum] = await pool.query(
      'SELECT SUM(usage_current) as total, SUM(usage_limit) as totalLimit FROM accounts WHERE (is_del = FALSE OR is_del IS NULL)'
    )

    sendSuccessResponse(res, {
      accounts: accountCount[0].count,
      activeAccounts: statusActiveCount[0].count, // 状态为 active 的账号数量
      groups: groupCount[0].count,
      tags: tagCount[0].count,
      totalUsage: usageSum[0].total || 0,
      totalLimit: usageSum[0].totalLimit || 0
    })
  } catch (error) {
    console.error('[Data API] Get stats error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'get_stats',
      code: error.code
    })
  }
})

export default router