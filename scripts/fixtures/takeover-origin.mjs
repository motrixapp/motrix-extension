import { createServer } from 'node:http'

export const preservedDownloadRequestCounts = {
  'early-document-direct': 3,
  'early-document-confirm': 3,
  'early-native-signed': 1,
  'early-native-cookie-redirect': 2,
  'early-native-blob': 1,
}

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
    const documentReload = name?.startsWith('early-document-')
    const cookieRedirect = name === 'early-native-cookie-redirect'
    const publicRedirect = name === 'early-public-redirect'
    const signed = name === 'early-native-signed'
    const file =
      (documentReload || cookieRedirect || publicRedirect) &&
      url.pathname.startsWith('/file/')
    if (url.pathname.startsWith('/start/')) {
      const href = `/download/${name}${signed ? '?download_token=fixture' : ''}`
      response.writeHead(200, {
        'Content-Type': 'text/html',
        ...(cookieRedirect
          ? { 'Set-Cookie': `fixture=1; Path=/file/${name}` }
          : {}),
      })
      if (name === 'early-native-blob') {
        response.end(`<a href="${href}">Download</a><script>
          async function save() {
            const response = await fetch("${href}")
            const link = document.createElement('a')
            link.href = URL.createObjectURL(await response.blob())
            link.download = '${name}.zip'
            link.click()
          }
          ${
            url.searchParams.has('click')
              ? "document.querySelector('a').onclick = (event) => { event.preventDefault(); void save() }"
              : 'void save()'
          }
          </script>`)
        return
      }
      if (url.searchParams.has('click')) {
        response.end(`<a href="${href}">Download</a>`)
        return
      }
      response.end(`<script>location.href='${href}'</script>`)
      return
    }
    if (!url.pathname.startsWith('/download/') && !file) {
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
    if (publicRedirect && !file) {
      response
        .writeHead(302, { Location: `/file/${name}?signature=fixture` })
        .end()
      return
    }
    if (cookieRedirect && !file) {
      response.writeHead(302, { Location: `/file/${name}` }).end()
      return
    }
    if (cookieRedirect && !request.headers.cookie?.includes('fixture=1')) {
      response.writeHead(403).end()
      return
    }
    if (documentReload && !file) {
      // The first GET renders a document. Its script changes the browser
      // state and reloads the same URL, which now redirects to the attachment.
      const cookie = `${name}=1`
      if (request.headers.cookie?.split('; ').includes(cookie)) {
        response.writeHead(302, { Location: `/file/${name}` }).end()
      } else {
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
        })
        response.end(
          `<script>document.cookie = "${cookie}; path=/download/${name}"; location.reload()</script>`
        )
      }
      return
    }
    if (
      (signed ||
        ['confirm', 'early-protected', 'early-protected-direct'].includes(
          name
        )) &&
      list.length > 1
    ) {
      response.writeHead(410).end()
      return
    }
    const size =
      name === 'confirm' ||
      Object.hasOwn(preservedDownloadRequestCounts, name) ||
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
