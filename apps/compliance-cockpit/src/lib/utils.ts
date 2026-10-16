import { fmtWhen } from './time'
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Cross-environment date format. We avoid `dateStyle`/`timeStyle`
 * shortcuts because Node's ICU and the browser's ICU disagree on the
 * exact separator (Node: "Jun 23, 2026, 12:29 PM"; Chrome: "Jun 23,
 * 2026 at 12:29 PM"). Same Date → different string → React hydration
 * error on SSR. Explicit fields produce the same output everywhere.
 */
export function formatDate(date: string | Date) {
  return fmtWhen(date)
}

export function getRiskLevelColor(level: string) {
  switch (level) {
    case 'LOW':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    case 'MEDIUM':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    case 'HIGH':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
    case 'CRITICAL':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
  }
}

export function getStatusColor(status: string) {
  switch (status) {
    case 'APPROVED':
    case 'AUTO_APPROVED':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    case 'PENDING_APPROVAL':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    case 'REJECTED':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
  }
}