/**
 * The VS Code `LanguageModelChatProvider` implementation for one WorkBuddy
 * variant: model listing (live catalog with a saved-catalog fallback), chat
 * streaming (OpenAI-compatible SSE translated into VS Code response parts),
 * and rough token counting.
 */

import * as vscode from 'vscode'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LanguageModelChatInformation,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  PrepareLanguageModelChatModelOptions,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode'
import type { WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyVariant } from './variant.js'
import {
  WorkBuddyUpstreamClient,
  extractDisplayErrorMessage,
  iterateSseData,
  modelCostLabel,
  modelMultiplier,
  modelPricing,
  modelWithCurrentPromotion,
  priceCategoryFor,
  supportedEffortsFor,
} from './upstream.js'
import type { WorkBuddyUpstreamModel } from './upstream.js'
import {
  convertMessages,
  convertTools,
  isDataPart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  flattenToolResultContent,
  mergeToolCallFragment,
  parseToolCallArguments,
} from './convert.js'
import type { ChatPartLike, OpenAiChunk, ToolCallAccumulator } from './convert.js'

/** Which document the model list currently comes from. */
export type CatalogSource = 'live' | 'saved' | 'none'

/** Provider state surfaced by the manage command and the status bar. */
export interface WorkBuddyProviderState {
  signedIn: boolean
  /** Why not signed in, when diagnosable. */
  reason?: string
  modelCount: number
  catalogSource: CatalogSource
  lastCatalogAtMs?: number
  catalogError?: string
}

const CATALOG_FORMAT_VERSION = 1

interface SavedCatalog {
  version: typeof CATALOG_FORMAT_VERSION
  savedAtMs: number
  models: readonly WorkBuddyUpstreamModel[]
}

function openAiErrorDetail(result: { status: number, kind: string, message: string }): string {
  return extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400)
}

