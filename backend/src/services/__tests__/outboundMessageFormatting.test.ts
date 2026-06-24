import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOutboundMessageText } from '../outboundMessageFormatting';

describe('sanitizeOutboundMessageText', () => {
  it('removes bold markers around a product name (double asterisk)', () => {
    assert.equal(
      sanitizeOutboundMessageText('Ju rekomandoj **Mass Gainer 3kg Qokolad** për shtim peshe.'),
      'Ju rekomandoj Mass Gainer 3kg Qokolad për shtim peshe.',
    );
  });

  it('removes single-asterisk (WhatsApp) bold around a product name', () => {
    assert.equal(
      sanitizeOutboundMessageText('Çmimi i *Mega Mass 3kg* është €55.'),
      'Çmimi i Mega Mass 3kg është €55.',
    );
  });

  it('removes underscore bold markers', () => {
    assert.equal(
      sanitizeOutboundMessageText('Produkti __Critical Mass__ kushton €68.'),
      'Produkti Critical Mass kushton €68.',
    );
  });

  it('does not touch a lone asterisk used as an operator', () => {
    assert.equal(sanitizeOutboundMessageText('2 * 3 = 6'), '2 * 3 = 6');
  });

  it('collapses multiple blank lines between sections to a single blank line', () => {
    const input = 'Rekomandimet:\n\n\n\nMass Gainer\n\n\nMega Mass';
    assert.equal(sanitizeOutboundMessageText(input), 'Rekomandimet:\n\nMass Gainer\n\nMega Mass');
  });

  it('treats whitespace-only lines as blank and collapses them', () => {
    const input = 'Linja 1\n   \n\t\nLinja 2';
    assert.equal(sanitizeOutboundMessageText(input), 'Linja 1\n\nLinja 2');
  });

  it('trims trailing whitespace and leading/trailing blank lines', () => {
    assert.equal(sanitizeOutboundMessageText('\n\nPershendetje   \n\n'), 'Pershendetje');
  });

  it('preserves a single blank line between paragraphs (order confirmation layout)', () => {
    const input =
      'Porosia u konfirmua!\n\nProdukti do të mbërrijë brenda 24 orëve.\n\nFaleminderit!';
    assert.equal(sanitizeOutboundMessageText(input), input);
  });

  it('handles multiple bold segments in one message', () => {
    assert.equal(
      sanitizeOutboundMessageText('**Mass Gainer** dhe **Mega Mass** janë në dispozicion.'),
      'Mass Gainer dhe Mega Mass janë në dispozicion.',
    );
  });

  it('strips a leading dash-space bullet from a product name line', () => {
    assert.equal(
      sanitizeOutboundMessageText('Disa prej tyre janë:\n- Creatine Monohydrate\n- Applied Nutrition Creatine 250gr'),
      'Disa prej tyre janë:\nCreatine Monohydrate\nApplied Nutrition Creatine 250gr',
    );
  });

  it('strips leading bullet (•) and middle-dot (·) markers from lines', () => {
    assert.equal(
      sanitizeOutboundMessageText('• Mass Gainer\n· Mega Mass'),
      'Mass Gainer\nMega Mass',
    );
  });

  it('does not strip a hyphen that is part of a product name (no trailing space)', () => {
    assert.equal(
      sanitizeOutboundMessageText('N-Acetyl Cysteine\n-Creatine'),
      'N-Acetyl Cysteine\n-Creatine',
    );
  });

  it('strips dash bullets even when blank lines separate list items', () => {
    assert.equal(
      sanitizeOutboundMessageText('- Mass Gainer\n\n- Mega Mass'),
      'Mass Gainer\n\nMega Mass',
    );
  });

  it('returns empty / falsy input unchanged', () => {
    assert.equal(sanitizeOutboundMessageText(''), '');
  });
});
