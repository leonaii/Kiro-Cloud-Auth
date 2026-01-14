import { Loader2 } from 'lucide-react'
import { Button } from '../../ui'

interface SocialLoginStatusProps {
  onCancel: () => void
}

export function SocialLoginStatus({ onCancel }: SocialLoginStatusProps) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-center">
        <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500" />
        <p className="text-sm text-blue-700 dark:text-blue-300">
          请在浏览器中完成登录...
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          登录完成后会自动返回
        </p>
      </div>

      <Button
        variant="destructive"
        className="w-full"
        onClick={onCancel}
      >
        取消登录
      </Button>
    </div>
  )
}