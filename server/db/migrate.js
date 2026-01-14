/**
 * 数据库迁移
 * 检查并修复所有表的字段，保留现有数据
 */
import { getDbName } from '../config/database.js'
import { TABLES } from './schema.js'
import { randomUUID } from 'crypto'
import * as crypto from 'crypto'

/**
 * 从字段定义中提取数据类型
 * @param {string} definition - 字段定义，如 "BIGINT" 或 "VARCHAR(50)"
 * @returns {string} - 数据类型，如 "bigint" 或 "varchar"
 */
function extractDataType(definition) {
  // 提取类型名称（忽略大小写和参数）
  const match = definition.match(/^(\w+)/i)
  return match ? match[1].toLowerCase() : ''
}

/**
 * 需要进行类型迁移的字段配置
 * 从 VARCHAR 转换为 BIGINT（时间戳字段）
 */
const TYPE_MIGRATIONS = {
  accounts: [
    { column: 'usage_free_trial_expiry', from: 'varchar', to: 'BIGINT' },
    { column: 'usage_next_reset_date', from: 'varchar', to: 'BIGINT' }
  ]
}

/**
 * 获取表的现有字段
 */
async function getExistingColumns(conn, tableName) {
  const dbName = getDbName()
  const [columns] = await conn.query(
    `
    SELECT COLUMN_NAME, DATA_TYPE, COLUMN_DEFAULT, IS_NULLABLE, COLUMN_KEY
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  `,
    [dbName, tableName]
  )
  return new Map(columns.map((c) => [c.COLUMN_NAME, c]))
}

/**
 * 获取表的现有索引
 */
async function getExistingIndexes(conn, tableName) {
  const dbName = getDbName()
  const [indexes] = await conn.query(
    `
    SELECT DISTINCT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
  `,
    [dbName, tableName]
  )
  return new Set(indexes.map((i) => i.INDEX_NAME))
}

/**
 * 检查表是否存在
 */
async function tableExists(conn, tableName) {
  const dbName = getDbName()
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  `,
    [dbName, tableName]
  )
  return rows.length > 0
}

/**
 * 执行字段类型迁移
 * 将 VARCHAR 字段转换为 BIGINT（用于时间戳字段）
 */
async function migrateColumnTypes(conn, tableName) {
  const migrations = TYPE_MIGRATIONS[tableName]
  if (!migrations || migrations.length === 0) {
    return { migrated: 0 }
  }

  const existingColumns = await getExistingColumns(conn, tableName)
  let migratedCount = 0

  for (const migration of migrations) {
    const { column, from, to } = migration
    const existingCol = existingColumns.get(column)

    if (!existingCol) {
      // 字段不存在，跳过（会在后续的 migrateTable 中添加）
      continue
    }

    const currentType = existingCol.DATA_TYPE.toLowerCase()

    // 检查是否需要迁移（当前类型与目标类型不匹配）
    if (currentType === from) {
      console.log(`[Migration] Converting ${tableName}.${column} from ${from.toUpperCase()} to ${to}...`)

      try {
        // 使用 MODIFY COLUMN 来更改字段类型
        // MySQL 会自动将有效的数字字符串转换为 BIGINT
        // 无效的值会变成 0 或 NULL
        await conn.query(`
          ALTER TABLE \`${tableName}\`
          MODIFY COLUMN ${column} ${to}
        `)
        console.log(`[Migration] ✓ Converted ${tableName}.${column} to ${to}`)
        migratedCount++
      } catch (error) {
        console.error(`[Migration] ✗ Failed to convert ${tableName}.${column}:`, error.message)
        // 不抛出错误，让迁移继续进行
      }
    }
  }

  return { migrated: migratedCount }
}

/**
 * 迁移单个表
 */
