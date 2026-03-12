import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { SIM_AGENT_API_URL } from '@/lib/copilot/constants'
import { authenticateCopilotRequestSessionOnly } from '@/lib/copilot/request-helpers'
import type { AvailableModel } from '@/lib/copilot/types'
import { env } from '@/lib/core/config/env'
import { getProviderModels } from '@/providers/models'
import { getAllProviderIds } from '@/providers/utils'
import {
  filterBlacklistedModels,
  isProviderBlacklisted,
} from '@/providers/utils'
import type { ModelsObject } from '@/providers/ollama/types'

const logger = createLogger('CopilotModelsAPI')

const DYNAMIC_PROVIDERS = ['ollama', 'vllm', 'openrouter'] as const

interface RawAvailableModel {
  id: string
  friendlyName?: string
  displayName?: string
  provider?: string
}

function isRawAvailableModel(item: unknown): item is RawAvailableModel {
  return (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof (item as { id: unknown }).id === 'string'
  )
}

/**
 * Build available models from app providers (Ollama, vLLM, base) for Copilot when Sim Agent is unavailable.
 */
async function getFallbackModels(): Promise<AvailableModel[]> {
  const result: AvailableModel[] = []
  const providerIds = getAllProviderIds()

  for (const providerId of providerIds) {
    if (isProviderBlacklisted(providerId)) continue
    if (DYNAMIC_PROVIDERS.includes(providerId as (typeof DYNAMIC_PROVIDERS)[number])) {
      if (providerId === 'ollama') {
        const ollamaHost = env.OLLAMA_URL || 'http://localhost:11434'
        try {
          const res = await fetch(`${ollamaHost}/api/tags`, {
            headers: { 'Content-Type': 'application/json' },
            next: { revalidate: 60 },
          })
          if (res.ok) {
            const data = (await res.json()) as ModelsObject
            const names = filterBlacklistedModels(data.models.map((m) => m.name))
            for (const name of names) {
              result.push({ id: name, friendlyName: name, provider: 'ollama' })
            }
          }
        } catch (e) {
          logger.debug('Ollama not available for copilot fallback', {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      } else if (providerId === 'vllm') {
        const baseUrl = (env.VLLM_BASE_URL || '').replace(/\/$/, '')
        if (!baseUrl) continue
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (env.VLLM_API_KEY) headers.Authorization = `Bearer ${env.VLLM_API_KEY}`
          const res = await fetch(`${baseUrl}/v1/models`, { headers, next: { revalidate: 60 } })
          if (res.ok) {
            const data = (await res.json()) as { data: Array<{ id: string }> }
            const ids = filterBlacklistedModels(data.data.map((m) => m.id))
            for (const id of ids) {
              result.push({ id, friendlyName: id, provider: 'vllm' })
            }
          }
        } catch (e) {
          logger.debug('vLLM not available for copilot fallback', {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      continue
    }
    const modelIds = getProviderModels(providerId)
    for (const modelId of modelIds) {
      result.push({
        id: modelId,
        friendlyName: modelId,
        provider: providerId,
      })
    }
  }

  return result
}

export async function GET(_req: NextRequest) {
  const { userId, isAuthenticated } = await authenticateCopilotRequestSessionOnly()
  if (!isAuthenticated || !userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (env.COPILOT_API_KEY) {
    headers['x-api-key'] = env.COPILOT_API_KEY
  }

  try {
    let models: AvailableModel[] = []
    let usedFallback = false

    const response = await fetch(`${SIM_AGENT_API_URL}/api/get-available-models`, {
      method: 'GET',
      headers,
      cache: 'no-store',
    })

    const payload = await response.json().catch(() => ({}))
    const rawModels = Array.isArray(payload?.models) ? payload.models : []

    if (response.ok && rawModels.length > 0) {
      models = rawModels
        .filter((item: unknown): item is RawAvailableModel => isRawAvailableModel(item))
        .map((item: RawAvailableModel) => ({
          id: item.id,
          friendlyName: item.friendlyName || item.displayName || item.id,
          provider: item.provider || 'unknown',
        }))
    } else {
      if (!response.ok) {
        logger.warn('Copilot backend models unavailable, using fallback', {
          status: response.status,
        })
      } else if (rawModels.length === 0) {
        logger.info('Copilot backend returned no models, using fallback')
      }
      models = await getFallbackModels()
      usedFallback = models.length > 0
      if (usedFallback) {
        logger.info('Copilot using local/self-hosted models', { count: models.length })
      }
    }

    return NextResponse.json({ success: true, models })
  } catch (error) {
    logger.warn('Error fetching models from copilot backend, trying fallback', {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const fallback = await getFallbackModels()
      if (fallback.length > 0) {
        return NextResponse.json({ success: true, models: fallback })
      }
    } catch (fallbackError) {
      logger.error('Fallback models failed', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      })
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch available models',
        models: [],
      },
      { status: 500 }
    )
  }
}
