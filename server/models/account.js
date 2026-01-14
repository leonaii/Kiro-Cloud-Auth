/**
 * 账号模型
 * 数据转换和数据库操作
 */
import { pool } from '../db/index.js'
import { randomUUID } from 'crypto'
import { generateInvocationId, generateDeviceHash } from '../utils/header-generator.js'
import { DEFAULT_HEADER_VERSION, getDefaultHeaderVersionForIdp } from '../config/index.js'

// V1 和 V2 版本的 SDK 和 IDE 版本号（写死在代码中，与 header-generator.js 保持一致）
// V1 (旧端点 codewhisperer.*.amazonaws.com)
const V1_SDK_JS_VERSION = '1.0.0'
const V1_IDE_VERSION = '0.6.18'
// V2 (新端点 q.*.amazonaws.com)
const V2_SDK_JS_VERSION = '1.0.27'
const V2_IDE_VERSION = '0.8.0'

// Kiro Auth API 配置 - 严格匹配 Rust 实现 (kiro_auth_client.rs)
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

/**
 * 将字符串或数字转换为数字类型（用于时间戳字段的向后兼容）
 * @param {string|number|null|undefined} value - 原始值
 * @returns {number|undefined} - 转换后的数字或 undefined
 */
function toNumber(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    // 尝试解析 ISO 8601 日期字符串
    if (value.includes('T') && value.includes('Z')) {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        return date.getTime()
      }
    }
    // 尝试解析为数字
    const num = Number(value)
    return isNaN(num) ? undefined : num
  }
  return undefined
}

/**
 * 从数据库行转换为 JSON 格式账号对象
 */
export function rowToAccount(row) {
  return {
    id: row.id,
    email: row.email,
    userId: row.user_id,
    nickname: row.nickname,
    idp: row.idp,
    status: row.status,
    isActive: false, // is_active 字段已移除，由客户端本地管理
    groupId: row.group_id,
    tags: JSON.parse(row.tags || '[]'),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    // Header版本控制字段
    headerVersion: row.header_version || 1,
    amzInvocationId: row.amz_invocation_id,
    kiroDeviceHash: row.kiro_device_hash,
    sdkJsVersion: row.sdk_js_version,
    ideVersion: row.ide_version,
    credentials: {
      accessToken: row.cred_access_token,
      csrfToken: row.cred_csrf_token,
      refreshToken: row.cred_refresh_token,
      clientId: row.cred_client_id,
      clientIdHash: row.cred_client_id_hash,
      clientSecret: row.cred_client_secret,
      region: row.cred_region,
      expiresAt: row.cred_expires_at,
      authMethod: row.cred_auth_method,
      provider: row.cred_provider
    },
    subscription: {
      type: row.sub_type,
      title: row.sub_title,
      rawType: row.sub_raw_type,
      daysRemaining: row.sub_days_remaining,
      expiresAt: row.sub_expires_at,
      managementTarget: row.sub_management_target,
      upgradeCapability: row.sub_upgrade_capability,
      overageCapability: row.sub_overage_capability
    },
    usage: {
      current: row.usage_current,
      limit: row.usage_limit,
      percentUsed: parseFloat(row.usage_percent_used) || 0,
      lastUpdated: row.usage_last_updated,
      baseLimit: row.usage_base_limit,
      baseCurrent: row.usage_base_current,
      freeTrialLimit: row.usage_free_trial_limit,
      freeTrialCurrent: row.usage_free_trial_current,
      // 将字符串转换为数字（向后兼容历史数据）
      freeTrialExpiry: toNumber(row.usage_free_trial_expiry),
      // 解析 bonuses JSON，并确保 expiresAt 是数字类型
      bonuses: JSON.parse(row.usage_bonuses || '[]').map(b => ({
        ...b,
        expiresAt: toNumber(b.expiresAt)
      })),
      // 将字符串转换为数字（向后兼容历史数据）
      nextResetDate: toNumber(row.usage_next_reset_date),
      resourceDetail: {
        resourceType: row.res_resource_type,
        displayName: row.res_display_name,
        displayNamePlural: row.res_display_name_plural,
        currency: row.res_currency,
        unit: row.res_unit,
        overageRate: parseFloat(row.res_overage_rate) || 0,
        overageCap: row.res_overage_cap,
        overageEnabled: !!row.res_overage_enabled
      }
    },
    apiCallCount: row.api_call_count || 0,
    apiLastCallAt: row.api_last_call_at,
    apiTotalTokens: row.api_total_tokens || 0,
    // 软删除字段
    isDel: row.is_del === 1 || row.is_del === true || false,
    deletedAt: row.deleted_at
  }
}

