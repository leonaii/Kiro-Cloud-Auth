import type { ImportResult } from './types'

interface OidcBatchFormProps {
  // 支持两种命名方式，保持向后兼容
  batchData?: string
  oidcBatchJson?: string
  batchImportResult?: ImportResult | null
  importResults?: ImportResult | null
  onBatchDataChange?: (value: string) => void
  onJsonChange?: (value: string) => void
  isLoading?: boolean
  onImport?: () => void
  // 新增配置项
  headerVersion?: 1 | 2
  onHeaderVersionChange?: (version: 1 | 2) => void
  autoRefreshToken?: boolean
  onAutoRefreshTokenChange?: (value: boolean) => void
  syncToServer?: boolean
  onSyncToServerChange?: (value: boolean) => void
}

export function OidcBatchForm({
  batchData,
  oidcBatchJson,
  batchImportResult,
  importResults,
  onBatchDataChange,
  onJsonChange,
  headerVersion = 2,
  onHeaderVersionChange,
  autoRefreshToken = false,
  onAutoRefreshTokenChange,
  syncToServer = true,
  onSyncToServerChange
}: OidcBatchFormProps) {
  // 兼容两种命名方式
  const data = batchData ?? oidcBatchJson ?? ''
  const result = batchImportResult ?? importResults ?? null
  const onChange = onBatchDataChange ?? onJsonChange ?? (() => {})

  const getCredentialCount = () => {
    try {
      const trimmed = data.trim()
      if (!trimmed) return 0
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.length : 1
    } catch {
      return 0
    }
  }

  const isValidJson = () => {
    try {
      const trimmed = data.trim()
      if (!trimmed) return false
      JSON.parse(trimmed)
      return true
    } catch {
      return false
    }
  }

  return (
    <>
      {/* 导入配置选项 */}
      <div className="space-y-3 p-3 bg-muted/30 rounded-xl border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Header 版本</span>
            <span className="text-xs text-muted-foreground">(API 请求头格式)</span>
          </div>
          <div className="flex bg-muted/50 rounded-lg p-0.5">
            <button
              type="button"
              className={`px-3 py-1 text-xs rounded-md transition-all ${headerVersion === 1 ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => onHeaderVersionChange?.(1)}
            >
              V1
            </button>
            <button
              type="button"
              className={`px-3 py-1 text-xs rounded-md transition-all ${headerVersion === 2 ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => onHeaderVersionChange?.(2)}
            >
              V2
            </button>
          </div>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">自动刷新 Token</span>
            <span className="text-xs text-muted-foreground">(关闭则使用导入的 accessToken)</span>
          </div>
          <button
            type="button"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoRefreshToken ? 'bg-primary' : 'bg-muted'}`}
            onClick={() => onAutoRefreshTokenChange?.(!autoRefreshToken)}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${autoRefreshToken ? 'translate-x-4' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">同步到服务器</span>
            <span className="text-xs text-muted-foreground">(关闭则仅本地保存)</span>
          </div>
          <button
            type="button"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${syncToServer ? 'bg-primary' : 'bg-muted'}`}
            onClick={() => onSyncToServerChange?.(!syncToServer)}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${syncToServer ? 'translate-x-4' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
      </div>

      <div className="p-3 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
        <p className="text-xs text-blue-600 dark:text-blue-400">
          支持 JSON 数组格式。必填: <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">refreshToken</code>
          {!autoRefreshToken && <>, <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">accessToken</code></>}。<br/>
          可选: <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">provider</code> (BuilderId/Github/Google)、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">clientId</code>、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">clientIdHash</code>、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">clientSecret</code>、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">label</code> (昵称)、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">email</code>、
          <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">region</code>
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium flex items-center gap-2">
          JSON 凭证数据 <span className="text-destructive">*</span>
        </label>
        <textarea
          className="w-full min-h-[180px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono text-xs"
          placeholder={autoRefreshToken ? `[
  {
    "email": "user@example.com",
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientIdHash": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId",
    "region": "us-east-1",
    "label": "我的账号"
  }
]` : `[
  {
    "email": "user@example.com",
    "accessToken": "xxx",
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientIdHash": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId",
    "region": "us-east-1",
    "label": "我的账号"
  }
]`}
          value={data}
          onChange={(e) => onChange(e.target.value)}
        />
        {data.trim() && (
          isValidJson() 
            ? <p className="text-xs text-muted-foreground">已输入 {getCredentialCount()} 个凭证</p>
            : <p className="text-xs text-destructive">JSON 格式错误</p>
        )}
      </div>

      {/* 批量导入结果 */}
      {result && (
        <div className={`p-3 rounded-lg text-sm ${result.failed > 0 ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'}`}>
          <p className={`font-medium ${result.failed > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300'}`}>
            导入结果: 成功 {result.success}/{result.total}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-2 text-xs text-amber-600 dark:text-amber-400 space-y-0.5 max-h-20 overflow-y-auto">
              {result.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}