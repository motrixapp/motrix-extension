import { describe, expect, it } from 'vitest'
import { contentDispositionFilename } from '@/background/capture/contentDisposition'

function parse(value: string, byteString = false) {
  return contentDispositionFilename(
    [{ name: 'Content-Disposition', value }],
    byteString
  )
}

describe('Content-Disposition filenames', () => {
  it.each([
    ['attachment; filename=report.zip', 'report.zip'],
    ['attachment; FILENAME = "report; final.zip"', 'report; final.zip'],
    ['attachment; filename="report\\"final.zip"', 'report"final.zip'],
    ['attachment; x-filename=wrong.zip; filename=right.zip', 'right.zip'],
    [
      'attachment; note="; filename=wrong.zip"; filename=right.zip',
      'right.zip',
    ],
    [
      "attachment; filename=backup.zip; filename*=UTF-8'zh'%E4%B8%AD%E6%96%87.zip",
      '中文.zip',
    ],
    [
      "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip; filename=backup.zip",
      '中文.zip',
    ],
    ["attachment; filename*=ISO-8859-1'en'r%E9sum%E9.zip", 'résumé.zip'],
    ["attachment; filename*=UTF-8''100%25%20ready.zip", '100% ready.zip'],
    ['attachment; filename="100%20ready.zip"', '100%20ready.zip'],
    ['attachment; filename="中文.zip"', '中文.zip'],
    ['attachment; filename="Ã©.zip"', 'Ã©.zip'],
    ['attachment; filename="  spaced.zip  "', '  spaced.zip  '],
  ])('parses %s', (header, expected) => {
    expect(parse(header)).toBe(expected)
  })

  it.each(['aaa123中文.zip', '日本語.zip', '한글.zip', '😀 résumé.zip'])(
    'decodes Firefox UTF-8 header bytes for %s',
    (filename) => {
      const bytes = Buffer.from(filename, 'utf8').toString('latin1')
      expect(parse(`attachment; filename="${bytes}"`, true)).toBe(filename)
    }
  )

  it.each(['résumé.zip', '中文.zip', '😀.zip'])(
    'preserves legacy or already decoded names: %s',
    (filename) => {
      expect(parse(`attachment; filename="${filename}"`, true)).toBe(filename)
    }
  )

  it('does not decode an extended Unicode filename twice', () => {
    expect(parse("attachment; filename*=UTF-8''%C3%83%C2%A9.zip", true)).toBe(
      'Ã©.zip'
    )
  })

  it.each([
    "UTF-8''bad%ZZ.zip",
    "UTF-8''bad%E4%B8.zip",
    "ISO-8859-1''bad%ZZ.zip",
    "unknown''file.zip",
    "US-ASCII''%C3%A9.zip",
    "UTF-8''",
    'missing-charset.zip',
  ])('uses the plain fallback for invalid filename*=%s', (extended) => {
    expect(
      parse(`attachment; filename=fallback.zip; filename*=${extended}`)
    ).toBe('fallback.zip')
    expect(parse(`attachment; filename*=${extended}`)).toBeUndefined()
  })

  it.each([
    '',
    'attachment',
    'attachment; filename=""',
    'attachment; filename="unterminated.zip',
    'attachment; x-filename=wrong.zip',
    'attachment; note="; filename=wrong.zip"',
    'attachment; filename=bad.zip\r\nInjected: value',
  ])('does not invent a filename from %s', (header) => {
    expect(parse(header)).toBeUndefined()
  })

  it('decodes binaryValue without discarding header bytes', () => {
    expect(
      contentDispositionFilename([
        {
          name: 'content-disposition',
          binaryValue: Array.from(
            Buffer.from('attachment; filename="中文.zip"')
          ),
        },
      ])
    ).toBe('中文.zip')
  })

  it('preserves non-UTF-8 binary filenames', () => {
    expect(
      contentDispositionFilename([
        {
          name: 'Content-Disposition',
          binaryValue: Array.from(
            Buffer.from('attachment; filename="café.zip"', 'latin1')
          ),
        },
      ])
    ).toBe('café.zip')
  })

  it('accepts binaryValue as an ArrayBuffer', () => {
    expect(
      contentDispositionFilename([
        {
          name: 'Content-Disposition',
          binaryValue: new TextEncoder().encode(
            'attachment; filename="中文.zip"'
          ).buffer,
        },
      ])
    ).toBe('中文.zip')
  })

  it.each([-1, 256, 1.5, Number.NaN])(
    'rejects invalid header bytes: %s',
    (byte) => {
      expect(
        contentDispositionFilename([
          {
            name: 'content-disposition',
            binaryValue: [byte],
          },
        ])
      ).toBeUndefined()
    }
  )
})
