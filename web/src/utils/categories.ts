import type { CategoriesDto } from '../api'

export const TAG_TYPES = ['success', 'info', 'warning', 'error', 'default'] as const

export function getEffectiveCategories(categories: CategoriesDto): string[] {
  if (!categories) return []
  return categories.effective?.length ? categories.effective : categories.folder
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

export function formatFolderDisplay(folder: string, libraryRoot: string): string {
  const raw = folder.trim()
  if (!raw) return '未选择目录'
  if (isAbsolutePath(raw)) return raw
  return libraryRoot ? `${libraryRoot.replace(/[\\/]+$/, '')}/${raw}` : raw
}

export function resolveFolderForBrowse(folder: string, libraryRoot: string): string {
  const raw = folder.trim()
  if (!raw) return ''
  if (isAbsolutePath(raw)) return raw
  return libraryRoot ? `${libraryRoot.replace(/[\\/]+$/, '')}/${raw}` : raw
}
