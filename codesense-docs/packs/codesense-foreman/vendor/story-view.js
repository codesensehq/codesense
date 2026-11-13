// vendored story-view build kit-rev:1 sha256:91c80090e34f156cb03fad0a0cda58fdc431202201014020a006d69c43173aa1
(function(){
'use strict';
const SCRIPT_SRC=document.currentScript&&document.currentScript.src||'';
/* CONFIG:begin */
const CONFIG={"template":1,"team":"getting-started","lead":{"agent":"story-lead","role":"lead","queue":"story-lead"},"sprint":{"agent":"sprint-lead","role":"sprint-lead","queue":"sprint-lead","launch":"/sprint-lead"},"foreman":{"role":"codesense-foreman","runtime":"claude","agents":["foreman-claude"],"guides":["guide-claude"],"name":"Foreman","worktree":"foreman","docs":{"org":"codesense/docs","team":"getting-started"},"senders":20,"history":5},"storyTypes":["story","bug","spike"],"variants":{"lead":"story","sprint-lead":"sprint","codesense-foreman":"foreman"},"owners":{"pause":null,"transcript":null,"detail":null},"phases":{"todo":"todo","in-progress":"in-progress","review":"review","qa":"qa","done":"done"},"rail":["todo","in-progress","review","qa","done"],"timers":{"slowMs":20000,"failMs":120000,"debounceMs":500},"limits":{"needsYou":200,"answers":500},"panel":{"tabs":null}};
/* CONFIG:end */
const STYLE=".sv-ready [data-cs]{display:none}\n.sv-root [hidden]{display:none !important}\nhtml,body{margin:0}\n.sv-root{--sv-border-strong:color-mix(in srgb,var(--cs-border) 62%,var(--cs-border-control));--sv-wash:color-mix(in srgb,var(--cs-accent) 10%,var(--cs-bg));--sv-warn-wash:color-mix(in srgb,var(--cs-warning) 9%,var(--cs-bg));--sv-danger-wash:color-mix(in srgb,var(--cs-danger) 9%,var(--cs-bg));\n box-sizing:border-box;color-scheme:var(--cs-color-scheme,light dark);display:flex;flex-direction:column;height:100vh;min-height:0;container-type:size;container-name:sv-root;background:var(--cs-bg);color:var(--cs-fg);font:var(--cs-text-base)/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;-webkit-font-smoothing:antialiased}\n.sv-root *{box-sizing:border-box}\n.sv-root button,.sv-root textarea{font:inherit;color:inherit}\n.sv-root :focus-visible{outline:2px solid var(--cs-accent);outline-offset:1px;border-radius:var(--cs-radius-sm)}\n.sv-root code{font-family:var(--cs-font-mono);font-size:var(--cs-text-sm)}\n.sv-root .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n.sv-root .btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:var(--cs-radius);white-space:nowrap;cursor:pointer;border:1px solid var(--sv-border-strong);background:var(--cs-bg);color:var(--cs-fg);font-size:var(--cs-text-sm);font-weight:500}\n.sv-root .btn:hover{background:var(--cs-surface)}\n.sv-root .btn.primary{background:var(--cs-accent);border-color:var(--cs-accent);color:var(--cs-accent-fg)}\n.sv-root .btn.primary:hover{background:color-mix(in srgb,var(--cs-accent) 88%,var(--cs-fg))}\n.sv-root .btn.quiet{border-color:transparent;background:transparent;color:var(--cs-fg)}\n.sv-root .btn.quiet:hover{background:var(--cs-surface)}\n.sv-root .btn.sm{height:24px;padding:0 9px;font-size:var(--cs-text-xs)}\n.sv-root .btn[disabled]{cursor:not-allowed;color:var(--cs-muted-fg);background:var(--cs-surface);border-color:var(--cs-border)}\n.sv-root #sv-panel[aria-pressed=true]{background:var(--sv-wash);border-color:color-mix(in srgb,var(--cs-accent) 45%,var(--cs-border))}\n.sv-root .av{position:relative;display:inline-block;width:12px;height:12px;border-radius:50%;flex:none;background:var(--cs-status-idle)}\n.sv-root .av[data-face=working]{background:var(--cs-accent);animation:sv-breathe 1.6s ease-in-out infinite}\n.sv-root .av[data-face=idle]{background:var(--cs-status-idle)}\n.sv-root .av[data-face=off]{background:transparent;box-shadow:inset 0 0 0 2px var(--cs-border-control)}\n.sv-root .av[data-face=failed]{background:transparent;box-shadow:inset 0 0 0 2px var(--cs-danger)}\n.sv-root .av[data-face=starting]{background:transparent;border:2px solid color-mix(in srgb,var(--cs-accent) 22%,transparent);border-top-color:var(--cs-accent);animation:sv-spin .9s linear infinite}\n@keyframes sv-spin{to{transform:rotate(360deg)}}\n@keyframes sv-breathe{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--cs-accent) 30%,transparent)}}\n@keyframes sv-dots{0%,80%,100%{opacity:.3}40%{opacity:1}}\n.sv-root .dh{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 20px;align-items:start;padding:12px 20px;border-bottom:1px solid var(--cs-border);flex:none}\n.sv-root .dh-id{display:flex;align-items:center;gap:8px;font-size:var(--cs-text-sm);color:var(--cs-muted-fg);flex-wrap:wrap}\n.sv-root .dh-id strong{color:var(--cs-fg);font-weight:600}\n.sv-root .dh h1{font-size:var(--cs-text-lg);font-weight:600;margin:2px 0 0;line-height:1.35}\n.sv-root .dh-a{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}\n.sv-root .dh-st{grid-column:1/-1;display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;font-size:var(--cs-text-sm)}\n.sv-root .story-l{display:inline-flex;align-items:center;min-height:24px;border:0;background:none;padding:0 2px;color:var(--cs-link);font-weight:600;cursor:pointer;font-size:var(--cs-text-sm)}\n.sv-root .story-l:hover{text-decoration:underline;text-underline-offset:2px}\n.sv-root .pause-l{display:inline-flex;align-items:center;height:28px;padding:0 4px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg);white-space:nowrap}\n.sv-root .pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:var(--cs-radius-full);border:1px solid var(--sv-border-strong);font-size:var(--cs-text-sm);font-weight:600;color:var(--cs-fg);white-space:nowrap}\n.sv-root .rail{display:inline-flex;gap:3px;align-items:center}\n.sv-root .rail i{width:14px;height:4px;border-radius:2px;background:var(--cs-border)}\n.sv-root .rail i[data-s=done]{background:var(--cs-muted-fg)}\n.sv-root .rail i[data-s=now]{background:var(--cs-accent)}\n.sv-root .waiting{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:var(--cs-radius);font-weight:600;border:1px solid color-mix(in srgb,var(--cs-warning) 40%,var(--cs-border));background:var(--sv-warn-wash);color:var(--cs-fg)}\n.sv-root .waiting small{font-weight:400;color:var(--cs-muted-fg);margin-left:6px}\n.sv-root .spent{color:var(--cs-muted-fg)}\n.sv-root .spent b{color:var(--cs-fg)}\n.sv-root .presence{display:inline-flex;align-items:center;gap:8px;min-width:0}\n.sv-root .presence .lbl{color:var(--cs-fg);font-weight:600}\n.sv-root .presence .what{color:var(--cs-muted-fg)}\n.sv-root .chatcol{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;height:100%}\n.sv-root #sv-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n.sv-root .src{display:flex;justify-content:center;font-size:var(--cs-text-xs);color:var(--cs-muted-fg);padding:6px 24px 0;flex:none}\n.sv-root .log{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px max(24px,calc((100% - 720px)/2)) 10px;display:flex;flex-direction:column;gap:10px}\n.sv-root .log:focus-visible{outline:2px solid var(--cs-accent);outline-offset:-2px;border-radius:0}\n.sv-root .log>:first-child{margin-top:auto}\n.sv-root .log>.status-slot,.sv-root .log>.src{align-self:stretch}\n.sv-root .msg{display:flex;flex-direction:column;gap:3px;max-width:min(560px,100%)}\n.sv-root .msg.lead,.sv-root .msg.other{align-self:flex-start;align-items:flex-start}\n.sv-root .msg.you{align-self:flex-end;align-items:flex-end}\n.sv-root .msg .meta{font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .msg .body{white-space:pre-wrap;overflow-wrap:anywhere;padding:7px 11px;border-radius:var(--cs-radius-lg);background:var(--cs-surface);border:1px solid var(--cs-border)}\n.sv-root .msg.you .body{background:var(--sv-wash)}\n.sv-root .msg .note,.sv-root .msg .mark{font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .msg.typing{flex-direction:row;align-items:center;gap:6px}\n.sv-root .dots{display:inline-flex;gap:4px}\n.sv-root .dots i{width:6px;height:6px;border-radius:50%;background:var(--cs-muted-fg);animation:sv-dots 1.2s infinite}\n.sv-root .dots i:nth-child(2){animation-delay:.2s}\n.sv-root .dots i:nth-child(3){animation-delay:.4s}\n.sv-root .status-slot{display:flex;flex-direction:column;gap:8px}\n.sv-root .status-slot[hidden]{display:none}\n.sv-root .sys{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--cs-text-sm);color:var(--cs-fg);padding:6px 10px;border-radius:var(--cs-radius);border:1px solid var(--cs-border);background:var(--cs-surface)}\n.sv-root .sys.warn{border-color:color-mix(in srgb,var(--cs-warning) 40%,var(--cs-border));background:var(--sv-warn-wash)}\n.sv-root .sys.danger{border-color:color-mix(in srgb,var(--cs-danger) 45%,var(--cs-border));background:var(--sv-danger-wash)}\n.sv-root .sys .code{color:var(--cs-muted-fg)}\n.sv-root .composer{flex:none;height:96px;display:flex;flex-direction:column;gap:4px;padding:10px max(24px,calc((100% - 720px)/2)) 8px;border-top:1px solid var(--cs-border);background:var(--cs-bg)}\n.sv-root .composer .box{flex:1 1 auto;min-height:0;display:flex;gap:8px;align-items:flex-end;padding:6px;border-radius:var(--cs-radius);border:1px solid var(--cs-border-control);background:var(--cs-bg)}\n.sv-root .composer .box:focus-within{border-color:var(--cs-accent)}\n.sv-root .composer .hint{flex:none;font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .composer textarea{flex:1 1 auto;align-self:stretch;resize:none;border:0;outline:0;padding:2px 4px;background:transparent;color:var(--cs-fg)}\n.sv-root .composer textarea::placeholder{color:var(--cs-muted-fg);opacity:1}\n.sv-root .composer textarea:disabled{color:var(--cs-muted-fg)}\n.sv-root .composer .btn{min-width:64px;justify-content:center}\n.sv-root .note-row{padding:24px;color:var(--cs-fg)}\n@container (max-width:720px){.sv-root .dh{grid-template-columns:minmax(0,1fr)}.sv-root .dh-a{justify-content:flex-start}}\n@container (max-height:640px){.sv-root .dh{padding:8px 16px;gap:4px 16px}.sv-root .dh h1{font-size:var(--cs-text-base)}.sv-root .log{padding:8px 16px 6px}.sv-root .composer{padding:8px 16px 10px}}\n@media (prefers-reduced-motion:reduce){.sv-root .av[data-face],.sv-root .dots i{animation:none}.sv-root .av[data-face=starting]{border-style:dashed}}\n.sv-root .ico{width:13px;height:13px;flex:none;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}\n.sv-root .ico.alert{color:var(--cs-danger)}\n.sv-root .btn.quiet[disabled]{background:transparent;border-color:transparent;color:var(--cs-muted-fg)}\n.sv-root .msg .mark[data-mark=kept]{color:var(--cs-danger)}\n.sv-root .sv-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) auto}\n.sv-root #sv-chat{min-width:0;min-height:0;display:flex;flex-direction:column}\n.sv-root .panel-col{min-height:0;min-width:0}\n.sv-root .strip-slot{display:contents}\n.sv-root .panel-col{border-left:1px solid var(--cs-border);background:var(--cs-bg)}\n.sv-root .panel{position:relative;height:100%;min-height:0;display:flex;flex-direction:column}\n.sv-root .resize{position:absolute;left:0;top:0;bottom:0;width:6px;z-index:2;cursor:col-resize;background:transparent;touch-action:none}\n.sv-root .resize:hover,.sv-root .resize:focus-visible{background:color-mix(in srgb,var(--cs-accent) 35%,transparent)}\n.sv-root .panel-head{position:sticky;top:0;flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--cs-border);background:var(--cs-bg)}\n.sv-root .tabs{position:relative;flex:1 1 auto;min-width:0;display:flex;flex-wrap:nowrap;gap:2px;overflow-x:auto;scrollbar-width:none}\n.sv-root .tabs::-webkit-scrollbar{display:none}\n.sv-root .tabs[data-fade-end=true]{mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent)}\n.sv-root .tabs[data-fade-start=true]{mask-image:linear-gradient(to left,#000 calc(100% - 28px),transparent)}\n.sv-root .tabs[data-fade-start=true][data-fade-end=true]{mask-image:linear-gradient(to right,transparent,#000 28px,#000 calc(100% - 28px),transparent)}\n.sv-root .btn.step{flex:none;min-width:24px;justify-content:center;padding:0 6px}\n.sv-root .btn.step[aria-disabled=true],.sv-root .btn.step[aria-disabled=true]:hover{cursor:not-allowed;color:var(--cs-muted-fg);background:transparent}\n.sv-root .tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:var(--cs-radius);background:transparent;color:var(--cs-muted-fg);cursor:pointer;font-size:var(--cs-text-sm);font-weight:500;white-space:nowrap}\n.sv-root .tab:hover{background:var(--cs-surface)}\n.sv-root .tab[aria-selected=true]{background:var(--sv-wash);color:var(--cs-fg);font-weight:600}\n.sv-root .ring{width:6px;height:6px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--cs-border-control);flex:none}\n.sv-root .menu-wrap{position:relative;flex:none}\n.sv-root .menu{position:absolute;right:0;top:calc(100% + 4px);z-index:5;min-width:220px;display:flex;flex-direction:column;padding:4px;border-radius:var(--cs-radius);border:1px solid var(--sv-border-strong);background:var(--cs-bg);box-shadow:var(--cs-shadow-lg)}\n.sv-root .menu-item{display:block;width:100%;text-align:left;height:28px;padding:0 10px;border:0;border-radius:var(--cs-radius-sm);background:transparent;color:var(--cs-fg);cursor:pointer;font-size:var(--cs-text-sm)}\n.sv-root .menu-item:hover,.sv-root .menu-item:focus-visible{background:var(--cs-surface)}\n.sv-root .menu-item[aria-current=true]{background:var(--sv-wash);font-weight:600}\n.sv-root .panel-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px}\n.sv-root .panel-body:focus-visible{outline-offset:-2px}\n.sv-root .panel-body p{margin:0 0 8px}\n.sv-root .panel-body .muted{color:var(--cs-muted-fg)}\n.sv-root .story-tab .bar{display:flex;justify-content:flex-end;margin-bottom:10px}\n.sv-root .story-tab .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.sv-root .result:focus-visible{outline-offset:2px}\n.sv-root .md h2,.sv-root .md h3,.sv-root .md h4,.sv-root .md h5,.sv-root .md h6{margin:14px 0 6px;line-height:1.3}\n.sv-root .md h2{font-size:var(--cs-text-lg)}.sv-root .md h3{font-size:var(--cs-text-base)}.sv-root .md h4,.sv-root .md h5,.sv-root .md h6{font-size:var(--cs-text-sm)}\n.sv-root .md p,.sv-root .md ul,.sv-root .md ol,.sv-root .md pre,.sv-root .md table,.sv-root .md blockquote{margin:0 0 10px}\n.sv-root .md ul,.sv-root .md ol{padding-left:22px}\n.sv-root .md a{color:var(--cs-link)}\n.sv-root .md pre{overflow:auto;padding:8px 10px;border-radius:var(--cs-radius);background:var(--cs-surface);border:1px solid var(--cs-border)}\n.sv-root .md blockquote{padding-left:10px;border-left:3px solid var(--cs-border-control);color:var(--cs-muted-fg)}\n.sv-root .md table{border-collapse:collapse;font-size:var(--cs-text-sm)}\n.sv-root .md th,.sv-root .md td{border:1px solid var(--cs-border);padding:4px 8px;text-align:left;vertical-align:top}\n.sv-root .md hr{border:0;border-top:1px solid var(--cs-border);margin:12px 0}\n.sv-root .legacy-frame{width:100%;height:60vh;border:1px solid var(--cs-border);border-radius:var(--cs-radius);color-scheme:light;background:Canvas}\n.sv-root .tasks-tab h2{margin:12px 0 6px;font-size:var(--cs-text-sm);color:var(--cs-muted-fg);font-weight:600}\n.sv-root .tasks-tab table{width:100%;border-collapse:collapse;font-size:var(--cs-text-sm)}\n.sv-root .tasks-tab th,.sv-root .tasks-tab td{border-bottom:1px solid var(--cs-border);padding:5px 8px 5px 0;text-align:left;vertical-align:top}\n.sv-root .tasks-tab th{font-weight:600;color:var(--cs-muted-fg)}\n.sv-root .tasks-tab ul{list-style:none;margin:0;padding-left:0}\n.sv-root .tasks-tab li ul{padding-left:18px;margin-top:2px}\n.sv-root .tasks-tab li.task{padding:2px 0;font-size:var(--cs-text-sm)}\n.sv-root .tasks-tab .box{margin-right:6px}\n.sv-root .tasks-tab .tags{color:var(--cs-muted-fg)}\n.sv-root .tasks-tab .muted{color:var(--cs-muted-fg)}\n.sv-root .tasks-tab a{color:var(--cs-link)}\n.sv-root .tasks-tab td[data-result=fail]{color:var(--cs-danger)}\n.sv-root .tasks-tab td[data-result=fail]::before{content:'✕ ';font-weight:600}\n.sv-root .md .box{margin-right:6px}\n.sv-root .md li.task{list-style:none;margin-left:-18px}\n.sv-root .agents{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:4px}\n.sv-root .agents .lead-in{color:var(--cs-muted-fg);font-size:var(--cs-text-xs)}\n.sv-root .ag{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:var(--cs-radius-full);border:1px solid var(--sv-border-strong);background:var(--cs-bg);color:var(--cs-fg);cursor:pointer;font-size:var(--cs-text-xs);white-space:nowrap}\n.sv-root .ag:hover{background:var(--cs-surface)}\n.sv-root .ag[aria-pressed=true]{background:var(--sv-wash);border-color:var(--cs-accent)}\n.sv-root .ag[aria-disabled=true]{cursor:not-allowed;color:var(--cs-muted-fg)}\n.sv-root .ag[aria-disabled=true]:hover{background:var(--cs-bg)}\n.sv-root .ov{margin:0}\n.sv-root .ov-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--cs-border);font-size:var(--cs-text-sm)}\n.sv-root .ov dt{color:var(--cs-muted-fg);font-weight:600}\n.sv-root .ov dd{margin:0;overflow-wrap:anywhere}\n.sv-root .ov dd.muted{color:var(--cs-muted-fg)}\n.sv-root .detail-head{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}\n.sv-root .detail-head #sv-detail-term{margin-left:auto}\n.sv-root .detail-head .ah{flex:1 1 100%}\n.sv-root .panel-head.detail .close{align-self:flex-start}\n.sv-root .detail-head .ah{display:inline-flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;font-size:var(--cs-text-sm)}\n.sv-root .detail-head .what{color:var(--cs-muted-fg)}\n.sv-root .panel-body .sec{margin:12px 0 4px;font-size:var(--cs-text-sm);color:var(--cs-muted-fg);font-weight:600}\n\n@container (max-width:720px){.sv-root .agents{margin-left:0}}\n.sv-root .sp-app{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:minmax(0,1fr)}\n.sv-root .sp-main{display:flex;flex-direction:column;min-width:0;min-height:0;container:sp-main/inline-size}\n.sv-root .sp-muted{color:var(--cs-muted-fg)}\n.sv-root .sp-hd{padding:10px 20px 0;border-bottom:1px solid var(--cs-border);flex:none}\n.sv-root .sp-hd-1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.sv-root .sp-hd h1{font-size:var(--cs-text-xl);font-weight:600;margin:0;letter-spacing:-0.01em}\n.sv-root .sp-hd-r{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.sv-root .sp-facts{display:flex;flex-wrap:wrap;align-items:center;gap:6px 0;margin:6px 0 8px;font-size:var(--cs-text-sm)}\n.sv-root .sp-fx{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:0 14px}\n.sv-root .sp-fx:first-child{padding-left:0}\n.sv-root .sp-fx+.sp-fx{border-left:1px solid var(--cs-border)}\n.sv-root .sp-fx .k{color:var(--cs-muted-fg)}\n.sv-root .sp-fx a{font-weight:600;color:var(--cs-link)}\n.sv-root .sp-body{flex:1 1 auto;overflow:auto;padding:14px 20px 24px;min-height:0}\n.sv-root .sp-body section+section{margin-top:18px}\n.sv-root .sp-sec-h{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;flex-wrap:wrap}\n.sv-root .sp-sec-h h2{font-size:var(--cs-text-lg);font-weight:600;margin:0}\n.sv-root .sp-s{font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-tnote{margin-top:6px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-sub{display:block;font-size:var(--cs-text-xs);color:var(--cs-muted-fg);margin-top:2px}\n.sv-root .acn{white-space:nowrap}\n.sv-root .sp-wait{color:var(--cs-muted-fg)}\n.sv-root .sp-wait::before{content:\"◌ \"}\n.sv-root .lnk{border:0;background:none;padding:0;color:var(--cs-link);font-weight:600;cursor:pointer;font-size:var(--cs-text-sm)}\n.sv-root .lnk:hover{text-decoration:underline;text-underline-offset:2px}\n.sv-root .bdg{display:inline-flex;align-items:center;gap:4px;min-height:18px;padding:0 6px;border-radius:var(--cs-radius-sm);font-size:var(--cs-text-xs);font-weight:500;white-space:nowrap;border:1px solid var(--sv-border-strong);color:var(--cs-muted-fg)}\n.sv-root .bdg.needs{color:var(--cs-fg);border-color:color-mix(in srgb,var(--cs-warning) 50%,var(--cs-border));background:var(--sv-warn-wash);font-weight:600}\n.sv-root .bdg.failed{color:var(--cs-danger);border-color:color-mix(in srgb,var(--cs-danger) 45%,var(--cs-border))}\n.sv-root .bdg.ok{color:var(--cs-fg);border-color:color-mix(in srgb,var(--cs-success) 45%,var(--cs-border))}\n.sv-root .bdg.quiet{border-color:var(--cs-border);background:var(--cs-surface)}\n.sv-root .sp-dot{display:inline-flex;align-items:center;gap:5px;font-size:var(--cs-text-sm)}\n.sv-root .sp-dot::before{content:\"\";width:7px;height:7px;border-radius:50%;flex:none;box-sizing:border-box}\n.sv-root .sp-dot.live{color:var(--cs-fg);font-weight:500}\n.sv-root .sp-dot.live::before{background:var(--cs-success)}\n.sv-root .sp-dot.idle::before{background:var(--cs-status-idle)}\n.sv-root .sp-dot.needs::before{background:var(--cs-warning)}\n.sv-root .sp-dot.off{color:var(--cs-muted-fg)}\n.sv-root .sp-dot.off::before{border:1.5px solid currentColor}\n.sv-root .sp-stg{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}\n.sv-root .pill[data-s=blocked]{color:var(--cs-danger);border-color:color-mix(in srgb,var(--cs-danger) 40%,var(--cs-border));background:var(--sv-danger-wash)}\n.sv-root .pill[data-s=planning],.sv-root .pill[data-s=todo]{color:var(--cs-muted-fg)}\n.sv-root table.sp-t{width:100%;border-collapse:collapse;font-size:var(--cs-text-sm)}\n.sv-root table.sp-t th{text-align:left;font-weight:500;color:var(--cs-muted-fg);font-size:var(--cs-text-xs);padding:5px 8px;border-bottom:1px solid var(--cs-border);white-space:nowrap}\n.sv-root table.sp-t td{padding:7px 8px;border-bottom:1px solid var(--cs-border);vertical-align:top}\n.sv-root table.sp-t .num{text-align:right}\n.sv-root table.sp-stories{table-layout:fixed}\n.sv-root table.sp-stories col[data-col=rank]{width:48px}\n.sv-root table.sp-stories col[data-col=stage]{width:176px}\n.sv-root table.sp-stories col[data-col=lead]{width:116px}\n.sv-root table.sp-stories col[data-col=progress]{width:150px}\n.sv-root table.sp-stories col[data-col=blockers]{width:136px}\n.sv-root table.sp-stories col[data-col=spend]{width:118px}\n.sv-root table.sp-stories>tbody>tr:not(.sp-grp){cursor:pointer}\n.sv-root table.sp-stories>tbody>tr:not(.sp-grp):hover>td{background:var(--cs-surface)}\n.sv-root .sp-sid{display:flex;align-items:center;gap:6px;min-width:0}\n.sv-root .sp-id{white-space:nowrap}\n.sv-root .sp-ttl{display:block;color:var(--cs-muted-fg);font-size:var(--cs-text-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sv-root .sp-bl{display:flex;flex-wrap:wrap;gap:4px;min-width:0}\n.sv-root .sp-bl .bdg{white-space:normal}\n.sv-root .sp-spend{display:grid;gap:2px;white-space:nowrap}\n.sv-root tr.sp-grp>td{background:var(--cs-surface);padding:0}\n.sv-root tr.sp-grp summary{display:flex;align-items:center;gap:10px;padding:7px 8px;cursor:pointer;font-size:var(--cs-text-sm);list-style:none}\n.sv-root tr.sp-grp summary::-webkit-details-marker{display:none}\n.sv-root tr.sp-grp summary .chev{color:var(--cs-muted-fg);transition:transform .12s}\n.sv-root tr.sp-grp details[open] summary .chev{transform:rotate(90deg)}\n.sv-root tr.sp-grp summary .sp-muted{margin-left:auto}\n.sv-root table.sp-mini{width:100%;border-collapse:collapse;font-size:var(--cs-text-sm);background:var(--cs-bg);table-layout:fixed}\n.sv-root table.sp-mini td:first-child{width:150px}\n.sv-root table.sp-mini td:last-child{width:118px}\n.sv-root table.sp-mini td:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sv-root table.sp-mini td{padding:5px 8px 5px 26px;border-top:1px solid var(--cs-border)}\n.sv-root table.sp-mini td+td{padding-left:8px}\n.sv-root .sp-ia{display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:var(--cs-radius);font-size:var(--cs-text-sm);border:1px solid color-mix(in srgb,var(--cs-warning) 45%,var(--cs-border));background:var(--sv-warn-wash)}\n.sv-root .sp-ia .btn{margin-left:auto}\n.sv-root .sp-ia.info{border-color:var(--sv-border-strong);background:var(--cs-surface)}\n.sv-root .sp-ia.err{border-color:color-mix(in srgb,var(--cs-danger) 35%,var(--cs-border));background:var(--sv-danger-wash)}\n.sv-root .sp-es{border:1px dashed var(--sv-border-strong);border-radius:var(--cs-radius);padding:14px 16px;font-size:var(--cs-text-sm);color:var(--cs-muted-fg)}\n.sv-root .sp-wcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr));gap:12px;align-items:start}\n.sv-root .sp-mq{border:1px solid color-mix(in srgb,var(--cs-warning) 40%,var(--cs-border));border-radius:var(--cs-radius);background:var(--sv-warn-wash);padding:10px 12px;display:grid;gap:8px;align-content:start;min-width:0}\n.sv-root .sp-mq-h{display:flex;align-items:center;gap:8px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg);flex-wrap:wrap}\n.sv-root .sp-mq-h .dest{margin-left:auto}\n.sv-root .sp-you{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--cs-warning);color:var(--cs-bg);font-size:11px;font-weight:700;line-height:1;flex:none}\n.sv-root .mono{font-family:var(--cs-font-mono);font-size:var(--cs-text-xs)}\n.sv-root .sp-mq .q{font-weight:500}\n.sv-root .sp-mq .q a{color:var(--cs-link)}\n.sv-root .sp-mq .lnk,.sv-root .sp-mq .q a{color:color-mix(in srgb,var(--cs-link) 85%,var(--cs-fg))}\n.sv-root .sp-unsure{margin:0;color:var(--cs-fg)}\n.sv-root .sp-mq[data-unsure]{background:var(--cs-bg);border-style:dashed;border-color:var(--sv-border-strong)}\n.sv-root .sp-mq[data-unsure] .sp-you{background:var(--cs-muted-fg)}\n.sv-root .sp-mq dl{display:grid;grid-template-columns:64px 1fr;gap:3px 10px;font-size:var(--cs-text-sm);margin:0;align-items:center}\n.sv-root .sp-mq dt{color:var(--cs-muted-fg)}\n.sv-root .sp-mq dd{margin:0}\n.sv-root .sp-mq .what{font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-mq .what b{color:var(--cs-fg);font-size:var(--cs-text-sm)}\n.sv-root .sp-body-t{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--cs-text-sm)/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;padding:8px 10px;border:1px solid var(--cs-border);border-radius:var(--cs-radius);background:var(--cs-bg);margin:0}\n.sv-root .sp-opts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}\n.sv-root .sp-free{display:flex;gap:6px;align-items:flex-end}\n.sv-root .sp-fi,.sv-root .sp-reason-t{flex:1;min-width:0;border:1px solid var(--cs-border-control);border-radius:var(--cs-radius);background:var(--cs-bg);color:var(--cs-fg);padding:5px 8px;font:inherit;font-size:var(--cs-text-sm);resize:vertical}\n.sv-root .sp-fi::placeholder{color:var(--cs-muted-fg);opacity:1}\n.sv-root .sp-confirm{display:grid;gap:6px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--cs-accent) 40%,var(--cs-border));border-radius:var(--cs-radius);background:var(--cs-bg);font-size:var(--cs-text-sm)}\n.sv-root .sp-confirm .r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.sv-root .sp-confirm .r3{flex:1 1 160px}\n.sv-root .sp-confirm .sp-btns{display:flex;gap:6px;margin-left:auto}\n.sv-root .sp-confirm .r3{font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-reason{display:grid;gap:4px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-reason-t{min-height:44px}\n.sv-root .sp-reason-e{color:var(--cs-danger);font-size:var(--cs-text-xs)}\n.sv-root .sp-reason-e:empty{display:none}\n.sv-root .sp-answered{display:grid;grid-template-columns:16px minmax(0,1fr);gap:8px;font-size:var(--cs-text-sm)}\n.sv-root .sp-answered .mark{color:var(--cs-success);font-weight:700}\n.sv-root .sp-lt{display:flex;align-items:flex-end;gap:2px;margin-top:4px}\n.sv-root .sp-lt a{display:inline-flex;align-items:center;gap:6px;padding:7px 10px 8px;color:var(--cs-muted-fg);border-bottom:2px solid transparent;text-decoration:none}\n.sv-root .sp-lt a:hover{color:var(--cs-fg)}\n.sv-root .sp-n{font-size:var(--cs-text-xs);font-weight:600;color:var(--cs-fg)}\n.sv-root .sp-n:empty{display:none}\n.sv-root .sp-chatbtn{margin-left:auto;align-self:center;margin-bottom:4px;display:none}\n.sv-root .sp-chat{border-left:1px solid var(--cs-border);display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--cs-bg)}\n.sv-root .sp-ch-h{padding:10px 12px;border-bottom:1px solid var(--cs-border);display:grid;gap:8px;flex:none}\n.sv-root .sp-ch-t{font-size:var(--cs-text-base);font-weight:600;margin:0}\n.sv-root .sp-to{display:flex;align-items:center;gap:8px;min-height:24px;padding:0;font-size:var(--cs-text-sm);min-width:0}\n.sv-root .sp-to .k{color:var(--cs-muted-fg)}\n.sv-root .sp-to .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sv-root .sp-chat-n:not(:empty){margin:10px 12px 0;flex:none}\n.sv-root .sp-chat-n .sp-ia{flex-wrap:wrap}\n.sv-root .sp-thread{flex:1 1 auto;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}\n.sv-root .sp-thread>:first-child{margin-top:auto}\n.sv-root .sp-msg{display:grid;gap:2px;font-size:var(--cs-text-sm)}\n.sv-root .sp-msg .m{display:flex;gap:6px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n.sv-root .sp-msg .m b{color:var(--cs-fg);font-weight:600}\n.sv-root .sp-msg .txt{padding:7px 10px;border-radius:var(--cs-radius);background:var(--cs-surface);border:1px solid var(--cs-border);white-space:pre-wrap;overflow-wrap:anywhere}\n.sv-root .sp-msg.me{justify-items:end}\n.sv-root .sp-msg.me .txt{background:var(--sv-wash);max-width:86%}\n.sv-root .sp-empty{text-align:center;font-size:var(--cs-text-xs)}\n.sv-root .sp-comp{border-top:1px solid var(--cs-border);padding:10px 12px 12px;display:grid;gap:8px;flex:none}\n.sv-root .sp-comp textarea{border:1px solid var(--cs-border-control);border-radius:var(--cs-radius);padding:8px 10px;min-height:58px;font-size:var(--cs-text-sm);background:var(--cs-bg);color:var(--cs-fg);resize:none;width:100%}\n.sv-root .sp-comp textarea::placeholder{color:var(--cs-muted-fg);opacity:1}\n.sv-root .sp-send{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:var(--cs-text-xs);color:var(--cs-muted-fg)}\n@container sv-root (max-width:1100px){\n .sv-root .sp-app{grid-template-columns:minmax(0,1fr)}\n .sv-root .sp-chat{display:none}\n .sv-root .sp-chatbtn{display:inline-flex}\n .sv-root .sp-app[data-chat-open]{grid-template-columns:minmax(0,1fr) 340px}\n .sv-root .sp-app[data-chat-open] .sp-chat{display:flex}\n .sv-root .sp-app[data-chat-open] .sp-wcards{grid-template-columns:minmax(0,1fr)}\n}\n@container sv-root (max-width:820px){\n .sv-root .sp-app[data-chat-open]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,45%)}\n .sv-root .sp-app[data-chat-open] .sp-chat{border-left:0;border-top:1px solid var(--cs-border)}\n}\n@container sp-main (max-width:900px){\n .sv-root table.sp-stories col:is([data-col=lead],[data-col=progress]){width:0}\n .sv-root table.sp-stories :is(th,td):is([data-col=lead],[data-col=progress]){padding:0;border-left:0;border-right:0;overflow:hidden;visibility:hidden;white-space:nowrap}\n}\n@container sp-main (max-width:640px){\n .sv-root table.sp-stories col[data-col=blockers]{width:0}\n .sv-root table.sp-stories :is(th,td)[data-col=blockers]{padding:0;border-left:0;border-right:0;overflow:hidden;visibility:hidden;white-space:nowrap}\n .sv-root table.sp-stories col[data-col=stage]{width:108px}\n .sv-root table.sp-stories .sp-stg .rail{display:none}\n}\n.sv-root .sp-stg .rail i{width:8px}\n.sv-root .fm-app{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n.sv-root .fm-hd{flex:none;display:flex;align-items:center;gap:12px;padding:10px max(24px,calc((100% - 720px)/2));border-bottom:1px solid var(--cs-border)}\n.sv-root .fm-hd h1{margin:0;font-size:var(--cs-text-lg,1.125rem);font-weight:600}\n.sv-root .fm-state{color:var(--cs-muted-fg);font-size:var(--cs-text-sm)}\n.sv-root .fm-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n.sv-root .fm-chat{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n.sv-root .fm-welcome{flex:none;padding:28px max(24px,calc((100% - 720px)/2)) 8px}\n.sv-root .fm-greeting{margin:0 0 4px;font-size:var(--cs-text-xl,1.375rem);font-weight:600}\n.sv-root .fm-status{margin:0 0 14px;color:var(--cs-muted-fg)}\n.sv-root .fm-starters{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}\n";
const LOADING='Loading…',UNKNOWN='Unknown',NOT_LOADED='Not loaded',NONE='None';
const REASONS={cost:'Cost not recorded',time:'Active time not recorded',rounds:'Review rounds not recorded',sessions:'Session count not recorded',lines:'Lines arrive with the next app update',commits:'Commits not recorded',files:'Files not recorded',prs:'PRs not in this answer',detail:"This page doesn't share a story's details"};
const sentence=reason=>reason?String(reason)[0].toUpperCase()+String(reason).slice(1):'';
const unknownLabel=reason=>reason?`${UNKNOWN} · ${sentence(reason)}`:UNKNOWN;
const COLUMN_LABELS=['Story','Cost & active time','Review rounds','Sessions','AI-written lines','Details'];
const partialLabel=(known,total)=>`Totals loading · ${known} of ${total} stories`;
const distinctReasons=texts=>[...new Set(texts.filter(text=>typeof text==='string'&&text))];
const reasonAt=(reasons,index)=>Array.isArray(reasons)&&Number.isInteger(index)&&typeof reasons[index]==='string'?reasons[index]:'';

const SVG='http://www.w3.org/2000/svg';
function h(tag,props={},...kids){
 const node=document.createElement(tag);
 for(const[key,value]of Object.entries(props||{})){
  if(value===null||value===undefined||value===false)continue;
  if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key==='style')node.style.cssText=value;
  else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else node.setAttribute(key,value===true?'':String(value));
 }
 node.append(...kids.flat(Infinity).filter(kid=>kid!==null&&kid!==undefined&&kid!==false));return node;
}
const PATHS={chev:'M6 4l4 4-4 4',down:'M4 6l4 4 4-4',out:'M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5',term:'M5 7l2 1.5L5 10M8.5 10.5H11M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3z',refresh:'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5',search:'M10.5 10.5L14 14M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',back:'M10 4L6 8l4 4'};
function icon(name){
 const svg=document.createElementNS(SVG,'svg'),path=document.createElementNS(SVG,'path');
 svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('class',name==='chev'?'ico chev':'ico');svg.setAttribute('aria-hidden','true');path.setAttribute('d',PATHS[name]);svg.append(path);return svg;
}
const skeleton=(width,large=false)=>h('span',{class:large?'sk l':'sk',style:`width:${width}px`,'aria-hidden':'true'});
const dayLabel=time=>new Date(time).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});