/**
 * 插入或更新账号
 */
export async function insertAccount(conn, id, acc) {
  const cred = acc.credentials || {}
  const sub = acc.subscription || {}
  const usage = acc.usage || {}
  const res = usage.resourceDetail || {}

  // 为新账号自动生成header相关字段
  // 如果账号已有 headerVersion，使用现有值；否则根据 IDP 决定默认版本
  let headerVersion
  if (acc.headerVersion !== undefined) {
    headerVersion = acc.headerVersion
  } else if (acc.idp) {
    // 根据 IDP 获取默认版本（AWS=2, GITHUB/GOOGLE=1）
    headerVersion = getDefaultHeaderVersionForIdp(acc.idp)
  } else {
    // 如果没有 IDP 信息，使用全局默认值
    headerVersion = DEFAULT_HEADER_VERSION
  }
  
  const amzInvocationId = acc.amzInvocationId || generateInvocationId()
  const kiroDeviceHash = acc.kiroDeviceHash || generateDeviceHash()
  
  // 根据header版本选择对应的SDK和IDE版本
  const defaultSdkVersion = headerVersion === 2 ? V2_SDK_JS_VERSION : V1_SDK_JS_VERSION
  const defaultIdeVersion = headerVersion === 2 ? V2_IDE_VERSION : V1_IDE_VERSION
  const sdkJsVersion = acc.sdkJsVersion || defaultSdkVersion
  const ideVersion = acc.ideVersion || defaultIdeVersion

  // 调试日志：打印关键字段
  console.log(`[insertAccount] Processing account: ${id}`)
  console.log(`[insertAccount] Email: ${acc.email}, IDP: ${acc.idp}, Status: ${acc.status}`)
  console.log(`[insertAccount] Header Version: ${headerVersion} (IDP-based), SDK: ${sdkJsVersion}, IDE: ${ideVersion}`)
  console.log(`[insertAccount] Has credentials: ${!!cred.accessToken}`)
  console.log(`[insertAccount] Has subscription: ${!!sub.type}`)
  console.log(`[insertAccount] Has usage: ${usage.current !== undefined}`)

  try {
    await conn.query(
    `
    INSERT INTO accounts (
      id, email, user_id, nickname, idp, status, group_id, tags,
      created_at, last_used_at, last_checked_at, last_error,
      cred_access_token, cred_csrf_token, cred_refresh_token, cred_client_id, cred_client_id_hash,
      cred_client_secret, cred_region, cred_expires_at, cred_auth_method, cred_provider,
      sub_type, sub_title, sub_raw_type, sub_days_remaining, sub_expires_at,
      sub_management_target, sub_upgrade_capability, sub_overage_capability,
      usage_current, usage_limit, usage_percent_used, usage_last_updated,
      usage_base_limit, usage_base_current, usage_free_trial_limit, usage_free_trial_current,
      usage_free_trial_expiry, usage_bonuses, usage_next_reset_date,
      res_resource_type, res_display_name, res_display_name_plural, res_currency,
      res_unit, res_overage_rate, res_overage_cap, res_overage_enabled,
      is_del, deleted_at,
      header_version, amz_invocation_id, kiro_device_hash, sdk_js_version, ide_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      email=VALUES(email), user_id=VALUES(user_id), nickname=VALUES(nickname),
      idp=VALUES(idp), status=VALUES(status),
      group_id=VALUES(group_id), tags=VALUES(tags), last_used_at=VALUES(last_used_at),
      last_checked_at=VALUES(last_checked_at), last_error=VALUES(last_error),
      cred_access_token=VALUES(cred_access_token), cred_csrf_token=VALUES(cred_csrf_token),
      cred_refresh_token=VALUES(cred_refresh_token), cred_client_id=VALUES(cred_client_id),
      cred_client_id_hash=VALUES(cred_client_id_hash), cred_client_secret=VALUES(cred_client_secret), cred_region=VALUES(cred_region),
      cred_expires_at=GREATEST(COALESCE(cred_expires_at, 0), COALESCE(VALUES(cred_expires_at), 0)),
      cred_auth_method=VALUES(cred_auth_method), cred_provider=VALUES(cred_provider),
      sub_type=VALUES(sub_type), sub_title=VALUES(sub_title), sub_raw_type=VALUES(sub_raw_type),
      sub_days_remaining=VALUES(sub_days_remaining), sub_expires_at=VALUES(sub_expires_at),
      sub_management_target=VALUES(sub_management_target), sub_upgrade_capability=VALUES(sub_upgrade_capability),
      sub_overage_capability=VALUES(sub_overage_capability),
      usage_current=VALUES(usage_current), usage_limit=VALUES(usage_limit),
      usage_percent_used=VALUES(usage_percent_used), usage_last_updated=VALUES(usage_last_updated),
      usage_base_limit=VALUES(usage_base_limit), usage_base_current=VALUES(usage_base_current),
      usage_free_trial_limit=VALUES(usage_free_trial_limit), usage_free_trial_current=VALUES(usage_free_trial_current),
      usage_free_trial_expiry=VALUES(usage_free_trial_expiry), usage_bonuses=VALUES(usage_bonuses),
      usage_next_reset_date=VALUES(usage_next_reset_date),
      res_resource_type=VALUES(res_resource_type), res_display_name=VALUES(res_display_name),
      res_display_name_plural=VALUES(res_display_name_plural), res_currency=VALUES(res_currency),
      res_unit=VALUES(res_unit), res_overage_rate=VALUES(res_overage_rate),
      res_overage_cap=VALUES(res_overage_cap), res_overage_enabled=VALUES(res_overage_enabled),
      is_del=VALUES(is_del), deleted_at=VALUES(deleted_at),
      header_version=COALESCE(header_version, VALUES(header_version)),
      amz_invocation_id=COALESCE(amz_invocation_id, VALUES(amz_invocation_id)),
      kiro_device_hash=COALESCE(kiro_device_hash, VALUES(kiro_device_hash)),
      sdk_js_version=COALESCE(sdk_js_version, VALUES(sdk_js_version)),
      ide_version=COALESCE(ide_version, VALUES(ide_version))
  `,
    [
      id,
      acc.email,
      acc.userId,
      acc.nickname,
      acc.idp,
      acc.status || 'active',
      acc.groupId,
      JSON.stringify(acc.tags || []),
      acc.createdAt,
      acc.lastUsedAt,
      acc.lastCheckedAt,
      acc.lastError,
      cred.accessToken,
      cred.csrfToken,
      cred.refreshToken,
      cred.clientId,
      cred.clientIdHash,
      cred.clientSecret,
      cred.region,
      cred.expiresAt,
      cred.authMethod,
      cred.provider,
      sub.type,
      sub.title,
      sub.rawType,
      sub.daysRemaining,
      sub.expiresAt,
      sub.managementTarget,
      sub.upgradeCapability,
      sub.overageCapability,
      usage.current,
      usage.limit,
      usage.percentUsed,
      usage.lastUpdated,
      usage.baseLimit,
      usage.baseCurrent,
      usage.freeTrialLimit,
      usage.freeTrialCurrent,
      toNumber(usage.freeTrialExpiry),
      JSON.stringify(usage.bonuses || []),
      toNumber(usage.nextResetDate),
      res.resourceType,
      res.displayName,
      res.displayNamePlural,
      res.currency,
      res.unit,
      res.overageRate,
      res.overageCap,
      res.overageEnabled,
      // 软删除字段（新增账号默认为未删除）
      acc.isDel === true ? 1 : 0,
      acc.deletedAt || null,
      // Header版本控制字段
      headerVersion,
      amzInvocationId,
      kiroDeviceHash,
      sdkJsVersion,
      ideVersion
    ]
    )
    console.log(`[insertAccount] ✅ Account ${id} saved successfully (Header V${headerVersion})`)
  } catch (error) {
    console.error(`[insertAccount] ❌ Failed to save account ${id}:`, error.message)
    console.error(`[insertAccount] SQL Error Code:`, error.code)
    console.error(`[insertAccount] SQL State:`, error.sqlState)
    throw error
  }
}

