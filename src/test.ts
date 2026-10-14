/**
 * Self-check suite, runnable with plain `node dist/test.js` (no VS Code, no
 * framework): envelope roundtrip, auth parsing, catalog parsing, chat body
 * normalization, registry parsing, message conversion, and SSE parsing.
 */

import {
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  openAuthField,
  sealAuthFieldForTest,
  parseAtRestPayload,
  deriveProtectorKey,
  parseWindowsRegistryOutput,
  parseWindowsDisplayIcon,
} from './atrest.js'
import { parseWorkBuddyAuth } from './auth.js'
import { convertTools, convertMessages, flattenToolResultContent } from './convert.js'
import {
  iterateSseData,
  modelCostLabel,
  modelMultiplier,
  modelPricing,
  modelWithCurrentPromotion,
  normalizeCredits,
  parseCycleEndTime,
  parseModelCatalog,
  prepareCnChatBody,
  prepareChatBody,
  prepareInternationalChatBody,
  priceCategoryFor,
  supportedEffortsFor,
} from './upstream.js'

let failures = 0
let checks = 0

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

function eq<T>(name: string, actual: T, expected: T): void {
  const equal = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, equal, equal ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- envelope roundtrip -----------------------------------------------------

{
  const key = Buffer.alloc(32, 7)
  const sealed = sealAuthFieldForTest(key, 'token-abc')
  const classification = classifyDesktopAuthDocument(
    JSON.stringify({ auth: { accessToken: sealed, refreshToken: 'plain-refresh' } }),
  )
  eq('classify encrypted', classification.format, 'encrypted')
  if (classification.format === 'encrypted') {
    eq('one wrapped field', classification.wrapped.fields.length, 1)
    eq('wrapped field name', classification.wrapped.fields[0]!.field, 'accessToken')
    const opened = openAuthField(key, classification.wrapped.fields[0]!.envelope)
    eq('open sealed field', opened, 'token-abc')
  }
  const wrongKey = Buffer.alloc(32, 9)
  check('wrong key fails', openAuthField(wrongKey, {
    suite: 1, keyId: 'a'.repeat(16),
    nonce: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), ciphertext: Buffer.from('x'.repeat(40)),
  }) === undefined)
}

// --- AAD determinism (transcription guard) -----------------------------------

{
  const aad = buildAuthenticatedContextAad('0123456789abcdef', 1)
  // WB-AAD\0 | 1 | lp"WBEV1" | lp"sym-v1" | u32(1) | lp"0123456789abcdef" | 02 | 00 | 00
  const expected = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    Buffer.from([0, 0, 0, 5]), Buffer.from('WBEV1'),
    Buffer.from([0, 0, 0, 6]), Buffer.from('sym-v1'),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from([0, 0, 0, 16]), Buffer.from('0123456789abcdef'),
    Buffer.from([2, 0, 0]),
  ])
  eq('AAD layout', aad.toString('hex'), expected.toString('hex'))
}

// --- classification ----------------------------------------------------------

{
  eq('classify absent', classifyDesktopAuthDocument('   \n ').format, 'absent')
  eq('classify not json', classifyDesktopAuthDocument('nope').format, 'unrecognized')
  eq('classify plaintext', classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: 'x', refreshToken: 'y' } })).format, 'plaintext')
  const brokenEnvelope = JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: '!!!' } } })
  eq('classify broken envelope', classifyDesktopAuthDocument(brokenEnvelope).format, 'unrecognized')
}

// --- payload ------------------------------------------------------------------

{
  const secret = Buffer.alloc(32, 3).toString('base64')
  eq('payload ok', parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: secret }))?.atRestSecretKey, secret)
  check('payload wrong version', parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: secret })) === undefined)
  check('payload zero secret', parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') })) === undefined)
  check('payload short secret', parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(16, 1).toString('base64') })) === undefined)
  eq('derive key', deriveProtectorKey('abc').length, 32)
}

// --- auth parsing --------------------------------------------------------------

{
  const nested = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: 'A', refreshToken: 'R', expiresAt: 1750000000, domain: 'workbuddy.ai' },
    account: { uid: 'u1', enterpriseId: 'e1', nickname: 'nick' },
  }))
  check('auth nested', nested !== undefined && nested.accessToken === 'A' && nested.uid === 'u1' && nested.enterpriseId === 'e1')
  eq('auth seconds to ms', nested?.expiresAtMs, 1750000000 * 1000)
  const flat = parseWorkBuddyAuth(JSON.stringify({ accessToken: 'A2', uid: 'u2' }))
  check('auth flat', flat !== undefined && flat.accessToken === 'A2' && flat.uid === 'u2')
  check('auth no token', parseWorkBuddyAuth('{}') === undefined)
}

