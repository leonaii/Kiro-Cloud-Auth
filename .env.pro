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
DEFAULT_API_KEY=sk-123456
# Web 后台登录密码（留空则不启用登录验证）
WEB_LOGIN_PASSWORD=admin123
# Electron 客户端认证密钥（用于 HMAC 签名验证）
ELECTRON_AUTH_SECRET=kiro-electron-secret-2024-leon

DISABLE_TOKEN_REFRESH=false
AUTO_BIND_MACHINE_ID=true
AUTO_REFRESH_USAGE_AFTER_TOKEN=true
DEFAULT_HEADER_VERSION=2
