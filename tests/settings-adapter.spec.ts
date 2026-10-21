import { describe, expect, it } from 'vitest'
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'

describe('DSH provider settings', () => {
  it('projects credential state without returning secret values', async () => {
    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never)

    const result = await adapter.listProviders()

    expect(result).toMatchObject({
      writable: true,
      revisionByNamespace: { 'llm-pi-ai': 7 },
      customProvider: {
        available: true,
        protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
        revision: 7,
      },
      providers: [{
        id: 'custom-openai',
        displayName: 'My OpenAI',
        active: true,
        configured: true,
        removable: true,
        credential: { ref: 'CUSTOM_OPENAI_API_KEY', configured: true, writable: true },
        config: {
          baseURL: 'http://llm.local/v1',
          api: 'openai-completions',
          models: [{ id: 'model-a', name: 'Catalog Model A' }],
          modelsInherited: true,
        },
      }],
    })
    expect(JSON.stringify(result)).not.toContain('server-secret')
  })

  it('projects adapter catalog metadata (defaultBaseURL, baseURLEnv, nativeAuth) onto provider rows', async () => {
    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never)

    const result = await adapter.listProviders()

    expect(result.providers[0]).toMatchObject({
      id: 'custom-openai',
      defaultBaseURL: 'https://api.openai.com/v1',
      baseURLEnv: ['OPENAI_BASE_URL'],
      nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
      settingsNs: 'llm-pi-ai',
    })
  })

  it('mutates provider settings, writes credentials separately, and discovers models', async () => {
    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never)

    await adapter.updateProvider('custom-openai', {
      baseURL: 'https://api.example/v1',
      apiKey: 'new-secret',
      models: [{ id: 'model-b' }],
      expectedRevision: 7,
    })
    expect(calls.mutation).toMatchObject({
      ns: 'llm-pi-ai',
      expectedRevision: 7,
      ops: [
        { op: 'set', path: ['providers', 'custom-openai', 'baseURL'], value: 'https://api.example/v1' },
        { op: 'set', path: ['providers', 'custom-openai', 'models'], value: [{ id: 'model-b' }] },
      ],
    })
    expect(calls.credential).toEqual({ ref: 'CUSTOM_OPENAI_API_KEY', value: 'new-secret' })

    await adapter.updateProvider('custom-openai', { models: null, expectedRevision: 8 })
    expect(calls.mutation).toMatchObject({
      ns: 'llm-pi-ai',
      expectedRevision: 8,
      ops: [{ op: 'unset', path: ['providers', 'custom-openai', 'models'] }],
    })

    await expect(adapter.discover('custom-openai', {
      baseURL: 'https://api.example/v1',
      api: 'openai-completions',
      apiKey: 'draft-key',
    })).resolves.toEqual([{ id: 'model-discovered', name: 'Discovered' }])
    expect(calls.discovery).toMatchObject({
      settingsNs: 'llm-pi-ai',
      provider: 'custom-openai',
      baseURL: 'https://api.example/v1',
      api: 'openai-completions',
      apiKey: 'draft-key',
    })
  })

  it('creates a custom provider using the DSH pi-ai namespace and stores its key separately', async () => {    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never)

    await adapter.createProvider({
      id: 'acme-gateway',
      displayName: 'Acme Gateway',
      baseURL: 'https://acme.example/v1',
      api: 'openai-responses',
      apiKey: 'custom-secret',
      models: [{ id: 'acme-code', contextWindow: 131_072 }],
      expectedRevision: 7,
    })

    expect(calls.mutation).toEqual({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://acme.example/v1',
          models: [{ id: 'acme-code', contextWindow: 131_072 }],
        },
      }],
      expectedRevision: 7,
    })
    expect(calls.credential).toEqual({ ref: 'ACME_GATEWAY_API_KEY', value: 'custom-secret' })
  })
})

function createFakeApi() {
  const state: {
    mutation?: Record<string, unknown>
    credential?: Record<string, unknown>
    discovery?: Record<string, unknown>
  } = {}
  const ok = <T>(value: T) => ({ result: { ok: true as const, value } })
  const baseProfile = {
    baseURL: 'http://llm.local/v1',
    api: 'openai-completions',
  }
  const profile = {
    displayName: 'My OpenAI',
    apiKeyEnv: 'CUSTOM_OPENAI_API_KEY',
  }
  const api = {
    llm: {
      providers: async () => ok({ providers: [{
        provider: 'custom-openai',
        displayName: 'Custom OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'custom-openai'],
        active: true,
        declared: true,
        defaultBaseURL: 'https://api.openai.com/v1',
        baseURLEnv: ['OPENAI_BASE_URL'],
        nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
      }] }),
      models: async () => ok({
        groups: [{ id: 'custom-openai', name: 'Custom OpenAI', models: [{ id: 'model-a', name: 'Catalog Model A' }] }],
        failures: [],
      }),
      discoverModels: async (request: { payload: Record<string, unknown> }) => {
        state.discovery = request.payload
        return ok({ models: [{ id: 'model-discovered', name: 'Discovered' }] })
      },
    },
    settings: {
      describe: async () => ok({
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: piAiSchema(),
          value: { providers: { 'custom-openai': profile } },
          base: { providers: { 'custom-openai': baseProfile } },
          user: { providers: { 'custom-openai': profile } },
          revision: 7,
        }],
      }),
      mutate: async (request: { payload: Record<string, unknown> }) => {
        state.mutation = request.payload
        return ok({ ns: 'llm', value: {}, revision: 8 })
      },
    },
    credentials: {
      describe: async () => ok({ credentials: {
        CUSTOM_OPENAI_API_KEY: { configured: true, source: 'profile-store', writable: true },
      } }),
      set: async (request: { payload: Record<string, unknown> }) => {
        state.credential = request.payload
        return ok({})
      },
      unset: async () => ok({}),
    },
  }
  return Object.assign(state, { api })
}

function piAiSchema() {
  return {
    uid: 6,
    refs: {
      0: { type: 'const', value: 'openai-completions' },
      1: { type: 'const', value: 'openai-responses' },
      2: { type: 'const', value: 'anthropic-messages' },
      3: { type: 'union', list: [0, 1, 2] },
      4: { type: 'object', dict: { api: 3 } },
      5: { type: 'dict', inner: 4 },
      6: { type: 'object', dict: { providers: 5 } },
    },
  }
}
