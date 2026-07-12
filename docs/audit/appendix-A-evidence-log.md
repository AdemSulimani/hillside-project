# Appendix A — Evidence Log

Every SQL/Redis query used as evidence in this audit, with verbatim results and timestamps. Queries are run once and cited from here. All Postgres access is SELECT-only against the dev/staging database; Redis access is read-only.

---

## EV-001 — Table row counts (audit baseline)

- **When:** 2026-07-10 ~22:45 +02:00 (pre-plan reconnaissance)
- **Query:**
```sql
SELECT (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM conversations) AS conversations,
       (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM ai_alerts) AS ai_alerts, (SELECT count(*) FROM orders) AS orders
```
- **Result:** tenants=6, conversations=46, messages=374, products=617, ai_alerts=20, orders=20

## EV-002 — Alert reason distribution

- **When:** 2026-07-10 ~22:50 +02:00
- **Query:** `SELECT reason, count(*) FROM ai_alerts GROUP BY reason ORDER BY count(*) DESC`
- **Result:**

| reason | count |
|--------|-------|
| product_question_unanswered | 7 |
| usage_question_unanswered | 6 |
| hallucinated_price | 2 |
| product_image_unavailable | 2 |
| uncertain_answer_escalated | 1 |
| hallucinated_product_name | 1 |
| unclear | 1 |

- **Note:** `product_image_unavailable`, `uncertain_answer_escalated`, `unclear` are absent from CLAUDE.md's alert-reason list → discrepancy register.

## EV-003 — Message stats by sender

- **When:** 2026-07-10 ~22:50 +02:00
- **Query:** `SELECT sent_by, count(*) AS n, count(*) FILTER (WHERE flagged) AS flagged, round(avg(quality_score)::numeric,3) AS avg_quality FROM messages GROUP BY sent_by`
- **Result:** ai: n=154, flagged=1, avg_quality=0.812 · human: n=13 · customer: n=207

## EV-004 — Product catalog state

- **When:** 2026-07-10 ~22:50 +02:00
- **Query:** `SELECT count(*) AS total, count(*) FILTER (WHERE embedding IS NULL) AS null_embedding, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted, count(*) FILTER (WHERE NOT in_stock) AS out_of_stock FROM products`
- **Result:** total=617, null_embedding=3, soft_deleted=359 (58%), out_of_stock=2

## EV-005 — Prompt block catalog

- **When:** 2026-07-10 ~23:00 +02:00
- **Query:** `SELECT key, title, category, is_platform_locked, length(default_content) AS content_len FROM prompt_blocks ORDER BY category, key`
- **Result:** 13 blocks (12 `guidelines.*`, 1 `vision`), 5 platform-locked (`catalog_integrity`, `category_product_aggregation`, `language`, `order_flow_and_escalation`, `price_currency_visibility`), content lengths 582–2731 chars (~20KB total)

## EV-006 — Sentry production error history

- **When:** 2026-07-10 ~23:05 +02:00
- **Query:** Sentry MCP `search_issues`, org `hillside-6c`, project `node-express`, `is:unresolved`, 90-day window
- **Result:** 1 issue — `TypeError: Object [object Object] has no method 'updateFrom'` in `../../sentry/scripts/views.js in poll` (a Sentry sample-style event, 1 occurrence, 2 days old). **No meaningful production error history.**

## EV-007 — Redis server state (audit baseline)

- **When:** 2026-07-10 ~22:45 +02:00
- **Query:** Redis MCP `info`
- **Result (selected):** redis 7.0.15 standalone (WSL2), db0 keys=444 (5 with expiry), connected_clients=14, blocked_clients=5 (BullMQ workers waiting), maxmemory_policy=noeviction, uptime 193s at query time

## EV-008 — ai_alerts schema introspection

- **When:** 2026-07-11 (Phase 3 alert forensics)
- **Query:** `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='ai_alerts' ORDER BY ordinal_position`
- **Result:** `id` uuid, `tenant_id` uuid, `conversation_id` uuid, `message_id` uuid, `reason` varchar, `status` varchar, `created_at` timestamptz, `details` jsonb

## EV-009 — Alert reason histogram (re-confirmation)

- **When:** 2026-07-11
- **Query:** `SELECT reason, count(*) FROM ai_alerts GROUP BY reason ORDER BY count(*) DESC`
- **Result:** product_question_unanswered=7, usage_question_unanswered=6, hallucinated_price=2, product_image_unavailable=2, uncertain_answer_escalated=1, hallucinated_product_name=1, unclear=1 — identical to EV-002.

## EV-010 — Full details JSONB for product/usage question alerts

- **When:** 2026-07-11
- **Query:** `SELECT id, reason, created_at, jsonb_pretty(details) FROM ai_alerts WHERE reason IN ('product_question_unanswered','usage_question_unanswered') ORDER BY reason, created_at`
- **Result (verbatim):**

| id | reason | created_at | details |
|----|--------|------------|---------|
| eb105e34-d57f-4be1-ac18-44824bb28f57 | product_question_unanswered | 2026-06-07T21:39:26.967Z | `null` |
| 8dd2cc18-dcab-4e4f-863f-6a9ec3abe1c0 | product_question_unanswered | 2026-06-07T23:23:17.860Z | `null` |
| 0b843cfe-d5b8-4af9-acc3-25498a20e92e | product_question_unanswered | 2026-06-07T23:26:04.273Z | `null` |
| ef0f4442-238e-41bf-80d2-f28f84324d57 | product_question_unanswered | 2026-06-08T11:10:59.609Z | `null` |
| 45247737-20bf-4afc-b657-834ef36099e3 | product_question_unanswered | 2026-06-23T15:18:52.475Z | `{"kind":"product_information_gap","partial":false,"missing_info":["çmimi","shija"],"answered_info":null,"customer_question":"sa kushton qikjo optium nutrition gold standart edhe qfar shije e ka","requested_attributes":["flavor","brand"]}` |
| d3db5dac-4681-4d7d-837a-00d220089a3a | product_question_unanswered | 2026-06-23T16:56:23.437Z | `{"kind":"product_information_gap","partial":true,"missing_info":["ma shum"],"answered_info":"Rrypi i fitnesit tekstil L ka një dizajn të veçantë dhe është i përforcuar në vendin ku ngjitet. Çmimi është €16.00.","customer_question":"A keni ma shum a veq aito\nQito","requested_attributes":[]}` |
| dcf5c812-b3df-4168-9222-7198185bbcb2 | product_question_unanswered | 2026-06-27T22:10:46.654Z | `{"kind":"product_information_gap","partial":true,"missing_info":["carbo one"],"answered_info":"Ne kemi A.Nutrition L-carnitine 480mil me shije portokalli që kushton €32.00.","customer_question":"Pershendetje a keni carbo one\nMe qfar shije i keni edhe sa kushtojn","requested_attributes":["flavor"]}` |
| 0d42204f…, fb535f16…, 3be07b56…, a44f3bbc… (2026-05-30), 653b73d0… (2026-06-02), 9143cf34… (2026-06-23) | usage_question_unanswered | — | all `null` |

- **Note:** All 6 usage_question_unanswered alerts have `details = null` (including the 2026-06-23 one). product_question_unanswered alerts before 2026-06-23 have `null` details; from 2026-06-23 they carry structured `product_information_gap` payloads (`kind`, `partial`, `missing_info`, `answered_info`, `customer_question`, `requested_attributes`). Details schema evidently introduced ~2026-06-23 for the product-gap path only.

## EV-011 — Hallucination alerts joined to flagged messages

- **When:** 2026-07-11
- **Query:** `SELECT a.id, a.reason, a.created_at, jsonb_pretty(a.details), m.id, m.direction, m.sent_by, m.flagged, m.flag_reason, m.content, m.product_ids FROM ai_alerts a LEFT JOIN messages m ON m.id = a.message_id WHERE a.reason IN ('hallucinated_price','hallucinated_product_name') ORDER BY a.created_at`
- **Result (verbatim):**

**ef3393c1 — hallucinated_product_name, 2026-06-23T16:33:39Z, conv fcd0af7e**
```json
{
  "catalogNames": ["Melatonine 180tab","Pure Creatine 100 capsul","Pure Creatine 250gr pa shije","Amino after-load 400gr Manto","Amino Energy 30 Servime","Arginine 100caps","BCAA+Glutamine 180tab","C4 Original 30 servime shije Bostani","C4 Original 30servime shije Mjedre","C4 Original 60servime Shije Bostani"],
  "suspectedNames": ["Mega Mass 3kg Qokolad","Mass gainer 3kg Qokolad"],
  "originalReplyPreview": "Për shtim peshe, Mega Mass 3kg Qokolad është një zgjedhje e shkëlqyer, pasi ofron kalori të larta dhe është ideal për ata që kanë vështirësi në shtimin e peshës. Gjithashtu, Mass gainer 3kg Qokolad ës"
}
```
Sent message (msg 6e9144d7, sent_by=ai, flagged=false): `"Së shpejti do t'ju kontaktojë një specialist me informacion të saktë për produktin."` — original reply was replaced with the escalation fallback. message.product_ids contains 10 UUIDs (the retrieved set).

**e37cd2ce — hallucinated_price, 2026-06-27T21:43:05Z, conv 3ea2ace9**
```json
{"statedPrices":["18.00"],"catalogPrices":[],"failureReason":"no_catalog_prices","establishedPrices":[],"originalReplyPreview":"Shijet: Limon, Portokall Çmimi: €18.00 për secilën."}
```
Sent message (msg 01994bfb): `"S� shpejti do t�ju kontaktoj� nj� specialist me informacion t� sakt� p�r produktin."` — mojibake encoding; `product_ids = []`.

**6e13dbe6 — hallucinated_price, 2026-06-27T22:00:38Z, conv cf2bf59a**
```json
{"statedPrices":["18.00"],"catalogPrices":[],"failureReason":"no_catalog_prices","establishedPrices":[],"originalReplyPreview":"Limon: €18.00 Portokall: €18.00"}
```
Sent message (msg 019ba07e): same mojibake fallback text; `product_ids = []`.

- **Note:** Both hallucinated_price alerts have `catalogPrices=[]` and explicit `failureReason:"no_catalog_prices"` — the filter had **zero catalog prices to compare against** (no products retrieved; `product_ids=[]` on the sent message) and stripped the reply anyway (fail-closed). Also: the two 06-27 fallback messages are stored with corrupted encoding (`S�`), whereas the 06-23 fallback is clean UTF-8.

## EV-012 — Details for remaining alert reasons

- **When:** 2026-07-11
- **Query:** `SELECT id, reason, created_at, jsonb_pretty(details) FROM ai_alerts WHERE reason IN ('product_image_unavailable','uncertain_answer_escalated','unclear') ORDER BY created_at`
- **Result:**

| id | reason | created_at | details |
|----|--------|------------|---------|
| 1df15a06 | unclear | 2026-06-23T19:15:17Z | `null` |
| 10946774 | uncertain_answer_escalated | 2026-06-23T19:33:25Z | `{"kind":"uncertain_answer_fallback","customer_question":"a keni ndonje produkt ne ofert be","originalReplyPreview":"Nuk kemi oferta aktive për momentin.","negative_availability_detected":true}` |
| 1a42067e | product_image_unavailable | 2026-07-03T18:59:38Z | `{"product_ids":["731907cb-aea5-48c5-b5a9-b34cbd9d533f"],"product_names":["Beast pre-workout 30servime Mango"]}` |
| 96833d74 | product_image_unavailable | 2026-07-03T19:44:39Z | same product (`Beast pre-workout 30servime Mango`), different conversation |

## EV-013 — Catalog cross-check of "hallucinated" names and prices

- **When:** 2026-07-11
- **Query:** `SELECT id, name, price, in_stock, deleted_at IS NOT NULL AS soft_deleted, embedding IS NULL AS null_embedding FROM products WHERE (name ILIKE '%carbo one%' OR name ILIKE '%mega mass%' OR name ILIKE '%mass gainer 3kg%') AND deleted_at IS NULL`
- **Result (active rows only):**

| name | price | in_stock | soft_deleted | null_embedding |
|------|-------|----------|--------------|----------------|
| Mega mass 7kg Qokolad | 95.00 | t | f | f |
| Mega mass 3kg Vanil | 55.00 | t | f | f |
| Mass gainer 3kg Qokolad | 52.00 | t | f | f |
| Mega mass 3kg Qokolad | 55.00 | t | f | f |
| Carbo One 1kg Orange | 18.00 | t | f | f |
| Carbo one 1kg Limon | 18.00 | t | f | f |

- **Note:** Every "suspected hallucinated" product name exists as an **active, in-stock catalog product with a non-null embedding**. The €18.00 "hallucinated" price exactly matches the real prices of Carbo one 1kg Limon / Carbo One 1kg Orange. All three hallucination alerts flagged **factually correct AI replies**.

## EV-014 — Alert turn position and per-conversation clustering

- **When:** 2026-07-11
- **Query:** `SELECT a.id, a.reason, a.conversation_id, a.created_at, (SELECT count(*) FROM messages m WHERE m.conversation_id=a.conversation_id AND m.created_at < a.created_at) AS msgs_before, (SELECT count(*) FROM messages m WHERE m.conversation_id=a.conversation_id) AS msgs_total FROM ai_alerts a ORDER BY a.conversation_id, a.created_at`
- **Result (msgs_before / msgs_total per alert):** eb105e34 1/2 · 0d42204f 15/15 · 1df15a06 13/15 · 10946774 15/15 · 1a42067e 5/32 · 96833d74 4/12 · a44f3bbc 8/12 · d3db5dac 8/9 · dcf5c812 2/3 · e37cd2ce 4/4 · 45247737 5/6 · ef0f4442 16/17 · 653b73d0 7/8 · 3be07b56 3/4 · 0b843cfe 2/3 · fb535f16 3/4 · 8dd2cc18 9/10 · 6e13dbe6 4/4 · 9143cf34 5/6 · ef3393c1 6/6
- **Clustering:** 20 alerts across 19 distinct conversations. Only conversation `18129839` has 2 alerts (`unclear` 19:15 + `uncertain_answer_escalated` 19:33, same evening). 16/20 alerts sit at or within one message of the conversation's final message — escalation typically **ends** the conversation. Exceptions: the two `product_image_unavailable` alerts (turn 5/32 and 4/12) where conversation continued.

## EV-015 — Transcripts of the three hallucination-alert conversations

- **When:** 2026-07-11
- **Query:** `SELECT conversation_id, created_at, sent_by, left(content,200) FROM messages WHERE conversation_id IN ('3ea2ace9…','cf2bf59a…','fcd0af7e…') ORDER BY conversation_id, created_at`
- **Result (condensed, verbatim content):**

