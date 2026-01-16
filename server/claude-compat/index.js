/**
 * Claude 兼容模块统一导出
 */

// 导出转换器
export {
  convertClaudeMessages,
  convertClaudeTools,
  processSystemPrompt,
  processToolChoice
} from './claude-converter.js'

// 导出响应构建器
export {
  CLAUDE_API_VERSIONS,
  DEFAULT_API_VERSION,
  validateAnthropicVersion,
  buildClaudeError,
  buildClaudeResponse,
  buildSSEEvent
} from './claude-response.js'

// 导出路由初始化函数
export { initClaudeRoutes, getAccountPool, default } from './claude-routes.js'
