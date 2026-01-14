import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LocalSettingsData } from '../types/local-settings'

// 重新导出 LocalSettingsData 类型，保持向后兼容
export type { LocalSettingsData }

// Custom APIs for renderer
const api = {
  // 打开外部链接
  openExternal: (url: string): void => {
    ipcRenderer.send('open-external', url)
  },

  // 获取应用版本
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('get-app-version')
  },

  // 重载应用（用于版本更新）
  reloadApp: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('reload-app')
  },

  // 监听 OAuth 回调
  onAuthCallback: (callback: (data: { code: string; state: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code: string; state: string }): void => {
      callback(data)
    }
    ipcRenderer.on('auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('auth-callback', handler)
    }
  },

  // 注意：loadAccounts 和 saveAccounts 已删除
  // Electron 渲染进程现在直接使用 HTTP 请求（通过 webAdapter），与 Web 版本统一
  // 这样可以自动携带 cookie 进行认证，无需通过 IPC 传递

  // 账号管理 - 刷新 Token
  refreshAccountToken: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('refresh-account-token', account)
  },

  // 账号管理 - 检查账号状态
  checkAccountStatus: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('check-account-status', account)
  },

  // 切换账号 - 写入凭证到本地 SSO 缓存
  switchAccount: (credentials: {
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: 'IdC' | 'social'
    provider?: 'BuilderId' | 'Github' | 'Google'
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('switch-account', credentials)
  },

  // 文件操作 - 导出到文件
  exportToFile: (data: string, filename: string): Promise<boolean> => {
    return ipcRenderer.invoke('export-to-file', data, filename)
  },

  // 文件操作 - 从文件导入
  importFromFile: (): Promise<string | null> => {
    return ipcRenderer.invoke('import-from-file')
  },

  // 验证凭证并获取账号信息
  verifyAccountCredentials: (credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string  // 'IdC' 或 'social'
    provider?: string    // 'BuilderId', 'Github', 'Google'
  }): Promise<{
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
        /** Unix时间戳（毫秒）或 ISO 日期字符串 */
        freeTrialExpiry?: string | number
        bonuses?: Array<{
          code: string
          name: string
          current: number
          limit: number
          /** Unix时间戳（毫秒）或 ISO 日期字符串 */
          expiresAt?: string | number
        }>
        /** Unix时间戳（毫秒）或 ISO 日期字符串 */
        nextResetDate?: string | number
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
      /** 根据 IDP 确定的 header 版本（1=V1老版本, 2=V2新版本） */
      headerVersion?: number
    }
    error?: string
  }> => {
    return ipcRenderer.invoke('verify-account-credentials', credentials)
  },

  // 获取本地 SSO 缓存中当前使用的账号信息
  getLocalActiveAccount: (): Promise<{
    success: boolean
    data?: {
      refreshToken: string
      accessToken?: string
      authMethod?: string
      provider?: string
    }
    error?: string
  }> => {
    return ipcRenderer.invoke('get-local-active-account')
  },

  // 从 Kiro 本地配置导入凭证
  loadKiroCredentials: (): Promise<{
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
  }> => {
    return ipcRenderer.invoke('load-kiro-credentials')
  },

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (bearerToken: string, region?: string): Promise<{
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
    }
    error?: { message: string }
  }> => {
    return ipcRenderer.invoke('import-from-sso-token', bearerToken, region || 'us-east-1')
  },

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (region?: string): Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('start-builder-id-login', region || 'us-east-1')
  },

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (region?: string): Promise<{
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
  }> => {
    return ipcRenderer.invoke('poll-builder-id-auth', region || 'us-east-1')
  },

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-builder-id-login')
  },

  // 启动 Social Auth 登录 (Google/GitHub)
  // skipOpenBrowser: 如果为 true，则不在主进程中打开浏览器，由渲染进程处理（用于比特浏览器等自定义浏览器）
  startSocialLogin: (provider: 'Google' | 'Github', skipOpenBrowser?: boolean): Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('start-social-login', provider, skipOpenBrowser)
  },

  // 交换 Social Auth token
  exchangeSocialToken: (code: string, state: string): Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('exchange-social-token', code, state)
  },

  // 取消 Social Auth 登录
  cancelSocialLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-social-login')
  },

  // 监听 Social Auth 回调
  onSocialAuthCallback: (callback: (data: { code?: string; state?: string; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code?: string; state?: string; error?: string }): void => {
      callback(data)
    }
    ipcRenderer.on('social-auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('social-auth-callback', handler)
    }
  },

  // ============ Web OAuth 无痕模式 API ============

  // 启动 Web OAuth 无痕模式登录 (Google/GitHub)
  startWebOAuthLogin: (provider: 'Google' | 'Github'): Promise<{
    success: boolean
    state?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('start-web-oauth-login', provider)
  },

  // 取消 Web OAuth 登录
  cancelWebOAuthLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-web-oauth-login')
  },

  // 监听 Web OAuth 回调
  onWebOAuthCallback: (callback: (data: {
    success?: boolean
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    email?: string
    userId?: string
    idp?: string
    authMethod?: string
    provider?: string
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
      freeTrialExpiry?: number
      bonuses?: Array<{
        code: string
        name: string
        current: number
        limit: number
        expiresAt?: number
      }>
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
    error?: string
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('web-oauth-callback', handler)
    return () => {
      ipcRenderer.removeListener('web-oauth-callback', handler)
    }
  },

  // 代理设置
  setProxy: (enabled: boolean, url: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('set-proxy', enabled, url)
  },

  // ============ 机器码管理 API ============

  // 获取操作系统类型
  machineIdGetOSType: (): Promise<'windows' | 'macos' | 'linux' | 'unknown'> => {
    return ipcRenderer.invoke('machine-id:get-os-type')
  },

  // 获取当前机器码
  machineIdGetCurrent: (): Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }> => {
    return ipcRenderer.invoke('machine-id:get-current')
  },

  // 设置新机器码
  machineIdSet: (newMachineId: string): Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }> => {
    return ipcRenderer.invoke('machine-id:set', newMachineId)
  },

  // 生成随机机器码
  machineIdGenerateRandom: (): Promise<string> => {
    return ipcRenderer.invoke('machine-id:generate-random')
  },

  // 检查管理员权限
  machineIdCheckAdmin: (): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:check-admin')
  },

  // 请求管理员权限重启
  machineIdRequestAdminRestart: (): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:request-admin-restart')
  },

  // 备份机器码到文件
  machineIdBackupToFile: (machineId: string): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:backup-to-file', machineId)
  },

  // 从文件恢复机器码
  machineIdRestoreFromFile: (): Promise<{
    success: boolean
    machineId?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('machine-id:restore-from-file')
  },

  // ============ 自动更新 ============

  // 检查更新 (electron-updater)
  checkForUpdates: (): Promise<{
    hasUpdate: boolean
    version?: string
    releaseDate?: string
    message?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('check-for-updates')
  },


  // 下载更新
  downloadUpdate: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('download-update')
  },

  // 安装更新并重启
  installUpdate: (): Promise<void> => {
    return ipcRenderer.invoke('install-update')
  },

  // 监听更新事件
  onUpdateChecking: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('update-checking', handler)
    return () => ipcRenderer.removeListener('update-checking', handler)
  },

  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string; releaseDate?: string; releaseNotes?: string }): void => callback(info)
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },

  onUpdateNotAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string }): void => callback(info)
    ipcRenderer.on('update-not-available', handler)
    return () => ipcRenderer.removeListener('update-not-available', handler)
  },

  onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }): void => callback(progress)
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },

  onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string; releaseDate?: string; releaseNotes?: string }): void => callback(info)
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },

  onUpdateError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on('update-error', handler)
    return () => ipcRenderer.removeListener('update-error', handler)
  },

  // ============ Kiro 设置管理 ============

  // 获取 Kiro 设置
  getKiroSettings: (): Promise<{
    settings?: Record<string, unknown>
    mcpConfig?: { mcpServers: Record<string, unknown> }
    steeringFiles?: string[]
    error?: string
  }> => {
    return ipcRenderer.invoke('get-kiro-settings')
  },

  // 保存 Kiro 设置
  saveKiroSettings: (settings: Record<string, unknown>): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-kiro-settings', settings)
  },

  // 打开 Kiro MCP 配置文件
  openKiroMcpConfig: (type: 'user' | 'workspace'): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-kiro-mcp-config', type)
  },

  // 打开 Kiro Steering 目录
  openKiroSteeringFolder: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-kiro-steering-folder')
  },

  // 打开 Kiro settings.json 文件
  openKiroSettingsFile: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-kiro-settings-file')
  },

  // 打开指定的 Steering 文件
  openKiroSteeringFile: (filename: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-kiro-steering-file', filename)
  },

  // 创建默认的 rules.md 文件
  createKiroDefaultRules: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('create-kiro-default-rules')
  },

  // 读取 Steering 文件内容
  readKiroSteeringFile: (filename: string): Promise<{ success: boolean; content?: string; error?: string }> => {
    return ipcRenderer.invoke('read-kiro-steering-file', filename)
  },

  // 保存 Steering 文件内容
  saveKiroSteeringFile: (filename: string, content: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-kiro-steering-file', filename, content)
  },

  // 删除 Steering 文件
  deleteKiroSteeringFile: (filename: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('delete-kiro-steering-file', filename)
  },

  // ============ MCP 服务器管理 ============

  // 保存 MCP 服务器配置
  saveMcpServer: (name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-mcp-server', name, config, oldName)
  },

  // 删除 MCP 服务器
  deleteMcpServer: (name: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('delete-mcp-server', name)
  },

  // ============ 本地设置存储 (客户端独立配置) ============

  // 加载本地设置
  loadLocalSettings: (): Promise<LocalSettingsData> => {
    return ipcRenderer.invoke('load-local-settings')
  },

  // 保存本地设置
  saveLocalSettings: (settings: LocalSettingsData): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-local-settings', settings)
  },

  // 通过比特浏览器打开 URL
  openUrlInBitBrowser: (url: string, port: number, browserId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-url-in-bitbrowser', url, port, browserId)
  },

  // 关闭比特浏览器窗口
  closeBitBrowser: (port: number, browserId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('close-bitbrowser', port, browserId)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
