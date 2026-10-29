import { studioClockScript } from './studioClock';
import { runDOMChecks } from './studioChecks';
export type PreviewMessage = { channel: 'studio-preview'; nonce: string; kind: 'loaded' | 'error' | 'checks'; message: string };

// Install before the generated scripts; readiness means loaded, never acceptance passed.
export function prepareStudioPreview(html: string, nonce: string, options?: { clock?: boolean }): string {
  const token = JSON.stringify(nonce).replace(/</g, '\\u003c');
  const bridge = `<script>(()=>{
    const send=(kind,message)=>parent.postMessage({channel:'studio-preview',nonce:${token},kind,message:String(message).slice(0,kind==='checks'?30000:2000)},'*');
    let errors=0;
    const report=message=>{if(errors++<20)send('error',message)};
    window.addEventListener('error',event=>{if(event.target===window)report(event.message+' ('+(event.filename||'preview')+':'+event.lineno+')')});
    window.addEventListener('unhandledrejection',event=>{const reason=event.reason;report(reason instanceof Error?reason.message:reason)});
    window.addEventListener('DOMContentLoaded',()=>send('loaded','Preview document loaded'),{once:true});
    let checked=false;
    window.addEventListener('message',async event=>{
      const data=event.data;
      if(checked||event.source!==parent||!data||data.channel!=='studio-checks'||data.nonce!==${token}||!Array.isArray(data.checks)||data.checks.length>10)return;
      checked=true;
      const run=${runDOMChecks.toString()};
      send('checks',JSON.stringify(await run(document,data.checks,()=>errors)));
    });
  })();</script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bridge + (options?.clock ? studioClockScript : ''));
}

export function readPreviewMessage(event: MessageEvent, frame: Window | null, nonce: string): PreviewMessage | null {
  if (!frame || event.source !== frame) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.channel !== 'studio-preview' || data.nonce !== nonce
    || !['loaded', 'error', 'checks'].includes(data.kind) || typeof data.message !== 'string' || data.message.length > (data.kind === 'checks' ? 30000 : 2000)) return null;
  return data as PreviewMessage;
}
