import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Toggle, Select } from '../ui'
import { SteeringEditor, McpServerEditor } from '../kiro'
import { useAccountsStore } from '@/store/accounts'
import { cn } from '@/lib/utils'
import {
  FileText,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  FolderOpen,
  AlertCircle,
  Edit,
  Sparkles,
  Shield,
  Zap,
  Settings2,
  Terminal,
  Lock,
  Unlock,
  Globe,
  Info
} from 'lucide-react'

interface KiroSettings {
  agentAutonomy: string
  modelSelection: string
  enableDebugLogs: boolean
  enableTabAutocomplete: boolean
  enableCodebaseIndexing: boolean
  usageSummary: boolean
  codeReferences: boolean
  configureMCP: string
  trustedCommands: string[]
  commandDenylist: string[]
  ignoreFiles: string[]
  mcpApprovedEnvVars: string[]
  notificationsActionRequired: boolean
  notificationsFailure: boolean
  notificationsSuccess: boolean
  notificationsBilling: boolean
}

interface McpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers: Record<string, McpServer>
}

// 模型锁定状态存储 key
const MODEL_LOCK_KEY = 'kiro-model-lock'

// 默认禁止的危险命令
const defaultDenyCommands = [
  'rm -rf *',
  'rm -rf /',
  'rm -rf ~',
  'del /f /s /q *',
  'format',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'wget * | sh',
  'curl * | sh',
  'shutdown',
  'reboot',
  'init 0',
  'init 6'
]

// Kiro 默认设置
const defaultSettings: KiroSettings = {
  agentAutonomy: 'Autopilot',
  modelSelection: 'auto',
  enableDebugLogs: false,
  enableTabAutocomplete: false,
  enableCodebaseIndexing: false,
  usageSummary: true,
  codeReferences: false,
  configureMCP: 'Enabled',
  trustedCommands: [],
  commandDenylist: [],
  ignoreFiles: [],
  mcpApprovedEnvVars: [],
  notificationsActionRequired: true,
  notificationsFailure: false,
  notificationsSuccess: false,
  notificationsBilling: true
}

