import { app, shell, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, session } from 'electron'
import * as machineIdModule from './machineId'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { encode, decode } from 'cbor-x'

// 图标路径（运行时解析）
const getIconPath = () => {
  if (is.dev) {
    return join(__dirname, '../../resources/kiro-high-resolution-logo-transparent.ico')
  }
  return join(process.resourcesPath, 'kiro-high-resolution-logo-transparent.ico')
}

// 托盘图标使用同一个 ICO
const getTrayIconPath = () => {
  if (is.dev) {
    return join(__dirname, '../../resources/kiro-high-resolution-logo-transparent.ico')
  }
  return join(process.resourcesPath, 'kiro-high-resolution-logo-transparent.ico')
}

// 系统托盘
let tray: Tray | null = null

// ============ Kiro API 调用 ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'

// ============ Header 版本控制配置 ============
// 不同 IDP 的默认 Header 版本（与 server/config/index.js 保持一致）
const IDP_HEADER_VERSIONS: Record<string, number> = {
  'AWSIdC': 2,      // AWS Identity Center
  'BuilderId': 2,   // AWS Builder ID
  'Github': 1,      // GitHub
  'Google': 1       // Google
}
const DEFAULT_HEADER_VERSION = 1

/**
 * 根据 IDP 获取默认的 Header 版本
 * @param idp - 身份提供商（AWSIdC, BuilderId, Github, Google）
 * @returns Header 版本号（1 或 2）
 */
function getDefaultHeaderVersionForIdp(idp: string): number {
  return IDP_HEADER_VERSIONS[idp] || DEFAULT_HEADER_VERSION
}

// ============ OIDC Token 刷新 ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  csrfToken?: string  // 社交登录 (GitHub/Google) 的 CSRF Token
  profileArn?: string // 社交登录的 Profile ARN
  error?: string
}

// 社交登录 (GitHub/Google) 的 Token 刷新端点
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ 代理设置 ============

