/**
 * WorkBuddy 5.6.x at-rest credential protection: classification, key
 * resolution, and field decryption for the desktop apps' encrypted auth files.
 *
 * Since WorkBuddy 5.6 both desktop apps encrypt `auth.accessToken` and
 * `auth.refreshToken` at rest, so readers see `{$wbEncrypted:1, envelope}`
 * wrappers instead of token strings. Everything needed to open them lives on
 * the same machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM; the AAD builder is transcribed from the app's own
 *   `buildAuthenticatedContextAad`.
 *
 * Ported from dsh-workbuddy-connect (MIT) `desktop-credential-protection.ts`.
 * Neither the payload, the key, nor any token is ever logged; error messages
 * carry sizes, ids, and exit codes only.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { WorkBuddyElectronProduct } from './variant.js'

/** The four states a desktop auth document can be read as. */
export type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized'

/** Why a finished-but-failed step cannot produce an answer. */
export type AtRestReasonCode =
  | 'credential-region-mismatch'
  | 'electron-path-invalid'
  | 'electron-binary-unavailable'
  | 'electron-binary-ambiguous'
  | 'electron-binary-not-found'
  | 'electron-discovery-incomplete'
  | 'encrypted-credential-unreadable'

/** A failure the UI can classify by code rather than by matching prose. */
export class WorkBuddyAtRestError extends Error {
  readonly reasonCode: AtRestReasonCode

  constructor(reasonCode: AtRestReasonCode, message: string) {
    super(message)
    this.name = 'WorkBuddyAtRestError'
    this.reasonCode = reasonCode
  }
}

/** Read the reason code off an arbitrary thrown value, when it carries one. */
export function atRestReasonCodeOf(error: unknown): AtRestReasonCode | undefined {
  return error instanceof WorkBuddyAtRestError ? error.reasonCode : undefined
}

/** One decrypted-openable envelope's decoded parts. */
export interface WorkBuddyEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** One auth field found in its encrypted wrapper, with its envelope decoded. */
export interface WrappedAuthField {
  field: 'accessToken' | 'refreshToken'
  envelope: WorkBuddyEnvelope
}

export type DesktopAuthClassification =
  | { format: 'absent' }
  | { format: 'plaintext' }
  | { format: 'encrypted', wrapped: { document: Record<string, unknown>, fields: readonly WrappedAuthField[] } }
  | { format: 'unrecognized' }

/** Distinct key ids across the wrapped fields, in field order. */
export function keyIdsOf(fields: readonly WrappedAuthField[]): string[] {
  return [...new Set(fields.map(wrapped => wrapped.envelope.keyId))]
}

/**
 * Whether a raw value is the 5.6 field wrapper. The wrapper is
 * `{$wbEncrypted:1, envelope:<base64 of JSON {suite,keyId,nonce,authTag,ciphertext}>}`.
 */
function parseWrappedField(field: 'accessToken' | 'refreshToken', value: unknown): WrappedAuthField | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value as Record<string, unknown>
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = inner as Record<string, unknown>
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite'])) return undefined
  // Suite 1 is the only scheme WorkBuddy 5.6.x defines for credential fields.
  if (parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  return {
    field,
    envelope: { suite: parts['suite'], keyId: parts['keyId'], nonce, authTag, ciphertext },
  }
}

/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

const AUTH_FIELDS = ['accessToken', 'refreshToken'] as const

