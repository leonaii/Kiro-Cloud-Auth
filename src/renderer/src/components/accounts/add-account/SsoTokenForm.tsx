import { Info, Loader2 } from 'lucide-react'
import { Button } from '../../ui'
import type { ImportResult } from './types'

interface SsoTokenFormProps {
  ssoToken: string
  region: string
  isVerifying: boolean
  batchImportResult: ImportResult | null
  onTokenChange: (value: string) => void
  onRegionChange: (value: string) => void
  onImport: () => void
}

export function SsoTokenForm({
  ssoToken,
  region,
  isVerifying,
  batchImportResult,
  onTokenChange,
  onRegionChange,
  onImport
}: SsoTokenFormProps) {
  const tokenCount = ssoToken.split('\n').filter(t => t.trim()).length

  return (
    <div className="space-y-5">
      <div className="p-4 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
            <Info className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-700 dark:text-blue-300 mb-1.5">如何获取 Token?</p>
            <ol className="text-xs text-blue-600/90 dark:text-blue-400/90 list-decimal list-inside space-y-1.5">
              <li>在浏览器中访问并登录: <a href="https://view.awsapps.com/start/#/device?user_code=PQCF-FCCN" target="_blank" rel="noreferrer" className="underline hover:text-blue-800 font-medium">view.awsapps.com/start/#/device?user_code=PQCF-FCCN</a></li>
              <li>按 F12 打开开发者工具 → Application → Cookies</li>
              <li>找到并复制 <code className="px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40 rounded font-mono text-[10px]">x-amz-sso_authn</code> 的值</li>
            </ol>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-1">
            x-amz-sso_authn <span className="text-destructive">*</span>
            <span className="text-xs text-muted-foreground font-normal ml-2">支持批量导入，每行一个 Token</span>
          </label>
          <textarea
            className="w-full min-h-[120px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
            placeholder="粘贴 Token 内容，每行一个&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2..."
            value={ssoToken}
            onChange={(e) => onTokenChange(e.target.value)}
          />
          {ssoToken.trim() && (
            <p className="text-xs text-muted-foreground">
              已输入 {tokenCount} 个 Token
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">AWS Region</label>
          <select
            className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            value={region}
            onChange={(e) => onRegionChange(e.target.value)}
          >
            <option value="us-east-1">us-east-1 (N. Virginia)</option>
            <option value="us-west-2">us-west-2 (Oregon)</option>
            <option value="eu-west-1">eu-west-1 (Ireland)</option>
          </select>
        </div>
      </div>

      {/* 批量导入结果 */}
      {batchImportResult && (
        <div className={`p-3 rounded-lg text-sm ${batchImportResult.failed > 0 ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'}`}>
          <p className={`font-medium ${batchImportResult.failed > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300'}`}>
            导入结果: 成功 {batchImportResult.success}/{batchImportResult.total}
          </p>
          {batchImportResult.errors.length > 0 && (
            <ul className="mt-2 text-xs text-amber-600 dark:text-amber-400 space-y-0.5 max-h-20 overflow-y-auto">
              {batchImportResult.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Button
        type="button"
        className="w-full h-11 text-sm font-medium rounded-xl shadow-sm"
        onClick={onImport}
        disabled={isVerifying || !ssoToken.trim()}
      >
        {isVerifying ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            正在并发导入 {tokenCount} 个账号...
          </>
        ) : (
          tokenCount > 1 ? `批量导入 ${tokenCount} 个账号` : '导入并验证'
        )}
      </Button>
    </div>
  )
}