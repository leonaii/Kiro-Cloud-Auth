/**
 * Kiro API 工具函数
 * 用于调用 CodeWhisperer API 获取使用量和订阅信息
 */

import { generateHeaders, getEndpointUrl } from './header-generator.js'

/**
 * 将时间戳转换为毫秒级
 * Kiro API 返回的是秒级时间戳，需要转换为毫秒
 * 判断逻辑：如果值小于 10000000000（即 2001 年之前的毫秒数），认为是秒级
 *
 * @param {number|undefined|null} ts - 原始时间戳
 * @returns {number|undefined} - 毫秒级时间戳
 */
export function toMilliseconds(ts) {
  // 统一处理：null/undefined/0 返回 undefined
  if (!ts) return undefined
  // 秒级时间戳（< 10000000000）转换为毫秒
  return ts < 10000000000 ? ts * 1000 : ts
}

/**
 * 调用 CodeWhisperer API 获取使用量
 * 支持V1和V2两种header格式和端点
 *
 * @param {string} accessToken - 访问令牌
 * @param {object} account - 账号对象（包含 headerVersion, machineId 等信息）
 * @returns {Promise<object>} - API 响应
 */
export async function getUsageLimits(accessToken, account) {
  // 如果传入的是字符串（旧的machineId参数），兼容处理
  let accountObj = account
  if (typeof account === 'string') {
    // 向后兼容：如果第二个参数是字符串，视为machineId
    accountObj = {
      headerVersion: 1,
      machineId: account,
      credentials: { accessToken, region: 'us-east-1' }
    }
  }

  const region = accountObj.credentials?.region || 'us-east-1'
  const headerVersion = accountObj.headerVersion || 1
  
  // 根据 headerVersion 选择端点URL
  const baseUrl = getEndpointUrl(headerVersion, region, 'usage')
  const url = `${baseUrl}?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`

  // 使用统一的 header 生成器
  const headers = generateHeaders(accountObj, accessToken)

  const response = await fetch(url, {
    method: 'GET',
    headers
  })

  const status = response.status
  const text = await response.text()

  if (!response.ok) {
    // 解析错误响应，提取 reason 字段
    try {
      const errorJson = JSON.parse(text)
      if (errorJson.reason) {
        throw new Error(`BANNED:${errorJson.reason}`)
      }
    } catch (e) {
      if (e.message && e.message.startsWith('BANNED:')) throw e
    }
    throw new Error(`GetUsageLimits failed (${status}): ${text}`)
  }

  return JSON.parse(text)
}

/**
 * 解析使用量响应
 * 
 * @param {object} result - API 响应
 * @param {object|undefined} newCredentials - 新的凭证（可选）
 * @param {string|undefined} idp - 身份提供者（可选）
 * @returns {object} - 解析后的使用量和订阅信息
 */
