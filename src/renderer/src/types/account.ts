// ============================================
// 多账号管理器类型定义
// ============================================

export type IdpType = 'Google' | 'Github' | 'BuilderId' | 'AWSIdC' | 'Internal'

export type SubscriptionType = 'Free' | 'Pro' | 'Enterprise' | 'Teams'

export type AccountStatus = 'active' | 'expired' | 'error' | 'refreshing' | 'unknown' | 'banned'

/**
 * 账号凭证信息
 */
export interface AccountCredentials {
  accessToken: string
  csrfToken: string
  refreshToken?: string
  clientId?: string      // OIDC 客户端 ID（用于刷新 token）
  clientIdHash?: string  // OIDC 客户端 ID 哈希（用于本地 SSO 缓存查找）
  clientSecret?: string  // OIDC 客户端密钥
  region?: string        // AWS 区域，默认 us-east-1
  expiresAt: number      // 时间戳
  authMethod?: 'IdC' | 'social'  // 认证方式：IdC (BuilderId) 或 social (GitHub/Google)
  provider?: 'BuilderId' | 'Github' | 'Google'  // 身份提供商
}

/**
 * 奖励额度信息
 */
export interface BonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: number  // Unix 时间戳（毫秒）
}

/**
 * 账号使用量信息
 */
export interface AccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  // 详细额度分解
  baseLimit?: number      // 基础额度
  baseCurrent?: number    // 基础已用
  freeTrialLimit?: number // 试用额度
  freeTrialCurrent?: number
  freeTrialExpiry?: number  // Unix 时间戳（毫秒）- 免费试用过期时间
  bonuses?: BonusUsage[]  // 奖励额度列表
  nextResetDate?: number  // Unix 时间戳（毫秒）- 配额重置日期
  resourceDetail?: ResourceDetail // 资源详情
}

/**
 * 账号订阅信息
 */
export interface AccountSubscription {
  type: SubscriptionType
  title?: string // 原始订阅标题，如 "KIRO PRO+"
  rawType?: string // 原始订阅类型，如 "Q_DEVELOPER_STANDALONE_PRO_PLUS"
  expiresAt?: number // 订阅到期时间戳
  daysRemaining?: number
  upgradeCapability?: string // 可升级能力
  overageCapability?: string // 超额能力
  managementTarget?: string // 订阅管理目标
}

/**
 * 资源使用详情
 */
export interface ResourceDetail {
  resourceType?: string // CREDIT
  displayName?: string // Credit
  displayNamePlural?: string // Credits
  currency?: string // USD
  unit?: string // INVOCATIONS
  overageRate?: number // 0.04
  overageCap?: number // 10000
  overageEnabled?: boolean
}

/**
 * 账号标签
 */
export interface AccountTag {
  id: string
  name: string
  color: string // hex color
  version?: number // 数据版本号（用于乐观锁）
}

/**
 * 账号实体
 */
export interface Account {
  // 基本信息
  id: string
  email: string
  nickname?: string // 自定义别名
  idp: IdpType
  userId?: string
  visitorId?: string

  // 认证信息
  credentials: AccountCredentials

  // 订阅信息
  subscription: AccountSubscription

  // 使用量
  usage: AccountUsage

  // 分组和标签
  groupId?: string
  tags: string[] // tag ids

  // 状态
  status: AccountStatus
  lastError?: string
  isActive: boolean // 是否为当前激活账号

  // 时间戳
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number // 上次状态检查时间

  // 软删除
  isDel?: boolean // 是否已删除
  deletedAt?: number // 删除时间戳

  // 版本控制（用于乐观锁）
  version?: number // 数据版本号

  // 同步状态
  needsSync?: boolean // 是否需要同步到服务器（本地新建账号默认为 true）

  // API 调用统计
  apiCallCount?: number // API 调用次数
  apiLastCallAt?: number // 最后调用时间
  apiTotalTokens?: number // 总 token 消耗

  // Header版本控制
  headerVersion?: number // Header版本（1=V1, 2=V2）
  amzInvocationId?: string // AWS SDK Invocation ID (32位UUID)
  kiroDeviceHash?: string // Kiro设备Hash (64位hex)
  sdkJsVersion?: string // SDK JS版本号
  ideVersion?: string // IDE版本号
}

/**
 * 账号分组
 */
export interface AccountGroup {
  id: string
  name: string
  description?: string
  color?: string
  apiKey?: string  // 分组专属 API Key，用于 OpenAI 兼容 API 认证，只能访问该分组内的账号
  order: number
  createdAt: number
  version?: number // 数据版本号（用于乐观锁）
}

/**
 * 账号池状态类型
 */
export type PoolStatus = 'active' | 'cooling' | 'none'

/**
 * 未分组特殊标识
 */
export const UNGROUPED_ID = '__ungrouped__'

/**
 * 筛选条件
 */
export interface AccountFilter {
  search?: string // 搜索关键词（邮箱/别名）
  subscriptionTypes?: SubscriptionType[]
  statuses?: AccountStatus[]
  idps?: IdpType[]
  groupIds?: string[] // 包含 UNGROUPED_ID 表示筛选未分组账号
  tagIds?: string[]
  usageMin?: number // 使用量百分比
  usageMax?: number
  daysRemainingMin?: number
  daysRemainingMax?: number
  showDeleted?: boolean // 是否显示已删除账号
  poolStatuses?: PoolStatus[] // 账号池状态筛选
}

/**
 * 排序选项
 */
export type SortField =
  | 'email'
  | 'nickname'
  | 'subscription'
  | 'usage'
  | 'daysRemaining'
  | 'lastUsedAt'
  | 'createdAt'
  | 'status'

export type SortOrder = 'asc' | 'desc'

export interface AccountSort {
  field: SortField
  order: SortOrder
}

/**
 * 导入/导出格式
 */
export interface AccountExportData {
  version: string
  exportedAt: number
  accounts: Omit<Account, 'isActive'>[]
  groups: AccountGroup[]
  tags: AccountTag[]
}

/**
 * 账号导入项（简化格式）
 */
export interface AccountImportItem {
  email: string
  accessToken: string
  csrfToken: string
  refreshToken?: string
  idp?: IdpType
  nickname?: string
  groupId?: string
  tags?: string[]
}

/**
 * 批量操作结果
 */
export interface BatchOperationResult {
  success: number
  failed: number
  errors: { id: string; error: string }[]
}

/**
 * 账号统计
 */
export interface AccountStats {
  total: number
  byStatus: Record<AccountStatus, number>
  bySubscription: Record<SubscriptionType, number>
  byIdp: Record<IdpType, number>
  activeCount: number
  expiringSoonCount: number // 7天内到期
}
