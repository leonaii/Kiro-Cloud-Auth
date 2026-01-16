/**
 * Claude 消息格式转换器
 */

/**
 * 转换 Claude 消息格式到内部格式
 * 支持多模态内容（文本 + 图片）和工具使用
 * @param {Array} messages - Claude 格式的消息列表
 * @returns {Array}
 */
export function convertClaudeMessages(messages) {
  return messages.map((msg) => {
    // Claude API 的 role 只有 "user" 和 "assistant"
    const role = msg.role

    // 处理 content - 可以是字符串或内容块数组
    let content = msg.content

    if (typeof content === 'string') {
      // 简单字符串内容
      content = [{ type: 'text', text: content }]
    } else if (Array.isArray(content)) {
      // 内容块数组 - 转换格式
      content = content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        } else if (block.type === 'image') {
          // 处理图像块
          if (block.source?.type === 'base64') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.media_type,
                data: block.source.data
              }
            }
          } else if (block.source?.type === 'url') {
            return {
              type: 'image',
              source: {
                type: 'url',
                url: block.source.url
              }
            }
          }
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input
          }
        } else if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error
          }
        }
        return block
      })
    }

    return { role, content }
  })
}

/**
 * 转换 Claude 工具格式到内部格式
 * @param {Array} tools - Claude 格式的工具列表
 * @returns {Array|null}
 */
export function convertClaudeTools(tools) {
  if (!tools || !Array.isArray(tools)) return null

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }))
}

/**
 * 处理 system prompt
 * Claude API 的 system 可以是字符串或内容块数组
 * @param {string|Array} system - system prompt
 * @returns {string|null}
 */
export function processSystemPrompt(system) {
  if (!system) return null

  if (typeof system === 'string') {
    return system
  }

  if (Array.isArray(system)) {
    return system
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  return null
}

/**
 * 处理 tool_choice 参数
 * @param {object} toolChoice - tool_choice 参数
 * @returns {object|null}
 */
export function processToolChoice(toolChoice) {
  if (!toolChoice) return null

  if (toolChoice.type === 'auto') {
    return { type: 'auto' }
  } else if (toolChoice.type === 'any') {
    return { type: 'any' }
  } else if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name }
  }

  return null
}
