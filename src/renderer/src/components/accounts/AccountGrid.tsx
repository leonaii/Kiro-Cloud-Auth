import { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAccountsStore } from '@/store/accounts'
import { AccountCard } from './AccountCard'
import { AccountDetailDialog } from './AccountDetailDialog'
import { AccountChatDialog } from './AccountChatDialog'
import { AccountContextMenu } from './AccountContextMenu'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import { Plus, FolderOpen, Tag, Settings, Users, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobile } from '@/hooks/use-mobile'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

interface AccountGridProps {
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onManageGroups: () => void
  onManageTags: () => void
}

// 卡片高度和间距配置
// 移动端卡片高度更大，因为内容垂直排列
const CARD_HEIGHT_DESKTOP = 110
const CARD_HEIGHT_MOBILE = 160
const GAP_DESKTOP = 12
const GAP_MOBILE = 16 // 移动端间隔更大，更美观

// 网格视图组件 - 优化版本
function GridView({
  accounts,
  tags,
  groups,
  selectedIds,
  toggleSelection,
  onAddAccount,
  onEditAccount,
  onShowDetail,
  onChat
}: {
  accounts: Account[]
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  selectedIds: Set<string>
  toggleSelection: (id: string) => void
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onShowDetail: (account: Account) => void
  onChat?: (account: Account) => void
}): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{
    account: Account
    position: { x: number; y: number }
  } | null>(null)

  // 使用 useMemo 优化 items 数组
  const items = useMemo(() => [...accounts, 'add' as const], [accounts])

  // 检测移动端
  const isMobile = useMobile()
  const cardHeight = isMobile ? CARD_HEIGHT_MOBILE : CARD_HEIGHT_DESKTOP
  const gap = isMobile ? GAP_MOBILE : GAP_DESKTOP

  // 虚拟滚动配置 - 使用 cardHeight 作为依赖，确保移动端/桌面端切换时重新计算
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => cardHeight + gap, [cardHeight, gap]),
    overscan: 8 // 增加预渲染数量以提升滚动流畅度
  })

  // 当卡片高度变化时，强制重新测量所有项目
  useEffect(() => {
    virtualizer.measure()
  }, [cardHeight, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()

  // 使用 useCallback 优化事件处理
  const handleContextMenu = useCallback((e: React.MouseEvent, account: Account) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ account, position: { x: e.clientX, y: e.clientY } })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  return (
    <>
      <div
        ref={parentRef}
        className="h-full overflow-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/30"
        style={{ contain: 'strict' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index]
            const isAddButton = item === 'add'

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size - gap}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingLeft: `${gap / 2}px`,
                  paddingRight: `${gap / 2}px`
                }}
              >
                {isAddButton ? (
                  <div
                    className={cn(
                      "h-full flex items-center justify-center",
                      "border-2 border-dashed border-muted-foreground/20 rounded-xl",
                      "cursor-pointer transition-all duration-200",
                      "hover:border-primary/50 hover:bg-primary/5 hover:shadow-sm",
                      "group"
                    )}
                    onClick={onAddAccount}
                  >
                    <div className="flex items-center gap-2 text-muted-foreground group-hover:text-primary transition-colors">
                      <Plus className="h-5 w-5" />
                      <span className="text-sm font-medium">添加账号</span>
                    </div>
                  </div>
                ) : (
                  <div
                    onContextMenu={(e) => handleContextMenu(e, item)}
                    className="h-full"
                  >
                    <AccountCard
                      account={item}
                      tags={tags}
                      groups={groups}
                      isSelected={selectedIds.has(item.id)}
                      onSelect={() => toggleSelection(item.id)}
                      index={virtualRow.index}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 空状态 */}
        {accounts.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted/50 flex items-center justify-center">
                <Users className="h-8 w-8 text-muted-foreground/50" />
              </div>
              <div>
                <p className="text-muted-foreground font-medium">暂无账号</p>
                <p className="text-sm text-muted-foreground/70 mt-1">点击下方按钮添加您的第一个账号</p>
              </div>
              <button
                className={cn(
                  "inline-flex items-center gap-2 px-5 py-2.5 rounded-lg",
                  "bg-primary text-primary-foreground font-medium",
                  "hover:bg-primary/90 transition-colors shadow-sm"
                )}
                onClick={onAddAccount}
              >
                <Plus className="h-4 w-4" />
                添加第一个账号
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <AccountContextMenu
          account={contextMenu.account}
          position={contextMenu.position}
          onClose={closeContextMenu}
          onEdit={onEditAccount}
          onShowDetail={onShowDetail}
          onChat={onChat}
        />
      )}
    </>
  )
}

