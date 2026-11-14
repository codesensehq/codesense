// CodeSense setup page: the shared chat (kit.chat) in its page layout, plus the page's own header,
// empty state and sign-in notice. `scripts/guide-page.mjs` inlines this file into index.html, so the
// grant the app mints from that page's bytes covers every line of it.
(() => {
  'use strict';
  const cs = window.codesense;
  const kit = cs && cs.kit;
  const chatKit = kit && kit.chat;
  const $ = (id) => document.getElementById(id);

  // The guide runs in the bundled docs team; the person's own team is named by every write the agent makes.
  const DOCS = { org: 'codesense/docs', team: 'getting-started' };
  const WORKSPACE = { name: 'CodeSense setup', worktree: 'guide' };
  const AGENT = { claude: 'guide-claude', codex: 'guide-codex', opencode: 'guide-opencode' };
  const NAME = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', hermes: 'Hermes' };
  // No guide agent names a model: the page passes one per setup state, and OpenCode keeps its own default.
  const MODEL = {
    claude: { setup: 'claude-sonnet-5-5', after: 'claude-haiku-5-5' },
    codex: { setup: 'gpt-6.1-sol', after: 'gpt-6-luna' },
  };
  const MODEL_NAME = {
    'claude-sonnet-5-5': 'Sonnet 5.5',
    'claude-haiku-5-5': 'Haiku 5.5',
    'gpt-6.1-sol': 'gpt-6.1-sol',
    'gpt-6-luna': 'gpt-6-luna',
  };
  // Each CLI's own sign-in command: the page never signs anyone in, it only says what to run.
  const LOGIN = { claude: 'claude auth login', codex: 'codex login', opencode: 'opencode auth login' };
  const SKILL = { claude: '/codesense-setup', codex: '$codesense-setup', opencode: '/codesense-setup' };
  const INSTALL = [
    ['Install Claude Code', 'https://docs.claude.com/en/docs/claude-code/overview'],
    ['Install Codex', 'https://github.com/openai/codex'],
    ['Install OpenCode', 'https://opencode.ai'],
  ];
  const STORAGE_KEY = 'codesense-guide:runtime';
  const LOGIN_MS = 25000;
  const CHECK_MS = 750;
  const CHECK_TRIES = 20;
  const SETTLE_MS = 300;
  // How long a confirmed stop may take to show in the roster before the switch or clear gives up.
  const EXIT_MS = 20000;

  const COPY = {
    lead: 'CodeSense setup',
    header: {
      done: 'finished',
      none: 'not running yet',
      starting: 'starting…',
      idle: 'ready',
      needs: 'needs you in its terminal',
      unknown: 'status unknown · its machine may be offline',
      working: (activity) => (activity === COPY.header.activityNone ? 'working' : `working · ${activity}`),
      failed: (reason) => `couldn't start · ${reason}`,
      activityNone: 'activity not reported',
    },
    placeholder: {
      running: "It's working; your message waits for its next step",
      idle: 'Ask for something: set up my repos, create a story…',
      needs: "It's waiting on its terminal; your message waits",
      unknown: "Your message waits until it's reachable",
      none: 'Ask for something: set up my repos, create a story…',
      starting: 'Starting CodeSense setup; more messages wait for it',
      failed: 'Retry, or add to your kept message',
      done: 'This conversation is finished',
    },
    mark: { starting: 'Sent · starting setup', held: 'Held · sends when setup joins' },
    row: {
      starting: 'Starting CodeSense setup…',
      slow: 'Still starting (over 20 s)',
      joined: (model) => (model === COPY.row.modelNone ? 'CodeSense setup joined' : `CodeSense setup joined · ${model}`),
      modelNone: 'model not reported yet',
      typing: 'CodeSense setup is typing',
      needsTerminal: 'Needs you in its terminal',
    },
    failure: {
      busy: "Couldn't start CodeSense setup: CodeSense is at its agent limit. Try again in a moment.",
      denied: (why) => `Couldn't start CodeSense setup: launching was refused (${why}).`,
      unavailable: (why) => `Couldn't start CodeSense setup: no agent is available (${why}).`,
      timeout: "CodeSense setup didn't start in 2 minutes.",
      exited: 'CodeSense setup stopped right after it started.',
      other: (why) => `Couldn't start CodeSense setup: ${why}.`,
      reasonBusy: 'CodeSense is at its agent limit',
      reasonTimeout: 'no join in 2 minutes',
      reasonExited: 'it stopped right after starting',
    },
    composerLabel: 'Message CodeSense setup',
    logLabel: 'Conversation with the CodeSense setup agent',
    card: { replyLabel: 'Your answer to CodeSense setup' },
    unload: 'Messages you sent are still waiting for CodeSense setup.',
    chips: 'Suggested',
  };

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...kids.filter((kid) => kid !== null && kid !== undefined && kid !== false));
    return node;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rowsOf = (answer) =>
    Array.isArray(answer) ? answer : Array.isArray(answer && answer.rows) ? answer.rows : [];
  const whyOf = (error) =>
    String((error && error.message) || error || 'unavailable').replace(/^(denied|unavailable):\s*/, '');
  const remembered = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  };
  const remember = (id) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage may be refused in this frame; the pick only decides the next open */
    }
  };

  const S = {
    list: [],
    runtime: null,
    done: false,
    begun: false,
    chat: null,
    reads: null,
    loginTimer: null,
    pending: null,
    problem: null,
    busy: false,
    marked: new Set(),
  };

  // ---- alerts: keyed notices between the header and the chat ----
  const notices = new Map();
  const notice = (key, node) => {
    const old = notices.get(key);
    if (old) old.remove();
    if (!node) {
      notices.delete(key);
      return;
    }
    notices.set(key, node);
    $('alerts').append(node);
  };
  const flash = (text) => {
    notice('flash', el('div', { class: 'alert info', role: 'status' }, el('span', { class: 'g' }, '✓'), el('span', {}, text), el('span')));
    setTimeout(() => notice('flash', null), 3000);
  };
  const problem = (key, text, ...buttons) =>
    notice(key, el('div', { class: 'alert err', role: 'alert' }, el('span', { class: 'g' }, '!'), el('span', {}, text), el('span', { class: 'acts' }, ...buttons)));

  const copyText = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(`Copied ${what}.`);
    } catch {
      // No clipboard in this frame: show the text so the person can select it.
      notice(
        'copy',
        el(
          'div',
          { class: 'alert warn', role: 'status' },
          el('span', { class: 'g' }, '▲'),
          el('span', {}, "Couldn't copy it. Select it here:", el('pre', { class: 'copied' }, text)),
          el('button', { type: 'button', class: 'btn sm', onclick: () => notice('copy', null) }, 'Done'),
        ),
      );
    }
  };

  // ---- reads: the app's session roster, inbox and activity events, as kit.chat wants them ----
  function createReads() {
    const listeners = { sessions: new Set(), inbox: new Set(), activity: new Set() };
    const stops = [];
    const timers = new Map();
    const fire = (name) => {
      for (const listener of [...listeners[name]]) listener();
    };
    const later = (name) => {
      clearTimeout(timers.get(name));
      timers.set(
        name,
        setTimeout(() => fire(name), SETTLE_MS),
      );
    };
    let latest = [];
    let first = null;
    const onMessage = (event) => {
      const data = event && event.data;
      if (!event || event.source !== window.parent) return;
      if (data === 'codesense:agent-activity-changed' || (data && data.type === 'codesense:agent-activity-changed'))
        later('activity');
    };
    window.addEventListener('message', onMessage);
    stops.push(() => window.removeEventListener('message', onMessage));
    return {
      on(name, listener) {
        listeners[name].add(listener);
        if (name === 'inbox' && listeners.inbox.size === 1 && typeof cs.onInboxChanged === 'function')
          stops.push(cs.onInboxChanged(() => later('inbox')));
        return () => listeners[name].delete(listener);
      },
      sessions() {
        if (!first)
          first = new Promise((resolve) => {
            const off = cs.onSessions((list, error) => {
              if (error || !Array.isArray(list)) return;
              latest = list;
              resolve(latest);
              fire('sessions');
            });
            if (typeof off === 'function') stops.push(off);
          });
        return first;
      },
      latestSessions: () => latest,
      usage: (args) => cs.invoke('sessionUsage', args),
      poke: () => fire('activity'),
      dispose() {
        stops.forEach((stop) => stop && stop());
        timers.forEach((timer) => clearTimeout(timer));
      },
    };
  }

  // ---- who the guide is: the chosen runtime's guide sessions, newest live one first ----
  // Only the docs team's guide for the chosen runtime: another runtime's guide, or a team's own agent
  // that happens to share the name, is not this conversation.
  const isGuide = (row) => {
    const id = AGENT[S.runtime];
    return (
      Boolean(id) &&
      Boolean(row) &&
      (row.agent === id || row.agent === `${DOCS.org}/${DOCS.team}/${id}`)
    );
  };
  const joinable = (row) =>
    Boolean(row) && row.state !== 'exited' && row.effectiveStatus !== 'crashed' && row.needsYouKind !== 'startup';
  const newest = (rows) =>
    [...rows].sort((a, b) => (b.startedAtMs || b.createdAtMs || 0) - (a.startedAtMs || a.createdAtMs || 0))[0] || null;
  const guideTarget = () => ({
    rows: (sessions) => (Array.isArray(sessions) ? sessions : []).filter(isGuide),
    pick: (rows) => newest(rows.filter(joinable)),
    sources: (rows) => {
      const live = newest(rows.filter(joinable));
      return live && live.handle ? [live.handle] : [];
    },
    read: () => Promise.resolve([]),
    queue: null,
    follow: false,
    leadName: () => COPY.lead,
    bindLaunched: true,
    keepUnsent: true,
  });

  // ---- setup state: the model follows it ----
  async function readSetupDone() {
    const was = S.done;
    try {
      const state = await cs.invoke('setupState');
      const orgs = Array.isArray(state && state.orgs) ? state.orgs : [];
      // Any context repo beyond the docs means setup has begun: the next open is a resume.
      S.begun = orgs.some((org) => org.slug !== DOCS.org);
      S.done = orgs.some(
        (org) =>
          org.slug !== DOCS.org &&
          (org.teams || []).some((team) => !team.archived && (team.sourceRepos || []).length > 0),
      );
    } catch {
      // An unread state is treated as "still setting up": the stronger model.
      S.done = false;
      S.begun = false;
    }
    if (S.done !== was) paintChip();
    return S.done;
  }
  const modelFor = (runtime) => (MODEL[runtime] ? MODEL[runtime][S.done ? 'after' : 'setup'] : undefined);

  // ---- launch and the transport kit.chat sends through ----
  const promptFor = (text) => {
    const body = String(text || '').trim();
    // The app's "Set up CodeSense" reopen opens this page at #resume; a restored tab with setup progress resumes too.
    const resumed = (S.chat && S.chat.thread().length > 0) || window.location.hash === '#resume' || S.begun;
    return [SKILL[S.runtime], body || (resumed ? 'resume' : '')].filter(Boolean).join(' ');
  };
  async function openGuide(prompt) {
    await readSetupDone();
    const open = (create) =>
      cs.invoke('openWorkspace', {
        target: {
          kind: 'team-workspace',
          org: DOCS.org,
          team: DOCS.team,
          name: WORKSPACE.name,
          worktree: WORKSPACE.worktree,
          ...(create ? { createWorktree: true } : {}),
        },
        agent: AGENT[S.runtime],
        ...(modelFor(S.runtime) ? { model: modelFor(S.runtime) } : {}),
        initialPrompt: prompt,
      });
    let result = await open(false);
    if (result && result.status === 'invalid' && /no worktree named/i.test(String(result.message || '')))
      result = await open(true);
    const status = result && result.status;
    if (status === 'opened') return { handle: result.handle, promptDelivered: true };
    if (status === 'alreadyLive') return { handle: result.handle, promptDelivered: false };
    if (status === 'busy') throw new Error('busy');
    throw new Error(`refused: ${(result && result.message) || 'the launch was refused'}`);
  }
  const transport = {
    launch: async (prompt) => {
      armLogin();
      return openGuide(prompt);
    },
    send: (handle, text) => cs.invoke('sendAsHuman', { to: handle, text }),
    reply: (messageId, text) => cs.invoke('replyAsHuman', { messageId, text }),
    stop: (handle) => (typeof cs.act === 'function' ? cs.act('stopSession', { handle }) : cs.invoke('stopSession', { handle })),
    gotoAgent: (sessionId) => cs.invoke('gotoAgent', { agentId: sessionId }),
    // Streamed reply text is not a page member yet; replies arrive whole, from the inbox.
    stream: null,
    threadOf: (sessionId) => cs.inbox({ sessionId }).then(rowsOf),
    roleThread: () => Promise.resolve([]),
  };

  // ---- sign-in notice: no signed-out signal exists for Claude or OpenCode, so it is a generic one ----
  const leadSpoke = () => {
    const chat = S.chat;
    return Boolean(chat) && chat.thread().some((row) => chatKit.thread.sideOf(row, chat.leadHandles()) === 'lead');
  };
  function armLogin() {
    clearTimeout(S.loginTimer);
    S.loginTimer = setTimeout(() => {
      if (S.chat && !leadSpoke()) showLogin();
    }, LOGIN_MS);
  }
  function hideLogin() {
    clearTimeout(S.loginTimer);
    const shown = notices.has('login');
    notice('login', null);
    if (!shown) return;
    paintChip();
    if (S.reads) S.reads.poke();
  }
  function showLogin() {
    if (notices.has('login')) return;
    queueMicrotask(() => S.reads && S.reads.poke());
    const runtime = S.runtime;
    const command = LOGIN[runtime];
    const other = S.list.find((item) => item.id !== runtime && AGENT[item.id]);
    notice(
      'login',
      el(
        'div',
        { class: 'alert warn', role: 'status', 'data-notice': 'login' },
        el('span', { class: 'g' }, '▲'),
        el(
          'span',
          {},
          el('b', {}, `${NAME[runtime]} may need you to sign in.`),
          " If it's showing its login screen in the setup agent's terminal, sign in there, or run ",
          el('code', {}, command),
          ' in any terminal.',
        ),
        el(
          'span',
          { class: 'acts' },
          el('button', { type: 'button', class: 'btn primary sm', 'data-act': 'open-terminal', onclick: openTerminal }, 'Open terminal to sign in'),
          el('button', { type: 'button', class: 'btn sm', 'data-act': 'copy-login', onclick: () => copyText(command, 'the sign-in command') }, 'Copy command'),
          other ? el('button', { type: 'button', class: 'btn sm', 'data-act': 'use-other', onclick: () => switchTo(other.id) }, `Use ${NAME[other.id]} instead`) : null,
        ),
      ),
    );
    paintChip();
  }
  function openTerminal() {
    const chat = S.chat;
    if (!chat) return;
    Promise.resolve(chat.focusLead()).catch((error) =>
      problem('terminal', `Couldn't open the terminal: ${whyOf(error)}.`),
    );
  }
  function onSessions() {
    const rows = S.reads ? S.reads.latestSessions().filter(isGuide) : [];
    if (rows.some((row) => row.needsYouKind === 'startup' && row.state !== 'exited')) showLogin();
  }

  // ---- header: presence word, Stop and the "needs you" mark, painted into kit.chat's header slot ----
  function awaitingYou(chat) {
    const thread = chat.thread();
    const handles = chat.leadHandles();
    return thread.some(
      (row) =>
        row.kind === 'needs-you' &&
        chatKit.thread.sideOf(row, handles) === 'lead' &&
        !chatKit.core.cardAnswer(row.messageId, thread),
    );
  }
  function paintHeader() {
    const chat = S.chat;
    if (!chat) return { sig: 'none', nodes: [] };
    const presence = chat.presence();
    const stoppable = chat.controls().stop && presence.key === 'running';
    const needs = awaitingYou(chat);
    return {
      sig: [presence.face, presence.header, stoppable, needs].join('|'),
      nodes: [
        el('span', { class: 'pres' }, el('span', { class: 'av', 'data-face': presence.face, 'aria-hidden': 'true' }), el('span', {}, presence.header)),
        needs ? el('span', { class: 'badge needs' }, 'Needs you') : null,
        stoppable
          ? el(
              'button',
              {
                type: 'button',
                class: 'btn sm stopb',
                'data-stop': '',
                'aria-label': 'Stop what the setup agent is doing',
                onclick: () =>
                  Promise.resolve(chat.stopLead()).catch((error) => problem('stop', `Couldn't stop it: ${whyOf(error)}.`)),
              },
              'Stop',
            )
          : null,
      ].filter(Boolean),
    };
  }

  // ---- the setup summary the ⋯ menu copies: the cards the person answered, from the thread ----
  function summaryText() {
    const chat = S.chat;
    const thread = chat ? chat.thread() : [];
    const lines = [];
    for (const row of thread) {
      if (row.kind !== 'needs-you') continue;
      const card = chatKit.core.parseCardLine(row.text || row.summary || '');
      const answer = card && chatKit.core.cardAnswer(row.messageId, thread);
      if (!answer) continue;
      const chosen = card.acts.find((item) => item.label === answer.text);
      const question = card.text.split('\n')[0].replace(/[*_`]/g, '').trim() || card.step;
      lines.push(`- ${question} → ${answer.text}${chosen && chosen.act === 'none' ? ' (declined)' : ''}`);
    }
    return ['CodeSense setup summary', ...(lines.length ? lines : ['Nothing is set up yet.'])].join('\n');
  }

  // ---- the page's own controls: runtime chip, ⋯ menu ----
  const closers = [];
  const closeAll = (except) => closers.forEach((close) => close !== except && close());
  function popover(button, panel) {
    const close = () => {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    closers.push(close);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = panel.hidden;
      closeAll();
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        const first = panel.querySelector('button, [role=radio]');
        if (first) first.focus();
      }
    });
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
        button.focus();
        return;
      }
      // Arrow keys move through a menu's items and a segmented control's options.
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      const items = [...panel.querySelectorAll('[role=menuitem], [role=radio]:not([aria-disabled=true])')];
      const at = items.indexOf(document.activeElement);
      if (at < 0) return;
      event.preventDefault();
      items[(at + step + items.length) % items.length].focus();
    });
    return close;
  }
  document.addEventListener('click', () => closeAll());

  function paintRuntime() {
    const wrap = $('rt-wrap');
    if (!S.runtime) {
      wrap.replaceChildren();
      return;
    }
    const choices = S.list.filter((item) => AGENT[item.id]).length;
    const button = el(
      'button',
      { type: 'button', class: 'rt', id: 'rt', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      el('span', { class: 'rt-name' }),
      el('span', { class: 'chg' }, choices > 1 ? 'Change' : 'Details'),
    );
    const panel = el('div', { class: 'pop', role: 'dialog', 'aria-label': "Choose the setup agent's CLI", id: 'rt-pop', hidden: true });
    paintRuntimePanel(panel);
    wrap.replaceChildren(button, panel);
    popover(button, panel);
    paintChip();
  }
  // The chip's words: the runtime, the model the next launch runs, and "your login" unless the sign-in
  // notice says that login may be missing.
  function paintChip() {
    const name = document.querySelector('#rt .rt-name');
    if (!name || !S.runtime) return;
    const model = modelFor(S.runtime);
    const more = [model ? MODEL_NAME[model] : null, notices.has('login') ? null : 'your login'].filter(Boolean).join(' · ');
    name.replaceChildren(NAME[S.runtime], more ? el('span', { class: 'rt-more' }, ` · ${more}`) : null);
  }
  function paintRuntimePanel(panel) {
    const choose = (id) => {
      S.pending = id === S.runtime ? null : id;
      paintRuntimePanel(panel);
      const radio = panel.querySelector(`[data-runtime="${id}"]`);
      if (radio) radio.focus();
    };
    const radios = S.list.map((item) => {
      const usable = Boolean(AGENT[item.id]);
      return el(
        'button',
        {
          type: 'button',
          role: 'radio',
          'data-runtime': item.id,
          'aria-checked': String(item.id === S.runtime),
          'aria-disabled': usable ? null : 'true',
          class: item.id === S.pending ? 'pend' : null,
          onclick: () => usable && choose(item.id),
        },
        NAME[item.id] || item.id,
      );
    });
    panel.replaceChildren(...[
      el('div', {}, el('b', {}, 'Run setup on'), el('span', { class: 'muted xs' }, ' installed on this Mac')),
      el('div', { class: 'segm', role: 'radiogroup', 'aria-label': 'Runtime' }, ...radios),
      el(
        'div',
        {},
        ...S.list.map((item) =>
          el(
            'div',
            { class: 'rl' },
            el('b', {}, NAME[item.id] || item.id),
            el('span', { class: 'muted' }, AGENT[item.id] ? item.version || 'installed' : 'needs a model endpoint; CodeSense setup does not use it'),
            el('span', { class: 'okw' }, AGENT[item.id] ? 'Installed' : ''),
          ),
        ),
        el('div', { class: 'rl note' }, el('span'), el('span', { class: 'muted xs' }, "Sign-in isn't checked ahead; if a CLI shows its login screen, you'll see it here."), el('span')),
      ),
      S.pending
        ? el(
            'div',
            { class: 'confirm', role: 'group', 'aria-label': `Switch to ${NAME[S.pending]}?` },
            el('span', {}, el('b', {}, `Switch to ${NAME[S.pending]}?`), ` ${NAME[S.runtime]} stops. The new session checks this Mac and your setup log again; nothing is redone.`),
            el('span', { class: 'acts' }, el('button', { type: 'button', class: 'btn primary sm', 'data-act': 'switch', onclick: () => switchTo(S.pending) }, 'Switch'), el('button', { type: 'button', class: 'btn sm', onclick: () => { S.pending = null; paintRuntimePanel(panel); } }, 'Cancel')),
          )
        : null,
    ].filter(Boolean));
  }

  function paintMenu() {
    const button = el('button', { type: 'button', class: 'btn quiet sm', id: 'more', 'aria-label': 'Setup menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, '⋯');
    const item = (label, run, act) =>
      el('button', { type: 'button', role: 'menuitem', 'data-act': act, onclick: () => { closeAll(); run(); } }, label);
    const panel = el(
      'div',
      { class: 'dm', role: 'menu', 'aria-label': 'Setup menu', id: 'more-menu', hidden: true },
      item("What I've set up", askSetup, 'whats-set-up'),
      item('Copy setup summary', () => copyText(summaryText(), 'the setup summary'), 'copy-summary'),
      el('div', { class: 'sep', role: 'separator' }),
      item('Clear conversation', askClear, 'clear'),
    );
    $('more-wrap').replaceChildren(button, panel);
    popover(button, panel);
  }
  function askSetup() {
    const chat = S.chat;
    if (chat && !chat.post("What have you set up?")) flash("The setup agent can't take a message right now.");
  }
  function askClear() {
    notice(
      'clear',
      el(
        'div',
        { class: 'alert warn', role: 'group', 'aria-label': 'Clear this conversation?', 'data-notice': 'clear' },
        el('span', { class: 'g' }, '▲'),
        el('span', {}, el('b', {}, 'Clear this conversation?'), ' It stops the setup agent and starts a new one. Your setup log and what was set up stay.'),
        el('span', { class: 'acts' }, el('button', { type: 'button', class: 'btn primary sm', 'data-act': 'confirm-clear', onclick: clearConversation }, 'Clear'), el('button', { type: 'button', class: 'btn sm', onclick: () => notice('clear', null) }, 'Cancel')),
      ),
    );
  }

  // ---- mount, switch, clear ----
  function mountChat() {
    const reads = (S.reads = createReads());
    reads.on('sessions', onSessions);
    S.chat = chatKit.mount($('chat'), {
      transport,
      reads,
      target: guideTarget(),
      timers: { slowMs: 20000, failMs: 120000 },
      card: promptFor,
      layout: {
        variant: 'page',
        logLabel: COPY.logLabel,
        composerLabel: COPY.composerLabel,
        // While the sign-in notice is up, the composer says why a message will wait.
        composer: () =>
          notices.has('login')
            ? { placeholder: 'Sign in first, then message CodeSense setup', hint: 'Messages are held until the CLI is signed in.' }
            : {},
      },
      headerSlot: { slot: $('ctl'), render: paintHeader },
      cards: { consent: true },
      next: { edit: true },
      activity: true,
      copy: COPY,
    });
    S.chat.subscribe(() => {
      if (leadSpoke()) hideLogin();
      markShownRead();
    });
    reads.poke();
    return S.chat;
  }
  // The person reads the guide here, so its messages on the page do not wait in the Inbox as unread.
  function markShownRead() {
    const chat = S.chat;
    if (!chat || document.visibilityState === 'hidden') return;
    const handles = chat.leadHandles();
    const ids = chat
      .thread()
      .filter((row) => row.unread === true && row.toHuman === true && !S.marked.has(row.messageId) && chatKit.thread.sideOf(row, handles) === 'lead')
      .map((row) => row.messageId);
    if (!ids.length) return;
    ids.forEach((id) => S.marked.add(id));
    Promise.resolve(cs.invoke('markRead', { messageIds: ids })).catch(() => {
      // A refused or failed call is tried again on the next change or when the page is shown again.
      ids.forEach((id) => S.marked.delete(id));
    });
  }
  document.addEventListener('visibilitychange', markShownRead);

  function unmountChat() {
    hideLogin();
    if (S.chat) S.chat.unmount();
    if (S.reads) S.reads.dispose();
    S.chat = null;
    S.reads = null;
  }
  // Reopening an open tab with no agent live launches one that resumes. The host reports a reopen two
  // ways: a fragment change, and a `codesense:navigate` message that also arrives when the fragment is
  // already `#resume` (no `hashchange` then). A live or starting agent makes both a no-op. The guard waits
  // for the chat's first roster read: before it, no guide is known, so a live one would look absent.
  function resumeIfIdle() {
    const chat = S.chat;
    if (!chat) return;
    chat.loaded().then(() => {
      if (S.chat !== chat) return;
      const controls = chat.controls();
      if (controls.launch && !controls.stop) chat.launchLead().catch(() => {});
    });
  }
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#resume') resumeIfIdle();
  });
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (event.source !== window.parent || !data || data.type !== 'codesense:navigate' || data.hash !== '#resume') return;
    resumeIfIdle();
  });
  async function startChat() {
    const chat = mountChat();
    await chat.loaded();
    const controls = chat.controls();
    // The opener is unprompted: a person with no live setup agent gets one that speaks first.
    if (controls.launch && !controls.stop) chat.launchLead().catch(() => {});
  }
  // Stops the guide and waits for the roster to show it gone, so the next launch can't bind to it
  // or be answered with it. False, with the reason shown, when the stop is cancelled, refused or slow.
  // The guide is read from the roster, not the chat's lead: a CLI at its sign-in screen is not joinable,
  // so it is no lead, but it is still running and must stop before another guide opens.
  async function stopLive() {
    const reads = S.reads;
    const row = reads ? newest(reads.latestSessions().filter((other) => isGuide(other) && other.state !== 'exited')) : null;
    if (!row) return true;
    notice('stop', null);
    let result;
    try {
      result = await transport.stop(row.handle);
    } catch (error) {
      problem('stop', `Couldn't stop it: ${whyOf(error)}.`);
      return false;
    }
    if (!(result && result.stopped === true)) {
      problem('stop', `Couldn't stop it: ${(result && (result.message || result.status)) || 'it was not stopped'}.`);
      return false;
    }
    notice('stopping', el('div', { class: 'alert info', role: 'status' }, el('span', { class: 'g' }, '…'), el('span', {}, `Stopping ${NAME[S.runtime]}…`), el('span')));
    const gone = await exited(row);
    notice('stopping', null);
    if (!gone) problem('stop', `${NAME[S.runtime]} hasn't stopped yet. Try again in a moment.`);
    return gone;
  }
  function exited(row) {
    const reads = S.reads;
    const same = (other) => (row.sessionId ? other.sessionId === row.sessionId : other.handle === row.handle);
    const out = () => !reads.latestSessions().some((other) => same(other) && other.state !== 'exited');
    return new Promise((resolve) => {
      if (out()) return resolve(true);
      const timer = setTimeout(() => done(false), EXIT_MS);
      const off = reads.on('sessions', () => out() && done(true));
      function done(value) {
        clearTimeout(timer);
        off();
        resolve(value);
      }
    });
  }
  // A switch or clear runs once at a time; a refused stop keeps the runtime and the conversation.
  async function restart(before) {
    if (S.busy) return;
    S.busy = true;
    try {
      if (!(await stopLive())) return;
      if (before) before();
      unmountChat();
      await startChat();
    } finally {
      S.busy = false;
    }
  }
  function switchTo(id) {
    closeAll();
    S.pending = null;
    return restart(() => {
      S.runtime = id;
      remember(id);
      paintRuntime();
    });
  }
  function clearConversation() {
    notice('clear', null);
    return restart();
  }

  // ---- no CLI: the empty state ----
  function terminalIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ico ei');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of [
      ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
      ['path', { d: 'm7 9 3 3-3 3M13 15h4' }],
    ]) {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      svg.append(node);
    }
    return svg;
  }
  function paintEmpty() {
    const hermes = S.list.some((item) => item.id === 'hermes');
    $('chat').hidden = true;
    const empty = $('empty');
    empty.hidden = false;
    empty.replaceChildren(...[
      terminalIcon(),
      el('h2', {}, 'No agent CLI found'),
      el('p', {}, 'CodeSense runs the agent CLI you already use. Install one, sign in once in a terminal, then come back. Setup takes it from there.'),
      el('div', { class: 'links' }, ...INSTALL.map(([label, href]) => el('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, label))),
      el('button', { type: 'button', class: 'btn primary', id: 'check-again', onclick: boot }, 'Check again'),
      hermes ? el('span', { class: 'muted xs' }, 'Hermes is installed but needs a model endpoint, so setup does not use it.') : null,
    ].filter(Boolean));
    $('rt-wrap').replaceChildren();
    $('more-wrap').replaceChildren();
    $('ctl').replaceChildren(el('span', { class: 'pres off' }, el('span', { class: 'av', 'data-face': 'off', 'aria-hidden': 'true' }), el('span', {}, 'not started')));
  }
  function paintChecking() {
    $('chat').hidden = true;
    const empty = $('empty');
    empty.hidden = false;
    empty.replaceChildren(el('p', { role: 'status' }, 'Checking this Mac for an agent CLI…'));
  }

  // ---- start ----
  async function loadRuntimes() {
    let found = null;
    for (let attempt = 0; attempt < CHECK_TRIES; attempt++) {
      found = await kit.runtimes({ lastUsed: remembered() });
      if (!(found.resolving && !found.pick)) break;
      paintChecking();
      await sleep(CHECK_MS);
    }
    S.list = found.list;
    S.runtime = found.pick;
    return found;
  }
  async function boot() {
    notice('problem', null);
    unmountChat();
    if (!chatKit || !cs || typeof cs.invoke !== 'function') {
      $('chat').hidden = true;
      $('empty').hidden = false;
      $('empty').replaceChildren(el('h2', {}, 'Open this page in CodeSense'), el('p', {}, 'The setup guide runs inside the CodeSense app.'));
      return;
    }
    try {
      await loadRuntimes();
    } catch (error) {
      S.list = [];
      S.runtime = null;
      problem('problem', `Couldn't check this Mac for agent CLIs: ${whyOf(error)}.`);
    }
    if (!S.runtime) {
      paintEmpty();
      return;
    }
    $('empty').hidden = true;
    $('chat').hidden = false;
    await readSetupDone();
    paintRuntime();
    paintMenu();
    await startChat();
  }
  window.addEventListener('beforeunload', () => {
    if (S.reads) S.reads.dispose();
  });
  boot();
})();
