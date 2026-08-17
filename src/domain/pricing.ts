/**
 * Pricing engine for token usage cost calculation.
 *
 * Uses integer arithmetic (cents) internally to avoid floating-point drift.
 * Rates are configurable via environment variable or JSON file.
 * Default rates reflect public pricing for major providers as of 2026-08.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Model pricing rate in cents per 1M tokens (input/output). */
export interface ModelRate {
  inputCentsPerMillion: number
  outputCentsPerMillion: number
}

/** Provider configuration with model-specific rates. */
export interface ProviderConfig {
  models: Record<string, ModelRate>
  defaultModel?: string
}

/** Full pricing configuration. */
export interface PricingConfig {
  providers: Record<string, ProviderConfig>
  defaultProvider?: string
  defaultModel?: string
}

/** Default pricing rates (cents per 1M tokens) as of 2026-08.
 * These are reference rates for major providers; actual rates may vary.
 * Sources: public pricing pages for OpenAI, Anthropic, Google, Mistral, etc.
 */
const DEFAULT_PRICING: PricingConfig = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  providers: {
    openai: {
      defaultModel: 'gpt-4o',
      models: {
        'gpt-4o': { inputCentsPerMillion: 250, outputCentsPerMillion: 1000 },      // $2.50/$10.00 per 1M
        'gpt-4o-mini': { inputCentsPerMillion: 15, outputCentsPerMillion: 60 },     // $0.15/$0.60 per 1M
        'gpt-4.1': { inputCentsPerMillion: 200, outputCentsPerMillion: 800 },       // $2.00/$8.00 per 1M
        'gpt-4.1-mini': { inputCentsPerMillion: 40, outputCentsPerMillion: 160 },   // $0.40/$1.60 per 1M
        'o3': { inputCentsPerMillion: 1000, outputCentsPerMillion: 4000 },          // $10.00/$40.00 per 1M
        'o4-mini': { inputCentsPerMillion: 110, outputCentsPerMillion: 440 },       // $1.10/$4.40 per 1M
      }
    },
    anthropic: {
      defaultModel: 'claude-3-5-sonnet-20241022',
      models: {
        'claude-3-5-sonnet-20241022': { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 }, // $3.00/$15.00
        'claude-3-5-haiku-20241022': { inputCentsPerMillion: 80, outputCentsPerMillion: 400 },     // $0.80/$4.00
        'claude-3-opus-20240229': { inputCentsPerMillion: 1500, outputCentsPerMillion: 7500 },    // $15.00/$75.00
      }
    },
    google: {
      defaultModel: 'gemini-1.5-pro',
      models: {
        'gemini-1.5-pro': { inputCentsPerMillion: 125, outputCentsPerMillion: 500 },  // $1.25/$5.00
        'gemini-1.5-flash': { inputCentsPerMillion: 7, outputCentsPerMillion: 21 },    // $0.07/$0.21
        'gemini-2.5-pro': { inputCentsPerMillion: 125, outputCentsPerMillion: 1000 },  // $1.25/$10.00
        'gemini-2.5-flash': { inputCentsPerMillion: 15, outputCentsPerMillion: 60 },   // $0.15/$0.60
      }
    },
    mistral: {
      defaultModel: 'mistral-large-latest',
      models: {
        'mistral-large-latest': { inputCentsPerMillion: 200, outputCentsPerMillion: 600 }, // $2.00/$6.00
        'mistral-small-latest': { inputCentsPerMillion: 20, outputCentsPerMillion: 60 },   // $0.20/$0.60
        'codestral-latest': { inputCentsPerMillion: 100, outputCentsPerMillion: 300 },     // $1.00/$3.00
      }
    },
    cohere: {
      defaultModel: 'command-r-plus',
      models: {
        'command-r-plus': { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 }, // $3.00/$15.00
        'command-r': { inputCentsPerMillion: 50, outputCentsPerMillion: 150 },         // $0.50/$1.50
      }
    },
    perplexity: {
      defaultModel: 'sonar-large-online',
      models: {
        'sonar-large-online': { inputCentsPerMillion: 100, outputCentsPerMillion: 100 },  // $1.00/$1.00
        'sonar-small-online': { inputCentsPerMillion: 20, outputCentsPerMillion: 20 },     // $0.20/$0.20
      }
    },
    azure: {
      defaultModel: 'gpt-4o',
      models: {
        'gpt-4o': { inputCentsPerMillion: 250, outputCentsPerMillion: 1000 },      // $2.50/$10.00 per 1M
        'gpt-4o-mini': { inputCentsPerMillion: 15, outputCentsPerMillion: 60 },     // $0.15/$0.60 per 1M
        'gpt-4': { inputCentsPerMillion: 3000, outputCentsPerMillion: 6000 },       // $30.00/$60.00 per 1M
        'gpt-35-turbo': { inputCentsPerMillion: 50, outputCentsPerMillion: 150 },   // $0.50/$1.50 per 1M
      }
    }
  }
}

/** Pricing engine for calculating token costs. */
export class PricingEngine {
  private readonly config: PricingConfig

  constructor(config?: Partial<PricingConfig>) {
    this.config = this.mergeConfig(config)
  }

