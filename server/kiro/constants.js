/**
 * Kiro API 常量定义
 */

// Thinking 模式常量
export const KIRO_MAX_OUTPUT_TOKENS = 32000
export const KIRO_MAX_TOOL_DESC_LEN = 10237
export const KIRO_MAX_TOOL_NAME_LEN = 64

// Kiro API 配置
export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  // V1: codewhisperer.{{region}}.amazonaws.com
  BASE_URL_V1: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
  // V2: q.{{region}}.amazonaws.com
  BASE_URL_V2: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  AXIOS_TIMEOUT: 120000,
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR',
}

// 模型映射
export const MODEL_MAPPING = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
}

// 支持的模型列表
export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)
