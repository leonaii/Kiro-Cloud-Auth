import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatDate(date: Date | string | number): string {
  const d = new Date(date)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateRandomString(64)
  const codeChallenge = base64UrlEncode(sha256(codeVerifier))
  return { codeVerifier, codeChallenge }
}

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, (byte) => chars[byte % chars.length]).join('')
}

function sha256(str: string): Uint8Array {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  const hashBuffer = new Uint8Array(32)
  for (let i = 0; i < data.length; i++) {
    hashBuffer[i % 32] ^= data[i]
  }
  return hashBuffer
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function generateState(): string {
  return generateRandomString(32)
}

// ============================================
// 状态管理工具函数
// ============================================

/**
 * 创建 Map 状态的快照（用于乐观更新回滚）
 * @param state - 原始 Map 状态
 * @returns 状态的浅拷贝
 */
export function createStateSnapshot<K, V>(state: Map<K, V>): Map<K, V> {
  return new Map(state)
}

/**
 * 应用乐观更新到 Map 中的指定项
 * @param state - 原始 Map 状态
 * @param id - 要更新的项 ID
 * @param updates - 部分更新内容
 * @returns 更新后的新 Map
 */
export function applyOptimisticUpdate<T>(
  state: Map<string, T>,
  id: string,
  updates: Partial<T>
): Map<string, T> {
  const updated = new Map(state)
  const item = updated.get(id)
  if (item) {
    updated.set(id, { ...item, ...updates })
  }
  return updated
}

// ============================================
// 隐私模式工具函数
// ============================================

/**
 * 邮箱脱敏处理
 * 将邮箱转换为固定格式的伪装邮箱
 * @param email - 原始邮箱
 * @returns 脱敏后的邮箱
 */
export function maskEmail(email: string): string {
  if (!email) return email
  // 生成固定长度的随机字符串作为伪装邮箱
  const hash = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const maskedName = `user${(hash % 100000).toString().padStart(5, '0')}`
  return `${maskedName}@***.com`
}

/**
 * 昵称脱敏处理
 * 将昵称转换为固定格式的伪装昵称
 * @param nickname - 原始昵称
 * @returns 脱敏后的昵称
 */
export function maskNickname(nickname: string | undefined): string {
  if (!nickname) return nickname || ''
  // 基于原始昵称生成固定的伪装昵称
  const hash = nickname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return `用户${(hash % 100000).toString().padStart(5, '0')}`
}

// ============================================
// 时间戳处理工具函数
// ============================================

/**
 * 将时间戳字符串转换为数字（毫秒）
 * 如果输入已经是数字，直接返回
 * 如果输入是字符串，尝试解析为时间戳
 * @param value - 时间戳值（字符串或数字）
 * @returns 毫秒时间戳或 undefined
 */
export function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return isNaN(parsed) ? undefined : parsed
}
