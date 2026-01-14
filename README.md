# Kiro-Cloud-Auth

多账号管理工具，支持 Electron 桌面客户端和 Web 版本，提供 OpenAI 兼容 API 接口。

## 功能特性

- 🔐 多账号管理：添加、编辑、删除、分组、标签
- 🔄 Token 自动刷新：支持 Social (GitHub/Google) 和 IdC (BuilderId) 认证
- 📊 使用量监控：实时显示账号使用量和订阅状态
- 🤖 OpenAI 兼容 API：支持 `/v1/chat/completions` 接口
- 🔀 负载均衡：自动选择低负载账号处理请求
- 📱 多端支持：Electron 桌面端 + Web 端
- 🌐 多服务器部署：共享 MySQL 数据库，支持横向扩展

## 项目结构

```
├── src/                    # 前端源码 (Electron + Web)
│   ├── main/              # Electron 主进程
│   ├── preload/           # Electron 预加载脚本
│   └── renderer/          # 渲染进程 (React)
│       └── src/
│           ├── components/    # UI 组件
│           │   ├── accounts/  # 账号管理组件
│           │   ├── layout/    # 布局组件
│           │   ├── pages/     # 页面组件
│           │   └── ui/        # 基础 UI 组件
│           ├── lib/           # 工具库
│           ├── services/      # API 服务
│           ├── store/         # 状态管理 (Zustand)
│           └── types/         # TypeScript 类型
│
├── server/                 # 后端服务
│   ├── config/            # 配置模块
│   ├── db/                # 数据库模块
│   │   ├── schema.js      # 表结构定义
│   │   ├── init.js        # 数据库初始化
│   │   └── migrate.js     # 数据库迁移
│   ├── models/            # 数据模型
│   ├── routes/            # API 路由
│   ├── openai-compat/     # OpenAI 兼容 API
│   └── token-refresher.js # Token 刷新服务
│
└── resources/             # 静态资源
```

## 快速开始

### 环境要求

- Node.js 18+
- MySQL 8.0+
- pnpm (推荐) 或 npm

### 开发模式

```bash
# 安装依赖
pnpm install

# 启动 Electron 开发模式
pnpm dev

# 启动 Web 开发模式
pnpm dev:web

# 启动后端服务
cd server && npm install && node index.js
```

### 生产部署

#### Docker 部署 (推荐)

```bash
# 配置环境变量
cp .env.example .env
nano .env

# 启动服务
docker-compose up -d
```

#### 手动部署

```bash
# 构建 Web 前端
pnpm build:web

# 启动后端服务
cd server && node index.js
```

## 环境变量

```env
# 数据库配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=kiro
DB_PASSWORD=your_password
DB_NAME=kiro

# 服务配置
PORT=3000
SERVER_ID=server-1
EXTERNAL_PORT=25000
```

## API 接口

### OpenAI 兼容 API

```bash
# 聊天补全
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}

# 列出模型
GET /v1/models

# 账号池状态
GET /v1/pool/status
```

### 支持的模型

| 模型 | 别名 |
|------|------|
| claude-sonnet-4-5 | gpt-4-turbo, gpt-4o |
| claude-opus-4-5 | - |
| claude-haiku-4-5 | - |
| claude-sonnet-4-20250514 | gpt-4 |
| claude-3-7-sonnet-20250219 | gpt-3.5-turbo |

### 管理 API

```bash
# 健康检查
GET /api/health

# 账号管理
GET /api/accounts
POST /api/accounts/:id
DELETE /api/accounts/:id

# 完整数据
GET /api/data
POST /api/data
```

## 多服务器部署

系统支持多服务器横向扩展，所有服务器共享同一个 MySQL 数据库：

```
Server 1 (区域 A)  ──┐
Server 2 (区域 B)  ──┼──> Shared MySQL
Server 3 (区域 C)  ──┘
```

每台服务器设置不同的 `SERVER_ID` 用于日志区分。

## 数据库迁移

系统启动时自动检查并添加缺失的数据库字段，保留现有数据：

```
[Migration] Starting database migration...
[Migration] ✓ Added column: accounts.api_call_count
[Migration] Database migration completed
[Validation] ✓ Database structure is valid
```

## 使用示例

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:25000/v1",
    api_key="dummy"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### JavaScript

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:25000/v1',
  apiKey: 'dummy'
});

const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(response.choices[0].message.content);
```

### cURL

```bash
curl -X POST http://localhost:25000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hello"}]}'
```

## 构建打包

### 使用构建脚本

```bash
# Windows PowerShell
.\build.ps1 all              # 构建全部
.\build.ps1 electron         # 构建 Electron (portable + nsis)
.\build.ps1 electron-portable # 仅构建便携版 exe
.\build.ps1 web              # 构建 Web 版本
.\build.ps1 docker           # 构建 Docker 镜像
.\build.ps1 clean            # 清理构建目录

# Linux/Mac
./build.sh all               # 构建全部
./build.sh linux             # 构建 Linux AppImage
./build.sh mac               # 构建 Mac DMG
./build.sh docker            # 构建 Docker 镜像
```

### 使用 npm 命令

```bash
# Windows
pnpm build:win:portable      # 便携版 exe -> dist/electron/
pnpm build:win:nsis          # 安装包 -> dist/electron/

# Linux
pnpm build:linux:appimage    # AppImage -> dist/linux/
pnpm build:linux:deb         # DEB 包 -> dist/linux/

# Mac
pnpm build:mac               # DMG -> dist/mac/

# Web + Docker
pnpm build:web               # Web 版本 -> dist/web/
pnpm build:docker            # Docker 镜像

# 清理
pnpm clean                   # 清理所有构建目录
```

### 输出目录结构

```
dist/
├── electron/               # Windows 构建产物
│   ├── Kiro-Cloud-Auth-x.x.x-portable.exe
│   └── Kiro-Cloud-Auth-x.x.x-x64-setup.exe
├── linux/                  # Linux 构建产物
│   ├── Kiro-Cloud-Auth-x.x.x-x64.AppImage
│   └── Kiro-Cloud-Auth-x.x.x-amd64.deb
├── mac/                    # Mac 构建产物
│   └── Kiro-Cloud-Auth-x.x.x-x64.dmg
├── webui/                  # Web 版本
│   ├── index.html
│   └── assets/
└── docker/                 # Docker 镜像
    └── Kiro-Cloud-Auth-x.x.x.tar
```

## License

MIT
