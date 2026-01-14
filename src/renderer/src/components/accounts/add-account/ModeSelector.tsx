import { Info } from 'lucide-react'
import type { ImportMode } from './types'

interface ModeSelectorProps {
  isWeb: boolean
  importMode: ImportMode
  onModeChange: (mode: ImportMode) => void
  disabled?: boolean
}

export function ModeSelector({ isWeb, importMode, onModeChange, disabled }: ModeSelectorProps) {
  if (isWeb) {
    return (
      <div className="p-3 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
          <p className="text-xs text-blue-600 dark:text-blue-400">
            Web 版本支持通过 OIDC 凭证添加账号。格式示例：<br/>
            <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">
              {'{"refreshToken":"xxx","authMethod":"social","provider":"Google"}'}
            </code>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-1 p-1 bg-muted/50 rounded-xl border">
      <button
        className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
          importMode === 'login'
            ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
            : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
        }`}
        onClick={() => onModeChange('login')}
        disabled={disabled}
      >
        在线登录
      </button>
      <button
        className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
          importMode === 'oidc'
            ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
            : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
        }`}
        onClick={() => onModeChange('oidc')}
        disabled={disabled}
      >
        OIDC 凭证
      </button>
      <button
        className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
          importMode === 'sso'
            ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
            : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
        }`}
        onClick={() => onModeChange('sso')}
        disabled={disabled}
      >
        SSO Token
      </button>
    </div>
  )
}