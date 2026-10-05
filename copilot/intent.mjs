const DETAIL = /\b(?:lookup|look up|exact|precise|complete|full|find|locate|retrieve|extract|which|who|where|how many|all|every|token|lookup_token|identifier|uuid|record|price|field|filename|exakt|genau|vollstandig|alle|jede|finde|suche|welche|welcher|welches|wer|wo|wie viele)\b/;
const PRECISION = /\b(?:measurement|duration|latency|runtime|slowest|fastest|largest|smallest|runner[- ]up|predecessor|successor|middle|cent(?:re|er)|median|mean|percentile|p\d{2,3}|(?:test|spec|case|metric)[_-]\w+|laufzeit|messwert|mittelwert|durchschnitt|langsamst\w*|schnellst\w*)\b/;
const SUMMARY = [
  /^(?:please )?summari[sz]e (?:the )?(?:(?:test|build) )?(?:output|results)(?: briefly)?$/,
  /^(?:please )?(?:give|show|provide)(?: me)? (?:a )?(?:brief |short |overall )?(?:summary|overview)(?: of (?:the )?(?:(?:test|build) )?(?:output|results))?$/,
  /^report (?:the )?passed and failed (?:test )?(?:totals|counts)(?: and (?:the )?shell exit code)?$/,
  /^(?:bitte )?fasse (?:die )?(?:testausgabe|testergebnisse|buildausgabe|ausgabe) (?:kurz )?zusammen$/,
  /^(?:bitte )?(?:gib|zeige)(?: mir)? (?:eine[n]? )?(?:kurze[n]? )?(?:zusammenfassung|ubersicht|uberblick)(?: (?:der|uber die) (?:testausgabe|testergebnisse|buildausgabe|ausgabe))?$/,
];

function isInstruction(clause) {
  if (/\b(?:but|instead|rather|however)\b/.test(clause)) return false;
  if (/^do not (?:read|edit|modify|write|delete|delegate|use|rerun|inspect)\b/.test(clause)
    && !/\b(?:give|show|provide|determine|include)\b/.test(clause)) return true;
  if (/^do not look up(?: or report)?\b/.test(clause)) return true;
  if (/^you may use (?:targeted )?(?:grep|view|tools?)\b/.test(clause)
    && !/\b(?:give|show|provide|report|determine|include)\b/.test(clause)) return true;
  if (/^never rerun\b/.test(clause)) return true;
  if (/^run exactly `[^`]+` once\b/.test(clause)
    && !/\b(?:report|determine|summari[sz]e|show|give|provide|include)\b/.test(clause)) return true;
  if (/^this is a bounded local synthetic (?:tool-)?output (?:benchmark|experiment)$/.test(clause)) return true;
  return /^final answer must be only one json object with integer keys "(?:passed|failed|exit)", "(?:passed|failed|exit)", and "(?:passed|failed|exit)", with no prose or code fences$/.test(clause)
    || /^(?:then stop|stop)$/.test(clause);
}

const ITEMS = '(?:source|fixture source|environment|environment variables|hooks|config|files)';
const LIST = '(?:, (?:or |and )?| (?:or|and) )';
const PROCEDURE = new RegExp(
  '^\\s*(?:'
  + 'run exactly `[^`\\r\\n]+` once(?:, synchronously)?(?:, without redirection or pipes)?'
  + `|do not read ${ITEMS}(?:${LIST}${ITEMS})*`
  + `|do not (?:edit files|delegate|use the network)(?:${LIST}(?:edit files|delegate|use the network))*`
  + '|you may use targeted grep or view on the original-output file named in the result'
  + '|never rerun the fixture'
  + '|f(?:u|\\u00fc)hre genau `[^`\\r\\n]+` einmal aus'
  + '|keine dateien bearbeiten'
  + ')[.!?;](\\s+|$)',
  'iu',
);

export function prioritizeRequest(prompt) {
  let end = 0;
  let gap = '';
  let match;
  while ((match = PROCEDURE.exec(prompt.slice(end)))) {
    end += match[0].length;
    gap = match[1];
  }
  if (!end || end === prompt.length || !gap) return prompt;
  const task = prompt.slice(end);
  if (/\b(?:above|below|preceding|following|previous|former|latter|oben|unten)\b/iu.test(task)
    || /^(?:then|afterwards|before|after|unless|otherwise|dann|danach|vorher|falls)\b/iu.test(task)) {
    return prompt;
  }
  return task + gap + prompt.slice(0, end - gap.length);
}

export function classifyRequest(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return 'unknown';
  const clauses = prompt.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[.!?](?:\s+|$)|[\n;]/).map(clause => clause.trim()).filter(Boolean);
  let summaries = 0;
  let unknown = false;
  for (const clause of clauses) {
    if (isInstruction(clause)) continue;
    if (DETAIL.test(clause) || PRECISION.test(clause)) return 'lookup';
    if (SUMMARY.some(pattern => pattern.test(clause))) summaries++;
    else unknown = true;
  }
  return summaries > 0 && !unknown ? 'summary' : 'unknown';
}
