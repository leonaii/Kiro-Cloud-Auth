import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'
import {
  Power,
  Copy,
  Edit,
  Trash2,
  RefreshCw,
  Info,
  MessageSquare,
  CheckCircle,
  FolderOpen,
  Tags,
  ChevronRight,
  Check,
  X,
  RotateCcw
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isElectron } from '@/lib/api'

interface ContextMenuProps {
  account: Account
  position: { x: number; y: number }
  onClose: () => void
  onEdit: (account: Account) => void
  onShowDetail: (account: Account) => void
  onChat?: (account: Account) => void
}

export function AccountContextMenu({
  account,
  position,
  onClose,
  onEdit,
  onShowDetail,
  onChat
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  // 初始位置设为 -9999 以避免闪烁，等待计算完成后再显示
  const [adjustedPosition, setAdjustedPosition] = useState({ x: -9999, y: -9999 })
  const [isPositioned, setIsPositioned] = useState(false)

  const {
    deleteAccount,
    refreshAccountToken,
    checkAccountStatus,
    setActiveAccount,
    localActiveAccountId,
    groups,
    tags,
    moveAccountsToGroup,
    addTagToAccounts,
    removeTagFromAccounts,
    restoreAccount
  } = useAccountsStore()

  const electron = isElectron()
  const isActive = electron && localActiveAccountId === account.id

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // 动态调整菜单位置，防止超出屏幕
  useLayoutEffect(() => {
    // 使用 requestAnimationFrame 确保 DOM 已渲染完成
    const calculatePosition = () => {
      if (menuRef.current) {
        const menuRect = menuRef.current.getBoundingClientRect()
        // 使用实际测量的尺寸，如果为0则使用默认值
        const menuWidth = menuRect.width > 0 ? menuRect.width : 200
        const menuHeight = menuRect.height > 0 ? menuRect.height : 400
        const padding = 16 // 距离屏幕边缘的最小间距
        
        let newX = position.x
        let newY = position.y
        
        // 获取视口尺寸
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        
        // 检查右边界：如果右侧放不下，就尝试放在鼠标左侧
        if (position.x + menuWidth > viewportWidth - padding) {
          newX = position.x - menuWidth
          // 如果左侧也放不下，则贴右边
          if (newX < padding) {
            newX = viewportWidth - menuWidth - padding
          }
        }
        
        // 检查下边界：如果底部放不下，就尝试放在鼠标上方
        if (position.y + menuHeight > viewportHeight - padding) {
          newY = position.y - menuHeight
          // 如果上方也放不下，则贴底边
          if (newY < padding) {
            newY = viewportHeight - menuHeight - padding
          }
        }
        
        // 确保左边界和上边界
        newX = Math.max(padding, newX)
        newY = Math.max(padding, newY)
        
        // 最终边界检查
        newX = Math.min(newX, viewportWidth - menuWidth - padding)
        newY = Math.min(newY, viewportHeight - menuHeight - padding)
        
        setAdjustedPosition({ x: newX, y: newY })
        setIsPositioned(true)
      }
    }
    
    // 使用 requestAnimationFrame 确保在下一帧计算位置
    requestAnimationFrame(calculatePosition)
  }, [position])

  const handleSwitch = async () => {
    if (!electron) return
    onClose()

    const { credentials } = account
    const { machineIdConfig, changeMachineId, bindMachineIdToAccount, accountMachineIds } =
      useAccountsStore.getState()

    if (!credentials.refreshToken) {
      alert('账号凭证不完整，无法切换')
      return
    }

    if (machineIdConfig.bindMachineIdToAccount) {
      try {
        let boundMachineId = accountMachineIds[account.id]
        if (!boundMachineId) {
          boundMachineId = await window.api.machineIdGenerateRandom()
          bindMachineIdToAccount(account.id, boundMachineId)
        }
        if (machineIdConfig.useBindedMachineId) {
          await changeMachineId(boundMachineId)
        }
      } catch (error) {
        console.error('[MachineId] Failed to switch:', error)
      }
    }

    const result = await window.api.switchAccount({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId || '',
      clientSecret: credentials.clientSecret || '',
      region: credentials.region || 'us-east-1',
      authMethod: credentials.authMethod,
      provider: credentials.provider
    })

    if (result.success) {
      setActiveAccount(account.id)
    } else {
      alert(`切换失败: ${result.error}`)
    }
  }

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(account.email)
    onClose()
  }

  const handleCopyToken = () => {
    if (account.credentials.refreshToken) {
      navigator.clipboard.writeText(account.credentials.refreshToken)
    }
    onClose()
  }

  const handleCopyCredentials = () => {
    const credentials = {
      refreshToken: account.credentials.refreshToken,
      clientId: account.credentials.clientId,
      clientSecret: account.credentials.clientSecret
    }
    navigator.clipboard.writeText(JSON.stringify(credentials, null, 2))
    onClose()
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await refreshAccountToken(account.id)
    setIsRefreshing(false)
    onClose()
  }

  const handleCheck = async () => {
    setIsChecking(true)
    await checkAccountStatus(account.id)
    setIsChecking(false)
    onClose()
  }

  const handleDelete = async () => {
    if (confirm(`确定要删除账号 ${account.email} 吗？`)) {
      await deleteAccount(account.id)
    }
    onClose()
  }

  const handleRestore = async () => {
    if (confirm(`确定要恢复账号 ${account.email} 吗？`)) {
      await restoreAccount(account.id)
    }
    onClose()
  }

  const isDeleted = account.isDel

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        "fixed z-[9999] min-w-[180px] bg-popover border rounded-lg shadow-xl py-1",
        isPositioned ? "animate-in fade-in-0 zoom-in-95" : "opacity-0"
      )}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
        // 确保菜单在最上层
        isolation: 'isolate'
      }}
    >
      {/* 账号信息 */}
      <div className="px-3 py-2 border-b">
        <p className="text-sm font-medium truncate">{account.email}</p>
        <p className="text-xs text-muted-foreground">{account.subscription.title || account.subscription.type}</p>
      </div>

      {/* Electron 专属操作 */}
      {electron && (
        <>
          <MenuItem
            icon={isActive ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Power className="h-4 w-4" />}
            label={isActive ? '当前使用中' : '切换到此账号'}
            onClick={handleSwitch}
            disabled={isActive}
          />
          <div className="border-t my-1" />
        </>
      )}

      {/* 已删除账号只显示查看详情、恢复和永久删除 */}
      {isDeleted ? (
        <>
          <MenuItem
            icon={<Info className="h-4 w-4" />}
            label="查看详情"
            onClick={() => { onShowDetail(account); onClose() }}
          />
          <div className="border-t my-1" />
          <MenuItem
            icon={<RotateCcw className="h-4 w-4 text-green-600" />}
            label="恢复账号"
            onClick={handleRestore}
          />
        </>
      ) : (
        <>
          {/* 通用操作 */}
          <MenuItem
            icon={<Info className="h-4 w-4" />}
            label="查看详情"
            onClick={() => { onShowDetail(account); onClose() }}
          />
          {/* <MenuItem
            icon={<Edit className="h-4 w-4" />}
            label="编辑账号"
            onClick={() => { onEdit(account); onClose() }}
          /> */}

          {onChat && (
            <MenuItem
              icon={<MessageSquare className="h-4 w-4" />}
              label="API 测试"
              onClick={() => { onChat(account); onClose() }}
            />
          )}

          {/* 分配到分组 */}
          <SubMenuItem
            icon={<FolderOpen className="h-4 w-4" />}
            label="分配到分组"
            menuRef={menuRef}
          >
        {Array.from(groups.values()).length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            暂无分组
          </div>
        ) : (
          <>
            {Array.from(groups.values()).map((group) => (
              <SubMenuOption
                key={group.id}
                label={group.name}
                color={group.color}
                isSelected={account.groupId === group.id}
                onClick={() => {
                  moveAccountsToGroup([account.id], group.id)
                  onClose()
                }}
              />
            ))}
            {account.groupId && (
              <>
                <div className="border-t my-1" />
                <SubMenuOption
                  label="移出分组"
                  icon={<X className="h-3 w-3" />}
                  onClick={() => {
                    moveAccountsToGroup([account.id], undefined)
                    onClose()
                  }}
                />
              </>
            )}
          </>
        )}
      </SubMenuItem>

          {/* 分配到标签 */}
          <SubMenuItem
            icon={<Tags className="h-4 w-4" />}
            label="分配到标签"
            menuRef={menuRef}
          >
            {Array.from(tags.values()).length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                暂无标签
              </div>
            ) : (
              Array.from(tags.values()).map((tag) => {
                const hasTag = account.tags.includes(tag.id)
                return (
                  <SubMenuOption
                    key={tag.id}
                    label={tag.name}
                    color={tag.color}
                    isSelected={hasTag}
                    onClick={() => {
                      if (hasTag) {
                        removeTagFromAccounts([account.id], tag.id)
                      } else {
                        addTagToAccounts([account.id], tag.id)
                      }
                      // 标签操作不关闭菜单，允许多选
                    }}
                  />
                )
              })
            )}
          </SubMenuItem>

          {/* 检查状态和刷新 Token - 仅 Web 模式显示 */}
          {!electron && (
            <>
              <div className="border-t my-1" />
              <MenuItem
                icon={isChecking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                label="检查状态"
                onClick={handleCheck}
                disabled={isChecking}
              />
              <MenuItem
                icon={isRefreshing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                label="刷新 Token"
                onClick={handleRefresh}
                disabled={isRefreshing}
              />
            </>
          )}

          <div className="border-t my-1" />

          <MenuItem
            icon={<Copy className="h-4 w-4" />}
            label="复制邮箱"
            onClick={handleCopyEmail}
          />
          {/* <MenuItem
            icon={<Copy className="h-4 w-4" />}
            label="复制 Token"
            onClick={handleCopyToken}
          /> */}
          <MenuItem
            icon={<Copy className="h-4 w-4" />}
            label="复制凭证"
            onClick={handleCopyCredentials}
          />

          {/* 删除功能仅在 Web 模式下显示 */}
          {!electron && (
            <>
              <div className="border-t my-1" />
              <MenuItem
                icon={<Trash2 className="h-4 w-4" />}
                label="删除账号"
                onClick={handleDelete}
                danger
              />
            </>
          )}
        </>
      )}
    </div>,
    document.body
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
        disabled
          ? 'text-muted-foreground cursor-not-allowed'
          : danger
            ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
            : 'hover:bg-muted'
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