/**
 * Read a desktop auth document's format. `absent` is an empty file;
 * `plaintext` is any document the regular parser could read; `encrypted` has
 * at least one field in a decodable wrapper; everything else is
 * `unrecognized`.
 */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === '') return { format: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { format: 'unrecognized' }
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const fields: WrappedAuthField[] = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(field, value)
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/** Decrypt a wrapped document into the plaintext text the regular parser reads. */
export function unwrapDesktopAuthDocument(
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  openField: (wrapped: WrappedAuthField) => string,
): string {
  const wrapped = classification.wrapped
  const rebuilt = structuredClone(wrapped.document) as Record<string, unknown>
  const auth = typeof rebuilt['auth'] === 'object' && rebuilt['auth'] !== null
    ? rebuilt['auth'] as Record<string, unknown>
    : rebuilt
  for (const field of wrapped.fields) {
    auth[field.field] = openField(field)
  }
  return JSON.stringify(rebuilt)
}

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad` (WBEV1 `field` framing).
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Open one envelope with a protector key; `undefined` when it will not open. */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** Seal one field with the exact format `openAuthField` reads. Test helper. */
export function sealAuthFieldForTest(key: Buffer, plaintext: string, suite = 1): { '$wbEncrypted': 1, envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string
}

/** Validate the helper's payload: `version:1` and a canonical-base64 32-byte non-zero secret. */
export function parseAtRestPayload(text: string): WorkBuddyAtRestPayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** A resolved protector key and the id envelopes name for it. */
interface ResolvedKey {
  key: Buffer
  keyId: string
}

/**
 * The helper: run inside WorkBuddy's Electron as plain Node, where the
 * private `workbuddyStorage` binding exists, and print only the payload.
 */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

// ---------------------------------------------------------------------------
// Electron binary resolution
// ---------------------------------------------------------------------------

const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'
const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1024 * 1024
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const WINDOWS_DISCOVERY_STEP_TIMEOUT_MS = 10_000
const DISCOVERY_BUDGET_MS = 10_000
const MDFIND_MAX_OUTPUT_BYTES = 1024 * 1024
const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024

/** Only exit-code 2/3 mean "root absent"/"root unreadable" for the fallback. */
const WINDOWS_POWERSHELL_ROOT_ABSENT = 2
const WINDOWS_POWERSHELL_ROOT_UNREADABLE = 3

/**
 * The PowerShell 5.1 fallback that re-reads one uninstall root as UTF-8.
 *
 * Windows PowerShell 5.1 joins every argument after `-Command` into one
 * command string, so the script is wrapped in a call-operator script block —
 * `& { …script… } -Root <path>` — or `$Root` never binds (the 0.7.2-era
 * defect fixed upstream as #105/#106/#107).
 */
const WINDOWS_POWERSHELL_QUERY_SCRIPT = [
  'param([string]$Root)',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  '$ErrorActionPreference="Stop";',
  '$path="Registry::"+$Root;',
  'if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.Write("root absent"); exit 2 };',
  'try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { [Console]::Error.Write("root unreadable"); exit 3 };',
  '$out=@();',
  'foreach ($n in $k.GetSubKeyNames()) {',
  '  try { $p=$k.OpenSubKey($n); if ($null -eq $p) { throw "null" } } catch { [Console]::Error.Write("subkey unreadable"); exit 3 };',
  '  $d=$p.GetValue("DisplayName");$i=$p.GetValue("DisplayIcon");',
  '  if ($null -ne $d -or $null -ne $i) { $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i } }',
  '};',
  'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
].join(' ')
export const WINDOWS_POWERSHELL_QUERY_COMMAND = `& { ${WINDOWS_POWERSHELL_QUERY_SCRIPT} }`

/** The only roots this tool will name on a `-Command` command line. */
const WINDOWS_REGISTRY_ROOT_PATTERN = /^HK(?:LM|CU)(?:\\[A-Za-z0-9._-]+)+$/u

/** Why a discovery subprocess could not produce an answer ("we do not know"). */
class DiscoveryIncompleteError extends Error {}

/** Which automatic discovery, if any, may run when no explicit binary is configured. */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

export function electronDiscoveryFor(platform: NodeJS.Platform = process.platform): WorkBuddyElectronDiscovery {
  if (platform === 'darwin') return 'macos-workbuddy'
  if (platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/** The platform-default Electron binary for one product, or undefined where none is verified. */
export function defaultWorkBuddyElectronPath(
  product: WorkBuddyElectronProduct,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'darwin') return product.macOS.defaultPath
  if (platform !== 'win32' || product.windows.defaultPathSegments === undefined) return undefined
  const localAppData = process.env['LOCALAPPDATA']?.trim()
  return localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...product.windows.defaultPathSegments)
}

/** Windows-only seam for querying one uninstall registry root. */
export type QueryUninstallRoot = (root: string, signal: AbortSignal) => Promise<string>

function subprocessFailureReason(error: { readonly code?: unknown, readonly killed?: boolean }): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'the output exceeded the size limit'
  return error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')
}

/** Only known missing-key diagnostics can safely make a failed query empty. */
function windowsRegistryKeyMissing(stderr: string): boolean {
  const detail = stderr.trim()
  return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail)
    || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail)
}

/**
 * The default Windows registry discovery tool: `reg.exe query <root> /s`,
 * re-read through the PowerShell 5.1 Unicode API whenever the raw bytes are
 * not pure ASCII (a code page other than the console's cannot be recovered
 * from the bytes themselves).
 */
export function workBuddyWindowsDiscoveryTools(): QueryUninstallRoot {
  const systemRoot = process.env['SystemRoot']?.trim()
  const regPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, 'System32', 'reg.exe')
  const powershellPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  const runTool = (root: string, signal: AbortSignal): Promise<Buffer> => new Promise<Buffer>((resolve, reject) => {
    if (regPath === undefined) {
      reject(new DiscoveryIncompleteError('SystemRoot is not configured'))
      return
    }
    if (signal.aborted) {
      reject(new DiscoveryIncompleteError('reg.exe was not started: the discovery budget was already spent'))
      return
    }
    let settled = false
    const child = execFile(regPath, ['query', root, '/s'], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: WINDOWS_DISCOVERY_STEP_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (settled) return
      settled = true
      if (error !== null && error !== undefined) {
        if (error.killed !== true && (error.code === 1 || error.code === '1')
          && windowsRegistryKeyMissing(stderr.toString('utf8'))) {
          resolve(Buffer.alloc(0))
          return
        }
        reject(new DiscoveryIncompleteError(`reg.exe could not complete (${subprocessFailureReason(error)})`))
        return
      }
      resolve(stdout)
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new DiscoveryIncompleteError('reg.exe was abandoned: the discovery budget was spent'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })

  const runFallback = (root: string, signal: AbortSignal): Promise<string> => new Promise<string>((resolve, reject) => {
    if (!WINDOWS_REGISTRY_ROOT_PATTERN.test(root)) {
      reject(new DiscoveryIncompleteError('the registry root was not a plain HKLM/HKCU path this tool may query'))
      return
    }
    if (powershellPath === undefined) {
      reject(new DiscoveryIncompleteError('SystemRoot is not configured'))
      return
    }
    if (signal.aborted) {
      reject(new DiscoveryIncompleteError('powershell.exe was not started: the discovery budget was already spent'))
      return
    }
    let settled = false
    const child = execFile(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_POWERSHELL_QUERY_COMMAND,
      '-Root',
      root,
    ], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: WINDOWS_DISCOVERY_STEP_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (settled) return
      settled = true
      if (error !== null && error !== undefined) {
        const code = error.killed === true ? undefined : Number(error.code)
        if (code === WINDOWS_POWERSHELL_ROOT_ABSENT) {
          resolve('')
          return
        }
        if (code === WINDOWS_POWERSHELL_ROOT_UNREADABLE) {
          reject(new DiscoveryIncompleteError(`powershell.exe could not read the registry root ${root}`))
          return
        }
        reject(new DiscoveryIncompleteError(`powershell.exe could not complete (${subprocessFailureReason(error)})`))
        return
      }
      const records = parseWindowsUninstallJson(stdout)
      if (records === undefined) {
        reject(new DiscoveryIncompleteError('powershell.exe output was not the expected registry document'))
        return
      }
      resolve(records)
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new DiscoveryIncompleteError('powershell.exe was abandoned: the discovery budget was spent'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })

  return async (root, signal) => {
    const raw = await runTool(root, signal)
    // ASCII-only output means every code page agrees; one byte at or above
    // 0x80 means the code page is unknowable from the bytes.
    if (!isAsciiOnly(raw)) return await runFallback(root, signal)
    return raw.toString('utf8')
  }
}

/** Whether every byte is ASCII, the one case where a decode cannot be wrong. */
function isAsciiOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return false
  }
  return true
}

/**
 * Turn the fallback's JSON into the same column-shaped document
 * `parseWindowsRegistryOutput` consumes.
 */
function parseWindowsUninstallJson(output: string): string | undefined {
  let document: unknown
  try {
    document = JSON.parse(output)
  } catch {
    return undefined
  }
  const rows = Array.isArray(document) ? document : [document]
  const lines: string[] = []
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const displayName = record['displayName']
    const displayIcon = record['displayIcon']
    if (typeof displayName !== 'string' && typeof displayIcon !== 'string') continue
    lines.push(`HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PS-${String(index)}}`)
    if (typeof displayName === 'string') lines.push(`    DisplayName    REG_SZ    ${displayName}`)
    if (typeof displayIcon === 'string') lines.push(`    DisplayIcon    REG_SZ    ${displayIcon}`)
  }
  return lines.join('\r\n')
}

/**
 * Parse the value columns emitted by `reg query ... /s`.
 * Entries are filtered by the product's DisplayName pattern *before* the
 * DisplayIcon is judged.
 */
export function parseWindowsRegistryOutput(output: string, displayNamePattern: RegExp): { candidates: string[], incomplete: boolean } {
  const entries = new Map<string, { displayName?: string, displayIcon?: string }>()
  let currentKey: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line)
    if (keyMatch !== null) {
      currentKey = keyMatch[1]!
      entries.set(currentKey, {})
      continue
    }
    if (currentKey === undefined) continue
    const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line)
    if (valueMatch === null) continue
    const entry = entries.get(currentKey)
    if (entry === undefined) continue
    const value = valueMatch[2] ?? ''
    if (valueMatch[1]!.toLowerCase() === 'displayname') entry.displayName = value
    else entry.displayIcon = value
  }
  const candidates: string[] = []
  let incomplete = false
  for (const entry of entries.values()) {
    if (entry.displayName === undefined) continue
    if (!displayNamePattern.test(entry.displayName.trim())) continue
    const displayIcon = entry.displayIcon === undefined ? undefined : parseWindowsDisplayIcon(entry.displayIcon)
    if (displayIcon === undefined) incomplete = true
    else candidates.push(displayIcon)
  }
  return { candidates, incomplete }
}

/** Read a quoted DisplayIcon path and remove the Windows icon-index suffix. */
export function parseWindowsDisplayIcon(value: string): string | undefined {
  const raw = value.trim()
  let path: string
  if (raw.startsWith('"')) {
    const closingQuote = raw.indexOf('"', 1)
    if (closingQuote < 0) return undefined
    const suffix = raw.slice(closingQuote + 1).trim()
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return undefined
    path = raw.slice(1, closingQuote).replace(/,\d+$/u, '')
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw)
    if (match === null) return undefined
    path = match[1]!
  }
  path = path.trim()
  return /\.exe$/iu.test(path) ? path : undefined
}

interface WindowsCandidateInspection {
  electronPath: string
  identity: string
}

/**
 * Validate the known Windows layout for the product's exe. `undefined` is a
 * decidable exclusion; `'unresolved'` is reserved for errors that prevent
 * checking.
 */
function inspectWindowsElectronCandidate(
  electronPath: string,
  platform: NodeJS.Platform,
  exeBasename: string,
): WindowsCandidateInspection | 'unresolved' | undefined {
  if (platform !== 'win32' || basename(electronPath).toLowerCase() !== exeBasename) return undefined
  let binaryStat
  try {
    binaryStat = statSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!binaryStat.isFile()) return undefined
  try {
    accessSync(electronPath, constants.X_OK)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  const installRoot = dirname(electronPath)
  let version: string
  try {
    version = readFileSync(join(installRoot, 'version'), 'utf8').trim()
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined

  try {
    // The archive path must not go through fs.stat: under an Electron host,
    // asar interception stats app.asar as a directory. Listing the real
    // resources directory is asar-independent.
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  let identity: string
  try {
    identity = realpathSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  return {
    electronPath,
    identity: platform === 'win32' ? identity.toLowerCase() : identity,
  }
}

/**
 * Parse the value columns emitted by `reg query` for macOS discovery inputs
 * is not needed — the macOS flow uses mdfind/plutil below.
 */
export interface WorkBuddyDiscoveryTools {
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/** macOS discovery tools: Spotlight for the bundle, plutil for identity. */
export function workBuddyDiscoveryTools(bundleId: string): WorkBuddyDiscoveryTools {
  const runTool = (bin: string, args: readonly string[], maxBytes: number, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`))
        return
      }
      let settled = false
      const child = execFile(bin, [...args], { maxBuffer: maxBytes, timeout: 3_000 }, (error, stdout) => {
        if (settled) return
        settled = true
        if (error !== null && error !== undefined) {
          reject(new DiscoveryIncompleteError(`${bin} could not complete (${subprocessFailureReason(error)})`))
          return
        }
        resolve(stdout)
      })
      const abort = (): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => { signal.removeEventListener('abort', abort) })
    })

  return {
    findApps: async signal => {
      const out = await runTool(MDFIND_BIN, [`kMDItemCFBundleIdentifier == '${bundleId}'`], MDFIND_MAX_OUTPUT_BYTES, signal)
      return out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        return out.trim()
      } catch {
        return undefined
      }
    },
  }
}