/**
 * 获取或创建账号的机器码
 * @param {object} conn - 数据库连接（可选，如果不传则使用 pool）
 * @param {string} accountId - 账号ID
 * @returns {Promise<string>} 机器码
 */
export async function getOrCreateMachineId(conn, accountId) {
  const db = conn || pool
  const [machineIdRows] = await db.query(
    'SELECT machine_id FROM account_machine_ids WHERE account_id = ?',
    [accountId]
  )
  
  if (machineIdRows.length > 0) {
    return machineIdRows[0].machine_id
  }
  
  // 创建新的机器码
  const machineId = randomUUID()
  await db.query(
    'INSERT INTO account_machine_ids (account_id, machine_id) VALUES (?, ?)',
    [accountId, machineId]
  )
  
  return machineId
}

/**
 * 确定账号的 IDP（身份提供者）
 * @param {object} credentials - 凭证对象，包含 authMethod 和 provider
 * @param {string} existingIdp - 现有的 IDP 值
 * @returns {string} 确定的 IDP 字符串
 */
export function determineIdp(credentials, existingIdp) {
  if (credentials?.authMethod === 'social') {
    return credentials.provider || existingIdp || 'BuilderId'
  }
  if (credentials?.provider) {
    return credentials.provider
  }
  return existingIdp || 'BuilderId'
}

