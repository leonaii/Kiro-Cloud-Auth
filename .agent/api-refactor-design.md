# Kiro-Cloud-Auth  API 重构设计文档

## 文档版本
- **版本**: v1.0
- **创建日期**: 2025-12-22
- **作者**: Kilo Code (Architect Mode)

---

## 1. 执行摘要

### 1.1 当前问题
1. **数据覆盖风险**: 单一的 `POST /api/data` 接口使用 `syncDelete` 参数，导致前端不完整数据会删除服务器上的其他数据
2. **并发冲突**: 多客户端同时写入会相互覆盖，缺乏冲突检测机制
3. **粒度过粗**: 一个接口处理所有数据类型（accounts, groups, tags, settings, machineIds），难以优化和维护
4. **缺乏版本控制**: 无法检测数据是否被其他客户端修改
5. **性能问题**: 每次都传输完整数据集，无法增量更新

### 1.2 设计目标
- ✅ 按资源类型拆分 API 端点（RESTful 微服务模式）
- ✅ 移除危险的 `syncDelete` 参数，使用明确的删除接口
- ✅ 添加乐观锁机制（版本号 + 时间戳）防止并发冲突
- ✅ 支持批量操作提高效率
- ✅ 支持增量查询和字段过滤
- ✅ 保持向后兼容，平滑迁移

---

## 2. 新 API 端点清单

### 2.1 账号资源 (Accounts)

#### 2.1.1 查询接口

```http
GET /api/v2/accounts
查询参数:
  - page: 页码（默认 1）
  - pageSize: 每页数量（默认 50，最大 200）
  - fields: 字段过滤（逗号分隔，如 "id,email,usage"）
  - includeDeleted: 是否包含已删除账号（默认 false）
  - modifiedSince: 增量查询时间戳（毫秒）
  - groupId: 按分组过滤
  - status: 按状态过滤（active/banned/expired）
  - sortBy: 排序字段（createdAt/lastUsedAt/email）
  - sortOrder: 排序方向（asc/desc，默认 desc）

响应格式:
{
  "success": true,
  "data": {
    "accounts": [
      {
        "id": "account-uuid",
        "email": "user@example.com",
        "version": 5,
        "updatedAt": 1703232000000,
        // ... 其他字段
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 50,
      "total": 150,
      "totalPages": 3,
      "hasNext": true
    },
    "serverTime": 1703232000000
  }
}
```

```http
GET /api/v2/accounts/:id
获取单个账号详情

响应格式:
{
  "success": true,
  "data": {
    "id": "account-uuid",
    "email": "user@example.com",
    "version": 5,
    "updatedAt": 1703232000000,
    // ... 完整账号信息
  }
}
```

#### 2.1.2 创建/更新接口

```http
POST /api/v2/accounts
创建新账号

请求体:
{
  "id": "account-uuid",
  "email": "user@example.com",
  "credentials": { ... },
  // ... 其他字段
}

响应格式:
{
  "success": true,
  "data": {
    "id": "account-uuid",
    "version": 1,
    "updatedAt": 1703232000000,
    "created": true
  }
}
```

```http
PUT /api/v2/accounts/:id
更新账号（需要版本号）

请求体:
{
  "version": 5,
  "email": "newemail@example.com",
  "usage": { ... },
  // ... 要更新的字段
}

响应格式:
{
  "success": true,
  "data": {
    "id": "account-uuid",
    "version": 6,
    "updatedAt": 1703232100000
  }
}

错误响应（版本冲突）:
{
  "success": false,
  "error": "VERSION_CONFLICT",
  "message": "账号已被其他客户端修改",
  "currentVersion": 7,
  "serverData": { ... }
}
```

```http
PATCH /api/v2/accounts/:id
部分更新账号（需要版本号）

请求体:
{
  "version": 5,
  "fields": {
    "status": "active",
    "lastCheckedAt": 1703232000000
  }
}
```

#### 2.1.3 删除接口

