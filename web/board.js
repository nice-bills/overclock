// Live job board. Reads the Overclock contract on X Layer over public JSON-RPC, with no libraries, so the
// page stays one self-contained file that DeWEB can serve. Job and game state come from contract calls,
// which are always complete; transaction links come from events. Public X Layer nodes only serve
// eth_getLogs 100 blocks at a time, so the page starts from a snapshot of past events (built by
// scripts/snapshot-board.js), scans the recent blocks itself, and finds any claim or dispute move it is
// still missing from the timestamp the contract stores with it.
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULT = '0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710';
  const DEFAULT_BLOCK = 73578388;
  const NODES = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://xlayer.drpc.org'];
  const EXPLORER = 'https://www.oklink.com/x-layer';
  const SPAN = 100; // blocks per eth_getLogs on public nodes
  const TAIL = 1500; // most blocks scanned in one refresh
  const REFRESH = 20000;

  const params = new URLSearchParams(location.search);
  let snap = null;
  try { snap = JSON.parse($('board-data').textContent); } catch (e) { /* none inlined */ }
  const CONTRACT = (params.get('contract') || DEFAULT).toLowerCase();
  if (snap && snap.contract.toLowerCase() !== CONTRACT) snap = null;
  const DEPLOY_BLOCK = snap ? snap.deployBlock : Number(params.get('from')) || (CONTRACT === DEFAULT.toLowerCase() ? DEFAULT_BLOCK : 0);
  $('contractLink').href = `${EXPLORER}/address/${CONTRACT}`;

  const TOPICS = {
    '0xd521bb07d01dfe38c9ddc989b6cbe19f6b408f2a298e263da79cd3bbc5278f4d': 'JobPosted',
    '0x855a507ff28d8878749a77d14a518c4f45c7cf33584d042add002377c34f46b4': 'Claimed',
    '0xa5f8c369e0214ca8253e5f7a94be7e6296f76d2e0283d76f7759115c6f042411': 'Challenged',
    '0xcceeb83fe4f7352f8b511ab8816c6f3f37a73798c028f0019b52b1b12a60b4d6': 'Revealed',
    '0x58bdb6a4f5f57c8cf3969bd320a3b34eca94998006fbc5feb273673b58d2ba04': 'Picked',
    '0xd8179ddf1c6a596713a2d7c20badda9e2caa45386409d1018fa6a6cee92be6cf': 'Resolved',
    '0x3ab77fd700217c820f33729d7e838d9e2741993bc1ad9c3c147d361efc2edf1d': 'Finalized',
    '0x1e1c1e4e68a25c69a078a396e73975691c071d69ef789015dc16a562957804e4': 'Continued',
  };
  const SEL = { jobCount: '0x4c5d8a0f', gameCount: '0x4d1975b4', bond: '0x64c9ec6f', window: '0x461645bf', feeBps: '0x24a9d853', jobs: '0x180aedf3', games: '0x117a5b90' };

  // ------------------------------------------------------------ JSON-RPC
  let node = 0, nid = 0;
  async function post(url, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  // [[method, params], ...] → results, five per request, falling over to the next node on any error.
  async function batch(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 5) {
      const part = calls.slice(i, i + 5).map(([method, p]) => ({ jsonrpc: '2.0', id: ++nid, method, params: p }));
      let res = null, err = null;
      for (let k = 0; k < NODES.length && !res; k++) {
        const n = (node + k) % NODES.length;
        try {
          let b = await post(NODES[n], part);
          if (!Array.isArray(b)) b = [b];
          const by = new Map(b.map((r) => [r.id, r]));
          const rs = part.map((q) => by.get(q.id));
          const bad = rs.find((r) => !r || r.error);
          if (bad) throw new Error(bad && bad.error ? bad.error.message : 'incomplete reply');
          res = rs.map((r) => r.result);
          node = n;
        } catch (e) { err = e; }
      }
      if (!res) throw err;
      out.push(...res);
    }
    return out;
  }
  const hex = (n) => '0x' + n.toString(16);
  const call = (data) => ['eth_call', [{ to: CONTRACT, data }, 'latest']];
  const arg = (n) => BigInt(n).toString(16).padStart(64, '0');

  // ------------------------------------------------------------ ABI decoding
  const word = (h, i) => h.slice(2 + 64 * i, 66 + 64 * i);
  const uint = (h, i) => BigInt('0x' + (word(h, i) || '0'));
  const num = (h, i) => Number(uint(h, i));
  const addr = (h, i) => '0x' + word(h, i).slice(24);
  const bytesAt = (h, i) => {
    const off = num(h, i) * 2;
    const len = Number(BigInt('0x' + h.slice(2 + off, 66 + off)));
    return '0x' + h.slice(66 + off, 66 + off + len * 2);
  };
  const utf8 = (h) => new TextDecoder().decode(new Uint8Array((h.slice(2).match(/../g) || []).map((b) => parseInt(b, 16))));
  const ZERO = '0x0000000000000000000000000000000000000000';

  function decodeJob(h, jobId) {
    return {
      jobId, cpu: addr(h, 0), id: uint(h, 1), inputs: bytesAt(h, 2), state: bytesAt(h, 3), fee: uint(h, 4),
      beats: num(h, 5), perBeat: num(h, 6) === 1, nIn: num(h, 7), nOut: num(h, 8), nState: num(h, 9), flat: num(h, 10),
      poster: addr(h, 11), parent: num(h, 12), claimant: addr(h, 13), traceRoot: '0x' + word(h, 14),
      outputs: bytesAt(h, 15), newState: bytesAt(h, 16), claimedAt: num(h, 17), challenged: num(h, 18) === 1, finalized: num(h, 19) === 1,
    };
  }
  function decodeGame(h, gameId) {
    return { gameId, jobId: num(h, 0), challenger: addr(h, 1), level: num(h, 2), index: uint(h, 3), turn: num(h, 5), deadline: num(h, 6) };
  }
  function decodeLog(l) {
    const name = TOPICS[l.topics[0]];
    if (!name) return null;
    const t1 = l.topics[1] ? Number(BigInt(l.topics[1])) : null;
    const t2 = l.topics[2] ? Number(BigInt(l.topics[2])) : null;
    const d = l.data;
    const e = { name, block: l.block, tx: l.tx, i: l.i };
    switch (name) {
      case 'JobPosted': return { ...e, jobId: t1, cpu: addr(d, 0), id: uint(d, 1), beats: num(d, 2) };
      case 'Claimed': return { ...e, jobId: t1, who: addr(d, 0), traceRoot: '0x' + word(d, 1) };
      case 'Challenged': return { ...e, jobId: t1, gameId: t2, who: addr(d, 0) };
      case 'Revealed': return { ...e, gameId: t1, level: num(d, 0), index: uint(d, 1) };
      case 'Picked': return { ...e, gameId: t1, level: num(d, 0), index: uint(d, 1) };
      case 'Resolved': return { ...e, jobId: t1, gameId: t2, who: addr(d, 0), reason: utf8(bytesAt(d, 1)) };
      case 'Finalized': return { ...e, jobId: t1 };
      case 'Continued': return { ...e, jobId: t1, parentJobId: t2 };
    }
    return null;
  }

  // ------------------------------------------------------------ event store: snapshot + cache + scans
  const KEY = 'overclock-board:' + CONTRACT;
  const store = { logs: new Map(), times: {}, scanned: DEPLOY_BLOCK - 1 };
  const addLog = (l) => store.logs.set(`${l.tx}:${l.i}`, l);
  if (snap) {
    snap.logs.forEach(addLog);
    Object.assign(store.times, snap.blockTimes || {});
    store.scanned = snap.toBlock;
  }
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && c.scanned > store.scanned) {
      c.logs.forEach(addLog);
      Object.assign(store.times, c.times || {});
      store.scanned = c.scanned;
    } else if (c) Object.assign(store.times, c.times || {});
  } catch (e) { /* storage unavailable */ }
  function save() {
    try {
      const extra = [...store.logs.values()].filter((l) => !snap || l.block > snap.toBlock);
      localStorage.setItem(KEY, JSON.stringify({ scanned: store.scanned, logs: extra, times: store.times }));
    } catch (e) { /* storage unavailable */ }
  }
  const rawLog = (l) => ({ block: Number(l.blockNumber), tx: l.transactionHash, i: Number(l.logIndex), topics: l.topics, data: l.data });
  async function scan(from, to) {
    const calls = [];
    for (let b = from; b <= to; b += SPAN) calls.push(['eth_getLogs', [{ address: CONTRACT, fromBlock: hex(b), toBlock: hex(Math.min(b + SPAN - 1, to)) }]]);
    const res = await batch(calls);
    for (const list of res) for (const l of list) addLog(rawLog(l));
  }
  let gapNote = '';
  async function scanTail(latest) {
    let from = store.scanned + 1;
    if (from > latest) return;
    if (latest - from + 1 > TAIL) {
      gapNote = `Blocks ${from.toLocaleString('en-US')}–${(latest - TAIL).toLocaleString('en-US')} were not scanned for events in this browser; claims and dispute moves in them are found from their timestamps.`;
      from = latest - TAIL + 1;
    }
    await scan(from, latest);
    store.scanned = latest;
  }
  // The block whose timestamp is ts, by interpolation on block numbers (X Layer makes about one block a second).
  async function blockAt(ts, head) {
    let lo = { n: DEPLOY_BLOCK || 0, t: null }, hi = head;
    const time = async (n) => { if (store.times[n]) return store.times[n]; const [b] = await batch([['eth_getBlockByNumber', [hex(n), false]]]); return (store.times[n] = Number(b.timestamp)); };
    lo.t = await time(lo.n);
    if (ts <= lo.t) return lo.n;
    for (let k = 0; k < 8 && hi.n - lo.n > SPAN / 2; k++) {
      const guess = Math.min(hi.n - 1, Math.max(lo.n + 1, Math.round(lo.n + (ts - lo.t) / Math.max(1, hi.t - lo.t) * (hi.n - lo.n))));
      const t = await time(guess);
      if (t === ts) return guess;
      if (t < ts) lo = { n: guess, t }; else hi = { n: guess, t };
    }
    return Math.round((lo.n + hi.n) / 2);
  }
  async function locate(ts, head) {
    const b = await blockAt(ts, head);
    await scan(Math.max(DEPLOY_BLOCK || 0, b - SPAN / 2), Math.min(head.n, b + SPAN / 2 - 1));
  }

  // ------------------------------------------------------------ formatting
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const okb = (wei) => {
    const s = (Number(wei) / 1e18).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return s + ' OKB';
  };
  const aLink = (a) => `<a href="${EXPLORER}/address/${a}" title="${a}">${short(a)}</a>`;
  const txLink = (tx, label, cls = '') => `<a class="${cls}" href="${EXPLORER}/tx/${tx}" title="${tx}"><b>${label}</b> ${tx.slice(0, 8)}</a>`;
  const dur = (s) => {
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
  };
  const ago = (t) => (t ? dur(chainNow() - t) + ' ago' : '');
  let headTs = 0, headAt = 0;
  const chainNow = () => headTs + (Date.now() - headAt) / 1000;
  const countdown = (until) => `<span data-until="${until}">${dur(until - chainNow())}</span>`;

  const bits = (h, n) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = (parseInt(h.substr(2 + (i >> 3) * 2, 2) || '0', 16) >> (i & 7)) & 1;
    return out;
  };
  const css = getComputedStyle(document.documentElement);
  function drawState(cv, h, n) {
    const w = Math.round(Math.sqrt(n));
    const on = css.getPropertyValue('--cell').trim(), off = css.getPropertyValue('--cell-off').trim();
    const b = bits(h, n), ctx = cv.getContext('2d');
    cv.width = w; cv.height = w;
    for (let i = 0; i < n; i++) { ctx.fillStyle = b[i] ? on : off; ctx.fillRect(i % w, Math.floor(i / w), 1, 1); }
  }

  // ------------------------------------------------------------ render
  let last = null;
  function render(d) {
    last = d;
    const { jobs, games, bond, window: win, feeBps } = d;
    const events = [...store.logs.values()].map(decodeLog).filter(Boolean).sort((a, b) => a.block - b.block || a.i - b.i);
    const byJob = new Map(), byGame = new Map();
    for (const e of events) {
      if (e.jobId != null && e.name !== 'Revealed' && e.name !== 'Picked') (byJob.get(e.jobId) || byJob.set(e.jobId, []).get(e.jobId)).push(e);
      if (e.gameId != null) (byGame.get(e.gameId) || byGame.set(e.gameId, []).get(e.gameId)).push(e);
    }
    const gameOf = new Map(games.map((g) => [g.gameId, g]));
    const resolved = events.filter((e) => e.name === 'Resolved');
    const caught = resolved.filter((e) => gameOf.get(e.gameId) && e.who.toLowerCase() === gameOf.get(e.gameId).challenger.toLowerCase());
    const finals = jobs.filter((j) => j.finalized);
    const paid = finals.reduce((a, j) => a + j.fee, 0n);
    const live = games.filter((g) => g.level !== 255 && g.deadline !== 0);

    $('liveSpecs').innerHTML = [
      [fmt(jobs.length), 'jobs posted'],
      [fmt(finals.length), 'finalized'],
      [fmt(jobs.length - finals.length), 'open or in window'],
      [fmt(games.length), live.length ? `disputes · ${live.length} live` : 'disputes'],
      [fmt(caught.length), 'cheats caught'],
      [okb(paid).replace(' OKB', '<small> OKB</small>'), 'fees paid out'],
    ].map(([v, k]) => `<div class="spec"><span class="v">${v}</span><span class="label">${k}</span></div>`).join('');

    // jobs, newest first
    const jobHtml = [...jobs].reverse().map((j) => {
      let cls, tag, until = '';
      if (j.finalized) { cls = 's-final'; tag = '<span class="tag ok">finalized</span>'; }
      else if (j.challenged) { cls = 's-dispute'; tag = '<span class="tag bad">in dispute</span>'; }
      else if (j.claimant !== ZERO) {
        const end = j.claimedAt + win;
        cls = 's-claimed';
        tag = end <= chainNow() ? '<span class="tag warn">ready to finalize</span>' : '<span class="tag warn">claimed</span>';
        until = end > chainNow() ? `<dt>Finalizes in</dt><dd>${countdown(end)}</dd>` : '';
      } else { cls = 's-open'; tag = '<span class="tag same">open</span>'; }
      const ev = byJob.get(j.jobId) || [];
      const links = [];
      let pending = null;
      for (const e of ev) {
        if (e.name === 'JobPosted') links.push(txLink(e.tx, 'posted'));
        else if (e.name === 'Continued') links.push(txLink(e.tx, `continues #${e.parentJobId}`));
        else if (e.name === 'Claimed') { pending = links.length; links.push(txLink(e.tx, 'claimed')); }
        else if (e.name === 'Challenged') links.push(txLink(e.tx, `challenged · game ${e.gameId}`, 'lie'));
        else if (e.name === 'Resolved') {
          const g = gameOf.get(e.gameId);
          const challengerWon = g && e.who.toLowerCase() === g.challenger.toLowerCase();
          if (challengerWon && pending != null) links[pending] = links[pending].replace('<b>claimed</b>', '<b>wrong claim</b>').replace('class=""', 'class="lie"');
          links.push(txLink(e.tx, challengerWon ? 'cheat caught' : 'claim upheld', challengerWon ? 'ok' : ''));
        } else if (e.name === 'Finalized') links.push(txLink(e.tx, 'finalized', 'ok'));
      }
      const square = j.nState > 0 && j.nState <= 4096 && Number.isInteger(Math.sqrt(j.nState));
      const states = square ? `<div class="states"><figure><canvas data-state="${j.state}" data-n="${j.nState}" aria-label="Starting state"></canvas><figcaption>start state</figcaption></figure>${j.claimant !== ZERO ? `<figure><canvas data-state="${j.newState}" data-n="${j.nState}" aria-label="Claimed final state"></canvas><figcaption>${j.finalized ? 'final state' : 'claimed state'}</figcaption></figure>` : ''}</div>` : '';
      return `<article class="ticket ${cls}">
        <div class="top"><h3>Job ${j.jobId}</h3>${tag}</div>
        <dl class="kv">
          <dt>Circuit</dt><dd>#${j.id} on ${aLink(j.cpu)}</dd>
          <dt>Run</dt><dd>${fmt(j.beats)} beat${j.beats === 1 ? '' : 's'} · ${fmt(j.beats * (j.flat + j.nState))} trace steps</dd>
          <dt>Pins</dt><dd>${j.nIn} in · ${j.nOut} out · ${fmt(j.nState)} state bits${j.perBeat ? ' · inputs per beat' : ''}</dd>
          <dt>Fee</dt><dd>${okb(j.fee)}</dd>
          <dt>Poster</dt><dd>${aLink(j.poster)}</dd>
          ${j.parent ? `<dt>Continues</dt><dd>job ${j.parent - 1}</dd>` : ''}
          <dt>Claimant</dt><dd>${j.claimant !== ZERO ? aLink(j.claimant) : 'none yet'}</dd>
          ${j.claimant !== ZERO ? `<dt>Outputs</dt><dd>${esc(j.outputs)}</dd>` : ''}
          ${until}
        </dl>
        ${states}
        <div class="txs">${links.join('') || '<span class="empty">transactions not found yet</span>'}</div>
      </article>`;
    });
    $('jobs').innerHTML = jobHtml.join('') || '<p class="empty">No jobs posted yet.</p>';
    $('jobs').querySelectorAll('canvas[data-state]').forEach((cv) => drawState(cv, cv.dataset.state, Number(cv.dataset.n)));

    const TURN = ['claimant to reveal', 'challenger to pick', 'challenger to prove the step'];
    $('games').innerHTML = [...games].reverse().map((g) => {
      const ev = byGame.get(g.gameId) || [];
      const res = ev.find((e) => e.name === 'Resolved');
      const start = ev.find((e) => e.name === 'Challenged');
      const moves = ev.filter((e) => e.name === 'Revealed' || e.name === 'Picked');
      const open = g.level !== 255 && g.deadline !== 0;
      const where = open ? `level ${g.level} · ${TURN[g.turn] || 'settling'} · ${countdown(g.deadline)} left` : `${moves.length} moves`;
      let outcome = 'open';
      if (res) outcome = `${res.who.toLowerCase() === g.challenger.toLowerCase() ? '<span class="tag ok">cheat caught</span>' : '<span class="tag warn">claim upheld</span>'} ${esc(res.reason)}`;
      else if (!open) outcome = 'settled';
      const moveLinks = moves.map((e) => txLink(e.tx, `${e.name === 'Revealed' ? 'reveal' : 'pick'} L${e.level}`)).join('');
      const txs = [start ? txLink(start.tx, 'challenge', 'lie') : '', moves.length ? `<details><summary>${moves.length} moves</summary><div class="txs">${moveLinks}</div></details>` : '', res ? txLink(res.tx, 'resolve', 'ok') : ''].join('');
      return `<tr><td>${g.gameId}</td><td>${g.jobId}</td><td>${aLink(g.challenger)}</td><td>${where}</td><td>${outcome}</td><td><div class="txs">${txs}</div></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No disputes yet. Every claim so far has gone unchallenged or been upheld.</td></tr>';

    const LABEL = { JobPosted: 'job posted', Claimed: 'claimed', Challenged: 'challenged', Revealed: 'revealed', Picked: 'picked', Resolved: 'resolved', Finalized: 'finalized', Continued: 'continued' };
    const detail = (e) => {
      switch (e.name) {
        case 'JobPosted': return `job ${e.jobId} · circuit #${e.id} · ${fmt(e.beats)} beats`;
        case 'Claimed': return `job ${e.jobId} by ${aLink(e.who)}`;
        case 'Challenged': return `job ${e.jobId} by ${aLink(e.who)} · game ${e.gameId}`;
        case 'Revealed': case 'Picked': return `game ${e.gameId} · level ${e.level}`;
        case 'Resolved': return `job ${e.jobId} · ${aLink(e.who)} wins · ${esc(e.reason)}`;
        case 'Finalized': return `job ${e.jobId}`;
        case 'Continued': return `job ${e.jobId} continues job ${e.parentJobId}`;
      }
      return '';
    };
    // a run of bisection moves in one game reads as one row
    const rows = [];
    for (const e of events) {
      const move = e.name === 'Revealed' || e.name === 'Picked';
      const prev = rows.at(-1);
      if (move && prev && prev.moves && prev.gameId === e.gameId) { prev.moves++; prev.last = e; continue; }
      rows.push(move ? { moves: 1, gameId: e.gameId, last: e } : { last: e });
    }
    $('feed').innerHTML = rows.slice(-15).reverse().map((r) => {
      const e = r.last, t = store.times[e.block];
      const what = r.moves ? (r.moves === 1 ? LABEL[e.name] : 'bisection') : LABEL[e.name];
      const info = r.moves && r.moves > 1 ? `game ${e.gameId} · ${r.moves} moves, down to level ${e.level}` : detail(e);
      return `<tr><td title="${t ? new Date(t * 1000).toISOString() : ''}">${t ? ago(t) : 'block ' + fmt(e.block)}</td><td>${what}</td><td>${info}</td><td><a href="${EXPLORER}/tx/${e.tx}" title="${e.tx}">${e.tx.slice(0, 10)}</a></td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">No events found yet.</td></tr>';
    $('feedNote').textContent = `${events.length} events · bond ${okb(bond)} · ${dur(win)} challenge window · ${(feeBps / 100).toFixed(feeBps % 100 ? 1 : 0)}% protocol fee${gapNote ? ' · ' + gapNote : ''}`;
  }

  setInterval(() => {
    document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = dur(Number(el.dataset.until) - chainNow()); });
  }, 1000);
  const redraw = () => { if (last) render(last); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ------------------------------------------------------------ refresh loop
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    $('liveRefresh').disabled = true;
    try {
      const [headBlock, jc, gc, bond, win, feeBps] = await batch([
        ['eth_getBlockByNumber', ['latest', false]], call(SEL.jobCount), call(SEL.gameCount), call(SEL.bond), call(SEL.window), call(SEL.feeBps),
      ]);
      const head = { n: Number(headBlock.number), t: Number(headBlock.timestamp) };
      headTs = head.t; headAt = Date.now();
      const nJobs = num(jc, 0), nGames = num(gc, 0);
      const calls = [];
      for (let i = 0; i < nJobs; i++) calls.push(call(SEL.jobs + arg(i)));
      for (let i = 0; i < nGames; i++) calls.push(call(SEL.games + arg(i)));
      const res = await batch(calls);
      const jobs = res.slice(0, nJobs).map(decodeJob);
      const games = res.slice(nJobs).map(decodeGame);
      const d = { jobs, games, bond: uint(bond, 0), window: num(win, 0), feeBps: num(feeBps, 0) };
      render(d);

      await scanTail(head.n);
      // claims and live dispute moves the scans missed: look them up by the timestamp the contract keeps
      const have = (name, key, val) => [...store.logs.values()].some((l) => TOPICS[l.topics[0]] === name && Number(BigInt(l.topics[1])) === val && (!key || store.times[l.block] === key));
      const targets = [];
      for (const j of jobs) if (j.claimant !== ZERO && !have('Claimed', 0, j.jobId) && !have('Resolved', j.claimedAt, j.jobId)) targets.push(j.claimedAt);
      for (const g of games) if (g.level !== 255 && g.deadline && !(store.logs.size && [...store.logs.values()].some((l) => store.times[l.block] === g.deadline - d.window))) targets.push(g.deadline - d.window);
      for (const ts of targets.slice(0, 6)) await locate(ts, head);
      // block times for the activity feed
      const need = [...new Set([...store.logs.values()].map((l) => l.block))].filter((b) => !store.times[b]).sort((a, b) => b - a).slice(0, 40);
      const blocks = await batch(need.map((b) => ['eth_getBlockByNumber', [hex(b), false]]));
      blocks.forEach((blk, k) => { if (blk) store.times[need[k]] = Number(blk.timestamp); });
      save();
      render(d);
      $('liveDot').className = 'dot on';
      $('liveStatus').textContent = `Live · block ${fmt(head.n)} · refreshes every ${REFRESH / 1000}s`;
    } catch (e) {
      $('liveDot').className = 'dot err';
      $('liveStatus').textContent = `Could not reach X Layer nodes (${e && e.message ? e.message : e}). Retrying.`;
    } finally {
      busy = false;
      $('liveRefresh').disabled = false;
    }
  }
  $('liveRefresh').addEventListener('click', refresh);
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH);
})();
