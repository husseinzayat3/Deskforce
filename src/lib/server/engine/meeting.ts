import { Agent, TaskItem } from '../../types';
import * as store from '../store';
import { addCost, runModel } from '../llm';
import { appendLive } from '../live';
import { errorMessage } from '../../errors';
import { begin, finish } from './state';

/**
 * A meeting: the participants were asked to change the same files, so before any of them starts
 * they agree who does what. The first proposes, the others answer in turn, and the last one
 * writes down the plan they will all follow.
 */
export const holdMeeting = async (host: Agent, task: TaskItem, agents: Agent[], overBudget: boolean) => {
  // No money left for talking: the tasks that wait on the meeting still run one after the other
  if (overBudget) {
    store.transitionTask(task.id, 'PENDING', 'CANCELLED', { reviewNote: 'Skipped: the task budget was reached.' });
    return;
  }
  if (!store.transitionTask(task.id, 'PENDING', 'IN_PROGRESS')) return;
  const signal = begin(task.id, host.id);

  const wasCancelled = () => {
    const current = store.getTask(task.id);
    return !current || current.status === 'CANCELLED';
  };

  try {
    const guests = agents.filter(a => a.id !== host.id && task.participants?.includes(a.id));
    if (guests.length === 0) throw new Error('The other participants are no longer in the office.');
    const speakers = [host, ...guests];

    const rules = 'You are in a short meeting because you were asked to change the same files. Plain text only, no tags unless asked, and under 150 words.';
    const turns: { speaker: Agent; text: string }[] = [];
    let tokens = 0;
    let cost: number | undefined = 0;
    const models = new Set<string>();

    for (let index = 0; index < speakers.length; index++) {
      const speaker = speakers[index];
      const others = speakers.filter(a => a.id !== speaker.id).map(a => `${a.name}, the ${a.role}`).join(' and ');
      const isLast = index === speakers.length - 1;
      const instruction = index === 0
        ? 'Propose how to split the work so nobody overwrites anyone else: who changes which file or which part of it, and in what order.'
        : isLast
          ? 'Agree with what was said or adjust it, then give the final plan all of you will follow inside [PLAN] ... [/PLAN].'
          : 'Agree with the proposal or adjust it, briefly.';

      appendLive(task.id, `${index > 0 ? '\n\n' : ''}${speaker.name}: `);
      const turn = await runModel({
        provider: speaker.api,
        model: speaker.model,
        systemPrompt: `You are ${speaker.name}, the ${speaker.role}. You are meeting ${others}. ${rules}\n${instruction}`,
        prompt: `${task.prompt}${turns.length ? `\n\nSaid so far:\n${turns.map(t => `${t.speaker.name}: ${t.text}`).join('\n\n')}` : ''}`,
        maxTokens: 600,
        onText: delta => appendLive(task.id, delta),
        signal,
      });

      store.addAgentTokens(speaker.id, turn.tokens);
      tokens += turn.tokens;
      cost = addCost(cost, turn.cost);
      models.add(turn.model);
      turns.push({ speaker, text: turn.response.trim() });
    }

    if (wasCancelled()) return;

    const closing = turns[turns.length - 1].text;
    store.updateTask(task.id, {
      status: 'COMPLETED',
      completedAt: Date.now(),
      response: turns.map(t => `${t.speaker.name}: ${t.text}`).join('\n\n'),
      summary: closing.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/i)?.[1].trim() || closing,
      tokens,
      cost,
      model: Array.from(models).join(' / '),
    });
  } catch (e) {
    if (!wasCancelled()) {
      // The tasks waiting on the meeting still run, one after the other
      store.updateTask(task.id, { status: 'FAILED', error: errorMessage(e) || 'Unknown error' });
    }
  } finally {
    finish(task.id, host.id);
  }
};
