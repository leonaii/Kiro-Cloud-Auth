import { createPortal } from 'react-dom'
import { useState } from 'react'
import { X, RefreshCw, User, CreditCard, Key, Copy, Check, ChevronDown, ChevronUp, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import type { Account } from '@/types/account'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'

interface AccountDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
  onRefresh?: () => void
  isRefreshing?: boolean
}

/**
 * 判断时间戳是否为秒级（API 返回的是秒级时间戳）
 * 如果值小于 10000000000（即 2001 年之前的毫秒数），认为是秒级
 */
const isSecondsTimestamp = (ts: number): boolean => {
  return ts > 0 && ts < 10000000000
}

/**
 * 将时间戳转换为毫秒级
 * 返回 null 表示无效时间戳（undefined、null、0 或负数）
 */
const toMilliseconds = (ts: number | undefined | null): number | null => {
  if (ts === undefined || ts === null || ts === 0 || ts < 0) return null
  // 如果是秒级时间戳（小于 10000000000），转换为毫秒
  return isSecondsTimestamp(ts) ? ts * 1000 : ts
}

// 格式化日期（支持秒级和毫秒级时间戳）
// 当值为 undefined、null、0 或无效时返回 "-"
const formatDate = (date: unknown): string => {
  if (date === undefined || date === null) return '-'
  if (date === 0) return '-' // 0 表示无效时间戳
  try {
    if (typeof date === 'string') {
      // 空字符串返回 "-"
      if (!date.trim()) return '-'
      return date.split('T')[0]
    }
    if (date instanceof Date) {
      // 检查是否是有效日期
      if (isNaN(date.getTime())) return '-'
      return date.toISOString().split('T')[0]
    }
    // 处理秒级时间戳
    const ts = date as number
    // 负数或非常小的数视为无效
    if (ts < 0) return '-'
    const ms = toMilliseconds(ts)
    if (!ms) return '-'
    const d = new Date(ms)
    // 检查转换后的日期是否有效
    if (isNaN(d.getTime())) return '-'
    return d.toISOString().split('T')[0]
  } catch {
    return '-'
  }
}

// 格式化完整日期时间（支持秒级和毫秒级时间戳）
// 当值为 undefined、null、0 或无效时返回 "-"
const formatDateTime = (date: unknown): string => {
  if (date === undefined || date === null) return '-'
  if (date === 0) return '-' // 0 表示无效时间戳
  try {
    let d: Date
    if (typeof date === 'string') {
      // 空字符串返回 "-"
      if (!date.trim()) return '-'
      d = new Date(date)
    } else if (date instanceof Date) {
      d = date
    } else {
      const ts = date as number
      // 负数视为无效
      if (ts < 0) return '-'
      const ms = toMilliseconds(ts)
      if (!ms) return '-'
      d = new Date(ms)
    }
    // 检查日期是否有效
    if (isNaN(d.getTime())) return '-'
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return '-'
  }
}

