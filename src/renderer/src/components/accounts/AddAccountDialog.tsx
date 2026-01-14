// Part 1: Imports, Types, and Component Setup (Lines 1-300)
import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { setAutoSyncToServer } from '@/store/sync-v2'
import type { SubscriptionType } from '@/types/account'
import { isElectron } from '@/lib/api'
import { X, Loader2, Download, Copy, Check, ExternalLink, Info, Settings } from 'lucide-react'
import {
  ModeSelector,
  OAuthModeSelector,
  LoginButtons,
  BuilderIdLoginStatus,
  SocialLoginStatus,
  SsoTokenForm,
  OidcSingleForm,
  OidcBatchForm,
  type ImportMode,
  type LoginType,
  type OAuthMode,
  type VerifiedData,
  type BonusData
} from './add-account'

interface AddAccountDialogProps {
  isOpen: boolean
  onClose: () => void
}

interface BuilderIdLoginData {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export function AddAccountDialog({ isOpen, onClose }: AddAccountDialogProps): React.ReactNode {
  const { addAccount, accounts, bitBrowserConfig, setBitBrowserConfig } = useAccountsStore()

  // 检查账户是否已存在
  const isAccountExists = (email: string, userId: string, provider?: string): boolean => {
    return Array.from(accounts.values()).some(
      acc => acc.email === email && acc.idp === (provider || 'BuilderId')
    )
  }

  // 导入模式 - Web 端默认使用 OIDC 模式
  const [importMode, setImportMode] = useState<ImportMode>(isElectron() ? 'login' : 'oidc')

  // OIDC 凭证输入
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [authMethod, setAuthMethod] = useState<'IdC' | 'social'>('IdC')
  const [provider, setProvider] = useState('BuilderId')

  // SSO Token 导入
  const [ssoToken, setSsoToken] = useState('')
  const [batchImportResult, setBatchImportResult] = useState<{ total: number; success: number; failed: number; errors: string[] } | null>(null)

  // OIDC 批量导入
  const [oidcImportMode, setOidcImportMode] = useState<'single' | 'batch'>('single')
  const [oidcBatchData, setOidcBatchData] = useState('')
  const [oidcBatchImportResult, setOidcBatchImportResult] = useState<{ total: number; success: number; failed: number; errors: string[] } | null>(null)
  
  // 批量导入配置
  const [batchHeaderVersion, setBatchHeaderVersion] = useState<1 | 2>(2)
  const [batchAutoRefreshToken, setBatchAutoRefreshToken] = useState(false)
  const [batchSyncToServer, setBatchSyncToServer] = useState(true)

  // 验证后的数据
  const [verifiedData, setVerifiedData] = useState<VerifiedData | null>(null)

  // 状态
  const [isVerifying, setIsVerifying] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 登录相关状态
  const [loginType, setLoginType] = useState<LoginType>('builderid')
  const [oauthMode, setOauthMode] = useState<OAuthMode>('deep-link')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [builderIdLoginData, setBuilderIdLoginData] = useState<BuilderIdLoginData | null>(null)
  const [copied, setCopied] = useState(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 比特浏览器配置展开状态
  const [showBitBrowserConfig, setShowBitBrowserConfig] = useState(false)

  // 打开 URL 的辅助函数（根据配置选择使用比特浏览器或默认浏览器）
  const openUrl = useCallback(async (url: string): Promise<void> => {
    if (bitBrowserConfig.enabled && bitBrowserConfig.browserId) {
      try {
        const result = await window.api.openUrlInBitBrowser(url, bitBrowserConfig.port, bitBrowserConfig.browserId)
        if (!result.success) {
          console.error('[AddAccountDialog] BitBrowser error:', result.error)
          setError(`比特浏览器打开失败: ${result.error}`)
          // 回退到默认浏览器
          window.api.openExternal(url)
        }
      } catch (e) {
        console.error('[AddAccountDialog] BitBrowser exception:', e)
        // 回退到默认浏览器
        window.api.openExternal(url)
      }
    } else {
      window.api.openExternal(url)
    }
  }, [bitBrowserConfig])

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [])

