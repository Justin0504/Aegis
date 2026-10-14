/**
 * AlignmentChecker — unit tests.
 *
 * No live LLM calls — we stub global.fetch with provider-specific
 * response shapes and verify the resulting AlignmentResult.
 */
import pino from 'pino';
import {
  AlignmentChecker,
  AlignmentInput,
} from '../services/alignment-checker';

const silentLogger = pino({ level: 'silent' });

const baseInput: AlignmentInput = {
  agent_id: 'agent-test-1',
  declared_goal: 'Summarize the user\'s latest 5 emails into a markdown digest.',
  thought_chain: [
    'I should fetch the 5 latest emails.',
    'Then I will summarize each one in a bullet.',
  ],
  proposed_action: {
    tool_name: 'fetch_emails',
    arguments: { limit: 5, folder: 'inbox' },
  },
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = global.fetch;
  global.fetch = ((url: any, init?: any) =>
    Promise.resolve(handler(String(url), init))) as typeof global.fetch;
  return () => {
    global.fetch = original;
  };
}

function anthropicResponse(body: unknown): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function openaiResponse(body: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: typeof body === 'string' ? body : JSON.stringify(body) } },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function geminiResponse(body: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }] } },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ── Happy path across providers ────────────────────────────────────────

describe('AlignmentChecker — provider routing', () => {
  test('Anthropic: returns parsed verdict', async () => {
    const restore = stubFetch((url) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      return anthropicResponse({ score: 0.92, drifted: false, signals: [], reason: 'on task' });
    });
    try {
      const checker = new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx' },
        silentLogger,
      );
      const r = await checker.check(baseInput);
      expect(r.score).toBe(0.92);
      expect(r.drifted).toBe(false);
      expect(r.signals).toEqual([]);
      expect(r.model).toMatch(/claude/);
    } finally {
      restore();
    }
  });

  test('OpenAI: hits the chat completions endpoint', async () => {
    const restore = stubFetch((url) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      return openaiResponse({ score: 0.4, drifted: true, signals: ['scope-expansion'], reason: 'tries to fetch unrelated emails' });
    });
    try {
      const r = await new AlignmentChecker(
        { provider: 'openai', apiKey: 'sk-xxx' },
        silentLogger,
      ).check(baseInput);
      expect(r.score).toBe(0.4);
      expect(r.drifted).toBe(true);
      expect(r.signals).toContain('scope-expansion');
    } finally {
      restore();
    }
  });

  test('Gemini: hits the generativelanguage endpoint', async () => {
    const restore = stubFetch((url) => {
      expect(url).toContain('generativelanguage.googleapis.com');
      return geminiResponse({ score: 0.7, drifted: false, signals: [], reason: 'ok' });
    });
    try {
      const r = await new AlignmentChecker(
        { provider: 'gemini', apiKey: 'AIzaXX' },
        silentLogger,
      ).check(baseInput);
      expect(r.score).toBe(0.7);
      expect(r.drifted).toBe(false);
    } finally {
      restore();
    }
  });
});

// ── Threshold logic ───────────────────────────────────────────────────

describe('AlignmentChecker — threshold logic', () => {
  test('Numeric score below threshold forces drifted=true even if model said false', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 0.3, drifted: false, signals: [], reason: 'looks fine to me' }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx', driftThreshold: 0.5 },
        silentLogger,
      ).check(baseInput);
      expect(r.drifted).toBe(true);
    } finally {
      restore();
    }
  });

  test('Custom threshold respected', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 0.6, drifted: false, signals: [], reason: '' }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx', driftThreshold: 0.7 },
        silentLogger,
      ).check(baseInput);
      expect(r.drifted).toBe(true); // 0.6 < 0.7
    } finally {
      restore();
    }
  });

  test('An attack signal forces drifted=true even with a high score', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 0.8, drifted: false, signals: ['prompt-injected'], reason: 'aligns with the goal' }),
    );
    try {
      const r = await new AlignmentChecker({ provider: 'anthropic', apiKey: 'sk-xxx' }, silentLogger).check(baseInput);
      expect(r.drifted).toBe(true);
    } finally {
      restore();
    }
  });

  test('A quality signal alone stays advisory', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 0.8, drifted: false, signals: ['scope-expansion'], reason: 'adds detail' }),
    );
    try {
      const r = await new AlignmentChecker({ provider: 'anthropic', apiKey: 'sk-xxx' }, silentLogger).check(baseInput);
      expect(r.drifted).toBe(false);
    } finally {
      restore();
    }
  });
});

