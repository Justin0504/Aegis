/**
 * The alignment auditor follows the documented client order (§2.8):
 * a configured local endpoint first, cloud keys after, and nothing
 * cloud-bound under AEGIS_OFFLINE. It previously went straight to the
 * first cloud key it found, so an air-gapped deployment still called out.
 */
import { resolveConfig } from '../api/alignment';

const body = {
  agent_id: 'a', declared_goal: 'g', thought_chain: [],
  proposed_action: { tool_name: 't', arguments: {} },
} as any;

describe('alignment auditor provider order', () => {
  test('local endpoint wins over a cloud key', () => {
    const cfg: any = resolveConfig(body, {
      AEGIS_LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1', AEGIS_LOCAL_LLM_MODEL: 'qwen2.5:7b',
      ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxx',
    } as any);
    expect(cfg.provider).toBe('local');
    expect(cfg.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  test('offline without a local model refuses rather than calling the cloud', () => {
    const cfg: any = resolveConfig(body, { AEGIS_OFFLINE: '1', OPENAI_API_KEY: 'sk-xxxxxxxx' } as any);
    expect(cfg.error).toMatch(/AEGIS_OFFLINE/);
  });

  test('no local model and not offline: first cloud key, as before', () => {
    const cfg: any = resolveConfig(body, { OPENAI_API_KEY: 'sk-xxxxxxxx' } as any);
    expect(cfg.provider).toBe('openai');
  });
});
