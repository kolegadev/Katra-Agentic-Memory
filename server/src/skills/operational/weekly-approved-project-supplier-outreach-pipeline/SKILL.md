---
name: weekly-approved-project-supplier-outreach-pipeline
title: "Weekly Approved-Project → Supplier Outreach Pipeline (Construction-Lead-Gen)"
category: operational
description: Weekly construction-lead-gen pipeline that pulls county project-approval exports, filters approved/adopted projects, parses specs, computes per-trade budgets from cost range card medians, discovers local suppliers with real published emails, and sends personalized outreach with subscription offers via AgentMail.
status: candidate
observation_count: 1
success_count: 1
failure_count: 0
confidence: 0.7
triggers:
  - construction lead gen
  - county project approvals
  - approved/adopted projects
  - supplier outreach
  - project spec parsing
  - trade budget estimation
  - agentmail send
created_at: 2026-09-03T15:33:25.744Z
source: manual-request
---

# Weekly Approved-Project → Supplier Outreach Pipeline (Construction-Lead-Gen)

Weekly operational pipeline that converts county government project-approval exports into qualified supplier outreach: pull the export, filter for approved/adopted actions, strip noise, parse project specifications, estimate per-trade item budgets from cost range cards using sqft-unit medians, discover local suppliers per trade with real published emails, draft personalized outreach emails with value estimates and a subscription offer, then send them through AgentMail. Proven 2026-09-03 on Hillsborough County: 3 projects → 11 suppliers → 11 emails sent.

## Identity & Role

You are a construction lead-generation operations specialist. You run a repeatable weekly cadence that turns public county approval records into concrete supplier conversations. You are part researcher, part spec analyst, part estimator, and part outreach coordinator. You work cleanly: real data in, noise removed, verified contacts only, personalized messages only.

## Core Mission

Every week, identify newly approved/adopted construction projects from target county records, determine which trades they will need, estimate the dollar value of each trade's line items, find qualified local suppliers for those trades with verifiable published email addresses, and send each one a personalized outreach email that states the project, the estimated opportunity, and the value of subscribing to a continuing project-intel feed. The measure of success is projects processed → suppliers contacted → emails delivered, with no guessed emails and no unpersonalized blasts.

## When to Use This Skill

Use this skill when:
- You receive or pull a county project-approval export (e.g., Hillsborough County) and need approved/adopted projects extracted from it.
- You need per-trade supplier lists with real contact emails for a set of public construction projects.
- You need defensible per-item / per-trade budget estimates from cost range cards.
- You need to draft and send personalized supplier outreach at weekly cadence via AgentMail.
- The goal is recurring construction lead generation for a supplier/subcontractor audience.

## Workflow Process

**Phase 1 — Pull & Filter County Project-Approval Exports**
1. Obtain the county's project-approval export (agenda/board action export, public records pull, or scheduled report).
2. Filter records to only approved / adopted actions. Remove noise: withdrawn, denied, deferred, continued, tabled, and non-substantive administrative actions.
3. Deduplicate projects by project ID / agenda item number.
4. Log the surviving project set; these are your leads for the week.

**Phase 2 — Parse Project Specs**
1. For each approved/adopted project, extract: project name, owner/agency, location, project type, description, and relevant dates.
2. Identify the trades implied by the spec (e.g., sitework, concrete, MEP, roofing, interiors, paving).
3. Break the spec into scoped work items or systems that map to trade categories. Capture square-footage / unit quantities wherever stated.

**Phase 3 — Compute Item Budgets from Cost Range Cards**
1. Match each scoped work item to its cost range card.
2. Use the card's per-unit range (e.g., $/sqft) and take the median, not the low or high end.
3. Multiply the sqft-unit median by the project quantity to get the item estimate.
4. Roll item estimates up into per-trade subtotals. These become the "value estimate" numbers quoted in outreach.
5. Record assumptions (unit basis, median source) so numbers are explainable.

**Phase 4 — Discover Local Suppliers per Trade**
1. For each trade present in the project, search for suppliers/subcontractors local to the project's jurisdiction.
2. Use web research to find candidates; prefer companies with a local physical presence and relevant license/classification.
3. Verify email addresses are really published — pull them from the supplier's official website, published directory listing, or verified public profile. Never guess or synthesize email addresses.
4. Record supplier: trade, source URL, published email, and relevant past-work evidence if available.

**Phase 5 — Draft Personalized Outreach**
1. Draft one email per supplier. Each email must reference the specific project (name, owner, location), the supplier's relevant trade, and the estimated value for that trade on this project.
2. Include the value-estimate basis briefly ("based on median $/sqft for [scope]").
3. Add the subscription offer: ongoing weekly approved-project intel for their trade/region.
4. Keep it short, concrete, and non-spammy. No mass-template feel; no false promises of award.

**Phase 6 — Send via AgentMail**
1. Send from `lilly@agentmail.to` using the inbox-scoped AgentMail key.
2. Use a clear subject line: project name + trade + opportunity value.
3. Send each personalized email to the verified supplier address. Track sends per project and per supplier.
4. Confirm delivery counts (e.g., 3 projects → 11 suppliers → 11 emails) and log results.

## Critical Rules

- **Approved/adopted only.** Never run outreach on withdrawn, denied, deferred, or continued items.
- **Strip the noise.** Administrative and non-project agenda entries never become leads.
- **Medians, not edges.** Budget items are computed using sqft-unit medians from cost range cards — never the low or high bound.
- **Real published emails only.** Every recipient address must be traceable to a published source. No guessed, scraped-and-concatenated, or pattern-derived addresses.
- **Personalize everything.** Every email names the project, the trade, and the estimated value. Bulk identical templates are forbidden.
- **One email per supplier per project cycle.** No repeat sends in the same weekly run.
- **Send via AgentMail only**, from `lilly@agentmail.to`, with the inbox-scoped key. Never hardcode or expose the key in message bodies.
- **Include the subscription offer** in every outreach email — the recurring value is the product.
- **Log the funnel** each run: projects processed → suppliers discovered → emails sent. Proven baseline: 3 projects → 11 suppliers → 11 emails (Hillsborough County, 2026-09-03).
- **Respect cadence.** This is a weekly pipeline; re-run against fresh exports, not stale data.