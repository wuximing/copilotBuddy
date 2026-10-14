/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance. The wire behavior is
 * ported from dsh-workbuddy-connect (MIT) `upstream.ts`, itself ported from
 * Sliverkiss/workbuddy2api (MIT).
 *
 * Chat identity note: this port always presents the compiled-in desktop
 * fallback identity (the form the reference implementation uses on Windows,
 * where no verified app-version source exists). The gateway has not been
 * observed to branch on the version number.
 */

import type { WorkBuddyCredential } from './auth.js'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** One CLI-usable model as the upstream catalog describes it. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  defaultContextWindow?: number
  maxInputTokens?: number
  supportedContextWindows?: readonly number[]
  promotions?: readonly WorkBuddyPromotion[]
  maxTokens: number
  /** Upstream-declared image input capability; missing/false resolves to false. */
  supportsImages: boolean
  reasoning?: WorkBuddyModelReasoning
  billing?: WorkBuddyModelBilling
}

export interface WorkBuddyModelReasoning {
  supports: boolean
  onlyReasoning: boolean
  supportedEfforts?: readonly WorkBuddyEffort[]
  defaultEffort?: WorkBuddyEffort
  canDisableThinking: boolean
}

export type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface WorkBuddyModelBilling {
  credits?: string
  badges?: readonly string[]
  free: boolean
  rateUnknown?: boolean
}

export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  endTimeMs?: number
}

export interface WorkBuddyExpiringCredits {
  total: number
  packages: number
  earliestEndTimeMs?: number
}

export interface WorkBuddyCreditExpiry {
  within24h: WorkBuddyExpiringCredits
  within3d: WorkBuddyExpiringCredits
  within7d: WorkBuddyExpiringCredits
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
  expiry?: WorkBuddyCreditExpiry
}

export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

const enterprisePackageName = 'enterprise'

/** Shared CLI-form User-Agent for refresh and the CN catalog. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/**
 * Compiled-in desktop fallback versions. The gateway splits `/v3/config` by
 * client identity and has not been observed to branch on the version number;
 * these are shape requirements rather than currency claims.
 */
const FALLBACK_APP_VERSION_GLOBAL = '5.5.2'
const FALLBACK_APP_VERSION_CN = '5.5.6'

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

const EFFORT_VALUES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const BADGE_PREFIX = 'badge:'

