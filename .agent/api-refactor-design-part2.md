# Kiro-Cloud-Auth  API 重构设计文档（续）

## 7. 错误处理

### 7.1 标准错误响应格式

```typescript
interface ErrorResponse {
  success: false;
  error: string;           // 错误代码
  message: string;         // 用户友好的错误消息
  details?: any;           // 详细错误信息
  timestamp: number;       // 错误发生时间
  requestId?: string;      // 请求 ID（用于追踪）
}
```

### 7.2 错误代码列表

| 错误代码 | HTTP 状态码 | 描述 | 处理建议 |
|---------|------------|------|---------|
| `VERSION_CONFLICT` | 409 | 版本冲突 | 获取最新数据并重试 |
| `ACCOUNT_NOT_FOUND` | 404 | 账号不存在 | 检查账号 ID |
| `INVALID_VERSION` | 400 | 无效的版本号 | 提供正确的版本号 |
| `VALIDATION_ERROR` | 400 | 数据验证失败 | 检查请求数据格式 |
| `RATE_LIMIT_EXCEEDED` | 429 | 超过速率限制 | 稍后重试 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体过大 | 减少批量操作数量 |
| `UNAUTHORIZED` | 401 | 未授权 | 检查认证信息 |
| `FORBIDDEN` | 403 | 禁止访问 | 检查权限 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 | 联系技术支持 |
| `DATABASE_ERROR` | 500 | 数据库错误 | 联系技术支持 |
| `NETWORK_ERROR` | 503 | 网络错误 | 检查网络连接 |

### 7.3 错误处理示例

```typescript
// 客户端错误处理
async function handleApiCall<T>(apiCall: () => Promise<T>): Promise<T> {
  try {
    return await apiCall();
  } catch (error) {
    if (error.error === 'VERSION_CONFLICT') {
      // 版本冲突：获取最新数据
      console.warn('检测到版本冲突，正在获取最新数据...');
      throw new ConflictError(error.message, error.details);
    } else if (error.error === 'RATE_LIMIT_EXCEEDED') {
      // 速率限制：等待后重试
      const retryAfter = error.details?.retryAfter || 60;
      console.warn(`超过速率限制，${retryAfter}秒后重试`);
      await sleep(retryAfter * 1000);
      return handleApiCall(apiCall);
    } else if (error.error === 'NETWORK_ERROR') {
      // 网络错误：重试
      console.warn('网络错误，正在重试...');
      await sleep(1000);
      return handleApiCall(apiCall);
    } else {
      // 其他错误：抛出
      throw error;
    }
  }
}
```

---

## 8. 监控和日志

### 8.1 API 调用监控

```typescript
// 服务器端中间件
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = generateRequestId();

  // 记录请求
  logger.info('API Request', {
    requestId,
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });

  // 响应完成后记录
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('API Response', {
      requestId,
      statusCode: res.statusCode,
      duration
    });

    // 记录到数据库（用于统计）
    if (req.path.startsWith('/api/v2/')) {
      recordApiMetrics({
        endpoint: req.path,
        method: req.method,
        statusCode: res.statusCode,
        duration,
        timestamp: Date.now()
      });
    }
  });

  next();
});
```

### 8.2 性能监控指标

1. **响应时间**
   - P50: 50ms
   - P95: 200ms
   - P99: 500ms

2. **吞吐量**
   - 目标: 1000 请求/秒
   - 峰值: 2000 请求/秒

3. **错误率**
   - 目标: < 0.1%
   - 告警阈值: > 1%

4. **数据库连接池**
   - 活跃连接数
   - 等待队列长度
   - 连接超时次数

### 8.3 日志级别

```typescript
enum LogLevel {
  DEBUG = 'debug',    // 调试信息
  INFO = 'info',      // 一般信息
  WARN = 'warn',      // 警告
  ERROR = 'error',    // 错误
  FATAL = 'fatal'     // 致命错误
}

// 日志示例
logger.info('Account updated', {
  accountId: 'account-uuid',
  version: 6,
  updatedFields: ['email', 'usage']
});

logger.warn('Version conflict detected', {
  accountId: 'account-uuid',
  clientVersion: 5,
  serverVersion: 7
});

logger.error('Database query failed', {
  query: 'UPDATE accounts SET ...',
  error: error.message,
  stack: error.stack
});
```

---

## 9. 测试策略

### 9.1 单元测试

