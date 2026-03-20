# Ajo Agent

An autonomous savings pool agent built for the Tether Hackathon Galáctica: WDK Edition.

The agent holds a self-custodial WDK wallet, deploys and manages AjoV1 rotating savings pool contracts on Ethereum Mainnet, and settles value on-chain — coordinated by Claude AI reasoning over real contract state.

> Builders define the rules → Agents do the work → Value settles onchain

---

## Hackathon Submission

Full submission details — tracks, team, and project overview: [Galactica Hackathon Submission — Ajo.pdf](./Galactica%20Hackathon%20Submission%20%E2%80%94%20Ajo.pdf)

---

## Built on AjoV1

This agent operates on top of the AjoV1 smart contracts from [ajo-public](https://github.com/bosinupebi/ajo-public) — an on-chain rotating savings protocol. The AjoV1Factory and AjoV1SavingsPool contracts are deployed on Ethereum Mainnet; this project adds an AI agent layer on top, giving the protocol autonomous management capabilities through a self-custodial WDK wallet and a Claude-powered admin interface.

---

## What it does

Ajo is a traditional rotating savings model (known as Ajo, Esusu, or ROSCA) implemented as autonomous economic infrastructure:

1. **You instruct Claude** in plain language — "create a pool for 5 members with a 7-day interval and 1 token contribution"
2. **The agent deploys the pool** via the AjoV1Factory contract and registers it on the website
3. **A registration website opens** where members submit their Ethereum address to join any open pool
4. **Each pool card** shows a live member progress bar, contribution amount, interval, and member list
5. **When the required member count is reached**, the pool card shows "Membership Closed" and the join form disappears
6. **Multiple pools** can be created and tracked simultaneously — each appears as its own card
7. **PoolManager automatically watches for signups** — once the required member count is reached, it calls `addMembers` on-chain without any admin prompt
8. **PoolManager automatically triggers payouts** — it polls every 60 seconds, sends each payout as soon as the interval elapses, and cycles through members indefinitely as they keep contributing
9. **On server restart**, PoolManager resumes tracking all previously closed pools automatically
10. **Payout errors** are retried up to 3 times; on persistent failure a warning banner appears on the pool card with a dismiss button to retry
11. **Payout history** is tracked per pool — recipient address and tx hash visible on each pool card
12. **Members approve the ERC-20 token and contribute** directly from the pool card UI using their own injected wallet (MetaMask or compatible)

The admin only creates the pool. Everything after — member onboarding and payout cycles — runs autonomously in the background via `PoolManager`.

---

## Architecture

```
http://localhost:3000
  ├── Chat panel (right)       You type instructions to Claude here
  │     POST /api/chat ──────► Orchestrator (SSE stream back)
  │                                │  tool calls
  │                                ▼
  │                            AdminAgent ──────────────► Ethereum Mainnet
  │                              WDK wallet                AjoV1Factory
  │                              viem ABI encoding         AjoV1SavingsPool (×N)
  │                                                        ERC-20 token
  │
  └── Pool cards (left)        Members interact with open pools here
        POST /join ──────────► RegistrationServer (tracks signups)
        GET  /api/pools ──────► Auto-refreshes every 10s
        GET  /api/tx/approve ─► Returns ERC-20 approve calldata (for agents/wallets)
        GET  /api/tx/contribute► Returns pool contribute calldata (for agents/wallets)
        POST /api/broadcast ──► Broadcasts a pre-signed raw transaction
        [wallet connect] ─────► Members approve token + contribute via injected wallet
```

Everything happens through the browser at `http://localhost:3000`. There is no terminal interaction after `npm start`.

Claude has access to the following tools:

| Tool | Description |
|---|---|
| `get_admin_address` | Fetch the agent's wallet address |
| `get_eth_balance` | Check ETH balance before transacting |
| `create_savings_pool` | Deploy a new pool and register it on the website |
| `get_registered_members` | See who has signed up, optionally filtered by pool |
| `wait_for_members` | Block until N members have signed up for a specific pool |
| `add_members` | Add registered addresses on-chain and update their status |
| `get_pool_info` | Read live pool state from the contract |
| `trigger_payout` | Distribute funds — rejects if recipient is not an added member |

---

## Running it

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY, ADMIN_SEED_PHRASE, MAINNET_FACTORY_ADDRESS
npm install
npm start
```

Then open **`http://localhost:3000`** in your browser. That's it — everything else happens in the UI.

**Admin** — use the chat panel on the right to create pools. Everything after is automatic. The chat is also a manual backup — if the autonomous loop misses a step or you need to intervene, you can instruct Claude directly to add members or trigger a payout:

```
Create a pool for 3 members with a 7 day interval and 1 token contribution
→ Pool deployed, card appears on the left showing 0/3 members
→ PoolManager starts watching in the background

[members sign up via the registration site — no admin action needed]
→ Once 3 members join, PoolManager calls addMembers on-chain automatically
→ Card shows "Membership Closed", members show as "added"

[interval elapses — no admin action needed]
→ PoolManager polls every 60s, triggers payout to member[0] automatically
→ Repeats for each member in signup order
→ Tx hashes appear as clickable Etherscan links on each pool card
```

**Members** — visit the same URL, see all open pools, and submit their Ethereum address to join. No seed phrases required from members. Chat history is preserved across page refreshes.

---

## The UI (`http://localhost:3000`)

A single page split into two panels:

**Left — Pool cards** (auto-refresh every 60s)
- Pool contract address
- Contribution amount and interval
- Member progress bar (e.g. `3 / 5`)
- Collapsible member list with `pending` / `added` status per address
- **"Membership Closed"** badge when the required count is reached
- Join form per pool (hidden once closed)
- Collapsible payout history — recipient address and clickable Etherscan tx link per payout
- **Approve Token** — connects to the member's own injected wallet (MetaMask or compatible), approves the ERC-20 token spend for the pool contract
- **Contribute** — calls `contribute(amount)` on the pool contract from the member's wallet

**Right — Agent chat**
- Used to create pools and as a manual backup for the autonomous loop
- Send natural language instructions to Claude (e.g. "add members to pool 0x..." or "trigger payout to 0x...")
- Responses stream in real time
- Tool calls shown as system bubbles
- Transaction hashes are clickable Etherscan links
- Chat history persists in `localStorage` across refreshes
- Clear button to reset the conversation

**Wallet connection** — a "Connect Wallet" button in the top-right header connects any MetaMask-compatible injected wallet. This wallet is used exclusively for member-side approve and contribute actions and is completely separate from the admin WDK wallet.

---

## Agent / Bot API

External agents can participate in pools programmatically without a browser UI.

### Get transaction calldata

```
GET /api/tx/approve?pool_address=0x...&amount=1000000
```
Returns the ABI-encoded calldata to approve ERC-20 token spending for a pool.

```
GET /api/tx/contribute?pool_address=0x...&amount=1000000
```
Returns the ABI-encoded calldata to call `contribute(amount)` on a pool.

**Response shape** (same for both):
```json
{
  "to": "0x...",
  "data": "0x...",
  "value": "0x0",
  "chainId": 1,
  "description": "Approve 1.00 token spend for pool 0x..."
}
```

The `amount` parameter is in the token's raw units — scaled by the token's decimals (e.g. `1000000` for 1 unit of a 6-decimal token).

### Broadcast a signed transaction

```
POST /api/broadcast
Content-Type: application/json
{ "signedTx": "0x..." }
```

Broadcasts a pre-signed raw transaction via the server's RPC node and returns `{ "txHash": "0x..." }`.

**Typical agent flow:**
1. `GET /api/tx/approve?pool_address=...&amount=...` → get calldata
2. Sign the transaction with your own private key
3. `POST /api/broadcast` with the signed hex to send it on-chain
4. Repeat steps 1–3 for `GET /api/tx/contribute`
5. `POST /join` to register your address with the pool

### Existing endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pools` | List all pools with member counts and payout history |
| `GET` | `/api/status/:address` | Check which pools an address has joined |
| `POST` | `/join` | Register an address for a pool (form body: `address`, `pool_address`) |
| `GET` | `/api/tx/approve` | Get ERC-20 token approve calldata |
| `GET` | `/api/tx/contribute` | Get pool contribute calldata |
| `POST` | `/api/broadcast` | Broadcast a signed raw transaction |
| `POST` | `/api/pools/:address/clear-warning` | Dismiss a payout failure warning and retry |

---

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude claude-opus-4-6) |
| `ADMIN_SEED_PHRASE` | BIP-39 seed phrase for the agent's WDK wallet |
| `MAINNET_FACTORY_ADDRESS` | AjoV1Factory — use `0x33D8ED98c9b0De6bc0459BDBA1194c883E24D4A4` |
| `ETH_RPC_URL` | Mainnet RPC endpoint (default: `https://eth.drpc.org`) |
| `REGISTRATION_PORT` | Port for the member signup site (default: `3000`) |
| `TOKEN_ADDRESS` | *(Optional)* ERC-20 token used for pool contributions (default: USDT on Ethereum Mainnet) |