**conv 3ea2ace9 (hallucinated_price #1, 06-27 21:41–21:43):**
1. customer: "Pershendetje a keni carbo one"
2. ai: "Po."
3. customer: "Me qfar shije i keni edhe sa kushtojn"
4. ai: "S� shpejti do t�ju kontaktoj� nj� specialist…" (fallback, mojibake)

**conv cf2bf59a (hallucinated_price #2, 06-27 21:59–22:00):** identical 4-message script, same customer wording, ~17 min later.

**conv fcd0af7e (hallucinated_product_name, 06-23 16:30–16:33):**
1. customer: "a keni produkte te mira per shtim peshe"
2. ai: "Po, kemi disa produkte për shtim peshe… - Mass gainer 3kg Qokolad… - Mega mass 3kg Qokolad…" (sent successfully)
3. customer: "a keni tjera a veq qito"
4. ai: "Po, kemi edhe disa produkte të tjera… - Critical Mass 6kg Keks - Pro Mass 1kg Qokolad" (sent successfully)
5. customer: "Cilen mkishe than ti me marr prej qitynve" (*which would you recommend*)
6. ai: escalation fallback — the recommendation naming the **same two products the AI itself listed in turn 2** was stripped as "hallucinated".

- **Note:** In turn 5 the customer message contains no product keywords; retrieval returned an unrelated top-10 (Melatonine, Creatine, C4…, per EV-011 `catalogNames`), so the name filter no longer "saw" the mass-gainer products and flagged them.

---
*(subsequent entries appended by audit workflows)*

## EV-016 — Schema introspection: messages, conversations, ai_alerts

- **When:** 2026-07-11
- **Query:** `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('messages','conversations','ai_alerts') ORDER BY table_name, ordinal_position`
- **Result (verbatim, condensed to table.column:type):**
  - `ai_alerts`: id:uuid, tenant_id:uuid, conversation_id:uuid, message_id:uuid, reason:varchar, status:varchar, created_at:timestamptz, details:jsonb
  - `conversations`: id:uuid, tenant_id:uuid, contact_id:uuid, channel_id:uuid, status:varchar, last_message_at:timestamptz, human_override_until:timestamptz, created_at:timestamptz, updated_at:timestamptz, ai_paused:bool, fully_ai_handled:bool, human_replied:bool
  - `messages`: id:uuid, tenant_id:uuid, conversation_id:uuid, external_message_id:varchar, direction:varchar, type:varchar, content:text, attachment_urls:jsonb, sent_by:varchar, ai_processed:bool, created_at:timestamptz, quality_score:numeric, flagged:bool, flag_reason:varchar, send_status:varchar, send_error:varchar, metadata:jsonb, reply_to_message_id:uuid, reply_to_external_id:varchar, reply_to_content:text, reply_to_attachment_url:varchar, edited_at:timestamptz, edit_count:int, original_content:text, edit_history:jsonb, product_ids:jsonb
- **Note:** `messages.send_status` / `send_error` exist and are NULL on every row in the dataset (see EV-018) — no persisted send failures.

## EV-017 — Q1 conversation roster (message counts by sender, alerts, flags)

- **When:** 2026-07-11
- **Query:** `SELECT c.id, c.tenant_id, c.human_replied, c.ai_paused, c.fully_ai_handled, count(m.id), count(*) FILTER (WHERE m.sent_by='customer'), count(*) FILTER (WHERE m.sent_by='ai'), count(*) FILTER (WHERE m.sent_by='human'), min(m.created_at), max(m.created_at), (SELECT count(*) FROM ai_alerts a WHERE a.conversation_id=c.id) FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id GROUP BY c.id ORDER BY count(m.id) DESC`
- **Result (verbatim; all conversations belong to single tenant `02beb134`):**

| conv | msgs | cust | ai | human | first_msg | last_msg | alerts | human_replied | ai_paused | fully_ai_handled |
|------|------|------|----|-------|-----------|----------|--------|---------------|-----------|------------------|
| 1d001d46 | 32 | 19 | 13 | 0 | 07-03 18:58 | 07-03 19:41 | 1 | f | f | f |
| cdd0bdea | 22 | 12 | 10 | 0 | 06-07 21:47 | 06-07 22:07 | 0 | f | f | f |
| 56a29a1a | 17 | 10 | 7 | 0 | 06-08 10:17 | 06-08 11:11 | 1 | f | f | t |
| 6a120665 | 17 | 9 | 8 | 0 | 06-24 09:30 | 06-24 09:39 | 0 | f | f | f |
| 2b375480 | 16 | 10 | 6 | 0 | 06-08 09:27 | 06-08 10:17 | 0 | f | f | f |
| 12af2f76 | 15 | 8 | 7 | 0 | 05-30 21:05 | 05-30 21:37 | 1 | f | t | f |
| 18129839 | 15 | 8 | 7 | 0 | 06-23 19:10 | 06-23 19:33 | 2 | f | f | f |
| 8153c698 | 15 | 8 | 7 | 0 | 06-07 22:15 | 06-07 22:22 | 0 | f | f | f |
| f412d3f4 | 15 | 8 | 7 | 0 | 06-02 15:24 | 06-02 15:47 | 0 | f | f | t |
| f911e3dd | 15 | 8 | 7 | 0 | 06-23 15:54 | 06-23 16:03 | 0 | f | f | f |
| 1e71b190 | 12 | 6 | 4 | 2 | 07-03 19:43 | 07-03 20:05 | 1 | t | f | f |
| 1f6a08de | 12 | 6 | 5 | 1 | 05-30 22:03 | 05-30 22:30 | 1 | f | f | f |
| 05e2354b | 11 | 6 | 5 | 0 | 06-02 12:38 | 06-02 12:41 | 0 | f | f | f |
| acfbb493 | 10 | 6 | 4 | 0 | 06-07 22:30 | 06-07 22:33 | 0 | f | f | f |
| bbdb9d71 | 10 | 6 | 4 | 0 | 06-07 23:00 | 06-07 23:23 | 1 | f | f | f |
| 254a70cc | 9 | 5 | 4 | 0 | 06-23 16:49 | 06-23 16:56 | 1 | f | f | f |
| 56b9702c | 8 | 4 | 4 | 0 | 06-02 17:31 | 06-02 17:35 | 1 | f | f | f |
| 79a58aac | 7 | 4 | 3 | 0 | 06-08 09:23 | 06-08 09:26 | 0 | f | f | f |
| 0a2b2999 | 6 | 3 | 3 | 0 | 06-20 15:49 | 06-20 15:51 | 0 | f | f | f |
| 29238c0d | 6 | 3 | 3 | 0 | 06-23 18:50 | 06-23 18:54 | 0 | f | f | f |
| 461901a6 | 6 | 3 | 3 | 0 | 06-23 17:01 | 06-23 17:04 | 0 | f | f | f |
| 509f4690 | 6 | 3 | 3 | 0 | 06-23 15:16 | 06-23 15:18 | 1 | f | f | f |
| d1d12b10 | 6 | 4 | 2 | 0 | 07-08 11:22 | 07-08 11:38 | 0 | f | f | f |
| e328fc3b | 6 | 3 | 0 | 3 | 06-23 21:10 | 06-23 21:12 | 1 | t | f | f |
| fcd0af7e | 6 | 3 | 3 | 0 | 06-23 16:30 | 06-23 16:33 | 1 | f | f | f |
| 4c10fc71 | 5 | 3 | 0 | 2 | 06-20 15:06 | 06-20 15:07 | 0 | t | f | f |
| 6da91488 | 5 | 3 | 2 | 0 | 06-04 10:00 | 06-04 10:02 | 0 | f | f | f |
| af548526 | 5 | 3 | 2 | 0 | 06-02 12:22 | 06-02 12:25 | 0 | f | f | f |
| d218dd90 | 5 | 3 | 2 | 0 | 05-30 22:59 | 05-30 22:59 | 0 | f | f | f |
| e4906244 | 5 | 3 | 1 | 1 | 05-30 13:42 | 05-30 21:02 | 0 | t | f | f |
| 306e56fe | 4 | 2 | 2 | 0 | 06-23 16:58 | 06-23 17:00 | 0 | f | f | f |
| 3ea2ace9 | 4 | 2 | 2 | 0 | 06-27 21:41 | 06-27 21:43 | 1 | f | t | f |
| 7dd53b3e | 4 | 2 | 2 | 0 | 05-30 21:54 | 05-30 21:55 | 1 | f | t | f |
| 92cd366e | 4 | 2 | 0 | 2 | 06-27 21:47 | 06-27 21:49 | 0 | t | f | f |
| 98571d00 | 4 | 2 | 2 | 0 | 06-24 16:13 | 06-24 16:15 | 0 | f | f | f |
| b973ad04 | 4 | 2 | 2 | 0 | 05-30 21:46 | 05-30 21:47 | 1 | f | t | f |
| cf2bf59a | 4 | 2 | 2 | 0 | 06-27 21:59 | 06-27 22:00 | 1 | f | t | f |
| ef6b1740 | 4 | 2 | 2 | 0 | 05-30 13:27 | 05-30 13:28 | 0 | f | f | f |
| 28bec994 | 3 | 2 | 1 | 0 | 06-27 22:09 | 06-27 22:10 | 1 | f | t | f |
| 5138a806 | 3 | 2 | 1 | 0 | 06-08 08:54 | 06-08 08:55 | 0 | f | f | f |
| b8173c49 | 3 | 2 | 1 | 0 | 06-07 23:25 | 06-07 23:26 | 1 | f | f | f |
| 0eda9a0a | 2 | 1 | 1 | 0 | 06-07 21:39 | 06-07 21:39 | 1 | f | f | f |
| 5086ed7d | 2 | 1 | 0 | 1 | 06-27 21:37 | 06-27 21:37 | 0 | t | f | f |
| cebf6a66 | 2 | 1 | 0 | 1 | 06-27 21:33 | 06-27 21:34 | 0 | t | f | f |
| 0a4cde32 | 1 | 1 | 0 | 0 | 06-08 08:52 | 06-08 08:52 | 0 | f | t | f |
| 88283c5e | 1 | 1 | 0 | 0 | 06-08 08:53 | 06-08 08:53 | 0 | f | t | f |

- **Multi-turn set (>= 6 messages), 25 conversations:** 1d001d46, cdd0bdea, 56a29a1a, 6a120665, 2b375480, 12af2f76, 18129839, 8153c698, f412d3f4, f911e3dd, 1e71b190, 1f6a08de, 05e2354b, acfbb493, bbdb9d71, 254a70cc, 56b9702c, 79a58aac, 0a2b2999, 29238c0d, 461901a6, 509f4690, d1d12b10, e328fc3b, fcd0af7e.
- **Alert conversations NOT in the multi-turn set (7):** 3ea2ace9, 7dd53b3e, b973ad04, cf2bf59a, 28bec994, b8173c49, 0eda9a0a. Total 44 conversations, 374 messages.

## EV-018 — Q2 full turn ledger (per-message: turn index, sender, content, flags, quality, product_ids, gap)

- **When:** 2026-07-11
- **Query:** `WITH t AS (SELECT m.conversation_id, m.created_at, m.sent_by, m.content, m.flagged, m.quality_score, m.product_ids, m.send_status, m.send_error, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS turn, EXTRACT(EPOCH FROM m.created_at - LAG(m.created_at) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at))::int AS gap_s FROM messages m) SELECT left(conversation_id::text,8), turn, sent_by, left(content,100), flagged::int, quality_score, jsonb_array_length(COALESCE(product_ids,'[]'::jsonb)), gap_s, send_status, send_error FROM t ORDER BY conversation_id, turn` (run in 4 batches via LIMIT/OFFSET; content truncated at 100 chars here — full 200-char content preserved verbatim in the 32 timeline JSON files, scratchpad `audit/timelines/`)
- **Result (374 rows, verbatim):**
| conv | turn | sent_by | content (first 100 chars) | flagged | q_score | n_pids | gap_s | send_status | send_error |
|---|---|---|---|---|---|---|---|---|---|
| 05e2354b | 1 | customer | Pershendetje, a keni ndonje produkt te mir per shtim peshe? | 0 |  | 0 |  |  |  |
| 05e2354b | 2 | ai | Përshëndetje! Po, kemi disa produkte për shtim peshe. Mund të rekomandoj "Mega Mass 3kg Qokolad, i c | 0 | 0.950 | 0 | 31 |  |  |
| 05e2354b | 3 | customer | Sa kushton mega massa? | 0 |  | 0 | 19 |  |  |
| 05e2354b | 4 | ai | "Mea Mass 3kg Qokolad" kushton 55€. | 0 | 0.920 | 0 | 20 |  |  |
| 05e2354b | 5 | customer | A muna me porosit | 0 |  | 0 | 16 |  |  |
| 05e2354b | 6 | ai | Sigurisht! Për të përfunduar porosinë, do të më nevojiten disa të dhëna: emri dhe mbiemri juaj, numr | 0 | 0.900 | 0 | 24 |  |  |
| 05e2354b | 7 | customer | Adem Sulimani, Bregu i diellit, Banesat e bardha blloku 35, 045 678 633 | 0 |  | 0 | 25 |  |  |
| 05e2354b | 8 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| 05e2354b | 9 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 26 |  |  |
| 05e2354b | 10 | customer | Po | 0 |  | 0 | 6 |  |  |
| 05e2354b | 11 | ai | Faleminderit! Porosia juaj është konfirmuar dhe do të përpunohet së shpejti. Nëse keni ndonjë pyetje | 0 | 0.200 | 0 | 28 |  |  |
| 0a2b2999 | 1 | customer | Pershendetje ku gjendeni me adres? | 0 |  | 0 |  |  |  |
| 0a2b2999 | 2 | ai | Bulevardi Dëshmorët e Kombit, Prishtinë. | 0 | 0.950 | 0 | 22 |  |  |
| 0a2b2999 | 3 | customer | A keni ndonje proteina te mira per shtim peshe | 0 |  | 0 | 30 |  |  |
| 0a2b2999 | 4 | ai | Po, kemi disa opsione për proteina për shtim peshe. Disa prej tyre janë: - Mass gainer 3kg Qokolad:  | 0 | 0.950 | 0 | 30 |  |  |
| 0a2b2999 | 5 | customer | Sa kushtojn kto | 0 |  | 0 | 25 |  |  |
| 0a2b2999 | 6 | ai | Më vjen keq, por produktet që përmenda nuk janë në katalogun tonë aktual, prandaj nuk mund tju jap n | 0 | 0.200 | 0 | 21 |  |  |
| 0a4cde32 | 1 | customer | Pershendetje a e keni kete produkt ne dispozicion | 0 |  | 0 |  |  |  |
| 0eda9a0a | 1 | customer | Pershendetje, ku gjendeni me Lokacion? | 0 |  | 0 |  |  |  |
| 0eda9a0a | 2 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 |  | 0 | 18 |  |  |
| 12af2f76 | 1 | customer | Pershendetje ku gjendeni me adres? | 0 |  | 0 |  |  |  |
| 12af2f76 | 2 | ai | Përshëndetje! Jemi të vendosur në Bulevardin Dëshmorët e Kombit, Prishtinë. | 0 | 0.950 | 0 | 17 |  |  |
| 12af2f76 | 3 | customer | si e keni numrin e telefonit ne rast nese mvyn me ju kontaktu? | 0 |  | 0 | 40 |  |  |
| 12af2f76 | 4 | ai | Numri ynë i telefonit për kontakt është +383 44 889 662. | 0 | 0.950 | 0 | 18 |  |  |
| 12af2f76 | 5 | customer | qfar dita punoni edhe kur e mbani hapur lokalin? | 0 |  | 0 | 58 |  |  |
| 12af2f76 | 6 | ai | Ne punojmë nga e hëna deri të shtunën, prej orës 09:00 deri në 20:00. Të dielën zakonisht jemi të mb | 0 | 0.950 | 0 | 18 |  |  |
| 12af2f76 | 7 | customer | e posten a e keni edhe me delivery apo vetem ne dyqan muna me ardh me blejt? | 0 |  | 0 | 146 |  |  |
| 12af2f76 | 8 | ai | Po, ne ofrojmë edhe shërbimin e dërgesës. Ju mund të porosisni dhe produktet do tju dërgohen në adre | 0 | 0.950 | 0 | 18 |  |  |
| 12af2f76 | 9 | customer | Pershendetje a keni produkt per shtim peshe | 0 |  | 0 | 234 |  |  |
| 12af2f76 | 10 | ai | Përshëndetje! Po, kemi produktin Mass Gainer Pro që është perfekt për shtim peshe dhe bulking. A don | 0 | 0.950 | 0 | 18 |  |  |
| 12af2f76 | 11 | customer | sa her ne dite muna me perdor | 0 |  | 0 | 13 |  |  |
| 12af2f76 | 12 | ai | Përdoret 1 herë në ditë. Koha zakonisht kur është më e mira është pas ushtrimeve. Nuk përdoret për m | 0 | 0.950 | 0 | 20 |  |  |
| 12af2f76 | 13 | customer | A munden me perdor grat shtatezena? | 0 |  | 0 | 53 |  |  |
| 12af2f76 | 14 | ai | Për përdorimin e suplementeve nga gratë shtatzëna, është e rëndësishme të konsultohen me një mjek os | 0 | 0.950 | 0 | 20 |  |  |
| 12af2f76 | 15 | customer | e sa her ne dit muna me perdor produktin? | 0 |  | 0 | 1246 |  |  |
| 18129839 | 1 | customer | Pershendetje a keni produkte per shtim peshe | 0 |  | 0 |  |  |  |
| 18129839 | 2 | ai | Po, kemi disa produkte për shtim peshe. | 0 | 0.950 | 25 | 55 |  |  |
| 18129839 | 3 | customer | cilat i keni | 0 |  | 0 | 11 |  |  |
| 18129839 | 4 | ai | Ja disa nga produktet tona për shtim peshe: - Critical Mass 6kg Keks - Mass gainer 3kg Qokolad - Meg | 0 | 0.950 | 25 | 40 |  |  |
| 18129839 | 5 | customer | sa kushton qikjo mega mass 3kg vanil | 0 |  | 0 | 20 |  |  |
| 18129839 | 6 | ai | €55 | 0 | 0.920 | 10 | 28 |  |  |
| 18129839 | 7 | customer | a muna me porosit | 0 |  | 0 | 23 |  |  |
| 18129839 | 8 | ai | Po, mund ta porosisni. Ju lutem më jepni emrin tuaj, numrin e telefonit dhe adresën e plotë të dërge | 0 | 0.900 | 0 | 23 |  |  |
| 18129839 | 9 | customer | Adem, 045 754 266, Bregu I diellit, banesat e bardha blloku 35 Prishtine | 0 |  | 0 | 24 |  |  |
| 18129839 | 10 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| 18129839 | 11 | ai | Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte? | 0 | 0.950 | 10 | 32 |  |  |
| 18129839 | 12 | customer | po | 0 |  | 0 | 5 |  |  |
| 18129839 | 13 | ai | Porosia juaj është konfirmuar! Do të arrijë brenda 2-3 ditëve të punës. Nëse keni pyetje të tjera os | 1 | 0.200 | 0 | 28 |  |  |
| 18129839 | 14 | customer | a keni ndonje produkt ne ofert be | 0 |  | 0 | 1055 |  |  |
| 18129839 | 15 | ai | Përshëndetje, do t’ju kthehemi së shpejti me një përgjigje. | 0 | 0.900 | 0 | 33 |  |  |
| 1d001d46 | 1 | customer | Pershendetje | 0 |  | 0 |  |  |  |
| 1d001d46 | 2 | customer | a keni nitro tech ripped | 0 |  | 0 | 2 |  |  |
| 1d001d46 | 3 | ai | Po. | 0 | 0.920 | 10 | 34 |  |  |
| 1d001d46 | 4 | customer | a muni me ma qu foto | 0 |  | 0 | 9 |  |  |
| 1d001d46 | 5 | ai | Foto e produktit do të ju dërgohet së shpejti. | 0 | 0.900 | 10 | 23 |  |  |
| 1d001d46 | 6 | customer | A keni naj kreatin | 0 |  | 0 | 1321 |  |  |
| 1d001d46 | 7 | ai | Po, kemi disa produkte kreatine në dispozicion: - Applied Nutrition Creatine 250gr shije Mjedre BSN  | 0 | 0.950 | 10 | 31 |  |  |
| 1d001d46 | 8 | customer | Cila o Ma e lira | 0 |  | 0 | 37 |  |  |
| 1d001d46 | 9 | ai | Applied Nutrition Creatine 250gr shije Mjedre: €25 BSN Creatine 216gr: €25 Crea HCL: €25 Creatine (M | 0 | 0.950 | 10 | 26 |  |  |
| 1d001d46 | 10 | customer | Aha okej a muna shef me porosit qita me shije mjedre | 0 |  | 0 | 40 |  |  |
| 1d001d46 | 11 | ai | Për të vazhduar me porosinë, ju lutem më jepni emrin tuaj, numrin e telefonit dhe adresën e plotë të | 0 | 0.950 | 10 | 27 |  |  |
| 1d001d46 | 12 | customer | Adem, 045 697 266, Bregu i Diellit Banesat e bardha blloku 35 | 0 |  | 0 | 29 |  |  |
| 1d001d46 | 13 | customer | *(null — attachment-only)* | 0 |  | 0 | 0 |  |  |
| 1d001d46 | 14 | ai | Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte? | 0 | 0.950 | 10 | 24 |  |  |
| 1d001d46 | 15 | customer | Po | 0 |  | 0 | 6 |  |  |
| 1d001d46 | 16 | ai | Faleminderit! Porosia juaj është konfirmuar dhe do të dërgohet së shpejti. Nëse keni pyetje të tjera | 0 | 0.200 | 0 | 30 |  |  |
| 1d001d46 | 17 | customer | Flm shef kalofshi mir | 0 |  | 0 | 10 |  |  |
| 1d001d46 | 18 | ai | Edhe ju gjithashtu, kalofshi bukur. | 0 | 0.950 | 10 | 25 |  |  |
| 1d001d46 | 19 | customer | Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr | 0 |  | 0 | 273 |  |  |
| 1d001d46 | 20 | customer | Mem pa tutesh qfar cpirre Jom | 0 |  | 0 | 8 |  |  |
| 1d001d46 | 21 | ai | Për shtim në peshë, mund të rekomandoj disa produkte që mund t'ju ndihmojnë: - Mass gainer 3kg Qokol | 0 | 0.950 | 10 | 46 |  |  |
| 1d001d46 | 22 | customer | Cila o ma e lira be se le qe jom cpirr po edhe fikan hahahahahah | 0 |  | 0 | 33 |  |  |
| 1d001d46 | 23 | ai | Pro mass 1kg Qokolad: €20 | 0 | 0.920 | 10 | 34 |  |  |
| 1d001d46 | 24 | customer | Okej qita pe porositi pra shef | 0 |  | 0 | 42 |  |  |
| 1d001d46 | 25 | ai | Për të përfunduar porosinë, a mund të më jepni emrin tuaj, numrin e telefonit dhe adresën e plotë të | 0 | 0.950 | 10 | 28 |  |  |
| 1d001d46 | 26 | customer | Adem, 045 687 266, Bregu i diellit banesat e bardha blloku 35 | 0 |  | 0 | 20 |  |  |
| 1d001d46 | 27 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| 1d001d46 | 28 | ai | Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte? | 0 | 0.950 | 10 | 36 |  |  |
| 1d001d46 | 29 | customer | Po zemer | 0 |  | 0 | 9 |  |  |
| 1d001d46 | 30 | ai | Faleminderit! Porosia juaj është konfirmuar dhe do të dërgohet së shpejti. Nëse keni pyetje të tjera | 0 | 0.200 | 0 | 33 |  |  |
| 1d001d46 | 31 | customer | Flm shum kalofshi mir | 0 |  | 0 | 142 |  |  |
| 1d001d46 | 32 | customer | Qysh o moti sot | 0 |  | 0 | 217 |  |  |
| 1e71b190 | 1 | customer | Hej a keni nitro tech ripped be | 0 |  | 0 |  |  |  |
| 1e71b190 | 2 | ai | Po. | 0 | 0.920 | 10 | 27 |  |  |
| 1e71b190 | 3 | customer | A muni me ma qu foto | 0 |  | 0 | 11 |  |  |
| 1e71b190 | 4 | ai | Foto e produktit do të ju dërgohet së shpejti. | 0 | 0.900 | 10 | 30 |  |  |
| 1e71b190 | 5 | customer | O shef qa bone | 0 |  | 0 | 501 |  |  |
| 1e71b190 | 6 | customer | A keni nitro tech ripped | 0 |  | 0 | 3 |  |  |
| 1e71b190 | 7 | ai | Po. | 0 | 0.920 | 10 | 63 |  |  |
| 1e71b190 | 8 | customer | Aha okej a muni me ma qu foto be se ju ka tek djalit tem me porosit ni qisi e spe di a osht e qasi q | 0 |  | 0 | 16 |  |  |
| 1e71b190 | 9 | human | Ja foto e Nitro Tech Ripped: | 0 |  | 0 | 29 |  |  |
| 1e71b190 | 10 | human | *(null — attachment-only)* | 0 |  | 0 | 6 |  |  |
| 1e71b190 | 11 | customer | Sa kushton kjo shef | 0 |  | 0 | 56 |  |  |
| 1e71b190 | 12 | ai | €50. | 0 | 0.920 | 10 | 576 |  |  |
| 1f6a08de | 1 | customer | pershendetje a keni produkt per shtim peshe | 0 |  | 0 |  |  |  |
| 1f6a08de | 2 | ai | Përshëndetje! Po, kemi produktin Mass Gainer Pro, i cili është perfekt për shtim peshe dhe bulking.  | 0 | 0.950 | 0 | 17 |  |  |
| 1f6a08de | 3 | human | sa her ndit muna me perdor? | 0 |  | 0 | 15 |  |  |
| 1f6a08de | 4 | customer | sa her ne dit muna me perdor? | 0 |  | 0 | 11 |  |  |
| 1f6a08de | 5 | ai | Përdoret 1 herë në ditë. Koha zakonisht kur është më e mira është pas ushtrimeve. | 0 | 0.950 | 0 | 28 |  |  |
| 1f6a08de | 6 | customer | Un i kom 15 vjet, a muna me perdor kit produkt a jo? | 0 |  | 0 | 42 |  |  |
| 1f6a08de | 7 | ai | Po, mund ta përdorni këtë produkt. Ai nuk është i rekomanduar vetëm për moshën nën 12 vjeçare. | 0 | 0.900 | 0 | 19 |  |  |
| 1f6a08de | 8 | customer | e grat shtatzane a munen me perdor? | 0 |  | 0 | 72 |  |  |
| 1f6a08de | 9 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje. | 0 |  | 0 | 16 |  |  |
| 1f6a08de | 10 | customer | pershendetje, a muna me porosit nje mass gainer ne keto te dhena: Bregu I diellit, banesat e bardha  | 0 |  | 0 | 1380 |  |  |
| 1f6a08de | 11 | customer | Customer shared content | 0 |  | 0 | 0 |  |  |
| 1f6a08de | 12 | ai | Porosia juaj për Mass Gainer Pro është konfirmuar dhe do të dërgohet në adresën tuaj. Nëse keni ndon | 0 | 0.950 | 0 | 23 |  |  |
| 254a70cc | 1 | customer | a keni produkte te mira per shtim peshe | 0 |  | 0 |  |  |  |
| 254a70cc | 2 | ai | Po, kemi disa produkte për shtim peshe si: - Critical Mass 6kg Keks - Mass gainer 3kg Qokolad - Mega | 0 | 0.950 | 10 | 34 |  |  |
| 254a70cc | 3 | customer | Cila osht ma e lira | 0 |  | 0 | 45 |  |  |
| 254a70cc | 4 | ai | Më vjen keq, nuk mund të jap informacion për çmime specifike në këtë moment. | 0 | 0.700 | 10 | 30 |  |  |
| 254a70cc | 5 | customer | A keni proteine te mira | 0 |  | 0 | 253 |  |  |
| 254a70cc | 6 | ai | Po, kemi disa proteina të mira si: - Applied Nutrition whey 2kg Dredhz - Applied Nutrition whey 2kg  | 0 | 0.920 | 10 | 27 |  |  |
| 254a70cc | 7 | customer | A keni ma shum a veq aito | 0 |  | 0 | 17 |  |  |
| 254a70cc | 8 | customer | Qito | 0 |  | 0 | 2 |  |  |
| 254a70cc | 9 | ai | Rrypi i fitnesit tekstil L ka një dizajn të veçantë dhe është i përforcuar në vendin ku ngjitet. Çmi | 0 |  | 25 | 31 |  |  |
| 28bec994 | 1 | customer | Pershendetje a keni carbo one | 0 |  | 0 |  |  |  |
| 28bec994 | 2 | customer | Me qfar shije i keni edhe sa kushtojn | 0 |  | 0 | 7 |  |  |
| 28bec994 | 3 | ai | Ne kemi A.Nutrition L-carnitine 480mil me shije portokalli që kushton €32.00. Do t'ju njoftojmë së s | 0 |  | 0 | 50 |  |  |
| 29238c0d | 1 | customer | Pershendetje a keni produkte per shtim peshe | 0 |  | 0 |  |  |  |
| 29238c0d | 2 | ai | Po, kemi disa produkte për shtim peshe. | 0 | 0.920 | 25 | 71 |  |  |
| 29238c0d | 3 | customer | cilat i keni | 0 |  | 0 | 25 |  |  |
| 29238c0d | 4 | ai | - Critical Mass 6kg Keks - Mass gainer 3kg Qokolad - Mega mass 3kg Qokolad - Mega mass 3kg Vanil - M | 0 | 0.950 | 25 | 32 |  |  |
| 29238c0d | 5 | customer | Cila osht ma e lira | 0 |  | 0 | 44 |  |  |
| 29238c0d | 6 | ai | Më vjen keq, por asnjë nga produktet që përmenda nuk është në dispozicion në katalogun aktual. Nëse  | 0 | 0.200 | 10 | 49 |  |  |
| 2b375480 | 1 | customer | Pershendetje a e keni kete produkt? | 0 |  | 0 |  |  |  |
| 2b375480 | 2 | customer | Customer shared a post | 0 |  | 0 | 2 |  |  |
| 2b375480 | 3 | ai | Po, e kemi produktin Nitro Tech Ripped në shije çokollatë. A doni ta porosisni? | 0 | 0.950 | 0 | 23 |  |  |
| 2b375480 | 4 | customer | Po | 0 |  | 0 | 54 |  |  |
| 2b375480 | 5 | customer | Sa osht qmimi | 0 |  | 0 | 12 |  |  |
| 2b375480 | 6 | ai | Çmimi i produktit Nitro Tech Ripped është €50.00. | 0 | 0.920 | 0 | 23 |  |  |
| 2b375480 | 7 | customer | Okej pe porositi | 0 |  | 0 | 16 |  |  |
| 2b375480 | 8 | ai | Për të vazhduar me porosinë, ju lutem më jepni emrin tuaj, numrin e telefonit dhe adresën e plotë të | 0 | 0.950 | 0 | 19 |  |  |
| 2b375480 | 9 | customer | 045 787 266, Bregu i diellit Banesat e bardha blloku 35, Prishtine | 0 |  | 0 | 23 |  |  |
| 2b375480 | 10 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| 2b375480 | 11 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 21 |  |  |
| 2b375480 | 12 | customer | Po | 0 |  | 0 | 5 |  |  |
| 2b375480 | 13 | ai | Porosia juaj është konfirmuar! Do të arrijë brenda afatit të dorëzimit të specifikuar. Nëse keni ndo | 0 | 0.200 | 0 | 21 |  |  |
| 2b375480 | 14 | customer | Poashtu a keni ndonje creatin te mir | 0 |  | 0 | 570 |  |  |
| 2b375480 | 15 | ai | Po, kemi disa opsione të shkëlqyera për kreatinë. Disa prej tyre janë: 1. **Applied Nutrition Creati | 0 | 0.950 | 0 | 22 |  |  |
| 2b375480 | 16 | customer | Pershendetje a muna me porosit kta | 0 |  | 0 | 2177 |  |  |
| 306e56fe | 1 | customer | Pershendetje a keni produkte per shtim peshe | 0 |  | 0 |  |  |  |
| 306e56fe | 2 | ai | Po. | 0 | 0.500 | 25 | 48 |  |  |
| 306e56fe | 3 | customer | Cilat i keni | 0 |  | 0 | 24 |  |  |
| 306e56fe | 4 | ai | Aktualisht nuk kemi produkte specifike për shtim peshe në katalogun e dhënë. Nëse jeni të interesuar | 0 | 0.900 | 10 | 23 |  |  |
| 3ea2ace9 | 1 | customer | Pershendetje a keni carbo one | 0 |  | 0 |  |  |  |
| 3ea2ace9 | 2 | ai | Po. | 0 | 0.500 | 10 | 23 |  |  |
| 3ea2ace9 | 3 | customer | Me qfar shije i keni edhe sa kushtojn | 0 |  | 0 | 16 |  |  |
| 3ea2ace9 | 4 | ai | S� shpejti do t�ju kontaktoj� nj� specialist me informacion t� sakt� p�r produktin. | 0 | 0.920 | 0 | 63 |  |  |
| 461901a6 | 1 | customer | Pershendejte a keni produkte per shtim peshe | 0 |  | 0 |  |  |  |
| 461901a6 | 2 | ai | Po, kemi disa produkte për shtim peshe. Disa nga opsionet janë: - Critical Mass 6kg Keks - Mass gain | 0 | 0.950 | 25 | 33 |  |  |
| 461901a6 | 3 | customer | A keni tjera a veq qito | 0 |  | 0 | 46 |  |  |
| 461901a6 | 4 | ai | Kemi edhe disa produkte të tjera për shtim peshe: - Mega mass 3kg Vanil - Mega mass 7kg Qokolad - Re | 0 | 0.920 | 25 | 21 |  |  |
| 461901a6 | 5 | customer | Sa kushton mega mass 7kg qokollada | 0 |  | 0 | 52 |  |  |
| 461901a6 | 6 | ai | Kushton €95. | 0 | 0.950 | 25 | 23 |  |  |
| 4c10fc71 | 1 | customer | Pershendetje si jeni, a keni kete produkt | 0 |  | 0 |  |  |  |
| 4c10fc71 | 2 | customer | Customer shared a post | 0 |  | 0 | 8 |  |  |
| 4c10fc71 | 3 | human | Më vjen keq, por nuk e kemi produktin Muscletech Nitro Tech Whey Protein" në shijen Luleshtrydhe. Në | 0 |  | 0 | 25 |  |  |
| 4c10fc71 | 4 | customer | A keni me ndonje shije tjeter qisi | 0 |  | 0 | 46 |  |  |
| 4c10fc71 | 5 | human | Më vjen keq, por nuk e kemi produktin e saktë që kërkoni. Megjithatë, mund t'ju ofrojmë disa alterna | 0 |  | 0 | 28 |  |  |
| 5086ed7d | 1 | customer | Pershendefje a keni carbo one | 0 |  | 0 |  |  |  |
| 5086ed7d | 2 | human | Po. | 0 |  | 0 | 26 |  |  |
| 509f4690 | 1 | customer | Pershendetje a keni proteina te mira | 0 |  | 0 |  |  |  |
| 509f4690 | 2 | ai | Po, kemi një gamë të gjerë proteinash cilësore. Disa nga opsionet tona përfshijnë Applied Nutrition  | 0 | 0.950 | 10 | 29 |  |  |
| 509f4690 | 3 | customer | Tjera a keni a veq qita | 0 |  | 0 | 26 |  |  |
| 509f4690 | 4 | ai | Kemi edhe shumë lloje të tjera proteinash. Për shembull, mund të gjeni edhe proteina si Optimum Nutr | 0 | 0.200 | 10 | 26 |  |  |
| 509f4690 | 5 | customer | sa kushton qikjo optium nutrition gold standart edhe qfar shije e ka | 0 |  | 0 | 39 |  |  |
| 509f4690 | 6 | ai | Përshëndetje, do t'ju njoftojmë së shpejti lidhur me çmimi dhe shija. | 0 |  | 10 | 34 |  |  |
| 5138a806 | 1 | customer | Pershendetje a e keni kete produkt | 0 |  | 0 |  |  |  |
| 5138a806 | 2 | customer | Customer shared a post | 0 |  | 0 | 2 |  |  |
| 5138a806 | 3 | ai | Më vjen keq, por nuk e kemi në dispozicion produktin Muscletech Nitro Tech Ripped. Nëse jeni duke kë | 0 | 0.900 | 0 | 26 |  |  |
| 56a29a1a | 1 | customer | Pershendetje a muna me Porosit qit produkt | 0 |  | 0 |  |  |  |
| 56a29a1a | 2 | customer | *(null — attachment-only)* | 0 |  | 0 | 6 |  |  |
| 56a29a1a | 3 | ai | Po, mund ta porosisni produktin Nitro Tech Ripped nga Muscletech. A doni ta porosisni? | 0 | 0.950 | 0 | 25 |  |  |
| 56a29a1a | 4 | customer | Po de | 0 |  | 0 | 21 |  |  |
| 56a29a1a | 5 | ai | Ju lutem më jepni emrin tuaj të parë, numrin e kontaktit dhe adresën e plotë të dërgesës për të vazh | 0 | 0.700 | 0 | 22 |  |  |
| 56a29a1a | 6 | customer | Adem, bregu i diellit banesat e bardha, blloku 35, Prishtin | 0 |  | 0 | 30 |  |  |
| 56a29a1a | 7 | ai | Faleminderit, Adem! Për të përfunduar, a mund të më jepni edhe numrin tuaj të kontaktit? | 0 | 0.950 | 0 | 19 |  |  |
| 56a29a1a | 8 | customer | Po mfal | 0 |  | 0 | 11 |  |  |
| 56a29a1a | 9 | customer | 045 687 266 | 0 |  | 0 | 4 |  |  |
| 56a29a1a | 10 | customer | *(null — attachment-only)* | 0 |  | 0 | 0 |  |  |
| 56a29a1a | 11 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.900 | 0 | 20 |  |  |
| 56a29a1a | 12 | customer | Po | 0 |  | 0 | 6 |  |  |
| 56a29a1a | 13 | ai | Faleminderit! Porosia juaj është konfirmuar dhe do të dërgohet së shpejti. Nëse keni ndonjë pyetje t | 0 | 0.200 | 0 | 24 |  |  |
| 56a29a1a | 14 | customer | Pershendetje, a keni ndonje produkt te mir per humbje peshe | 0 |  | 0 | 2885 |  |  |
| 56a29a1a | 15 | ai | Për humbje peshe, mund të rekomandoj disa produkte të shkëlqyera që kemi në dispozicion: 1. **A.Nutr | 0 | 0.950 | 0 | 28 |  |  |
| 56a29a1a | 16 | customer | Sa kushton nutrition me shije porotokalli | 0 |  | 0 | 59 |  |  |
| 56a29a1a | 17 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 |  | 0 | 22 |  |  |
| 56b9702c | 1 | customer | Pershendetje a keni creatine monohydrate ne dispoziciom? | 0 |  | 0 |  |  |  |
| 56b9702c | 2 | ai | Përshëndetje! Po, creatine monohydrate është në dispozicion. A doni ta porosisni? | 0 | 0.920 | 0 | 28 |  |  |
| 56b9702c | 3 | customer | Me qfar shije i keni? | 0 |  | 0 | 16 |  |  |
| 56b9702c | 4 | ai | E kemi në shije mjedre. | 0 | 0.700 | 0 | 23 |  |  |
| 56b9702c | 5 | customer | A keni me shije qershie? | 0 |  | 0 | 25 |  |  |
| 56b9702c | 6 | ai | Më vjen keq, por creatine monohydrate nuk e kemi në shije qershie. Aktualisht është në dispozicion v | 0 | 0.600 | 0 | 22 |  |  |
| 56b9702c | 7 | customer | Sa her ne dite muna me perdor? | 0 |  | 0 | 62 |  |  |
| 56b9702c | 8 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje. | 0 |  | 0 | 21 |  |  |
| 6a120665 | 1 | customer | Pershendetje a keni proteina te mira per ushtrime | 0 |  | 0 |  |  |  |
| 6a120665 | 2 | ai | Po, kemi disa opsione të proteinave cilësore për ushtrime. Ja disa prej tyre: - Applied Nutrition Di | 0 | 0.950 | 10 | 28 |  |  |
| 6a120665 | 3 | customer | Cila o ma e lira | 0 |  | 0 | 22 |  |  |
| 6a120665 | 4 | ai | Applied Nutrition Diet whey 1kg Qokolad: €42 | 0 | 0.920 | 10 | 23 |  |  |
| 6a120665 | 5 | customer | A muna me porosit qita | 0 |  | 0 | 17 |  |  |
| 6a120665 | 6 | ai | Po, mund ta porosisni. Ju lutem më jepni emrin tuaj, numrin e telefonit dhe adresën e plotë të dorëz | 0 | 0.700 | 0 | 29 |  |  |
| 6a120665 | 7 | customer | Adem, 045687266, Bregu i Diellit banesat e bardha blloku 39 Prishtine | 0 |  | 0 | 27 |  |  |
| 6a120665 | 8 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| 6a120665 | 9 | ai | Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte? | 0 | 0.950 | 10 | 25 |  |  |
| 6a120665 | 10 | customer | Po | 0 |  | 0 | 4 |  |  |
| 6a120665 | 11 | ai | Porosia juaj është konfirmuar dhe do të dorëzohet së shpejti. Nëse keni pyetje të tjera ose doni të  | 0 | 0.200 | 0 | 22 |  |  |
| 6a120665 | 12 | customer | E kreatina a keni be | 0 |  | 0 | 153 |  |  |
| 6a120665 | 13 | ai | Po, kemi një gamë të gjerë të kreatinave. Disa prej tyre janë: - Creatine Monohydrate - Applied Nutr | 0 | 0.920 | 25 | 28 |  |  |
| 6a120665 | 14 | customer | E tjera a keni | 0 |  | 0 | 11 |  |  |
| 6a120665 | 15 | ai | Po, kemi edhe këto kreatina të tjera: - BSN Creatine 216gr - Cell Tech 1.13 kg Fruit | 0 | 0.920 | 25 | 39 |  |  |
| 6a120665 | 16 | customer | Qfar shije i kan edhe sa kushtojn | 0 |  | 0 | 70 |  |  |
| 6a120665 | 17 | ai | Këto janë shijet dhe çmimet për kreatinat që kemi: - Applied Nutrition Creatine 250gr shije Mjedre:  | 0 | 0.900 | 25 | 50 |  |  |
| 6da91488 | 1 | customer | Pershendetje a e keni kete kreatin? | 0 |  | 0 |  |  |  |
| 6da91488 | 2 | customer | Customer shared a post | 0 |  | 0 | 2 |  |  |
| 6da91488 | 3 | ai | Përshëndetje! Fatkeqësisht, nuk e kemi kreatinën "Optimum Nutrition Micronised Creatine Powder" në k | 0 | 0.920 | 0 | 32 |  |  |
| 6da91488 | 4 | customer | A keni kreatina tjera perpos ksaj? | 0 |  | 0 | 29 |  |  |
| 6da91488 | 5 | ai | Po, ne kemi një gamë të gjerë të produkteve të kreatinës. Disa prej tyre përfshijnë: - Kreatinë 300g | 0 | 0.950 | 0 | 23 |  |  |
| 79a58aac | 1 | customer | Pershendetje a e keni kete produkt? | 0 |  | 0 |  |  |  |
| 79a58aac | 2 | customer | Customer shared a post | 0 |  | 0 | 2 |  |  |
| 79a58aac | 3 | ai | Po, e kemi në stok produktin Nitro Tech Ripped. A doni ta porosisni? | 0 | 0.920 | 0 | 25 |  |  |
| 79a58aac | 4 | customer | Qfar shije e ka | 0 |  | 0 | 32 |  |  |
| 79a58aac | 5 | ai | Nitro Tech Ripped nuk ka shije të specifikuar në katalog. Nëse dëshironi të eksploroni opsione të tj | 0 | 0.920 | 0 | 24 |  |  |
| 79a58aac | 6 | customer | Jo flm a muna me porosit qit produktin qe ta dergova foto edhe sa kushton mfal | 0 |  | 0 | 102 |  |  |
| 79a58aac | 7 | ai | Për fat të keq, produkti që keni dërguar në foto nuk është në katalogun tonë aktual. Ju rekomandoj t | 0 | 0.900 | 0 | 22 |  |  |
| 7dd53b3e | 1 | customer | pershendetje, a keni ndonje produkt per shtim peshe | 0 |  | 0 |  |  |  |
| 7dd53b3e | 2 | ai | Përshëndetje! Po, kemi Mass Gainer Pro, i cili është perfekt për shtim peshe dhe bulking. A doni ta  | 0 | 0.950 | 0 | 19 |  |  |
| 7dd53b3e | 3 | customer | sa her ne dit muna me perdor kit produkt mfal? | 0 |  | 0 | 35 |  |  |
| 7dd53b3e | 4 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje. | 0 |  | 0 | 26 |  |  |
| 8153c698 | 1 | customer | Pershendetje, ku gjendeni me Lokacion? | 0 |  | 0 |  |  |  |
| 8153c698 | 2 | ai | Përshëndetje! Ne jemi të vendosur në Bulevardin Dëshmorët e Kombit, Prishtinë. | 0 | 0.950 | 0 | 19 |  |  |
| 8153c698 | 3 | customer | qysh e keni numrin e telefonit | 0 |  | 0 | 58 |  |  |
| 8153c698 | 4 | ai | Numri ynë i telefonit është +383 44 889 662. | 0 | 0.950 | 0 | 25 |  |  |
| 8153c698 | 5 | customer | a osht posta falas per porosi apo jo? | 0 |  | 0 | 17 |  |  |
| 8153c698 | 6 | ai | Po, posta është falas për porositë mbi 20 euro. | 0 | 0.900 | 0 | 18 |  |  |
| 8153c698 | 7 | customer | A keni ndonje produkt te mir per humbje peshe? | 0 |  | 0 | 137 |  |  |
| 8153c698 | 8 | ai | Po, kemi disa produkte të shkëlqyera për humbje peshe. Disa prej tyre janë: - **A.Nutrition L-carnit | 0 | 0.950 | 0 | 21 |  |  |
| 8153c698 | 9 | customer | Sa kushton qikjo c4 ripped | 0 |  | 0 | 33 |  |  |
| 8153c698 | 10 | ai | C4 Ripped pre-workout me shije Ananas kushton €38.00. | 0 | 0.920 | 0 | 22 |  |  |
| 8153c698 | 11 | customer | A muna me porosit ne keto te dhena: Bregu i diellit banesat e bardha blloku 35 Prishtine, 045 687 26 | 0 |  | 0 | 39 |  |  |
| 8153c698 | 12 | customer | *(null — attachment-only)* | 0 |  | 0 | 0 |  |  |
| 8153c698 | 13 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 20 |  |  |
| 8153c698 | 14 | customer | Po | 0 |  | 0 | 6 |  |  |
| 8153c698 | 15 | ai | Porosia juaj është konfirmuar! Faleminderit që zgjodhët Protein Plus. Nëse keni ndonjë pyetje tjetër | 0 | 0.200 | 0 | 22 |  |  |
| 88283c5e | 1 | customer | Pershendetje a e keni kete produkt me dispozicion | 0 |  | 0 |  |  |  |
| 92cd366e | 1 | customer | Pershendetje a keni carbo one | 0 |  | 0 |  |  |  |
| 92cd366e | 2 | human | Po. | 0 |  | 0 | 32 |  |  |
| 92cd366e | 3 | customer | Me qfar shije i keni edhe sa kushtojn | 0 |  | 0 | 3 |  |  |
| 92cd366e | 4 | human | Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 |  | 0 | 72 |  |  |
| 98571d00 | 1 | customer | Pershendetje a keni whey protein edhe me qfar shije | 0 |  | 0 |  |  |  |
| 98571d00 | 2 | ai | Po, kemi whey protein në disa shije të ndryshme: - Dredhëz Çokollatë Vanilje Banane Karamel Keks Nës | 0 | 0.950 | 25 | 55 |  |  |
| 98571d00 | 3 | customer | Sa kushton | 0 |  | 0 | 23 |  |  |
| 98571d00 | 4 | ai | Çmimet për whey protein janë si më poshtë: - Compact gold whey 1kg Dredhz: €35.00 Compact gold whey  | 0 | 0.950 | 25 | 47 |  |  |
| acfbb493 | 1 | customer | Pershendetje a keni ndonje creatine te mir | 0 |  | 0 |  |  |  |
| acfbb493 | 2 | ai | Përshëndetje! Po, kemi disa opsione të shkëlqyera për kreatinë në Protein Plus. Disa nga produktet t | 0 | 0.950 | 0 | 19 |  |  |
| acfbb493 | 3 | customer | A muna me porosit qita applied nutrition creatine? | 0 |  | 0 | 78 |  |  |
| acfbb493 | 4 | ai | Sigurisht! Për të vazhduar me porosinë e produktit Applied Nutrition Creatine 250gr shije Mjedre, ju | 0 | 0.950 | 0 | 20 |  |  |
| acfbb493 | 5 | customer | Adem Sulimani, Bregu i diellit Banesat e bardha blloku 35 Prishtine, 045 687 266 | 0 |  | 0 | 34 |  |  |
| acfbb493 | 6 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| acfbb493 | 7 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 19 |  |  |
| acfbb493 | 8 | customer | Oo | 0 |  | 0 | 8 |  |  |
| acfbb493 | 9 | customer | Po | 0 |  | 0 | 1 |  |  |
| acfbb493 | 10 | ai | Faleminderit për konfirmimin! Porosia juaj për Applied Nutrition Creatine është përpunuar dhe do të  | 0 | 0.200 | 0 | 25 |  |  |
| af548526 | 1 | customer | Pershendetje a keni ndonje produkt te mir per shtim Peshe? | 0 |  | 0 |  |  |  |
| af548526 | 2 | customer | Pershendetje, a keni ndonje produkt te mir per shtim peshe? | 0 |  | 0 | 15 |  |  |
| af548526 | 3 | ai | Përshëndetje! Për shtim në peshë, një opsion i mirë është proteina si Applied Nutrition Whey. Kjo nd | 0 | 0.920 | 0 | 32 |  |  |
| af548526 | 4 | customer | Sa kushton? | 0 |  | 0 | 74 |  |  |
| af548526 | 5 | ai | Më vjen keq, por për momentin nuk kam qasje në çmimin e saktë për Applied Nutrition Whey. Ju rekoman | 0 | 0.900 | 0 | 22 |  |  |
| b8173c49 | 1 | customer | Pershendejte a e keni kete produkt ne dispozicion? | 0 |  | 0 |  |  |  |
| b8173c49 | 2 | customer | Customer shared content: 🔥 Back in STOCK! 🔥 Creatine Monohydrate me shijen më të kërkuar – QERSHI 🍒  | 0 |  | 0 | 2 |  |  |
| b8173c49 | 3 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 |  | 0 | 22 |  |  |
| b973ad04 | 1 | customer | pershendetje, a keni ndonje produkt per shtim peshe | 0 |  | 0 |  |  |  |
| b973ad04 | 2 | ai | Përshëndetje! Po, kemi Mass Gainer Pro që është perfekt për shtim peshe dhe bulking. A doni ta poros | 0 | 0.950 | 0 | 18 |  |  |
| b973ad04 | 3 | customer | sa her ne dit muna me perdor mfal | 0 |  | 0 | 15 |  |  |
| b973ad04 | 4 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje. | 0 |  | 0 | 16 |  |  |
| bbdb9d71 | 1 | customer | Pershendetje a keni ndonje creatine te mir | 0 |  | 0 |  |  |  |
| bbdb9d71 | 2 | ai | Përshëndetje! Po, kemi disa opsione të kreatinës që mund të jenë të përshtatshme për ju. Disa nga pr | 0 | 0.950 | 0 | 20 |  |  |
| bbdb9d71 | 3 | customer | A muna me porosit applied nutrion creatine ne keto te dhena: Bregu i Diellit, Banesat e bardha prish | 0 |  | 0 | 78 |  |  |
| bbdb9d71 | 4 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| bbdb9d71 | 5 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 18 |  |  |
| bbdb9d71 | 6 | customer | Po | 0 |  | 0 | 7 |  |  |
| bbdb9d71 | 7 | ai | Porosia juaj është konfirmuar dhe do të përpunohet së shpejti. Nëse keni ndonjë pyetje tjetër apo dë | 0 | 0.200 | 0 | 20 |  |  |
| bbdb9d71 | 8 | customer | Pershendetje a e keni kete produkt ne dispozicion? | 0 |  | 0 | 1198 |  |  |
| bbdb9d71 | 9 | customer | Customer shared content: 🔥 Back in STOCK! 🔥 Creatine Monohydrate me shijen më të kërkuar – QERSHI 🍒  | 0 |  | 0 | 2 |  |  |
| bbdb9d71 | 10 | ai | Përshëndetje, së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 |  | 0 | 28 |  |  |
| cdd0bdea | 1 | customer | Pershendetje ku gjendeni me lokaciom? | 0 |  | 0 |  |  |  |
| cdd0bdea | 2 | ai | Përshëndetje! Protein Plus ndodhet në Bulevardi Dëshmorët e Kombit, Prishtinë. | 0 | 0.950 | 0 | 20 |  |  |
| cdd0bdea | 3 | customer | Si e keni numrin e telefonit me ju kontaktu? | 0 |  | 0 | 21 |  |  |
| cdd0bdea | 4 | ai | Numri ynë i telefonit është +383 44 889 662. | 0 | 0.950 | 0 | 19 |  |  |
| cdd0bdea | 5 | customer | e orarin e punes qysh e keni a jeni te dielleve hapur? | 0 |  | 0 | 21 |  |  |
| cdd0bdea | 6 | ai | Orari ynë i punës është nga e hëna deri të shtunën, prej orës 09:00 deri në 20:00. Të dielave zakoni | 0 | 0.950 | 0 | 18 |  |  |
| cdd0bdea | 7 | customer | Aha okej, dashta me ju vet a keni ndonje produkt te mir per shtim peshe? | 0 |  | 0 | 58 |  |  |
| cdd0bdea | 8 | ai | Po, kemi disa produkte për shtim peshe që mund tju interesojnë. Disa nga opsionet më të mira përfshi | 0 | 0.950 | 0 | 20 |  |  |
| cdd0bdea | 9 | customer | Sa kushton mega masa? | 0 |  | 0 | 60 |  |  |
| cdd0bdea | 10 | ai | Mega Mass 3kg në shije qokoladë dhe vanil kushton €55.00. | 0 | 0.950 | 0 | 22 |  |  |
| cdd0bdea | 11 | customer | A muna me porosit | 0 |  | 0 | 23 |  |  |
| cdd0bdea | 12 | ai | Sigurisht! Për të vazhduar me porosinë, ju lutem më jepni emrin tuaj, mbiemrin, numrin e telefonit d | 0 | 0.900 | 0 | 19 |  |  |
| cdd0bdea | 13 | customer | Adem Sulimani, 045 687 266, Bregu i diellit, Banesat e bardha blloku 35 Prishtine | 0 |  | 0 | 36 |  |  |
| cdd0bdea | 14 | customer | *(null — attachment-only)* | 0 |  | 0 | 0 |  |  |
| cdd0bdea | 15 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 21 |  |  |
| cdd0bdea | 16 | customer | Po | 0 |  | 0 | 8 |  |  |
| cdd0bdea | 17 | ai | Porosia juaj është konfirmuar dhe do të dorëzohet brenda 24 orëve. Nëse keni ndonjë pyetje tjetër ap | 0 | 0.200 | 0 | 21 |  |  |
| cdd0bdea | 18 | customer | Faleminderit a muna me Porosit produktin e njejt veq me shije qokollad | 0 |  | 0 | 696 |  |  |
| cdd0bdea | 19 | ai | Po, mund të porosisni Mega Mass 3kg me shije qokoladë. | 0 | 0.920 | 0 | 22 |  |  |
| cdd0bdea | 20 | customer | Okej faleminderit shum, kaloni bukur | 0 |  | 0 | 32 |  |  |
| cdd0bdea | 21 | customer | Poashtu kur um vjen porosia? | 0 |  | 0 | 11 |  |  |
| cdd0bdea | 22 | ai | Përshëndetje, porosia juaj do të mbërrijë brenda 24 orëve. | 0 |  | 0 | 12 |  |  |
| cebf6a66 | 1 | customer | Pershendefje a keni carbo one | 0 |  | 0 |  |  |  |
| cebf6a66 | 2 | human | Po. | 0 |  | 0 | 29 |  |  |
| cf2bf59a | 1 | customer | Pershendetje a keni carbo one | 0 |  | 0 |  |  |  |
| cf2bf59a | 2 | ai | Po. | 0 | 0.500 | 10 | 35 |  |  |
| cf2bf59a | 3 | customer | Me qfar shije i keni edhe sa kushtojn | 0 |  | 0 | 3 |  |  |
| cf2bf59a | 4 | ai | S� shpejti do t�ju kontaktoj� nj� specialist me informacion t� sakt� p�r produktin. | 0 | 0.920 | 0 | 42 |  |  |
| d1d12b10 | 1 | customer | pershendetje a keni nitro tech ripped | 0 |  | 0 |  |  |  |
| d1d12b10 | 2 | customer | pershendetje a keni nitro tech ripped | 0 |  | 0 | 411 |  |  |
| d1d12b10 | 3 | customer | pershendetje a keni nitro tech ripped | 0 |  | 0 | 457 |  |  |
| d1d12b10 | 4 | ai | Po. | 0 |  | 10 | 44 |  |  |
| d1d12b10 | 5 | customer | A munesh me ma qu foto be | 0 |  | 0 | 17 |  |  |
| d1d12b10 | 6 | ai | Dërgo emrin e saktë të produktit ose një foto të produktit. | 0 |  | 3 | 52 |  |  |
| d218dd90 | 1 | customer | pershendetje, a muna me porosit nje mass gainer ne keto te dhena: Bregu I diellit, banesat e bardha  | 0 |  | 0 |  |  |  |
| d218dd90 | 2 | customer | Customer shared content | 0 |  | 0 | 0 |  |  |
| d218dd90 | 3 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që numri i telefoni | 0 | 0.900 | 0 | 19 |  |  |
| d218dd90 | 4 | customer | po | 0 |  | 0 | 9 |  |  |
| d218dd90 | 5 | ai | Perfekt, porosia juaj është e konfirmuar dhe do të dorëzohet së shpejti. Nëse keni ndonjë pyetje tje | 0 | 0.200 | 0 | 19 |  |  |
| e328fc3b | 1 | customer | Pershendetje a keni naj kreatin te mir | 0 |  | 0 |  |  |  |
| e328fc3b | 2 | human | Po, kemi disa opsione të kreatinës që mund tju interesojnë: - On creatine 317gr pa shije - Creatine  | 0 |  | 0 | 31 |  |  |
| e328fc3b | 3 | customer | sa kushtojn kto | 0 |  | 0 | 75 |  |  |
| e328fc3b | 4 | human | - On creatine 317gr pa shije: €40 - Creatine 300g shije Qershis: €25 - Creatine 500gr Portokall: €38 | 0 |  | 0 | 28 |  |  |
| e328fc3b | 5 | customer | Cilen ma kishe rekomandu me marr be | 0 |  | 0 | 12 |  |  |
| e328fc3b | 6 | human | Së shpejti do t’ju kontaktojë një specialist për këtë çështje. | 0 |  | 0 | 27 |  |  |
| e4906244 | 1 | customer | hows the weather pookie | 0 |  | 0 |  |  |  |
| e4906244 | 2 | human | Pershendetje, ku gjendeni me adres? | 0 |  | 0 | 26258 |  |  |
| e4906244 | 3 | customer | Pershendetje ku gjendeni me adres? | 0 |  | 0 | 45 |  |  |
| e4906244 | 4 | customer | Pershendetje ku gjendeni me adres? | 0 |  | 0 | 89 |  |  |
| e4906244 | 5 | ai | Përshëndetje! Jemi të vendosur në Bulevardi Dëshmorët e Kombit, Prishtinë 10000. | 0 | 0.950 | 0 | 26 |  |  |
| ef6b1740 | 1 | customer | pershendetje, a muna me porosit nje mass gainer ne keto te dhena: Bregu I diellit, Banesat e bardha, | 0 |  | 0 |  |  |  |
| ef6b1740 | 2 | ai | Përshëndetje! Faleminderit për të dhënat. Produkti Mass Gainer Pro është në dispozicion. A doni ta p | 0 | 0.950 | 0 | 19 |  |  |
| ef6b1740 | 3 | customer | po | 0 |  | 0 | 14 |  |  |
| ef6b1740 | 4 | ai | Shkëlqyeshëm! Porosia juaj për Mass Gainer Pro është pranuar dhe do të dorëzohet së shpejti te Bregu | 0 | 0.200 | 0 | 19 |  |  |
| f412d3f4 | 1 | customer | Pershendetje a keni ndonje produkt te mir per humbje peshe | 0 |  | 0 |  |  |  |
| f412d3f4 | 2 | ai | Përshëndetje! Po, kemi disa produkte të mira për humbje peshe. Një opsion është A.Nutrition L-carnit | 0 | 0.920 | 0 | 25 |  |  |
| f412d3f4 | 3 | customer | Sa kushtojn kto? | 0 |  | 0 | 35 |  |  |
| f412d3f4 | 4 | ai | Për momentin nuk kam informacion për çmimet e këtyre produkteve specifike në katalogun tonë. Nëse dë | 0 | 0.200 | 0 | 23 |  |  |
| f412d3f4 | 5 | customer | A keni produkte per shtim peshe? | 0 |  | 0 | 1022 |  |  |
| f412d3f4 | 6 | ai | Po, kemi disa produkte për shtim peshe. Për shembull, Mass gainer 3kg Qokolad është një zgjedhje ide | 0 | 0.950 | 0 | 36 |  |  |
| f412d3f4 | 7 | customer | Sa kushtojne kto? | 0 |  | 0 | 20 |  |  |
| f412d3f4 | 8 | ai | Mass gainer 3kg Qokolad kushton €52.00, ndërsa Mega mass 3kg Qokolad kushton €55.00. | 0 | 0.950 | 0 | 33 |  |  |
| f412d3f4 | 9 | customer | A mundem me porosit mass gainer 3kg qokolad | 0 |  | 0 | 92 |  |  |
| f412d3f4 | 10 | ai | Sigurisht! Për të vazhduar me porosinë e Mass gainer 3kg Qokolad, ju lutem më jepni emrin tuaj të pa | 0 | 0.950 | 0 | 34 |  |  |
| f412d3f4 | 11 | customer | Adem Sulimani, Bregu i diellit banesat e bardha blloku 35, 045 697 266 | 0 |  | 0 | 24 |  |  |
| f412d3f4 | 12 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| f412d3f4 | 13 | ai | Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që ken | 0 | 0.950 | 0 | 30 |  |  |
| f412d3f4 | 14 | customer | Po | 0 |  | 0 | 5 |  |  |
| f412d3f4 | 15 | ai | Faleminderit për konfirmimin! Porosia juaj për Mass gainer 3kg Qokolad është regjistruar dhe do të p | 0 | 0.200 | 0 | 24 |  |  |
| f911e3dd | 1 | customer | Pershendetje a keni carbo one 1kg edhe qfar shije e keni | 0 |  | 0 |  |  |  |
| f911e3dd | 2 | ai | Po, kemi Carbo One 1kg në dispozicion me shije limoni dhe portokalli. | 0 | 0.950 | 25 | 75 |  |  |
| f911e3dd | 3 | customer | Sa kushtojn | 0 |  | 0 | 15 |  |  |
| f911e3dd | 4 | ai | €18. | 0 | 0.920 | 25 | 33 |  |  |
| f911e3dd | 5 | customer | A muna me Porosit qita me shije limoni | 0 |  | 0 | 33 |  |  |
| f911e3dd | 6 | ai | Patjetër! Më nevojiten emri juaj, numri i telefonit dhe adresa e plotë e dorëzimit për të vazhduar m | 0 | 0.950 | 25 | 77 |  |  |
| f911e3dd | 7 | customer | Adem, 045 687 266, Bregu i Diellit Banesat e bardha blloku 35 Prishtine | 0 |  | 0 | 27 |  |  |
| f911e3dd | 8 | customer | *(null — attachment-only)* | 0 |  | 0 | 1 |  |  |
| f911e3dd | 9 | ai | Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte? | 0 | 0.950 | 10 | 34 |  |  |
| f911e3dd | 10 | customer | Po | 0 |  | 0 | 5 |  |  |
| f911e3dd | 11 | ai | Faleminderit, porosia juaj është konfirmuar dhe do të dërgohet së shpejti. Nëse keni pyetje të tjera | 0 | 0.200 | 0 | 37 |  |  |
| f911e3dd | 12 | customer | a keni produkte te mira per shtim peshe | 0 |  | 0 | 113 |  |  |
| f911e3dd | 13 | ai | Po, kemi produktin X-Mass 3kg Qokolad, i cili është i përshtatshëm për shtim peshe. A doni ta porosi | 0 | 0.950 | 10 | 50 |  |  |
| f911e3dd | 14 | customer | a keni tjera a veq qita | 0 |  | 0 | 10 |  |  |
| f911e3dd | 15 | ai | Ndërsa produkti i saktë që përmenda nuk është në katalogun aktual, mund të sugjeroj që të provoni "C | 0 | 0.900 | 25 | 44 |  |  |
| fcd0af7e | 1 | customer | a keni produkte te mira per shtim peshe | 0 |  | 0 |  |  |  |
| fcd0af7e | 2 | ai | Po, kemi disa produkte për shtim peshe. Disa nga opsionet përfshijnë: - Mass gainer 3kg Qokolad: Plu | 0 | 0.950 | 25 | 53 |  |  |
| fcd0af7e | 3 | customer | a keni tjera a veq qito | 0 |  | 0 | 39 |  |  |
| fcd0af7e | 4 | ai | Po, kemi edhe disa produkte të tjera për shtim peshe, si: - Critical Mass 6kg Keks - Pro Mass 1kg Qo | 0 | 0.920 | 25 | 39 |  |  |
| fcd0af7e | 5 | customer | Cilen mkishe than ti me marr prej qitynve | 0 |  | 0 | 25 |  |  |
| fcd0af7e | 6 | ai | Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin. | 0 | 0.200 | 10 | 43 |  |  |

- **Notes on EV-018:** `send_status`/`send_error` are NULL on all 374 rows. Every `quality_score = 0.200` row is an order-confirmation message ("Porosia juaj është konfirmuar…") — the eval model systematically scores the final confirmation reply 0.2 while scoring mid-conversation product answers 0.9–0.95. Only one message in the entire DB is `flagged=true` (conv 18129839 turn 13, also a 0.200 confirmation). NULL-content rows are attachment-only messages.

## EV-019 — Q3 product-anchor loss (AI turns with empty product_ids after an anchored AI turn)

- **When:** 2026-07-11
- **Query:** window-function query over `messages`: for each AI turn, `max(np) OVER (PARTITION BY conversation_id ORDER BY turn ROWS UNBOUNDED PRECEDING TO 1 PRECEDING)` vs current `jsonb_array_length(product_ids)`; selected rows where current `np=0` and a preceding AI turn had `np>0` (`prev_ai_np` = np of the immediately preceding AI turn).
- **Result (verbatim, 10 anchor-loss events):**

| conv | overall turn | ai_idx | np | prev_ai_np | prev_max_np |
|------|------|--------|----|------------|-------------|
| 18129839 | 8 | 4 | 0 | 10 | 25 |
| 18129839 | 13 | 6 | 0 | 10 | 25 |
| 18129839 | 15 | 7 | 0 | 0 | 25 |
| 1d001d46 | 16 | 7 | 0 | 10 | 10 |
| 1d001d46 | 30 | 13 | 0 | 10 | 10 |
| 3ea2ace9 | 4 | 2 | 0 | 10 | 10 |
| 6a120665 | 6 | 3 | 0 | 10 | 10 |
| 6a120665 | 11 | 5 | 0 | 10 | 10 |
| cf2bf59a | 4 | 2 | 0 | 10 | 10 |
| f911e3dd | 11 | 5 | 0 | 10 | 10 |

- **Note:** Anchor loss clusters on exactly two reply types: (a) order-flow replies (ask-for-details / confirmation — turns 8/13 in 18129839, 16/30 in 1d001d46, 6/11 in 6a120665, 11 in f911e3dd) and (b) escalation fallbacks (3ea2ace9 t4, cf2bf59a t4, 18129839 t15). In both cases the retrieval context that anchored earlier product answers is dropped for the reply that closes the sale or escalates — consistent with EV-015 where the name-hallucination filter then no longer "sees" products the AI itself listed.

## EV-020 — Q4 quality-vs-depth buckets (AI-turn index within conversation)

- **When:** 2026-07-11
- **Query:** AI messages ranked per conversation (`ai_idx`), bucketed 1-3 / 4-6 / 7-10 / 11+; `alert_near` = alert with same `message_id` or |alert.created_at − msg.created_at| <= 120s in the same conversation.
- **Result (verbatim):**

| bucket | n_ai_turns | avg_quality | n_scored | flag_rate | alert_proximity_rate |
|--------|-----------|-------------|----------|-----------|----------------------|
| 1-3 | 96 | 0.839 | 88 | 0.000 | 0.240 |
| 4-6 | 39 | 0.793 | 35 | 0.026 | 0.205 |
| 7-10 | 16 | 0.719 | 14 | 0.000 | 0.125 |
| 11+ | 3 | 0.700 | 3 | 0.000 | 0.000 |

- **Note:** Monotonic quality decline with depth: 0.839 → 0.793 → 0.719 → 0.700. Caveat: deep turns include more 0.200-scored order confirmations (see EV-018), which drags late-bucket averages; alert proximity is *highest* in turns 1-3 (0.24) because most escalations end short conversations early (EV-014).

## EV-021 — Q5 window boundaries in conversations with > 10 messages

- **When:** 2026-07-11
- **Query:** for every AI turn in the 15 conversations with total > 10 messages: prior message count (`turn-1`), first customer turn, first product-anchored AI turn (`np>0`), and whether a raw last-10-messages window (turns `turn-10 .. turn-1`, cf. `AI_HISTORY_FETCH_LIMIT` shape) would exclude them.
- **Result (verbatim rows where the window excludes the first product-anchored AI answer — 15 of 92 AI turns):**

| conv | AI turn | prior_msgs | first_ai_product_turn | window excludes 1st product answer | window excludes 1st customer msg |
|------|---------|-----------|----------------------|-----------------------------------|----------------------------------|
| 18129839 | 13 | 12 | 2 | true | true |
| 18129839 | 15 | 14 | 2 | true | true |
| 1d001d46 | 14 | 13 | 3 | true | true |
| 1d001d46 | 16 | 15 | 3 | true | true |
| 1d001d46 | 18 | 17 | 3 | true | true |
| 1d001d46 | 21 | 20 | 3 | true | true |
| 1d001d46 | 23 | 22 | 3 | true | true |
| 1d001d46 | 25 | 24 | 3 | true | true |
| 1d001d46 | 28 | 27 | 3 | true | true |
| 1d001d46 | 30 | 29 | 3 | true | true |
| 6a120665 | 13 | 12 | 2 | true | true |
| 6a120665 | 15 | 14 | 2 | true | true |
| 6a120665 | 17 | 16 | 2 | true | true |
| f911e3dd | 13 | 12 | 2 | true | true |
| f911e3dd | 15 | 14 | 2 | true | true |

- **Note:** In every >10-message conversation the first customer message is turn 1, so any AI turn past turn 11 also loses the conversation opener. In 1d001d46, 8 of 13 AI replies were generated after the original product context (turn 3, "nitro tech ripped") had scrolled out of a raw-10 window; the conversation's second order (turns 19-30) proceeded on a completely different product, and the final off-topic customer messages ("Qysh o moti sot") got no reply.

## EV-022 — Q6 flagged-refeed (AI turns whose preceding 10 messages contain a flagged AI message)

- **When:** 2026-07-11
- **Query:** self-join of turn-numbered messages: AI turn `a`, flagged AI message `f` with `f.turn BETWEEN a.turn-10 AND a.turn-1`.
- **Result (verbatim):**

| conv | AI turn | flagged turns inside its 10-message window |
|------|---------|--------------------------------------------|
| 18129839 | 15 | {13} |

- **Note:** Only 1 case exists because only one message in the DB is flagged. It is real, though: the flagged 0.200-quality confirmation at turn 13 sat inside the context window of the AI's next reply (turn 15), which itself became the `uncertain_answer_escalated` fallback ("a keni ndonje produkt ne ofert be" → generic hold-off). Flagged content is re-fed to the model verbatim — there is no exclusion of flagged messages from history.

## EV-023 — Q7 alert turn positions (early/mid/late)

- **When:** 2026-07-11
- **Query:** `SELECT a.id, a.reason, a.conversation_id, (count of messages created before a.created_at)+1 AS fires_at_turn, total msgs, phase = position/total (<0.34 early, <0.67 mid, else late) FROM ai_alerts a`
- **Result (verbatim, 20 alerts):**

| alert | reason | conv | fires_at_turn / total | phase |
|-------|--------|------|----------------------|-------|
| 0d42204f | usage_question_unanswered | 12af2f76 | 16/15 | late |
| fb535f16 | usage_question_unanswered | b973ad04 | 4/4 | late |
| 3be07b56 | usage_question_unanswered | 7dd53b3e | 4/4 | late |
| a44f3bbc | usage_question_unanswered | 1f6a08de | 9/12 | mid |
| 653b73d0 | usage_question_unanswered | 56b9702c | 8/8 | late |
| eb105e34 | product_question_unanswered | 0eda9a0a | 2/2 | mid |
| 8dd2cc18 | product_question_unanswered | bbdb9d71 | 10/10 | late |
| 0b843cfe | product_question_unanswered | b8173c49 | 3/3 | mid |
| ef0f4442 | product_question_unanswered | 56a29a1a | 17/17 | late |
| 45247737 | product_question_unanswered | 509f4690 | 6/6 | late |
| ef3393c1 | hallucinated_product_name | fcd0af7e | 7/6 | late |
| d3db5dac | product_question_unanswered | 254a70cc | 9/9 | late |
| 1df15a06 | unclear | 18129839 | 14/15 | late |
| 10946774 | uncertain_answer_escalated | 18129839 | 16/15 | late |
| 9143cf34 | usage_question_unanswered | e328fc3b | 6/6 | late |
| e37cd2ce | hallucinated_price | 3ea2ace9 | 5/4 | late |
| 6e13dbe6 | hallucinated_price | cf2bf59a | 5/4 | late |
| dcf5c812 | product_question_unanswered | 28bec994 | 3/3 | mid |
| 1a42067e | product_image_unavailable | 1d001d46 | 6/32 | early |
| 96833d74 | product_image_unavailable | 1e71b190 | 5/12 | early |

- **Classification: 14 late, 4 mid, 2 early.** The only early alerts are the two `product_image_unavailable` ones — the only alert type after which the conversation demonstrably continued and even converted (1d001d46 went on to place two orders). Every other alert coincides with (and effectively causes) the end of the conversation. `fires_at_turn > total` means the alert fired after the last stored message (post-reply guard).

## EV-024 — Q8 burst proxy (consecutive customer messages < 12s apart)

- **When:** 2026-07-11
- **Query:** LAG over messages per conversation; pairs where `sent_by='customer' AND prev_sender='customer' AND gap_s < 12`.
- **Result (verbatim; 22 conversations have at least one burst pair):**

| conv | burst pairs | 2nd-message turn(s) |
|------|-------------|---------------------|
| 1d001d46 | 4 | 2, 13, 20, 27 |
| 56a29a1a | 3 | 2, 9, 10 |
| 2b375480 | 2 | 2, 10 |
| acfbb493 | 2 | 6, 9 |
| bbdb9d71 | 2 | 4, 9 |
| cdd0bdea | 2 | 14, 21 |
| 05e2354b, 18129839, 1e71b190, 1f6a08de, 254a70cc, 28bec994, 4c10fc71, 5138a806, 6a120665, 6da91488, 79a58aac, 8153c698, b8173c49, d218dd90, f412d3f4, f911e3dd | 1 each | (turns 8, 10, 6, 11, 8, 2, 2, 2, 8, 2, 2, 12, 2, 2, 12, 8) |

- **Note:** 30 burst pairs across 22/44 conversations (50%). Two dominant shapes: text + attachment sent together at conversation open (turn 2), and order-details text + attachment mid-flow. The burst-merge path in `processAIReply` is therefore exercised in half of all real conversations.

## EV-025 — Q9 Issue-1 proxy: near-identical customer messages across conversations with different AI outcomes

- **When:** 2026-07-11
- **Queries:**
  1. `SELECT extname FROM pg_extension` → `pg_trgm`, `pgcrypto`, `plpgsql`, `vector` (pg_trgm available; similarity() used).
  2. Pair query: customer messages (content >= 15 chars) joined across different conversations of the same tenant with `similarity(lower(trim(content)), …) > 0.75`; per message the outcome = first non-customer reply (sender, flagged, preview), `alert_2min` = alert in that conversation within 2 minutes after the message; outcome classes: `replied` / `fallback` (specialist canned text) / `alert` / `flagged` / `no_reply`.
- **Result:** 165 similar pairs total (avg similarity 0.889); 60 pairs have DIFFERENT outcomes. Representative verbatim divergent pairs:

| message (normalized) | conv A → outcome | conv B → outcome |
|----------------------|------------------|------------------|
| "Sa her ne dite muna me perdor?" (sim 1.00) | 12af2f76 → **replied** "Përdoret 1 herë në ditë…" | 56b9702c → **alert** (usage_question_unanswered) + specialist fallback |
| "sa her ne dit muna me perdor?" (0.88-0.90) | 1f6a08de → **replied** "Përdoret 1 herë në ditë…" | b973ad04 / 7dd53b3e → **alert** + specialist fallback |
| "Pershendetje, ku gjendeni me Lokacion?" (1.00) | 8153c698 → **replied** with address | 0eda9a0a → **alert** (product_question_unanswered) + specialist fallback |
| "Pershendetje a keni carbo one" (1.00) | 92cd366e / 5086ed7d / cebf6a66 → human "Po." (**replied**) | 3ea2ace9 / cf2bf59a → AI "Po." then **hallucinated_price alert**; 28bec994 → AI answered about the WRONG product (L-carnitine) + **product_question_unanswered alert** |
| "Pershendetje a e keni kete produkt ne dispozicion" (0.86-1.00) | 0a4cde32 / 88283c5e → **no_reply at all** (ai_paused=t, 1-message conversations) | bbdb9d71 / b8173c49 → specialist fallback + **alert** |
| "a keni tjera a veq qito" (1.00) | 461901a6 → **replied** with product list | fcd0af7e → same reply shape but ended in **hallucinated_product_name alert** two turns later |
| "Tjera a keni a veq qita" (0.83) | f911e3dd → **replied** (partial-answer substitute) | 509f4690 → **alert** (product_question_unanswered) after inventing "Optimum Nutrition Gold Standard" |
| "Sa kushtojn kto?" (0.82-1.00) | f412d3f4 t7 → **replied** with correct prices | f412d3f4 t3 (earlier, same wording!) → "no price info"; 0a2b2999 → "products not in catalog"; e328fc3b → human price list + usage alert later |
| "a muna me porosit" (0.77-1.00) | cdd0bdea / 05e2354b / 6a120665 → **replied**, order completed | 18129839 → same order flow but conversation later flagged + 2 alerts |
| "Pershendetje, a keni ndonje produkt … per shtim peshe" (0.80-0.86) | 05e2354b / af548526 / 12af2f76 / 29238c0d / 306e56fe / 18129839 → **replied** (with 4 different product recommendations across conversations) | 7dd53b3e / b973ad04 → **alert** on the immediate follow-up usage question |

- **Note:** The same customer utterance is a coin-flip between a confident answer and an escalation. The "sa her ne dit muna me perdor" case is the cleanest: identical question, same product (Mass Gainer Pro), answered factually on 05-30 21:05 (12af2f76) and 22:03 (1f6a08de) but escalated with alerts at 21:46 (b973ad04) and 21:54 (7dd53b3e) — *between* the two successful answers, ruling out a config change as the sole cause. Also notable: identical "products for weight gain" openers received four different recommendation sets (Mass Gainer Pro — absent from EV-013's audit-time `deleted_at IS NULL` sweep but verified as a live catalog row until its 2026-06-02 soft-delete, i.e. real at the time of these 05-30 conversations; Mass gainer 3kg Qokolad; Applied Nutrition Whey; "Po." with no list), and "Sa kushtojn kto?" produced correct prices, "no access to prices", and "those products aren't in our catalog" in three conversations — retrieval nondeterminism visible end-to-end.

---
*(EV-016 – EV-025 appended 2026-07-11 by Phase 4 SQL harvest; per-conversation timeline JSONs for the 25 multi-turn + 7 alert-only conversations are in the session scratchpad `audit/timelines/<conversation_id>.json`)*

## EV-026 — Live prompt-block catalog dump (Phase 7)

- **When:** 2026-07-11
- **Query:** `SELECT key, title, category, sort_order, is_platform_locked, is_active, default_content FROM prompt_blocks ORDER BY sort_order;`
- **Result (verbatim; 13 rows — `default_content` in full):**

| key | title | category | sort | locked | active |
|-----|-------|----------|------|--------|--------|
| guidelines.language | Language lock | guidelines | 10 | t | t |
| guidelines.messaging_style | Messaging style | guidelines | 20 | f | t |
| guidelines.catalog_integrity | Catalog and business facts | guidelines | 30 | t | t |
| guidelines.price_currency_visibility | Price, currency, stock mentions | guidelines | 40 | t | t |
| guidelines.category_product_aggregation | Category & multi-product aggregation | guidelines | 45 | t | t |
| guidelines.offers_promotions | Offers & promotions | guidelines | 48 | f | **f** |
| guidelines.discount_policy | Discount handling | guidelines | 50 | f | t |
| guidelines.product_usage_verbatim | Product usage instructions | guidelines | 60 | f | t |
| guidelines.follow_up_and_closing | Follow-up and closing discipline | guidelines | 70 | f | t |
| guidelines.product_description_responses | Product description length | guidelines | 75 | f | **f** |
| guidelines.recommendations | Recommendations and product naming | guidelines | 80 | f | t |
| guidelines.order_flow_and_escalation | Orders, delivery data, confirmations | guidelines | 90 | t | t |
| guidelines.vision_product_images | Customer product images | vision | 100 | f | t |

Full `default_content` (verbatim, `\r\n` line breaks preserved as line breaks):

**guidelines.language (locked):**
> - LANGUAGE LOCK (very important): the customer's current language is {{LANGUAGE_NAME}}. Reply ONLY in {{LANGUAGE_NAME}}. Do NOT include any {{OTHER_LANGUAGE_NAME}} words, sentences, or phrases. Never mix the two languages in the same reply — keep the entire message in {{LANGUAGE_NAME}} from greeting to closing.
> - If an OPERATOR BUSINESS RULE, PLATFORM POLICY rule, Q&A pair, or any other instruction is written in {{OTHER_LANGUAGE_NAME}} (or specifies a fixed sentence in {{OTHER_LANGUAGE_NAME}}), apply the rule's intent in {{LANGUAGE_NAME}}. When the rule pins an exact sentence to send, translate it cleanly into {{LANGUAGE_NAME}} while preserving the meaning, tone, and any product/value placeholders. Never echo a fixed sentence in a language other than {{LANGUAGE_NAME}} in the customer-facing reply.

**guidelines.messaging_style:**
> - Brevity (HIGHEST PRIORITY): give the SHORTEST reply that fully and correctly answers the customer's current message. Lead with the direct answer. A one-word or single-line answer is correct and preferred whenever it fully answers — it does not need to be a complete sentence.
> - Concrete examples of the expected length:
>   - "Do you have this product?" -> "Yes."
>   - "Do you have this brand?" -> "Yes."
>   - "What is the price?" -> "€25"
> - Do NOT restate the product or brand name the customer just referenced, and do NOT add filler such as "we have it available in our catalog".
> - Never repeat or rephrase the customer's question, and never restate information the customer already gave you.
> - No opening pleasantries or filler ("Of course!", "Sure", "Thanks for reaching out", "I'd be happy to help") — start with the answer.
> - Stay warm, natural, and polite — concise, not cold or robotic. This is a messaging app, not email: scannable beats wordy. Keep the words needed for the answer to be clear and grammatical; cut everything that adds no information.
> - Give a longer answer only when the question genuinely requires it or another guideline requires fixed/verbatim wording (usage instructions, discount phrases, order-confirmation footer, unavailable-product alternatives, multi-attribute aggregation, recommendations). Even then, add only what is necessary — no padding or redundancy.
> - Do not use markdown formatting — reply in plain text suitable for a messaging app.

**guidelines.catalog_integrity (locked):**
> - If the customer asks about a product you don't have, say so honestly.
> - When the requested product is unavailable or not an exact match, clearly say that exact product is not available, then immediately suggest up to 2-3 similar alternatives from the same category in the catalog where available (never more than three).
> - For unavailable-product cases, keep the sequence: (1) a brief unavailable acknowledgement, then (2) up to 2-3 relevant alternatives from the same category where available — end the reply right after the alternatives with no follow-up question.
> - EXCEPTION for comparisons and recommendations: when the customer asked to compare prices or for a recommendation among several products and one of those products is unavailable, keep that product in the comparison with its price and briefly note it is currently unavailable — do NOT replace the whole reply with alternatives.
> - Never fabricate product details, prices, or availability.
> - CATALOG GROUNDING (critical): only name or recommend specific products that appear in the Product catalog section of this prompt. Never name, suggest, or reference a product by a specific name that is not listed there — not even if you believe the store might carry it. If the customer asks about more options and none are listed, say you have shown all available options and invite them to ask about something specific.
> - For business location, physical address, pickup point, hours, or general "about the business" questions: use only the Business profile section when it is present above. If it does not contain the answer, do not invent one — offer to have a team member help.
> - If a question is outside your scope, politely let the customer know a human agent can help.

**guidelines.price_currency_visibility (locked):**
> - Strict rule: never mention product price or stock availability unless the customer explicitly asks for price/stock in their current message.
> - Currency rule: whenever you mention any product price amount, use the Euro symbol (€), never the dollar sign ($).
> - Price visibility for THIS reply: if the customer's current message explicitly asks for price or cost, you may include pricing only if it matches the catalog exactly. If the customer's current message does not explicitly ask for price or cost, do not mention any product price.
> - Never volunteer stock or availability in normal replies.
> - Treat "Stock status" in the catalog as internal information. Mention availability only when the customer explicitly asks about stock/availability in their current message — with ONE exception: in a price comparison or recommendation the customer asked for, if one of the listed products is out of stock you may briefly note it is currently unavailable while still including it (with its price) in the comparison.

**guidelines.category_product_aggregation (locked):**
> - When multiple products match the customer's query (same category, ingredient, type, or product group), treat the question as being about the GROUP — not a single SKU.
> - For attribute questions (flavors, sizes, colors, variants, brands, weights, packaging, ingredients, specs, usage differences): aggregate information across ALL matching products shown in the catalog context and any aggregated attribute summary.
> - List every distinct attribute value found across the group and which product(s) have each value.
> - Keep it compact: list the values directly with no intro line, no restating the question, and no closing summary; group products that share a value instead of repeating it.
> - Never answer using only one product when multiple relevant products exist unless the customer explicitly chose one specific product.
> - When recommending from a group, you may still suggest 1-2 options — but attribute answers (e.g. available flavors) must cover the full matching set.
> - If a matching product exists in the catalog but a specific attribute or technical detail is not available in the catalog data, say what is known and what is not — do NOT guess the missing detail; if critical information is genuinely absent from the catalog, note that you do not have that specific detail available.
> - If the product the customer is asking about does not exist in our catalog at all, do NOT say a specialist will follow up — instead, clearly tell the customer that product is not available, then immediately suggest 1-2 relevant alternatives from the catalog if any exist.

**guidelines.offers_promotions (catalog-INACTIVE, no migration — admin-created orphan):**
> - The "Active offers and promotions" section above is the ONLY source of truth about offers, promotions, bundles, BOGO, and deals. Never invent, assume, or guess an offer, a discount, or its terms.
> - Only describe an offer as available if its line is marked Status: ACTIVE. If it is SCHEDULED, tell the customer the date it starts. If it is EXPIRED, tell the customer it has already ended and do not present it as available.
> - When asked which products are included in an offer, list only the products shown for that offer. For Buy X Get Y or BOGO, clearly separate the product(s) the customer must buy from the free or discounted reward product.
> - For "what is the discounted price", use the discounted price shown for the offer. When the price depends on quantity (BOGO / Buy X Get Y), state the rule instead of inventing a single number (e.g. "buy 1 and the 2nd is free").
> - For "can I combine this with another offer", answer from the offer's Combinable flag and its stated conditions. If it is not combinable, say only one offer can be applied at a time.
> - If the section shows no offers, tell the customer there are no active offers right now — do not fabricate one.
> - When a customer asks whether a specific product is on offer, answer using the offers that list that product. If none list it, say that product is not part of any current offer.
> - Never claim a discount that is not backed by an offer line shown above or by a product's configured discounted price.

**guidelines.discount_policy:**
> - Discount handling rules:
>   1) If the customer asks for a discount/lower price/promotion/offer, look up the matched product in the catalog above and check the "Discounted price" line.
>   2) If a "Discounted price" value is configured for that product, offer it explicitly using the EXACT amount from the catalog. Reply with one short sentence such as: "{{DISCOUNT_OFFER_EXAMPLE}}". Do not invent or round the value.
>   3) The configured "Discounted price" is the MAXIMUM available discount. Never propose a value lower than the catalog discounted price, and never offer multiple progressively smaller prices.
>   4) If the customer keeps insisting on a further/extra discount AFTER you have already offered the catalog discounted price (or after a previous assistant message in this conversation has already addressed the discount), reply that no additional discount can be applied. {{DISCOUNT_RULE_NO_FURTHER}}
>   5) If the matched product has NO discounted price configured (the catalog shows "Discounted price: not configured" or no Discounted price line), inform the customer that no discount is available and that the current price is final. {{DISCOUNT_RULE_NONE_AVAILABLE}} (you may include the regular catalog price if helpful).
>   6) Never reveal a discounted price unless the customer is asking for a discount. Do not volunteer discount info in normal product replies.
>   7) Never invent, estimate, or negotiate a discount value that is not explicitly listed as "Discounted price" in the catalog above.
> - Discount context for THIS message: if the customer is asking for a discount in their current message, apply the discount handling rules above strictly. If the customer is not asking for a discount in their current message, do not bring up discounts unsolicited.
> - Conversation context: if a previous assistant reply in this conversation already addressed the discount question (offered the discounted price or stated none is available), and the customer keeps insisting on a further discount, follow rule (4): no additional discount can be applied. If no prior assistant reply has addressed a discount yet in this conversation, use rules (1)-(3) as appropriate.

