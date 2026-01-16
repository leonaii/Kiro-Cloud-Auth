/**
 * 工具处理函数
 */

import { KIRO_MAX_TOOL_NAME_LEN, KIRO_MAX_TOOL_DESC_LEN } from './constants.js'

/**
 * 截断工具名称（Kiro 限制 64 字符）
 * @param {string} name - 工具名称
 * @returns {string}
 */
export function shortenToolNameIfNeeded(name) {
  if (!name || name.length <= KIRO_MAX_TOOL_NAME_LEN) return name
  // 保留前32和后31字符，中间用_连接
  return name.substring(0, 32) + '_' + name.substring(name.length - 31)
}

/**
 * 处理工具描述（空描述默认值，长度截断）
 * @param {string} description - 工具描述
 * @returns {string}
 */
export function processToolDescription(description) {
  if (!description || description.trim() === '') {
    return 'No description provided'
  }
  if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
    return description.substring(0, KIRO_MAX_TOOL_DESC_LEN - 3) + '...'
  }
  return description
}
