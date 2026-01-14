
import { useState, useRef, useEffect } from 'react'
import { Button } from '../ui'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  X,
  Send,
  Loader2,
  Sparkles,
  RotateCcw,
  Copy,
  Check,
  ChevronDown,
  Wand2,
  RefreshCw,
  Image,
  Menu
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchWithAuth } from '@/lib/api'
import { useMobile } from '@/hooks/use-mobile'
import type { Account } from '@/types/account'

interface AccountChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
}

interface LogEntry {
  time: string
  type: 'info' | 'request' | 'response' | 'error' | 'stream'
  message: string
}

interface ModelInfo {
  id: string
  object: string
  owned_by: string
}

interface ImageData {
  id: string
  base64: string
  mimeType: string
  name: string
}

// 预设提示词
const PRESET_PROMPTS = [
  '请用HTML+CSS+JavaScript创建一个贪吃蛇小游戏，要求：1.使用方向键控制 2.有计分系统 3.撞墙或撞自己游戏结束 4.界面美观',
  '请用HTML+CSS+JavaScript创建一个2048小游戏，要求：1.使用方向键控制 2.数字合并动画流畅 3.有最高分记录 4.配色美观',
  '请用Python实现一个完整的红黑树，包含插入、删除、查找操作，并提供可视化打印树结构的方法',
  '请用JavaScript实现一个LRU缓存，要求：1.O(1)时间复杂度的get和put 2.支持设置容量 3.包含完整的单元测试',
  '请用React+TypeScript创建一个Todo应用组件，要求：1.支持增删改查 2.本地存储持久化 3.支持拖拽排序 4.有过滤和搜索功能'
]

function getRandomPrompt(): string {
  return PRESET_PROMPTS[Math.floor(Math.random() * PRESET_PROMPTS.length)]
}

function getApiBase(): string {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE.replace(/\/api$/, '')
  }
  return ''
}

const DEFAULT_AI_POLISH_PROMPT =
  '给我一个编码相关的话题提示词，大约50-80字，要求对方极简描述某个编码概念的原理和应用，直接输出话题内容，请随机生成，不要缓存。'

const AI_CONFIG_KEY = 'ai_polish_config_api_v2'

interface AiConfig {
  apiUrl: string
  apiKey: string
  model: string
  prompt: string
  preset?: string
}

interface ApiPreset {
  name: string
  apiUrl: string
  apiKey: string
  model: string
}

const API_PRESETS: ApiPreset[] = [
  { name: '自定义', apiUrl: '', apiKey: '', model: '' },
  { name: '公益一', apiUrl: 'https://sukaka.ai6.me', apiKey: '123456', model: 'ANT/gemini-2.5-flash' }
]

const encryptData = (data: string): string => {
  const base64 = btoa(unescape(encodeURIComponent(data)))
  return base64.split('').map((c) => String.fromCharCode(c.charCodeAt(0) + 5)).join('')
}

const decryptData = (encrypted: string): string => {
  try {
    const base64 = encrypted.split('').map((c) => String.fromCharCode(c.charCodeAt(0) - 5)).join('')
    return decodeURIComponent(escape(atob(base64)))
  } catch {
    return ''
  }
}

const loadAiConfig = (): AiConfig => {
  try {
    const encrypted = localStorage.getItem(AI_CONFIG_KEY)
    if (encrypted) {
      const json = decryptData(encrypted)
      if (json) return JSON.parse(json)
    }
  } catch { /* ignore */ }
  return { apiUrl: 'https://sukaka.ai6.me', apiKey: '123456', model: 'ANT/gemini-2.5-flash', prompt: DEFAULT_AI_POLISH_PROMPT, preset: '公益一' }
}

const saveAiConfig = (config: AiConfig) => {
  try {
    const json = JSON.stringify(config)
    const encrypted = encryptData(json)
    localStorage.setItem(AI_CONFIG_KEY, encrypted)
  } catch { /* ignore */ }
}