async function migrateTable(conn, tableName, tableSchema) {
  const { columns, indexes = [] } = tableSchema

  // 检查表是否存在
  if (!(await tableExists(conn, tableName))) {
    console.log(`[Migration] Table '${tableName}' does not exist, skipping migration`)
    return { added: 0, skipped: 0, migrated: 0 }
  }

  // 先执行字段类型迁移
  const typeMigrationResult = await migrateColumnTypes(conn, tableName)

  const existingColumns = await getExistingColumns(conn, tableName)
  const existingIndexes = await getExistingIndexes(conn, tableName)

  let addedCount = 0
  let skippedCount = 0

  // 检查并添加缺失的字段
  for (const col of columns) {
    // 跳过主键字段（不能通过 ALTER TABLE 添加）
    if (col.definition.includes('PRIMARY KEY')) {
      continue
    }

    if (!existingColumns.has(col.name)) {
      const columnName = col.isReserved ? `\`${col.name}\`` : col.name
      try {
        await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnName} ${col.definition}`)
        console.log(`[Migration] ✓ Added column: ${tableName}.${col.name}`)
        addedCount++
      } catch (error) {
        if (error.message.includes('Duplicate column')) {
          skippedCount++
        } else {
          console.error(`[Migration] ✗ Failed to add column ${tableName}.${col.name}:`, error.message)
        }
      }
    } else {
      skippedCount++
    }
  }

  // 检查并添加缺失的索引
  for (const idx of indexes) {
    if (!existingIndexes.has(idx.name)) {
      try {
        await conn.query(`ALTER TABLE \`${tableName}\` ADD INDEX ${idx.name} (${idx.columns})`)
        console.log(`[Migration] ✓ Added index: ${tableName}.${idx.name}`)
      } catch (error) {
        if (!error.message.includes('Duplicate key name')) {
          console.error(`[Migration] ✗ Failed to add index ${idx.name}:`, error.message)
        }
      }
    }
  }

  return { added: addedCount, skipped: skippedCount, migrated: typeMigrationResult.migrated }
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

// V1 和 V2 版本的 SDK 和 IDE 版本号（与 header-generator.js 保持一致）
const V1_SDK_JS_VERSION = '1.0.0'
const V1_IDE_VERSION = '0.6.18'
const V2_SDK_JS_VERSION = '1.0.27'
const V2_IDE_VERSION = '0.8.0'

/**
 * 修正账号的 SDK 和 IDE 版本号
 * 根据 header_version 字段确保版本号正确
 * - header_version = 1: sdk_js_version = '1.0.0', ide_version = '0.6.18'
 * - header_version = 2: sdk_js_version = '1.0.27', ide_version = '0.8.0'
 */