// --- catalog parsing -------------------------------------------------------------

{
  const document = {
    models: [
      { id: 'm1', name: 'Model One', maxInputTokens: 100000, maxOutputTokens: 8192, supportsImages: true },
      { id: 'm2', name: 'Model Two', maxInputTokens: 0, maxOutputTokens: 0 },
      { id: 'm3', name: 'Model Three', maxInputTokens: 50000, maxOutputTokens: 4096, disabled: true },
      { id: 'm4', name: 'Model Four', maxInputTokens: 50000, maxOutputTokens: 4096, credits: 'x0.79 credits', tags: ['badge:限时免费:#FF0000'] },
    ],
    agents: [{ name: 'cli', models: ['m1', 'm2', 'm3', 'm4', 'm-retired'] }],
  }
  const models = parseModelCatalog(document, false, new Map([['m1', ['badge:夜间折扣:#1E90FF']]]))
  eq('catalog count', models.length, 2)
  eq('catalog first id', models[0]!.id, 'm1')
  eq('catalog images', models[0]!.supportsImages, true)
  check('catalog badge merge', models[0]!.billing?.badges?.includes('夜间折扣') === true)
  eq('catalog credits normalized', normalizeCredits(models[1]!.billing?.credits), 'x0.79')
  eq('catalog free flag', models[1]!.billing?.free, false)

  const international = parseModelCatalog({
    models: [{
      id: 'g1', name: 'G One', maxInputTokens: 1000, maxOutputTokens: 100,
      contextWindow: { defaultLength: 2000, supportedLengths: [2000, 4000] },
    }],
    agents: [{ name: 'cli', models: ['g1'] }],
    modelPromotions: [{
      enabled: true, modelIds: ['g1'],
      schedule: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' },
      discount: { displayMode: 'replace', factor: 0 },
      badge: { label: 'Free now' },
      priority: 1,
    }],
  }, true)
  eq('intl context window', international[0]!.contextWindow, 2000)
  eq('intl max input', international[0]!.maxInputTokens, 1000)
  check('intl windows', international[0]!.supportedContextWindows?.join(',') === '2000,4000')
  const promoted = modelWithCurrentPromotion(international[0]!, Date.parse('2026-06-01T00:00:00Z'))
  eq('promotion free', promoted.billing?.free, true)
  eq('promotion label', promoted.billing?.badges?.includes('Free now'), true)
  const expired = modelWithCurrentPromotion(international[0]!, Date.parse('2100-01-01T00:00:00Z'))
  eq('expired rate unknown', expired.billing?.rateUnknown, true)

  try {
    parseModelCatalog({ models: [], agents: [] })
    check('catalog empty roster throws', false)
  } catch {
    check('catalog empty roster throws', true)
  }
}

// --- chat body preparation ---------------------------------------------------------

{
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm',
    stream: false,
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
    tool_choice: { type: 'function', function: { name: 'fn1' } },
  }))) as Record<string, unknown>
  eq('stream forced', prepared['stream'], true)
  eq('developer rewritten', (prepared['messages'] as Array<{ role: string }>)[0]!.role, 'system')
  eq('tool_choice flattened', prepared['tool_choice'], 'fn1')

  eq('tool_choice none drops tools', JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: 'none', tools: [1] })))['tools'], undefined)
  eq('tool_choice required', JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'required' } })))['tool_choice'], 'required')
  eq('tool_choice auto', JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))['tool_choice'], 'auto')

  const cn = JSON.parse(prepareCnChatBody(JSON.stringify({ model: 'm', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }] }))) as Record<string, unknown>
  check('cn strips off', !('reasoning_effort' in cn))
  eq('cn keeps system position', (cn['messages'] as Array<{ role: string }>)[0]!.role, 'user')
  // The CN gateway rejects non-streaming requests with 400 code 11101, so
  // `stream: true` must be injected even when the caller omitted it.
  eq('cn forces stream', cn['stream'], true)

  const intl = JSON.parse(prepareInternationalChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))) as Record<string, unknown>
  eq('intl prepends system', (intl['messages'] as Array<{ role: string }>)[0]!.role, 'system')
  const intlKeeps = JSON.parse(prepareInternationalChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'custom' }, { role: 'user', content: 'hi' }] }))) as Record<string, unknown>
  eq('intl keeps existing system', (intlKeeps['messages'] as Array<{ role: string, content: string }>)[0]!.content, 'custom')
}

