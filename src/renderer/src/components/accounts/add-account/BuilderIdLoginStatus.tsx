import { Loader2, Copy, Check, ExternalLink } from 'lucide-react'
import { Button } from '../../ui'
import type { BuilderIdLoginData } from './types'

interface BuilderIdLoginStatusProps {
  loginData: BuilderIdLoginData
  copied: boolean
  onCopyUserCode: () => void
  onReopenBrowser: () => void
  onCancel: () => void
}

export function BuilderIdLoginStatus({
  loginData,
  copied,
  onCopyUserCode,
  onReopenBrowser,
  onCancel
}: BuilderIdLoginStatusProps) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-center">
        <p className="text-sm text-blue-700 dark:text-blue-300 mb-2">
          请在浏览器中完成登录，并输入以下代码：
        </p>
        <div className="flex items-center justify-center gap-2">
          <code className="text-2xl font-bold tracking-widest bg-white dark:bg-gray-800 px-4 py-2 rounded border">
            {loginData.userCode}
          </code>
          <Button
            variant="outline"
            size="icon"
            onClick={onCopyUserCode}
            title="复制代码"
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          等待授权中...
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={onReopenBrowser}
        >
          <ExternalLink className="h-4 w-4 mr-2" />
          重新打开浏览器
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          onClick={onCancel}
        >
          取消登录
        </Button>
      </div>
    </div>
  )
}