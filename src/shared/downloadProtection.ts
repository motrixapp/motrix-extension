import { z } from 'zod'
export const listSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    rules: z
      .array(
        z
          .object({
            host: z
              .string()
              .max(253)
              .regex(/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/),
            matchOn: z.enum(['source', 'resource']),
            includeSubdomains: z.boolean().optional(),
            pathPrefix: z.string().regex(/^\//).max(512).optional(),
          })
          .strict()
      )
      .max(2048),
  })
  .strict()
type List = z.infer<typeof listSchema>
export function isProtectedDownload(
  list: List,
  role: 'source' | 'resource',
  address?: string
) {
  if (!address) return false
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  const hostname = url.hostname.replace(/\.$/, '')
  return list.rules.some((rule) => {
    if (rule.matchOn !== role) return false
    if (
      hostname !== rule.host &&
      !(rule.includeSubdomains && hostname.endsWith(`.${rule.host}`))
    )
      return false
    const prefix = rule.pathPrefix?.replace(/\/$/, '')
    return (
      !prefix ||
      url.pathname === prefix ||
      url.pathname.startsWith(`${prefix}/`)
    )
  })
}
