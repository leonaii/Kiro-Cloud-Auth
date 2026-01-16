/**
 * Claude 响应构建器
 */

import { v4 as uuidv4 } from 'uuid'

// Claude API 版本常量
export const CLAUDE_API_VERSIONS = ['2023-06-01', '2023-01-01', '2024-01-01']
export const DEFAULT_API_VERSION = '2023-06-01'

/**
 * 验证 anthropic-version 头部中间件
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @param {function} next - 下一个中间件
 */
export function validateAnthropicVersion(req, res, next) {
  const version = req.headers['anthropic-version']
  if (version && !CLAUDE_API_VERSIONS.includes(version)) {
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Invalid anthropic-version header: ${version}. Supported versions: ${CLAUDE_API_VERSIONS.join(', ')}`
      }
    })
  }
  req.anthropicVersion = version || DEFAULT_API_VERSION
  next()
}

/**
 * 构建 Claude 格式的错误响应
 * @param {string} type - 错误类型
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @returns {object}
 */
export function buildClaudeError(type, message, status = 400) {
  return {
    status,
    body: {
      type: 'error',
      error: {
        type,
        message
      }
    }
  }
}

/**
 * 构建 Claude 格式的非流式响应
 * @param {string} content - 响应内容
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 * @param {string} stopReason - 停止原因
 * @param {Array} contentBlocks - 内容块
 * @returns {object}
 */
export function buildClaudeResponse(content, model, inputTokens, outputTokens, stopReason = 'end_turn', contentBlocks = null) {
  const response = {
    id: `msg_${uuidv4().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  }

  // 处理内容块
  if (contentBlocks && Array.isArray(contentBlocks)) {
    response.content = contentBlocks.map(block => {
      if (block.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: block.thinking
        }
      } else if (block.type === 'text') {
        return {
          type: 'text',
          text: block.text
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input
        }
      }
      return block
    })
  } else if (content) {
    response.content = [{ type: 'text', text: content }]
  }

  return response
}

/**
 * 构建 SSE 流式事件
 * @param {string} eventType - 事件类型
 * @param {object} data - 事件数据
 * @returns {string}
 */
export function buildSSEEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}