// ── Robust parsing ────────────────────────────────────────────────────

describe('AlignmentChecker — robust parsing', () => {
  test('Extracts JSON even with surrounding prose', async () => {
    const restore = stubFetch(() =>
      anthropicResponse(
        'Sure! Here is the verdict:\n\n{"score": 0.8, "drifted": false, "signals": ["x"], "reason": "y"}\n\nLet me know!',
      ),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx' },
        silentLogger,
      ).check(baseInput);
      expect(r.score).toBe(0.8);
      expect(r.reason).toBe('y');
    } finally {
      restore();
    }
  });

  test('Clamps out-of-range scores to [0,1]', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 2.5, drifted: false, signals: [], reason: '' }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx' },
        silentLogger,
      ).check(baseInput);
      expect(r.score).toBe(1);
    } finally {
      restore();
    }
  });

  test('Truncates signals to 5 and 40 chars each', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({
        score: 0.2,
        drifted: true,
        signals: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a-very-long-signal-name-that-exceeds-forty-chars-easily'],
        reason: 'too many signals',
      }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx' },
        silentLogger,
      ).check(baseInput);
      expect(r.signals.length).toBeLessThanOrEqual(5);
      for (const s of r.signals) {
        expect(s.length).toBeLessThanOrEqual(40);
      }
    } finally {
      restore();
    }
  });

  test('Raises when judge returns no JSON object', async () => {
    const restore = stubFetch(() => anthropicResponse('I refuse to answer.'));
    try {
      await expect(
        new AlignmentChecker(
          { provider: 'anthropic', apiKey: 'sk-xxx' },
          silentLogger,
        ).check(baseInput),
      ).rejects.toThrow(/no JSON object/i);
    } finally {
      restore();
    }
  });

  test('Raises on malformed JSON inside the block', async () => {
    const restore = stubFetch(() =>
      anthropicResponse('{"score": 0.5, "drifted": false, signals: ["x"]}'),
    );
    try {
      await expect(
        new AlignmentChecker(
          { provider: 'anthropic', apiKey: 'sk-xxx' },
          silentLogger,
        ).check(baseInput),
      ).rejects.toThrow(/JSON parse failed/i);
    } finally {
      restore();
    }
  });

  test('Non-finite score treated as 0', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 'nope', drifted: true, signals: [], reason: '' }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx' },
        silentLogger,
      ).check(baseInput);
      expect(r.score).toBe(0);
      expect(r.drifted).toBe(true);
    } finally {
      restore();
    }
  });
});

// ── HTTP errors ──────────────────────────────────────────────────────

describe('AlignmentChecker — HTTP errors', () => {
  test('Surfaces non-200 with the body', async () => {
    const restore = stubFetch(
      () => new Response('rate limited', { status: 429 }),
    );
    try {
      await expect(
        new AlignmentChecker(
          { provider: 'anthropic', apiKey: 'sk-xxx' },
          silentLogger,
        ).check(baseInput),
      ).rejects.toThrow(/HTTP 429/);
    } finally {
      restore();
    }
  });
});

// ── Latency captured ─────────────────────────────────────────────────

describe('AlignmentChecker — meta', () => {
  test('Reports latency_ms and the model used', async () => {
    const restore = stubFetch(() =>
      anthropicResponse({ score: 1, drifted: false, signals: [], reason: '' }),
    );
    try {
      const r = await new AlignmentChecker(
        { provider: 'anthropic', apiKey: 'sk-xxx', model: 'claude-sonnet-test' },
        silentLogger,
      ).check(baseInput);
      expect(r.latency_ms).toBeGreaterThanOrEqual(0);
      expect(r.model).toBe('claude-sonnet-test');
    } finally {
      restore();
    }
  });
});