```typescript
describe('Account API v2', () => {
  describe('PUT /api/v2/accounts/:id', () => {
    it('should update account with correct version', async () => {
      const account = await createTestAccount();
      const response = await request(app)
        .put(`/api/v2/accounts/${account.id}`)
        .send({
          version: 1,
          email: 'newemail@example.com'
        });

      expect(response.status).toBe(200);
      expect(response.body.data.version).toBe(2);
    });

    it('should reject update with wrong version', async () => {
      const account = await createTestAccount();
      const response = await request(app)
        .put(`/api/v2/accounts/${account.id}`)
        .send({
          version: 999,
          email: 'newemail@example.com'
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('VERSION_CONFLICT');
    });
  });
});
```

### 9.2 集成测试

```typescript
describe('Sync Flow', () => {
  it('should sync changes between clients', async () => {
    // 客户端 A 创建账号
    const accountA = await clientA.createAccount({
      id: 'test-account',
      email: 'test@example.com'
    });

    // 客户端 B 获取增量变更
    const changes = await clientB.getChanges(lastSyncTime);
    expect(changes.accounts.created).toContainEqual(
      expect.objectContaining({ id: 'test-account' })
    );

    // 客户端 B 更新账号
    await clientB.updateAccount('test-account', {
      version: accountA.version,
      email: 'updated@example.com'
    });

    // 客户端 A 获取变更（应该看到更新）
    const changesA = await clientA.getChanges(lastSyncTime);
    expect(changesA.accounts.updated).toContainEqual(
      expect.objectContaining({
        id: 'test-account',
        email: 'updated@example.com'
      })
    );
  });
});
```

### 9.3 性能测试

```typescript
describe('Performance Tests', () => {
  it('should handle 1000 concurrent requests', async () => {
    const requests = Array(1000).fill(null).map(() =>
      request(app).get('/api/v2/accounts')
    );

    const startTime = Date.now();
    const responses = await Promise.all(requests);
    const duration = Date.now() - startTime;

    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(duration).toBeLessThan(5000); // 5 秒内完成
  });

  it('should handle batch operations efficiently', async () => {
    const operations = Array(100).fill(null).map((_, i) => ({
      action: 'create',
      data: {
        id: `account-${i}`,
        email: `user${i}@example.com`
      }
    }));

    const startTime = Date.now();
    const response = await request(app)
      .post('/api/v2/accounts/batch')
      .send({ operations });
    const duration = Date.now() - startTime;

    expect(response.status).toBe(200);
    expect(response.body.data.summary.succeeded).toBe(100);
    expect(duration).toBeLessThan(2000); // 2 秒内完成
  });
});
```

---

## 10. 部署和运维

### 10.1 部署清单

#### 数据库迁移
```bash
# 1. 备份数据库
mysqldump -u root -p kiro_accounts > backup_$(date +%Y%m%d).sql

# 2. 运行迁移脚本
node server/db/migrate-to-v2.js

# 3. 验证迁移结果
node server/db/verify-migration.js
```

#### 服务器部署
```bash
# 1. 拉取最新代码
git pull origin main

# 2. 安装依赖
npm install

# 3. 构建项目
npm run build

# 4. 重启服务（零停机部署）
pm2 reload kiro-server

# 5. 验证部署
curl http://localhost:3000/api/health
curl http://localhost:3000/api/v2/sync/snapshot
```

### 10.2 回滚计划

如果新版本出现问题，按以下步骤回滚：

```bash
# 1. 回滚代码
git revert HEAD
git push origin main

# 2. 重新部署
pm2 reload kiro-server

# 3. 回滚数据库（如果需要）
mysql -u root -p kiro_accounts < backup_YYYYMMDD.sql

# 4. 验证回滚
curl http://localhost:3000/api/health
```

### 10.3 监控告警

配置以下告警规则：

1. **错误率告警**
   - 条件: 5 分钟内错误率 > 1%
   - 级别: 警告
   - 通知: 邮件 + Slack

2. **响应时间告警**
   - 条件: P95 响应时间 > 1 秒
   - 级别: 警告
   - 通知: 邮件

3. **数据库连接告警**
   - 条件: 连接池使用率 > 80%
   - 级别: 警告
   - 通知: 邮件

4. **服务不可用告警**
   - 条件: 健康检查失败
   - 级别: 紧急
   - 通知: 邮件 + Slack + 短信

---

## 11. 文档和培训

### 11.1 API 文档

使用 OpenAPI (Swagger) 规范生成交互式 API 文档：

```yaml
openapi: 3.0.0
info:
  title: Kiro-Cloud-Auth  API v2
  version: 2.0.0
  description: 细化的微服务 API，支持版本控制和增量同步

servers:
  - url: https://api.kiro.dev/v2
    description: 生产环境
  - url: http://localhost:3000/api/v2
    description: 开发环境

paths:
  /accounts:
    get:
      summary: 查询账号列表
      parameters:
        - name: page
          in: query
          schema:
            type: integer
            default: 1
        - name: pageSize
          in: query
          schema:
            type: integer
            default: 50
            maximum: 200
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AccountListResponse'
```