**guidelines.product_usage_verbatim:**
> - When a customer asks how to use a product, how to take it, dosage, application instructions, or anything related to product usage: locate the usage description for that product in the catalog above. Extract and return ONLY the specific sentence(s) or portion(s) that directly answer the customer''s exact question — do not return the entire usage description when only part of it is relevant. Reproduce the extracted portion word for word exactly as it appears; do not rephrase or reword it. Do not add, assume, infer, or include any information that is not explicitly present in the usage description. Do not draw on your own general knowledge to supplement or expand the answer.
> - If the customer''s question is about personal suitability, safety, or compatibility in specific circumstances (e.g. "I don''t work out, can I use this?", "Is this suitable for me?", "I''m pregnant, is this ok?", "Can I use this without exercising?", "Any problem if I don''t exercise?") and the usage description does NOT explicitly address that specific circumstance: do NOT generate health advice, medical recommendations, or guidance from your general training knowledge. Do not speculate. Simply say you do not have that specific information available. A specialist will provide accurate guidance.

**guidelines.follow_up_and_closing:**
> - STRICT FOLLOW-UP / CLOSING POLICY (very important): only include a follow-up question, invitation, or closing prompt in ONE case:
>   (a) When you are confirming that an order has been placed/confirmed, end with the exact order-confirmation follow-up sentence specified later in these rules.
> - In ALL OTHER CASES — including product recommendations, product explanations, product comparisons, price answers, stock answers, unavailable-product replies, post-recommendation messages, ambiguous short answers, and general chat — DO NOT include ANY follow-up question, order-closing question, invitation, "let me know" prompt, or any closing prompt. End the reply naturally right after delivering the requested information.
> - Forbidden trailing patterns (in any language; not exhaustive): "A doni ta porosisni?", "Doni ta porosisni?", "Would you like to order it?", "Do you want to order?", "më tregoni", "më shkruani", "më kontaktoni", "doni më shumë informacion", "nëse dëshironi detaje më tregoni", "nëse dëshironi të porosisni më tregoni", "let me know", "feel free to ask", "anything else", "if you want more info just ask", or any equivalent. Do not produce them.
> - Do not ask any order-closing question in any product, recommendation, explanation, comparison, price, stock, or unavailable-product reply — not even on the first product turn.
> - If the latest customer messages repeat or paraphrase the same question, combine them and answer once without repeating the same information.
> - Do not wrap product names in quotation marks when answering normally. Mention product names naturally in the sentence, or use a generic reference like "produkti" when the exact name is unnecessary.
> - Avoid robotic closings like "anything else I can help with?" — they violate the strict follow-up policy above.
> - For non-product/general chat, end naturally without forcing a question.

