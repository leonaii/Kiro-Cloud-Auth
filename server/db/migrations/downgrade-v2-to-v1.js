/**
 * 数据库迁移脚本：将V2账号降级到V1（回滚操作）
 * 
 * 功能：
 * - 将指定账号或所有V2账号降级回V1版本
 * - 保留 amz_invocation_id 和 kiro_device_hash（以防再次升级）
 * - 更新 SDK 和 IDE 版本号为 V1 版本
 * 
 * 执行方式：
 * node server/db/migrations/downgrade-v2-to-v1.js [options]
 * 
 * 选项：
 * --all              降级所有V2账号
 * --email=xxx        降级指定邮箱的账号
 * --id=xxx           降级指定ID的账号
 * --dry-run          仅显示将要降级的账号，不实际执行
 */

import { getConnectionWithRetry } from '../../config/database.js'

// V1 版本的 SDK 和 IDE 版本号（与 header-generator.js 保持一致）
// V1 (旧端点 codewhisperer.*.amazonaws.com)
const V1_SDK_JS_VERSION = '1.0.0'
const V1_IDE_VERSION = '0.6.18'

/**
 * 获取需要降级的账号列表
 */
async function getAccountsToDowngrade(conn, options) {
  let query = `
    SELECT id, email, header_version
    FROM accounts
    WHERE header_version = 2
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
 * 降级单个账号到V1
 */
async function downgradeAccountToV1(conn, account) {
  // 降级到V1，但保留 invocation_id 和 device_hash（以防再次升级）
  await conn.query(`
    UPDATE accounts 
    SET header_version = 1,
        sdk_js_version = ?,
        ide_version = ?
    WHERE id = ?
  `, [V1_SDK_JS_VERSION, V1_IDE_VERSION, account.id])
  
  return {
    id: account.id,
    email: account.email
  }
}

/**
 * 执行降级
 */
async function downgrade(options = {}) {
  const conn = await getConnectionWithRetry({ operationName: 'downgrade_v2_to_v1' })
  
  try {
    console.log('[Downgrade] 开始V2到V1降级流程')
    console.log('[Downgrade] ==========================================')
    
    // 获取需要降级的账号
    const accounts = await getAccountsToDowngrade(conn, options)
    
    if (accounts.length === 0) {
      console.log('[Downgrade] 没有找到需要降级的V2账号')
      return
    }
    
    console.log(`[Downgrade] 找到 ${accounts.length} 个V2账号需要降级`)
    
    // Dry-run 模式：仅显示将要降级的账号
    if (options.dryRun) {
      console.log('\n[Downgrade] DRY-RUN 模式 - 以下账号将被降级：')
      for (const account of accounts) {
        console.log(`  - ${account.email} (ID: ${account.id})`)
      }
      console.log('\n[Downgrade] 移除 --dry-run 参数执行实际降级')
      return
    }
    
    // 显示将要降级的账号
    console.log('\n[Downgrade] 将要降级以下账号：')
    for (const account of accounts) {
      console.log(`  - ${account.email} (ID: ${account.id})`)
    }
    
    await conn.beginTransaction()
    
    const downgraded = []
    for (const account of accounts) {
      const result = await downgradeAccountToV1(conn, account)
      downgraded.push(result)
      console.log(`[Downgrade] ✅ 降级账号 ${result.email}`)
    }
    
    await conn.commit()
    
    console.log('\n[Downgrade] ==========================================')
    console.log(`[Downgrade] 成功降级 ${downgraded.length} 个账号到V1版本`)
    console.log('[Downgrade] 降级内容：')
    console.log('  - header_version: 2 → 1')
    console.log(`  - sdk_js_version: → ${V1_SDK_JS_VERSION}`)
    console.log(`  - ide_version: → ${V1_IDE_VERSION}`)
    console.log('  - 端点URL: q.*.amazonaws.com → codewhisperer.*.amazonaws.com')
    console.log('\n[Downgrade] 注意：')
    console.log('  - amz_invocation_id 和 kiro_device_hash 已保留')
    console.log('  - 如需再次升级，这些ID将被重用')
    console.log('\n[Downgrade] 建议：')
    console.log('  1. 重启服务以清除缓存')
    console.log('  2. 监控降级后的账号API调用成功率')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Downgrade] 降级失败:', error)
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
    console.error('[Downgrade] 错误：必须指定降级范围')
    console.error('\n使用方法：')
    console.error('  node server/db/migrations/downgrade-v2-to-v1.js --all              # 降级所有V2账号')
    console.error('  node server/db/migrations/downgrade-v2-to-v1.js --email=xxx        # 降级指定邮箱')
    console.error('  node server/db/migrations/downgrade-v2-to-v1.js --id=xxx           # 降级指定ID')
    console.error('  node server/db/migrations/downgrade-v2-to-v1.js --all --dry-run    # 预览降级')
    process.exit(1)
  }
  
  downgrade(options)
    .then(() => {
      console.log('[Downgrade] 降级完成')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[Downgrade] 降级失败:', error)
      process.exit(1)
    })
}

export { downgrade }