  // 监听 Social Auth 回调 (应用授权模式 - deep link)
  useEffect(() => {
    if (!isLoggingIn || loginType === 'builderid' || oauthMode !== 'deep-link') return

    const unsubscribe = window.api.onSocialAuthCallback(async (data) => {
      console.log('[AddAccountDialog] Social auth callback (deep-link):', data)

      if (data.error) {
        setError(`登录失败: ${data.error}`)
        setIsLoggingIn(false)
        return
      }

      if (data.code && data.state) {
        try {
          const result = await window.api.exchangeSocialToken(data.code, data.state)
          if (result.success) {
            // 授权成功后，如果使用了比特浏览器，则关闭浏览器窗口
            if (bitBrowserConfig.enabled && bitBrowserConfig.browserId) {
              console.log('[AddAccountDialog] Closing BitBrowser window after successful auth...')
              try {
                const closeResult = await window.api.closeBitBrowser(bitBrowserConfig.port, bitBrowserConfig.browserId)
                if (closeResult.success) {
                  console.log('[AddAccountDialog] BitBrowser window closed successfully')
                } else {
                  console.warn('[AddAccountDialog] Failed to close BitBrowser window:', closeResult.error)
                }
              } catch (closeError) {
                console.warn('[AddAccountDialog] Error closing BitBrowser window:', closeError)
              }
            }
            
            await handleLoginSuccess({
              accessToken: result.accessToken!,
              refreshToken: result.refreshToken!,
              authMethod: 'social',
              provider: result.provider
            })
          } else {
            setError(result.error || 'Token 交换失败')
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : '登录失败')
        } finally {
          setIsLoggingIn(false)
        }
      }
    })

    return () => unsubscribe()
  }, [isLoggingIn, loginType, oauthMode, bitBrowserConfig])

  // 监听 Web OAuth 回调 (Web OAuth 无痕模式)
  useEffect(() => {
    if (!isLoggingIn || loginType === 'builderid' || oauthMode !== 'web-oauth') return

    const unsubscribe = window.api.onWebOAuthCallback(async (data) => {
      console.log('[AddAccountDialog] Web OAuth callback:', data)

      if (data.error) {
        setError(`登录失败: ${data.error}`)
        setIsLoggingIn(false)
        return
      }

      if (data.success && data.accessToken && data.refreshToken) {
        try {
          await handleLoginSuccess({
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            authMethod: 'social',
            provider: data.provider
          })
        } catch (e) {
          setError(e instanceof Error ? e.message : '登录失败')
        } finally {
          setIsLoggingIn(false)
        }
      }
    })

    return () => unsubscribe()
  }, [isLoggingIn, loginType, oauthMode])

