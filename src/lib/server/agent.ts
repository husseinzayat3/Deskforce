import { APIProvider } from '../types';
import { ImagePart, ToolCall, ToolResult, ToolSpec, Turn, addCost, runStep } from './llm';

/**
 * The tool loop: the model works by calling functions (read a file, write a file, delegate…)
 * until it answers with plain text, which is its summary of the work.
 */

/** Most steps one task may take; each step is one model call. */
const MAX_STEPS = 30;
/** Steps a task gets to wrap up after it was told its budget is spent. */
const STEPS_AFTER_BUDGET = 2;
/** Room for one step's answer. Whole files are written in a single call, so it is generous. */
const STEP_MAX_TOKENS = 12000;
/** Longest tool result handed back to the model. */
const MAX_RESULT_CHARS = 30_000;

/** What running one tool produced. */
export interface ToolOutcome {
  output: string;
  isError?: boolean;
  /** Tokens and cost the tool itself used (a web search is a model call of its own). */
  tokens?: number;
  cost?: number | undefined;
  /** End the task after this call: the agent is waiting for the user. */
  stop?: boolean;
}

export interface AgentTool extends ToolSpec {
  /** One line for the live view and the transcript, e.g. "saved file: lib/main.dart". */
  describe: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome;
}

export interface AgentRun {
  /** The model's closing message: its summary of the work. */
  finalText: string;
  /** Everything it wrote along the way, with a line per tool call. Stored as the task's response. */
  transcript: string;
  tokens: number;
  cost: number | undefined;
  model: string;
  /** True when the loop was stopped by a tool (the agent asked the user something). */
  stopped: boolean;
  problems: string[];
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

export const runAgent = async ({ provider, model, system, prompt, images, tools, nativeWeb, overBudget, onText, signal }: {
  provider: APIProvider;
  model?: string;
  system: string;
  prompt: string;
  images?: ImagePart[];
  tools: AgentTool[];
  nativeWeb: boolean;
  /** Given what this run has cost so far, is the task's budget used up? */
  overBudget: (spent: number) => boolean;
  onText: (delta: string) => void;
  signal: AbortSignal;
}): Promise<AgentRun> => {
  const turns: Turn[] = [{ role: 'user', text: prompt, images }];
  const specs: ToolSpec[] = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const run: AgentRun = { finalText: '', transcript: '', tokens: 0, cost: 0, model: '', stopped: false, problems: [] };
  const note = (line: string) => {
    run.transcript += `${run.transcript && !run.transcript.endsWith('\n') ? '\n' : ''}${line}\n`;
    onText(`\n${line}\n`);
  };

  let budgetWarnedAt: number | undefined;
  let toolCallsMade = 0;
  let reminded = false;
  const canWrite = tools.some(tool => tool.name === 'write_file');

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await runStep({ provider, model, system, turns, tools: specs, maxTokens: STEP_MAX_TOKENS, nativeWeb, onText, signal });
    run.tokens += result.tokens;
    run.cost = addCost(run.cost, result.cost);
    run.model = result.model;
    if (result.text) run.transcript += `${run.transcript && !run.transcript.endsWith('\n') ? '\n' : ''}${result.text}`;

    // Cut off in the middle of a tool call: its arguments are incomplete, so it must not run
    if (result.truncated && result.toolCalls.length > 0) {
      turns.push(
        { role: 'assistant', text: result.text || '(cut off)' },
        { role: 'user', text: 'Your last message hit the length limit in the middle of a tool call, so nothing was done. Do it again in smaller pieces: write a long file as a shorter first version with write_file and extend it with edit_file, or split it into several files.' },
      );
      continue;
    }

    // Some models answer with the code in their message instead of saving it. Nothing was
    // written, so say so once and let them do it properly.
    if (result.toolCalls.length === 0 && toolCallsMade === 0 && !reminded && canWrite && /```|\[FILE:/.test(result.text)) {
      reminded = true;
      turns.push(
        { role: 'assistant', text: result.text, raw: result.raw },
        { role: 'user', text: 'Nothing has been saved: code or text in your message is not a file. Save each file with the write_file tool now, then reply with your summary.' },
      );
      note('(reminded to save files with tools)');
      continue;
    }

    if (result.toolCalls.length === 0) {
      run.finalText = result.text.trim();
      if (result.truncated) run.problems.push('The closing message reached the length limit and may be incomplete.');
      return run;
    }

    toolCallsMade += result.toolCalls.length;
    turns.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls, raw: result.raw });

    const results: ToolResult[] = [];
    for (const call of result.toolCalls) {
      const outcome = await runTool(tools, call);
      const tool = tools.find(t => t.name === call.name);
      note(`(${tool && !outcome.isError ? tool.describe(call.input) : `${call.name} failed: ${outcome.output.split('\n')[0]}`})`);
      run.tokens += outcome.tokens || 0;
      if (outcome.tokens) run.cost = addCost(run.cost, outcome.cost);
      if (outcome.stop) run.stopped = true;
      results.push({
        id: call.id,
        name: call.name,
        output: outcome.output.length > MAX_RESULT_CHARS ? `${outcome.output.slice(0, MAX_RESULT_CHARS)}\n[cut: the result was longer]` : outcome.output,
        isError: outcome.isError,
      });
      if (signal.aborted) throw new Error('The task was stopped.');
    }

    if (run.stopped) return run;

    // Out of money: say so once, give a couple of steps to finish cleanly, then stop
    if (overBudget(run.cost || 0)) {
      if (budgetWarnedAt === undefined) {
        budgetWarnedAt = step;
        results[results.length - 1].output += '\n\n[Office] The budget for this task is used up. Make no further changes: reply now with your summary, saying what is done and what is not.';
      } else if (step - budgetWarnedAt >= STEPS_AFTER_BUDGET) {
        run.problems.push('Stopped: the task budget was used up before the work was finished.');
        return run;
      }
    }

    turns.push({ role: 'tool', results });
  }

  run.problems.push(`Stopped after ${MAX_STEPS} steps without finishing.`);
  return run;
};

const runTool = async (tools: AgentTool[], call: ToolCall): Promise<ToolOutcome> => {
  if (call.invalid) return { output: call.invalid, isError: true };
  const tool = tools.find(t => t.name === call.name);
  if (!tool) return { output: `There is no tool called "${call.name}". Available: ${tools.map(t => t.name).join(', ')}.`, isError: true };
  try {
    return await tool.run(call.input || {});
  } catch (e: any) {
    return { output: str(e?.message) || 'The tool failed.', isError: true };
  }
};
