/**
 * OpenAI 兼容 API 模块
 *
 * 提供标准 OpenAI API 接口，使用数据库中的账号池进行负载均衡
 *
 * 支持的端点：
 * - GET  /v1/models          - 列出可用模型
 * - GET  /v1/models/:model   - 获取模型详情
 * - POST /v1/chat/completions - 聊天补全（支持流式）
 * - GET  /v1/pool/status     - 获取账号池状态
 * - POST /v1/pool/refresh    - 刷新账号池缓存
 *
 * 使用示例：
 * ```javascript
 * import { initOpenAIRoutes } from './openai-compat/index.js'
 *
 * const openaiRoutes = initOpenAIRoutes(mysqlPool)
 * app.use(openaiRoutes)
 * ```
 */

export { initOpenAIRoutes, default as openaiRouter } from './openai-routes.js'
export { default as AccountPool } from './account-pool.js'
export { default as KiroClient, SUPPORTED_MODELS, MODEL_MAPPING } from './kiro-client.js'
