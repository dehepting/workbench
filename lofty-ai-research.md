# Lofty.ai — Programmatic Data Access Research

**Research date:** 2026-10-09
**Method:** Web search + direct HTTP probes (no credentials used anywhere).
**Convention:** ✅ = verified by me (live probe or primary source I fetched). ⚠️ = reported by a third party I could not independently confirm. ❌ = could not verify / explicitly not found.

---

## ⚠️ Naming hazard — read first

**`lofty.ai` (the tokenization platform) is NOT `lofty.com` / `Lofty, Inc.` (a real estate CRM, formerly CINC).**

- `https://developer.lofty.com/` and `https://api.lofty.com/docs` are the **CRM company's** developer docs — 94–115 endpoints for leads, MLS listings, transactions, webhooks. **Completely unrelated product.** Do not build on these.
- Lofty.ai's own domains: `www.lofty.ai`, `api.lofty.ai`, `amm.lofty.ai` (lending), `images.lofty.ai`, `services.lofty.ai`.
- ❌ `docs.lofty.ai` and `developer.lofty.ai` **do not resolve** (ENOTFOUND) — I verified via DNS lookup. Lofty.ai has **no public developer documentation site and no OpenAPI spec.**

---

## 1. Product model — ✅ VERIFIED

**Fractional/tokenized U.S. real estate with a peer-to-peer limit-order book, plus an AMM.**

Sources I fetched:
- `https://www.lofty.ai/how-it-works` (via search snippet + `llms-full.txt`)
- `https://www.lofty.ai/help/articles/6145558-how-the-lofty-marketplace-works` → 200
- `https://algorand.co/case-studies/lofty-transform-real-estate-industry` → 200
- `https://www.lofty.ai/terms` → 200
- Live API responses (below)

### Verified mechanics