/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped: Record<string, unknown>): { reasoning: WorkBuddyModelReasoning } {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts: WorkBuddyEffort[] | undefined
  let defaultEffort: WorkBuddyEffort | undefined
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const reasoning = rawReasoning as Record<string, unknown>
    const rawEfforts = reasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter((value): value is WorkBuddyEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof reasoning['defaultEffort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['defaultEffort'] as string)) {
      defaultEffort = reasoning['defaultEffort'] as WorkBuddyEffort
    } else if (typeof reasoning['effort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['effort'] as string)) {
      defaultEffort = reasoning['effort'] as WorkBuddyEffort
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire.
    canDisableThinking = reasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/**
 * Reduce an upstream credits string to its language-neutral display form
 * (`x0.79`), dropping a trailing `credits` unit word.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(
  wrapped: Record<string, unknown>,
  extraTags?: readonly string[],
): { billing: WorkBuddyModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags: readonly unknown[] = [...Array.isArray(wrapped['tags']) ? wrapped['tags'] : [], ...extraTags ?? []]
  for (const tag of rawTags) {
    if (typeof tag !== 'string') continue
    if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue
    const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
    if (label !== '' && !badges.includes(label)) badges.push(label)
  }
  const multiplier = normalizeCredits(credits)
  const free = multiplier !== undefined && /^x?0\.0+$/u.test(multiplier)
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free,
    },
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  if (status === 401) return 'session_dead'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Extract a user-facing error message from an upstream JSON response body.
 * Prefers WorkBuddy's localized `displayMsg.zh` / `displayMsg.en`, falling
 * back to `msg`.
 */
export function extractDisplayErrorMessage(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const obj = parsed as Record<string, unknown>
    const displayMsg = obj['displayMsg']
    if (typeof displayMsg === 'object' && displayMsg !== null && !Array.isArray(displayMsg)) {
      const localized = displayMsg as Record<string, unknown>
      if (typeof localized['zh'] === 'string' && localized['zh'].trim() !== '') {
        return localized['zh'].trim()
      }
      if (typeof localized['en'] === 'string' && localized['en'].trim() !== '') {
        return localized['en'].trim()
      }
    }
    if (typeof obj['msg'] === 'string' && obj['msg'].trim() !== '') {
      return obj['msg'].trim()
    }
  } catch {
    // Non-JSON bodies stay undefined
  }
  return undefined
}

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** The desktop-client User-Agent shape chat requests present. */
function chatUserAgent(region: WorkBuddyRegion): string {
  const version = region === 'global' ? FALLBACK_APP_VERSION_GLOBAL : FALLBACK_APP_VERSION_CN
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  return `WorkBuddy/${version} ${product}/${version}`
}

/** The App-shaped User-Agent for the international catalog request. */
function appCatalogUserAgent(region: WorkBuddyRegion): string {
  const version = region === 'global' ? FALLBACK_APP_VERSION_GLOBAL : FALLBACK_APP_VERSION_CN
  return region === 'global' ? `WorkBuddyAI/${version}` : CLIENT_UA
}

/**
 * Chat request headers, including the X-No-* conventions the official CLI
 * uses. Chat requests never carry the refresh token.
 */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const region = regionOf(credential.domain)
  return {
    ...commonHeaders(credential),
    'User-Agent': chatUserAgent(region),
    'Content-Type': 'application/json',
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': region === 'global' ? FALLBACK_APP_VERSION_GLOBAL : FALLBACK_APP_VERSION_CN,
    'X-Product': 'SaaS',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400),
 * and rewrite `developer` messages as `system` (the upstream rejects that
 * role with 400 code 11128).
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/**
 * Remove the `off` effort spelling from the wire. Both endpoints reject
 * `reasoning_effort: "off"` (the CN endpoint on models that declare
 * `onlyReasoning`, the international GPT family with 400/11133). Omission is
 * the only form measured good on every such model.
 */
function dropUnsupportedEffort(obj: Record<string, unknown>): void {
  if (obj['reasoning_effort'] === 'off') delete obj['reasoning_effort']
}

/** Prepare a body for the **CN** endpoint: the shared `off` strip only. */
export function prepareCnChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  dropUnsupportedEffort(body as Record<string, unknown>)
  return JSON.stringify(body)
}

const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * Prepare a body for the **international** endpoint: everything
 * {@link prepareChatBody} does, the shared `off` strip, plus the gateway's
 * requirement that the first message be a system prompt (400 code 11128
 * otherwise).
 */
export function prepareInternationalChatBody(source: string): string {
  const prepared = prepareChatBody(source)
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    return prepared
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return prepared
  const obj = body as Record<string, unknown>
  dropUnsupportedEffort(obj)
  const messages = obj['messages']
  if (!Array.isArray(messages)) return JSON.stringify(obj)
  const first = messages[0]
  if (typeof first === 'object' && first !== null && !Array.isArray(first)
    && (first as Record<string, unknown>)['role'] === 'system') return JSON.stringify(obj)
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(obj)
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
  document: Record<string, unknown>
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
    document,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Parse either catalog shape after its envelope has been checked.
 *
 * Membership is the `cli` agent's roster, intersected with the rows that are
 * usable: the roster is what the client identity this extension presents is
 * allowed to chat with, and joining rather than trusting it outright drops
 * both ids the roster has retired and rows the document lists but cannot
 * serve (`disabled: true`, non-positive caps).
 */
export function parseModelCatalog(
  data: Record<string, unknown>,
  international = false,
  promoBadges?: ReadonlyMap<string, readonly string[]>,
): readonly WorkBuddyUpstreamModel[] {
  const rawModels = Array.isArray(data['models']) ? data['models'] : []
  const agents = Array.isArray(data['agents']) ? data['agents'] : []
  let cliIds: readonly string[] | undefined
  for (const agent of agents) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent as Record<string, unknown>
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
        break
      }
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('workbuddy model catalog lists no cli agent models')
  }
  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const model of rawModels) {
    if (typeof model !== 'object' || model === null) continue
    const wrapped = model as Record<string, unknown>
    const id = typeof wrapped['id'] === 'string' ? wrapped['id'] : ''
    if (id === '' || wrapped['disabled'] === true) continue
    const input = typeof wrapped['maxInputTokens'] === 'number' ? wrapped['maxInputTokens'] : 0
    const output = typeof wrapped['maxOutputTokens'] === 'number' ? wrapped['maxOutputTokens'] : 0
    if (input <= 0 || output <= 0) continue
    byId.set(id, {
      id,
      name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
      contextWindow: international && isObject(wrapped['contextWindow']) && positive(wrapped['contextWindow']['defaultLength'])
        ? wrapped['contextWindow']['defaultLength'] : input,
      ...(international ? {
        ...isObject(wrapped['contextWindow']) && positive(wrapped['contextWindow']['defaultLength'])
          ? { defaultContextWindow: wrapped['contextWindow']['defaultLength'] } : {},
        maxInputTokens: input,
        supportedContextWindows: isObject(wrapped['contextWindow']) && Array.isArray(wrapped['contextWindow']['supportedLengths'])
          ? wrapped['contextWindow']['supportedLengths'].filter(positive) : [],
        promotions: parsePromotions(data['modelPromotions'], id),
      } : {}),
      maxTokens: output,
      supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
      ...resolveUpstreamReasoning(wrapped),
      ...resolveUpstreamBilling(wrapped, promoBadges?.get(id)),
    })
  }
  const models = cliIds
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}