```http
DELETE /api/v2/accounts/:id
软删除账号

请求体:
{
  "version": 5
}

响应格式:
{
  "success": true,
  "data": {
    "id": "account-uuid",
    "deleted": true,
    "deletedAt": 1703232000000
  }
}
```

```http
DELETE /api/v2/accounts/:id/permanent
永久删除账号

请求体:
{
  "version": 5,
  "confirm": true
}
```

```http
POST /api/v2/accounts/:id/restore
恢复已删除账号
```

#### 2.1.4 批量操作接口

```http
POST /api/v2/accounts/batch
批量创建/更新账号

请求体:
{
  "operations": [
    {
      "action": "create",
      "data": {
        "id": "account-uuid-1",
        "email": "user1@example.com"
      }
    },
    {
      "action": "update",
      "data": {
        "id": "account-uuid-2",
        "version": 3,
        "email": "user2@example.com"
      }
    }
  ],
  "stopOnError": false
}

响应格式:
{
  "success": true,
  "data": {
    "results": [
      {
        "id": "account-uuid-1",
        "success": true,
        "version": 1
      },
      {
        "id": "account-uuid-2",
        "success": false,
        "error": "VERSION_CONFLICT",
        "currentVersion": 5
      }
    ],
    "summary": {
      "total": 2,
      "succeeded": 1,
      "failed": 1
    }
  }
}
```

```http
POST /api/v2/accounts/batch-delete
批量软删除账号

请求体:
{
  "ids": ["account-uuid-1", "account-uuid-2"],
  "versions": {
    "account-uuid-1": 5,
    "account-uuid-2": 3
  }
}
```

#### 2.1.5 特殊操作接口

```http
POST /api/v2/accounts/:id/refresh-token
刷新账号 Token

POST /api/v2/accounts/:id/check-status
检查账号状态（调用 Kiro API）
```

---

### 2.2 分组资源 (Groups)

```http
GET /api/v2/groups
查询参数:
  - modifiedSince: 增量查询时间戳

POST /api/v2/groups
创建分组

PUT /api/v2/groups/:id
更新分组

DELETE /api/v2/groups/:id
删除分组

POST /api/v2/groups/batch-reorder
批量调整分组顺序
```

---

### 2.3 标签资源 (Tags)

```http
GET /api/v2/tags
查询参数:
  - modifiedSince: 增量查询时间戳

POST /api/v2/tags
创建标签

PUT /api/v2/tags/:id
更新标签

DELETE /api/v2/tags/:id
删除标签
```

---

### 2.4 设置资源 (Settings)

```http
GET /api/v2/settings
获取所有设置

GET /api/v2/settings/:key
获取单个设置

PUT /api/v2/settings/:key
更新单个设置

POST /api/v2/settings/batch
批量更新设置
```

---

### 2.5 机器码资源 (Machine IDs)

```http
GET /api/v2/machine-ids/config
获取机器码配置

PUT /api/v2/machine-ids/config
更新机器码配置

GET /api/v2/machine-ids/bindings
获取所有账号机器码绑定

PUT /api/v2/machine-ids/bindings/:accountId
绑定/更新账号机器码

DELETE /api/v2/machine-ids/bindings/:accountId
解绑账号机器码

GET /api/v2/machine-ids/history
获取机器码历史记录

POST /api/v2/machine-ids/history
添加机器码历史记录
```

---

### 2.6 同步接口（兼容旧版）

```http
GET /api/v2/sync/snapshot
获取完整数据快照（用于初始化）

响应格式:
{
  "success": true,
  "data": {
    "accounts": [ ... ],
    "groups": [ ... ],
    "tags": [ ... ],
    "settings": { ... },
    "machineIdBindings": [ ... ],
    "machineIdHistory": [ ... ],
    "serverTime": 1703232000000,
    "snapshotVersion": "v2.0"
  }
}
```