---

## File structure

```
src/
├── admin.ts                       Entry point — starts server (no terminal interaction after)
├── orchestrator.ts                Claude agentic loop, driven by POST /api/chat
├── tools.ts                       Tool definitions and handlers
├── PoolManager.ts                 Autonomous background loop — member watching, addMembers, payouts
├── config.ts                      Environment variable loading
├── abis.ts                        AjoV1 and ERC-20 contract ABIs
├── agents/
│   └── AdminAgent.ts              WDK wallet + all on-chain operations
└── server/
    └── RegistrationServer.ts      Express website with multi-pool tracking
```

---

## Key design principles

- **Self-custodial**: the agent wallet is derived from a BIP-39 seed phrase via WDK — no centralised key custody
- **On-chain settlement**: every action (pool creation, member addition, payout) is a signed Ethereum transaction
- **Agent autonomy**: after pool creation, `PoolManager` autonomously handles member onboarding and recurring payout cycles — no further prompts required; resumes on restart and retries failed payouts with UI feedback
- **Multi-pool**: multiple savings pools can run concurrently, each tracked independently on the website
- **Open participation layer**: any participant — human or agent — can join a pool by `POST /join`, view open pools via `GET /api/pools`, check membership status via `GET /api/status/:address`, and approve/contribute on-chain using the transaction-builder endpoints (`GET /api/tx/approve`, `GET /api/tx/contribute`, `POST /api/broadcast`) — no interaction with the admin agent required