export function AccountDetailDialog({
  open,
  onOpenChange,
  account,
  onRefresh,
  isRefreshing
}: AccountDetailDialogProps) {
  const [showTokens, setShowTokens] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const { maskEmail, maskNickname, privacyMode } = useAccountsStore()

  if (!open || !account) return null

  const usage = account.usage
  const subscription = account.subscription
  const credentials = account.credentials

  // 计算奖励总计
  const bonusTotal = usage.bonuses?.reduce((sum, b) => sum + b.limit, 0) ?? 0
  const bonusUsed = usage.bonuses?.reduce((sum, b) => sum + b.current, 0) ?? 0

  // 复制到剪贴板
  const handleCopy = (text: string | undefined, field: string) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopied(field)
    setTimeout(() => setCopied(null), 1500)
  }

  // 判断账号类型（不区分大小写，支持下划线变体如 BUILDER_ID）
  const normalizedIdp = account.idp?.toUpperCase().replace(/_/g, '') || ''
  const isSocialAuth = normalizedIdp === 'GOOGLE' || normalizedIdp === 'GITHUB'
  const isIdCAuth = normalizedIdp === 'BUILDERID' || normalizedIdp === 'AWSIDC'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4 animate-in zoom-in-95 duration-200 border">
        {/* 头部 */}
        <div className="sticky top-0 bg-background/95 backdrop-blur z-20 border-b p-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shadow-inner">
              <User className="h-6 w-6 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg">{maskEmail(account.email)}</span>
                <Badge className="bg-primary hover:bg-primary/90 text-white shadow-sm">
                  {subscription.title || subscription.type}
                </Badge>
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                 <span className="px-1.5 py-0.5 bg-muted rounded-md font-medium">{account.idp}</span>
                 <span>·</span>
                 <span>添加于 {formatDate(account.createdAt)}</span>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="rounded-full hover:bg-muted">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-8">
          {/* 配额总览 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
                <CreditCard className="h-5 w-5 text-primary" />
                配额总览
              </h3>
              {onRefresh && (
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing} className="h-8 rounded-lg">
                  <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isRefreshing && "animate-spin")} />
                  刷新数据
                </Button>
              )}
            </div>

            <div className="bg-muted/30 border rounded-xl p-5 space-y-4">
               {/* 总使用量 */}
               <div>
                 <div className="flex items-end justify-between mb-2">
                   <div className="space-y-1">
                     <div className="text-sm text-muted-foreground font-medium">总使用量</div>
                     <div className="flex items-baseline gap-1.5">
                       <span className="text-3xl font-bold tracking-tight text-foreground">{usage.current.toLocaleString()}</span>
                       <span className="text-lg text-muted-foreground font-medium">/ {usage.limit.toLocaleString()}</span>
                     </div>
                   </div>
                   <div className={cn(
                     "text-sm font-semibold px-2.5 py-1 rounded-lg",
                     usage.percentUsed > 0.9 ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : 
                     "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                   )}>
                     {(usage.percentUsed * 100).toFixed(1)}% 已使用
                   </div>
                 </div>
                 <Progress value={usage.percentUsed * 100} className="h-3 rounded-full" indicatorClassName={usage.percentUsed > 0.9 ? "bg-red-500" : "bg-primary"} />
               </div>

               <div className="grid grid-cols-3 gap-4 pt-2">
                 {/* 主配额 */}
                 <div className="p-4 bg-background rounded-xl border shadow-sm">
                   <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400 mb-2">
                     <div className="w-2 h-2 rounded-full bg-blue-500" />
                     主配额
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {usage.baseCurrent ?? 0} <span className="text-sm text-muted-foreground font-normal">/ {usage.baseLimit ?? 0}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {formatDate(usage.nextResetDate)} 重置
                   </div>
                 </div>
                 
                 {/* 免费试用 */}
                 <div className={cn("p-4 bg-background rounded-xl border shadow-sm", (usage.freeTrialLimit ?? 0) === 0 && "opacity-60 grayscale")}>
                   <div className="flex items-center gap-2 text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">
                     <div className="w-2 h-2 rounded-full bg-purple-500" />
                     免费试用
                     {(usage.freeTrialLimit ?? 0) > 0 && <Badge variant="secondary" className="text-[10px] px-1 h-4 ml-auto">ACTIVE</Badge>}
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {usage.freeTrialCurrent ?? 0} <span className="text-sm text-muted-foreground font-normal">/ {usage.freeTrialLimit ?? 0}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {usage.freeTrialExpiry ? `${formatDate(usage.freeTrialExpiry)} 过期` : '无试用额度'}
                   </div>
                 </div>

                 {/* 奖励总计 */}
                 <div className={cn("p-4 bg-background rounded-xl border shadow-sm", bonusTotal === 0 && "opacity-60 grayscale")}>
                   <div className="flex items-center gap-2 text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-2">
                     <div className="w-2 h-2 rounded-full bg-cyan-500" />
                     奖励总计
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {bonusUsed} <span className="text-sm text-muted-foreground font-normal">/ {bonusTotal}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {usage.bonuses?.length ?? 0} 个生效奖励
                   </div>
                 </div>
               </div>
            </div>
          </section>

          {/* 奖励详情 */}
          {usage.bonuses && usage.bonuses.length > 0 && (
            <section className="space-y-3">
              <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wider pl-1">生效奖励明细</h3>
              <div className="grid grid-cols-1 gap-2">
                {usage.bonuses.map((bonus) => (
                  <div key={bonus.code} className="flex items-center justify-between p-4 bg-background border rounded-xl shadow-sm hover:shadow-md transition-shadow">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{bonus.name}</span>
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-green-600 border-green-200 bg-green-50">
                          ACTIVE
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        Code: {bonus.code} · {formatDateTime(bonus.expiresAt)} 过期
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold">{bonus.current} <span className="text-muted-foreground font-normal">/ {bonus.limit}</span></div>
                      <div className="text-[10px] text-blue-600 font-medium">
                         已用 {((bonus.current / bonus.limit) * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 基本信息 */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
              <User className="h-5 w-5 text-primary" />
              基本信息
            </h3>
            <div className="bg-muted/30 border rounded-xl p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">邮箱地址</label>
                  <div className="text-sm font-mono break-all select-all">{maskEmail(account.email)}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">账号别名</label>
                  <div className="text-sm font-medium">{maskNickname(account.nickname) || '-'}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">身份提供商</label>
                  <div className="text-sm font-medium">{account.idp}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">用户 ID</label>
                  <div className="text-xs font-mono break-all bg-background p-2 rounded border select-all">{privacyMode ? '********' : (account.userId?.slice(-12) || '-')}</div>
                </div>
              </div>
            </div>
          </section>

          {/* Header版本信息 */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
              <Shield className="h-5 w-5 text-primary" />
              Header版本信息
            </h3>
            <div className="bg-muted/30 border rounded-xl p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Header版本</label>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={cn(
                        'text-sm font-bold',
                        account.headerVersion === 2
                          ? 'bg-green-500 text-white'
                          : 'bg-gray-500 text-white'
                      )}
                    >
                      {account.headerVersion === 2 ? 'V2 (新端点)' : 'V1 (旧端点)'}
                    </Badge>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">端点URL</label>
                  <div className="text-xs font-mono bg-background p-2 rounded border break-all">
                    {account.headerVersion === 2
                      ? `q.${credentials.region || 'us-east-1'}.amazonaws.com`
                      : `codewhisperer.${credentials.region || 'us-east-1'}.amazonaws.com`}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">SDK版本</label>
                  <div className="text-sm font-mono bg-background p-2 rounded border">
                    {account.sdkJsVersion || '-'}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">IDE版本</label>
                  <div className="text-sm font-mono bg-background p-2 rounded border">
                    {account.ideVersion || '-'}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Invocation ID (32位UUID)</label>
                <div className="text-xs font-mono bg-background p-2 rounded border break-all select-all">
                  {account.amzInvocationId || '-'}
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Device Hash (64位)</label>
                <div className="text-xs font-mono bg-background p-2 rounded border break-all select-all">
                  {account.kiroDeviceHash || '-'}
                </div>
              </div>
            </div>
          </section>

          {/* 订阅详情 */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
              <CreditCard className="h-5 w-5 text-primary" />
              订阅详情
            </h3>
            <div className="bg-muted/30 border rounded-xl p-4 text-sm">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">Region</span>
                  <Badge variant="outline" className="font-mono text-xs">{credentials.region || 'us-east-1'}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">Token 到期</span>
                  <span className="font-medium text-xs">{credentials.expiresAt ? formatDateTime(credentials.expiresAt) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">订阅类型</span>
                  <span className="font-mono text-xs truncate max-w-[100px]" title={subscription.rawType}>{subscription.rawType || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">超额费率</span>
                  <span className="font-mono text-xs">
                    {usage.resourceDetail?.overageRate
                      ? `$${usage.resourceDetail.overageRate}/${usage.resourceDetail.unit || 'INV'}`
                      : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">资源类型</span>
                  <span className="font-mono text-xs">{usage.resourceDetail?.resourceType || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">可升级</span>
                  <span className={cn("text-xs font-bold", subscription.upgradeCapability === 'UPGRADE_CAPABLE' ? "text-green-600" : "text-muted-foreground")}>
                    {subscription.upgradeCapability === 'UPGRADE_CAPABLE' ? 'YES' : 'NO'}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Token 凭证（可折叠） */}
          <section className="space-y-3">
            <div
              className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded-lg p-2 -m-2 transition-colors"
              onClick={() => setShowTokens(!showTokens)}
            >
              <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
                <Key className="h-5 w-5 text-primary" />
                Token 凭证
              </h3>
              <div className="flex items-center gap-2 text-muted-foreground">
                {credentials.expiresAt && (
                  <span className="text-xs">{formatDateTime(credentials.expiresAt)}</span>
                )}
                {showTokens ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </div>
            </div>
            
            {showTokens && (
              <div className="bg-muted/30 border rounded-xl p-4 space-y-4">
                {/* Access Token */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Access Token</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleCopy(privacyMode ? undefined : credentials.accessToken, 'access')}
                      disabled={privacyMode}
                    >
                      {copied === 'access' ? <Check className="h-3 w-3 text-green-500 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                      {copied === 'access' ? '已复制' : '复制'}
                    </Button>
                  </div>
                  <textarea
                    value={privacyMode ? '********' : (credentials.accessToken || '')}
                    readOnly
                    className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg resize-none h-14"
                    placeholder={isIdCAuth ? 'aoa...' : 'eyJ...'}
                  />
                </div>

                {/* Refresh Token */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Refresh Token</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleCopy(privacyMode ? undefined : credentials.refreshToken, 'refresh')}
                      disabled={privacyMode || !credentials.refreshToken}
                    >
                      {copied === 'refresh' ? <Check className="h-3 w-3 text-green-500 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                      {copied === 'refresh' ? '已复制' : '复制'}
                    </Button>
                  </div>
                  <textarea
                    value={privacyMode ? '********' : (credentials.refreshToken || '')}
                    readOnly
                    className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg resize-none h-14"
                    placeholder={isIdCAuth ? 'aor...' : 'refresh token'}
                  />
                </div>

                {/* CSRF Token */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">CSRF Token</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleCopy(privacyMode ? undefined : credentials.csrfToken, 'csrf')}
                      disabled={privacyMode || !credentials.csrfToken}
                    >
                      {copied === 'csrf' ? <Check className="h-3 w-3 text-green-500 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                      {copied === 'csrf' ? '已复制' : '复制'}
                    </Button>
                  </div>
                  <input
                    type="text"
                    value={privacyMode ? '********' : (credentials.csrfToken || '-')}
                    readOnly
                    className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg"
                  />
                </div>

                {/* IdC (BuilderId) 专用字段 */}
                {isIdCAuth && (
                  <div className="pt-3 border-t space-y-3">
                    <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Shield className="h-3 w-3" />
                      SSO 凭证 (BuilderId/IdC)
                    </div>
                    
                    {/* Client ID */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground">Client ID</label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-xs"
                          onClick={() => handleCopy(privacyMode ? undefined : credentials.clientId, 'clientId')}
                          disabled={privacyMode || !credentials.clientId}
                        >
                          {copied === 'clientId' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                        </Button>
                      </div>
                      <input
                        type="text"
                        value={privacyMode ? '********' : (credentials.clientId || '-')}
                        readOnly
                        className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                      />
                    </div>

                    {/* Client Secret */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground">Client Secret</label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-xs"
                          onClick={() => handleCopy(privacyMode ? undefined : credentials.clientSecret, 'clientSecret')}
                          disabled={privacyMode || !credentials.clientSecret}
                        >
                          {copied === 'clientSecret' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                        </Button>
                      </div>
                      <textarea
                        value={privacyMode ? '********' : (credentials.clientSecret || '')}
                        readOnly
                        className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg resize-none h-14 opacity-60"
                      />
                    </div>

                    {/* Region */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Region</label>
                        <input
                          type="text"
                          value={credentials.region || 'us-east-1'}
                          readOnly
                          className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Auth Method</label>
                        <input
                          type="text"
                          value={credentials.authMethod || 'IdC'}
                          readOnly
                          className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Social (Google/Github) 专用字段 */}
                {isSocialAuth && (
                  <div className="pt-3 border-t space-y-3">
                    <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Shield className="h-3 w-3" />
                      社交登录凭证 ({account.idp})
                    </div>
                    
                    {/* Visitor ID */}
                    {account.visitorId && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs text-muted-foreground">Visitor ID</label>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-xs"
                            onClick={() => handleCopy(privacyMode ? undefined : account.visitorId, 'visitorId')}
                            disabled={privacyMode || !account.visitorId}
                          >
                            {copied === 'visitorId' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                          </Button>
                        </div>
                        <input
                          type="text"
                          value={privacyMode ? '********' : (account.visitorId || '-')}
                          readOnly
                          className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                        />
                      </div>
                    )}
                    
                    {/* Auth Method & Provider */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Auth Method</label>
                        <input
                          type="text"
                          value={credentials.authMethod || 'social'}
                          readOnly
                          className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Provider</label>
                        <input
                          type="text"
                          value={credentials.provider || account.idp}
                          readOnly
                          className="w-full px-3 py-2 text-xs font-mono bg-background border rounded-lg opacity-60"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}
