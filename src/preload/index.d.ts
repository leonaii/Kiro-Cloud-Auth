import { ElectronAPI } from '@electron-toolkit/preload'

// 服务器同步的账号数据（不包含本地设置）
interface AccountData {
  accounts: Record<string, unknown>
  groups: Record<string, unknown>
  tags: Record<string, unknown>
  activeAccountId: string | null
}

// 本地设置数据（客户端独立存储，不同步到服务器）
interface LocalSettingsData {
  privacyMode?: boolean
  theme?: string
  darkMode?: boolean
  autoRefreshEnabled?: boolean
  autoRefreshInterval?: number
  statusCheckInterval?: number
  autoSwitchEnabled?: boolean
  autoSwitchThreshold?: number
  autoSwitchInterval?: number
  proxyEnabled?: boolean
  proxyUrl?: string
  localActiveAccountId?: string | null
  // 机器码管理
  machineIdConfig?: {
    autoSwitchOnAccountChange: boolean
    bindMachineIdToAccount: boolean
    useBindedMachineId: boolean
  }
  accountMachineIds?: Record<string, string>
  machineIdHistory?: Array<{
    id: string
    machineId: string
    timestamp: number
    action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
    accountId?: string
    accountEmail?: string
  }>
  // 比特浏览器配置
  bitBrowserConfig?: {
    enabled: boolean
    port: number
    browserId: string
  }
}

interface RefreshResult {
  success: boolean
  data?: {
    accessToken: string
    refreshToken?: string
    expiresIn: number
  }
  error?: { message: string }
}

interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

interface StatusResult {
  success: boolean
  data?: {
    status: string
    email?: string
    userId?: string
    idp?: string // 身份提供商：BuilderId, Google, Github 等
    userStatus?: string // 用户状态：Active 等
    featureFlags?: string[] // 特性开关
    subscriptionTitle?: string
    usage?: {
      current: number
      limit: number
      percentUsed: number
      lastUpdated: number
      baseLimit?: number
      baseCurrent?: number
      freeTrialLimit?: number
      freeTrialCurrent?: number
      freeTrialExpiry?: string
      bonuses?: BonusData[]
      nextResetDate?: string
      resourceDetail?: ResourceDetail
    }
    subscription?: {
      type: string
      title?: string
      rawType?: string
      expiresAt?: number
      daysRemaining?: number
      upgradeCapability?: string
      overageCapability?: string
      managementTarget?: string
    }
    // 如果 token 被刷新，返回新凭证
    newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresAt?: number
    }
  }
  error?: { message: string }
}

interface KiroApi {
  openExternal: (url: string) => void
  getAppVersion: () => Promise<string>
  reloadApp: () => Promise<{ success: boolean; error?: string }>
  onAuthCallback: (callback: (data: { code: string; state: string }) => void) => () => void

  // 注意：loadAccounts 和 saveAccounts 已删除
  // Electron 渲染进程现在直接使用 HTTP 请求（通过 webAdapter），与 Web 版本统一
  // 这样可以自动携带 cookie 进行认证，无需通过 IPC 传递

  // 账号管理 - 刷新 Token
  refreshAccountToken: (account: unknown) => Promise<RefreshResult>
  checkAccountStatus: (account: unknown) => Promise<StatusResult>

  // 切换账号 - 写入凭证到本地 SSO 缓存
  switchAccount: (credentials: {
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: 'IdC' | 'social'
    provider?: 'BuilderId' | 'Github' | 'Google'
  }) => Promise<{ success: boolean; error?: string }>

  // 文件操作
  exportToFile: (data: string, filename: string) => Promise<boolean>
  importFromFile: () => Promise<string | null>

