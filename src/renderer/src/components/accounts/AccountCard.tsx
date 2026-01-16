import { memo, useMemo, useState, useEffect } from 'react'
import { Card, CardContent, Badge, Progress } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import {
  Clock,
  Loader2,
  FolderOpen,
  AlertCircle,
  KeyRound,
  Fingerprint,
  Check,
  Trash2,
  RotateCcw
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isElectron } from '@/lib/api'
import { useMobile } from '@/hooks/use-mobile'

// 解析 ARGB 颜色转换为 CSS rgba
function toRgba(argbColor: string): string {
  let alpha = 255
  let rgb = argbColor
  if (argbColor.length === 9 && argbColor.startsWith('#')) {
    alpha = parseInt(argbColor.slice(1, 3), 16)
    rgb = '#' + argbColor.slice(3)
  }
  const hex = rgb.startsWith('#') ? rgb.slice(1) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
}

// 生成标签光环样式
function generateGlowStyle(tagColors: string[]): React.CSSProperties {
  if (tagColors.length === 0) return {}

  if (tagColors.length === 1) {
    const color = toRgba(tagColors[0])
    const colorTransparent = color.replace('1)', '0.15)')
    return {
      boxShadow: `0 0 0 1px ${color}, 0 4px 12px -2px ${colorTransparent}`
    }
  }

  const gradientColors = tagColors
    .map((c, i) => {
      const percent = (i / tagColors.length) * 100
      const nextPercent = ((i + 1) / tagColors.length) * 100
      return `${toRgba(c)} ${percent}%, ${toRgba(c)} ${nextPercent}%`
    })
    .join(', ')

  return {
    background: `linear-gradient(white, white) padding-box, linear-gradient(135deg, ${gradientColors}) border-box`,
    border: '1.5px solid transparent',
    boxShadow: '0 4px 12px -2px rgba(0, 0, 0, 0.05)'
  }
}

interface AccountCardProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  onSelect: () => void
  index?: number // 用于交错动画
}

const getSubscriptionColor = (type?: string | null, title?: string | null): string => {
  const text = (title || type || '').toUpperCase()
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS'))
    return 'bg-purple-500'
  if (text.includes('POWER')) return 'bg-amber-500'
  if (text.includes('PRO')) return 'bg-blue-500'
  return 'bg-gray-500'
}

// IDP 平台颜色配置
const getIdpColor = (idp?: string | null): string => {
  const idpLower = (idp || '').toLowerCase()
  if (idpLower.includes('google')) return 'bg-blue-500 text-white border-blue-500'
  if (idpLower.includes('builderid')) return 'bg-orange-500 text-white border-orange-500'
  if (idpLower.includes('github')) return 'bg-gray-700 text-white border-gray-700'
  return 'bg-muted/50 text-muted-foreground border-border' // 默认样式
}

const StatusLabels: Record<string, string> = {
  active: '正常',
  expired: '过期',
  error: '错误',
  refreshing: '刷新中',
  unknown: '未知',
  banned: '封禁'
}

// 倒计时 Hook
const useCountdown = (expiresAt: number | undefined) => {
  const [timeLeft, setTimeLeft] = useState<number>(0)

  useEffect(() => {
    if (!expiresAt) return

    const calculateTimeLeft = () => {
      const now = Date.now()
      const diff = expiresAt - now
      return Math.max(0, Math.floor(diff / 60000)) // 转换为分钟
    }

    setTimeLeft(calculateTimeLeft())

    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft())
    }, 60000) // 每分钟更新一次

    return () => clearInterval(timer)
  }, [expiresAt])

  return timeLeft
}

// 倒计时显示组件
const ExpiryCountdown: React.FC<{ expiresAt: number | undefined }> = ({ expiresAt }) => {
  const minutesLeft = useCountdown(expiresAt)

  if (!expiresAt) return <span className="text-gray-400">--</span>

  const isExpired = minutesLeft <= 0
  const isWarning = minutesLeft > 0 && minutesLeft <= 30 // 30分钟内警告
  const isCritical = minutesLeft > 0 && minutesLeft <= 10 // 10分钟内紧急

  return (
    <span
      className={`
        font-mono text-xs
        ${isExpired ? 'text-red-500' : ''}
        ${isCritical ? 'text-red-500 animate-pulse' : ''}
        ${isWarning && !isCritical ? 'text-yellow-500' : ''}
        ${!isExpired && !isWarning ? 'text-green-500' : ''}
      `}
    >
      {isExpired ? '已过期' : `${minutesLeft} 分钟`}
    </span>
  )
}

