/**
 * 工作时段检查工具
 * 用于控制 Token 刷新和 API 请求的工作时段
 * 支持工作日判断（调用外部API）
 */

// 默认工作时段：7:00 - 24:00（北京时间）
const DEFAULT_START_HOUR = 7
const DEFAULT_END_HOUR = 24

// 工作日API配置
const WORKDAY_API_URL = 'https://date.appworlds.cn/work'
const WORKDAY_API_TIMEOUT = 5000 // 5秒超时

// 工作日缓存
let workdayCache = {
  isWorkday: true,  // 默认为工作日（保守策略）
  date: '',
  lastFetchTime: 0,
  fetchError: null
}

// 定时刷新器
let workdayRefreshTimer = null

/**
 * 获取当前北京日期字符串
 * @returns {string} 格式：YYYY-MM-DD
 */
function getBeijingDateString() {
  const now = new Date()
  const beijingOffset = 8 * 60 * 60 * 1000
  const beijingTime = new Date(now.getTime() + beijingOffset)
  const year = beijingTime.getUTCFullYear()
  const month = (beijingTime.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = beijingTime.getUTCDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 从API获取工作日状态
 * @returns {Promise<{isWorkday: boolean, date: string, error: string|null}>}
 */
async function fetchWorkdayFromApi() {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), WORKDAY_API_TIMEOUT)

    const response = await fetch(WORKDAY_API_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()

    if (data.code === 200 && data.data && typeof data.data.work === 'boolean') {
      return {
        isWorkday: data.data.work,
        date: data.data.date || getBeijingDateString(),
        error: null
      }
    } else {
      throw new Error('Invalid response format')
    }
  } catch (error) {
    const errorMsg = error.name === 'AbortError' ? 'Request timeout' : error.message
    console.warn(`[WorkingHours] Failed to fetch workday status: ${errorMsg}`)
    return {
      isWorkday: true,  // 默认为工作日
      date: getBeijingDateString(),
      error: errorMsg
    }
  }
}

/**
 * 刷新工作日缓存
 * @returns {Promise<void>}
 */
async function refreshWorkdayCache() {
  const currentDate = getBeijingDateString()

  // 如果日期变化，强制刷新
  const dateChanged = workdayCache.date !== currentDate

  console.log(`[WorkingHours] Refreshing workday cache... (date: ${currentDate}, dateChanged: ${dateChanged})`)

  const result = await fetchWorkdayFromApi()

  // 如果API请求失败且有缓存且日期相同，保留缓存
  if (result.error && workdayCache.date === currentDate && workdayCache.lastFetchTime > 0) {
    console.log(`[WorkingHours] API failed, keeping cached status: isWorkday=${workdayCache.isWorkday}`)
    workdayCache.fetchError = result.error
    workdayCache.lastFetchTime = Date.now()
    return
  }

  workdayCache = {
    isWorkday: result.isWorkday,
    date: result.date,
    lastFetchTime: Date.now(),
    fetchError: result.error
  }

  console.log(`[WorkingHours] Workday cache updated: date=${result.date}, isWorkday=${result.isWorkday}, error=${result.error}`)
}

/**
 * 启动工作日缓存定时刷新
 * 每小时整点后10分钟刷新一次
 */
function startWorkdayRefreshTimer() {
  if (workdayRefreshTimer) {
    clearInterval(workdayRefreshTimer)
  }

  // 计算到下一个整点后10分钟的延迟
  const now = new Date()
  const minutes = now.getMinutes()
  const seconds = now.getSeconds()
  const milliseconds = now.getMilliseconds()

  let delayToNext10
  if (minutes < 10) {
    // 当前分钟小于10，等到本小时的10分
    delayToNext10 = ((10 - minutes) * 60 - seconds) * 1000 - milliseconds
  } else {
    // 当前分钟>=10，等到下一小时的10分
    delayToNext10 = ((70 - minutes) * 60 - seconds) * 1000 - milliseconds
  }

  console.log(`[WorkingHours] Next workday refresh in ${Math.round(delayToNext10 / 1000)}s`)

  // 先等待到下一个整点后10分钟
  setTimeout(() => {
    refreshWorkdayCache().catch(console.error)

    // 然后每小时刷新一次
    workdayRefreshTimer = setInterval(() => {
      refreshWorkdayCache().catch(console.error)
    }, 60 * 60 * 1000) // 1小时
  }, delayToNext10)
}

/**
 * 初始化工作日缓存（服务启动时调用）
 */
async function initWorkdayCache() {
  console.log('[WorkingHours] Initializing workday cache...')
  await refreshWorkdayCache()
  startWorkdayRefreshTimer()
}

/**
 * 解析工作时段配置
 * @param {string} workingHours - 工作时段配置，格式：起始小时-结束小时（如 "7-24"）
 * @returns {{ startHour: number, endHour: number }} 解析后的工作时段
 */
function parseWorkingHours(workingHours) {
  if (!workingHours || typeof workingHours !== 'string') {
    return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR }
  }

  const match = workingHours.trim().match(/^(\d{1,2})-(\d{1,2})$/)
  if (!match) {
    console.warn(`[WorkingHours] Invalid format: "${workingHours}", using default 7-24`)
    return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR }
  }

  const startHour = parseInt(match[1], 10)
  const endHour = parseInt(match[2], 10)

  // 验证小时范围
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour >= endHour) {
    console.warn(`[WorkingHours] Invalid hours: ${startHour}-${endHour}, using default 7-24`)
    return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR }
  }

  return { startHour, endHour }
}