**guidelines.product_description_responses (catalog-INACTIVE, retired by migration 056):**
> - NEVER send the full product description text to the customer, even when a longer description appears in the catalog context above.
> - For recommendations or general product talk: at most 1-2 short lines per product with key benefits or selling points from the catalog — do not copy long catalog text.
> - When the customer asks about product details: read the catalog internally, then reply with ONLY the information that answers their question; if they need a broader overview, write a 1-2 line summary of the most important points — never paste the full description verbatim.

**guidelines.recommendations:**
> - NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
> - For recommendations, comparisons, or product suggestions: suggest up to 2-3 products from the catalog where available (never more than three) and list ONLY the product name(s) — one per line, with no description, benefits, or details after each name. Provide a short description only when the customer explicitly follows up about a specific product (e.g. "tell me more about X", "what does it do?").
> - PRICE COMPARISON EXCEPTION: when the customer asks which product is cheapest, most expensive, or to compare prices, include the price next to each product name (one per line, in the format "Product Name: €X") and state directly which is the cheapest/most expensive — do not add descriptions beyond the price.
> - When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
> - For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add any follow-up question, order-closing question, invitation, "let me know" prompt, or any closing prompt.
> - In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
> - In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.

**guidelines.order_flow_and_escalation (locked):**
> - If the message is detected as an end-of-conversation signal by the closing-intent classifier, respond with exactly one short polite closing sentence in the customer language.
> - For classifier-detected closing replies, do not ask follow-up questions and do not introduce new topics.
> - When collecting delivery details for an order, ask ONLY for: (1) customer first name, (2) contact phone number, and (3) full delivery address. Do not ask for last name, ID number, birthday, email, or any other personal data unless the business explicitly requires it elsewhere.
> - If the customer's message already contains a clear order intent — including statements ("I want to order", "Dua ta porosis", affirming a product) AND question-form expressions ("Can I order this?", "Can I order this product?", "How do I order?", "A mund ta porosis?", "A mund ta porosit?", "A mund ta blej?") — do NOT ask an order-closing question such as "A doni ta porosisni?" or "Would you like to order?" — proceed directly to asking for any missing delivery details.
> - After you have collected the first name, phone number, and delivery address, do NOT confirm the order yet. Instead send this exact data-verification message to the customer: {{DATA_CONFIRMATION_SENTENCE}}. Only after the customer confirms that their details are correct should you treat the order as confirmed.
> {{ORDER_CONFIRMATION_CLOSING_RULE}}
> {{DELIVERY_ETA_NOTE}}
> - For ambiguous short customer replies (e.g., "po", "ok", "yes", "po ju lutem"), rely on conversation context and classifier signals to decide intent. Do not classify based only on keywords. If classifier/context indicates order affirmation, continue order flow; escalate only when classifier/context indicates a real post-purchase issue.
> - Draft/confirm order behavior must be triggered only when classifier + conversation context indicate explicit order affirmation. Product inquiries alone (price, stock, details, comparison, availability) are not order confirmation. Note: "Can I order this?" and "A mund ta porosis?" are ORDER intent expressions, not availability questions — treat them as order intent.
> - If the assistant has already asked to proceed with an order (or requested delivery details), and the customer then provides ALL required details (first name, phone number, and full delivery address), send the data-verification message above before confirming the order.
> - Never treat an order as complete/ready for creation unless ALL required delivery details are present: customer first name, a contact phone number, and a full delivery/shipping address. If any detail is missing, ask specifically for the missing detail and do not confirm order placement yet.
> {{POST_PURCHASE_ESCALATION_RULE}}

