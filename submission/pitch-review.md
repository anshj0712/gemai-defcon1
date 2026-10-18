# Pitch Deck Review: Churn Preventer Agent

**Review Date:** 18 Oct 2026
**Deck Version:** `Churn Preventer Agent - AI Builder Cup deck.pptx` (15 slides, built on the Google AI Builder Cup template)
**Stage:** Working prototype, deployed on Google Cloud (hackathon submission, not a fundraise)
**Industry:** Retail & Commerce, checkout analytics
**Reviewer:** pitch-deck-reviewer method (OneWave-AI), read as a hackathon judge

> How this review was calibrated. The skill's eight dimensions are written for investor decks. The Google template has no market, team or ask slides, so a plain eight-dimension score under-rates a good hackathon deck. Below, the eight dimensions are scored as the skill defines them (as the skill's calibration note allows, missing sections score 1 to 2 and are flagged), and then the deck is scored again on the Cup's own published weights: technical merit and Gen AI 40%, problem alignment and impact 25%, innovation 25%, UX 10%.

**Update 18 Oct (later):** the deck was cut to short bullets, the performance slide now has a chart, and the new agent eval engine (11 of 11 golden cases pass on real Gemini) is on slides 4, 5, 8, 11 and 12. Scores below were set before this change; the eval engine would raise Traction and Technical merit slightly.

---

## Executive Summary

The strongest part is the engineering story: a real pipeline on Google Cloud, Gemini used in ways that are checked (visual proof, a four-juror review gated by code, rules drafted by Gemini but approved by a person), and measured results from a simulator with known answers. The performance slide (12) separates what was measured from what is projected, which is what a careful judge wants to see. The most critical gaps are not about the product: the team name and leader are still placeholders, there is no demo video link yet, and the GitHub repository is private today. A judge also will ask who the real competitors are, and the deck never names any.