// --- credits helpers ------------------------------------------------------------

{
  eq('cycle end ok', parseCycleEndTime('2026-10-13 12:34:56'), new Date(2026, 9, 13, 12, 34, 56).getTime())
  check('cycle end feb30', parseCycleEndTime('2026-02-30 00:00:00') === undefined)
  check('cycle end junk', parseCycleEndTime('nope') === undefined)
  eq('credits bare', normalizeCredits('x0.79'), 'x0.79')
  eq('credits with unit', normalizeCredits('x0.79 credits'), 'x0.79')
  eq('credits only unit', normalizeCredits('credits'), undefined)
}

// --- cost label (the model-picker cost column) --------------------------------

{
  const base = { id: 'm', name: 'Model', contextWindow: 1000, maxTokens: 100, supportsImages: false }
  eq('cost label rate', modelCostLabel({ ...base, billing: { credits: 'x0.79 credits', free: false } }), 'x0.79')
  eq('cost label free', modelCostLabel({ ...base, billing: { credits: 'x0.00', free: true } }), 'x0.00')
  eq('cost label badges', modelCostLabel({
    ...base,
    billing: { credits: 'x0.00', free: true, badges: ['限时免费'] },
  }), 'x0.00 · 限时免费')
  eq('cost label unknown rate', modelCostLabel({ ...base, billing: { free: false, rateUnknown: true } }), 'rate unknown')
  eq('cost label absent billing', modelCostLabel(base), '')

  // The cost column's own metadata: multiplier + tier.
  eq('multiplier from x0.79', modelMultiplier({ ...base, billing: { credits: 'x0.79 credits', free: false } }), 0.79)
  eq('multiplier free', modelMultiplier({ ...base, billing: { credits: 'x0.00', free: true } }), 0)
  eq('multiplier unknown rate', modelMultiplier({ ...base, billing: { free: false, rateUnknown: true } }), undefined)
  eq('multiplier absent', modelMultiplier(base), undefined)
  // VS Code renders `pricing` (a string); the numeric multiplier alone shows nothing.
  eq('pricing string', modelPricing({ ...base, billing: { credits: 'x0.79 credits', free: false } }), '0.79x')
  eq('pricing free', modelPricing({ ...base, billing: { credits: 'x0.00', free: true } }), '0x')
  eq('pricing unknown rate', modelPricing({ ...base, billing: { free: false, rateUnknown: true } }), undefined)
  eq('pricing absent', modelPricing(base), undefined)
  eq('tier low', priceCategoryFor(0), 'low')
  eq('tier low boundary', priceCategoryFor(0.49), 'low')
  eq('tier medium', priceCategoryFor(0.5), 'medium')
  eq('tier medium high edge', priceCategoryFor(0.99), 'medium')
  eq('tier high', priceCategoryFor(1), 'high')
  eq('tier very high', priceCategoryFor(2), 'very_high')
  eq('tier absent', priceCategoryFor(undefined), undefined)

  // The Thinking Effort submenu appears only for upstream-declared efforts.
  eq('efforts declared', supportedEffortsFor({
    ...base,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true, supportedEfforts: ['low', 'high', 'max'] },
  }), ['low', 'high', 'max'])
  eq('efforts undeclared', supportedEffortsFor({
    ...base,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
  }), undefined)
  eq('efforts no reasoning row', supportedEffortsFor(base), undefined)
}

// --- windows registry parsing -------------------------------------------------------