const COPY={
 lead:'Story lead',
 header:{done:'Story is done',none:'not running: your next message starts it',starting:'starting…',idle:'waiting for you',needs:'needs you in its terminal',unknown:'status unknown · its machine may be offline',working:activity=>`working · ${activity}`,failed:reason=>`couldn't start · ${reason}`,activityNone:'activity not reported'},
 placeholder:{running:"It's working; your message waits for its next step",idle:'Reply to the story lead',needs:"It's waiting on its terminal; your message waits",unknown:"Your message waits until it's reachable",none:'Message to start the story lead',starting:'Starting the story lead; more messages wait for it',failed:'Retry, or add to your kept message',done:'This story is done'},
 mark:{stuck:'Sent · waiting on its terminal',starting:'Sent · starting the lead',held:'Held · sends when the lead joins',sent:'Sent',kept:'Not delivered · kept'},
 row:{starting:'Starting story lead…',slow:'Still starting (over 20 s)',joined:(model,activity)=>`Story lead joined · ${model} · ${activity}`,modelNone:'model not reported yet',typing:'Story lead is typing',retry:'Retry',needsTerminal:'Needs you in its terminal',unread:"Couldn't load the conversation.",stale:time=>`Couldn't refresh · ${time}`},
 failure:{send:why=>`Couldn't send your message: ${why}.`,busy:'Couldn\'t start the story lead: CodeSense is at its agent limit. Try again in a moment.',denied:why=>`Couldn't start the story lead: launching was refused (${why}).`,unavailable:why=>`Couldn't start the story lead: no agent is available (${why}).`,timeout:"The story lead didn't start in 2 minutes.",exited:'The story lead stopped right after it started.',refused:why=>`Couldn't start the story lead: ${String(why).replace(/\.$/,'')}.`,other:code=>`Couldn't start the story lead: ${code}.`,reasonBusy:'CodeSense is at its agent limit',reasonTimeout:'no join in 2 minutes',reasonExited:'it stopped right after starting'},
 terminal:'Show terminal',terminalOff:'Show terminal · not running',
 story:'Story',
 pause:owner=>`Pause launches · coming in ${owner}`,
 transcript:owner=>`Story chat transcript arrives with ${owner}`,
 inboxNote:'Answer it in your Inbox',
 send:'Send',
 hint:'Enter to send · Shift+Enter for a new line',
 who:{you:'You'},
 composerLabel:'Message to the story lead',
 questions:(n,capped)=>`${n}${capped?'+':''} ${n===1&&!capped?'question':'questions'} for you`,
 questionsNote:'counted from the latest 200',
 questionsUnread:"counted from unread for cards outside this story's lead",
 spend:{none:'$0.00 · no runs yet',unpriced:'Unknown · Cost not recorded',partial:'first page only',unpricedSome:n=>`${n} unpriced`},
 variant:{notFound:'session not found',unknownRole:'unknown role',notBuilt:owner=>owner?`Not built yet: ${owner}`:'Not built yet · no story filed yet',noSprintShell:'Open stories/SPRINT-<n>.html',badSprint:'story-view:sprint is not a sprint number'},
 panel:{toggle:'Side panel',toggleNarrow:'Side panel · widen the window to open it',close:'Close the side panel',allTabs:'All tabs',resize:'Resize side panel',narrow:'Narrow side panel',widen:'Widen side panel',tablist:'Story panels',notBuiltSuffix:' · not built yet',
  unbuiltName:(label,owner)=>`${label}, not built yet, coming in ${owner}`,unbuiltHead:label=>`${label}: not built yet`,comingIn:owner=>`Coming in ${owner}.`,openOwner:id=>`Open ${id}`},
 sprint:{
  title:n=>`Sprint ${n}`,count:n=>`${n} ${n===1?'story':'stories'}`,dash:'—',loading:'Loading…',none:'none',
  nav:'Sprint sections',
  stories:{h:'Stories',sub:'needs you first, then blocked, then by stage · click a row to open it',empty:n=>`No stories in Sprint ${n}`,failed:'Stories didn’t load.',failedWhy:why=>`queryContext failed (${why}); Waiting on you and the chat still work.`,retry:'Retry',
   rankNote:'A rank column appears once the sprint lead writes cs:rank.',note:'$ a point = known spend ÷ points; a story whose spend is unknown shows "—" and stays out of every sum.'},
  col:{story:'Story',rank:'Rank',stage:'Stage',lead:'Story lead',progress:'Progress',blockers:'Blockers',spend:'Spend · $ a point'},
  openTab:id=>`Open ${id}'s tab`,openMd:name=>`Open ${name}`,mdOnly:'md only',mdOnlyTitle:'No story view yet: the row opens the md',
  lead:{running:'running',idle:'idle',needs:'needs you in its terminal',offline:'offline',unknown:'status unknown',none:'no lead'},
  tasks:(done,total)=>`${done}/${total} tasks`,acs:(verified,total)=>`${verified}/${total} ACs verified`,noTrace:n=>`ACs: no trace yet (${n})`,
  noTraceTitle:id=>`No design/${id}/qa/trace.md yet, so no AC is verified or failed`,noTasks:'no Tasks outline in the md',
  blocked:'■ blocked',needsAnswer:'? your answer',needsMerge:'? merge approval',needsCount:n=>`? ${n}`,
  perPoint:(value,atLeast)=>`${atLeast?'≥ ':''}${value}/pt`,points:n=>`${n} ${n===1?'pt':'pts'}`,acsUnknown:'ACs: —',acsUnknownTitle:'The QA trace or the md\'s ACs could not be read',noPoints:'no points',noRuns:'no runs yet',computing:'computing',notInSum:'not in the sum',
  unknownTitle:why=>`storyTotals: ${why}`,atLeastTitle:'At least: a session is still running and not fully counted',
  group:{stories:n=>`${n} ${n===1?'story':'stories'}`},
  strip:{waiting:'Waiting on you',spend:'Spend',cards:(merges,questions)=>[merges?`${merges} merge`:'',questions?`${questions} ${questions===1?'question':'questions'}`:''].filter(Boolean).join(', '),
   spendTitle:'Known storyTotals only: a story still computing, failed or not counted is left out and counted as unknown; "≥" while any is unknown or a session runs'},
  chat:{h:'Chat',to:'To',lead:'Sprint lead',next:'Next sprint lead',queue:'queue',who:'Sprint lead',live:'live',idle:'idle',needs:'needs you in its terminal',unknown:'status unknown',off:'not running',
   focus:'Focus sprint lead',launch:'Launch sprint lead…',noLead:'No sprint lead is running.',waits:queue=>`Messages wait in the ${queue} queue; the next sprint lead reads them first.`,
   placeholder:'Message the sprint lead…',placeholderQueue:'Message the next sprint lead…',hint:'Story answers go from the cards, not here · ⌘↵ sends',hintQueue:'Waits in the queue until a sprint lead starts · ⌘↵ queues',
   send:'Send',queueSend:'Queue',logLabel:'Messages with the sprint lead',regionLabel:'Sprint lead chat',inputLabel:'Message to the sprint lead',empty:'No messages yet',failed:"Couldn't send.",failedWhy:why=>`${why}. Your message is kept.`,
   show:'Chat · sprint lead',hide:'Hide chat',actFailed:{launch:'Couldn’t open the launcher.',focus:'Couldn’t focus the sprint lead.',thread:'Couldn’t read the thread.'}},
  waiting:{h:'Waiting on you',sub:"answers go to the story's lead, not the sprint lead",count:n=>`${n} open`,countMore:limit=>`${limit}+ cards to you`,cantTell:'Can’t tell',nothing:'Nothing waits on you',more:'More cards than this page reads: answer the rest in your Inbox',
   question:'Question',merge:'Merge approval',goesTo:'Goes to',bodyLabel:"The lead's merge card, as sent",
   answerLabel:'Answer in your own words',answerPlaceholder:'Answer in your own words…',send:'Send',
   mergeTitle:'Merge',mergedTitle:'Merged:',pr:'PR',spend:'Spend',prOpen:label=>`○ ${label}: open`,prUnknown:label=>`${label}: state unknown`,stillUnknown:label=>`storyTotals doesn't list ${label}'s state.`,
   unsure:'Can’t tell from here whether this was answered: check your Inbox before you reply.',readFailed:'Waiting on you didn’t load.',readFailedWhy:why=>`inbox failed (${why}); the count is unknown.`,prMerged:(label,at)=>`✓ ${label}: merged${at?` ${at}`:''}`,
   mergeFirst:label=>`Merge ${label} on GitHub first.`,approveTurns:'Approve turns primary when the PR shows merged; if you merged in the last minute, Approve still replies merge.',
   whatMerged:dest=>`Approve replies merge and ${dest} closes the story.`,
   approveOpen:'Approve: PR is merged',approveMerged:'Approve merge',sendBack:'Send back…',cancel:'Cancel',approve:'Approve',replyMergeAnyway:'Reply merge',
   confirmMerge:dest=>`Reply merge to ${dest}?`,stillOpen:label=>`${label} still shows open in storyTotals.`,confirmHint:'⌘↵ approves · Esc cancels',
   sendBackTo:(label,dest)=>`Send ${label} back to ${dest}`,reasonLabel:'Reason (required: the lead works from it)',reasonRequired:'Give a reason: the lead works from it.',
   sendBackOk:'Send back',sendBackHint:'Sends "send back: <reason>" · ⌘↵ sends · Esc cancels',
   replied:text=>`You replied: ${text}`,to:'to',leaves:'The card leaves Waiting on you when the reply is read.',failed:"Couldn't send.",failedWhy:why=>`${why}. Your answer is kept; try again.`},
 },
 offline:'Offline · the CodeSense viewer did not load its page kit',
 unload:'Messages you sent are still waiting for the story lead.',
 unloadKept:"Some messages weren't sent.",
};
const failureText=(failure,copy=COPY)=>failure.kind==='busy'?copy.failure.busy:failure.kind==='denied'?copy.failure.denied(failure.why):failure.kind==='unavailable'?copy.failure.unavailable(failure.why):failure.kind==='refused'?copy.failure.refused(failure.why):failure.kind==='timeout'?copy.failure.timeout:failure.kind==='exited'?copy.failure.exited:copy.failure.other(failure.code);
const failureReason=(failure,copy=COPY)=>failure.kind==='busy'?copy.failure.reasonBusy:failure.kind==='timeout'?copy.failure.reasonTimeout:failure.kind==='exited'?copy.failure.reasonExited:failure.why||failure.code;
const modelLabel=id=>{const m=/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{6,})?$/.exec(String(id||''));return m?`${m[1][0].toUpperCase()+m[1].slice(1)} ${m[2]}${m[3]?'.'+m[3]:''}`:String(id||'');};
const timeLabel=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
const STORY_TAB={loading:'Reading the story…',failed:reason=>`Couldn't read the story md (${reason}).`,unavailable:"This page can't read files, so the story isn't shown here.",openMd:'Open the story md',openFile:'Open the story file',retry:'Retry',legacy:'Older HTML story · shown as is',empty:'The story md is empty.'};
const TASKS_TAB={acs:'Acceptance criteria',tasks:'Tasks',colAc:'AC',colCriterion:'Criterion',colResult:'Result',notTraced:'not traced',done:(n,total)=>`${n} of ${total} tasks done`,
 partial:"Some of the md isn't in AC or task form; read it in the Story tab.",none:'No ACs or tasks found in the story md.',traceFailed:reason=>`Couldn't read the QA trace (${reason}).`,unavailable:"This page can't read files, so the tasks aren't shown here.",
 doneMark:'Done',openMark:'Open'};