**guidelines.vision_product_images (vision category — only injected on image turns):**
> When a customer sends an image of a product, you must follow this exact process in order:
> Step 1 - Identify the product in the image as specifically as possible. Extract: the brand name, product name, flavor or variant, size or weight, and any other distinguishing details visible on the packaging.
> Step 2 - Search the provided product catalog for an exact or near-exact match. A match is only valid if the brand name AND product type match. A different brand of the same product type is NOT a match.
> Step 3 - Apply one of these three responses only:
> Response A - Exact match found: You have that exact product or a version of it from the same brand. Confirm availability with details from your catalog.
> Response B - Similar product, different brand: You have a similar product but a different brand. Be honest - say you do not carry that exact brand but offer your alternative. Example: "We do not carry [Brand X], but we do have [Your Brand], a similar mass gainer."
> Response C - No match at all: You do not have anything similar. Tell the customer honestly and ask if they are looking for something specific you might be able to help with.
> Never confirm you have a product just because the product category matches. Brand accuracy matters.
> Competitor brands: you may name a competitor brand ONLY to honestly state you do not carry it (as in Response B). Never proactively bring up, recommend, praise, or compare to a competitor's brands, products, or prices.
> Use the steps above for your own reasoning only. In the customer-facing message, give a short, clean answer — do not narrate the steps or produce a long structured report.