// 设置代理环境变量
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    process.env.HTTP_PROXY = url
    process.env.HTTPS_PROXY = url
    process.env.http_proxy = url
    process.env.https_proxy = url
    console.log(`[Proxy] Enabled: ${url}`)
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// IdC (BuilderId) 的 OIDC Token 刷新
async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1'
): Promise<OidcRefreshResult> {
  console.log(`[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...`)

  const url = `https://oidc.${region}.amazonaws.com/token`

  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': await getKiroUserAgent()
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken, // 可能不返回新的 refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 社交登录 (GitHub/Google) 的 Token 刷新
// 严格匹配 Rust 实现 (Kiro_New/src-tauri/src/kiro_auth_client.rs)
async function refreshSocialToken(refreshToken: string): Promise<OidcRefreshResult> {
  console.log(`[Social] Refreshing token...`)

  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 严格匹配 Rust 实现的 User-Agent
        'User-Agent': 'KiroBatchLoginCLI/1.0.0'
      },
      body: JSON.stringify({ refreshToken })
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)
    // 严格匹配 Rust 实现: SocialRefreshResponse 包含 csrfToken 和 profileArn
    if (data.csrfToken) {
      console.log(`[Social] CSRF Token received: ${data.csrfToken.substring(0, 20)}...`)
    }

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn,
      csrfToken: data.csrfToken,  // 从响应中提取 CSRF Token
      profileArn: data.profileArn  // 从响应中提取 Profile ARN
    }
  } catch (error) {
    console.error(`[Social] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// Web OAuth Token 刷新 (使用 KiroWebPortalService RefreshToken API)
// 严格匹配 Rust 实现: Kiro_New/src-tauri/src/providers/web_oauth.rs refresh_token_with_cookies
async function refreshWebOAuthToken(
  accessToken: string,
  csrfToken: string,
  sessionToken: string,
  idp: string
): Promise<OidcRefreshResult> {
  console.log(`[Web OAuth] Refreshing token for ${idp}...`)

  const url = `${KIRO_API_BASE}/RefreshToken`

  // 请求体包含 csrfToken
  const body = {
    csrfToken: csrfToken
  }

  // Cookie 格式: AccessToken=xxx; RefreshToken=xxx; Idp=xxx
  const cookie = `AccessToken=${accessToken}; RefreshToken=${sessionToken}; Idp=${idp}`

  console.log(`[Web OAuth] RefreshToken Request:`)
  console.log(`  - url: ${url}`)
  console.log(`  - idp: ${idp}`)
  console.log(`  - accessToken: ${accessToken.substring(0, 20)}...`)
  console.log(`  - sessionToken: ${sessionToken.substring(0, 20)}...`)
  console.log(`  - csrfToken: ${csrfToken}`)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/cbor',
        'content-type': 'application/cbor',
        'smithy-protocol': 'rpc-v2-cbor',
        'amz-sdk-invocation-id': generateInvocationId(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amz-user-agent': await getKiroUserAgent(),
        'x-csrf-token': csrfToken,  // 同时在 header 中传递 csrfToken
        'Cookie': cookie
      },
      body: Buffer.from(encode(body))
    })

    if (!response.ok) {
      const errorBuffer = await response.arrayBuffer()
      let errorMessage = `HTTP ${response.status}`
      try {
        const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
        if (errorData.message) {
          errorMessage = errorData.message
        }
        // 423 Locked = AccountSuspendedException = 账号被封禁
        if (response.status === 423 || errorMessage.includes('AccountSuspendedException')) {
          return { success: false, error: 'BANNED: 账号已被封禁' }
        }
      } catch {
        // 忽略解析错误
      }
      console.error(`[Web OAuth] RefreshToken failed: ${errorMessage}`)
      return { success: false, error: `RefreshToken failed: ${errorMessage}` }
    }

    // 解析响应体
    const cborResponse = decode(Buffer.from(await response.arrayBuffer())) as {
      accessToken?: string
      csrfToken?: string
      expiresIn?: number
      profileArn?: string
    }

    console.log(`[Web OAuth] RefreshToken Response:`, JSON.stringify(cborResponse, null, 2))

    if (!cborResponse.accessToken) {
      return { success: false, error: 'No access_token in response' }
    }
    if (!cborResponse.csrfToken) {
      return { success: false, error: 'No csrf_token in response' }
    }

    console.log(`[Web OAuth] Token refreshed successfully, expires in ${cborResponse.expiresIn}s`)

    return {
      success: true,
      accessToken: cborResponse.accessToken,
      refreshToken: sessionToken,  // sessionToken 保持不变
      expiresIn: cborResponse.expiresIn,
      csrfToken: cborResponse.csrfToken,  // 新的 csrfToken
      profileArn: cborResponse.profileArn
    }
  } catch (error) {
    console.error(`[Web OAuth] RefreshToken error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 通用 Token 刷新 - 根据 authMethod 选择刷新方式
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  csrfToken?: string,
  accessToken?: string,
  idp?: string
): Promise<OidcRefreshResult> {
  // 如果是 Web OAuth 登录，使用 KiroWebPortalService RefreshToken API
  if (authMethod === 'web_oauth') {
    if (!csrfToken || !accessToken || !idp) {
      return { success: false, error: 'Web OAuth 刷新需要 csrfToken, accessToken 和 idp' }
    }
    return refreshWebOAuthToken(accessToken, csrfToken, token, idp)
  }
  // 如果是社交登录，使用 Kiro Auth Service 刷新
  if (authMethod === 'social') {
    return refreshSocialToken(token)
  }
  // 否则使用 OIDC 刷新 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ============ AWS SSO 设备授权流程 ============
interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

async function ssoDeviceAuth(
  bearerToken: string,
  region: string = 'us-east-1'
): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const portalBase = 'https://portal.sso.us-east-1.amazonaws.com'
  const startUrl = 'https://view.awsapps.com/start'
  const scopes = [
    'codewhisperer:analysis',
    'codewhisperer:completions',
    'codewhisperer:conversations',
    'codewhisperer:taskassist',
    'codewhisperer:transformations'
  ]

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let deviceSessionToken: string
  let interval = 1

  // Step 1: 注册 OIDC 客户端
  console.log('[SSO] Step 1: Registering OIDC client...')
  try {
    const regRes = await fetch(`${oidcBase}/client/register`, {
      method: 'POST',
      headers: {
        ...getBrowserHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientName: 'Kiro-Cloud-Auth ',
        clientType: 'public',
        scopes,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: startUrl
      })
    })
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`)
    const regData = (await regRes.json()) as { clientId: string; clientSecret: string }
    clientId = regData.clientId
    clientSecret = regData.clientSecret
    console.log(`[SSO] Client registered: ${clientId.substring(0, 30)}...`)
  } catch (e) {
    return { success: false, error: `注册客户端失败: ${e}` }
  }

  // Step 2: 发起设备授权
  console.log('[SSO] Step 2: Starting device authorization...')
  try {
    const devRes = await fetch(`${oidcBase}/device_authorization`, {
      method: 'POST',
      headers: {
        ...getBrowserHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    })
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`)
    const devData = (await devRes.json()) as {
      deviceCode: string
      userCode: string
      interval?: number
    }
    deviceCode = devData.deviceCode
    userCode = devData.userCode
    interval = devData.interval || 1
    console.log(`[SSO] Device code obtained, user_code: ${userCode}`)
  } catch (e) {
    return { success: false, error: `设备授权失败: ${e}` }
  }

  // Step 3: 验证 Bearer Token (whoAmI)
  console.log('[SSO] Step 3: Verifying bearer token...')
  try {
    const whoRes = await fetch(`${portalBase}/token/whoAmI`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
        'User-Agent': await getKiroUserAgent()
      }
    })
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`)
    console.log('[SSO] Bearer token verified')
  } catch (e) {
    return { success: false, error: `Token 验证失败: ${e}` }
  }

  // Step 4: 获取设备会话令牌
  console.log('[SSO] Step 4: Getting device session token...')
  try {
    const sessRes = await fetch(`${portalBase}/session/device`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        'User-Agent': await getKiroUserAgent()
      },
      body: JSON.stringify({})
    })
    if (!sessRes.ok) throw new Error(`Device session failed: ${sessRes.status}`)
    const sessData = (await sessRes.json()) as { token: string }
    deviceSessionToken = sessData.token
    console.log('[SSO] Device session token obtained')
  } catch (e) {
    return { success: false, error: `获取设备会话失败: ${e}` }
  }

  // Step 5: 接受用户代码
  console.log('[SSO] Step 5: Accepting user code...')
  let deviceContext: { deviceContextId?: string; clientId?: string; clientType?: string } | null =
    null
  try {
    const acceptRes = await fetch(`${oidcBase}/device_authorization/accept_user_code`, {
      method: 'POST',
      headers: {
        ...getBrowserHeaders(),
        'Content-Type': 'application/json',
        Referer: 'https://view.awsapps.com/'
      },
      body: JSON.stringify({ userCode, userSessionId: deviceSessionToken })
    })
    if (!acceptRes.ok) throw new Error(`Accept user code failed: ${acceptRes.status}`)
    const acceptData = (await acceptRes.json()) as {
      deviceContext?: { deviceContextId?: string; clientId?: string; clientType?: string }
    }
    deviceContext = acceptData.deviceContext || null
    console.log('[SSO] User code accepted')
  } catch (e) {
    return { success: false, error: `接受用户代码失败: ${e}` }
  }

  // Step 6: 批准授权
  if (deviceContext?.deviceContextId) {
    console.log('[SSO] Step 6: Approving authorization...')
    try {
      const approveRes = await fetch(`${oidcBase}/device_authorization/associate_token`, {
        method: 'POST',
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json',
          Referer: 'https://view.awsapps.com/'
        },
        body: JSON.stringify({
          deviceContext: {
            deviceContextId: deviceContext.deviceContextId,
            clientId: deviceContext.clientId || clientId,
            clientType: deviceContext.clientType || 'public'
          },
          userSessionId: deviceSessionToken
        })
      })
      if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status}`)
      console.log('[SSO] Authorization approved')
    } catch (e) {
      return { success: false, error: `批准授权失败: ${e}` }
    }
  }

  // Step 7: 轮询获取 Token
  console.log('[SSO] Step 7: Polling for token...')
  const startTime = Date.now()
  const timeout = 120000 // 2 分钟超时

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, interval * 1000))

    try {
      const tokenRes = await fetch(`${oidcBase}/token`, {
        method: 'POST',
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.ok) {
        const tokenData = (await tokenRes.json()) as {
          accessToken: string
          refreshToken: string
          expiresIn?: number
        }
        console.log('[SSO] Token obtained successfully!')
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
      }

      if (tokenRes.status === 400) {
        const errData = (await tokenRes.json()) as { error?: string }
        if (errData.error === 'authorization_pending') {
          continue // 继续轮询
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token 获取失败: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: '授权超时，请重试' }
}

// 生成 Kiro IDE 风格的 x-amz-user-agent
// 严格匹配 Rust 实现 (Kiro_New/src-tauri/src/codewhisperer_client.rs)
async function getKiroUserAgent(): Promise<string> {
  // 获取应用版本
  const version = app.getVersion()
  // 获取机器 ID（从本地设置或生成一个临时的）
  let machineId = 'unknown'
  try {
    const result = await machineIdModule.getCurrentMachineId()
    if (result.success && result.machineId) {
      machineId = result.machineId
    }
  } catch {
    // 忽略错误，使用默认值
  }
  return `aws-sdk-js/1.0.0 KiroIDE-${version}-${machineId}`
}

// 生成模拟浏览器的 Headers (用于 AWS Builder ID 登录)
// 模拟 Chrome 143.0 on Windows 10
function getBrowserHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
  }
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp: string = 'BuilderId' // 支持 BuilderId, Github, Google
): Promise<T> {
  console.log(`[Kiro API] Calling ${operation}`)
  console.log(`[Kiro API] Body:`, JSON.stringify(body))
  console.log(`[Kiro API] AccessToken length:`, accessToken?.length)
  console.log(`[Kiro API] AccessToken (first 100 chars):`, accessToken?.substring(0, 100))
  console.log(
    `[Kiro API] AccessToken (last 50 chars):`,
    accessToken?.substring(accessToken.length - 50)
  )
  console.log(`[Kiro API] Idp:`, idp)

  // 获取 Kiro IDE 风格的 User-Agent
  const xAmzUserAgent = await getKiroUserAgent()
  console.log(`[Kiro API] x-amz-user-agent:`, xAmzUserAgent)

  const response = await fetch(`${KIRO_API_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      accept: 'application/cbor',
      'content-type': 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      'amz-sdk-invocation-id': generateInvocationId(),
      'amz-sdk-request': 'attempt=1; max=1',
      // 严格匹配 Rust 实现的格式：aws-sdk-js/1.0.0 KiroIDE-{version}-{machine_id}
      'x-amz-user-agent': xAmzUserAgent,
      authorization: `Bearer ${accessToken}`,
      cookie: `Idp=${idp}; AccessToken=${accessToken}`
    },
    body: Buffer.from(encode(body))
  })

  console.log(`[Kiro API] Response status: ${response.status}`)

  if (!response.ok) {
    // 尝试解析 CBOR 格式的错误响应
    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
      if (errorData.__type && errorData.message) {
        // 提取错误类型名称（去掉命名空间）
        const errorType = errorData.__type.split('#').pop() || errorData.__type
        errorMessage = `${errorType}: ${errorData.message}`
      } else if (errorData.message) {
        errorMessage = errorData.message
      }
      console.error(`[Kiro API] Error:`, errorData)
    } catch {
      // 如果 CBOR 解析失败，显示原始内容
      const errorText = Buffer.from(errorBuffer).toString('utf-8')
      console.error(`[Kiro API] Error (raw): ${errorText}`)
    }
    throw new Error(errorMessage)
  }

  const arrayBuffer = await response.arrayBuffer()
  const result = decode(Buffer.from(arrayBuffer)) as T
  console.log(`[Kiro API] Response:`, JSON.stringify(result, null, 2))
  return result
}

// GetUserInfo API - 只需要 accessToken 即可调用
interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

async function getUserInfo(
  accessToken: string,
  idp: string = 'BuilderId'
): Promise<UserInfoResponse> {
  return kiroApiRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp)
}

// 定义自定义协议
const PROTOCOL_PREFIX = 'kiro'

// Electron-Web 模式：不使用本地存储，所有数据从远程 MySQL 数据库获取

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    title: `Kiro Cloud v${app.getVersion()}`,
    width: 1200, // 刚好容纳 3 列卡片 (340*3 + 16*2 + 边距)
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    show: true, // 🔥 立即显示窗口，不等待内容加载
    backgroundColor: '#ffffff', // 🔥 设置背景色，避免白屏闪烁
    autoHideMenuBar: true,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 🔥 性能优化
      backgroundThrottling: false, // 后台不节流
      enableWebSQL: false, // 禁用 WebSQL
      spellcheck: false // 禁用拼写检查
    }
  })

  // 完全移除菜单栏（禁用 Alt 键显示菜单）
  mainWindow.setMenu(null)

  mainWindow.on('ready-to-show', () => {
    // 设置带版本号的标题（HTML 加载后会覆盖初始标题）
    mainWindow?.setTitle(`Kiro-Cloud-Auth v${app.getVersion()}`)
    // 窗口已经显示，不需要再调用 show()
  })

  // 关闭按钮最小化到托盘而不是退出
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发模式下禁用缓存，确保热更新生效
  if (is.dev) {
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache'
        }
      })
    })
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  // 支持通过环境变量 WEB_SERVER_URL 加载远程 Web 服务器
  // 注意：ELECTRON_WEB_SERVER_URL 在构建时通过 electron.vite.config.ts 的 define 注入
  const webServerUrl = process.env.WEB_SERVER_URL || process.env.ELECTRON_WEB_SERVER_URL || ''

  if (webServerUrl) {
    console.log(`[Window] Loading from web server: ${webServerUrl}`)
    mainWindow.loadURL(webServerUrl)

    // 注入 WEB_SERVER_URL 到渲染进程，用于 API 调用
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.executeJavaScript(`
        window.__WEB_SERVER_URL__ = '${webServerUrl}';
        console.log('[Electron] Injected WEB_SERVER_URL:', '${webServerUrl}');
      `)
    })

    // 防止页面自动刷新：拦截导航事件
    mainWindow.webContents.on('will-navigate', (event, url) => {
      // 如果是同一个 URL（刷新），阻止并记录日志
      const currentUrl = mainWindow?.webContents.getURL()
      if (currentUrl && url === currentUrl) {
        console.log('[Window] Blocked automatic page refresh')
        event.preventDefault()
      }
    })

    // 处理页面加载失败：不自动刷新，只记录错误
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error(`[Window] Page load failed: ${errorCode} - ${errorDescription}`)
      // 不自动重新加载，让用户手动刷新
    })
  } else if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册自定义协议
function registerProtocol(): void {
  // 先注销旧的注册（防止上次异常退出未注销）
  unregisterProtocol()

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// 注销自定义协议 (应用退出时调用)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// 处理协议 URL (用于 OAuth 回调)
function handleProtocolUrl(url: string): void {
  console.log('[Protocol] Received URL:', url)
  console.log('[Protocol] Expected prefix:', `${PROTOCOL_PREFIX}://`)

  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) {
    console.log('[Protocol] URL does not match expected prefix, ignoring')
    return
  }

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 处理 auth 回调
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// 创建系统托盘
function createTray(): void {
  const trayImage = nativeImage.createFromPath(getTrayIconPath())
  tray = new Tray(trayImage.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: '打开开发者工具',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.openDevTools()
        }
      }
    },
    {
      label: '强制刷新缓存',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.session.clearCache()
            .then(() => {
              if (mainWindow) {
                mainWindow.webContents.reload()
                console.log('[Tray] Cache cleared and page reloaded')
              }
            })
            .catch((error) => {
              console.error('[Tray] Failed to clear cache:', error)
              if (mainWindow) {
                mainWindow.webContents.reload()
              }
            })
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('Kiro-Cloud-Auth')
  tray.setContextMenu(contextMenu)

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

// 扩展 app 类型
declare module 'electron' {
  interface App {
    isQuitting: boolean
  }
}
app.isQuitting = false

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 注册自定义协议
  registerProtocol()

  // 创建系统托盘
  createTray()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.kiro.cloud')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: 打开外部链接
  ipcMain.on('open-external', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url)
    }
  })

  // IPC: 通过比特浏览器打开 URL
  ipcMain.handle('open-url-in-bitbrowser', async (_event, url: string, port: number, browserId: string) => {
    try {
      if (!url || !port || !browserId) {
        return { success: false, error: '缺少必要参数：url、port 或 browserId' }
      }

      console.log(`[IPC] Opening URL in BitBrowser: ${url}, port: ${port}, browserId: ${browserId}`)

      // 调用比特浏览器 API 打开浏览器窗口
      const response = await fetch(`http://127.0.0.1:${port}/browser/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: browserId,
          args: [url]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[IPC] BitBrowser API error: ${response.status} - ${errorText}`)
        return { success: false, error: `比特浏览器 API 错误: ${response.status} - ${errorText}` }
      }

      const result = await response.json()
      console.log('[IPC] BitBrowser API response:', result)

      // 检查比特浏览器 API 返回的结果
      if (result.success === false) {
        return { success: false, error: result.msg || '比特浏览器打开失败' }
      }

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[IPC] Failed to open URL in BitBrowser:', errorMessage)

      // 检查是否是连接错误
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        return { success: false, error: `无法连接到比特浏览器，请确保比特浏览器已启动并且端口 ${port} 正确` }
      }

      return { success: false, error: `打开比特浏览器失败: ${errorMessage}` }
    }
  })

  // IPC: 关闭比特浏览器窗口
  ipcMain.handle('close-bitbrowser', async (_event, port: number, browserId: string) => {
    try {
      if (!port || !browserId) {
        return { success: false, error: '缺少必要参数：port 或 browserId' }
      }

      console.log(`[IPC] Closing BitBrowser window: port: ${port}, browserId: ${browserId}`)

      // 调用比特浏览器 API 关闭浏览器窗口
      const response = await fetch(`http://127.0.0.1:${port}/browser/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: browserId
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[IPC] BitBrowser close API error: ${response.status} - ${errorText}`)
        return { success: false, error: `比特浏览器关闭 API 错误: ${response.status} - ${errorText}` }
      }

      const result = await response.json()
      console.log('[IPC] BitBrowser close API response:', result)

      // 检查比特浏览器 API 返回的结果
      if (result.success === false) {
        return { success: false, error: result.msg || '比特浏览器关闭失败' }
      }

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[IPC] Failed to close BitBrowser:', errorMessage)

      // 检查是否是连接错误
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        return { success: false, error: `无法连接到比特浏览器，请确保比特浏览器已启动并且端口 ${port} 正确` }
      }

      return { success: false, error: `关闭比特浏览器失败: ${errorMessage}` }
    }
  })

  // IPC: 获取应用版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: 重载应用（用于版本更新）
  ipcMain.handle('reload-app', () => {
    if (mainWindow) {
      mainWindow.reload()
      return { success: true }
    }
    return { success: false, error: '窗口不存在' }
  })

  // 注意：load-accounts 和 save-accounts IPC 已删除
  // Electron 渲染进程现在直接使用 HTTP 请求（通过 webAdapter），与 Web 版本统一
  // 这样可以自动携带 cookie 进行认证，无需通过 IPC 传递

  // IPC: 刷新账号 Token（支持 IdC、社交登录和 Web OAuth）
  ipcMain.handle('refresh-account-token', async (_event, account) => {
    try {
      const { refreshToken, clientId, clientSecret, region, authMethod, csrfToken, accessToken, provider } = account.credentials || {}

      if (!refreshToken) {
        return { success: false, error: { message: '缺少 Refresh Token' } }
      }

      // Web OAuth 需要 csrfToken, accessToken 和 provider
      if (authMethod === 'web_oauth') {
        if (!csrfToken || !accessToken || !provider) {
          return { success: false, error: { message: 'Web OAuth 刷新需要 csrfToken, accessToken 和 provider' } }
        }
      } else if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
        return { success: false, error: { message: '缺少 OIDC 刷新凭证 (clientId/clientSecret)' } }
      }

      console.log(`[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...`)

      // 根据 authMethod 选择刷新方式
      const refreshResult = await refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region || 'us-east-1',
        authMethod,
        csrfToken,      // Web OAuth 需要
        accessToken,    // Web OAuth 需要
        provider        // Web OAuth 需要 (idp)
      )

      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: { message: refreshResult.error || 'Token 刷新失败' } }
      }

      return {
        success: true,
        data: {
          accessToken: refreshResult.accessToken,
          refreshToken: refreshResult.refreshToken || refreshToken,
          expiresIn: refreshResult.expiresIn ?? 3600,
          csrfToken: refreshResult.csrfToken,      // Web OAuth / 社交登录的 CSRF Token
          profileArn: refreshResult.profileArn     // Profile ARN
        }
      }
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 从 SSO Token 导入账号 (x-amz-sso_authn)
  ipcMain.handle(
    'import-from-sso-token',
    async (_event, bearerToken: string, region: string = 'us-east-1') => {
      console.log('[IPC] import-from-sso-token called')

      try {
        // 执行 SSO 设备授权流程
        const ssoResult = await ssoDeviceAuth(bearerToken, region)

        if (!ssoResult.success || !ssoResult.accessToken) {
          return { success: false, error: { message: ssoResult.error || 'SSO 授权失败' } }
        }

        // 并行获取用户信息和使用量
        interface UsageBreakdownItem {
          resourceType?: string
          currentUsage?: number
          usageLimit?: number
          displayName?: string
          displayNamePlural?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          freeTrialInfo?: {
            currentUsage?: number
            usageLimit?: number
            freeTrialExpiry?: number  // API 返回的是 Unix 时间戳（毫秒）
            freeTrialStatus?: string
          }
          bonuses?: Array<{
            bonusCode?: string
            displayName?: string
            currentUsage?: number
            usageLimit?: number
            expiresAt?: number  // API 返回的是 Unix 时间戳（毫秒）
          }>
        }
        interface UsageApiResponse {
          userInfo?: { email?: string; userId?: string }
          subscriptionInfo?: {
            type?: string
            subscriptionTitle?: string
            upgradeCapability?: string
            overageCapability?: string
            subscriptionManagementTarget?: string
          }
          usageBreakdownList?: UsageBreakdownItem[]
          nextDateReset?: number  // API 返回的是 Unix 时间戳（毫秒）
          overageConfiguration?: { overageEnabled?: boolean }
        }

        let userInfo: UserInfoResponse | undefined
        let usageData: UsageApiResponse | undefined

        try {
          console.log('[SSO] Fetching user info and usage data...')
          const [userInfoResult, usageResult] = await Promise.all([
            getUserInfo(ssoResult.accessToken).catch((e) => {
              console.error('[SSO] getUserInfo failed:', e)
              return undefined
            }),
            kiroApiRequest<UsageApiResponse>(
              'GetUserUsageAndLimits',
              { isEmailRequired: true, origin: 'KIRO_IDE' },
              ssoResult.accessToken
            ).catch((e) => {
              console.error('[SSO] GetUserUsageAndLimits failed:', e)
              return undefined
            })
          ])
          userInfo = userInfoResult
          usageData = usageResult
          console.log('[SSO] userInfo:', userInfo?.email)
          console.log('[SSO] usageData:', usageData?.subscriptionInfo?.subscriptionTitle)
        } catch (e) {
          console.error('[IPC] API calls failed:', e)
        }

        // 解析使用量数据
        const creditUsage = usageData?.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')
        const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'

        // 规范化订阅类型
        let subscriptionType = 'Free'
        if (subscriptionTitle.toUpperCase().includes('PRO')) {
          subscriptionType = 'Pro'
        } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
          subscriptionType = 'Enterprise'
        } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
          subscriptionType = 'Teams'
        }

        // 基础额度
        const baseLimit = creditUsage?.usageLimit ?? 0
        const baseCurrent = creditUsage?.currentUsage ?? 0

        // 试用额度
        let freeTrialLimit = 0,
          freeTrialCurrent = 0,
          freeTrialExpiry: number | undefined
        if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
          freeTrialLimit = creditUsage.freeTrialInfo.usageLimit ?? 0
          freeTrialCurrent = creditUsage.freeTrialInfo.currentUsage ?? 0
          // API 返回的是 Unix 时间戳（毫秒）
          freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
        }

        // 奖励额度
        const bonuses = (creditUsage?.bonuses || []).map((b) => ({
          code: b.bonusCode || '',
          name: b.displayName || '',
          current: b.currentUsage ?? 0,
          limit: b.usageLimit ?? 0,
          // API 返回的是 Unix 时间戳（毫秒）
          expiresAt: b.expiresAt
        }))

        const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
        const totalCurrent =
          baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

        return {
          success: true,
          data: {
            accessToken: ssoResult.accessToken,
            refreshToken: ssoResult.refreshToken,
            clientId: ssoResult.clientId,
            clientSecret: ssoResult.clientSecret,
            region: ssoResult.region,
            expiresIn: ssoResult.expiresIn,
            email: usageData?.userInfo?.email || userInfo?.email,
            userId: usageData?.userInfo?.userId || userInfo?.userId,
            idp: userInfo?.idp || 'BuilderId',
            status: userInfo?.status,
            subscriptionType,
            subscriptionTitle,
            subscription: {
              managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
              upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
              overageCapability: usageData?.subscriptionInfo?.overageCapability
            },
            usage: {
              current: totalCurrent,
              limit: totalLimit,
              baseLimit,
              baseCurrent,
              freeTrialLimit,
              freeTrialCurrent,
              freeTrialExpiry,
              bonuses,
              nextResetDate: usageData?.nextDateReset,
              resourceDetail: creditUsage
                ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled: usageData?.overageConfiguration?.overageEnabled
                  }
                : undefined
            },
            // API 返回的 nextDateReset 是 Unix 时间戳（毫秒）
            daysRemaining: usageData?.nextDateReset && typeof usageData.nextDateReset === 'number'
              ? Math.max(
                  0,
                  Math.ceil((usageData.nextDateReset - Date.now()) / 86400000)
                )
              : undefined
          }
        }
      } catch (error) {
        console.error('[IPC] import-from-sso-token error:', error)
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : 'Unknown error' }
        }
      }
    }
  )

  // IPC: 检查账号状态（支持自动刷新 Token）
  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log('[IPC] check-account-status called')
    console.log('[IPC] Account email:', account?.email)
    console.log('[IPC] Has credentials:', !!account?.credentials)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      currentUsage?: number
      status?: string
      expiresAt?: number // API 返回的是 Unix 时间戳（毫秒）
    }

    interface FreeTrialInfo {
      usageLimit?: number
      currentUsage?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number // API 返回的是 Unix 时间戳（毫秒）
    }

    interface UsageBreakdown {
      usageLimit?: number
      currentUsage?: number
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      nextDateReset?: number // API 返回的是 Unix 时间戳（毫秒）
      bonuses?: Bonus[]
      freeTrialInfo?: FreeTrialInfo
    }

    interface SubscriptionInfo {
      subscriptionTitle?: string
      type?: string
      upgradeCapability?: string
      overageCapability?: string
      subscriptionManagementTarget?: string
    }

    interface UserInfo {
      email?: string
      userId?: string
    }

    interface OverageConfiguration {
      overageEnabled?: boolean
    }

    interface UsageResponse {
      daysUntilReset?: number
      nextDateReset?: number // API 返回的是 Unix 时间戳（毫秒）
      usageBreakdownList?: UsageBreakdown[]
      overageConfiguration?: OverageConfiguration
      subscriptionInfo?: SubscriptionInfo
      userInfo?: UserInfo
    }

    // 解析 API 响应的辅助函数
    const parseUsageResponse = (
      result: UsageResponse,
      newCredentials?: {
        accessToken: string
        refreshToken?: string
        expiresIn?: number
      },
      userInfo?: UserInfoResponse
    ) => {
      console.log('GetUserUsageAndLimits response:', JSON.stringify(result, null, 2))

      // 解析 Credits 使用量（resourceType 为 CREDIT）
      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // 解析使用量（详细）
      // 基础额度
      const baseLimit = creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsage ?? 0

      // 试用额度
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: number | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsage ?? 0
        // API 返回的是 Unix 时间戳（毫秒）
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 奖励额度
      const bonusesData: {
        code: string
        name: string
        current: number
        limit: number
        expiresAt?: number // Unix 时间戳（毫秒）
      }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonusesData.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsage ?? 0,
              limit: bonus.usageLimit ?? 0,
              // API 返回的是 Unix 时间戳（毫秒）
              expiresAt: bonus.expiresAt
            })
          }
        }
      }

      // 计算总额度
      const totalLimit =
        baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed =
        baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      // API 返回的是 Unix 时间戳（毫秒）
      const nextResetDate = result.nextDateReset

      // 解析订阅类型
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 解析重置时间并计算剩余天数
      // API 返回的 nextDateReset 是 Unix 时间戳（毫秒）
      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset && typeof result.nextDateReset === 'number') {
        // 直接使用 Unix 时间戳
        expiresAt = result.nextDateReset
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // 资源详情
      const resourceDetail = creditUsage
        ? {
            resourceType: creditUsage.resourceType,
            displayName: creditUsage.displayName,
            displayNamePlural: creditUsage.displayNamePlural,
            currency: creditUsage.currency,
            unit: creditUsage.unit,
            overageRate: creditUsage.overageRate,
            overageCap: creditUsage.overageCap,
            overageEnabled: result.overageConfiguration?.overageEnabled ?? false
          }
        : undefined

      return {
        success: true,
        data: {
          status: userInfo?.status === 'Active' ? 'active' : userInfo?.status ? 'error' : 'active',
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // 如果刷新了 token，返回新的凭证
          newCredentials: newCredentials
            ? {
                accessToken: newCredentials.accessToken,
                refreshToken: newCredentials.refreshToken,
                expiresAt: newCredentials.expiresIn
                  ? Date.now() + newCredentials.expiresIn * 1000
                  : undefined
              }
            : undefined
        }
      }
    }

    try {
      const { accessToken, refreshToken, clientId, clientSecret, region, authMethod, provider } =
        account.credentials || {}

      // 确定正确的 idp：优先使用 credentials.provider，否则回退到 account.idp
      // 社交登录使用实际的 provider (Github/Google)，IdC 使用 BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!accessToken) {
        console.log('[IPC] Missing accessToken')
        return { success: false, error: { message: '缺少 accessToken' } }
      }

      // 第一次尝试：使用当前 accessToken
      try {
        // 并行调用 GetUserInfo 和 GetUserUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(accessToken, idp).catch(() => undefined), // GetUserInfo 失败不影响整体流程
          kiroApiRequest<UsageResponse>(
            'GetUserUsageAndLimits',
            { isEmailRequired: true, origin: 'KIRO_IDE' },
            accessToken,
            idp
          )
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''

        // 检查是否是 401 错误（token 过期）
        // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          console.log(
            `[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...`
          )

          // 尝试刷新 token - 根据 authMethod 选择刷新方式
          const refreshResult = await refreshTokenByMethod(
            refreshToken,
            clientId || '',
            clientSecret || '',
            region || 'us-east-1',
            authMethod
          )

          if (refreshResult.success && refreshResult.accessToken) {
            console.log('[IPC] Token refreshed, retrying API call...')

            // 用新 token 并行调用 GetUserInfo 和 GetUserUsageAndLimits
            const [userInfoResult, usageResult] = await Promise.all([
              getUserInfo(refreshResult.accessToken, idp).catch(() => undefined),
              kiroApiRequest<UsageResponse>(
                'GetUserUsageAndLimits',
                { isEmailRequired: true, origin: 'KIRO_IDE' },
                refreshResult.accessToken,
                idp
              )
            ])

            // 返回结果并包含新凭证
            return parseUsageResponse(
              usageResult,
              {
                accessToken: refreshResult.accessToken,
                refreshToken: refreshResult.refreshToken,
                expiresIn: refreshResult.expiresIn
              },
              userInfoResult
            )
          } else {
            console.error('[IPC] Token refresh failed:', refreshResult.error)
            return {
              success: false,
              error: { message: `Token 过期且刷新失败: ${refreshResult.error}` }
            }
          }
        }

        // 不是 401 或没有刷新凭证，抛出原错误
        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 导出到文件
  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出账号数据',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  // IPC: 从文件导入
  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '导入账号数据',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const content = await readFile(result.filePaths[0], 'utf-8')
        return content
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })

  // IPC: 验证凭证并获取账号信息（用于添加账号）
  ipcMain.handle(
    'verify-account-credentials',
    async (
      _event,
      credentials: {
        refreshToken: string
        clientId: string
        clientSecret: string
        region?: string
        authMethod?: string
        provider?: string // 'BuilderId', 'Github', 'Google' 等
      }
    ) => {
      console.log('[IPC] verify-account-credentials called')

      try {
        const {
          refreshToken,
          clientId,
          clientSecret,
          region = 'us-east-1',
          authMethod,
          provider
        } = credentials
        // 确定 idp：社交登录使用 provider，IdC 使用 BuilderId
        const idp = authMethod === 'social' && provider ? provider : 'BuilderId'

        // 社交登录只需要 refreshToken，IdC 需要 clientId 和 clientSecret
        if (!refreshToken) {
          return { success: false, error: '请填写 Refresh Token' }
        }
        if (authMethod !== 'social' && (!clientId || !clientSecret)) {
          return { success: false, error: '请填写 Client ID 和 Client Secret' }
        }

        // Step 1: 使用合适的方式刷新获取 accessToken
        console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
        const refreshResult = await refreshTokenByMethod(
          refreshToken,
          clientId,
          clientSecret,
          region,
          authMethod
        )

        if (!refreshResult.success || !refreshResult.accessToken) {
          return { success: false, error: `Token 刷新失败: ${refreshResult.error}` }
        }

        console.log('[Verify] Step 2: Getting user info...')

        // Step 2: 调用 GetUserUsageAndLimits 获取用户信息
        interface Bonus {
          bonusCode?: string
          displayName?: string
          usageLimit?: number
          currentUsage?: number
          status?: string
          expiresAt?: number  // API 返回的是 Unix 时间戳（毫秒）
        }

        interface FreeTrialInfo {
          usageLimit?: number
          currentUsage?: number
          freeTrialStatus?: string
          freeTrialExpiry?: number  // API 返回的是 Unix 时间戳（毫秒）
        }

        interface UsageBreakdown {
          usageLimit?: number
          currentUsage?: number
          resourceType?: string
          displayName?: string
          displayNamePlural?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          bonuses?: Bonus[]
          freeTrialInfo?: FreeTrialInfo
        }

        interface UsageResponse {
          nextDateReset?: number  // API 返回的是 Unix 时间戳（毫秒）
          usageBreakdownList?: UsageBreakdown[]
          subscriptionInfo?: {
            subscriptionTitle?: string
            type?: string
            subscriptionManagementTarget?: string
            upgradeCapability?: string
            overageCapability?: string
          }
          overageConfiguration?: { overageEnabled?: boolean }
          userInfo?: { email?: string; userId?: string }
        }

        const usageResult = await kiroApiRequest<UsageResponse>(
          'GetUserUsageAndLimits',
          { isEmailRequired: true, origin: 'KIRO_IDE' },
          refreshResult.accessToken,
          idp
        )

        // 解析用户信息
        const email = usageResult.userInfo?.email || ''
        const userId = usageResult.userInfo?.userId || ''

        // 解析订阅类型
        const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
        let subscriptionType = 'Free'
        if (subscriptionTitle.toUpperCase().includes('PRO')) {
          subscriptionType = 'Pro'
        } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
          subscriptionType = 'Enterprise'
        } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
          subscriptionType = 'Teams'
        }

        // 解析使用量（详细）
        const creditUsage = usageResult.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')

        // 基础额度
        const baseLimit = creditUsage?.usageLimit ?? 0
        const baseCurrent = creditUsage?.currentUsage ?? 0

        // 试用额度
        let freeTrialLimit = 0
        let freeTrialCurrent = 0
        let freeTrialExpiry: number | undefined
        if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
          freeTrialLimit = creditUsage.freeTrialInfo.usageLimit ?? 0
          freeTrialCurrent = creditUsage.freeTrialInfo.currentUsage ?? 0
          // API 返回的是 Unix 时间戳（毫秒）
          freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
        }

        // 奖励额度
        const bonuses: {
          code: string
          name: string
          current: number
          limit: number
          expiresAt?: number  // Unix 时间戳（毫秒）
        }[] = []
        if (creditUsage?.bonuses) {
          for (const bonus of creditUsage.bonuses) {
            if (bonus.status === 'ACTIVE') {
              bonuses.push({
                code: bonus.bonusCode || '',
                name: bonus.displayName || '',
                current: bonus.currentUsage ?? 0,
                limit: bonus.usageLimit ?? 0,
                // API 返回的是 Unix 时间戳（毫秒）
                expiresAt: bonus.expiresAt
              })
            }
          }
        }

        // 计算总额度
        const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
        const totalUsed =
          baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

        // 计算重置剩余天数
        // API 返回的 nextDateReset 是 Unix 时间戳（毫秒）
        let daysRemaining: number | undefined
        let expiresAt: number | undefined
        const nextResetDate = usageResult.nextDateReset
        if (nextResetDate && typeof nextResetDate === 'number') {
          expiresAt = nextResetDate
          daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
        }

        // 根据 IDP 获取默认的 Header 版本
        const headerVersion = getDefaultHeaderVersionForIdp(idp)
        console.log('[Verify] Success! Email:', email, 'IDP:', idp, 'HeaderVersion:', headerVersion)

        return {
          success: true,
          data: {
            email,
            userId,
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken || refreshToken,
            expiresIn: refreshResult.expiresIn,
            subscriptionType,
            subscriptionTitle,
            subscription: {
              rawType: usageResult.subscriptionInfo?.type,
              managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
              upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
              overageCapability: usageResult.subscriptionInfo?.overageCapability
            },
            usage: {
              current: totalUsed,
              limit: totalLimit,
              baseLimit,
              baseCurrent,
              freeTrialLimit,
              freeTrialCurrent,
              freeTrialExpiry,
              bonuses,
              nextResetDate,
              resourceDetail: creditUsage
                ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled: usageResult.overageConfiguration?.overageEnabled
                  }
                : undefined
            },
            daysRemaining,
            expiresAt,
            // 返回根据 IDP 确定的 header 版本，让客户端知道应该使用哪个版本
            headerVersion
          }
        }
      } catch (error) {
        console.error('[Verify] Error:', error)
        return { success: false, error: error instanceof Error ? error.message : '验证失败' }
      }
    }
  )

  // IPC: 获取本地 SSO 缓存中当前使用的账号信息
  ipcMain.handle('get-local-active-account', async () => {
    const os = await import('os')
    const path = await import('path')

    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')

      const tokenContent = await readFile(tokenPath, 'utf-8')
      const tokenData = JSON.parse(tokenContent)

      if (!tokenData.refreshToken) {
        return { success: false, error: '本地缓存中没有 refreshToken' }
      }

      return {
        success: true,
        data: {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
          authMethod: tokenData.authMethod,
          provider: tokenData.provider
        }
      }
    } catch {
      return { success: false, error: '无法读取本地 SSO 缓存' }
    }
  })

  // IPC: 从 Kiro 本地配置导入凭证
  ipcMain.handle('load-kiro-credentials', async () => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const fs = await import('fs/promises')

    try {
      // 从 ~/.aws/sso/cache/kiro-auth-token.json 读取 token
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      console.log('[Kiro Credentials] Reading token from:', tokenPath)

      let tokenData: {
        accessToken?: string
        refreshToken?: string
        clientIdHash?: string
        region?: string
        authMethod?: string
        provider?: string
      }

      try {
        const tokenContent = await readFile(tokenPath, 'utf-8')
        tokenData = JSON.parse(tokenContent)
      } catch {
        return { success: false, error: '找不到 kiro-auth-token.json 文件，请先在 Kiro IDE 中登录' }
      }

      if (!tokenData.refreshToken) {
        return { success: false, error: 'kiro-auth-token.json 中缺少 refreshToken' }
      }

      // 确定 clientIdHash：优先使用文件中的，否则计算默认值
      let clientIdHash = tokenData.clientIdHash
      if (!clientIdHash) {
        // 使用标准的 startUrl 计算 hash（与 Kiro 客户端一致）
        const startUrl = 'https://view.awsapps.com/start'
        clientIdHash = crypto.createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
        console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
      }

      // 读取客户端注册信息
      const clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
      console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)

      let clientData: {
        clientId?: string
        clientSecret?: string
      } | null = null

      try {
        const clientContent = await readFile(clientRegPath, 'utf-8')
        clientData = JSON.parse(clientContent)
      } catch {
        // 如果找不到，尝试搜索目录中的其他 .json 文件（排除 kiro-auth-token.json）
        console.log('[Kiro Credentials] Client file not found, searching cache directory...')
        try {
          const files = await fs.readdir(ssoCache)
          for (const file of files) {
            if (file.endsWith('.json') && file !== 'kiro-auth-token.json') {
              try {
                const content = await readFile(path.join(ssoCache, file), 'utf-8')
                const data = JSON.parse(content)
                if (data.clientId && data.clientSecret) {
                  clientData = data
                  console.log('[Kiro Credentials] Found client registration in:', file)
                  break
                }
              } catch {
                // 忽略无法解析的文件
              }
            }
          }
        } catch {
          // 忽略目录读取错误
        }
      }

      // 社交登录不需要 clientId/clientSecret
      const isSocialAuth = tokenData.authMethod === 'social'

      if (!isSocialAuth && (!clientData || !clientData.clientId || !clientData.clientSecret)) {
        return { success: false, error: '找不到客户端注册文件，请确保已在 Kiro IDE 中完成登录' }
      }

      console.log(
        `[Kiro Credentials] Successfully loaded credentials (authMethod: ${tokenData.authMethod || 'IdC'})`
      )

      return {
        success: true,
        data: {
          accessToken: tokenData.accessToken || '',
          refreshToken: tokenData.refreshToken,
          clientId: clientData?.clientId || '',
          clientSecret: clientData?.clientSecret || '',
          region: tokenData.region || 'us-east-1',
          authMethod: tokenData.authMethod || 'IdC',
          provider: tokenData.provider || 'BuilderId'
        }
      }
    } catch (error) {
      console.error('[Kiro Credentials] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  })

  // IPC: 切换账号 - 写入凭证到本地 SSO 缓存
  ipcMain.handle(
    'switch-account',
    async (
      _event,
      credentials: {
        accessToken: string
        refreshToken: string
        clientId: string
        clientSecret: string
        region?: string
        authMethod?: 'IdC' | 'social'
        provider?: 'BuilderId' | 'Github' | 'Google'
      }
    ) => {
      const os = await import('os')
      const path = await import('path')
      const crypto = await import('crypto')
      const { mkdir, writeFile } = await import('fs/promises')

      try {
        const {
          accessToken,
          refreshToken,
          clientId,
          clientSecret,
          region = 'us-east-1',
          authMethod = 'IdC',
          provider = 'BuilderId'
        } = credentials

        // 计算 clientIdHash (与 Kiro 客户端一致)
        const startUrl = 'https://view.awsapps.com/start'
        const clientIdHash = crypto
          .createHash('sha1')
          .update(JSON.stringify({ startUrl }))
          .digest('hex')

        // 确保目录存在
        const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
        await mkdir(ssoCache, { recursive: true })

        // 写入 token 文件
        const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
        const tokenData = {
          accessToken,
          refreshToken,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          clientIdHash,
          authMethod,
          provider,
          region
        }
        await writeFile(tokenPath, JSON.stringify(tokenData, null, 2))
        console.log('[Switch Account] Token saved to:', tokenPath)

        // 只有 IdC 登录需要写入客户端注册文件
        if (authMethod !== 'social' && clientId && clientSecret) {
          const clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
          const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000)
            .toISOString()
            .replace('Z', '')
          const clientData = {
            clientId,
            clientSecret,
            expiresAt,
            scopes: [
              'codewhisperer:completions',
              'codewhisperer:analysis',
              'codewhisperer:conversations',
              'codewhisperer:transformations',
              'codewhisperer:taskassist'
            ]
          }
          await writeFile(clientRegPath, JSON.stringify(clientData, null, 2))
          console.log('[Switch Account] Client registration saved to:', clientRegPath)
        }

        return { success: true }
      } catch (error) {
        console.error('[Switch Account] Error:', error)
        return { success: false, error: error instanceof Error ? error.message : '切换失败' }
      }
    }
  )

  // ============ 手动登录相关 IPC ============

  // 存储当前登录状态
  let currentLoginState: {
    type: 'builderid' | 'social'
    // BuilderId 相关
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    // Social Auth 相关
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 启动 Builder ID 手动登录
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 注册 OIDC 客户端
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetch(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          clientName: 'Kiro-Cloud-Auth ',
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `注册客户端失败: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 发起设备授权
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetch(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `设备授权失败: ${errText}` }
      }

      const authData = await authRes.json()
      const {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        interval = 5,
        expiresIn = 600
      } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 保存登录状态
      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 Builder ID 授权状态
  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '没有进行中的登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetch(`${oidcBase}/token`, {
        method: 'POST',
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')

        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }

        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: '设备码已过期' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '用户拒绝授权' }
        } else {
          currentLoginState = null
          return { success: false, error: `授权错误: ${error}` }
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '轮询失败' }
    }
  })

  // IPC: 取消 Builder ID 登录
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 启动 Social Auth 登录 (Google/GitHub)
  // skipOpenBrowser: 如果为 true，则不在主进程中打开浏览器，由渲染进程处理（用于比特浏览器等自定义浏览器）
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github', skipOpenBrowser?: boolean) => {
    console.log(`[Login] Starting ${provider} Social Auth login... (skipOpenBrowser: ${skipOpenBrowser})`)

    const crypto = await import('crypto')

    // 生成 PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // 构建登录 URL
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // 保存登录状态
    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    // 如果不跳过打开浏览器，则使用默认浏览器打开
    if (!skipOpenBrowser) {
      console.log(`[Login] Opening browser for ${provider} login...`)
      shell.openExternal(loginUrl.toString())
    } else {
      console.log(`[Login] Returning login URL for ${provider}, browser will be opened by renderer...`)
    }

    return {
      success: true,
      loginUrl: loginUrl.toString(),
      state: oauthState
    }
  })

  // IPC: 交换 Social Auth token
  // 严格匹配 Rust 实现 (Kiro_New/src-tauri/src/providers/social.rs)
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '没有进行中的社交登录' }
    }

    // 验证 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '状态参数不匹配，可能存在安全风险' }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'

    try {
      const tokenRes = await fetch(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token 交换失败: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')
      // 严格匹配 Rust 实现: SocialTokenResponse 包含 csrfToken
      if (tokenData.csrfToken) {
        console.log('[Login] CSRF Token received:', tokenData.csrfToken.substring(0, 20) + '...')
      } else {
        console.warn('[Login] No CSRF Token in response')
      }

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        csrfToken: tokenData.csrfToken,  // 从响应中提取 CSRF Token
        idToken: tokenData.idToken,       // 从响应中提取 ID Token
        tokenType: tokenData.tokenType,   // 从响应中提取 Token Type
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token 交换失败' }
    }
  })

  // IPC: 取消 Social Auth 登录
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // ============ Web OAuth 无痕模式 (使用 KiroWebPortalService API) ============
  // 参考 Kiro_New/src-tauri/src/providers/web_oauth.rs 实现

  const KIRO_WEB_REDIRECT_URI = 'https://app.kiro.dev/signin/oauth'

  // Web OAuth 登录状态
  let webOAuthState: {
    codeVerifier: string
    codeChallenge: string
    oauthState: string
    provider: string
    authWindow: BrowserWindow | null
  } | null = null

  // 生成 PKCE code_verifier (32 字节随机数，Base64URL 编码)
  async function generateCodeVerifier(): Promise<string> {
    const crypto = await import('crypto')
    return crypto.randomBytes(32).toString('base64url')
  }

  // 生成 PKCE code_challenge (SHA256 + Base64URL)
  async function generateCodeChallenge(verifier: string): Promise<string> {
    const crypto = await import('crypto')
    return crypto.createHash('sha256').update(verifier).digest('base64url')
  }

  // 调用 KiroWebPortalService InitiateLogin API
  // 严格匹配 Rust 实现: Kiro_New/src-tauri/src/providers/web_oauth.rs
  async function initiateWebOAuthLogin(
    idp: string,
    codeChallenge: string,
    state: string
  ): Promise<{ redirectUrl: string }> {
    console.log(`[Web OAuth] Calling InitiateLogin for ${idp}...`)
    console.log(`[Web OAuth] PKCE Parameters:`)
    console.log(`  - codeChallenge: ${codeChallenge}`)
    console.log(`  - codeChallenge length: ${codeChallenge?.length}`)
    console.log(`  - redirectUri: ${KIRO_WEB_REDIRECT_URI}`)
    console.log(`  - state: ${state}`)

    // 使用驼峰格式的字段名（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs InitiateLoginRequest
    const body = {
      idp,
      redirectUri: KIRO_WEB_REDIRECT_URI,        // 驼峰格式
      codeChallenge: codeChallenge,               // 驼峰格式
      codeChallengeMethod: 'S256',                // 驼峰格式
      state
    }

    console.log('[Web OAuth] Request body:', JSON.stringify(body, null, 2))

    const response = await fetch(`${KIRO_API_BASE}/InitiateLogin`, {
      method: 'POST',
      headers: {
        'accept': 'application/cbor',
        'content-type': 'application/cbor',
        'smithy-protocol': 'rpc-v2-cbor',
        'amz-sdk-invocation-id': generateInvocationId(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amz-user-agent': await getKiroUserAgent()
      },
      body: Buffer.from(encode(body))
    })

    if (!response.ok) {
      const errorBuffer = await response.arrayBuffer()
      let errorMessage = `HTTP ${response.status}`
      try {
        const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
        if (errorData.message) {
          errorMessage = errorData.message
        }
      } catch {
        // 忽略解析错误
      }
      throw new Error(`InitiateLogin failed: ${errorMessage}`)
    }

    // API 返回 redirectUrl 字段（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs InitiateLoginResponse
    const result = decode(Buffer.from(await response.arrayBuffer())) as { redirectUrl: string }
    console.log(`[Web OAuth] Got redirect URL: ${result.redirectUrl.substring(0, 100)}...`)
    return result
  }

  // ExchangeToken 响应结构（与 Rust 实现一致）
  // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs ExchangeTokenCborResponse & ExchangeTokenResult
  interface ExchangeTokenResult {
    accessToken: string        // 从响应体或 Set-Cookie 获取
    csrfToken: string          // 从响应体获取
    expiresIn?: number         // 从响应体获取
    profileArn?: string        // 从响应体获取
    sessionToken: string       // 从 Set-Cookie RefreshToken 获取
    idp?: string               // 从 Set-Cookie 获取
  }

  // 解析 Set-Cookie 头
  function parseCookies(setCookieHeaders: string[]): Record<string, string> {
    const cookies: Record<string, string> = {}
    for (const header of setCookieHeaders) {
      // 简单解析：取第一个 = 之前的作为 name，之后到 ; 之前的作为 value
      const match = header.match(/^([^=]+)=([^;]*)/)
      if (match) {
        cookies[match[1]] = match[2]
      }
    }
    return cookies
  }

  // 调用 KiroWebPortalService ExchangeToken API
  // 严格匹配 Rust 实现: Kiro_New/src-tauri/src/providers/web_oauth.rs
  async function exchangeWebOAuthToken(
    idp: string,
    code: string,
    codeVerifier: string,
    state: string
  ): Promise<ExchangeTokenResult> {
    console.log(`[Web OAuth] Calling ExchangeToken for ${idp}...`)
    console.log(`[Web OAuth] ExchangeToken Parameters:`)
    console.log(`  - code: ${code?.substring(0, 20)}...`)
    console.log(`  - codeVerifier: ${codeVerifier}`)
    console.log(`  - codeVerifier length: ${codeVerifier?.length}`)
    console.log(`  - redirectUri: ${KIRO_WEB_REDIRECT_URI}`)
    console.log(`  - state: ${state?.substring(0, 20)}...`)

    // 使用驼峰格式的字段名（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs ExchangeTokenRequest
    const body = {
      idp,
      code,
      codeVerifier: codeVerifier,           // 驼峰格式
      redirectUri: KIRO_WEB_REDIRECT_URI,   // 驼峰格式
      state
    }

    console.log(`[Web OAuth] ExchangeToken Request body:`, JSON.stringify(body, null, 2))

    const response = await fetch(`${KIRO_API_BASE}/ExchangeToken`, {
      method: 'POST',
      headers: {
        'accept': 'application/cbor',
        'content-type': 'application/cbor',
        'smithy-protocol': 'rpc-v2-cbor',
        'amz-sdk-invocation-id': generateInvocationId(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amz-user-agent': await getKiroUserAgent()
      },
      body: Buffer.from(encode(body))
    })

    // 打印所有响应头（调试用）
    console.log(`[Web OAuth] ExchangeToken Response Headers:`)
    response.headers.forEach((value, name) => {
      console.log(`  ${name}: ${value}`)
    })

    // 从 Set-Cookie 响应头提取 cookie（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs 第 347-365 行
    let cookieSessionToken: string | undefined
    let cookieAccessToken: string | undefined
    let cookieIdp: string | undefined

    const setCookieHeaders = response.headers.getSetCookie ? response.headers.getSetCookie() : []
    console.log(`[Web OAuth] Set-Cookie headers count: ${setCookieHeaders.length}`)

    for (const cookieStr of setCookieHeaders) {
      console.log(`[Web OAuth] Set-Cookie raw: ${cookieStr}`)
      const cookies = parseCookies([cookieStr])
      if (cookies['RefreshToken']) {
        cookieSessionToken = cookies['RefreshToken']
        console.log(`[Web OAuth] Found RefreshToken cookie: ${cookieSessionToken.substring(0, 20)}...`)
      }
      if (cookies['AccessToken']) {
        cookieAccessToken = cookies['AccessToken']
        console.log(`[Web OAuth] Found AccessToken cookie: ${cookieAccessToken.substring(0, 20)}...`)
      }
      if (cookies['Idp']) {
        cookieIdp = cookies['Idp']
        console.log(`[Web OAuth] Found Idp cookie: ${cookieIdp}`)
      }
    }

    if (!response.ok) {
      const errorBuffer = await response.arrayBuffer()
      let errorMessage = `HTTP ${response.status}`
      try {
        const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
        if (errorData.message) {
          errorMessage = errorData.message
        }
      } catch {
        // 忽略解析错误
      }
      throw new Error(`ExchangeToken failed: ${errorMessage}`)
    }

    // 解析响应体（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs ExchangeTokenCborResponse
    const cborResponse = decode(Buffer.from(await response.arrayBuffer())) as {
      accessToken?: string
      csrfToken?: string
      expiresIn?: number
      profileArn?: string
    }

    console.log(`[Web OAuth] ExchangeToken Response Body:`, JSON.stringify(cborResponse, null, 2))

    // 合并响应体和 Cookie 数据（与 Rust 实现一致）
    // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs 第 390-397 行
    const accessToken = cborResponse.accessToken || cookieAccessToken
    const csrfToken = cborResponse.csrfToken
    const sessionToken = cookieSessionToken

    if (!accessToken) {
      throw new Error('No access_token in response')
    }
    if (!csrfToken) {
      throw new Error('No csrf_token in response')
    }
    if (!sessionToken) {
      throw new Error('No RefreshToken/SessionToken cookie from ExchangeToken')
    }

    console.log(`[Web OAuth] Token exchange successful, expires in ${cborResponse.expiresIn}s`)

    return {
      accessToken,
      csrfToken,
      expiresIn: cborResponse.expiresIn,
      profileArn: cborResponse.profileArn,
      sessionToken,
      idp: cookieIdp
    }
  }

  // IPC: 启动 Web OAuth 无痕模式登录
  ipcMain.handle('start-web-oauth-login', async (_event, provider: 'Google' | 'Github') => {
    console.log('[IPC] start-web-oauth-login called with provider:', provider)
    console.log(`[Web OAuth] Starting ${provider} Web OAuth login (incognito mode)...`)

    try {
      // 生成 PKCE
      const codeVerifier = await generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const crypto = await import('crypto')
      const oauthState = crypto.randomBytes(32).toString('base64url')

      // 调用 InitiateLogin API 获取登录 URL
      // API 返回 redirectUrl 字段（与 Rust 实现一致）
      const { redirectUrl } = await initiateWebOAuthLogin(provider, codeChallenge, oauthState)
      const loginUrl = redirectUrl

      // 创建无痕模式的 BrowserWindow
      const { session } = await import('electron')
      const partition = `oauth-${Date.now()}`
      const ses = session.fromPartition(partition, { cache: false })

      const authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        title: `${provider} 登录`,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true
        },
        parent: mainWindow || undefined,
        modal: false,
        show: true
      })

      // 保存登录状态
      webOAuthState = {
        codeVerifier,
        codeChallenge,
        oauthState,
        provider,
        authWindow
      }

      // 监听导航拦截回调 URL
      authWindow.webContents.on('will-redirect', (event, url) => {
        console.log(`[Web OAuth] will-redirect: ${url.substring(0, 100)}...`)
        if (url.startsWith(KIRO_WEB_REDIRECT_URI) && url.includes('code=')) {
          event.preventDefault()
          handleWebOAuthCallback(url)
        }
      })

      // 也监听 will-navigate 事件（某些情况下回调可能通过 navigate 而不是 redirect）
      authWindow.webContents.on('will-navigate', (event, url) => {
        console.log(`[Web OAuth] will-navigate: ${url.substring(0, 100)}...`)
        if (url.startsWith(KIRO_WEB_REDIRECT_URI) && url.includes('code=')) {
          event.preventDefault()
          handleWebOAuthCallback(url)
        }
      })

      // 窗口关闭时清理状态
      authWindow.on('closed', () => {
        if (webOAuthState?.authWindow === authWindow) {
          console.log('[Web OAuth] Auth window closed by user')
          // 通知渲染进程登录被取消
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('web-oauth-callback', { error: 'cancelled' })
          }
          webOAuthState = null
        }
      })

      // 加载登录 URL
      authWindow.loadURL(loginUrl)

      return {
        success: true,
        state: oauthState
      }
    } catch (error) {
      console.error('[Web OAuth] Start login error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '启动登录失败'
      }
    }
  })

  // 处理 Web OAuth 回调
  async function handleWebOAuthCallback(callbackUrl: string): Promise<void> {
    console.log('[Web OAuth] ===== handleWebOAuthCallback START =====')
    console.log('[Web OAuth] URL:', callbackUrl)

    if (!webOAuthState) {
      console.error('[Web OAuth] No active login state')
      return
    }

    const { codeVerifier, oauthState, provider, authWindow } = webOAuthState

    try {
      // 解析回调 URL
      const urlObj = new URL(callbackUrl)
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')
      const error = urlObj.searchParams.get('error')

      console.log('[Web OAuth] Extracted code:', code?.substring(0, 20) + '...')
      console.log('[Web OAuth] Extracted state:', state)

      // 关闭认证窗口
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close()
      }

      if (error) {
        console.error(`[Web OAuth] OAuth error: ${error}`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('web-oauth-callback', { error })
        }
        webOAuthState = null
        return
      }

      if (!code || !state) {
        console.error('[Web OAuth] Missing code or state in callback')
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('web-oauth-callback', { error: 'Missing code or state' })
        }
        webOAuthState = null
        return
      }

      // 验证 state
      if (state !== oauthState) {
        console.error('[Web OAuth] State mismatch')
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('web-oauth-callback', { error: 'State mismatch' })
        }
        webOAuthState = null
        return
      }

      // 交换 token（与 Rust 实现一致）
      // 参考: Kiro_New/src-tauri/src/providers/web_oauth.rs complete_login
      console.log('[Web OAuth] Starting token exchange...')
      const tokenResult = await exchangeWebOAuthToken(provider, code, codeVerifier, state)
      console.log('[Web OAuth] Token exchange successful')
      console.log('[Web OAuth] Access token:', tokenResult.accessToken?.substring(0, 20) + '...')

      // 获取用户信息（使用 accessToken 和 idp）
      // 参考: Kiro_New/src-tauri/src/commands/web_oauth_cmd.rs 第 93-99 行
      console.log('[Web OAuth] Getting user info...')
      const userInfo = await getUserInfo(tokenResult.accessToken, provider)
      console.log('[Web OAuth] User info retrieved:', { email: userInfo.email, id: userInfo.userId })

      // 获取使用量信息
      console.log('[Web OAuth] Getting usage info...')
      interface UsageApiResponse {
        userInfo?: { email?: string; userId?: string }
        subscriptionInfo?: {
          type?: string
          subscriptionTitle?: string
          upgradeCapability?: string
          overageCapability?: string
          subscriptionManagementTarget?: string
        }
        usageBreakdownList?: Array<{
          resourceType?: string
          currentUsage?: number
          usageLimit?: number
          displayName?: string
          displayNamePlural?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          freeTrialInfo?: {
            currentUsage?: number
            usageLimit?: number
            freeTrialExpiry?: number
            freeTrialStatus?: string
          }
          bonuses?: Array<{
            bonusCode?: string
            displayName?: string
            currentUsage?: number
            usageLimit?: number
            expiresAt?: number
          }>
        }>
        nextDateReset?: number
        overageConfiguration?: { overageEnabled?: boolean }
      }

      let usageData: UsageApiResponse | undefined
      try {
        usageData = await kiroApiRequest<UsageApiResponse>(
          'GetUserUsageAndLimits',
          { isEmailRequired: true, origin: 'KIRO_IDE' },
          tokenResult.accessToken,
          provider
        )
        console.log('[Web OAuth] Usage info retrieved')
      } catch (e) {
        console.error('[Web OAuth] GetUserUsageAndLimits failed:', e)
      }

      // 解析使用量数据
      const creditUsage = usageData?.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')
      const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'

      // 规范化订阅类型
      let subscriptionType = 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 基础额度
      const baseLimit = creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsage ?? 0

      // 试用额度
      let freeTrialLimit = 0, freeTrialCurrent = 0, freeTrialExpiry: number | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 奖励额度
      const bonuses = (creditUsage?.bonuses || []).map((b) => ({
        code: b.bonusCode || '',
        name: b.displayName || '',
        current: b.currentUsage ?? 0,
        limit: b.usageLimit ?? 0,
        expiresAt: b.expiresAt
      }))

      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
      const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

      console.log('[Web OAuth] Saving account to database...')
      console.log('[Web OAuth] Account data:', { email: usageData?.userInfo?.email || userInfo?.email, provider })

      // 发送成功回调（与 Rust 实现一致）
      // 参考: Kiro_New/src-tauri/src/commands/web_oauth_cmd.rs 第 114-141 行
      // 注意: refreshToken 实际上是 sessionToken (Set-Cookie 中的 RefreshToken)
      // csrfToken 需要保存用于后续的 RefreshToken API 调用
      console.log('[Web OAuth] Sending web-oauth-success event to renderer')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('web-oauth-callback', {
          success: true,
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.sessionToken,  // 使用 sessionToken 作为 refreshToken
          csrfToken: tokenResult.csrfToken,        // 新增: csrfToken 用于刷新
          profileArn: tokenResult.profileArn,      // 新增: profileArn
          expiresIn: tokenResult.expiresIn,
          email: usageData?.userInfo?.email || userInfo?.email,
          userId: usageData?.userInfo?.userId || userInfo?.userId,
          idp: provider,
          authMethod: 'web_oauth',                 // 修改: 使用 web_oauth 而不是 social
          provider,
          subscriptionType,
          subscriptionTitle,
          subscription: {
            managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
            upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
            overageCapability: usageData?.subscriptionInfo?.overageCapability
          },
          usage: {
            current: totalCurrent,
            limit: totalLimit,
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses,
            nextResetDate: usageData?.nextDateReset,
            resourceDetail: creditUsage ? {
              displayName: creditUsage.displayName,
              displayNamePlural: creditUsage.displayNamePlural,
              resourceType: creditUsage.resourceType,
              currency: creditUsage.currency,
              unit: creditUsage.unit,
              overageRate: creditUsage.overageRate,
              overageCap: creditUsage.overageCap,
              overageEnabled: usageData?.overageConfiguration?.overageEnabled
            } : undefined
          },
          daysRemaining: usageData?.nextDateReset && typeof usageData.nextDateReset === 'number'
            ? Math.max(0, Math.ceil((usageData.nextDateReset - Date.now()) / 86400000))
            : undefined
        })
        console.log('[Web OAuth] Account saved successfully')
        mainWindow.focus()
      }

      webOAuthState = null
      console.log('[Web OAuth] Login completed successfully!')
      console.log('[Web OAuth] ===== handleWebOAuthCallback END =====')

    } catch (error) {
      console.error('[Web OAuth] ===== ERROR =====')
      console.error('[Web OAuth] Error message:', error instanceof Error ? error.message : String(error))
      console.error('[Web OAuth] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
      console.error('[Web OAuth] Full error:', error)

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('web-oauth-callback', {
          error: error instanceof Error ? error.message : 'Token 交换失败'
        })
      }
      webOAuthState = null
      console.log('[Web OAuth] ===== handleWebOAuthCallback END =====')
    }
  }

  // IPC: 取消 Web OAuth 登录
  ipcMain.handle('cancel-web-oauth-login', async () => {
    console.log('[Web OAuth] Cancelling Web OAuth login...')
    if (webOAuthState?.authWindow && !webOAuthState.authWindow.isDestroyed()) {
      webOAuthState.authWindow.close()
    }
    webOAuthState = null
    return { success: true }
  })

  // IPC: 设置代理
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    console.log(`[IPC] set-proxy called: enabled=${enabled}, url=${url}`)
    try {
      applyProxySettings(enabled, url)

      // 同时设置 Electron 的 session 代理
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && url) {
          await session.setProxy({ proxyRules: url })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }

      return { success: true }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============ Kiro 设置管理 IPC ============

  // IPC: 获取 Kiro 设置
  ipcMain.handle('get-kiro-settings', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')

      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(
        homeDir,
        'AppData',
        'Roaming',
        'Kiro',
        'User',
        'settings.json'
      )
      const kiroSteeringPath = path.join(homeDir, '.kiro', 'steering')
      const kiroMcpUserPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')

      let settings = {}
      let mcpConfig = { mcpServers: {} }
      let steeringFiles: string[] = []

      // 读取 Kiro settings.json (VS Code 风格 JSON，可能有尾随逗号)
      if (fs.existsSync(kiroSettingsPath)) {
        let parsed: Record<string, unknown> = {}
        try {
          const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
          // 直接解析，Kiro 的 settings.json 是标准 JSON
          parsed = JSON.parse(content)
          console.log('[KiroSettings] Loaded settings successfully')
        } catch (err) {
          console.log('[KiroSettings] Parse error:', err)
        }
        settings = {
          modelSelection: parsed['kiroAgent.modelSelection'],
          agentAutonomy: parsed['kiroAgent.agentAutonomy'],
          enableDebugLogs: parsed['kiroAgent.enableDebugLogs'],
          enableTabAutocomplete: parsed['kiroAgent.enableTabAutocomplete'],
          enableCodebaseIndexing: parsed['kiroAgent.enableCodebaseIndexing'],
          usageSummary: parsed['kiroAgent.usageSummary'],
          codeReferences: parsed['kiroAgent.codeReferences.referenceTracker'],
          configureMCP: parsed['kiroAgent.configureMCP'],
          trustedCommands: parsed['kiroAgent.trustedCommands'] || [],
          commandDenylist: parsed['kiroAgent.commandDenylist'] || [],
          ignoreFiles: parsed['kiroAgent.ignoreFiles'] || [],
          mcpApprovedEnvVars: parsed['kiroAgent.mcpApprovedEnvVars'] || [],
          notificationsActionRequired: parsed['kiroAgent.notifications.agent.actionRequired'],
          notificationsFailure: parsed['kiroAgent.notifications.agent.failure'],
          notificationsSuccess: parsed['kiroAgent.notifications.agent.success'],
          notificationsBilling: parsed['kiroAgent.notifications.billing']
        }
      }

      // 读取用户级 MCP 配置
      if (fs.existsSync(kiroMcpUserPath)) {
        try {
          const mcpContent = fs.readFileSync(kiroMcpUserPath, 'utf-8')
          mcpConfig = JSON.parse(mcpContent)
        } catch {
          console.log('[KiroSettings] Failed to parse user MCP config')
        }
      }

      // 读取工作区 MCP 配置（合并到用户配置）
      const workspaceMcpPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      if (fs.existsSync(workspaceMcpPath)) {
        try {
          const workspaceMcpContent = fs.readFileSync(workspaceMcpPath, 'utf-8')
          const workspaceMcp = JSON.parse(workspaceMcpContent)
          // 工作区配置优先级更高，覆盖用户配置
          mcpConfig.mcpServers = {
            ...mcpConfig.mcpServers,
            ...workspaceMcp.mcpServers
          }
          console.log('[KiroSettings] Loaded workspace MCP config:', workspaceMcpPath)
        } catch {
          console.log('[KiroSettings] Failed to parse workspace MCP config')
        }
      }

      // 读取 Steering 文件列表
      if (fs.existsSync(kiroSteeringPath)) {
        const files = fs.readdirSync(kiroSteeringPath)
        steeringFiles = files.filter((f) => f.endsWith('.md'))
        console.log('[KiroSettings] Steering path:', kiroSteeringPath)
        console.log('[KiroSettings] Found steering files:', steeringFiles)
      } else {
        console.log('[KiroSettings] Steering path does not exist:', kiroSteeringPath)
      }

      return { settings, mcpConfig, steeringFiles }
    } catch (error) {
      console.error('[KiroSettings] Failed to get settings:', error)
      return { error: error instanceof Error ? error.message : 'Failed to get settings' }
    }
  })

  // IPC: 保存 Kiro 设置
  ipcMain.handle('save-kiro-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')

      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(
        homeDir,
        'AppData',
        'Roaming',
        'Kiro',
        'User',
        'settings.json'
      )

      let existingSettings: Record<string, unknown> = {}
      if (fs.existsSync(kiroSettingsPath)) {
        try {
          const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
          existingSettings = JSON.parse(content)
        } catch (parseError) {
          console.warn('[KiroSettings] Failed to parse existing settings:', parseError)
        }
      }

      // 映射设置到 Kiro 的格式
      const kiroSettings = {
        ...existingSettings,
        'kiroAgent.modelSelection': settings.modelSelection,
        'kiroAgent.agentAutonomy': settings.agentAutonomy,
        'kiroAgent.enableDebugLogs': settings.enableDebugLogs,
        'kiroAgent.enableTabAutocomplete': settings.enableTabAutocomplete,
        'kiroAgent.enableCodebaseIndexing': settings.enableCodebaseIndexing,
        'kiroAgent.usageSummary': settings.usageSummary,
        'kiroAgent.codeReferences.referenceTracker': settings.codeReferences,
        'kiroAgent.configureMCP': settings.configureMCP,
        'kiroAgent.trustedCommands': settings.trustedCommands,
        'kiroAgent.commandDenylist': settings.commandDenylist,
        'kiroAgent.ignoreFiles': settings.ignoreFiles,
        'kiroAgent.mcpApprovedEnvVars': settings.mcpApprovedEnvVars,
        'kiroAgent.notifications.agent.actionRequired': settings.notificationsActionRequired,
        'kiroAgent.notifications.agent.failure': settings.notificationsFailure,
        'kiroAgent.notifications.agent.success': settings.notificationsSuccess,
        'kiroAgent.notifications.billing': settings.notificationsBilling
      }

      // 确保目录存在
      const dir = path.dirname(kiroSettingsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      fs.writeFileSync(kiroSettingsPath, JSON.stringify(kiroSettings, null, 4))
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save settings:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save settings'
      }
    }
  })

  // IPC: 打开 Kiro MCP 配置文件
  ipcMain.handle('open-kiro-mcp-config', async (_event, type: 'user' | 'workspace') => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()

      let configPath: string
      if (type === 'user') {
        configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      } else {
        // 工作区配置，打开当前工作区的 .kiro/settings/mcp.json
        configPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      }

      // 如果文件不存在，创建空配置
      const fs = await import('fs')
      if (!fs.existsSync(configPath)) {
        const dir = path.dirname(configPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
      }

      shell.openPath(configPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open MCP config:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open MCP config'
      }
    }
  })

  // IPC: 打开 Kiro Steering 目录
  ipcMain.handle('open-kiro-steering-folder', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')

      // 如果目录不存在，创建它
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }

      shell.openPath(steeringPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering folder:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open steering folder'
      }
    }
  })

  // IPC: 打开 Kiro settings.json 文件
  ipcMain.handle('open-kiro-settings-file', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')

      // 如果文件不存在，创建默认配置
      if (!fs.existsSync(settingsPath)) {
        const dir = path.dirname(settingsPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const defaultSettings = {
          'workbench.colorTheme': 'Kiro Light',
          'kiroAgent.modelSelection': 'claude-haiku-4.5'
        }
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4))
      }

      shell.openPath(settingsPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open settings file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open settings file'
      }
    }
  })

  // IPC: 打开指定的 Steering 文件
  ipcMain.handle('open-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)

      shell.openPath(filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open steering file'
      }
    }
  })

  // IPC: 创建默认的 rules.md 文件
  ipcMain.handle('create-kiro-default-rules', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const rulesPath = path.join(steeringPath, 'rules.md')

      // 确保目录存在
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }

      // 默认规则内容
      const defaultContent = `# Role: 高级软件开发助手
一、系统为Windows10
二、调式文件、测试脚本、test相关文件都放在test文件夹里面，md文件放在docs文件夹里面
# 核心原则


## 1. 沟通与协作
- **诚实优先**：在任何情况下都严禁猜测或伪装。当需求不明确、存在技术风险或遇到知识盲区时，必须停止工作，并立即向用户澄清。
- **技术攻坚**：面对技术难题时，首要目标是寻找并提出高质量的解决方案。只有在所有可行方案均被评估后，才能与用户探讨降级或替换方案。
- **批判性思维**：在执行任务时，如果发现当前需求存在技术限制、潜在风险或有更优的实现路径，必须主动向用户提出你的见解和改进建议。
- **语言要求**：思考和回答时总是使用中文进行回复。


## 2. 架构设计
- **模块化设计**：所有设计都必须遵循功能解耦、职责单一的原则。严格遵守SOLID和DRY原则。
- **前瞻性思维**：在设计时必须考虑未来的可扩展性和可维护性，确保解决方案能够融入项目的整体架构。
- **技术债务优先**：在进行重构或优化时，优先处理对系统稳定性和可维护性影响最大的技术债务和基础架构问题。


## 3. 代码与交付物质量标准
### 编写规范
- **架构视角**：始终从整体项目架构出发编写代码，确保代码片段能够无缝集成，而不是孤立的功能。
- **零技术债务**：严禁创建任何形式的技术债务，包括但不限于：临时文件、硬编码值、职责不清的模块或函数。
- **问题暴露**：禁止添加任何用于掩盖或绕过错误的fallback机制。代码应设计为快速失败（Fail-Fast），确保问题在第一时间被发现。


### 质量要求
- **可读性**：使用清晰、有意义的变量名和函数名。代码逻辑必须清晰易懂，并辅以必要的注释。
- **规范遵循**：严格遵循目标编程语言的社区最佳实践和官方编码规范。
- **健壮性**：必须包含充分的错误处理逻辑和边界条件检查。
- **性能意识**：在保证代码质量和可读性的前提下，对性能敏感部分进行合理优化，避免不必要的计算复杂度和资源消耗。


### 交付物规范
- **无文档**：除非用户明确要求，否则不要创建任何Markdown文档或其他形式的说明文档。
- **无测试**：除非用户明确要求，否则不要编写单元测试或集成测试代码。
- **无编译/运行**：禁止编译或执行任何代码。你的任务是生成高质量的代码和设计方案。


# 注意事项
- 除非特别说明否则不要创建新的文档、不要测试、不要编译、不要运行、不需要总结，除非用户主动要求


- 需求不明确时使向用户询问澄清，提供预定义选项
- 在有多个方案的时候，需要向用户询问，而不是自作主张
- 在有方案/策略需要更新时，需要向用户询问，而不是自作主张


- ACE为augmentContextEngine工具的缩写
- 如果要求查看文档请使用 Context7 MCP
- 如果需要进行WEB前端页面测试请使用 Playwright MCP
- 如果用户回复'继续' 则请按照最佳实践继续完成任务
`

      fs.writeFileSync(rulesPath, defaultContent, 'utf-8')
      console.log('[KiroSettings] Created default rules.md at:', rulesPath)

      // 打开文件
      shell.openPath(rulesPath)

      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to create default rules:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create default rules'
      }
    }
  })

  // IPC: 读取 Steering 文件内容
  ipcMain.handle('read-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      console.error('[KiroSettings] Failed to read steering file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read file'
      }
    }
  })

  // IPC: 保存 Steering 文件内容
  ipcMain.handle('save-kiro-steering-file', async (_event, filename: string, content: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const filePath = path.join(steeringPath, filename)

      // 确保目录存在
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }

      fs.writeFileSync(filePath, content, 'utf-8')
      console.log('[KiroSettings] Saved steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save steering file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save file'
      }
    }
  })

  // ============ MCP 服务器管理 IPC ============

  // IPC: 保存 MCP 服务器配置
  ipcMain.handle(
    'save-mcp-server',
    async (
      _event,
      name: string,
      config: { command: string; args?: string[]; env?: Record<string, string> },
      oldName?: string
    ) => {
      try {
        const os = await import('os')
        const fs = await import('fs')
        const path = await import('path')
        const homeDir = os.homedir()
        const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')

        // 读取现有配置
        let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
        if (fs.existsSync(mcpPath)) {
          const content = fs.readFileSync(mcpPath, 'utf-8')
          mcpConfig = JSON.parse(content)
        }

        // 如果是重命名，先删除旧的
        if (oldName && oldName !== name) {
          delete mcpConfig.mcpServers[oldName]
        }

        // 添加/更新服务器
        mcpConfig.mcpServers[name] = config

        // 确保目录存在
        const dir = path.dirname(mcpPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
        console.log('[KiroSettings] Saved MCP server:', name)
        return { success: true }
      } catch (error) {
        console.error('[KiroSettings] Failed to save MCP server:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save MCP server'
        }
      }
    }
  )

  // IPC: 删除 MCP 服务器
  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')

      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: '配置文件不存在' }
      }

      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)

      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: '服务器不存在' }
      }

      delete mcpConfig.mcpServers[name]
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Deleted MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete MCP server:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server'
      }
    }
  })

  // IPC: 删除 Steering 文件
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete file'
      }
    }
  })

  // ============ 机器码管理 IPC ============

  // IPC: 获取操作系统类型
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: 获取当前机器码
  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: 设置新机器码
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)

    if (!result.success && result.requiresAdmin) {
      // 弹窗询问用户是否以管理员权限重启
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }

    return result
  })

  // IPC: 生成随机机器码
  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: 检查管理员权限
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: 请求管理员权限重启
  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: 备份机器码到文件
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '备份机器码',
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) {
      return false
    }

    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: 从文件恢复机器码
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '恢复机器码',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: '用户取消' }
    }

    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // ============ 本地设置存储 (客户端独立配置) ============
  // 这些设置存储在本地，不同步到服务器，每个客户端独立维护

  const localSettingsPath = join(app.getPath('userData'), 'local-settings.cbor')

  // IPC: 加载本地设置
  ipcMain.handle('load-local-settings', async () => {
    try {
      const data = await readFile(localSettingsPath)
      const settings = decode(data)
      console.log('[LocalSettings] Loaded local settings')
      return settings
    } catch (error) {
      // 文件不存在时返回空对象
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[LocalSettings] No local settings file, returning defaults')
        return {}
      }
      console.error('[LocalSettings] Failed to load:', error)
      return {}
    }
  })

  // IPC: 保存本地设置
  ipcMain.handle('save-local-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      await writeFile(localSettingsPath, Buffer.from(encode(settings)))
      console.log('[LocalSettings] Saved local settings')
      return { success: true }
    } catch (error) {
      console.error('[LocalSettings] Failed to save:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新协议处理函数以支持 Social Auth 回调
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 重新定义协议处理
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)

      // 处理 Social Auth 回调 (kiro://kiro.kiroAgent/authenticate-success)
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // 调用原始处理函数处理其他协议
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Windows/Linux: 处理第二个实例和协议 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 协议 URL 会作为命令行参数传入
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 聚焦主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 处理协议 URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// 托盘模式：窗口关闭不退出应用
app.on('window-all-closed', () => {
  // 不退出，保持托盘运行
})

// 应用退出前清理
app.on('will-quit', () => {
  unregisterProtocol()
  if (tray) {
    tray.destroy()
    tray = null
  }
})

// 防止崩溃：捕获未处理的异常
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
