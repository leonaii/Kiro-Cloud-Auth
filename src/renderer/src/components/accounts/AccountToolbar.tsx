import { useState, useRef, useEffect } from 'react'
import { Button, Badge, Toggle } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { AccountFilterPanel } from './AccountFilter'
import {
  Search,
  Plus,
  Upload,
  Download,
  RefreshCw,
  Trash2,
  Tag,
  FolderPlus,
  CheckSquare,
  Square,
  Loader2,
  Eye,
  EyeOff,
  Filter,
  ChevronDown,
  Check,
  X,
  Minus,
  RotateCcw,
} from 'lucide-react'

interface AccountToolbarProps {
  onAddAccount: () => void
  onImport: () => void
  onExport: () => void
  onManageGroups: () => void
  onManageTags: () => void
  isFilterExpanded: boolean
  onToggleFilter: () => void
}

export function AccountToolbar({
  onAddAccount,
  onImport,
  onExport,
  onManageGroups,
  onManageTags,
  isFilterExpanded,
  onToggleFilter
}: AccountToolbarProps): React.ReactNode {
  const {
    filter,
    setFilter,
    setShowDeleted,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    selectedIds,
    accounts
  } = useAccountsStore()

  // 计算已删除账号数量
  const deletedCount = Array.from(accounts.values()).filter(a => a.isDel).length

  const stats = getStats()
  const filteredCount = getFilteredAccounts().length

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
  }

  return (
    <div className="space-y-3">
      {/* 搜索和主要操作 */}
      <div className="flex items-center gap-4">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          <input
            type="text"
            placeholder="搜索账号..."
            className="w-full pl-10 pr-4 py-2.5 text-sm border border-input/50 rounded-xl bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 focus:bg-background transition-all shadow-sm"
            value={filter.search ?? ''}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {/* 主要操作按钮 */}
        <Button onClick={onAddAccount} className="shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-all">
          <Plus className="h-4 w-4 mr-1.5" />
          添加账号
        </Button>
      </div>

      {/* 统计和选择操作 */}
      <div className="flex items-center justify-between p-1">
        {/* 左侧：统计信息 */}
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary/50" />
            共 <span className="font-mono font-medium text-foreground">{stats.total}</span> 个账号
            {filteredCount !== stats.total && (
              <span className="flex items-center gap-1 text-muted-foreground/80">
                (已筛选 <span className="font-mono font-medium text-foreground">{filteredCount}</span>)
              </span>
            )}
          </span>
          {stats.expiringSoonCount > 0 && (
            <Badge variant="destructive" className="gap-1.5 shadow-sm">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
              </span>
              {stats.expiringSoonCount} 个即将到期
            </Badge>
          )}
        </div>

        {/* 右侧：选择操作和管理 */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/30 p-1 rounded-lg border border-border/30">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 hover:bg-background shadow-none"
              onClick={onManageGroups}
            >
              <FolderPlus className="h-3.5 w-3.5 mr-1.5 text-blue-500" />
              分组
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 hover:bg-background shadow-none"
              onClick={onManageTags}
            >
              <Tag className="h-3.5 w-3.5 mr-1.5 text-purple-500" />
              标签
            </Button>
          </div>

          <div className="w-px h-4 bg-border/50 mx-1" />

          <Button
            variant="ghost"
            size="sm"
            className="h-8 hover:bg-muted/50"
            onClick={onImport}
            title="导入账号"
          >
            <Upload className="h-3.5 w-3.5 mr-1.5 opacity-70" />
            导入
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 hover:bg-muted/50"
            onClick={onExport}
            title="导出账号"
          >
            <Download className="h-3.5 w-3.5 mr-1.5 opacity-70" />
            导出
          </Button>

          <div className="w-px h-4 bg-border/50 mx-1" />

          <Button
            variant={privacyMode ? "secondary" : "ghost"}
            size="sm"
            className={privacyMode ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-muted/50"}
            onClick={() => setPrivacyMode(!privacyMode)}
            title={privacyMode ? "关闭隐私模式" : "开启隐私模式"}
          >
            {privacyMode ? (
              <EyeOff className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Eye className="h-3.5 w-3.5 mr-1.5 opacity-70" />
            )}
            隐私
          </Button>

          {/* 显示已删除账号开关 */}
          {deletedCount > 0 && (
            <>
              <div className="w-px h-4 bg-border/50 mx-1" />
              <div className="flex items-center gap-2">
                <button
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all duration-200 ${
                    filter.showDeleted
                      ? 'bg-destructive text-destructive-foreground border-destructive hover:bg-destructive/90 shadow-sm'
                      : 'hover:bg-destructive/10 border-destructive/30 text-destructive hover:border-destructive/50'
                  }`}
                  onClick={() => setShowDeleted(!filter.showDeleted)}
                  title={filter.showDeleted ? '返回查看正常账号' : '查看已删除的账号'}
                >
                  {filter.showDeleted ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>返回正常</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>回收站</span>
                      <span className="bg-white/20 px-1.5 py-0.5 rounded text-[10px] ml-0.5">
                        {deletedCount}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {/* 筛选按钮与气泡 */}
          <div className="relative ml-1">
            <Button
              variant={isFilterExpanded ? "default" : "outline"}
              size="sm"
              onClick={onToggleFilter}
              title="展开/收起高级筛选"
              className={isFilterExpanded ? "shadow-md" : "border-dashed"}
            >
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              筛选
            </Button>
            {/* 筛选气泡面板 */}
            {isFilterExpanded && (
              <div className="absolute right-0 top-full mt-3 z-[100] min-w-[600px] bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                {/* 气泡箭头 */}
                <div className="absolute -top-2 right-4 w-4 h-4 bg-popover/95 border-l border-t border-border/50 rotate-45 z-[101]" />
                <div className="relative z-[102] p-1">
                   <AccountFilterPanel />
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