/** Provider options; the spawn/source seams exist so tests never spawn a process. */
export interface WorkBuddyAtRestKeyProviderOptions {
  product: WorkBuddyElectronProduct
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number
  /** Where the payload comes from; defaults to spawning WorkBuddy's own Electron. */
  source?: () => Promise<string>
  /** Runs the helper at the resolved path. */
  spawnHelper?: (electronPath: string) => Promise<string>
  /** Windows registry discovery subprocess; injectable so tests never spawn. */
  queryUninstallRoot?: QueryUninstallRoot
  /** macOS discovery subprocesses; injectable so tests never spawn. */
  discoveryTools?: WorkBuddyDiscoveryTools
  /** Platform override for deterministic tests. */
  platform?: NodeJS.Platform
  /** Total budget for one discovery run. */
  discoveryBudgetMs?: number
}

/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for.
 */
export class WorkBuddyAtRestKeyProvider {
  private readonly explicitPath: string | undefined
  private readonly product: WorkBuddyElectronProduct
  private readonly defaultPath: string | undefined
  private readonly discovery: WorkBuddyElectronDiscovery
  private readonly queryUninstallRoot: QueryUninstallRoot
  private readonly discoveryTools: WorkBuddyDiscoveryTools
  private readonly platform: NodeJS.Platform
  private readonly discoveryBudgetMs: number
  private readonly timeoutMs: number
  private readonly source: () => Promise<string>
  private readonly spawnHelperFn: (electronPath: string) => Promise<string>
  private discoveredPath: string | undefined
  private cache: ResolvedKey | undefined
  private inflight: Promise<ResolvedKey> | undefined

