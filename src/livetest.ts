/**
 * Live verification against the real desktop app and upstream (plain Node,
 * NOT part of the packaged extension). Per variant it verifies:
 * credential discovery → at-rest decryption → catalog → credits; with
 * `--chat` it additionally runs one minimal streaming conversation on a
 * (preferably free) model. Never prints tokens.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKBUDDY_VARIANTS } from './variant.js'
import { WorkBuddyCredentialStore } from './auth.js'
import { WorkBuddyUpstreamClient, iterateSseData, modelCostLabel, modelMultiplier, modelPricing, supportedEffortsFor } from './upstream.js'
import type { WorkBuddyUpstreamModel } from './upstream.js'
import { WorkBuddyAtRestKeyProvider } from './atrest.js'

const chat = process.argv.includes('--chat')
const stateDir = join(process.cwd(), '.livetest-state')

async function chatOnce(client: WorkBuddyUpstreamClient, credential: Parameters<WorkBuddyUpstreamClient['chatStream']>[0], model: WorkBuddyUpstreamModel): Promise<void> {
  const body = JSON.stringify({
    model: model.id,
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
  })
  const result = await client.chatStream(credential, body)
  if (!result.ok) {
    console.log(`chat FAILED (${String(result.status)} ${result.kind}): ${result.message.slice(0, 200)}`)
    return
  }
  let text = ''
  for await (const payload of iterateSseData(result.response.body!)) {
    try {
      const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
      const content = chunk.choices?.[0]?.delta?.content
      if (typeof content === 'string') text += content
    } catch {
      // skip keepalives
    }
  }
  console.log(`chat on ${model.id}: ${JSON.stringify(text.slice(0, 120))}`)
}

async function main(): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  for (const variant of WORKBUDDY_VARIANTS) {
    console.log(`\n=== ${variant.displayName} (${variant.id}) ===`)
    const client = new WorkBuddyUpstreamClient()
    const keyProvider = new WorkBuddyAtRestKeyProvider({ product: variant.electron })
    const store = new WorkBuddyCredentialStore({
      variant,
      ownDirectory: stateDir,
      refresh: credential => client.refreshToken(credential),
      keyProvider,
    })
    const status = await store.status()
    console.log(`sign-in: ${status.state}${status.reason === undefined ? '' : ` — ${status.reason}`}`)
    if (status.nickname !== undefined) console.log(`account: ${status.nickname} (domain ${status.domain ?? '?'})`)
    if (status.expiresAtMs !== undefined) console.log(`access token expires: ${new Date(status.expiresAtMs).toISOString()}`)
    if (status.state !== 'signed-in') continue
    console.log(`key helper: ${keyProvider.helperPath() ?? '(not needed — plaintext)'}`)
    const credential = await store.resolve()

    let models: readonly WorkBuddyUpstreamModel[] = []
    try {
      models = await client.fetchModels(credential)
      console.log(`catalog: ${String(models.length)} models (${client.lastCatalog?.source ?? '?'})`)
      console.log('  --- name (always visible) | pricing/multiplier (VS Code cost metadata) | efforts ---')
      for (const model of models) {
        const tags = modelCostLabel(model)
        const name = tags === '' ? model.name : `${model.name} · ${tags}`
        const pricing = modelPricing(model) ?? '-'
        const multiplier = modelMultiplier(model)
        const efforts = supportedEffortsFor(model)
        console.log(`  - ${name.padEnd(34)} pricing=${pricing.padEnd(7)} mult=${String(multiplier ?? '-').padEnd(5)} efforts=${efforts?.join(',') ?? '(none)'}`)
      }
    } catch (error: unknown) {
      console.log(`catalog FAILED: ${String(error)}`)
      continue
    }
    try {
      const credits = await client.fetchCredits(credential)
      console.log(`credits: ${credits.unlimited === true ? '∞ (enterprise, uncapped)' : credits.total.toLocaleString()}`)
      for (const account of credits.accounts) {
        console.log(`  - ${account.packageName}: ${account.unlimited === true ? '∞' : `${String(account.remain)}/${String(account.size)}`}`)
      }
    } catch (error: unknown) {
      console.log(`credits FAILED: ${String(error)}`)
    }
    if (chat) {
      const free = models.find(model => model.billing?.free === true)
      const pick = free ?? models[0]!
      console.log(`chat target: ${pick.id}${free === undefined ? '' : ' (free)'}`)
      await chatOnce(client, credential, pick)
    }
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
