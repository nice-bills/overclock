// The Floor, a page per circuit (#c/<processor>/<id>), the owner lookup (#owner) and the landing counters.
// Two inputs, both inlined by scripts/build-web.js:
//   #census-data  docs/census.json: every stuck machine and miner on X Layer mainnet, in compact rows.
//   #runs-data    web/runs.json, the runner's index of runs and certificates (docs/runs-schema.md).
// When the page is served over HTTP it also fetches runs.json (or the URL in <meta name="runs-url">) and
// switches to that copy, so a fresh index updates the page with no rebuild. A circuit with no run is queued.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const GAS_PER_GATE = 2400, BLOCK_GAS = 210e6, GWEI = 0.02, EST_OC_GAS = 816083;
  const EXPLORER = 'https://www.oklink.com/x-layer';
  const STATUS = { queued: ['same', 'Queued'], running: ['warn', 'Running'], final: ['info', 'Final'], certified: ['ok', 'Certified'] };
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const big = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : fmt(n);
  const okb = (gas) => { const v = gas * GWEI * 1e-9; return v >= 1 ? fmt(v) : v >= 1e-3 ? v.toFixed(4) : v.toFixed(7).replace(/0+$/, ''); };
  const keyOf = (cpu, id) => `${String(cpu).toLowerCase()}:${Number(id)}`;
  const parse = (id) => { try { return JSON.parse($(id).textContent); } catch (e) { return null; } };

  // ------------------------------------------------------------ data
  const census = parse('census-data');
  let runsDoc = parse('runs-data');
  const circuits = new Map(); // key → { key, cpu, id, name, owner, nIn, nOut, nState, gates, kind, shape }
  const add = (c) => {
    const k = keyOf(c.cpu, c.id);
    if (circuits.has(k)) return circuits.get(k);
    const gates = c.gates || 0;
    const kind = gates * GAS_PER_GATE > BLOCK_GAS ? 'big' : c.name === 'FAB-Genisis' ? 'miner' : 'machine';
    const o = { key: k, cpu: c.cpu, id: Number(c.id), name: c.name || '', owner: c.owner || '', nIn: c.nIn || 0, nOut: c.nOut || 0, nState: c.nState || 0, gates, kind, shape: `${gates}/${c.nIn || 0}/${c.nOut || 0}/${c.nState || 0}`, inCensus: !!c.inCensus };
    circuits.set(k, o);
    return o;
  };
  if (census && census.machines) {
    const { procs, owners, rows } = census.machines;
    for (const [p, id, o, nIn, nOut, nState, gates] of rows) add({ cpu: procs[p].a, name: procs[p].n, id, owner: owners[o], nIn, nOut, nState, gates, inCensus: true });
  }

  let runsBy = new Map(), certsBy = new Map(), stats = { run: 0, certs: 0, steps: 0, runs: 0 };
  function index() {
    runsBy = new Map(); certsBy = new Map();
    const valid = runsDoc && runsDoc.schema === 1 && Array.isArray(runsDoc.runs);
    const runs = valid ? runsDoc.runs : [], certs = valid && Array.isArray(runsDoc.certificates) ? runsDoc.certificates : [];
    const touch = (c) => add({ cpu: c.processor, id: c.id, name: c.name, owner: c.owner, nIn: c.nIn, nOut: c.nOut, nState: c.nState, gates: c.gates });
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const r of runs) { if (!r.circuit) continue; touch(r.circuit); push(runsBy, keyOf(r.circuit.processor, r.circuit.id), r); }
    for (const x of certs) {
      if (!x.circuit) continue;
      touch(x.circuit); push(certsBy, keyOf(x.circuit.processor, x.circuit.id), x);
      for (const c of x.covers || []) push(certsBy, keyOf(c.processor, c.id), x);
    }
    const finals = runs.filter((r) => r.status === 'final');
    stats = { run: new Set(finals.map((r) => keyOf(r.circuit.processor, r.circuit.id))).size, runs: runs.length, certs: certs.filter((x) => x.status === 'certified').length, steps: finals.reduce((s, r) => s + (r.steps || 0), 0), valid };
  }
  const runsOf = (c) => runsBy.get(c.key) || [];
  const certsOf = (c) => certsBy.get(c.key) || [];
  function statusOf(c) {
    if (certsOf(c).some((x) => x.status === 'certified')) return 'certified';
    const rs = runsOf(c);
    if (rs.some((r) => r.status === 'final')) return 'final';
    return rs.length ? 'running' : 'queued';
  }
  const explorer = (chainId) => (runsDoc && runsDoc.networks && runsDoc.networks[chainId] && runsDoc.networks[chainId].explorer) || (Number(chainId) === 1952 ? `${EXPLORER}-testnet` : EXPLORER);
  const tag = (s) => `<span class="tag ${STATUS[s][0]}">${STATUS[s][1]}</span>`;
  const circuitHref = (c) => `#c/${c.cpu}/${c.id}`;
  const label = (c) => `${c.name || short(c.cpu)} #${c.id}`;

  // ------------------------------------------------------------ landing counters and the Floor
  let filter = 'all';
  function counters() {
    const total = circuits.size;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('cMachines', stats.valid ? fmt(stats.run) : '—');
    set('cTotal', fmt(total));
    set('cCerts', stats.valid ? fmt(stats.certs) : '—');
    set('cSteps', stats.valid ? big(stats.steps) : '—');
    const q = [...circuits.values()].reduce((n, c) => n + (statusOf(c) === 'queued'), 0);
    $('floorSpecs').innerHTML = [
      [stats.valid ? fmt(stats.run) : '—', `of ${fmt(total)} machines run`],
      [stats.valid ? fmt(stats.certs) : '—', 'certificates issued'],
      [stats.valid ? big(stats.steps) : '—', 'steps settled on X Layer'],
      [fmt(q), 'queued: nothing has run them yet'],
    ].map(([v, l]) => `<div class="spec"><span class="v">${v}</span><span class="label">${l}</span></div>`).join('');
  }

  function renderFloor() {
    const list = [...circuits.values()];
    const count = { queued: 0, running: 0, final: 0, certified: 0 };
    for (const c of list) count[statusOf(c)]++;
    $('floorLegend').innerHTML = [['queued', 'var(--cell-off)'], ['running', 'var(--warn)'], ['final', 'var(--blue)'], ['certified', 'var(--accent)']]
      .map(([s, col]) => `<span style="--k: ${col}">${STATUS[s][1].toLowerCase()} ${fmt(count[s])}</span>`).join('');
    const cell = (c) => { const s = statusOf(c); return `<a class="cell s-${s}" href="${circuitHref(c)}" title="${esc(label(c))} · ${fmt(c.gates)} gates · ${s}" aria-label="${esc(label(c))}, ${fmt(c.gates)} gates, ${s}"></a>`; };
    const miners = list.filter((c) => c.kind === 'miner'), machines = list.filter((c) => c.kind !== 'miner');
    let html = '';
    if (filter !== 'miner') {
      machines.sort((a, b) => b.gates - a.gates);
      html += `<section class="group"><div class="sec-head"><h2>Machines</h2><p class="label">${fmt(machines.length)} machines, biggest first</p></div><div class="cells">${machines.map(cell).join('')}</div></section>`;
    }
    if (filter !== 'machine') {
      const shapes = new Map();
      for (const c of miners) { if (!shapes.has(c.shape)) shapes.set(c.shape, []); shapes.get(c.shape).push(c); }
      const groups = [...shapes.values()].sort((a, b) => b.length - a.length || b[0].gates - a[0].gates);
      html += `<section class="group"><div class="sec-head"><h2>Miners, by shape</h2><p class="label">${fmt(miners.length)} FabX miner circuits in ${fmt(groups.length)} shapes. One certificate can cover a whole shape.</p></div>`
        + groups.map((g) => {
          const c0 = g[0], done = g.filter((c) => statusOf(c) === 'certified').length;
          return `<div class="shape"><div class="shapehead"><b>${fmt(c0.gates)} gates</b><span class="muted">${fmt(c0.nIn)} in · ${fmt(c0.nOut)} out · ${fmt(c0.nState)} state bits</span><span class="label">${fmt(g.length)} circuit${g.length > 1 ? 's' : ''}${done ? ` · ${fmt(done)} certified` : ''}</span></div><div class="cells">${g.map(cell).join('')}</div></div>`;
        }).join('') + '</section>';
    }
    $('floorGrid').innerHTML = html;
    for (const b of document.querySelectorAll('#floorFilters button')) b.setAttribute('aria-pressed', String(b.dataset.f === filter));
    const note = $('floorNote');
    if (census) note.textContent = `Circuits from the census of X Layer mainnet at block ${fmt(census.summary.block)}, plus anything the runner has run since. ${stats.valid ? `Runs index updated ${esc(runsDoc.updatedAt || 'unknown')}.` : 'No runs index loaded: every circuit shows as queued.'}`;
  }

  // ------------------------------------------------------------ a circuit
  function costs(c, run) {
    const beats = run ? run.beats : c.nState ? 1000 : 1;
    const direct = run && run.directGas ? run.directGas : c.gates * GAS_PER_GATE * beats;
    const oc = run && run.gas && run.gas.honestPath ? run.gas.honestPath : EST_OC_GAS;
    const top = Math.max(direct, oc), w = (g) => `max(2px, ${(g / top * 100).toFixed(4)}%)`;
    const ratio = direct / oc, blocks = direct / BLOCK_GAS;
    return `<div class="costs">
      <div class="cost"><span>Directly through TapeOut's <code>${c.nState ? 'step' : 'eval'}()</code></span><div class="track"><i class="${blocks > 1 ? 'over' : ''}" style="width:${w(direct)}"></i></div><b>${fmt(direct)} gas</b><span class="tag ${blocks > 1 ? 'bad' : 'warn'}">${blocks >= 1 ? `${blocks.toFixed(blocks < 10 ? 2 : 0)} blocks` : `${(blocks * 100).toFixed(1)}% of a block`} · ${okb(direct)} OKB</span></div>
      <div class="cost"><span>Through Overclock, nobody cheats${run ? '' : ' (estimate)'}</span><div class="track"><i style="width:${w(oc)}"></i></div><b>${run ? '' : '≈ '}${fmt(oc)} gas</b><span class="tag ${ratio >= 1 ? 'ok' : 'same'}">${ratio >= 1 ? `${fmt(ratio)}× less` : 'direct is cheaper here'} · ${okb(oc)} OKB</span></div>
    </div>
    <p class="label">${run ? `Measured: the job's post, claim and finalize. Direct is ${run.directGas ? 'the measured or estimated cost of' : 'gates × beats × 2,400 gas for'} ${fmt(beats)} beat${beats > 1 ? 's' : ''} through TapeOut.` : `Nothing has run this circuit yet, so this compares ${fmt(beats)} beat${beats > 1 ? 's' : ''} directly (gates × beats × 2,400 gas) with the honest path of our three mainnet jobs (0.6M to 2.2M gas, whatever the beats).`} OKB at ${GWEI} gwei.</p>`;
  }
  const txChips = (list, chainId) => list && list.length ? `<div class="txs">${list.map((t) => `<a href="${explorer(chainId)}/tx/${esc(t.tx)}" target="_blank" rel="noopener"><b>${esc(t.what)}</b> <span>${short(t.tx)}${t.gas ? ` · ${fmt(t.gas)} gas` : ''}</span></a>`).join('')}</div>` : '';

  function renderCircuit(cpu, id) {
    const el = $('circuitBody');
    const c = ADDR.test(cpu) ? circuits.get(keyOf(cpu, id)) : null;
    if (!c) {
      document.title = 'Overclock · Circuit';
      const link = ADDR.test(cpu) && id >= 1 ? `<a class="btn primary" href="#try?cpu=${esc(cpu)}&id=${id}&beats=1">Run it in your browser <span class="arr">→</span></a>` : '';
      el.innerHTML = `<div class="intro"><a class="back" href="#floor">← The Floor</a><h1>Circuit not on the Floor</h1><p>${ADDR.test(cpu) ? `${short(cpu)} #${esc(id)} isn't in the census or the runner's index. It may have been taped out after the census, or the link may be wrong.` : 'That link is not a processor address and circuit ID.'}</p></div>${link ? `<div class="cta">${link}</div>` : ''}`;
      return;
    }
    const st = statusOf(c), runs = runsOf(c), certs = certsOf(c);
    const run = runs.find((r) => r.status === 'final') || runs[runs.length - 1] || null;
    const chain = run ? run.chainId : 196;
    document.title = `Overclock · ${label(c)}`;
    const peers = [...circuits.values()].filter((x) => x.shape === c.shape).length;
    const beatGas = c.gates * GAS_PER_GATE;
    const reach = beatGas > BLOCK_GAS ? `One beat costs ${(beatGas / BLOCK_GAS).toFixed(2)} blocks of gas: TapeOut can't run it even once in a transaction.` : `TapeOut can run ${fmt(Math.floor(BLOCK_GAS / beatGas))} beat${Math.floor(BLOCK_GAS / beatGas) > 1 ? 's' : ''} in a block.`;
    const what = `${fmt(c.gates)} gates, ${fmt(c.nIn)} input${c.nIn === 1 ? '' : 's'}, ${fmt(c.nOut)} output${c.nOut === 1 ? '' : 's'}` + (c.nState ? `, ${fmt(c.nState)} bits of state: a machine that takes a step per beat.` : ', no state: one evaluation answers it.') + ' ' + reach
      + (c.kind === 'miner' ? ` A FabX miner design: ${fmt(peers)} circuit${peers > 1 ? 's' : ''} on X Layer ${peers > 1 ? 'have' : 'has'} exactly this shape.` : peers > 1 ? ` ${fmt(peers)} circuits on X Layer share this shape.` : '');
    const url = location.href.split('#')[0] + circuitHref(c);
    const text = `${label(c)} on X Layer: ${STATUS[st][1].toLowerCase()} on Overclock`;
    const owner = c.owner ? `<a href="#owner?addr=${c.owner}">${short(c.owner)}</a> <a class="muted" href="${EXPLORER}/address/${c.owner}" target="_blank" rel="noopener">explorer</a>` : '<span class="muted">not in the census</span>';
    const runCards = runs.length ? runs.map((r) => `<div class="card">
      <div class="top"><h3>Job ${r.jobId} <span class="dim">on ${esc((runsDoc.networks && runsDoc.networks[r.chainId] && runsDoc.networks[r.chainId].name) || 'chain ' + r.chainId)}</span></h3>${tag(r.status === 'final' ? 'final' : 'running')}</div>
      <p class="muted">${esc(r.what || '')}</p>
      <dl class="kv"><dt>Beats</dt><dd>${fmt(r.beats)}</dd><dt>Steps committed</dt><dd>${fmt(r.steps || 0)}</dd><dt>Fee · bond</dt><dd>${esc(r.fee || '?')} · ${esc(r.bond || '?')} OKB</dd>${r.disputes ? `<dt>Disputes</dt><dd>${fmt(r.disputes)}${r.disputeTxs ? ` (${fmt(r.disputeTxs)} transactions)` : ''}</dd>` : ''}<dt>Contract</dt><dd><a href="${explorer(r.chainId)}/address/${esc(r.overclock)}" target="_blank" rel="noopener">${short(r.overclock)}</a></dd></dl>
      ${r.outcome ? `<p class="muted">${esc(r.outcome)}</p>` : ''}${txChips(r.txs, r.chainId)}</div>`).join('') : `<div class="card"><div class="top"><h3>Not run yet</h3>${tag('queued')}</div><p class="muted">Nothing has run this circuit. When the runner reaches it, its job, result and transactions appear here.</p></div>`;
    const certCard = certs.length ? certs.map((x) => `<div class="card"><div class="top"><h3>Certificate</h3><span class="tag ${x.status === 'certified' ? 'ok' : 'bad'}">${x.status === 'certified' ? 'Certified' : 'Failed'}</span></div>
      <p class="muted">${x.mismatches === 0 ? `This design matched its reference on all ${fmt(x.inputs)} inputs, settled as an Overclock job.` : `${fmt(x.mismatches)} mismatch${x.mismatches > 1 ? 'es' : ''} in ${fmt(x.inputs)} inputs${x.firstFailingInput ? `; first failing input ${esc(x.firstFailingInput)}` : ''}.`}</p>
      <dl class="kv">${x.reference ? `<dt>Reference</dt><dd>${esc(x.reference.name || short(x.reference.processor))} #${x.reference.id}</dd>` : ''}<dt>Inputs checked</dt><dd>${fmt(x.inputs)}</dd><dt>Mismatches</dt><dd>${fmt(x.mismatches)}</dd>${x.runId ? `<dt>Job</dt><dd>${esc(x.runId)}</dd>` : ''}</dl>${txChips(x.txs, x.chainId || chain)}</div>`).join('')
      : `<div class="card"><div class="top"><h3>Certificate</h3><span class="tag same">None yet</span></div><p class="muted">A certificate says a design matches its reference on every input, settled on X Layer as a finalized job anyone can read. None has been issued for this circuit${c.kind === 'miner' ? `; miner certificates are issued per shape, and this shape has ${fmt(peers)} circuit${peers > 1 ? 's' : ''}` : ''}.</p></div>`;
    el.innerHTML = `
      <div class="intro"><a class="back" href="#floor">← The Floor</a><div class="titlerow"><h1>${esc(c.name || short(c.cpu))} <span class="dim">#${c.id}</span></h1>${tag(st)}</div>
        <p class="label"><a href="${EXPLORER}/address/${c.cpu}" target="_blank" rel="noopener">${short(c.cpu)}</a>${c.inCensus ? '' : ' · not in the census snapshot'}</p></div>
      <div class="specs"><div class="spec"><span class="v">${fmt(c.gates)}</span><span class="label">gates per beat</span></div><div class="spec"><span class="v">${fmt(c.nState)}</span><span class="label">state bits</span></div><div class="spec"><span class="v">${run ? fmt(run.beats) : '0'}</span><span class="label">beats run</span></div><div class="spec"><span class="v">${run ? big(runs.filter((r) => r.status === 'final').reduce((s, r) => s + (r.steps || 0), 0)) : '0'}</span><span class="label">steps settled</span></div></div>
      <section><div class="sec-head"><h2>What it is</h2></div><div class="card"><p>${esc(what)}</p><dl class="kv"><dt>Owner</dt><dd>${owner}</dd><dt>Processor</dt><dd><code>${c.cpu}</code></dd><dt>Circuit</dt><dd>#${c.id}</dd></dl>
        <div class="row"><a class="btn" href="#try?cpu=${c.cpu}&id=${c.id}&beats=${c.nState ? 1000 : 1}">Run it in your browser <span class="arr">→</span></a></div></div></section>
      <section><div class="sec-head"><h2>Current state</h2></div>${runCards}</section>
      <section><div class="sec-head"><h2>Certificate</h2></div>${certCard}</section>
      <section><div class="sec-head"><h2>Direct cost vs Overclock</h2></div><div class="card">${costs(c, run)}</div></section>
      <section><div class="sec-head"><h2>Share</h2></div><div class="card"><div class="row"><code class="grow" id="shareUrl">${esc(url)}</code></div>
        <div class="row"><button type="button" class="btn" id="shareCopy">Copy link</button><a class="btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Post on X</a><a class="btn" href="https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Telegram</a></div></div></section>`;
  }

  // ------------------------------------------------------------ owner lookup
  let ownerAddr = '';
  function renderOwner(addr, quiet) {
    const out = $('ownerOut'), note = $('ownerNote');
    addr = (addr || '').trim();
    out.innerHTML = ''; note.textContent = ''; note.classList.remove('bad');
    if (!addr) return;
    if (!ADDR.test(addr)) { note.textContent = 'That is not an address: 0x and 40 hex digits.'; note.classList.add('bad'); return; }
    ownerAddr = addr;
    const mine = [...circuits.values()].filter((c) => c.owner && c.owner.toLowerCase() === addr.toLowerCase()).sort((a, b) => b.gates - a.gates);
    if (!quiet) history.replaceState(null, '', `#owner?addr=${addr}`);
    if (!mine.length) {
      out.innerHTML = `<div class="card"><h3>No circuits on the Floor for ${short(addr)}</h3><p class="muted">The census covers the circuits a block can't run (snapshot at block ${census ? fmt(census.summary.block) : '?'}). If this address taped one out since, paste its processor and ID in <a href="#try">Your circuit</a>.</p></div>`;
      return;
    }
    const by = { queued: 0, running: 0, final: 0, certified: 0 };
    for (const c of mine) by[statusOf(c)]++;
    const runs = mine.flatMap((c) => runsOf(c).map((r) => [c, r])), certs = mine.flatMap((c) => certsOf(c).filter((x) => x.status === 'certified').map((x) => [c, x]));
    const SHOW = 50, more = mine.length - SHOW;
    const row = (c) => `<tr><td><a class="ev" href="${circuitHref(c)}"><b>${esc(c.name || short(c.cpu))}</b> <span class="muted">#${c.id}</span></a></td><td class="num">${fmt(c.gates)}</td><td class="num">${fmt(c.nState)}</td><td>${tag(statusOf(c))}</td></tr>`;
    out.innerHTML = `
      <div class="specs"><div class="spec"><span class="v">${fmt(mine.length)}</span><span class="label">circuits on the Floor</span></div><div class="spec"><span class="v">${fmt(runs.length)}</span><span class="label">runs</span></div><div class="spec"><span class="v">${fmt(certs.length)}</span><span class="label">certificates</span></div><div class="spec"><span class="v">${fmt(by.queued)}</span><span class="label">queued</span></div></div>
      <section><div class="sec-head"><h2>Your circuits</h2><p class="label"><a href="${EXPLORER}/address/${addr}" target="_blank" rel="noopener">${short(addr)}</a></p></div>
        <div class="log"><table class="trylist"><thead><tr><th>Circuit</th><th class="num">Gates</th><th class="num">State bits</th><th>Status</th></tr></thead><tbody id="ownerRows">${mine.slice(0, SHOW).map(row).join('')}</tbody></table></div>
        ${more > 0 ? `<div class="row"><button type="button" id="ownerMore">Show the other ${fmt(more)}</button></div>` : ''}</section>
      ${runs.length ? `<section><div class="sec-head"><h2>Runs</h2></div><div class="log"><table class="trylist"><thead><tr><th>Circuit</th><th>Job</th><th>Result</th><th class="num">Gas, Overclock vs direct</th></tr></thead><tbody>${runs.map(([c, r]) => `<tr><td><a class="ev" href="${circuitHref(c)}">${esc(label(c))}</a></td><td>${r.jobId}</td><td>${tag(r.status === 'final' ? 'final' : 'running')}</td><td class="num">${r.gas && r.gas.honestPath ? fmt(r.gas.honestPath) : '?'} vs ${r.directGas ? fmt(r.directGas) : '?'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      ${certs.length ? `<section><div class="sec-head"><h2>Certificates</h2></div><div class="log"><table class="trylist"><thead><tr><th>Circuit</th><th class="num">Inputs checked</th><th class="num">Mismatches</th></tr></thead><tbody>${certs.map(([c, x]) => `<tr><td><a class="ev" href="${circuitHref(c)}">${esc(label(c))}</a></td><td class="num">${fmt(x.inputs)}</td><td class="num">${fmt(x.mismatches)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
    const btn = $('ownerMore');
    if (btn) btn.addEventListener('click', () => { $('ownerRows').innerHTML = mine.map(row).join(''); btn.remove(); });
  }

  // The wallet is found by run.js (window.OCWallet); without it, fall back to whatever the browser injects.
  const wallets = () => {
    if (window.OCWallet) return window.OCWallet.wallets();
    const w = window.okxwallet ? { info: { name: 'OKX Wallet' }, provider: window.okxwallet } : window.ethereum ? { info: { name: 'Browser wallet' }, provider: window.ethereum } : null;
    return w ? [w] : [];
  };
  function drawOwnerWallet() {
    const el = $('ownerWallet'), list = wallets();
    if (!list.length) { el.innerHTML = '<p class="label">No wallet in this browser. Paste an address above, or open this page in OKX Wallet.</p>'; return; }
    el.innerHTML = '<div class="row"></div>';
    for (const d of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn';
      b.textContent = `Connect ${d.info.name}`;
      b.onclick = async () => {
        try { const [a] = await d.provider.request({ method: 'eth_requestAccounts' }); $('ownerInput').value = a; renderOwner(a); } catch (e) { $('ownerNote').textContent = e.code === 4001 ? 'You declined it in your wallet.' : (e.message || String(e)); $('ownerNote').classList.add('bad'); }
      };
      el.firstChild.appendChild(b);
    }
  }

  // ------------------------------------------------------------ routing and wiring
  function route() {
    const h = location.hash, base = h.split('?')[0];
    if (base.startsWith('#c/')) { const [, cpu, id] = base.split('/'); renderCircuit(cpu, Number(id)); }
    else if (base === '#owner') {
      const a = new URLSearchParams(h.split('?')[1] || '').get('addr');
      if (a && a !== ownerAddr) { $('ownerInput').value = a; renderOwner(a, true); }
    }
  }
  function refresh() { index(); counters(); renderFloor(); route(); }

  $('floorFilters').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) { filter = b.dataset.f; renderFloor(); } });
  $('ownerForm').addEventListener('submit', (e) => { e.preventDefault(); renderOwner($('ownerInput').value); });
  $('circuitBody').addEventListener('click', async (e) => {
    if (e.target.id !== 'shareCopy') return;
    try { await navigator.clipboard.writeText($('shareUrl').textContent); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500); } catch (err) { /* clipboard blocked */ }
  });
  addEventListener('hashchange', route);
  addEventListener('oc:account', (e) => { $('ownerInput').value = e.detail; });
  addEventListener('eip6963:announceProvider', () => setTimeout(drawOwnerWallet, 450));
  refresh();
  drawOwnerWallet();
  setTimeout(drawOwnerWallet, 600);

  // Live index: only over HTTP (a file: page keeps the inlined copy), and never at the cost of a working page.
  const meta = document.querySelector('meta[name="runs-url"]');
  async function pull() {
    try {
      const r = await fetch(meta ? meta.content : 'runs.json', { cache: 'no-store' });
      const d = await r.json();
      if (d && d.schema === 1 && Array.isArray(d.runs)) { runsDoc = d; refresh(); }
    } catch (e) { /* keep what we have */ }
  }
  if (/^https?:$/.test(location.protocol)) { pull(); setInterval(pull, 60000); }
})();
