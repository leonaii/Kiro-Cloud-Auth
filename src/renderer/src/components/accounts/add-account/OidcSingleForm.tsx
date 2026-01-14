import { Button } from '../../ui'
import { Loader2 } from 'lucide-react'

interface OidcCredentials {
  refreshToken: string
  clientId: string
  clientSecret: string
  region: string
  authMethod: 'IdC' | 'social'
  provider: string
}

interface OidcSingleFormProps {
  oidcCredentials: OidcCredentials
  onCredentialsChange: (credentials: OidcCredentials) => void
  selectedRegion: string
  onRegionChange: (region: string) => void
  isLoading: boolean
  onImport: () => void
}

export function OidcSingleForm({
  oidcCredentials,
  onCredentialsChange,
  selectedRegion,
  onRegionChange,
  isLoading,
  onImport
}: OidcSingleFormProps) {
  const { refreshToken, clientId, clientSecret, authMethod, provider } = oidcCredentials
  return (
    <div className="space-y-4">
      {/* 登录类型选择 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">登录类型</label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'IdC' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
            onClick={() => onCredentialsChange({ ...oidcCredentials, authMethod: 'IdC' })}
          >
            Builder ID (IdC)
          </button>
          <button
            type="button"
            className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'social' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
            onClick={() => onCredentialsChange({ ...oidcCredentials, authMethod: 'social' })}
          >
            GitHub / Google
          </button>
        </div>
        {authMethod === 'social' && (
          <p className="text-xs text-muted-foreground">
            社交登录不需要 Client ID 和 Client Secret
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          Refresh Token <span className="text-destructive">*</span>
        </label>
        <textarea
          className="w-full min-h-[80px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
          placeholder="粘贴 Refresh Token..."
          value={refreshToken}
          onChange={(e) => onCredentialsChange({ ...oidcCredentials, refreshToken: e.target.value })}
        />
      </div>

      {/* IdC 登录需要 Client ID、Client Secret 和 Region */}
      {authMethod !== 'social' && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Client ID <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => onCredentialsChange({ ...oidcCredentials, clientId: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Client Secret <span className="text-destructive">*</span>
              </label>
              <input
                type="password"
                className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                placeholder="Client Secret"
                value={clientSecret}
                onChange={(e) => onCredentialsChange({ ...oidcCredentials, clientSecret: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">AWS Region</label>
            <select
              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              value={selectedRegion}
              onChange={(e) => {
                onRegionChange(e.target.value)
                onCredentialsChange({ ...oidcCredentials, region: e.target.value })
              }}
            >
              <option value="us-east-1">us-east-1 (N. Virginia)</option>
              <option value="us-west-2">us-west-2 (Oregon)</option>
              <option value="eu-west-1">eu-west-1 (Ireland)</option>
            </select>
          </div>
        </>
      )}
    </div>
  )
}