const STRIP={group:'Other agents on this story',working:'Also working',ended:'Also on this story',widen:'widen the window to open it',widenSuffix:' · widen the window to open it'};
const OVERVIEW={notSet:'not set',none:'none',leadOnly:'Story lead only',leadLine:presence=>`${COPY.lead} · ${presence}`};
const DETAIL={back:'Story panel',backName:'Back to the story panel',doingNow:'Doing now',fromSession:note=>`${note} · from its session`,nothing:'Nothing reported yet',notRunningNow:'Not running.',terminalFailed:"Couldn't show the terminal.",since:time=>`since ${time}`,
 notRunning:'not running',endedAt:time=>`ended ${time}`,later:owner=>`Activity, files, cost and its mail with the lead come in ${owner}. Ask the story lead about this work in the chat.`};
const mergeCopy=(base,over)=>Object.fromEntries(Object.entries({...base,...over}).map(([key,value])=>[key,value&&typeof value==='object'&&base[key]&&typeof base[key]==='object'?{...base[key],...value}:value]));
const FOREMAN_COPY=mergeCopy(COPY,{
 lead:'Foreman',
 header:{done:'',none:'not running: your next message starts it',starting:'starting…',idle:'waiting for you',needs:'needs you in its terminal',unknown:'status unknown · its machine may be offline'},
 placeholder:{running:"It's working; your message waits for its next step",idle:'Message the Foreman',needs:"It's waiting on its terminal; your message waits",unknown:"Your message waits until it's reachable",none:'Message to start the Foreman',starting:'Starting the Foreman; more messages wait for it',failed:'Retry, or add to your kept message',done:''},
 mark:{starting:'Sent · starting the Foreman',held:'Held · sends when the Foreman joins',kept:'Not sent · kept'},
 row:{starting:'Starting the Foreman…',joined:(model,activity)=>`Foreman joined · ${model} · ${activity}`,typing:'The Foreman is typing'},
 failure:{busy:"Couldn't start the Foreman: CodeSense is at its agent limit. Try again in a moment.",denied:why=>`Couldn't start the Foreman: launching was refused (${why}).`,unavailable:why=>`Couldn't start the Foreman: no agent is available (${why}).`,timeout:"The Foreman didn't start in 2 minutes.",exited:'The Foreman stopped right after it started.',
  refused:why=>`Couldn't start the Foreman: ${String(why).replace(/\.$/,'')}.`,other:code=>`Couldn't start the Foreman: ${code}.`},
 composerLabel:'Message to the Foreman',
 unload:'Messages you sent are still waiting for the Foreman.',
 chat:{logLabel:'Foreman chat',noRuntime:'No supported agent CLI found',noTeams:"couldn't read your teams",noRuntimeRead:"couldn't check which agent CLIs are installed"},
 title:'Foreman',
 welcome:{
  morning:'Morning',afternoon:'Afternoon',evening:'Evening',
  greeting:(part,name)=>name?`${part}, ${name}.`:`${part}.`,
  status:(waiting,working)=>`${waiting} ${waiting==='1'?'thing waits':'things wait'} on you. ${working} ${working==='1'?'agent is':'agents are'} working.`,
  dash:'—',
  starters:['What’s waiting on me?','Turn an idea into a story','Open the sprint lead','How does CodeSense work?'],
  startersLabel:'Ways to start',
 },
 prompt:'You are the Foreman. From the Foreman page:',
 handoffNote:'Foreman handoff:',
});

const readMeta=doc=>Object.fromEntries([...doc.querySelectorAll('meta[name]')].map(node=>[node.getAttribute('name'),node.getAttribute('content')||'']));
const sessionParam=search=>new URLSearchParams(search||'').get('session')||null;
const storyIdOf=meta=>meta['cs:story-id']||'';

const SPRINT_META='story-view:sprint';
const FOREMAN_META='story-view:foreman';
function pickVariant({config,meta,param,rows}){
 let variant;
 if(Object.hasOwn(meta,FOREMAN_META)){
  if(param&&!(rows||[]).some(item=>item.handle===param))return {kind:'error',text:COPY.variant.notFound};
  return {kind:'foreman'};
 }
 const sprint=Object.hasOwn(meta,SPRINT_META)?meta[SPRINT_META]:null;
 if(sprint!==null&&!/^(?:0|[1-9][0-9]*)$/.test(sprint))return {kind:'error',text:COPY.variant.badSprint};
 if(param){
  const row=(rows||[]).find(item=>item.handle===param);
  if(!row)return {kind:'error',text:COPY.variant.notFound};
  if(sprint!==null)return {kind:'sprint',sprint};
  variant=config.variants[row.role];
  if(!variant)return {kind:'error',text:COPY.variant.unknownRole};
 }else variant=sprint!==null?'sprint':config.storyTypes.includes(meta['cs:type'])?'story':null;
 if(!variant)return {kind:'error',text:COPY.variant.unknownRole};
 if(variant==='story')return {kind:'story'};
 if(variant==='foreman')return {kind:'foreman'};
 if(variant==='sprint')return sprint!==null?{kind:'sprint',sprint}:{kind:'placeholder',variant,owner:null,text:COPY.variant.noSprintShell};
 const owner=Object.hasOwn(config.owners,variant)?config.owners[variant]:null;
 return {kind:'placeholder',variant,owner,text:COPY.variant.notBuilt(owner)};
}

