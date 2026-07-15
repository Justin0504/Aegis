/**
 * LLM client adapter tests + AEGIS_OFFLINE contract.
 *
 * The security-load-bearing property here is `pickLlmClient`:
 *   1. AEGIS_OFFLINE=1  →  cloud clients MUST NOT be returned.
 *   2. Local URL present → local wins over any cloud key.
 *   3. Local URL wins EVEN when AEGIS_OFFLINE=1 (local is always OK).
 *
 * Enterprise/BFSI buyers rely on this to attest their air-gapped
 * deployment doesn't accidentally reach public LLM APIs.
 */

import pino from 'pino';
import {
  LocalOpenAICompatibleLlmClient,
  AnthropicLlmClient,
  OpenAILlmClient,
  pickLlmClient,
} from '../services/llm-clients';

const logger = pino({ level: 'silent' });

afterEach(() => jest.restoreAllMocks());

// ── LocalOpenAICompatibleLlmClient ───────────────────────────────────

describe('LocalOpenAICompatibleLlmClient', () => {
  test('rejects a baseUrl that isn\'t an OpenAI-compat /v1 URL', () => {
    expect(() => new LocalOpenAICompatibleLlmClient(
      { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' }, logger,
    )).toThrow(/OpenAI-compat \/v1 URL/);
  });

  test('POSTs to <baseUrl>/chat/completions and returns choices[0].content', async () => {
    const capturedInit: any = {};
    const impl = async function fetchImpl(input: any, init: any) {
      capturedInit.url = String(input);
      capturedInit.body = init.body;
      capturedInit.headers = init.headers;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello from local' } }],
      }), { status: 200 });
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(impl as any);

    const c = new LocalOpenAICompatibleLlmClient(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' }, logger,
    );
    const out = await c.complete({ system: 'S', user: 'U' });
    expect(out).toBe('hello from local');
    expect(capturedInit.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(capturedInit.body);
    expect(body.model).toBe('llama3.1');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user',   content: 'U' },
    ]);
    expect(capturedInit.headers.authorization).toBeUndefined();
  });

  test('attaches Bearer auth when apiKey is supplied', async () => {
    const captured: any = {};
    const impl = async function fetchImpl(_input: any, init: any) {
      captured.headers = init.headers;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 });
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(impl as any);
    const c = new LocalOpenAICompatibleLlmClient(
      { baseUrl: 'http://vllm:8000/v1', model: 'meta-llama/Llama-3.1', apiKey: 'secret-token' },
      logger,
    );
    await c.complete({ system: '', user: 'x' });
    expect(captured.headers.authorization).toBe('Bearer secret-token');
  });

  test('throws on non-2xx with the upstream status in the message', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 503 }),
    );
    const c = new LocalOpenAICompatibleLlmClient(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' }, logger,
    );
    await expect(c.complete({ system: '', user: 'x' })).rejects.toThrow(/local LLM 503/);
  });

  test('throws when the response is missing choices[0].message.content', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const c = new LocalOpenAICompatibleLlmClient(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' }, logger,
    );
    await expect(c.complete({ system: '', user: 'x' })).rejects.toThrow(/no choices/);
  });
});

// ── pickLlmClient (env selection + AEGIS_OFFLINE) ────────────────────

describe('pickLlmClient · AEGIS_OFFLINE contract', () => {
  test('AEGIS_OFFLINE=1 with no local URL → returns undefined (heuristic-only)', () => {
    const client = pickLlmClient({
      AEGIS_OFFLINE: '1',
      ANTHROPIC_API_KEY: 'sk-ant-cloud',
      OPENAI_API_KEY:    'sk-openai-cloud',
    } as any, logger);
    expect(client).toBeUndefined();
  });

  test('AEGIS_OFFLINE=true (string) also blocks cloud clients', () => {
    const client = pickLlmClient({
      AEGIS_OFFLINE: 'true',
      ANTHROPIC_API_KEY: 'sk-ant',
    } as any, logger);
    expect(client).toBeUndefined();
  });

  test('AEGIS_OFFLINE unset + ANTHROPIC key → Anthropic client', () => {
    const client = pickLlmClient({
      ANTHROPIC_API_KEY: 'sk-ant',
    } as any, logger);
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  test('AEGIS_OFFLINE unset + only OPENAI key → OpenAI client', () => {
    const client = pickLlmClient({
      OPENAI_API_KEY: 'sk-openai',
    } as any, logger);
    expect(client).toBeInstanceOf(OpenAILlmClient);
  });

  test('local URL wins over cloud keys (offline preference)', () => {
    const client = pickLlmClient({
      AEGIS_LOCAL_LLM_URL:   'http://127.0.0.1:11434/v1',
      AEGIS_LOCAL_LLM_MODEL: 'llama3.1',
      ANTHROPIC_API_KEY:     'sk-ant',
      OPENAI_API_KEY:        'sk-openai',
    } as any, logger);
    expect(client).toBeInstanceOf(LocalOpenAICompatibleLlmClient);
  });

  test('local URL is allowed EVEN when AEGIS_OFFLINE=1 (local is not cloud)', () => {
    const client = pickLlmClient({
      AEGIS_OFFLINE:         '1',
      AEGIS_LOCAL_LLM_URL:   'http://127.0.0.1:11434/v1',
      AEGIS_LOCAL_LLM_MODEL: 'llama3.1',
    } as any, logger);
    expect(client).toBeInstanceOf(LocalOpenAICompatibleLlmClient);
  });

  test('no keys, no local URL → undefined (heuristic-only)', () => {
    const client = pickLlmClient({} as any, logger);
    expect(client).toBeUndefined();
  });
});