async function fixVersionNumbers(conn) {
  try {
    // 检查是否需要修正（字段是否存在）
    const existingColumns = await getExistingColumns(conn, 'accounts')
    if (!existingColumns.has('header_version') || !existingColumns.has('sdk_js_version') || !existingColumns.has('ide_version')) {
      return { fixed: 0 } // 字段还未添加，跳过修正
    }

    // 查找版本号不匹配的 V1 账号
    const [v1Accounts] = await conn.query(`
      SELECT id, email, header_version, sdk_js_version, ide_version
      FROM accounts
      WHERE header_version = 1
        AND (sdk_js_version != ? OR ide_version != ? OR sdk_js_version IS NULL OR ide_version IS NULL)
    `, [V1_SDK_JS_VERSION, V1_IDE_VERSION])

    // 查找版本号不匹配的 V2 账号
    const [v2Accounts] = await conn.query(`
      SELECT id, email, header_version, sdk_js_version, ide_version
      FROM accounts
      WHERE header_version = 2
        AND (sdk_js_version != ? OR ide_version != ? OR sdk_js_version IS NULL OR ide_version IS NULL)
    `, [V2_SDK_JS_VERSION, V2_IDE_VERSION])

    const totalToFix = v1Accounts.length + v2Accounts.length
    if (totalToFix === 0) {
      return { fixed: 0 }
    }

    console.log(`[Migration] Fixing version numbers for ${totalToFix} accounts (V1: ${v1Accounts.length}, V2: ${v2Accounts.length})...`)

    let fixedCount = 0

    // 修正 V1 账号
    if (v1Accounts.length > 0) {
      await conn.query(`
        UPDATE accounts
        SET sdk_js_version = ?,
            ide_version = ?
        WHERE header_version = 1
          AND (sdk_js_version != ? OR ide_version != ? OR sdk_js_version IS NULL OR ide_version IS NULL)
      `, [V1_SDK_JS_VERSION, V1_IDE_VERSION, V1_SDK_JS_VERSION, V1_IDE_VERSION])
      
      fixedCount += v1Accounts.length
      if (v1Accounts.length <= 3) {
        for (const account of v1Accounts) {
          console.log(`[Migration] ✓ Fixed V1 account ${account.email}: sdk=${V1_SDK_JS_VERSION}, ide=${V1_IDE_VERSION}`)
        }
      } else {
        console.log(`[Migration] ✓ Fixed ${v1Accounts.length} V1 accounts: sdk=${V1_SDK_JS_VERSION}, ide=${V1_IDE_VERSION}`)
      }
    }

    // 修正 V2 账号
    if (v2Accounts.length > 0) {
      await conn.query(`
        UPDATE accounts
        SET sdk_js_version = ?,
            ide_version = ?
        WHERE header_version = 2
          AND (sdk_js_version != ? OR ide_version != ? OR sdk_js_version IS NULL OR ide_version IS NULL)
      `, [V2_SDK_JS_VERSION, V2_IDE_VERSION, V2_SDK_JS_VERSION, V2_IDE_VERSION])
      
      fixedCount += v2Accounts.length
      if (v2Accounts.length <= 3) {
        for (const account of v2Accounts) {
          console.log(`[Migration] ✓ Fixed V2 account ${account.email}: sdk=${V2_SDK_JS_VERSION}, ide=${V2_IDE_VERSION}`)
        }
      } else {
        console.log(`[Migration] ✓ Fixed ${v2Accounts.length} V2 accounts: sdk=${V2_SDK_JS_VERSION}, ide=${V2_IDE_VERSION}`)
      }
    }

    console.log(`[Migration] ✓ Version numbers fixed for ${fixedCount} accounts`)
    return { fixed: fixedCount }
  } catch (error) {
    console.error('[Migration] ✗ Failed to fix version numbers:', error.message)
    return { fixed: 0 }
  }
}

/**
 * 初始化Header版本控制字段数据
 * 为缺少这些字段值的现有账号生成唯一ID和hash
 */
async function initializeHeaderVersionData(conn) {
  try {
    // 检查是否需要初始化（字段是否存在）
    const existingColumns = await getExistingColumns(conn, 'accounts')
    if (!existingColumns.has('header_version')) {
      return { initialized: 0 } // 字段还未添加，跳过初始化
    }

    // 获取所有需要初始化的账号
    const [accounts] = await conn.query(`
      SELECT id, email
      FROM accounts
      WHERE (amz_invocation_id IS NULL OR amz_invocation_id = '')
         OR (kiro_device_hash IS NULL OR kiro_device_hash = '')
    `)
    
    if (accounts.length === 0) {
      return { initialized: 0 }
    }
    
    console.log(`[Migration] Initializing header version data for ${accounts.length} accounts...`)
    
    // 为每个账号生成唯一的ID和hash
    let successCount = 0
    for (const account of accounts) {
      const invocationId = generateInvocationId()
      const deviceHash = generateDeviceHash()
      
      try {
        // 使用COALESCE确保不覆盖已有值
        // V1版本使用V1的SDK和IDE版本（与 header-generator.js 保持一致）
        await conn.query(`
          UPDATE accounts
          SET amz_invocation_id = COALESCE(NULLIF(amz_invocation_id, ''), ?),
              kiro_device_hash = COALESCE(NULLIF(kiro_device_hash, ''), ?),
              sdk_js_version = COALESCE(NULLIF(sdk_js_version, ''), '1.0.0'),
              ide_version = COALESCE(NULLIF(ide_version, ''), '0.6.18')
          WHERE id = ?
        `, [invocationId, deviceHash, account.id])
        
        successCount++
        if (successCount <= 3) {
          console.log(`[Migration] ✓ Initialized ${account.email}: invocationId=${invocationId.substring(0, 8)}..., deviceHash=${deviceHash.substring(0, 16)}...`)
        }
      } catch (error) {
        console.error(`[Migration] ✗ Failed to initialize ${account.email}:`, error.message)
      }
    }
    
    if (successCount > 3) {
      console.log(`[Migration] ✓ ... and ${successCount - 3} more accounts`)
    }
    console.log(`[Migration] ✓ Header version data initialized for ${successCount} accounts`)
    
    return { initialized: successCount }
  } catch (error) {
    console.error('[Migration] ✗ Failed to initialize header version data:', error.message)
    return { initialized: 0 }
  }
}

