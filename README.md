# Ajo Agent

An autonomous savings pool agent built for the Tether Hackathon Galáctica: WDK Edition.

The agent holds a self-custodial WDK wallet, deploys and manages AjoV1 rotating savings pool contracts on Ethereum Mainnet, and settles value on-chain — coordinated by Claude AI reasoning over real contract state.

> Builders define the rules → Agents do the work → Value settles onchain

---

## What it does

Ajo is a traditional rotating savings model (known as Ajo, Esusu, or ROSCA) implemented as autonomous economic infrastructure:

1. **The agent deploys a savings pool** via the AjoV1Factory contract, setting the contribution amount and interval
2. **A registration website opens** where members submit their Ethereum address to join
3. **Claude monitors signups** and decides when the target membership is reached
4. **The agent calls `addMembers` on-chain**, committing the member set to the contract
5. **Claude tracks the interval** and triggers payouts to members in sequence when the time is right

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
  viem ABI encoding                              AjoV1SavingsPool
  on-chain reads + writes                        USDT (ERC-20)
    │
    ▼
RegistrationServer (Express)
  localhost:3000
  Members submit their address to join
```

Claude has access to the following tools:

| Tool | Description |
|---|---|
| `get_admin_address` | Fetch the agent's wallet address |
| `get_eth_balance` | Check ETH balance before transacting |
| `create_savings_pool` | Deploy a new pool via the factory |
| `get_registered_members` | See who has signed up via the website |
| `wait_for_members` | Block until N members have registered |
| `add_members` | Add registered addresses on-chain |
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
You: Create a savings pool with a 7 day interval and 1 USDT contribution
Claude: [deploys pool, registration site goes live at localhost:3000]

You: Wait for 3 members to sign up then add them to the pool
Claude: [waits... adds members on-chain once 3 addresses are submitted]

You: Check the pool balance and tell me when payout is due
Claude: [reads contract state, reports interval progress]

You: Trigger payout to the first member
Claude: [computes correct timestamp from pool state, sends payout tx]
```

Members visit `http://localhost:3000`, paste their Ethereum address, and join. No seed phrases required from members — they interact through the website and sign their own transactions independently.

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
    └── RegistrationServer.ts      Express signup website
```

---

## Key design principles

- **Self-custodial**: the agent wallet is derived from a BIP-39 seed phrase via WDK — no centralised key custody
- **On-chain settlement**: every action (pool creation, member addition, payout) is a signed Ethereum transaction
- **Agent autonomy**: Claude reads live contract state to determine when to act — no hardcoded thresholds
- **Human coordination layer**: the registration website lets real users participate without needing to interact with the agent directly
