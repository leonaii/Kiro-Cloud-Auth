import { Info } from 'lucide-react'
import type { OAuthMode } from './types'

interface OAuthModeSelectorProps {
  oauthMode: OAuthMode
  onModeChange: (mode: OAuthMode) => void
}

export function OAuthModeSelector({ oauthMode, onModeChange }: OAuthModeSelectorProps) {
  return (
    <div className="px-2 mb-4">
      <div className="p-3 bg-muted/30 rounded-xl border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">登录模式</span>
          <div className="flex items-center gap-1">
            <Info className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">
              {oauthMode === 'deep-link' ? '推荐' : '备用'}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {/* 应用授权模式 - 推荐，放在前面 */}
          <button
            type="button"
            className={`flex-1 py-2 px-3 text-xs rounded-lg border transition-all ${
              oauthMode === 'deep-link'
                ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                : 'bg-background border-input hover:bg-muted hover:border-muted-foreground/30'
            }`}
            onClick={() => onModeChange('deep-link')}
          >
            <div className="font-medium">应用授权模式</div>
            <div className={`text-[10px] mt-0.5 ${oauthMode === 'deep-link' ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
              系统浏览器 + 协议回调
            </div>
          </button>
          {/* Web OAuth 无痕模式 - 备用 */}
          <button
            type="button"
            className={`flex-1 py-2 px-3 text-xs rounded-lg border transition-all ${
              oauthMode === 'web-oauth'
                ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                : 'bg-background border-input hover:bg-muted hover:border-muted-foreground/30'
            }`}
            onClick={() => onModeChange('web-oauth')}
          >
            <div className="font-medium">Web OAuth 无痕模式</div>
            <div className={`text-[10px] mt-0.5 ${oauthMode === 'web-oauth' ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
              内置浏览器窗口登录
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}