export type NotifySeverity = 'confirm' | 'error' | 'reminder'

export interface NotificationsConfig {
  master: boolean
  confirm: boolean
  error: boolean
  reminder: boolean
}

export const NOTIFICATIONS_DEFAULT: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

export function isSeverityEnabled(
  cfg: NotificationsConfig,
  severity: NotifySeverity
): boolean {
  return cfg.master && cfg[severity]
}

export interface NotifyInput {
  title: string
  message: string
  severity: NotifySeverity
}

export type Notify = (n: NotifyInput) => void