/** One verified promotion entry. */
export interface WorkBuddyPromotion {
  start: number
  end: number
  label: string
  factor: number
  priority: number
}

/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value: unknown, model: string): WorkBuddyPromotion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isObject(item) || item['enabled'] !== true) return []
    const modelIds = item['modelIds']
    if (!Array.isArray(modelIds) || !modelIds.includes(model)) return []
    const schedule = item['schedule']
    const discount = item['discount']
    const badge = item['badge']
    if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return []
    // Only a replacement discount has an unambiguous display rule.
    if (discount['displayMode'] !== 'replace') return []
    const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : Number.NaN
    const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : Number.NaN
    const factor = discount['factor']
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return []
    return [{
      start,
      end,
      factor,
      label: typeof badge['label'] === 'string' ? badge['label'] : '',
      priority: typeof item['priority'] === 'number' && Number.isFinite(item['priority']) ? item['priority'] : 0,
    }]
  })
}

/**
 * The cost label for one model: its credit multiplier plus promo badges,
 * e.g. `x0.79`, `x0.00 · 限时免费`, or `rate unknown`.
 *
 * This string rides in the model *name* (and `detail`). VS Code's own cost
 * badge is gated on Copilot usage-based billing (`isUBB`), which a BYOK user
 * does not have, so the name is the only surface that always shows the rate.
 */
export function modelCostLabel(model: WorkBuddyUpstreamModel): string {
  const rate = model.billing?.rateUnknown === true
    ? 'rate unknown'
    : normalizeCredits(model.billing?.credits)
  return [...rate === undefined ? [] : [rate], ...model.billing?.badges ?? []].join(' · ')
}

/**
 * The `pricing` string VS Code renders as the model's cost tier, e.g. `0.79x`.
 *
 * VS Code's model hover and picker show `metadata.pricing` (a string) and use
 * `multiplierNumeric` only as an additional "this model has a rate" flag; a
 * numeric multiplier without this string renders nothing.
 */
export function modelPricing(model: WorkBuddyUpstreamModel): string | undefined {
  const multiplier = modelMultiplier(model)
  if (multiplier === undefined) return undefined
  return `${String(multiplier)}x`
}

