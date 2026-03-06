/**
 * Zero-code auto-instrumentation.
 * Patches Anthropic, OpenAI, LangChain.js, and Vercel AI SDK at the module level.
 *
 * Usage:
 *   import agentguard from 'agentguard'
 *   agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })
 */

import { AgentGuard } from '../core/tracer.js';
import type { AgentGuardConfig } from '../core/types.js';
import { AgentGuardBlockedError } from '../core/types.js';

type PatchResult = { framework: string; ok: boolean };

export class AutoInstrument {
  private readonly guard: AgentGuard;
  // Pending tool calls for Anthropic/OpenAI (request/response split)
  private readonly pending = new Map<string, {
    toolName: string; prompt: string; args: Record<string, unknown>; startTime: number;
  }>();

  constructor(guard: AgentGuard) {
    this.guard = guard;
  }

  /** Patch all available frameworks and return a summary. */
  patchAll(): PatchResult[] {
    return [
      this.patchAnthropic(),
      this.patchOpenAI(),
      this.patchLangChain(),
      this.patchVercelAI(),
    ];
  }

  // ── Anthropic ─────────────────────────────────────────────────────────────

  patchAnthropic(): PatchResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/sdk');
      const Messages = sdk?.default?.Messages ?? sdk?.Messages;
      if (!Messages?.prototype?.create) throw new Error('Messages.create not found');

      const original = Messages.prototype.create as Function;
      const instrument = this;

