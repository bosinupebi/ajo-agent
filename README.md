# Ajo Agent

An autonomous savings pool agent built for the Tether Hackathon Galáctica: WDK Edition.

The agent holds a self-custodial WDK wallet, deploys and manages AjoV1 rotating savings pool contracts on Ethereum Mainnet, and settles value on-chain — coordinated by Claude AI reasoning over real contract state.

> Builders define the rules → Agents do the work → Value settles onchain

---

## What it does

Ajo is a traditional rotating savings model (known as Ajo, Esusu, or ROSCA) implemented as autonomous economic infrastructure:

1. **You instruct Claude** in plain language — "create a pool for 5 members with a 7-day interval and 1 USDT contribution"
2. **The agent deploys the pool** via the AjoV1Factory contract and registers it on the website
3. **A registration website opens** where members submit their Ethereum address to join any open pool
4. **Each pool card** shows a live member progress bar, contribution amount, interval, and member list
5. **When the required member count is reached**, the pool card shows "Membership Closed" and the join form disappears
6. **Multiple pools** can be created and tracked simultaneously — each appears as its own card
7. **Claude monitors signups** and decides when to call `addMembers` on-chain, updating member statuses to "added"
8. **Claude tracks intervals** and triggers payouts to members when instructed

The admin never manually submits a transaction. Claude reasons over on-chain state — balances, intervals, payout timestamps — and acts through the agent wallet.

---

## Architecture

```
You (operator)
    │  natural language instructions
    ▼
Claude (claude-opus-4-6)
    │  tool calls
    ▼
AdminAgent  ──────────────────────────────────► Ethereum Mainnet
  WDK self-custodial wallet                      AjoV1Factory
  viem ABI encoding                              AjoV1SavingsPool (×N)
  on-chain reads + writes                        USDT (ERC-20)
    │
    ▼
RegistrationServer (Express)
  localhost:3000
  Pool cards with live member tracking
  Members submit their address to join
  Membership Closed badge when pool is full
```

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
| `trigger_payout` | Distribute funds to the next recipient |

---

## Running it

```bash
cp .env.example .env   # fill in seed phrase, API key, factory address
npm install
npm start
```

Then instruct Claude in plain language:

```
You: Create a pool for 3 members with a 7 day interval and 1 USDT contribution
Claude: [deploys pool, card appears at localhost:3000 showing 0/3 members]

You: Create another pool for 5 members with a 30 day interval and 5 USDT
Claude: [deploys second pool, second card appears alongside the first]

You: Wait for 3 members on the first pool then add them
Claude: [waits... adds on-chain once 3 sign up, site shows "Membership Closed"]

You: Check pool balance and tell me when payout is due
Claude: [reads contract state, reports interval progress]

You: Trigger payout to the first member
Claude: [computes timestamp from pool state, sends payout tx]
```

Members visit `http://localhost:3000`, see all open pools, and submit their Ethereum address to join. No seed phrases required from members.

---

## Registration website

Each pool appears as a card showing:
- Pool contract address
- Contribution amount and interval
- Member progress bar (e.g. `3 / 5`)
- Collapsible member list with pending/added status per address
- **"Membership Closed"** badge and notice when the required count is reached
- Join form (hidden once membership is closed)

The page auto-refreshes every 5 seconds.

---

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude claude-opus-4-6) |
| `ADMIN_SEED_PHRASE` | BIP-39 seed phrase for the agent's WDK wallet |
| `MAINNET_FACTORY_ADDRESS` | AjoV1Factory contract address on Ethereum Mainnet |
| `ETH_RPC_URL` | Mainnet RPC endpoint (default: `https://eth.drpc.org`) |
| `REGISTRATION_PORT` | Port for the member signup site (default: `3000`) |

---

## File structure

```
src/
├── admin.ts                       Entry point — starts server and Claude chat
├── orchestrator.ts                Interactive Claude REPL loop
├── tools.ts                       Tool definitions and handlers
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
- **Agent autonomy**: Claude reads live contract state to determine when to act — no hardcoded thresholds
- **Multi-pool**: multiple savings pools can run concurrently, each tracked independently on the website
- **Human coordination layer**: the registration website lets real users participate without needing to interact with the agent directly