```http
POST /api/v2/sync/changes
获取增量变更（用于后台同步）

请求体:
{
  "lastSyncTime": 1703230000000,
  "resources": ["accounts", "groups", "tags", "settings"]
}

响应格式:
{
  "success": true,
  "data": {
    "changes": {
      "accounts": {
        "created": [ ... ],
        "updated": [ ... ],
        "deleted": ["account-uuid-1"]
      },
      "groups": {
        "created": [ ... ],
        "updated": [ ... ],
        "deleted": []
      }
    },
    "serverTime": 1703232000000,
    "hasMore": false
  }
}
```

```http
POST /api/v2/sync/push
推送本地变更到服务器

请求体:
{
  "changes": {
    "accounts": {
      "created": [ ... ],
      "updated": [ ... ],
      "deleted": ["account-uuid-1"]
    }
  },
  "clientTime": 1703232000000
}

响应格式:
{
  "success": true,
  "data": {
    "results": {
      "accounts": {
        "succeeded": ["account-uuid-1"],
        "failed": [
          {
            "id": "account-uuid-2",
            "error": "VERSION_CONFLICT",
            "serverData": { ... }
          }
        ]
      }
    },
    "conflicts": [ ... ],
    "serverTime": 1703232100000
  }
}
```

---

### 2.7 导入/导出接口

```http
POST /api/v2/import
导入数据

请求体:
{
  "mode": "merge",
  "data": {
    "accounts": [ ... ],
    "groups": [ ... ],
    "tags": [ ... ],
    "settings": { ... }
  },
  "options": {
    "skipConflicts": false,
    "updateExisting": true
  }
}

响应格式:
{
  "success": true,
  "data": {
    "summary": {
      "accounts": { "created": 10, "updated": 5, "skipped": 2 },
      "groups": { "created": 3, "updated": 1, "skipped": 0 }
    },
    "conflicts": [ ... ],
    "errors": [ ... ]
  }
}
```

```http
GET /api/v2/export
导出数据

查询参数:
  - format: 导出格式（json/csv）
  - resources: 要导出的资源类型（逗号分隔）
  - includeDeleted: 是否包含已删除数据
```

---

## 3. 数据模型定义

### 3.1 版本控制字段

所有资源都包含以下版本控制字段：

```typescript
interface VersionedResource {
  version: number;        // 版本号（每次更新递增）
  updatedAt: number;      // 最后更新时间戳（毫秒）
  createdAt?: number;     // 创建时间戳（毫秒）
  deletedAt?: number;     // 删除时间戳（毫秒，软删除）
}
```

### 3.2 账号模型 (Account)

```typescript
interface Account extends VersionedResource {
  id: string;
  email: string;
  userId?: string;
  nickname?: string;
  idp?: string;
  status: 'active' | 'banned' | 'expired' | 'error';
  groupId?: string;
  tags: string[];

  credentials: {
    accessToken?: string;
    csrfToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    region?: string;
    expiresAt?: number;
    authMethod?: 'oidc' | 'social' | 'IdC';
    provider?: string;
  };

  subscription: {
    type: 'Free' | 'Pro' | 'Enterprise' | 'Teams';
    title?: string;
    rawType?: string;
    daysRemaining?: number;
    expiresAt?: number;
    managementTarget?: string;
    upgradeCapability?: string;
    overageCapability?: string;
  };

  usage: {
    current: number;
    limit: number;
    percentUsed: number;
    lastUpdated?: number;
    baseLimit: number;
    baseCurrent: number;
    freeTrialLimit: number;
    freeTrialCurrent: number;
    freeTrialExpiry?: number;
    bonuses: Bonus[];
    nextResetDate?: number;
    resourceDetail?: ResourceDetail;
  };

  lastUsedAt?: number;
  lastCheckedAt?: number;
  lastError?: string;
  isDel: boolean;
}
```

### 3.3 分组模型 (Group)

```typescript
interface Group extends VersionedResource {
  id: string;
  name: string;
  color: string;
  order: number;
}
```