/**
 * 执行数据库迁移
 */
export async function migrateDatabase(conn) {
  console.log('[Migration] Starting database migration...')

  const results = {
    totalAdded: 0,
    totalSkipped: 0,
    totalMigrated: 0,
    totalInitialized: 0,
    tables: {}
  }

  // 迁移所有表
  for (const [tableName, tableSchema] of Object.entries(TABLES)) {
    const result = await migrateTable(conn, tableName, tableSchema)
    results.tables[tableName] = result
    results.totalAdded += result.added
    results.totalSkipped += result.skipped
    results.totalMigrated += result.migrated || 0
  }

  // 在所有字段添加完成后，初始化Header版本控制数据
  const initResult = await initializeHeaderVersionData(conn)
  results.totalInitialized = initResult.initialized

  // 修正版本号（确保 sdk_js_version 和 ide_version 与 header_version 一致）
  const fixResult = await fixVersionNumbers(conn)
  results.totalFixed = fixResult.fixed

  if (results.totalAdded > 0) {
    console.log(`[Migration] ✓ Added ${results.totalAdded} new columns`)
  }
  
  if (results.totalMigrated > 0) {
    console.log(`[Migration] ✓ Migrated ${results.totalMigrated} columns to new types`)
  }

  if (results.totalInitialized > 0) {
    console.log(`[Migration] ✓ Initialized ${results.totalInitialized} accounts with header version data`)
  }

  if (results.totalFixed > 0) {
    console.log(`[Migration] ✓ Fixed ${results.totalFixed} accounts with incorrect version numbers`)
  }
  
  if (results.totalAdded === 0 && results.totalMigrated === 0 && results.totalInitialized === 0 && results.totalFixed === 0) {
    console.log('[Migration] ✓ All columns are up to date')
  }

  console.log('[Migration] Database migration completed')
  return results
}

/**
 * 验证数据库结构完整性
 */
export async function validateDatabase(conn) {
  console.log('[Validation] Checking database structure...')

  const issues = []

  for (const [tableName, tableSchema] of Object.entries(TABLES)) {
    // 检查表是否存在
    if (!(await tableExists(conn, tableName))) {
      issues.push({ type: 'missing_table', table: tableName })
      continue
    }

    // 检查字段
    const existingColumns = await getExistingColumns(conn, tableName)
    for (const col of tableSchema.columns) {
      if (col.definition.includes('PRIMARY KEY')) continue
      if (!existingColumns.has(col.name)) {
        issues.push({ type: 'missing_column', table: tableName, column: col.name })
      }
    }

    // 检查索引
    const existingIndexes = await getExistingIndexes(conn, tableName)
    for (const idx of tableSchema.indexes || []) {
      if (!existingIndexes.has(idx.name)) {
        issues.push({ type: 'missing_index', table: tableName, index: idx.name })
      }
    }
  }

  if (issues.length === 0) {
    console.log('[Validation] ✓ Database structure is valid')
  } else {
    console.log(`[Validation] Found ${issues.length} issues:`)
    for (const issue of issues) {
      if (issue.type === 'missing_table') {
        console.log(`  - Missing table: ${issue.table}`)
      } else if (issue.type === 'missing_column') {
        console.log(`  - Missing column: ${issue.table}.${issue.column}`)
      } else if (issue.type === 'missing_index') {
        console.log(`  - Missing index: ${issue.table}.${issue.index}`)
      }
    }
  }

  return issues
}

export default migrateDatabase