## EV-027 — Per-tenant prompt-block variance (Phase 7)

- **When:** 2026-07-11
- **Query:** `SELECT block_key, count(DISTINCT content) AS variants, count(*) FILTER (WHERE enabled) AS enabled_count, count(*) AS tenants FROM tenant_prompt_blocks GROUP BY block_key ORDER BY block_key;`
- **Result (verbatim):**

| block_key | variants | enabled_count | tenants |
|-----------|----------|---------------|---------|
| guidelines.catalog_integrity | 1 | 6 | 6 |
| guidelines.category_product_aggregation | 1 | 6 | 6 |
| guidelines.discount_policy | 1 | 6 | 6 |
| guidelines.follow_up_and_closing | 1 | 6 | 6 |
| guidelines.language | 1 | 6 | 6 |
| guidelines.messaging_style | 1 | 6 | 6 |
| guidelines.offers_promotions | 1 | **6** | 6 |
| guidelines.order_flow_and_escalation | 1 | 6 | 6 |
| guidelines.price_currency_visibility | 1 | 6 | 6 |
| guidelines.product_description_responses | 1 | **0** | 6 |
| guidelines.product_usage_verbatim | 1 | 6 | 6 |
| guidelines.recommendations | 1 | 6 | 6 |
| guidelines.vision_product_images | 1 | 6 | 6 |

