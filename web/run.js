// "Run a job": post a ready-made machine as an Overclock job from the browser, approve it in OKX Wallet (or any
// injected wallet), then watch an operator claim it, the challenge window run out and the result finalize, and
// check that result with the TAP-02 evaluator in this page. No libraries: JSON-RPC and ABI by hand, like board.js.
//
// Runs against the X Layer testnet playground (deployments/1952.json, inlined as #run-config by
// scripts/build-web.js), where the hosted testnet MCP server runs an operator. Mainnet joins once the fixed
// contract is redeployed and an operator runs there.
(function () {
  const $ = (id) => document.getElementById(id);
  let CFG = null;
  try { CFG = JSON.parse($('run-config').textContent); } catch (e) { /* not inlined */ }
  if (!CFG) { $('run').querySelector('.runapp').innerHTML = '<p class="empty">This page was built without a network to post to.</p>'; return; }
  const NET = CFG.networks[CFG.default];
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SEL = { postJob: '0x89fbb96e', jobs: '0x180aedf3', window: '0x461645bf', netlist: '0x3fc4be56', info: '0x084d60f1' };
  const JOB_POSTED = '0xd521bb07d01dfe38c9ddc989b6cbe19f6b408f2a298e263da79cd3bbc5278f4d';
  const PATTERNS = { glider: '.O./..O/OOO', lwss: '.O..O/O..../O...O/OOOO.', rpentomino: '.OO/OO./.O.', toad: '.OOO/OOO.', blinker: 'OOO' };

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
  const slot = (h, i) => h.slice(2 + 64 * i, 66 + 64 * i);
  const num = (h, i) => Number(BigInt('0x' + slot(h, i)));
  const bytesAt = (h, i) => { const off = num(h, i) * 2; const len = Number(BigInt('0x' + h.slice(2 + off, 66 + off))); return '0x' + h.slice(66 + off, 66 + off + 2 * len); };
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const dyn = (hex) => { const h = hex.slice(2); return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); };
  const readJob = async (jobId) => {
    const h = await call(NET.overclock, SEL.jobs + word(jobId));
    return { claimant: '0x' + slot(h, 13).slice(24), outputs: bytesAt(h, 15), newState: bytesAt(h, 16), claimedAt: num(h, 17), challenged: num(h, 18) > 0, finalized: num(h, 19) === 1 };
  };

  // ------------------------------------------------------------ machines
  const lifeState = (pattern) => {
    const cells = new Array(64).fill(0);
    PATTERNS[pattern].split('/').forEach((row, dy) => [...row].forEach((ch, dx) => { if (ch === 'O') cells[(1 + dy) * 8 + 1 + dx] = 1; }));
    return TAP02.bytesToHex(TAP02.pack(cells));
  };
  const nib = (bits, k) => bits.slice(13 + 4 * k, 17 + 4 * k).reduce((v, b, i) => v | (b << i), 0);
  const MACHINES = {
    life: {
      id: NET.machines.life, state: () => lifeState($('runPattern').value), beats: () => Number($('runGens').value),
      what: (b) => `${fmt(b)} generation${b > 1 ? 's' : ''} of Life`,
      show: (stateHex) => drawBoard(TAP02.unpack(TAP02.hexToBytes(stateHex), 64)),
    },
    cpu: {
      id: NET.machines.cpu, state: () => CFG.cpuState, beats: () => 16 * Number($('runPasses').value),
      what: (b) => `${fmt(b)} beats of the 4-bit CPU`,
      show: (stateHex, start) => { const s = TAP02.unpack(TAP02.hexToBytes(stateHex), 205); const a = nib(s, 0) | (nib(s, 1) << 4), b = nib(s, 2) | (nib(s, 3) << 4); return `<div class="fib"><span class="label">RAM ${start ? 'at the start' : 'after the run'}</span><b>a = ${a}, b = ${b}</b><span class="label">${start ? 'the first two Fibonacci numbers' : 'the last two Fibonacci numbers it computed, mod 256'}</span></div>`; },
    },
  };
  let machine = 'life';
  function drawBoard(cells) {
    return `<div class="lifegrid" role="img" aria-label="8 by 8 board">${cells.map((v) => `<i${v ? ' class="on"' : ''}></i>`).join('')}</div>`;
  }
  function preview() {
    const m = MACHINES[machine];
    for (const k of Object.keys(MACHINES)) { $('pick-' + k).setAttribute('aria-pressed', String(k === machine)); $('opts-' + k).hidden = k !== machine; }
    $('runStart').innerHTML = `<span class="label">Starting state</span>${m.show(m.state(), true)}`;
    const b = m.beats();
    $('runSummary').textContent = `${m.what(b)} on circuit #${m.id}. Fee ${$('runFee').value} test OKB plus a little gas.`;
  }

  // ------------------------------------------------------------ wallet
  const found = new Map();
  let wallet = null, walletName = '', account = null;
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
    const el = $('runWallet');
    if (account) {
      el.innerHTML = `<span class="tag ok">${esc(walletName)} connected</span> <code>${short(account)}</code> <span class="label" id="runBal"></span>`;
      balance();
      return;
    }
    if (!found.size) {
      const u = location.href;
      const okx = 'https://www.okx.com/download?deeplink=' + encodeURIComponent('okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(u));
      el.innerHTML = `<p class="muted">No wallet in this browser. On a phone, open this page in OKX Wallet; on a computer, install the OKX Wallet or MetaMask extension and reload.</p><div class="row"><a class="btn" href="${okx}">Open in OKX Wallet</a></div>`;
      return;
    }
    el.innerHTML = '<div class="row"></div>';
    for (const d of found.values()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.innerHTML = (d.info.icon ? `<img alt="" src="${esc(d.info.icon)}">` : '') + 'Connect ' + esc(d.info.name);
      b.onclick = () => connect(d);
      el.firstChild.appendChild(b);
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
      $('runPost').disabled = false;
    } catch (e) { setStatus(e.message || String(e), true); }
  }
  async function balance() {
    try {
      const wei = BigInt(await rpc('eth_getBalance', [account, 'latest']));
      const okb = Number(wei) / 1e18;
      $('runBal').innerHTML = `${okb.toFixed(4)} test OKB` + (okb < 0.001 ? ` · <a href="${NET.faucet}" target="_blank" rel="noopener">get free test OKB</a>` : '');
    } catch (e) { /* balance is a nicety */ }
  }

  // ------------------------------------------------------------ post and follow
  function setStatus(text, bad) { const s = $('runStatus'); s.textContent = text; s.classList.toggle('bad', !!bad); }
  const steps = ['posted', 'claimed', 'window', 'finalized', 'checked'];
  function stepTo(k, detail) {
    const i = steps.indexOf(k);
    steps.forEach((s, j) => { const li = $('st-' + s); li.className = j < i ? 'done' : j === i ? 'now' : ''; });
    if (detail != null) $('sd-' + k).innerHTML = detail;
  }
  const txLink = (h, label) => `<a href="${NET.explorer}/tx/${h}" target="_blank" rel="noopener">${label || short(h)}</a>`;

  async function post() {
    const m = MACHINES[machine], beats = m.beats(), state = m.state();
    const fee = $('runFee').value.trim();
    if (!/^\d*\.?\d+$/.test(fee)) return setStatus('The fee is an amount of OKB, like 0.0001.', true);
    const value = '0x' + BigInt(Math.round(Number(fee) * 1e18)).toString(16);
    const data = SEL.postJob + '000000000000000000000000' + NET.processor.slice(2).toLowerCase() + word(m.id) + word(192) + word(192 + 32) + word(beats) + word(0) + dyn('0x') + dyn(state);
    $('runPost').disabled = true;
    $('runTrack').hidden = false;
    ['posted', 'claimed', 'window', 'finalized', 'checked'].forEach((s) => { $('sd-' + s).innerHTML = ''; });
    $('runResult').innerHTML = '';
    try {
      await ensureChain();
      setStatus('Approve the job in your wallet…');
      stepTo('posted');
      const hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: account, to: NET.overclock, value, data }] });
      setStatus('Waiting for X Layer to include it…');
      let rc = null;
      for (let i = 0; i < 120 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (!rc) await sleep(1500); }
      if (!rc) throw new Error('The transaction was sent but not seen yet. Check your wallet for its status.');
      if (rc.status !== '0x1') throw new Error('The transaction failed on-chain.');
      const log = rc.logs.find((l) => l.topics[0] === JOB_POSTED && l.address.toLowerCase() === NET.overclock.toLowerCase());
      const jobId = Number(BigInt(log.topics[1]));
      history.replaceState(null, '', `#run?job=${jobId}`);
      stepTo('claimed');
      $('sd-posted').innerHTML = `job ${jobId} · ${txLink(hash)}`;
      await follow(jobId, m, state, beats);
    } catch (e) {
      setStatus(e.code === 4001 ? 'You declined it in your wallet. Nothing was sent.' : (e.message || String(e)), true);
    } finally {
      $('runPost').disabled = !account;
      balance();
    }
  }

  // Poll the job until it is final, then check the result in this page.
  async function follow(jobId, m, state, beats) {
    fetch(NET.operatorUrl, { mode: 'no-cors' }).catch(() => {}); // wakes the hosted operator if it is asleep
    const win = num(await call(NET.overclock, SEL.window), 0);
    let j;
    setStatus('Waiting for an operator to run it and claim the result…');
    for (;;) {
      j = await readJob(jobId);
      if (j.claimant !== '0x0000000000000000000000000000000000000000') break;
      await sleep(4000);
    }
    stepTo('window');
    $('sd-claimed').innerHTML = `by <a href="${NET.explorer}/address/${j.claimant}" target="_blank" rel="noopener">${short(j.claimant)}</a>, with a bond`;
    for (;;) {
      j = await readJob(jobId);
      if (j.finalized) break;
      const left = j.claimedAt + win - Math.floor(Date.now() / 1000);
      $('sd-window').textContent = j.challenged ? 'a watcher challenged the claim: the dispute is running' : left > 0 ? `anyone can challenge for another ${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s` : 'window closed, waiting for the finalize transaction';
      setStatus(j.challenged ? 'A watcher disagreed. The contract is narrowing it down to one gate.' : 'The claim is public. If it were wrong, anyone could prove one gate wrong and take the bond.');
      await sleep(3000);
    }
    $('sd-window').textContent = 'closed without a valid challenge';
    stepTo('checked');
    $('sd-finalized').textContent = 'any contract can now read result(' + jobId + ')';
    $('runResult').innerHTML = `<span class="label">Final state on-chain</span>${m.show(j.newState)}`;
    setStatus('Checking the result in this page…');
    try {
      const c = await loadCircuit(NET.processor, m.id);
      let st = TAP02.unpack(TAP02.hexToBytes(state), c.nState), outs = [];
      for (let b = 0; b < beats; b++) { [st, outs] = TAP02.beat(c, st, []); if (b % 2000 === 1999) await sleep(0); }
      const ok = TAP02.bytesToHex(TAP02.pack(st)) === j.newState.toLowerCase() && TAP02.bytesToHex(TAP02.pack(outs)) === j.outputs.toLowerCase();
      $('sd-checked').innerHTML = ok ? '<span class="tag ok">matches this page\'s own run, bit for bit</span>' : '<span class="tag bad">differs from this page\'s run</span>';
      document.querySelector('#st-checked').className = 'done';
      setStatus(ok ? 'Done. You ran a job on X Layer without trusting the operator.' : 'The final result differs from the run in this page.', !ok);
    } catch (e) {
      $('sd-checked').textContent = `couldn't check it here: ${e.message || e}`;
      setStatus('');
    }
  }

  async function loadCircuit(cpu, id) {
    const raw = new Map(), key = (a, i) => `${a.toLowerCase()}:${BigInt(i)}`;
    const get = async (a, i) => {
      if (raw.has(key(a, i))) return;
      const [info, nl] = await Promise.all([call(a, SEL.info + word(i)), call(a, SEL.netlist + word(i))]);
      const r = { bytes: TAP02.hexToBytes(bytesAt(nl, 0)), nIn: num(info, 0), nOut: num(info, 1) };
      raw.set(key(a, i), r);
      for (const e of TAP02.decode(r.bytes, r.nIn)) if (e.op === TAP02.REF) await get(e.cpu, e.id);
    };
    await get(cpu, id);
    const done = new Map();
    const resolve = (a, i) => { const k = key(a, i); if (!done.has(k)) { const r = raw.get(k); if (!r) return null; done.set(k, TAP02.load(r.bytes, r.nIn, r.nOut, resolve)); } return done.get(k); };
    return resolve(cpu, id);
  }

  // ------------------------------------------------------------ wire up
  for (const k of Object.keys(MACHINES)) $('pick-' + k).addEventListener('click', () => { machine = k; preview(); });
  for (const id of ['runPattern', 'runGens', 'runPasses', 'runFee']) $(id).addEventListener('input', preview);
  $('runPost').addEventListener('click', post);
  // The hosted operator sleeps when idle; wake it as soon as someone opens this view.
  const wake = () => { if (location.hash.startsWith('#run')) fetch(NET.operatorUrl, { mode: 'no-cors' }).catch(() => {}); };
  addEventListener('hashchange', wake);
  wake();
  $('runNet').textContent = NET.name;
  $('runContract').href = `${NET.explorer}/address/${NET.overclock}`;
  preview();
})();
