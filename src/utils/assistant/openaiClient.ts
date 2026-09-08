/**
 * OpenAI chat completions with tool calling, over plain `fetch`.
 *
 * No SDK, for the same reasons the Mistral OCR adapter has none: the protocol
 * is a single POST, an SDK would have to be told `dangerouslyAllowBrowser`,
 * and the only things worth abstracting are the key, the model and where the
 * request goes. `api.openai.com` answers browser origins with CORS headers, so
 * the call works under this app's COEP (`require-corp` governs embedded
 * subresources, not `fetch`); `endpoint` exists for a same-origin proxy should
 * a deployment need one.
 *
 * The caller (useAssistant) owns consent and the key; this module speaks the
 * wire format and nothing else. The response is treated as untrusted: a
 * malformed tool call is reported, never thrown at the loop.
 */
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatCompletionRequest {
  apiKey: string
  model: string
  endpoint?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  signal?: AbortSignal
}

export interface ChatCompletionResult {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  finishReason: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export async function chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
  if (!req.apiKey) throw new Error('The assistant needs an OpenAI API key — open its settings (gear icon)')
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('The assistant needs a network connection')

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.2
  }
  if (req.tools && req.tools.length) {
    body.tools = req.tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(req.endpoint || OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let detail = text.slice(0, 200)
    try { detail = JSON.parse(text)?.error?.message || detail } catch (_) { /* not JSON */ }
    throw new Error(`OpenAI: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  const json: any = await res.json()
  const choice = json?.choices?.[0]
  const msg = choice?.message
  if (!msg || msg.role !== 'assistant') throw new Error('OpenAI: the reply had no assistant message')
  const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter((t: any) => t && t.type === 'function' && t.function && typeof t.function.name === 'string')
        .map((t: any) => ({
          id: String(t.id),
          type: 'function' as const,
          function: { name: t.function.name, arguments: String(t.function.arguments ?? '{}') }
        }))
    : undefined
  return {
    message: {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {})
    },
    finishReason: String(choice.finish_reason ?? ''),
    usage: json.usage
  }
}