/** VS Code's cost-tier vocabulary, as its own model picker renders it. */
export type WorkBuddyPriceCategory = 'low' | 'medium' | 'high' | 'very_high'

/**
 * The numeric credit multiplier as a number, for VS Code's cost column.
 *
 * `x0.79` → `0.79`. Returns undefined when the upstream gave no usable rate
 * (a model with no billing row, or one whose rate is no longer trustworthy
 * because its promotion lapsed).
 */
export function modelMultiplier(model: WorkBuddyUpstreamModel): number | undefined {
  if (model.billing?.rateUnknown === true) return undefined
  const rate = normalizeCredits(model.billing?.credits)
  if (rate === undefined) return undefined
  const value = Number(rate.replace(/^x/iu, ''))
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Map the credit multiplier onto VS Code's four cost tiers.
 *
 * WorkBuddy charges a *fraction* of a credit for most models, so the tiers
 * are anchored on the multiplier itself: `x0.00`–`x0.49` cheap, `x0.50`–`x0.99`
 * below one credit, `x1.00`–`x1.99` around one credit, `x2.00`+ expensive.
 */
export function priceCategoryFor(multiplier: number | undefined): WorkBuddyPriceCategory | undefined {
  if (multiplier === undefined) return undefined
  if (multiplier < 0.5) return 'low'
  if (multiplier < 1) return 'medium'
  if (multiplier < 2) return 'high'
  return 'very_high'
}

/**
 * The reasoning-effort values VS Code should offer for one model, or
 * undefined when the model declares none.
 *
 * Only an upstream-declared `supportedEfforts` list produces a picker: the
 * reference implementation learned that models which merely *accept* the
 * parameter may silently ignore the value, so an undeclared model keeps
 * WorkBuddy's own default effort instead of offering a menu that does
 * nothing.
 */
export function supportedEffortsFor(model: WorkBuddyUpstreamModel): readonly WorkBuddyEffort[] | undefined {
  const efforts = model.reasoning?.supportedEfforts
  return efforts === undefined || efforts.length === 0 ? undefined : efforts
}

/**
 * Re-evaluate a model's promotion against the current time, so a cached
 * "Free now" badge disappears on its own after `validUntil` passes.
 */export function modelWithCurrentPromotion(model: WorkBuddyUpstreamModel, now = Date.now()): WorkBuddyUpstreamModel {
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    // A row with promotions attached but none in force: the upstream bakes
    // the discounted value into `credits`, so the cached rate describes a
    // discount that has ended. The original price is not recoverable, so the
    // honest answer is to stop asserting one.
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    return {
      ...model,
      billing: {
        free: false,
        rateUnknown: true,
      },
    }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  // A replacement to zero is meaningful even when the base rate is unknown;
  // any other multiplier needs a number to scale.
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: [
        ...(model.billing?.badges ?? []),
        ...promotion.label === '' ? [] : [promotion.label],
      ],
    },
  }
}

/**
 * Parse the billing response's `CycleEndTime` into epoch milliseconds.
 *
 * The upstream sends a zone-less `YYYY-MM-DD HH:mm:ss`; read as the running
 * machine's local time (what the official desktop client does), with a
 * round-trip check so a rolled-forward date reads as unknown.
 */
export function parseCycleEndTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s] = match
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as
    [number, number, number, number, number, number]
  const date = new Date(year, month - 1, day, hour, minute, second)
  const parsed = date.getTime()
  if (!Number.isFinite(parsed)) return undefined
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    return undefined
  }
  return parsed
}

/** Empty bucket, used whenever no account qualifies. */
const NO_EXPIRING_CREDIT: WorkBuddyExpiringCredits = { total: 0, packages: 0 }

function expiringWithin(
  accounts: readonly WorkBuddyCreditAccount[],
  nowMs: number,
  horizonMs: number,
): WorkBuddyExpiringCredits {
  return sumExpiring(accounts, end => end > nowMs && end - nowMs <= horizonMs)
}

