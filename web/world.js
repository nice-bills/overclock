// "World": Overclock World, Red vs Blue on a shared 16x16 Game of Life (contracts/World.sol). Shows the live
// board, lets you pick a team and buy cells with OKX Wallet (or any injected wallet), follows the epoch that is
// running as an Overclock job, lets anyone move the world on for the keeper tip, and pays out won seasons.
// No libraries: JSON-RPC and ABI by hand, like run.js. The network and selectors come from #world-config,
// inlined by scripts/build-web.js.
(function () {
  const $ = (id) => document.getElementById(id);
  let CFG = null;
  try { CFG = JSON.parse($('world-config').textContent); } catch (e) { /* not inlined */ }
  if (!CFG) { $('world').querySelector('.worldapp').innerHTML = '<p class="empty">Overclock World is not live on a network yet. It launches on X Layer mainnet; the contract and a full rehearsed season are in the repo.</p>'; return; }
  const NET = CFG, SEL = CFG.sel, W = 16, H = 16, N = W * H, RED = 1, BLUE = 2, MAX = 12;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const okb = (wei) => { const v = Number(wei) / 1e18; return v === 0 ? '0' : v < 0.001 ? v.toFixed(5) : v.toFixed(4); };
  const TEAM = { 1: 'Red', 2: 'Blue' };

  // ------------------------------------------------------------ chain reads
  let nid = 0;
  async function rpc(method, params) {
    let err;
    for (const url of NET.rpc) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++nid, method, params }) });
        const b = await r.json();
        if (b.error) throw new Error(b.error.message);
        return b.result;
      } catch (e) { err = e; }
    }
    throw err;
  }
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const addr = (a) => word(BigInt(a));
  const slot = (h, i) => h.slice(2 + 64 * i, 66 + 64 * i);
  const big = (h, i) => BigInt('0x' + slot(h, i));
  const num = (h, i) => Number(big(h, i));
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

  // ------------------------------------------------------------ state
  let S = null; // the world as last read
  let account = null, wallet = null, walletName = '';
  let team = RED; // the team you are buying for
  const picked = new Set(); // cells you are about to buy
  let ahead = 0; // generations of forecast shown on the board
  let busy = false;

  async function read() {
    const h = await call(NET.world, SEL.status + addr(account || ZERO));
    const s = {
      alive: big(h, 0), blue: big(h, 1), pendingAlive: big(h, 2), pendingBlue: big(h, 3), running: big(h, 4),
      epoch: num(h, 5), season: num(h, 6), pot: big(h, 7), fuel: big(h, 8), myTeam: num(h, 9), myPlaced: num(h, 10), job: null,
    };
    if (s.running > 0n) {
      const id = s.running - 1n;
      const j = await call(NET.overclock, SEL.jobs + word(id));
      s.job = { id, claimant: '0x' + slot(j, 13).slice(24), claimedAt: num(j, 17), challenged: num(j, 18) > 0, finalized: num(j, 19) === 1 };
      if (!S || S.window == null) s.window = num(await call(NET.overclock, SEL.window), 0);
      else s.window = S.window;
    }
    if (s.myTeam) team = s.myTeam;
    return s;
  }

  // the board as 0 (dead) / 1 (red) / 2 (blue), from the contract's bitmasks
  const cellsOf = (aliveMask, blueMask) => Array.from({ length: N }, (_, k) => ((aliveMask >> BigInt(k)) & 1n ? ((blueMask >> BigInt(k)) & 1n ? BLUE : RED) : 0));
  // the plain-JS rule of the world circuit (src/world.js worldStep): Life, and a newborn takes its parents' majority colour
  function step(cells) {
    const out = new Array(N).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let live = 0, blues = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const v = cells[((y + dy + H) % H) * W + ((x + dx + W) % W)];
        if (v) live++;
        if (v === BLUE) blues++;
      }
      const self = cells[y * W + x];
      if (self && (live === 2 || live === 3)) out[y * W + x] = self;
      else if (!self && live === 3) out[y * W + x] = blues >= 2 ? BLUE : RED;
    }
    return out;
  }
  // what the next epoch starts from: the board with the bought cells dropped on
  function nextStart(s) {
    const board = cellsOf(s.alive, s.blue), pend = cellsOf(s.pendingAlive, s.pendingBlue);
    return board.map((v, k) => pend[k] || v);
  }

  // ------------------------------------------------------------ drawing
  function draw() {
    if (!S) return;
    const now = cellsOf(S.alive, S.blue), pend = cellsOf(S.pendingAlive, S.pendingBlue);
    let shown = now;
    if (ahead > 0) { shown = nextStart(S); for (let g = 0; g < ahead; g++) shown = step(shown); }
    const grid = $('wGrid');
    if (!grid.children.length) {
      for (let k = 0; k < N; k++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.k = k;
        b.setAttribute('aria-label', `cell ${k % W + 1}, ${Math.floor(k / W) + 1}`);
        grid.appendChild(b);
      }
    }
    for (let k = 0; k < N; k++) {
      const el = grid.children[k];
      const v = shown[k];
      el.className = (v === RED ? 'r' : v === BLUE ? 'b' : '') + (ahead === 0 && pend[k] ? ' p' + pend[k] : '') + (picked.has(k) ? ' pick t' + team : '');
      el.disabled = ahead > 0 || !!pend[k];
    }
    const sc = (cells) => [cells.filter((v) => v === RED).length, cells.filter((v) => v === BLUE).length];
    const [r, b] = sc(now);
    $('wRed').textContent = r;
    $('wBlue').textContent = b;
    const lead = $('wLead');
    lead.className = 'lead ' + (r > b ? 'r' : b > r ? 'b' : '');
    lead.textContent = r > b ? 'Red leads' : b > r ? 'Blue leads' : r ? 'Level' : 'Empty board';
    const gen = S.epoch * NET.epochBeats;
    $('wSeason').innerHTML = `Season ${S.season + 1} · generation ${gen} of ${NET.epochBeats * NET.epochsPerSeason} · pot <b>${okb(S.pot)} OKB</b>`;
    $('wAheadLabel').textContent = ahead === 0 ? 'now' : `${ahead} generation${ahead > 1 ? 's' : ''} after the next drop`;
    if (ahead > 0) { const [fr, fb] = sc(shown); $('wForecast').textContent = `If nobody buys anything else: Red ${fr}, Blue ${fb}.`; } else $('wForecast').textContent = '';
    drawTeams();
    drawBuy();
    drawEpoch();
  }

  function drawTeams() {
    const locked = S && S.myTeam;
    for (const t of [RED, BLUE]) {
      const el = $('wTeam' + t);
      el.setAttribute('aria-pressed', String(team === t));
      el.disabled = !!locked && locked !== t;
    }
    $('wTeamNote').textContent = locked ? `You are ${TEAM[locked]} this season, with ${S.myPlaced} cell${S.myPlaced === 1 ? '' : 's'} bought.` : 'You stay on one team for the whole season.';
  }

  function drawBuy() {
    const n = picked.size;
    const cost = BigInt(NET.cellPrice) * BigInt(n);
    $('wBuy').disabled = !n || busy;
    $('wBuy').textContent = n ? `Buy ${n} ${TEAM[team]} cell${n > 1 ? 's' : ''} for ${okb(cost)} OKB` : 'Tap empty or enemy cells to pick them';
    $('wBuy').className = 'btn primary t' + team;
    $('wPickNote').textContent = n >= MAX ? `${MAX} cells is the most in one go.` : n ? 'Half goes to the season pot, half pays for running the world.' : '';
  }

  function drawEpoch() {
    const el = $('wEpoch'), btn = $('wAdvance');
    const empty = S.alive === 0n && S.pendingAlive === 0n;
    let text, can = false;
    if (S.job) {
      const j = S.job, jl = `<a href="#board">Overclock job ${j.id}</a>`;
      if (j.finalized) { text = `Generations ${S.epoch * NET.epochBeats + 1}–${(S.epoch + 1) * NET.epochBeats} are final in ${jl}. The world can move on.`; can = true; }
      else if (j.claimant === ZERO) text = `Generations ${S.epoch * NET.epochBeats + 1}–${(S.epoch + 1) * NET.epochBeats} are running off-chain as ${jl}, waiting for an operator to claim the result.`;
      else {
        const left = j.claimedAt + S.window - Math.floor(Date.now() / 1000);
        text = j.challenged ? `${jl} was challenged: the contract is narrowing the dispute down to one gate.`
          : left > 0 ? `${jl} is claimed by <a href="${NET.explorer}/address/${j.claimant}" target="_blank" rel="noopener">${short(j.claimant)}</a>. Anyone can prove it wrong for another ${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s.`
          : `${jl}'s challenge window is over; it is final once someone sends the finalize transaction.`;
      }
    } else if (empty) text = 'The board is empty. Buy the first cells and the season starts.';
    else { text = 'Cells are waiting. The next epoch starts when someone moves the world on.'; can = true; }
    if (S.epoch === NET.epochsPerSeason - 1 && S.job) text += ' This is the last epoch of the season.';
    el.innerHTML = text;
    btn.disabled = !can || !account || busy;
    $('wFuel').textContent = `Whoever moves it on earns ${okb(NET.keeperTip)} OKB. Fuel left: ${okb(S.fuel)} OKB.`;
  }

  async function drawSeasons() {
    const el = $('wSeasons');
    if (!S || S.season === 0) { el.innerHTML = '<p class="label">No season has finished yet.</p>'; return; }
    const rows = [];
    for (let s = S.season - 1; s >= Math.max(0, S.season - 5); s--) {
      const h = await call(NET.world, SEL.seasonInfo + word(s));
      const info = { pot: big(h, 0), redPlaced: num(h, 1), bluePlaced: num(h, 2), winner: num(h, 3), red: num(h, 4), blue: num(h, 5) };
      let mine = '';
      if (account) {
        const [t, p, c] = await Promise.all([SEL.teamOf, SEL.placedBy, SEL.claimed].map((sel) => call(NET.world, sel + word(s) + addr(account))));
        const myT = num(t, 0), myP = num(p, 0), done = num(c, 0) === 1;
        if (myT && info.winner === myT) {
          const share = (info.pot * BigInt(myP)) / BigInt(myT === RED ? info.redPlaced : info.bluePlaced);
          mine = done ? `<span class="tag ok">you were paid ${okb(share)} OKB</span>` : `<button type="button" class="btn primary" data-claim="${s}">Claim ${okb(share)} OKB</button>`;
        } else if (myT) mine = `<span class="label">you played ${TEAM[myT]}</span>`;
      }
      const head = info.winner ? `<b class="${info.winner === RED ? 'tr' : 'tb'}">${TEAM[info.winner]} won</b>` : '<b>A draw</b>, the pot rolled over';
      rows.push(`<li><span>Season ${s + 1}</span> ${head} · Red ${info.red}, Blue ${info.blue} · pot ${okb(info.pot)} OKB ${mine}</li>`);
    }
    el.innerHTML = `<ul class="seasons">${rows.join('')}</ul>`;
    for (const b of el.querySelectorAll('[data-claim]')) b.onclick = () => send(SEL.claim + word(b.dataset.claim), 0n, 'Claiming your share…', 'Paid.');
  }

  // ------------------------------------------------------------ wallet (as in run.js)
  const found = new Map();
  addEventListener('eip6963:announceProvider', (e) => { found.set(e.detail.info.uuid, e.detail); drawWallet(); });
  dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => {
    if (!found.size) {
      if (window.okxwallet) found.set('okx', { info: { name: 'OKX Wallet', icon: '' }, provider: window.okxwallet });
      else if (window.ethereum) found.set('injected', { info: { name: 'Browser wallet', icon: '' }, provider: window.ethereum });
    }
    drawWallet();
  }, 400);
  function drawWallet() {
    const el = $('wWallet');
    if (account) { el.innerHTML = `<span class="tag ok">${esc(walletName)}</span> <code>${short(account)}</code>`; return; }
    if (!found.size) {
      const okx = 'https://www.okx.com/download?deeplink=' + encodeURIComponent('okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(location.href));
      el.innerHTML = `<a class="btn" href="${okx}">Open in OKX Wallet to play</a>`;
      return;
    }
    el.innerHTML = '';
    for (const d of found.values()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.innerHTML = (d.info.icon ? `<img alt="" src="${esc(d.info.icon)}">` : '') + 'Connect ' + esc(d.info.name);
      b.onclick = () => connect(d);
      el.appendChild(b);
    }
  }
  async function ensureChain() {
    if (Number(await wallet.request({ method: 'eth_chainId' })) === NET.chainId) return;
    try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NET.chain.chainId }] }); }
    catch (e) {
      if (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902)) await wallet.request({ method: 'wallet_addEthereumChain', params: [NET.chain] });
      else throw e;
    }
  }
  async function connect(d) {
    try {
      wallet = d.provider; walletName = d.info.name;
      const [a] = await wallet.request({ method: 'eth_requestAccounts' });
      await ensureChain();
      account = a;
      drawWallet();
      await refresh();
      drawSeasons();
    } catch (e) { setStatus(e.message || String(e), true); }
  }

  // ------------------------------------------------------------ transactions
  function setStatus(text, bad) { const s = $('wStatus'); s.innerHTML = text; s.classList.toggle('bad', !!bad); }
  async function send(data, value, waiting, done) {
    if (!account) return setStatus('Connect a wallet first.', true);
    busy = true; draw();
    try {
      await ensureChain();
      setStatus('Approve it in your wallet…');
      const tx = { from: account, to: NET.world, data, value: '0x' + value.toString(16) };
      const gas = BigInt(await rpc('eth_estimateGas', [tx]));
      const hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ ...tx, gas: '0x' + ((gas * 13n) / 10n).toString(16) }] });
      setStatus(waiting);
      let rc = null;
      for (let i = 0; i < 120 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (!rc) await sleep(1500); }
      if (!rc) throw new Error('Sent, but not seen on-chain yet. Check your wallet.');
      if (rc.status !== '0x1') throw new Error('The transaction failed on-chain.');
      setStatus(`${done} <a href="${NET.explorer}/tx/${hash}" target="_blank" rel="noopener">See it on OKLink</a>`);
      return rc;
    } catch (e) {
      setStatus(e.code === 4001 ? 'You declined it in your wallet. Nothing was sent.' : reason(e), true);
      return null;
    } finally {
      busy = false;
      await refresh();
      drawSeasons();
    }
  }
  const REASONS = { taken: 'Someone bought one of those cells for the next epoch first.', 'one team a season': 'You are on the other team this season.', fuel: 'The world is out of fuel. Anyone can top it up.', 'empty world': 'There is nothing on the board to run.' };
  function reason(e) {
    const m = (e && (e.message || e.data?.message)) || String(e);
    for (const [k, v] of Object.entries(REASONS)) if (m.includes(k)) return v;
    return m;
  }
  async function buy() {
    const mask = [...picked].reduce((m, k) => m | (1n << BigInt(k)), 0n);
    const n = picked.size;
    const rc = await send(SEL.place + word(team) + word(mask), BigInt(NET.cellPrice) * BigInt(n), 'Buying your cells…', `Bought ${n} cell${n > 1 ? 's' : ''}. They drop onto the board when the next epoch starts.`);
    if (rc) { picked.clear(); draw(); }
  }

  // ------------------------------------------------------------ wire up
  async function refresh() {
    try { S = await read(); draw(); }
    catch (e) { setStatus(`Couldn't read the world: ${esc(e.message || e)}`, true); }
  }
  $('wGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const k = Number(b.dataset.k);
    if (picked.has(k)) picked.delete(k);
    else if (picked.size < MAX) picked.add(k);
    draw();
  });
  for (const t of [RED, BLUE]) $('wTeam' + t).addEventListener('click', () => { team = t; draw(); });
  $('wBuy').addEventListener('click', buy);
  $('wAdvance').addEventListener('click', async () => {
    const was = S.season, last = S.job && S.epoch === NET.epochsPerSeason - 1;
    const rc = await send(SEL.advance, 0n, 'Moving the world on…', last ? 'Done: the season is over.' : 'Done: the next epoch is posted as an Overclock job.');
    if (rc && S.season !== was) setStatus(`Season ${was + 1} is over. The result is below${NET.container ? ', and the world announced it over TapeSend' : ''}. <a href="${NET.explorer}/tx/${rc.transactionHash}" target="_blank" rel="noopener">See it on OKLink</a>`);
  });
  $('wAhead').max = String(NET.epochBeats);
  $('wAhead').addEventListener('input', () => { ahead = Number($('wAhead').value); draw(); });
  $('wContract').href = `${NET.explorer}/address/${NET.world}`;
  $('wNet').textContent = NET.name;
  if (NET.container) $('wContainer').innerHTML = ` · the world's own account <a href="${NET.explorer}/address/${NET.container}" target="_blank" rel="noopener">${short(NET.container)}</a> posts every epoch and announces each season over TapeSend`;
  $('wRules').textContent = `Every ${NET.epochBeats} generations are one Overclock job; ${NET.epochsPerSeason} jobs make a season. A cell costs ${okb(NET.cellPrice)} OKB.`;

  let timer = null;
  const live = () => location.hash.split('?')[0] === '#world';
  async function tick() {
    if (!live()) { timer = null; return; }
    await refresh();
    timer = setTimeout(tick, 5000);
  }
  const start = () => { if (live() && !timer) { tick(); drawSeasons(); } };
  addEventListener('hashchange', start);
  start();
})();
