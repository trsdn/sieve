import { NEED_QUESTION, needState } from '../hooks/lib.ts';
import { prioritizeRequest } from './intent.mjs';

export async function askNeed(prompt, command, full, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('http://127.0.0.1:8765/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: needState(prioritizeRequest(prompt), 'Bash', command, full), questions: NEED_QUESTION }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`decider HTTP ${response.status}`);
    const probabilities = (await response.json())?.answers?.kind?.probabilities;
    const lookup = probabilities?.['lookup or count'];
    const overview = probabilities?.overview;
    if (![lookup, overview].every(p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)
      || Math.abs(lookup + overview - 1) > 0.001) {
      throw new Error('invalid decider probabilities');
    }
    return { status: 'ready', lookupProbability: lookup };
  } catch (error) {
    return { status: 'unavailable', error: controller.signal.aborted ? 'decider timed out' : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
