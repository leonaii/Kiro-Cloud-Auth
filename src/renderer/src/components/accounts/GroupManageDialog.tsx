import { useState, useMemo } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import type { AccountGroup } from '@/types/account'
import { X, Plus, Edit2, Trash2, Users, Check, FolderOpen, Key, Copy, RefreshCw, Eye, EyeOff, XCircle } from 'lucide-react'

// 检测是否是 Electron 环境
const isElectronEnv = typeof window !== 'undefined' &&
  window.api &&
  typeof window.api.getAppVersion === 'function' &&
  !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter

interface GroupManageDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function GroupManageDialog({ isOpen, onClose }: GroupManageDialogProps): React.ReactNode {
  const { groups, accounts, addGroup, updateGroup, removeGroup, moveAccountsToGroup } = useAccountsStore()

  // 编辑状态
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editColor, setEditColor] = useState('#3b82f6')
  const [editApiKey, setEditApiKey] = useState('')
  const [showEditApiKey, setShowEditApiKey] = useState(false)

  // 新建状态
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newColor, setNewColor] = useState('#3b82f6')
  const [newApiKey, setNewApiKey] = useState('')
  const [showNewApiKey, setShowNewApiKey] = useState(false)

  // 分配账号状态
  const [assigningGroupId, setAssigningGroupId] = useState<string | null>(null)

  // 获取分组内的账号数量
  const getGroupAccountCount = (groupId: string): number => {
    return Array.from(accounts.values()).filter(acc => acc.groupId === groupId).length
  }

  // 获取未分组的账号数量
  const getUngroupedCount = (): number => {
    return Array.from(accounts.values()).filter(acc => !acc.groupId).length
  }

  // 生成随机 API Key
  const generateApiKey = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = 'sk-grp-'
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  // 复制到剪贴板
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      alert('已复制到剪贴板')
    } catch {
      alert('复制失败')
    }
  }

  // 创建分组
  const handleCreate = () => {
    if (!newName.trim()) return
    addGroup({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
      color: newColor,
      apiKey: newApiKey.trim() || undefined
    })
    setNewName('')
    setNewDescription('')
    setNewColor('#3b82f6')
    setNewApiKey('')
    setShowNewApiKey(false)
    setIsCreating(false)
  }

  // 开始编辑
  const handleStartEdit = (group: AccountGroup) => {
    setEditingId(group.id)
    setEditName(group.name)
    setEditDescription(group.description || '')
    setEditColor(group.color || '#3b82f6')
    setEditApiKey(group.apiKey || '')
    setShowEditApiKey(false)
  }

  // 保存编辑
  const handleSaveEdit = () => {
    if (!editingId || !editName.trim()) return
    updateGroup(editingId, {
      name: editName.trim(),
      description: editDescription.trim() || undefined,
      color: editColor,
      apiKey: editApiKey.trim() || undefined
    })
    setEditingId(null)
    setShowEditApiKey(false)
  }

  // 删除分组
  const handleDelete = (id: string, name: string) => {
    const count = getGroupAccountCount(id)
    const msg = count > 0
      ? `确定要删除分组「${name}」吗？\n该分组包含 ${count} 个账号，删除后这些账号将变为未分组状态。`
      : `确定要删除分组「${name}」吗？`
    if (confirm(msg)) {
      removeGroup(id)
    }
  }

  // 批量分配账号到分组（不退出分配模式，允许连续操作）
  const handleAssignAccounts = (groupId: string | undefined, accountIds: string[]) => {
    moveAccountsToGroup(accountIds, groupId)
  }

  // 获取可分配的账号列表（只返回未分组的账号）
  const getAssignableAccounts = (_groupId: string) => {
    return Array.from(accounts.values()).filter(acc => !acc.groupId)
  }

  // 获取分组内的账号列表
  const getGroupAccounts = (groupId: string) => {
    return Array.from(accounts.values()).filter(acc => acc.groupId === groupId)
  }

  const groupList = Array.from(groups.values()).sort((a, b) => a.order - b.order)

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <Card className="relative w-full max-w-2xl max-h-[85vh] overflow-hidden z-[201] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between pb-2 shrink-0">
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            分组管理
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="flex-1 overflow-auto space-y-4">
          {/* 统计信息 */}
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>共 {groupList.length} 个分组</span>
            <span>•</span>
            <span>{getUngroupedCount()} 个未分组账号</span>
          </div>

          {/* 新建分组 */}
          {isCreating ? (
            <div className="p-4 border rounded-lg space-y-3 bg-muted/30">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer"
                />
                <input
                  type="text"
                  placeholder="分组名称"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-lg text-sm"
                  autoFocus
                />
              </div>
              <input
                type="text"
                placeholder="分组描述（可选）"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              {/* API Key 输入 - 仅在 Web 端显示，Electron 客户端不显示 */}
              {!isElectronEnv && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Key className="h-3 w-3" />
                    分组专属 API Key（可选，用于限制 API 访问范围）
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showNewApiKey ? 'text' : 'password'}
                        placeholder="留空则不限制，使用默认 SK 可访问所有账号"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        className="w-full px-3 py-2 pr-10 border rounded-lg text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewApiKey(!showNewApiKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showNewApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setNewApiKey(generateApiKey())}
                      title="生成随机 API Key"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    {newApiKey && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(newApiKey)}
                          title="复制"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setNewApiKey('')}
                          title="清除 API Key"
                          className="text-destructive hover:text-destructive"
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setIsCreating(false); setNewApiKey(''); setShowNewApiKey(false) }}>
                  取消
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                  <Check className="h-4 w-4 mr-1" />
                  创建
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="w-full" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-2" />
              新建分组
            </Button>
          )}

          {/* 分组列表 */}
          <div className="space-y-2">
            {groupList.map((group) => (
              <div
                key={group.id}
                className="p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                {editingId === group.id ? (
                  // 编辑模式
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        className="w-8 h-8 rounded cursor-pointer"
                      />
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 px-3 py-1.5 border rounded text-sm"
                        autoFocus
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="分组描述"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded text-sm"
                    />
                    {/* API Key 编辑 - 仅在 Web 端显示，Electron 客户端不显示 */}
                    {!isElectronEnv && (
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground flex items-center gap-1">
                          <Key className="h-3 w-3" />
                          分组专属 API Key
                        </label>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <input
                              type={showEditApiKey ? 'text' : 'password'}
                              placeholder="留空则不限制"
                              value={editApiKey}
                              onChange={(e) => setEditApiKey(e.target.value)}
                              className="w-full px-3 py-1.5 pr-10 border rounded text-sm font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => setShowEditApiKey(!showEditApiKey)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showEditApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditApiKey(generateApiKey())}
                            title="生成随机 API Key"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          {editApiKey && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => copyToClipboard(editApiKey)}
                                title="复制"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditApiKey('')}
                                title="清除 API Key"
                                className="text-destructive hover:text-destructive"
                              >
                                <XCircle className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => { setEditingId(null); setShowEditApiKey(false) }}>
                        取消
                      </Button>
                      <Button size="sm" onClick={handleSaveEdit}>
                        保存
                      </Button>
                    </div>
                  </div>
                ) : assigningGroupId === group.id ? (
                  // 分配账号模式
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded"
                        style={{ backgroundColor: group.color || '#3b82f6' }}
                      />
                      <span className="font-medium">{group.name}</span>
                      <span className="text-sm text-muted-foreground">- 选择要添加的账号</span>
                    </div>

                    {/* 当前分组内的账号 */}
                    {getGroupAccounts(group.id).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">当前分组内的账号：</p>
                        <div className="flex flex-wrap gap-1">
                          {getGroupAccounts(group.id).map(acc => (
                            <span
                              key={acc.id}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs"
                            >
                              {acc.email}
                              <button
                                onClick={() => handleAssignAccounts(undefined, [acc.id])}
                                className="hover:text-destructive"
                                title="移出分组"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 可添加的账号 */}
                    {getAssignableAccounts(group.id).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">点击添加到此分组：</p>
                        <div className="flex flex-wrap gap-1 max-h-32 overflow-auto">
                          {getAssignableAccounts(group.id).map(acc => (
                            <button
                              key={acc.id}
                              onClick={() => handleAssignAccounts(group.id, [acc.id])}
                              className="px-2 py-0.5 bg-muted hover:bg-primary/20 rounded text-xs transition-colors"
                            >
                              {acc.email}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => setAssigningGroupId(null)}>
                        完成
                      </Button>
                    </div>
                  </div>
                ) : (
                  // 显示模式
                  <div className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded shrink-0"
                      style={{ backgroundColor: group.color || '#3b82f6' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{group.name}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {getGroupAccountCount(group.id)}
                        </span>
                        {/* API Key 图标 - 仅在 Web 端显示 */}
                        {!isElectronEnv && group.apiKey && (
                          <span className="text-xs text-green-600 flex items-center gap-1" title="已配置专属 API Key">
                            <Key className="h-3 w-3" />
                          </span>
                        )}
                      </div>
                      {group.description && (
                        <p className="text-xs text-muted-foreground truncate">{group.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setAssigningGroupId(group.id)}
                        title="管理账号"
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleStartEdit(group)}
                        title="编辑"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(group.id, group.name)}
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {groupList.length === 0 && !isCreating && (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>暂无分组</p>
                <p className="text-sm">点击上方按钮创建第一个分组</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
