/**
 * Token 计数工具
 * 参考 claude-kiro.js 的实现，提供更精确的 token 计数
 * 
 * 支持：
 * - 文本内容计数
 * - 图片内容估算（固定 1600 tokens）
 * - 工具定义计数
 * - 工具调用/结果计数
 * - 多模态消息计数
 */

// 尝试导入 Anthropic 官方 tokenizer，如果不可用则使用估算
let countTokensLib = null
try {
  const tokenizer = await import('@anthropic-ai/tokenizer')
  countTokensLib = tokenizer.countTokens
  console.log('[TokenCounter] Using @anthropic-ai/tokenizer for accurate token counting')
} catch (error) {
  console.log('[TokenCounter] @anthropic-ai/tokenizer not available, using estimation')
}

/**
 * 计算文本的 token 数量
 * 优先使用 Anthropic 官方 tokenizer，否则使用估算
 * @param {string} text - 要计数的文本
 * @returns {number} token 数量
 */
export function countTextTokens(text) {
  if (!text) return 0
  
  if (countTokensLib) {
    try {
      return countTokensLib(text)
    } catch (error) {
      console.warn('[TokenCounter] Tokenizer error, falling back to estimation:', error.message)
    }
  }
  
  // 回退到估算：平均每 4 个字符约 1 个 token
  return Math.ceil(text.length / 4)
}

/**
 * 从消息内容中提取纯文本
 * @param {string|Array|Object} content - 消息内容
 * @returns {string} 提取的文本
 */
export function getContentText(content) {
  if (!content) return ''
  
  if (typeof content === 'string') {
    return content
  }
  
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        if (part.type === 'text' && part.text) return part.text
        if (part.text) return part.text
      }
      return ''
    }).join('')
  }
  
  if (typeof content === 'object') {
    if (content.text) return content.text
    if (content.content) return getContentText(content.content)
  }
  
  return String(content)
}

/**
 * 估算输入 tokens（用于 Claude API 请求）
 * @param {Object} requestBody - 请求体
 * @returns {number} 估算的输入 token 数量
 */
export function estimateInputTokens(requestBody) {
  let totalTokens = 0
  
  // 计算 system prompt tokens
  if (requestBody.system) {
    const systemText = getContentText(requestBody.system)
    totalTokens += countTextTokens(systemText)
  }
  
  // 计算 thinking prefix tokens（如果启用）
  if (requestBody.thinking?.type === 'enabled') {
    const budget = requestBody.thinking.budget_tokens || 20000
    const prefixText = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    totalTokens += countTextTokens(prefixText)
  }
  
  // 计算所有消息的 tokens
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      if (message.content) {
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text' && part.text) {
              totalTokens += countTextTokens(part.text)
            } else if (part.type === 'thinking' && part.thinking) {
              totalTokens += countTextTokens(part.thinking)
            } else if (part.type === 'tool_result') {
              const resultContent = getContentText(part.content)
              totalTokens += countTextTokens(resultContent)
            } else if (part.type === 'tool_use' && part.input) {
              totalTokens += countTextTokens(JSON.stringify(part.input))
            } else if (part.type === 'image') {
              // 图片固定估算为 1600 tokens
              totalTokens += 1600
            } else if (part.type === 'document') {
              // 文档估算
              if (part.source?.data) {
                const estimatedChars = part.source.data.length * 0.75 // base64 to bytes ratio
                totalTokens += Math.ceil(estimatedChars / 4)
              }
            }
          }
        } else {
          const contentText = getContentText(message)
          totalTokens += countTextTokens(contentText)
        }
      }
    }
  }
  
  // 计算工具定义的 tokens
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    totalTokens += countTextTokens(JSON.stringify(requestBody.tools))
  }
  
  return totalTokens
}

/**
 * 估算输出 tokens
 * @param {string} content - 响应内容
 * @param {Array} toolCalls - 工具调用（可选）
 * @returns {number} 估算的输出 token 数量
 */
export function estimateOutputTokens(content, toolCalls = null) {
  let totalTokens = 0
  
  if (content) {
    totalTokens += countTextTokens(content)
  }
  
  if (toolCalls && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc.function?.arguments) {
        totalTokens += countTextTokens(tc.function.arguments)
      } else if (tc.input) {
        totalTokens += countTextTokens(JSON.stringify(tc.input))
      }
    }
  }
  
  return totalTokens
}

/**
 * 简单的 token 估算（用于快速估算）
 * @param {string} text - 文本
 * @returns {number} 估算的 token 数量
 */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * 计算完整请求的 token 数量（兼容 Claude API count_tokens 端点）
 * @param {Object} requestBody - 请求体
 * @returns {Object} { input_tokens: number }
 */
export function countTokens(requestBody) {
  let totalTokens = 0

  // 计算 system prompt tokens
  if (requestBody.system) {
    const systemText = getContentText(requestBody.system)
    totalTokens += countTextTokens(systemText)
  }

  // 计算所有消息的 tokens
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      if (message.content) {
        if (typeof message.content === 'string') {
          totalTokens += countTextTokens(message.content)
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              totalTokens += countTextTokens(block.text)
            } else if (block.type === 'tool_use') {
              // 计算工具使用块的 tokens
              totalTokens += countTextTokens(block.name || '')
              totalTokens += countTextTokens(JSON.stringify(block.input || {}))
            } else if (block.type === 'tool_result') {
              // 计算工具结果块的 tokens
              const resultContent = getContentText(block.content)
              totalTokens += countTextTokens(resultContent)
            } else if (block.type === 'image') {
              // 图片固定估算为 1600 tokens
              totalTokens += 1600
            } else if (block.type === 'document') {
              // 文档估算
              if (block.source?.data) {
                const estimatedChars = block.source.data.length * 0.75
                totalTokens += Math.ceil(estimatedChars / 4)
              }
            }
          }
        }
      }
    }
  }

  // 计算工具定义的 tokens
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    for (const tool of requestBody.tools) {
      totalTokens += countTextTokens(tool.name || '')
      totalTokens += countTextTokens(tool.description || '')
      if (tool.input_schema) {
        totalTokens += countTextTokens(JSON.stringify(tool.input_schema))
      }
    }
  }

  return { input_tokens: totalTokens }
}

export default {
  countTextTokens,
  getContentText,
  estimateInputTokens,
  estimateOutputTokens,
  estimateTokens,
  countTokens
}