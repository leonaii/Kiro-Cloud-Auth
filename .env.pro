# Kiro-Cloud-Auth  - 生产环境配置

# 数据库配置（host 网络模式下可以直接用 127.0.0.1）
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=open_ai
DB_PASSWORD=D97sRGSFXxYo5N
DB_NAME=open_kiro_db

# Redis 配置
REDIS_HOST=127.0.0.1
REDIS_PORT=25010

# 服务配置
SERVER_ID=pro

DB_POOL_SIZE=200
CLUSTER_WORKERS=1

# OpenAI 兼容 API 默认授权密钥
DEFAULT_API_KEY=Alf123456
# Web 后台登录密码（留空则不启用登录验证）
WEB_LOGIN_PASSWORD=Alf123456
# Electron 客户端认证密钥（用于 HMAC 签名验证）
ELECTRON_AUTH_SECRET=kiro-electron-secret-2024-leon

DISABLE_TOKEN_REFRESH=false
AUTO_BIND_MACHINE_ID=true
AUTO_REFRESH_USAGE_AFTER_TOKEN=true
DEFAULT_HEADER_VERSION=2

# ============ 活跃池/冷却池配置 ============

# 是否启用活跃池机制（默认 true）
# 启用后，系统会维护一个固定大小的活跃账号池，只从活跃池中选择账号处理请求
# 禁用后，使用传统的全局轮询方式
ACTIVE_POOL_ENABLED=true

# 活跃池上限（默认 5）
# 活跃池中最多保持的账号数量，建议根据并发量设置
ACTIVE_POOL_LIMIT=5

# 异常累计阈值（默认 5）
# 当活跃池中的账号累计错误次数达到此阈值时，会被移入冷却池
ACTIVE_POOL_ERROR_THRESHOLD=3

# 冷却时间（毫秒，默认 3600000 = 60 分钟）
# 账号在冷却池中需要等待的时间，超过后会检查是否可以恢复到活跃池
ACTIVE_POOL_COOLING_PERIOD_MS=3600000

# Token 刷新是否只针对活跃池账号（默认 true）
# 设为 true 时，只刷新活跃池中账号的 Token
# 设为 false 时，刷新所有即将过期的账号 Token
TOKEN_REFRESH_ACTIVE_POOL_ONLY=true
