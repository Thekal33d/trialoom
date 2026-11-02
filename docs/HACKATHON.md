# Celo hackathon alignment

Rechecked **2026-11-02** against [Agents on Open Rails](https://www.loops.house/agents-on-open-rails), reached through [Builder Arena](https://www.loops.house/builder-arena). Selected by the user: **Build with buy**. The user **enrolled on 2026-11-02** and was issued attribution tag `celo_043943600450`. Nothing in the rules changed between the two readings.

## Current official requirements

Deadline: **2026-11-09 09:00 GMT / 10:00 Africa/Lagos**. Build with buy allocates $1,000 across five projects. Judging considers useful paid external-service calls and their growth, with payment proof and named services. Cheap repetitive calls do not qualify as useful integration.

The rules require Celo mainnet, a public GitHub repository at registration, event-period code and an ERC-8004 agent identity. General rules require attribution, while the buy FAQ says no tag is needed for that track; x402 guidance requests PayTo addresses. Preserve payer, service payee and receipt evidence and resolve entry-specific attribution before claiming counted activity.

Two further points were confirmed on the 2026-11-02 reading. The page lists submission contents as a public GitHub repository, and for Build with buy a statement of the services used with proof of payment; it **does not explicitly require a hosted demo, a video or a deployment**, so hosting is a product gate rather than a submission one. And "code is written during the hackathon" is satisfied: kick-off was 2026-10-06 and this repository's first commit is `22e6ce0` on 2026-10-26.

**The submission form asks for more than the public page lists.** `loops project fields` on 2026-11-02 reports six required fields: `name`, `description`, `repoUrl`, `screenshots` (at least one), `demoUrl` (live demo or website link), and the extra field `agent-wallet`. Two corrections follow. A **live demo URL is required**, so FREE-03 hosting is a submission gate after all, not only a product one — an earlier reading of the public page concluded otherwise because the page does not list it. And the repository field says "GitHub repo (**private repos supported**, judges get read access)", so the repository need not be public, but it does still need to be GitHub.

**Unresolved, and it has to be resolved before the first paid call.** The public page says an attribution tag is "not required for Build with buy". The event skill installed on 2026-11-02 (`npx loopshouse add agents-on-open-rails`) says the opposite as a general rule: "A transaction the project sends is credited to this entry only if its calldata carries the entry's ERC-8021 attribution tag. A transaction sent without the tag can never be credited later: there is no backfill." The Build with buy bounty itself is scored on "verified paid calls from the project's **tagged wallet** on Celo mainnet". A third source of ambiguity: the page states attribution tags are not yet supported on x402 and a PayTo wallet address is required there instead, and buy settles over x402.

A knowledge-graph query against the buy sponsor on 2026-11-02 advanced this without closing it. The attribution SDK documents a **Schema 2 role-based tag** that is "the shape used by payment facilitators (e.g. x402 settlement services) that submit transactions on behalf of an app", encoding the app, the facilitator and optionally the paying client separately — and it says to "credit `sender`, not the transaction's `from` — `from` is the bundler". Celo's own documentation adds that "whether a code gets credited on a leaderboard or rewards program is resolved at the registry/indexer layer, not at the tagging step". So for an x402 call the settling transaction is not ours to tag, Schema 2 exists precisely for that case, and crediting is an indexer decision. What remains unknown is whether buy's gateway emits a Schema 2 tag carrying this entry's app code. That question goes to buy or the organisers; it cannot be answered from our side of the wire.

Because there is no backfill, the safe reading is to tag everything that can be tagged. The tag is wired into the Remesso settlement client already. **It is not wired into any buy or x402 client, because none exists yet** — when BUY-01 gains a real payment path, the tag belongs at that wallet client (`withAttribution` from `@celo/attribution-tags@^0.5.0`, or the `celo.dataSuffix` that `loops project get` returns), not only at the Remesso one. Confirm the x402 case with the sponsor knowledge graph or the organisers before paying.

The independent-user qualifier excludes wallets created/funded by the entrant and requires earlier Celo activity. The FAQ also welcomes newcomers. Free email registrations are not proof of qualifying independent wallets. Do not invent traction or eligibility. Source: [official rules and FAQ](https://www.loops.house/agents-on-open-rails).

## Trialoom entry

The selected [free beta](FREE-BETA.md) gives builders browser results and replay. Trialoom sponsors a useful external call through buy to explain sanitized test observations and suggest a debugging step. Customer pricing and external-service payment are separate. The later paid repair marketplace is outside this demonstration's required scope (D049).

The [live buy catalog](https://gateway.usebuy.ai/v1/catalog), retrieved unsigned on 2026-11-01, advertises Cencori inference, Chainstack RPC and browser rental. Cencori is the first integration candidate; actual useful delivery remains unverified. Official [gateway guidance](https://github.com/celo-org/buy-skill/blob/main/skills/use-api-gateway/SKILL.md) describes exact-request quotes, payment limits, browser commands and receipt recovery. Never treat catalog pricing or local fork transactions as paid mainnet output.

## Entry and integration checklist

- [x] Select Build with buy and record the public-free-beta scope.
- [x] Refresh event rules and inspect the free live catalog.
- [x] Enrol and obtain the attribution tag (2026-11-02).
- [x] Wire the attribution tag into the code before any agent transaction. `celo_043943600450` is the recorded default builder code in `src/server/remesso.ts`, overridable by `TRIALOOM_BUILDER_CODES`, and the pinned SDK's own charset validator accepts it. Not required for Build with buy; carried so any transaction can be credited.
- [ ] Publish a public GitHub repository that still resolves at judging. Required **at registration**, and the user's GitHub is unavailable.
- [ ] Register the ERC-8004 identity **from the agent wallet** before the deadline. The rules state a project is only valid with an ERC-8004 identity. The wallet is decided — `0xf8Ff4F7C83404e04506785b7DFDf838CA75C22ae`, supplied 2026-11-03, read on chain, funded with 10 CELO and holding no identity — and the submission form accepts it. `register()` simulates successfully from it for about 0.022 CELO, and a `data:` URI removes the dependency on hosting, so the only missing input is the transaction, which only the key holder can send. [ERC-8004 notes](ERC-8004.md)
- [ ] Resolve whether a buy/x402 paid call can be credited without calldata attribution, and the PayTo payee reporting. No backfill exists, so settle this before the first paid call.
- [ ] Establish a dedicated resource wallet, supported token and explicit aggregate spend cap.
- [ ] Execute one useful, capped buy request through the product; retain result and matching receipt.
- [ ] Demonstrate durable uncertain-payment recovery and zero customer reimbursement.
- [ ] Observe a genuine external user benefiting from the result; describe user provenance accurately.
- [x] Write the repository's front door: what is true today, what is not, how to run it, and where each claim's checkpoint lives.
- [x] Capture the submission screenshots. The signup-to-replay check of 2026-11-03 produced a desktop and a mobile full-page view of a real completed free test and its replay, against the owned fixture; both are public-safe and kept in [docs/screenshots/](screenshots/).
- [ ] Complete public-safe demo, setup instructions, limitations and final commit.
- [ ] Submit and retain confirmation before the deadline.

## Evidence index

| Item | Current evidence |
| --- | --- |
| Track / enrollment | Build with buy selected as the core focus track; **enrolled 2026-11-02**. Attribution tag `celo_043943600450` wired in and **confirmed by the platform** — `loops project get` returns the same tag, with `dataSuffix` `0x63656c6f5f303433393433363030343530110080218021802180218021802180218021`. No project record exists yet (`exists: false`), so the platform still reports agent wallet and ERC-8004 identity as null — the wallet below is recorded here and accepted by a draft `project create`, but it reaches the platform only when the entry is created. Bounty id `e9a90153-6486-4deb-8027-a931e5eea4d2` |
| Submission fields | Six required: name, description, repoUrl, screenshots, demoUrl, agent-wallet. Name, description and tagline are drafted and the user approved them on 2026-11-03; the agent wallet and screenshots now exist. `loops project create` still refuses — on 2026-11-03 it returned `FIELDS_REQUIRED` naming **`repoUrl` alone**, so the GitHub repository is the last thing standing between this entry and existing. `demoUrl` does not block creation |
| Screenshots | [desktop](screenshots/free-test-result-desktop.png) `f14b1485…` and [mobile](screenshots/free-test-result-mobile.png) `8231fc77…`, captured by `npm run runner:free-check` on 2026-11-03 from a real completed test: the workspace, the four passing checks, the recorded replay with its timings, and the line stating what the replay omits. Fixture data only — no customer URL, identity or page content |
| Public repo / hosted demo | User push to GitLab verified at `633c2cf` on 2026-11-01; both histories preserved. GitLab visibility not independently verified. User's GitHub is currently unavailable; required public GitHub repository and hosted demo remain missing |
| Agent identity / funded resource wallet | Agent wallet **`0xf8Ff4F7C83404e04506785b7DFDf838CA75C22ae`**, supplied 2026-11-03 and read on chain: nonce 0, 10 CELO, **0 USDC**, no identity held. The ERC-8004 identity is mandatory and does not exist yet; the Celo mainnet registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is verified against the chain, `register()` simulates from this wallet, and [`public/agent.json`](../public/agent.json) keeps its unfilled fields empty rather than guessed. The 0 USDC balance is a separate gate: **no buy call can be paid from this wallet until it is funded**. [Notes](ERC-8004.md) |
| Real browser results / replay | Local owned fixture and authorized Blokaz ladder; [verified checkpoint](evidence/RUN-03-ladder-verified.json) |
| Payment recovery | Local Celo fork only; [VAL-03](evidence/VAL-03.json), [VAL-04](evidence/VAL-04.json) |
| Useful buy output / mainnet receipt | Pending; [unsigned quote/input boundary](BUY-01.md) verified, with no payment |
| External beta users / submission | Pending |

Registration, publication and funding require concrete destination/identity/budget details. Keep private customer data, credentials, raw traces and provider capabilities out of public evidence. A working demo does not itself close public beta operations gates.

Continue development using [the GitLab repository](https://gitlab.com/Otaiki1/trialoom). GitHub unavailability does not waive the official public GitHub requirement. Restored access or an organizer-confirmed alternative is needed; no exception has been requested or approved through this task.