/**
 * 根据认证方式刷新 Token
 * 严格匹配 Rust 实现：不发送 x-amzn-sessionid 和 x-device-id
 *
 * @param {string} authMethod - 认证方式 ('social' | 'oidc' | 'IdC')
 * @param {string} refreshToken - 刷新令牌
 * @param {string} clientId - 客户端ID（OIDC 方式需要）
 * @param {string} clientSecret - 客户端密钥（OIDC 方式需要）
 * @param {string} region - AWS 区域（默认 'us-east-1'）
 * @returns {Promise<{success: boolean, accessToken?: string, refreshToken?: string, expiresIn?: number, error?: string}>}
 */
export async function refreshTokenByAuthMethod(authMethod, refreshToken, clientId, clientSecret, region) {
  if (authMethod === 'social') {
    // 社交登录：使用 Kiro Auth Service 刷新
    // 严格匹配 kiro_auth_client.rs：只发送 User-Agent: KiroBatchLoginCLI/1.0.0
    const response = await fetch(`${KIRO_AUTH_ENDPOINT}/refreshToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KiroBatchLoginCLI/1.0.0'
      },
      body: JSON.stringify({ refreshToken })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn
    }
  } else {
    // IdC/BuilderId：使用 AWS OIDC 刷新
    // 严格匹配 aws_sso_client.rs：只发送 Content-Type
    const url = `https://oidc.${region || 'us-east-1'}.amazonaws.com/token`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken,
        grantType: 'refresh_token'
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn
    }
  }
}

/**
 * 如果指定账号是当前激活账号，则清除激活状态
 * @param {string} accountId - 账号ID
 * @returns {Promise<void>}
 */
export async function clearActiveAccountIfMatch(accountId) {
  const [settings] = await pool.query("SELECT value FROM settings WHERE `key` = 'activeAccountId'")
  if (settings.length > 0 && settings[0].value === accountId) {
    await pool.query("UPDATE settings SET value = NULL WHERE `key` = 'activeAccountId'")
  }
}

/**
 * 将数据库行转换为分组对象
 * @param {object} row - 数据库行
 * @returns {object} 分组对象
 */
export function rowToGroup(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description || undefined,
    apiKey: row.api_key || undefined,
    order: row.order,
    createdAt: row.created_at,
    version: row.version || 1,
    updatedAt: row.updated_at || row.created_at || Date.now()
  }
}

/**
 * 将数据库行转换为标签对象
 * @param {object} row - 数据库行
 * @returns {object} 标签对象
 */
export function rowToTag(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    version: row.version || 1,
    updatedAt: row.updated_at || row.created_at || Date.now()
  }
}

/**
 * 将数据库行转换为设置对象（包含类型解析）
 * @param {object} row - 数据库行
 * @returns {object} 设置对象 { key, value, valueType, version, updatedAt }
 */
export function rowToSetting(row) {
  let value
  try {
    if (row.value_type === 'json') {
      value = JSON.parse(row.value)
    } else if (row.value_type === 'boolean') {
      value = row.value === 'true'
    } else if (row.value_type === 'number') {
      value = Number(row.value)
    } else {
      value = row.value
    }
  } catch (parseError) {
    console.warn(`[Model] Failed to parse setting ${row.key}:`, parseError.message)
    value = row.value
  }
  return {
    key: row.key,
    value,
    valueType: row.value_type,
    version: row.version || 1,
    updatedAt: row.updated_at || Date.now()
  }
}

export default {
  rowToAccount,
  insertAccount,
  getOrCreateMachineId,
  determineIdp,
  refreshTokenByAuthMethod,
  clearActiveAccountIfMatch,
  rowToGroup,
  rowToTag,
  rowToSetting
}
