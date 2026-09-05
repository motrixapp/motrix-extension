import { z } from 'zod'
import { parseRemoteEndpoint } from '@/shared/endpoint'
import { SUPPORTED_LOCALES } from '@/shared/supportedLocales'

export const takeoverFormSchema = z.object({
  enabled: z.boolean(),
  thresholdMB: z.string().refine((s) => s.trim() === '' || Number(s) >= 0, {
    message: 'options.takeover.thresholdInvalid',
  }),
  denylist: z.string(),
})
export type TakeoverFormValues = z.infer<typeof takeoverFormSchema>

export const generalFormSchema = takeoverFormSchema.extend({
  notifyMaster: z.boolean(),
  notifyConfirm: z.boolean(),
  notifyError: z.boolean(),
  notifyReminder: z.boolean(),
})
export type GeneralFormValues = z.infer<typeof generalFormSchema>

export const appearanceFormSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  language: z.enum(['system', ...SUPPORTED_LOCALES]),
})
export type AppearanceFormValues = z.infer<typeof appearanceFormSchema>

export const serverFormSchema = z.object({
  name: z.string().trim().min(1, {
    message: 'options.servers.nameRequired',
  }),
  url: z
    .string()
    .min(1, {
      message: 'options.servers.urlRequired',
    })
    .refine(
      (value) => {
        try {
          parseRemoteEndpoint(value)
          return true
        } catch {
          return false
        }
      },
      { message: 'options.servers.urlInvalid' }
    ),
})
export type ServerFormValues = z.infer<typeof serverFormSchema>

export const helpFormSchema = z.object({
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
})
export type HelpFormValues = z.infer<typeof helpFormSchema>
