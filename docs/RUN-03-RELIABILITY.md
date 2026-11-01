# Preview runner reliability

## Buffered response timing

The HTTPS proxy buffers responses before releasing them, so it can enforce byte caps and redirect policy. Its former client-side five-second idle timer could expire during an upstream transfer that was still making progress. The owned streaming fixture exercises this case separately from an actually stalled upstream.

Keep the CONNECT/header/TLS-handshake idle guards while admitting the request. Once a valid request is being fetched, upstream traffic owns the five-second idle check. The original absolute connection deadline (15 seconds), run deadline and all byte/request/connection caps still apply. A stream making progress does not have unlimited time. No retry, TLS bypass, DNS relaxation or permission expansion is introduced.

## Failure diagnostics

Broker startup emits only a closed stage/reason and optional manifest-origin index. The trusted host reads this bounded diagnostic after a stopped broker; it never prints raw stderr, targets, keys or arbitrary error messages. The earlier fix for an asynchronously starting `created` container remains.

Proxy reports retain at most 16 upstream failures with an already-approved origin, a fixed failure kind and phase, IP family and bounded elapsed milliseconds. URLs, IP addresses, headers, bodies and error strings are omitted. Cancellation does not invent an upstream failure. DNS/upstream failures keep the journey blocked and produce an infrastructure replay step, separately from scope denials and exhausted budgets. Witness/claim equality and acceptance/payment rules remain unchanged.

## Verification

`npm run runner:proxy-check` covers streamed progress, real upstream stalls, absolute connection cutoff, existing DNS/TLS/scope/cookie/byte boundaries, two isolated Chromium journeys and proxy loss. `npm run browser:preview -- --smoke --ladder` exercises a diagnosed broker startup refusal, owned success and wrong-count/unexpected-origin/upstream-failure controls through actual application evidence and replay.

The live journey uses the already-approved exact GET described in [RUN-03-LADDER.md](RUN-03-LADDER.md). A local fixture pass is not proof that the public ladder succeeded. The current result and outstanding work are recorded in [STATUS.md](../memory/STATUS.md).