const money=value=>`$${value.toFixed(2)}`;
function spendModel(usage){
 if(!usage)return {text:unknownLabel('Cost not read'),known:false};
 if(usage.unavailableReason)return {text:unknownLabel(usage.unavailableReason),known:false};
 const sessions=Array.isArray(usage.sessions)?usage.sessions:[];
 if(!sessions.length)return {text:COPY.spend.none,known:true};
 const priced=sessions.filter(row=>Number.isFinite(row.costUsd));
 if(!priced.length)return {text:COPY.spend.unpriced,known:false};
 const total=priced.reduce((sum,row)=>sum+row.costUsd,0),partial=Boolean(usage.nextCursor),unpriced=sessions.length-priced.length;
 const notes=[partial?COPY.spend.partial:'',unpriced?COPY.spend.unpricedSome(unpriced):''].filter(Boolean);
 return {text:money(total)+(notes.length?` · ${notes.join(' · ')}`:''),known:true,partial};
}
const mentions=(row,id)=>[row.story,row.storyId].includes(id)||new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9-])`).test(`${row.summary||''} ${row.text||''}`);
function questionsModel(rows,storyId,limit,{thread=[],leadHandles=new Set()}={}){
 const list=Array.isArray(rows)?rows:[],answered=new Set((Array.isArray(thread)?thread:[]).filter(row=>row.from==='human'&&row.inReplyTo).map(row=>row.inReplyTo));
 const inScope=row=>leadHandles.has(row.from)||/^role:/.test(row.from||'');
 const open=list.filter(row=>row.from!=='human'&&row.kind==='needs-you'&&mentions(row,storyId)&&(inScope(row)?!answered.has(row.messageId):row.unread===true));
 const capped=list.length>=limit,outside=open.some(row=>!inScope(row));
 return {count:open.length,capped,text:open.length||capped?COPY.questions(open.length,capped):'',note:[outside?COPY.questionsUnread:'',capped?COPY.questionsNote:''].filter(Boolean).join(' · ')};
}
function stageModel(status,config){
 const phase=config.phases[status]||status||'',at=config.rail.indexOf(phase);
 return {phase,at,steps:config.rail.map((name,index)=>({name,state:at<0?'todo':index<at?'done':index===at?'now':'todo'}))};
}
const textOf=value=>{const text=typeof value==='string'?value.trim():'';return text||null;};
function createHeaderMeta(shell){
 let current={status:textOf(shell['cs:status']),points:textOf(shell['cs:points']),sprint:textOf(shell['cs:sprint']),
  dependsOn:(shell['cs:depends-on']||'').split(',').map(item=>item.trim()).filter(Boolean),epic:textOf(shell['cs:parent-epic']),needsYou:{count:0,capped:false}};
 const listeners=new Set();
 return {
  meta:()=>current,
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
  update(patch){
   const next={...current,...patch};
   if(JSON.stringify(next)===JSON.stringify(current))return;
   current=next;for(const fn of [...listeners])fn(current);
  },
 };
}

const leadRowsOf=(rows,storyId,role)=>(Array.isArray(rows)?rows:[]).filter(row=>row.story===storyId&&row.role===role);
const liveLeadOf=(rows,storyId,role)=>leadRowsOf(rows,storyId,role).find(row=>row.state!=='exited')||null;
const activityOf=(row,runningSince,copy=COPY)=>{const p=row&&row.progress;return p&&typeof p.note==='string'&&p.note&&Number.isFinite(p.atMs)&&p.atMs>=(runningSince||0)?p.note:copy.header.activityNone;};
const presenceTable=copy=>({
 starting:{face:'starting',header:copy.header.starting,placeholder:copy.placeholder.starting},
 none:{face:'off',header:copy.header.none,placeholder:copy.placeholder.none},
 idle:{face:'idle',header:copy.header.idle,placeholder:copy.placeholder.idle},
 needs:{face:'working',header:copy.header.needs,placeholder:copy.placeholder.needs},
 unknown:{face:'off',header:copy.header.unknown,placeholder:copy.placeholder.unknown},
});
function presenceOf(row,{launch,runningSince,done}={},copy=COPY){
 let out;const by=presenceTable(copy);
 if(launch&&launch.state==='failed')out={key:'failed',face:'failed',header:copy.header.failed(failureReason(launch.failure,copy)),placeholder:copy.placeholder.failed};
 else if(launch&&launch.stuck&&(launch.state==='starting'||launch.state==='slow'))out={key:'needs',...by.needs};
 else if(launch&&(launch.state==='starting'||launch.state==='slow'))out={key:'starting',...by.starting};
 else if(!row||row.state==='exited')out={key:'none',...by.none};
 else if(row.state==='running'){const activity=activityOf(row,runningSince,copy);out={key:'running',face:'working',header:copy.header.working(activity),placeholder:copy.placeholder.running,activity};}
 else if(row.state==='idle')out={key:'idle',...by.idle};
 else if(row.state==='needs-you')out={key:'needs',...by.needs};
 else out={key:'unknown',...by.unknown};
 if(done)out={key:'done',face:'off',header:copy.header.done,placeholder:copy.placeholder.done};
 return out;
}

const parseFailure=error=>{
 const code=String((error&&error.message)||error||'unavailable').trim();
 if(/^refused:/.test(code))return {kind:'refused',code:'refused',why:code.replace(/^refused:\s*/,'')};
 if(/^busy\b/.test(code))return {kind:'busy',code};
 if(/^denied:/.test(code))return {kind:'denied',code,why:code.replace(/^denied:\s*/,'')};
 if(/^unavailable:/.test(code))return {kind:'unavailable',code,why:code.replace(/^unavailable:\s*/,'')};
 return {kind:'other',code};
};
const storyCard=(meta,text)=>`Story ${meta['cs:story-id']||''}: ${meta['cs:title']||''}\nStatus: ${meta['cs:status']||'unknown'}\nYou are its story lead.\nFrom the story page:\n\n${text}`;
const died=row=>row.state==='exited'||row.effectiveStatus==='crashed';
const joinable=row=>Boolean(row)&&!died(row)&&row.needsYouKind!=='startup';
const firstLive=list=>list.find(joinable)||null;
function createLaunch({transport,clock,storyId,leadRole,timers,card,onChange=()=>{},ownRows=rows=>leadRowsOf(rows,storyId,leadRole),pickLive=firstLive}){
 let promptItems=new Set(),state='idle',failure=null,sendFailure=null,rows=[],launchResult=null,settled=false,stuck=false,seq=0,ids=0,chain=Promise.resolve(),slowTimer=null,failTimer=null,staleDead=new Map();
 const messages=[],outbox=[],emit=()=>onChange();
 const identity=row=>row.sessionId||row.handle;
 const rank=row=>(staleDead.has(identity(row))?2:0)+(row.state==='exited'?1:0);
 const launchedIn=list=>{
  if(!launchResult||!(launchResult.sessionId||launchResult.handle))return null;
  if(launchResult.sessionId)return ownRows(list).find(row=>row.sessionId===launchResult.sessionId)||null;
  return ownRows(list).filter(row=>row.handle===launchResult.handle).sort((a,b)=>rank(a)-rank(b))[0]||null;
 };
 const launchedRow=()=>launchedIn(rows);
 const liveIn=list=>{const row=launchedIn(list);return joinable(row)?row:pickLive(ownRows(list));};
 const live=()=>liveIn(rows);
 const starting=()=>state==='starting'||state==='slow';
 const clearTimers=()=>{if(slowTimer!==null)clock.clearTimeout(slowTimer);if(failTimer!==null)clock.clearTimeout(failTimer);slowTimer=failTimer=null;};
 const enqueue=job=>{chain=chain.then(job,job);return chain;};
 const texts=list=>list.map(item=>item.text).join('\n\n');
 const deliver=(list,handle)=>{
  list.forEach(item=>{item.mark='sent';});sendFailure=null;emit();
  return enqueue(()=>transport.send(handle,texts(list))).then(result=>{
   if(result&&result.status!==undefined&&result.status!=='sent'){list.forEach(item=>{item.mark='kept';});sendFailure={kind:'other',code:String(result.status),why:result.message||String(result.status)};emit();return;}
   if(result&&result.messageId!==undefined)for(const item of list)item.messageId=result.messageId;emit();
  },error=>{list.forEach(item=>{item.mark='kept';});sendFailure=parseFailure(error);emit();});
 };
 function fail(next){clearTimers();stuck=false;state='failed';failure=next;outbox.splice(0);messages.forEach(item=>{if(item.mark==='starting'||item.mark==='held')item.mark='kept';});emit();}
 function startTimers(){
  slowTimer=clock.setTimeout(()=>{slowTimer=null;if(state==='starting'){state='slow';emit();}},timers.slowMs);
  armFail();
 }
 function armFail(){failTimer=clock.setTimeout(()=>{failTimer=null;if(starting())fail({kind:'timeout',code:'timeout'});},timers.failMs);}
 function tryJoin(){
  const own=launchedRow();
  if(state!=='failed'&&own&&!joinable(own))return false;
  const row=live();
  if(!row||!['starting','slow','failed'].includes(state)||(state!=='failed'&&!settled))return false;
  clearTimers();stuck=false;
  const first=messages.filter(item=>(item.mark==='starting'||item.mark==='kept')&&promptItems.has(item)),held=[...messages.filter(item=>item.mark==='kept'&&!promptItems.has(item)),...outbox.splice(0)];
  state='joined';failure=null;
  if(first.length){if(launchResult&&launchResult.promptDelivered!==false)first.forEach(item=>{item.mark='sent';});else deliver(first,row.handle);}
  for(const item of held)deliver([item],row.handle);
  emit();return true;
 }
 function inspect(){
  const row=launchedRow();
  if(launchResult&&!(row&&died(row))){
   if(row)staleDead.delete(identity(row));
   else for(const [key,handle] of staleDead)if(launchResult.sessionId?key===launchResult.sessionId:handle===launchResult.handle)staleDead.delete(key);
  }
  if(starting()&&settled&&row&&died(row)&&!staleDead.has(identity(row))){
   fail({kind:'exited',code:row.endReason||(row.effectiveStatus==='crashed'?'crashed':'exited')});return true;
  }
  if(tryJoin())return true;
  if(starting()&&settled){
   if(row&&row.needsYouKind==='startup'){if(!stuck){stuck=true;clearTimers();emit();}}
   else if(stuck){stuck=false;if(!row)armFail();emit();}
  }
  return false;
 }
 function startLaunch(list){
  const mine=++seq;promptItems=new Set(list);state='starting';failure=null;sendFailure=null;settled=false;stuck=false;launchResult=null;
  staleDead=new Map(ownRows(rows).filter(died).map(row=>[identity(row),row.handle]));
  list.forEach(item=>{item.mark='starting';});emit();
  return enqueue(()=>Promise.resolve().then(()=>transport.launch(card(texts(list))))).then(result=>{
   if(mine!==seq)return;launchResult=result||{};settled=true;
   if(!inspect()){if(!stuck)startTimers();emit();}
  },error=>{if(mine!==seq)return;settled=true;fail(parseFailure(error));});
 }
 const retryList=()=>[...messages.filter(item=>item.mark==='kept'),...outbox.splice(0)];
 return {
  get state(){return state;},get failure(){return failure;},get stuck(){return stuck;},get sendFailure(){return sendFailure;},get messages(){return messages;},get held(){return outbox.length;},
  launchedRow,liveIn,
  hasHeld:()=>outbox.length>0||messages.some(item=>item.mark==='kept'),
  hasKept:()=>messages.some(item=>item.mark==='kept'),
  send(text){
   const item={id:++ids,text,mark:null,sentAt:clock.now()};messages.push(item);
   const row=live();
   if(state==='failed'){
    if(row){tryJoin();return deliver([item],row.handle);}
    return startLaunch([...retryList(),item]);
   }
   if(starting()){item.mark='held';outbox.push(item);emit();return Promise.resolve();}
   if(row)return deliver([...messages.filter(other=>other!==item&&other.mark==='kept'),item],row.handle);
   return startLaunch([...messages.filter(other=>other!==item&&other.mark==='kept'),item]);
  },
  retry(){
   if(state!=='failed')return Promise.resolve();
   if(live()){tryJoin();return Promise.resolve();}
   return startLaunch(retryList());
  },
  retrySend(){
   const row=live(),kept=messages.filter(item=>item.mark==='kept');
   if(!kept.length||state==='failed')return Promise.resolve();
   return row?deliver(kept,row.handle):startLaunch(kept);
  },
  rows(next){
   rows=Array.isArray(next)?next:[];
   if(inspect())return;
   if(state==='joined'&&!live())state='idle';
   emit();
  },
  dispose(){seq++;clearTimers();},
 };
}

const rowsOf=answer=>Array.isArray(answer)?answer:Array.isArray(answer&&answer.messages)?answer.messages:[];
function mergeThread(...lists){
 const byId=new Map();
 for(const row of lists.flatMap(rowsOf))if(row&&row.messageId!==undefined&&!byId.has(row.messageId))byId.set(row.messageId,row);
 return [...byId.values()].sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)||(a.messageId>b.messageId?1:-1));
}
const sideOf=(row,leadHandles)=>row.from==='human'?'you':leadHandles.has(row.from)||/^role:/.test(row.from||'')?'lead':'other';
const newestFrom=(rows,leadHandles)=>rows.filter(row=>sideOf(row,leadHandles)==='lead').reduce((at,row)=>Math.max(at,row.createdAtMs||0),0);

const bridgeOf=win=>win&&win.codesense||null;
function createTransport(cs,{config,storyId}){
 const invoke=(verb,args)=>cs.invoke(verb,args);
 return {
  launch:prompt=>invoke('openWorkspace',{target:{kind:'story',storyId,agent:config.lead.agent,session:'lead'},initialPrompt:prompt}),
  send:(handle,text)=>invoke('sendAsHuman',{to:handle,text}),
  gotoAgent:sessionId=>invoke('gotoAgent',{agentId:sessionId}),
  stream:typeof cs.onChunk==='function'?listener=>cs.onChunk(listener):null,
  threadOf:sessionId=>cs.inbox({sessionId}).then(rowsOf),
  roleThread:()=>cs.inbox({role:`${config.lead.queue}:${storyId}`}).then(rowsOf),
 };
}

const sessionRows=answer=>Array.isArray(answer)?answer:Array.isArray(answer&&answer.sessions)?answer.sessions:[];
function createReads(cs,{config,storyId,clock=globalThis,win=globalThis}){
 let timer=null;const listeners={sessions:new Set(),sessionsFailed:new Set(),inbox:new Set(),context:new Set(),activity:new Set()};
 const fire=name=>{for(const fn of listeners[name])fn();};
 const pending=new Set();
 const later=name=>{pending.add(name);if(timer!==null)clock.clearTimeout(timer);timer=clock.setTimeout(()=>{timer=null;const names=[...pending];pending.clear();names.forEach(fire);},config.timers.debounceMs);};
 let first=null,latest=[],stop=[];
 const message=name=>event=>{if(!event||event.source!==win.parent)return;const data=event.data;if(data===name||(data&&data.type===name))later(name.replace('codesense:','').replace('-changed','').replace('agent-activity','activity'));};
 return {
  sessions(){
   if(!first)first=new Promise(resolve=>{
    const off=cs.onSessions((list,error)=>{if(error||list===null||list===undefined){fire('sessionsFailed');return;}latest=sessionRows(list);resolve(latest);fire('sessions');});
    if(typeof off==='function')stop.push(off);
   });
   return first;
  },
  latestSessions:()=>latest,
  queryStory:()=>cs.queryContext({match:{story_id:storyId},select:['title','status','story_id'],limit:1}).then(answer=>rowsOf(answer&&answer.rows?answer.rows:answer)[0]||null),
  needsYou:()=>cs.inbox({kind:'needs-you',limit:config.limits.needsYou}).then(rowsOf),
  usage:args=>cs.sessionUsage(args||{story:storyId}),
  openFile:path=>cs.openFile({path,newTab:true}),
  gotoAgent:agentId=>cs.invoke('gotoAgent',{agentId}),
  readFile:path=>typeof cs.invoke==='function'?cs.invoke('files.read',{path}):Promise.reject(new Error('unavailable: this page cannot read files')),
  on(name,fn){
   listeners[name].add(fn);
   if(listeners[name].size===1&&name==='inbox'&&typeof cs.onInboxChanged==='function')stop.push(cs.onInboxChanged(()=>later('inbox')));
   if(listeners[name].size===1&&(name==='context'||name==='activity')){const handler=message(`codesense:${name==='activity'?'agent-activity':'context'}-changed`);win.addEventListener('message',handler);stop.push(()=>win.removeEventListener('message',handler));}
   return ()=>listeners[name].delete(fn);
  },
  dispose(){stop.forEach(off=>off());stop=[];if(timer!==null)clock.clearTimeout(timer);},
 };
}

const COMPOSER_IDS={region:'sv-composer',input:'sv-composer-input',send:'sv-send',hint:'sv-composer-hint'};
function createComposer({onSend,copy=COPY}){
 const input=h('textarea',{id:COMPOSER_IDS.input,rows:'2','aria-label':copy.composerLabel,'aria-describedby':COMPOSER_IDS.hint,spellcheck:'true'});
 const send=h('button',{id:COMPOSER_IDS.send,type:'button',class:'btn primary'},copy.send);
 const region=h('div',{id:COMPOSER_IDS.region,class:'composer'},h('div',{class:'box'},input,send),h('div',{class:'hint',id:COMPOSER_IDS.hint},copy.hint));
 const submit=()=>{const text=input.value.trim();if(!text||input.disabled)return;input.value='';onSend(text);};
 input.addEventListener('keydown',event=>{if((event.code==='Enter'||event.code==='NumpadEnter')&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}});
 send.addEventListener('click',submit);
 const post=text=>{if(!text||input.disabled)return false;onSend(text);return true;};
 return {region,input,send,post,
  update({placeholder,disabled}){input.placeholder=placeholder;input.disabled=Boolean(disabled);send.disabled=Boolean(disabled);}};
}

const systemClock=()=>({now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)});
const face=(state,label)=>h('span',{class:'av','aria-hidden':'true','data-face':state,'data-label':label});
const ALERT_NS='http://www.w3.org/2000/svg';
const alertIcon=()=>{const svg=document.createElementNS(ALERT_NS,'svg'),path=document.createElementNS(ALERT_NS,'path');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('class','ico alert');svg.setAttribute('aria-hidden','true');path.setAttribute('d','M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2');svg.append(path);return svg;};
function reconcile(parent,cache,items){
 const seen=new Set(),nodes=[];
 for(const item of items){
  seen.add(item.id);
  if(item.node){nodes.push(item.node);continue;}
  const old=cache.get(item.id);
  if(old&&old.sig===item.sig)nodes.push(old.node);else{const node=item.make();cache.set(item.id,{sig:item.sig,node});nodes.push(node);}
 }
 for(const id of [...cache.keys()])if(!seen.has(id))cache.delete(id);
 nodes.forEach((node,index)=>{if(parent.childNodes[index]!==node)parent.insertBefore(node,parent.childNodes[index]||null);});
 while(parent.childNodes.length>nodes.length)parent.lastChild.remove();
}
function mount(el,{storyId,transport,reads,config,meta,clock=systemClock(),done=false,win=window,subject=null}){
 const leadRole=config.lead.role,copy=subject?subject.copy:COPY;
 const markText={stuck:copy.mark.stuck,starting:copy.mark.starting,held:copy.mark.held,sent:copy.mark.sent,kept:copy.mark.kept};
 const ownRows=list=>subject?subject.rowsOf(list):leadRowsOf(list,storyId,leadRole);
 let started=false,gotRows=false,mergedKey=null,threadRead=false,rows=[],thread=[],model=null,joinedAt=null,runningSince=0,lastLiveState=null,launchSessionId=null,isDone=done,awaitBase=null,gen=0,refocus=false;
 const streams=new Map(),watched=new Set(),listeners=new Set(),cache=new Map();
 const wrapped={launch:async prompt=>{const result=await transport.launch(prompt);if(result&&result.sessionId)launchSessionId=result.sessionId;return result;},send:(handle,text)=>transport.send(handle,text)};
 const launch=createLaunch({transport:wrapped,clock,storyId,leadRole,timers:config.timers,card:text=>subject?subject.card(text):storyCard(meta,text),onChange:()=>render(),ownRows,...(subject?{pickLive:subject.live}:{})});
 const live=()=>subject?launch.liveIn(rows):liveLeadOf(rows,storyId,leadRole);
 const noteLaunched=()=>{const row=launch.launchedRow();if(row)launchSessionId=row.sessionId;};
 const leadHandles=()=>new Set([...ownRows(rows).map(row=>row.handle),...(subject?subject.history():[])]);
 const leadCount=()=>{const handles=leadHandles();return thread.filter(row=>sideOf(row,handles)==='lead').length+streams.size;};
 const presence=()=>presenceOf(live(),{launch:{state:launch.state,failure:launch.failure,stuck:launch.stuck},runningSince,done:isDone},copy);
 const launchedFirst=()=>launch.stuck||(launch.state==='failed'&&launch.failure.kind==='exited');
 const terminalTarget=()=>(launchedFirst()&&launchSessionId)||(live()&&live().sessionId)||launchSessionId||null;
 const showTerminal=()=>{const target=terminalTarget();if(target)transport.gotoAgent(target);};
 const log=h('div',{class:'log',role:'log',tabindex:'0','aria-live':'polite','aria-label':subject?copy.chat.logLabel:'Story lead chat'});
 const status=h('div',{class:'status-slot',id:'sv-status',tabindex:'-1'});
 const composer=createComposer({onSend:text=>{awaitBase=leadCount();launch.send(text);},copy});
 el.replaceChildren(h('div',{class:'chatcol'},subject?null:h('div',{class:'src'},COPY.transcript(config.owners.transcript)),log,composer.region));
 const bubble=(item,side)=>h('div',{class:`msg ${side}`,'data-mid':item.id===undefined?null:String(item.id)},
  h('div',{class:'meta'},`${item.who} · ${timeLabel(item.at)}`),h('div',{class:'body'},item.text),item.note?h('div',{class:'note'},item.note):null,item.mark?h('div',{class:'mark','data-mark':item.markKey},item.mark):null);
 const typing=()=>h('div',{class:'msg lead typing','data-typing':'1'},face('working',copy.row.typing),h('span',{class:'dots','aria-hidden':'true'},h('i'),h('i'),h('i')),h('span',{class:'sr'},copy.row.typing));
 const termButton=id=>{const on=Boolean(terminalTarget());return h('button',{type:'button',class:'btn sm quiet term',id,'data-term':'1',disabled:on?null:'',onclick:showTerminal},on?copy.terminal:copy.terminalOff);};
 const alertRow=(kind,why,code,...extra)=>h('div',{class:'sys danger',role:'alert','data-row':kind},alertIcon(),h('span',{class:'why'},why),h('code',{class:'code'},code),...extra);
 const statusCache=new Map();
 function statusItems(){
  const unread=threadFailed(),stale=staleAt(),readRetry=()=>h('button',{type:'button',class:'btn sm','data-thread-retry':'1',onclick:()=>{readThread();}},copy.row.retry);
  const reads=unread?[{id:'unread',sig:'u',make:()=>h('div',{class:'sys danger',role:'alert','data-row':'unread'},h('span',{},copy.row.unread),readRetry())}]
   :stale!==null?[{id:'stale',sig:'st|'+stale,make:()=>h('div',{class:'sys warn',role:'status','data-row':'stale'},h('span',{},copy.row.stale(timeLabel(stale))),readRetry())}]:[];
  const state=launch.state,p=presence(),on=Boolean(terminalTarget()),out=[...reads];
  if((state==='starting'||state==='slow')&&launch.stuck){
   out.push({id:'stuck',sig:'stuck|'+on,make:()=>h('div',{class:'sys warn','data-row':'stuck'},h('span',{},copy.row.needsTerminal),termButton('sv-term-stuck'))});
  }else if(state==='starting'||state==='slow'){
   out.push({id:'starting',sig:'s',make:()=>h('div',{class:'sys','data-row':'starting'},face('starting',`${copy.lead} · ${copy.header.starting}`),h('span',{},copy.row.starting))});
   if(state==='slow')out.push({id:'slow',sig:'slow|'+on,make:()=>h('div',{class:'sys warn','data-row':'slow'},h('span',{},copy.row.slow),termButton('sv-term-slow'))});
  }else if(state==='failed'){
   const failure=launch.failure;
   out.push({id:'failed',sig:['f',failure.kind,failure.code,failureText(failure,copy),on].join('|'),make:()=>alertRow('failed',failureText(failure,copy),failure.code,failure.kind==='timeout'||failure.kind==='exited'?termButton('sv-term-failed'):null,
    h('button',{type:'button',class:'btn sm','data-retry':'1',onclick:()=>{refocus=true;launch.retry();status.focus();}},copy.row.retry))});
  }else{
   const sf=launch.sendFailure;
   if(sf)out.push({id:'send-failed',sig:['sf',sf.why,sf.code].join('|'),make:()=>alertRow('send-failed',copy.failure.send(sf.why||sf.code),sf.code,
    h('button',{type:'button',class:'btn sm','data-retry-send':'1',onclick:()=>{launch.retrySend();}},copy.row.retry))});
   if(joinedAt!==null){
    const text=copy.row.joined(model?modelLabel(model):copy.row.modelNone,activityOf(live(),runningSince,copy));
    out.push({id:'joined',sig:['j',p.face,p.header,text].join('|'),make:()=>h('div',{class:'sys','data-row':'joined'},face(p.face,`${copy.lead} · ${p.header}`),h('span',{},text))});
   }
  }
  return out;
 }
 function threadItems(){
  const handles=leadHandles(),entries=[],rowIds=new Set(thread.map(row=>row.messageId));
  for(const row of thread){
   const side=sideOf(row,handles),needs=row.kind==='needs-you'&&side==='lead',who=side==='you'?copy.who.you:side==='lead'?copy.lead:(row.fromName||row.from||'');
   entries.push({t:row.createdAtMs||0,id:'m'+row.messageId,sig:['m',row.messageId,row.text,side,needs,row.createdAtMs].join('|'),make:()=>bubble({id:row.messageId,text:row.text||row.summary||'',note:needs?copy.inboxNote:null,who,at:row.createdAtMs},side)});
  }
  for(const item of launch.messages){
   if(item.messageId!==undefined&&rowIds.has(item.messageId))continue;
   const mark=launch.stuck&&item.mark==='starting'?'stuck':item.mark;
   entries.push({t:item.sentAt,id:'l'+item.id,sig:['l',item.id,mark,item.text].join('|'),make:()=>bubble({text:item.text,mark:markText[mark]||null,markKey:mark,who:copy.who.you,at:item.sentAt},'you')});
  }
  entries.sort((a,b)=>a.t-b.t);
  for(const [id,text] of streams)if(!rowIds.has(id))entries.push({t:Infinity,id:'s'+id,sig:'s|'+id+'|'+text,make:()=>bubble({id,text,who:copy.lead,at:clock.now()},'lead')});
  return entries;
 }
 const awaiting=()=>awaitBase!==null&&leadCount()<=awaitBase&&(launch.state==='joined'||Boolean(live()&&live().state==='running'));
 function render(){
  noteLaunched();
  const p=presence();
  if(launch.state==='joined'&&joinedAt===null){
   joinedAt=clock.now();const row=live();
   if(row)reads.usage({sessionId:row.sessionId}).then(usage=>{const own=usage&&usage.sessions&&usage.sessions[0],first=own&&own.models&&own.models[0];model=(typeof first==='string'?first:first&&first.model)||null;render();},()=>{});
  }
  if(launch.state!=='joined'&&launch.state!=='idle')joinedAt=null;
  reconcile(status,statusCache,statusItems());
  status.hidden=!status.childNodes.length;
  const want=[...threadItems(),{id:'status',node:status},...(awaiting()?[{id:'typing',sig:'t',make:typing}]:[])];
  const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<80;
  reconcile(log,cache,want);
  if(nearBottom)log.scrollTop=log.scrollHeight;
  if(refocus&&launch.state!=='starting'&&launch.state!=='slow'){refocus=false;const retry=status.querySelector('[data-retry]');if(retry&&(!el.ownerDocument.activeElement||el.ownerDocument.activeElement===el.ownerDocument.body||el.ownerDocument.activeElement===status))retry.focus();}
  composer.update({placeholder:p.placeholder,disabled:isDone});
  for(const fn of listeners)fn();
 }
 const ROLE='\u0000role',bySource=new Map(),readOf=new Map(),asked=new Set(),pending=new Map(),failed=new Set(),failedAt=new Map(),missOf=new Map(),sessionsOf=new Map();
 const flight=(id,by)=>{const n=(pending.get(id)||0)+by;if(n>0)pending.set(id,n);else pending.delete(id);};
 const sourcesOf=leadRows=>subject?subject.sources(leadRows):leadRows.map(row=>row.sessionId);
 const current=()=>[...sourcesOf(ownRows(rows)),ROLE];
 const threadFailed=()=>current().some(id=>failed.has(id)&&!bySource.has(id));
 const staleAt=()=>{const times=current().filter(id=>failed.has(id)&&failedAt.has(id)).map(id=>failedAt.get(id));return times.length?Math.min(...times):null;};
 const threadSettled=()=>threadRead&&!current().some(id=>pending.has(id)&&!bySource.has(id));
 async function readThread(onlyNew=false){
  const mine=++gen,leadRows=ownRows(rows);
  for(const row of leadRows)watched.add(row.sessionId);
  const sources=sourcesOf(leadRows);
  for(const id of asked)if(!sources.includes(id))asked.delete(id);
  const ids=onlyNew?sources.filter(id=>!asked.has(id)):[...sources,ROLE];
  ids.forEach(id=>{asked.add(id);flight(id,1);});
  const key=current().join('\n');
  if(key!==mergedKey){mergedKey=key;thread=mergeThread(...current().map(id=>bySource.get(id)||[]));render();}
  const newer=id=>(readOf.get(id)||0)<mine;
  const keep=(id,list)=>{if(!newer(id))return;readOf.set(id,mine);bySource.set(id,list);if((missOf.get(id)||0)<mine){failed.delete(id);failedAt.delete(id);}else if(!failedAt.has(id))failedAt.set(id,clock.now());};
  const miss=id=>{if(!newer(id))return;missOf.set(id,Math.max(missOf.get(id)||0,mine));failed.add(id);if(!bySource.has(id))asked.delete(id);else if(!failedAt.has(id))failedAt.set(id,clock.now());};
  await Promise.all(ids.map(id=>(id===ROLE?transport.roleThread():transport.threadOf(id)).then(list=>keep(id,list),()=>miss(id)).then(()=>flight(id,-1))));
  const now=current();mergedKey=now.join('\n');
  thread=mergeThread(...now.map(id=>bySource.get(id)||[]));
  if(!now.some(id=>pending.has(id)&&!bySource.has(id)))threadRead=true;
  if(runningSince===0)runningSince=newestFrom(thread,leadHandles());
  for(const row of thread)streams.delete(row.messageId);
  if(awaitBase!==null&&leadCount()>awaitBase)awaitBase=null;
  render();
 }
 function onRows(next){
  const firstRoster=!gotRows;gotRows=true;
  const before=live();rows=next;const now=live();
  let reread=false;
  for(const row of ownRows(next)){
   if(!row.handle)continue;
   const known=sessionsOf.get(row.handle),sessions=known||new Set();
   if(!known)sessionsOf.set(row.handle,sessions);
   if(row.state==='exited'||sessions.has(row.sessionId))continue;
   sessions.add(row.sessionId);
   if(known&&!firstRoster&&subject){asked.delete(row.handle);reread=true;}
  }
  if(now&&now.state==='running'&&(!before||before.state!=='running')&&lastLiveState!==null)runningSince=clock.now();
  lastLiveState=now?now.state:'none';
  launch.rows(next);
  if(!started||reread||ownRows(next).some(row=>!watched.has(row.sessionId))){const more=started&&Boolean(subject);started=true;readThread(more);}else render();
 }
 const offs=[reads.on('sessions',()=>onRows(reads.latestSessions())),reads.on('inbox',()=>{readThread();}),reads.on('activity',()=>render())];
 if(typeof transport.stream==='function')offs.push(transport.stream(chunk=>{streams.set(chunk.messageId,(streams.get(chunk.messageId)||'')+chunk.text);render();}));
 const onUnload=event=>{if(launch.hasHeld()){const text=launch.hasKept()?copy.unloadKept:copy.unload;event.preventDefault();event.returnValue=text;return text;}};
 win.addEventListener('beforeunload',onUnload);
 render();
 composer.input.focus();
 if(subject){started=true;readThread(true);}
 reads.sessions().then(()=>{if(!gotRows)onRows(reads.latestSessions());});
 return {
  unmount(){offs.forEach(off=>off&&off());launch.dispose();win.removeEventListener('beforeunload',onUnload);el.replaceChildren();},
  presence,launch,showTerminal,send:text=>{awaitBase=leadCount();return launch.send(text);},thread:()=>thread,threadFailed,threadSettled,refresh:readThread,post:text=>composer.post(text),leadHandles,terminalOn:()=>Boolean(terminalTarget()),lead:live,
  setDone(value){isDone=Boolean(value);render();},
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
 };
}

function viewerPath(pathname){
 const m=/^\/viewer\/([^/]+)\/(.*)$/.exec(String(pathname||''));
 if(!m)return {root:null,rel:decodeURIComponent(String(pathname||'')).replace(/^\//,'')};
 let root=null;
 try{const b64=m[1].replace(/-/g,'+').replace(/_/g,'/'),text=atob(b64+'='.repeat((4-b64.length%4)%4));if(text.startsWith('/'))root=text;}catch{root=null;}
 return {root,rel:decodeURIComponent(m[2])};
}
const kindLabel=type=>type?type[0].toUpperCase()+type.slice(1):'Story';
function storyMdPath(meta,pathname){
 const docs=(meta['cs:supporting-docs']||'').split(',').map(item=>item.trim()).filter(item=>item.endsWith('.story.md'));
 if(!docs.length)return null;
 const {root,rel}=viewerPath(pathname),dir=rel.split('/').slice(0,-1).join('/');
 const parts=[...(dir?dir.split('/'):[]),...docs[0].split('/')].reduce((out,part)=>{if(part==='..')out.pop();else if(part!=='.'&&part)out.push(part);return out;},[]);
 return root?`${root.replace(/\/$/,'')}/${parts.join('/')}`:parts.join('/');
}
function mountHeader(el,{meta,config,reads,chat,storyId,pathname=globalThis.location&&globalThis.location.pathname}){
 const metaModel=createHeaderMeta(meta);
 let status=meta['cs:status']||'';
 const mdPath=storyMdPath(meta,pathname);
 const storyBtn=h('button',{type:'button',class:'story-l',id:'sv-story',onclick:()=>{if(mdPath)reads.openFile(mdPath);}},COPY.story);
 const panelToggle=h('button',{type:'button',class:'btn sm quiet',id:'sv-panel','aria-pressed':'false'},COPY.panel.toggle);
 const termLabel=h('span',{},COPY.terminal),termBtn=h('button',{type:'button',class:'btn sm quiet term',id:'sv-term-header','data-term':'1',onclick:()=>chat&&chat.showTerminal()},icon('term'),termLabel);
 const pause=h('span',{class:'pause-l',id:'sv-pause'},COPY.pause(config.owners.pause));
 const stageChip=h('span',{class:'pill',id:'sv-stage'}),rail=h('span',{class:'rail','aria-hidden':'true'});
 const questions=h('span',{class:'waiting',id:'sv-questions',role:'status',hidden:''});
 const spend=h('span',{class:'spent',id:'sv-spend'},h('b',{},'Loading…'));
 const presence=h('span',{class:'presence',id:'sv-presence',role:'status'});
 const stripSlot=h('span',{class:'strip-slot','data-slot':'agents-strip'});
 el.replaceChildren(
  h('div',{class:'dh'},
   h('div',{},h('div',{class:'dh-id'},h('span',{},kindLabel(meta['cs:type'])),h('strong',{id:'sv-id'},storyId)),h('h1',{id:'sv-title'},meta['cs:title']||'')),
   h('div',{class:'dh-a'},storyBtn,chat?panelToggle:null,chat?termBtn:null,pause),
   h('div',{class:'dh-st'},h('span',{class:'stage'},stageChip,' ',rail),questions,spend,presence,stripSlot)));
 function paintStage(){
  const model=stageModel(status,config);
  stageChip.textContent=model.phase||'unknown';
  rail.replaceChildren(...model.steps.map(step=>h('i',{'data-s':step.state})));
  pause.hidden=status==='done';
  metaModel.update({status:status||null});
  if(chat)chat.setDone(status==='done');
 }
 let painted='';
 function paintPresence(){
  if(!chat){presence.replaceChildren();return;}
  const p=chat.presence(),on=chat.terminalOn();
  termBtn.disabled=!on;termLabel.textContent=on?COPY.terminal:COPY.terminalOff;
  const key=`${p.face}|${p.header}`;
  if(key===painted)return;painted=key;
  presence.replaceChildren(h('span',{class:'av','aria-hidden':'true','data-face':p.face,'data-label':`${COPY.lead} · ${p.header}`}),h('span',{class:'lbl'},COPY.lead),h('span',{class:'what'},`· ${p.header}`));
 }
 let needs=[],paintedQuestions=null;
 const paintQuestions=()=>{const model=questionsModel(needs,storyId,config.limits.needsYou,{thread:chat?chat.thread():[],leadHandles:chat?chat.leadHandles():new Set()});const key=`${model.text}|${model.note}`;if(key===paintedQuestions)return;paintedQuestions=key;metaModel.update({needsYou:{count:model.count,capped:model.capped}});questions.hidden=!model.text;questions.replaceChildren(model.text,...(model.note?[h('small',{},model.note)]:[]));};
 const loadQuestions=()=>reads.needsYou().then(rows=>{needs=rows;paintQuestions();},()=>{questions.hidden=true;});
 const loadSpend=()=>reads.usage().then(usage=>{spend.replaceChildren(h('b',{},spendModel(usage).text));},()=>{spend.replaceChildren(h('b',{},spendModel(null).text));});
 const loadStatus=()=>reads.queryStory().then(row=>{const next=row&&(row.status||(row.fields&&row.fields.status));if(next&&next!==status){status=next;paintStage();}},()=>{});
 paintStage();paintPresence();
 if(chat)chat.subscribe(()=>{paintPresence();paintQuestions();});
 loadQuestions();loadSpend();loadStatus();
 const offs=[reads.on('inbox',loadQuestions),reads.on('activity',loadSpend),reads.on('context',loadStatus)];
 return {meta:metaModel.meta,subscribe:metaModel.subscribe,stripSlot,panelToggle,unmount(){offs.forEach(off=>off());el.replaceChildren();}};
}

const present=value=>typeof value==='string'&&value.trim()?value.trim():null;
const waitingText=needs=>{
 const count=needs&&Number.isFinite(needs.count)?needs.count:0;
 return count?`${count}${needs.capped?'+':''} ${count===1&&!needs.capped?'question':'questions'}`:OVERVIEW.none;
};
function overviewModel({meta,pills,lead}){
 const text=value=>present(value)||OVERVIEW.notSet,deps=Array.isArray(meta.dependsOn)?meta.dependsOn.filter(Boolean):[];
 const agents=pills.length?[OVERVIEW.leadLine(lead),...pills.map(pill=>`${pill.name} · ${pill.presence}`)]:OVERVIEW.leadOnly;
 const rows=[['Stage',text(meta.status),!present(meta.status)],['Points',text(meta.points),!present(meta.points)],['Sprint',text(meta.sprint),!present(meta.sprint)],
  ['Depends on',deps.length?deps.join(', '):OVERVIEW.notSet,!deps.length],['Epic',text(meta.epic),!present(meta.epic)],['Agents',agents,false],['Waiting on you',waitingText(meta.needsYou),false]];
 return rows.map(([label,value,muted])=>({label,value,muted}));
}

const SCHEME=/^[a-z][a-z0-9+.-]*:/i,ALLOWED=/^(https?|mailto):/i;
function safeHref(url){
 const clean=String(url).replace(/[\u0000- ]/g,'');
 if(!clean)return null;
 if(SCHEME.test(clean))return ALLOWED.test(clean)?clean:null;
 if(/^[\\/]{2}/.test(clean)||/^[^/?#]*:/.test(clean))return null;
 return clean;
}
const INLINE=/(`+)([^`]+?)\1|(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*/;
function inline(doc,parent,text){
 for(let rest=text;rest;){
  const match=INLINE.exec(rest);
  if(!match){parent.append(rest);return;}
  if(match.index)parent.append(rest.slice(0,match.index));
  if(match[2]!==undefined){const code=doc.createElement('code');code.textContent=match[2];parent.append(code);}
  else if(match[4]!==undefined){
   const href=safeHref(match[5]);
   if(href===null||!match[4])parent.append(match[4]||match[0]);
   else{const link=doc.createElement('a');link.setAttribute('href',href);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');inline(doc,link,match[4]);parent.append(link);}
  }else if(match[6]!==undefined){const strong=doc.createElement('strong');inline(doc,strong,match[6]);parent.append(strong);}
  else{const em=doc.createElement('em');inline(doc,em,match[7]);parent.append(em);}
  rest=rest.slice(match.index+match[0].length);
 }
}
function renderInline(text,doc){
 const span=doc.createElement('span');
 inline(doc,span,String(text));
 return span;
}
const ITEM=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/,FENCE=/^\s*```/,HR=/^\s*([-*_])(\s*\1){2,}\s*$/,HEADING=/^(#{1,6})\s+(.*?)\s*#*\s*$/,SEP=/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
const startsBlock=(line,next)=>!line.trim()||FENCE.test(line)||HEADING.test(line)||HR.test(line)||ITEM.test(line)||/^\s*>/.test(line)||(line.includes('|')&&next!==undefined&&SEP.test(next)&&next.includes('-'));
function list(doc,items){
 const build=(from,indent)=>{
  const ol=/^\d/.test(items[from].marker),el=doc.createElement(ol?'ol':'ul');let at=from,last=null;
  while(at<items.length&&items[at].indent>=indent){
   if(items[at].indent>indent&&last){const [child,next]=build(at,items[at].indent);last.append(child);at=next;continue;}
   last=doc.createElement('li');
   const task=/^\[([ xX])\]\s+(.*)$/.exec(items[at].text),checked=task&&task[1]!==' ';
   if(task){const box=doc.createElement('span'),words=doc.createElement('span');box.setAttribute('class','box');box.setAttribute('aria-hidden','true');box.textContent=checked?'☑':'☐';words.setAttribute('class','sr');words.textContent=`${checked?TASKS_TAB.doneMark:TASKS_TAB.openMark}: `;last.setAttribute('class','task');last.append(box,words);}
   inline(doc,last,task?task[2]:items[at].text);el.append(last);at++;
  }
  return [el,at];
 };
 return build(0,Math.min(...items.map(item=>item.indent)))[0];
}
function blocks(doc,root,lines){
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(FENCE.test(line)){
   const body=[];for(i++;i<lines.length&&!/^\s*```\s*$/.test(lines[i]);i++)body.push(lines[i]);i++;
   const pre=doc.createElement('pre'),code=doc.createElement('code');code.textContent=body.join('\n');pre.append(code);root.append(pre);continue;
  }
  const heading=HEADING.exec(line);
  if(heading){const el=doc.createElement(`h${Math.min(6,heading[1].length+1)}`);inline(doc,el,heading[2]);root.append(el);i++;continue;}
  if(HR.test(line)){root.append(doc.createElement('hr'));i++;continue;}
  if(line.includes('|')&&i+1<lines.length&&SEP.test(lines[i+1])&&lines[i+1].includes('-')){
   const table=doc.createElement('table'),thead=doc.createElement('thead'),tbody=doc.createElement('tbody'),head=doc.createElement('tr');
   for(const text of cells(line)){const th=doc.createElement('th');inline(doc,th,text);head.append(th);}
   thead.append(head);table.append(thead,tbody);
   for(i+=2;i<lines.length&&lines[i].includes('|')&&lines[i].trim();i++){const tr=doc.createElement('tr');for(const text of cells(lines[i])){const td=doc.createElement('td');inline(doc,td,text);tr.append(td);}tbody.append(tr);}
   root.append(table);continue;
  }
  if(/^\s*>/.test(line)){
   const inner=[];for(;i<lines.length&&/^\s*>/.test(lines[i]);i++)inner.push(lines[i].replace(/^\s*>\s?/,''));
   const quote=doc.createElement('blockquote');blocks(doc,quote,inner);root.append(quote);continue;
  }
  if(ITEM.test(line)){
   const items=[];
   for(;i<lines.length;i++){const m=ITEM.exec(lines[i]);if(m)items.push({indent:m[1].length,marker:m[2],text:m[3]});else if(lines[i].trim()&&/^\s+\S/.test(lines[i])&&items.length)items[items.length-1].text+=` ${lines[i].trim()}`;else break;}
   root.append(list(doc,items));continue;
  }
  const para=[line];
  for(i++;i<lines.length&&!startsBlock(lines[i],lines[i+1]);i++)para.push(lines[i]);
  const p=doc.createElement('p');inline(doc,p,para.map(item=>item.trim()).join(' '));root.append(p);
 }
}
function render(md,doc){
 const root=doc.createElement('div');
 root.setAttribute('class','md');
 blocks(doc,root,String(md).replace(/\r\n?/g,'\n').split('\n'));
 return root;
}

const OL_CHECK=/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;
const OL_AC_TAG=/\(\s*AC\s*:\s*([0-9,\s\-–]+?)\s*\)/i;
const OL_TASK_ID=/^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/;
const OL_HANDOFF_H=/^#{3,4}\s+Handoff\s+(\d{4}-\d{2}-\d{2})\s*[·—–-]\s*(?:session\s+)?(.+?)\s*$/i;
const OL_FIELD=/^\s*[-*]\s+(Done|Next|Decisions|Files)\s*:\s*(.*)$/i;
const olFence=line=>line.trimStart().startsWith('```');
function olBody(text){
 const lines=text.split('\n');
 if(!lines.length||lines[0].trim()!=='---')return text;
 for(let i=1;i<lines.length;i++)if(lines[i].trim()==='---')return lines.slice(i+1).join('\n');
 return text;
}
function olBlocks(body){
 const blocks=[];let fence=false;
 for(const line of body.split('\n')){
  if(olFence(line))fence=!fence;
  const m=fence?null:line.match(/^##\s+(.*?)\s*#*$/);
  if(m&&!line.startsWith('###'))blocks.push([m[1],[]]);
  else if(blocks.length)blocks[blocks.length-1][1].push(line);
 }
 return blocks;
}
function olUnfenced(lines){
 const out=[];let fence=false;
 for(const line of lines){if(olFence(line))fence=!fence;else if(!fence)out.push(line);}
 return out;
}
function olExpand(spec){
 const out=[];
 for(const part of spec.trim().split(/[,\s]+/)){
  if(!part)continue;
  const r=part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if(r){const a=Number(r[1]),b=Number(r[2]);for(let n=a;n<=b;n++)out.push(n);}
  else if(/^\d+$/.test(part))out.push(Number(part));
 }
 return out;
}
const olIndent=ws=>[...ws].reduce((col,c)=>c==='\t'?col+2-col%2:col+1,0);
const olStartsIndented=line=>line.startsWith(' ')||line.startsWith('\t');
const olLf=text=>String(text).replace(/\r\n?/g,'\n');
function parseOutline(text){
 const blocks=olBlocks(olBody(olLf(text))),sections=blocks.map(([title])=>title),problems=[];
 const block=rx=>{for(const [title,lines] of blocks)if(rx.test(title))return lines;return null;};
 const acLines=block(/^acceptance/i),taskLines=block(/^tasks?\b/i);
 const acs=[];
 if(acLines!==null){
  let cur=null;
  for(const line of olUnfenced(acLines)){
   const m=line.match(/^(\d+)[.)]\s+(.*)$/),b=line.match(/^\s{0,3}[-*]\s+(.*)$/);
   if(m){cur={n:Number(m[1]),text:m[2].trim()};acs.push(cur);}
   else if(b&&taskLines===null){cur={n:acs.length+1,text:b[1].trim()};acs.push(cur);}
   else if(cur&&olStartsIndented(line)&&line.trim())cur.text+=' '+line.trim();
  }
 }
 const format=acLines!==null&&taskLines!==null?'bmad-1':acLines!==null?'legacy':'unknown';
 const tasks=[];
 if(taskLines!==null){
  let curTask=null;
  for(const line of olUnfenced(taskLines)){
   const m=line.match(OL_CHECK);
   if(!m)continue;
   const indent=olIndent(m[1]),checked=m[2]!==' ',rest=m[3].trim(),tm=rest.match(OL_TASK_ID);
   let [id,txt]=tm?[tm[1],tm[2]]:[null,rest];
   const tag=txt.match(OL_AC_TAG),acn=tag?olExpand(tag[1]):[];
   if(tag)txt=(txt.slice(0,tag.index)+txt.slice(tag.index+tag[0].length)).trim();
   const node={id,text:txt,checked,acs:acn,subtasks:[]};
   if(indent===0||curTask===null){node.id=id||String(tasks.length+1);tasks.push(node);curTask=node;}
   else{node.id=id||`${curTask.id}.${curTask.subtasks.length+1}`;curTask.subtasks.push(node);}
  }
  for(const task of tasks)task.acs=[...new Set([...task.acs,...task.subtasks.flatMap(sub=>sub.acs)])].sort((a,b)=>a-b);
 }
 const handoffs=[],rec=block(/^dev agent record/i);
 if(rec!==null){
  let cur=null,field=null;
  for(const line of rec){
   const hm=line.match(OL_HANDOFF_H);
   if(hm){cur={date:hm[1],session:hm[2],done:'',next:'',decisions:'',files:''};handoffs.push(cur);field=null;continue;}
   if(cur===null)continue;
   const f=line.match(OL_FIELD);
   if(f){field=f[1].toLowerCase();cur[field]=f[2].trim();}
   else if(/^#{1,4}\s/.test(line)){cur=null;field=null;}
   else if(field&&olStartsIndented(line)&&line.trim())cur[field]=(cur[field]+' '+line.trim()).trim();
  }
 }
 if(format==='unknown')problems.push('no Acceptance Criteria section');
 if(format==='bmad-1'){
  if(!acs.length)problems.push('Acceptance Criteria has no numbered items');
  const nums=acs.map(ac=>ac.n);
  if(nums.some((n,i)=>n!==i+1))problems.push(`AC numbers are not 1..n in order: [${nums.join(', ')}]`);
  if(!tasks.length)problems.push('Tasks / Subtasks has no checkbox items');
  const known=new Set(nums),used=new Set();
  for(const task of tasks){
   if(!task.acs.length)problems.push(`orphan task ${task.id}: no (AC: n) tag`);
   for(const n of task.acs)if(!known.has(n))problems.push(`task ${task.id} names AC ${n}, which does not exist`);
   task.acs.forEach(n=>used.add(n));
  }
  for(const ac of acs)if(!used.has(ac.n))problems.push(`AC ${ac.n} has no task`);
 }
 return {format,acs,tasks,handoffs,sections,problems};
}
function parseTrace(text){
 const rows=[];let inTable=false;
 for(const line of olLf(text).split('\n')){
  const s=line.trim();
  if(!s.startsWith('|')){inTable=false;continue;}
  const cells=s.replace(/^\|+|\|+$/g,'').split('|').map(cell=>cell.trim());
  if(cells.slice(0,3).map(cell=>cell.toLowerCase()).join('|')==='ac|evidence|result'){inTable=true;continue;}
  if(inTable&&cells.length>=3&&!/^:?-{2,}:?$/.test(cells[0])){
   const m=cells[0].match(/^(?:AC\s*)?(\d+)$/i);
   if(m)rows.push({ac:Number(m[1]),evidence:cells[1],result:cells[2]});
  }
 }
 return rows;
}
const taskCounts=outline=>outline&&outline.tasks.length?{done:outline.tasks.filter(task=>task.checked).length,total:outline.tasks.length}:null;
function acsVerified(rows){
 const latest=new Map();
 for(const row of rows)latest.set(row.ac,row.result);
 return [...latest.values()].filter(result=>/^pass/i.test(result)).length;
}

const UNAVAILABLE=/^(unavailable|denied: grant)/i;
function createSource(reads,path){
 let pending=null;
 const failure=error=>{const message=String(error&&error.message||error||'unknown');return {ok:false,unavailable:UNAVAILABLE.test(message),reason:message.replace(/^unavailable:\s*/i,'')};};
 return {
  path,
  load(){
   if(!pending)pending=reads.readFile(path).then(answer=>({ok:true,text:typeof answer==='string'?answer:String(answer&&answer.text||'')}),failure);
   return pending;
  },
  reset(){pending=null;},
 };
}
const isLegacyHtml=text=>/^\s*<(?:!doctype\s+html|html)\b/i.test(text);
function mountStory(el,ctx){
 const box=h('div',{class:'story-tab'});
 el.replaceChildren(box);
 const open=label=>h('button',{type:'button',class:'btn sm',onclick:()=>ctx.reads.openFile(ctx.source.path)},label);
 function paint(result,{refocus=false}={}){
  let content,openLabel=STORY_TAB.openMd;
  if(!result.ok&&result.unavailable)content=h('p',{role:'status'},STORY_TAB.unavailable);
  else if(!result.ok)content=h('div',{class:'row'},h('p',{role:'alert'},STORY_TAB.failed(result.reason)),h('button',{type:'button',class:'btn sm','data-retry':'1',onclick:retry},STORY_TAB.retry));
  else if(!result.text.trim())content=h('p',{},STORY_TAB.empty);
  else if(isLegacyHtml(result.text)){
   openLabel=STORY_TAB.openFile;
   content=h('div',{class:'legacy'},h('p',{class:'muted'},STORY_TAB.legacy),h('iframe',{class:'legacy-frame',title:STORY_TAB.legacy,sandbox:'',srcdoc:result.text}));
  }else content=render(result.text,document);
  const body=h('div',{class:'result',tabindex:'-1'},content);
  box.replaceChildren(h('div',{class:'bar'},open(openLabel)),body);
  if(refocus)body.focus();
 }
 function load(refocus){
  box.replaceChildren(h('p',{role:'status'},STORY_TAB.loading));
  ctx.source.load().then(result=>paint(result,{refocus}));
 }
 function retry(){ctx.source.reset();load(true);}
 load(false);
}

const traceMissing=reason=>/not.?found|no such file|enoent/i.test(reason);
async function readTrace(source){
 const answer=await source.load();
 if(answer.ok)return {state:'rows',rows:parseTrace(answer.text)};
 if(traceMissing(answer.reason))return {state:'missing'};
 source.reset();
 return {state:'failed',reason:answer.reason};
}
const resultOf=(rows,n)=>{const own=rows.filter(row=>row.ac===n);return own.length?h('td',{title:own.map(row=>row.evidence).join(' · '),'data-result':own.some(row=>/^fail/i.test(row.result))?'fail':null},own.map(row=>row.result).join(' · ')):h('td',{class:'muted'},TASKS_TAB.notTraced);};
function taskItem(task){
 return h('li',{class:'task','data-done':task.checked?'1':'0'},
  h('span',{class:'box','aria-hidden':'true'},task.checked?'☑':'☐'),h('span',{class:'sr'},`${task.checked?TASKS_TAB.doneMark:TASKS_TAB.openMark}: `),
  `${task.id}. ${task.text}`,task.acs.length?h('span',{class:'tags'},` · AC ${task.acs.join(', ')}`):null,
  task.subtasks.length?h('ul',{},...task.subtasks.map(taskItem)):null);
}
function mountTasks(el,ctx){
 const box=h('div',{class:'tasks-tab'});
 el.replaceChildren(box);
 function paint(outline,trace){
  const rows=trace.state==='rows'?trace.rows:null,parts=[];
  if(!outline.acs.length&&!outline.tasks.length){box.replaceChildren(h('p',{},TASKS_TAB.none));return;}
  const notes=[outline.problems.length?h('p',{class:'muted',role:'status'},TASKS_TAB.partial):null,trace.state==='failed'?h('p',{class:'muted',role:'status'},TASKS_TAB.traceFailed(trace.reason)):null].filter(Boolean);
  if(outline.acs.length)parts.push(h('h2',{},TASKS_TAB.acs),...notes,h('table',{class:'acs'},
   h('thead',{},h('tr',{},h('th',{},TASKS_TAB.colAc),h('th',{},TASKS_TAB.colCriterion),rows?h('th',{},TASKS_TAB.colResult):null)),
   h('tbody',{},...outline.acs.map(ac=>h('tr',{},h('td',{},String(ac.n)),h('td',{},renderInline(ac.text,document)),rows?resultOf(rows,ac.n):null)))));
  if(!outline.acs.length)parts.push(...notes);
  if(outline.tasks.length)parts.push(h('h2',{},TASKS_TAB.tasks),h('p',{class:'muted'},TASKS_TAB.done(outline.tasks.filter(task=>task.checked).length,outline.tasks.length)),h('ul',{class:'tasklist'},...outline.tasks.map(taskItem)));
  box.replaceChildren(...parts);
 }
 function failed(result){
  box.replaceChildren(result.unavailable?h('p',{role:'status'},TASKS_TAB.unavailable):h('div',{class:'row'},h('p',{role:'alert'},STORY_TAB.failed(result.reason)),h('button',{type:'button',class:'btn sm','data-retry':'1',onclick:()=>{ctx.source.reset();ctx.trace.reset();load(true);}},STORY_TAB.retry)));
 }
 function load(refocus){
  box.replaceChildren(h('p',{role:'status'},STORY_TAB.loading));
  Promise.all([ctx.source.load(),readTrace(ctx.trace)]).then(([result,trace])=>{
   if(result.ok)paint(parseOutline(result.text),trace);else failed(result);
   if(refocus){box.tabIndex=-1;box.focus();}
  });
 }
 load(false);
}

function mountOverview(el,ctx){
 const list=h('dl',{class:'ov'});
 el.replaceChildren(list);
 function paint(){
  const rows=overviewModel({meta:ctx.header.meta(),pills:ctx.agents(),lead:ctx.chat.presence().header});
  list.replaceChildren(...rows.map(row=>h('div',{class:'ov-row','data-field':row.label},h('dt',{},row.label),
   h('dd',{class:row.muted?'muted':null},...(Array.isArray(row.value)?row.value.map(line=>h('div',{},line)):[row.value])))));
 }
 const offs=[ctx.header.subscribe(paint),ctx.reads.on('sessions',paint),ctx.reads.on('activity',paint),ctx.chat.subscribe(paint)];
 paint();
 return ()=>offs.forEach(off=>off());
}

const ACTIVITY_MAX=24;
const PRESENCE={running:['working','working'],idle:['idle','idle'],'needs-you':['needs you','working'],exited:['not running','off'],offline:['offline','off']};
const LIVE=new Set(['running','idle','needs-you']);
const two=n=>String(n).padStart(2,'0');
const clock24=ms=>{const date=new Date(ms);return `${two(date.getHours())}:${two(date.getMinutes())}`;};
function stripModel(rows,{storyId,leadRole}){
 const list=(Array.isArray(rows)?rows:[]).filter(row=>row&&row.story===storyId&&row.role!==leadRole);
 const ordered=list.map((row,index)=>({row,index})).sort((a,b)=>(Number.isFinite(a.row.startedAtMs)?a.row.startedAtMs:Infinity)-(Number.isFinite(b.row.startedAtMs)?b.row.startedAtMs:Infinity)||a.index-b.index);
 const pills=ordered.map(({row})=>{
  const [presence,face]=PRESENCE[row.state]||['status unknown','off'];
  const note=row.progress&&typeof row.progress.note==='string'?row.progress.note:'';
  const activity=LIVE.has(row.state)?note:row.state==='exited'&&Number.isFinite(row.endedAtMs)?`ended ${clock24(row.endedAtMs)}`:'';
  const name=row.displayName||row.role||row.handle;
  return {sessionId:row.sessionId||row.handle,handle:row.handle,name,state:row.state,presence,face,live:LIVE.has(row.state),activity,
   shown:activity.length>ACTIVITY_MAX?activity.slice(0,ACTIVITY_MAX)+'…':activity,label:[name,presence,activity].filter(Boolean).join(', '),row};
 });
 return {pills,leadIn:pills.length?(pills.some(pill=>pill.live)?STRIP.working:STRIP.ended):null};
}

function mountStrip(slot,{reads,config,storyId,onPick,win=window}){
 const nodes=new Map();let selected=null,last={pills:[],leadIn:null},group=null;
 const narrow=()=>win.innerWidth<NARROW;
 const make=pill=>{
  const node=h('button',{type:'button',class:'ag',id:`sv-ag-${pill.sessionId}`,'aria-pressed':'false','data-agent':pill.sessionId,onclick:()=>{const now=last.pills.find(item=>item.sessionId===pill.sessionId);if(now&&!narrow())onPick(now);}},
   h('span',{class:'av','aria-hidden':'true'}),h('span',{class:'nm'}));
  return node;
 };
 const set=(node,name,value)=>{if(value===null)node.removeAttribute(name);else if(node.getAttribute(name)!==value)node.setAttribute(name,value);};
 function paint(node,pill){
  const off=narrow(),words=`${pill.name} · ${pill.shown||pill.presence}`;
  set(node,'aria-label',pill.label+(off?STRIP.widenSuffix:''));
  set(node,'title',off?(pill.activity?pill.activity+STRIP.widenSuffix:STRIP.widen):pill.activity||null);
  set(node,'aria-disabled',off?'true':null);
  set(node,'aria-pressed',String(pill.sessionId===selected));
  set(node.firstChild,'data-face',pill.face);
  if(node.lastChild.textContent!==words)node.lastChild.textContent=words;
 }
 function render(){
  last=stripModel(reads.latestSessions(),{storyId,leadRole:config.lead.role});
  if(!last.pills.length){nodes.clear();group=null;slot.replaceChildren();return;}
  const keep=new Set(last.pills.map(pill=>pill.sessionId));
  for(const [id,node] of nodes)if(!keep.has(id)){node.remove();nodes.delete(id);}
  if(!group){group=h('span',{class:'agents',role:'group','aria-label':STRIP.group},h('span',{class:'lead-in'}));slot.replaceChildren(group);}
  group.firstChild.textContent=last.leadIn;
  last.pills.forEach((pill,at)=>{
   let node=nodes.get(pill.sessionId);
   if(!node){node=make(pill);nodes.set(pill.sessionId,node);}
   paint(node,pill);
   const want=group.children[at+1]||null;
   if(want!==node)group.insertBefore(node,want);
  });
 }
 const offs=[reads.on('sessions',render),reads.on('activity',render)];
 const repaint=()=>last.pills.forEach(pill=>paint(nodes.get(pill.sessionId),pill));
 win.addEventListener('resize',repaint);
 reads.sessions().then(render);
 return {
  select(sessionId){selected=sessionId;repaint();},
  pill:sessionId=>last.pills.find(pill=>pill.sessionId===sessionId)||null,
  pillNode:sessionId=>nodes.get(sessionId)||null,
  model:()=>last,
  unmount(){offs.forEach(off=>off());win.removeEventListener('resize',repaint);slot.replaceChildren();},
 };
}

function mountDetail({head,body},ctx,sessionId,{onBack}){
 const find=()=>stripModel(ctx.reads.latestSessions(),{storyId:ctx.storyId,leadRole:ctx.config.lead.role}).pills.find(pill=>pill.sessionId===sessionId)||null;
 let last=find();
 const back=h('button',{type:'button',class:'btn sm quiet back',id:'sv-detail-back','aria-label':DETAIL.backName,onclick:onBack},icon('back'),h('span',{},DETAIL.back));
 head.id='sv-detail-head';
 const agent=h('span',{class:'ah',id:'sv-detail-agent'}),termText=h('span'),term=h('button',{type:'button',class:'btn sm',id:'sv-detail-term',onclick:()=>{termNote.hidden=true;Promise.resolve(ctx.reads.gotoAgent(sessionId)).catch(()=>{termNote.hidden=false;});}},icon('term'),termText);
 const termNote=h('p',{class:'muted',role:'status','data-term-note':'1',hidden:''},DETAIL.terminalFailed),doing=h('p',{'data-doing':'1'});
 head.replaceChildren(back,term,agent);
 body.replaceChildren(termNote,h('h2',{class:'sec'},DETAIL.doingNow),doing,h('p',{class:'muted later'},DETAIL.later(ctx.config.owners.detail)));
 function paint(){
  const pill=find()||{...last,presence:DETAIL.notRunning,face:'off',state:'exited',activity:''};
  last=pill;
  const started=Number.isFinite(pill.row&&pill.row.startedAtMs)?DETAIL.since(clock24(pill.row.startedAtMs)):null;
  const ended=pill.state==='exited'&&Number.isFinite(pill.row&&pill.row.endedAtMs)?DETAIL.endedAt(clock24(pill.row.endedAtMs)):null;
  const line=pill.state==='exited'?[DETAIL.notRunning,ended]:[pill.presence,pill.activity,started];
  agent.replaceChildren(h('span',{class:'av','aria-hidden':'true','data-face':pill.face}),h('strong',{class:'nm'},pill.name),h('span',{class:'what'},line.filter(Boolean).join(' · ')));
  const exited=pill.state==='exited';
  term.disabled=exited;termText.textContent=exited?COPY.terminalOff:COPY.terminal;
  doing.textContent=exited?DETAIL.notRunningNow:pill.activity?DETAIL.fromSession(pill.activity):DETAIL.nothing;
 }
 paint();
 const offs=[ctx.reads.on('sessions',paint),ctx.reads.on('activity',paint)];
 back.focus();
 return ()=>offs.forEach(off=>off());
}

const nothing=()=>{};
function buildRegistry(config,mounts={}){
 return Object.entries(config.panel.tabs).map(([id,tab])=>{
  const built=tab.built===true;
  return {id,label:tab.label,owner:tab.owner,ownerPath:tab.ownerPath||null,emptyText:tab.empty,built,
   action:built?null:{label:COPY.panel.openOwner(tab.open),path:tab.ownerPath},mount:mounts[id]||nothing};
 });
}
const tabName=tab=>tab.built?tab.label:COPY.panel.unbuiltName(tab.label,tab.owner);
const menuLabel=tab=>tab.built?tab.label:tab.label+COPY.panel.notBuiltSuffix;

const NARROW=720;
const MIN_WIDTH=320,STEP=16,BUTTON_STEP=64,CHAT_MIN=400,MAX_WIDTH=720,DEFAULT_WIDTH=460;
const maxWidthFor=viewport=>Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,viewport-CHAT_MIN));
const ring=()=>h('span',{class:'ring','aria-hidden':'true'});
function mountPanel({column,toggle,registry,ctx={},win=window}){
 let isOpen=false,selected=registry[0].id,width=null,detail=null,unmountTab=null;
 const byId=new Map(registry.map(tab=>[tab.id,tab]));
 const tablist=h('div',{class:'tabs',role:'tablist','aria-label':COPY.panel.tablist});
 const allTabs=h('button',{type:'button',class:'btn sm quiet all-tabs','aria-haspopup':'menu','aria-expanded':'false'},COPY.panel.allTabs);
 const closeBtn=h('button',{type:'button',class:'btn sm quiet close','aria-label':COPY.panel.close,onclick:()=>setOpen(false)},'×');
 const stepButton=(label,glyph,by)=>h('button',{type:'button',class:'btn sm quiet step','aria-label':label,title:label,onclick:()=>setWidth(width+by)},glyph);
 const sizeBtns=[stepButton(COPY.panel.narrow,'−',-BUTTON_STEP),stepButton(COPY.panel.widen,'+',BUTTON_STEP)];
 const menuWrap=h('div',{class:'menu-wrap'},allTabs);
 const detailHead=h('div',{class:'detail-head',hidden:''});
 const head=h('div',{class:'panel-head'},tablist,menuWrap,detailHead,...sizeBtns,closeBtn);
 const body=h('div',{class:'panel-body',role:'tabpanel',tabindex:'-1'});
 const sep=h('div',{class:'resize',role:'separator','aria-orientation':'vertical','aria-label':COPY.panel.resize,tabindex:'0'});
 column.replaceChildren(h('div',{class:'panel'},sep,head,body));
 const tabButtons=new Map(registry.map(tab=>{
  const button=h('button',{type:'button',class:'tab',role:'tab',id:`sv-tab-${tab.id}`,'aria-controls':'sv-panel-body','aria-selected':'false',tabindex:'-1','data-tab':tab.id,
   'aria-label':tab.built?null:tabName(tab),onclick:()=>select(tab.id)},tab.label,tab.built?null:ring());
  return [tab.id,button];
 }));
 body.id='sv-panel-body';tablist.replaceChildren(...tabButtons.values());
 const maxWidth=()=>maxWidthFor(win.innerWidth);
 const clamp=value=>Math.max(MIN_WIDTH,Math.min(maxWidth(),value));
 function paintWidth(){
  width=clamp(width===null?DEFAULT_WIDTH:width);
  column.style.width=`${width}px`;
  sep.setAttribute('aria-valuemin',String(MIN_WIDTH));sep.setAttribute('aria-valuemax',String(maxWidth()));sep.setAttribute('aria-valuenow',String(width));
  sizeBtns[0].setAttribute('aria-disabled',String(width<=MIN_WIDTH));sizeBtns[1].setAttribute('aria-disabled',String(width>=maxWidth()));
 }
 const setWidth=value=>{width=clamp(value);paintWidth();paintEdges();};
 let frame=0,latest=0;
 const flush=()=>{if(frame){win.cancelAnimationFrame(frame);frame=0;setWidth(win.innerWidth-latest);}};
 function paintEdges(){
  const room=tablist.scrollWidth-tablist.clientWidth;
  tablist.dataset.fadeStart=String(tablist.scrollLeft>1);tablist.dataset.fadeEnd=String(tablist.scrollLeft<room-1);
 }
 function paintTabs(){
  for(const [id,button] of tabButtons){const on=id===selected;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;}
  const button=tabButtons.get(selected);
  if(button.offsetLeft<tablist.scrollLeft)tablist.scrollLeft=button.offsetLeft;
  else if(button.offsetLeft+button.offsetWidth>tablist.scrollLeft+tablist.clientWidth)tablist.scrollLeft=button.offsetLeft+button.offsetWidth-tablist.clientWidth;
  paintEdges();
 }
 function unbuiltBody(tab){
  return [h('p',{class:'ub-head'},h('b',{},COPY.panel.unbuiltHead(tab.label))),h('p',{},tab.emptyText),h('p',{class:'muted'},COPY.panel.comingIn(tab.owner)),
   h('button',{type:'button',class:'btn sm',onclick:()=>ctx.openContent(tab.action.path)},tab.action.label)];
 }
 function paintBody(){
  const tab=byId.get(selected);
  body.setAttribute('aria-labelledby',`sv-tab-${selected}`);
  if(unmountTab){unmountTab();unmountTab=null;}
  body.replaceChildren();
  if(tab.built){const done=tab.mount(body,ctx);if(typeof done==='function')unmountTab=done;}else body.append(...unbuiltBody(tab));
 }
 function select(id,{focus=false}={}){
  selected=id;paintTabs();paintBody();
  if(focus)tabButtons.get(id).focus();
 }
 tablist.addEventListener('scroll',paintEdges);
 tablist.addEventListener('keydown',event=>{
  const ids=registry.map(tab=>tab.id),at=ids.indexOf(selected);
  const next=event.key==='ArrowRight'?ids[(at+1)%ids.length]:event.key==='ArrowLeft'?ids[(at-1+ids.length)%ids.length]:event.key==='Home'?ids[0]:event.key==='End'?ids[ids.length-1]:null;
  if(next===null)return;
  event.preventDefault();select(next,{focus:true});
 });
 let menu=null;
 function closeMenu({focus=true}={}){
  if(!menu)return;
  menu.remove();menu=null;allTabs.setAttribute('aria-expanded','false');
  win.document.removeEventListener('pointerdown',outside,true);
  if(focus)allTabs.focus();
 }
 function outside(event){if(menu&&!menu.contains(event.target)&&event.target!==allTabs)closeMenu();}
 function openMenu(){
  const items=registry.map(tab=>h('button',{type:'button',class:'menu-item',role:'menuitem',tabindex:'-1','data-tab':tab.id,'aria-current':tab.id===selected?'true':null,onclick:()=>{select(tab.id);closeMenu();}},menuLabel(tab)));
  menu=h('div',{class:'menu',role:'menu','aria-label':COPY.panel.allTabs},...items);
  menu.addEventListener('keydown',event=>{
   const at=items.indexOf(win.document.activeElement);
   const to=event.key==='ArrowDown'?(at+1)%items.length:event.key==='ArrowUp'?(at-1+items.length)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:null;
   if(to!==null){event.preventDefault();items[to].focus();return;}
   if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();closeMenu();}
  });
  menuWrap.append(menu);allTabs.setAttribute('aria-expanded','true');
  win.document.addEventListener('pointerdown',outside,true);
  items[registry.findIndex(tab=>tab.id===selected)].focus();
 }
 allTabs.addEventListener('click',()=>menu?closeMenu():openMenu());
 function paintMode(){
  tablist.hidden=menuWrap.hidden=sizeBtns[0].hidden=sizeBtns[1].hidden=Boolean(detail);detailHead.hidden=!detail;head.classList.toggle('detail',Boolean(detail));
  if(detail){body.setAttribute('role','region');body.setAttribute('aria-labelledby','sv-detail-agent');}else body.setAttribute('role','tabpanel');
 }
 function showDetail(mount){
  if(narrow())return false;
  if(detail&&detail.cleanup)detail.cleanup();
  if(unmountTab){unmountTab();unmountTab=null;}
  detail={cleanup:null};paintMode();
  setOpen(true);
  detail.cleanup=mount({head:detailHead,body});
  return true;
 }
 function hideDetail(){
  if(!detail)return;
  if(typeof detail.cleanup==='function')detail.cleanup();
  detail=null;paintMode();paintTabs();paintBody();
 }
 const narrow=()=>win.innerWidth<NARROW;
 function paintToggle(){
  toggle.setAttribute('aria-pressed',String(isOpen));
  toggle.disabled=narrow();
  if(narrow()){toggle.setAttribute('aria-label',COPY.panel.toggleNarrow);toggle.setAttribute('title',COPY.panel.toggleNarrow);}else{toggle.removeAttribute('aria-label');toggle.removeAttribute('title');}
 }
 function setOpen(next){
  if(next&&narrow())return;
  const inside=!next&&column.contains(win.document.activeElement);
  if(!next)closeMenu({focus:false});
  isOpen=next;column.hidden=!next;
  if(next){paintWidth();if(!detail){paintTabs();paintBody();}paintEdges();}
  paintToggle();
  if(inside||(!next&&win.document.activeElement===win.document.body)){
   const composer=win.document.getElementById('sv-composer-input');
   if(narrow()&&composer)composer.focus();else toggle.focus();
  }
 }
 toggle.addEventListener('click',()=>setOpen(!isOpen));
 win.addEventListener('resize',()=>{if(narrow()&&isOpen)setOpen(false);else if(isOpen){paintWidth();paintEdges();}paintToggle();});
 sep.addEventListener('keydown',event=>{
  const to=event.key==='ArrowLeft'?width+STEP:event.key==='ArrowRight'?width-STEP:event.key==='Home'?MIN_WIDTH:event.key==='End'?maxWidth():null;
  if(to===null)return;event.preventDefault();setWidth(to);
 });
 sep.addEventListener('dblclick',()=>setWidth(DEFAULT_WIDTH));
 sep.addEventListener('pointerdown',event=>{
  event.preventDefault();sep.setPointerCapture(event.pointerId);
  const move=ev=>{latest=ev.clientX;if(!frame)frame=win.requestAnimationFrame(()=>{frame=0;setWidth(win.innerWidth-latest);});},done=()=>{flush();sep.removeEventListener('pointermove',move);sep.removeEventListener('pointerup',done);sep.removeEventListener('pointercancel',done);};
  sep.addEventListener('pointermove',move);sep.addEventListener('pointerup',done);sep.addEventListener('pointercancel',done);
 });
 column.hidden=true;paintToggle();
 return {open:()=>setOpen(true),close:()=>setOpen(false),select,showDetail,hideDetail,isOpen:()=>isOpen,selected:()=>selected,body,detailShown:()=>detail!==null};
}

const isSendKey=event=>event.key==='Enter'&&Boolean(event.metaKey||event.ctrlKey)&&!event.isComposing;
const errorText=error=>String(error&&error.message||error||'unknown');

const SPRINT_KINDS=['story','bug','spike'];
const STAGE_ORDER=['in-progress','review','qa','todo','planning','done'];
const sprintQuery=(n,config)=>({where:{kinds:SPRINT_KINDS,teams:[config.team]},filters:[{key:'sprint',op:'eq',value:String(n)}],
 select:['story_id','title','status','points','sprint','cs:supporting-docs','cs:rank'],limit:500});
function joinPath(dir,rel){
 const out=[];
 for(const part of `${dir}/${rel}`.split('/')){if(part===''||part==='.')continue;if(part==='..'){if(!out.length)return null;out.pop();}else out.push(part);}
 return out.join('/');
}
const listOf=value=>Array.isArray(value)?value.map(String):typeof value==='string'?value.split(',').map(item=>item.trim()).filter(Boolean):[];
const numberOf=value=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
function storyRows(answer,n){
 const rows=answer&&Array.isArray(answer.rows)?answer.rows:[];
 return rows.filter(row=>row&&SPRINT_KINDS.includes(row.kind)&&row.fields&&row.fields.sprint===String(n)).map(row=>{
  const fields=row.fields,relPath=String(row.relPath||''),dir=relPath.split('/').slice(0,-1).join('/'),shell=relPath.endsWith('.html');
  const storyMd=listOf(fields.supporting_docs).find(doc=>doc.endsWith('.story.md'));
  const points=numberOf(fields.points);
  return {id:String(fields.story_id||row.id),title:String(fields.title||row.title||''),status:String(fields.status||''),kind:row.kind,shell,
   points:points!==null&&points>0?points:null,rank:numberOf(fields.rank),open:relPath,md:shell?(storyMd?joinPath(dir,storyMd):null):relPath};
 });
}
const idParts=id=>{const m=/^(.*?)-?(\d+)$/.exec(id);return m?[m[1],Number(m[2])]:[id,Infinity];};
const stageIndex=status=>{const i=STAGE_ORDER.indexOf(status);return i<0?STAGE_ORDER.length:i;};
function sortKey(row,needs){
 const [prefix,number]=idParts(row.id);
 return [needs.get(row.id)?0:1,row.status==='blocked'?0:1,row.rank===null?Infinity:row.rank,stageIndex(row.status),prefix,number];
}
const compareKeys=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i]<b[i])return -1;if(a[i]>b[i])return 1;}return 0;};
const sortRows=(rows,needs)=>rows.map(row=>[sortKey(row,needs),row]).sort((a,b)=>compareKeys(a[0],b[0])).map(pair=>pair[1]);
function foldRows(sorted,needs){
 const out={rows:[],planning:[],done:[]};
 for(const row of sorted){const fold=!needs.get(row.id)&&(row.status==='planning'||row.status==='done');(fold?out[row.status]:out.rows).push(row);}
 return out;
}
const showRank=rows=>rows.some(row=>row.rank!==null);
function newestOf(sessions,match){
 let best=null,bestAt=-Infinity;
 (Array.isArray(sessions)?sessions:[]).forEach((row,i)=>{
  if(!row||row.state==='exited'||!match(row))return;
  const started=row.launchTelemetry&&Number.isFinite(row.launchTelemetry.startedAtMs)?row.launchTelemetry.startedAtMs:null;
  const at=started===null?i:1e15+started;
  if(at>=bestAt){best=row;bestAt=at;}
 });
 return best;
}
const leadOf=(sessions,id,config)=>newestOf(sessions,row=>row.story===id&&row.role===config.lead.role);
function progressModel({read,outline,trace}){
 if(read==='loading')return {state:'loading'};
 if(read!=='ready'||!outline)return {state:'unknown'};
 const tasks=taskCounts(outline),total=outline.acs.length,own=new Set(outline.acs.map(ac=>ac.n));
 const acs=trace==='failed'||!total?{unknown:true}:trace?{verified:acsVerified(trace.filter(row=>own.has(row.ac))),total}:{noTrace:total};
 return {state:'ready',tasks,acs};
}

