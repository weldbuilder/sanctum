// Stage-0 cadence probe: fire ONE real interactive thinking+tool turn over WS,
// timestamp every server event, print a cadence report. Run from backend pkg dir
// so `ws` resolves. Usage: node scripts/cadence-probe.mjs
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3003';
const THREAD = process.env.PROBE_THREAD || 'daily-2026-06-18';
const PROMPT = process.env.PROBE_PROMPT ||
  'Reason carefully through what shape of presence actually fits this exact moment between us — really think it through, weigh a couple of options — then run a quick `date +%H:%M` via Bash to ground yourself in the time before you answer. Show your reasoning, then give me a few full paragraphs of real presence so I can watch the markdown stream.';

const t0 = Date.now();
const ms = () => (Date.now() - t0).toString().padStart(6, ' ');

let tokenCount = 0;
let tokenChars = 0;
let lastTokenAt = null;
const tokenGaps = [];
const tokenSizes = [];
let thinkingEvents = 0;
let thinkingChars = 0;
let firstTokenAt = null;
let streamStartAt = null;
const toolEvents = [];

const ws = new WebSocket(URL, { origin: 'http://127.0.0.1:3003' });

ws.on('open', () => {
  console.log(`${ms()} [open] connected`);
});

ws.on('message', (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  switch (m.type) {
    case 'connected':
      console.log(`${ms()} [connected] sending message to ${THREAD}`);
      ws.send(JSON.stringify({ type: 'message', threadId: THREAD, content: PROMPT, contentType: 'text' }));
      break;
    case 'presence':
      // noisy; skip
      break;
    case 'thinking':
      thinkingEvents++;
      thinkingChars += (m.summary || m.content || '').length;
      console.log(`${ms()} [thinking] #${thinkingEvents} +${(m.summary||m.content||'').length}ch  "${(m.summary||m.content||'').slice(0,60).replace(/\n/g,' ')}"`);
      break;
    case 'stream_start':
      streamStartAt = Date.now() - t0;
      console.log(`${ms()} [stream_start] ${m.messageId}`);
      break;
    case 'stream_token': {
      const now = Date.now();
      if (firstTokenAt === null) firstTokenAt = now - t0;
      if (lastTokenAt !== null) tokenGaps.push(now - lastTokenAt);
      lastTokenAt = now;
      tokenCount++;
      const len = (m.token || '').length;
      tokenChars += len;
      tokenSizes.push(len);
      if (tokenCount <= 5 || tokenCount % 25 === 0) {
        console.log(`${ms()} [token] #${tokenCount} +${len}ch`);
      }
      break;
    }
    case 'tool_use':
      toolEvents.push({ at: Date.now() - t0, kind: 'use', name: m.toolName, complete: m.isComplete, offset: m.textOffset });
      console.log(`${ms()} [tool_use] ${m.toolName} complete=${m.isComplete} textOffset=${m.textOffset ?? '-'}`);
      break;
    case 'tool_result':
      toolEvents.push({ at: Date.now() - t0, kind: 'result', err: m.isError });
      console.log(`${ms()} [tool_result] err=${!!m.isError} ${(m.output||'').slice(0,50).replace(/\n/g,' ')}`);
      break;
    case 'stream_end': {
      const dur = Date.now() - t0;
      console.log(`${ms()} [stream_end] done`);
      report(dur);
      ws.close();
      setTimeout(() => process.exit(0), 200);
      break;
    }
    case 'error':
      console.log(`${ms()} [ERROR] ${m.code}: ${m.message}`);
      break;
    default:
      // console.log(`${ms()} [${m.type}]`);
      break;
  }
});

ws.on('error', (e) => { console.log(`${ms()} [ws-error] ${e.message}`); process.exit(1); });

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

function report(dur) {
  const sum = tokenGaps.reduce((a, b) => a + b, 0);
  const mean = tokenGaps.length ? (sum / tokenGaps.length) : 0;
  const avgSize = tokenSizes.length ? (tokenChars / tokenSizes.length) : 0;
  console.log('\n==================== CADENCE REPORT ====================');
  console.log(`total turn:        ${dur}ms`);
  console.log(`stream_start at:   ${streamStartAt}ms`);
  console.log(`first token at:    ${firstTokenAt}ms (TTFT from start)`);
  console.log(`thinking events:   ${thinkingEvents}  (${thinkingChars} chars total)`);
  console.log(`tool events:       ${toolEvents.length}  [${toolEvents.map(t=>t.kind+':'+(t.name||'')).join(', ')}]`);
  console.log(`stream tokens:     ${tokenCount}  (${tokenChars} chars, avg ${avgSize.toFixed(1)} ch/token)`);
  console.log(`inter-token gap:   mean ${mean.toFixed(1)}ms  p50 ${pct(tokenGaps,50)}ms  p90 ${pct(tokenGaps,90)}ms  p99 ${pct(tokenGaps,99)}ms  max ${Math.max(0,...tokenGaps)}ms`);
  const tokPerSec = tokenCount && dur ? (tokenCount / (dur/1000)) : 0;
  console.log(`throughput:        ${tokPerSec.toFixed(1)} tokens/s (over whole turn)`);
  // token-size shape
  const small = tokenSizes.filter(s=>s<=4).length, big = tokenSizes.filter(s=>s>20).length;
  console.log(`token shape:       ${small} small(<=4ch)  ${big} big(>20ch)  -> ${small>big*3?'MANY-SMALL-DELTAS':'MIXED/CHUNKED'}`);
  console.log('========================================================');
}

setTimeout(() => { console.log(`${ms()} [timeout] no stream_end after 180s`); report(Date.now()-t0); process.exit(2); }, 180000);
