/**
 * OpenAI 消息格式转换器
 */

/**
 * 转换 OpenAI 消息格式到内部格式
 * 支持多模态内容（文本 + 图片）
 * @param {Array} messages - OpenAI 格式的消息列表
 * @returns {Array}
 */
export function convertMessages(messages) {
  return messages.map((msg) => {
    const role = msg.role === 'system' ? 'user' : msg.role
    // 保持原始 content 格式，支持 string 或 array（多模态）
    return { role, content: msg.content }
  })
}

/**
 * 提取 system prompt
 * @param {Array} messages - 消息列表
 * @returns {string|null}
 */
export function extractSystemPrompt(messages) {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  if (systemMsgs.length === 0) return null
  return systemMsgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

/**
 * 估算 token 数量（简单实现）
 * @param {string} text - 文本内容
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}
