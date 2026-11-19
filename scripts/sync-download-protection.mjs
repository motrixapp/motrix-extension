// Refresh the offline snapshot from a reviewed website checkout or published feed.
import { readFile, writeFile } from 'node:fs/promises'
import { listSchema } from '../src/shared/downloadProtection.ts'

const path = process.argv[2]
async function publishedList() {
  const response = await fetch(
    'https://motrix.app/rules/download-protection/v1.json',
    { redirect: 'error', signal: AbortSignal.timeout(5000) }
  )
  if (!response.ok)
    throw new Error(`Protection feed returned ${response.status}`)
  return response.json()
}
const raw = path
  ? JSON.parse(await readFile(path, 'utf8'))
  : await publishedList()
const snapshot = new URL(
  '../src/background/policy/download-protection.json',
  import.meta.url
)
const current = listSchema.parse(JSON.parse(await readFile(snapshot, 'utf8')))
const next = listSchema.parse(raw)
if (next.revision < current.revision)
  throw new Error('Refusing an older protection list')
await writeFile(snapshot, `${JSON.stringify(next, null, 2)}\n`)
