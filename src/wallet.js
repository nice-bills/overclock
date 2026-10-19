// Signing without a private key: a small approval page on localhost that the user opens once and
// leaves open. It connects their own wallet (OKX Wallet, MetaMask or any injected EIP-1193 wallet)
// and, for every transaction a tool wants to send, asks the wallet to approve it. The key never
// leaves the wallet; the server only ever sees the transaction hash, and checks on-chain that the
// transaction it got is the one it asked for.
//
//   const bridge = new WalletBridge({ provider, chainId, rpcUrl });
//   await bridge.listen(0);          // or mount bridge.handle(req, res) on an existing server
//   bridge.url                       // give this to the user
//   bridge.signer                    // an ethers Signer; sendTransaction waits for approval

import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { AbstractSigner, getAddress, toQuantity, formatEther } from 'ethers';

const SEEN_MS = 15_000; // a page that has not polled for this long counts as closed
const PICKUP_MS = 5 * 60_000; // how long a request may wait for the page to hand it to the wallet
const APPROVE_MS = 15 * 60_000; // how long the wallet prompt may stay open

// The tool that is sending, so the approval page can say what each transaction is for.
const doing = new AsyncLocalStorage();
export const labelled = (label, fn) => doing.run(label, fn);

const XLAYER_CHAIN = {
  chainId: '0xc4', chainName: 'X Layer Mainnet', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: ['https://rpc.xlayer.tech'], blockExplorerUrls: ['https://www.oklink.com/xlayer'],
};

export class NotConnected extends Error {
  constructor(url) {
    super(`No wallet connected. Ask the user to open ${url} and connect their wallet (OKX Wallet or MetaMask), keep that page open, then try again. Every transaction is approved in their wallet; no private key is needed.`);
    this.url = url;
  }
}

export class WalletBridge {
  constructor({ provider, chainId, rpcUrl, explorer, log = () => {} }) {
    this.provider = provider;
    this.chainId = Number(chainId);
    this.rpcUrl = rpcUrl;
    this.explorer = explorer ?? (this.chainId === 196 ? 'https://www.oklink.com/xlayer/tx/' : null);
    this.log = log;
    this.token = randomBytes(16).toString('hex');
    this.base = null; // http://host:port, set by listen() or setBase()
    this.address = null;
    this.walletName = null;
    this.lastSeen = 0;
    this.pending = new Map(); // id -> { id, tx, label, picked, resolve, reject, timer }
    this.nextId = 1;
    this.waiters = new Set();
    this.signer = new BridgeSigner(this, provider);
  }

  get path() { return `/wallet/${this.token}`; }
  get url() { return this.base ? `${this.base}${this.path}` : null; }
  setBase(base) { this.base = base.replace(/\/$/, ''); }
  get connected() { return Boolean(this.address) && Date.now() - this.lastSeen < SEEN_MS; }

  status() {
    return this.connected
      ? { mode: 'browser wallet', connected: true, address: this.address, wallet: this.walletName, approvalPage: this.url }
      : { mode: 'browser wallet', connected: false, approvalPage: this.url };
  }

  // Resolves once a page reports a connected wallet, or after ms.
  async waitConnected(ms) {
    if (this.connected || ms <= 0) return this.connected;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(this.connected); };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  async listen(port = 0, host = '127.0.0.1') {
    if (this.server) return this.url;
    this.server = createServer((req, res) => { if (!this.handle(req, res)) res.writeHead(404).end(); });
    await new Promise((ok, bad) => { this.server.once('error', bad); this.server.listen(port, host, ok); });
    this.server.unref();
    this.setBase(`http://${host}:${this.server.address().port}`);
    return this.url;
  }

  close() { this.server?.close(); }