export function AccountGrid({
  onAddAccount,
  onEditAccount,
  onManageGroups,
  onManageTags
}: AccountGridProps): React.ReactNode {
  const [detailAccount, setDetailAccount] = useState<Account | null>(null)
  const [chatAccount, setChatAccount] = useState<Account | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const isMobile = useMobile()
  const [sheetOpen, setSheetOpen] = useState(false)

  const {
    getFilteredAccounts,
    tags,
    groups,
    selectedIds,
    toggleSelection,
    checkAccountStatus,
    filter,
    setFilter,
    accounts: allAccounts
  } = useAccountsStore()

  // 使用 useMemo 优化分组计数计算
  const groupCounts = useMemo(() => {
    const counts = new Map<string | undefined, number>()
    let ungrouped = 0

    Array.from(allAccounts.values()).forEach((acc) => {
      if (acc.groupId) {
        counts.set(acc.groupId, (counts.get(acc.groupId) || 0) + 1)
      } else {
        ungrouped++
      }
    })

    counts.set(undefined, ungrouped)
    return counts
  }, [allAccounts])

  // 使用 useMemo 优化标签计数计算
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    Array.from(allAccounts.values()).forEach((acc) => {
      acc.tags?.forEach((tagId) => {
        counts.set(tagId, (counts.get(tagId) || 0) + 1)
      })
    })
    return counts
  }, [allAccounts])

  const handleShowDetail = (account: Account): void => {
    setDetailAccount(account)
  }

  const handleRefreshDetail = async (): Promise<void> => {
    if (!detailAccount) return
    setIsRefreshing(true)
    try {
      await checkAccountStatus(detailAccount.id)
      const accounts = getFilteredAccounts()
      const updated = accounts.find((a) => a.id === detailAccount.id)
      if (updated) setDetailAccount(updated)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleFilterByGroup = (groupId: string | undefined) => {
    if (groupId === undefined) {
      // 点击"全部"或"未分组"
      setFilter({ ...filter, groupIds: undefined })
    } else {
      setFilter({ ...filter, groupIds: [groupId] })
    }
  }

  const handleFilterByTag = (tagId: string) => {
    const currentTags = filter.tagIds || []
    if (currentTags.includes(tagId)) {
      // 移除标签筛选
      const newTags = currentTags.filter((t) => t !== tagId)
      setFilter({ ...filter, tagIds: newTags.length > 0 ? newTags : undefined })
    } else {
      // 添加标签筛选
      setFilter({ ...filter, tagIds: [...currentTags, tagId] })
    }
  }

  const accounts = getFilteredAccounts()
  const selectedGroupId = filter.groupIds?.[0]
  const selectedTagIds = filter.tagIds || []

  const SidebarContent = (
    <div className={cn("flex flex-col gap-4 overflow-hidden", isMobile ? "h-full" : "w-48 shrink-0")}>
      {/* 分组 */}
      <div className="bg-card rounded-xl border shadow-sm overflow-hidden flex flex-col max-h-[70%]">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            <span>分组</span>
          </div>
          <button
            onClick={onManageGroups}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="管理分组"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="overflow-y-auto p-2 space-y-0.5 scrollbar-thin">
          {/* 全部 */}
          <button
            className={cn(
              'w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-all',
              !selectedGroupId
                ? 'bg-primary/10 text-primary font-medium shadow-sm'
                : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
            )}
            onClick={() => handleFilterByGroup(undefined)}
          >
            <span>全部</span>
            <span className={cn("text-xs px-1.5 py-0.5 rounded-full", !selectedGroupId ? "bg-primary/10" : "bg-muted")}>
              {allAccounts.size}
            </span>
          </button>

          {/* 分组列表 */}
          {Array.from(groups.values()).map((group) => (
            <button
              key={group.id}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-all',
                selectedGroupId === group.id
                  ? 'bg-primary/10 text-primary font-medium shadow-sm'
                  : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
              )}
              onClick={() => handleFilterByGroup(group.id)}
            >
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-offset-1 ring-offset-card"
                style={{ backgroundColor: group.color, '--tw-ring-color': group.color } as React.CSSProperties}
              />
              <span className="truncate flex-1 text-left">{group.name}</span>
              <span className={cn("text-xs px-1.5 py-0.5 rounded-full", selectedGroupId === group.id ? "bg-primary/10" : "bg-muted")}>
                {groupCounts.get(group.id) || 0}
              </span>
            </button>
          ))}

          {/* 未分组 */}
          {(groupCounts.get(undefined) || 0) > 0 && (
            <button
              className={cn(
                'w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-all',
                selectedGroupId === 'none'
                  ? 'bg-primary/10 text-primary font-medium shadow-sm'
                  : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setFilter({ ...filter, groupIds: [] })}
            >
              <span>未分组</span>
              <span className={cn("text-xs px-1.5 py-0.5 rounded-full", selectedGroupId === 'none' ? "bg-primary/10" : "bg-muted")}>
                {groupCounts.get(undefined) || 0}
              </span>
            </button>
          )}

          {groups.size === 0 && (
            <div className="px-3 py-8 text-xs text-muted-foreground text-center flex flex-col items-center gap-2">
              <FolderOpen className="h-8 w-8 opacity-20" />
              <span>暂无分组</span>
            </div>
          )}
        </div>
      </div>

      {/* 标签 */}
      <div className="bg-card rounded-xl border shadow-sm overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span>标签</span>
          </div>
          <button
            onClick={onManageTags}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="管理标签"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="overflow-y-auto p-2 space-y-0.5 scrollbar-thin flex-1">
          {Array.from(tags.values()).map((tag) => {
            const isSelected = selectedTagIds.includes(tag.id)
            return (
              <button
                key={tag.id}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-all',
                  isSelected
                    ? 'bg-primary/10 text-primary font-medium shadow-sm'
                    : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
                )}
                onClick={() => handleFilterByTag(tag.id)}
              >
                <div
                  className={cn(
                    'w-3 h-3 rounded-full border-2 shrink-0',
                    isSelected && 'border-transparent'
                  )}
                  style={{
                    backgroundColor: isSelected ? tag.color : 'transparent',
                    borderColor: tag.color
                  }}
                />
                <span className="truncate flex-1 text-left">
                  {tag.name}
                </span>
                <span className={cn("text-xs px-1.5 py-0.5 rounded-full", isSelected ? "bg-primary/10" : "bg-muted")}>
                  {tagCounts.get(tag.id) || 0}
                </span>
              </button>
            )
          })}

          {tags.size === 0 && (
            <div className="px-3 py-8 text-xs text-muted-foreground text-center flex flex-col items-center gap-2">
              <Tag className="h-8 w-8 opacity-20" />
              <span>暂无标签</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full gap-4 relative">
      {/* 左侧边栏 - 分组和标签 */}
      {!isMobile && SidebarContent}

      {/* 移动端筛选按钮 */}
      {isMobile && (
        <>
          <Button
            variant="outline"
            size="sm"
            className="absolute left-0 top-0 z-10 gap-2 bg-background/80 backdrop-blur-sm shadow-sm"
            onClick={() => setSheetOpen(true)}
          >
            <Filter className="h-4 w-4" />
            筛选
          </Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen} side="left">
            <SheetContent className="w-64 p-4 pt-10 bg-background/95 backdrop-blur-xl">
              {SidebarContent}
            </SheetContent>
          </Sheet>
        </>
      )}

      {/* 右侧内容区 */}
      <div className={cn("flex-1 overflow-hidden", isMobile ? "pt-10" : "")}>
        <GridView
          accounts={accounts}
          tags={tags}
          groups={groups}
          selectedIds={selectedIds}
          toggleSelection={toggleSelection}
          onAddAccount={onAddAccount}
          onEditAccount={onEditAccount}
          onShowDetail={handleShowDetail}
          onChat={setChatAccount}
        />
      </div>

      {/* 账号详情对话框 */}
      <AccountDetailDialog
        open={!!detailAccount}
        onOpenChange={(open) => !open && setDetailAccount(null)}
        account={detailAccount}
        onRefresh={handleRefreshDetail}
        isRefreshing={isRefreshing}
      />

      {/* API 测试对话框 */}
      <AccountChatDialog
        open={!!chatAccount}
        onOpenChange={(open) => !open && setChatAccount(null)}
        account={chatAccount}
      />
    </div>
  )
}
