import { useState, useRef, useEffect } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { AccountGrid } from './AccountGrid'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { GroupManageDialog } from './GroupManageDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { AccountFilterPanel } from './AccountFilter'
import { Button, Badge } from '../ui'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { Account } from '@/types/account'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  Loader2,
  Users,
  Search,
  Plus,
  Upload,
  Download,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Filter,
  CheckSquare,
  Square,
  ScanSearch,
  X,
  FolderPlus,
  Tag,
  ChevronUp,
  Check,
  Minus
} from 'lucide-react'
import { isElectron } from '@/lib/api'
import { useMobile } from '@/hooks/use-mobile'

interface AccountManagerProps {
  onBack?: () => void
}

export function AccountManager({ onBack }: AccountManagerProps): React.ReactNode {
  const {
    isLoading,
    accounts,
    importFromExportData,
    selectedIds,
    filter,
    setFilter,
    selectAll,
    deselectAll,
    batchDeleteAccounts,
    batchRefreshTokens,
    batchCheckStatus,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    groups,
    tags,
    moveAccountsToGroup,
    addTagToAccounts,
    removeTagFromAccounts
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)
  const [showGroupMenu, setShowGroupMenu] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)

  const groupMenuRef = useRef<HTMLDivElement>(null)
  const tagMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setShowGroupMenu(false)
      }
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const electron = isElectron()
  const isMobile = useMobile()
  const stats = getStats()
  const filteredCount = getFilteredAccounts().length
  const selectedCount = selectedIds.size

  // 获取要导出的账号列表
  const getExportAccounts = (): Account[] => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter((acc) => selectedIds.has(acc.id))
    }
    return accountList
  }

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
  }

  const handleToggleSelectAll = (): void => {
    if (selectedCount === filteredCount && filteredCount > 0) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  const handleBatchRefresh = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsRefreshing(true)
    await batchRefreshTokens(Array.from(selectedIds))
    setIsRefreshing(false)
  }

  const handleBatchCheck = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsChecking(true)
    await batchCheckStatus(Array.from(selectedIds))
    setIsChecking(false)
  }

  const handleBatchDelete = async (): Promise<void> => {
    if (selectedCount === 0) return
    if (confirm(`确定要删除选中的 ${selectedCount} 个账号吗？`)) {
      await batchDeleteAccounts(Array.from(selectedIds))
      deselectAll()
    }
  }

  // 获取选中账户的分组和标签状态
  const getSelectedAccountsGroupStatus = () => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const groupCounts = new Map<string | undefined, number>()

    selectedAccounts.forEach(acc => {
      if (acc) {
        const gid = acc.groupId
        groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1)
      }
    })

    return { selectedAccounts, groupCounts }
  }

  const getSelectedAccountsTagStatus = () => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const tagCounts = new Map<string, number>()

    selectedAccounts.forEach(acc => {
      if (acc?.tags) {
        acc.tags.forEach(tagId => {
          tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1)
        })
      }
    })

    return { selectedAccounts, tagCounts, total: selectedAccounts.length }
  }

  // 处理分组操作
  const handleMoveToGroup = (groupId: string | undefined) => {
    if (selectedIds.size === 0) return
    moveAccountsToGroup(Array.from(selectedIds), groupId)
    setShowGroupMenu(false)
  }

  // 处理标签操作
  const handleAddTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    addTagToAccounts(Array.from(selectedIds), tagId)
  }

  const handleRemoveTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    removeTagFromAccounts(Array.from(selectedIds), tagId)
  }

  const handleToggleTag = (tagId: string) => {
    const { tagCounts, total } = getSelectedAccountsTagStatus()
    const count = tagCounts.get(tagId) || 0

    if (count === total) {
      // 所有选中账户都有此标签，移除
      handleRemoveTag(tagId)
    } else {
      // 部分或无账户有此标签，添加
      handleAddTag(tagId)
    }
  }

  // 导入
  const handleImport = async (): Promise<void> => {
    const content = await window.api.importFromFile()
    if (content) {
      try {
        const data = JSON.parse(content)
        // 支持两种格式：
        // 1. 标准导出格式：{ version, accounts, groups, tags }
        // 2. 简化数组格式：[{ id, email, refreshToken, ... }]
        if (data.version && data.accounts) {
          // 标准导出格式
          const result = await importFromExportData(data)
          const skippedInfo = result.errors.find((e) => e.id === 'skipped')
          const skippedMsg = skippedInfo ? `\n${skippedInfo.error}` : ''
          const failedMsg = result.failed > 0 ? `\n失败 ${result.failed} 个` : ''
          // 输出详细错误到控制台
          if (result.errors.length > 0) {
            console.log('[Import] 导入详情:', result.errors)
          }
          alert(`导入完成：\n成功 ${result.success} 个${failedMsg}${skippedMsg}`)
        } else if (Array.isArray(data) && data.length > 0 && data[0].email && data[0].refreshToken) {
          // 简化数组格式（兼容外部工具导出的格式）
          const result = await importFromExportData(data)
          const skippedInfo = result.errors.find((e) => e.id === 'skipped')
          const skippedMsg = skippedInfo ? `\n${skippedInfo.error}` : ''
          const failedMsg = result.failed > 0 ? `\n失败 ${result.failed} 个` : ''
          // 输出详细错误到控制台
          if (result.errors.length > 0) {
            console.log('[Import] 导入详情:', result.errors)
          }
          alert(`导入完成：\n成功 ${result.success} 个${failedMsg}${skippedMsg}`)
        } else {
          alert('无效的导入文件格式')
        }
      } catch (e) {
        console.error('[Import] 解析导入文件失败:', e)
        alert('解析导入文件失败')
      }
    }
  }

  // 检测本地凭证 (Electron only)
  const handleDetectCredentials = async (): Promise<void> => {
    if (!electron) return
    setIsDetecting(true)
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        const creds = result.data
        // 检查是否已存在相同的账号
        const existingAccount = Array.from(accounts.values()).find(
          (acc) => acc.credentials.refreshToken === creds.refreshToken
        )
        if (existingAccount) {
          alert(`检测到的凭证已存在：${existingAccount.email}`)
        } else {
          // 添加新账号
          const { addAccount, checkAccountStatus } = useAccountsStore.getState()
          const authMethod = creds.authMethod === 'IdC' ? 'IdC' : 'social'
          const providerMap: Record<string, 'BuilderId' | 'Github' | 'Google'> = {
            BuilderId: 'BuilderId',
            Github: 'Github',
            Google: 'Google'
          }
          const provider = providerMap[creds.provider] || 'BuilderId'
          const newId = await addAccount({
            email: '未知邮箱',
            nickname: undefined,
            idp: 'BuilderId',
            credentials: {
              accessToken: creds.accessToken,
              refreshToken: creds.refreshToken,
              csrfToken: '',
              clientId: creds.clientId,
              clientSecret: creds.clientSecret,
              region: creds.region || 'us-east-1',
              expiresAt: Date.now() + 3600 * 1000,
              authMethod,
              provider
            },
            subscription: { type: 'Free' },
            usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: Date.now() },
            tags: [],
            status: 'unknown',
            lastUsedAt: Date.now()
          })
          // 立即检查状态获取完整信息
          if (newId) {
            await checkAccountStatus(newId)
            alert('成功检测并导入本地凭证！')
          } else {
            alert('导入失败：无法创建账号')
          }
        }
      } else {
        alert('未检测到本地 Kiro 凭证: ' + (result.error || '未知原因'))
      }
    } catch (error) {
      console.error('检测凭证失败:', error)
      alert('检测凭证失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsDetecting(false)
    }
  }

  // 刷新账号列表
  const { loadFromStorage } = useAccountsStore()
  const [isRefreshingList, setIsRefreshingList] = useState(false)
  
  const handleRefreshList = async () => {
    setIsRefreshingList(true)
    try {
      await loadFromStorage()
    } finally {
      setIsRefreshingList(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background/50 backdrop-blur-sm">
      {/* 顶部标题栏 - 简洁 */}
      <div className="px-6 py-5 border-b border-border/40 bg-card/30 backdrop-blur-md shrink-0 sticky top-0 z-20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {onBack && (
              <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0 -ml-2 rounded-full hover:bg-background/80">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">账号管理</h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  管理所有的 Kiro 账号、分组和标签
                </p>
              </div>
            </div>
          </div>
          {/* 刷新按钮 */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefreshList}
            disabled={isRefreshingList}
            className="rounded-full hover:bg-background/80"
            title="刷新账号列表"
          >
            {isRefreshingList ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="px-6 py-3 border-b border-border/40 bg-card/20 backdrop-blur-sm shrink-0 relative z-10">
        <div className={cn("flex gap-4", isMobile ? "flex-col items-stretch" : "items-center justify-between")}>
          {/* 左侧：搜索 + 视图切换 */}
          <div className={cn("flex items-center gap-4", isMobile ? "w-full" : "")}>
            <div className={cn("relative group", isMobile ? "w-full" : "w-72")}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <input
                type="text"
                placeholder="搜索账号..."
                className="w-full h-9 pl-9 pr-4 text-sm border border-input bg-background/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all hover:bg-background/80"
                value={filter.search ?? ''}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>


            {/* <span className="text-sm text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full border border-border/50">
              共 <span className="font-semibold text-foreground">{stats.total}</span> 个
              {filteredCount !== stats.total && (
                <span className="ml-1">
                  / 筛选 <span className="font-semibold text-foreground">{filteredCount}</span>
                </span>
              )}
            </span>

            {stats.expiringSoonCount > 0 && (
              <Badge variant="destructive" className="text-xs shadow-sm animate-pulse-subtle">
                {stats.expiringSoonCount} 即将到期
              </Badge>
            )} */}
          </div>

          {/* 右侧：操作按钮 */}
          <div className={cn("flex items-center gap-2", isMobile ? "overflow-x-auto pb-1 no-scrollbar" : "")}>
            <Button variant="default" size="sm" className="h-9 px-4 shadow-md hover:shadow-lg transition-all shrink-0" onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              添加
            </Button>

            {electron && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 bg-background/50 border-border/50 hover:bg-background/80"
                onClick={handleDetectCredentials}
                disabled={isDetecting}
              >
                {isDetecting ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <ScanSearch className="h-4 w-4 mr-1.5" />
                )}
                检测
              </Button>
            )}

            <Button variant="outline" size="sm" className="h-9 bg-background/50 border-border/50 hover:bg-background/80" onClick={handleImport}>
              <Upload className="h-4 w-4 mr-1.5" />
              导入
            </Button>

            <Button variant="outline" size="sm" className="h-9 bg-background/50 border-border/50 hover:bg-background/80" onClick={() => setShowExportDialog(true)}>
              <Download className="h-4 w-4 mr-1.5" />
              导出
            </Button>

            <div className="h-6 w-px bg-border/60 mx-1" />

            <Button
              variant={privacyMode ? 'secondary' : 'ghost'}
              size="icon"
              className={cn("h-9 w-9 rounded-full", privacyMode ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-muted")}
              onClick={() => setPrivacyMode(!privacyMode)}
              title={privacyMode ? '关闭隐私模式' : '开启隐私模式'}
            >
              {privacyMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>

            <div className="relative">
              <Button
                variant={showFilterPanel ? 'secondary' : 'ghost'}
                size="icon"
                className={cn("h-9 w-9 rounded-full", showFilterPanel ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-muted")}
                onClick={() => setShowFilterPanel(!showFilterPanel)}
                title="高级筛选"
              >
                <Filter className="h-4 w-4" />
              </Button>
              
              {/* 移动端使用 Sheet - 全屏显示 */}
              {isMobile ? (
                <Sheet open={showFilterPanel} onOpenChange={setShowFilterPanel}>
                  <SheetContent side="bottom" className="h-[100dvh] rounded-t-xl">
                    <SheetHeader>
                      <SheetTitle>高级筛选</SheetTitle>
                    </SheetHeader>
                    <div className="mt-4 h-[calc(100%-4rem)] overflow-y-auto pb-safe">
                      <AccountFilterPanel />
                    </div>
                  </SheetContent>
                </Sheet>
              ) : (
                /* 桌面端使用下拉面板 */
                showFilterPanel && (
                  <>
                    {/* 点击遮罩层关闭筛选面板 */}
                    <div
                      className="fixed inset-0 z-[9998]"
                      onClick={() => setShowFilterPanel(false)}
                    />
                    <div
                      className="absolute right-0 top-full mt-2 z-[9999] min-w-[500px] bg-popover/98 backdrop-blur-xl border border-border/50 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                      style={{ isolation: 'isolate' }}
                    >
                      <AccountFilterPanel />
                    </div>
                  </>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden px-6 py-4 relative">
        <AccountGrid
          onAddAccount={() => setShowAddDialog(true)}
          onEditAccount={(account) => setEditingAccount(account)}
          onManageGroups={() => setShowGroupDialog(true)}
          onManageTags={() => setShowTagDialog(true)}
        />

        {/* 悬浮选中操作栏 - 仅 Web 模式显示 */}
        {!electron && (
        <div
          className={cn(
            "bg-popover/95 backdrop-blur-xl border border-border/50 shadow-2xl transition-all duration-500 cubic-bezier(0.34, 1.56, 0.64, 1) z-50 ring-1 ring-black/5",
            isMobile
              ? "fixed left-0 right-0 bottom-0 rounded-t-2xl p-3 pb-safe"
              : "absolute left-1/2 -translate-x-1/2 bottom-8 rounded-2xl p-2",
            selectedCount > 0 ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-[150%] opacity-0 scale-95 pointer-events-none'
          )}
        >
          <div className={cn("flex items-center gap-2", isMobile ? "flex-col" : "")}>
            {/* 选中数量和取消按钮 */}
            <div className={cn("flex items-center gap-2", isMobile ? "w-full justify-between pb-2 border-b border-border/50" : "px-2 border-r border-border/50")}>
              <span className="font-medium text-sm text-foreground/80">已选 {selectedCount} 项</span>
              <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-muted/80 text-muted-foreground" onClick={deselectAll}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* 操作按钮 */}
            <div className={cn("flex items-center gap-1", isMobile ? "w-full flex-wrap justify-center" : "")}>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
              onClick={handleToggleSelectAll}
            >
              {selectedCount === filteredCount ? (
                <CheckSquare className="h-4 w-4 mr-1.5" />
              ) : (
                <Square className="h-4 w-4 mr-1.5" />
              )}
              {selectedCount === filteredCount ? '全选' : '全选'}
            </Button>

            {/* 分组下拉菜单 */}
            <div className="relative" ref={groupMenuRef}>
              <Button
                variant={showGroupMenu ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                onClick={() => {
                  setShowGroupMenu(!showGroupMenu)
                  setShowTagMenu(false)
                }}
              >
                <FolderPlus className="h-4 w-4 mr-1.5" />
                分组
                <ChevronUp className={`h-3 w-3 ml-1 transition-transform ${showGroupMenu ? 'rotate-180' : ''}`} />
              </Button>

              {showGroupMenu && (
                <div className="absolute left-0 bottom-full mb-3 z-[100] min-w-[200px] bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <div className="text-xs font-medium text-muted-foreground px-3 py-2 bg-muted/30 border-b border-border/50">
                    移动到分组
                  </div>

                  {/* 移除分组 */}
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted/50 text-left transition-colors"
                    onClick={() => handleMoveToGroup(undefined)}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                    <span>移除分组</span>
                    {(() => {
                      const { groupCounts, selectedAccounts } = getSelectedAccountsGroupStatus()
                      const noGroupCount = groupCounts.get(undefined) || 0
                      if (noGroupCount === selectedAccounts.length) {
                        return <Check className="h-4 w-4 ml-auto text-primary" />
                      }
                      return null
                    })()}
                  </button>

                  <div className="border-t border-border/50" />

                  {/* 分组列表 */}
                  <div className="max-h-[240px] overflow-y-auto scrollbar-thin">
                    {Array.from(groups.values()).map(group => {
                      const { groupCounts, selectedAccounts } = getSelectedAccountsGroupStatus()
                      const count = groupCounts.get(group.id) || 0
                      const isAllInGroup = count === selectedAccounts.length

                      return (
                        <button
                          key={group.id}
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted/50 text-left transition-colors"
                          onClick={() => handleMoveToGroup(group.id)}
                        >
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-offset-1 ring-offset-popover"
                            style={{ backgroundColor: group.color || '#888', '--tw-ring-color': group.color } as React.CSSProperties}
                          />
                          <span className="truncate flex-1">{group.name}</span>
                          {isAllInGroup && <Check className="h-4 w-4 text-primary" />}
                          {count > 0 && !isAllInGroup && (
                            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{count}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {groups.size === 0 && (
                    <div className="text-sm text-muted-foreground px-3 py-4 text-center flex flex-col items-center gap-2">
                      <FolderPlus className="h-6 w-6 opacity-20" />
                      <span>暂无分组</span>
                    </div>
                  )}

                  <div className="border-t border-border/50" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-primary/5 text-primary font-medium transition-colors"
                    onClick={() => {
                      setShowGroupMenu(false)
                      setShowGroupDialog(true)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                    <span>管理分组</span>
                  </button>
                </div>
              )}
            </div>

            {/* 标签下拉菜单 */}
            <div className="relative" ref={tagMenuRef}>
              <Button
                variant={showTagMenu ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                onClick={() => {
                  setShowTagMenu(!showTagMenu)
                  setShowGroupMenu(false)
                }}
              >
                <Tag className="h-4 w-4 mr-1.5" />
                标签
                <ChevronUp className={`h-3 w-3 ml-1 transition-transform ${showTagMenu ? 'rotate-180' : ''}`} />
              </Button>

              {showTagMenu && (
                <div className="absolute left-0 bottom-full mb-3 z-[100] min-w-[220px] bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <div className="text-xs font-medium text-muted-foreground px-3 py-2 bg-muted/30 border-b border-border/50">
                    添加/移除标签
                  </div>

                  {/* 标签列表 */}
                  <div className="max-h-[240px] overflow-y-auto scrollbar-thin">
                    {Array.from(tags.values()).map(tag => {
                      const { tagCounts, total } = getSelectedAccountsTagStatus()
                      const count = tagCounts.get(tag.id) || 0
                      const isAll = count === total
                      const isPartial = count > 0 && count < total

                      return (
                        <button
                          key={tag.id}
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted/50 text-left transition-colors"
                          onClick={() => handleToggleTag(tag.id)}
                        >
                          <div
                            className={cn(
                              "w-4 h-4 rounded flex items-center justify-center shrink-0 transition-all",
                              isAll || isPartial ? "bg-primary text-primary-foreground" : "border-2 border-muted-foreground/30"
                            )}
                            style={isAll || isPartial ? { backgroundColor: tag.color, borderColor: tag.color } : undefined}
                          >
                            {isAll && <Check className="h-3 w-3 text-white" />}
                            {isPartial && <Minus className="h-3 w-3 text-white" />}
                          </div>
                          <span className="truncate flex-1">{tag.name}</span>
                          {isPartial && (
                            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{count}/{total}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {tags.size === 0 && (
                    <div className="text-sm text-muted-foreground px-3 py-4 text-center flex flex-col items-center gap-2">
                      <Tag className="h-6 w-6 opacity-20" />
                      <span>暂无标签</span>
                    </div>
                  )}

                  <div className="border-t border-border/50" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-primary/5 text-primary font-medium transition-colors"
                    onClick={() => {
                      setShowTagMenu(false)
                      setShowTagDialog(true)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                    <span>管理标签</span>
                  </button>
                </div>
              )}
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
              onClick={handleBatchCheck}
              disabled={isChecking}
            >
              {isChecking ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              检查
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
              onClick={handleBatchRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              刷新
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg text-destructive hover:text-destructive hover:bg-destructive/10 transition-colors"
              onClick={handleBatchDelete}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              删除
            </Button>
            </div>
          </div>
        </div>
        )}
      </div>

      {/* 对话框 */}
      <AddAccountDialog isOpen={showAddDialog} onClose={() => setShowAddDialog(false)} />
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />
      <GroupManageDialog isOpen={showGroupDialog} onClose={() => setShowGroupDialog(false)} />
      <TagManageDialog isOpen={showTagDialog} onClose={() => setShowTagDialog(false)} />
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
      />
    </div>
  )
}