- **Note:** `variants = 1` on every key — zero tenant customization exists in production. The retired `product_description_responses` is correctly disabled for all 6 tenants (migration 056's manual disable), while the catalog-inactive orphan `offers_promotions` remains **enabled 6/6** — confirming there is no code path that disables tenant rows on catalog deactivation.

## EV-028 — ai_configs personality/restriction field usage (Phase 7)

- **When:** 2026-07-11
- **Query:** `SELECT tone IS NOT NULL AS has_tone, personality_description IS NOT NULL AS has_persona, restrictions IS NOT NULL AS has_restrictions, qa_pairs IS NOT NULL AND qa_pairs::text <> '[]' AS has_qa, custom_model_id FROM ai_configs;`
- **Result (verbatim, 6 rows):**

| has_tone | has_persona | has_restrictions | has_qa | custom_model_id |
|----------|-------------|------------------|--------|-----------------|
| t | f | t | f | null |
| t | f | t | f | null |
| t | f | t | f | null |
| t | f | t | f | null |
| t | f | t | f | null |
| t | f | t | t | null |

- **Note:** All 6 tenants have a tone; none has a personality description, sales strategy persona, or fine-tuned `custom_model_id`; exactly 1 tenant has Q&A pairs. `has_restrictions` is `t` for all rows only because the column is NOT NULL — see EV-029 for actual contents.

## EV-029 — Operator restrictions contents and distribution (Phase 7)

- **When:** 2026-07-11
- **Query 1:** `SELECT DISTINCT jsonb_pretty(restrictions) AS restrictions, jsonb_pretty(platform_restrictions) AS platform_restrictions FROM ai_configs;`
- **Result 1:** exactly **2 distinct variants**: (a) `restrictions = []`, `platform_restrictions = []`; (b) a 17-element Albanian rule array with `platform_restrictions = []`. Variant (b) is, rule for rule, an Albanian translation of the 17 rules in repo-root `business.md` (off-topic → `[NO_REPLY]`; catalog-only info; no invention; price-only-when-asked + comparison format "Emri i produktit: €X"; no stock mentions; unavailable → say so; no competitor brands (Albanian text says "një alternativë" — ONE alternative — where business.md says 1–2); short replies; no markdown; no unconfirmed promises; closing-signal handling; draft-order-only-on-confirmation; unavailable → 1-2 alternatives + comparison exception; post-purchase apology; usage/dosage escalation; price-comparison direct answer "Mos shkakto alarme ose njoftime specialiste për këto pyetje" (do not trigger specialist alerts); recommendation direct answer, same no-alert clause).
- **Query 2:** `SELECT count(*) AS tenants_total, count(*) FILTER (WHERE jsonb_array_length(restrictions) > 0) AS with_restrictions, count(*) FILTER (WHERE jsonb_array_length(restrictions) = 17) AS with_17_rules, count(*) FILTER (WHERE jsonb_array_length(platform_restrictions) > 0) AS with_platform_restrictions FROM ai_configs;`
- **Result 2 (verbatim):**

| tenants_total | with_restrictions | with_17_rules | with_platform_restrictions |
|---------------|-------------------|---------------|----------------------------|
| 6 | 1 | 1 | 0 |

- **Note:** The `business.md` operator rulebook reaches the model as the "OPERATOR BUSINESS RULES" footer (`aiService.ts:2306-2328`, appended last at 4086-4092) for **exactly 1 of 6 tenants**. Five tenants run with an empty restrictions footer — none of the 17 business rules is in their prompt except where a guideline block independently encodes it. `platform_restrictions` is `[]` for all 6 tenants: the "PLATFORM POLICY — follow strictly:" footer has never rendered in production.

---
*(EV-026 – EV-029 appended 2026-07-11 by Phase 7 business-rules/prompt tri-diff)*

## EV-030 — Albanian language profile of dev customer traffic (Phase 8)

- **When:** 2026-07-12
- **Query:** `SELECT LEFT(content,160), conversation_id FROM messages WHERE sent_by='customer' AND content IS NOT NULL AND length(trim(content)) > 0 ORDER BY created_at DESC LIMIT 40`
- **Result (40 most recent customer messages, verbatim sample):**

| content | conversation |
|---|---|
| "A munesh me ma qu foto be" | d1d12b10 |
| "pershendetje a keni nitro tech ripped" (×3, retries) | d1d12b10 |
| "Sa kushton kjo shef" | 1e71b190 |
| "Aha okej a muni me ma qu foto be se ju ka tek djalit tem me porosit ni qisi e spe di a osht e qasi qe pe don" | 1e71b190 |
| "O shef qa bone" | 1e71b190 |
| "Qysh o moti sot" | 1d001d46 |
| "Adem, 045 687 266, Bregu i diellit banesat e bardha blloku 35" | 1d001d46 |
| "Okej qita pe porositi pra shef" | 1d001d46 |
| "Cila o ma e lira be se le qe jom cpirr po edhe fikan hahahahahah" | 1d001d46 |
| "Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr" | 1d001d46 |
| "Aha okej a muna shef me porosit qita me shije mjedre" | 1d001d46 |
| "A keni naj kreatin" | 1d001d46 |
| "Me qfar shije i keni edhe sa kushtojn" (×4 conversations) | 28bec994, cf2bf59a, 92cd366e, 3ea2ace9 |
| "Pershendetje a keni carbo one" (×4) / "Pershendefje a keni carbo one" (typo, ×2) | ditto + 5086ed7d, cebf6a66 |
| "Pershendetje a keni whey protein edhe me qfar shije" | 98571d00 |
| "Qfar shije i kan edhe sa kushtojn" | 6a120665 |

- **Language-feature classification of the 40-message sample:** 39/40 Albanian, 0 English, ~1 ambiguous ("Po"). **Zero messages carry Albanian diacritics (ë/ç)** — 100% bare-Latin spelling. Gheg/Kosovo dialect markers pervasive: interrogative particle "a" + verb ("a keni", "a muna", "a munesh", "a muni"), Gheg comparative "ma" for standard "më" ("ma e lira", "ma qu"), deictics "qita/qito/qikjo/kto" for standard "këto/kjo", "veq" (= "vetëm"), "qysh" (= "si"), "osht/o" (= "është"), "naj" (= "ndonjë"), "tmir" (= "të mirë"), vocatives/slang "be", "shef", "qr", clipped forms "sun" (s'mund), "spe di", "pe don", "jom" (jam), "flm". Verb endings clipped: "kushtojn" (kushtojnë), "kan" (kanë). "qfar" for standard "çfarë/cfare". Product/brand names typed lowercase and sometimes misspelled ("carbo one", "Pershendefje", EV-010's "optium nutrition gold standart"). Mixed AL/EN limited to product names ("whey protein", "nitro tech ripped", "mass gainer") — brand vocabulary is English inside Albanian sentences.

## EV-031 — Product catalog field language (Phase 8)

- **When:** 2026-07-12
- **Query:** `SELECT name, category, flavor, tags FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 30`
- **Result (condensed):** names are English brand/product strings with Albanian attribute suffixes in nonstandard spelling — "Nitro Tech Ripped", "Carbo One 1kg Orange" vs sibling "Carbo one 1kg Limon" (inconsistent casing), "Whey protein 700gr Shije Dredhze", "Vegan Protei 600gr Qokolad Karamel" (truncated "Protei"; "Qokolad" = nonstandard for "çokollatë"), "Protein 80 700gr Dubai qokolad", "Energizer pre-workout 35 Servime shije shalqini", "X-Mass 3kg Qokolad - Copy - Copy" (UI-duplicate artifact row). Categories are Albanian: "Proteina", "Shtim peshe", "Humbje peshe, Pre Workout" (comma-packed multi-category in one varchar), "Multivitamina & Minerale", "Aminoacide", "Kollagjen", "Tjera (others)". `flavor` is NULL on 29/30 rows (flavor lives inside `name` as free text, e.g. "shije Dredhze"); `tags` is `[]` on 30/30 rows.
- **Note:** The structured-attribute machinery (flavor/size/color/variant/weight columns, attribute-availability classifier, `buildProductText` "flavor X" segments) has almost no data to work with — flavor/tag signal exists only as diacritic-free Albanian embedded in `name`. Keyword ILIKE against `name` is therefore the de-facto flavor search path, and it is spelling-exact.

## EV-032 — Misspelled-brand retrieval: no fuzzy matching despite pg_trgm (Phase 8)

- **When:** 2026-07-12
- **Query:** `SELECT name, brand FROM products WHERE name ILIKE '%gold standard%' OR name ILIKE '%optimum%' OR brand ILIKE '%optimum%'`
- **Result:** 17 rows exist for the EV-010 "optium nutrition gold standart" question — "GOLD STANDARD", "Protein Gold Standard" (×2), "Gold standard whey 2.2kg/900gr …" (×8), "Optimum Nutrition creatine/Creatine 247gr …" (×4), "ON Gold standard BCAA 266gr shije dredhze" (×2). `brand` is NULL on every row — brand lives in `name`. **Correction (verifier, 2026-07-12):** the query above lacks `deleted_at IS NULL`; only **7 of the 17 rows are live** (10 are soft-deleted duplicates), and retrieval (`product.ts:517`) filters to live+active rows. The live 7 still carry the prices/flavors the customer asked about, so the finding stands with the corrected count.
- **Code cross-check:** `grep -rn "similarity(" backend/src` → **0 matches**. The pg_trgm GIN indexes from migration `044_add_trigram_search_indexes.sql` only accelerate `ILIKE` substring matching (`product.ts:510-536` and companions); no query uses trigram `similarity()`/`%` fuzzy matching. A customer misspelling ("optium" for "Optimum", "standart" for "standard") therefore produces zero lexical hits on the misspelled token; only exact-substring fragments ("gold") can still hit.
- **Note:** EV-025 itself used `similarity()` — the extension is installed and functional in this database; the application simply never calls it.

---
*(EV-030 – EV-032 appended 2026-07-12 by Phase 8 Albanian language audit)*

## EV-033 — products.embedding actual dimension (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query:** `SELECT a.atttypmod, format_type(a.atttypid,a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname='products' AND a.attname='embedding';`
- **Result (verbatim):** `atttypmod = 1536`, `type = vector(1536)`
- **Cross-check:** `SELECT vector_dims(embedding), count(*) FROM products WHERE embedding IS NOT NULL GROUP BY 1` → single group `dims=1536, count=614` (across all 617 rows incl. soft-deleted). No dimension-variant survivors.
- **Verdict:** CONFIRMED — column is `vector(1536)`; every stored vector is 1536-dim.

## EV-034 — HNSW index definitions: global + partial (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query:** `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('products','product_image_fingerprints') AND indexdef ILIKE '%hnsw%';`
- **Result (verbatim):**
  - `idx_products_embedding` = `CREATE INDEX idx_products_embedding ON public.products USING hnsw (embedding vector_cosine_ops) WHERE ((embedding IS NOT NULL) AND (deleted_at IS NULL))`
  - `idx_pif_embedding_hnsw` = `CREATE INDEX idx_pif_embedding_hnsw ON public.product_image_fingerprints USING hnsw (embedding vector_cosine_ops) WHERE (embedding IS NOT NULL)`
- **Verdict:** CONFIRMED — both HNSW, `vector_cosine_ops`, partial (`WHERE embedding IS NOT NULL`; products also `AND deleted_at IS NULL`). **Neither index includes `tenant_id`** — the ANN index is global across all tenants. Tenant scoping is applied only as a post/co-filter in the SQL predicate, not in the index. On a large multi-tenant corpus HNSW traversal explores other tenants' vectors before the `tenant_id` filter is applied (recall/perf risk at scale; correctness still holds because the `WHERE tenant_id=$` filters results).

## EV-035 — embedding_model distribution: 3-small wrote the vectors, not 3-large (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query:** `SELECT embedding_model, count(*), count(*) FILTER (WHERE embedding IS NULL) FROM products WHERE deleted_at IS NULL GROUP BY embedding_model;`
- **Result (verbatim):** single row — `embedding_model = text-embedding-3-small`, `total = 258`, `null_embeddings = 0`.
- **product_image_fingerprints** same query: `text-embedding-3-small`, total 1, 0 null, dims 1536.
- **Verdict:** SURPRISE / REFUTES the documented default. CLAUDE.md §10 states `OPENAI_EMBEDDING_MODEL` default is `text-embedding-3-large`. Every live product vector in the dev DB was actually written by **`text-embedding-3-small`** (native 1536-dim, which is why the `vector(1536)` column fits with no truncation). Zero rows carry a `3-large` tag; zero null embeddings; zero dimension mismatches. Prior retrieval-quality analysis should assume 3-small embeddings. A future switch to 3-large (3072-dim native) would require dimension-reduction params or a column/index migration — a silent mismatch risk if the env var changes without re-embedding.

## EV-036 — Installed extensions: pg_trgm present, similarity() available but unused (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query:** `SELECT extname, extversion FROM pg_extension ORDER BY extname;`
- **Result (verbatim):** `pg_trgm 1.6`, `pgcrypto 1.4`, `plpgsql 1.0`, `vector 0.8.2`.
- **Cross-check:** `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='products' AND (gin/trgm)` → six GIN indexes: `idx_products_name_trgm`, `_brand_trgm`, `_description_trgm`, `_category_trgm`, `_tags_text_trgm` (all `gin_trgm_ops`), plus `idx_products_tags` (jsonb gin).
- **Verdict:** CONFIRMS EV-032. `pg_trgm` (with `similarity()` and `%` operator) is installed and functional, and five trigram GIN indexes exist — yet application code calls `similarity()` **0 times** (`grep -rn "similarity(" backend/src` = 0). These GIN indexes only accelerate `ILIKE` substring scans; the typo-tolerant capability they enable is dormant. `pgvector` is `0.8.2` (HNSW supported).

## EV-037 — Migration tracking: duplicate 062–065 numbers, applied out of numeric order (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query:** `SELECT column_name FROM information_schema.columns WHERE table_name='_migrations'` then `SELECT * FROM _migrations ORDER BY id DESC LIMIT 25;`
- **Tracking table:** `_migrations (id int, name varchar, run_at timestamptz)` — keyed by **filename `name`**, not by numeric prefix. The runner applies any file whose `name` is not yet present; two files sharing a numeric prefix but differing in suffix are treated as distinct and both applied.
- **Result (verbatim, both requested 062 files):**
  - `id=65, name=062_message_product_context.sql, run_at=2026-06-20T16:16:37.745Z`
  - `id=66, name=062_compact_edge_case_guidelines.sql, run_at=2026-06-22T16:18:14.749Z`
  - Both **062 files applied.** Recorded order: `062_message_product_context` first (06-20), `062_compact_edge_case_guidelines` second (06-22).
- **Broader collision (SURPRISE):** the same duplication spans **062, 063, 064, 065** — two parallel numbering series (an "offers" branch and a "guidelines/grounding" branch) collided:

  | id | name | run_at |
  |----|------|--------|
  | 65 | 062_message_product_context.sql | 06-20 |
  | 66 | 062_compact_edge_case_guidelines.sql | 06-22 |
  | 67 | 063_create_offers.sql | 06-22 |
  | 68 | 064_add_offer_columns_to_orders.sql | 06-22 |
  | 69 | 065_offers_promotions_prompt_block.sql | 06-22 |
  | 70 | 063_catalog_grounding_guardrails.sql | 06-23 |
  | 71 | 064_reconcile_recommendations_names_only.sql | 06-23 |
  | 72 | 065_align_guidelines_with_business_rules.sql | 06-23 |
  | 73 | 066_increase_recommendation_limit_to_3.sql | 06-24 |
  | 74 | 067_remove_product_reply_follow_up.sql | 06-24 |
- **Verdict:** Execution order does **not** match numeric order — `065_offers_promotions` (id 69) ran a full day **before** `063_catalog_grounding_guardrails` (id 70). Because tracking is by filename, no migration was skipped or double-run, but the numeric prefix is no longer a reliable ordering key. Any future migration authored assuming "063 runs before 065" is unsafe; DDL depending on ordering between the two branches applied in merge-timestamp order, not numeric order. Highest applied migration: `067` (id 74, 2026-06-24). Total tracked rows: 74.

## EV-038 — Tenant isolation reality + SEC-2 channel dual-connect (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Query A (SEC-2 dual-connect):** `SELECT type, external_id, count(DISTINCT tenant_id) FROM channels GROUP BY type, external_id HAVING count(DISTINCT tenant_id) > 1;` → **`[]` (zero rows).**
- **Query B (channels unique constraint):** `pg_constraint` + `pg_indexes`. Result: PK on `id`; unique index `idx_channels_tenant_type_external_id = UNIQUE (tenant_id, type, external_id)`. **No global unique on `(type, external_id)`.**
- **Query C (cross-tenant integrity):** one combined SELECT →

  | check | value |
  |---|---|
  | messages whose conversation has NULL tenant | 0 |
  | conversation.tenant_id ≠ contact.tenant_id | 0 |
  | order.tenant_id ≠ its conversation.tenant_id | 0 |
  | channels total | **0** |
  | tenants total | 6 |
  | products all / live | 617 / 258 |
- **Query D (channel nullability realized):** `channels=0`, `conversations=46`, `conversations WHERE channel_id IS NULL = 46` (100%), `messages=374`.
- **Verdict:**
  - Application-level tenant isolation is **clean in the dev data**: zero cross-tenant leakage on the message→conversation→contact→order join graph.
  - **SEC-2 (dual-connect) is a live *schema* risk but unrealized in data.** The uniqueness key includes `tenant_id`, so the DB *permits* two different tenants to connect the **same** `(type, external_id)` messaging account — no global guard. Not currently exploited only because **the `channels` table is empty (0 rows).** Nothing at the DB layer prevents two tenants registering the same page/Viber ID; webhook resolution would decide which tenant receives the traffic.
  - **SURPRISE:** the dev DB has **zero channels** yet 46 conversations and 374 messages — every conversation is orphaned (`channel_id IS NULL`, 100%). This fully exercises the "channel disconnect preserves history / channel_id nullable" path (CLAUDE.md §11), and means any earlier-phase claim relying on live channel rows (webhook routing, `ai_enabled` gating, encrypted-token presence) could **not** have been observed against runtime data here.

## EV-039 — pgvector version + HNSW capability (Phase 10, runtime PG)

- **When:** 2026-07-12
- **Source:** EV-036 extension list (`vector 0.8.2`) + EV-034 index defs.
- **Verdict:** CONFIRMED — `pgvector 0.8.2` installed; HNSW (`vector_cosine_ops`) indexes present and valid on both `products` and `product_image_fingerprints`. Cosine distance is the operative metric, consistent with `SIMILARITY_THRESHOLD` cosine-similarity semantics documented in CLAUDE.md §7/§10.

---
*(EV-033 – EV-039 appended 2026-07-12 by Phase 10 Postgres runtime verifier)*

## EV-040 — Redis server + keyspace state (Phase 10 Redis runtime verifier)

- **When:** 2026-07-12
- **Query:** Redis MCP (read-only) `dbsize`, `info memory`, `info keyspace`, `info clients`
- **Result:** DBSIZE = **445** keys (db0: keys=445, expires=**5**, avg_ttl≈23396). `maxmemory` = **0** (no ceiling), `maxmemory_policy` = **noeviction**, `used_memory` = 2.79M (peak 3.30M), mem_allocator jemalloc-5.3.0. `connected_clients` = 14, `blocked_clients` = **5** (workers parked in blocking pops), `clients_in_timeout_table` = 5.
- **Note:** noeviction confirmed (matches EV-007 baseline), but with `maxmemory=0` the policy is currently inert. Only 5 keys carry any TTL — all BullMQ scheduler `delayed`/`repeat` entries (EV-042), not application keys.

## EV-041 — AI-path application key prefixes: NONE present at rest (Phase 10)

- **When:** 2026-07-12
- **Query:** Redis MCP `scan_keys` (MATCH `<prefix>*`, count 1000) for each mapper-claimed prefix, plus a full `scan_keys *` (count 2000)
- **Result:** all twelve prefixes returned **0 keys** — `ai_config:*`, `tenant:*`, `tenant_prompt_blocks:*`, `products:*`, `ai_active_jobs:*`, `ai_conv_lock:*`, `ai_rate_limit:*`, `ai_send_done:*`, `webhook_seen:*`, `self_send_echo:*`, `img_fp:*`, `cust_vision:*`. The full `*` scan returned **exclusively `bull:*` keys** — the entire 445-key keyspace is BullMQ; zero application cache/lock/dedup/rate-limit keys exist.
- **Note:** every listed prefix is a short-TTL ephemeral key (locks, rate windows, dedup markers, hot caches). The instance was scanned idle with no live inbound traffic, so all had expired (consistent with only 5 TTL'd keys, all BullMQ scheduler entries). Their existence and TTLs are therefore **code-asserted, not runtime-confirmed**. The MCP has **no dedicated per-key TTL command** (`type` incidentally surfaces a `ttl` field, but that is moot here — none of these keys exist to read a TTL from). This scan neither confirms nor refutes the mappers; it confirms only that these keys are transient and absent when the pipeline is idle.

## EV-042 — BullMQ queue inventory, depths, and failed-job backlog (Phase 10)

- **When:** 2026-07-12
- **Query:** Redis MCP `scan_keys bull:*` / `bull:ai:*` / `bull:webhook:*`; `type` on `bull:<q>:{wait,active,delayed,failed}`; `get` on `bull:<q>:id`; `zrange bull:<q>:failed 0 -1` and `zrange bull:<q>:delayed 0 -1`
- **Result — queues present (vs CLAUDE.md §5):** `ai` (id 749), `ai.reply` (id 28), `webhook` (id 1004), `message.inbound`, `default`, `finetuning`, `finetuning.prepare`, `notifications`, `product.embedding`. CLAUDE.md documents only `webhook/ai/notifications/finetuning/default`; live adds **`ai.reply`** (CLAUDE.md lists `ai.reply` as a *job type* on the `ai` queue, but it is a **distinct queue** and is the actual main-pipeline queue), **`message.inbound`**, **`finetuning.prepare`**, **`product.embedding`**.
- **Depths:** `wait`/`active`/`delayed` keys are **absent** (type=none) for `ai`, `ai.reply`, `webhook`, `message.inbound` → **zero backlog; all queues drained**. Only scheduler `delayed` zsets exist: `bull:default:delayed` = 7 upcoming cron iterations (embeddingReconcile[Fast], offerEmbeddingReconcile, imageFingerprintReconcile, meta-token-refresh-weekly, monthlyUseCaseSnapshot); `bull:finetuning:delayed` = 1 (finetuning-prepare-nightly). Normal repeatables, not backlog.
- **Failed jobs (zset, ttl -1, never trimmed) — ~79 total retained:**

| Queue | Failed | Job IDs |
|---|---|---|
| `webhook` | 30 | 5, 17–46, 786, 787 |
| `default` | 20 | all `repeat:offerEmbeddingReconcileFast:*` iterations |
| `message.inbound` | 16 | 3–18 (contiguous) |
| `ai` | 7 | 25, 33, 35, 37, 325, 744, 745 |
| `ai.reply` | 3 | 2, 3, 20 |
| `product.embedding` | 3 | 1, 2, 3 |
| `notifications` | 0 | — |
| `finetuning` | 0 | — |

- **Note:** `webhook` (30) and `message.inbound` (16) carry large, mostly-contiguous low-ID failed sets — heavy early-dev inbound-processing failures, retained (no auto-trim on failed sets). `default` has **20 failed `offerEmbeddingReconcileFast` cron iterations** — a scheduled reconcile job failing on nearly every run; worth code-side root-cause. AI queues themselves are modest (`ai` 7, `ai.reply` 3). Workers connected and idle-blocked (EV-040, blocked_clients=5) — healthy pool, no jobs to process.

---
*(EV-040 – EV-042 appended 2026-07-12 by Phase 10 Redis runtime verifier)*

## EV-043 — Zero-cost retrieval-replay: ANN path, rank stability, tenant filter, threshold (Phase 10)

- **When:** 2026-07-12
- **Method:** Reused an EXISTING stored product embedding as the query vector (NO OpenAI calls) to exercise `product.ts › searchProductsBySimilarity()` read-only. Probe = product `0192c052-e67f-46d6-959c-2c806b8c710c` ("Rryp fitnesi lekur S", embedding_model `text-embedding-3-small`), tenant `02beb134-a979-46bc-82b8-9d8f586190db` (257 active embedded products; the only other tenant with embeddings has just 1).

**Query 1 — tenant selection**
```sql
SELECT tenant_id, count(*) FROM products WHERE deleted_at IS NULL AND embedding IS NOT NULL GROUP BY tenant_id ORDER BY 2 DESC;
```
Result: `02beb134… = 257`, `059dbbbd… = 1` (global active-embedded pool = 258).

**Query 2 — similarity top-10 (code-equivalent SQL), run x3 → RANK STABLE (identical every run)**
```sql
WITH probe AS (SELECT embedding AS e FROM products WHERE id='0192c052-…')
SELECT p.id, p.name, round((1-(p.embedding <=> (SELECT e FROM probe)))::numeric,6) AS sim
FROM products p
WHERE p.tenant_id='02beb134-…' AND p.deleted_at IS NULL AND p.is_active=true AND p.embedding IS NOT NULL
ORDER BY p.embedding <=> (SELECT e FROM probe) LIMIT 10;
```
| rank | name | sim |
|---|---|---|
| 1 | Rryp fitnesi lekur S (self) | 1.000000 |
| 2 | Doreza fitnesi model i ri | 0.594007 |
| 3 | Doreza fitnesi L | 0.587319 |
| 4 | Rryp fitnesi tekstil L | 0.584791 |
| 5 | Doreza fitnesi 100% lekur | 0.576302 |
| 6 | Qant fitnesi Nike | 0.541142 |
| 7 | Syza sportive me shum ngjyra | 0.524779 |
| 8 | Serious Mass 2.7kg Qokolad | 0.468308 |
| 9 | SET 50 KG - TEGA PROFESIONALE | 0.453805 |
| 10 | HMB 300gr shije Exotic | 0.452816 |

**Query 3 — EXPLAIN (ANALYZE, BUFFERS, VERBOSE), tenant-scoped.** Tested twice: probe as scalar-subquery (InitPlan) AND as a true `'[…]'::vector` literal Const (what bound `$2` compiles to). Both plans identical in shape:
```
Limit → Sort (Sort Method: top-N heapsort, 26kB)
  → Seq Scan on public.products p (rows=257, Rows Removed by Filter: 360)
     Filter: (deleted_at IS NULL) AND is_active AND (embedding IS NOT NULL) AND (tenant_id = '02beb134-…')
Execution Time: ~4.3 ms (literal) / ~8.5 ms (subquery)
```
- **HNSW index NOT used** — planner cost-prefers brute-force Seq Scan at this scale (617 total rows / 258 embedded). `idx_products_embedding` (HNSW) is valid but dormant; retrieval is currently **exact, not approximate**.
- **Tenant filter is POST-scan** — a Seq Scan `Filter` predicate (no index pre-filter); 360 of 617 rows removed.

**Query 4 — global (no tenant_id filter): cross-tenant rows in top-10 = 0**
```sql
… WHERE p.deleted_at IS NULL AND p.is_active=true AND p.embedding IS NOT NULL ORDER BY p.embedding <=> (SELECT e FROM probe) LIMIT 10;
```
All 10 rows belong to the probe's own tenant. Recall-starvation is **doubly unrealized**: ANN index unused (exact scan) AND only 1 cross-tenant product exists in the whole DB.

**Query 5 — SIMILARITY_THRESHOLD 0.65 vs 0.60 (self-probe, 257-row pool)**
```sql
count(*) FILTER (WHERE 1-(embedding <=> probe) >= 0.65) …
```
| >=0.65 | >=0.65 excl-self | >=0.60 | >=0.60 excl-self | >=0.55 | pool |
|---|---|---|---|---|---|
| **1** | 0 | **1** | 0 | 5 | 257 |
Only the identical self-vector (1.0) clears 0.65 — and 0.60. Closest *distinct* item = 0.594 (below both). At the documented 0.65 floor with `-small` vectors, genuine same-category neighbours are filtered out.

- **Verdict:** rankStable=**true**, hnswUsed=**false** (dormant at this scale), tenantFilterStage=**post-scan seq-scan Filter**, crossTenantInTop10=**0**, threshold065Count=**1**.
- **Risk flagged:** stored vectors are `text-embedding-3-small` but CLAUDE.md §10 documents default `OPENAI_EMBEDDING_MODEL=text-embedding-3-large`. If the live query embeds with `-large` and passes `expectedModel='text-embedding-3-large'`, the `modelGuard` (`embedding_model IS NULL OR embedding_model=$4`) excludes **all 257 rows** → zero retrieval. Needs code-side confirmation of the actual embed-model used at query time.

---
*(EV-043 appended 2026-07-12 by Phase 10 retrieval-replay verifier)*

## EV-043 — Backend unit test suite runs green locally (C-145)

- **When:** 2026-07-12
- **Where:** `backend/`
- **Command:** `npm test` → resolved script `tsx --test src/services/__tests__/**/*.test.ts` (Node built-in test runner via `tsx`, no build step)
- **Result:** **PASS — `# tests 548 / # suites 75 / # pass 548 / # fail 0 / # skipped 0 / # todo 0`**, duration ~5.9s. Suite index reached `1..74` (74 named suites). No failing tests.
- **Environment:** No tsconfig/DB/Redis/`.env` required — suite runs fully offline as pure-logic unit tests (health-advice fast-path keyword parity, follow-up-invitation pattern parity, Albanian classifiers, etc.). Windows/Git-Bash glob expanded correctly; all 74 suites discovered.
- **Note (confirms C-145):** CLAUDE.md §4 states CI does **not** run `npm test` (CI = typecheck + build + migration smoke-test + health check only). This run proves the 548-assertion suite **exists and passes** locally — so C-145 is a genuine CI-coverage gap, not broken tests: a green, non-trivial suite is never executed by the pipeline, so regressions in the covered guard/classifier logic would ship uncaught. Full run detail: scratchpad `audit/runtime/npmtest.md`.

*(EV-043 appended 2026-07-12 by Phase 10 test-suite runner)*

---

## EV-044 — Live-replay divergence: identical input → divergent OUTCOMES (Issue-1, empirical)

- **When:** 2026-07-12
- **Where:** `backend/` runtime; live tenant `02beb134-a979-46bc-82b8-9d8f586190db` (fitness/supplements, 257 embedded products).
- **Cost:** This is the ONE credit-spending audit step (user-approved). **81 OpenAI calls total**; hard cap 118 enforced by a wrapped client counter. Clean exit, no loops/errors.
- **Method — capture-and-replay:** Monkey-patched the shared OpenAI singleton to (a) count+cap calls and (b) intercept the customer-facing reply completion (the only `chat.completions.create` with `temperature!==0` AND no `response_format`) to capture its fully-assembled `messages`. Phase A: real `aiService.generateReply(randomUUID(), tenant, input)` ×1/input (random nonexistent conversationId ⇒ empty history ⇒ **no rows written**). Phase B: replay captured prompt **8×** @ temp 0.3 (gpt-4o). Phase C: real `assessProductInformationRequest(input, catalogCtx)` **8×** (escalate = `!ok || missing>0`). Phase D: `filterHallucinatedProductNames` + `evaluateReply` on 2 sampled replies/input. Live config: chat=gpt-4o, `AI_REPLY_TEMPERATURE=0.3`, `QUALITY_THRESHOLD=0.1`. Harness: `scratchpad/audit/runtime/replay-harness.ts`; raw: `replay-results.json`; memo: `runtime/live-replay.md`.

**3 fixed Albanian inputs, mapped to REAL in-stock items:**
| id | kind | message | maps to |
|---|---|---|---|
| IN1 | availability | `A keni proteine Compact whey gold?` | Compact whey gold ×many, €22–65 |
| IN2 | price+flavor | `Sa kushton whey Applied Nutrition dhe qfar shije keni?` | Applied Nutrition whey 2kg €68 (Dredhz/Vanile/Qokolad) |
| IN3 | comparison | `Cila kreatine eshte me e mire, Creatine Monohydrate apo BSN Creatine?` | Creatine Monohydrate €24 vs BSN Creatine 216gr €25 |

**Reply-replay divergence (8 identical-prompt runs @ temp 0.3):**
| input | matched | distinct texts /8 | class | quality | note |
|---|---|---|---|---|---|
| IN1 | 10 | **1** | answered | **0.20** | degenerate collapse: every run = `"Po."` (one-word "Yes"). |
| IN2 | 25 | **3** | answered | 0.95 | stable €68+3 flavors, but 2/8 runs **drop the product name**. |
| IN3 | 25 | **8** (max) | answered | 0.95 | every run different; several **fabricate** "BSN = Bio-Engineered Supplements and Nutrition" + strength claims NOT in catalog — passed name-guard AND quality-eval. |

**Escalate-gate divergence (8 runs, `assessProductInformationRequest`, temp 0):**
| input | escalate /8 | distinct missing-sets | missing labels |
|---|---|---|---|
| IN1 | **8/8** | 1 | `["marka"]` (brand null for all matches; customer only asked availability). |
| IN2 | 0/8 | 1 | `[]` |
| IN3 | **8/8** | **2** | 4×`["cila eshte me e mire"]`, 4×`["më e mirë"]` — escalation REASON itself non-deterministic at temp 0. |

- **Verdict:** **divergenceObserved = TRUE.** Wording: identical input → up to **8/8 distinct replies** (IN3), 3/8 (IN2), 1/8 degenerate (IN1). **escalatedCorrectAnswer = TRUE (IN1, IN3):** two correct/answerable catalog questions are flagged escalate 8/8 by the product-info-gap arm **while the reply arm confidently answers them** (IN3 quality 0.95) — the pipeline's reply and escalate arms disagree on identical input. Escalation metadata (IN3 `missing`) is itself non-deterministic. High-temp wording drift carries **factual/grounding drift** (ungrounded BSN backronym) that both the name-guard and quality-eval let through.
- **outcomeClassesPerInput:** IN1 {reply:answered / gate:escalate} · IN2 {reply:answered / gate:answer} · IN3 {reply:answered / gate:escalate}. **distinctRepliesPerInput:** [1, 3, 8].
- **Test-data inventory:** **NO ROWS WRITTEN** (no conversations/messages/orders/alerts/contacts/products inserted or test-updated). Incidental only: ephemeral Redis cache keys (`ai_config:*`,`tenant:*`,`products:*`,`tenant_prompt_blocks:*`, TTL 2–30min); `generateReply`→`forceSyncLockedBlocksForTenant` is a no-op equality check for this current-content tenant.

*(EV-044 appended 2026-07-12 by Phase 10 live-replay divergence experiment)*