export const AccountCard = memo(function AccountCard({
  account,
  tags,
  groups,
  isSelected,
  onSelect,
  index = 0
}: AccountCardProps) {
  const {
    toggleSelection,
    maskEmail,
    accountMachineIds,
    localActiveAccountId
  } = useAccountsStore()

  const boundMachineId = accountMachineIds[account.id]
  const hasBoundMachineId = !!boundMachineId

  const accountTags = account.tags
    .map((id) => tags.get(id))
    .filter((t): t is AccountTag => t !== undefined)

  const accountGroup = account.groupId ? groups.get(account.groupId) : undefined

  const glowStyle = useMemo(() => {
    const tagColors = accountTags.map((t) => t.color)
    return generateGlowStyle(tagColors)
  }, [accountTags])

  // 免费试用包时效判断
  const freeTrialExpiry = account.usage?.freeTrialExpiry
    ? new Date(account.usage.freeTrialExpiry).getTime()
    : account.createdAt
      ? account.createdAt + 30 * 24 * 60 * 60 * 1000
      : undefined
  // 使用 Math.ceil 确保剩余时间不足 1 天但未过期时显示"1天"而不是"已过期"
  // 只有当差值 <= 0 时才真正过期
  const freeTrialDaysRemaining = freeTrialExpiry
    ? (() => {
        const diffMs = freeTrialExpiry - Date.now()
        if (diffMs <= 0) return 0  // 真正过期
        return Math.ceil(diffMs / (24 * 60 * 60 * 1000))  // 向上取整，不足1天显示1天
      })()
    : undefined
  const isExpiringSoon = freeTrialDaysRemaining !== undefined && freeTrialDaysRemaining <= 7
  const isHighUsage = account.usage.percentUsed > 80
  // 封禁状态判断：优先使用 status === 'banned'，兼容旧的 lastError 判断
  const isUnauthorized =
    account.status === 'banned' ||
    account.lastError?.includes('UnauthorizedException') ||
    account.lastError?.includes('AccountSuspendedException') ||
    account.lastError?.includes('BANNED:')

  // 已删除账号样式
  const isDeleted = account.isDel
  const deletedStyle: React.CSSProperties = isDeleted
    ? {
        backgroundColor: 'rgba(254, 226, 226, 0.3)',
        opacity: 0.7
      }
    : {}

  const unauthorizedStyle: React.CSSProperties = isUnauthorized
    ? {
        backgroundColor: 'var(--card-unauthorized-bg)',
        borderColor: 'var(--card-unauthorized-border)',
        boxShadow: `0 0 0 1px var(--card-unauthorized-ring), 0 4px 20px -2px var(--card-unauthorized-shadow)`
      }
    : {}

  const isActive = isElectron() && localActiveAccountId === account.id
  const showActiveStyle = isActive && !isDeleted
  const activeGlowStyle: React.CSSProperties = showActiveStyle
    ? {
        backgroundColor: 'var(--card-active-bg)',
        borderColor: 'var(--card-active-border)',
        boxShadow: `0 0 0 1px var(--card-active-ring), 0 8px 24px -4px var(--card-active-shadow), inset 3px 0 0 0 var(--card-active-accent)`
      }
    : {}

  let finalStyle: React.CSSProperties = {}
  if (isDeleted) {
    finalStyle = deletedStyle
  } else if (isUnauthorized) {
    finalStyle = unauthorizedStyle
  } else if (showActiveStyle) {
    finalStyle = { ...glowStyle, ...activeGlowStyle }
  } else {
    finalStyle = glowStyle
  }

  // 格式化删除时间
  const formatDeletedTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hour = date.getHours().toString().padStart(2, '0')
    const minute = date.getMinutes().toString().padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  }

  // 计算交错动画延迟类
  const staggerClass = index < 8 ? `stagger-${index + 1}` : ''

  const isMobile = useMobile()

  return (
    <Card
      className={cn(
        'relative cursor-pointer overflow-hidden border group h-full',
        // 动画效果
        'animate-slideUp hover-lift-sm',
        staggerClass,
        // 过渡效果
        'transition-all duration-300 ease-out',
        // 悬停效果
        'hover:shadow-lg hover:border-primary/30',
        // 状态样式
        isUnauthorized
          ? 'border-red-400/50 bg-red-50/50 dark:bg-red-900/10'
          : showActiveStyle
            ? 'border-transparent'
            : '',
        // 活跃账号动效边框
        showActiveStyle && 'active-account-border-themed',
        isSelected && !showActiveStyle && !isUnauthorized && 'bg-primary/5 ring-1 ring-primary/30',
        accountTags.length > 0 && !showActiveStyle && !isUnauthorized && 'border-transparent'
      )}
      style={finalStyle}
      onClick={() => toggleSelection(account.id)}
    >
      <CardContent className={cn(
        "h-full flex gap-3",
        isMobile ? "p-3 flex-col" : "p-4 md:p-5 items-center md:gap-5"
      )}>
        {/* 桌面端：Checkbox - 仅在 Web 端显示，Electron 客户端不需要多选 */}
        {!isMobile && !isElectron() && (
          <div
            className={cn(
              'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 cursor-pointer',
              'transition-all duration-200 ease-out',
              isDeleted
                ? 'bg-gray-400 border-gray-400 text-white'
                : isSelected
                  ? 'bg-primary border-primary text-primary-foreground scale-110'
                  : 'border-muted-foreground/30 hover:border-primary hover:scale-105'
            )}
            onClick={(e) => {
              e.stopPropagation()
              if (!isDeleted) onSelect()
            }}
          >
            {isDeleted ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : isSelected ? (
              <Check className="h-3.5 w-3.5 animate-scaleIn" />
            ) : null}
          </div>
        )}

        {/* 移动端顶部行：Checkbox + Email + Status */}
        {isMobile && (
          <div className="flex items-center gap-2 w-full">
            {/* Checkbox - 已删除账号显示垃圾桶图标，仅在 Web 端显示 */}
            {!isElectron() && (
              <div
                className={cn(
                  'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 cursor-pointer',
                  'transition-all duration-200 ease-out',
                  isDeleted
                    ? 'bg-gray-400 border-gray-400 text-white'
                    : isSelected
                      ? 'bg-primary border-primary text-primary-foreground scale-110'
                      : 'border-muted-foreground/30 hover:border-primary hover:scale-105'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isDeleted) onSelect()
                }}
              >
                {isDeleted ? (
                  <Trash2 className="h-3.5 w-3.5" />
                ) : isSelected ? (
                  <Check className="h-3.5 w-3.5 animate-scaleIn" />
                ) : null}
              </div>
            )}

            {/* Email */}
            <h3
              className={cn(
                "font-semibold text-sm truncate flex-1",
                isDeleted
                  ? "text-gray-500 line-through decoration-red-400 decoration-2"
                  : "text-foreground"
              )}
              title={account.email}
            >
              {maskEmail(account.email)}
            </h3>

            {/* Status Badge */}
            {isDeleted ? (
              <Badge className="bg-red-500 text-white text-xs h-5 px-2 border-0 flex items-center gap-1 animate-fadeIn shadow-sm shrink-0">
                <Trash2 className="h-3 w-3" />
                已删除
              </Badge>
            ) : (
              <div
                className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0',
                  'transition-all duration-200 shadow-sm border border-transparent',
                  isUnauthorized
                    ? 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30 border-red-200 dark:border-red-900/50'
                    : account.status === 'active'
                      ? 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30 border-green-200 dark:border-green-900/50'
                      : account.status === 'refreshing'
                        ? 'text-primary bg-primary/10 border-primary/20'
                        : 'text-muted-foreground bg-muted border-border'
                )}
              >
                {account.status === 'refreshing' && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {isUnauthorized && <AlertCircle className="h-3 w-3 animate-pulse-subtle" />}
                {isUnauthorized ? '封禁' : StatusLabels[account.status]}
              </div>
            )}
          </div>
        )}

        {/* 桌面端：完整布局 */}
        {!isMobile && (
          <div className="flex-1 min-w-0 flex items-center gap-5">
            {/* Email & Status */}
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-3">
                <h3
                  className={cn(
                    "font-semibold text-base truncate tracking-tight",
                    isDeleted
                      ? "text-gray-500 line-through decoration-red-400 decoration-2"
                      : "text-foreground"
                  )}
                  title={account.email}
                >
                  {maskEmail(account.email)}
                </h3>
                {/* Status Badge */}
                {isDeleted ? (
                  <Badge className="bg-red-500 text-white text-xs h-5 px-2 border-0 flex items-center gap-1 animate-fadeIn shadow-sm">
                    <Trash2 className="h-3 w-3" />
                    已删除
                  </Badge>
                ) : (
                  <div
                    className={cn(
                      'text-xs font-medium px-2.5 py-0.5 rounded-full flex items-center gap-1.5 flex-shrink-0',
                      'transition-all duration-200 shadow-sm border border-transparent',
                      isUnauthorized
                        ? 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30 border-red-200 dark:border-red-900/50'
                        : account.status === 'active'
                          ? 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30 border-green-200 dark:border-green-900/50'
                          : account.status === 'refreshing'
                            ? 'text-primary bg-primary/10 border-primary/20'
                            : 'text-muted-foreground bg-muted border-border'
                    )}
                  >
                    {account.status === 'refreshing' && (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    {isUnauthorized && <AlertCircle className="h-3 w-3 animate-pulse-subtle" />}
                    {isUnauthorized ? '封禁' : StatusLabels[account.status]}
                  </div>
                )}
              </div>
              {/* Second Row: Badges */}
              <div className="flex items-center flex-wrap gap-2">
              <Badge
                className={cn(
                  'text-white text-xs h-5 px-2.5 border-0 shadow-sm font-medium',
                  getSubscriptionColor(account.subscription.type, account.subscription.title)
                )}
              >
                {(account.subscription.title || account.subscription.type)?.replaceAll('KIRO ','')}
              </Badge>
              <Badge
                className={cn(
                  'text-xs h-5 px-2.5 font-medium border-0 shadow-sm',
                  getIdpColor(account.idp)
                )}
              >
                {account.idp}
              </Badge>
              {/* Header版本徽章 */}
              <Badge
                variant="outline"
                className={cn(
                  'h-5 text-xs font-medium',
                  account.headerVersion === 2
                    ? 'text-green-600 border-green-400/50 bg-green-50 dark:text-green-400 dark:bg-green-900/30 dark:border-green-600/30'
                    : 'text-gray-600 border-gray-400/50 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/30 dark:border-gray-600/30'
                )}
                title={`Header版本: ${account.headerVersion === 2 ? 'V2 (新端点)' : 'V1 (旧端点)'}`}
              >
                {account.headerVersion === 2 ? 'V2' : 'V1'}
              </Badge>
              {accountGroup && (
                <span
                  className="text-xs px-2.5 py-0.5 rounded-full flex items-center gap-1.5 font-medium border border-transparent"
                  style={{
                    color: accountGroup.color,
                    backgroundColor: accountGroup.color + '15',
                    borderColor: accountGroup.color + '30'
                  }}
                >
                  <FolderOpen className="w-3 h-3" />
                  {accountGroup.name}
                </span>
              )}
              {hasBoundMachineId && (
                <Badge
                  variant="outline"
                  className="h-5 text-xs text-cyan-600 border-cyan-400/50 bg-cyan-50 dark:text-cyan-400 dark:bg-cyan-900/30 dark:border-cyan-600/30 gap-1"
                  title={`机器码: ${boundMachineId}`}
                >
                  <Fingerprint className="h-3 w-3" />
                </Badge>
              )}
              {accountTags.slice(0, 2).map((tag) => (
                <span
                  key={tag.id}
                  className="px-2.5 py-0.5 text-xs rounded-full text-white font-medium shadow-sm"
                  style={{ backgroundColor: toRgba(tag.color) }}
                >
                  {tag.name}
                </span>
              ))}
              {accountTags.length > 2 && (
                <span className="text-xs text-muted-foreground font-medium px-1">+{accountTags.length - 2}</span>
              )}
              {/* Error Badge */}
              {account.lastError && !isUnauthorized && (
                <Badge
                  variant="destructive"
                  className="h-5 text-xs px-2 gap-1 max-w-[180px] bg-red-100 text-red-600 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900/50 hover:bg-red-200 dark:hover:bg-red-900/50"
                  title={account.lastError}
                >
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{account.lastError}</span>
                  </Badge>
                )}
              </div>
            </div>

            {/* Usage & Time Container */}
            <div className="flex items-center gap-4">
              {/* Usage Progress */}
              <div className="w-36 bg-muted/30 p-3 rounded-lg border border-border/50">
                <div className="flex justify-between items-center text-xs mb-2">
                  <span className="text-muted-foreground font-medium">使用量</span>
                  <span className={cn(
                    'font-mono font-bold transition-colors duration-300',
                    isHighUsage ? 'text-amber-600 dark:text-amber-400' : 'text-primary'
                  )}>
                    {(account.usage.percentUsed * 100).toFixed(0)}%
                  </span>
                </div>
                <Progress
                  value={account.usage.percentUsed * 100}
                  className="h-1.5 bg-muted"
                  indicatorClassName={cn(
                    isHighUsage ? 'bg-amber-500' : 'bg-primary',
                    'transition-all duration-500 ease-out'
                  )}
                />
                <div className="flex justify-between items-center mt-2 text-[10px] text-muted-foreground">
                  <span className="font-mono">{account.usage.current} / {account.usage.limit}</span>
                  <span className="text-blue-600 dark:text-blue-400 font-medium" title="API 调用次数">
                    API: {account.apiCallCount ?? 0}
                  </span>
                </div>
              </div>

              {/* Time Info */}
              <div className="flex-shrink-0 text-xs text-muted-foreground space-y-2 w-24 text-right">
                {isDeleted ? (
                  <div className="flex items-center justify-end gap-1.5 text-red-600" title="删除时间">
                    <Trash2 className="h-3.5 w-3.5" />
                    <span className="font-medium">
                      {account.deletedAt ? formatDeletedTime(account.deletedAt) : '-'}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-end gap-1.5" title="免费试用包时效">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground/70" />
                      <span className={cn(
                        "font-medium",
                        isExpiringSoon ? 'text-amber-600 dark:text-amber-400' : ''
                      )}>
                        {freeTrialDaysRemaining !== undefined
                          ? freeTrialDaysRemaining <= 0
                            ? '已过期'
                            : `${freeTrialDaysRemaining}天`
                          : '-'}
                      </span>
                    </div>
                    <div
                      className="flex items-center justify-end gap-1.5"
                      title={
                        account.credentials.expiresAt
                          ? new Date(account.credentials.expiresAt).toLocaleString('zh-CN')
                          : '未知'
                      }
                    >
                      <KeyRound className="h-3.5 w-3.5 text-muted-foreground/70" />
                      <ExpiryCountdown expiresAt={account.credentials.expiresAt} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 移动端：紧凑布局 */}
        {isMobile && (
          <>
            {/* Badges Row */}
            <div className="flex items-center flex-wrap gap-1.5">
              <Badge
                className={cn(
                  'text-white text-xs h-5 px-2 border-0 shadow-sm font-medium',
                  getSubscriptionColor(account.subscription.type, account.subscription.title)
                )}
              >
                {(account.subscription.title || account.subscription.type)?.replaceAll('KIRO ','')}
              </Badge>
              <Badge
                className={cn(
                  'text-xs h-5 px-2 font-medium border-0 shadow-sm',
                  getIdpColor(account.idp)
                )}
              >
                {account.idp}
              </Badge>
              {/* Header版本徽章 - 移动端 */}
              <Badge
                variant="outline"
                className={cn(
                  'h-5 text-xs font-medium',
                  account.headerVersion === 2
                    ? 'text-green-600 border-green-400/50 bg-green-50 dark:text-green-400 dark:bg-green-900/30'
                    : 'text-gray-600 border-gray-400/50 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/30'
                )}
                title={`Header版本: ${account.headerVersion === 2 ? 'V2' : 'V1'}`}
              >
                {account.headerVersion === 2 ? 'V2' : 'V1'}
              </Badge>
              {accountGroup && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1 font-medium border border-transparent"
                  style={{
                    color: accountGroup.color,
                    backgroundColor: accountGroup.color + '15',
                    borderColor: accountGroup.color + '30'
                  }}
                >
                  <FolderOpen className="w-3 h-3" />
                  {accountGroup.name}
                </span>
              )}
              {hasBoundMachineId && (
                <Badge
                  variant="outline"
                  className="h-5 text-xs text-cyan-600 border-cyan-400/50 bg-cyan-50 dark:text-cyan-400 dark:bg-cyan-900/30 dark:border-cyan-600/30 gap-1"
                  title={`机器码: ${boundMachineId}`}
                >
                  <Fingerprint className="h-3 w-3" />
                </Badge>
              )}
              {accountTags.slice(0, 2).map((tag) => (
                <span
                  key={tag.id}
                  className="px-2 py-0.5 text-xs rounded-full text-white font-medium shadow-sm"
                  style={{ backgroundColor: toRgba(tag.color) }}
                >
                  {tag.name}
                </span>
              ))}
              {accountTags.length > 2 && (
                <span className="text-xs text-muted-foreground font-medium">+{accountTags.length - 2}</span>
              )}
            </div>

            {/* Usage & Time Row */}
            <div className="flex items-center gap-2 mt-auto">
              {/* Usage Progress - 紧凑版 */}
              <div className="flex-1 bg-muted/30 p-2 rounded-lg border border-border/50">
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="text-muted-foreground text-[10px]">使用量</span>
                  <span className={cn(
                    'font-mono text-xs font-bold',
                    isHighUsage ? 'text-amber-600' : 'text-primary'
                  )}>
                    {(account.usage.percentUsed * 100).toFixed(0)}%
                  </span>
                </div>
                <Progress
                  value={account.usage.percentUsed * 100}
                  className="h-1 bg-muted"
                  indicatorClassName={cn(
                    isHighUsage ? 'bg-amber-500' : 'bg-primary'
                  )}
                />
                <div className="flex justify-between items-center mt-1 text-[10px] text-muted-foreground">
                  <span className="font-mono">{account.usage.current}/{account.usage.limit}</span>
                  <span className="text-blue-600 dark:text-blue-400">API:{account.apiCallCount ?? 0}</span>
                </div>
              </div>

              {/* Time Info - 紧凑版 */}
              <div className="text-[10px] text-muted-foreground space-y-1 text-right shrink-0">
                {isDeleted ? (
                  <div className="flex items-center justify-end gap-1 text-red-600">
                    <Trash2 className="h-3 w-3" />
                    <span>{account.deletedAt ? formatDeletedTime(account.deletedAt) : '-'}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-end gap-1" title="试用期">
                      <Clock className="h-3 w-3" />
                      <span className={isExpiringSoon ? 'text-amber-600' : ''}>
                        {freeTrialDaysRemaining !== undefined
                          ? freeTrialDaysRemaining <= 0 ? '过期' : `${freeTrialDaysRemaining}天`
                          : '-'}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-1" title="Token">
                      <KeyRound className="h-3 w-3" />
                      <ExpiryCountdown expiresAt={account.credentials.expiresAt} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* 操作按钮已整合到右键菜单 */}

        {/* Error indicator (Small dot for collapsed view or extra visibility) */}
        {account.lastError && !isUnauthorized && (
          <div
            className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-bl-lg shadow-sm"
          />
        )}
      </CardContent>
    </Card>
  )
})
