import { Button } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import type { AccountFilter as FilterType, SubscriptionType, AccountStatus, IdpType, PoolStatus } from '@/types/account'
import { UNGROUPED_ID } from '@/types/account'
import { cn } from '@/lib/utils'
import { Trash2, RotateCcw, Users, Snowflake, Circle } from 'lucide-react'
import { useMobile } from '@/hooks/use-mobile'

const SubscriptionOptions: { value: SubscriptionType; label: string }[] = [
  { value: 'Free', label: 'Free' },
  { value: 'Pro', label: 'Pro' },
  { value: 'Enterprise', label: 'Enterprise' },
  { value: 'Teams', label: 'Teams' }
]

const StatusOptions: { value: AccountStatus; label: string }[] = [
  { value: 'active', label: '正常' },
  { value: 'banned', label: '已封禁' },
  { value: 'expired', label: '已过期' },
  { value: 'error', label: '错误' },
  { value: 'unknown', label: '未知' }
]

const IdpOptions: { value: IdpType; label: string }[] = [
  { value: 'Google', label: 'Google' },
  { value: 'Github', label: 'GitHub' },
  { value: 'BuilderId', label: 'AWS Builder ID' },
  { value: 'AWSIdC', label: 'AWS IAM IdC' }
]

// 使用量预设选项
const UsagePresets: { label: string; min: number | undefined; max: number | undefined }[] = [
  { label: '已用完 (100%)', min: 1, max: undefined },
  { label: '未使用 (0%)', min: undefined, max: 0 },
  { label: '低使用 (1-50%)', min: 0.01, max: 0.5 },
  { label: '高使用 (50-99%)', min: 0.5, max: 0.99 }
]

// 剩余时间预设选项
const DaysRemainingPresets: { label: string; min: number | undefined; max: number | undefined }[] = [
  { label: '即将到期 (≤10天)', min: undefined, max: 10 },
  { label: '中期 (11-19天)', min: 11, max: 19 },
  { label: '充足 (≥20天)', min: 20, max: undefined }
]

// 账号池状态选项
const PoolStatusOptions: { value: PoolStatus; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'active', label: '活跃池', icon: <Users className="h-3.5 w-3.5" />, color: 'text-green-500' },
  { value: 'cooling', label: '冷却池', icon: <Snowflake className="h-3.5 w-3.5" />, color: 'text-blue-500' },
  { value: 'none', label: '未在池中', icon: <Circle className="h-3.5 w-3.5" />, color: 'text-muted-foreground' }
]

