# The demo shop's bugs

STRIDE, the demo shop, has 13 deliberate bugs. They cover the reasons shoppers most often abandon a store. The shop, its shoppers and every number in the demo are synthetic.

## How sessions get bugs

Every shopper's tab gets its bugs once and keeps them for the whole session (`apps/demo-shop/src/bugs.ts`):

- **The five crucial bugs are live in every session:** Slow bank (the payment gateway timeout), Checkout error, Card declined, Cart total and Shipping shock. They sit on the money path from the bag to payment.
- **The three payment bugs take turns,** so each one shows: the first Place Order hangs 6.5 s and the bank times out, the second is declined (and Use another card does nothing), and the third goes through to checkout, where an order from the Northeast region fails with a 500.
- **Each of the other bugs** is live with an even chance. Quantity price never runs alongside Cart total, since both rewrite the bag amounts, so it only appears when a script forces it.
- **Scripts:** the simulator and the end-to-end check force a set with `?bugs=...` in the shop URL. The simulator keeps clean shoppers, so revenue at risk still has a baseline to compare against.

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
| Card declined | Checkout | The card is declined, and Use another card does nothing (with Slow bank live: the try after the timeout) | Declined card | Dead clicks, live |
| Checkout error | Checkout | Region Northeast fails at payment with a 500 and a JS error | Payment gateway | Error after a click and rage clicks, live |
| Slow bank | Checkout | Payment authorisation hangs 6.5 s, then the bank times out (crucial: the payment gateway timeout) | Payment gateway | The agent proposes a speed rule on the request |

**Not covered:** competitor offers and discount-only shoppers. These are real churn reasons, but they are not page defects a session can show.
