/**
 * 数据库表结构定义
 * 所有表的完整字段定义，用于初始化和迁移
 */

// accounts 表完整字段定义
export const ACCOUNTS_COLUMNS = [
  // 基本信息
  { name: 'id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'email', definition: 'VARCHAR(255) NOT NULL' },
  { name: 'user_id', definition: 'VARCHAR(255)' },
  { name: 'nickname', definition: 'VARCHAR(255)' },
  { name: 'idp', definition: 'VARCHAR(50)' },
  { name: 'status', definition: "VARCHAR(50) DEFAULT 'active'" },
  { name: 'group_id', definition: 'VARCHAR(255)' },
  { name: 'tags', definition: 'JSON' },
  { name: 'created_at', definition: 'BIGINT' },
  { name: 'last_used_at', definition: 'BIGINT' },
  { name: 'last_checked_at', definition: 'BIGINT' },
  { name: 'last_error', definition: 'TEXT' },

  // credentials 字段
  { name: 'cred_access_token', definition: 'TEXT' },
  { name: 'cred_csrf_token', definition: 'VARCHAR(255)' },
  { name: 'cred_refresh_token', definition: 'TEXT' },
  { name: 'cred_client_id', definition: 'VARCHAR(255)' },
  { name: 'cred_client_id_hash', definition: 'VARCHAR(64)' },  // OIDC 客户端 ID 哈希（用于本地 SSO 缓存查找）
  { name: 'cred_client_secret', definition: 'TEXT' },
  { name: 'cred_region', definition: 'VARCHAR(50)' },
  { name: 'cred_expires_at', definition: 'BIGINT' },
  { name: 'cred_auth_method', definition: 'VARCHAR(50)' },
  { name: 'cred_provider', definition: 'VARCHAR(50)' },

  // subscription 字段
  { name: 'sub_type', definition: 'VARCHAR(50)' },
  { name: 'sub_title', definition: 'VARCHAR(100)' },
  { name: 'sub_raw_type', definition: 'VARCHAR(100)' },
  { name: 'sub_days_remaining', definition: 'INT' },
  { name: 'sub_expires_at', definition: 'BIGINT' },
  { name: 'sub_management_target', definition: 'VARCHAR(50)' },
  { name: 'sub_upgrade_capability', definition: 'VARCHAR(50)' },
  { name: 'sub_overage_capability', definition: 'VARCHAR(50)' },

  // usage 字段
  { name: 'usage_current', definition: 'INT DEFAULT 0' },
  { name: 'usage_limit', definition: 'INT DEFAULT 0' },
  { name: 'usage_percent_used', definition: 'DECIMAL(10,8) DEFAULT 0' },
  { name: 'usage_last_updated', definition: 'BIGINT' },
  { name: 'usage_base_limit', definition: 'INT DEFAULT 0' },
  { name: 'usage_base_current', definition: 'INT DEFAULT 0' },
  { name: 'usage_free_trial_limit', definition: 'INT DEFAULT 0' },
  { name: 'usage_free_trial_current', definition: 'INT DEFAULT 0' },
  { name: 'usage_free_trial_expiry', definition: 'BIGINT' },  // Unix 时间戳（毫秒）
  { name: 'usage_bonuses', definition: 'JSON' },
  { name: 'usage_next_reset_date', definition: 'BIGINT' },  // Unix 时间戳（毫秒）

  // usage.resourceDetail 字段
  { name: 'res_resource_type', definition: 'VARCHAR(50)' },
  { name: 'res_display_name', definition: 'VARCHAR(50)' },
  { name: 'res_display_name_plural', definition: 'VARCHAR(50)' },
  { name: 'res_currency', definition: 'VARCHAR(10)' },
  { name: 'res_unit', definition: 'VARCHAR(50)' },
  { name: 'res_overage_rate', definition: 'DECIMAL(10,4)' },
  { name: 'res_overage_cap', definition: 'INT' },
  { name: 'res_overage_enabled', definition: 'BOOLEAN DEFAULT FALSE' },

  // API 调用统计字段
  { name: 'api_call_count', definition: 'INT DEFAULT 0' },
  { name: 'api_last_call_at', definition: 'BIGINT' },
  { name: 'api_total_tokens', definition: 'INT DEFAULT 0' },

  // 软删除字段
  { name: 'is_del', definition: 'BOOLEAN DEFAULT FALSE' },
  { name: 'deleted_at', definition: 'BIGINT' },

  // 版本控制字段
  { name: 'version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'updated_at', definition: 'BIGINT' },

  // Header版本控制字段（灰度发布功能）
  { name: 'header_version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'amz_invocation_id', definition: 'VARCHAR(36)' },
  { name: 'kiro_device_hash', definition: 'VARCHAR(64)' },
  { name: 'sdk_js_version', definition: 'VARCHAR(20)' },
  { name: 'ide_version', definition: 'VARCHAR(20)' }
]

// accounts 表索引
export const ACCOUNTS_INDEXES = [
  { name: 'idx_email', columns: 'email' },
  { name: 'idx_status', columns: 'status' },
  { name: 'idx_group_id', columns: 'group_id' },
  { name: 'idx_is_del', columns: 'is_del' }
]

// groups 表字段定义
export const GROUPS_COLUMNS = [
  { name: 'id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'name', definition: 'VARCHAR(100) NOT NULL' },
  { name: 'color', definition: 'VARCHAR(20) NOT NULL' },
  { name: 'description', definition: 'VARCHAR(500)' },
  { name: 'api_key', definition: 'VARCHAR(255)' },  // 分组专属 API Key，用于 OpenAI 兼容 API 认证
  { name: 'order', definition: 'INT DEFAULT 0', isReserved: true },
  { name: 'created_at', definition: 'BIGINT' },

  // 版本控制字段
  { name: 'version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'updated_at', definition: 'BIGINT' }
]

// tags 表字段定义
export const TAGS_COLUMNS = [
  { name: 'id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'name', definition: 'VARCHAR(100) NOT NULL' },
  { name: 'color', definition: 'VARCHAR(20) NOT NULL' },
  { name: 'created_at', definition: 'BIGINT' },

  // 版本控制字段
  { name: 'version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'updated_at', definition: 'BIGINT' }
]

// settings 表字段定义
export const SETTINGS_COLUMNS = [
  { name: 'key', definition: 'VARCHAR(100) PRIMARY KEY', isReserved: true },
  { name: 'value', definition: 'TEXT' },
  { name: 'value_type', definition: "VARCHAR(20) DEFAULT 'string'" },

  // 版本控制字段
  { name: 'version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'updated_at', definition: 'BIGINT' }
]

// machine_id_history 表字段定义
export const MACHINE_ID_HISTORY_COLUMNS = [
  { name: 'id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'machine_id', definition: 'VARCHAR(255) NOT NULL' },
  { name: 'timestamp', definition: 'BIGINT NOT NULL' },
  { name: 'action', definition: 'VARCHAR(50) NOT NULL' }
]

// account_machine_ids 表字段定义
export const ACCOUNT_MACHINE_IDS_COLUMNS = [
  { name: 'account_id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'machine_id', definition: 'VARCHAR(255) NOT NULL' },

  // 版本控制字段
  { name: 'version', definition: 'INT NOT NULL DEFAULT 1' },
  { name: 'updated_at', definition: 'BIGINT' }
]

// api_request_logs 表字段定义
export const API_REQUEST_LOGS_COLUMNS = [
  { name: 'id', definition: 'BIGINT AUTO_INCREMENT PRIMARY KEY' },
  { name: 'server_id', definition: 'VARCHAR(50)' },
  { name: 'request_id', definition: 'VARCHAR(64) NOT NULL' },
  { name: 'account_id', definition: 'VARCHAR(255)' },
  { name: 'account_email', definition: 'VARCHAR(255)' },
  { name: 'account_idp', definition: 'VARCHAR(50)' },
  { name: 'model', definition: 'VARCHAR(100)' },
  { name: 'is_stream', definition: 'BOOLEAN DEFAULT FALSE' },
  { name: 'status', definition: "ENUM('success', 'error') NOT NULL" },
  { name: 'error_type', definition: 'VARCHAR(100)' },
  { name: 'error_message', definition: 'TEXT' },
  { name: 'request_tokens', definition: 'INT DEFAULT 0' },
  { name: 'response_tokens', definition: 'INT DEFAULT 0' },
  { name: 'duration_ms', definition: 'INT DEFAULT 0' },
  { name: 'client_ip', definition: 'VARCHAR(45)' },
  { name: 'user_agent', definition: 'VARCHAR(500)' },
  { name: 'is_thinking', definition: 'BOOLEAN DEFAULT FALSE' },
  { name: 'thinking_budget', definition: 'INT DEFAULT 0' },
  { name: 'header_version', definition: 'INT DEFAULT 1' },
  { name: 'request_headers', definition: 'TEXT' },
  { name: 'api_protocol', definition: "VARCHAR(20) DEFAULT 'openai'" },  // API 协议类型：openai 或 claude
  { name: 'created_at', definition: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
]

export const API_REQUEST_LOGS_INDEXES = [
  { name: 'idx_created_at', columns: 'created_at' },
  { name: 'idx_server_created', columns: 'server_id, created_at' },
  { name: 'idx_status_created', columns: 'status, created_at' },
  { name: 'idx_account_created', columns: 'account_id, created_at' },
  { name: 'idx_request_id', columns: 'request_id' }
]

// system_logs 表字段定义
export const SYSTEM_LOGS_COLUMNS = [
  { name: 'id', definition: 'VARCHAR(64) PRIMARY KEY' },
  { name: 'server_id', definition: 'VARCHAR(50)' },
  { name: 'type', definition: 'VARCHAR(50) NOT NULL' },
  { name: 'level', definition: "ENUM('info', 'warn', 'error', 'success') NOT NULL DEFAULT 'info'" },
  { name: 'action', definition: 'VARCHAR(100) NOT NULL' },
  { name: 'message', definition: 'TEXT' },
  { name: 'details', definition: 'JSON' },
  { name: 'account_id', definition: 'VARCHAR(255)' },
  { name: 'account_email', definition: 'VARCHAR(255)' },
  { name: 'account_idp', definition: 'VARCHAR(50)' },
  { name: 'duration_ms', definition: 'INT' },
  { name: 'request_headers', definition: 'TEXT' },
  { name: 'created_at', definition: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
]

export const SYSTEM_LOGS_INDEXES = [
  { name: 'idx_created_at', columns: 'created_at' },
  { name: 'idx_server_created', columns: 'server_id, created_at' },
  { name: 'idx_type_created', columns: 'type, created_at' },
  { name: 'idx_level_created', columns: 'level, created_at' },
  { name: 'idx_type_level_created', columns: 'type, level, created_at' }
]

// sessions 表字段定义（登录会话持久化）
export const SESSIONS_COLUMNS = [
  { name: 'token', definition: 'VARCHAR(64) PRIMARY KEY' },
  { name: 'created_at', definition: 'BIGINT NOT NULL' },
  { name: 'expires_at', definition: 'BIGINT NOT NULL' }
]

export const SESSIONS_INDEXES = [
  { name: 'idx_expires_at', columns: 'expires_at' }
]

// pool_round_robin 表字段定义（账号池轮询索引，用于分布式环境下的负载均衡）
export const POOL_ROUND_ROBIN_COLUMNS = [
  { name: 'group_id', definition: 'VARCHAR(255) PRIMARY KEY' },
  { name: 'current_index', definition: 'INT NOT NULL DEFAULT 0' },
  { name: 'account_count', definition: 'INT NOT NULL DEFAULT 0' },  // 记录账号数量，用于检测变化
  { name: 'updated_at', definition: 'BIGINT NOT NULL' }
]

// 所有表定义
export const TABLES = {
  accounts: {
    columns: ACCOUNTS_COLUMNS,
    indexes: ACCOUNTS_INDEXES
  },
  groups: {
    columns: GROUPS_COLUMNS,
    indexes: []
  },
  tags: {
    columns: TAGS_COLUMNS,
    indexes: []
  },
  settings: {
    columns: SETTINGS_COLUMNS,
    indexes: []
  },
  machine_id_history: {
    columns: MACHINE_ID_HISTORY_COLUMNS,
    indexes: []
  },
  account_machine_ids: {
    columns: ACCOUNT_MACHINE_IDS_COLUMNS,
    indexes: []
  },
  api_request_logs: {
    columns: API_REQUEST_LOGS_COLUMNS,
    indexes: API_REQUEST_LOGS_INDEXES
  },
  system_logs: {
    columns: SYSTEM_LOGS_COLUMNS,
    indexes: SYSTEM_LOGS_INDEXES
  },
  sessions: {
    columns: SESSIONS_COLUMNS,
    indexes: SESSIONS_INDEXES
  },
  pool_round_robin: {
    columns: POOL_ROUND_ROBIN_COLUMNS,
    indexes: []
  }
}

export default TABLES
