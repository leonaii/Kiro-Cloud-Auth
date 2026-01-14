/**
 * 同步 API 路由 (v2)
 *
 * 提供基于版本控制的增量同步功能：
 * - GET /api/v2/sync/changes - 获取增量变更
 *
 * 注意：/api/v2/sync/snapshot 接口已删除，请使用独立的微服务接口：
 * - GET /api/v2/accounts - 获取账号列表
 * - GET /api/v2/groups - 获取分组列表
 * - GET /api/v2/tags - 获取标签列表
 * - GET /api/v2/settings - 获取设置列表
 *
 * 错误处理：
 * - 所有错误响应包含 requestId 用于追踪
 * - 使用统一的错误分类和消息格式
 */

import { Router } from 'express'
import { pool } from '../db/index.js'
import { rowToAccount, rowToGroup, rowToTag, rowToSetting } from '../models/account.js'
import {
  ErrorType,
  sendErrorResponse,
  sendSuccessResponse,
  classifyDatabaseError,
  getDatabaseErrorMessage,
  generateRequestId,
  recordErrorStats
} from '../utils/error-handler.js'
import {
  validateRequest,
  syncChangesQuerySchema
} from '../validators/schemas.js'

const router = Router()

// 有效的资源类型列表
const VALID_RESOURCES = ['accounts', 'groups', 'tags', 'settings', 'machineIdBindings']

/**
 * 验证资源类型参数
 * @param {string[]} resources - 请求的资源类型列表
 * @returns {object|null} 如果验证失败返回错误对象，否则返回null
 */
function validateResources(resources) {
  const invalidResources = resources.filter(r => !VALID_RESOURCES.includes(r))
  if (invalidResources.length > 0) {
    return {
      valid: false,
      invalidResources,
      message: `无效的资源类型: ${invalidResources.join(', ')}。有效类型: ${VALID_RESOURCES.join(', ')}`
    }
  }
  return { valid: true }
}

/**
 * 验证变更数据完整性
 * @param {object} changes - 变更数据对象
 * @returns {object} 验证结果
 */
function validateChangesIntegrity(changes) {
  const issues = []
  
  // 验证accounts
  if (changes.accounts) {
    if (!Array.isArray(changes.accounts.created)) {
      issues.push('accounts.created 不是数组')
    }
    if (!Array.isArray(changes.accounts.updated)) {
      issues.push('accounts.updated 不是数组')
    }
    if (!Array.isArray(changes.accounts.deleted)) {
      issues.push('accounts.deleted 不是数组')
    }
    
    // 验证每个账号是否包含必需字段
    const allAccounts = [...(changes.accounts.created || []), ...(changes.accounts.updated || [])]
    for (const account of allAccounts) {
      if (!account.id) {
        issues.push(`账号缺少 id 字段`)
      }
      if (account.version === undefined) {
        issues.push(`账号 ${account.id || 'unknown'} 缺少 version 字段`)
      }
    }
  }
  
  // 验证groups
  if (changes.groups) {
    if (!Array.isArray(changes.groups.created)) {
      issues.push('groups.created 不是数组')
    }
    if (!Array.isArray(changes.groups.updated)) {
      issues.push('groups.updated 不是数组')
    }
  }
  
  // 验证tags
  if (changes.tags) {
    if (!Array.isArray(changes.tags.created)) {
      issues.push('tags.created 不是数组')
    }
    if (!Array.isArray(changes.tags.updated)) {
      issues.push('tags.updated 不是数组')
    }
  }
  
  // 验证settings
  if (changes.settings) {
    if (!Array.isArray(changes.settings.updated)) {
      issues.push('settings.updated 不是数组')
    }
  }
  
  return {
    valid: issues.length === 0,
    issues
  }
}

/**
 * 获取增量变更
 * 基于 lastSyncTime 返回所有变更的记录
 * 
 * GET /api/v2/sync/changes
 * 
 * 查询参数:
 * - modifiedSince: 必需，上次同步时间戳（毫秒）
 * - resources: 可选，逗号分隔的资源类型列表
 * - includeDeleted: 是否包含已删除的记录（默认 true，增量同步需要知道删除操作）
 */
