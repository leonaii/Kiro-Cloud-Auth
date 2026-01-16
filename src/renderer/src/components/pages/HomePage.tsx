import { useMemo } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '../ui'
import { Users, CheckCircle, AlertTriangle, Clock, Zap, Shield, Fingerprint, FolderPlus, Tag, TrendingUp, Activity, BarChart3 } from 'lucide-react'
import kiroLogo from '@/assets/icon.png'
import { cn } from '@/lib/utils'

// 订阅类型颜色映射
const getSubscriptionColor = (type?: string | null, title?: string | null): string => {
  const text = (title || type || '').toUpperCase()
  // KIRO PRO+ / PRO_PLUS - 紫色
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS')) return 'bg-purple-500'
  // KIRO POWER - 金色
  if (text.includes('POWER')) return 'bg-amber-500'
  // KIRO PRO - 蓝色
  if (text.includes('PRO')) return 'bg-blue-500'
  // KIRO FREE - 灰色
  return 'bg-gray-500'
}

export function HomePage(): React.ReactNode {
  const { accounts, getStats, darkMode } = useAccountsStore()
  const stats = getStats()

  // 计算额度统计
  const usageStats = useMemo(() => {
    let totalLimit = 0
    let totalUsed = 0
    let validAccountCount = 0

    Array.from(accounts.values()).forEach(account => {
      // 只统计正常状态且未软删除的账号
      if (account.status === 'active' && !account.isDel && account.usage) {
        const limit = account.usage.limit ?? 0
        const used = account.usage.current ?? 0
        if (limit > 0) {
          totalLimit += limit
          totalUsed += used
          validAccountCount++
        }
      }
    })

    const remaining = totalLimit - totalUsed
    const percentUsed = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0

    return {
      totalLimit,
      totalUsed,
      remaining,
      percentUsed,
      validAccountCount
    }
  }, [accounts])

  const statCards = [
    {
      label: '总账号数',
      value: stats.total,
      icon: Users,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10'
    },
    {
      label: '正常账号',
      value: stats.activeCount,
      icon: CheckCircle,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10'
    },
    {
      label: '已封禁',
      value: stats.byStatus?.banned || 0,
      icon: AlertTriangle,
      color: 'text-red-500',
      bgColor: 'bg-red-500/10'
    },
  ]

  // 获取当前活跃账号
  const activeAccount = Array.from(accounts.values()).find(a => a.isActive)

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <PageHeader
        title="数据统计"
        description="管理你的 Kiro IDE 账号，一键切换，高效开发"
        icon={
          <img
            src={kiroLogo}
            alt="Kiro"
            className={cn(
              "h-10 w-auto transition-all duration-300 hover:scale-105 drop-shadow-lg",
              darkMode && "invert brightness-0"
            )}
          />
        }
        className="animate-fadeIn"
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-4 max-w-4xl mx-auto">
        {statCards.map((stat, index) => {
          const Icon = stat.icon
          return (
            <Card
              key={stat.label}
              className={cn(
                "border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm",
                "animate-slideUp transition-all duration-300",
                `stagger-${index + 1}`
              )}
            >
              <CardContent className="p-5">
                <div className="flex items-center gap-4">
                  <div className={cn(
                    "p-3 rounded-2xl transition-transform duration-300 hover:scale-110 shadow-sm",
                    stat.bgColor
                  )}>
                    <Icon className={cn("h-6 w-6", stat.color)} />
                  </div>
                  <div>
                    <p className="text-3xl font-bold tracking-tight transition-all duration-300">{stat.value}</p>
                    <p className="text-sm font-medium text-muted-foreground mt-0.5">{stat.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Usage Stats */}
      {usageStats.validAccountCount > 0 && (
        <Card className="border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm animate-slideUp stagger-5">
          <CardHeader className="pb-4">
            <CardTitle className="text-base flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary transition-transform duration-300 hover:scale-110">
                <BarChart3 className="h-4.5 w-4.5" />
              </div>
              额度统计
              <span className="text-xs font-normal text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full border border-border/50">
                基于 {usageStats.validAccountCount} 个有效账号
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-4 bg-muted/30 border border-border/50 rounded-xl transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  <span className="text-xs font-medium text-muted-foreground">总额度</span>
                </div>
                <p className="text-2xl font-bold tracking-tight transition-all duration-300">{usageStats.totalLimit.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-muted/30 border border-border/50 rounded-xl transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="h-4 w-4 text-orange-500" />
                  <span className="text-xs font-medium text-muted-foreground">已使用</span>
                </div>
                <p className="text-2xl font-bold tracking-tight transition-all duration-300">{usageStats.totalUsed.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-muted/30 border border-border/50 rounded-xl transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-4 w-4 text-green-500" />
                  <span className="text-xs font-medium text-muted-foreground">剩余额度</span>
                </div>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400 tracking-tight transition-all duration-300">{usageStats.remaining.toLocaleString()}</p>
              </div>
              <div className="p-4 bg-muted/30 border border-border/50 rounded-xl transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <BarChart3 className="h-4 w-4 text-purple-500" />
                  <span className="text-xs font-medium text-muted-foreground">使用率</span>
                </div>
                <p className="text-2xl font-bold tracking-tight transition-all duration-300">{usageStats.percentUsed.toFixed(1)}%</p>
              </div>
            </div>
            {/* 进度条 */}
            <div className="space-y-3 p-4 bg-muted/20 rounded-xl border border-border/30">
              <div className="flex justify-between text-xs font-medium text-muted-foreground">
                <span>总体使用进度</span>
                <span className="font-mono">{usageStats.totalUsed.toLocaleString()} / {usageStats.totalLimit.toLocaleString()}</span>
              </div>
              <div className="h-3 bg-muted/50 rounded-full overflow-hidden border border-border/20">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-700 ease-out shadow-sm",
                    usageStats.percentUsed < 50 && "bg-green-500",
                    usageStats.percentUsed >= 50 && usageStats.percentUsed < 80 && "bg-amber-500",
                    usageStats.percentUsed >= 80 && "bg-red-500"
                  )}
                  style={{ width: `${Math.min(usageStats.percentUsed, 100)}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Current Account */}
      {activeAccount && (
        <Card className="border border-primary/20 shadow-lg bg-gradient-to-br from-primary/5 to-primary/10 animate-scaleIn stagger-6 hover-lift-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <CardHeader className="pb-4 relative z-10">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="p-1.5 bg-primary/10 rounded-full animate-pulse-subtle">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              当前使用账号
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 relative z-10">
            {/* 基本信息 */}
            <div className="flex items-center justify-between p-4 bg-card/60 backdrop-blur-sm rounded-xl border border-border/40 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center text-primary-foreground font-bold text-lg shadow-md ring-2 ring-white/20">
                  {(activeAccount.nickname || activeAccount.email || '?')[0].toUpperCase()}
                </div>
                <div>
                  <p className="font-semibold text-lg tracking-tight">{activeAccount.nickname || activeAccount.email}</p>
                  <p className="text-sm text-muted-foreground font-medium">{activeAccount.email}</p>
                </div>
              </div>
              <div className="text-right">
                <span className={cn(
                  'inline-flex items-center px-3 py-1 rounded-full text-xs font-bold text-white shadow-sm',
                  getSubscriptionColor(
                    activeAccount.subscription?.type || 'Free',
                    activeAccount.subscription?.title
                  )
                )}>
                  {activeAccount.subscription?.title || activeAccount.subscription?.type || 'Free'}
                </span>
              </div>
            </div>

            {/* 详细信息网格 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t">
              {/* 用量 */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">本月用量</p>
                <p className="text-sm font-medium">
                  {activeAccount.usage?.current || 0} / {activeAccount.usage?.limit || 0}
                </p>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (activeAccount.usage?.percentUsed || 0) > 0.8
                        ? 'bg-red-500'
                        : (activeAccount.usage?.percentUsed || 0) > 0.5
                          ? 'bg-amber-500'
                          : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min((activeAccount.usage?.percentUsed || 0) * 100, 100)}%` }}
                  />
                </div>
              </div>

              {/* 订阅剩余 */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">订阅剩余</p>
                <p className="text-sm font-medium">
                  {activeAccount.subscription?.daysRemaining != null
                    ? `${activeAccount.subscription.daysRemaining} 天`
                    : '永久'}
                </p>
              </div>

              {/* Token 状态 */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Token 状态</p>
                {(() => {
                  const expiresAt = activeAccount.credentials?.expiresAt
                  if (!expiresAt) return <p className="text-sm font-medium text-muted-foreground">未知</p>
                  const now = Date.now()
                  const remaining = expiresAt - now
                  if (remaining <= 0) return <p className="text-sm font-medium text-red-500">已过期</p>
                  const minutes = Math.floor(remaining / 60000)
                  if (minutes < 60) return <p className="text-sm font-medium text-amber-500">{minutes} 分钟</p>
                  const hours = Math.floor(minutes / 60)
                  return <p className="text-sm font-medium text-green-500">{hours} 小时</p>
                })()}
              </div>

              {/* 登录方式 */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">登录方式</p>
                <p className="text-sm font-medium">
                  {activeAccount.credentials?.authMethod === 'social'
                    ? (activeAccount.credentials?.provider || 'Social')
                    : 'Builder ID'}
                </p>
              </div>
            </div>

            {/* 订阅详情 */}
            <div className="pt-3 border-t space-y-2">
              <p className="text-xs font-medium text-muted-foreground">订阅详情</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">订阅类型:</span>
                  <span className="font-medium">{activeAccount.subscription?.title || activeAccount.subscription?.type || 'Free'}</span>
                </div>
                {activeAccount.subscription?.rawType && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">原始类型:</span>
                    <span className="font-mono text-[10px]">{activeAccount.subscription.rawType}</span>
                  </div>
                )}
                {activeAccount.subscription?.expiresAt && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">到期时间:</span>
                    <span className="font-medium">{new Date(activeAccount.subscription.expiresAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                )}
                {activeAccount.subscription?.upgradeCapability && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">可升级:</span>
                    <span className="font-medium">{activeAccount.subscription.upgradeCapability}</span>
                  </div>
                )}
                {activeAccount.subscription?.overageCapability && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">超额能力:</span>
                    <span className="font-medium">{activeAccount.subscription.overageCapability}</span>
                  </div>
                )}
              </div>
            </div>

            {/* 额度明细 */}
            {(activeAccount.usage?.baseLimit || activeAccount.usage?.freeTrialLimit || activeAccount.usage?.bonuses?.length) && (
              <div className="pt-3 border-t space-y-2">
                <p className="text-xs font-medium text-muted-foreground">额度明细</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {/* 基础额度 */}
                  {activeAccount.usage?.baseLimit !== undefined && activeAccount.usage.baseLimit > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-muted-foreground">基础额度:</span>
                      <span className="font-medium">
                        {activeAccount.usage.baseCurrent ?? 0} / {activeAccount.usage.baseLimit}
                      </span>
                    </div>
                  )}
                  {/* 试用额度 */}
                  {activeAccount.usage?.freeTrialLimit !== undefined && activeAccount.usage.freeTrialLimit > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-purple-500" />
                      <span className="text-muted-foreground">试用额度:</span>
                      <span className="font-medium">
                        {activeAccount.usage.freeTrialCurrent ?? 0} / {activeAccount.usage.freeTrialLimit}
                      </span>
                      {activeAccount.usage.freeTrialExpiry && (
                        <span className="text-muted-foreground/70 text-[10px]">
                          (至 {(() => {
                            const d = activeAccount.usage.freeTrialExpiry as unknown
                            try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                          })()})
                        </span>
                      )}
                    </div>
                  )}
                  {/* 奖励额度 */}
                  {activeAccount.usage?.bonuses?.map((bonus) => (
                    <div key={bonus.code} className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-cyan-500" />
                      <span className="text-muted-foreground truncate">{bonus.name}:</span>
                      <span className="font-medium">{bonus.current} / {bonus.limit}</span>
                      {bonus.expiresAt && (
                        <span className="text-muted-foreground/70 text-[10px]">
                          (至 {(() => {
                            const d = bonus.expiresAt as unknown
                            try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                          })()})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 账户信息 */}
            <div className="pt-3 border-t space-y-2">
              <p className="text-xs font-medium text-muted-foreground">账户信息</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">User ID:</span>
                  <span className="font-mono text-[10px] break-all select-all">{activeAccount.userId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">IDP:</span>
                  <span className="font-medium">{activeAccount.idp || 'BuilderId'}</span>
                </div>
                {activeAccount.usage?.nextResetDate && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">重置日期:</span>
                    <span className="font-medium">
                      {(() => {
                        const d = activeAccount.usage.nextResetDate as unknown
                        try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '未知' }
                      })()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Tips */}
      {/* <Card className="border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm animate-slideUp stagger-7">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary transition-transform duration-300 hover:scale-110">
              <Shield className="h-4.5 w-4.5" />
            </div>
            快速提示
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            <li className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30 transition-all duration-200 hover:bg-muted/50 hover:border-primary/20 group">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 group-hover:scale-125 transition-transform" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                点击左侧「账户管理」可以查看和管理所有账号
              </span>
            </li>
            <li className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30 transition-all duration-200 hover:bg-muted/50 hover:border-primary/20 group">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 group-hover:scale-125 transition-transform" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                在账号卡片上点击电源图标可以快速切换账号
              </span>
            </li>
            <li className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30 transition-all duration-200 hover:bg-muted/50 hover:border-primary/20 group">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 group-hover:scale-125 transition-transform" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                Token 会在过期前 5 分钟自动刷新，无需手动操作
              </span>
            </li>
            <li className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30 transition-all duration-200 hover:bg-muted/50 hover:border-primary/20 group">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 group-hover:scale-125 transition-transform" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                使用「隐私模式」可以隐藏邮箱和账号信息
              </span>
            </li>
          </ul>
        </CardContent>
      </Card> */}

      {/* Feature Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm animate-slideUp stagger-6 group">
          <CardContent className="p-5">
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20 group-hover:rotate-3 shadow-sm">
                <Fingerprint className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-sm group-hover:text-primary transition-colors">机器码管理</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  修改设备标识符，切号时自动更换，支持账户绑定
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm animate-slideUp stagger-7 group">
          <CardContent className="p-5">
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20 group-hover:rotate-3 shadow-sm">
                <FolderPlus className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-sm group-hover:text-primary transition-colors">分组管理</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  多选账户后可批量设置分组，一键移动账号
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/40 shadow-sm hover-lift-sm bg-card/50 backdrop-blur-sm animate-slideUp stagger-8 group">
          <CardContent className="p-5">
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20 group-hover:rotate-3 shadow-sm">
                <Tag className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-sm group-hover:text-primary transition-colors">标签管理</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  多选账户后可批量添加/移除标签，支持多标签
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