  // Queue a transaction for the page and wait for the wallet's answer: a transaction hash.
  request(tx, label) {
    if (!this.connected) return Promise.reject(new NotConnected(this.url));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const p = { id, tx, label, picked: false, resolve, reject };
      const expire = (why) => { if (this.pending.delete(id)) reject(new Error(why)); };
      p.timer = setTimeout(() => expire(`The approval page did not pick up the transaction within ${PICKUP_MS / 1000}s. Is ${this.url} still open?`), PICKUP_MS);
      p.expire = expire;
      this.pending.set(id, p);
      this.log({ what: 'awaiting approval', id, label });
    });
  }

  // Returns true when the request was for the bridge.
  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(this.path)) return false;
    const rest = url.pathname.slice(this.path.length);
    const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (req.method === 'GET' && (rest === '' || rest === '/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(page(this));
      return true;
    }
    if (req.method === 'GET' && rest === '/state') {
      this.lastSeen = Date.now();
      json(200, {
        chainId: this.chainId, address: this.address,
        pending: [...this.pending.values()].map(({ id, tx, label, picked }) => ({ id, tx, label, picked })),
      });
      return true;
    }
    if (req.method !== 'POST') { json(405, { error: 'method' }); return true; }
    // The page is same-origin; refuse posts a different site's page could send blindly.
    const origin = req.headers.origin;
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) { json(403, { error: 'origin' }); return true; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body || '{}'); } catch { json(400, { error: 'json' }); return; }
      this.lastSeen = Date.now();
      if (rest === '/connect') {
        try { this.address = m.address ? getAddress(m.address) : null; } catch { json(400, { error: 'address' }); return; }
        this.walletName = m.wallet ? String(m.wallet).slice(0, 60) : null;
        this.log({ what: this.address ? 'wallet connected' : 'wallet disconnected', address: this.address });
        for (const w of [...this.waiters]) w();
        json(200, { ok: true });
        return;
      }
      const p = this.pending.get(Number(m.id));
      if (!p) { json(404, { error: 'no such request' }); return; }
      if (rest === '/picked') {
        p.picked = true;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => p.expire('The wallet prompt was not answered in time.'), APPROVE_MS);
        json(200, { ok: true });
        return;
      }
      if (rest === '/result') {
        this.pending.delete(p.id);
        clearTimeout(p.timer);
        if (typeof m.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.hash)) p.resolve(m.hash);
        else p.reject(new Error(m.error ? `Wallet: ${String(m.error).slice(0, 300)}` : 'The wallet returned no transaction hash.'));
        json(200, { ok: true });
        return;
      }
      json(404, { error: 'unknown' });
    });
    return true;
  }
}

// An ethers Signer whose transactions are approved in the user's wallet through the bridge.
class BridgeSigner extends AbstractSigner {
  constructor(bridge, provider) {
    super(provider);
    this.bridge = bridge;
  }

  connect(provider) { return new BridgeSigner(this.bridge, provider); }

  async getAddress() {
    if (!this.bridge.connected) throw new NotConnected(this.bridge.url);
    return this.bridge.address;
  }

  async sendTransaction(tx) {
    const from = await this.getAddress();
    const pop = await this.populateCall(tx);
    // Estimating first surfaces a revert here, with its reason, instead of in the user's wallet.
    const gas = pop.gasLimit ?? await this.provider.estimateGas(pop);
    const req = {
      from, to: pop.to, data: pop.data ?? '0x', value: toQuantity(pop.value ?? 0n),
      gas: toQuantity((BigInt(gas) * 12n) / 10n), chainId: toQuantity(this.bridge.chainId),
    };
    const label = describe(tx, req);
    const hash = await this.bridge.request(req, label);
    const sent = await this.#find(hash);
    // The page could be anything that can reach localhost; only accept the transaction we asked for.
    const same = sent.from.toLowerCase() === from.toLowerCase()
      && (sent.to ?? '').toLowerCase() === (req.to ?? '').toLowerCase()
      && sent.data.toLowerCase() === req.data.toLowerCase()
      && sent.value === BigInt(req.value);
    if (!same) throw new Error(`Transaction ${hash} is not the one that was requested; ignoring it.`);
    this.bridge.log({ what: 'approved', hash, label });
    return sent;
  }

  async #find(hash) {
    for (let i = 0; i < 120; i++) {
      const t = await this.provider.getTransaction(hash);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`The wallet reported ${hash} but the network does not know it.`);
  }

  signTransaction() { throw new Error('This wallet signs in the browser; use sendTransaction.'); }
  signMessage() { throw new Error('Message signing is not supported by the approval page.'); }
  signTypedData() { throw new Error('Typed-data signing is not supported by the approval page.'); }
}

// What the approval page shows next to the wallet prompt.
function describe(tx, req) {
  const fn = tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : null;
  const what = doing.getStore() ?? (fn ? `contract call ${fn}` : 'transfer');
  return `${what} · ${formatEther(BigInt(req.value))} OKB to ${req.to}`;
}