function sumExpiring(
  accounts: readonly WorkBuddyCreditAccount[],
  matches: (endTimeMs: number) => boolean,
): WorkBuddyExpiringCredits {
  let total = 0
  let packages = 0
  let earliestEndTimeMs: number | undefined
  for (const account of accounts) {
    const end = account.endTimeMs
    if (end === undefined || account.remain <= 0) continue
    if (!matches(end)) continue
    total += account.remain
    packages += 1
    if (earliestEndTimeMs === undefined || end < earliestEndTimeMs) earliestEndTimeMs = end
  }
  if (packages === 0) return NO_EXPIRING_CREDIT
  return { total, packages, ...earliestEndTimeMs === undefined ? {} : { earliestEndTimeMs } }
}

function summariseExpiry(
  accounts: readonly WorkBuddyCreditAccount[],
  nowMs: number,
): { expiry?: WorkBuddyCreditExpiry } {
  if (!accounts.some((account) => account.endTimeMs !== undefined)) return {}
  const HOUR = 3600 * 1000
  const DAY = 24 * HOUR
  return {
    expiry: {
      within24h: expiringWithin(accounts, nowMs, DAY),
      within3d: expiringWithin(accounts, nowMs, 3 * DAY),
      within7d: expiringWithin(accounts, nowMs, 7 * DAY),
    },
  }
}

