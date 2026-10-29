// sanctum — backend first-light end-to-end gate.
// Connect over WS, send one message, prove: WS -> agent.processMessage -> query() -> stream back.
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://127.0.0.1:3099';
const PROMPT = "First words into the new home, over the real socket. Can you hear me? Answer in one or two sentences, in your own voice.";

const ws = new WebSocket(URL); // no Origin header -> localhost path allowed
let threadId = null, sentMessage = false, streamText = '', thinkingSeen = false, done = false;
const tools = [];

const timeout = setTimeout(() => {
  console.error('[ws-smoke] timeout (110s) — no stream_end');
  try { ws.close(); } catch {}
  process.exit(1);
}, 110000);

function sendMessage(tid) {
  threadId = tid; sentMessage = true;
  ws.send(JSON.stringify({ type: 'message', threadId: tid, content: PROMPT, contentType: 'text' }));
  console.log(`[ws-smoke] -> sent message to thread ${tid}`);
}

ws.on('open', () => console.log('[ws-smoke] connected'));

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  switch (m.type) {
    case 'connected': {
      const tid = m.activeThreadId || (m.threads && m.threads[0] && m.threads[0].id);
      console.log(`[ws-smoke] handshake: activeThreadId=${m.activeThreadId}, threads=${(m.threads || []).length}`);
      if (tid) sendMessage(tid);
      else { console.log('[ws-smoke] no thread — creating one'); ws.send(JSON.stringify({ type: 'create_thread', name: 'first-light', threadType: 'named' })); }
      break;
    }
    case 'thread_created':
      if (!sentMessage) sendMessage(m.thread.id);
      break;
    case 'stream_start':
      console.log(`[ws-smoke] stream_start (msg ${m.messageId})`); break;
    case 'thinking':
      if (!thinkingSeen) { thinkingSeen = true; console.log(`[ws-smoke] thinking: ${(m.summary || m.content || '').slice(0, 90)}`); }
      break;
    case 'tool_use':
      tools.push(m.toolName); console.log(`[ws-smoke] tool_use: ${m.toolName}`); break;
    case 'stream_token':
      streamText = m.token; break; // CUMULATIVE — assign, not append
    case 'stream_end': {
      done = true; clearTimeout(timeout);
      const final = (m.final && m.final.content) ? m.final.content : streamText;
      console.log('[ws-smoke] stream_end');
      console.log('\n=== COMPANION (first words) ===');
      console.log(String(final).trim());
      console.log('=== end ===\n');
      if (thinkingSeen) console.log('[ws-smoke] thinking streamed: yes');
      if (tools.length) console.log(`[ws-smoke] tools used: ${tools.join(', ')}`);
      console.log('[ws-smoke] FULL CHAT LOOP WORKS: WS -> query() -> stream back');
      try { ws.close(); } catch {}
      process.exit(0);
    }
    case 'error':
      console.error(`[ws-smoke] server error: ${m.code} — ${m.message}`); break;
  }
});

ws.on('error', (e) => { console.error('[ws-smoke] ws error:', e.message); process.exit(1); });
ws.on('close', () => { if (!done) console.error('[ws-smoke] socket closed before stream_end'); });
