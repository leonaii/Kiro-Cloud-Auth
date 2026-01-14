// 共享类型定义
export interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  /** Unix时间戳（毫秒），表示奖励过期时间 */
  expiresAt?: number
}

export interface VerifiedData {
  email: string
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn?: number
  subscriptionType: string
  subscriptionTitle: string
  subscription?: {
    managementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
    rawType?: string
  }
  usage: {
    current: number
    limit: number
    baseLimit?: number
    baseCurrent?: number
    freeTrialLimit?: number
    freeTrialCurrent?: number
    /** Unix时间戳（毫秒），表示免费试用过期时间 */
    freeTrialExpiry?: number
    bonuses?: BonusData[]
    /** Unix时间戳（毫秒），表示下次重置日期 */
    nextResetDate?: number
    resourceDetail?: {
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      overageEnabled?: boolean
    }
  }
  daysRemaining?: number
  expiresAt?: number
}

export type ImportMode = 'oidc' | 'sso' | 'login'
export type LoginType = 'builderid' | 'google' | 'github'
export type OAuthMode = 'web-oauth' | 'deep-link'

export interface ImportResult {
  total: number
  success: number
  failed: number
  errors: string[]
}

export interface BuilderIdLoginData {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}