const modelOptions = [
  { value: 'auto', label: 'Auto', description: '自动选择最佳模型' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: '最新 Sonnet 模型' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4', description: '混合推理与编码' },
  { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', description: '最新 Haiku 模型' },
  { value: 'claude-opus-4.5', label: 'Claude Opus 4.5', description: '最强大模型' }
]

const autonomyOptions = [
  { value: 'Autopilot', label: 'Autopilot (自动执行)', description: 'Agent 自动执行任务' },
  { value: 'Supervised', label: 'Supervised (需确认)', description: '每个步骤需要手动确认' }
]

const mcpOptions = [
  { value: 'Enabled', label: '启用', description: '允许 MCP 服务器连接' },
  { value: 'Disabled', label: '禁用', description: '禁用所有 MCP 功能' }
]

// 读取模型锁定状态
function loadModelLock(): { locked: boolean; model: string | null } {
  try {
    const saved = localStorage.getItem(MODEL_LOCK_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('[ModelLock] Failed to load:', e)
  }
  return { locked: false, model: null }
}

// 保存模型锁定状态
function saveModelLock(locked: boolean, model: string | null) {
  try {
    localStorage.setItem(MODEL_LOCK_KEY, JSON.stringify({ locked, model }))
  } catch (e) {
    console.error('[ModelLock] Failed to save:', e)
  }
}

export function KiroSettingsPage() {
  const [settings, setSettings] = useState<KiroSettings>(defaultSettings)
  const [mcpConfig, setMcpConfig] = useState<McpConfig>({ mcpServers: {} })
  const [steeringFiles, setSteeringFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 从 localStorage 初始化锁定状态
  const [modelLocked, setModelLocked] = useState(() => loadModelLock().locked)
  const [lockedModel, setLockedModel] = useState<string | null>(() => loadModelLock().model)

  // 用于防止循环保存
  const isRestoringRef = useRef(false)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [expandedSections, setExpandedSections] = useState({
    agent: true,
    proxy: true,
    mcp: true,
    steering: true,
    commands: false
  })

  // 代理设置（从 store 获取）
  const { proxyEnabled, proxyUrl, setProxy } = useAccountsStore()
  const [tempProxyUrl, setTempProxyUrl] = useState(proxyUrl)

  // 同步 proxyUrl 变化
  useEffect(() => {
    setTempProxyUrl(proxyUrl)
  }, [proxyUrl])

  const [newTrustedCommand, setNewTrustedCommand] = useState('')
  const [newDenyCommand, setNewDenyCommand] = useState('')
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [editingMcp, setEditingMcp] = useState<{ name?: string; server?: McpServer } | null>(null)

  // 实时保存设置（防抖）
  const autoSave = useCallback((newSettings: KiroSettings) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(() => {
      window.api.saveKiroSettings(newSettings as unknown as Record<string, unknown>)
        .then(() => console.log('[AutoSave] Settings saved'))
        .catch(console.error)
    }, 300)
  }, [])

  // 更新设置并自动保存
  const updateSettings = useCallback((updater: (prev: KiroSettings) => KiroSettings) => {
    setSettings(prev => {
      const newSettings = updater(prev)
      autoSave(newSettings)
      return newSettings
    })
  }, [autoSave])

  // 加载设置
  const loadKiroSettings = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const result = await window.api.getKiroSettings()
      if (result.settings) {
        const filteredSettings = Object.fromEntries(
          Object.entries(result.settings).filter(([, v]) => v !== undefined)
        ) as Partial<KiroSettings>

        const newSettings = { ...defaultSettings, ...filteredSettings }

        // 如果模型被锁定且外部修改了模型，恢复到锁定的模型
        if (modelLocked && lockedModel && newSettings.modelSelection !== lockedModel) {
          isRestoringRef.current = true
          newSettings.modelSelection = lockedModel
          // 静默恢复，不触发页面更新
          window.api.saveKiroSettings(newSettings as unknown as Record<string, unknown>)
            .then(() => console.log('[ModelLock] Restored to:', lockedModel))
            .catch(console.error)
            .finally(() => { isRestoringRef.current = false })
        }

        setSettings(newSettings)
      }
      if (result.mcpConfig) setMcpConfig(result.mcpConfig as McpConfig)
      if (result.steeringFiles) setSteeringFiles(result.steeringFiles)
    } catch (err) {
      if (!silent) setError('加载 Kiro 设置失败')
      console.error(err)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [modelLocked, lockedModel])

  // 初始加载和自动刷新
  useEffect(() => {
    loadKiroSettings(false)
    const interval = setInterval(() => loadKiroSettings(true), 5000)
    return () => {
      clearInterval(interval)
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }
  }, [loadKiroSettings])

  // 手动刷新
  const handleRefresh = async () => {
    setRefreshing(true)
    await loadKiroSettings(true)
    setTimeout(() => setRefreshing(false), 500)
  }

  // 切换模型锁定
  const toggleModelLock = () => {
    if (!modelLocked) {
      setLockedModel(settings.modelSelection)
      setModelLocked(true)
      saveModelLock(true, settings.modelSelection)
    } else {
      setLockedModel(null)
      setModelLocked(false)
      saveModelLock(false, null)
    }
  }

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const openKiroSettingsFile = async () => {
    try { await window.api.openKiroSettingsFile() } catch (err) { console.error(err) }
  }

  const openMcpConfig = async (type: 'user' | 'workspace') => {
    try { await window.api.openKiroMcpConfig(type) } catch (err) { console.error(err) }
  }

  const openSteeringFolder = async () => {
    try { await window.api.openKiroSteeringFolder() } catch (err) { console.error(err) }
  }

  const openSteeringFile = (filename: string) => setEditingFile(filename)

  const openSteeringFileExternal = async (filename: string) => {
    try { await window.api.openKiroSteeringFile(filename) } catch (err) { console.error(err) }
  }

  const createDefaultRules = async () => {
    try {
      const result = await window.api.createKiroDefaultRules()
      if (result.success) await loadKiroSettings(true)
    } catch (err) { console.error(err) }
  }

  const deleteSteeringFile = async (filename: string) => {
    if (!confirm(`确定要删除 "${filename}" 吗？此操作无法撤销。`)) return
    try {
      const result = await window.api.deleteKiroSteeringFile(filename)
      if (result.success) await loadKiroSettings(true)
      else setError(result.error || '删除文件失败')
    } catch (err) {
      console.error(err)
      setError('删除文件失败')
    }
  }

  const deleteMcpServer = async (name: string) => {
    if (!confirm(`确定要删除 MCP 服务器 "${name}" 吗？`)) return
    try {
      const result = await window.api.deleteMcpServer(name)
      if (result.success) await loadKiroSettings(true)
      else setError(result.error || '删除服务器失败')
    } catch (err) {
      console.error(err)
      setError('删除服务器失败')
    }
  }

  const addTrustedCommand = () => {
    if (newTrustedCommand.trim()) {
      updateSettings(prev => ({
        ...prev,
        trustedCommands: [...prev.trustedCommands, newTrustedCommand.trim()]
      }))
      setNewTrustedCommand('')
    }
  }

  const removeTrustedCommand = (index: number) => {
    updateSettings(prev => ({
      ...prev,
      trustedCommands: prev.trustedCommands.filter((_, i) => i !== index)
    }))
  }

  const addDenyCommand = () => {
    if (newDenyCommand.trim()) {
      updateSettings(prev => ({
        ...prev,
        commandDenylist: [...prev.commandDenylist, newDenyCommand.trim()]
      }))
      setNewDenyCommand('')
    }
  }

  const addDefaultDenyCommands = () => {
    updateSettings(prev => {
      const newCommands = defaultDenyCommands.filter(cmd => !prev.commandDenylist.includes(cmd))
      return { ...prev, commandDenylist: [...prev.commandDenylist, ...newCommands] }
    })
  }

  const removeDenyCommand = (index: number) => {
    updateSettings(prev => ({
      ...prev,
      commandDenylist: prev.commandDenylist.filter((_, i) => i !== index)
    }))
  }

  if (loading) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* 页面头部 - 简洁风格 */}
      <div className="px-0 py-1 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Kiro 设置</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                管理 Kiro IDE 的配置、MCP 服务器和用户规则
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-9 bg-background/50 border-border/50 hover:bg-background/80" onClick={handleRefresh} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button variant="outline" size="sm" className="h-9 bg-background/50 border-border/50 hover:bg-background/80" onClick={openKiroSettingsFile}>
              <ExternalLink className="h-4 w-4 mr-1.5" />
              设置文件
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-4 bg-destructive/10 text-destructive rounded-xl border border-destructive/20 animate-in slide-in-from-top-2">
          <AlertCircle className="h-5 w-5" />
          {error}
        </div>
      )}

      {/* Agent 设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-xl" onClick={() => toggleSection('agent')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Settings2 className="h-4.5 w-4.5" />
              </div>
              <span>Agent 设置</span>
            </div>
            {expandedSections.agent ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.agent && (
          <CardContent className="space-y-6 pt-4 animate-in slide-in-from-top-2">
            {/* Agent Autonomy */}
            <div className="flex items-center justify-between p-1">
              <div>
                <p className="font-medium text-sm">Agent 自主模式</p>
                <p className="text-xs text-muted-foreground mt-0.5">控制 Agent 是否自动执行或需要确认</p>
              </div>
              <Select
                value={settings.agentAutonomy}
                options={autonomyOptions}
                onChange={(value) => updateSettings(prev => ({ ...prev, agentAutonomy: value }))}
                className="w-[240px]"
              />
            </div>

            {/* Model Selection */}
            <div className="flex items-center justify-between border-t border-border/50 pt-4 p-1">
              <div>
                <p className="font-medium text-sm">模型选择</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {modelLocked ? '模型已锁定，不会被自动切换' : '选择 Agent 使用的 AI 模型'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleModelLock}
                  className={cn(
                    "p-2 rounded-lg transition-all duration-200",
                    modelLocked
                      ? 'bg-primary/10 text-primary hover:bg-primary/20 ring-1 ring-primary/20'
                      : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                  )}
                  title={modelLocked ? `已锁定: ${lockedModel}，点击解锁` : '点击锁定当前模型'}
                >
                  {modelLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                </button>
                <Select
                  value={settings.modelSelection}
                  options={modelOptions}
                  onChange={(value) => updateSettings(prev => ({ ...prev, modelSelection: value }))}
                  className="w-[240px]"
                  disabled={modelLocked}
                />
              </div>
            </div>

            {/* Toggle Options */}
            <div className="border-t border-border/50 pt-4 space-y-2">
              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <div>
                  <p className="font-medium text-sm">Tab 自动补全</p>
                  <p className="text-xs text-muted-foreground mt-0.5">输入时提供代码建议</p>
                </div>
                <Toggle
                  checked={settings.enableTabAutocomplete}
                  onChange={(checked) => updateSettings(prev => ({ ...prev, enableTabAutocomplete: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <div>
                  <p className="font-medium text-sm">使用统计</p>
                  <p className="text-xs text-muted-foreground mt-0.5">显示 Agent 执行时间和用量</p>
                </div>
                <Toggle
                  checked={settings.usageSummary}
                  onChange={(checked) => updateSettings(prev => ({ ...prev, usageSummary: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <div>
                  <p className="font-medium text-sm">代码引用追踪</p>
                  <p className="text-xs text-muted-foreground mt-0.5">允许生成带公开代码引用的代码</p>
                </div>
                <Toggle
                  checked={settings.codeReferences}
                  onChange={(checked) => updateSettings(prev => ({ ...prev, codeReferences: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <div>
                  <p className="font-medium text-sm">代码库索引</p>
                  <p className="text-xs text-muted-foreground mt-0.5">启用代码库索引以提升搜索性能</p>
                </div>
                <Toggle
                  checked={settings.enableCodebaseIndexing}
                  onChange={(checked) => updateSettings(prev => ({ ...prev, enableCodebaseIndexing: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <div>
                  <p className="font-medium text-sm">调试日志</p>
                  <p className="text-xs text-muted-foreground mt-0.5">在输出面板显示调试日志</p>
                </div>
                <Toggle
                  checked={settings.enableDebugLogs}
                  onChange={(checked) => updateSettings(prev => ({ ...prev, enableDebugLogs: checked }))}
                />
              </div>
            </div>

            {/* 通知设置 */}
            <div className="border-t border-border/50 pt-6 space-y-4">
              <div className="flex items-center gap-2 px-1">
                <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                <p className="font-medium text-sm">通知设置</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30 hover:bg-muted/40 transition-colors">
                  <div>
                    <p className="font-medium text-sm">需要操作通知</p>
                    <p className="text-xs text-muted-foreground mt-0.5">需要确认时</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsActionRequired}
                    onChange={(checked) => updateSettings(prev => ({ ...prev, notificationsActionRequired: checked }))}
                    size="sm"
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30 hover:bg-muted/40 transition-colors">
                  <div>
                    <p className="font-medium text-sm">失败通知</p>
                    <p className="text-xs text-muted-foreground mt-0.5">执行失败时</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsFailure}
                    onChange={(checked) => updateSettings(prev => ({ ...prev, notificationsFailure: checked }))}
                    size="sm"
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30 hover:bg-muted/40 transition-colors">
                  <div>
                    <p className="font-medium text-sm">成功通知</p>
                    <p className="text-xs text-muted-foreground mt-0.5">执行成功时</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsSuccess}
                    onChange={(checked) => updateSettings(prev => ({ ...prev, notificationsSuccess: checked }))}
                    size="sm"
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30 hover:bg-muted/40 transition-colors">
                  <div>
                    <p className="font-medium text-sm">账单通知</p>
                    <p className="text-xs text-muted-foreground mt-0.5">账单相关</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsBilling}
                    onChange={(checked) => updateSettings(prev => ({ ...prev, notificationsBilling: checked }))}
                    size="sm"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 代理设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-xl" onClick={() => toggleSection('proxy')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Globe className="h-4.5 w-4.5" />
              </div>
              <span>代理设置</span>
              {proxyEnabled && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 border border-green-200 dark:border-green-800">
                  已启用
                </span>
              )}
            </div>
            {expandedSections.proxy ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.proxy && (
          <CardContent className="space-y-6 pt-4 animate-in slide-in-from-top-2">
            <div className="flex items-center justify-between p-1">
              <div>
                <p className="font-medium text-sm">启用代理</p>
                <p className="text-xs text-muted-foreground mt-0.5">所有网络请求将通过代理服务器（仅本客户端）</p>
              </div>
              <Button
                variant={proxyEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => setProxy(!proxyEnabled, tempProxyUrl)}
                className="rounded-full px-4"
              >
                {proxyEnabled ? '已开启' : '已关闭'}
              </Button>
            </div>

            <div className="space-y-3 pt-4 border-t border-border/50">
              <label className="text-sm font-medium">代理地址</label>
              <div className="flex gap-3">
                <input
                  type="text"
                  className="flex-1 h-10 px-3 rounded-lg border border-input bg-background/50 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  value={tempProxyUrl}
                  onChange={(e) => setTempProxyUrl(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setProxy(proxyEnabled, tempProxyUrl)}
                  disabled={tempProxyUrl === proxyUrl}
                  className="h-10 px-4"
                >
                  保存
                </Button>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Info className="w-3 h-3" />
                支持 HTTP/HTTPS/SOCKS5 代理，格式: protocol://host:port
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* MCP 设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-xl" onClick={() => toggleSection('mcp')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Zap className="h-4.5 w-4.5" />
              </div>
              <span>MCP 服务器</span>
              <span className="px-2.5 py-0.5 text-xs rounded-full bg-primary/10 text-primary font-medium">
                {Object.keys(mcpConfig.mcpServers).length} 个
              </span>
            </div>
            {expandedSections.mcp ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.mcp && (
          <CardContent className="space-y-6 pt-4 animate-in slide-in-from-top-2">
            <div className="flex items-center justify-between p-1">
              <div>
                <p className="font-medium text-sm">启用 MCP</p>
                <p className="text-xs text-muted-foreground mt-0.5">允许连接外部工具和数据源</p>
              </div>
              <Select
                value={settings.configureMCP}
                options={mcpOptions}
                onChange={(value) => updateSettings(prev => ({ ...prev, configureMCP: value }))}
                className="w-[240px]"
              />
            </div>

            <div className="border-t border-border/50 pt-4">
              <p className="font-medium mb-3 text-sm">已配置的 MCP 服务器</p>
              {Object.keys(mcpConfig.mcpServers).length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center bg-muted/20 rounded-xl border border-dashed border-border/50">
                  <Zap className="h-8 w-8 mx-auto mb-2 opacity-20" />
                  暂无配置的 MCP 服务器
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(mcpConfig.mcpServers).map(([name, server]) => (
                    <div key={name} className="flex items-center justify-between p-3 bg-muted/30 border border-border/30 rounded-xl hover:bg-muted/50 transition-colors group">
                      <div className="flex-1">
                        <p className="font-medium text-sm">{name}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{server.command}</p>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="p-2 hover:bg-background rounded-lg transition-colors border border-transparent hover:border-border/50 shadow-sm" onClick={() => setEditingMcp({ name, server })} title="编辑">
                          <Edit className="h-4 w-4 text-primary" />
                        </button>
                        <button className="p-2 hover:bg-background rounded-lg transition-colors border border-transparent hover:border-border/50 shadow-sm" onClick={() => deleteMcpServer(name)} title="删除">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditingMcp({})} className="bg-background/50 border-border/50">
                <Plus className="h-4 w-4 mr-2" />添加 MCP 服务器
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('user')} className="bg-background/50 border-border/50">
                <FolderOpen className="h-4 w-4 mr-2" />用户 MCP 配置
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('workspace')} className="bg-background/50 border-border/50">
                <FolderOpen className="h-4 w-4 mr-2" />工作区 MCP 配置
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Steering 用户规则 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-xl" onClick={() => toggleSection('steering')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <FileText className="h-4.5 w-4.5" />
              </div>
              <span>用户规则 (Steering)</span>
              <span className="px-2.5 py-0.5 text-xs rounded-full bg-primary/10 text-primary font-medium">
                {steeringFiles.length} 个文件
              </span>
            </div>
            {expandedSections.steering ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.steering && (
          <CardContent className="space-y-6 pt-4 animate-in slide-in-from-top-2">
            <div className="flex items-start gap-3 p-3 bg-primary/5 rounded-xl border border-primary/10">
              <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-sm text-muted-foreground">Steering 文件用于定义 AI 助手的行为规则和上下文，可以帮助 Agent 更好地理解项目规范。</p>
            </div>

            {steeringFiles.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center bg-muted/20 rounded-xl border border-dashed border-border/50">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-20" />
                暂无 Steering 文件
              </div>
            ) : (
              <div className="space-y-2">
                {steeringFiles.map((file, index) => (
                  <div key={index} className="flex items-center gap-3 p-3 bg-muted/30 border border-border/30 rounded-xl hover:bg-muted/50 transition-colors group">
                    <div className="p-2 rounded-lg bg-background border border-border/50">
                      <FileText className="h-4 w-4 text-primary" />
                    </div>
                    <span className="text-sm font-mono flex-1 truncate">{file}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 hover:bg-background rounded-lg transition-colors border border-transparent hover:border-border/50 shadow-sm" onClick={() => openSteeringFile(file)} title="内部编辑">
                        <Edit className="h-4 w-4 text-primary" />
                      </button>
                      <button className="p-2 hover:bg-background rounded-lg transition-colors border border-transparent hover:border-border/50 shadow-sm" onClick={() => openSteeringFileExternal(file)} title="外部打开">
                        <ExternalLink className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button className="p-2 hover:bg-background rounded-lg transition-colors border border-transparent hover:border-border/50 shadow-sm" onClick={() => deleteSteeringFile(file)} title="删除">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={createDefaultRules} className="bg-background/50 border-border/50">
                <Plus className="h-4 w-4 mr-2" />创建规则文件
              </Button>
              <Button variant="outline" size="sm" onClick={openSteeringFolder} className="bg-background/50 border-border/50">
                <FolderOpen className="h-4 w-4 mr-2" />打开 Steering 目录
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 命令设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-xl" onClick={() => toggleSection('commands')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Terminal className="h-4.5 w-4.5" />
              </div>
              <span>命令配置</span>
            </div>
            {expandedSections.commands ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.commands && (
          <CardContent className="space-y-6 pt-4 animate-in slide-in-from-top-2">
            {/* Trusted Commands */}
            <div className="p-5 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 rounded-md bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                  <Shield className="h-4 w-4" />
                </div>
                <p className="font-medium text-sm">信任的命令</p>
              </div>
              <p className="text-xs text-muted-foreground mb-4">这些命令将自动执行，无需确认</p>
              <div className="space-y-2.5">
                {settings.trustedCommands.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2 group">
                    <code className="flex-1 px-3 py-2 bg-background/80 border border-border/50 rounded-lg text-sm font-mono">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeTrustedCommand(index)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTrustedCommand}
                    onChange={(e) => setNewTrustedCommand(e.target.value)}
                    placeholder="如: npm *"
                    className="flex-1 px-3 py-2 rounded-lg border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                    onKeyDown={(e) => e.key === 'Enter' && addTrustedCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addTrustedCommand} className="h-auto">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Command Denylist */}
            <div className="p-5 rounded-xl bg-destructive/5 border border-destructive/20">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-md bg-destructive/10 text-destructive">
                    <AlertCircle className="h-4 w-4" />
                  </div>
                  <p className="font-medium text-sm text-destructive">禁止的命令</p>
                </div>
                <Button variant="outline" size="sm" onClick={addDefaultDenyCommands} className="text-xs h-7 bg-background/50 border-destructive/20 text-destructive hover:bg-destructive/10">
                  <Shield className="h-3.5 w-3.5 mr-1.5" />添加默认危险命令
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mb-4">这些命令总是需要手动确认，无法自动执行</p>
              <div className="space-y-2.5">
                {settings.commandDenylist.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2 group">
                    <code className="flex-1 px-3 py-2 bg-background/80 border border-destructive/20 rounded-lg text-sm font-mono">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeDenyCommand(index)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDenyCommand}
                    onChange={(e) => setNewDenyCommand(e.target.value)}
                    placeholder="如: rm -rf *"
                    className="flex-1 px-3 py-2 rounded-lg border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-destructive/20 focus:border-destructive/50 transition-all"
                    onKeyDown={(e) => e.key === 'Enter' && addDenyCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addDenyCommand} className="h-auto">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Steering 编辑器 */}
      {editingFile && (
        <SteeringEditor
          filename={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={() => loadKiroSettings(true)}
        />
      )}

      {/* MCP 服务器编辑器 */}
      {editingMcp && (
        <McpServerEditor
          serverName={editingMcp.name}
          server={editingMcp.server}
          onClose={() => setEditingMcp(null)}
          onSaved={() => loadKiroSettings(true)}
        />
      )}
    </div>
  )
}
