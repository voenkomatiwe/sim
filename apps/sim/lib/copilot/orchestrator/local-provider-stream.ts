import { createLogger } from '@sim/logger'
import type { StreamingExecution } from '@/executor/types'
import { executeProviderRequest } from '@/providers'
import type { Message, ProviderRequest } from '@/providers/types'
import type { SSEEvent } from '@/lib/copilot/orchestrator/types'
import { runStreamLoopFromEvents } from '@/lib/copilot/orchestrator/stream-core'
import type { ExecutionContext, OrchestratorOptions, StreamingContext } from '@/lib/copilot/orchestrator/types'

const logger = createLogger('CopilotLocalProvider')

const LOCAL_PROVIDERS = ['ollama', 'vllm'] as const
const LOCAL_PROVIDER_PREFIXES = ['ollama/', 'vllm/'] as const

export function isLocalCopilotModel(model: string, provider?: string): boolean {
  if (provider && LOCAL_PROVIDERS.includes(provider.toLowerCase() as (typeof LOCAL_PROVIDERS)[number])) {
    return true
  }
  if (!model || typeof model !== 'string') return false
  const lower = model.toLowerCase()
  return LOCAL_PROVIDER_PREFIXES.some((p) => lower.startsWith(p))
}

export function getLocalProviderAndModel(
  model: string,
  providerFromPayload?: string
): { provider: string; modelId: string } | null {
  const provider = providerFromPayload?.toLowerCase()
  if (provider === 'ollama') {
    const modelId = model?.trim() || 'llama3.2'
    return { provider: 'ollama', modelId: modelId.startsWith('ollama/') ? modelId.slice(7).trim() || 'llama3.2' : modelId }
  }
  if (provider === 'vllm') {
    const modelId = model?.trim() || ''
    return { provider: 'vllm', modelId: modelId.startsWith('vllm/') ? modelId.slice(5).trim() : modelId }
  }
  if (!model || typeof model !== 'string') return null
  const lower = model.toLowerCase()
  if (lower.startsWith('ollama/')) {
    return { provider: 'ollama', modelId: model.slice(7).trim() || 'llama3.2' }
  }
  if (lower.startsWith('vllm/')) {
    return { provider: 'vllm', modelId: model.slice(5).trim() }
  }
  return null
}

function buildMessagesFromPayload(payload: Record<string, unknown>): Message[] {
  const messages: Message[] = []
  const history = payload.conversationHistory as Array<{ role?: string; content?: string }> | undefined
  if (Array.isArray(history)) {
    for (const m of history) {
      const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null
      if (role && typeof m?.content === 'string') {
        messages.push({ role, content: m.content })
      }
    }
  }
  const userMessage = payload.message as string
  if (typeof userMessage === 'string' && userMessage.trim()) {
    messages.push({ role: 'user', content: userMessage.trim() })
  }
  return messages
}

function buildSystemPromptFromPayload(payload: Record<string, unknown>): string | undefined {
  const contexts = payload.context as Array<{ type?: string; content?: string }> | undefined
  if (!Array.isArray(contexts) || contexts.length === 0) return undefined
  const parts = contexts
    .filter((c) => typeof c?.content === 'string' && c.content.trim())
    .map((c) => c.content!.trim())
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}

async function* streamProviderBodyToSSEEvents(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      if (abortSignal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) {
        yield { type: 'content', data: chunk }
      }
    }
    const remainder = decoder.decode()
    if (remainder) {
      yield { type: 'content', data: remainder }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
  yield { type: 'done', data: {} }
}

/**
 * Run Copilot stream using a local provider (Ollama/vLLM) instead of Sim Agent.
 * No tools are passed; the model only generates text.
 */
export async function runLocalProviderStream(
  requestPayload: Record<string, unknown>,
  context: StreamingContext,
  execContext: ExecutionContext,
  options: OrchestratorOptions
): Promise<void> {
  const model = requestPayload.model as string
  const providerFromPayload = requestPayload.provider as string | undefined
  const parsed = getLocalProviderAndModel(model, providerFromPayload)
  if (!parsed) {
    context.errors.push('Local model not supported for this request')
    context.streamComplete = true
    await options.onEvent?.({ type: 'error', data: { displayMessage: context.errors[0] } })
    return
  }

  const messages = buildMessagesFromPayload(requestPayload)
  if (messages.length === 0) {
    context.errors.push('No messages to send')
    context.streamComplete = true
    await options.onEvent?.({ type: 'error', data: { displayMessage: 'No messages to send.' } })
    return
  }

  const systemPrompt = buildSystemPromptFromPayload(requestPayload)
  const providerRequest: ProviderRequest = {
    model: parsed.modelId,
    messages,
    systemPrompt,
    stream: true,
    abortSignal: options.abortSignal,
  }

  let stream: ReadableStream<Uint8Array>
  try {
    const response = await executeProviderRequest(parsed.provider, providerRequest)
    if (response && typeof response === 'object' && 'stream' in response) {
      stream = (response as StreamingExecution).stream as ReadableStream<Uint8Array>
    } else if (response instanceof ReadableStream) {
      stream = response
    } else {
      context.errors.push('Local provider did not return a stream')
      context.streamComplete = true
      await options.onEvent?.({ type: 'error', data: { displayMessage: context.errors[0] } })
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Local provider request failed', { provider: parsed.provider, model: parsed.modelId, error: message })
    context.errors.push(message)
    context.streamComplete = true
    await options.onEvent?.({ type: 'error', data: { displayMessage: message } })
    return
  }

  const events = streamProviderBodyToSSEEvents(stream, options.abortSignal)
  await runStreamLoopFromEvents(events, context, execContext, {
    ...options,
    onBeforeDispatch: undefined,
  })
}