/**
 * Upstream HTTP client. One instance serves one variant; requests take the
 * credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /** Provenance of the most recent successful catalog fetch. */
  lastCatalog: { fetchedAtMs: number, source: string } | undefined

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    const region = regionOf(credential.domain)
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: region === 'global' ? prepareInternationalChatBody(bodyJson) : prepareCnChatBody(bodyJson),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = isObject(envelope.data) ? envelope.data : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * GET the personal model catalog (`/v3/config`, the product document the
   * desktop product itself fetches). The User-Agent decides which roster the
   * gateway serves: a CLI-shaped UA yields the CLI's roster (CN), an
   * App-shaped UA yields the App's roster (international).
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const international = regionOf(credential.domain) === 'global'
    const response = await fetch(`${chatBase(credential)}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
        'User-Agent': appCatalogUserAgent(regionOf(credential.domain)),
      },
      signal: signal === undefined
        ? AbortSignal.timeout(JSON_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // Two catalog shapes share this path: wrapped `{code,msg,data}` and the
    // product document bare at the top level.
    const data = isObject(envelope.data)
      ? envelope.data
      : 'models' in envelope.document || 'agents' in envelope.document ? envelope.document
      : {}
    // Promo badges exist only in the console document, so CN merges them in
    // (best-effort; failure costs the badges, never the catalog).
    const promoBadges = international ? undefined : await this.fetchPromoBadges(credential, signal)
    const models = parseModelCatalog(data, international, promoBadges)
    this.lastCatalog = {
      fetchedAtMs: Date.now(),
      source: international ? 'workbuddy-ai:app' : 'workbuddy:cli',
    }
    return models
  }

  /** Read the console catalog's promotional tags, by model id (CN only, best-effort). */
  private async fetchPromoBadges(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
    try {
      const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: 'application/json',
          Origin: originReferer(credential),
          Referer: `${originReferer(credential)}/`,
          'User-Agent': CLIENT_UA,
        },
        signal: signal === undefined
          ? AbortSignal.timeout(JSON_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
      })
      if (!response.ok) return undefined
      const envelope = await readEnvelope(response)
      const data = isObject(envelope.data) ? envelope.data : envelope.document
      const rawModels = Array.isArray(data['models']) ? data['models'] : []
      const badges = new Map<string, readonly string[]>()
      for (const model of rawModels) {
        if (!isObject(model)) continue
        const id = typeof model['id'] === 'string' ? model['id'] : ''
        if (id === '') continue
        const tags = Array.isArray(model['tags'])
          ? model['tags'].filter((tag): tag is string =>
            typeof tag === 'string' && tag.toLowerCase().startsWith(BADGE_PREFIX))
          : []
        if (tags.length > 0) badges.set(id, tags)
      }
      return badges.size === 0 ? undefined : badges
    } catch {
      return undefined
    }
  }

  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * CN enterprise accounts (`enterpriseId` non-empty) ask the enterprise
   * endpoint, which answers a single cycle quota; everyone else keeps the
   * personal endpoint. The region gate is load-bearing: the enterprise
   * endpoint is unverified for the global region.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    if (regionOf(credential.domain) === 'cn'
      && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      return await this.fetchEnterpriseCredits(credential)
    }
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = isObject(envelope.data) ? envelope.data : {}
    const data = isObject(responseWrapper['Response']) ? responseWrapper['Response'] as Record<string, unknown> : {}
    const inner = isObject(data['Data']) ? data['Data'] as Record<string, unknown> : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
    const accounts: WorkBuddyCreditAccount[] = []
    let total = 0
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const size = numberField('CycleCapacitySize')
      const cycleRemain = numberField('CycleCapacityRemain')
      const cycleUsed = numberField('CycleCapacityUsed')
      const capacityRemain = numberField('CapacityRemain')
      let remain: number
      if (size > 0) remain = cycleRemain
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
      else remain = capacityRemain
      if (remain < 0) remain = 0
      total += remain
      const endTimeMs = parseCycleEndTime(account['CycleEndTime'])
      accounts.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain,
        size: size > 0 ? size : numberField('CapacitySize'),
        ...endTimeMs === undefined ? {} : { endTimeMs },
      })
    }
    return { total, accounts, ...summariseExpiry(accounts, now.getTime()) }
  }

  /**
   * CN enterprise credit read: a single cycle quota instead of a package
   * list. The body is an empty object; identity travels in the headers. Both
   * field spellings the official client uses are accepted.
   */
  private async fetchEnterpriseCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const sources: Record<string, unknown>[] = []
    for (const candidate of [envelope.data, envelope.document]) {
      if (!isObject(candidate)) continue
      if (isObject(candidate['data'])) sources.push(candidate['data'])
      sources.push(candidate)
    }
    const numberAt = (source: Record<string, unknown>, key: string): number | undefined =>
      typeof source[key] === 'number' ? source[key] as number : undefined
    let limit: number | undefined
    let used: number | undefined
    let resetTime: string | undefined
    for (const source of sources) {
      const candidate = numberAt(source, 'limitNum') ?? numberAt(source, 'limit_num')
      if (candidate === undefined) continue
      limit = candidate
      used = numberAt(source, 'credit') ?? numberAt(source, 'used_num')
      if (typeof source['cycleResetTime'] === 'string' && source['cycleResetTime'] !== '') {
        resetTime = source['cycleResetTime'] as string
      }
      break
    }
    if (limit === undefined) {
      throw new Error('workbuddy enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num)')
    }
    // `-1` is the upstream's "no cap" marker, not a balance.
    if (limit === -1) {
      return {
        total: 0,
        accounts: [{ packageName: enterprisePackageName, remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...resetTime === undefined ? {} : { cycleResetTime: resetTime },
      }
    }
    if (used === undefined) {
      throw new Error('workbuddy enterprise billing response carried a quota limit but no recognised usage field (expected credit/used_num alongside limitNum/limit_num)')
    }
    let remain = limit - used
    if (remain < 0) remain = 0
    return {
      total: remain,
      accounts: [{ packageName: enterprisePackageName, remain, size: limit }],
      ...resetTime === undefined ? {} : { cycleResetTime: resetTime },
    }
  }
}

// ---------------------------------------------------------------------------
// SSE parsing (vscode-free so tests and the provider share it)
// ---------------------------------------------------------------------------

/**
 * Iterate the `data:` payloads of a `text/event-stream` body, stopping at
 * `[DONE]`. Non-data lines are ignored.
 */
export async function* iterateSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl).replace(/\r$/u, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).replace(/^ /u, '')
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