  constructor(options: WorkBuddyAtRestKeyProviderOptions) {
    this.product = options.product
    const fromEnv = process.env[options.product.envVar]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // An explicit path is authoritative: naming a binary means "use this one",
    // so an unusable one is an error, not an invitation to look for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = electronDiscoveryFor(options.platform ?? process.platform)
    this.platform = options.platform ?? process.platform
    this.defaultPath = defaultWorkBuddyElectronPath(this.product, this.platform)
    this.queryUninstallRoot = options.queryUninstallRoot ?? workBuddyWindowsDiscoveryTools()
    this.discoveryTools = options.discoveryTools ?? workBuddyDiscoveryTools(this.product.macOS.bundleId)
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.spawnHelperFn = options.spawnHelper ?? (path => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
  }

  /** The binary the helper would use, for diagnostics; never triggers a search. */
  helperPath(): string | undefined {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return undefined
    return this.discoveredPath ?? this.defaultPath
  }

  /** A protector key matching one of the requested envelope key ids. */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (requested.length === 0) {
      throw new WorkBuddyAtRestError('encrypted-credential-unreadable', 'encrypted desktop credential carries no key ids')
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source().then(text => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyAtRestError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')});`
        + ' the desktop credential was sealed by a different WorkBuddy installation',
      )
    }
    return resolved.key
  }