  /** Create engine from environment variable PRICING_CONFIG (JSON file path). */
  static fromEnv(): PricingEngine {
    const configPath = process.env.PRICING_CONFIG
    if (!configPath) {
      return new PricingEngine()
    }
    try {
      const filePath = resolve(configPath)
      const content = readFileSync(filePath, 'utf-8')
      const config = JSON.parse(content) as PricingConfig
      return new PricingEngine(config)
    } catch {
      // Fall back to defaults on any config error
      return new PricingEngine()
    }
  }

  /** Merge provided config with defaults (deep merge for providers/models). */
  private mergeConfig(config?: Partial<PricingConfig>): PricingConfig {
    if (!config) return DEFAULT_PRICING

    const merged: PricingConfig = {
      defaultProvider: config.defaultProvider ?? DEFAULT_PRICING.defaultProvider,
      defaultModel: config.defaultModel ?? DEFAULT_PRICING.defaultModel,
      providers: { ...DEFAULT_PRICING.providers }
    }

    if (config.providers) {
      for (const [provider, providerConfig] of Object.entries(config.providers)) {
        if (!merged.providers[provider]) {
          merged.providers[provider] = { models: {} }
        }
        if (providerConfig.defaultModel) {
          merged.providers[provider].defaultModel = providerConfig.defaultModel
        }
        if (providerConfig.models) {
          merged.providers[provider].models = {
            ...merged.providers[provider].models,
            ...providerConfig.models
          }
        }
      }
    }

    return merged
  }

  /** Get rate for a model (provider/model format or just model name). */
  getRate(model: string): ModelRate | undefined {
    // Try "provider/model" format first
    const parts = model.split('/')
    if (parts.length === 2) {
      const [provider, modelName] = parts
      if (provider && modelName) {
        const providerConfig = this.config.providers[provider]
        if (providerConfig?.models[modelName]) {
          return providerConfig.models[modelName]
        }
      }
    }

    // Search all providers for the model name
    for (const providerConfig of Object.values(this.config.providers)) {
      if (providerConfig.models[model]) {
        return providerConfig.models[model]
      }
    }

    // Try default provider
    const defaultProviderKey = this.config.defaultProvider
    if (defaultProviderKey) {
      const defaultProvider = this.config.providers[defaultProviderKey]
      if (defaultProvider?.models[model]) {
        return defaultProvider.models[model]
      }
    }

    // Try default model
    const defaultProviderKey2 = this.config.defaultProvider
    if (defaultProviderKey2) {
      const defaultProvider = this.config.providers[defaultProviderKey2]
      if (defaultProvider?.defaultModel && defaultProvider.models[defaultProvider.defaultModel]) {
        return defaultProvider.models[defaultProvider.defaultModel]
      }
    }

    // Fallback to first available model
    for (const providerConfig of Object.values(this.config.providers)) {
      const modelName = providerConfig.defaultModel ?? Object.keys(providerConfig.models)[0]
      if (modelName && providerConfig.models[modelName]) {
        return providerConfig.models[modelName]
      }
    }

    return undefined
  }

  /** Calculate cost in cents for given token counts and model. */
  calculateCostCents(promptTokens: number, completionTokens: number, model: string): number {
    const rate = this.getRate(model)
    if (!rate) return 0

    // Integer arithmetic: (tokens * centsPerMillion) / 1_000_000
    const inputCost = Math.round((promptTokens * rate.inputCentsPerMillion) / 1_000_000)
    const outputCost = Math.round((completionTokens * rate.outputCentsPerMillion) / 1_000_000)
    return inputCost + outputCost
  }

  /** Calculate cost in dollars (float) for display. */
  calculateCostDollars(promptTokens: number, completionTokens: number, model: string): number {
    return this.calculateCostCents(promptTokens, completionTokens, model) / 100
  }

  /** Get available providers. */
  getProviders(): string[] {
    return Object.keys(this.config.providers)
  }

  /** Get available models for a provider. */
  getModels(provider: string): string[] {
    return Object.keys(this.config.providers[provider]?.models ?? {})
  }

  /** Get all models across all providers. */
  getAllModels(): string[] {
    const models = new Set<string>()
    for (const providerConfig of Object.values(this.config.providers)) {
      for (const model of Object.keys(providerConfig.models)) {
        models.add(model)
      }
    }
    return Array.from(models)
  }

  /** Get the resolved rate info for a model (for debugging/display). */
  getRateInfo(model: string): { provider: string; model: string; rate: ModelRate } | undefined {
    // Try explicit provider/model
    const parts = model.split('/')
    if (parts.length === 2) {
      const [provider, modelName] = parts
      if (provider && modelName) {
        const providerConfig = this.config.providers[provider]
        if (providerConfig?.models[modelName]) {
          return { provider, model: modelName, rate: providerConfig.models[modelName] }
        }
      }
    }

    // Search all providers
    for (const [provider, providerConfig] of Object.entries(this.config.providers)) {
      if (providerConfig.models[model]) {
        return { provider, model, rate: providerConfig.models[model] }
      }
    }

    return undefined
  }
}

/** Default singleton instance. */
export const pricingEngine = new PricingEngine()