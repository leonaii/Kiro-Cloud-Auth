/**
 * 数据库初始化
 * 创建表和索引
 */
import { ACCOUNTS_COLUMNS, ACCOUNTS_INDEXES } from './schema.js'

/**
 * 生成建表 SQL
 */
function generateCreateTableSQL(tableName, columns, indexes = []) {
  const columnDefs = columns.map((col) => {
    const name = col.isReserved ? `\`${col.name}\`` : col.name
    return `${name} ${col.definition}`
  })

  const indexDefs = indexes.map((idx) => `INDEX ${idx.name} (${idx.columns})`)

  const allDefs = [...columnDefs, ...indexDefs].join(',\n        ')

  return `
    CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        ${allDefs}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
}

/**
 * 初始化数据库表
 */
export async function initDatabase(conn) {
  console.log('[Database] Initializing tables...')

  // 创建 accounts 表
  await conn.query(generateCreateTableSQL('accounts', ACCOUNTS_COLUMNS, ACCOUNTS_INDEXES))
  console.log('[Database] ✓ accounts table ready')

  // 创建 groups 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`groups\` (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) NOT NULL,
      \`order\` INT DEFAULT 0,
      created_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ groups table ready')

  // 创建 tags 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tags (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) NOT NULL,
      created_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ tags table ready')

  // 创建 settings 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT,
      value_type VARCHAR(20) DEFAULT 'string'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ settings table ready')

  // 创建 machine_id_history 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS machine_id_history (
      id VARCHAR(255) PRIMARY KEY,
      machine_id VARCHAR(255) NOT NULL,
      timestamp BIGINT NOT NULL,
      action VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ machine_id_history table ready')

  // 创建 account_machine_ids 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS account_machine_ids (
      account_id VARCHAR(255) PRIMARY KEY,
      machine_id VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ account_machine_ids table ready')

  // 创建 api_request_logs 表（请求日志）
  await conn.query(`
    CREATE TABLE IF NOT EXISTS api_request_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      server_id VARCHAR(50),
      request_id VARCHAR(64) NOT NULL,
      account_id VARCHAR(255),
      account_email VARCHAR(255),
      model VARCHAR(100),
      is_stream BOOLEAN DEFAULT FALSE,
      status ENUM('success', 'error') NOT NULL,
      error_type VARCHAR(100),
      error_message TEXT,
      request_tokens INT DEFAULT 0,
      response_tokens INT DEFAULT 0,
      duration_ms INT DEFAULT 0,
      client_ip VARCHAR(45),
      user_agent VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_server_created (server_id, created_at),
      INDEX idx_status_created (status, created_at),
      INDEX idx_account_created (account_id, created_at),
      INDEX idx_request_id (request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ api_request_logs table ready')

  // 创建 system_logs 表（系统日志）
  await conn.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id VARCHAR(64) PRIMARY KEY,
      server_id VARCHAR(50),
      type VARCHAR(50) NOT NULL,
      level ENUM('info', 'warn', 'error', 'success') NOT NULL DEFAULT 'info',
      action VARCHAR(100) NOT NULL,
      message TEXT,
      details JSON,
      account_id VARCHAR(255),
      account_email VARCHAR(255),
      duration_ms INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_server_created (server_id, created_at),
      INDEX idx_type_created (type, created_at),
      INDEX idx_level_created (level, created_at),
      INDEX idx_type_level_created (type, level, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ system_logs table ready')

  // 创建 pool_round_robin 表（账号池轮询索引，用于分布式环境下的负载均衡）
  await conn.query(`
    CREATE TABLE IF NOT EXISTS pool_round_robin (
      group_id VARCHAR(255) PRIMARY KEY,
      current_index INT NOT NULL DEFAULT 0,
      account_count INT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('[Database] ✓ pool_round_robin table ready')

  console.log('[Database] All tables initialized')
}

export default initDatabase
