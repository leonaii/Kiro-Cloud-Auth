import { useEffect, useState } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge } from '../ui'
import {
  Fingerprint,
  RefreshCw,
  RotateCcw,
  Copy,
  Download,
  Upload,
  Shield,
  Link2,
  Shuffle,
  History,
  AlertTriangle,
  CheckCircle,
  Monitor
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { HistoryDialog } from './machine-id/HistoryDialog'
import { AccountBindingDialog } from './machine-id/AccountBindingDialog'

export function MachineIdPage(): React.ReactNode {
  const {
    machineIdConfig,
    currentMachineId,
    originalMachineId,
    originalBackupTime,
    accountMachineIds,
    machineIdHistory,
    accounts,
    setMachineIdConfig,
    refreshCurrentMachineId,
    changeMachineId,
    restoreOriginalMachineId,
    clearMachineIdHistory,
    bindMachineIdToAccount
  } = useAccountsStore()

  const [isLoading, setIsLoading] = useState(false)
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null)
  const [osType, setOsType] = useState<string>('unknown')
  const [customMachineId, setCustomMachineId] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showAccountBindings, setShowAccountBindings] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editingMachineId, setEditingMachineId] = useState('')

  // 初始化
  useEffect(() => {
    const init = async (): Promise<void> => {
      setIsLoading(true)
      try {
        // 获取操作系统类型
        const os = await window.api.machineIdGetOSType()
        setOsType(os)

        // 检查管理员权限
        const admin = await window.api.machineIdCheckAdmin()
        setHasAdmin(admin)

        // 刷新当前机器码
        await refreshCurrentMachineId()
      } catch (error) {
        console.error('初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [refreshCurrentMachineId])

  // 复制机器码到剪贴板
  const copyToClipboard = (text: string): void => {
    navigator.clipboard.writeText(text)
  }

  // 随机生成并应用新机器码
  const handleRandomChange = async (): Promise<void> => {
    setIsLoading(true)
    try {
      await changeMachineId()
      await refreshCurrentMachineId()
    } finally {
      setIsLoading(false)
    }
  }

  // 应用自定义机器码
  const handleCustomChange = async (): Promise<void> => {
    if (!customMachineId.trim()) return
    setIsLoading(true)
    try {
      await changeMachineId(customMachineId.trim())
      await refreshCurrentMachineId()
      setCustomMachineId('')
    } finally {
      setIsLoading(false)
    }
  }

  // 恢复原始机器码
  const handleRestore = async (): Promise<void> => {
    setIsLoading(true)
    try {
      await restoreOriginalMachineId()
      await refreshCurrentMachineId()
    } finally {
      setIsLoading(false)
    }
  }

  // 备份机器码到文件
  const handleBackupToFile = async (): Promise<void> => {
    if (!currentMachineId) return
    await window.api.machineIdBackupToFile(currentMachineId)
  }

  // 从文件恢复机器码
  const handleRestoreFromFile = async (): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await window.api.machineIdRestoreFromFile()
      if (result.success && result.machineId) {
        await changeMachineId(result.machineId)
        await refreshCurrentMachineId()
      }
    } finally {
      setIsLoading(false)
    }
  }

  // 请求管理员权限
  const handleRequestAdmin = async (): Promise<void> => {
    await window.api.machineIdRequestAdminRestart()
  }

  // 生成随机 UUID
  const generateRandomUUID = (): string => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  // 开始编辑账户机器码
  const startEditAccountMachineId = (accountId: string): void => {
    setEditingAccountId(accountId)
    setEditingMachineId(accountMachineIds[accountId] || '')
  }

  // 保存账户机器码
  const saveAccountMachineId = (accountId: string): void => {
    if (editingMachineId.trim()) {
      bindMachineIdToAccount(accountId, editingMachineId.trim())
    }
    setEditingAccountId(null)
    setEditingMachineId('')
  }

  // 取消编辑
  const cancelEditAccountMachineId = (): void => {
    setEditingAccountId(null)
    setEditingMachineId('')
  }

  // 为账户生成随机机器码
  const randomizeAccountMachineId = (accountId: string): void => {
    const newMachineId = generateRandomUUID()
    bindMachineIdToAccount(accountId, newMachineId)
    if (editingAccountId === accountId) {
      setEditingMachineId(newMachineId)
    }
  }

  // 删除账户机器码绑定
  const removeAccountMachineId = (accountId: string): void => {
    const { accountMachineIds: currentBindings } = useAccountsStore.getState()
    const newBindings = { ...currentBindings }
    delete newBindings[accountId]
    useAccountsStore.setState({ accountMachineIds: newBindings })
    useAccountsStore.getState().saveToStorage()
  }

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString('zh-CN')
  }

  // 获取操作系统显示名称
  const getOSName = (): string => {
    switch (osType) {
      case 'windows': return 'Windows'
      case 'macos': return 'macOS'
      case 'linux': return 'Linux'
      default: return '未知'
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-y-auto">
      {/* 页面头部 - 简洁风格 */}
      <div className="px-0 py-1 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
            <Fingerprint className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">机器码管理</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              管理设备标识符，防止账号关联和封禁
            </p>
          </div>
        </div>
      </div>

      {/* 权限警告 */}
      {hasAdmin === false && (
        <Card className="border-amber-500/30 bg-amber-500/5 backdrop-blur-md shadow-lg animate-in fade-in slide-in-from-top-4 duration-500">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-2 rounded-full bg-amber-500/10">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="font-semibold text-amber-700 dark:text-amber-400">需要管理员权限</p>
                  <p className="text-sm text-amber-600/80 dark:text-amber-500/80">修改机器码需要以管理员身份运行应用</p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleRequestAdmin} className="border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-600">
                <Shield className="h-4 w-4 mr-2" />
                以管理员重启
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* 当前机器码 */}
        <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300 group">
          <CardHeader className="border-b border-border/30 pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-3">
              <Monitor className="h-5 w-5 text-primary" />
              当前机器码
              <Badge variant="secondary" className="bg-white/5 border-white/10 ml-auto">{getOSName()}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="p-4 bg-muted/30 rounded-xl font-mono text-sm break-all border border-border/30 shadow-inner">
              {isLoading ? (
                <span className="text-muted-foreground animate-pulse">加载中...</span>
              ) : currentMachineId || (
                <span className="text-muted-foreground">无法获取</span>
              )}
            </div>
            {/* 最后修改时间 */}
            {machineIdHistory.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/30 p-2 rounded-lg w-fit">
                <History className="h-3 w-3" />
                最后修改: {formatTime(machineIdHistory[machineIdHistory.length - 1].timestamp)}
              </div>
            )}
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 rounded-xl border-border/50 hover:bg-muted/50"
                onClick={() => copyToClipboard(currentMachineId)}
                disabled={!currentMachineId}
              >
                <Copy className="h-4 w-4 mr-2" />
                复制
              </Button>
              <Button
                variant="outline"
                className="flex-1 rounded-xl border-border/50 hover:bg-muted/50"
                onClick={() => refreshCurrentMachineId()}
                disabled={isLoading}
              >
                <RefreshCw className={cn("h-4 w-4 mr-2", isLoading && "animate-spin")} />
                刷新
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 原始机器码备份 */}
        <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300 group">
          <CardHeader className="border-b border-border/30 pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-3">
              <Shield className="h-5 w-5 text-green-500" />
              原始机器码备份
              {originalMachineId && (
                <Badge variant="secondary" className="ml-auto bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  已备份
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {originalMachineId ? (
              <>
                <div className="p-4 bg-muted/30 rounded-xl font-mono text-sm break-all border border-border/30 shadow-inner relative group/code">
                  {originalMachineId}
                  <div className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
                     <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => copyToClipboard(originalMachineId)}>
                        <Copy className="h-3 w-3" />
                     </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/30 p-2 rounded-lg w-fit">
                  <History className="h-3 w-3" />
                  备份时间: {originalBackupTime ? formatTime(originalBackupTime) : '未知'}
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1 rounded-xl border-border/50 hover:bg-muted/50"
                    onClick={() => copyToClipboard(originalMachineId)}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    复制
                  </Button>
                  <Button
                    className="flex-1 rounded-xl shadow-md transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                    onClick={handleRestore}
                    disabled={isLoading || currentMachineId === originalMachineId}
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    恢复原始
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground space-y-4">
                 <div className="p-4 bg-muted/30 rounded-full">
                    <Shield className="h-8 w-8 opacity-50" />
                 </div>
                <p className="text-sm font-medium">
                  首次修改机器码时将自动备份原始值
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 机器码操作 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-lg font-semibold flex items-center gap-3">
            <Shuffle className="h-5 w-5 text-purple-500" />
            机器码操作
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 随机生成 */}
            <div className="p-6 rounded-xl border border-border/40 bg-muted/20 space-y-4 hover:bg-muted/40 transition-colors duration-300">
              <div className="space-y-1">
                <h4 className="font-semibold text-foreground">随机生成新机器码</h4>
                <p className="text-sm text-muted-foreground">
                  一键生成随机 UUID 格式的机器码并应用
                </p>
              </div>
              <Button onClick={handleRandomChange} disabled={isLoading} className="w-full rounded-xl shadow-md">
                <Shuffle className="h-4 w-4 mr-2" />
                随机生成并应用
              </Button>
            </div>

            {/* 自定义机器码 */}
            <div className="p-6 rounded-xl border border-border/40 bg-muted/20 space-y-4 hover:bg-muted/40 transition-colors duration-300">
              <div className="space-y-1">
                <h4 className="font-semibold text-foreground">自定义机器码</h4>
                <p className="text-sm text-muted-foreground">
                   手动输入特定的机器码
                </p>
              </div>
              <div className="flex gap-2">
                 <input
                    type="text"
                    placeholder="输入 UUID 格式机器码..."
                    value={customMachineId}
                    onChange={(e) => setCustomMachineId(e.target.value)}
                    className="flex-1 px-3 py-2 text-sm border border-border/50 rounded-xl bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                  />
                  <Button
                    onClick={handleCustomChange}
                    disabled={isLoading || !customMachineId.trim()}
                    variant="outline"
                    className="rounded-xl border-border/50"
                  >
                    应用
                  </Button>
              </div>
            </div>
          </div>

          {/* 文件操作 */}
          <div className="flex gap-4 pt-4 border-t border-border/30">
            <Button variant="outline" size="sm" onClick={handleBackupToFile} disabled={!currentMachineId} className="rounded-xl border-border/50 hover:bg-muted/50">
              <Download className="h-4 w-4 mr-2" />
              导出到文件
            </Button>
            <Button variant="outline" size="sm" onClick={handleRestoreFromFile} disabled={isLoading} className="rounded-xl border-border/50 hover:bg-muted/50">
              <Upload className="h-4 w-4 mr-2" />
              从文件导入
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 自动化设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-lg font-semibold flex items-center gap-3">
            <Link2 className="h-5 w-5 text-blue-500" />
            自动化设置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-4">
          {/* 切号时自动更换 */}
          <div className="flex items-center justify-between p-4 rounded-xl hover:bg-muted/30 transition-colors duration-300">
            <div className="space-y-1">
              <p className="font-medium text-foreground">切换账号时自动更换机器码</p>
              <p className="text-sm text-muted-foreground">
                每次切换账号时自动生成并应用新的机器码
              </p>
            </div>
            <Button
              variant={machineIdConfig.autoSwitchOnAccountChange ? "default" : "outline"}
              size="sm"
              onClick={() => setMachineIdConfig({ autoSwitchOnAccountChange: !machineIdConfig.autoSwitchOnAccountChange })}
              className={cn("rounded-lg transition-all duration-300", machineIdConfig.autoSwitchOnAccountChange ? "shadow-md" : "border-border/50")}
            >
              {machineIdConfig.autoSwitchOnAccountChange ? '已开启' : '已关闭'}
            </Button>
          </div>

          {/* 使用绑定的机器码 */}
          {machineIdConfig.bindMachineIdToAccount && (
            <div className="flex items-center justify-between p-4 rounded-xl hover:bg-muted/30 transition-colors duration-300 border-t border-border/30">
              <div className="pl-4 border-l-2 border-primary/20">
                <p className="font-medium text-foreground">使用绑定的唯一机器码</p>
                <p className="text-sm text-muted-foreground">
                  关闭时每次切换将随机生成新机器码
                </p>
              </div>
              <Button
                variant={machineIdConfig.useBindedMachineId ? "default" : "outline"}
                size="sm"
                onClick={() => setMachineIdConfig({ useBindedMachineId: !machineIdConfig.useBindedMachineId })}
                className={cn("rounded-lg transition-all duration-300", machineIdConfig.useBindedMachineId ? "shadow-md" : "border-border/50")}
              >
                {machineIdConfig.useBindedMachineId ? '已开启' : '已关闭'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 历史记录按钮 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300 group cursor-pointer" onClick={() => setShowHistory(true)}>
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted/30 group-hover:bg-muted/50 transition-colors">
                <History className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
              </div>
              <div>
                <p className="font-medium text-foreground">变更历史</p>
                <p className="text-sm text-muted-foreground group-hover:text-muted-foreground/80">
                  共 {machineIdHistory.length} 条记录
                </p>
              </div>
            </div>
            <Button variant="ghost" className="hover:bg-muted/50">
              查看历史
            </Button>
          </div>
        </CardContent>
      </Card>

      <HistoryDialog
        open={showHistory}
        onClose={() => setShowHistory(false)}
        history={machineIdHistory}
        accounts={accounts}
        onClear={clearMachineIdHistory}
        onCopy={copyToClipboard}
        formatTime={formatTime}
      />

      <AccountBindingDialog
        open={showAccountBindings}
        onClose={() => setShowAccountBindings(false)}
        accounts={accounts}
        accountMachineIds={accountMachineIds}
        editingAccountId={editingAccountId}
        editingMachineId={editingMachineId}
        onStartEdit={startEditAccountMachineId}
        onSave={saveAccountMachineId}
        onCancelEdit={cancelEditAccountMachineId}
        onRandomize={randomizeAccountMachineId}
        onRemove={removeAccountMachineId}
        onCopy={copyToClipboard}
        setEditingMachineId={setEditingMachineId}
      />

      {/* 平台说明 */}
      <div className="rounded-xl border border-dashed border-border/40 p-4 bg-muted/20 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">平台说明</p>
              <ul className="list-disc list-inside space-y-1 opacity-80">
                <li><strong>Windows</strong>: 修改注册表 MachineGuid，需要管理员权限</li>
                <li><strong>macOS</strong>: 使用应用层覆盖方式，原生硬件 UUID 无法修改</li>
                <li><strong>Linux</strong>: 修改 /etc/machine-id，需要 root 权限</li>
              </ul>
              <p className="pt-2 text-amber-600 dark:text-amber-400 font-medium">
                ⚠️ 修改机器码可能影响部分软件的授权，请谨慎操作
              </p>
            </div>
          </div>
      </div>
    </div>
  )
}