  // 验证凭证并获取账号信息
  verifyAccountCredentials: (credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string  // 'IdC' 或 'social'
    provider?: string    // 'BuilderId', 'Github', 'Google'
  }) => Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      subscription?: {
        rawType?: string
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
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
      // 根据 IDP 确定的 header 版本（1=V1老版本, 2=V2新版本）
      headerVersion?: number
    }
    error?: string
  }>

  // 获取本地 SSO 缓存中当前使用的账号信息
  getLocalActiveAccount: () => Promise<{
    success: boolean
    data?: {
      refreshToken: string
      accessToken?: string
      authMethod?: string
      provider?: string
    }
    error?: string
  }>

  // 从 Kiro 本地配置导入凭证
  loadKiroCredentials: () => Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken: string
      clientId: string
      clientSecret: string
      region: string
      authMethod: string  // 'IdC' 或 'social'
      provider: string    // 'BuilderId', 'Github', 'Google'
    }
    error?: string
  }>

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (bearerToken: string, region?: string) => Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken: string
      clientId: string
      clientSecret: string
      region: string
      expiresIn?: number
      email?: string
      userId?: string
      idp?: string
      status?: string
      subscriptionType?: string
      subscriptionTitle?: string
      subscription?: {
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage?: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
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
    }
    error?: { message: string }
  }>

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (region?: string) => Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }>

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (region?: string) => Promise<{
    success: boolean
    completed?: boolean
    status?: string
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }>

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: () => Promise<{ success: boolean }>

  // 启动 Social Auth 登录 (Google/GitHub)
  // skipOpenBrowser: 如果为 true，则不在主进程中打开浏览器，由渲染进程处理（用于比特浏览器等自定义浏览器）
  startSocialLogin: (provider: 'Google' | 'Github', skipOpenBrowser?: boolean) => Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }>

  // 交换 Social Auth token
  exchangeSocialToken: (code: string, state: string) => Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }>

  // 取消 Social Auth 登录
  cancelSocialLogin: () => Promise<{ success: boolean }>

  // 监听 Social Auth 回调
  onSocialAuthCallback: (callback: (data: { code?: string; state?: string; error?: string }) => void) => () => void

  // 代理设置
  setProxy: (enabled: boolean, url: string) => Promise<{ success: boolean; error?: string }>

  // ============ 机器码管理 API ============

  // 获取操作系统类型
  machineIdGetOSType: () => Promise<'windows' | 'macos' | 'linux' | 'unknown'>

  // 获取当前机器码
  machineIdGetCurrent: () => Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }>

  // 设置新机器码
  machineIdSet: (newMachineId: string) => Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }>

  // 生成随机机器码
  machineIdGenerateRandom: () => Promise<string>

  // 检查管理员权限
  machineIdCheckAdmin: () => Promise<boolean>

  // 请求管理员权限重启
  machineIdRequestAdminRestart: () => Promise<boolean>

  // 备份机器码到文件
  machineIdBackupToFile: (machineId: string) => Promise<boolean>

  // 从文件恢复机器码
  machineIdRestoreFromFile: () => Promise<{
    success: boolean
    machineId?: string
    error?: string
  }>

  // ============ 自动更新 API ============

  // 检查更新 (electron-updater)
  checkForUpdates: () => Promise<{
    hasUpdate: boolean
    version?: string
    releaseDate?: string
    message?: string
    error?: string
  }>


  // 下载更新
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>

  // 安装更新并重启
  installUpdate: () => Promise<void>

  // 监听更新事件
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void
  onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void
  onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
  onUpdateError: (callback: (error: string) => void) => () => void

  // ============ Kiro 设置管理 API ============

  // 获取 Kiro 设置
  getKiroSettings: () => Promise<{
    settings?: Record<string, unknown>
    mcpConfig?: { mcpServers: Record<string, unknown> }
    steeringFiles?: string[]
    error?: string
  }>

  // 保存 Kiro 设置
  saveKiroSettings: (settings: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>

  // 打开 Kiro MCP 配置文件
  openKiroMcpConfig: (type: 'user' | 'workspace') => Promise<{ success: boolean; error?: string }>

  // 打开 Kiro Steering 目录
  openKiroSteeringFolder: () => Promise<{ success: boolean; error?: string }>

  // 打开 Kiro settings.json 文件
  openKiroSettingsFile: () => Promise<{ success: boolean; error?: string }>

  // 打开指定的 Steering 文件
  openKiroSteeringFile: (filename: string) => Promise<{ success: boolean; error?: string }>

  // 创建默认的 rules.md 文件
  createKiroDefaultRules: () => Promise<{ success: boolean; error?: string }>

  // 读取 Steering 文件内容
  readKiroSteeringFile: (filename: string) => Promise<{ success: boolean; content?: string; error?: string }>

  // 保存 Steering 文件内容
  saveKiroSteeringFile: (filename: string, content: string) => Promise<{ success: boolean; error?: string }>

  // 删除 Steering 文件
  deleteKiroSteeringFile: (filename: string) => Promise<{ success: boolean; error?: string }>

  // ============ MCP 服务器管理 ============

  // 保存 MCP 服务器配置
  saveMcpServer: (name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string) => Promise<{ success: boolean; error?: string }>

  // 删除 MCP 服务器
  deleteMcpServer: (name: string) => Promise<{ success: boolean; error?: string }>

  // ============ 本地设置存储 (客户端独立配置) ============

  // 加载本地设置
  loadLocalSettings: () => Promise<LocalSettingsData>

  // 保存本地设置
  saveLocalSettings: (settings: LocalSettingsData) => Promise<{ success: boolean; error?: string }>

  // 通过比特浏览器打开 URL
  openUrlInBitBrowser: (url: string, port: number, browserId: string) => Promise<{ success: boolean; error?: string }>

  // 关闭比特浏览器窗口
  closeBitBrowser: (port: number, browserId: string) => Promise<{ success: boolean; error?: string }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KiroApi
  }
}
