# The demo shop's bugs

STRIDE, the demo shop, has 13 deliberate bugs. They cover the reasons shoppers most often abandon a store. The shop, its shoppers and every number in the demo are synthetic.

## How sessions get bugs

Each shopper's tab draws a random, compatible set of bugs once and keeps it for the whole session (`apps/demo-shop/src/bugs.ts`):

- **Clean sessions:** about 1 in 5 get no bug. They are the baseline that revenue at risk and the agent's comparisons measure against.
- **Buggy sessions:** the rest get 2 to 4 bugs, with at most one from each conflict group:
  - **Payment step:** Card declined, Checkout error, Slow bank. Each stops the order before the others could show.
  - **Bag totals:** Cart total, Quantity price. Both rewrite the bag amounts.
  - The other eight touch different controls and combine freely.
- **Scripts:** the simulator and the end-to-end check force a set with `?bugs=...` in the shop URL.

## The bugs

| Bug | Page | What the shopper meets | Churn reason | How Churn Preventer catches it |
| --- | --- | --- | --- | --- |
| Dead button | Bag | Apply Coupon silently stops responding after the 3rd press | Poor user experience | Dead clicks, live |
| Ghost line | Bag | Remove leaves a bag line at quantity 0 (₹0), then stops responding | Poor user experience | Dead clicks live; the agent suggests a rule |
| Slow stock check | Product | Add to Bag waits 4 s for a stock check instead of 150 ms | Poor user experience | The agent proposes a speed rule on the request |
| Cart total | Bag | With 2+ items and SAVE10 applied, the total leaves out the last item | Price trust | Built-in rule, live |
| Quantity price | Bag | A line with quantity 2+ shows 100x its price; the totals agree with it | Price trust | Found later by a rule written afterwards; the agent can also find it |
| Shipping shock | Checkout | The bag says free delivery; checkout adds ₹499 delivery and handling | Shipping cost | The agent proposes a probe on the fee and a rule |
| Slow delivery | Product | The product page promises delivery in 9–12 days instead of 2–4 | Delivery time | The agent proposes a probe on the estimate and a rule |
| Returns hidden | Product | The Returns policy button does nothing | Returns hassle | Dead clicks, live |
| Support down | Checkout | Chat with us fails with a 503 and a JS error | Customer service | Error after a click, live |
| Sold-out picks | Bag | Picked for you suggests sold-out shoes; Quick add does nothing | Personalization | Dead clicks, live |
| Card declined | Checkout | Every card is declined, and Use another card does nothing | Declined card | Dead clicks, live |
| Checkout error | Checkout | Region Northeast fails at payment with a 500 and a JS error | Payment gateway | Error after a click and rage clicks, live |
| Slow bank | Checkout | Payment authorisation hangs 6.5 s, then the bank times out | Payment gateway | The agent proposes a speed rule on the request |

**Not covered:** competitor offers and discount-only shoppers. These are real churn reasons, but they are not page defects a session can show.