const PROGRESS_IN_FLIGHT=4;
const missingFile=error=>/^(?:not[_ ]?found|file not found)\b/i.test(errorText(error));
function createProgressReader({read,parse={outline:parseOutline,trace:parseTrace}}){
 const parsed=new Map(),last=new Map();
 let generation=0;
 const parseOnce=(kind,file)=>{const key=`${kind}:${file.sha256}`;if(!parsed.has(key))parsed.set(key,parse[kind](typeof file.text==='string'?file.text:''));return parsed.get(key);};
 async function readRow(row){
  if(!row.md)return ['none',{read:'failed'}];
  let md;
  try{md=await read(row.md);}catch{return ['failed',{read:'failed'}];}
  let trace=null,traceKey='none';
  try{const file=await read(`design/${row.id}/qa/trace.md`);trace=parseOnce('trace',file);traceKey=file.sha256;}catch(error){if(!missingFile(error)){trace='failed';traceKey='failed';}}
  return [`${md.sha256}|${traceKey}`,{read:'ready',outline:parseOnce('outline',md),trace}];
 }
 return {
  async run(rows,onResult){
   const mine=++generation,queue=[...rows];
   const worker=async()=>{
    while(queue.length&&mine===generation){
     const row=queue.shift(),[key,value]=await readRow(row);
     if(mine!==generation)return;
     if(last.get(row.id)===key)continue;
     last.set(row.id,key);onResult(row.id,value);
    }
   };
   await Promise.all(Array.from({length:PROGRESS_IN_FLIGHT},worker));
  },
 };
}

