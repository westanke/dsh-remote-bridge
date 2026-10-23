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
    })).resolves.toEqual({
      models: [{ id: 'model-discovered', name: 'Discovered' }],
      baseURLHost: 'api.example',
    })
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

  describe('credential repoint guard (SEC-H11 persistent variant)', () => {
    it('refuses to move baseURL to another host while a credential is stored', async () => {
      const calls = createFakeApi()
      const adapter = new DshSettingsAdapter(calls.api as never)

      // 供应商当前指向 llm.local 且已存 key；把它改到攻击者的域名等于把 key 交出去。
      await expect(adapter.updateProvider('custom-openai', { baseURL: 'https://attacker.example/v1' }))
        .rejects.toMatchObject({ code: 'PROVIDER_BASE_URL_REPOINT_FORBIDDEN', status: 403 })
      expect(calls.mutation).toBeUndefined()
    })

    it('allows the same-host change (path/port is not a destination change)', async () => {
      const calls = createFakeApi()
      const adapter = new DshSettingsAdapter(calls.api as never)

      await adapter.updateProvider('custom-openai', { baseURL: 'https://llm.local/v2' })
      expect(calls.mutation).toMatchObject({
        ops: [{ op: 'set', path: ['providers', 'custom-openai', 'baseURL'], value: 'https://llm.local/v2' }],
      })
    })

    it('allows repointing when the caller supplies a fresh apiKey', async () => {
      const calls = createFakeApi()
      const adapter = new DshSettingsAdapter(calls.api as never)

      // 用户本来就在重设凭据 —— 目的地跟着换是正当操作，不该被拦。
      await adapter.updateProvider('custom-openai', {
        baseURL: 'https://attacker.example/v1',
        apiKey: 'brand-new-key',
      })
      expect(calls.credential).toEqual({ ref: 'CUSTOM_OPENAI_API_KEY', value: 'brand-new-key' })
    })

    it('still rejects private targets even when a new apiKey is supplied', async () => {
      const calls = createFakeApi()
      const adapter = new DshSettingsAdapter(calls.api as never)

      // 地址策略先于重定向闸门生效：换 key 不免除私网限制。
      await expect(adapter.updateProvider('custom-openai', {
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKey: 'brand-new-key',
      })).rejects.toMatchObject({ code: 'PROVIDER_BASE_URL_FORBIDDEN', status: 403 })
    })

    it('does not guard providers that hold no credential', async () => {
      const calls = createFakeApi({ credentialConfigured: false })
      const adapter = new DshSettingsAdapter(calls.api as never)

      await adapter.updateProvider('custom-openai', { baseURL: 'https://other.example/v1' })
      expect(calls.mutation).toMatchObject({
        ops: [{ op: 'set', path: ['providers', 'custom-openai', 'baseURL'], value: 'https://other.example/v1' }],
      })
    })

    it('does not guard plain edits that leave baseURL alone', async () => {
      const calls = createFakeApi()
      const adapter = new DshSettingsAdapter(calls.api as never)

      await adapter.updateProvider('custom-openai', { displayName: 'Renamed', models: [{ id: 'm1' }] })
      expect(calls.mutation).toBeDefined()
    })
  })

  it('blocks discover from reaching a private address without an explicit allowlist', async () => {
    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never)

    // 修复前这里会把请求（连同真实凭据）发到 127.0.0.1 上任意端口。
    await expect(adapter.discover('custom-openai', { baseURL: 'http://127.0.0.1:18095/v1' }))
      .rejects.toMatchObject({ code: 'PROVIDER_BASE_URL_FORBIDDEN' })
    expect(calls.discovery).toBeUndefined()
  })

  it('lets discover reach a loopback LLM when the deployment allowlists that port', async () => {
    const calls = createFakeApi()
    const adapter = new DshSettingsAdapter(calls.api as never, {
      allowPrivateProviderHosts: ['127.0.0.1:11434'],
    })

    await expect(adapter.discover('custom-openai', { baseURL: 'http://127.0.0.1:11434/v1' }))
      .resolves.toMatchObject({ baseURLHost: '127.0.0.1:11434' })
    expect(calls.discovery).toMatchObject({ baseURL: 'http://127.0.0.1:11434/v1' })
  })
})

function createFakeApi(options: { credentialConfigured?: boolean } = {}) {
  const credentialConfigured = options.credentialConfigured ?? true
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
        CUSTOM_OPENAI_API_KEY: { configured: credentialConfigured, source: 'profile-store', writable: true },
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