export function AccountChatDialog({ open, onOpenChange, account }: AccountChatDialogProps) {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [useStream, setUseStream] = useState(true)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [copied, setCopied] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-5')
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [showAiPolishDialog, setShowAiPolishDialog] = useState(false)
  const [aiPolishPrompt, setAiPolishPrompt] = useState(DEFAULT_AI_POLISH_PROMPT)
  const [isGenerating, setIsGenerating] = useState(false)
  const [aiApiUrl, setAiApiUrl] = useState('https://sukaka.ai6.me')
  const [aiApiKey, setAiApiKey] = useState('123456')
  const [aiModel, setAiModel] = useState('ANT/gemini-2.5-flash')
  const [aiModels, setAiModels] = useState<string[]>([])
  const [loadingAiModels, setLoadingAiModels] = useState(false)
  const [showAiModelDropdown, setShowAiModelDropdown] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState('公益一')
  const [images, setImages] = useState<ImageData[]>([])
  const [showLogsSheet, setShowLogsSheet] = useState(false)

  const responseRef = useRef<HTMLDivElement>(null)
  const logsRef = useRef<HTMLDivElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const aiModelDropdownRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isMobile = useMobile()

  useEffect(() => {
    const config = loadAiConfig()
    setAiApiUrl(config.apiUrl)
    setAiApiKey(config.apiKey)
    setAiModel(config.model)
    setAiPolishPrompt(config.prompt)
    setSelectedPreset(config.preset || '自定义')
  }, [])

  const handlePresetChange = (presetName: string) => {
    setSelectedPreset(presetName)
    const preset = API_PRESETS.find((p) => p.name === presetName)
    if (preset && presetName !== '自定义') {
      setAiApiUrl(preset.apiUrl)
      setAiApiKey(preset.apiKey)
      setAiModel(preset.model)
    }
  }

  const loadAiModels = async () => {
    if (!aiApiUrl || !aiApiKey) return
    setLoadingAiModels(true)
    try {
      const apiBase = getApiBase()
      const res = await fetchWithAuth(`${apiBase}/api/proxy/openai/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiUrl: aiApiUrl, apiKey: aiApiKey })
      })
      if (res.ok) {
        const data = await res.json()
        const modelIds = (data.data || []).map((m: { id: string }) => m.id).sort()
        setAiModels(modelIds)
      }
    } catch (error) {
      console.error('Failed to load AI models:', error)
    } finally {
      setLoadingAiModels(false)
    }
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (aiModelDropdownRef.current && !aiModelDropdownRef.current.contains(e.target as Node)) {
        setShowAiModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const loadModels = async () => {
    setLoadingModels(true)
    try {
      const apiBase = getApiBase()
      const res = await fetchWithAuth(`${apiBase}/v1/models`)
      if (res.ok) {
        const data = await res.json()
        setModels(data.data || [])
      }
    } catch (error) {
      console.error('Failed to load models:', error)
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (open) {
      setPrompt(getRandomPrompt())
      setResponse('')
      setLogs([])
      setImages([])
      loadModels()
    }
  }, [open])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const addLog = (type: LogEntry['type'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs((prev) => [...prev, { time, type, message }])
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) {
        addLog('error', `文件 ${file.name} 不是图片格式`)
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        addLog('error', `图片 ${file.name} 超过 10MB 限制`)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        setImages((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, base64, mimeType: file.type, name: file.name }])
        addLog('info', `已添加图片: ${file.name}`)
      }
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id))
  }

  const handleSend = async () => {
    if (!prompt.trim() || !account || isLoading) return
    setIsLoading(true)
    setResponse('')
    setLogs([])
    const apiBase = getApiBase()
    const startTime = Date.now()
    addLog('info', `开始测试账号: ${account.email}`)
    addLog('info', `模型: ${selectedModel}`)
    addLog('info', `模式: ${useStream ? '流式' : '非流式'}`)
    if (images.length > 0) addLog('info', `附带图片: ${images.length} 张`)

    try {
      let messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
      if (images.length > 0) {
        messageContent = [
          { type: 'text', text: prompt },
          ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }))
        ]
      } else {
        messageContent = prompt
      }

      const requestBody = { model: selectedModel, messages: [{ role: 'user', content: messageContent }], stream: useStream, account_id: account.id }
      addLog('request', `POST /v1/chat/completions\n${JSON.stringify({ ...requestBody, messages: [{ role: 'user', content: images.length > 0 ? `[文本 + ${images.length} 张图片]` : prompt }] }, null, 2)}`)

      const res = await fetchWithAuth(`${apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })

      if (!res.ok) {
        const errorText = await res.text()
        addLog('error', `HTTP ${res.status}: ${errorText}`)
        setResponse(`错误: ${res.status} - ${errorText}`)
        return
      }

      if (useStream) {
        const reader = res.body?.getReader()
        if (!reader) { addLog('error', '无法获取响应流'); return }
        const decoder = new TextDecoder()
        let fullContent = ''
        let chunkCount = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') { addLog('stream', `流结束，共 ${chunkCount} 个数据块`); continue }
              try {
                const parsed = JSON.parse(data)
                const content = parsed.choices?.[0]?.delta?.content
                if (content) { fullContent += content; setResponse(fullContent); chunkCount++ }
              } catch { /* ignore */ }
            }
          }
        }
        const elapsed = Date.now() - startTime
        addLog('response', `完成，耗时 ${elapsed}ms，内容长度 ${fullContent.length} 字符`)
      } else {
        const data = await res.json()
        addLog('response', `响应:\n${JSON.stringify(data, null, 2)}`)
        const content = data.choices?.[0]?.message?.content || ''
        setResponse(content)
        const elapsed = Date.now() - startTime
        addLog('info', `完成，耗时 ${elapsed}ms`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      addLog('error', `请求失败: ${message}`)
      setResponse(`错误: ${message}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyResponse = () => {
    if (response) {
      navigator.clipboard.writeText(response)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleRandomPrompt = () => setPrompt(getRandomPrompt())

  const handleAiGenerate = async () => {
    if (!aiPolishPrompt.trim() || isGenerating) return
    if (!aiApiKey.trim()) { alert('请先填写 API Key'); return }
    saveAiConfig({ apiUrl: aiApiUrl, apiKey: aiApiKey, model: aiModel, prompt: aiPolishPrompt, preset: selectedPreset })
    setIsGenerating(true)
    try {
      const apiBase = getApiBase()
      const res = await fetchWithAuth(`${apiBase}/api/proxy/openai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiUrl: aiApiUrl, apiKey: aiApiKey, model: aiModel, messages: [{ role: 'user', content: aiPolishPrompt }], stream: true })
      })
      if (!res.ok) { const errorText = await res.text(); alert(`生成失败: ${res.status} - ${errorText.substring(0, 100)}`); return }
      const reader = res.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let generatedContent = ''
      setShowAiPolishDialog(false)
      setPrompt('')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) { generatedContent += content; setPrompt(generatedContent) }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (error) {
      alert(`生成失败: ${error instanceof Error ? error.message : '网络错误'}`)
    } finally {
      setIsGenerating(false)
    }
  }

  if (!open || !account) return null

  const fileInput = <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageUpload} />

  const imagePreview = images.length > 0 && (
    <div className="flex flex-wrap gap-2 p-2 bg-muted/30 rounded-lg border border-dashed">
      {images.map((img) => (
        <div key={img.id} className="relative group">
          <img src={`data:${img.mimeType};base64,${img.base64}`} alt={img.name} className="h-16 w-16 object-cover rounded-lg border" />
          <button onClick={() => removeImage(img.id)} className="absolute -top-1.5 -right-1.5 p-0.5 bg-destructive text-destructive-foreground rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )

  const logsContent = (
    <div ref={logsRef} className="flex-1 overflow-auto p-3 space-y-2 scrollbar-thin">
      {logs.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-muted-foreground/30 gap-2">
          <div className="w-12 h-1 bg-current rounded-full opacity-20" />
          <div className="w-8 h-1 bg-current rounded-full opacity-20" />
          <p className="text-[10px] mt-2">暂无日志记录</p>
        </div>
      ) : (
        [...logs].reverse().map((log, i) => (
          <div key={i} className={cn(
            'text-[11px] p-2.5 rounded-lg border shadow-sm',
            log.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/50 dark:border-red-800/60 dark:text-red-300'
              : log.type === 'request'
              ? 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/50 dark:border-blue-800/60 dark:text-blue-300'
              : log.type === 'response'
              ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-950/50 dark:border-green-800/60 dark:text-green-300'
              : log.type === 'stream'
              ? 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-950/50 dark:border-purple-800/60 dark:text-purple-300'
              : 'bg-muted/50 border-border text-foreground/80 dark:bg-muted/30 dark:border-border/60 dark:text-foreground/70'
          )}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono text-[10px] opacity-60">{log.time}</span>
              <span className={cn(
                "uppercase text-[9px] font-bold px-1.5 py-0.5 rounded",
                log.type === 'error'
                  ? 'bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-300'
                  : log.type === 'request'
                  ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                  : log.type === 'response'
                  ? 'bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-300'
                  : log.type === 'stream'
                  ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/50 dark:text-purple-300'
                  : 'bg-muted text-muted-foreground dark:bg-muted/50'
              )}>{log.type}</span>
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono leading-relaxed">{log.message}</pre>
          </div>
        ))
      )}
    </div>
  )

  // 移动端布局
  if (isMobile) {
    return (
      <>
        {fileInput}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="h-[95vh] rounded-t-xl p-0 flex flex-col">
            <SheetHeader className="px-4 py-3 border-b shrink-0">
              <div className="flex items-center justify-between pr-8">
                <div>
                  <SheetTitle className="text-base">API 测试实验室</SheetTitle>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <p className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">{account.email}</p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="gap-1" onClick={() => setShowLogsSheet(true)}>
                  <Menu className="h-4 w-4" />
                  日志
                </Button>
              </div>
            </SheetHeader>

            <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
              {/* 模型选择 */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="relative flex-1" ref={modelDropdownRef}>
                  <button onClick={() => setShowModelDropdown(!showModelDropdown)} className="flex items-center gap-2 h-9 px-3 text-sm font-medium border border-input bg-background/50 hover:bg-accent/50 rounded-lg w-full justify-between" disabled={loadingModels}>
                    {loadingModels ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>加载...</span></> : <><span className="truncate text-xs">{selectedModel}</span><ChevronDown className={cn('h-3.5 w-3.5 transition-transform opacity-50', showModelDropdown && 'rotate-180')} /></>}
                  </button>
                  {showModelDropdown && models.length > 0 && (
                    <div className="absolute left-0 top-full mt-2 z-50 w-full max-h-[200px] overflow-auto bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-xl p-1">
                      {models.map((model) => (
                        <button key={model.id} className={cn('w-full text-left px-3 py-2 text-sm rounded-lg', selectedModel === model.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted/80')} onClick={() => { setSelectedModel(model.id); setShowModelDropdown(false) }}>{model.id}</button>
                      ))}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1.5 rounded-lg border">
                  <input type="checkbox" checked={useStream} onChange={(e) => setUseStream(e.target.checked)} className="sr-only peer" />
                  <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary relative" />
                  <span className="text-muted-foreground">流式</span>
                </label>
              </div>

              {/* 工具栏 */}
              <div className="flex items-center gap-2 shrink-0">
                {/* <Button variant="outline" size="sm" className="h-8 text-xs flex-1" onClick={() => fileInputRef.current?.click()}>
                  <Image className="h-3.5 w-3.5 mr-1" />
                  图片 {images.length > 0 && `(${images.length})`}
                </Button> */}
                <Button variant="outline" size="sm" className="h-8 text-xs flex-1" onClick={handleRandomPrompt}>
                  <Sparkles className="h-3.5 w-3.5 mr-1 text-yellow-500" />
                  随机
                </Button>
                <Button variant="outline" size="sm" className="h-8 text-xs flex-1" onClick={() => setShowAiPolishDialog(true)} disabled={isGenerating}>
                  <Wand2 className="h-3.5 w-3.5 mr-1" />
                  AI
                </Button>
              </div>

              {/* 图片预览 */}
              {imagePreview}

              {/* 输入框 */}
              <div className="relative shrink-0">
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入提示词..." className="w-full h-24 p-3 text-sm border border-input bg-background/50 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary/20" />
                <Button onClick={handleSend} disabled={isLoading || !prompt.trim()} size="sm" className="absolute bottom-2 right-2">
                  {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>

              {/* 响应区域 */}
              <div className="flex-1 flex flex-col overflow-hidden bg-muted/10 rounded-xl border">
                <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
                  <span className="text-xs font-medium text-muted-foreground">Response</span>
                  {response && <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={handleCopyResponse}>{copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}</Button>}
                </div>
                <div ref={responseRef} className="flex-1 p-3 overflow-auto text-sm whitespace-pre-wrap font-mono">
                  {response || <div className="h-full flex items-center justify-center text-muted-foreground/40 text-xs">等待发送请求...</div>}
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        {/* 日志 Sheet */}
        <Sheet open={showLogsSheet} onOpenChange={setShowLogsSheet}>
          <SheetContent side="right" className="w-full sm:w-[400px] p-0 flex flex-col">
            <SheetHeader className="px-4 py-3 border-b">
              <div className="flex items-center justify-between pr-8">
                <SheetTitle>System Logs</SheetTitle>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setLogs([])}><RotateCcw className="h-3.5 w-3.5" /></Button>
              </div>
            </SheetHeader>
            {logsContent}
          </SheetContent>
        </Sheet>

        {/* AI 润色弹框 */}
        {showAiPolishDialog && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowAiPolishDialog(false)} />
            <div className="relative bg-background rounded-2xl w-full max-w-md max-h-[80vh] overflow-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold">AI 智能润色</h3>
                <Button variant="ghost" size="icon" onClick={() => setShowAiPolishDialog(false)}><X className="h-5 w-5" /></Button>
              </div>
              <div className="space-y-3">
                <select value={selectedPreset} onChange={(e) => handlePresetChange(e.target.value)} className="w-full h-10 px-3 text-sm border rounded-lg bg-background">
                  {API_PRESETS.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
                </select>
                {selectedPreset === '自定义' && (
                  <>
                    <input type="text" value={aiApiUrl} onChange={(e) => setAiApiUrl(e.target.value)} placeholder="API URL" className="w-full h-10 px-3 text-sm border rounded-lg" />
                    <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="API Key" className="w-full h-10 px-3 text-sm border rounded-lg" />
                    <div className="flex gap-2">
                      <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="模型" className="flex-1 h-10 px-3 text-sm border rounded-lg" />
                      <Button variant="outline" size="icon" className="h-10 w-10" onClick={loadAiModels} disabled={loadingAiModels}>
                        {loadingAiModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      </Button>
                    </div>
                  </>
                )}
                <textarea value={aiPolishPrompt} onChange={(e) => setAiPolishPrompt(e.target.value)} placeholder="生成指令..." className="w-full h-24 p-3 text-sm border rounded-lg resize-none" />
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setAiPolishPrompt(DEFAULT_AI_POLISH_PROMPT)}><RotateCcw className="h-4 w-4 mr-2" />重置</Button>
                  <Button className="flex-1" onClick={handleAiGenerate} disabled={!aiPolishPrompt.trim() || !aiApiKey.trim() || isGenerating}>
                    {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}生成
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  // 桌面端布局
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {fileInput}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative bg-background/95 backdrop-blur-xl border border-border/50 rounded-2xl shadow-2xl w-full max-w-[950px] max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/40 bg-muted/10">
          <div>
            <h2 className="text-lg font-bold tracking-tight">API 测试实验室</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <p className="text-xs text-muted-foreground font-mono">{account.email}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="rounded-full hover:bg-destructive/10 hover:text-destructive">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* 主体内容 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧：输入和响应 */}
          <div className="flex-1 flex flex-col p-6 overflow-hidden gap-6">
            {/* 控制区域 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                {/* 模型选择 */}
                <div className="relative z-20" ref={modelDropdownRef}>
                  <button onClick={() => setShowModelDropdown(!showModelDropdown)} className="flex items-center gap-2 h-9 px-4 text-sm font-medium border border-input bg-background/50 hover:bg-accent/50 rounded-lg shadow-sm w-[200px] justify-between" disabled={loadingModels}>
                    {loadingModels ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>加载模型...</span></> : <><span className="truncate">{selectedModel}</span><ChevronDown className={cn('h-3.5 w-3.5 transition-transform opacity-50', showModelDropdown && 'rotate-180')} /></>}
                  </button>
                  {showModelDropdown && models.length > 0 && (
                    <div className="absolute left-0 top-full mt-2 z-50 w-[240px] max-h-[320px] overflow-auto bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-xl p-1">
                      {models.map((model) => (
                        <button key={model.id} className={cn('w-full text-left px-3 py-2 text-sm rounded-lg truncate', selectedModel === model.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted/80')} onClick={() => { setSelectedModel(model.id); setShowModelDropdown(false) }}>{model.id}</button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => fileInputRef.current?.click()}>
                    <Image className="h-3.5 w-3.5 mr-1.5" />
                    图片 {images.length > 0 && `(${images.length})`}
                  </Button> */}
                  <Button variant="outline" size="sm" className="h-9 text-xs border-dashed border-primary/30 hover:border-primary/60 text-primary" onClick={() => setShowAiPolishDialog(true)} disabled={isGenerating}>
                    {isGenerating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1.5" />}
                    AI 润色
                  </Button>
                  <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={handleRandomPrompt}>
                    <Sparkles className="h-3.5 w-3.5 mr-1.5 text-yellow-500" />
                    随机示例
                  </Button>
                  <div className="h-4 w-px bg-border/50 mx-1" />
                  <label className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1.5 rounded-lg hover:bg-muted/50">
                    <div className="relative flex items-center">
                      <input type="checkbox" checked={useStream} onChange={(e) => setUseStream(e.target.checked)} className="peer sr-only" />
                      <div className="w-9 h-5 bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                    </div>
                    <span className="text-muted-foreground">流式响应</span>
                  </label>
                </div>
              </div>

              {/* 图片预览 */}
              {imagePreview}

              <div className="relative group">
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="在此输入您的提示词 (Prompt)..." className="w-full h-32 p-4 text-sm border border-input bg-background/50 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono" />
                <div className="absolute bottom-3 right-3">
                  <Button onClick={handleSend} disabled={isLoading || !prompt.trim()} size="sm" className="shadow-lg">
                    {isLoading ? <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />处理中...</> : <><Send className="h-3.5 w-3.5 mr-1.5" />发送</>}
                  </Button>
                </div>
              </div>
            </div>

            {/* 响应区域 */}
            <div className="flex-1 flex flex-col overflow-hidden bg-muted/10 rounded-xl border border-border/50">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-muted/20">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Response</label>
                {response && <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={handleCopyResponse}>{copied ? <Check className="h-3 w-3 mr-1 text-green-500" /> : <Copy className="h-3 w-3 mr-1" />}复制内容</Button>}
              </div>
              <div ref={responseRef} className="flex-1 p-4 overflow-auto text-sm leading-relaxed whitespace-pre-wrap font-mono">
                {response || <div className="h-full flex flex-col items-center justify-center text-muted-foreground/40 gap-2"><div className="p-3 rounded-full bg-muted/30"><Send className="h-6 w-6" /></div><span className="text-xs">等待发送请求...</span></div>}
              </div>
            </div>
          </div>

          {/* 右侧：日志 */}
          <div className="w-80 border-l border-border/40 flex flex-col bg-muted/5">
            <div className="px-4 py-3 border-b border-border/40 bg-muted/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">System Logs</span>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => setLogs([])} title="清空日志">
                  <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
            {logsContent}
          </div>
        </div>
      </div>

      {/* AI 润色弹框 */}
      {showAiPolishDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAiPolishDialog(false)} />
          <div className="relative bg-background/95 backdrop-blur-xl border border-border/50 rounded-2xl shadow-2xl w-[550px] max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border/40 bg-muted/10">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-primary/10"><Wand2 className="h-5 w-5 text-primary" /></div>
                <div>
                  <h3 className="font-bold text-lg">AI 智能润色</h3>
                  <p className="text-xs text-muted-foreground">优化您的提示词以获得更好效果</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setShowAiPolishDialog(false)} className="rounded-full"><X className="h-5 w-5" /></Button>
            </div>
            <div className="p-6 space-y-6 overflow-auto max-h-[calc(85vh-80px)]">
              <div className="p-5 bg-muted/30 border border-border/40 rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">API 配置</p></div>
                  <select value={selectedPreset} onChange={(e) => handlePresetChange(e.target.value)} className="h-8 px-3 text-xs font-medium border border-input bg-background rounded-lg">
                    {API_PRESETS.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
                  </select>
                </div>
                {selectedPreset === '自定义' ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground ml-1">API URL</label>
                      <input type="text" value={aiApiUrl} onChange={(e) => setAiApiUrl(e.target.value)} placeholder="https://api.openai.com" className="w-full h-10 px-3 text-sm border border-input bg-background/50 rounded-lg" />
                    </div>
                    <div className="col-span-2 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground ml-1">API Key</label>
                      <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." className="w-full h-10 px-3 text-sm border border-input bg-background/50 rounded-lg font-mono" />
                    </div>
                    <div className="col-span-2 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground ml-1">模型</label>
                      <div className="flex gap-2">
                        <div className="relative flex-1" ref={aiModelDropdownRef}>
                          <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} onFocus={() => aiModels.length > 0 && setShowAiModelDropdown(true)} placeholder="gpt-4o-mini" className="w-full h-10 px-3 text-sm border border-input bg-background/50 rounded-lg" />
                          {showAiModelDropdown && aiModels.length > 0 && (
                            <div className="absolute left-0 top-full mt-2 z-50 w-full max-h-[200px] overflow-auto bg-popover/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-xl p-1">
                              {aiModels.map((model) => (
                                <button key={model} className={cn('w-full text-left px-3 py-2 text-sm rounded-lg', aiModel === model ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted/80')} onClick={() => { setAiModel(model); setShowAiModelDropdown(false) }}>{model}</button>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button variant="outline" size="icon" className="h-10 w-10 shrink-0 border-dashed" onClick={loadAiModels} disabled={loadingAiModels || !aiApiKey} title="从 API 获取模型列表">
                          {loadingAiModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                      </div>
                      {aiModels.length > 0 && <p className="text-xs text-green-500 flex items-center gap-1 mt-1.5"><Check className="h-3 w-3" />已加载 {aiModels.length} 个模型</p>}
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-background/50 rounded-lg border border-border/50 text-xs text-muted-foreground space-y-1.5 font-mono">
                    <p className="flex items-center gap-2"><span className="w-10 opacity-50">API:</span> {aiApiUrl}</p>
                    <p className="flex items-center gap-2"><span className="w-10 opacity-50">Model:</span> {aiModel}</p>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium ml-1">生成指令 (System Prompt)</label>
                <textarea value={aiPolishPrompt} onChange={(e) => setAiPolishPrompt(e.target.value)} placeholder="输入生成指令..." className="w-full h-28 p-4 text-sm border border-input bg-background/50 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono" />
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1 h-10 border-dashed" onClick={() => setAiPolishPrompt(DEFAULT_AI_POLISH_PROMPT)}><RotateCcw className="h-4 w-4 mr-2" />重置指令</Button>
                <Button className="flex-[2] h-10 shadow-lg shadow-primary/20" onClick={handleAiGenerate} disabled={!aiPolishPrompt.trim() || !aiApiKey.trim() || isGenerating}>
                  {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}开始生成
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}