export function parseUsageResponse(result, newCredentials, idp) {
  // 解析 Credits 使用量
  const creditUsage = result.usageBreakdownList?.find(
    (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
  )

  // 基础额度
  const baseLimit = creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsage ?? 0

  // 试用额度
  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry = undefined
  
  // 无论试用期是否激活，都尝试提取 freeTrialExpiry
  if (creditUsage?.freeTrialInfo) {
    // API 返回的是秒级时间戳，转换为毫秒
    freeTrialExpiry = toMilliseconds(creditUsage.freeTrialInfo.freeTrialExpiry)
    
    // 只有激活状态才计入额度
    if (creditUsage.freeTrialInfo.freeTrialStatus === 'ACTIVE') {
      freeTrialLimit = creditUsage.freeTrialInfo.usageLimit ?? 0
      freeTrialCurrent = creditUsage.freeTrialInfo.currentUsage ?? 0
    }
  }

  // 奖励额度
  const bonusesData = []
  if (creditUsage?.bonuses) {
    for (const bonus of creditUsage.bonuses) {
      if (bonus.status === 'ACTIVE') {
        bonusesData.push({
          code: bonus.bonusCode || '',
          name: bonus.displayName || '',
          current: bonus.currentUsage ?? 0,
          limit: bonus.usageLimit ?? 0,
          // API 返回的是秒级时间戳，转换为毫秒
          expiresAt: toMilliseconds(bonus.expiresAt)
        })
      }
    }
  }

  // 计算总额度
  const totalLimit = baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
  const totalUsed = baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)

  // 解析订阅类型
  const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
  let subscriptionType = 'Free'
  if (subscriptionTitle.toUpperCase().includes('PRO')) {
    subscriptionType = 'Pro'
  } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
    subscriptionType = 'Enterprise'
  } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
    subscriptionType = 'Teams'
  }

  // 计算剩余天数
  // 注意：API 返回的 nextDateReset 是秒级时间戳，需要转换为毫秒
  let expiresAt, daysRemaining
  if (result.nextDateReset && typeof result.nextDateReset === 'number') {
    // 转换为毫秒级时间戳
    expiresAt = toMilliseconds(result.nextDateReset)
    const now = Date.now()
    daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
  }

  // 资源详情（与 Electron 端一致）
  const resourceDetail = creditUsage
    ? {
        resourceType: creditUsage.resourceType,
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: result.overageConfiguration?.overageEnabled ?? false
      }
    : undefined

  // nextResetDate 也需要转换为毫秒
  const nextResetDate = toMilliseconds(result.nextDateReset)

  return {
    success: true,
    data: {
      status: 'active',
      email: result.userInfo?.email,
      userId: result.userInfo?.userId,
      idp: idp,
      subscriptionTitle,
      usage: {
        current: totalUsed,
        limit: totalLimit,
        percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
        lastUpdated: Date.now(),
        baseLimit,
        baseCurrent,
        freeTrialLimit,
        freeTrialCurrent,
        freeTrialExpiry,
        bonuses: bonusesData,
        nextResetDate,
        resourceDetail
      },
      subscription: {
        type: subscriptionType,
        title: subscriptionTitle,
        rawType: result.subscriptionInfo?.type,
        expiresAt,
        daysRemaining,
        upgradeCapability: result.subscriptionInfo?.upgradeCapability,
        overageCapability: result.subscriptionInfo?.overageCapability,
        managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
      },
      newCredentials: newCredentials ? {
        accessToken: newCredentials.accessToken,
        refreshToken: newCredentials.refreshToken,
        expiresAt: newCredentials.expiresIn ? Date.now() + newCredentials.expiresIn * 1000 : undefined
      } : undefined
    }
  }
}

/**
 * 生成更新使用量和订阅信息的 SQL 参数
 * 
 * @param {object} parsed - parseUsageResponse 返回的解析结果
 * @param {string} accountId - 账号 ID
 * @returns {object} - { sql: string, params: array }
 */
export function buildUsageUpdateSQL(parsed, accountId) {
  const resourceDetail = parsed.data.usage.resourceDetail || {}
  
  const sql = `UPDATE accounts SET
    usage_current = ?, usage_limit = ?, usage_percent_used = ?, usage_last_updated = ?,
    usage_base_limit = ?, usage_base_current = ?,
    usage_free_trial_limit = ?, usage_free_trial_current = ?, usage_free_trial_expiry = ?,
    usage_bonuses = ?, usage_next_reset_date = ?,
    sub_type = ?, sub_title = ?, sub_days_remaining = ?, sub_expires_at = ?,
    sub_raw_type = ?, sub_upgrade_capability = ?, sub_overage_capability = ?, sub_management_target = ?,
    res_resource_type = ?, res_display_name = ?, res_display_name_plural = ?,
    res_currency = ?, res_unit = ?, res_overage_rate = ?,
    res_overage_cap = ?, res_overage_enabled = ?,
    status = 'active', last_checked_at = ?
   WHERE id = ?`

  const params = [
    parsed.data.usage.current, parsed.data.usage.limit, parsed.data.usage.percentUsed, Date.now(),
    parsed.data.usage.baseLimit, parsed.data.usage.baseCurrent,
    parsed.data.usage.freeTrialLimit, parsed.data.usage.freeTrialCurrent, parsed.data.usage.freeTrialExpiry,
    JSON.stringify(parsed.data.usage.bonuses || []), parsed.data.usage.nextResetDate,
    parsed.data.subscription.type, parsed.data.subscription.title, parsed.data.subscription.daysRemaining, parsed.data.subscription.expiresAt,
    parsed.data.subscription.rawType, parsed.data.subscription.upgradeCapability, parsed.data.subscription.overageCapability, parsed.data.subscription.managementTarget,
    resourceDetail.resourceType, resourceDetail.displayName, resourceDetail.displayNamePlural,
    resourceDetail.currency, resourceDetail.unit, resourceDetail.overageRate,
    resourceDetail.overageCap, resourceDetail.overageEnabled ? 1 : 0,
    Date.now(), accountId
  ]

  return { sql, params }
}

export default {
  toMilliseconds,
  getUsageLimits,
  parseUsageResponse,
  buildUsageUpdateSQL
}