// Raw script avoids bundler helper references in the sandbox. Only hidden test frames install it.
export const studioClockScript = `<script>(()=>{
  const NativeDate=Date, realNow=performance.now.bind(performance), realTimeout=setTimeout.bind(window);
  const epoch=NativeDate.now(), origin=realNow(), timers=new Map();
  let time=0, anchor=origin, nextId=1, running=false;
  const now=()=>running?time:time+realNow()-anchor;
  const schedule=(callback,delay,args,interval,raf=false)=>{
    const id=nextId++;
    let duration=Number(delay)||0;
    duration=Number.isFinite(duration)?Math.max(0,duration>2147483647?1:duration):0;
    timers.set(id,{id,callback,args,interval,duration,raf,due:raf?(Math.floor(now()/16)+1)*16:now()+(duration||(running?1:0))});
    return id;
  };
  window.setTimeout=(callback,delay,...args)=>schedule(callback,delay,args,false);
  window.setInterval=(callback,delay,...args)=>schedule(callback,delay,args,true);
  window.clearTimeout=window.clearInterval=id=>timers.delete(id);
  window.requestAnimationFrame=callback=>schedule(callback,16,[],false,true);
  window.cancelAnimationFrame=window.clearTimeout;
  const ClockDate=function(...args){
    if(!new.target)return new NativeDate(epoch+now()).toString();
    return args.length?new NativeDate(...args):new NativeDate(epoch+now());
  };
  Object.setPrototypeOf(ClockDate,NativeDate);
  ClockDate.prototype=NativeDate.prototype;
  ClockDate.now=()=>Math.floor(epoch+now());
  window.Date=ClockDate;
  Object.defineProperty(performance,'now',{value:now});
  const next=end=>{
    let first;
    for(const timer of timers.values())if(timer.due<=end&&(!first||timer.due<first.due||timer.due===first.due&&timer.id<first.id))first=timer;
    return first;
  };
  const fire=timer=>{
    time=Math.max(time,timer.due);
    if(timer.interval)timer.due+=timer.duration;else timers.delete(timer.id);
    try{
      if(typeof timer.callback==='function')timer.callback.apply(window,timer.raf?[time]:timer.args);
      else (0,eval)(String(timer.callback));
    }catch(error){return error}
  };
  // Yield between callbacks so microtasks and framework updates observe each due time.
  const channel=new MessageChannel();
  let resume;
  channel.port1.onmessage=()=>resume();
  const yieldTask=()=>new Promise(resolve=>{resume=resolve;channel.port2.postMessage(0)});
  const runFor=async ms=>{
    time=now();
    const end=time+ms;
    running=true;
    try{let timer,firstError;while((timer=next(end))){const error=fire(timer);firstError=firstError||error;await yieldTask()}time=end;if(firstError)throw firstError}
    finally{anchor=realNow();running=false}
  };
  const pump=()=>{
    if(!running){const end=now();time=end;running=true;let timer;while((timer=next(end))){const error=fire(timer);if(error)realTimeout(()=>{throw error},0)}time=end;anchor=realNow();running=false}
    realTimeout(pump,10);
  };
  realTimeout(pump,10);
  // Non-enumerable test hook; never installed in the interactive PLAY preview.
  Object.defineProperty(window,'__studioClock',{value:{runFor}});
})();</script>`;
