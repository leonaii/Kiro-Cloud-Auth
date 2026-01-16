import { useMemo, useState } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { Users, TrendingUp, Activity, ChevronDown, ChevronUp, Search, PieChart, Layers, Wallet, List } from 'lucide-react'
import kiroLogo from '@/assets/icon.png'
import { cn } from '@/lib/utils'

export function HomePageWeb(): React.ReactNode {
  const { accounts, groups, tags } = useAccountsStore()
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState<'percent' | 'used' | 'limit' | 'name'>('percent')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [showAll, setShowAll] = useState(false)

  // 计算统计数据
  const stats = useMemo(() => {
    const accountList = Array.from(accounts.values())

    let totalLimit = 0
    let totalUsed = 0
    let activeCount = 0

    accountList.forEach(account => {
      if (account.status === 'active' && account.usage) {
        totalLimit += account.usage.limit ?? 0
        totalUsed += account.usage.current ?? 0
        activeCount++
      }
    })

    return {
      totalAccounts: accountList.length,
      activeAccounts: activeCount,
      totalGroups: groups.size,
      totalTags: tags.size,
      totalLimit,
      totalUsed,
      remaining: totalLimit - totalUsed,
      percentUsed: totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0
    }
  }, [accounts, groups, tags])

  // 准备账号使用量数据
  const accountUsageData = useMemo(() => {
    let data = Array.from(accounts.values())
      .filter(acc => acc.status === 'active' && acc.usage && acc.usage.limit > 0)
      .map(acc => ({
        id: acc.id,
        email: acc.email,
        nickname: acc.nickname,
        used: acc.usage?.current ?? 0,
        limit: acc.usage?.limit ?? 0,
        // percentUsed 是小数，需要乘以 100
        percent: (acc.usage?.percentUsed ?? 0) * 100
      }))

    // 搜索过滤
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      data = data.filter(acc =>
        (acc.email || '').toLowerCase().includes(term) ||
        (acc.nickname || '').toLowerCase().includes(term)
      )
    }

    // 排序
    data.sort((a, b) => {
      let cmp = 0
      switch (sortBy) {
        case 'percent':
          cmp = a.percent - b.percent
          break
        case 'used':
          cmp = a.used - b.used
          break
        case 'limit':
          cmp = a.limit - b.limit
          break
        case 'name':
          cmp = (a.nickname || a.email).localeCompare(b.nickname || b.email)
          break
      }
      return sortOrder === 'desc' ? -cmp : cmp
    })

    return data
  }, [accounts, searchTerm, sortBy, sortOrder])

  // 分组统计
  const groupStats = useMemo(() => {
    const groupMap = new Map<string, { name: string; color: string; used: number; limit: number; count: number }>()

    Array.from(accounts.values()).forEach(acc => {
      if (acc.status !== 'active' || !acc.usage) return

      const groupId = acc.groupId || 'ungrouped'
      const group = acc.groupId ? groups.get(acc.groupId) : null

      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, {
          name: group?.name || '未分组',
          color: group?.color || '#94a3b8',
          used: 0,
          limit: 0,
          count: 0
        })
      }

      const stat = groupMap.get(groupId)!
      stat.used += acc.usage.current ?? 0
      stat.limit += acc.usage.limit ?? 0
      stat.count++
    })

    return Array.from(groupMap.values())
      .sort((a, b) => b.used - a.used)
      .slice(0, 5) // Top 5 groups
  }, [accounts, groups])

  // 显示的账号数量
  const displayedAccounts = showAll ? accountUsageData : accountUsageData.slice(0, 10)

  const toggleSort = (field: typeof sortBy): void => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
    } else {
      setSortBy(field)
      setSortOrder('desc')
    }
  }

  const SortIcon = ({ field }: { field: typeof sortBy }): React.ReactNode => {
    if (sortBy !== field) return <div className="w-3 h-3" /> // 占位
    return sortOrder === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
  }

  return (
    <div className="flex-1 p-8 space-y-8 overflow-y-auto min-h-screen">
      {/* Header with Glass Effect */}
      <div className="relative overflow-hidden rounded-2xl bg-background/40 backdrop-blur-xl border border-white/10 shadow-2xl p-8 group">
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary/20 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 opacity-30 group-hover:opacity-50 transition-opacity duration-700" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-secondary/20 rounded-full blur-[80px] translate-y-1/2 -translate-x-1/2 opacity-30 group-hover:opacity-50 transition-opacity duration-700" />

        <div className="relative flex items-center gap-6 z-10">
          <div className="relative group/logo">
            <div className="absolute inset-0 bg-primary/20 rounded-2xl blur-xl group-hover/logo:blur-2xl transition-all duration-500 opacity-0 group-hover/logo:opacity-100" />
            <img
              src={kiroLogo}
              alt="Kiro"
              className="relative h-20 w-20 object-contain drop-shadow-2xl transition-transform duration-500 group-hover/logo:scale-110"
            />
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">数据概览</h1>
            <p className="text-lg text-muted-foreground font-medium max-w-2xl leading-relaxed">
              全方位监控账号资源，智能分析 usage 趋势
            </p>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          {
            title: '总账号数',
            value: stats.totalAccounts,
            subValue: `${stats.activeAccounts} 活跃`,
            icon: Users,
            color: 'text-blue-500',
            bg: 'bg-blue-500/10',
            subBg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
          },
          {
            title: '总额度',
            value: stats.totalLimit.toLocaleString(),
            icon: Wallet,
            color: 'text-purple-500',
            bg: 'bg-purple-500/10'
          },
          {
            title: '已使用',
            value: stats.totalUsed.toLocaleString(),
            subValue: `${stats.percentUsed.toFixed(1)}%`,
            icon: Activity,
            color: 'text-orange-500',
            bg: 'bg-orange-500/10',
            subBg: 'text-muted-foreground'
          },
          {
            title: '剩余额度',
            value: stats.remaining.toLocaleString(),
            icon: TrendingUp,
            color: 'text-green-500',
            bg: 'bg-green-500/10',
            valueColor: 'text-green-600 dark:text-green-400'
          }
        ].map((item, index) => (
          <Card key={index} className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg hover:shadow-xl hover:bg-white/5 transition-all duration-300 group">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className={`p-4 rounded-2xl ${item.bg} ${item.color} group-hover:scale-110 transition-transform duration-300 shadow-inner`}>
                  <item.icon className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">{item.title}</p>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-2xl font-bold tracking-tight ${item.valueColor || 'text-foreground'}`}>{item.value}</span>
                    {item.subValue && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.subBg}`}>
                        {item.subValue}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Analytics & Distributions (4 cols) */}
        <div className="lg:col-span-4 space-y-8">
          {/* Overall Usage Ring */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
            <CardHeader className="border-b border-white/5 pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <PieChart className="h-4 w-4 text-primary" />
                总体使用率
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center p-8">
              <div className="relative w-56 h-56 group cursor-default">
                <div className="absolute inset-0 rounded-full bg-primary/5 scale-90 group-hover:scale-100 transition-transform duration-500 blur-xl" />
                <svg className="w-full h-full transform -rotate-90 transition-all duration-500" viewBox="0 0 100 100">
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-muted/10"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={`${stats.percentUsed * 2.51} 251`}
                    className={cn(
                      "transition-all duration-1000 ease-out drop-shadow-[0_0_10px_rgba(0,0,0,0.3)]",
                      stats.percentUsed >= 90 ? 'text-red-500' :
                        stats.percentUsed >= 70 ? 'text-amber-500' :
                          'text-green-500'
                    )}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-5xl font-bold tracking-tight text-foreground">{stats.percentUsed.toFixed(1)}<span className="text-2xl text-muted-foreground">%</span></span>
                  <span className="text-xs uppercase tracking-wider text-muted-foreground mt-2 font-medium bg-white/5 px-2 py-1 rounded-full border border-white/5">Used</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 w-full mt-8">
                {[
                  { label: 'Healthy', count: accountUsageData.filter(a => a.percent < 50).length, color: 'text-green-500', bg: 'bg-green-500/10 border-green-500/20' },
                  { label: 'Warn', count: accountUsageData.filter(a => a.percent >= 50 && a.percent < 80).length, color: 'text-amber-500', bg: 'bg-amber-500/10 border-amber-500/20' },
                  { label: 'Critical', count: accountUsageData.filter(a => a.percent >= 80).length, color: 'text-red-500', bg: 'bg-red-500/10 border-red-500/20' }
                ].map((item, i) => (
                  <div key={i} className={`flex flex-col items-center p-3 rounded-xl border ${item.bg} backdrop-blur-sm transition-transform hover:scale-105 duration-300`}>
                    <span className={`text-xl font-bold ${item.color}`}>
                      {item.count}
                    </span>
                    <span className={`text-[10px] uppercase font-bold opacity-70 mt-1 ${item.color}`}>{item.label}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Group Stats */}
          {groupStats.length > 0 && (
            <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
              <CardHeader className="border-b border-white/5 pb-4">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Layers className="h-4 w-4 text-primary" />
                  分组概况
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                {groupStats.map((group, index) => {
                  const percent = group.limit > 0 ? (group.used / group.limit) * 100 : 0
                  return (
                    <div key={index} className="space-y-2 group">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-3 h-3 rounded-full ring-2 ring-transparent group-hover:ring-offset-1 transition-all shadow-sm"
                            style={{ backgroundColor: group.color, '--tw-ring-color': group.color } as React.CSSProperties}
                          />
                          <span className="font-medium text-foreground/80 group-hover:text-foreground transition-colors">
                            {group.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-muted-foreground font-mono bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                            {group.used.toLocaleString()} <span className="text-muted-foreground/50">/</span> {group.limit.toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="relative w-full h-2.5 bg-muted/30 rounded-full overflow-hidden border border-white/5">
                        <div
                          className="absolute inset-y-0 left-0 transition-all duration-500 ease-out shadow-[0_0_10px_rgba(0,0,0,0.2)]"
                          style={{
                            width: `${Math.min(percent, 100)}%`,
                            backgroundColor: group.color
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column: Account List (8 cols) */}
        <div className="lg:col-span-8">
          <Card className="h-full bg-background/40 backdrop-blur-md border-white/10 shadow-lg flex flex-col overflow-hidden">
            <CardHeader className="border-b border-white/10 bg-white/5 py-5 px-6">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-xl text-primary shadow-inner">
                    <List className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-lg font-semibold">账号详情列表</CardTitle>
                </div>
                <div className="relative w-full sm:w-auto group">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 group-focus-within:text-primary transition-colors" />
                  <input
                    type="text"
                    placeholder="搜索邮箱或昵称..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 pr-4 py-2.5 text-sm border border-white/10 rounded-xl bg-black/20 w-full sm:w-72 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all shadow-inner placeholder:text-muted-foreground/50"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 flex flex-col">
              {/* List Header */}
              <div className="grid grid-cols-12 gap-4 px-6 py-4 bg-white/5 text-xs font-semibold text-muted-foreground border-b border-white/10 sticky top-0 backdrop-blur-md z-10 uppercase tracking-wider">
                <div
                  className="col-span-5 flex items-center gap-2 cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => toggleSort('name')}
                >
                  账号信息 <SortIcon field="name" />
                </div>
                <div
                  className="col-span-2 text-right flex items-center justify-end gap-2 cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => toggleSort('used')}
                >
                  <SortIcon field="used" /> 已用量
                </div>
                <div
                  className="col-span-2 text-right flex items-center justify-end gap-2 cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => toggleSort('limit')}
                >
                  <SortIcon field="limit" /> 总额度
                </div>
                <div
                  className="col-span-3 text-right flex items-center justify-end gap-2 cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => toggleSort('percent')}
                >
                  <SortIcon field="percent" /> 使用率
                </div>
              </div>

              {/* List Body */}
              <div className="divide-y divide-white/5 flex-1 overflow-y-auto min-h-[400px]">
                {displayedAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                    <div className="p-6 bg-white/5 rounded-full mb-4 border border-white/5">
                      <Search className="h-10 w-10 text-muted-foreground/30" />
                    </div>
                    <p className="text-base font-medium">
                      {searchTerm ? '没有找到匹配的账号' : '暂无账号数据'}
                    </p>
                  </div>
                ) : (
                  displayedAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="grid grid-cols-12 gap-4 items-center px-6 py-4 hover:bg-white/5 transition-all duration-200 group border-l-2 border-transparent hover:border-primary/50"
                    >
                      <div className="col-span-5 flex items-center gap-4 min-w-0">
                        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary text-sm font-bold ring-1 ring-white/10 shadow-sm group-hover:scale-105 transition-transform">
                          {(acc.nickname || acc.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-sm text-foreground truncate group-hover:text-primary transition-colors">{acc.nickname || acc.email}</div>
                          {acc.nickname && (
                            <div className="text-xs text-muted-foreground truncate font-mono opacity-70">{acc.email}</div>
                          )}
                        </div>
                      </div>

                      <div className="col-span-2 text-right text-sm font-mono tracking-tight text-foreground/90 bg-white/5 px-2 py-1 rounded-md border border-transparent group-hover:border-white/10 transition-colors">
                        {acc.used.toLocaleString()}
                      </div>

                      <div className="col-span-2 text-right text-sm font-mono tracking-tight text-muted-foreground bg-white/5 px-2 py-1 rounded-md border border-transparent group-hover:border-white/10 transition-colors">
                        {acc.limit.toLocaleString()}
                      </div>

                      <div className="col-span-3 flex items-center justify-end gap-3">
                        <div className="w-28 h-2.5 bg-black/20 rounded-full overflow-hidden border border-white/5">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500 shadow-[0_0_8px_rgba(0,0,0,0.3)]",
                              acc.percent >= 90 ? 'bg-red-500' :
                                acc.percent >= 70 ? 'bg-amber-500' :
                                  'bg-green-500'
                            )}
                            style={{ width: `${Math.min(acc.percent, 100)}%` }}
                          />
                        </div>
                        <span className={cn(
                          "text-sm font-bold w-14 text-right font-mono",
                          acc.percent >= 90 ? 'text-red-500' :
                            acc.percent >= 70 ? 'text-amber-500' :
                              'text-green-600 dark:text-green-400'
                        )}>
                          {acc.percent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Footer / Show More */}
              {accountUsageData.length > 10 && (
                <div className="p-4 border-t border-white/10 bg-white/5 text-center backdrop-blur-md">
                  <button
                    onClick={() => setShowAll(!showAll)}
                    className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors px-6 py-2.5 rounded-xl hover:bg-primary/10 border border-transparent hover:border-primary/20 active:scale-95"
                  >
                    {showAll ? (
                      <>收起列表 <ChevronUp className="h-4 w-4" /></>
                    ) : (
                      <>
                        显示全部 {accountUsageData.length} 个账号
                        <ChevronDown className="h-4 w-4" />
                      </>
                    )}
                  </button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}