/**
 * 带子菜单的菜单项组件
 */
function SubMenuItem({
  icon,
  label,
  children,
  menuRef
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  menuRef: React.RefObject<HTMLDivElement | null>
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [subMenuPosition, setSubMenuPosition] = useState<'right' | 'left'>('right')
  const itemRef = useRef<HTMLDivElement>(null)
  const subMenuRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    
    // 计算子菜单位置
    if (itemRef.current && menuRef.current) {
      const itemRect = itemRef.current.getBoundingClientRect()
      const menuRect = menuRef.current.getBoundingClientRect()
      const subMenuWidth = 180 // 预估子菜单宽度
      
      // 检查右侧是否有足够空间
      if (menuRect.right + subMenuWidth > window.innerWidth) {
        setSubMenuPosition('left')
      } else {
        setSubMenuPosition('right')
      }
    }
    
    setIsOpen(true)
  }, [menuRef])

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 150) // 延迟关闭，给用户时间移动到子菜单
  }, [])

  const handleSubMenuMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const handleSubMenuMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 150)
  }, [])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return (
    <div
      ref={itemRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors cursor-pointer',
          isOpen ? 'bg-muted' : 'hover:bg-muted'
        )}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span>{label}</span>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* 子菜单 */}
      {isOpen && (
        <div
          ref={subMenuRef}
          className={cn(
            'absolute top-0 min-w-[160px] bg-popover border rounded-lg shadow-lg py-1 z-[101]',
            'animate-in fade-in-0 zoom-in-95',
            subMenuPosition === 'right' ? 'left-full ml-1' : 'right-full mr-1'
          )}
          style={{
            maxHeight: '300px',
            overflowY: 'auto'
          }}
          onMouseEnter={handleSubMenuMouseEnter}
          onMouseLeave={handleSubMenuMouseLeave}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * 子菜单选项组件
 */
function SubMenuOption({
  label,
  color,
  icon,
  isSelected,
  onClick
}: {
  label: string
  color?: string
  icon?: React.ReactNode
  isSelected?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted',
        isSelected && 'bg-muted/50'
      )}
      onClick={onClick}
    >
      {/* 颜色圆点或图标 */}
      {color ? (
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
      ) : icon ? (
        <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
          {icon}
        </span>
      ) : (
        <span className="w-3 h-3 flex-shrink-0" />
      )}
      
      {/* 标签名称 */}
      <span className="flex-1 text-left truncate">{label}</span>
      
      {/* 选中状态 */}
      {isSelected && (
        <Check className="h-4 w-4 text-primary flex-shrink-0" />
      )}
    </button>
  )
}

export default AccountContextMenu