export class WorkBuddyChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event

  private infoCache: LanguageModelChatInformation[] | undefined
  private stateValue: WorkBuddyProviderState

  constructor(
    private readonly variant: WorkBuddyVariant,
    private readonly store: WorkBuddyCredentialStore,
    private readonly client: WorkBuddyUpstreamClient,
    private readonly storageDirectory: string,
  ) {
    this.stateValue = { signedIn: false, modelCount: 0, catalogSource: 'none' }
  }

  get state(): WorkBuddyProviderState {
    return this.stateValue
  }

  /** The credential store, for the manage command. */
  get credentialStore(): WorkBuddyCredentialStore {
    return this.store
  }

  private updateState(patch: Partial<WorkBuddyProviderState>): void {
    this.stateValue = { ...this.stateValue, ...patch }
  }

  /** Drop caches and tell VS Code to re-query the model list. */
  reload(): void {
    this.infoCache = undefined
    this._onDidChange.fire()
  }

  async provideLanguageModelChatInformation(
    _options: PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    if (this.infoCache !== undefined) return this.infoCache
    let credential
    try {
      credential = await this.store.resolve()
    } catch (error: unknown) {
      this.updateState({ signedIn: false, reason: error instanceof Error ? error.message : String(error) })
      return []
    }
    this.updateState({ signedIn: true, reason: undefined })
    try {
      const models = await this.client.fetchModels(credential, asAbortSignal(token))
      await this.persistCatalog(models)
      this.updateState({
        modelCount: models.length,
        catalogSource: 'live',
        lastCatalogAtMs: Date.now(),
        catalogError: undefined,
      })
      this.infoCache = models.map(model => this.toInformation(modelWithCurrentPromotion(model)))
      return this.infoCache
    } catch (error: unknown) {
      // The upstream catalog can change shape without notice; the last
      // successful catalog for this account keeps the group alive.
      const saved = await this.loadSavedCatalog()
      if (saved !== undefined) {
        this.updateState({
          modelCount: saved.models.length,
          catalogSource: 'saved',
          lastCatalogAtMs: saved.savedAtMs,
          catalogError: error instanceof Error ? error.message : String(error),
        })
        this.infoCache = saved.models.map(model => this.toInformation(modelWithCurrentPromotion(model)))
        return this.infoCache
      }
      this.updateState({
        modelCount: 0,
        catalogSource: 'none',
        catalogError: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  private toInformation(model: WorkBuddyUpstreamModel): LanguageModelChatInformation {
    const maxInput = model.maxInputTokens !== undefined && model.maxInputTokens > 0
      ? model.maxInputTokens
      : Math.max(1, model.contextWindow - model.maxTokens)
    const multiplier = modelMultiplier(model)
    const priceCategory = priceCategoryFor(multiplier)
    const pricing = modelPricing(model)
    const efforts = supportedEffortsFor(model)
    const tags = modelCostLabel(model)
    const base: LanguageModelChatInformation = {
      id: model.id,
      // The rate rides in the name. VS Code's own cost badge is gated on
      // Copilot usage-based billing (`isUBB`), which a BYOK user does not
      // have, so nothing VS Code renders from metadata is guaranteed visible;
      // the name always is. Matches dsh-workbuddy-connect's display.
      name: tags === '' ? model.name : `${model.name} · ${tags}`,
      family: this.variant.id,
      version: '1',
      maxInputTokens: maxInput,
      maxOutputTokens: model.maxTokens,
      tooltip: `${model.id} · context ${String(model.contextWindow)} · max output ${String(model.maxTokens)} · via ${this.variant.displayName}`
        + (tags === '' ? '' : ` · credits ${tags}`),
      ...tags === '' ? {} : { detail: tags },
      capabilities: {
        imageInput: model.supportsImages,
        // Tool calling is required for the model to appear in agent mode; the
        // upstream speaks the OpenAI tools protocol for its whole roster.
        toolCalling: true,
      },
    }
    // Undeclared-but-read metadata. VS Code's ExtHost copies these fields
    // straight off the provider's model object into the model metadata the
    // workbench renders (see `$provideLanguageModelChatInfo`), even though
    // @types/vscode 1.140 does not declare them on
    // LanguageModelChatInformation:
    //   - `pricing` (string, e.g. `0.79x`) is what VS Code actually renders for
    //     a model's cost, and `multiplierNumeric` is its "has a rate" flag —
    //     supplying the number without the string renders nothing;
    //   - `configurationSchema.properties.reasoningEffort.enum` is what puts
    //     the Thinking Effort submenu on the model.
    // Only fields with real data are attached.
    return {
      ...base,
      ...pricing === undefined ? {} : { pricing },
      ...multiplier === undefined ? {} : { multiplierNumeric: multiplier },
      ...priceCategory === undefined ? {} : { priceCategory },
      ...efforts === undefined ? {} : {
        configurationSchema: {
          type: 'object',
          properties: {
            reasoningEffort: {
              type: 'string',
              // `group: 'navigation'` is what the model picker matches on
              // (getModelConfigProperty skips properties without its group).
              group: 'navigation',
              title: 'Thinking Effort',
              enum: [...efforts],
              ...model.reasoning?.defaultEffort === undefined ? {} : { default: model.reasoning.defaultEffort },
            },
          },
        },
      },
    } as LanguageModelChatInformation
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const credential = await this.store.resolve()
    const body: Record<string, unknown> = {
      model: model.id,
      messages: convertMessages(messages.map(message => ({
        role: message.role,
        content: message.content as readonly ChatPartLike[],
      }))),
    }
    const tools = convertTools(options.tools)
    if (tools !== undefined) {
      body['tools'] = tools
      // `toolMode: Required` maps to the string form `required`; the upstream
      // rejects the object spelling.
      body['tool_choice'] = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
    }
    // The Thinking Effort submenu's selection arrives as
    // `options.modelConfiguration.reasoningEffort` (ExtHost forwards the
    // workbench's `configuration` under that name). Only canonical WorkBuddy
    // values are forwarded; anything else — including the absence of a
    // selection — leaves `reasoning_effort` off entirely, which is the one
    // form measured good on every model (the upstream rejects `off`).
    const configuration = (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration
    const effort = configuration?.['reasoningEffort'] ?? options.modelOptions?.['reasoning_effort']
    if (typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      body['reasoning_effort'] = effort
    }

    const controller = new AbortController()
    const cancellation = token.onCancellationRequested(() => controller.abort())
    const result = await this.client.chatStream(credential, JSON.stringify(body), controller.signal)
    try {
      if (!result.ok) {
        throw new Error(
          `WorkBuddy ${result.kind} (http ${String(result.status)}): ${openAiErrorDetail(result)}`,
        )
      }
      const toolCalls = new Map<number, ToolCallAccumulator>()
      let flushed = false
      const flushToolCalls = (): void => {
        if (flushed) return
        flushed = true
        for (const acc of [...toolCalls.keys()].sort((a, b) => a - b).map(key => toolCalls.get(key)!)) {
          if (acc.id === '' || acc.name === '') continue
          progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, parseToolCallArguments(acc.args)))
        }
      }

      const bodyStream = result.response.body
      if (bodyStream === null) throw new Error('WorkBuddy upstream returned an empty stream')
      for await (const payload of iterateSseData(bodyStream)) {
        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(payload) as OpenAiChunk
        } catch {
          continue
        }
        if (chunk.error !== undefined) {
          const message = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
          throw new Error(`WorkBuddy stream error: ${message}`)
        }
        const choice = chunk.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta
        if (typeof delta?.content === 'string' && delta.content !== '') {
          progress.report(new vscode.LanguageModelTextPart(delta.content))
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const fragment of delta.tool_calls as Array<{ index?: number, id?: unknown, function?: { name?: unknown, arguments?: unknown } }>) {
            mergeToolCallFragment(toolCalls, fragment)
          }
        }
        if (choice.finish_reason === 'tool_calls') flushToolCalls()
      }
      flushToolCalls()
    } finally {
      cancellation.dispose()
    }
  }

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') return Math.ceil(text.length / 4)
    let chars = 0
    let images = 0
    for (const part of text.content) {
      if (isTextPart(part)) {
        chars += part.value.length
      } else if (isDataPart(part)) {
        if (part.mimeType.startsWith('image/')) images += 1
        else chars += part.data.length
      } else if (isToolCallPart(part)) {
        chars += JSON.stringify(part.input).length
      } else if (isToolResultPart(part)) {
        chars += flattenToolResultContent(part.content).length
      }
    }
    // ponytail: chars/4 estimate + flat image cost; a real tokenizer is the upgrade path.
    return Math.ceil(chars / 4) + images * 1000
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  private catalogPath(): string {
    return join(this.storageDirectory, this.variant.catalogFilename)
  }

  private async persistCatalog(models: readonly WorkBuddyUpstreamModel[]): Promise<void> {
    try {
      const document: SavedCatalog = { version: CATALOG_FORMAT_VERSION, savedAtMs: Date.now(), models }
      await mkdir(this.storageDirectory, { recursive: true })
      await writeFile(this.catalogPath(), JSON.stringify(document), { mode: 0o600 })
    } catch {
      // A read-only storage directory must not fail a live catalog.
    }
  }

  private async loadSavedCatalog(): Promise<SavedCatalog | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.catalogPath(), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const document = parsed as Record<string, unknown>
      if (document['version'] !== CATALOG_FORMAT_VERSION || !Array.isArray(document['models'])) return undefined
      return { version: CATALOG_FORMAT_VERSION, savedAtMs: typeof document['savedAtMs'] === 'number' ? document['savedAtMs'] : 0, models: document['models'] as readonly WorkBuddyUpstreamModel[] }
    } catch {
      return undefined
    }
  }
}

/** Adapt a VS Code cancellation token into an AbortSignal for fetch. */
function asAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
  if (token.isCancellationRequested) return AbortSignal.abort()
  const controller = new AbortController()
  const disposable = token.onCancellationRequested(() => controller.abort())
  const signal = controller.signal
  signal.addEventListener('abort', () => disposable.dispose(), { once: true })
  return signal
}
