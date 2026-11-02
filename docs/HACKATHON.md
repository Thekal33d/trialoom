# Celo hackathon alignment

Rechecked **2026-11-02** against [Agents on Open Rails](https://www.loops.house/agents-on-open-rails), reached through [Builder Arena](https://www.loops.house/builder-arena). Selected by the user: **Build with buy**. The user **enrolled on 2026-11-02** and was issued attribution tag `celo_043943600450`. Nothing in the rules changed between the two readings.

## Current official requirements

Deadline: **2026-11-09 09:00 GMT / 10:00 Africa/Lagos**. Build with buy allocates $1,000 across five projects. Judging considers useful paid external-service calls and their growth, with payment proof and named services. Cheap repetitive calls do not qualify as useful integration.

The rules require Celo mainnet, a public GitHub repository at registration, event-period code and an ERC-8004 agent identity. General rules require attribution, while the buy FAQ says no tag is needed for that track; x402 guidance requests PayTo addresses. Preserve payer, service payee and receipt evidence and resolve entry-specific attribution before claiming counted activity.

Two further points were confirmed on the 2026-11-02 reading. The page lists submission contents as a public GitHub repository, and for Build with buy a statement of the services used with proof of payment; it **does not explicitly require a hosted demo, a video or a deployment**, so hosting is a product gate rather than a submission one. And "code is written during the hackathon" is satisfied: kick-off was 2026-10-06 and this repository's first commit is `22e6ce0` on 2026-10-26.

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
- [ ] Add the agent wallet to the entry and register its ERC-8004 identity **from that wallet** before the deadline. The rules state a project is only valid with an ERC-8004 identity. Registry address verified on chain and the registration file drafted; the wallet and a resolvable `agentURI` are the two missing inputs. [ERC-8004 notes](ERC-8004.md)
- [ ] Resolve the relevant x402 payee reporting.
- [ ] Establish a dedicated resource wallet, supported token and explicit aggregate spend cap.
- [ ] Execute one useful, capped buy request through the product; retain result and matching receipt.
- [ ] Demonstrate durable uncertain-payment recovery and zero customer reimbursement.
- [ ] Observe a genuine external user benefiting from the result; describe user provenance accurately.
- [x] Write the repository's front door: what is true today, what is not, how to run it, and where each claim's checkpoint lives.
- [ ] Complete public-safe demo, setup instructions, limitations and final commit.
- [ ] Submit and retain confirmation before the deadline.

## Evidence index

| Item | Current evidence |
| --- | --- |
| Track / enrollment | Build with buy selected; **enrolled 2026-11-02**, attribution tag `celo_043943600450` issued and wired in |
| Public repo / hosted demo | User push to GitLab verified at `633c2cf` on 2026-11-01; both histories preserved. GitLab visibility not independently verified. User's GitHub is currently unavailable; required public GitHub repository and hosted demo remain missing |
| Agent identity / funded resource wallet | Not configured. ERC-8004 identity is mandatory and does not exist yet; the Celo mainnet registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is verified against the chain and [`public/agent.json`](../public/agent.json) is drafted with the unfilled fields left empty rather than guessed. [Notes](ERC-8004.md) |
| Real browser results / replay | Local owned fixture and authorized Blokaz ladder; [verified checkpoint](evidence/RUN-03-ladder-verified.json) |
| Payment recovery | Local Celo fork only; [VAL-03](evidence/VAL-03.json), [VAL-04](evidence/VAL-04.json) |
| Useful buy output / mainnet receipt | Pending; [unsigned quote/input boundary](BUY-01.md) verified, with no payment |
| External beta users / submission | Pending |

Registration, publication and funding require concrete destination/identity/budget details. Keep private customer data, credentials, raw traces and provider capabilities out of public evidence. A working demo does not itself close public beta operations gates.

Continue development using [the GitLab repository](https://gitlab.com/Otaiki1/trialoom). GitHub unavailability does not waive the official public GitHub requirement. Restored access or an organizer-confirmed alternative is needed; no exception has been requested or approved through this task.
