import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatUnits } from 'viem';
import {
  agentIdFrom,
  agentUri,
  identityClients,
  identityKey,
  identityRegistry,
  registryAbi,
} from '../src/server/identity.ts';

/**
 * A local console for registering this entry's ERC-8004 identity.
 *
 * Two transactions, both from the agent wallet, both irreversible. Nothing is
 * sent until the person at the keyboard presses the button: every GET only
 * reads the chain, and the page shows the exact calldata, the wallet and the
 * estimated cost first. It binds to loopback only and prints no key.
 */
const key = identityKey();
if (!key) {
  console.error(
    'Set TRIALOOM_SPONSOR_AGENT_KEY in .env first. It is the agent wallet named on the entry, and the rules require the identity to be registered from it.',
  );
  process.exit(1);
}
const rpcUrl = process.env.TRIALOOM_CELO_RPC_URL || 'https://forno.celo.org';
const { account, chain, wallet } = identityClients(key, rpcUrl);

async function state() {
  const [celoBalance, held, gasPrice] = await Promise.all([
    chain.getBalance({ address: account.address }),
    chain.readContract({
      address: identityRegistry.address,
      abi: registryAbi,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    chain.getGasPrice(),
  ]);
  let gas: bigint | null = null;
  let simulated: bigint | null = null;
  if (held === 0n) {
    try {
      const { result } = await chain.simulateContract({
        address: identityRegistry.address,
        abi: registryAbi,
        functionName: 'register',
        account,
      });
      simulated = result;
      gas = await chain.estimateContractGas({
        address: identityRegistry.address,
        abi: registryAbi,
        functionName: 'register',
        account,
      });
    } catch {
      gas = null;
    }
  }
  return {
    address: account.address,
    celo: formatUnits(celoBalance, 18),
    held: Number(held),
    gas: gas ? Number(gas) : null,
    cost: gas ? formatUnits(gas * gasPrice, 18) : null,
    simulated: simulated ? Number(simulated) : null,
    registry: identityRegistry.address,
  };
}

const safe = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

function page(view: Awaited<ReturnType<typeof state>>) {
  const done = view.held > 0;
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent identity</title>
<style>
:root{--bg:#f6f5ef;--ink:#202d26;--dim:#5a6b62;--line:#d8d6ca;--accent:#174b38;--warn:#8a3b1e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151a17;--ink:#e8eae6;--dim:#9aa8a0;--line:#2b332e;--accent:#8fd0ae;--warn:#e09272}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 .25rem}
p.lede{color:var(--dim);margin:0 0 2rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1.25rem;margin:0 0 2rem;
  border-top:1px solid var(--line);padding-top:1rem}
dt{color:var(--dim)}
dd{margin:0;font-family:ui-monospace,SFMono-Regular,monospace;font-size:.86rem;word-break:break-all}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--bg);border:0;
  border-radius:.4rem;padding:.7rem 1.3rem;cursor:pointer}
button[disabled]{opacity:.45;cursor:not-allowed}
.note{border-left:3px solid var(--warn);padding:.4rem 0 .4rem .9rem;color:var(--dim);margin:0 0 1.5rem}
code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.86rem}
#out{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.82rem;margin-top:1.5rem;
  border-top:1px solid var(--line);padding-top:1rem;color:var(--dim)}
</style>
<main>
<h1>Register this entry's agent identity</h1>
<p class="lede">ERC-8004 on Celo mainnet. Two transactions, both from the agent wallet, both irreversible.</p>
${
  done
    ? '<p class="note">This wallet already holds an identity. Nothing further is needed here.</p>'
    : '<p class="note">Pressing the button sends a real transaction and spends real gas. Nothing has been sent yet.</p>'
}
<dl>
<dt>Agent wallet</dt><dd>${safe(view.address)}</dd>
<dt>CELO balance</dt><dd>${safe(view.celo)}</dd>
<dt>Identities held</dt><dd>${view.held}</dd>
<dt>Registry</dt><dd>${safe(view.registry)}</dd>
<dt>Call</dt><dd>register() &middot; calldata <code>0x1aa3a008</code></dd>
<dt>Estimated gas</dt><dd>${view.gas ? `${view.gas} &middot; about ${safe(view.cost ?? '')} CELO` : 'not estimable'}</dd>
<dt>Simulated agent id</dt><dd>${view.simulated ?? 'n/a'}${view.simulated ? ' (not reserved; the receipt decides)' : ''}</dd>
</dl>
<button id="go"${done || !view.gas ? ' disabled' : ''}>Send register()</button>
<div id="out"></div>
<script>
const out = document.querySelector('#out');
const go = document.querySelector('#go');
go?.addEventListener('click', async () => {
  go.disabled = true;
  out.textContent = 'Sending register()…';
  try {
    const first = await (await fetch('/register', { method: 'POST' })).json();
    if (first.error) { out.textContent = 'Failed: ' + first.error; go.disabled = false; return; }
    out.textContent = 'register() included in ' + first.hash + '\\nagent id ' + first.agentId +
      '\\n\\nPublishing the registration file as a data: URI…';
    const second = await (await fetch('/set-uri', { method: 'POST' })).json();
    out.textContent += second.error
      ? '\\nsetAgentURI failed: ' + second.error + '\\nThe identity exists; the URI can be set again.'
      : '\\nsetAgentURI included in ' + second.hash + '\\n\\nDone. Agent id ' + first.agentId + '.';
  } catch (error) {
    out.textContent = 'Failed: ' + error.message;
    go.disabled = false;
  }
});
</script>
</main></html>`;
}

let agentId: bigint | null = null;

const server = createServer(async (request, response) => {
  const send = (status: number, body: string, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  };
  try {
    if (request.method === 'GET' && request.url === '/')
      return send(200, page(await state()), 'text/html; charset=utf-8');
    if (request.method === 'POST' && request.url === '/register') {
      const hash = await wallet.writeContract({
        address: identityRegistry.address,
        abi: registryAbi,
        functionName: 'register',
      });
      const receipt = await chain.waitForTransactionReceipt({ hash });
      agentId = agentIdFrom(receipt.logs);
      console.log(JSON.stringify({ event: 'identity.registered', hash, agentId: String(agentId) }));
      return send(200, JSON.stringify({ hash, agentId: String(agentId) }));
    }
    if (request.method === 'POST' && request.url === '/set-uri') {
      if (agentId === null) return send(409, JSON.stringify({ error: 'No agent id yet.' }));
      const { uri } = await agentUri(agentId);
      const hash = await wallet.writeContract({
        address: identityRegistry.address,
        abi: registryAbi,
        functionName: 'setAgentURI',
        args: [agentId, uri],
      });
      await chain.waitForTransactionReceipt({ hash });
      console.log(JSON.stringify({ event: 'identity.uri_set', hash, bytes: uri.length }));
      return send(200, JSON.stringify({ hash }));
    }
    return send(404, JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    return send(500, JSON.stringify({ error: (error as Error).message.slice(0, 300) }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(
    `Identity console on http://127.0.0.1:${port} — nothing is sent until you press the button.`,
  );
});
