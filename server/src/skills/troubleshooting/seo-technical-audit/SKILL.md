---
name: seo-technical-audit
title: SEO Technical Audit via RankPilot (GSC indexing diagnostics)
category: troubleshooting
description: Diagnose and remediate site indexing/technical-SEO problems using RankPilot's technical audit (Audit dashboard view or the seo.technical_audit MCP tool): GSC sitemap status, URL-inspection sampling (verdict/coverage/fetch/robots/rich results), robots.txt/llms.txt/IndexNow checks, with findings automatically written to RankPilot anomalies for the next optimise pass to fix. Use when a site has no traffic/indexing yet, sitemap "couldn't fetch", URL Inspection reports critical issues, rich-result warnings, or the user asks for a technical SEO audit.
status: stable
observation_count: 3
success_count: 3
failure_count: 0
confidence: 0.9
triggers:
  - technical audit
  - seo audit
  - site not indexed
  - couldn't fetch sitemap
  - url inspection
  - indexing issues
  - rich results
  - schema warnings
  - google not ranking
  - no impressions
  - technical seo
  - audit site
created_at: 2026-08-14T00:00:00.000Z
source: manual-request
---
# SEO Technical Audit via RankPilot

Run RankPilot's technical audit to see exactly what Google sees for a site,
then let the findings flow into the normal triage loop. The audit is
read-only against Google (inspection + sitemap status) — it never submits
the sitemap or requests indexing.

## When to Use This Skill

- A site shows zero traffic / zero impressions and the user asks why
- GSC shows sitemap "couldn't fetch" or "critical issues" in URL Inspection
- New pages are not being indexed
- The user asks for a technical/SEO audit of the site
- After any hosting/deployment change, to verify Google can still see the site

## The Tool

**RankPilot Audit view** (dashboard → Audit → Run audit), or the MCP tool
`seo.technical_audit`, or `POST /api/audit/run` (HTTP). One run (~10–30s):

1. **Sitemaps** — GSC feed status per sitemap: errors, warnings,
   `submitted` vs `indexed` counts, `isPending`.
2. **URL sample** — homepage + every `/guides/<slug>` + first 5 other
   sitemap URLs (≤12) through GSC URL Inspection: verdict, coverage state,
   page-fetch state, robots state, last crawl, canonical, rich-result
   issues.
3. **Checks** — robots.txt, llms.txt, and the IndexNow key file must serve
   HTTP 200 from the site root.
4. **Triage** — every non-info finding is written to RankPilot `anomalies`
   (kinds `index_error` / `crawl_error` / `rich_result` / `site_file`,
   7-day dedupe). The weekly optimise prompt converts open audit anomalies
   into ledger actions (`technical_fix`, 14-day window) and acks them after
   the fix commits.

## Live-Verified Lessons (apply these before inventing new theories)

1. **GSC APIs require the EXACT property URL.** The stored `gsc.site_url`
   (`https://www.depositback247.com/` — trailing slash matters) is the only
   value GSC accepts for sitemap/inspection calls. Passing the site row's
   base URL returns "User does not have sufficient permission" / "You do
   not own this site". The audit resolves the property URL from the stored
   connector config — keep it in sync with the GSC property.
2. **apex vs www must match.** If the site canonical/GSC property is
   `www.depositback247.com` but RankPilot's site `site_base_url` is the
   apex, every GSC call and fetch fails. Symptom in the audit: all checks
   `fetch failed` + GSC permission errors. Fix: set `site_base_url` to the
   www URL (Settings → Site & Repo).
3. **URL Inspection API endpoint** is
   `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`
   (body `{inspectionUrl, siteUrl}`). The old
   `webmasters/v3/…/urlInspection/…` path returns a Google HTML 404.
4. **Fresh URLs read as failures but aren't.** On a new site: verdict
   NEUTRAL with "URL is unknown to Google" or "Discovered - currently not
   indexed" is normal for URLs younger than days. The homepage being
   PASS/"Submitted and indexed"/pageFetch SUCCESSFUL is the anchor — if
   THAT fails, the problem is real.
5. **Rich-result warnings are usually the Product schema.** Google flags
   Product snippets missing `review`/`aggregateRating` (and Merchant
   listings missing `image`/`hasMerchantReturnPolicy`/`shippingDetails`).
   If there are no real reviews to cite, the honest fix is replacing
   `Product` JSON-LD with `Service` (provider + areaServed + offer) — the
   warnings disappear without fabricating data.
6. **Sitemap "couldn't fetch" is a serving-layer problem, not a sitemap
   problem.** Check the feed status via the API: if `lastSubmitted` exists
   and `lastDownloaded` is recent, Google DID fetch it (the UI complaint was
   transient). If it truly can't fetch: the hosting is not serving the file
   to Googlebot (WAF/rewrites) — that's a platform fix, not repo code.
7. **"0 indexed" for a new domain is latency, not breakage.** Google's
   first-crawl budget on new domains is tiny. Sitemap submission +
   IndexNow + internal links from the indexed homepage is the fix; give it
   days-to-weeks.

## Remediation Flow (after the audit)

1. Read the audit's issues list; triage critical first (fetch FAILED,
   robots DISALLOWED, sitemap errors).
2. Repo-side fixes (schema, llms.txt, dates) → commit → republish.
3. Config fixes (site_base_url, GSC site_url) → Settings, re-run the audit
   to confirm `anomaliesCreated` drops to 0 for the fixed items.
4. Serving-layer fixes (per-route prerendered files, `_redirects`,
   Googlebot access) → platform team; see the site repo's
   `docs/SEO-TECHNICAL-SPEC.md` F1/F2.
5. Ack the anomalies only after the fix is live; the optimise pass turns
   the remaining ones into ledger actions.

## Verification

- Re-run the audit: homepage verdict PASS, checks all `ok`, and no NEW
  anomalies for previously fixed findings (7-day dedupe makes re-runs
  free of duplicates).
- Confirm Google's side a few days later: `indexed` counts climb in the
  sitemap row and impressions appear in the Traffic page.