  private ingest(text: string): ResolvedKey {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyAtRestError(
        'encrypted-credential-unreadable',
        'WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    const resolved: ResolvedKey = {
      key,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
    }
    this.cache = resolved
    return resolved
  }

  /** The binary to spawn, or a diagnosable error saying why there is none. */
  private async resolveElectronPath(): Promise<string> {
    if (this.explicitPath !== undefined) {
      if (!isExecutable(this.explicitPath)) {
        throw new WorkBuddyAtRestError(
          'electron-path-invalid',
          `the configured ${this.product.productName} Electron binary is not available at ${this.explicitPath};`
          + ` check ${this.product.envVar} or the extension setting, or unset it to let the extension look for the app itself`,
        )
      }
      return this.explicitPath
    }
    if (this.discovery === 'none') {
      throw new WorkBuddyAtRestError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    if (this.defaultPath !== undefined && isExecutable(this.defaultPath)) return this.defaultPath
    if (this.discoveredPath !== undefined) {
      if (isExecutable(this.discoveredPath)) return this.discoveredPath
      this.discoveredPath = undefined
    }
    const found = this.discovery === 'macos-workbuddy'
      ? await this.discoverMacosApp()
      : await this.discoverWindowsApp()
    this.discoveredPath = found
    return found
  }

  /** Resolve this product's app through Spotlight, proving each candidate's identity. */
  private async discoverMacosApp(): Promise<string> {
    if (this.platform !== 'darwin') {
      throw new WorkBuddyAtRestError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let candidates: readonly string[]
      try {
        candidates = await this.discoveryTools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete(this.product.productName, 'the app search did not complete')
      }
      const seen = new Map<string, string>()
      let unresolved = false
      for (const candidate of candidates) {
        try {
          statSync(candidate)
        } catch (error: unknown) {
          if (isENOENT(error)) continue
          unresolved = true
          continue
        }
        let bundleIdentifier: string | undefined
        try {
          bundleIdentifier = await this.discoveryTools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== this.product.macOS.bundleId) continue
        const electronPath = join(candidate, 'Contents', 'MacOS', 'Electron')
        if (!isExecutable(electronPath)) continue
        let identity: string
        try {
          identity = realpathSync(candidate)
        } catch {
          identity = candidate
        }
        if (seen.has(identity)) continue
        seen.set(identity, electronPath)
      }
      if (seen.size > 1) {
        const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
        throw new WorkBuddyAtRestError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyAtRestError(
          'electron-binary-not-found',
          `no ${this.product.productName} application was found in the default location or the system index;`
          + ` set ${this.product.envVar} to the app's Electron binary`,
        )
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /** Resolve this product's app through Windows uninstall records. */
  private async discoverWindowsApp(): Promise<string> {
    if (this.platform !== 'win32') {
      throw new WorkBuddyAtRestError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      const candidates: string[] = []
      let unresolved = false
      for (const root of WINDOWS_REGISTRY_ROOTS) {
        let output: string
        try {
          output = await this.queryUninstallRoot(root, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        const parsed = parseWindowsRegistryOutput(output, this.product.windows.displayNamePattern)
        candidates.push(...parsed.candidates)
        unresolved ||= parsed.incomplete
      }

      const seen = new Map<string, string>()
      const rejected: string[] = []
      for (const candidate of new Set(candidates)) {
        const inspection = inspectWindowsElectronCandidate(candidate, this.platform, this.product.windows.exeBasename)
        if (inspection === 'unresolved') {
          unresolved = true
          continue
        }
        if (inspection === undefined) {
          rejected.push(candidate)
          continue
        }
        seen.set(inspection.identity, inspection.electronPath)
      }
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some registry entries or candidates could not be checked')
      if (seen.size > 1) {
        const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
        throw new WorkBuddyAtRestError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      if (seen.size === 0) {
        const message = rejected.length === 0
          ? `no usable ${this.product.productName} Electron binary was found in the default location or Windows uninstall records;`
            + ` set ${this.product.envVar} to the app's Electron binary`
          : `Windows uninstall records found ${rejected.length} ${this.product.productName} candidate${rejected.length > 1 ? 's' : ''},`
            + ` but ${rejected.length > 1 ? 'none' : 'it'} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar);`
            + ` set ${this.product.envVar} to the installed app's executable to use it`
        throw new WorkBuddyAtRestError('electron-binary-not-found', message)
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async spawnPayload(): Promise<string> {
    return await this.spawnHelperFn(await this.resolveElectronPath())
  }

  private async spawnAt(electronPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFile(electronPath, ['-e', HELPER_SCRIPT], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }, (error, stdout) => {
        if (error !== null && error !== undefined) {
          // Code and reason only: stdout/stderr can carry paths or crash dumps,
          // and the payload must never appear in a message.
          const reason = error.killed === true
            ? `timed out or was killed after ${String(this.timeoutMs)}ms`
            : error.code !== undefined
              ? `exited with code ${String(error.code)}`
              : 'could not be started'
          reject(new WorkBuddyAtRestError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) ${reason}`,
          ))
          return
        }
        const output = stdout.trim()
        if (output === '') {
          reject(new WorkBuddyAtRestError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) produced no payload`,
          ))
          return
        }
        resolve(output)
      })
    })
  }
}

function discoveryIncomplete(productName: string, detail: string): WorkBuddyAtRestError {
  return new WorkBuddyAtRestError(
    'electron-discovery-incomplete',
    `the ${productName} application search did not finish (${detail}); this is not proof that the app is missing`,
  )
}

/** Whether a path exists and is executable; never throws. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