  // 处理登录成功
  const handleLoginSuccess = async (tokenData: {
    accessToken: string
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    provider?: string
  }): Promise<void> => {
    console.log('[AddAccountDialog] Login successful, verifying credentials...')

    try {
      // 验证凭证并获取账号信息
      const result = await window.api.verifyAccountCredentials({
        refreshToken: tokenData.refreshToken,
        clientId: tokenData.clientId || '',
        clientSecret: tokenData.clientSecret || '',
        region: tokenData.region || 'us-east-1',
        authMethod: tokenData.authMethod,
        provider: tokenData.provider
      })

      if (result.success && result.data) {
        const { email, userId } = result.data

        // 检查账户是否已存在
        if (isAccountExists(email, userId, tokenData.provider)) {
          setError('该账号已存在，无需重复添加')
          return
        }

        // 启用自动同步到服务器（在线登录的账号应该自动同步）
        setAutoSyncToServer(true)

        // 添加账号
        const now = Date.now()
        try {
          await addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: (tokenData.provider || 'BuilderId') as 'BuilderId' | 'Google' | 'Github',
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId: tokenData.clientId || '',
            clientSecret: tokenData.clientSecret || '',
            region: tokenData.region || 'us-east-1',
            expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod: tokenData.authMethod as 'IdC' | 'social',
            provider: (tokenData.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            rawType: result.data.subscription?.rawType,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0
              ? result.data.usage.current / result.data.usage.limit
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          groupId: undefined,
          tags: [],
          status: 'active',
          lastUsedAt: now,
          // 使用服务端返回的 headerVersion（根据 IDP 自动确定）
          headerVersion: result.data.headerVersion
        })

          resetForm()
          onClose()
        } finally {
          // 恢复默认设置：不自动同步到服务器
          setAutoSyncToServer(false)
        }
      } else {
        setError(result.error || '验证失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加账号失败')
    }
  }
  // 启动 Builder ID 登录
  const handleStartBuilderIdLogin = async (): Promise<void> => {
    setIsLoggingIn(true)
    setError(null)
    setBuilderIdLoginData(null)

    try {
      const result = await window.api.startBuilderIdLogin(region)

      if (result.success && result.userCode && result.verificationUri) {
        setBuilderIdLoginData({
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresIn: result.expiresIn || 600,
          interval: result.interval || 5
        })

        // 打开浏览器
        openUrl(result.verificationUri)

        // 开始轮询
        startPolling(result.interval || 5)
      } else {
        setError(result.error || '启动登录失败')
        setIsLoggingIn(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动登录失败')
      setIsLoggingIn(false)
    }
  }

  // 开始轮询 Builder ID 授权
  const startPolling = (interval: number): void => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await window.api.pollBuilderIdAuth(region)

        if (!result.success) {
          setError(result.error || '授权失败')
          setIsLoggingIn(false)
          setBuilderIdLoginData(null)
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          return
        }

        if (result.completed) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }

          await handleLoginSuccess({
            accessToken: result.accessToken!,
            refreshToken: result.refreshToken!,
            clientId: result.clientId,
            clientSecret: result.clientSecret,
            region: result.region,
            authMethod: 'IdC',
            provider: 'BuilderId'
          })

          setIsLoggingIn(false)
          setBuilderIdLoginData(null)
        }
      } catch (e) {
        console.error('[AddAccountDialog] Poll error:', e)
      }
    }, interval * 1000)
  }

  // 取消登录
  const handleCancelLogin = async (): Promise<void> => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    if (loginType === 'builderid') {
      await window.api.cancelBuilderIdLogin()
    } else if (oauthMode === 'web-oauth') {
      await window.api.cancelWebOAuthLogin()
    } else {
      await window.api.cancelSocialLogin()
    }

    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setError(null)
  }

  // 启动 Social Auth 登录 (Google/GitHub)
  const handleStartSocialLogin = async (socialProvider: 'Google' | 'Github'): Promise<void> => {
    setIsLoggingIn(true)
    setError(null)

    // 检查是否启用了比特浏览器
    const useBitBrowser = bitBrowserConfig.enabled && bitBrowserConfig.browserId

    try {
      if (oauthMode === 'web-oauth') {
        const result = await window.api.startWebOAuthLogin(socialProvider)
        if (!result.success) {
          setError(result.error || '启动登录失败')
          setIsLoggingIn(false)
        } else if (useBitBrowser && result.loginUrl) {
          // 使用比特浏览器打开登录页面
          openUrl(result.loginUrl)
        }
        // 如果不使用比特浏览器，主进程已经打开了默认浏览器
      } else {
        // 如果启用了比特浏览器，告诉主进程不要打开浏览器
        const result = await window.api.startSocialLogin(socialProvider, useBitBrowser)
        if (!result.success) {
          setError(result.error || '启动登录失败')
          setIsLoggingIn(false)
        } else if (useBitBrowser && result.loginUrl) {
          // 使用比特浏览器打开登录页面
          openUrl(result.loginUrl)
        }
        // 如果不使用比特浏览器，主进程已经打开了默认浏览器
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动登录失败')
      setIsLoggingIn(false)
    }
  }

  // 复制 user_code
  const handleCopyUserCode = async (): Promise<void> => {
    if (builderIdLoginData?.userCode) {
      await navigator.clipboard.writeText(builderIdLoginData.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // 从本地配置导入
  const handleImportFromLocal = async (): Promise<void> => {
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        setRefreshToken(result.data.refreshToken)
        setClientId(result.data.clientId)
        setClientSecret(result.data.clientSecret)
        setRegion(result.data.region)
        setAuthMethod(result.data.authMethod as 'IdC' | 'social' || 'IdC')
        setProvider(result.data.provider || 'BuilderId')
        setError(null)
      } else {
        setError(result.error || '导入失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  // 从 SSO Token 导入并添加账号（支持批量）
  const handleSsoImport = async (): Promise<void> => {
    if (!ssoToken.trim()) {
      setError('请输入 x-amz-sso_authn 的值')
      return
    }

    const tokens = ssoToken
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0)

    if (tokens.length === 0) {
      setError('请输入至少一个 Token')
      return
    }

    setIsVerifying(true)
    setError(null)
    setBatchImportResult(null)

    // 启用自动同步到服务器（SSO Token 导入的账号应该自动同步）
    setAutoSyncToServer(true)

    const importResult = { total: tokens.length, success: 0, failed: 0, errors: [] as string[] }

    const importSingleToken = async (token: string, index: number): Promise<void> => {
      try {
        const result = await window.api.importFromSsoToken(token, region)

        if (result.success && result.data) {
          const { email, userId } = result.data

          if (email && userId && isAccountExists(email, userId, 'BuilderId')) {
            importResult.failed++
            importResult.errors.push(`#${index + 1}: ${email} 已存在`)
            return
          }

          const now = Date.now()
          await addAccount({
            email: email || '',
            userId: userId || '',
            nickname: email ? email.split('@')[0] : undefined,
            idp: 'BuilderId',
            credentials: {
              accessToken: result.data.accessToken,
              csrfToken: '',
              refreshToken: result.data.refreshToken,
              clientId: result.data.clientId,
              clientSecret: result.data.clientSecret,
              region: result.data.region,
              expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000
            },
            subscription: {
              type: (result.data.subscriptionType || 'Free') as SubscriptionType,
              title: result.data.subscriptionTitle || 'KIRO',
              daysRemaining: result.data.daysRemaining,
              managementTarget: result.data.subscription?.managementTarget,
              upgradeCapability: result.data.subscription?.upgradeCapability,
              overageCapability: result.data.subscription?.overageCapability
            },
            usage: {
              current: result.data.usage?.current || 0,
              limit: result.data.usage?.limit || 0,
              percentUsed: (result.data.usage?.limit || 0) > 0
                ? (result.data.usage?.current || 0) / (result.data.usage?.limit || 1)
                : 0,
              lastUpdated: now,
              baseLimit: result.data.usage?.baseLimit,
              baseCurrent: result.data.usage?.baseCurrent,
              freeTrialLimit: result.data.usage?.freeTrialLimit,
              freeTrialCurrent: result.data.usage?.freeTrialCurrent,
              freeTrialExpiry: result.data.usage?.freeTrialExpiry,
              bonuses: result.data.usage?.bonuses,
              nextResetDate: result.data.usage?.nextResetDate,
              resourceDetail: result.data.usage?.resourceDetail
            },
            groupId: undefined,
            tags: [],
            status: 'active',
            lastUsedAt: now,
            // SSO Token 导入的都是 BuilderId，默认使用 V2
            headerVersion: result.data.headerVersion || 2
          })

          importResult.success++
        } else {
          importResult.failed++
          importResult.errors.push(`#${index + 1}: ${result.error?.message || '导入失败'}`)
        }
      } catch (e) {
        importResult.failed++
        importResult.errors.push(`#${index + 1}: ${e instanceof Error ? e.message : '导入失败'}`)
      }
    }

    try {
      await Promise.allSettled(tokens.map((token, index) => importSingleToken(token, index)))

      setBatchImportResult(importResult)

      if (importResult.failed === 0) {
        resetForm()
        onClose()
      } else if (importResult.success > 0) {
        setError(`成功导入 ${importResult.success} 个，失败 ${importResult.failed} 个`)
      } else {
        setError(`全部导入失败 (${importResult.failed} 个)`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SSO 导入失败')
    } finally {
      setIsVerifying(false)
      // 恢复默认设置：不自动同步到服务器
      setAutoSyncToServer(false)
    }
  }
  // OIDC 批量导入
  const handleOidcBatchAdd = async (): Promise<void> => {
    if (!oidcBatchData.trim()) {
      setError('请输入凭证数据')
      return
    }

    let credentials: Array<{
      refreshToken: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: 'IdC' | 'social'
      provider?: string
      email?: string
      label?: string
      accessToken?: string
      clientIdHash?: string
    }>

    try {
      const parsed = JSON.parse(oidcBatchData.trim())
      credentials = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      setError('JSON 格式错误，请检查输入')
      return
    }

    if (credentials.length === 0) {
      setError('请输入至少一个凭证')
      return
    }

    // 如果不自动刷新 token，检查是否提供了 accessToken
    if (!batchAutoRefreshToken) {
      const missingAccessToken = credentials.findIndex(c => !c.accessToken)
      if (missingAccessToken !== -1) {
        setError(`#${missingAccessToken + 1}: 未开启自动刷新时，必须提供 accessToken`)
        return
      }
    }

    setIsSubmitting(true)
    setError(null)
    setOidcBatchImportResult(null)

    // 根据用户选择临时设置是否同步到服务器
    if (batchSyncToServer) {
      setAutoSyncToServer(true)
    }

    const importResult = { total: credentials.length, success: 0, failed: 0, errors: [] as string[] }

    const importSingleCredential = async (cred: typeof credentials[0], index: number): Promise<void> => {
      try {
        if (!cred.refreshToken) {
          importResult.failed++
          importResult.errors.push(`#${index + 1}: 缺少 refreshToken`)
          return
        }

        const credProvider = cred.provider || 'BuilderId'
        const credAuthMethod = cred.authMethod || (credProvider === 'BuilderId' ? 'IdC' : 'social')

        // 根据配置决定是否刷新 token
        if (batchAutoRefreshToken) {
          // 自动刷新 token 模式：调用验证接口
          let result: { success: boolean; data?: VerifiedData; error?: string }

          if (isElectron()) {
            result = await window.api.verifyAccountCredentials({
              refreshToken: cred.refreshToken,
              clientId: cred.clientId || '',
              clientSecret: cred.clientSecret || '',
              region: cred.region || 'us-east-1',
              authMethod: credAuthMethod,
              provider: credProvider
            })
          } else {
            const response = await fetch('/api/accounts/verify-credentials', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                refreshToken: cred.refreshToken,
                clientId: cred.clientId || '',
                clientSecret: cred.clientSecret || '',
                region: cred.region || 'us-east-1',
                authMethod: credAuthMethod,
                provider: credProvider,
                email: cred.email || ''
              })
            })
            result = await response.json()
          }

          if (result.success && result.data) {
            const { email, userId } = result.data

            if (isAccountExists(email, userId, credProvider)) {
              importResult.failed++
              importResult.errors.push(`#${index + 1}: ${email} 已存在`)
              return
            }

            const provider = (cred.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
            const idpMap: Record<string, 'BuilderId' | 'Github' | 'Google'> = {
              'BuilderId': 'BuilderId',
              'Github': 'Github',
              'Google': 'Google'
            }
            const idp = idpMap[provider] || 'BuilderId'
            const authMethod = cred.authMethod || (provider === 'BuilderId' ? 'IdC' : 'social')

            // 使用 label 作为昵称，如果没有则使用邮箱前缀
            const nickname = cred.label || (email ? email.split('@')[0] : undefined)
            
            const now = Date.now()
            await addAccount({
              email,
              userId,
              nickname,
              idp,
              credentials: {
                accessToken: result.data.accessToken,
                csrfToken: '',
                refreshToken: result.data.refreshToken,
                clientId: cred.clientId || '',
                clientIdHash: cred.clientIdHash || '',
                clientSecret: cred.clientSecret || '',
                region: cred.region || 'us-east-1',
                expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
                authMethod,
                provider
              },
              subscription: {
                type: result.data.subscriptionType as SubscriptionType,
                title: result.data.subscriptionTitle,
                daysRemaining: result.data.daysRemaining,
                expiresAt: result.data.expiresAt,
                managementTarget: result.data.subscription?.managementTarget,
                upgradeCapability: result.data.subscription?.upgradeCapability,
                overageCapability: result.data.subscription?.overageCapability
              },
              usage: {
                current: result.data.usage.current,
                limit: result.data.usage.limit,
                percentUsed: result.data.usage.limit > 0
                  ? result.data.usage.current / result.data.usage.limit
                  : 0,
                lastUpdated: now,
                baseLimit: result.data.usage.baseLimit,
                baseCurrent: result.data.usage.baseCurrent,
                freeTrialLimit: result.data.usage.freeTrialLimit,
                freeTrialCurrent: result.data.usage.freeTrialCurrent,
                freeTrialExpiry: result.data.usage.freeTrialExpiry,
                bonuses: result.data.usage.bonuses,
                nextResetDate: result.data.usage.nextResetDate,
                resourceDetail: result.data.usage.resourceDetail
              },
              groupId: undefined,
              tags: [],
              status: 'active',
              lastUsedAt: now,
              // 使用 UI 选择的 headerVersion
              headerVersion: batchHeaderVersion
            })

            importResult.success++
          } else {
            importResult.failed++
            importResult.errors.push(`#${index + 1}: 验证失败 - ${result.error || '未知错误'}`)
          }
        } else {
          // 不自动刷新 token 模式：直接使用导入的 accessToken
          if (!cred.accessToken) {
            importResult.failed++
            importResult.errors.push(`#${index + 1}: 缺少 accessToken`)
            return
          }

          const email = cred.email || ''
          // 生成一个临时的 userId（如果没有提供）
          const userId = email ? `user_${email.replace(/[^a-zA-Z0-9]/g, '_')}` : `user_${Date.now()}`

          if (email && isAccountExists(email, userId, credProvider)) {
            importResult.failed++
            importResult.errors.push(`#${index + 1}: ${email} 已存在`)
            return
          }

          const provider = (cred.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
          const idpMap: Record<string, 'BuilderId' | 'Github' | 'Google'> = {
            'BuilderId': 'BuilderId',
            'Github': 'Github',
            'Google': 'Google'
          }
          const idp = idpMap[provider] || 'BuilderId'
          const authMethod = cred.authMethod || (provider === 'BuilderId' ? 'IdC' : 'social')

          // 使用 label 作为昵称，如果没有则使用邮箱前缀
          const nickname = cred.label || (email ? email.split('@')[0] : undefined)
          
          const now = Date.now()
          await addAccount({
            email,
            userId,
            nickname,
            idp,
            credentials: {
              accessToken: cred.accessToken,
              csrfToken: '',
              refreshToken: cred.refreshToken,
              clientId: cred.clientId || '',
              clientIdHash: cred.clientIdHash || '',
              clientSecret: cred.clientSecret || '',
              region: cred.region || 'us-east-1',
              // 默认 1 小时后过期
              expiresAt: now + 3600 * 1000,
              authMethod,
              provider
            },
            subscription: {
              type: 'Free' as SubscriptionType,
              title: 'KIRO'
            },
            usage: {
              current: 0,
              limit: 0,
              percentUsed: 0,
              lastUpdated: now
            },
            groupId: undefined,
            tags: [],
            status: 'active',
            lastUsedAt: now,
            // 使用 UI 选择的 headerVersion
            headerVersion: batchHeaderVersion
          })

          importResult.success++
        }
      } catch (e) {
        importResult.failed++
        importResult.errors.push(`#${index + 1}: ${e instanceof Error ? e.message : '导入失败'}`)
      }
    }

    try {
      await Promise.allSettled(credentials.map((cred, index) => importSingleCredential(cred, index)))

      setOidcBatchImportResult(importResult)

      if (importResult.failed === 0) {
        resetForm()
        onClose()
      } else if (importResult.success > 0) {
        setError(`成功导入 ${importResult.success} 个，失败 ${importResult.failed} 个`)
      } else {
        setError(`全部导入失败 (${importResult.failed} 个)`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OIDC 批量导入失败')
    } finally {
      setIsSubmitting(false)
      // 恢复默认设置：不自动同步到服务器
      setAutoSyncToServer(false)
    }
  }

  // OIDC 凭证添加账号（验证并添加）
  const handleOidcAdd = async (): Promise<void> => {
    if (!refreshToken) {
      setError('请填写 Refresh Token')
      return
    }
    if (authMethod !== 'social' && (!clientId || !clientSecret)) {
      setError('请填写 Client ID 和 Client Secret')
      return
    }

    setIsSubmitting(true)
    setError(null)

    // 启用自动同步到服务器（OIDC 单个凭证添加的账号应该自动同步）
    setAutoSyncToServer(true)

    try {
      let result: { success: boolean; data?: VerifiedData; error?: string }

      if (isElectron()) {
        result = await window.api.verifyAccountCredentials({
          refreshToken,
          clientId,
          clientSecret,
          region,
          authMethod,
          provider
        })
      } else {
        const response = await fetch('/api/accounts/verify-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refreshToken,
            clientId,
            clientSecret,
            region,
            authMethod,
            provider
          })
        })
        result = await response.json()
      }

      if (result.success && result.data) {
        const { email, userId } = result.data

        if (isAccountExists(email, userId, provider)) {
          setError('该账号已存在，无需重复添加')
          return
        }

        const now = Date.now()
        await addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: 'BuilderId',
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId,
            clientSecret,
            region,
            expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod,
            provider: (provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0
              ? result.data.usage.current / result.data.usage.limit
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          groupId: undefined,
          tags: [],
          status: 'active',
          lastUsedAt: now,
          // 使用服务端返回的 headerVersion（根据 IDP 自动确定）
          headerVersion: result.data.headerVersion
        })

        resetForm()
        onClose()
      } else {
        setError(result.error || '验证失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally {
      setIsSubmitting(false)
      // 恢复默认设置：不自动同步到服务器
      setAutoSyncToServer(false)
    }
  }

  const resetForm = (): void => {
    setImportMode(isElectron() ? 'login' : 'oidc')
    setRefreshToken('')
    setClientId('')
    setClientSecret('')
    setRegion('us-east-1')
    setAuthMethod('IdC')
    setProvider('BuilderId')
    setSsoToken('')
    setVerifiedData(null)
    setError(null)
    setLoginType('builderid')
    setOauthMode('deep-link')  // 默认使用应用授权模式（推荐）
    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setCopied(false)
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }

  if (!isOpen) return null

  const isWeb = !isElectron()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <Card className="relative w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col z-10">
        <CardHeader className="pb-4 border-b shrink-0">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-xl font-bold">添加账号</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-muted" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">选择一种方式来添加您的 Kiro 账号</p>
        </CardHeader>

        <CardContent className="space-y-6 pt-6 overflow-y-auto flex-1">
          {/* 导入模式切换 */}
          <ModeSelector
            importMode={importMode}
            onModeChange={(mode) => { setImportMode(mode); setError(null) }}
            isWeb={isWeb}
            disabled={!!verifiedData || isLoggingIn}
          />

          {/* 登录模式 - 仅 Electron 端 */}
          {!isWeb && importMode === 'login' && !verifiedData && (
            <div className="space-y-4">
              {/* 登录中状态 - Builder ID */}
              {isLoggingIn && builderIdLoginData && (
                <BuilderIdLoginStatus
                  loginData={builderIdLoginData}
                  copied={copied}
                  onCopyUserCode={handleCopyUserCode}
                  onReopenBrowser={() => openUrl(builderIdLoginData.verificationUri)}
                  onCancel={handleCancelLogin}
                />
              )}

              {/* 登录中状态 - Social Auth */}
              {isLoggingIn && !builderIdLoginData && (
                <SocialLoginStatus
                  loginType={loginType}
                  onCancel={handleCancelLogin}
                />
              )}

              {/* 未登录状态 - 显示登录选项 */}
              {!isLoggingIn && (
                <div className="space-y-4 py-2">
                  <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Check className="w-6 h-6 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold">选择登录方式</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      支持多种方式快捷登录
                    </p>
                  </div>

                  {/* OAuth 模式选择 */}
                  <OAuthModeSelector
                    oauthMode={oauthMode}
                    onModeChange={setOauthMode}
                  />

                  {/* 比特浏览器配置 */}
                  <div className="border rounded-lg p-3 bg-muted/30">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={bitBrowserConfig.enabled}
                          onChange={(e) => setBitBrowserConfig({ enabled: e.target.checked })}
                          className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                        />
                        <span className="text-sm font-medium">使用比特浏览器打开登录页面</span>
                      </label>
                      {bitBrowserConfig.enabled && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => setShowBitBrowserConfig(!showBitBrowserConfig)}
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    
                    {bitBrowserConfig.enabled && showBitBrowserConfig && (
                      <div className="mt-3 space-y-3 pt-3 border-t">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                              API 端口号
                            </label>
                            <input
                              type="number"
                              value={bitBrowserConfig.port}
                              onChange={(e) => setBitBrowserConfig({ port: parseInt(e.target.value) || 54345 })}
                              placeholder="54345"
                              className="w-full px-2 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                              浏览器窗口 ID
                            </label>
                            <input
                              type="text"
                              value={bitBrowserConfig.browserId}
                              onChange={(e) => setBitBrowserConfig({ browserId: e.target.value })}
                              placeholder="输入浏览器窗口 ID"
                              className="w-full px-2 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          <Info className="inline-block w-3 h-3 mr-1" />
                          请确保比特浏览器已启动，并填写正确的端口号和浏览器窗口 ID
                        </p>
                      </div>
                    )}
                    
                    {bitBrowserConfig.enabled && !bitBrowserConfig.browserId && (
                      <p className="mt-2 text-xs text-amber-600">
                        ⚠️ 请配置浏览器窗口 ID 后再进行登录
                      </p>
                    )}
                  </div>

                  {/* 登录按钮 */}
                  <LoginButtons
                    onGoogleLogin={() => {
                      setLoginType('google')
                      handleStartSocialLogin('Google')
                    }}
                    onGithubLogin={() => {
                      setLoginType('github')
                      handleStartSocialLogin('Github')
                    }}
                    onBuilderIdLogin={() => {
                      setLoginType('builderid')
                      handleStartBuilderIdLogin()
                    }}
                    isLoading={isLoggingIn}
                  />
                </div>
              )}
            </div>
          )}

          {/* SSO Token 导入模式 - 仅 Electron 端 */}
          {!isWeb && importMode === 'sso' && !verifiedData && (
            <SsoTokenForm
              ssoToken={ssoToken}
              onTokenChange={(value) => { setSsoToken(value); setBatchImportResult(null) }}
              selectedRegion={region}
              onRegionChange={setRegion}
              importResults={batchImportResult}
              isLoading={isVerifying}
              onImport={handleSsoImport}
            />
          )}

          {/* OIDC 凭证输入模式 */}
          {importMode === 'oidc' && !verifiedData && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">输入 OIDC 凭证</h3>
                <div className="flex items-center gap-2">
                  {/* 单个/批量 切换 */}
                  <div className="flex bg-muted/50 rounded-lg p-0.5">
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'single' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('single'); setOidcBatchImportResult(null) }}
                    >
                      单个
                    </button>
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'batch' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('batch'); setOidcBatchImportResult(null) }}
                    >
                      批量
                    </button>
                  </div>
                  {oidcImportMode === 'single' && !isWeb && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-lg text-xs"
                      onClick={handleImportFromLocal}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      本地导入
                    </Button>
                  )}
                </div>
              </div>

              {/* 单个导入模式 */}
              {oidcImportMode === 'single' && (
                <OidcSingleForm
                  oidcCredentials={{
                    refreshToken,
                    clientId,
                    clientSecret,
                    region,
                    authMethod,
                    provider
                  }}
                  onCredentialsChange={(creds) => {
                    setRefreshToken(creds.refreshToken)
                    setClientId(creds.clientId)
                    setClientSecret(creds.clientSecret)
                    setRegion(creds.region)
                    setAuthMethod(creds.authMethod)
                    setProvider(creds.provider)
                  }}
                  selectedRegion={region}
                  onRegionChange={setRegion}
                  isLoading={isSubmitting}
                  onImport={handleOidcAdd}
                />
              )}

              {/* 批量导入模式 */}
              {oidcImportMode === 'batch' && (
                <OidcBatchForm
                  oidcBatchJson={oidcBatchData}
                  onJsonChange={(value) => { setOidcBatchData(value); setOidcBatchImportResult(null) }}
                  importResults={oidcBatchImportResult}
                  isLoading={isSubmitting}
                  onImport={handleOidcBatchAdd}
                  headerVersion={batchHeaderVersion}
                  onHeaderVersionChange={setBatchHeaderVersion}
                  autoRefreshToken={batchAutoRefreshToken}
                  onAutoRefreshTokenChange={setBatchAutoRefreshToken}
                  syncToServer={batchSyncToServer}
                  onSyncToServerChange={setBatchSyncToServer}
                />
              )}
            </div>
          )}

          {/* 错误信息 */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
              <div className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
              {error}
            </div>
          )}

          {/* 提交按钮 - 只在 OIDC 模式显示 */}
          {importMode === 'oidc' && (
            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={onClose} className="rounded-xl h-10 px-6">
                取消
              </Button>
              {oidcImportMode === 'single' ? (
                <Button
                  onClick={handleOidcAdd}
                  disabled={isSubmitting || !refreshToken || (authMethod !== 'social' && (!clientId || !clientSecret))}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  确认添加
                </Button>
              ) : (
                <Button
                  onClick={handleOidcBatchAdd}
                  disabled={isSubmitting || !oidcBatchData.trim()}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      正在并发导入...
                    </>
                  ) : (
                    (() => {
                      try {
                        const parsed = JSON.parse(oidcBatchData.trim())
                        const count = Array.isArray(parsed) ? parsed.length : 1
                        return `批量导入 ${count} 个账号`
                      } catch {
                        return '批量导入'
                      }
                    })()
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}