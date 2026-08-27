import type { MessageApi } from 'naive-ui'

/**
 * 包装异步操作，自动处理错误并显示 toast 提示
 */
export async function withErrorToast<T>(
  fn: () => Promise<T>,
  message: MessageApi,
  fallbackMsg = '操作失败',
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    message.error(msg || fallbackMsg)
    return undefined
  }
}

/**
 * 创建一个带 loading ref 的异步操作包装器
 */
export function createAsyncHandler(message: MessageApi) {
  return async function handle<T>(
    fn: () => Promise<T>,
    options: {
      fallbackMsg?: string
      successMsg?: string
    } = {},
  ): Promise<T | undefined> {
    try {
      const result = await fn()
      if (options.successMsg) {
        message.success(options.successMsg)
      }
      return result
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      message.error(msg || options.fallbackMsg || '操作失败')
      return undefined
    }
  }
}
