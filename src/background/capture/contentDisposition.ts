export interface ResponseHeader {
  name: string
  value?: string | undefined
  binaryValue?: number[] | ArrayBuffer | undefined
}

/** Decode only header bytes, never browser/user-provided Unicode filenames. */
function decodeLegacyFilename(value: string, byteString: boolean): string {
  if (!byteString || Array.from(value).some((c) => c.charCodeAt(0) > 255))
    return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(value, (c) => c.charCodeAt(0))
    )
  } catch {
    // A genuine legacy single-byte name must survive an invalid UTF-8 decode.
    return value
  }
}

function decodeExtendedFilename(value: string): string | undefined {
  const match = /^([^']+)'[^']*'(.*)$/.exec(value)
  if (!match) return undefined
  const charset = match[1]?.toLowerCase()
  const encoded = match[2] ?? ''
  if (/[^\x20-\x7e]|%(?![\da-f]{2})/i.test(encoded)) return undefined
  try {
    if (charset === 'utf-8' || charset === 'us-ascii') {
      const decoded = decodeURIComponent(encoded)
      if (
        charset === 'us-ascii' &&
        Array.from(decoded).some((c) => c.charCodeAt(0) > 127)
      )
        return undefined
      return decoded || undefined
    }
    if (charset === 'iso-8859-1') {
      return (
        encoded.replace(/%([\da-f]{2})/gi, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        ) || undefined
      )
    }
  } catch {
    // Malformed extended values may still have a usable legacy fallback.
  }
  return undefined
}

function parameters(value: string): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
    else if (char === ';' && !quoted) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts.slice(1)
}

/** Firefox exposes HTTP values as ByteString; Chromium exposes Unicode or
 * binaryValue. Interpret those representations before choosing a filename. */
export function contentDispositionFilename(
  headers: readonly ResponseHeader[] | undefined,
  byteStringValues = false
): string | undefined {
  const header = headers?.find(
    ({ name }) => name.toLowerCase() === 'content-disposition'
  )
  if (!header) return undefined
  let value = header.value
  if (value === undefined && header.binaryValue) {
    const bytes = Array.isArray(header.binaryValue)
      ? header.binaryValue
      : Array.from(new Uint8Array(header.binaryValue))
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      return undefined
    value = bytes.map((byte) => String.fromCharCode(byte)).join('')
    byteStringValues = true
  }
  if (!value || /[\r\n]/.test(value)) return undefined
  let basic: string | undefined
  for (const parameter of parameters(value)) {
    const separator = parameter.indexOf('=')
    if (separator < 0) continue
    const name = parameter.slice(0, separator).trim().toLowerCase()
    if (name !== 'filename' && name !== 'filename*') continue
    let raw = parameter.slice(separator + 1).trim()
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) continue
      raw = raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
    if (name === 'filename*') {
      const extended = decodeExtendedFilename(raw)
      if (extended) return extended
    } else if (!basic && raw) {
      basic = decodeLegacyFilename(raw, byteStringValues)
    }
  }
  return basic
}
