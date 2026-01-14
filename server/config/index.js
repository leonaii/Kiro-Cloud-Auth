/**
 * 应用配置
 */

export const APP_VERSION = process.env.APP_VERSION || '1.0.0'

// SERVER_ID 格式：环境-worker编号，如 pro-1-w0, pro-1-w3
const baseServerId = process.env.SERVER_ID || 'server-1'
const workerIndex = process.env.WORKER_INDEX
export const SERVER_ID = workerIndex !== undefined ? `${baseServerId}-w${workerIndex}` : baseServerId

export const PORT = process.env.PORT || 3000

// OpenAI 兼容 API 默认授权密钥
export const DEFAULT_API_KEY = process.env.DEFAULT_API_KEY || ''

// Web 后台登录密码
export const WEB_LOGIN_PASSWORD = process.env.WEB_LOGIN_PASSWORD || ''

// JWT 认证密钥（用于 Web 和 Electron 统一的密码认证）
export const ELECTRON_AUTH_SECRET = process.env.ELECTRON_AUTH_SECRET || 'kiro-electron-secret-2024-leon'

// Header版本控制配置
// 全局默认版本（1=V1老版本, 2=V2新版本）
export const DEFAULT_HEADER_VERSION = parseInt(process.env.DEFAULT_HEADER_VERSION) || 1

// 不同 IDP 的默认 Header 版本
export const IDP_HEADER_VERSIONS = {
  'AWSIdC': 2,      // AWS Identity Center
  'BuilderId': 2,   // AWS Builder ID
  'Github': 1,      // GitHub
  'Google': 1       // Google
}

/**
 * 根据 IDP 获取默认的 Header 版本
 * @param {string} idp - 身份提供商（AWSIdC, BuilderId, Github, Google）
 * @returns {number} Header 版本号（1 或 2）
 */
export function getDefaultHeaderVersionForIdp(idp) {
  return IDP_HEADER_VERSIONS[idp] || DEFAULT_HEADER_VERSION
}

export default {
  APP_VERSION,
  SERVER_ID,
  PORT,
  DEFAULT_API_KEY,
  WEB_LOGIN_PASSWORD,
  ELECTRON_AUTH_SECRET,
  DEFAULT_HEADER_VERSION,
  IDP_HEADER_VERSIONS,
  getDefaultHeaderVersionForIdp
}
