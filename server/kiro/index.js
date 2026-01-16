/**
 * Kiro 模块统一导出
 */

// 导出 KiroClient 类
export { default as KiroClient, default } from './kiro-client.js'

// 导出常量
export {
  KIRO_CONSTANTS,
  MODEL_MAPPING,
  SUPPORTED_MODELS,
  KIRO_MAX_OUTPUT_TOKENS,
  KIRO_MAX_TOOL_DESC_LEN,
  KIRO_MAX_TOOL_NAME_LEN
} from './constants.js'

// 导出 HTTP Agent
export { httpAgent, httpsAgent } from './http-agent.js'

// 导出工具函数
export { shortenToolNameIfNeeded, processToolDescription } from './tool-utils.js'

// 从 utils 重新导出 thinking 相关函数（向后兼容）
export { checkThinkingMode, extractThinkingFromContent, THINKING_START_TAG, THINKING_END_TAG } from '../utils/thinking-utils.js'
