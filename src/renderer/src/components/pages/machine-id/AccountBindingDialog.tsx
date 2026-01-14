import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '@/components/ui'
import { Users, Search, X, Edit3, Shuffle, Copy, Trash2, Check } from 'lucide-react'

interface AccountBindingDialogProps {
  open: boolean
  onClose: () => void
  accounts: Map<string, any>
  accountMachineIds: Record<string, string>
  editingAccountId: string | null
  editingMachineId: string
  onStartEdit: (accountId: string) => void
  onSave: (accountId: string) => void
  onCancelEdit: () => void
  onRandomize: (accountId: string) => void
  onRemove: (accountId: string) => void
  onCopy: (text: string) => void
  setEditingMachineId: (id: string) => void
}

export function AccountBindingDialog({
  open,
  onClose,
  accounts,
  accountMachineIds,
  editingAccountId,
  editingMachineId,
  onStartEdit,
  onSave,
  onCancelEdit,
  onRandomize,
  onRemove,
  onCopy,
  setEditingMachineId
}: AccountBindingDialogProps) {
  const [accountSearchQuery, setAccountSearchQuery] = useState('')

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-0">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-all duration-300"
        onClick={onClose}
      />

      {/* 对话框内容 */}
      <div className="relative bg-background/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Users className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">账户机器码管理</h2>
            <Badge variant="secondary" className="bg-background/50 border-white/10">{accounts.size} 个账户</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-white/10 rounded-full"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 搜索框 */}
        <div className="px-6 pt-4">
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <input
              type="text"
              value={accountSearchQuery}
              onChange={(e) => setAccountSearchQuery(e.target.value)}
              placeholder="搜索账户..."
              className="w-full pl-10 pr-10 py-2.5 text-sm bg-black/20 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all placeholder:text-muted-foreground/50"
            />
            {accountSearchQuery && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 p-0 hover:bg-white/10 rounded-full"
                onClick={() => setAccountSearchQuery('')}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        {/* 账户列表 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {Array.from(accounts.values())
            .filter((account) => {
              if (!accountSearchQuery.trim()) return true
              const query = accountSearchQuery.toLowerCase()
              return (
                account.email?.toLowerCase().includes(query) ||
                account.nickname?.toLowerCase().includes(query) ||
                accountMachineIds[account.id]?.toLowerCase().includes(query)
              )
            })
            .map((account) => {
              const boundMachineId = accountMachineIds[account.id]
              const isEditing = editingAccountId === account.id

              return (
                <div key={account.id} className="p-4 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition-colors group">
                  {/* 账户信息行 */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary text-sm font-bold ring-1 ring-white/10 shadow-sm">
                        {(account.nickname || account.email || '?')[0].toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-semibold text-sm truncate max-w-[200px] text-foreground">
                          {account.nickname || account.email}
                        </span>
                        {account.nickname && account.email && (
                          <span className="text-xs text-muted-foreground truncate max-w-[200px] font-mono opacity-70">
                            {account.email}
                          </span>
                        )}
                      </div>
                      {boundMachineId && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                          已绑定
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {!isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 hover:bg-white/10 rounded-lg"
                            onClick={() => onStartEdit(account.id)}
                            title="编辑"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 hover:bg-white/10 rounded-lg"
                            onClick={() => onRandomize(account.id)}
                            title="随机"
                          >
                            <Shuffle className="h-3.5 w-3.5" />
                          </Button>
                          {boundMachineId && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 hover:bg-white/10 rounded-lg"
                                onClick={() => onCopy(boundMachineId)}
                                title="复制"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 hover:bg-red-500/10 text-destructive hover:text-destructive rounded-lg"
                                onClick={() => onRemove(account.id)}
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7 px-2 text-xs rounded-lg"
                            onClick={() => onSave(account.id)}
                          >
                            <Check className="h-3.5 w-3.5 mr-1" />
                            保存
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs rounded-lg hover:bg-white/10"
                            onClick={onCancelEdit}
                          >
                            取消
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 rounded-lg hover:bg-white/10"
                            onClick={() => onRandomize(account.id)}
                            title="随机"
                          >
                            <Shuffle className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 机器码显示/编辑 */}
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingMachineId}
                      onChange={(e) => setEditingMachineId(e.target.value)}
                      placeholder="输入 UUID 格式机器码"
                      className="w-full px-3 py-2 text-xs font-mono bg-black/20 border border-primary/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20"
                      autoFocus
                    />
                  ) : boundMachineId ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-black/20 rounded-lg border border-white/5">
                      <code className="text-xs font-mono flex-1 text-muted-foreground">{boundMachineId}</code>
                    </div>
                  ) : (
                    <div className="px-3 py-2 bg-white/5 rounded-lg border border-dashed border-white/10 text-center">
                      <span className="text-xs text-muted-foreground/50">未绑定</span>
                    </div>
                  )}
                </div>
              )
            })}

          {accounts.size === 0 && (
            <div className="text-center py-12">
              <Users className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground font-medium">暂无账户</p>
              <p className="text-sm text-muted-foreground/50">请先添加账户</p>
            </div>
          )}

          {accounts.size > 0 && accountSearchQuery &&
            Array.from(accounts.values()).filter((account) => {
              const query = accountSearchQuery.toLowerCase()
              return (
                account.email?.toLowerCase().includes(query) ||
                account.nickname?.toLowerCase().includes(query) ||
                accountMachineIds[account.id]?.toLowerCase().includes(query)
              )
            }).length === 0 && (
              <div className="text-center py-8">
                <Search className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground font-medium">未找到匹配的账户</p>
                <p className="text-sm text-muted-foreground/50">尝试其他关键词</p>
              </div>
            )}
        </div>
      </div>
    </div>,
    document.body
  )
}