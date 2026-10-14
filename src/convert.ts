/**
 * VS Code chat-request → OpenAI chat-completions conversion, vscode-free so
 * the wire translation is unit-testable under plain Node. Parts are
 * duck-typed: {@link ChatPartLike} mirrors the shapes of
 * `LanguageModelTextPart` / `LanguageModelToolCallPart` /
 * `LanguageModelToolResultPart` / `LanguageModelDataPart`.
 */

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

export type OpenAiContentPart =
  | { type: 'text', text: string }
  | { type: 'image_url', image_url: { url: string } }

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAiContentPart[]
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

/** A VS Code chat request part, duck-typed for unit tests. */
export type ChatPartLike =
  | { value: string }                                   // LanguageModelTextPart
  | { callId: string, name: string, input: object }     // LanguageModelToolCallPart
  | { callId: string, content: unknown[] }              // LanguageModelToolResultPart
  | { mimeType: string, data: Uint8Array }              // LanguageModelDataPart
  | unknown

export function isTextPart(part: ChatPartLike): part is { value: string } {
  return typeof part === 'object' && part !== null
    && typeof (part as { value?: unknown }).value === 'string'
    && !('callId' in part) && !('mimeType' in part)
}

export function isToolCallPart(part: ChatPartLike): part is { callId: string, name: string, input: object } {
  return typeof part === 'object' && part !== null
    && typeof (part as { callId?: unknown }).callId === 'string'
    && typeof (part as { name?: unknown }).name === 'string'
    && typeof (part as { input?: unknown }).input === 'object'
}

export function isToolResultPart(part: ChatPartLike): part is { callId: string, content: unknown[] } {
  return typeof part === 'object' && part !== null
    && typeof (part as { callId?: unknown }).callId === 'string'
    && Array.isArray((part as { content?: unknown }).content)
}

export function isDataPart(part: ChatPartLike): part is { mimeType: string, data: Uint8Array } {
  return typeof part === 'object' && part !== null
    && typeof (part as { mimeType?: unknown }).mimeType === 'string'
    && (part as { data?: unknown }).data instanceof Uint8Array
}

/** Flatten a tool result's content parts into a single text string. */
export function flattenToolResultContent(content: readonly unknown[]): string {
  const pieces: string[] = []
  for (const item of content) {
    if (isTextPart(item)) {
      pieces.push(item.value)
    } else if (isDataPart(item) && !item.mimeType.startsWith('image/')) {
      pieces.push(Buffer.from(item.data).toString('utf8'))
    } else if (typeof item === 'string') {
      pieces.push(item)
    }
    // Images and opaque parts are dropped: the WorkBuddy upstream's tool
    // result channel is text.
  }
  return pieces.join('\n')
}

function buildContent(texts: readonly string[], images: readonly OpenAiContentPart[]): string | OpenAiContentPart[] | undefined {
  if (images.length === 0) {
    const joined = texts.join('')
    return joined === '' ? undefined : joined
  }
  const parts: OpenAiContentPart[] = []
  const text = texts.join('')
  if (text !== '') parts.push({ type: 'text', text })
  parts.push(...images)
  return parts
}

/** Convert VS Code chat request messages into OpenAI chat-completions messages. */
export function convertMessages(
  messages: readonly { role: number, content: readonly ChatPartLike[] }[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  for (const message of messages) {
    // LanguageModelChatMessageRole.Assistant === 2; User === 1.
    const isAssistant = message.role === 2
    const texts: string[] = []
    const images: OpenAiContentPart[] = []
    const toolCalls: OpenAiToolCall[] = []
    const toolResults: { callId: string, content: string }[] = []
    for (const part of message.content) {
      if (isToolCallPart(part)) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        })
        continue
      }
      if (isToolResultPart(part)) {
        toolResults.push({ callId: part.callId, content: flattenToolResultContent(part.content) })
        continue
      }
      if (isDataPart(part)) {
        if (part.mimeType.startsWith('image/')) {
          const base64 = Buffer.from(part.data).toString('base64')
          images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${base64}` } })
        } else {
          texts.push(Buffer.from(part.data).toString('utf8'))
        }
        continue
      }
      if (isTextPart(part)) {
        texts.push(part.value)
      }
    }
    // Tool results travel as separate `role: "tool"` messages, in order,
    // before the same user message's text.
    for (const result of toolResults) {
      out.push({ role: 'tool', tool_call_id: result.callId, content: result.content })
    }
    if (isAssistant) {
      if (toolCalls.length > 0) {
        const content = texts.join('')
        out.push({ role: 'assistant', ...(content === '' ? {} : { content }), tool_calls: toolCalls })
      } else {
        const content = buildContent(texts, images)
        if (content !== undefined) out.push({ role: 'assistant', content })
      }
    } else {
      const content = buildContent(texts, images)
      if (content !== undefined) out.push({ role: 'user', content })
    }
  }
  return out
}

/** One tool description as the VS Code API shapes it. */
export interface ToolLike {
  name: string
  description: string
  inputSchema?: object
}

/** Convert VS Code tools into the OpenAI `tools` array. */
export function convertTools(tools: readonly ToolLike[] | undefined): Array<{ type: 'function', function: { name: string, description: string, parameters: object } }> | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }))
}

/** One streamed OpenAI chunk, loosely typed. */
export interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: unknown, reasoning_content?: unknown, tool_calls?: unknown }
    finish_reason?: unknown
  }>
  error?: { message?: unknown }
}

/** Accumulator for one streamed tool call, keyed by its fragment index. */
export interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

/** Merge one streamed tool-call fragment into the accumulator map. */
export function mergeToolCallFragment(
  map: Map<number, ToolCallAccumulator>,
  fragment: { index?: number, id?: unknown, function?: { name?: unknown, arguments?: unknown } },
): void {
  const index = typeof fragment.index === 'number' ? fragment.index : 0
  const acc = map.get(index) ?? { id: '', name: '', args: '' }
  if (typeof fragment.id === 'string' && fragment.id !== '') acc.id = fragment.id
  if (typeof fragment.function?.name === 'string' && fragment.function.name !== '') acc.name = fragment.function.name
  if (typeof fragment.function?.arguments === 'string') acc.args += fragment.function.arguments
  map.set(index, acc)
}

/** Parse accumulated tool-call arguments into an object input. */
export function parseToolCallArguments(args: string): object {
  try {
    return JSON.parse(args === '' ? '{}' : args) as object
  } catch {
    return { _raw: args }
  }
}