### 3.4 标签模型 (Tag)

```typescript
interface Tag extends VersionedResource {
  id: string;
  name: string;
  color: string;
}
```

### 3.5 设置模型 (Setting)

```typescript
interface Setting extends VersionedResource {
  key: string;
  value: any;
  valueType: 'string' | 'number' | 'boolean' | 'json';
}
```

### 3.6 机器码绑定模型 (MachineIdBinding)

```typescript
interface MachineIdBinding extends VersionedResource {
  accountId: string;
  machineId: string;
}
```

---

## 4. 迁移策略

### 4.1 向后兼容方案

#### 阶段 1: 双接口并存（1-2 个月）

1. **保留旧接口**
   - `GET /api/data` - 标记为 `@deprecated`
   - `POST /api/data` - 标记为 `@deprecated`
   - 在响应头添加: `X-Deprecated: true`
   - 在响应中添加警告: `"warning": "此接口将在 v3.0 版本移除"`

2. **新接口上线**
   - 所有 `/api/v2/*` 接口同时上线
   - 客户端可以选择使用新接口或旧接口

3. **数据库迁移**
   ```sql
   -- 添加版本控制字段
   ALTER TABLE accounts ADD COLUMN version INT DEFAULT 1;
   ALTER TABLE accounts ADD COLUMN updated_at BIGINT;
   ALTER TABLE groups ADD COLUMN version INT DEFAULT 1;
   ALTER TABLE groups ADD COLUMN updated_at BIGINT;
   ALTER TABLE tags ADD COLUMN version INT DEFAULT 1;
   ALTER TABLE tags ADD COLUMN updated_at BIGINT;
   ALTER TABLE settings ADD COLUMN version INT DEFAULT 1;
   ALTER TABLE settings ADD COLUMN updated_at BIGINT;
   ALTER TABLE account_machine_ids ADD COLUMN version INT DEFAULT 1;
   ALTER TABLE account_machine_ids ADD COLUMN updated_at BIGINT;

   -- 初始化现有数据
   UPDATE accounts SET version = 1, updated_at = created_at WHERE version IS NULL;
   UPDATE groups SET version = 1, updated_at = created_at WHERE version IS NULL;
   UPDATE tags SET version = 1, updated_at = created_at WHERE version IS NULL;
   ```

#### 阶段 2: 客户端迁移（2-3 个月）

1. **前端适配器层**
   ```typescript
   class ApiAdapter {
     async getData(): Promise<AccountData> {
       try {
         const snapshot = await api.v2.sync.snapshot();
         return this.transformToOldFormat(snapshot);
       } catch (error) {
         return api.v1.getData();
       }
     }

     async saveData(data: AccountData): Promise<void> {
       const changes = this.detectChanges(data);
       await api.v2.sync.push(changes);
     }
   }
   ```

2. **渐进式迁移**
   - 新功能只使用新接口
   - 旧功能逐步迁移到新接口
   - 使用特性开关控制迁移进度

#### 阶段 3: 移除旧接口（3-6 个月后）

1. **监控旧接口使用情况**
   - 记录旧接口调用次数
   - 识别仍在使用旧接口的客户端
   - 通知用户升级

2. **最终移除**
   - 旧接口返回 410 Gone 状态码
   - 提供迁移指南链接

### 4.2 冲突解决策略

当检测到版本冲突时，客户端可以采用以下策略：

1. **服务器优先** (Server Wins)
   - 丢弃本地修改，使用服务器数据
   - 适用于非关键数据

2. **客户端优先** (Client Wins)
   - 强制覆盖服务器数据（需要特殊权限）
   - 适用于管理员操作

3. **手动合并** (Manual Merge)
   - 提示用户选择保留哪个版本
   - 或者合并两个版本的数据

4. **最后写入优先** (Last Write Wins)
   - 比较 `updatedAt` 时间戳
   - 保留最新的修改

---

