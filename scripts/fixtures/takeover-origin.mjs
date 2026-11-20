import { createServer } from 'node:http'
export function createTakeoverOrigin() {
  const requests = new Map()
  const unicodeFilenames = new Map([
    ['early-default', 'résumé 日本語 😀.zip'],
    ['early-direct', '中文 extended.zip'],
    ['early-confirm-accept', 'aaa123中文.zip'],
  ])
  const transfers = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const name = url.pathname.split('/').at(-1)
    if (url.pathname.startsWith('/start/')) {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      if (url.searchParams.has('click')) {
        response.end(`<a href="/download/${name}">Download</a>`)
        return
      }
      response.end(`<script>location.href='/download/${name}'</script>`)
      return
    }
    if (!url.pathname.startsWith('/download/')) {
      response.writeHead(404).end()
      return
    }
    const list = requests.get(name) ?? []
    list.push({
      method: request.method,
      range: request.headers.range ?? null,
      ...(name?.startsWith('paired-')
        ? { fromEngine: request.headers['x-motrix-fixture'] === 'paired' }
        : {}),
    })
    requests.set(name, list)
    if (
      ['confirm', 'early-protected', 'early-protected-direct'].includes(name) &&
      list.length > 1
    ) {
      response.writeHead(410).end()
      return
    }
    const size =
      name === 'confirm' ||
      name?.startsWith('early-protected') ||
      name?.startsWith('early-confirm-') ||
      name?.startsWith('paired-')
        ? 1024 * 1024
        : ['small', 'early-small'].includes(name)
          ? 2 * 1024 * 1024
          : 8 * 1024 * 1024
    // The browser's original response works, while HEAD fails and ranged GET
    // is forbidden. Size discovery must come from Firefox's live metadata.
    if (request.method === 'HEAD') {
      if (name === 'probe-only') {
        response
          .writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': size,
          })
          .end()
        return
      }
      request.socket.destroy()
      return
    }
    const resume =
      (name?.startsWith('early-confirm-') || name?.startsWith('paired-')) &&
      /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    const offset = resume ? Number(resume[1]) : 0
    if (request.headers.range && (!resume || offset >= size)) {
      response.writeHead(403).end()
      return
    }
    response.writeHead(resume ? 206 : 200, {
      ...(name?.startsWith('early-confirm-') || name?.startsWith('paired-')
        ? { 'Accept-Ranges': 'bytes', ETag: '"fixture-file"' }
        : {}),
      ...(resume
        ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` }
        : {}),
      ...(name === 'early-no-type'
        ? {}
        : {
            'Content-Type':
              name === 'early-pdf' ? 'application/pdf' : 'application/zip',
          }),
      // Model raw UTF-8 in a legacy filename, the suspected input in #2388.
      // Node serializes HTTP header strings as Latin-1 bytes.
      'Content-Disposition':
        name === 'early-direct'
          ? `attachment; filename=backup.zip; filename*=UTF-8'zh'${encodeURIComponent(unicodeFilenames.get(name))}`
          : `${name === 'early-pdf' ? 'inline' : 'attachment'}; filename="${Buffer.from(unicodeFilenames.get(name) ?? `${name}.zip`).toString('latin1')}"`,
      ...(!name.startsWith('unknown-') && name !== 'probe-only'
        ? { 'Content-Length': size - offset }
        : {}),
    })
    // Flush via a buffer write to preserve header bytes. flushHeaders() can
    // UTF-8-encode the Latin-1 byte string again, creating artificial mojibake.
    response.write(Buffer.alloc(0))
    let sent = offset
    const timer = setInterval(() => {
      const count = Math.min(64 * 1024, size - sent)
      response.write(Buffer.alloc(count))
      sent += count
      if (sent >= size) response.end()
    }, 100)
    transfers.add(timer)
    response.on('close', () => {
      clearInterval(timer)
      transfers.delete(timer)
    })
  })
  return { requests, unicodeFilenames, transfers, server }
}
