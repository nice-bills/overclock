// "Your circuit": load any circuit taped out on X Layer mainnet, run it in this page with the TAP-02 evaluator
// (src/tap02.js, inlined as TAP02 by scripts/build-web.js), and compare what running it on-chain costs
// directly and through Overclock. Reads the chain over public JSON-RPC with no libraries, like board.js.
// The census of every circuit on mainnet (scripts/census.js) is inlined as #census-data.
//
// Links carry the circuit: #try?cpu=0x…&id=3&beats=1000 opens that circuit and runs it.
(function () {
  const $ = (id) => document.getElementById(id);
  const NODES = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'];
  const EXPLORER = 'https://www.oklink.com/x-layer';
  const GAS_PER_GATE = 2400; // direct step() on mainnet: 2,354–2,970 gas per flattened gate in our measurements
  const BLOCK_GAS = 210e6;
  const HONEST_MAX = 2244073; // the most an honest Overclock job has cost on mainnet (the 161K-gate digit net)
  const WORK_MAX = 60e6; // gate evaluations this page runs before it stops and says so
  const SEL = { netlist: '0x3fc4be56', info: '0x084d60f1', owner: '0x6352211e', name: '0x06fdde03', eval: '0x934d06ea', step: '0xe8281a1a' };
  const CHECK_GAS = 30e6; // one beat this size or smaller is also run by TapeOut itself, as a free eth_call
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  let census = null;
  try { census = JSON.parse($('census-data').textContent); } catch (e) { /* not inlined */ }

  // ------------------------------------------------------------ JSON-RPC
  let node = 0, nid = 0;
  async function rpc(method, params) {
    let err;
    for (let k = 0; k < NODES.length; k++) {
      const n = (node + k) % NODES.length;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 30000);
        const r = await fetch(NODES[n], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++nid, method, params }), signal: ctl.signal }).finally(() => clearTimeout(t));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = await r.json();
        if (b.error) throw new Error(b.error.message);
        node = n;
        return b.result;
      } catch (e) { err = e; }
    }
    throw err;
  }
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const slot = (h, i) => h.slice(2 + 64 * i, 66 + 64 * i);
  const bytesAt = (h, i) => { const off = Number(BigInt('0x' + slot(h, i))) * 2; const len = Number(BigInt('0x' + h.slice(2 + off, 66 + off))); return h.slice(66 + off, 66 + off + 2 * len); };
  const utf8 = (hex) => new TextDecoder().decode(new Uint8Array((hex.match(/../g) || []).map((x) => parseInt(x, 16))));

  // A circuit and every circuit it REFs, loaded with the evaluator.
  async function fetchCircuit(cpu, id, onNote) {
    const raw = new Map();
    const key = (a, i) => `${a.toLowerCase()}:${BigInt(i)}`;
    const get = async (a, i) => {
      const k = key(a, i);
      if (raw.has(k)) return;
      onNote(`Reading circuit #${i} of ${short(a)} from X Layer…`);
      const [info, nl] = await Promise.all([call(a, SEL.info + word(i)), call(a, SEL.netlist + word(i))]);
      if (!info || info === '0x') throw new Error(`${short(a)} #${i} is not a TapeOut circuit`);
      const r = { bytes: TAP02.hexToBytes('0x' + bytesAt(nl, 0)), nIn: Number(BigInt('0x' + slot(info, 0))), nOut: Number(BigInt('0x' + slot(info, 1))), nState: Number(BigInt('0x' + slot(info, 2))), gates: Number(BigInt('0x' + slot(info, 3))) };
      raw.set(k, r);
      for (const e of TAP02.decode(r.bytes, r.nIn)) if (e.op === TAP02.REF) await get(e.cpu, e.id);
    };
    await get(cpu, id);
    const loaded = new Map();
    const resolve = (a, i) => {
      const k = key(a, i);
      if (!loaded.has(k)) { const r = raw.get(k); if (!r) return null; loaded.set(k, TAP02.load(r.bytes, r.nIn, r.nOut, resolve)); }
      return loaded.get(k);
    };
    const top = raw.get(key(cpu, id));
    const [owner, name] = await Promise.all([call(cpu, SEL.owner + word(id)).catch(() => null), call(cpu, SEL.name).catch(() => null)]);
    return {
      c: resolve(cpu, id), gates: top.gates, refs: raw.size - 1,
      owner: owner && owner.length >= 66 ? '0x' + owner.slice(26, 66) : null,
      name: name && name.length > 2 ? utf8(bytesAt(name, 0)).replace(/\0/g, '') : '',
    };
  }

  // ------------------------------------------------------------ bits
  const bitsFrom = (hex, n) => {
    const h = (hex || '').trim().replace(/^0x/i, '');
    if (h && !/^[0-9a-f]*$/i.test(h)) throw new Error('inputs and state are hex, like 0x01ff');
    return TAP02.unpack(TAP02.hexToBytes('0x' + (h.length % 2 ? '0' + h : h)), n);
  };
  const hexOf = (bits) => bits.length ? TAP02.bytesToHex(TAP02.pack(bits)) : '0x';
  const randomHex = (n) => hexOf(Array.from({ length: n }, () => (Math.random() < 0.5 ? 1 : 0)));

  // ------------------------------------------------------------ view
  const form = $('tryForm'), out = $('tryOut'), note = $('tryNote');
  let loaded = null; // { cpu, id, ...fetchCircuit }

  function renderCensus() {
    if (!census) { $('censusSpecs').hidden = true; $('tryList').closest('section').hidden = true; return; }
    const s = census.summary;
    $('censusSpecs').innerHTML = [
      [fmt(s.circuits), 'circuits on X Layer mainnet'],
      [fmt(s.tooBigForABlock), 'too big to run once in a block'],
      [fmt(s.machinesHeldBack), 'machines a block can\'t run 1,000 beats of'],
      [fmt(s.ownersToReach), 'holders of those circuits'],
    ].map(([v, l]) => `<div class="spec"><span class="v">${v}</span><span class="label">${l}</span></div>`).join('');
    $('censusNote').textContent = `Census of all ${fmt(s.processors)} processors at block ${fmt(s.block)} (scripts/census.js).`;
    $('tryList').innerHTML = census.featured.map((c) => {
      const beat = c.gates * GAS_PER_GATE;
      const reach = beat > BLOCK_GAS ? `<span class="tag bad">${(beat / BLOCK_GAS).toFixed(2)} blocks per run</span>` : `<span class="tag warn">${fmt(Math.floor(BLOCK_GAS / beat))} beats per block</span>`;
      return `<tr><td><b>${esc(c.processorName || short(c.processor))}</b> <span class="muted">#${c.id}</span></td><td class="num">${fmt(c.gates)}</td><td class="num">${fmt(c.nState)}</td><td>${reach}</td><td><button type="button" data-cpu="${c.processor}" data-id="${c.id}" data-beats="${c.nState ? 1000 : 1}">Run it</button></td></tr>`;
    }).join('');
  }

  function setNote(text, bad) { note.textContent = text; note.classList.toggle('bad', !!bad); }

  async function run(cpu, id, beats, inputsHex, stateHex) {
    out.hidden = true;
    form.querySelector('button[type=submit]').disabled = true;
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(cpu)) throw new Error('The processor is a 0x address of 40 hex digits.');
      if (!(id >= 1)) throw new Error('Circuit IDs start at 1.');
      if (!loaded || loaded.cpu !== cpu.toLowerCase() || loaded.id !== id) loaded = { cpu: cpu.toLowerCase(), id, ...(await fetchCircuit(cpu, id, setNote)) };
      const { c } = loaded;
      beats = Math.max(1, Math.floor(beats || 1));
      if (c.nState === 0) beats = 1;
      if (inputsHex == null || inputsHex === '') { inputsHex = randomHex(c.nIn); $('tryInputs').value = inputsHex; }
      const ins = bitsFrom(inputsHex, c.nIn);
      let state = bitsFrom(stateHex, c.nState);
      const work = c.nGates * beats;
      const ranBeats = Math.min(beats, Math.max(1, Math.floor(WORK_MAX / Math.max(1, c.nGates))));
      setNote(`Running ${fmt(ranBeats)} beat${ranBeats > 1 ? 's' : ''} of ${fmt(c.nGates)} gates in this page…`);
      const t0 = performance.now();
      let outs = [], first = null;
      const st0 = state;
      for (let b = 0; b < ranBeats;) {
        const until = Math.min(ranBeats, b + Math.max(1, Math.floor(400000 / Math.max(1, c.nGates))));
        for (; b < until; b++) { [state, outs] = TAP02.beat(c, state, ins); if (!first) first = [state, outs]; }
        if (b < ranBeats) { setNote(`Running in this page: beat ${fmt(b)} of ${fmt(ranBeats)}…`); await new Promise((r) => setTimeout(r)); }
      }
      const ms = performance.now() - t0;
      show({ cpu, id, beats, ranBeats, ms, ins: inputsHex, outs, state, work, stateHex: c.nState ? hexOf(st0) : '' });
      setNote('');
      check(cpu, id, c, st0, ins, first);
      history.replaceState(null, '', `#try?cpu=${cpu}&id=${id}&beats=${beats}`);
    } catch (e) {
      setNote(e.message || String(e), true);
    } finally {
      form.querySelector('button[type=submit]').disabled = false;
    }
  }

  // Run the first beat through TapeOut's own eval()/step() on mainnet and say whether it agrees.
  async function check(cpu, id, c, st0, ins, [st1, out1]) {
    const el = $('tryCheck');
    if (c.nGates * GAS_PER_GATE > CHECK_GAS) { el.innerHTML = `<span class="tag same">too big for TapeOut to run even as a free call</span>`; return; }
    el.innerHTML = `<span class="tag same">checking beat 1 against TapeOut's own ${c.nState ? 'step' : 'eval'}() on mainnet…</span>`;
    const dyn = (hex) => { const h = hex.slice(2); return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); };
    try {
      let ok;
      if (c.nState) {
        const a = dyn(hexOf(st0)), b = dyn(hexOf(ins));
        const r = await call(cpu, SEL.step + word(id) + word(96) + word(96 + a.length / 2) + a + b);
        ok = bytesAt(r, 0) === hexOf(st1).slice(2) && bytesAt(r, 1) === hexOf(out1).slice(2);
      } else {
        const r = await call(cpu, SEL.eval + word(id) + word(64) + dyn(hexOf(ins)));
        ok = bytesAt(r, 0) === hexOf(out1).slice(2);
      }
      el.innerHTML = ok ? `<span class="tag ok">beat 1 matches TapeOut's own ${c.nState ? 'step' : 'eval'}() on mainnet, bit for bit</span>` : `<span class="tag bad">beat 1 differs from TapeOut's ${c.nState ? 'step' : 'eval'}(): please open an issue</span>`;
    } catch (e) {
      el.innerHTML = `<span class="tag same">couldn't check against TapeOut: ${esc(e.message || e)}</span>`;
    }
  }

  function show(r) {
    const { c, gates, refs, owner, name } = loaded;
    const direct = r.work * GAS_PER_GATE;
    const blocks = direct / BLOCK_GAS;
    const fits = blocks <= 1;
    $('tryTitle').innerHTML = `${esc(name || 'Circuit')} <span class="dim">#${r.id}</span>`;
    $('tryMeta').innerHTML = `<a href="${EXPLORER}/address/${r.cpu}">${short(r.cpu)}</a>` + (owner ? ` · held by <a href="${EXPLORER}/address/${owner}">${short(owner)}</a>` : '') + ` · ${fmt(c.nIn)} in, ${fmt(c.nOut)} out` + (refs ? ` · REFs ${refs} other circuit${refs > 1 ? 's' : ''}` : '');
    $('trySpecs').innerHTML = [
      [fmt(gates), 'gates per beat'],
      [fmt(c.nState), 'state bits'],
      [fmt(r.beats), r.beats > 1 ? 'beats' : 'beat'],
      [r.ms < 1000 ? `${Math.max(1, Math.round(r.ms))}<small> ms</small>` : `${(r.ms / 1000).toFixed(1)}<small> s</small>`, r.ranBeats < r.beats ? `to run ${fmt(r.ranBeats)} beats here` : 'to run it in this page'],
    ].map(([v, l]) => `<div class="spec"><span class="v">${v}</span><span class="label">${l}</span></div>`).join('');
    const scale = Math.log10(Math.max(direct, HONEST_MAX) * 1.4);
    const bar = (g) => `${Math.max(2, (Math.log10(Math.max(g, 10)) / scale) * 100).toFixed(1)}%`;
    $('tryGas').innerHTML = `
      <div class="cost"><span>Directly through TapeOut's <code>${c.nState ? 'step' : 'eval'}()</code></span><div class="track"><i class="${fits ? '' : 'over'}" style="width:${bar(direct)}"></i></div><b>${fmt(direct)} gas</b><span class="tag ${fits ? 'ok' : 'bad'}">${fits ? 'fits one transaction' : `${blocks < 10 ? blocks.toFixed(2) : fmt(blocks)} blocks: can't be sent`}</span></div>
      <div class="cost"><span>Through Overclock, nobody cheats</span><div class="track"><i style="width:${bar(HONEST_MAX)}"></i></div><b>≤ ${fmt(HONEST_MAX)} gas</b><span class="tag ok">${direct > HONEST_MAX ? `${fmt(direct / HONEST_MAX)}× less, at least` : 'flat however many beats'}</span></div>`;
    $('tryGasNote').textContent = `Direct cost: ${fmt(gates)} gates × ${fmt(r.beats)} beat${r.beats > 1 ? 's' : ''} × ${fmt(GAS_PER_GATE)} gas, the lowest per-gate cost we measured on mainnet; a block holds ${fmt(BLOCK_GAS / 1e6)}M. Overclock's honest path is a claim and a finalize, and stays the same however many beats run: the three jobs we ran on mainnet cost 182K to 2.24M gas.`;
    const outHex = hexOf(r.outs), stHex = hexOf(r.state);
    $('tryResult').innerHTML = `<div id="tryCheck"></div><div><span class="label">Outputs${r.ranBeats < r.beats ? ` after beat ${fmt(r.ranBeats)}` : ''}</span><code>${outHex}</code></div>` + (c.nState ? `<div><span class="label">State after beat ${fmt(r.ranBeats)}</span><code>${stHex.length > 140 ? stHex.slice(0, 140) + '…' : stHex}</code></div>` : '');
    $('tryCut').hidden = r.ranBeats === r.beats;
    $('tryCut').textContent = `This page stops after ${fmt(r.ranBeats)} beats (${fmt(WORK_MAX / 1e6)}M gate evaluations). An operator runs all ${fmt(r.beats)} with the same evaluator.`;
    const stArg = r.stateHex && /[1-9a-f]/i.test(r.stateHex.slice(2)) ? ` state ${r.stateHex}` : '';
    $('tryPrompt').textContent = `Post an Overclock job for circuit ${r.id} on processor ${r.cpu}, ${fmt(r.beats)} beat${r.beats > 1 ? 's' : ''}, inputs ${r.ins}${stArg}. Tell me the fee first.`;
    $('tryCli').textContent = `node bin/overclock.js post --cpu ${r.cpu} --id ${r.id} --beats ${r.beats} --inputs ${r.ins}${stArg ? ` --state ${r.stateHex}` : ''} --fee 0.0002`;
    out.hidden = false;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run($('tryCpu').value.trim(), Number($('tryId').value), Number($('tryBeats').value), $('tryInputs').value.trim(), $('tryState').value.trim());
  });
  $('tryRandom').addEventListener('click', () => { if (loaded) { $('tryInputs').value = randomHex(loaded.c.nIn); form.requestSubmit(); } else $('tryInputs').value = ''; });
  $('tryList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cpu]');
    if (!b) return;
    $('tryCpu').value = b.dataset.cpu; $('tryId').value = b.dataset.id; $('tryBeats').value = b.dataset.beats; $('tryInputs').value = ''; $('tryState').value = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.requestSubmit();
  });
  for (const id of ['tryCopyPrompt', 'tryCopyLink']) $(id).addEventListener('click', async (e) => {
    const text = id === 'tryCopyLink' ? location.href : $('tryPrompt').textContent;
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = id === 'tryCopyLink' ? 'Copy link to this run' : 'Copy'; }, 1500); } catch (err) { /* clipboard blocked */ }
  });

  // Open a linked circuit when the view is #try?cpu=…&id=…
  function fromHash() {
    if (!location.hash.startsWith('#try')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if (!q.get('cpu')) return;
    $('tryCpu').value = q.get('cpu'); $('tryId').value = q.get('id') || '1'; $('tryBeats').value = q.get('beats') || '1';
    if (q.get('inputs')) $('tryInputs').value = q.get('inputs');
    if (q.get('state')) $('tryState').value = q.get('state');
    if (!loaded || loaded.cpu !== q.get('cpu').toLowerCase()) form.requestSubmit();
  }
  renderCensus();
  addEventListener('hashchange', fromHash);
  fromHash();
})();
