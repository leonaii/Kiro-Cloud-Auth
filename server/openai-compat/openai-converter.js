/**
 * OpenAI 消息格式转换器
 * 支持多模态内容（文本 + 图片）和工具使用
 */

/**
 * 转换 OpenAI 消息格式到内部格式
 * 支持多模态内容（文本 + 图片）和工具调用
 * @param {Array} messages - OpenAI 格式的消息列表
 * @returns {Array}
 */
export function convertMessages(messages) {
  return messages.map((msg) => {
    // OpenAI 的 system role 转换为 user（Kiro 不支持 system role）
    let role = msg.role === 'system' ? 'user' : msg.role

    // 处理 tool role（工具结果）
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }]
      }
    }

    // 处理 content
    let content = msg.content

    if (typeof content === 'string') {
      // 简单字符串内容
      content = [{ type: 'text', text: content }]
    } else if (Array.isArray(content)) {
      // 内容块数组 - 转换 OpenAI 格式到内部格式
      content = content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        } else if (block.type === 'image_url') {
          // OpenAI 图片格式转换
          const imageUrl = block.image_url?.url || ''
          if (imageUrl.startsWith('data:')) {
            // Base64 格式: data:image/jpeg;base64,/9j/4AAQ...
            const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (matches) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: matches[1],
                  data: matches[2]
                }
              }
            }
          } else {
            // URL 格式
            return {
              type: 'image',
              source: {
                type: 'url',
                url: imageUrl
              }
            }
          }
        }
        return block
      }).filter(Boolean)
    }

    // 处理 assistant 消息中的 tool_calls
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      // 将 tool_calls 转换为 tool_use 内容块
      const toolUseBlocks = msg.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || tc.name,
        input: parseToolInput(tc.function?.arguments || tc.arguments)
      }))

      // 如果有文本内容，保留它
      if (Array.isArray(content) && content.length > 0) {
        content = [...content, ...toolUseBlocks]
      } else if (typeof msg.content === 'string' && msg.content) {
        content = [{ type: 'text', text: msg.content }, ...toolUseBlocks]
      } else {
        content = toolUseBlocks
      }
    }

    return { role, content }
  })
}

/**
 * 解析工具输入参数
 * @param {string|object} args - 工具参数（可能是 JSON 字符串或对象）
 * @returns {object}
 */
function parseToolInput(args) {
  if (!args) return {}
  if (typeof args === 'object') return args
  try {
    return JSON.parse(args)
  } catch (e) {
    return { raw: args }
  }
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
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
      }
      return JSON.stringify(m.content)
    })
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

/**
 * 转换工具调用响应为 OpenAI 格式
 * @param {Array} toolUseBlocks - 工具使用块
 * @returns {Array}
 */
export function convertToolCallsToOpenAI(toolUseBlocks) {
  if (!toolUseBlocks || !Array.isArray(toolUseBlocks)) return null

  return toolUseBlocks.map(block => ({
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
    }
  }))
}
