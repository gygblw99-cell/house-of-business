<p align="center">
  <img src="web/public/logo-v2.png" alt="House of Business" width="140">
</p>

<h1 align="center">House of Business</h1>

<p align="center">
  An AI-powered management platform for restaurants — live in production with real users.<br>
  Designed, built and operated by <b>Guy Gilboa</b>.
</p>

<p align="center">
  <a href="https://houseofbusiness.co.il">houseofbusiness.co.il</a>
</p>

---

## Why I built it

I own and run a smoked-meat restaurant. Every day I saw where time and money were lost: inventory nobody tracked, supplier invoices piling up, food cost that was a guess, and daily sales reports that nobody had time to analyze.

House of Business turns those daily inputs into a live picture of the business — automatically.

## What it does

| Area | Highlights |
|---|---|
| **Sales** | Daily Z-reports are pulled straight from the owner's mailbox (Gmail API / IMAP), parsed — with AI as a fallback for unfamiliar formats — and turned into sales per dish. |
| **Inventory** | Every sold dish deducts its ingredients by recipe; supplier invoices add stock back. Low-stock alerts and a weekly smart-order recommendation. |
| **Suppliers & invoices** | Upload an invoice photo or PDF; AI reads the supplier, items, quantities and prices, and updates stock and cost of goods. |
| **Recipes & food cost** | Recipes linked to real ingredient prices, so food cost per dish is always current. |
| **Finance** | Profit & loss, fixed expenses, VAT periods, supplier payments and reports. |
| **Team** | Shifts, hours and salary calculation, with separate permissions for owners, managers and employees. |
| **AI advisor** | Weekly business reports, price comparisons and on-demand business audits, grounded in the business's own data. |

## By the numbers

- **~99K** lines of code
- **425** API endpoints
- **42** database tables
- **71** screens (Hebrew, RTL)
- **598** automated tests

## Tech stack

- **Backend:** Node.js, Express, PostgreSQL (Supabase), Redis cache with in-memory fallback, Zod validation, Server-Sent Events for live updates
- **Frontend:** Next.js 14 (App Router), React, TypeScript, Redux Toolkit, Tailwind CSS, Recharts
- **AI:** Anthropic Claude, Google Gemini and Groq, with a fallback chain between providers
- **Integrations:** Gmail API / OAuth, IMAP/SMTP, Stripe, Twilio SMS, Firebase push, Cloudflare R2 storage
- **Quality & ops:** Jest, Playwright, Sentry, Docker, Railway, Caddy / nginx

## Architecture

```
backend/   Express API — auth, business logic, AI agents, integrations   (Node.js)
web/       Management platform for owners and staff                      (Next.js)
website/   Marketing website                                             (Next.js)
mobile/    Mobile app                                                    (React Native)
nginx/     Reverse proxy + TLS for self-hosted deployment
```

A few design decisions I'm proud of:

- **Multi-tenant by default** — every query is scoped to a business, with Row Level Security in the database as a second line of defense.
- **Layered security** — bcrypt-hashed passwords, two-factor authentication, rate limiting, input validation on every route, and separate tokens for business users and platform admins.
- **Timezone-safe** — all date logic is explicitly `Asia/Jerusalem`, never the server clock.
- **Resilient to the outside world** — AI providers, email formats and supplier files change without notice, so each integration has a fallback path and a regression test.

## Running locally

```bash
# Backend (API on :3001)
cd backend && npm install && cp .env.example .env && npm run dev

# Management platform (:3002)
cd web && npm install && npm run dev

# Marketing website (:4000)
cd website && npm install && npm run dev
```

Tests: `cd backend && npm test`

---

<p align="center">
  Guy Gilboa · <a href="https://claude.ai/artifact/3wruVL4whruvo73yedZWxH">Resume</a>
</p>
