/**
 * 数据库迁移脚本：将V1账号批量升级到V2
 * 
 * 功能：
 * - 将指定账号或所有V1账号升级到V2版本
 * - 自动补全缺失的 amz_invocation_id 和 kiro_device_hash
 * - 更新 SDK 和 IDE 版本号为 V2 版本
 * 
 * 执行方式：
 * node server/db/migrations/upgrade-v1-to-v2.js [options]
 * 
 * 选项：
 * --all              升级所有V1账号
 * --email=xxx        升级指定邮箱的账号
 * --id=xxx           升级指定ID的账号
 * --dry-run          仅显示将要升级的账号，不实际执行
 */

import { getConnectionWithRetry } from '../../config/database.js'
import { randomUUID } from 'crypto'
import * as crypto from 'crypto'

// V2 版本的 SDK 和 IDE 版本号（与 header-generator.js 保持一致）
const V2_SDK_JS_VERSION = '1.0.27'
const V2_IDE_VERSION = '0.8.0'

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
 * 获取需要升级的账号列表
 */
async function getAccountsToUpgrade(conn, options) {
  let query = `
    SELECT id, email, header_version, amz_invocation_id, kiro_device_hash
    FROM accounts
    WHERE header_version = 1
      AND (is_del = FALSE OR is_del IS NULL)
  `
  const params = []
  
  if (options.email) {
    query += ' AND email = ?'
    params.push(options.email)
  } else if (options.id) {
    query += ' AND id = ?'
    params.push(options.id)
  }
  
  const [accounts] = await conn.query(query, params)
  return accounts
}

/**
 * 升级单个账号到V2
 */
async function upgradeAccountToV2(conn, account) {
  // 确保账号有必需的字段
  const invocationId = account.amz_invocation_id || generateInvocationId()
  const deviceHash = account.kiro_device_hash || generateDeviceHash()
  
  await conn.query(`
    UPDATE accounts 
    SET header_version = 2,
        amz_invocation_id = ?,
        kiro_device_hash = ?,
        sdk_js_version = ?,
        ide_version = ?
    WHERE id = ?
  `, [invocationId, deviceHash, V2_SDK_JS_VERSION, V2_IDE_VERSION, account.id])
  
  return {
    id: account.id,
    email: account.email,
    invocationId: invocationId.substring(0, 8) + '...',
    deviceHash: deviceHash.substring(0, 16) + '...'
  }
}

/**
 * 执行升级
 */
async function upgrade(options = {}) {
  const conn = await getConnectionWithRetry({ operationName: 'upgrade_v1_to_v2' })
  
  try {
    console.log('[Upgrade] 开始V1到V2升级流程')
    console.log('[Upgrade] ==========================================')
    
    // 获取需要升级的账号
    const accounts = await getAccountsToUpgrade(conn, options)
    
    if (accounts.length === 0) {
      console.log('[Upgrade] 没有找到需要升级的V1账号')
      return
    }
    
    console.log(`[Upgrade] 找到 ${accounts.length} 个V1账号需要升级`)
    
    // Dry-run 模式：仅显示将要升级的账号
    if (options.dryRun) {
      console.log('\n[Upgrade] DRY-RUN 模式 - 以下账号将被升级：')
      for (const account of accounts) {
        console.log(`  - ${account.email} (ID: ${account.id})`)
      }
      console.log('\n[Upgrade] 使用 --execute 参数执行实际升级')
      return
    }
    
    // 确认升级
    console.log('\n[Upgrade] 将要升级以下账号：')
    for (const account of accounts) {
      console.log(`  - ${account.email} (ID: ${account.id})`)
    }
    
    await conn.beginTransaction()
    
    const upgraded = []
    for (const account of accounts) {
      const result = await upgradeAccountToV2(conn, account)
      upgraded.push(result)
      console.log(`[Upgrade] ✅ 升级账号 ${result.email}`)
      console.log(`  - invocationId: ${result.invocationId}`)
      console.log(`  - deviceHash: ${result.deviceHash}`)
    }
    
    await conn.commit()
    
    console.log('\n[Upgrade] ==========================================')
    console.log(`[Upgrade] 成功升级 ${upgraded.length} 个账号到V2版本`)
    console.log('[Upgrade] 升级内容：')
    console.log('  - header_version: 1 → 2')
    console.log(`  - sdk_js_version: → ${V2_SDK_JS_VERSION}`)
    console.log(`  - ide_version: → ${V2_IDE_VERSION}`)
    console.log('  - 端点URL: codewhisperer.*.amazonaws.com → q.*.amazonaws.com')
    console.log('\n[Upgrade] 建议：')
    console.log('  1. 重启服务以清除缓存')
    console.log('  2. 监控升级后的账号API调用成功率')
    console.log('  3. 如有问题，可使用 downgrade-v2-to-v1.js 回滚')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Upgrade] 升级失败:', error)
    throw error
  } finally {
    conn.release()
  }
}

/**
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    all: false,
    email: null,
    id: null,
    dryRun: false
  }
  
  for (const arg of args) {
    if (arg === '--all') {
      options.all = true
    } else if (arg.startsWith('--email=')) {
      options.email = arg.split('=')[1]
    } else if (arg.startsWith('--id=')) {
      options.id = arg.split('=')[1]
    } else if (arg === '--dry-run') {
      options.dryRun = true
    }
  }
  
  return options
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs()
  
  // 验证参数
  if (!options.all && !options.email && !options.id) {
    console.error('[Upgrade] 错误：必须指定升级范围')
    console.error('\n使用方法：')
    console.error('  node server/db/migrations/upgrade-v1-to-v2.js --all              # 升级所有V1账号')
    console.error('  node server/db/migrations/upgrade-v1-to-v2.js --email=xxx        # 升级指定邮箱')
    console.error('  node server/db/migrations/upgrade-v1-to-v2.js --id=xxx           # 升级指定ID')
    console.error('  node server/db/migrations/upgrade-v1-to-v2.js --all --dry-run    # 预览升级')
    process.exit(1)
  }
  
  upgrade(options)
    .then(() => {
      console.log('[Upgrade] 升级完成')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[Upgrade] 升级失败:', error)
      process.exit(1)
    })
}

export { upgrade }