// 解析 ARGB 颜色转换为 CSS rgba
function toRgba(argbColor: string): string {
  // 支持格式: #AARRGGBB 或 #RRGGBB
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

export function AccountFilterPanel(): React.ReactNode {
  const { filter, setFilter, clearFilter, groups, tags, getStats } = useAccountsStore()
  const isMobile = useMobile()

  const stats = getStats()

  const hasActiveFilters = Boolean(
    filter.subscriptionTypes?.length ||
    filter.statuses?.length ||
    filter.idps?.length ||
    filter.groupIds?.length ||
    filter.tagIds?.length ||
    filter.usageMin !== undefined ||
    filter.usageMax !== undefined ||
    filter.daysRemainingMin !== undefined ||
    filter.daysRemainingMax !== undefined ||
    filter.showDeleted ||
    filter.poolStatuses?.length
  )

  // 计算未分组账号数量
  const ungroupedCount = Array.from(useAccountsStore.getState().accounts.values())
    .filter(a => !a.groupId && !a.isDel).length

  // 切换显示已删除账号
  const toggleShowDeleted = (): void => {
    setFilter({
      ...filter,
      showDeleted: !filter.showDeleted
    })
  }

  const toggleArrayFilter = <T extends string>(
    key: keyof FilterType,
    value: T
  ): void => {
    const current = (filter[key] as T[] | undefined) ?? []
    const newValue = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]

    setFilter({
      ...filter,
      [key]: newValue.length > 0 ? newValue : undefined
    })
  }

  const setRangeFilter = (
    minKey: keyof FilterType,
    maxKey: keyof FilterType,
    min: number | undefined,
    max: number | undefined
  ): void => {
    setFilter({
      ...filter,
      [minKey]: min,
      [maxKey]: max
    })
  }

  return (
    <div className="p-4 space-y-4">
      {/* 清除筛选按钮 */}
      {hasActiveFilters && (
        <div className="flex justify-end absolute top-4 right-4 z-10">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs px-3 hover:bg-destructive/10 hover:text-destructive transition-colors"
            onClick={() => clearFilter()}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            清除筛选
          </Button>
        </div>
      )}

      {/* 第一行：已删除筛选 + 订阅类型 + 状态 + 身份提供商 */}
      <div className="space-y-4">
        {/* 已删除筛选开关 */}
        <div className="flex items-start gap-4">
           <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">特殊视图</div>
           <div className="flex flex-wrap gap-2">
            <button
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all duration-200',
                filter.showDeleted
                  ? 'bg-red-500/10 text-red-600 border-red-500/20 hover:bg-red-500/20 dark:text-red-400'
                  : 'bg-background/50 hover:bg-muted/80 border-border/50 text-muted-foreground hover:text-foreground'
              )}
              onClick={toggleShowDeleted}
              title={filter.showDeleted ? '查看正常账号' : '查看已删除账号'}
            >
              {filter.showDeleted ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>返回正常账号</span>
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>回收站 (已删除)</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="h-px bg-border/40" />

        {/* 订阅类型 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">订阅类型</div>
          <div className="flex flex-wrap gap-2">
            {SubscriptionOptions.map((option) => {
              const isActive = filter.subscriptionTypes?.includes(option.value)
              const count = stats.bySubscription[option.value]
              return (
                <button
                  key={option.value}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200',
                    isActive
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20'
                      : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                  )}
                  onClick={() => toggleArrayFilter('subscriptionTypes', option.value)}
                >
                  {option.label}
                  <span className={cn("ml-1.5 text-[10px]", isActive ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 状态 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">账号状态</div>
          <div className="flex flex-wrap gap-2">
            {StatusOptions.map((option) => {
              const isActive = filter.statuses?.includes(option.value)
              const count = stats.byStatus[option.value]
              return (
                <button
                  key={option.value}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200',
                    isActive
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20'
                      : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                  )}
                  onClick={() => toggleArrayFilter('statuses', option.value)}
                >
                  {option.label}
                  <span className={cn("ml-1.5 text-[10px]", isActive ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 身份提供商 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">IDP</div>
          <div className="flex flex-wrap gap-2">
            {IdpOptions.map((option) => {
              const isActive = filter.idps?.includes(option.value)
              const count = stats.byIdp[option.value]
              return (
                <button
                  key={option.value}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200',
                    isActive
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20'
                      : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                  )}
                  onClick={() => toggleArrayFilter('idps', option.value)}
                >
                  {option.label}
                  <span className={cn("ml-1.5 text-[10px]", isActive ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="h-px bg-border/40" />

      {/* 第二行：分组 + 标签 + 范围筛选 */}
      <div className="space-y-4">
        {/* 分组 - 包含"未分组"选项 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">分组</div>
          <div className={cn(
            "flex flex-wrap gap-2 overflow-y-auto scrollbar-thin pr-1",
            isMobile ? "max-h-[180px]" : "max-h-[240px]"
          )}>
            {/* 未分组选项 */}
            <button
              className={cn(
                'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200 flex items-center gap-1.5 h-fit',
                filter.groupIds?.includes(UNGROUPED_ID)
                  ? 'bg-muted text-foreground border-muted-foreground/30 shadow-sm'
                  : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
              )}
              onClick={() => toggleArrayFilter('groupIds', UNGROUPED_ID)}
            >
              <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
              未分组
              <span className={cn(
                "text-[10px]",
                filter.groupIds?.includes(UNGROUPED_ID) ? "text-foreground/70" : "text-muted-foreground"
              )}>
                {ungroupedCount}
              </span>
            </button>
            {/* 已有分组 */}
            {Array.from(groups.values()).map((group) => {
              const isActive = filter.groupIds?.includes(group.id)
              return (
                <button
                  key={group.id}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200 flex items-center gap-1.5 h-fit',
                    isActive
                      ? 'text-white border-transparent shadow-sm'
                      : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                  )}
                  style={isActive && group.color ? { backgroundColor: toRgba(group.color) } : undefined}
                  onClick={() => toggleArrayFilter('groupIds', group.id)}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: isActive ? 'white' : (group.color || '#888') }}
                  />
                  {group.name}
                </button>
              )
            })}
          </div>
        </div>

        {/* 标签 - 高度占用较小，因为标签通常比分组少 */}
        {tags.size > 0 && (
          <div className="flex items-start gap-4">
            <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">标签</div>
            <div className={cn(
              "flex flex-wrap gap-2 overflow-y-auto scrollbar-thin pr-1",
              isMobile ? "max-h-[80px]" : "max-h-[100px]"
            )}>
              {Array.from(tags.values()).map((tag) => {
                const isActive = filter.tagIds?.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200 h-fit',
                      isActive ? 'text-white border-transparent shadow-sm' : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                    )}
                    style={isActive ? { backgroundColor: toRgba(tag.color) } : undefined}
                    onClick={() => toggleArrayFilter('tagIds', tag.id)}
                  >
                    {tag.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 使用量范围 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">使用量</div>
          <div className="flex flex-col gap-2">
            {/* 预设选项 */}
            <div className="flex flex-wrap gap-2">
              {UsagePresets.map((preset, index) => {
                const isActive =
                  filter.usageMin === preset.min &&
                  filter.usageMax === preset.max
                return (
                  <button
                    key={index}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200',
                      isActive
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20'
                        : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                    )}
                    onClick={() => setRangeFilter('usageMin', 'usageMax', preset.min, preset.max)}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
            {/* 自定义输入 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">自定义:</span>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  placeholder="0"
                  className="w-16 px-2 py-1 text-xs border border-input bg-background/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  value={filter.usageMin !== undefined ? Math.round(filter.usageMin * 100) : ''}
                  onChange={(e) =>
                    setRangeFilter(
                      'usageMin',
                      'usageMax',
                      e.target.value ? Number(e.target.value) / 100 : undefined,
                      filter.usageMax
                    )
                  }
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
              </div>
              <span className="text-muted-foreground text-xs">~</span>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  placeholder="100"
                  className="w-16 px-2 py-1 text-xs border border-input bg-background/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  value={filter.usageMax !== undefined ? Math.round(filter.usageMax * 100) : ''}
                  onChange={(e) =>
                    setRangeFilter(
                      'usageMin',
                      'usageMax',
                      filter.usageMin,
                      e.target.value ? Number(e.target.value) / 100 : undefined
                    )
                  }
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
              </div>
            </div>
          </div>
        </div>

        {/* 剩余天数范围 */}
        <div className="flex items-start gap-4">
          <div className="w-16 text-xs font-medium text-muted-foreground pt-1.5 shrink-0">剩余时间</div>
          <div className="flex flex-col gap-2">
            {/* 预设选项 */}
            <div className="flex flex-wrap gap-2">
              {DaysRemainingPresets.map((preset, index) => {
                const isActive =
                  filter.daysRemainingMin === preset.min &&
                  filter.daysRemainingMax === preset.max
                return (
                  <button
                    key={index}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-lg border transition-all duration-200',
                      isActive
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20'
                        : 'bg-background/50 border-border/50 hover:bg-muted/80 text-foreground/80'
                    )}
                    onClick={() => setRangeFilter('daysRemainingMin', 'daysRemainingMax', preset.min, preset.max)}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
            {/* 自定义输入 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">自定义:</span>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  placeholder="0"
                  className="w-16 px-2 py-1 text-xs border border-input bg-background/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  value={filter.daysRemainingMin ?? ''}
                  onChange={(e) =>
                    setRangeFilter(
                      'daysRemainingMin',
                      'daysRemainingMax',
                      e.target.value ? Number(e.target.value) : undefined,
                      filter.daysRemainingMax
                    )
                  }
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">天</span>
              </div>
              <span className="text-muted-foreground text-xs">~</span>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  placeholder="∞"
                  className="w-16 px-2 py-1 text-xs border border-input bg-background/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  value={filter.daysRemainingMax ?? ''}
                  onChange={(e) =>
                    setRangeFilter(
                      'daysRemainingMin',
                      'daysRemainingMax',
                      filter.daysRemainingMin,
                      e.target.value ? Number(e.target.value) : undefined
                    )
                  }
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">天</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
