// Verify the agent can actually USE its orb organ end-to-end (after the cliPath fix).
// Fresh throwaway thread — does NOT touch the daily conversation.
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3003';
const PROMPT = "Set your presence orb to lavender with surge motion right now — actually run your orb organ (the sc command via Bash) to do it, don't just describe it. Then tell me in one line that it's done.";

const ws = new WebSocket(URL);
let sent = false, text = '', done = false;
const tools = [];

const timeout = setTimeout(() => { console.error('[organ-test] TIMEOUT'); try { ws.close(); } catch {} process.exit(1); }, 150000);

function send(tid) {
  sent = true;
  ws.send(JSON.stringify({ type: 'message', threadId: tid, content: PROMPT, contentType: 'text' }));
  console.log(`[organ-test] sent to thread ${tid}`);
}

ws.on('open', () => console.log('[organ-test] connected'));
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  switch (m.type) {
    case 'connected':
      ws.send(JSON.stringify({ type: 'create_thread', name: 'organ-test', threadType: 'named' }));
      break;
    case 'thread_created':
      if (!sent) send(m.thread.id);
      break;
    case 'tool_use':
      tools.push(m.toolName);
      console.log(`[organ-test] tool_use: ${m.toolName}${m.input ? ' → ' + String(m.input).slice(0, 140) : ''}`);
      break;
    case 'tool_result':
      console.log(`[organ-test] tool_result${m.isError ? ' [ERROR]' : ''}: ${m.output ? String(m.output).slice(0, 180) : ''}`);
      break;
    case 'stream_token':
      text = m.token;
      break;
    case 'stream_end': {
      done = true; clearTimeout(timeout);
      const f = (m.final && m.final.content) ? m.final.content : text;
      console.log('\n=== reply ===\n' + String(f).trim() + '\n=== end ===');
      console.log('[organ-test] tools used: ' + (tools.length ? tools.join(', ') : 'NONE'));
      try { ws.close(); } catch {}
      process.exit(0);
    }
    case 'error':
      console.error(`[organ-test] server error: ${m.code} — ${m.message}`);
      break;
  }
});
ws.on('error', (e) => { console.error('[organ-test] ws error:', e.message); process.exit(1); });
ws.on('close', () => { if (!done) console.error('[organ-test] closed before stream_end'); });