/**
 * 获取当前北京时间的小时数
 * @returns {number} 当前北京时间的小时（0-23）
 */
function getBeijingHour() {
  const now = new Date()
  const beijingOffset = 8 * 60 // 分钟
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const beijingMinutes = utcMinutes + beijingOffset
  const beijingHour = Math.floor((beijingMinutes % (24 * 60)) / 60)
  return beijingHour
}

/**
 * 获取当前北京时间的格式化字符串
 * @returns {string} 格式化的北京时间（如 "14:30"）
 */
function getBeijingTimeString() {
  const now = new Date()
  const beijingOffset = 8 * 60 * 60 * 1000
  const beijingTime = new Date(now.getTime() + beijingOffset)
  const hours = beijingTime.getUTCHours().toString().padStart(2, '0')
  const minutes = beijingTime.getUTCMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * 检查今天是否工作日
 * @returns {{ isWorkday: boolean, date: string, lastFetchTime: number, fetchError: string|null }}
 */
function checkWorkday() {
  const currentDate = getBeijingDateString()

  // 如果日期变化，触发异步刷新
  if (workdayCache.date !== currentDate) {
    refreshWorkdayCache().catch(console.error)
  }

  return { ...workdayCache }
}

/**
 * 检查当前是否在工作时段内
 * @param {string} [workingHoursConfig] - 工作时段配置，默认从环境变量读取
 * @returns {{ isWorking: boolean, currentHour: number, startHour: number, endHour: number, beijingTime: string, message: string }}
 */
function checkWorkingHours(workingHoursConfig) {
  const config = workingHoursConfig || process.env.WORKING_HOURS || '7-24'
  const { startHour, endHour } = parseWorkingHours(config)
  const currentHour = getBeijingHour()
  const isWorking = currentHour >= startHour && currentHour < endHour
  const beijingTime = getBeijingTimeString()

  const message = isWorking
    ? `当前北京时间 ${beijingTime}，在工作时段 ${startHour}:00-${endHour}:00 内`
    : `当前北京时间 ${beijingTime}，不在工作时段 ${startHour}:00-${endHour}:00 内，服务暂停`

  return {
    isWorking,
    currentHour,
    startHour,
    endHour,
    beijingTime,
    message
  }
}

/**
 * 获取完整的工作状态信息
 * @returns {object} 包含工作日、工作时段、当前时间等完整信息
 */
function getWorkingStatus() {
  const workdayInfo = checkWorkday()
  const hoursInfo = checkWorkingHours()
  const skipOnHoliday = process.env.SKIP_REFRESH_ON_HOLIDAY === 'true'

  // 判断是否应该工作
  const shouldWork = workdayInfo.isWorkday || !skipOnHoliday
  const isInWorkingHours = hoursInfo.isWorking
  const isServiceAvailable = shouldWork && isInWorkingHours

  return {
    // 工作日信息
    date: workdayInfo.date || getBeijingDateString(),
    isWorkday: workdayInfo.isWorkday,
    workdayLastFetch: workdayInfo.lastFetchTime,
    workdayFetchError: workdayInfo.fetchError,

    // 工作时段信息
    beijingTime: hoursInfo.beijingTime,
    currentHour: hoursInfo.currentHour,
    startHour: hoursInfo.startHour,
    endHour: hoursInfo.endHour,
    isInWorkingHours,

    // 配置信息
    skipOnHoliday,

    // 综合状态
    isServiceAvailable,
    message: isServiceAvailable
      ? `服务正常：${workdayInfo.isWorkday ? '工作日' : '非工作日'}，当前北京时间 ${hoursInfo.beijingTime}`
      : !shouldWork
        ? `服务暂停：今天是非工作日（${workdayInfo.date}）`
        : `服务暂停：当前北京时间 ${hoursInfo.beijingTime}，不在工作时段 ${hoursInfo.startHour}:00-${hoursInfo.endHour}:00 内`
  }
}

/**
 * 构建非工作时段/非工作日的错误响应
 * @param {string} format - 响应格式：'openai' | 'claude'
 * @returns {object} 错误响应对象
 */
function buildNonWorkingHoursError(format = 'openai') {
  const status = getWorkingStatus()
  const message = status.message

  if (format === 'claude') {
    return {
      status: 503,
      body: {
        type: 'error',
        error: {
          type: 'service_unavailable',
          message
        }
      }
    }
  }

  // OpenAI 格式
  return {
    status: 503,
    body: {
      error: {
        message,
        type: 'service_unavailable',
        code: status.isWorkday ? 'non_working_hours' : 'non_working_day'
      }
    }
  }
}

export {
  parseWorkingHours,
  getBeijingHour,
  getBeijingTimeString,
  getBeijingDateString,
  checkWorkingHours,
  checkWorkday,
  getWorkingStatus,
  refreshWorkdayCache,
  initWorkdayCache,
  buildNonWorkingHoursError,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR
}

