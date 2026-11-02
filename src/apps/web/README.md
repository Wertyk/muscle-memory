# Chat

For Muscle Memory's product overview, current setup and rehearsal instructions,
architecture, and hackathon disclosures, read the [workspace README](../../README.md).

## Kiln & Co. fixture data

All shop data is 100% synthetic: customer names, businesses, street addresses,
city names, orders, shipments, and correspondence were invented for this
project and do not represent actual people or transactions. State codes and ZIP
formats are plausible US formats; emails use reserved `example.com` and
`example.test` domains. Labels and replies are stored records; no carrier labels
are purchased and no email is sent. This disclosure stays outside the shop's
customer-facing content.

From the repository root, `pnpm -C src reset:shop` empties only the shop tables;
`pnpm -C src seed:shop` replaces them with repeatable data using seed `20261102`
and reference time `2026-11-02T12:00:00.000Z`. Local PGlite needs no
`DATABASE_URL`. Open request ages span the preceding three days; handled history
has earlier, varied dates. The data contains 25 products, 40 customers, 60
original orders plus one replacement, and 30 open / 30 handled requests.

Rehearsal cases:

- `req_0001` / `ord_1001`: Ember Large Serving Platter, USD 280 per unit.
  A 50% refund for one damaged unit is USD 140 and requires approval.
- `req_0031`–`req_0037`: standard damaged-item history, with a 50% unit-price
  refund, reply, and tag.
- `req_0038` / `ord_1038`: replacement `ord_1061` instead of a refund, with zero
  additional payment.
- `req_0039` / `ord_1039`: a USD 380 platter refunded in full.
- `req_0040` / `ord_1040`: a 50% refund with a distinct personal reply.

The three exceptions are deliberate backtest comparison cases. They are stored
as actual fixture outcomes in orders, refunds, replies, and request tags.

The minimal agent-native starter app — a clean, ChatGPT-style shell with chat at
the center, durable threads, standard app navigation, auth, live sync, and
actions. Start here when you want a real browser app to build on without
committing to a domain template.

**Live app: [chat.agent-native.com](https://chat.agent-native.com?utm_source=github&utm_medium=referral&utm_content=chat-readme)**

Chat is the basic agent-native app starting point. It gives you the app-agent
loop wired end to end and one example action, so you can add your own UI, data,
and actions on top.

## Features

- ChatGPT-style shell with a threads list and durable chat history.
- Auth, live sync, and application state wired out of the box.
- The action surface the agent and UI share, plus one example action to copy.
- A minimal, brandable base for any domain app.

## Develop locally

Scaffold your own copy and run it:

```bash
npx --yes @agent-native/core@latest create my-app --standalone --template chat
cd my-app
corepack enable
pnpm install
pnpm dev
```

Full docs: [agent-native.com/docs/template-chat](https://agent-native.com/docs/template-chat?utm_source=github&utm_medium=referral&utm_content=chat-readme).
