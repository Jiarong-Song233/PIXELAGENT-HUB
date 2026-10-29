/**
 * A local OpenAI-compatible chat endpoint backed by the official Codex CLI, so PLAY LIVE benchmarks
 * can run on a ChatGPT subscription instead of a paid API key. Each request runs one
 * `codex exec` in an empty read-only sandbox and streams its final message back as one SSE chunk.
 *
 *   npx tsx scripts/codex-chat-server.ts [--port 8787] [--effort low] [--timeout 240]
 *
 * Point PLAY LIVE (or benchmark-live.ts --provider custom) at http://localhost:8787/v1. Codex adds
 * its own agent prompt, so replies are slower (tens of seconds) and usage counts include that
 * overhead. Requests are served one at a time.
 */
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const port = Number(argument('--port') || 8787);
const effort = argument('--effort') || 'low';
if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('--effort must be minimal, low, medium, high or xhigh');
const timeoutMs = Number(argument('--timeout') || 240) * 1000;
let queue = Promise.resolve();

type Message = { role: string; content: string };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

async function codex(model: string, messages: Message[]): Promise<{ content: string; usage?: Usage }> {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-chat-'));
  try {
    const prompt = [
      'You are answering one chat-completion request. Do not run commands, read files or use tools.',
      'Reply with the answer only, exactly in the format the instructions ask for.',
      ...messages.map((message) => `\n--- ${message.role.toUpperCase()} ---\n${message.content}`),
    ].join('\n');
    const out = join(cwd, 'last.txt');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-s', 'read-only', '-m', model,
      '-c', `model_reasoning_effort="${effort}"`, '-c', 'approval_policy="never"', '-o', out, '-'];
    const events = await new Promise<string>((resolve, reject) => {
      const child = spawn('codex', args, { cwd, shell: process.platform === 'win32' });
      let stdout = '';
      let stderr = '';
      // A hung CLI would block the one-at-a-time queue forever: kill its whole process tree.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`codex exceeded ${timeoutMs / 1000} s and was stopped`));
        else if (code === 0) resolve(stdout);
        else reject(new Error(`codex exited ${code}: ${(stdout.match(/"message":"([^"]+)"/)?.[1] || stderr).slice(0, 300)}`));
      });
      child.stdin.end(prompt);
    });
    const raw = [...events.matchAll(/"usage":\{"input_tokens":(\d+)[^}]*"output_tokens":(\d+)/g)].at(-1);
    const usage = raw ? { prompt_tokens: Number(raw[1]), completion_tokens: Number(raw[2]), total_tokens: Number(raw[1]) + Number(raw[2]) } : undefined;
    return { content: await readFile(out, 'utf8'), usage };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' };
const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return send(res, 404, { error: { message: 'Only POST /v1/chat/completions' } });
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || '{}') as { model?: string; messages?: Message[]; stream?: boolean };
  const model = request.model || 'gpt-6-luna';
  // On Windows the CLI runs through a shell, so only plain model names reach its command line.
  if (!/^[\w.-]{1,64}$/.test(model)) return send(res, 400, { error: { message: 'Invalid model name' } });
  const started = Date.now();
  // One Codex run at a time: the subscription is rate limited, and parallel agents only queue there.
  // A usage-limit reply waits and retries (the 5-hour window resets), for up to 5 hours.
  const attempt = async () => {
    for (let waited = 0; ; waited += 10) {
      try { return await codex(model, request.messages || []); }
      catch (error) {
        if (!/usage limit/i.test((error as Error).message) || waited >= 300) throw error;
        console.log(`${new Date().toISOString()} usage limit; waiting 10 min`);
        await new Promise((resolve) => setTimeout(resolve, 600_000));
      }
    }
  };
  const job = queue.then(attempt);
  queue = job.then(() => undefined, () => undefined);
  try {
    const { content, usage } = await job;
    console.log(`${new Date().toISOString()} ${model} ${((Date.now() - started) / 1000).toFixed(0)} s ${content.length} chars`);
    if (!request.stream) return send(res, 200, { model, choices: [{ message: { role: 'assistant', content } }], usage });
    res.writeHead(200, { 'content-type': 'text/event-stream', ...cors });
    res.write(`data: ${JSON.stringify({ model, choices: [{ delta: { content } }], usage: null })}\n\n`);
    res.end(`data: ${JSON.stringify({ model, choices: [{ delta: {} }], usage: usage ?? null })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    console.log(`${new Date().toISOString()} ${model} failed: ${(error as Error).message}`);
    send(res, 502, { error: { message: (error as Error).message } });
  }
}).listen(port, '127.0.0.1', () => console.log(`Codex chat endpoint on http://localhost:${port}/v1 (effort ${effort})`));