const inboxAnswer=answer=>({rows:rowsOf(answer),hasMore:Boolean(answer&&answer.hasMore)});
function createSprintBridge(cs,{config,sprint}){
 const act=(verb,args)=>typeof cs.act==='function'?cs.act(verb,args):cs.invoke(verb,args);
 return {
  query:()=>cs.queryContext(sprintQuery(sprint,config)),
  totals:ids=>cs.storyTotals({storyIds:ids}),
  needs:()=>cs.inbox({scope:'to-human',kind:'needs-you',limit:config.limits.needsYou}).then(inboxAnswer),
  answers:()=>cs.inbox({scope:'to-agents',limit:config.limits.answers}).then(inboxAnswer),
  storyAnswers:id=>cs.inbox({role:`${config.lead.queue}:${id}`}).then(inboxAnswer),
  thread:lead=>(lead?cs.inbox({sessionId:lead.sessionId||lead.handle}):cs.inbox({role:config.sprint.queue})).then(rowsOf),
  read:path=>cs.files.read({path}),
  openFile:path=>cs.openFile({path,newTab:true}),
  act,
  watchTotals(onChange){
   if(typeof cs.subscribe!=='function')return ()=>{};
   cs.subscribe('storyTotals',{onChange}).catch(()=>{});
   return ()=>{if(typeof cs.unsubscribe==='function')cs.unsubscribe('storyTotals',onChange).catch(()=>{});};
  },
 };
}

const usdText=usd=>`$${usd.toFixed(2)}`;
const amountText=spend=>`${spend.running?'≥ ':''}${usdText(spend.usd)}`;
function spendOf(answer,id){
 const stories=answer&&answer.stories&&typeof answer.stories==='object'?answer.stories:null;
 if(!stories)return {known:false,why:'error'};
 const entry=stories[id];
 if(!entry||typeof entry!=='object')return {known:false,why:'missing'};
 if(entry.pending)return {known:false,why:'pending'};
 if(entry.error)return {known:false,why:'error'};
 const usd=entry.totals?entry.totals.costUsd:null;
 if(typeof usd!=='number'||!Number.isFinite(usd)){const index=entry.unavailable?entry.unavailable.costUsd:null;return {known:false,why:'unavailable',reason:reasonAt(answer.reasons,index)};}
 return {known:true,usd,running:Number.isFinite(entry.openSessions)&&entry.openSessions>0,prs:Array.isArray(entry.prs)?entry.prs:[]};
}
const perPoint=(spend,points)=>spend.known&&Number.isFinite(points)&&points>0?spend.usd/points:null;
function sumSpend(answer,ids){
 let usd=0,known=0,unknown=0,running=false;
 for(const id of ids){const spend=spendOf(answer,id);if(spend.known){usd+=spend.usd;known++;running=running||spend.running;}else unknown++;}
 return {usd:known?usd:null,unknown,running};
}
function sumText({usd,unknown,running}){
 if(usd===null)return unknown?`— (${unknown} unknown)`:usdText(0);
 return `${unknown||running?'≥ ':''}${usdText(usd)}${unknown?` (${unknown} unknown)`:''}`;
}

const C=COPY.sprint;
const LEAD_STATE={running:['live',C.lead.running],idle:['idle',C.lead.idle],'needs-you':['needs',C.lead.needs],offline:['off',C.lead.offline]};
function leadCell(lead){
 if(!lead)return h('span',{class:'sp-dot off','data-lead':'none'},C.lead.none);
 const [tone,word]=LEAD_STATE[lead.state]||['off',C.lead.unknown];
 return h('span',{class:`sp-dot ${tone}`,'data-lead':lead.state||'unknown',title:lead.handle||''},word);
}
function stageCell(status,config){
 const model=stageModel(status,config);
 return h('span',{class:'sp-stg'},h('span',{class:'rail','aria-hidden':'true'},model.steps.map(step=>h('i',{'data-s':step.state}))),h('span',{class:'pill','data-s':status||'unknown'},status||C.dash));
}
function progressCell(model,id){
 if(model.state==='loading')return [h('span',{class:'sp-wait'},C.loading)];
 if(model.state!=='ready')return [h('span',{'data-progress':'unknown'},C.dash)];
 const tasks=model.tasks?h('span',{'data-progress':'tasks'},C.tasks(model.tasks.done,model.tasks.total)):h('span',{'data-progress':'tasks',title:C.noTasks},C.dash);
 const acs=model.acs.unknown?h('span',{class:'sp-sub','data-progress':'acs',title:C.acsUnknownTitle},C.acsUnknown)
  :model.acs.noTrace!==undefined?h('span',{class:'sp-sub acn','data-progress':'acs',title:C.noTraceTitle(id)},C.noTrace(model.acs.noTrace))
  :h('span',{class:'sp-sub','data-progress':'acs'},C.acs(model.acs.verified,model.acs.total));
 return [tasks,acs];
}
function spendCell(spend,points){
 if(!spend.known)return h('div',{class:'sp-spend','data-spend':spend.why},h('span',{title:C.unknownTitle(spend.reason||spend.why)},C.dash),
  spend.why==='pending'?h('span',{class:'sp-sub sp-wait'},C.computing):h('span',{class:'sp-sub'},C.notInSum));
 const amount=h('span',{title:spend.running?C.atLeastTitle:null},amountText(spend));
 const pp=perPoint(spend,points);
 const sub=spend.usd===0&&!spend.running?C.noRuns:pp!==null?C.perPoint(usdText(pp),spend.running):null;
 return h('div',{class:'sp-spend','data-spend':'known'},amount,sub?h('span',{class:'sp-sub'},sub):h('span',{class:'sp-sub',title:C.noPoints},C.dash));
}
function blockersCell(row,{needs,merge}){
 const badges=[];
 if(row.status==='blocked')badges.push(h('span',{class:'bdg failed'},C.blocked));
 if(needs)badges.push(h('span',{class:'bdg needs'},merge?C.needsMerge:C.needsAnswer));
 return h('span',{class:'sp-bl'},badges.length?badges:h('span',{class:'sp-muted'},C.none));
}
const fileName=path=>String(path).split('/').pop();
const idLink=(row,onclick)=>h('button',{type:'button',class:'lnk sp-id','data-focus':`id:${row.id}`,title:row.shell?C.openTab(row.id):C.openMd(fileName(row.open)),onclick},row.id);
const mdOnly=row=>row.shell?[]:[h('span',{class:'bdg quiet',title:C.mdOnlyTitle},C.mdOnly),' '];
function storyRow(row,ctx){
 const open=()=>ctx.open(row.open);
 const idBtn=idLink(row,event=>{event.stopPropagation();open();});
 const title=h('span',{class:'sp-ttl'},mdOnly(row),row.title);
 const progress=h('td',{'data-col':'progress'},progressCell(ctx.progress,row.id));
 const tr=h('tr',{'data-id':row.id,onclick:open},
  ctx.rank?h('td',{class:'num','data-col':'rank'},row.rank===null?C.dash:String(row.rank)):null,
  h('td',{'data-col':'story'},h('span',{class:'sp-sid'},idBtn,ctx.needs?h('span',{class:'bdg needs'},C.needsCount(ctx.needs)):null),title),
  h('td',{'data-col':'stage'},stageCell(row.status,ctx.config)),
  h('td',{'data-col':'lead'},leadCell(ctx.lead)),
  progress,
  h('td',{'data-col':'blockers'},blockersCell(row,ctx)),
  h('td',{'data-col':'spend'},spendCell(ctx.spend,row.points)));
 return {tr,setProgress:model=>progress.replaceChildren(...progressCell(model,row.id))};
}
function groupRow(status,rows,{colspan,sum,spendOf,open}){
 const mini=rows.map(row=>{const spend=spendOf(row.id);return h('tr',{'data-id':row.id},
  h('td',{},idLink(row,()=>open(row.open))),
  h('td',{class:'sp-muted'},mdOnly(row),row.title),
  h('td',{class:'num'},spend.known?amountText(spend):C.dash));});
 return h('tr',{class:'sp-grp','data-group':status},h('td',{colspan:String(colspan)},h('details',{'data-focus':`group:${status}`},
  h('summary',{},icon('chev'),h('span',{class:'pill','data-s':status},status),h('b',{},C.group.stories(rows.length)),h('span',{class:'sp-muted'},sum)),
  h('table',{class:'sp-mini'},h('tbody',{},mini)))));
}

