/**
 * 修复补丁：Claude 兼容模块问题修复
 *
 * 本文件记录了重构过程中发现的问题及修复方案
 */

## 问题 1: 流式响应中的状态重置问题

### 位置
`server/claude-compat/routes/claude-routes.js` 第 363-418 行

### 问题描述
在 TOKEN_EXPIRED 重试时，重置了 `fullContent` 和 `thinkingContent`，导致：
1. 已发送给客户端的内容无法累积到日志中
2. 最终的 token 计数不准确

### 修复方案
不要重置内容累积变量，只重置流状态：

```javascript
// 修改前（第 373-374 行）
fullContent = '';
thinkingContent = '';

// 修改后
// 不重置 fullContent 和 thinkingContent，保持累积
// 只重置流状态变量
```

---

## 问题 2: 流初始化时的 402 重试逻辑缺失

### 位置
`server/claude-compat/routes/claude-routes.js` handleStreamingRequest 函数

### 问题描述
原始实现在调用 `createStream` 之前就处理 402 错误并切换账号，新实现缺少这部分逻辑。

### 修复方案
在 `handleStreamingRequest` 函数开始处添加初始化重试逻辑：

```javascript
async function handleStreamingRequest(req, res, options) {
  // ... 现有代码 ...

  let retryCount = 0;
  let account = currentAccount;

  // 添加：初始化时的重试逻辑
  const attemptCreateStream = async (acc) => {
    try {
      return createStream(acc);
    } catch (error) {
      // 402 错误：配额耗尽
      if (isQuotaExhaustedError(error)) {
        console.log(`[Claude API] Quota exhausted (402) for account ${acc.email}, marking and switching...`);
        accountPool.markAccountQuotaExhausted(acc.id, error.message);

        if (retryCount < maxRetries && !accountId) {
          retryCount++;
          const newAccount = await accountPool.getNextAccount(groupId);
          if (newAccount && newAccount.id !== acc.id) {
            console.log(`[Claude API] Retry stream with new account after 402: ${newAccount.email}`);
            await accountPool.incrementApiCall(newAccount.id);
            account = newAccount;
            return attemptCreateStream(newAccount);
          }
        }
      }

      // 其他可重试错误
      if (isRetryableError(error) && retryCount < maxRetries && !accountId) {
        await accountPool.markAccountError(acc.id);
        retryCount++;
        const newAccount = await accountPool.getNextAccount(groupId);
        if (newAccount && newAccount.id !== acc.id) {
          await accountPool.incrementApiCall(newAccount.id);
          account = newAccount;
          return attemptCreateStream(newAccount);
        }
      }

      throw error;
    }
  };

  // 使用重试逻辑创建流
  let stream;
  try {
    stream = await attemptCreateStream(account);
  } catch (error) {
    // 处理最终失败
    const err = buildClaudeError('api_error', error.message, 500);
    return res.status(err.status).json(err.body);
  }

  // ... 继续现有的流处理逻辑 ...
}
```

---

## 问题 3: Content Block 索引管理

### 位置
`server/claude-compat/handlers/stream-handler.js` processStreamEvent 函数

### 问题描述
`SSEWriter` 自动递增 `contentBlockIndex`，但 `StreamState` 的索引可能不同步。

### 修复方案
在 `processStreamEvent` 中同步更新 state 的索引：

```javascript
case 'thinking_start':
  state.recordFirstByte();
  if (!state.thinkingBlockStarted) {
    state.thinkingBlockIndex = writer.writeThinkingBlockStart();
    state.thinkingBlockStarted = true;
  }
  break;

case 'content':
  if (event.content) {
    state.recordFirstByte();
    if (!state.textBlockStarted) {
      state.textBlockIndex = writer.writeTextBlockStart();
      state.textBlockStarted = true;
    }
    state.fullContent += event.content;
    writer.writeTextDelta(state.textBlockIndex, event.content);
  }
  break;
```

---

## 问题 4: 工具描述长度限制不一致

### 位置
`server/claude-compat/constants.js` 第 26 行

### 问题描述
- Go 实现: 9216
- JS 实现: 10237

### 修复方案
```javascript
// 修改前
export const MAX_TOOL_DESCRIPTION_LENGTH = 10237;

// 修改后（与 Go 实现保持一致）
export const MAX_TOOL_DESCRIPTION_LENGTH = 9216;
```

---

## 问题 5: 工具名称长度限制

### 位置
`server/claude-compat/constants.js` 第 25 行

### 当前值
```javascript
export const MAX_TOOL_NAME_LENGTH = 64;
```

### 验证
根据 Go 实现，64 是正确的值，无需修改。

---

## 优先级评估

| 问题 | 严重程度 | 影响范围 | 优先级 |
|------|----------|----------|--------|
| 流初始化 402 重试缺失 | 🔴 高 | 配额耗尽场景 | P0 |
| 状态重置导致日志不准 | 🟡 中 | 日志记录 | P1 |
| 索引管理不一致 | 🟢 低 | 潜在问题 | P2 |
| 工具描述长度 | 🟢 低 | 边界情况 | P3 |

---

## 测试建议

### 1. 流初始化 402 重试测试
```javascript
// 模拟第一个账号 402，第二个账号成功
mockKiroClient.streamApi
  .mockRejectedValueOnce(new Error('Quota exceeded'))
  .mockResolvedValueOnce(mockStream);
```

### 2. 流中 TOKEN_EXPIRED 测试
```javascript
// 模拟流中间 TOKEN_EXPIRED
const mockStream = {
  async *[Symbol.asyncIterator]() {
    yield { type: 'content', content: 'Hello' };
    throw new Error('TOKEN_EXPIRED');
  }
};
```

### 3. Content Block 索引测试
```javascript
// 验证 thinking → text → tool_use 的索引序列
// 应该是 0, 1, 2
```

---

## 实施计划

1. **立即修复** (P0): 流初始化 402 重试逻辑
2. **短期修复** (P1): 状态重置问题
3. **中期优化** (P2): 索引管理优化
4. **长期对齐** (P3): 常量值统一

---

## 回归测试清单

- [ ] 流式响应正常场景
- [ ] 流初始化时 402 错误切换账号
- [ ] 流中间 TOKEN_EXPIRED 切换账号
- [ ] 非流式响应 402 重试
- [ ] 工具调用流程
- [ ] Thinking mode 流程
- [ ] 多轮对话
- [ ] 图片处理
- [ ] 历史压缩
