/**
 * Thinking 模式工具函数
 */

// Thinking 模式常量
export const THINKING_START_TAG = '<thinking>'
export const THINKING_END_TAG = '</thinking>'

/**
 * 检查是否启用了 Thinking 模式
 * @param {object} requestBody - 请求体
 * @returns {{ enabled: boolean, budgetTokens: number }}
 */
export function checkThinkingMode(requestBody) {
  let enabled = false
  let budgetTokens = 16000

  // Claude API 格式
  if (requestBody.thinking?.type === 'enabled') {
    enabled = true
    if (requestBody.thinking.budget_tokens > 0) {
      budgetTokens = requestBody.thinking.budget_tokens
    }
  }

  // OpenAI 格式 (reasoning_effort)
  if (!enabled && requestBody.reasoning_effort) {
    const effort = requestBody.reasoning_effort
    if (effort && effort !== 'none') {
      enabled = true
      switch (effort) {
        case 'low': budgetTokens = 8000; break
        case 'medium': budgetTokens = 16000; break
        case 'high': budgetTokens = 24000; break
        default: budgetTokens = 16000
      }
    }
  }

  // AMP/Cursor 格式 - 检查系统提示中的 thinking_mode 标签
  if (!enabled && requestBody.system) {
    const systemStr = typeof requestBody.system === 'string'
      ? requestBody.system
      : JSON.stringify(requestBody.system)
    if (systemStr.includes('<thinking_mode>') && systemStr.includes('</thinking_mode>')) {
      const startIdx = systemStr.indexOf('<thinking_mode>') + 15
      const endIdx = systemStr.indexOf('</thinking_mode>', startIdx)
      if (endIdx > startIdx) {
        const thinkingMode = systemStr.substring(startIdx, endIdx)
        if (thinkingMode === 'interleaved' || thinkingMode === 'enabled') {
          enabled = true
          const lengthMatch = systemStr.match(/<max_thinking_length>(\d+)<\/max_thinking_length>/)
          if (lengthMatch) budgetTokens = parseInt(lengthMatch[1], 10)
        }
      }
    }
  }

  return { enabled, budgetTokens }
}

/**
 * 从响应内容中提取 thinking 块
 * @param {string} content - 响应内容
 * @returns {Array<{ type: string, text?: string, thinking?: string }>}
 */
export function extractThinkingFromContent(content) {
  const blocks = []
  if (!content) return blocks
  if (!content.includes(THINKING_START_TAG)) {
    return [{ type: 'text', text: content }]
  }

  let remaining = content
  while (remaining.length > 0) {
    const startIdx = remaining.indexOf(THINKING_START_TAG)
    if (startIdx === -1) {
      if (remaining.trim()) blocks.push({ type: 'text', text: remaining })
      break
    }
    if (startIdx > 0) {
      const textBefore = remaining.substring(0, startIdx)
      if (textBefore.trim()) blocks.push({ type: 'text', text: textBefore })
    }
    remaining = remaining.substring(startIdx + THINKING_START_TAG.length)
    const endIdx = remaining.indexOf(THINKING_END_TAG)
    if (endIdx === -1) {
      if (remaining.trim()) blocks.push({ type: 'thinking', thinking: remaining })
      break
    }
    const thinkContent = remaining.substring(0, endIdx)
    if (thinkContent.trim()) blocks.push({ type: 'thinking', thinking: thinkContent })
    remaining = remaining.substring(endIdx + THINKING_END_TAG.length)
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}