const W=COPY.sprint.waiting;
const escapeId=id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const wholeId=id=>new RegExp(`(?:^|[^A-Za-z0-9-])${escapeId(id)}(?![A-Za-z0-9])`);
const leadRole=(config,id)=>`role:${config.lead.queue}:${id}`;
function cardStory(card,ids,config){
 const prefix=leadRole(config,''),replyTo=typeof card.replyTo==='string'?card.replyTo:'';
 if(replyTo.startsWith(prefix)){const id=replyTo.slice(prefix.length);return ids.includes(id)?id:null;}
 const text=`${card.summary||''}\n${card.text||''}`;
 let best=null,at=Infinity;
 for(const id of ids){const m=wholeId(id).exec(text);if(m&&m.index<at){best=id;at=m.index;}}
 return best;
}
const PR_URL=/https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)/;
function mergeOf(card){const m=PR_URL.exec(`${card.text||''}\n${card.summary||''}`);return m?{number:Number(m[1]),url:m[0]}:null;}
const pageOf=answers=>Array.isArray(answers)?{rows:answers,hasMore:false}:{rows:answers&&Array.isArray(answers.rows)?answers.rows:[],hasMore:Boolean(answers&&answers.hasMore)};
const answeredIds=rows=>new Set(rows.filter(row=>row&&row.from==='human'&&row.inReplyTo!==null&&row.inReplyTo!==undefined).map(row=>row.inReplyTo));
function decides(page,card){
 if(!page.hasMore)return true;
 const times=page.rows.map(row=>row&&row.createdAtMs).filter(Number.isFinite);
 return times.length>0&&Number.isFinite(card.createdAtMs)&&card.createdAtMs>=Math.min(...times);
}
function waitingCards(needs,answers,ids,config,byStory=new Map()){
 const all=pageOf(answers),answered=answeredIds([all,...byStory.values()].flatMap(page=>pageOf(page).rows)),out=[];
 for(const card of Array.isArray(needs)?needs:[]){
  if(!card||card.kind!=='needs-you'||card.from==='human'||answered.has(card.messageId))continue;
  const story=cardStory(card,ids,config);
  if(!story)continue;
  const own=card.replyTo===leadRole(config,story)&&byStory.has(story)?pageOf(byStory.get(story)):null;
  out.push({card,story,merge:mergeOf(card),unsure:!decides(all,card)&&!(own&&decides(own,card))});
 }
 return out.sort((a,b)=>(a.merge?0:1)-(b.merge?0:1)||(b.card.createdAtMs||0)-(a.card.createdAtMs||0));
}
const unsureStories=(items,config)=>new Set(items.filter(item=>item.unsure&&item.card.replyTo===leadRole(config,item.story)).map(item=>item.story));
function prState(merge,spend){
 const hit=spend&&spend.known&&Array.isArray(spend.prs)?spend.prs.find(pr=>pr&&Number(pr.number)===merge.number):null;
 if(!hit)return {known:false,merged:false};
 return Number.isFinite(hit.merged)?{known:true,merged:true,at:hit.merged}:{known:true,merged:false};
}
const countText=(n,hasMore,limit)=>hasMore?`${limit}+`:String(n);
const replyText={merge:'merge',sendBack:reason=>`send back: ${reason}`};
const destOf=card=>card.replyToName||String(card.replyTo||card.from||'').replace(/^role:/,'');
const plainText=text=>String(text||'').replace(/\*\*|__/g,'');
function cardView(item,ctx){
 const {card,story,merge,unsure}=item,dest=destOf(card),root=h('div',{class:'sp-mq',role:'group','data-card':String(card.messageId),'data-story':story,'data-unsure':unsure?'true':null,'aria-labelledby':`sp-q-${card.messageId}`});
 const statusText=status=>status?` · ${status}`:'';
 const statusEl=h('span',{},statusText(ctx.status));
 const head=h('div',{class:'sp-mq-h'},h('span',{class:'sp-you','aria-hidden':'true'},unsure?'·':'?'),unsure?h('span',{class:'bdg quiet'},W.cantTell):null,h('span',{class:'bdg needs'},merge?W.merge:W.question),
  h('span',{},h('button',{type:'button',class:'lnk','data-focus':`card-story:${card.messageId}`,title:COPY.sprint.openTab(story),onclick:()=>ctx.openStory(story)},story),statusEl,card.createdAtMs?` · ${timeLabel(card.createdAtMs)}`:''),
  h('span',{class:'dest'},W.goesTo,' ',h('span',{class:'mono'},dest)));
 const alert=h('div',{class:'sp-alert-slot'});
 const spendDd=h('dd',{},ctx.spendText);
 let busy=false,answered=false;
 const update=next=>{statusEl.textContent=statusText(next.status);spendDd.textContent=next.spendText;};
 const view={root,update,answered:()=>answered};
 const send=(text,onDone)=>{
  if(busy)return;busy=true;alert.replaceChildren();
  ctx.reply(card.messageId,text).then(()=>{
   busy=false;answered=true;
   const doc=root.ownerDocument,had=root.contains(doc.activeElement)||doc.activeElement===doc.body;
   const done=h('div',{class:'sp-answered',role:'status',tabindex:'-1'},h('span',{class:'mark','aria-hidden':'true'},'✓'),
    h('span',{},h('b',{},W.replied(text)),h('span',{class:'sp-muted'},` · ${W.to} `),h('span',{class:'mono'},dest),h('span',{class:'sp-sub'},W.leaves)));
   root.replaceChildren(done);if(had)done.focus();
  },
  error=>{busy=false;alert.replaceChildren(h('div',{class:'sp-ia err',role:'alert'},h('span',{},h('b',{},W.failed),' ',W.failedWhy(errorText(error)))));if(onDone)onDone();});
 };
 const body=plainText(card.text);
 const unsureNote=()=>h('div',{class:'sp-unsure sp-sub'},W.unsure);
 if(!merge){
  const titleId=card.summary?null:`sp-q-${card.messageId}`;
  root.append(...[head,card.summary?h('div',{class:'q',id:`sp-q-${card.messageId}`},card.summary):null,h('pre',{class:'sp-body-t',id:titleId},body)].filter(Boolean));
  if(unsure){root.append(unsureNote());return view;}
  const input=h('textarea',{class:'sp-fi',rows:'2','aria-label':W.answerLabel,placeholder:W.answerPlaceholder,'data-focus':`answer:${card.messageId}`});
  const sendBtn=h('button',{type:'button',class:'btn sm',onclick:()=>{const text=input.value.trim();if(text)send(text);}},W.send);
  input.addEventListener('keydown',event=>{if(isSendKey(event)){event.preventDefault();sendBtn.click();}});
  root.append(h('div',{class:'sp-free'},input,sendBtn),alert);
  return view;
 }
 const state=prState(merge,ctx.spend),label=`PR #${merge.number}`;
 const prLink=h('a',{href:merge.url,target:'_blank',rel:'noopener noreferrer',title:merge.url},`${label} ↗`);
 const title=h('div',{class:'q',id:`sp-q-${card.messageId}`},state.merged?W.mergedTitle:W.mergeTitle,' ',prLink);
 const prRow=state.merged?h('span',{class:'bdg ok','data-pr':'merged'},W.prMerged(label,timeLabel(state.at)))
  :h('span',{class:'bdg quiet','data-pr':state.known?'open':'unknown'},state.known?W.prOpen(label):W.prUnknown(label));
 const facts=h('dl',{},h('dt',{},W.pr),h('dd',{},prRow),h('dt',{},W.spend),spendDd);
 root.append(head,title,h('pre',{class:'sp-body-t','aria-label':W.bodyLabel},body),facts);
 if(unsure){root.append(unsureNote());return view;}
 const what=h('div',{class:'what'},state.merged?W.whatMerged(dest):[h('b',{},W.mergeFirst(label)),' ',W.approveTurns]);
 const approve=h('button',{type:'button',class:state.merged?'btn sm primary':'btn sm','aria-expanded':'false','data-act':'approve'},state.merged?W.approveMerged:W.approveOpen);
 const back=h('button',{type:'button',class:'btn sm','aria-expanded':'false','data-act':'send-back'},W.sendBack);
 const opts=h('div',{class:'sp-opts'},approve,back);
 const confirmSlot=h('div',{});
 function confirmBox(opener,parts,{onOk,okLabel,okPrimary,reason}){
  const close=()=>{confirmSlot.replaceChildren();opener.setAttribute('aria-expanded','false');opts.hidden=false;opener.focus();};
  const cancel=h('button',{type:'button',class:'btn sm','data-act':'cancel'},W.cancel);
  const ok=h('button',{type:'button',class:okPrimary?'btn sm primary':'btn sm','data-act':'ok'},okLabel);
  const box=h('div',{class:'sp-confirm',role:'group','aria-label':parts.label},...parts.body,reason?reason.label:null,h('div',{class:'r1'},h('span',{class:'r3'},parts.hint),h('span',{class:'sp-btns'},ok,cancel)));
  cancel.addEventListener('click',close);
  ok.addEventListener('click',()=>onOk(close));
  box.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}else if(isSendKey(event)){event.preventDefault();ok.click();}});
  opts.hidden=true;opener.setAttribute('aria-expanded','true');confirmSlot.replaceChildren(box);cancel.focus();
 }
 const stateLine=state.merged?W.prMerged(label,timeLabel(state.at)):state.known?W.stillOpen(label):W.stillUnknown(label);
 approve.addEventListener('click',()=>confirmBox(approve,{label:W.confirmMerge(dest),body:[h('div',{class:'r1'},h('span',{},h('b',{},W.confirmMerge(dest)),' ',stateLine))],hint:W.confirmHint},
  {okLabel:state.merged?W.approve:W.replyMergeAnyway,okPrimary:state.merged,onOk:()=>send(replyText.merge)}));
 back.addEventListener('click',()=>{
  const area=h('textarea',{class:'sp-reason-t','aria-required':'true','data-focus':`reason:${card.messageId}`});
  const error=h('span',{class:'sp-reason-e',role:'alert'});
  const reasonLabel=h('label',{class:'sp-reason'},W.reasonLabel,area,error);
  confirmBox(back,{label:W.sendBackTo(label,dest),body:[h('div',{class:'r1'},h('b',{},W.sendBackTo(label,dest)))],hint:W.sendBackHint},
   {okLabel:W.sendBackOk,okPrimary:true,reason:{label:reasonLabel},onOk:()=>{const reason=area.value.trim();if(!reason){error.textContent=W.reasonRequired;area.setAttribute('aria-invalid','true');area.focus();return;}send(replyText.sendBack(reason));}});
 });
 root.append(what,opts,confirmSlot,alert);
 return view;
}
function mountWaiting(el,{openStory,reply,retry}){
 const count=h('span',{class:'sp-s',id:'sp-waiting-count'});
 const list=h('div',{class:'sp-wcards',id:'sp-wcards'});
 const heading=h('h2',{id:'sp-h-wait',tabindex:'-1'},W.h);
 el.replaceChildren(h('div',{class:'sp-sec-h'},heading,count,h('span',{class:'sp-s'},W.sub)),list);
 function swap(nodes){
  const doc=el.ownerDocument,active=doc.activeElement,had=Boolean(active&&list.contains(active));
  const at=had?[...list.querySelectorAll('[data-card]')].findIndex(node=>node.contains(active)):-1;
  list.replaceChildren(...nodes);
  if(!had||list.contains(doc.activeElement))return;
  if(list.contains(active)){active.focus({preventScroll:true});return;}
  const cards=list.querySelectorAll('[data-card]'),next=cards[Math.min(Math.max(at,0),cards.length-1)];
  const target=next?next.querySelector('button:not([disabled]),textarea,a[href]')||next.querySelector('.sp-answered[tabindex]'):list.querySelector('button:not([disabled])');
  (target||heading).focus();
 }
 let views=new Map();
 const moreNote=h('div',{class:'sp-es'},W.more);
 return {
  paint({items,hasMore,limit,error,spendOf,spendTextOf,statusOf}){
   if(error){
    count.textContent='';views=new Map();
    swap([h('div',{class:'sp-ia err',role:'alert'},h('span',{class:'g','aria-hidden':'true'},'▲'),h('span',{},h('b',{},W.readFailed),' ',W.readFailedWhy(errorText(error))),
     h('button',{type:'button',class:'btn sm',onclick:retry},COPY.sprint.stories.retry))]);
    return;
   }
   count.textContent=hasMore?W.countMore(limit):items.length?W.count(String(items.length)):'';
   const more=hasMore?[moreNote]:[];
   if(!items.length){views=new Map();swap(more.length?more:[h('div',{class:'sp-es',id:'sp-nothing'},W.nothing)]);return;}
   const byId=new Map([...views.values()].map(view=>[view.id,view]));
   const next=new Map();
   for(const item of items){
    const spend=spendOf(item.story),ctx={spend,spendText:spendTextOf(item.story),status:statusOf(item.story),openStory,reply};
    const key=`${item.card.messageId}:${item.unsure?'unsure':''}:${item.merge?JSON.stringify(prState(item.merge,spend)):''}`;
    const old=byId.get(item.card.messageId);
    const view=old&&(old.key===key||old.view.answered())?old:{id:item.card.messageId,key,view:cardView(item,ctx)};
    view.view.update(ctx);next.set(item.card.messageId,view);
   }
   views=next;
   const nodes=[...[...next.values()].map(view=>view.view.root),...more];
   if(nodes.length!==list.children.length||nodes.some((node,i)=>list.children[i]!==node))swap(nodes);
  },
 };
}

const CH=COPY.sprint.chat;
const runsAgent=(row,agent)=>typeof row.agent==='string'&&(row.agent===agent||row.agent.endsWith(`/${agent}`));
const sprintLeadOf=(sessions,config)=>newestOf(sessions,row=>runsAgent(row,config.sprint.agent));
const chatTo=(lead,config)=>lead?lead.handle:`#${config.sprint.queue}`;
const launchArgs=(config,sprint)=>({task:`${config.sprint.launch} ${sprint}`,team:config.team});
const focusArgs=lead=>({agentId:lead.sessionId||lead.handle});
function mountSprintChat(el,controls,{config,sprint,act,loadThread}){
 let lead=null,rows=[],sending=false;
 const to=h('div',{class:'sp-to',id:'sp-chat-to'});
 const notice=h('div',{class:'sp-chat-n'});
 const log=h('div',{class:'sp-thread',id:'sp-thread',role:'log','aria-live':'polite','aria-label':CH.logLabel,tabindex:'0'});
 const input=h('textarea',{id:'sp-chat-input',rows:'3','aria-label':CH.inputLabel,'aria-describedby':'sp-chat-hint'});
 const hint=h('span',{id:'sp-chat-hint'});
 const send=h('button',{type:'button',class:'btn primary',id:'sp-chat-send'});
 const alert=h('div',{class:'sp-alert-slot',id:'sp-chat-alert'});
 el.replaceChildren(h('div',{class:'sp-ch-h'},h('h2',{class:'sp-ch-t'},CH.h),to),notice,log,h('div',{class:'sp-comp'},alert,input,h('div',{class:'sp-send'},hint,send)));
 const fail=(what,error)=>alert.replaceChildren(h('div',{class:'sp-ia err',role:'alert','data-fail':what},h('span',{},h('b',{},CH.actFailed[what]),' ',errorText(error))));
 const launch=()=>act('openLauncher',launchArgs(config,sprint)).catch(error=>fail('launch',error));
 const focus=()=>{if(lead)act('gotoAgent',focusArgs(lead)).catch(error=>fail('focus',error));};
 function paintControls(){
  const word=lead?(lead.state==='running'?CH.live:lead.state==='idle'?CH.idle:lead.state==='needs-you'?CH.needs:CH.unknown):CH.off;
  controls.replaceChildren(h('span',{class:'sp-muted'},CH.who),h('span',{class:`sp-dot ${lead?'live':'off'}`,id:'sp-lead-state'},word),
   lead?h('button',{type:'button',class:'btn sm',id:'sp-focus',onclick:focus},CH.focus):h('button',{type:'button',class:'btn sm primary',id:'sp-launch',onclick:launch},CH.launch));
  to.replaceChildren(h('span',{class:'k'},CH.to),lead?h('span',{class:'v'},`${CH.lead} · `,h('span',{class:'mono'},lead.handle)):h('span',{class:'v'},`${CH.next} · `,h('span',{class:'mono'},chatTo(null,config)),` ${CH.queue}`));
  notice.replaceChildren(...(lead?[]:[h('div',{class:'sp-ia info',role:'status'},h('span',{},h('b',{},CH.noLead),' ',CH.waits(config.sprint.queue)),h('button',{type:'button',class:'btn sm',id:'sp-launch-chat',onclick:launch},CH.launch))]));
  input.placeholder=lead?CH.placeholder:CH.placeholderQueue;
  hint.textContent=lead?CH.hint:CH.hintQueue;
  send.textContent=lead?CH.send:CH.queueSend;
 }
 function paintThread(){
  const ordered=mergeThread(rows);
  log.replaceChildren(...(ordered.length?ordered.map(row=>{
   const mine=row.from==='human';
   return h('div',{class:mine?'sp-msg me':'sp-msg','data-message':String(row.messageId)},
    h('div',{class:'m'},h('b',{},mine?COPY.who.you:lead&&row.from===lead.handle?`${CH.lead} · ${lead.handle}`:row.fromName||row.from||''),row.createdAtMs?` ${timeLabel(row.createdAtMs)}`:''),h('div',{class:'txt'},row.summary&&!mine?row.summary:row.text||''));
  }):[h('div',{class:'sp-muted sp-empty'},CH.empty)]));
  log.scrollTop=log.scrollHeight;
 }
 let reading=0;
 const refresh=()=>{const mine=++reading;return loadThread(lead).then(next=>{if(mine!==reading)return;rows=next;paintThread();if(alert.querySelector('[data-fail=thread]'))alert.replaceChildren();},error=>{if(mine===reading)fail('thread',error);});};
 function submit(){
  const text=input.value.trim();
  if(!text||sending)return;
  sending=true;send.disabled=true;alert.replaceChildren();
  act('sendAsHuman',{to:chatTo(lead,config),text}).then(()=>{sending=false;send.disabled=false;if(input.value.trim()===text)input.value='';return refresh();},
   error=>{sending=false;send.disabled=false;alert.replaceChildren(h('div',{class:'sp-ia err',role:'alert'},h('span',{},h('b',{},CH.failed),' ',CH.failedWhy(errorText(error)))));});
 }
 send.addEventListener('click',submit);
 input.addEventListener('keydown',event=>{if(isSendKey(event)){event.preventDefault();submit();}});
 paintControls();paintThread();
 return {
  setSessions(sessions,read=true){const next=sprintLeadOf(sessions,config),moved=(next&&next.handle)!==(lead&&lead.handle);lead=next;paintControls();return read&&moved?refresh():Promise.resolve();},
  refresh,
  lead:()=>lead,
 };
}