router.get('/api/v2/sync/changes', validateRequest(syncChangesQuerySchema, 'query'), async (req, res) => {
  const requestId = generateRequestId()
  
  try {
    // modifiedSince 已通过joi验证
    const modifiedSince = req.query.modifiedSince
    
    // 验证时间戳范围（不能太久远）- joi已验证不能是未来时间
    const now = Date.now()
    const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000)
    
    if (modifiedSince < oneYearAgo) {
      console.warn(`[Sync] modifiedSince 时间过早 (${new Date(modifiedSince).toISOString()})，建议执行全量同步`)
    }
    
    // resources 已通过joi验证并设置默认值
    const requestedResources = req.query.resources
    
    const includeDeleted = req.query.includeDeleted !== 'false'
    
    const changes = {
      serverTime: Date.now(),
      modifiedSince
    }
    
    // 获取账号变更
    if (requestedResources.includes('accounts')) {
      try {
        let accountQuery = 'SELECT * FROM accounts WHERE updated_at > ?'
        if (!includeDeleted) {
          accountQuery += ' AND (is_del = FALSE OR is_del IS NULL)'
        }
        accountQuery += ' ORDER BY updated_at ASC'
        
        const [accountRows] = await pool.query(accountQuery, [modifiedSince])
        
        changes.accounts = {
          created: [],
          updated: [],
          deleted: []
        }
        
        for (const row of accountRows) {
          const account = {
            ...rowToAccount(row),
            version: row.version || 1,
            updatedAt: row.updated_at || row.created_at || Date.now()
          }
          
          // 判断是创建、更新还是删除
          if (row.is_del) {
            changes.accounts.deleted.push(account.id)
          } else if (row.created_at > modifiedSince) {
            changes.accounts.created.push(account)
          } else {
            changes.accounts.updated.push(account)
          }
        }
      } catch (accountError) {
        console.error('[Sync] Failed to fetch accounts:', accountError.message)
        throw accountError
      }
    }
    
    // 获取分组变更
    if (requestedResources.includes('groups')) {
      try {
        const [groupRows] = await pool.query(
          'SELECT * FROM `groups` WHERE updated_at > ? ORDER BY updated_at ASC',
          [modifiedSince]
        )
        
        changes.groups = {
          created: [],
          updated: [],
          deleted: []
        }
        
        for (const row of groupRows) {
          // 使用提取的公共函数转换分组数据
          const group = rowToGroup(row)
          
          if (row.created_at > modifiedSince) {
            changes.groups.created.push(group)
          } else {
            changes.groups.updated.push(group)
          }
        }
      } catch (groupError) {
        console.error('[Sync] Failed to fetch groups:', groupError.message)
        throw groupError
      }
    }
    
    // 获取标签变更
    if (requestedResources.includes('tags')) {
      try {
        const [tagRows] = await pool.query(
          'SELECT * FROM tags WHERE updated_at > ? ORDER BY updated_at ASC',
          [modifiedSince]
        )
        
        changes.tags = {
          created: [],
          updated: [],
          deleted: []
        }
        
        for (const row of tagRows) {
          // 使用提取的公共函数转换标签数据
          const tag = rowToTag(row)
          
          if (row.created_at > modifiedSince) {
            changes.tags.created.push(tag)
          } else {
            changes.tags.updated.push(tag)
          }
        }
      } catch (tagError) {
        console.error('[Sync] Failed to fetch tags:', tagError.message)
        throw tagError
      }
    }
    
    // 获取设置变更
    if (requestedResources.includes('settings')) {
      try {
        const [settingRows] = await pool.query(
          'SELECT * FROM settings WHERE updated_at > ? ORDER BY updated_at ASC',
          [modifiedSince]
        )
        
        changes.settings = {
          created: [],
          updated: [],
          deleted: []
        }
        
        for (const row of settingRows) {
          // 使用提取的公共函数转换设置数据
          const setting = rowToSetting(row)
          changes.settings.updated.push(setting)
        }
      } catch (settingError) {
        console.error('[Sync] Failed to fetch settings:', settingError.message)
        throw settingError
      }
    }
    
    // 获取机器码绑定变更
    if (requestedResources.includes('machineIdBindings')) {
      try {
        const [bindingRows] = await pool.query(
          'SELECT * FROM account_machine_ids WHERE updated_at > ? ORDER BY updated_at ASC',
          [modifiedSince]
        )
        
        changes.machineIdBindings = {
          created: [],
          updated: [],
          deleted: []
        }
        
        for (const row of bindingRows) {
          const binding = {
            accountId: row.account_id,
            machineId: row.machine_id,
            version: row.version || 1,
            updatedAt: row.updated_at || Date.now()
          }
          
          changes.machineIdBindings.updated.push(binding)
        }
      } catch (bindingError) {
        console.error('[Sync] Failed to fetch machine ID bindings:', bindingError.message)
        throw bindingError
      }
    }
    
    // 验证数据完整性
    const integrityCheck = validateChangesIntegrity(changes)
    if (!integrityCheck.valid) {
      console.error(`[Sync] [${requestId}] Data integrity check failed:`, integrityCheck.issues)
      return sendErrorResponse(res, ErrorType.INTERNAL_ERROR,
        '同步数据完整性检查失败，建议执行全量同步', {
          requestId,
          operation: 'sync_changes',
          issues: integrityCheck.issues,
          suggestion: '请使用 /api/v2/accounts、/api/v2/groups 等接口获取完整数据'
        })
    }
    
    // 添加变更统计信息
    const stats = {
      accounts: changes.accounts ? {
        created: changes.accounts.created.length,
        updated: changes.accounts.updated.length,
        deleted: changes.accounts.deleted.length
      } : null,
      groups: changes.groups ? {
        created: changes.groups.created.length,
        updated: changes.groups.updated.length
      } : null,
      tags: changes.tags ? {
        created: changes.tags.created.length,
        updated: changes.tags.updated.length
      } : null,
      settings: changes.settings ? {
        updated: changes.settings.updated.length
      } : null,
      machineIdBindings: changes.machineIdBindings ? {
        updated: changes.machineIdBindings.updated.length
      } : null
    }
    
    sendSuccessResponse(res, {
      ...changes,
      stats,
      requestId
    })
    
  } catch (error) {
    // 记录错误统计
    const errorType = classifyDatabaseError(error)
    recordErrorStats(errorType, 'sync_changes', error)
    
    console.error(`[Sync] [${requestId}] Get changes error:`, {
      error: error.message,
      code: error.code,
      modifiedSince: req.query.modifiedSince,
      resources: req.query.resources
    })
    
    const userMessage = getDatabaseErrorMessage(error, errorType)
    
    sendErrorResponse(res, errorType, userMessage, {
      requestId,
      operation: 'sync_changes',
      modifiedSince: req.query.modifiedSince,
      resources: req.query.resources,
      code: error.code
    })
  }
})

export default router