## 5. 实现优先级

### 5.1 第一阶段（核心功能）- 优先级 P0

**目标**: 解决数据覆盖问题，支持基本的增量同步

1. **数据库迁移**
   - 添加版本控制字段
   - 创建迁移脚本

2. **核心同步接口**
   - `GET /api/v2/sync/snapshot` - 获取完整快照
   - `POST /api/v2/sync/changes` - 获取增量变更
   - `POST /api/v2/sync/push` - 推送本地变更

3. **账号基础接口**
   - `GET /api/v2/accounts` - 查询账号（支持增量）
   - `POST /api/v2/accounts` - 创建账号
   - `PUT /api/v2/accounts/:id` - 更新账号（带版本控制）
   - `DELETE /api/v2/accounts/:id` - 软删除账号

4. **前端适配器**
   - 创建 API 适配器层
   - 支持新旧接口切换

**预计时间**: 2-3 周

### 5.2 第二阶段（批量操作）- 优先级 P1

**目标**: 提高批量操作效率

1. **批量接口**
   - `POST /api/v2/accounts/batch` - 批量创建/更新
   - `POST /api/v2/accounts/batch-delete` - 批量删除

2. **分组和标签接口**
   - `GET /api/v2/groups` - 查询分组
   - `POST /api/v2/groups` - 创建分组
   - `PUT /api/v2/groups/:id` - 更新分组
   - `DELETE /api/v2/groups/:id` - 删除分组
   - 标签接口同理

3. **设置接口**
   - `GET /api/v2/settings` - 获取所有设置
   - `PUT /api/v2/settings/:key` - 更新单个设置
   - `POST /api/v2/settings/batch` - 批量更新设置

**预计时间**: 1-2 周

### 5.3 第三阶段（高级功能）- 优先级 P2

**目标**: 性能优化和高级功能

1. **分页和过滤**
   - 账号列表分页
   - 字段过滤
   - 高级查询

2. **机器码接口**
   - `GET /api/v2/machine-ids/config`
   - `PUT /api/v2/machine-ids/config`
   - `GET /api/v2/machine-ids/bindings`
   - `PUT /api/v2/machine-ids/bindings/:accountId`

3. **导入/导出接口**
   - `POST /api/v2/import`
   - `GET /api/v2/export`

**预计时间**: 1-2 周

### 5.4 第四阶段（清理和优化）- 优先级 P3

**目标**: 移除旧接口，优化性能

1. **性能优化**
   - 添加缓存层
   - 优化数据库查询
   - 添加索引

2. **监控和日志**
   - API 调用统计
   - 性能监控
   - 错误追踪

3. **移除旧接口**
   - 标记旧接口为 deprecated
   - 监控使用情况
   - 最终移除

**预计时间**: 1-2 周

---

## 6. 安全和性能考虑

### 6.1 并发控制机制

#### 乐观锁实现

```typescript
// 服务器端实现
async function updateAccount(id: string, data: Partial<Account>, version: number) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 检查版本号
    const [rows] = await conn.query(
      'SELECT version, updated_at FROM accounts WHERE id = ? FOR UPDATE',
      [id]
    );

    if (rows.length === 0) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    const currentVersion = rows[0].version;
    if (currentVersion !== version) {
      // 版本冲突
      throw {
        code: 'VERSION_CONFLICT',
        currentVersion,
        message: '账号已被其他客户端修改'
      };
    }

    // 更新数据
    const newVersion = currentVersion + 1;
    const updatedAt = Date.now();

    await conn.query(
      'UPDATE accounts SET ..., version = ?, updated_at = ? WHERE id = ?',
      [...values, newVersion, updatedAt, id]
    );

    await conn.commit();
    return { version: newVersion, updatedAt };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
```

#### 客户端冲突处理

