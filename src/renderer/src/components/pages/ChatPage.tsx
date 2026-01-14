import { useState, useEffect, useRef } from 'react'
import { Button } from '../ui'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Plus, MessageSquare, Send, Trash2, Bot, User, Settings2, Sparkles, ChevronDown, MoreVertical, Copy, RotateCcw, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobile } from '@/hooks/use-mobile'
import { v4 as uuidv4 } from 'uuid'

// Types
interface Message {
    role: 'user' | 'assistant' | 'system'
    content: string
}

interface ChatSession {
    id: string
    title: string
    messages: Message[]
    model: string
    createdAt: number
    updatedAt: number
}

// Models
const MODELS = [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '强大且高效' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '快速且经济' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', description: '最强大的模型' }
]

export function ChatPage() {
    const [sessions, setSessions] = useState<ChatSession[]>([])
    const [currentId, setCurrentId] = useState<string | null>(null)
    const [input, setInput] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [selectedModel, setSelectedModel] = useState(MODELS[0].id)
    const [showModelSelect, setShowModelSelect] = useState(false)
    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const modelSelectWrapperRef = useRef<HTMLDivElement>(null)
    const isMobile = useMobile()

    // Load chats from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('kiro-chat-history')
        if (saved) {
            try {
                const parsed = JSON.parse(saved)
                // Sort by updatedAt desc
                parsed.sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt)
                setSessions(parsed)
                if (parsed.length > 0 && !currentId) {
                    setCurrentId(parsed[0].id)
                }
            } catch (e) {
                console.error('Failed to parse chat history', e)
            }
        } else {
            createNewChat()
        }
    }, [])

    // Save to localStorage
    useEffect(() => {
        if (sessions.length > 0) {
            localStorage.setItem('kiro-chat-history', JSON.stringify(sessions))
        }
    }, [sessions])

    // Scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [currentId, sessions])

    // Close model dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modelSelectWrapperRef.current && !modelSelectWrapperRef.current.contains(event.target as Node)) {
                setShowModelSelect(false)
            }
        }
        if (showModelSelect) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showModelSelect])

    const currentSession = sessions.find(s => s.id === currentId) || sessions[0]
    const currentModel = MODELS.find(m => m.id === selectedModel) || MODELS[0]

    const createNewChat = () => {
        const newChat: ChatSession = {
            id: uuidv4(),
            title: '新对话',
            messages: [],
            model: selectedModel,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
        setSessions(prev => [newChat, ...prev])
        setCurrentId(newChat.id)
        return newChat
    }

    const handleDeleteChat = (id: string, e: React.MouseEvent) => {
        e.stopPropagation()
        const newSessions = sessions.filter(s => s.id !== id)
        setSessions(newSessions)
        if (currentId === id) {
            setCurrentId(newSessions[0]?.id || null)
        }
        if (newSessions.length === 0) {
            localStorage.removeItem('kiro-chat-history')
        }
    }

    const handleCopy = (content: string, id: string) => {
        navigator.clipboard.writeText(content)
        setCopiedId(id)
        setTimeout(() => setCopiedId(null), 2000)
    }

    const handleRegenerate = async () => {
        if (isLoading || !currentSession || currentSession.messages.length < 1) return

        const lastMessage = currentSession.messages[currentSession.messages.length - 1]
        if (lastMessage.role !== 'assistant') return

        // Remove last assistant message and regenerate
        const messagesWithoutLast = currentSession.messages.slice(0, -1)
        const updatedSession = {
            ...currentSession,
            messages: messagesWithoutLast,
            updatedAt: Date.now()
        }

        setSessions(prev => prev.map(s => s.id === currentSession.id ? updatedSession : s))
        setIsLoading(true)

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            }
            
            const apiKey = import.meta.env.VITE_DEFAULT_API_KEY || 'Alf123456'
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`
            }

            const response = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    messages: messagesWithoutLast,
                    model: selectedModel,
                    stream: false
                })
            })

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}))
                throw new Error(errData.error?.message || `Error ${response.status}`)
            }

            const data = await response.json()
            const aiContent = data.choices?.[0]?.message?.content || '无响应内容'

            setSessions(prev => prev.map(s => s.id === currentSession.id ? {
                ...s,
                messages: [...messagesWithoutLast, { role: 'assistant', content: aiContent }],
                updatedAt: Date.now()
            } : s))

        } catch (err) {
            console.error('Chat error:', err)
            const errorMessage: Message = { role: 'assistant', content: `❌ 请求失败: ${err instanceof Error ? err.message : String(err)}` }
            setSessions(prev => prev.map(s => s.id === currentSession.id ? {
                ...s,
                messages: [...messagesWithoutLast, errorMessage],
                updatedAt: Date.now()
            } : s))
        } finally {
            setIsLoading(false)
        }
    }

    const handleSend = async () => {
        if (!input.trim() || isLoading) return

        let session = currentSession
        if (!session) {
            session = createNewChat()
        }

        const newMessage: Message = { role: 'user', content: input.trim() }
        const updatedMessages = [...session.messages, newMessage]

        const updatedSession = {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
            title: session.messages.length === 0 ? input.trim().slice(0, 30) : session.title
        }

        setSessions(prev => prev.map(s => s.id === session.id ? updatedSession : s))
        setInput('')
        setIsLoading(true)

        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
        }

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            }
            
            const apiKey = import.meta.env.VITE_DEFAULT_API_KEY || 'Alf123456'
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`
            }

            const response = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    messages: updatedMessages,
                    model: selectedModel,
                    stream: false
                })
            })

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}))
                throw new Error(errData.error?.message || `Error ${response.status}`)
            }

            const data = await response.json()
            const aiContent = data.choices?.[0]?.message?.content || '无响应内容'

            const assistantMessage: Message = { role: 'assistant', content: aiContent }

            setSessions(prev => prev.map(s => s.id === session.id ? {
                ...s,
                messages: [...updatedMessages, assistantMessage],
                updatedAt: Date.now()
            } : s))

        } catch (err) {
            console.error('Chat error:', err)
            const errorMessage: Message = { role: 'assistant', content: `❌ 请求失败: ${err instanceof Error ? err.message : String(err)}` }
            setSessions(prev => prev.map(s => s.id === session.id ? {
                ...s,
                messages: [...updatedMessages, errorMessage],
                updatedAt: Date.now()
            } : s))
        } finally {
            setIsLoading(false)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value)
        e.target.style.height = 'auto'
        e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
    }

    const formatTime = (timestamp: number) => {
        const date = new Date(timestamp)
        const now = new Date()
        const diff = now.getTime() - timestamp
        
        const minutes = Math.floor(diff / 60000)
        const hours = Math.floor(diff / 3600000)
        const days = Math.floor(diff / 86400000)
        
        if (minutes < 1) return '刚刚'
        if (minutes < 60) return `${minutes}分钟前`
        if (hours < 24) return `${hours}小时前`
        if (days < 7) return `${days}天前`
        
        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    }

    return (
        <div className={cn(
            "flex bg-background overflow-hidden",
            isMobile ? "h-[100dvh]" : "h-screen"
        )}>
            {/* 移动端侧边栏 Sheet */}
            {isMobile && (
                <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen} side="left">
                    <SheetContent className="w-[280px] p-0" side="left">
                        <div className="h-full flex flex-col">
                            {/* 侧边栏头部 */}
                            <SheetHeader>
                                <SheetTitle className="px-3 py-3 border-b text-base">对话历史</SheetTitle>
                            </SheetHeader>
                            
                            <div className="p-2 border-b border-border/50">
                                <Button
                                    className="w-full justify-start gap-2 bg-transparent hover:bg-muted border shadow-sm text-foreground transition-all duration-200 group"
                                    variant="outline"
                                    onClick={() => { createNewChat(); setMobileSidebarOpen(false); }}
                                >
                                    <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
                                    <span>新对话</span>
                                </Button>
                            </div>

                            {/* 历史对话列表 */}
                            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                                <div className="text-xs font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                                    今天
                                </div>
                                {sessions.slice(0, 10).map(session => (
                                    <div
                                        key={session.id}
                                        className={cn(
                                            "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer transition-all duration-200",
                                            currentId === session.id
                                                ? "bg-primary/10 text-primary font-medium"
                                                : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                                        )}
                                        onClick={() => { setCurrentId(session.id); setMobileSidebarOpen(false); }}
                                    >
                                        <MessageSquare className="h-4 w-4 flex-shrink-0" />
                                        <span className="flex-1 truncate text-sm">{session.title}</span>
                                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <span className="text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                                            <button
                                                className="p-1 hover:bg-destructive/10 hover:text-destructive rounded-lg transition-colors"
                                                onClick={(e) => handleDeleteChat(session.id, e)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </SheetContent>
                </Sheet>
            )}

            {/* 桌面端侧边栏 */}
            {!isMobile && (
                <aside className={cn(
                    "flex-shrink-0 border-r bg-background transition-all duration-300 ease-out",
                    desktopSidebarOpen ? "w-[280px]" : "w-0 overflow-hidden"
                )}>
                    <div className="h-full flex flex-col">
                        {/* 侧边栏头部 */}
                        <div className="p-3 border-b border-border/50">
                            <Button
                                className="w-full justify-start gap-2 bg-transparent hover:bg-muted border shadow-sm text-foreground transition-all duration-200 group"
                                variant="outline"
                                onClick={createNewChat}
                            >
                                <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
                                <span>新对话</span>
                            </Button>
                        </div>

                        {/* 历史对话列表 */}
                        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                            <div className="text-xs font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                                今天
                            </div>
                            {sessions.slice(0, 10).map(session => (
                                <div
                                    key={session.id}
                                    className={cn(
                                        "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer transition-all duration-200",
                                        currentId === session.id
                                            ? "bg-primary/10 text-primary font-medium"
                                            : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                                    )}
                                    onClick={() => setCurrentId(session.id)}
                                >
                                    <MessageSquare className="h-4 w-4 flex-shrink-0" />
                                    <span className="flex-1 truncate text-sm">{session.title}</span>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <span className="text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                                        <button
                                            className="p-1 hover:bg-destructive/10 hover:text-destructive rounded-lg transition-colors"
                                            onClick={(e) => handleDeleteChat(session.id, e)}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </aside>
            )}

            {/* 主聊天区域 */}
            <main className="flex-1 flex flex-col min-w-0 min-h-0 relative">
                {/* 顶部栏 */}
                <header className={cn(
                    "border-b border-border/50 flex items-center justify-between px-4 bg-background/80 backdrop-blur-sm shrink-0 z-10",
                    isMobile ? "h-12" : "h-14"
                )}>
                    <div className="flex items-center gap-3">
                        {isMobile && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setMobileSidebarOpen(true)}
                            >
                                <MessageSquare className="h-5 w-5" />
                            </Button>
                        )}
                        <div ref={modelSelectWrapperRef} className="relative">
                            <button
                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-muted/50 transition-colors text-sm font-medium"
                                onClick={() => setShowModelSelect(!showModelSelect)}
                            >
                                <Sparkles className="h-4 w-4 text-primary" />
                                <span>{currentModel.name}</span>
                                <ChevronDown className={cn(
                                    "h-4 w-4 transition-transform duration-200",
                                    showModelSelect && "rotate-180"
                                )} />
                            </button>
                            
                            {/* 模型选择下拉菜单 */}
                            {showModelSelect && (
                                <div className={cn(
                                    "absolute top-full left-0 mt-2 bg-popover border border-border rounded-xl shadow-lg z-20 animate-slideUp",
                                    isMobile ? "w-[calc(100vw-32px)] right-0" : "w-72"
                                )}>
                                    <div className="p-1">
                                        {MODELS.map(model => (
                                            <button
                                                key={model.id}
                                                className={cn(
                                                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                                                    selectedModel === model.id
                                                        ? "bg-primary/10 text-primary"
                                                        : "hover:bg-muted/50"
                                                )}
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    setSelectedModel(model.id)
                                                    setShowModelSelect(false)
                                                }}
                                            >
                                                <Sparkles className="h-4 w-4" />
                                                <div className="flex-1">
                                                    <div className="text-sm font-medium">{model.name}</div>
                                                    <div className="text-xs text-muted-foreground">{model.description}</div>
                                                </div>
                                                {selectedModel === model.id && (
                                                    <Check className="h-4 w-4" />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" className="text-muted-foreground">
                        <Settings2 className="h-4 w-4" />
                    </Button>
                </header>

                {/* 消息区域 */}
                <div className="flex-1 overflow-y-auto min-h-0">
                    <div className={cn(
                        "mx-auto space-y-6",
                        isMobile ? "max-w-full px-3 py-4" : "max-w-3xl px-4 py-6"
                    )}>
                        {!currentSession || currentSession.messages.length === 0 ? (
                            /* 空状态 */
                            <div className="h-full flex flex-col items-center justify-center text-center space-y-6 py-12">
                                <div className="relative">
                                    <div className="absolute inset-0 bg-primary/10 blur-3xl rounded-full" />
                                    <div className="relative p-4 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl animate-pulse-subtle">
                                        <Bot className="h-16 w-16 text-primary" />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <h2 className="text-2xl font-semibold">开始聊天</h2>
                                    <p className="text-muted-foreground">选择一个模型并发送消息开始对话</p>
                                </div>
                                <div className="grid grid-cols-2 gap-3 max-w-md">
                                    {[
                                        '解释一个技术概念',
                                        '写一段代码',
                                        '帮我优化这段文字',
                                        '设计一个数据库'
                                    ].map((suggestion, index) => (
                                        <button
                                            key={index}
                                            className="text-left p-3 rounded-xl border border-border/50 hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 text-sm"
                                            onClick={() => setInput(suggestion)}
                                        >
                                            {suggestion}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            /* 消息列表 */
                            currentSession.messages.map((msg, idx) => (
                                <div
                                    key={idx}
                                    className={cn(
                                        "flex gap-4 group animate-fadeIn",
                                        msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                                    )}
                                >
                                    {/* 头像 */}
                                    <div className={cn(
                                        "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
                                        msg.role === 'assistant' 
                                            ? "bg-gradient-to-br from-primary to-primary/70 text-primary-foreground" 
                                            : "bg-muted"
                                    )}>
                                        {msg.role === 'assistant' ? (
                                            <Bot className="h-5 w-5" />
                                        ) : (
                                            <User className="h-5 w-5 text-muted-foreground" />
                                        )}
                                    </div>

                                    {/* 消息内容 */}
                                    <div className={cn(
                                        "flex-1 max-w-[85%]",
                                        msg.role === 'user' ? "flex flex-col items-end" : "flex flex-col items-start"
                                    )}>
                                        <div className={cn(
                                            "rounded-2xl px-4 py-3 text-sm leading-relaxed",
                                            msg.role === 'user'
                                                ? "bg-primary text-primary-foreground rounded-tr-sm"
                                                : "bg-muted/50 rounded-tl-sm"
                                        )}>
                                            <div className="whitespace-pre-wrap">{msg.content}</div>
                                        </div>

                                        {/* 操作按钮 */}
                                        <div className={cn(
                                            "flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity",
                                            msg.role === 'user' ? "mr-1" : "ml-1"
                                        )}>
                                            <button
                                                className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
                                                onClick={() => handleCopy(msg.content, `${currentId}-${idx}`)}
                                                title="复制"
                                            >
                                                {copiedId === `${currentId}-${idx}` ? (
                                                    <Check className="h-4 w-4 text-success" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </button>
                                            {msg.role === 'assistant' && idx === currentSession.messages.length - 1 && (
                                                <button
                                                    className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
                                                    onClick={handleRegenerate}
                                                    title="重新生成"
                                                >
                                                    <RotateCcw className="h-4 w-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}

                        {/* 加载状态 */}
                        {isLoading && (
                            <div className="flex gap-4 animate-fadeIn">
                                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0">
                                    <Bot className="h-5 w-5 text-primary-foreground animate-pulse" />
                                </div>
                                <div className="bg-muted/30 rounded-2xl rounded-tl-sm px-4 py-3 space-y-2 w-[200px]">
                                    <div className="h-2 bg-muted-foreground/20 rounded w-3/4 animate-pulse" />
                                    <div className="h-2 bg-muted-foreground/20 rounded w-1/2 animate-pulse" />
                                    <div className="h-2 bg-muted-foreground/20 rounded w-2/3 animate-pulse" />
                                </div>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* 输入区域 */}
                <div className={cn(
                    "shrink-0 bg-background border-t border-border/30",
                    isMobile ? "p-2 pb-[env(safe-area-inset-bottom,8px)]" : "p-4"
                )}>
                    <div className={cn(
                        "relative",
                        isMobile ? "max-w-full" : "max-w-3xl mx-auto"
                    )}>
                        <div className="relative group">
                            <textarea
                                ref={textareaRef}
                                className={cn(
                                    "w-full px-4 pr-12 rounded-2xl",
                                    "border border-border bg-background shadow-sm",
                                    "focus:ring-2 focus:ring-primary/20 focus:border-primary",
                                    "resize-none outline-none text-sm leading-relaxed",
                                    "transition-all duration-200",
                                    "placeholder:text-muted-foreground/50",
                                    isMobile ? "min-h-[44px] max-h-[120px] py-2.5" : "min-h-[56px] max-h-[200px] py-3.5"
                                )}
                                placeholder="发送消息给 AI..."
                                value={input}
                                onChange={handleInput}
                                onKeyDown={handleKeyDown}
                                disabled={isLoading}
                                rows={1}
                            />
                            <Button
                                className={cn(
                                    "absolute right-2 p-0 rounded-xl transition-all duration-200",
                                    isMobile ? "bottom-1.5 h-8 w-8" : "bottom-2 h-9 w-9",
                                    input.trim() && !isLoading
                                        ? "bg-primary text-primary-foreground hover:bg-primary/90 scale-100"
                                        : "bg-muted text-muted-foreground scale-90"
                                )}
                                size="icon"
                                onClick={handleSend}
                                disabled={!input.trim() || isLoading}
                            >
                                <Send className={cn(
                                    "h-4 w-4 transition-transform duration-200",
                                    input.trim() && !isLoading && "translate-x-0.5 translate-y-0.5"
                                )} />
                            </Button>
                        </div>
                        {!isMobile && (
                            <div className="text-center text-xs text-muted-foreground/60 mt-2">
                                AI 可能生成不准确的信息。
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    )
}