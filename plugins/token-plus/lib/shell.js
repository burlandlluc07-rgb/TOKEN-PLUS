'use strict';
// A deliberately conservative shell-command scanner.
//
// It does NOT try to understand all of POSIX sh. Its job is to answer one question:
// "Is this command simple enough that appending/inserting flags cannot change its meaning?"
// Anything that involves expansion, redirection, pipes, subshells, heredocs, comments,
// background jobs or multiple statements is reported as complex and left untouched.
// The only compound form accepted is a single leading `cd <dir> && <command>`.

function scan(cmd) {
  const res = { ok: false, reason: '', segments: [], ops: [] };
  if (typeof cmd !== 'string' || !cmd.trim()) {
    res.reason = 'empty';
    return res;
  }
  const s = cmd;
  let tokens = [];
  let cur = null; // {raw:[start], value}
  let quote = null; // "'" or '"'
  let i = 0;

  const startTok = () => {
    if (!cur) cur = { start: i, value: '' };
  };
  const endTok = () => {
    if (cur) {
      cur.end = i;
      cur.raw = s.slice(cur.start, cur.end);
      tokens.push(cur);
      cur = null;
    }
  };
  const fail = (why) => {
    res.reason = why;
    res.ok = false;
    return res;
  };

  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur.value += c;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === '$' || c === '`') return fail('expansion inside double quotes');
      if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
        cur.value += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '\n') return fail('multiline quoted string');
      cur.value += c;
      i++;
      continue;
    }
    // unquoted
    if (c === ' ' || c === '\t') {
      endTok();
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') return fail('multiline command');
    if (c === "'" || c === '"') {
      startTok();
      quote = c;
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= s.length || s[i + 1] === '\n') return fail('line continuation');
      startTok();
      cur.value += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '&' && s[i + 1] === '&') {
      endTok();
      res.segments.push(tokens);
      res.ops.push('&&');
      tokens = [];
      i += 2;
      continue;
    }
    if (c === '|' && s[i + 1] === '|') return fail('|| operator');
    if (c === '|') return fail('pipe');
    if (c === ';') return fail('multiple statements');
    if (c === '&') return fail('background job');
    if (c === '<' || c === '>') return fail('redirection');
    if (c === '(' || c === ')') return fail('subshell or grouping');
    if (c === '`') return fail('command substitution');
    if (c === '$') return fail('parameter or command expansion');
    if (c === '#' && !cur) return fail('comment');
    if ((c === '{' || c === '}') && !cur) return fail('brace group');
    if (c === '!' && !cur) return fail('history/negation');
    startTok();
    cur.value += c;
    i++;
  }
  if (quote) return fail('unterminated quote');
  endTok();
  res.segments.push(tokens);

  if (res.segments.some((seg) => seg.length === 0)) return fail('empty segment');
  if (res.segments.length > 2) return fail('too many && segments');
  if (res.segments.length === 2) {
    const first = res.segments[0];
    if (!(first[0].value === 'cd' && first.length === 2)) return fail('&& only allowed after a single cd');
  }
  res.ok = true;
  return res;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Split a token list into leading env assignments and the command words.
function splitEnv(tokens) {
  let k = 0;
  while (k < tokens.length && ENV_ASSIGN.test(tokens[k].raw) && !tokens[k].raw.startsWith('=')) k++;
  return { env: tokens.slice(0, k), words: tokens.slice(k) };
}

// Quote a value for safe insertion into a shell command.
function quote(v) {
  if (v === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(v)) return v;
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

// Rebuild a command from scan() output with the last segment's words replaced.
// `newWords` is an array of raw strings (already quoted where needed).
function rebuild(scanRes, env, newWords) {
  const parts = [];
  if (scanRes.segments.length === 2) parts.push(scanRes.segments[0].map((t) => t.raw).join(' '), '&&');
  parts.push(...env.map((t) => t.raw), ...newWords);
  return parts.join(' ');
}

module.exports = { scan, splitEnv, quote, rebuild };
