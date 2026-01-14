/**
 * 本地设置数据类型定义
 * 这些设置存储在客户端本地，不同步到服务器
 * 
 * 此文件是共享类型定义，被以下文件使用：
 * - src/preload/index.ts
 * - src/renderer/src/store/accounts.ts
 */
export interface LocalSettingsData {
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
  /** 比特浏览器配置 */
  bitBrowserConfig?: {
    /** 是否启用比特浏览器打开登录页面 */
    enabled: boolean
    /** 比特浏览器 API 端口号，默认 54345 */
    port: number
    /** 比特浏览器窗口 ID */
    browserId: string
  }
  /** 索引签名，支持动态属性访问 */
  [key: string]: unknown
}