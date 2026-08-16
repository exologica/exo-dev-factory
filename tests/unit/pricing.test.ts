import { describe, it, expect } from 'vitest'
import { PricingEngine, pricingEngine } from '../../src/domain/pricing.js'

describe('PricingEngine', () => {
  describe('default rates', () => {
    it('has default rates for OpenAI models', () => {
      const rate = pricingEngine.getRate('gpt-4o')
      expect(rate).toEqual({ inputCentsPerMillion: 250, outputCentsPerMillion: 1000 })
    })

    it('has default rates for Anthropic models', () => {
      const rate = pricingEngine.getRate('claude-3-5-sonnet-20241022')
      expect(rate).toEqual({ inputCentsPerMillion: 300, outputCentsPerMillion: 1500 })
    })

    it('has default rates for Google models', () => {
      const rate = pricingEngine.getRate('gemini-1.5-pro')
      expect(rate).toEqual({ inputCentsPerMillion: 125, outputCentsPerMillion: 500 })
    })

    it('falls back to default model for unknown model', () => {
      const rate = pricingEngine.getRate('unknown-model-xyz')
      // Falls back to default provider/model (openai/gpt-4o)
      expect(rate).toEqual({ inputCentsPerMillion: 250, outputCentsPerMillion: 1000 })
    })
  })

  describe('calculateCostCents', () => {
    it('calculates cost in cents using integer arithmetic', () => {
      // gpt-4o: $2.50/1M input, $10.00/1M output
      // 1000 prompt tokens = 1000 * 250 / 1_000_000 = 0.25 cents -> rounded to 0
      // 500 completion tokens = 500 * 1000 / 1_000_000 = 0.5 cents -> rounded to 1
      // Total: 1 cent
      const cost = pricingEngine.calculateCostCents(1000, 500, 'gpt-4o')
      expect(cost).toBe(1)
    })

    it('calculates cost correctly for larger token counts', () => {
      // 1M prompt tokens = 1_000_000 * 250 / 1_000_000 = 250 cents = $2.50
      // 1M completion tokens = 1_000_000 * 1000 / 1_000_000 = 1000 cents = $10.00
      const cost = pricingEngine.calculateCostCents(1_000_000, 1_000_000, 'gpt-4o')
      expect(cost).toBe(1250) // 250 + 1000 = 1250 cents = $12.50
    })

    it('uses fallback model for unknown model', () => {
      // Falls back to default (gpt-4o), so cost is calculated
      const cost = pricingEngine.calculateCostCents(1000, 500, 'unknown-model')
      expect(cost).toBe(1) // Same as gpt-4o fallback
    })

    it('handles zero tokens', () => {
      const cost = pricingEngine.calculateCostCents(0, 0, 'gpt-4o')
      expect(cost).toBe(0)
    })
  })

  describe('calculateCostDollars', () => {
    it('returns cost in dollars as float', () => {
      const cost = pricingEngine.calculateCostDollars(1_000_000, 1_000_000, 'gpt-4o')
      expect(cost).toBe(12.50)
    })
  })

  describe('provider/model format', () => {
    it('accepts provider/model format', () => {
      const rate = pricingEngine.getRate('openai/gpt-4o')
      expect(rate).toEqual({ inputCentsPerMillion: 250, outputCentsPerMillion: 1000 })
    })

    it('accepts anthropic/claude format', () => {
      const rate = pricingEngine.getRate('anthropic/claude-3-5-sonnet-20241022')
      expect(rate).toEqual({ inputCentsPerMillion: 300, outputCentsPerMillion: 1500 })
    })
  })

  describe('getRateInfo', () => {
    it('returns provider, model, and rate for known model', () => {
      const info = pricingEngine.getRateInfo('gpt-4o')
      expect(info).toBeDefined()
      expect(info?.provider).toBe('openai')
      expect(info?.model).toBe('gpt-4o')
      expect(info?.rate).toEqual({ inputCentsPerMillion: 250, outputCentsPerMillion: 1000 })
    })

    it('returns undefined for unknown model', () => {
      const info = pricingEngine.getRateInfo('unknown-xyz')
      expect(info).toBeUndefined()
    })
  })

  describe('custom config', () => {
    it('accepts custom provider config', () => {
      const custom = new PricingEngine({
        providers: {
          custom: {
            models: {
              'custom-model': { inputCentsPerMillion: 100, outputCentsPerMillion: 200 }
            }
          }
        }
      })
      const rate = custom.getRate('custom-model')
      expect(rate).toEqual({ inputCentsPerMillion: 100, outputCentsPerMillion: 200 })
    })

    it('merges custom models with defaults', () => {
      const custom = new PricingEngine({
        providers: {
          openai: {
            models: {
              'gpt-custom': { inputCentsPerMillion: 50, outputCentsPerMillion: 150 }
            }
          }
        }
      })
      // Default gpt-4o should still exist
      expect(custom.getRate('gpt-4o')).toEqual({ inputCentsPerMillion: 250, outputCentsPerMillion: 1000 })
      // Custom model should be added
      expect(custom.getRate('gpt-custom')).toEqual({ inputCentsPerMillion: 50, outputCentsPerMillion: 150 })
    })
  })

  describe('getProviders/getModels', () => {
    it('returns list of providers', () => {
      const providers = pricingEngine.getProviders()
      expect(providers).toContain('openai')
      expect(providers).toContain('anthropic')
      expect(providers).toContain('google')
    })

    it('returns models for a provider', () => {
      const models = pricingEngine.getModels('openai')
      expect(models).toContain('gpt-4o')
      expect(models).toContain('gpt-4o-mini')
    })

    it('returns empty array for unknown provider', () => {
      const models = pricingEngine.getModels('unknown')
      expect(models).toEqual([])
    })
  })
})