/**
 * 账号 API 路由
 */
import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import {
  rowToAccount,
  insertAccount,
  getOrCreateMachineId,
  determineIdp,
  refreshTokenByAuthMethod,
  clearActiveAccountIfMatch
} from '../models/account.js'

// 引用共享的 Kiro API 工具函数
import { getUsageLimits, parseUsageResponse, buildUsageUpdateSQL } from '../utils/kiro-api.js'

const router = Router()

// 获取所有账号 (对象格式)
// 支持 showDeleted=true 参数显示已删除账号
router.get('/api/accounts', async (req, res) => {
  try {
    const showDeleted = req.query.showDeleted === 'true'
    let query = 'SELECT * FROM accounts'
    if (!showDeleted) {
      // 默认只返回未删除的账号（is_del = FALSE 或 is_del IS NULL 兼容历史数据）
      query += ' WHERE (is_del = FALSE OR is_del IS NULL)'
    }
    const [rows] = await pool.query(query)
    const accounts = {}
    for (const row of rows) {
      accounts[row.id] = rowToAccount(row)
    }
    res.json(accounts)
  } catch (error) {
    console.error('Get accounts error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取账号列表 (数组格式)
// 支持 showDeleted=true 参数显示已删除账号
router.get('/api/accounts/list', async (req, res) => {
  try {
    const showDeleted = req.query.showDeleted === 'true'
    let query = 'SELECT * FROM accounts'
    if (!showDeleted) {
      // 默认只返回未删除的账号（is_del = FALSE 或 is_del IS NULL 兼容历史数据）
      query += ' WHERE (is_del = FALSE OR is_del IS NULL)'
    }
    query += ' ORDER BY created_at DESC'
    const [rows] = await pool.query(query)
    res.json(rows.map(rowToAccount))
  } catch (error) {
    console.error('Get accounts list error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取单个账号
router.get('/api/accounts/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM accounts WHERE id = ?', [req.params.id])
    if (rows.length > 0) {
      res.json(rowToAccount(rows[0]))
    } else {
      res.status(404).json({ error: 'Account not found' })
    }
  } catch (error) {
    console.error('Get account error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 创建/更新账号
router.post('/api/accounts/:id', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'create_update_account' })
  try {
    const acc = { ...req.body, id: req.params.id }
    const accountId = req.params.id
    
    // 检查是否是新增账号（通过查询是否已存在）
    const [existingRows] = await conn.query('SELECT id FROM accounts WHERE id = ?', [accountId])
    const isNewAccount = existingRows.length === 0
    
    await insertAccount(conn, accountId, acc)
    res.json({ success: true })
    
    // 如果是新增账号，异步获取使用量信息（不阻塞响应）
    if (isNewAccount && acc.credentials?.accessToken) {
      // 使用 setImmediate 确保响应先发送
      setImmediate(async () => {
        try {
          console.log(`[API] New account added: ${acc.email}, fetching usage info...`)
          
          // 获取或创建机器码（使用提取的公共函数）
          const machineId = await getOrCreateMachineId(null, accountId)
          
          // 确定 idp（使用提取的公共函数）
          const idp = determineIdp(acc.credentials, acc.idp)
          
          // 构造账号对象用于 API 调用
          const accountForApi = {
            headerVersion: acc.headerVersion || 1,
            machineId: machineId,
            amzInvocationId: acc.amzInvocationId,
            kiroDeviceHash: acc.kiroDeviceHash,
            sdkJsVersion: acc.sdkJsVersion,
            ideVersion: acc.ideVersion,
            credentials: acc.credentials
          }
          
          // 调用 API 获取使用量
          const usageResult = await getUsageLimits(acc.credentials.accessToken, accountForApi)
          const parsed = parseUsageResponse(usageResult, undefined, idp)
          
          // 更新数据库中的使用量和订阅信息
          const { sql, params } = buildUsageUpdateSQL(parsed, accountId)
          await pool.query(sql, params)
          
          console.log(`[API] Usage info fetched for new account ${acc.email}: ${parsed.data.usage.current}/${parsed.data.usage.limit}`)
        } catch (usageError) {
          const errorMsg = usageError instanceof Error ? usageError.message : String(usageError)
          console.warn(`[API] Failed to fetch usage for new account ${acc.email}: ${errorMsg}`)
          
          // 如果是被封禁，更新账号状态
          if (errorMsg.startsWith('BANNED:')) {
            try {
              await pool.query(
                `UPDATE accounts SET status = 'banned', last_checked_at = ? WHERE id = ?`,
                [Date.now(), accountId]
              )
            } catch (updateError) {
              console.error(`[API] Failed to update banned status: ${updateError.message}`)
            }
          }
        }
      })
    }
  } catch (error) {
    console.error('Save account error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    conn.release()
  }
})

// 更新账号
router.put('/api/accounts/:id', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'update_account' })
  try {
    const acc = { ...req.body, id: req.params.id }
    await insertAccount(conn, req.params.id, acc)
    res.json({ success: true })
  } catch (error) {
    console.error('Update account error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    conn.release()
  }
})

// 删除账号（软删除）
router.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params
    const now = Date.now()
    // 软删除：设置 is_del = TRUE 和 deleted_at
    await pool.query('UPDATE accounts SET is_del = TRUE, deleted_at = ? WHERE id = ?', [now, id])
    // 如果是当前激活账号，清除激活状态（使用提取的公共函数）
    await clearActiveAccountIfMatch(id)
    res.json({ success: true })
  } catch (error) {
    console.error('Delete account error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 恢复已删除的账号
router.put('/api/accounts/:id/restore', async (req, res) => {
  try {
    const { id } = req.params
    // 恢复账号：设置 is_del = FALSE，清除 deleted_at
    await pool.query('UPDATE accounts SET is_del = FALSE, deleted_at = NULL WHERE id = ?', [id])
    res.json({ success: true })
  } catch (error) {
    console.error('Restore account error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 永久删除账号（真正从数据库删除）
router.delete('/api/accounts/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params
    await pool.query('DELETE FROM accounts WHERE id = ?', [id])
    await pool.query('DELETE FROM account_machine_ids WHERE account_id = ?', [id])
    // 如果是当前激活账号，清除激活状态（使用提取的公共函数）
    await clearActiveAccountIfMatch(id)
    res.json({ success: true })
  } catch (error) {
    console.error('Permanent delete account error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 验证凭证并获取账号信息（Web 端添加账号用）
router.post('/api/accounts/verify-credentials', async (req, res) => {
  try {
    const { refreshToken, clientId, clientSecret, region, authMethod, provider, email: inputEmail } = req.body

    if (!refreshToken) {
      return res.status(400).json({ success: false, error: '缺少 refreshToken' })
    }

    // 非社交登录需要 clientId 和 clientSecret
    if (authMethod !== 'social' && (!clientId || !clientSecret)) {
      return res.status(400).json({ success: false, error: '缺少 clientId 或 clientSecret' })
    }

    const { randomUUID } = await import('crypto')
    const { generateInvocationId, generateDeviceHash, generateHeaders, getEndpointUrl } = await import('../utils/header-generator.js')
    const { getDefaultHeaderVersionForIdp } = await import('../config/index.js')

    // 根据认证方式刷新 token 获取 accessToken（使用提取的公共函数）
    const tokenResult = await refreshTokenByAuthMethod(authMethod, refreshToken, clientId, clientSecret, region)
    
    if (!tokenResult.success) {
      return res.status(400).json({ success: false, error: `Token 刷新失败: ${tokenResult.error}` })
    }

    // 确定 IDP 并获取对应的默认 header 版本
    const idp = determineIdp({ authMethod, provider }, undefined)
    const headerVersion = getDefaultHeaderVersionForIdp(idp)

    // 为临时验证创建账号对象（根据 IDP 使用对应的 header 版本）
    const tempAccount = {
      email: inputEmail || 'temp',
      headerVersion: headerVersion,
      machineId: randomUUID(),
      amzInvocationId: generateInvocationId(),
      kiroDeviceHash: generateDeviceHash(),
      credentials: {
        accessToken: tokenResult.accessToken,
        region: region || 'us-east-1'
      }
    }

    // 根据 headerVersion 选择端点URL
    const apiUrl = getEndpointUrl(tempAccount.headerVersion, tempAccount.credentials.region, 'usage')
    const fullUrl = `${apiUrl}?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`
    
    // 使用统一的 header 生成器
    const headers = generateHeaders(tempAccount, tokenResult.accessToken)
    
    const apiResponse = await fetch(fullUrl, {
      method: 'GET',
      headers
    })

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text()
      let errorMessage = `HTTP ${apiResponse.status}`
      try {
        const errorData = JSON.parse(errorText)
        if (errorData.reason) {
          errorMessage = `BANNED:${errorData.reason}`
        } else if (errorData.message) {
          errorMessage = errorData.message
        }
      } catch {
        errorMessage = errorText || errorMessage
      }
      return res.status(400).json({ success: false, error: `获取用户信息失败: ${errorMessage}` })
    }

    const result = await apiResponse.json()

    // 使用共享的 parseUsageResponse 函数解析使用量（消除重复代码）
    // idp 已在上面确定
    const parsed = parseUsageResponse(result, {
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken || refreshToken,
      expiresIn: tokenResult.expiresIn || 3600
    }, idp)

    // 优先使用 API 返回的 email，如果没有则使用用户输入的 email
    const finalEmail = parsed.data.email || inputEmail

    // 构建响应（保持与原有接口兼容的格式）
    res.json({
      success: true,
      data: {
        email: finalEmail,
        userId: parsed.data.userId,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken || refreshToken,
        expiresIn: tokenResult.expiresIn || 3600,
        subscriptionType: parsed.data.subscription.type,
        subscriptionTitle: parsed.data.subscription.title,
        subscription: {
          managementTarget: parsed.data.subscription.managementTarget,
          upgradeCapability: parsed.data.subscription.upgradeCapability,
          overageCapability: parsed.data.subscription.overageCapability
        },
        usage: {
          current: parsed.data.usage.current,
          limit: parsed.data.usage.limit,
          baseLimit: parsed.data.usage.baseLimit,
          baseCurrent: parsed.data.usage.baseCurrent,
          freeTrialLimit: parsed.data.usage.freeTrialLimit,
          freeTrialCurrent: parsed.data.usage.freeTrialCurrent,
          freeTrialExpiry: parsed.data.usage.freeTrialExpiry,
          bonuses: parsed.data.usage.bonuses,
          nextResetDate: parsed.data.usage.nextResetDate
        },
        daysRemaining: parsed.data.subscription.daysRemaining,
        expiresAt: parsed.data.subscription.expiresAt,
        // 返回根据 IDP 确定的 header 版本，让客户端知道应该使用哪个版本
        headerVersion: headerVersion
      }
    })
  } catch (error) {
    console.error('Verify credentials error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 批量删除账号（软删除）
router.post('/api/accounts/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body
    console.log('[API] Batch delete request:', { ids, count: ids?.length })
    
    if (!ids || ids.length === 0) {
      return res.json({ success: true, count: 0 })
    }
    
    // 验证 ids 是否为有效的字符串数组
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) {
      console.error('[API] Invalid ids format:', ids)
      return res.status(400).json({ error: 'Invalid ids format: expected non-empty string array' })
    }
    
    const now = Date.now()
    const placeholders = ids.map(() => '?').join(',')
    const sql = `UPDATE accounts SET is_del = TRUE, deleted_at = ? WHERE id IN (${placeholders})`
    const params = [now, ...ids]
    
    console.log('[API] Executing SQL:', sql)
    console.log('[API] SQL params:', params)
    
    // 软删除：设置 is_del = TRUE 和 deleted_at
    const [result] = await pool.query(sql, params)
    
    console.log('[API] Batch delete result:', { affectedRows: result.affectedRows })
    res.json({ success: true, count: result.affectedRows })
  } catch (error) {
    console.error('[API] Batch delete error:', error)
    console.error('[API] Error stack:', error.stack)
    res.status(500).json({ error: error.message })
  }
})

// 批量恢复账号
router.post('/api/accounts/batch-restore', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || ids.length === 0) {
      return res.json({ success: true, count: 0 })
    }
    const placeholders = ids.map(() => '?').join(',')
    // 恢复账号：设置 is_del = FALSE，清除 deleted_at
    await pool.query(`UPDATE accounts SET is_del = FALSE, deleted_at = NULL WHERE id IN (${placeholders})`, ids)
    res.json({ success: true, count: ids.length })
  } catch (error) {
    console.error('Batch restore error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 批量永久删除账号（真正从数据库删除）
router.post('/api/accounts/batch-permanent-delete', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || ids.length === 0) {
      return res.json({ success: true, count: 0 })
    }
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM accounts WHERE id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM account_machine_ids WHERE account_id IN (${placeholders})`, ids)
    res.json({ success: true, count: ids.length })
  } catch (error) {
    console.error('Batch permanent delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 激活账号（仅更新 settings 表，is_active 字段已移除，由客户端本地管理）
router.post('/api/accounts/:id/activate', async (req, res) => {
  try {
    const { id } = req.params
    await pool.query(
      "INSERT INTO settings (`key`, value, value_type) VALUES ('activeAccountId', ?, 'string') ON DUPLICATE KEY UPDATE value = ?",
      [id, id]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Activate account error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新账号状态
router.patch('/api/accounts/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status, lastCheckedAt } = req.body
    const updates = []
    const values = []
    if (status !== undefined) {
      updates.push('status = ?')
      values.push(status)
    }
    if (lastCheckedAt !== undefined) {
      updates.push('last_checked_at = ?')
      values.push(lastCheckedAt)
    }
    if (updates.length > 0) {
      values.push(id)
      await pool.query(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, values)
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Update status error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新账号凭证
router.patch('/api/accounts/:id/credentials', async (req, res) => {
  try {
    const { id } = req.params
    const cred = req.body
    const updates = []
    const values = []
    if (cred.accessToken !== undefined) {
      updates.push('cred_access_token = ?')
      values.push(cred.accessToken)
    }
    if (cred.refreshToken !== undefined) {
      updates.push('cred_refresh_token = ?')
      values.push(cred.refreshToken)
    }
    if (cred.expiresAt !== undefined) {
      updates.push('cred_expires_at = ?')
      values.push(cred.expiresAt)
    }
    if (updates.length > 0) {
      values.push(id)
      await pool.query(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, values)
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Update credentials error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新账号使用量
router.patch('/api/accounts/:id/usage', async (req, res) => {
  try {
    const { id } = req.params
    const usage = req.body
    const updates = []
    const values = []
    if (usage.current !== undefined) {
      updates.push('usage_current = ?')
      values.push(usage.current)
    }
    if (usage.limit !== undefined) {
      updates.push('usage_limit = ?')
      values.push(usage.limit)
    }
    if (usage.percentUsed !== undefined) {
      updates.push('usage_percent_used = ?')
      values.push(usage.percentUsed)
    }
    if (usage.lastUpdated !== undefined) {
      updates.push('usage_last_updated = ?')
      values.push(usage.lastUpdated)
    }
    if (updates.length > 0) {
      values.push(id)
      await pool.query(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, values)
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Update usage error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新账号分组
router.patch('/api/accounts/:id/group', async (req, res) => {
  try {
    const { id } = req.params
    const { groupId } = req.body
    await pool.query('UPDATE accounts SET group_id = ? WHERE id = ?', [groupId, id])
    res.json({ success: true })
  } catch (error) {
    console.error('Update group error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新账号标签
router.patch('/api/accounts/:id/tags', async (req, res) => {
  try {
    const { id } = req.params
    const { tags } = req.body
    await pool.query('UPDATE accounts SET tags = ? WHERE id = ?', [JSON.stringify(tags), id])
    res.json({ success: true })
  } catch (error) {
    console.error('Update tags error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 手动刷新单个账号的 Token
router.post('/api/accounts/:id/refresh-token', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'refresh_token' })
  try {
    const { id } = req.params
    const [rows] = await conn.query(
      `SELECT id, email, cred_access_token, cred_refresh_token,
              cred_client_id, cred_client_secret, cred_region,
              cred_expires_at, cred_auth_method, cred_provider
       FROM accounts WHERE id = ?`,
      [id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const account = rows[0]
    if (!account.cred_refresh_token) {
      return res.status(400).json({ error: 'No refresh token available' })
    }

    // 获取或创建机器码（使用提取的公共函数）
    const machineId = await getOrCreateMachineId(conn, id)

    // 根据认证方式刷新 token（使用提取的公共函数）
    const result = await refreshTokenByAuthMethod(
      account.cred_auth_method,
      account.cred_refresh_token,
      account.cred_client_id,
      account.cred_client_secret,
      account.cred_region
    )
    
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error })
    }

    // 更新数据库
    const now = Date.now()
    const newExpiresAt = now + (result.expiresIn || 3600) * 1000
    await conn.query(
      'UPDATE accounts SET cred_access_token = ?, cred_refresh_token = ?, cred_expires_at = ? WHERE id = ?',
      [result.accessToken, result.refreshToken || account.cred_refresh_token, newExpiresAt, id]
    )

    console.log(`[API] Token refreshed for ${account.email}, expires at ${new Date(newExpiresAt).toISOString()}`)

    res.json({
      success: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || account.cred_refresh_token,
        expiresIn: result.expiresIn || 3600
      }
    })
  } catch (error) {
    console.error('Refresh token error:', error)
    res.status(500).json({ success: false, error: error.message })
  } finally {
    conn.release()
  }
})

// 检查账号状态（调用 Kiro API 获取最新数据）
router.post('/api/accounts/:id/check-status', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'check_status' })
  try {
    const { id } = req.params
    const [rows] = await conn.query(
      `SELECT id, email, idp, cred_access_token, cred_refresh_token,
              cred_client_id, cred_client_secret, cred_region,
              cred_auth_method, cred_provider
       FROM accounts WHERE id = ?`,
      [id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const account = rows[0]
    const { cred_access_token, cred_refresh_token, cred_client_id, cred_client_secret, cred_region, cred_auth_method, cred_provider } = account

    if (!cred_access_token) {
      return res.status(400).json({ success: false, error: '缺少 accessToken' })
    }

    // 确定 idp（使用提取的公共函数）
    const idp = determineIdp({ authMethod: cred_auth_method, provider: cred_provider }, account.idp)

    // 获取或创建机器码（使用提取的公共函数）
    const machineId = await getOrCreateMachineId(conn, id)

    // 第一次尝试：使用当前 accessToken
    // 构造账号对象用于 API 调用
    const accountForApi = {
      id: id,
      email: account.email,
      headerVersion: account.header_version || 1,
      machineId: machineId,
      amzInvocationId: account.amz_invocation_id,
      kiroDeviceHash: account.kiro_device_hash,
      sdkJsVersion: account.sdk_js_version,
      ideVersion: account.ide_version,
      credentials: {
        accessToken: cred_access_token,
        region: cred_region || 'us-east-1'
      }
    }
    
    try {
      console.log(`[API] Calling getUsageLimits for ${account.email} (Header V${accountForApi.headerVersion})`)
      const usageResult = await getUsageLimits(cred_access_token, accountForApi)
      console.log(`[API] getUsageLimits response:`, JSON.stringify(usageResult, null, 2))

      const parsed = parseUsageResponse(usageResult, undefined, idp)
      console.log(`[API] Parsed usage: current=${parsed.data.usage.current}, limit=${parsed.data.usage.limit}`)

      // 更新数据库中的使用量和订阅信息（使用共享模块的 buildUsageUpdateSQL）
      const { sql, params } = buildUsageUpdateSQL(parsed, id)
      await conn.query(sql, params)

      console.log(`[API] Status checked for ${account.email}: usage=${parsed.data.usage.current}/${parsed.data.usage.limit}`)
      res.json(parsed)
    } catch (apiError) {
      const errorMsg = apiError instanceof Error ? apiError.message : String(apiError)

      // 检查是否被封禁
      if (errorMsg.startsWith('BANNED:')) {
        console.error(`[API] Account ${account.email} is BANNED: ${errorMsg}`)
        await conn.query(
          `UPDATE accounts SET status = 'banned', last_checked_at = ? WHERE id = ?`,
          [Date.now(), id]
        )
        // 返回 403 状态码，表示账号被封禁
        return res.status(403).json({ success: false, error: errorMsg })
      }

      // 检查是否是 401 错误（token 过期）
      const canRefresh = cred_refresh_token && (cred_auth_method === 'social' || (cred_client_id && cred_client_secret))
      if (errorMsg.includes('401') && canRefresh) {
        console.log(`[API] Token expired for ${account.email}, attempting to refresh...`)

        // 使用提取的公共函数刷新 token
        const refreshResult = await refreshTokenByAuthMethod(
          cred_auth_method, cred_refresh_token, cred_client_id, cred_client_secret, cred_region
        )

        if (refreshResult.success && refreshResult.accessToken) {
          console.log(`[API] Token refreshed for ${account.email}, retrying...`)

          // 更新数据库中的 token
          const newExpiresAt = Date.now() + (refreshResult.expiresIn || 3600) * 1000
          await conn.query(
            'UPDATE accounts SET cred_access_token = ?, cred_refresh_token = ?, cred_expires_at = ? WHERE id = ?',
            [refreshResult.accessToken, refreshResult.refreshToken || cred_refresh_token, newExpiresAt, id]
          )

          // 更新账号对象的 accessToken
          accountForApi.credentials.accessToken = refreshResult.accessToken

          // 用新 token 重试
          const usageResult = await getUsageLimits(refreshResult.accessToken, accountForApi)

          const parsed = parseUsageResponse(usageResult, {
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken,
            expiresIn: refreshResult.expiresIn
          }, idp)

          // 更新数据库中的使用量和订阅信息（使用共享模块的 buildUsageUpdateSQL）
          const { sql, params } = buildUsageUpdateSQL(parsed, id)
          await conn.query(sql, params)

          console.log(`[API] Status checked (after refresh) for ${account.email}`)
          res.json(parsed)
        } else {
          console.error(`[API] Token refresh failed for ${account.email}:`, refreshResult.error)
          res.status(400).json({ success: false, error: `Token 过期且刷新失败: ${refreshResult.error}` })
        }
      } else {
        throw apiError
      }
    }
  } catch (error) {
    console.error('Check status error:', error)
    res.status(500).json({ success: false, error: error.message })
  } finally {
    conn.release()
  }
})

export default router