      Messages.prototype.create = async function (this: unknown, params: Record<string, unknown>) {
        const messages = (params.messages as Record<string, unknown>[] | undefined) ?? [];

        // ① Collect tool_results → complete pending traces
        for (const msg of messages) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content as Record<string, unknown>[]) {
            if (block.type !== 'tool_result') continue;
            const tid = block.tool_use_id as string;
            const pending = instrument.pending.get(tid);
            if (!pending) continue;
            instrument.pending.delete(tid);
            const result = Array.isArray(block.content)
              ? (block.content as Record<string, unknown>[]).map((b) => b.text ?? '').join(' ')
              : (block.content as string | undefined) ?? '';
            instrument.guard.sendTrace({ toolName: pending.toolName, prompt: pending.prompt, arguments: pending.args, startTime: pending.startTime, result });
          }
        }

        // ② Make real call
        const response = await original.call(this, params);

        // ③ Extract tool_use blocks → store as pending (+ optional block check)
        if (response?.stop_reason === 'tool_use' && Array.isArray(response.content)) {
          const lastPrompt = instrument.extractLastPrompt(messages);
          for (const block of response.content as Record<string, unknown>[]) {
            if (block.type !== 'tool_use') continue;
            const toolName = block.name as string;
            const args = (block.input ?? {}) as Record<string, unknown>;

            if (instrument.guard.config.blockingMode) {
              await instrument.guard.enforceBlock(toolName, args);
            }

            instrument.pending.set(block.id as string, {
              toolName,
              prompt: lastPrompt,
              args,
              startTime: Date.now(),
            });
          }
        }

        return response;
      };

      return { framework: 'Anthropic', ok: true };
    } catch (err) {
      return { framework: 'Anthropic', ok: false };
    }
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────

  patchOpenAI(): PatchResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('openai');
      const Completions = sdk?.default?.Chat?.Completions ?? sdk?.Chat?.Completions;
      if (!Completions?.prototype?.create) throw new Error('Completions.create not found');

      const original = Completions.prototype.create as Function;
      const instrument = this;

      Completions.prototype.create = async function (this: unknown, params: Record<string, unknown>) {
        const messages = (params.messages as Record<string, unknown>[] | undefined) ?? [];

        // ① Collect tool results
        for (const msg of messages) {
          if (msg.role !== 'tool') continue;
          const tid = msg.tool_call_id as string;
          const pending = instrument.pending.get(tid);
          if (!pending) continue;
          instrument.pending.delete(tid);
          instrument.guard.sendTrace({ toolName: pending.toolName, prompt: pending.prompt, arguments: pending.args, startTime: pending.startTime, result: msg.content });
        }

        // ② Real call
        const response = await original.call(this, params);

        // ③ Extract tool_calls
        const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
        if (choice?.finish_reason === 'tool_calls' && Array.isArray(choice.message?.tool_calls)) {
          const lastPrompt = instrument.extractLastPrompt(messages);
          for (const tc of choice.message.tool_calls as Record<string, unknown>[]) {
            const fn = tc.function as Record<string, unknown>;
            const toolName = fn.name as string;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse((fn.arguments as string) || '{}'); } catch { /* */ }

            if (instrument.guard.config.blockingMode) {
              await instrument.guard.enforceBlock(toolName, args);
            }

            instrument.pending.set(tc.id as string, {
              toolName,
              prompt: lastPrompt,
              args,
              startTime: Date.now(),
            });
          }
        }

        return response;
      };

      return { framework: 'OpenAI', ok: true };
    } catch {
      return { framework: 'OpenAI', ok: false };
    }
  }

  // ── LangChain.js ──────────────────────────────────────────────────────────

  patchLangChain(): PatchResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@langchain/core/tools');
      const BaseTool = mod?.StructuredTool ?? mod?.Tool ?? mod?.BaseTool;
      if (!BaseTool?.prototype?.invoke) throw new Error('BaseTool.invoke not found');

      const original = BaseTool.prototype.invoke as Function;
      const instrument = this;

      BaseTool.prototype.invoke = async function (
        this: { name?: string },
        input: unknown,
        config?: unknown
      ) {
        const toolName = this.name ?? 'unknown';
        const args = typeof input === 'object' && input !== null
          ? (input as Record<string, unknown>)
          : { input: String(input) };
        const prompt = typeof input === 'string' ? input : JSON.stringify(input);
        const startTime = Date.now();

        if (instrument.guard.config.blockingMode) {
          await instrument.guard.enforceBlock(toolName, args);
        }

        let result: unknown;
        let error: string | undefined;
        try {
          result = await original.call(this, input, config);
          return result;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          instrument.guard.sendTrace({ toolName, prompt, arguments: args, startTime, result, error });
        }
      };

      return { framework: 'LangChain', ok: true };
    } catch {
      return { framework: 'LangChain', ok: false };
    }
  }

  // ── Vercel AI SDK ─────────────────────────────────────────────────────────

  patchVercelAI(): PatchResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('ai');
      if (!mod?.tool) throw new Error('ai.tool not found');

      const originalTool = mod.tool as Function;
      const instrument = this;

      mod.tool = function (config: Record<string, unknown>) {
        const wrapped = originalTool(config);
        const originalExecute = wrapped.execute as Function | undefined;
        if (!originalExecute) return wrapped;

        const toolName = (config.description as string | undefined) ?? 'ai-tool';
        wrapped.execute = async function (args: Record<string, unknown>, options?: unknown) {
          const startTime = Date.now();

          if (instrument.guard.config.blockingMode) {
            await instrument.guard.enforceBlock(toolName, args);
          }

          let result: unknown;
          let error: string | undefined;
          try {
            result = await originalExecute.call(this, args, options);
            return result;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            instrument.guard.sendTrace({
              toolName, prompt: JSON.stringify(args),
              arguments: args, startTime, result, error,
            });
          }
        };
        return wrapped;
      };

      return { framework: 'Vercel AI', ok: true };
    } catch {
      return { framework: 'Vercel AI', ok: false };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractLastPrompt(messages: Record<string, unknown>[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
        }
      }
    }
    return '';
  }
}

// ── Public one-liner API ────────────────────────────────────────────────────

let _defaultGuard: AgentGuard | null = null;

/**
 * Zero-code auto-instrumentation.
 *
 * @example
 * import agentguard from 'agentguard'
 * agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })
 */
export function auto(
  gatewayUrl: string,
  options: Omit<AgentGuardConfig, 'gatewayUrl'>
): AgentGuard {
  const guard = new AgentGuard({ gatewayUrl, ...options });
  const instrument = new AutoInstrument(guard);
  const results = instrument.patchAll();

  const patched = results.filter((r) => r.ok).map((r) => r.framework);
  const failed  = results.filter((r) => !r.ok).map((r) => r.framework);

  console.log(
    `[AgentGuard] Auto-patched: ${patched.join(', ') || 'none'}` +
    (failed.length ? ` | Not found (ok): ${failed.join(', ')}` : '')
  );

  _defaultGuard = guard;
  return guard;
}

export { AgentGuardBlockedError };
