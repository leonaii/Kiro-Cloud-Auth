/**
 * Header生成工具
 * 根据账号的header_version生成对应版本的HTTP Headers
 * 
 * V1版本（老账号）：
 * - 端点: codewhisperer.{{region}}.amazonaws.com
 * - Headers: 基础的 x-amz-user-agent 和 user-agent
 * 
 * V2版本（新账号）：
 * - 端点: q.{{region}}.amazonaws.com
 * - Headers: 增强的headers，包含额外的控制字段
 */

import { randomUUID } from 'crypto'
import * as crypto from 'crypto'

// V1 和 V2 版本的 SDK 和 IDE 版本号（写死在代码中）
// V1 (旧端点 codewhisperer.*.amazonaws.com)
const V1_SDK_JS_VERSION = '1.0.0'
const V1_IDE_VERSION = '0.6.18'

// V2 (新端点 q.*.amazonaws.com)
const V2_SDK_JS_VERSION = '1.0.27'
const V2_IDE_VERSION = '0.8.0'

/**
 * 生成32位GUID（标准UUID v4格式，带连字符）
 * 用于 amz-sdk-invocation-id header
 */
export function generateInvocationId() {
  return randomUUID()
}

/**
 * 生成64位设备hash
 * 用于 user-agent 和 x-amz-user-agent 的设备标识
 */
export function generateDeviceHash() {
  const randomBytes = crypto.randomBytes(32)
  return randomBytes.toString('hex')
}

/**
 * 获取账号的SDK版本号
 * 优先使用账号级别配置，否则根据header版本使用对应的全局配置
 *
 * @param {object} account - 账号对象
 * @returns {string} SDK版本号
 */
function getSdkVersion(account) {
  // 如果账号有自定义版本，优先使用
  if (account.sdkJsVersion) {
    return account.sdkJsVersion
  }
  
  // 根据header版本选择对应的SDK版本
  const headerVersion = account.headerVersion || 1
  return headerVersion === 2 ? V2_SDK_JS_VERSION : V1_SDK_JS_VERSION
}

/**
 * 获取账号的IDE版本号
 * 优先使用账号级别配置，否则根据header版本使用对应的全局配置
 *
 * @param {object} account - 账号对象
 * @returns {string} IDE版本号
 */
function getIdeVersion(account) {
  // 如果账号有自定义版本，优先使用
  if (account.ideVersion) {
    return account.ideVersion
  }
  
  // 根据header版本选择对应的IDE版本
  const headerVersion = account.headerVersion || 1
  return headerVersion === 2 ? V2_IDE_VERSION : V1_IDE_VERSION
}

/**
 * 生成V1版本的Headers（老版本，向后兼容）
 * 使用传统的header格式
 * 
 * @param {object} account - 账号对象
 * @param {string} accessToken - 访问令牌
 * @returns {object} HTTP Headers
 */
function generateV1Headers(account, accessToken) {
  const machineId = account.machineId || generateDeviceHash()
  const kiroVersion = getIdeVersion(account)
  const sdkVersion = getSdkVersion(account)
  
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'x-amz-user-agent': `aws-sdk-js/${sdkVersion} KiroIDE-${kiroVersion}-${machineId}`,
    'user-agent': `aws-sdk-js/${sdkVersion} ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererruntime#${sdkVersion} m/E KiroIDE-${kiroVersion}-${machineId}`,
    'amz-sdk-request': 'attempt=1; max=1',
    'amz-sdk-invocation-id': generateInvocationId(),
    'Connection': 'close'
  }
}

/**
 * 生成V2版本的Headers（新版本）
 * 使用增强的header格式，支持更多控制选项
 * 
 * 新增的header字段：
 * - x-amzn-kiro-agent-mode: vibe
 * - x-amzn-codewhisperer-optout: true
 * - amz-sdk-invocation-id: 使用账号专属的32位GUID
 * - x-amz-user-agent 和 user-agent: 使用账号专属的64位hash
 * 
 * @param {object} account - 账号对象
 * @param {string} accessToken - 访问令牌
 * @returns {object} HTTP Headers
 */
function generateV2Headers(account, accessToken) {
  // 使用账号专属的invocation ID，如果没有则生成新的
  const invocationId = account.amzInvocationId || generateInvocationId()
  
  // 使用账号专属的device hash，如果没有则使用machineId或生成新的
  const deviceHash = account.kiroDeviceHash || account.machineId || generateDeviceHash()
  
  const kiroVersion = getIdeVersion(account)
  const sdkVersion = getSdkVersion(account)
  
  return {
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amzn-codewhisperer-optout': 'true',
    'content-type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'amz-sdk-request': 'attempt=1; max=3',
    'amz-sdk-invocation-id': invocationId,
    'x-amz-user-agent': `aws-sdk-js/${sdkVersion} KiroIDE-${kiroVersion}-${deviceHash}`,
    'user-agent': `aws-sdk-js/${sdkVersion} ua/2.1 os/win32#10.0.26100 lang/is md/nodejs#22.21.1 api/codewhispererstreaming#${sdkVersion} m/E KiroIDE-${kiroVersion}-${deviceHash}`,
    'Connection': 'close'
  }
}

/**
 * 根据账号的header_version生成对应版本的Headers
 * 
 * @param {object} account - 账号对象，必须包含以下字段：
 *   - headerVersion: header版本号（1或2）
 *   - credentials.accessToken: 访问令牌
 *   - machineId: 机器ID（可选，V1版本使用）
 *   - amzInvocationId: 专属invocation ID（可选，V2版本使用）
 *   - kiroDeviceHash: 专属device hash（可选，V2版本使用）
 *   - sdkJsVersion: SDK版本（可选，默认使用全局配置）
 *   - ideVersion: IDE版本（可选，默认使用全局配置）
 * @param {string} accessToken - 访问令牌（可选，如果不提供则从account.credentials.accessToken获取）
 * @returns {object} HTTP Headers
 */
export function generateHeaders(account, accessToken = null) {
  const token = accessToken || account.credentials?.accessToken
  
  if (!token) {
    throw new Error('Access token is required to generate headers')
  }
  
  // 默认使用V1版本（向后兼容）
  const headerVersion = account.headerVersion || 1
  
  if (headerVersion === 2) {
    return generateV2Headers(account, token)
  } else {
    return generateV1Headers(account, token)
  }
}

/**
 * 根据header版本获取对应的API端点URL
 * 
 * @param {number} headerVersion - header版本号（1或2）
 * @param {string} region - AWS区域（默认'us-east-1'）
 * @param {string} endpoint - 端点类型（'base'或'usage'，默认'base'）
 * @returns {string} API端点URL
 */
export function getEndpointUrl(headerVersion, region = 'us-east-1', endpoint = 'base') {
  const version = headerVersion || 1
  
  if (version === 2) {
    // V2版本使用 q.{{region}}.amazonaws.com
    if (endpoint === 'usage') {
      return `https://q.${region}.amazonaws.com/getUsageLimits`
    }
    return `https://q.${region}.amazonaws.com/generateAssistantResponse`
  } else {
    // V1版本使用 codewhisperer.{{region}}.amazonaws.com
    if (endpoint === 'usage') {
      return `https://codewhisperer.${region}.amazonaws.com/getUsageLimits`
    }
    return `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`
  }
}

export default {
  generateHeaders,
  generateInvocationId,
  generateDeviceHash,
  getEndpointUrl
}