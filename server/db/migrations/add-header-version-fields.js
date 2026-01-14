/**
 * 数据库迁移脚本：添加Header版本控制字段
 * 
 * 为 accounts 表添加：
 * - header_version: Header版本号（1=V1老版本使用codewhisperer端点, 2=V2新版本使用q端点）
 * - amz_invocation_id: 账号专属32位GUID（用于amz-sdk-invocation-id header）
 * - kiro_device_hash: 账号专属64位hash（用于user-agent和x-amz-user-agent）
 * - sdk_js_version: SDK版本号（如 '1.0.27'）
 * - ide_version: IDE版本号（如 '0.8.0'）
 * 
 * 执行方式：
 * node server/db/migrations/add-header-version-fields.js
 */

import { getConnectionWithRetry } from '../../config/database.js'
import { randomUUID } from 'crypto'
import * as crypto from 'crypto'

/**
 * 检查列是否存在
 */
async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as count 
     FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ? 
     AND COLUMN_NAME = ?`,
    [tableName, columnName]
  )
  return rows[0].count > 0
}

/**
 * 生成64位设备hash
 */
function generateDeviceHash() {
  const randomBytes = crypto.randomBytes(32)
  return randomBytes.toString('hex')
}

/**
 * 生成32位GUID（标准UUID v4格式，带连字符）
 */
function generateInvocationId() {
  return randomUUID()
}

/**
 * 为表添加Header版本控制字段
 */
async function addHeaderVersionColumns(conn) {
  console.log('[Migration] 检查 accounts 表的 Header 版本控制字段...')
  
  // 添加 header_version 字段
  const hasHeaderVersion = await columnExists(conn, 'accounts', 'header_version')
  if (!hasHeaderVersion) {
    console.log('[Migration] 为 accounts 表添加 header_version 字段...')
    await conn.query('ALTER TABLE accounts ADD COLUMN header_version INT NOT NULL DEFAULT 1')
  } else {
    console.log('[Migration] accounts 表已存在 header_version 字段，跳过')
  }
  
  // 添加 amz_invocation_id 字段
  const hasInvocationId = await columnExists(conn, 'accounts', 'amz_invocation_id')
  if (!hasInvocationId) {
    console.log('[Migration] 为 accounts 表添加 amz_invocation_id 字段...')
    await conn.query('ALTER TABLE accounts ADD COLUMN amz_invocation_id VARCHAR(36)')
  } else {
    console.log('[Migration] accounts 表已存在 amz_invocation_id 字段，跳过')
  }
  
  // 添加 kiro_device_hash 字段
  const hasDeviceHash = await columnExists(conn, 'accounts', 'kiro_device_hash')
  if (!hasDeviceHash) {
    console.log('[Migration] 为 accounts 表添加 kiro_device_hash 字段...')
    await conn.query('ALTER TABLE accounts ADD COLUMN kiro_device_hash VARCHAR(64)')
  } else {
    console.log('[Migration] accounts 表已存在 kiro_device_hash 字段，跳过')
  }
  
  // 添加 sdk_js_version 字段
  const hasSdkVersion = await columnExists(conn, 'accounts', 'sdk_js_version')
  if (!hasSdkVersion) {
    console.log('[Migration] 为 accounts 表添加 sdk_js_version 字段...')
    await conn.query('ALTER TABLE accounts ADD COLUMN sdk_js_version VARCHAR(20)')
  } else {
    console.log('[Migration] accounts 表已存在 sdk_js_version 字段，跳过')
  }
  
  // 添加 ide_version 字段
  const hasIdeVersion = await columnExists(conn, 'accounts', 'ide_version')
  if (!hasIdeVersion) {
    console.log('[Migration] 为 accounts 表添加 ide_version 字段...')
    await conn.query('ALTER TABLE accounts ADD COLUMN ide_version VARCHAR(20)')
  } else {
    console.log('[Migration] accounts 表已存在 ide_version 字段，跳过')
  }
}

/**
 * 初始化现有账号的Header版本控制数据
 */
async function initializeHeaderVersionData(conn) {
  console.log('[Migration] 初始化现有账号的 Header 版本控制数据...')
  
  // 获取所有需要初始化的账号
  const [accounts] = await conn.query(`
    SELECT id, email 
    FROM accounts 
    WHERE amz_invocation_id IS NULL 
       OR kiro_device_hash IS NULL
  `)
  
  if (accounts.length === 0) {
    console.log('[Migration] 没有需要初始化的账号')
    return
  }
  
  console.log(`[Migration] 需要初始化 ${accounts.length} 个账号`)
  
  // 为每个账号生成唯一的ID和hash
  for (const account of accounts) {
    const invocationId = generateInvocationId()
    const deviceHash = generateDeviceHash()
    
    // V1版本使用V1的SDK和IDE版本（与 header-generator.js 保持一致）
    await conn.query(`
      UPDATE accounts
      SET amz_invocation_id = ?,
          kiro_device_hash = ?,
          header_version = 1,
          sdk_js_version = COALESCE(sdk_js_version, '1.0.0'),
          ide_version = COALESCE(ide_version, '0.6.18')
      WHERE id = ?
    `, [invocationId, deviceHash, account.id])
    
    console.log(`[Migration] 初始化账号 ${account.email}: invocationId=${invocationId.substring(0, 8)}..., deviceHash=${deviceHash.substring(0, 16)}...`)
  }
  
  console.log('[Migration] 所有账号的 Header 版本控制数据初始化完成')
}

/**
 * 执行迁移
 */
async function migrate() {
  const conn = await getConnectionWithRetry({ operationName: 'migration_header_version' })
  
  try {
    console.log('[Migration] 开始数据库迁移：添加 Header 版本控制字段')
    console.log('[Migration] ==========================================')
    
    await conn.beginTransaction()
    
    // 1. 添加字段
    await addHeaderVersionColumns(conn)
    
    // 2. 初始化现有账号数据
    await initializeHeaderVersionData(conn)
    
    await conn.commit()
    
    console.log('\n[Migration] ==========================================')
    console.log('[Migration] 数据库迁移成功完成！')
    console.log('[Migration] accounts 表已添加 Header 版本控制字段')
    console.log('[Migration] 所有现有账号已设置为 V1 版本（header_version=1）')
    console.log('[Migration] 新账号将根据全局配置决定使用哪个版本')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Migration] 迁移失败:', error)
    throw error
  } finally {
    conn.release()
  }
}

/**
 * 回滚迁移（可选）
 */
async function rollback() {
  const conn = await getConnectionWithRetry({ operationName: 'rollback_header_version' })
  
  try {
    console.log('[Migration] 开始回滚迁移...')
    
    await conn.beginTransaction()
    
    // 删除字段
    const fieldsToRemove = [
      'header_version',
      'amz_invocation_id', 
      'kiro_device_hash',
      'sdk_js_version',
      'ide_version'
    ]
    
    for (const field of fieldsToRemove) {
      if (await columnExists(conn, 'accounts', field)) {
        console.log(`[Migration] 删除字段: ${field}`)
        await conn.query(`ALTER TABLE accounts DROP COLUMN ${field}`)
      }
    }
    
    await conn.commit()
    console.log('[Migration] 回滚完成')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Migration] 回滚失败:', error)
    throw error
  } finally {
    conn.release()
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2]
  
  if (command === 'rollback') {
    rollback()
      .then(() => {
        console.log('[Migration] 回滚成功')
        process.exit(0)
      })
      .catch((error) => {
        console.error('[Migration] 回滚失败:', error)
        process.exit(1)
      })
  } else {
    migrate()
      .then(() => {
        console.log('[Migration] 迁移成功')
        process.exit(0)
      })
      .catch((error) => {
        console.error('[Migration] 迁移失败:', error)
        process.exit(1)
      })
  }
}

export { migrate, rollback }