{
  const regOutput = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID-1}',
    '    DisplayName    REG_SZ    WorkBuddy AI 5.7.6',
    '    DisplayIcon    REG_SZ    "C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe",0',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID-2}',
    '    DisplayName    REG_SZ    Something Else',
    '    DisplayIcon    REG_SZ    "C:\\other\\x.exe",0',
  ].join('\r\n')
  const parsed = parseWindowsRegistryOutput(regOutput, /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u)
  eq('registry candidates', parsed.candidates, ['C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe'])
  eq('registry incomplete', parsed.incomplete, false)

  eq('displayicon quoted', parseWindowsDisplayIcon('"C:\\a\\b.exe",0'), 'C:\\a\\b.exe')
  eq('displayicon bare', parseWindowsDisplayIcon('C:\\a\\b.exe,1'), 'C:\\a\\b.exe')
  check('displayicon non-exe', parseWindowsDisplayIcon('"C:\\a\\b.txt"') === undefined)
  const missingIcon = parseWindowsRegistryOutput(
    ['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID-1}', '    DisplayName    REG_SZ    WorkBuddy 5.6.2'].join('\r\n'),
    /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
  )
  eq('missing icon incomplete', missingIcon.incomplete, true)
}

// --- message conversion ----------------------------------------------------------

{
  const messages = [
    { role: 1, content: [{ value: 'hello' }] },
    { role: 2, content: [{ value: 'I will call a tool' }, { callId: 'c1', name: 'readFile', input: { path: 'x' } }] },
    { role: 1, content: [{ callId: 'c1', content: [{ value: 'file contents' }] }, { value: 'continue' }] },
    { role: 1, content: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }, { value: 'what is this' }] },
  ]
  const converted = convertMessages(messages as Parameters<typeof convertMessages>[0])
  eq('converted count', converted.length, 5)
  eq('user text', converted[0], { role: 'user', content: 'hello' })
  check('assistant tool call', converted[1]!.tool_calls?.[0]?.function.name === 'readFile'
    && converted[1]!.tool_calls?.[0]?.id === 'c1'
    && JSON.parse(converted[1]!.tool_calls?.[0]?.function.arguments ?? '')?.path === 'x')
  eq('tool result', converted[2], { role: 'tool', tool_call_id: 'c1', content: 'file contents' })
  eq('user followup', converted[3], { role: 'user', content: 'continue' })
  const imageMessage = converted[4]!
  check('image part', Array.isArray(imageMessage.content)
    && imageMessage.content[0]!.type === 'text'
    && imageMessage.content[0]!.text === 'what is this'
    && imageMessage.content[1]!.type === 'image_url'
    && imageMessage.content[1]!.image_url.url.startsWith('data:image/png;base64,'))
  eq('flatten tool result', flattenToolResultContent([{ value: 'a' }, { value: 'b' }]), 'a\nb')

  const tools = convertTools([{ name: 't', description: 'd', inputSchema: { type: 'object' } }])
  check('tools converted', tools?.[0]?.function.name === 't' && tools[0].type === 'function')
  eq('no tools', convertTools(undefined), undefined)
}

// --- SSE parsing -------------------------------------------------------------------

async function sseTest(): Promise<void> {
  const payloads = [
    JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":""' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]
  const raw = `data: ${payloads[0]!}\n\n`
    + `data: ${payloads[1]!}\n\n`
    + ': keepalive comment\n\n'
    + `data: ${payloads[2]!}\n\n`
    + 'data: [DONE]\n\n'
    + 'data: {"choices":[{"delta":{"content":"after done"}}]}\n\n'
  const bytes = new TextEncoder().encode(raw)
  // Cut into irregular chunks, including mid-line splits, so the incremental
  // buffering is exercised.
  const cuts = [7, 45, 46, 100, 101, bytes.length]
  const chunks: Uint8Array[] = []
  let start = 0
  for (const cut of cuts) {
    if (start >= bytes.length) break
    chunks.push(bytes.slice(start, cut))
    start = cut
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const collected: string[] = []
  for await (const payload of iterateSseData(stream)) collected.push(payload)
  eq('sse payload count', collected.length, 3)
  eq('sse first', JSON.parse(collected[0]!).choices[0].delta.content, 'Hello')
  const toolChunk = JSON.parse(collected[1]!)
  eq('sse tool name', toolChunk.choices[0].delta.tool_calls[0].function.name, 'f')
  eq('sse tool args', toolChunk.choices[0].delta.tool_calls[0].function.arguments, '{"a":""')
  eq('sse done stops iteration', JSON.parse(collected[2]!).choices[0].finish_reason, 'tool_calls')
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  await sseTest()
  console.log(`${String(checks)} checks, ${failures === 0 ? 'no' : String(failures)} failures`)
  if (failures > 0) process.exitCode = 1
}

void main()
