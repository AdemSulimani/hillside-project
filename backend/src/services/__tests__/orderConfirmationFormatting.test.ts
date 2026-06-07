import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderConfirmationDeliveryLine,
  ensureOrderConfirmationDeliveryAndFollowUp,
  stripModelDeliveryEtaMentions,
  textContainsCanonicalDeliveryEta,
} from '../orderConfirmationFormatting';

const ORDER_FOLLOW_UP_SQ =
  'Nëse keni ndonjë pyetje tjetër apo dëshironi të porosisni diçka tjetër, jam këtu për t’ju ndihmuar.';

describe('orderConfirmationFormatting', () => {
  it('strips embedded Albanian delivery ETA from model confirmation text', () => {
    const input =
      'Porosia juaj është konfirmuar dhe do të dorëzohet brenda 24 orëve.';
    const stripped = stripModelDeliveryEtaMentions(input);
    assert.equal(stripped, 'Porosia juaj është konfirmuar');
  });

  it('strips embedded English delivery ETA from model confirmation text', () => {
    const input = 'Your order is confirmed and will be delivered within 48 hours.';
    const stripped = stripModelDeliveryEtaMentions(input);
    assert.equal(stripped, 'Your order is confirmed');
  });

  it('does not strip the canonical platform delivery line', () => {
    const canonical = buildOrderConfirmationDeliveryLine('24h', 'sq');
    const input = `Porosia juaj është konfirmuar.\n\n${canonical}`;
    const stripped = stripModelDeliveryEtaMentions(input, canonical);
    assert.ok(stripped.includes(canonical));
  });

  it('removes duplicate delivery ETA and keeps one canonical line at the end', () => {
    const deliveryLine = buildOrderConfirmationDeliveryLine('24h', 'sq');
    const modelReply =
      'Porosia juaj është konfirmuar dhe do të dorëzohet brenda 24 orëve. Nëse keni ndonjë pyetje tjetër apo dëshironi të porosisni diçka tjetër, jam këtu për t’ju ndihmuar.';

    const result = ensureOrderConfirmationDeliveryAndFollowUp(
      modelReply,
      deliveryLine,
      ORDER_FOLLOW_UP_SQ,
    );

    assert.ok(!/dorëzohet brenda 24 orëve/i.test(result));
    assert.equal(textContainsCanonicalDeliveryEta(result, deliveryLine), true);
    assert.ok(result.includes(ORDER_FOLLOW_UP_SQ));
    assert.match(result, /Produkti do të mbërrijë brenda 24 orëve/);
  });

  it('appends delivery line and follow-up when model omits both', () => {
    const deliveryLine = buildOrderConfirmationDeliveryLine('24h', 'sq');
    const modelReply = 'Porosia juaj për Mega Mass 3kg Vanil është konfirmuar.';

    const result = ensureOrderConfirmationDeliveryAndFollowUp(
      modelReply,
      deliveryLine,
      ORDER_FOLLOW_UP_SQ,
    );

    assert.match(result, /^Porosia juaj për Mega Mass 3kg Vanil është konfirmuar\./);
    assert.ok(result.includes(deliveryLine));
    assert.ok(result.includes(ORDER_FOLLOW_UP_SQ));
    assert.equal((result.match(/brenda 24 orëve/gi) ?? []).length, 1);
  });
});