const SP=COPY.sprint;
function latestOnly(start){let generation=0;return ()=>{const mine=++generation;return start(()=>mine===generation);};}
function mountSprint(root,{cs,reads,config,sprint,win=globalThis}){
 const bridge=createSprintBridge(cs,{config,sprint});
 const S={rows:null,queryError:null,totals:null,sessions:[],needs:[],needsMore:false,needsError:null,answers:{rows:[],hasMore:false},byStory:new Map(),cards:[],progress:new Map(),openGroups:new Set()};
 const count=h('span',{class:'sp-muted',id:'sp-count'});
 const storiesSub=h('span',{class:'sp-s',id:'sp-stories-sub'},SP.stories.sub);
 const table=h('div',{id:'sp-table'},h('div',{class:'sp-ia info',role:'status'},SP.loading));
 const tnote=h('div',{class:'sp-tnote',id:'sp-tnote'});
 const stories=h('section',{id:'sp-stories','aria-labelledby':'sp-h-st'},h('div',{class:'sp-sec-h'},h('h2',{id:'sp-h-st'},SP.stories.h),storiesSub),table,tnote);
 const waitingEl=h('section',{id:'sp-waiting','aria-labelledby':'sp-h-wait'});
 const body=h('main',{class:'sp-body',id:'sp-body'},waitingEl,stories);
 const leadControls=h('div',{class:'sp-hd-r',id:'sp-lead'});
 const chatToggle=h('button',{type:'button',class:'btn sm sp-chatbtn',id:'sp-chat-toggle','aria-expanded':'false','aria-controls':'sp-chat'},SP.chat.show);
 const navWaiting=h('span',{class:'sp-n',id:'sp-nav-waiting'}),navStories=h('span',{class:'sp-n',id:'sp-nav-stories'});
 const linkWaiting=h('a',{href:'#sp-waiting'},SP.waiting.h,navWaiting),linkStories=h('a',{href:'#sp-stories'},SP.stories.h,navStories);
 const setNavCount=(link,el,label,text)=>{el.textContent=text;link.setAttribute('aria-label',text?`${label}, ${text}`:label);};
 const nav=h('nav',{class:'sp-lt','aria-label':SP.nav},linkWaiting,linkStories,chatToggle);
 const waitingFact=h('a',{href:'#sp-waiting',id:'sp-fact-waiting'},SP.dash),waitingKinds=h('span',{class:'sp-muted',id:'sp-fact-kinds'});
 const spendFact=h('b',{id:'sp-fact-spend',title:SP.strip.spendTitle},SP.loading);
 const facts=h('div',{class:'sp-facts',id:'sp-facts'},h('span',{class:'sp-fx'},h('span',{class:'k'},SP.strip.waiting),waitingFact,waitingKinds),h('span',{class:'sp-fx'},h('span',{class:'k'},SP.strip.spend),spendFact));
 const head=h('header',{id:'sp-head',class:'sp-hd'},h('div',{class:'sp-hd-1'},h('h1',{id:'sp-title'},SP.title(sprint)),count,leadControls),facts,nav);
 const chatEl=h('aside',{class:'sp-chat',id:'sp-chat','aria-label':SP.chat.regionLabel});
 const app=h('div',{class:'sp-app',id:'sp-app'},h('div',{class:'sp-main'},head,body),chatEl);
 chatToggle.addEventListener('click',()=>{const open=app.toggleAttribute('data-chat-open');chatToggle.setAttribute('aria-expanded',String(open));chatToggle.textContent=open?SP.chat.hide:SP.chat.show;});
 root.replaceChildren(app);
 const chat=mountSprintChat(chatEl,leadControls,{config,sprint,act:bridge.act,loadThread:bridge.thread});
 const rowViews=new Map(),progressReader=createProgressReader({read:bridge.read});
 const progressOf=id=>S.progress.get(id)||{read:'loading'};
 const setProgress=(id,value)=>{S.progress.set(id,value);const view=rowViews.get(id);if(view)view.setProgress(progressModel(value));};
 const fillProgress=()=>progressReader.run(S.rows||[],setProgress);
 const needsMap=()=>{const out=new Map();for(const card of S.cards)if(card.story)out.set(card.story,(out.get(card.story)||0)+1);return out;};
 const mergeSet=()=>new Set(S.cards.filter(card=>card.merge).map(card=>card.story));
 function keepFocus(paint){
  const active=win.document.activeElement,key=active&&root.contains(active)?active.getAttribute('data-focus'):null;
  paint();
  if(key){const next=root.querySelector(`[data-focus="${CSS.escape(key)}"]`);if(next)next.focus();}
 }
 function renderStories(){
  rowViews.clear();
  if(S.queryError){
   table.replaceChildren(h('div',{class:'sp-ia',role:'alert'},h('span',{class:'g','aria-hidden':'true'},'▲'),h('span',{},h('b',{},SP.stories.failed),' ',SP.stories.failedWhy(errorText(S.queryError))),
    h('button',{type:'button',class:'btn sm',onclick:retryStories},SP.stories.retry)));
   count.textContent='';setNavCount(linkStories,navStories,SP.stories.h,'');return;
  }
  const rows=S.rows||[];
  count.textContent=SP.count(rows.length);setNavCount(linkStories,navStories,SP.stories.h,String(rows.length));
  storiesSub.textContent=`${SP.count(rows.length)} · ${SP.stories.sub}`;
  tnote.textContent=`${SP.stories.note} ${showRank(rows)?'':SP.stories.rankNote}`.trim();
  if(!rows.length){table.replaceChildren(h('div',{class:'sp-es'},SP.stories.empty(sprint)));return;}
  const needs=needsMap(),merges=mergeSet(),rank=showRank(rows),fold=foldRows(sortRows(rows,needs),needs);
  const open=path=>bridge.openFile(path);
  const ctx=row=>({config,needs:needs.get(row.id)||0,merge:merges.has(row.id),lead:leadOf(S.sessions,row.id,config),spend:spendOf(S.totals,row.id),progress:progressModel(progressOf(row.id)),rank,open});
  const cols=[rank?['rank',SP.col.rank]:null,['story',SP.col.story],['stage',SP.col.stage],['lead',SP.col.lead],['progress',SP.col.progress],['blockers',SP.col.blockers],['spend',SP.col.spend]].filter(Boolean);
  const colspan=cols.length;
  const tbody=h('tbody',{});
  for(const row of fold.rows){const view=storyRow(row,ctx(row));rowViews.set(row.id,view);tbody.append(view.tr);}
  for(const status of ['planning','done']){
   const group=fold[status];if(!group.length)continue;
   const tr=groupRow(status,group,{colspan,sum:sumText(sumSpend(S.totals,group.map(row=>row.id))),spendOf:id=>spendOf(S.totals,id),open});
   const details=tr.querySelector('details');details.open=S.openGroups.has(status);
   details.addEventListener('toggle',()=>{if(details.open)S.openGroups.add(status);else S.openGroups.delete(status);});
   tbody.append(tr);
  }
  table.replaceChildren(h('table',{class:'sp-t sp-stories',id:'sp-stories-table'},
   h('colgroup',{},cols.map(([key])=>h('col',{'data-col':key}))),
   h('thead',{},h('tr',{},cols.map(([key,label])=>h('th',{scope:'col','data-col':key},label)))),tbody));
 }
 const storyOf=id=>(S.rows||[]).find(row=>row.id===id)||null;
 const openStory=id=>{const row=storyOf(id);if(row)bridge.openFile(row.open);};
 const waiting=mountWaiting(waitingEl,{openStory,reply:(messageId,text)=>bridge.act('replyAsHuman',{messageId,text}),retry:refreshNeeds});
 const storySpendText=id=>{
  const spend=spendOf(S.totals,id),row=storyOf(id);
  if(!spend.known)return spend.why==='pending'?`${SP.dash} ${SP.computing}`:SP.dash;
  const pp=perPoint(spend,row&&row.points);
  return [amountText(spend),row&&row.points?SP.points(row.points):null,pp!==null?SP.perPoint(usdText(pp),spend.running):null].filter(Boolean).join(' · ');
 };
 const computeCards=()=>{S.cards=S.needsError?[]:waitingCards(S.needs,S.answers,(S.rows||[]).map(row=>row.id),config,S.byStory);};
 const renderWaiting=()=>waiting.paint({items:S.cards,hasMore:S.needsMore,limit:config.limits.needsYou,error:S.needsError,spendOf:id=>spendOf(S.totals,id),spendTextOf:storySpendText,statusOf:id=>{const row=storyOf(id);return row?row.status:'';}});
 function renderStrip(){
  const merges=S.cards.filter(card=>card.merge).length;
  waitingFact.textContent=S.needsError?SP.dash:S.needsMore?SP.waiting.countMore(config.limits.needsYou):String(S.cards.length);
  setNavCount(linkWaiting,navWaiting,SP.waiting.h,S.needsError?SP.dash:countText(S.cards.length,S.needsMore,config.limits.needsYou));
  waitingKinds.textContent=S.needsError?'':SP.strip.cards(merges,S.cards.length-merges);
  spendFact.textContent=S.queryError?SP.dash:sumText(sumSpend(S.totals,(S.rows||[]).map(row=>row.id)));
 }
 const render=()=>keepFocus(()=>{computeCards();renderStrip();renderWaiting();renderStories();});
 const loadRows=latestOnly(current=>bridge.query().then(answer=>{if(current()){S.rows=storyRows(answer,sprint);S.queryError=null;}},error=>{if(current()){S.queryError=error;S.rows=null;}}));
 const loadTotals=latestOnly(current=>{const ids=(S.rows||[]).map(row=>row.id);return ids.length?bridge.totals(ids).then(answer=>{if(current())S.totals=answer;},()=>{if(current())S.totals=null;}).then(watchPending):Promise.resolve();});
 let unwatch=null,painted=false;
 function watchPending(){
  if(!painted)return;
  const pending=(S.rows||[]).some(row=>spendOf(S.totals,row.id).why==='pending');
  if(pending&&!unwatch)unwatch=bridge.watchTotals(()=>{loadTotals().then(render);});
  else if(!pending&&unwatch){unwatch();unwatch=null;}
 }
 function retryStories(){loadRows().then(loadTotals).then(()=>{render();fillProgress();});}
 function refreshNeeds(){loadNeeds().then(()=>{render();settleUnsure();});}
 const loadNeeds=latestOnly(current=>Promise.all([bridge.needs(),bridge.answers()]).then(([needs,answers])=>{if(current()){S.needs=needs.rows;S.needsMore=needs.hasMore;S.answers=answers;S.needsError=null;}},error=>{if(current())S.needsError=error;}));
 function settleUnsure(){
  const ids=[...unsureStories(S.cards,config)].filter(id=>!S.byStory.has(id));
  if(!ids.length)return Promise.resolve();
  return Promise.all(ids.map(id=>bridge.storyAnswers(id).then(page=>{S.byStory.set(id,page);},()=>{}))).then(render);
 }
 const loadSessions=()=>Promise.resolve().then(()=>reads.sessions()).then(rows=>{S.sessions=rows;chat.setSessions(rows,false);},()=>{S.sessions=[];});
 const first=Promise.all([loadRows(),loadSessions(),loadNeeds()]).then(()=>Promise.all([loadTotals(),chat.refresh()]));
 const ready=first.then(()=>null,error=>error).then(error=>{
  painted=true;
  reads.on('sessions',()=>{S.sessions=reads.latestSessions();chat.setSessions(S.sessions);render();});
  reads.on('context',retryStories);
  reads.on('activity',()=>{loadTotals().then(render);});
  reads.on('inbox',()=>{refreshNeeds();chat.refresh();});
  try{render();}catch(thrown){error=error||thrown;}
  if(error)body.prepend(h('div',{class:'sp-ia err',role:'alert'},errorText(error)));
  if(win.performance&&typeof win.performance.mark==='function')win.performance.mark('sprint-first-paint');
  watchPending();
  fillProgress();
  settleUnsure();
 });
 return {ready};
}

const UI_TOPIC='ui:foreman';
const runsAny=(row,ids)=>Boolean(row)&&typeof row.agent==='string'&&ids.some(id=>row.agent===id||row.agent.endsWith(`/${id}`));
const foremanRows=(rows,config)=>(Array.isArray(rows)?rows:[]).filter(row=>runsAny(row,config.foreman.agents));
const liveForeman=(rows,config)=>newestOf(rows,row=>runsAny(row,config.foreman.agents));
const usableForeman=joinable;
const addSender=(list,handle,config)=>handle?[handle,...(Array.isArray(list)?list:[]).filter(item=>item!==handle)].slice(0,config.foreman.senders):(Array.isArray(list)?list.slice(0,config.foreman.senders):[]);
const sendersOf=state=>{const value=Array.isArray(state)?state[0]:state;return value&&Array.isArray(value.senders)?value.senders.filter(item=>typeof item==='string'&&item):[];};
const isHostedSetup=(row,config,senders)=>runsAny(row,config.foreman.guides)&&typeof row.launchedBy==='string'&&senders.includes(row.launchedBy);
const runtimeList=runtimes=>Array.isArray(runtimes)?runtimes:Array.isArray(runtimes&&runtimes.runtimes)?runtimes.runtimes:null;
const pick=(runtimes,config)=>{
 const list=runtimeList(runtimes)||[];
 const installed=list.some(item=>item&&(item.id||item.name||item.runtime)===config.foreman.runtime&&item.installed!==false);
 return installed?config.foreman.agents[0]:null;
};

const timersOf=config=>[
 {name:'launch-slow',ms:config.timers.slowMs},
 {name:'launch-fail',ms:config.timers.failMs},
 {name:'event-debounce',ms:config.timers.debounceMs},
];

function homeOf(setup,config){
 const docs={org:config.foreman.docs.org,team:config.foreman.docs.team};
 const teams=Array.isArray(setup&&setup.teams)?setup.teams:[];
 const found=teams.find(item=>item&&item.org&&(item.name||item.team)&&item.org!==docs.org&&!item.archived&&item.launchable!==false);
 return found?{org:found.org,team:found.name||found.team}:docs;
}
const isMissingWorktree=result=>Boolean(result)&&result.status==='invalid'&&/no worktree named/i.test(String(result.message||''));
const isAlreadyRunning=result=>Boolean(result)&&result.status==='invalid'&&/is already running in/i.test(String(result.message||''));
async function launchForeman({act,config,home,agent,prompt,sessions=async()=>[]}){
 if(!agent)throw new Error(`unavailable: ${FOREMAN_COPY.chat.noRuntime}`);
 const call=create=>act('openWorkspace',{target:{kind:'team-workspace',org:home.org,team:home.team,name:config.foreman.name,worktree:config.foreman.worktree,...(create?{createWorktree:true}:{})},agent,role:config.foreman.role,initialPrompt:prompt});
 let result=await call(false);
 if(isMissingWorktree(result)){
  result=await call(true);
  if(isAlreadyRunning(result)){
   const rows=foremanRows(await sessions().catch(()=>[]),config).filter(row=>usableForeman(row)&&row.team&&row.team.org===home.org&&row.team.team===home.team);
   const named=row=>Boolean(row.handle)&&new RegExp(`(^|[^\\w/-])${row.handle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^\\w/-]|$)`).test(String(result.message));
   const live=rows.find(named)||liveForeman(rows,config);
   if(live)return {handle:live.handle,promptDelivered:false};
  }
 }
 const status=result&&result.status;
 if(status==='opened')return {handle:result.handle,promptDelivered:true};
 if(status==='alreadyLive')return {handle:result.handle,promptDelivered:false};
 if(status==='busy')throw new Error('busy');
 throw new Error(`refused: ${(result&&result.message)||'the launch was refused'}`);
}
const promptFor=(text,handoff,copy=FOREMAN_COPY)=>`${handoff?`${handoff}\n\n`:''}${copy.prompt}\n\n${text}`;
function handoffOf({thread,rows,senders,copy=FOREMAN_COPY}){
 const handle=senders[0];
 if(!handle||!(Array.isArray(rows)?rows:[]).some(row=>row.handle===handle&&row.state==='exited'))return null;
 const last=(Array.isArray(thread)?thread:[]).filter(row=>row.from===handle).sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)).pop();
 return last&&typeof last.text==='string'&&last.text.startsWith(copy.handoffNote)?last.text:null;
}

function createForemanBridge(cs,{config}){
 let writes=0;
 const act=(verb,args)=>typeof cs.act==='function'?cs.act(verb,args):cs.invoke(verb,args);
 const optional=name=>typeof cs[name]==='function'?cs[name].bind(cs):null;
 return {
  act,
  transport:(launch,onSent=()=>{})=>({
   launch,
   send:(handle,text)=>act('sendAsHuman',{to:handle,text}).then(result=>{if(!result||result.status===undefined||result.status==='sent')onSent(handle);return result;}),
   gotoAgent:sessionId=>act('gotoAgent',{agentId:sessionId}),
   stream:typeof cs.onChunk==='function'?listener=>cs.onChunk(listener):null,
   threadOf:handle=>cs.inbox({sessionId:handle}).then(rowsOf),
   roleThread:()=>Promise.resolve([]),
  }),
  readSenders(onChange=()=>{}){const subscribe=optional('subscribe');return subscribe?Promise.resolve(subscribe(UI_TOPIC,{onChange:answer=>onChange(sendersOf(answer&&answer.snapshot))})).then(answer=>sendersOf(answer&&answer.snapshot),()=>[]):Promise.resolve([]);},
  writeSenders(senders){
   const set=optional('setUiState');if(!set)return Promise.resolve(true);
   const n=++writes,write=()=>Promise.resolve().then(()=>set(UI_TOPIC,{senders})),latest=()=>n===writes;
   return write().catch(()=>latest()?write():undefined).then(()=>latest()?true:undefined,()=>latest()?false:undefined);
  },
  humanStatus(){const read=optional('humanStatus');return read?Promise.resolve(read()).catch(()=>null):Promise.resolve(null);},
  setupState(){const read=optional('setupState');return read?Promise.resolve(read()):Promise.reject(new Error('unavailable'));},
  runtimes(){return cs.kit&&typeof cs.kit.runtimes==='function'?Promise.resolve(cs.kit.runtimes()):Promise.reject(new Error('unavailable'));},
  gotoAgent:agentId=>act('gotoAgent',{agentId}),
  sessions(){return typeof cs.sessions==='function'?Promise.resolve(cs.sessions()).then(sessionRows):Promise.reject(new Error('unavailable'));},
 };
}

const WELCOME=FOREMAN_COPY.welcome;
const partOfDay=hour=>hour<12?WELCOME.morning:hour<18?WELCOME.afternoon:WELCOME.evening;
const greetingOf=(date,name)=>WELCOME.greeting(partOfDay(date.getHours()),typeof name==='string'&&name.trim()?name.trim():'');
const statusLineOf=(waiting,working)=>WELCOME.status(Number.isInteger(waiting)?String(waiting):WELCOME.dash,Number.isInteger(working)?String(working):WELCOME.dash);
const workingCount=(rows,isOwn=()=>false)=>Array.isArray(rows)?rows.filter(row=>row&&row.state==='running'&&!isOwn(row)).length:null;
function mountWelcome(el,{onStarter}){
 const greeting=h('h2',{class:'fm-greeting',id:'fm-greeting'}),line=h('p',{class:'fm-status',id:'fm-status-line'});
 const lock=on=>{for(const button of buttons)button.disabled=on;};
 const buttons=WELCOME.starters.map(text=>h('button',{type:'button',class:'btn','data-starter':text,onclick:()=>{lock(true);if(!onStarter(text))lock(false);}},text));
 const starters=h('ul',{class:'fm-starters',id:'fm-starters','aria-label':WELCOME.startersLabel},buttons.map(button=>h('li',{},button)));
 el.replaceChildren(greeting,line,starters);
 return {
  paint({now,name,waiting,working}){greeting.textContent=greetingOf(new Date(now),name);line.textContent=statusLineOf(waiting,working);},
  show(visible){if(visible&&el.hidden)lock(false);el.hidden=!visible;},
 };
}

const unique=list=>[...new Set(list)];
function mountForeman(root,{cs,reads,config,win=globalThis}){
 const bridge=createForemanBridge(cs,{config});
 const copy=FOREMAN_COPY;
 const S={senders:[],setup:null,needs:null,name:null,roster:null};
 const welcomeEl=h('section',{class:'fm-welcome',id:'fm-welcome','aria-label':copy.title,hidden:''}),chatEl=h('div',{id:'fm-chat',class:'fm-chat'});
 const state=h('span',{class:'fm-state',id:'fm-state'});
 const head=h('header',{id:'fm-head',class:'fm-hd'},h('h1',{id:'fm-title'},copy.title),state);
 root.replaceChildren(h('div',{class:'fm-app',id:'fm-app'},head,h('main',{id:'fm-body',class:'fm-body'},welcomeEl,chatEl)));
 const welcome=mountWelcome(welcomeEl,{onStarter:text=>Boolean(chat&&chat.post(text))});
 let chat=null;
 const readSetup=()=>bridge.setupState().then(answer=>{S.setup=answer&&typeof answer==='object'?answer:null;},()=>{S.setup=null;});
 let setupRead=readSetup(),setupStale=false;
 const needsRead=()=>reads.needsYou().then(rows=>{S.needs=rows.length;},()=>{S.needs=null;});
 const paint=()=>{
  const rows=S.roster==='ok'?reads.latestSessions():null,own=new Set(foremanRows(rows,config));
  welcome.paint({now:win.Date.now(),name:S.name,waiting:S.needs,working:workingCount(rows,row=>own.has(row))});
  if(!chat)return;
  const empty=chat.thread().length===0&&chat.launch.messages.length===0;
  const unread=chat.threadFailed();
  welcome.show(Boolean(S.roster)&&chat.threadSettled()&&!unread&&empty);
  const p=chat.presence();
  state.textContent=p.header;state.setAttribute('data-face',p.face);
 };
 const windowOf=list=>list.slice(0,config.foreman.history).sort().join('\n');
 const setSenders=list=>{const before=windowOf(S.senders);S.senders=list;if(chat&&windowOf(list)!==before)chat.refresh(true);};
 let joined=null,unsaved=false;
 const prepend=(handle,force=false)=>{
  if(!handle||(handle===joined&&!force))return;
  joined=handle;
  if(S.senders[0]===handle&&!unsaved)return;
  setSenders(addSender(S.senders,handle,config));
  bridge.writeSenders(S.senders).then(saved=>{if(saved!==undefined)unsaved=!saved;});
 };
 const launch=async prompt=>{
  if(setupStale){setupStale=false;setupRead=readSetup();}
  await setupRead;
  if(!S.setup){setupStale=true;throw new Error(`refused: ${copy.chat.noTeams}`);}
  const runtimes=await bridge.runtimes().catch(()=>null);
  if(!runtimeList(runtimes))throw new Error(`refused: ${copy.chat.noRuntimeRead}`);
  const agent=pick(runtimes,config);
  const result=await launchForeman({act:bridge.act,config,home:homeOf(S.setup,config),agent,prompt,sessions:()=>bridge.sessions().catch(()=>reads.latestSessions())});
  prepend(result.handle,true);
  return result;
 };
 const usableOf=rows=>liveForeman(rows.filter(usableForeman),config);
 const subject={
  copy,
  rowsOf:rows=>foremanRows(rows,config),
  live:usableOf,
  history:()=>S.senders,
  sources:rows=>unique([...S.senders.slice(0,config.foreman.history),...[liveForeman(rows,config),usableOf(rows)].filter(Boolean).map(row=>row.handle)]),
  card:text=>promptFor(text,handoffOf({thread:chat?chat.thread():[],rows:reads.latestSessions(),senders:S.senders,copy}),copy),
 };
 let pushed=false;
 const ready=Promise.all([bridge.readSenders(list=>{pushed=true;setSenders(list);}),bridge.humanStatus()]).then(([senders,status])=>{
  if(!pushed)setSenders(senders);S.name=status&&(status.name||status.displayName)||null;
  chat=mount(chatEl,{storyId:'',transport:bridge.transport(launch,prepend),reads,config,meta:{},win,subject});
  chat.subscribe(()=>{const row=chat.launch.state==='joined'&&chat.lead();if(row)prepend(row.handle);});
  chat.subscribe(paint);
  reads.on('sessions',()=>{S.roster='ok';paint();});
  reads.on('sessionsFailed',()=>{if(S.roster!=='ok')S.roster='failed';paint();});
  reads.on('inbox',()=>{needsRead().then(paint);});
  reads.sessions().then(()=>{if(S.roster!=='ok'){S.roster='ok';paint();}});
  return needsRead().then(paint);
 });
 paint();
 return {ready,chat:()=>chat,senders:()=>S.senders};
}

function ensureRoot(doc){
 if(!doc.getElementById('sv-style'))doc.head.append(h('style',{id:'sv-style'},STYLE));
 let root=doc.getElementById('story-view');
 if(!root){root=h('div',{id:'story-view'});doc.body.append(root);}
 root.className='sv-root';
 return root;
}
const note=text=>h('div',{class:'note-row',role:'status','data-note':'1'},text);
function offline(root,meta,storyId){
 if(Object.hasOwn(meta,FOREMAN_META)){root.replaceChildren(h('header',{id:'fm-head',class:'fm-hd'},h('h1',{id:'fm-title'},FOREMAN_COPY.title)),h('main',{id:'fm-body',class:'fm-body'},note(COPY.offline)));return;}
 if(Object.hasOwn(meta,SPRINT_META)){root.replaceChildren(h('header',{id:'sp-head',class:'sp-hd'},h('h1',{id:'sp-title'},COPY.sprint.title(meta[SPRINT_META]))),h('main',{id:'sp-body'},note(COPY.offline)));return;}
 root.replaceChildren(h('header',{id:'sv-head'}),h('main',{id:'sv-body'},note(COPY.offline)));
 mountHeader(root.querySelector('#sv-head'),{meta,config:CONFIG,reads:{openFile(){},needsYou:()=>Promise.reject(new Error('offline')),usage:()=>Promise.reject(new Error('offline')),queryStory:()=>Promise.reject(new Error('offline')),on:()=>()=>{}},chat:null,storyId});
}
async function run(cs,doc,win){
 const meta=readMeta(doc),storyId=storyIdOf(meta),root=ensureRoot(doc);
 const reads=createReads(cs,{config:CONFIG,storyId,win});
 const param=sessionParam(win.location.search);
 const variant=param?pickVariant({config:CONFIG,meta,param,rows:await reads.sessions()}):pickVariant({config:CONFIG,meta,param:null,rows:[]});
 if(variant.kind==='sprint'){mountSprint(root,{cs,reads,config:CONFIG,sprint:variant.sprint,win});return;}
 if(variant.kind==='foreman'){mountForeman(root,{cs,reads,config:CONFIG,win});return;}
 root.replaceChildren(h('header',{id:'sv-head'}),h('main',{id:'sv-body'}));
 const head=root.querySelector('#sv-head'),body=root.querySelector('#sv-body');
 if(variant.kind!=='story'){
  mountHeader(head,{meta,config:CONFIG,reads,chat:null,storyId});
  body.append(note(variant.text));
  return;
 }
 const chatEl=h('div',{id:'sv-chat'}),panelMount=h('aside',{id:'panel-mount',class:'panel-col',hidden:''});
 body.append(h('div',{class:'sv-split'},chatEl,panelMount));
 const chat=mount(chatEl,{storyId,transport:createTransport(cs,{config:CONFIG,storyId}),reads,config:CONFIG,meta,done:meta['cs:status']==='done',win});
 const header=mountHeader(head,{meta,config:CONFIG,reads,chat,storyId});
 const here=viewerPath(win.location.pathname);
 const atRoot=path=>here.root?`${here.root.replace(/\/$/,'')}/${path}`:path;
 const openContent=path=>reads.openFile(atRoot(path));
 const source=createSource(reads,storyMdPath(meta,win.location.pathname)||atRoot(here.rel)),trace=createSource(reads,atRoot(`design/${storyId}/qa/trace.md`));
 let panel=null;
 const ctx={reads,openContent,header,source,trace,chat,storyId,config:CONFIG,agents:()=>stripModel(reads.latestSessions(),{storyId,leadRole:CONFIG.lead.role}).pills};
 const back=sessionId=>{panel.hideDetail();strip.select(null);const node=strip.pillNode(sessionId);if(node)node.focus();};
 const strip=mountStrip(header.stripSlot,{reads,config:CONFIG,storyId,onPick:pill=>{if(panel.showDetail(parts=>mountDetail(parts,ctx,pill.sessionId,{onBack:()=>back(pill.sessionId)})))strip.select(pill.sessionId);},win});
 panel=mountPanel({column:panelMount,toggle:header.panelToggle,registry:buildRegistry(CONFIG,{story:mountStory,overview:mountOverview,tasks:mountTasks}),ctx,win});
}
function boot(win=window){
 const doc=win.document,meta=readMeta(doc),storyId=storyIdOf(meta),root=ensureRoot(doc);
 const go=()=>{const cs=bridgeOf(win);if(cs)run(cs,doc,win).catch(error=>{root.replaceChildren(note(String(error&&error.message||error)));});else offline(root,meta,storyId);};
 if(bridgeOf(win))go();
 else if(doc.readyState==='complete')go();
 else win.addEventListener('load',go,{once:true});
 win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>doc.documentElement.classList.add('sv-ready')));
}
boot();

})();