function page(b) {
  const cfg = {
    base: b.path, chainId: b.chainId, explorer: b.explorer,
    chain: b.chainId === 196 ? XLAYER_CHAIN : {
      chainId: toQuantity(b.chainId), chainName: `Chain ${b.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: b.rpcUrl && /^https?:/.test(b.rpcUrl) ? [b.rpcUrl] : [],
    },
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overclock wallet</title><link rel="icon" href="data:,">
<style>
:root{--bg:#f6f5f1;--fg:#16150f;--mute:#6b6a63;--line:#dedcd3;--card:#fff;--acc:#1f7a4d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#111110;--fg:#eceae3;--mute:#9a988f;--line:#2a2926;--card:#1a1918;--acc:#5fd39a;--bad:#f2867c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 12px}
button{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;margin:0 8px 8px 0;display:inline-flex;gap:8px;align-items:center}
button img{width:20px;height:20px}button:hover{border-color:var(--fg)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.ok{color:var(--acc)}.bad{color:var(--bad)}.mute{color:var(--mute)}
ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}li:first-child{border-top:0}
</style></head><body><main>
<h1>Overclock wallet</h1>
<p>Your agent sends Overclock transactions through this page. Each one opens in your wallet for you to approve or reject. Keep this tab open while the agent works.</p>
<div class="card" id="conn"><div id="wallets" class="mute">Looking for wallets…</div></div>
<div class="card"><strong>Requests</strong><ul id="reqs"><li class="mute">Nothing waiting.</li></ul></div>
<div class="card"><strong>History</strong><ul id="hist"><li class="mute">No transactions yet.</li></ul></div>
<script>
const CFG=${JSON.stringify(cfg).replace(/</g, '\\u003c')};
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>'&#'+c.charCodeAt(0)+';');
const found=new Map();let wallet=null,name=null,account=null,busy=false,current=null;const done=new Set(),hist=[];
window.addEventListener('eip6963:announceProvider',(e)=>{found.set(e.detail.info.uuid,e.detail);drawWallets();});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(!found.size){
  if(window.okxwallet)found.set('okx',{info:{name:'OKX Wallet',icon:''},provider:window.okxwallet});
  else if(window.ethereum)found.set('injected',{info:{name:'Browser wallet',icon:''},provider:window.ethereum});
}drawWallets();},400);
function drawWallets(){
  if(account){$('conn').innerHTML='<span class="ok">Connected</span> '+esc(name)+' <code>'+esc(account)+'</code><br><button id="dis">Disconnect</button>';$('dis').onclick=disconnect;return;}
  if(!found.size){$('wallets').innerHTML='No wallet found in this browser. Install <a href="https://www.okx.com/web3">OKX Wallet</a> or MetaMask, then reload.';return;}
  const el=document.createElement('div');el.id='wallets';el.innerHTML='<p>Connect a wallet:</p>';
  for(const [k,d] of found){const b=document.createElement('button');b.innerHTML=(d.info.icon?'<img alt="" src="'+esc(d.info.icon)+'">':'')+esc(d.info.name);b.onclick=()=>connect(d);el.appendChild(b);}
  $('conn').replaceChildren(el);
}
async function post(p,body){await fetch(CFG.base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
async function ensureChain(){
  const id=await wallet.request({method:'eth_chainId'});
  if(Number(id)===CFG.chainId)return;
  try{await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:CFG.chain.chainId}]});}
  catch(e){if(e.code===4902||e?.data?.originalError?.code===4902)await wallet.request({method:'wallet_addEthereumChain',params:[CFG.chain]});else throw e;}
}
async function connect(d){
  try{
    wallet=d.provider;name=d.info.name;
    const [a]=await wallet.request({method:'eth_requestAccounts'});
    await ensureChain();account=a;
    wallet.on?.('accountsChanged',(as)=>{account=as[0]||null;post('/connect',{address:account,wallet:name});drawWallets();});
    await post('/connect',{address:a,wallet:name});drawWallets();
  }catch(e){$('conn').insertAdjacentHTML('beforeend','<p class="bad">'+esc(e.message||e)+'</p>');}
}
async function disconnect(){account=null;await post('/connect',{address:null});drawWallets();}
async function approve(r){
  busy=true;current=r.id;drawReqs([r]);await post('/picked',{id:r.id});
  try{await ensureChain();const hash=await wallet.request({method:'eth_sendTransaction',params:[{from:r.tx.from,to:r.tx.to,data:r.tx.data,value:r.tx.value,gas:r.tx.gas}]});
    done.add(r.id);await post('/result',{id:r.id,hash});hist.unshift({label:r.label,hash});}
  catch(e){done.add(r.id);await post('/result',{id:r.id,error:e.message||String(e)});hist.unshift({label:r.label,error:e.message||String(e)});}
  busy=false;drawHist();drawReqs([]);
}
function drawReqs(open){$('reqs').innerHTML=open.length?open.map((r)=>'<li>'+esc(r.label)+(r.id===current?' <span class="mute">· waiting for you in the wallet</span>':'')+'</li>').join(''):'<li class="mute">Nothing waiting.</li>';}
function drawHist(){if(!hist.length)return;$('hist').innerHTML=hist.slice(0,20).map((h)=>'<li>'+esc(h.label)+'<br>'+(h.hash?(CFG.explorer?'<a href="'+CFG.explorer+h.hash+'" target="_blank" rel="noopener"><code>'+h.hash+'</code></a>':'<code>'+h.hash+'</code>'):'<span class="bad">'+esc(h.error)+'</span>')+'</li>').join('');}
async function poll(){
  try{const s=await (await fetch(CFG.base+'/state',{cache:'no-store'})).json();
    if(account&&!s.address)await post('/connect',{address:account,wallet:name});
    const open=s.pending.filter((r)=>!done.has(r.id));
    if(!busy)drawReqs(open);
    if(account&&!busy&&open.length)approve(open[0]);
  }catch{}
  setTimeout(poll,1000);
}
poll();
</script></main></body></html>`;
}