### 11.2 迁移指南

为开发者提供详细的迁移指南：

#### 从 v1 迁移到 v2

**旧代码 (v1)**:
```typescript
// 获取所有数据
const data = await api.getData();

// 保存数据（危险：会删除服务器上的其他数据）
await api.saveData({
  ...data,
  syncDelete: true
});
```

**新代码 (v2)**:
```typescript
// 获取完整快照（初始化）
const snapshot = await api.v2.sync.snapshot();

// 获取增量变更（后台同步）
const changes = await api.v2.sync.changes({
  lastSyncTime: lastSyncTime,
  resources: ['accounts', 'groups', 'tags']
});

// 推送本地变更
await api.v2.sync.push({
  changes: {
    accounts: {
      created: [newAccount],
      updated: [updatedAccount],
      deleted: [deletedAccountId]
    }
  }
});
```

### 11.3 最佳实践

1. **始终提供版本号**
   ```typescript
   // ✅ 正确
   await api.v2.accounts.update(id, {
     version: account.version,
     email: 'new@example.com'
   });

   // ❌ 错误（会导致版本冲突）
   await api.v2.accounts.update(id, {
     email: 'new@example.com'
   });
   ```

2. **处理版本冲突**
   ```typescript
   try {
     await api.v2.accounts.update(id, data);
   } catch (error) {
     if (error.error === 'VERSION_CONFLICT') {
       // 获取最新数据
       const latest = await api.v2.accounts.get(id);
       // 合并或提示用户
       const merged = mergeData(data, latest);
       await api.v2.accounts.update(id, merged);
     }
   }
   ```

3. **使用增量同步**
   ```typescript
   // 定期获取增量变更（每 10 秒）
   setInterval(async () => {
     const changes = await api.v2.sync.changes({
       lastSyncTime: lastSyncTime
     });

     // 应用变更到本地
     applyChanges(changes);

     // 更新同步时间
     lastSyncTime = changes.serverTime;
   }, 10000);
   ```

4. **批量操作优化**
   ```typescript
   // ✅ 使用批量接口
   await api.v2.accounts.batch({
     operations: accounts.map(acc => ({
       action: 'create',
       data: acc
     }))
   });

   // ❌ 避免循环调用
   for (const acc of accounts) {
     await api.v2.accounts.create(acc);
   }
   ```

---

## 12. 总结

### 12.1 关键改进

1. **消除数据覆盖风险**
   - 移除危险的 `syncDelete` 参数
   - 使用明确的删除接口
   - 添加版本控制防止误操作

2. **解决并发冲突**
   - 乐观锁机制（版本号 + 时间戳）
   - 冲突检测和自动重试
   - 提供冲突解决策略

3. **提高性能**
   - 支持增量查询（只传输变更数据）
   - 支持分页和字段过滤
   - 批量操作接口
   - 缓存策略

4. **改善可维护性**
   - RESTful 微服务架构
   - 清晰的资源边界
   - 标准化的错误处理
   - 完善的监控和日志

### 12.2 实施时间表

| 阶段 | 内容 | 时间 | 状态 |
|-----|------|------|------|
| 阶段 1 | 核心功能（同步接口、版本控制） | 2-3 周 | 待开始 |
| 阶段 2 | 批量操作、分组标签接口 | 1-2 周 | 待开始 |
| 阶段 3 | 高级功能（分页、机器码、导入导出） | 1-2 周 | 待开始 |
| 阶段 4 | 清理优化、移除旧接口 | 1-2 周 | 待开始 |
| **总计** | | **5-9 周** | |

### 12.3 风险和缓解措施

| 风险 | 影响 | 概率 | 缓解措施 |
|-----|------|------|---------|
| 数据库迁移失败 | 高 | 低 | 充分测试、备份数据、准备回滚方案 |
| 客户端兼容性问题 | 中 | 中 | 保留旧接口、渐进式迁移、充分测试 |
| 性能下降 | 中 | 低 | 性能测试、优化查询、添加缓存 |
| 版本冲突频繁 | 低 | 中 | 优化冲突解决策略、用户教育 |

### 12.4 成功指标

1. **功能指标**
   - ✅ 零数据覆盖事故
   - ✅ 版本冲突自动解决率 > 90%
   - ✅ API 响应时间 P95 < 200ms

2. **质量指标**
   - ✅ 单元测试覆盖率 > 80%
   - ✅ 集成测试覆盖率 > 60%
   - ✅ API 错误率 < 0.1%