```typescript
// 客户端实现
async function saveAccountWithRetry(account: Account, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await api.v2.accounts.update(account.id, {
        version: account.version,
        ...account
      });
      return result;
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') {
        // 获取服务器最新数据
        const serverData = await api.v2.accounts.get(account.id);

        // 尝试自动合并
        const merged = mergeAccounts(account, serverData);
        account = merged;

        // 如果无法自动合并，提示用户
        if (!merged.autoMerged) {
          throw new ConflictError('需要手动解决冲突', {
            local: account,
            server: serverData
          });
        }
      } else {
        throw error;
      }
    }
  }
  throw new Error('更新失败：超过最大重试次数');
}
```

### 6.2 批量操作限制

1. **请求大小限制**
   - 单次批量操作最多 100 条记录
   - 请求体大小限制 10MB
   - 超过限制返回 413 Payload Too Large

2. **速率限制**
   - 每个客户端每分钟最多 60 次请求
   - 批量操作计为 1 次请求
   - 超过限制返回 429 Too Many Requests

3. **超时控制**
   - 单次请求超时 30 秒
   - 批量操作超时 60 秒
   - 长时间操作使用异步任务

### 6.3 缓存策略

#### 服务器端缓存

```typescript
// Redis 缓存实现
class CacheManager {
  // 缓存账号列表（5 分钟）
  async getAccountsList(cacheKey: string) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const accounts = await db.getAccounts();
    await redis.setex(cacheKey, 300, JSON.stringify(accounts));
    return accounts;
  }

  // 缓存失效策略
  async invalidateAccountCache(accountId: string) {
    // 删除相关缓存
    await redis.del(`account:${accountId}`);
    await redis.del('accounts:list:*');
  }
}
```

#### 客户端缓存

```typescript
// IndexedDB 缓存实现
class LocalCache {
  // 缓存完整快照
  async cacheSnapshot(snapshot: Snapshot) {
    await db.put('snapshots', {
      id: 'latest',
      data: snapshot,
      timestamp: Date.now()
    });
  }

  // 应用增量变更
  async applyChanges(changes: Changes) {
    const snapshot = await this.getSnapshot();
    const updated = this.mergeChanges(snapshot, changes);
    await this.cacheSnapshot(updated);
  }

  // 检查缓存是否过期（10 分钟）
  async isCacheValid() {
    const snapshot = await db.get('snapshots', 'latest');
    if (!snapshot) return false;
    return Date.now() - snapshot.timestamp < 600000;
  }
}
```

### 6.4 性能优化建议

1. **数据库索引**
   ```sql
   -- 账号查询优化
   CREATE INDEX idx_accounts_updated_at ON accounts(updated_at);
   CREATE INDEX idx_accounts_status_updated ON accounts(status, updated_at);
   CREATE INDEX idx_accounts_group_updated ON accounts(group_id, updated_at);

   -- 增量查询优化
   CREATE INDEX idx_accounts_version ON accounts(version);
   CREATE INDEX idx_groups_updated_at ON groups(updated_at);
   CREATE INDEX idx_tags_updated_at ON tags(updated_at);
   ```

2. **查询优化**
   - 使用字段过滤减少数据传输
   - 使用分页避免一次加载大量数据
   - 使用增量查询减少重复数据传输

3. **连接池配置**
   ```javascript
   const pool = mysql.createPool({
     host: 'localhost',
     user: 'root',
     password: 'password',
     database: 'kiro_accounts',
     connectionLimit: 20,      // 最大连接数
     queueLimit: 0,            // 无限队列
     waitForConnections: true,
     enableKeepAlive: true,
     keepAliveInitialDelay: 0
   });
   ```

4. **响应压缩**
   ```javascript
   import compression from 'compression';
   app.use(compression({
     filter: (req, res) => {
       if (req.headers['x-no-compression']) {
         return false;
       }
       return compression.filter(req, res);
     },
     level: 6  // 压缩级别 (0-9)
   }));
   ```

---

## 7. 错误处理

### 7.1 标准错误响应格式

```typescript
interface ErrorResponse {
  success