| Fact | Source |
|---|---|
| Tokens are **Algorand Standard Assets (ASAs)**; each property is its own **legal LLC/DAO**; buying tokens = buying a membership interest in that LLC | ✅ help article `6145595`, Algorand case study |
| **Bid/ask order book confirmed.** Sellers place **sell limit orders** (price they accept), buyers place **buy limit orders** (max price they'll pay). Orders match on price. | ✅ help articles `6559222` + `6167215` |
| **Tokens go to escrow when listed**; seller still owns them and still receives rent while the order rests | ✅ help article `6167215` |
| Default limit price auto-fills from **HouseCanary** valuation ("estimated price") | ✅ help articles |
| **No order-book minimum tick mentioned;** orders expire (default **30 days** per SDK) | ⚠️ SDK README |
| **Two venues:** order book (P2P limit orders) **and** AMM pools. Quotes report `source: 'amm'` or `'orderbook'` | ⚠️ official SDK README |
| Fees: **2.5% buy, 3% sell** (market orders, "paid to market makers"); help article also states **3% seller fee** for direct P2P listings | ✅ `how-it-works` + `6167215` — *note the inconsistency: 2.5% vs 3% on buys/sells depending on page* |
| Rent paid **daily ~midnight UTC** | ✅ `how-it-works` |
| Max **15% of a property's shares** per investor; sellers must retain ≥10% equity; up to 90% sellable | ✅ `how-it-works` |
| Governance: Robert's Rules of Order; motion → second → 48h discussion → 72h vote. Some properties use **scaled (ownership-weighted) voting**, others 1 token = 1 vote | ✅ `how-it-works` + governance text embedded in API `updates` field |
| On-chain votes are queryable at **`https://allo.info/application/<appId>`** — properties expose `dao_app_id` / `participant_app_id` | ✅ URLs appear verbatim in API response `updates` field |

### DAO structure — confirmed, but nuance
Lofty itself says: *"We do not own or manage any of the assets... we allow anyone interested in selling a property to sell to many buyers, who collectively manage and own the property through a legal DAO in the United States."* ✅ (Algorand case study, quoting co-founder Jerry Chu)

---

## 2. Public API — ✅ THREE UNAUTHENTICATED ENDPOINTS FOUND

### ⚠️ CRITICAL: There are TWO separate API surfaces on `api.lofty.ai`

| Surface | Base | Auth | Purpose |
|---|---|---|---|
| **Internal/website** | `https://api.lofty.ai/prod` | Cognito `idToken` (browser session) — **but a handful of reads are open** | What the lofty.ai SPA calls |
| **Official SDK** | `https://api.lofty.ai/public/v1` | `Authorization: Bearer lofty_live_…` (API key from dashboard) | `@loftyaicode/sdk` |

They are **unrelated credential systems** — an SDK key does not authenticate `/prod`, and vice versa. ⚠️ (per `piekstra/lofty-cli` docs; consistent with my probes)

---

### ✅ OPEN ENDPOINTS (HTTP 200, zero credentials, verified by me 2026-10-09)

#### A) `GET https://api.lofty.ai/prod/properties/v2/marketplace`

```
Status: 200  Content-Type: application/json  ~3,061,518 bytes (all 83 properties)
```

Query params I verified work:
- `?page=<n>` — works. `?pageSize=<n>` — works (**max 200**, default 200 when omitted... actually default when a param is present differs; safest: always pass `pageSize=200`).
  - `?page=1&pageSize=50` → `meta.pageSize=50, count=50, next=2`
  - `?page=99&pageSize=3` → `meta.pageSize=20, count=0` (returns 0, not an error)
  - **Gotcha:** `?page=1&pageSize=3` came back `pageSize: 20`. Small values are clamped/reset. Test empirically.
- `?propertyType=ALL` → returned 36 properties (filtered).
- `?limit=`, `?location=all` → ignored (returned all 83).
- `?slug=<slug>` → **ignored**, returns everything.

Envelope:
```json
{ "success": true, "status": "ok", "message": "success",
  "data": { "properties": [ … ], "meta": { "cacheHit", "page", "pageSize", "count",
            "propertiesMeta": { "hasNew", "hasUpcoming", "minPry", "maxPry", "minPan", "maxPan" } } },
  "meta": {} }
```

**83 properties**, union of **115 distinct field names**. See §3.

Cache headers: `cache-control: public, max-age=120, stale-while-revalidate=60`, `cf-cache-status: DYNAMIC`.

#### B) `GET https://api.lofty.ai/prod/exchange/v2/getpropertyorderbook?propertyId=<ULID>`

```
Status: 200  ~213 bytes (empty) to ~3.7 KB
```

- **`propertyId` must be the ULID `id`** (e.g. `01K1VKTF50B18YPKEKKMNT988E`), **NOT** `assetId`, `dao_app_id`, or `oldAssetId`. Those return a valid 200 with empty books (silent wrong-answer risk!).
- Wrong param name (`id=`, `assetId=`) → HTTP **500** `{"error":"propertyId is required"}`.

```json
{ "success": true, "status": "ok", "message": "success",
  "data": {
    "propertyId": "01K1VKTF…",
    "orderBook": {
      "buyOrders":  [ { "quantity": 2.9224, "price": 43,    "propertyId": "…",
                        "id": "01M4ENB0G8TM9HXATR08Y1VXSA",
                        "expireAt": 1799273104997, "createdAt": 1791493506641 }, … ],
      "sellOrders": [ { "quantity": 3.9044, "price": 46.46, … }, … ]
    },
    "ranges": { "buy": {"min":1.1,"max":43}, "sell": {"min":46.46,"max":60.97} },
    "error": null
  }, "meta": {} }
```

- `buyOrders` sorted **descending** by price (best bid first) ✅ verified across 18 orders
- `sellOrders` sorted **ascending** by price (best ask first) ✅ verified across 4 orders
- This is a **full depth book with order-level granularity** — order IDs, sizes, prices, creation & expiry timestamps.

#### C) `GET https://api.lofty.ai/prod/exchange/v2/getpropertyinfo?propertyId=<ULID>`

```
Status: 200  ~170–320 KB
```

**Full trade history + market summary:**

```json
{ "data": {
  "transactions": [ { "status":"completed", "paymentCurrency":"usdc",
      "quantity":0.0956, "price":46.46, "propertyId":"…", "id":"01M4GPP9…",
      "createdAt":1791562032986, "updatedAt":…,
      "buyOrderCreatedAt":…, "sellOrderCreatedAt":…,
      "usedExchangeRate":10000, "exchangeRateDecimals":6, "swappedAmount":4441576 }, … ],
  "ranges": { "period": {"min":26.49,"max":46.47}, "allTime": {"min":1,"max":50} },
  "lastPrice": 46.46,
  "tradeVolume": 12097.814026999991,
  "secondaryEnabled": true,
  "coc": 7.86, "capRate": 4.83, "projectedCoc": 6.89, "projectedCapRate": 4.23,
  "limitTokensAvailable": 7429.263800000001
}}
```

Sampled trade counts: **492, 874, 914, 542, 1058, 143, 557, 202, 142, 5** transactions per property. **No round cap** (1058 and 143 and 5 all appear) and no pagination params → these are almost certainly **complete fill histories per property**, not a truncated window. ⚠️ Still inferred, not documented.

---

### ❌ ENDPOINTS THAT DID NOT WORK (all probed unauthenticated)

| URL | Status | Body |
|---|---|---|
| `https://api.lofty.ai/` | 403 | `{"message":"Forbidden"}` |
| `https://api.lofty.ai/v1/properties` | 403 | `{"message":"Forbidden"}` |
| `https://api.lofty.ai/v2/properties` | 403 | `{"message":"Forbidden"}` |
| `https://api.lofty.ai/public/v1/properties` | **401** | `{"message":"Unauthorized"}` |
| `…/public/v1/properties` w/ `Bearer bogus` | **403** | `{"message":"User is not authorized to access this resource with an explicit deny in an identity-based policy"}` (AWS Cognito/IAM style) |
| `https://api.lofty.ai/public/v1/amm/pools` | 401 | `{"message":"Unauthorized"}` |
| `https://api.lofty.ai/public/v1/market/properties` | 403 | `{"message":"Missing Authentication Token"}` (API Gateway — likely non-existent route) |
| `…/prod/properties` | 403 | `{"message":"Forbidden"}` |
| `…/prod/properties/v2/property?id=…` | 403 | `{"message":"Forbidden"}` |
| `…/prod/properties/v2/lookup?…` | 403 | `{"message":"Missing Authentication Token"}` |
| `…/prod/properties/v2/ticker`, `/featured`, `/oracle-price`, `/get-property-yields`, `/get-list-view-data*` | 403 | `{"message":"Forbidden"}` |
| `…/prod/exchange/v2/getpropertytxns?propertyId=…` | 403 | `{"message":"Forbidden"}` |
| `…/prod/exchange/v2/getuserinfo`, `/getorderandstreams` | 403 | `{"message":"Forbidden"}` |
| `…/prod/amm/*`, `/prod/lp-rewards/*`, `/prod/blog/v2/home`, `/prod/payments/*`, `/prod/users/*`, `/prod/transactions/*`, `/prod/geolocation/*`, `/prod/marketing/*` | 403 | `{"message":"Forbidden"}` |
| `https://docs.lofty.ai/` | — | DNS ENOTFOUND |
| `https://developer.lofty.ai/` | — | DNS ENOTFOUND |

### 🚨 THE 403 TRAP — do not probe for route discovery

⚠️ Per `piekstra/lofty-cli/docs/api.md` (verified consistent with my probes):

> A route that is **real but gated** and a route that **never existed** return **byte-identical** `403 {"message":"Forbidden"}`. An AWS Cognito authorizer would normally return `401` for an unparseable token; this surface does not.

**Consequence:** *absence of a 200 is not evidence that a route doesn't exist, and a 403 is not evidence that it does.* I confirmed `/prod/zzz/v2/not-real` → 403, identical to gated routes. **You cannot discover routes by probing.**

---

## 3. Data fields per property — ✅ VERIFIED

### From the open marketplace endpoint (115 distinct keys; these are the ones I saw with real values)

**Identity / location**
`id` (ULID), `assetId` (Algorand ASA id), `oldAssetId`, `assetUnit` (`LFTY0477`), `assetName`, `assetDecimals` (6), `slug`, `address`, `address_line1`, `address_line2`, `city`, `state`, `zipcode`, `lat`, `lng`, `market`, `property_type`, `dataType`, `ownerId`, `assetCreator` (Algorand addr), `reserveOwnerId`, `dao_app_id`, `participant_app_id`, `featured`

**Token supply / ownership**
`numIssued` (46646), `tokens` (75914), `num_sold` (75914), `assetLineage[]`, `partialOwned`, `hideMkt`, `hide_details`, `isSellerBuyBack`, `timeline_offering_complete`

✅ **Supply semantics (verified across all 83 properties):**
- `tokens === num_sold` for **every** property → these are the same value.
- `total_investment / tokens` ≈ **$50.00** for most properties (50.000, 50.000, 50.000, 50.000, 50.000, 50.000…) — matching Lofty's documented "$50 initial token price". ⇒ **`tokens` = total shares outstanding at original issuance.**
- `sale_price / tokens` ≈ **$44–50** — the *original* per-share sale price, **not** the live market price.
- `numIssued` is **absent on 36/83** properties and always `≤ tokens` when present (e.g. 46646 vs 75914). **Semantics unconfirmed** — possibly circulating/legacy. ⚠️ Do not use it as shares outstanding.
- `assetDecimals` is `6`, `null`, or `0` — **properties differ** (whole-share vs fractional). Check before computing per-share values.

**Market cap proxy:** `tokens × live price` (from orderbook `lastPrice`/best bid). ⚠️ Derived, not published by Lofty.

**💰 Yield / return metrics** — see §4 for definitions
`cap_rate` (3.45), `projected_rental_yield` (6.4), `projected_annual_return` (8), `irr` (8.9), `coc` (7.3), `appreciation` (1.6), `gross_yield`, `projected_annual_cash_flow` (149250), `cash_flow` (170322.58), `underlying_price`, `redemptionPrice`

**💰 Order book summary (embedded in marketplace payload)**
```json
"trading": {
  "buyOrderTokens": 167.8782,     // total bid depth in tokens
  "sellOrderTokens": 7447.9904,   // total ask depth in tokens
  "buy":  { "min": 0, "max": 0 },
  "sell": { "min": 46.46, "max": 60.97 }
}
```
⚠️ **Caveat:** for the property I checked, `trading.buy` was `{0,0}` while the live order book had **18 bids** ranging $1.10–$43. The `sell` range matched the order book exactly. **Do not trust `trading.buy.min/max` as the bid range — use the orderbook endpoint.** (May be a stale/cached field; `meta.cacheHit` was `true`.)

**Financials**
`sale_price` (3793150), `total_investment` (3795700), `current_loan` (1463385.6), `monthly_loan_repayment`, `monthly_rent` (1041.67), `ownerRent` (bool), `taxes`, `insurance`, `utilities`, `utilities_water_sewer`, `management_fees`, `maintenance_reserve`, `curr_maintenance_reserve`, `vacancy_reserve`, `llc_admin_fee_yearly`, `llc_admin_fee_upfront`, `closing_costs`, `city_transfer_tax`, `total_fees`, `listing_fee`, `capitalize_fees`, `or_replenishment`, `is_delinquent`

**Occupancy**
`is_occupied` (bool), `custom_occupancy`, `available_date`, `lease_begins_date`

**Building**
`sqft`, `year_built`, `beds`, `baths`, `neighborhoodScore`, `thumbnail`, `images[]`, `description`, `documents[]` (title + targetUrl, often Dropbox)

**Timestamps (epoch ms)**
`createdAt`, `updatedAt`, `starting_date`, `original_starting_date`, `sellout_date`, `original_sellout_date`, `closing_date`

**Historical valuation (only 20/83 properties had populated data)**
```json
"avmHistory": {
  "sales":   [ { "price", "recordDate", "buyer", "seller", "apn",
                 "recordDocument", "eventType":"arms_length_sale",
                 "isLoftySale", "hc_blockId", "hc_addressId", … } ],
  "prices":  [ { "price", "recordDate":"2021-12-01", "priceType":"current",
                 "reportLink":"https://loftyai-llc-avm-reports.s3.amazonaws.com/….pdf",
                 "sentinelPrice", "disabled", … } ],     // monthly HouseCanary AVM
  "trend":   [ { "date", "oldPrice", "newPrice", "pctChange", "reportLink" } ],
  "latest":  { … }, "overall": { "oldPrice":176031, "newPrice":236082, "pctChange":0.341139 }
}
```
⚠️ In my samples the AVM `prices` array stopped at **2023-09 / 2023-10**. Historical coverage appears to be legacy/stale for older listings. **Verify per property before relying on it.**

**Other**
`updates` — a **long markdown field of owner/manager property updates including governance vote results with on-chain `allo.info` links.** Surprisingly rich; could be mined for events.

### Fields shown on the website (`/property_deal/<slug>`) — ✅ verified by fetching the SSR HTML

```
Share price • Avg yield • Current yield (7.86%)
Tabs: Details | Financials | Order book | Community
About / Property Management / Due Diligence Documents
Offering Details: Total Property Value, Equity, Debt, Closing Costs,
                  LLC Formation, Operating Reserve
Projected Returns: Total Return Model — Annual Cash Flow + Appreciation
                   Monthly Cash Flow, Monthly Rent, Monthly Expenses,
                   Net Monthly Cash Flow, Annual Appreciation
Returns tab: Projected Annual Return | Average Rental Yield |
             Projected Appreciation | Current Rental Yield
Monthly Operating Statement: Gross Rent, Property Taxes, Insurance, …
Returns Calculator: Rental Yield %, Investment Amount, Annual Appreciation %,
                    7-Year Projection
Market: city narrative
Property Updates, Investor Reviews, FAQ
```

Marketplace card (`/marketplace`) shows: `address, city, state, zip, $46.46 /share, 7.8 % avg yield, 117 investors`, plus tags (`Cash Flowing`, `No Mortgage`, `Commercial`, `Seller Buyback`, …).

**Marketplace index page also shows an aggregate:** `5.6% avg yield 46` (as of the fetch).

---

## 4. Yield/return metrics — definitions ✅ VERIFIED (quoted verbatim from property page SSR)

| Metric | Lofty's own definition (verbatim) |
|---|---|
| **Average Rental Yield** | *"the average annualized rental yield an investor can expect for this property, based on a **simple average of all historical yield data since the property has been listed on the Lofty exchange**."* |
| **Current Rental Yield** | *"this month's **realized** rental yield, annualized. This value is based on the **lowest purchase price available at the time**, so it can differ from the yield you see in your account based on your unique cost basis."* |
| **Projected Annual Return** | Shown alongside the above. **Formula not published.** |
| **Projected Appreciation** | *"a measure of the estimated increase in value of a property over a **one year** time period."* |
| **Cap Rate / CoC / IRR / projected_rental_yield** | Present in the API. **Lofty publishes no formulas for these.** ❌ (see formula-testing table below) |
| **Projected Returns model** | *"The calculations assume a **7-year hold period** and an **average annual net operating income increase of 3%**."* Annual appreciation presets: **8.0% (10-yr US avg), 4.5% (20-yr US avg)** — sourced from **Zillow ZHVI Single Family Homes**, 35th–65th percentile, Mar 2003–Mar 2023. |

**Headline figure:** *"As of May 2026 the marketplace average rental yield is **9.2%**"* ✅ (`/how-it-works`). ⚠️ Note `/marketplace` SSR showed **5.6% avg yield** at fetch time — these disagree; different definitions or different dates.

✅ **Cross-check:** `getpropertyinfo.coc` = **7.86** for 2820 Rucker Ave, and the property page SSR displayed **"Current yield 7.86%"** — so **`getpropertyinfo.coc` is what the site renders as "Current yield."**

### Formula testing — ✅ ONE CONFIRMED, rest ❌ FAILED

I tested candidate formulas against **all 83 properties** (2% relative tolerance):

✅ **CONFIRMED (79/79 exact matches):**
```
projected_annual_return  ==  projected_rental_yield  +  appreciation
```

❌ **DISPROVED** (matched only a handful, i.e. coincidental):

| Candidate | Matched |
|---|---|
| `projected_rental_yield == projected_annual_cash_flow / total_investment × 100` | 32 / 62 |
| `projected_rental_yield == projected_annual_cash_flow / sale_price × 100` | 9 / 62 |
| `projected_rental_yield == cash_flow / total_investment × 100` | 2 / 62 |
| `projected_rental_yield == monthly_rent×12 / sale_price × 100` | 0 / 62 |
| `projected_rental_yield == monthly_rent×12 / total_investment × 100` | 0 / 62 |
| `coc == projected_annual_cash_flow / total_investment × 100` | 2 / 42 |
| `cap_rate == cash_flow / sale_price × 100` | 2 / 67 |
| `irr == coc` | 7 / 81 |

**Conclusion:** `projected_rental_yield`, `coc`, `cap_rate`, `irr` are **not reproducible** from the other numeric fields in the payload. Their inputs (probably a pro-forma NOI or a denominator tied to the *live* token price rather than `sale_price`) are **not present in the response**. ❌ **Treat them as opaque platform-published values.**

---

## 5. Unofficial / community tooling — ✅ FOUND

### `piekstra/lofty-cli` — ✅ the best reference
- **https://github.com/piekstra/lofty-cli** (Rust, MIT, created 2026-07-21, 0 stars, 28 commits)
- Key docs: `https://raw.githubusercontent.com/piekstra/lofty-cli/main/docs/api.md` → 200 (6,228 bytes)
- **`src/catalog.rs`** → 200: a **static harvest of 124 endpoints** scraped from the website's JS bundle, with path, name, group, and safety class (`Read`/`Write`/`Admin`). Groups: `admin, algocontracts, blog, emails, exchange, geolocation, liquidity, lp-rewards, marketing, payments, properties, property-managers, taxdocuments, transactions, users, verifications, wallet`.
  - ⚠️ **No HTTP method recorded, never live-verified, and the 403 trap makes verification-by-probe impossible.** Treat as a map, not a contract.
- Read routes of interest from the catalog: `/properties/v2/marketplace`, `/properties/v2/property`, `/properties/v2/ticker`, `/properties/v2/oracle-price`, `/properties/v2/get-property-yields`, `/exchange/v2/getpropertyorderbook`, `/exchange/v2/getpropertytxns`, `/exchange/v2/getpropertyinfo`, `/lp-rewards/enabled`, `/lp-rewards/dashboard`, `/lp-rewards/history`
- ⚠️ Reports **rate limits (per key): 300 reads/min, 30 writes/min; writes also 60/min per account.**

### `earlvanze/lofty-utils` — ✅ exists, stale
- **https://github.com/earlvanze/lofty-utils** — Python, 0 stars, created 2024-03-11, **last push 2024-04-03** (dormant)
- README: *"tools to interface with Lofty.ai and Algorand APIs"*, contains `get_orders.py`, `order_book_analysis.py`, links a Google Sheet of liquidity-pool analysis.
- ⚠️ **Likely outdated** (2024, pre-AMM, pre-current API). Verify before copying.

### `@loftyaicode/sdk` — ✅ OFFICIAL npm package
- **https://registry.npmjs.org/@loftyaicode/sdk` → 200.** Latest **0.8.1**. Maintainer `alphagoat <mark@lofty.ai>` (Mark Keane, Lofty founding engineer ✅ per lofty.ai/team). License MIT. *"Official TypeScript SDK for the Lofty trading API."*
- I downloaded and unpacked it. **Complete `/public/v1` route list extracted from the bundle:**

```
/public/v1/account/balance        /public/v1/account/lp-positions
/public/v1/account/lp-programs    /public/v1/account/lp-rewards
/public/v1/account/positions      /public/v1/account/trades
/public/v1/account/withdrawals    /public/v1/amm/pools
/public/v1/amm/pools/{poolId}     /public/v1/amm/quote
/public/v1/amm/swap               /public/v1/orders
/public/v1/orders/{orderId}       /public/v1/properties
/public/v1/properties/{id}                    /public/v1/properties/{id}/orderbook
/public/v1/properties/{id}/trades             /public/v1/recurring-plans
/public/v1/recurring-plans/{planId}           /public/v1/swaps/{batchId}
/public/v1/users                 /public/v1/users/api-keys
/public/v1/users/deposit-addresses
```

- Base URL: `https://api.lofty.ai`. **All require `Bearer lofty_live_…` / `lofty_test_…`.**
- **Requires a Lofty account + completed KYC + a dashboard-generated API key** (`Settings → API Keys`).
- Read-only keys exist (market data + balance); a **Trading** toggle is required for order placement/cancel.
- SDK **refuses to run in browser contexts** (throws) to avoid key exposure. Node 18+.

### Other GitHub results
- `SolutionsCorridor/lofti-ai-clone` — a React/Tailwind UI clone, **no API value**.
- GitHub code search for `lofty.ai` repos returned **13 total**, most irrelevant. **No mature scraper framework found.**

### On-chain route (⚠️ plausible but untested by me)
Tokens are Algorand ASAs; `assetId` is exposed per property. Algorand APIs (algod/indexer, `allo.info`) are public. **I did not verify** that you can reconstruct prices/holders purely from chain data — the order book appears to be **off-chain** (Lofty's matcher), so on-chain data likely gives you *holdings and transfers*, not the book.

---

## 6. Rate limits, auth, ToS — ✅ VERIFIED where noted

### Rate limits

| Surface | Limit | Evidence |
|---|---|---|
| **`/public/v1` (SDK)** | **300 reads/min per key, 30 writes/min per key, 60 writes/min per account across keys.** Headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. `429` + `Retry-After`. | ✅ official `@loftyaicode/sdk` README (v0.8.1), which I downloaded |
| **`/prod` (open reads)** | **❌ NO RATE LIMIT OBSERVED.** Largest burst: **120 consecutive requests in 15.7 s** (≈7.6 req/s) at `getpropertyorderbook` → **120/120 HTTP 200**. Also **40/40 in 9.0 s** (4.4 req/s) at `properties/v2/marketplace`, and 30/30 in 4.2 s on the orderbook. **Never saw a 429, `X-RateLimit-*`, or `Retry-After` header.** | ✅ my own probe |

**Headers actually present on `/prod`:** `server: cloudflare`, `cf-ray`, `cf-cache-status: DYNAMIC`, `x-amzn-RequestId` (AWS API Gateway/Lambda), `cache-control`.

> ⚠️ **My burst test was small (40 req). This is NOT proof that no limit exists.** Cloudflare WAF or gateway throttling could trigger at higher volume or over time. **Be polite: cache the 3 MB marketplace payload (it has `max-age=120`), poll orderbooks at a modest interval, and back off on any 429/403 change.**

### Auth requirements — summary

| Data | Auth needed |
|---|---|
| All 83 property records + financials + AVM history | **None** ✅ |
| Full order book (all levels, order-level) | **None** ✅ |
| Full trade history + last price + volume + CoC/cap | **None** ✅ |
| Single-property detail (`/properties/v2/property`) | 403 — likely Cognito session |
| Tax documents (`/taxdocuments/v2/all`) | 403 — Cognito session only, **not** SDK key ⚠️ |
| Order placement, account, positions, rewards | SDK key (`lofty_live_…`) + KYC'd account |
| AMM pools / quotes / swaps | SDK key |

### Terms of Service — ⚠️ IMPORTANT CONSTRAINT

**`https://www.lofty.ai/terms` → 200.** Last updated **May 1, 2026.** Section **4.1 Prohibited Activity** lists, verbatim:

> **Data Mining or Scraping.** Activity that involves data mining, robots, scraping, or similar data gathering or extraction methods of content or information from any of our Products.

Also in 4.1: `Cyberattack`, `Market Manipulation` (incl. wash trading), `Securities and Derivatives Violations`.
Section 3.1 grants only *"a limited, revocable, non-exclusive, non-sublicensable, non-transferable license to access and use our Products"* and prohibits *"use, modify, distribute, tamper with, **reverse engineer**, disassemble or decompile any of our Products."*

**The "Products" are defined as** the website (`lofty.ai`), the interface, **and associated services** — so the API arguably falls under this.

> 🔴 **This is a real ToS risk for a data-analysis tool.** There is no carve-out for research, no public API terms, and no stated rate limit to comply with. Lofty could reasonably argue that pulling `api.lofty.ai/prod/*` at volume is "data mining or scraping."

### robots.txt — ✅ VERIFIED (more permissive than the ToS)
```
https://www.lofty.ai/robots.txt → 200
User-agent: *
Disallow: /returns /reports /faq /signup_pay /value_home /login /account
         /reset_password_request /request_report /request_report_confirmation
         /report_confirmation /report_error /lofty_listings
Sitemap: https://www.lofty.ai/sitemap.xml
```
- **`/marketplace` and `/property_deal/*` are NOT disallowed.** ✅
- `api.lofty.ai` is **not mentioned at all** in robots.txt. ❌ (no guidance either way)
- Explicitly publishes AI-crawler resources: `/llms.txt`, `/llms-full.txt`, `/.well-known/reasoning.json`, `/.well-known/ai-manifest.json`.

**Tension:** robots.txt invites machine reading of property pages, while the ToS prohibits scraping generally. **Not resolved.**

---

## 7. Practical recipe for your tool

```bash
# 1) Universe of properties (83, ~3 MB) — cache it, server sends max-age=120
curl -s 'https://api.lofty.ai/prod/properties/v2/marketplace?pageSize=200'

# 2) Per property — use the ULID `id`, NOT assetId
curl -s 'https://api.lofty.ai/prod/exchange/v2/getpropertyorderbook?propertyId=01K1VKTF50B18YPKEKKMNT988E'
curl -s 'https://api.lofty.ai/prod/exchange/v2/getpropertyinfo?propertyId=01K1VKTF50B18YPKEKKMNT988E'

# 3) Detail page (SSR, renders financials + yield definitions)
curl -s 'https://www.lofty.ai/property_deal/2820-Rucker-Ave_Everett-WA-98201'
```

**Derivable metrics** (from data I verified you can get):
- Best bid / best ask / spread / mid / book depth — orderbook endpoint
- Last trade, trade count, trade volume, all-time & period price range — `getpropertyinfo`
- Full time series of fills (price, size, timestamp) — `getpropertyinfo.transactions`
- Market cap proxy ≈ `tokens` × live price (`tokens` = shares outstanding, verified; ⚠️ derived, not published)
- Yield metrics: use Lofty's published fields **as-is**, and separately compute your own from `cash_flow`/`monthly_rent`/`sale_price`/`current_loan`
- Occupancy, delinquency, rent, loan, expenses — marketplace payload
- Monthly AVM history (where populated) — `avmHistory`

---

## 8. Explicit list of things I could NOT verify

1. ❓ **Whether `/prod` has any rate limit at all.** My 40-request burst saw none; that is weak evidence only.
2. ❓ **Whether `getpropertyinfo.transactions` is truly complete.** Counts sampled (5, 142, 143, 202, 492, 542, 557, 874, 914, 1058) show **no round-number cap** and I found no pagination params — strongly suggesting full histories, but this is inference, not documentation.
3. ❓ **Formulas for `cap_rate`, `coc`, `irr`, `projected_rental_yield`, `gross_yield`.** Not published, and I **disproved** 8 candidate formulas across all 83 properties (only `projected_annual_return = projected_rental_yield + appreciation` reproduced, 79/79). The underlying inputs are not in the payload.
4. ❓ **`numIssued` semantics.** Partially resolved: `tokens === num_sold` for all 83 properties, and `total_investment / tokens ≈ $50`, so **`tokens` is shares outstanding at issuance**. But `numIssued` is missing on 36/83 and always ≤ `tokens` — its exact meaning (circulating? currently issued on-chain? legacy?) is still unconfirmed.
5. ❓ **AMM pool data** — exists per SDK (`/public/v1/amm/pools`) but needs a key; `/prod/amm/*` returned 403. I have **no** pool data.
6. ❓ **Rent/distribution history per property** — no public endpoint found. `transactions/v2/getbyuser` is account-scoped. The site claims "rent history" on listings but I found no route for it.
7. ❓ **Whether `/prod` open-read status is intentional or an oversight.** Nothing indicates it either way.
8. ❓ **Whether on-chain (Algorand/allo.info) data can substitute for the API.** Untested.
9. ❓ **Actual enforcement behavior** of the ToS scraping clause — no public case found.
10. ❓ **`amm.lofty.ai`** (lending) — returned 200 (37 KB HTML) but I did not analyze it.
11. ⚠️ **The 124-route catalog** in `lofty-cli/src/catalog.rs` is a JS-bundle scrape: no HTTP methods, never live-verified, and unverifiable by probing due to the 403 trap.
12. ⚠️ **SDK README rate limits** are for `/public/v1`, a surface I could not call. They may not apply to `/prod`.

---

## Appendix — every URL I checked and its outcome

| URL | Result |
|---|---|
| `https://api.lofty.ai/prod/properties/v2/marketplace` | **200**, 3,061,518 B JSON, 83 properties |
| `…/marketplace?pageSize=50` / `?page=2` / `?page=99` | **200**, pagination works |
| `…/marketplace?propertyType=ALL` | **200**, 36 results |
| `…/marketplace?slug=…`, `?limit=`, `?location=` | **200**, params ignored |
| `https://api.lofty.ai/prod/exchange/v2/getpropertyorderbook?propertyId=<ULID>` | **200**, full book |
| `…?propertyId=<assetId/dao/oldAssetId>` | 200 but **empty book** (wrong ID!) |
| `…?id=` / `?assetId=` | **500** `propertyId is required` |
| `https://api.lofty.ai/prod/exchange/v2/getpropertyinfo?propertyId=<ULID>` | **200**, 171–316 KB, trades |
| `https://api.lofty.ai/public/v1/properties` | **401** `Unauthorized` |
| `https://api.lofty.ai/public/v1/properties` (bad bearer) | **403** Cognito/IAM deny |
| `https://api.lofty.ai/public/v1/amm/pools` | **401** |
| `https://api.lofty.ai/public/v1/market/properties` | **403** `Missing Authentication Token` |
| `https://api.lofty.ai/v1/properties`, `/v2/properties`, `/` | **403** `Forbidden` |
| `https://api.lofty.ai/prod/properties`, `/prod/health`, `/prod/properties/v2/marketplace/` | **403** |
| `…/prod/properties/v2/{property,lookup,ticker,featured,oracle-price,get-property-yields,get-list-view-data*}` | **403** |
| `…/prod/exchange/v2/{getpropertytxns,getuserinfo,getorderandstreams}` | **403** |
| `…/prod/{amm,lp-rewards,blog,payments,users,transactions,geolocation,marketing,taxdocuments}/…` | **403** |
| `https://docs.lofty.ai/` | **DNS ENOTFOUND** |
| `https://developer.lofty.ai/` | **DNS ENOTFOUND** |
| `https://www.lofty.ai/robots.txt` | **200** |
| `https://www.lofty.ai/terms` | **200** — §4.1 prohibits data mining/scraping |
| `https://www.lofty.ai/terms-of-service` | **404** |
| `https://www.lofty.ai/llms.txt`, `/llms-full.txt` | **200** |
| `https://www.lofty.ai/marketplace` | **200** (SSR: cards w/ price + avg yield) |
| `https://www.lofty.ai/property_deal/2820-Rucker-Ave_Everett-WA-98201` | **200** (SSR: full financials + yield definitions) |
| `https://www.lofty.ai/how-it-works` | **200** |
| `https://www.lofty.ai/help/articles/6145558-…`, `/6559222-…`, `/6167215-…` | **200** |
| `https://amm.lofty.ai/` | **200** (not analyzed) |
| `https://registry.npmjs.org/@loftyaicode/sdk` | **200**, v0.8.1, official |
| `https://www.npmjs.com/package/@loftyaicode/sdk` | **403** Cloudflare challenge |
| `https://raw.githubusercontent.com/piekstra/lofty-cli/main/{README.md,docs/api.md,src/catalog.rs}` | **200** ×3 |
| `https://raw.githubusercontent.com/earlvanze/lofty-utils/main/README.md` | **200** |
| `https://api.github.com/repos/earlvanze/lofty-utils` | **200** (last push 2024-04-03) |
| `https://api.github.com/search/repositories?q=lofty.ai…` | **200**, 13 results, mostly irrelevant |
| `https://algorand.co/case-studies/lofty-transform-real-estate-industry` | **200** (DAO model quote) |
| `https://www.prnewswire.com/…lofty-ai-launches-tokenized-liquid-marketplace…` | via search (2021 launch, Algorand, $50 tokens) |
