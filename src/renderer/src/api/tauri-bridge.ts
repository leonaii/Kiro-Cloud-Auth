/**
 * Tauri API 桥接层
 * 
 * 这个文件提供了一个统一的 API 接口，可以在 Tauri 客户端和 Web 端之间切换。
 * - 在 Tauri 客户端中，调用 Tauri 的 invoke 命令
 * - 在 Web 端，调用后端 API
 */

// 检测是否在 Tauri 环境中运行
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

// Tauri invoke 函数类型
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

// 获取 Tauri invoke 函数
const getTauriInvoke = (): TauriInvoke | null => {
  if (isTauri()) {
    // @ts-ignore - Tauri 全局对象
    return window.__TAURI__.core.invoke
  }
  return null
}

/**
 * 社交登录结果
 */
export interface LoginResult {
  accessToken: string
  refreshToken: string
  expiresAt: string
  expiresIn: number
  provider: string
  authMethod: string
  profileArn?: string
  idToken?: string
  csrfToken?: string
}

/**
 * Kiro 本地 Token
 */
export interface KiroLocalToken {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  authMethod?: string
  provider?: string
  profileArn?: string
  clientIdHash?: string
  region?: string
}

/**
 * Kiro 遥测信息
 */
export interface KiroTelemetryInfo {
  machineId?: string
  sqmId?: string
  devDeviceId?: string
  serviceMachineId?: string
}

/**
 * 切换账号参数
 */
export interface SwitchAccountParams {
  accessToken: string
  refreshToken: string
  provider: string
  authMethod?: string
  profileArn?: string
  clientIdHash?: string
  clientId?: string
  clientSecret?: string
  region?: string
  resetMachineId?: boolean
  autoRestart?: boolean
}

/**
 * 切换账号结果
 */
export interface SwitchAccountResult {
  success: boolean
  message: string
  kiroWasRunning: boolean
  kiroRestarted: boolean
}

/**
 * 机器 GUID 信息
 */
export interface MachineGuidInfo {
  guid: string
  source: string
}

/**
 * 应用配置
 */
export interface AppConfig {
  serverUrl: string
  useRemoteServer: boolean
}

/**
 * Tauri API 桥接类
 */
class TauriBridge {
  private invoke: TauriInvoke | null = null

  constructor() {
    this.invoke = getTauriInvoke()
  }

  /**
   * 检查是否在 Tauri 环境中
   */
  isAvailable(): boolean {
    return this.invoke !== null
  }

  /**
   * 启动社交登录
   */
  async startSocialLogin(provider: string): Promise<string> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('start_social_login', { provider })
  }

  /**
   * 交换社交登录 Token
   */
  async exchangeSocialToken(code: string, callbackState: string): Promise<LoginResult> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('exchange_social_token', { code, callbackState })
  }

  /**
   * 刷新社交登录 Token
   */
  async refreshSocialToken(refreshToken: string, provider: string): Promise<LoginResult> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('refresh_social_token', { refreshToken, provider })
  }

  /**
   * 获取 Kiro 本地 Token
   */
  async getKiroLocalToken(): Promise<KiroLocalToken | null> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('get_kiro_local_token')
  }

  /**
   * 切换 Kiro 账号
   */
  async switchKiroAccount(params: SwitchAccountParams): Promise<SwitchAccountResult> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('switch_kiro_account', { params })
  }

  /**
   * 获取 Kiro 遥测信息
   */
  async getKiroTelemetryInfo(): Promise<KiroTelemetryInfo | null> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('get_kiro_telemetry_info')
  }

  /**
   * 重置 Kiro 机器 ID
   */
  async resetKiroMachineId(): Promise<KiroTelemetryInfo> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('reset_kiro_machine_id')
  }

  /**
   * 获取系统机器 GUID
   */
  async getSystemMachineGuid(): Promise<MachineGuidInfo> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('get_system_machine_guid')
  }

  /**
   * 备份机器 GUID
   */
  async backupMachineGuid(): Promise<string> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('backup_machine_guid')
  }

  /**
   * 恢复机器 GUID
   */
  async restoreMachineGuid(): Promise<string> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('restore_machine_guid')
  }

  /**
   * 重置系统机器 GUID
   */
  async resetSystemMachineGuid(): Promise<string> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('reset_system_machine_guid')
  }

  /**
   * 生成机器 GUID
   */
  async generateMachineGuid(): Promise<string> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('generate_machine_guid')
  }

  /**
   * 检测已安装的浏览器
   */
  async detectInstalledBrowsers(): Promise<string[]> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('detect_installed_browsers')
  }

  /**
   * 启动 Web OAuth 登录
   */
  async webOAuthLogin(provider: string): Promise<{ windowLabel: string; state: string }> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('web_oauth_login', { provider })
  }

  /**
   * 关闭 OAuth 窗口
   */
  async webOAuthCloseWindow(windowLabel: string): Promise<void> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('web_oauth_close_window', { windowLabel })
  }

  /**
   * 获取应用配置
   */
  async getAppConfig(): Promise<AppConfig> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('get_app_config')
  }

  /**
   * 设置应用配置
   */
  async setAppConfig(config: AppConfig): Promise<void> {
    if (!this.invoke) {
      throw new Error('Tauri not available')
    }
    return this.invoke('set_app_config', { config })
  }
}

// 导出单例
export const tauriBridge = new TauriBridge()

// 导出便捷函数
export const startSocialLogin = (provider: string) => tauriBridge.startSocialLogin(provider)
export const exchangeSocialToken = (code: string, state: string) => tauriBridge.exchangeSocialToken(code, state)
export const refreshSocialToken = (refreshToken: string, provider: string) => tauriBridge.refreshSocialToken(refreshToken, provider)
export const getKiroLocalToken = () => tauriBridge.getKiroLocalToken()
export const switchKiroAccount = (params: SwitchAccountParams) => tauriBridge.switchKiroAccount(params)
export const getKiroTelemetryInfo = () => tauriBridge.getKiroTelemetryInfo()
export const resetKiroMachineId = () => tauriBridge.resetKiroMachineId()
export const getSystemMachineGuid = () => tauriBridge.getSystemMachineGuid()
export const backupMachineGuid = () => tauriBridge.backupMachineGuid()
export const restoreMachineGuid = () => tauriBridge.restoreMachineGuid()
export const resetSystemMachineGuid = () => tauriBridge.resetSystemMachineGuid()
export const generateMachineGuid = () => tauriBridge.generateMachineGuid()
export const detectInstalledBrowsers = () => tauriBridge.detectInstalledBrowsers()
export const webOAuthLogin = (provider: string) => tauriBridge.webOAuthLogin(provider)
export const webOAuthCloseWindow = (windowLabel: string) => tauriBridge.webOAuthCloseWindow(windowLabel)
export const getAppConfig = () => tauriBridge.getAppConfig()
export const setAppConfig = (config: AppConfig) => tauriBridge.setAppConfig(config)