**Overall Score (skill's eight dimensions): 5.4 / 10 -- Needs Work** (driven down by the template having no market, team or ask slide, and by the unfilled team fields)
**Score on the Cup's weights: 8.4 / 10 -- Strong, once the three submission blockers are cleared**

---

## Slide-by-Slide Analysis

### Slide 1: Team Details
**Content Summary:** Team name and leader in brackets; one-line problem statement.
**Purpose:** Identify the team and state the problem.
**Effectiveness:** The problem line is clear. The team fields are empty.
**Strengths:** "Shoppers abandon checkout because of bugs nobody sees; teams learn about them days late, if ever." is one sentence and concrete.
**Weaknesses:** `[enter team name]` and `[enter leader name]` cannot go to judges.
**Recommendations:** Fill both. Optional: add team members' roles in the notes.

### Slide 2: Brief about the idea
**Content Summary:** A one-sentence pitch and three cards: problem, what we built, what the merchant gets.
**Purpose:** Let a judge understand the idea in 20 seconds.
**Effectiveness:** High. The headline sentence works as the one-sentence explanation.
**Strengths:** Concrete failures (dead coupon button, wrong cart total, 500 at Place Order); states "all demo data is synthetic".
**Weaknesses:** No opening statistic or story; the skill's "hook" is missing. (We have no sourced statistic, so the deck rightly does not invent one.)
**Recommendations:** If a real, citable abandonment figure for the target segment can be found, add it to the problem card with its source.

### Slide 3: Opportunities
**Content Summary:** Three answers to the template's three questions.
**Purpose:** Differentiate.
**Effectiveness:** Good on the product side, weak on competitors.
**Strengths:** The wedge is specific: silent business bugs and looking backwards over 30 days.
**Weaknesses:** "Session-replay tools" are never named. A judge cannot tell what is being compared.
**Recommendations:** Name two or three real session-replay or analytics tools and say in one line what each misses. Keep it factual.

### Slide 4: Features
**Content Summary:** Twelve numbered features.
**Purpose:** Show breadth.
**Effectiveness:** Complete, scannable.
**Strengths:** Each feature is one line and all are built.
**Weaknesses:** Twelve equal items hide which three matter most.
**Recommendations:** Bold or colour the three that carry the thesis (the jury, retroactive re-scan, revenue at risk).

### Slide 5: Process flow
**Content Summary:** Six-step flow and a four-step "how a rule learns" loop.
**Purpose:** Explain how the system works end to end.
**Effectiveness:** Very good: the second row shows the learning loop that makes this more than a detector.
**Strengths:** The human approval step is visible; idempotency stated.
**Weaknesses:** Step 5 text is compressed ("Gemini, ₹ at risk, AI jury").
**Recommendations:** None blocking.

### Slide 6: Wireframes
**Content Summary:** Dashboard and issue-page wireframes.
**Purpose:** Show intended UX.
**Effectiveness:** Clear layout logic.
**Strengths:** Matches the shipped product, so wireframe and screenshots agree.
**Weaknesses:** Small labels (7 to 8.5 pt).
**Recommendations:** Acceptable for an optional slide.

### Slide 7: Architecture
**Content Summary:** The repository's own high-level diagram plus two lines on scale and safety.
**Purpose:** Prove technical merit.
**Effectiveness:** Strong. Diagram is real, readable and consistent with the tech stack slide.
**Strengths:** Shows storage, the learning loop and the human gate; states Gemini never sees raw events.
**Weaknesses:** Diagram text is small when projected.
**Recommendations:** If time allows, ship the low-level diagram as a backup slide.

### Slide 8: Technologies
**Content Summary:** Six grouped cards with versions.
**Purpose:** Show the stack.
**Effectiveness:** Good. Versions come from the repo.
**Strengths:** Model split is explicit (Flash-Lite for bulk, Flash for reasoning and vision).
**Weaknesses:** None material.
**Recommendations:** None.

### Slide 9: Cost
**Content Summary:** Cost drivers per service; only Gemini has a figure.
**Purpose:** Show cost awareness.
**Effectiveness:** Honest but thin.
**Strengths:** Gemini maths is shown (200 issues a day x tokens), and the key claim is that cost follows issues, not sessions.
**Weaknesses:** Four cells read "[₹ from billing]".
**Recommendations:** Fill them from the Billing console, or delete the slide (it is optional).

### Slide 10: Snapshots
**Content Summary:** Four screenshots of the live product.
**Purpose:** Show the prototype is real.
**Effectiveness:** Good. Screenshots come from the deployed site.
**Strengths:** Includes the shop checkout validation and the time-travel chart.
**Weaknesses:** Text inside screenshots is small.
**Recommendations:** Pair with the video; judges will click the live link.

### Slide 11: Performance and benchmarking
**Content Summary:** Measured results on the left; an illustrative revenue projection on the right.
**Purpose:** The selling-point slide.
**Effectiveness:** Strong. The two halves are labelled "Measured" and "Illustrative projection", and the assumptions are bracketed.
**Strengths:** Real numbers (8 of 8, 100% recall and precision, 0 false alarms, 27.6 s, 249 sessions re-scanned in about 10 s); an "Honest limit" line admits the bugs were planted by the team.
**Weaknesses:** The projected figure (about ₹1.13 crore a month) is large and rests on assumptions the team chose.
**Recommendations:** Keep the label. In the video, say "illustrative" out loud when showing it.

### Slide 12: Future development
**Content Summary:** Six items: login, rebuild path, real-traffic pilot, alerts, scale-out, out of scope.
**Purpose:** Show maturity.
**Effectiveness:** Good. Items are honest and come from the architecture notes.
**Strengths:** Names the real gaps (no login on the demo; one rule path not built).
**Weaknesses:** None.
**Recommendations:** None.

### Slide 13: Links
**Content Summary:** Repo, demo video, product link.
**Purpose:** Let judges reach the work.
**Effectiveness:** Blocked: the repo is private and the video does not exist yet.
**Strengths:** The product link works and needs no login.
**Weaknesses:** Two of three links are not ready.
**Recommendations:** Make the repo public, record the video, replace the brackets.

### Slides 14 and 15: Template closing slides
Untouched, as instructed.

---

## Dimension Scores (the skill's eight dimensions)

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Narrative Flow and Story Arc | 8/10 | 15% | 1.20 |
| Problem/Solution Clarity | 8/10 | 15% | 1.20 |
| Market Sizing Methodology | 3/10 | 12% | 0.36 |
| Competitive Positioning | 5/10 | 10% | 0.50 |
| Financial Projections Realism | 6/10 | 12% | 0.72 |
| Team Credibility | 1/10 | 12% | 0.12 |
| Ask Clarity and Use of Funds | 4/10 | 12% | 0.48 |
| Traction and Validation | 7/10 | 12% | 0.84 |
| **Overall** | | **100%** | **5.42** |

Grade: **Needs Work (5.0 to 5.9)**. Three of the low scores (market, team, ask) come from sections the Google template does not include or that are unfilled, not from weak thinking.

### Dimension Detail

#### 1. Narrative Flow and Story Arc: 8/10
The order follows the template, and inside it the story holds: idea (2), difference (3), features (4), how it works (5), what it looks like (6, 10), how it is built (7, 8), proof (11), what is next (12). Slide 11 is where energy peaks, which is right. The opening has no hook number.

#### 2. Problem/Solution Clarity: 8/10
The problem is shown with three concrete failures a shopper hits. The solution can be said in one sentence after reading slide 2. The "painkiller" test passes: it puts a rupee figure on each bug. What is missing is evidence that real merchants feel this pain; that is a pilot, which slide 12 admits.

#### 3. Market Sizing Methodology: 3/10
There is no market slide, and the template does not ask for one. The only sizing is the illustrative platform on slide 11 (a mid-size footwear store). That is a usage model, not a market. For a hackathon this is acceptable; flag it so the team is ready for the question.

#### 4. Competitive Positioning: 5/10
Differentiation is specific (silent business-rule bugs, 30-day re-scan, time travel) but no tool is named, and there is no comparison table. Judges told the common objection "existing replay tools already do this" will want the answer on a slide.

#### 5. Financial Projections Realism: 6/10
Better than most hackathon decks. Every unsourced number is bracketed, the formula is in the deck, and the abandon gaps come from a simulator with known answers. Held back because the affected shares and the 14-day and 1-day assumptions are the team's own, and the total is a single large figure.

#### 6. Team Credibility: 1/10
Placeholders only. The skill's rule: an absent or empty section scores 1 to 2 and goes in the executive summary.

#### 7. Ask Clarity and Use of Funds: 4/10
A hackathon has no ask, but "what happens next" is clear on slide 12. A single line such as "pilot with one real store" would turn that list into an ask.

#### 8. Traction and Validation: 7/10
Strong for a prototype: deployed on Cloud Run, 240 simulated shoppers, 13 planted bugs, 533 automated tests, three rules drafted by Gemini that each found 12 past shoppers. No real merchant has used it, and the deck says so.

---

## Score on the Cup's own weights

| Criterion | Weight | Score | Weighted | Why |
|---|---|---|---|---|
| Technical merit and Gen AI implementation | 40% | 9 | 3.60 | Real pipeline on Google Cloud; Gemini used with visual proof, a code-gated jury and human-approved rules; measured results; 533 tests |
| Problem alignment and impact | 25% | 7.5 | 1.88 | Clear retail problem with a rupee figure; impact is projected, not measured on real traffic (and says so) |
| Innovation and creativity | 25% | 8.5 | 2.13 | Retroactive re-scan with "found later", time travel, an agent that proposes its own rules |
| User experience | 10% | 8 | 0.80 | Clean dashboard, plain wording, working demo link |
| **Overall** | | | **8.4 / 10** | |

---

## Design and Visual Communication Notes

- Template colours, header and footer are kept on every slide; fonts match the template (Google Sans Flex).
- One accent (blue), red only for money lost, green only for good news. Consistent card style.
- Smallest text is 7 to 8.5 pt on the wireframe and in the screenshots; everything else is 9.5 pt or larger.
- No overflow or overlap was found in the rendered slides (checked slide by slide in PowerPoint).
- Slides 4 and 8 are dense but scannable.

---

## Top 5 Improvements

### 1. Fill the team fields
**Current State:** `[enter team name]`, `[enter leader name]`.
**Recommended Change:** Real names; add one line on roles in the speaker notes.
**Expected Impact:** Removes the most visible "unfinished" signal.
**Implementation Difficulty:** Low
**Priority:** Immediate

### 2. Make the repository public and add the demo video
**Current State:** Repository is private; video link is a bracket.
**Recommended Change:** Make the repo public, record the 3-minute video (spend about a third of it on the retroactive re-scan), paste both links on slide 13.
**Expected Impact:** Judges can verify the claims. Without these the entry may be incomplete.
**Implementation Difficulty:** Medium
**Priority:** Immediate

### 3. Name the competition
**Current State:** "Session-replay tools" with no names.
**Recommended Change:** On slide 3, name two or three real tools and one line each on what they miss.
**Expected Impact:** Pre-empts the most likely judge question.
**Implementation Difficulty:** Low
**Priority:** Immediate

### 4. Fill or drop the cost slide
**Current State:** Four "[₹ from billing]" cells.
**Recommended Change:** Read the month-to-date cost in the Billing console and fill the cells, or delete the optional slide.
**Expected Impact:** Removes a visible gap.
**Implementation Difficulty:** Low
**Priority:** Soon

### 5. Make the three headline features stand out on slide 4 (done in the final deck)
**Current State:** Twelve equal cards (now the jury, the retroactive re-scan and revenue at risk are outlined in blue).
**Recommended Change:** Colour the jury, the retroactive re-scan and revenue at risk.
**Expected Impact:** A judge skimming for 10 seconds sees the thesis.
**Implementation Difficulty:** Low
**Priority:** Soon

---

## Judge Objection Predictions

### Objection 1: "Existing session-replay tools already flag rage clicks. What is new?"
**Category:** Competitive
**Severity:** High
**Trigger:** Slide 3 names no tools.
**Suggested Verbal Response:** "Agreed on rage clicks. We catch the silent bugs (a total that does not match its lines, a fee that appears at checkout) and we can look backwards: a rule written today re-scans 30 days of sessions."
**Deck Fix:** Name the tools; add one line on the re-scan.

### Objection 2: "You planted the bugs and then found them. Of course recall is 100%."
**Category:** Technical
**Severity:** High
**Trigger:** Slide 11 "8 of 8".
**Suggested Verbal Response:** "Fair. That is why the slide says upper bound. The simulator keeps clean shoppers and we saw no false alarms; real-traffic accuracy is the pilot."
**Deck Fix:** The "Honest limit" line already covers it. Say it aloud in the video.

### Objection 3: "The ₹1.13 crore figure is made up."
**Category:** Business Model
**Severity:** Medium
**Trigger:** Slide 11 projection.
**Suggested Verbal Response:** "It is labelled illustrative. The formula is shown, the abandon gaps are from the simulator, and every volume is a bracketed assumption you can change."
**Deck Fix:** Keep "projection, not a measured result" next to the number.

### Objection 4: "Where is the team?"
**Category:** Execution
**Severity:** High
**Trigger:** Slide 1 placeholders.
**Suggested Verbal Response:** n/a until filled.
**Deck Fix:** Fill slide 1.

### Objection 5: "Is the dashboard safe to open to real customers?"
**Category:** Regulatory / security
**Severity:** Medium
**Trigger:** Slide 13 says "no login".
**Suggested Verbal Response:** "The demo holds synthetic data only. Sign-in and signed replay links are the first item on the roadmap. Replays are built from masked sessions."
**Deck Fix:** Slide 12 already lists login first.

### Objection 6: "Gemini will hallucinate root causes."
**Category:** Technical
**Severity:** Medium
**Trigger:** Slides 2, 4 and 7 rely on Gemini explanations.
**Suggested Verbal Response:** "Code decides what is a finding and its score. Gemini cites evidence ids we supplied, a screenshot confirms the defect, and four jurors must approve before a report is trusted."
**Deck Fix:** Already on slides 3, 4 and 7.

---

## Comparison to Successful Decks

### Primary Benchmark: Y Combinator standard deck (traction-first, demo-heavy)

**Relevance:** A hackathon deck is judged in minutes, like a demo-day deck.

**Where This Deck is Stronger:**
- Measured and projected numbers are kept apart and labelled.
- A real architecture diagram and a deployed product.

**Where This Deck Falls Short:**
- No named competitors; no team.
- No opening hook.

**Techniques to Borrow:**
- Lead the video with the cart-total bug: 15 seconds, then straight to the dashboard.

### Secondary Benchmark: Mixpanel (data-driven positioning)

**Relevance:** Analytics product sold on measured evidence.

**Where This Deck is Stronger:**
- It ties each finding to rupees lost.

**Where This Deck Falls Short:**
- No customer quote or pilot result.

**Techniques to Borrow:**
- One line of customer evidence once a pilot exists.

---

## Missing Slides or Sections

- Team details (placeholders).
- Named competitors.
- A working demo video link and a public repository link.
- Cost figures (optional slide).

---

## Appendix: Methodology

This review follows the pitch-deck-reviewer workflow (inventory, eight weighted dimensions, slide-by-slide notes, objections, benchmarks, top five fixes). Because the target is a hackathon with its own published weights, the deck is also scored on those weights. No market-size, revenue or growth claims were taken from the deck without checking them against its own labelled assumptions; none are presented as measured facts. Rendered slides were checked in PowerPoint for overflow, overlap and low-contrast text.