3. **用户体验指标**
   - ✅ 客户端迁移完成率 > 95%
   - ✅ 用户满意度 > 4.5/5
   - ✅ 支持工单减少 > 50%

---

## 13. 附录

### 13.1 完整的 API 端点列表

#### 账号资源
- `GET /api/v2/accounts` - 查询账号列表
- `GET /api/v2/accounts/:id` - 获取单个账号
- `POST /api/v2/accounts` - 创建账号
- `PUT /api/v2/accounts/:id` - 更新账号
- `PATCH /api/v2/accounts/:id` - 部分更新账号
- `DELETE /api/v2/accounts/:id` - 软删除账号
- `DELETE /api/v2/accounts/:id/permanent` - 永久删除账号
- `POST /api/v2/accounts/:id/restore` - 恢复账号
- `POST /api/v2/accounts/batch` - 批量操作
- `POST /api/v2/accounts/batch-delete` - 批量删除
- `POST /api/v2/accounts/:id/refresh-token` - 刷新 Token
- `POST /api/v2/accounts/:id/check-status` - 检查状态

#### 分组资源
- `GET /api/v2/groups` - 查询分组列表
- `POST /api/v2/groups` - 创建分组
- `PUT /api/v2/groups/:id` - 更新分组
- `DELETE /api/v2/groups/:id` - 删除分组
- `POST /api/v2/groups/batch-reorder` - 批量调整顺序

#### 标签资源
- `GET /api/v2/tags` - 查询标签列表
- `POST /api/v2/tags` - 创建标签
- `PUT /api/v2/tags/:id` - 更新标签
- `DELETE /api/v2/tags/:id` - 删除标签

#### 设置资源
- `GET /api/v2/settings` - 获取所有设置
- `GET /api/v2/settings/:key` - 获取单个设置
- `PUT /api/v2/settings/:key` - 更新单个设置
- `POST /api/v2/settings/batch` - 批量更新设置

#### 机器码资源
- `GET /api/v2/machine-ids/config` - 获取配置
- `PUT /api/v2/machine-ids/config` - 更新配置
- `GET /api/v2/machine-ids/bindings` - 获取绑定列表
- `PUT /api/v2/machine-ids/bindings/:accountId` - 绑定机器码
- `DELETE /api/v2/machine-ids/bindings/:accountId` - 解绑机器码
- `GET /api/v2/machine-ids/history` - 获取历史记录
- `POST /api/v2/machine-ids/history` - 添加历史记录

#### 同步资源
- `GET /api/v2/sync/snapshot` - 获取完整快照
- `POST /api/v2/sync/changes` - 获取增量变更
- `POST /api/v2/sync/push` - 推送本地变更

#### 导入/导出
- `POST /api/v2/import` - 导入数据
- `GET /api/v2/export` - 导出数据

### 13.2 数据库 Schema 变更

```sql
-- 添加版本控制字段
ALTER TABLE accounts ADD COLUMN version INT DEFAULT 1 AFTER id;
ALTER TABLE accounts ADD COLUMN updated_at BIGINT AFTER version;

ALTER TABLE groups ADD COLUMN version INT DEFAULT 1 AFTER id;
ALTER TABLE groups ADD COLUMN updated_at BIGINT AFTER version;

ALTER TABLE tags ADD COLUMN version INT DEFAULT 1 AFTER id;
ALTER TABLE tags ADD COLUMN updated_at BIGINT AFTER version;

ALTER TABLE settings ADD COLUMN version INT DEFAULT 1 AFTER `key`;
ALTER TABLE settings ADD COLUMN updated_at BIGINT AFTER version;

ALTER TABLE account_machine_ids ADD COLUMN version INT DEFAULT 1 AFTER account_id;
ALTER TABLE account_machine_ids ADD COLUMN updated_at BIGINT AFTER version;

-- 添加索引
CREATE INDEX idx_accounts_version ON accounts(version);
CREATE INDEX idx_accounts_updated_at ON accounts(updated_at);
CREATE INDEX idx_groups_updated_at ON groups(updated_at);
CREATE INDEX idx_tags_updated_at ON tags(updated_at);
CREATE INDEX idx_settings_updated_at ON settings(updated_at);
```

### 13.3 参考资料

- [RESTful API 设计最佳实践](https://restfulapi.net/)
- [乐观锁 vs 悲观锁](https://en.wikipedia.org/wiki/Optimistic_concurrency_control)
- [API 版本控制策略](https://www.troyhunt.com/your-api-versioning-is-wrong-which-is/)
- [数据库迁移最佳实践](https://www.liquibase.org/get-started/best-practices)

---

**文档结束**

如有疑问或需要进一步说明，请联系架构团队。
