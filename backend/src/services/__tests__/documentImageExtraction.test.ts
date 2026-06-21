import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {
  extractedDataToProductInput,
  type ExtractedProductData,
} from '../documents/AttachDocumentService';
import { AttachSpreadsheetService } from '../documents/AttachSpreadsheetService';
import { AttachPdfService } from '../documents/AttachPdfService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an xlsx Buffer from an array of plain objects (one sheet). */
function makeXlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** Subclass that exposes the protected extractProducts method for unit tests. */
class TestablePdfService extends AttachPdfService {
  public parseText(text: string) {
    return this.extractProducts(text);
  }
}

// ---------------------------------------------------------------------------
// extractedDataToProductInput — image_urls passthrough
// ---------------------------------------------------------------------------

describe('extractedDataToProductInput — image_urls', () => {
  const TENANT = 'tenant-1';
  const SOURCE = 'spreadsheet' as const;

  it('passes valid http and https image URLs through to the product input', () => {
    const data: ExtractedProductData = {
      name: 'Test Product',
      price: 10,
      image_urls: [
        'https://cdn.example.com/product.jpg',
        'http://files.example.com/img.png',
      ],
    };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.deepEqual(input.image_urls, [
      'https://cdn.example.com/product.jpg',
      'http://files.example.com/img.png',
    ]);
  });

  it('strips invalid / non-http entries and omits image_urls when none survive', () => {
    const data: ExtractedProductData = {
      name: 'Test Product',
      price: 10,
      image_urls: ['not-a-url', 'ftp://invalid.com/img.jpg', ''],
    };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.equal(input.image_urls, undefined);
  });

  it('filters out invalid entries but keeps valid ones in a mixed list', () => {
    const data: ExtractedProductData = {
      name: 'Test Product',
      price: 10,
      image_urls: ['not-a-url', 'https://cdn.example.com/good.jpg', ''],
    };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.deepEqual(input.image_urls, ['https://cdn.example.com/good.jpg']);
  });

  it('leaves image_urls undefined when the field is absent from extracted data', () => {
    const data: ExtractedProductData = { name: 'Test Product', price: 10 };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.equal(input.image_urls, undefined);
  });

  it('leaves image_urls undefined when the array is empty', () => {
    const data: ExtractedProductData = { name: 'Test Product', price: 10, image_urls: [] };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.equal(input.image_urls, undefined);
  });

  it('accepts CDN URLs without a file extension', () => {
    const data: ExtractedProductData = {
      name: 'Test Product',
      price: 10,
      image_urls: ['https://res.cloudinary.com/demo/image/upload/v1234/product'],
    };
    const input = extractedDataToProductInput(TENANT, data, SOURCE, '', {});
    assert.deepEqual(input.image_urls, [
      'https://res.cloudinary.com/demo/image/upload/v1234/product',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AttachSpreadsheetService — image column detection
// ---------------------------------------------------------------------------

describe('AttachSpreadsheetService — image column extraction', () => {
  const svc = new AttachSpreadsheetService('tenant-1');

  it('extracts a single image URL from an "image_url" column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Alpha Whey', price: 29.99, image_url: 'https://cdn.example.com/alpha.jpg' },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/alpha.jpg']);
  });

  it('extracts a single image URL from an "image" column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Beta Mass', price: 49.99, image: 'https://cdn.example.com/beta.png' },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/beta.png']);
  });

  it('extracts a single image URL from a "photo" column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Gamma Creatine', price: 19.99, photo: 'https://cdn.example.com/gamma.jpg' },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/gamma.jpg']);
  });

  it('extracts a single image URL from a "photo_url" column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Delta Pre', price: 34.99, photo_url: 'https://cdn.example.com/delta.webp' },
    ]);
    const { products } = await svc.parse(buf);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/delta.webp']);
  });

  it('extracts a single image URL from a "thumbnail" column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Epsilon BCAA', price: 24.99, thumbnail: 'https://cdn.example.com/epsilon.jpg' },
    ]);
    const { products } = await svc.parse(buf);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/epsilon.jpg']);
  });

  it('splits comma-separated URLs in a single cell into multiple image_urls', async () => {
    const buf = makeXlsxBuffer([
      {
        name: 'Multi-Photo Product',
        price: 59.99,
        image_url:
          'https://cdn.example.com/front.jpg,https://cdn.example.com/back.jpg,https://cdn.example.com/side.jpg',
      },
    ]);
    const { products } = await svc.parse(buf);
    assert.deepEqual(products[0].image_urls, [
      'https://cdn.example.com/front.jpg',
      'https://cdn.example.com/back.jpg',
      'https://cdn.example.com/side.jpg',
    ]);
  });

  it('splits semicolon-separated URLs in a single cell', async () => {
    const buf = makeXlsxBuffer([
      {
        name: 'Semi Product',
        price: 15.99,
        image_url:
          'https://cdn.example.com/a.jpg;https://cdn.example.com/b.png',
      },
    ]);
    const { products } = await svc.parse(buf);
    assert.deepEqual(products[0].image_urls, [
      'https://cdn.example.com/a.jpg',
      'https://cdn.example.com/b.png',
    ]);
  });

  it('ignores invalid (non-http) values in the image column', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Bad URL Product', price: 9.99, image_url: 'not-a-url' },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products[0].image_urls, undefined);
  });

  it('leaves image_urls undefined when the image column cell is empty', async () => {
    const buf = makeXlsxBuffer([
      { name: 'No Image Product', price: 9.99, image_url: '' },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products[0].image_urls, undefined);
  });

  it('leaves image_urls undefined when no image column is present', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Plain Product', price: 9.99 },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products[0].image_urls, undefined);
  });

  it('extracts all other existing fields alongside image_url', async () => {
    const buf = makeXlsxBuffer([
      {
        name: 'Full Product',
        brand: 'BrandX',
        price: 39.99,
        discounted_price: 29.99,
        sku: 'SKU-001',
        category: 'Protein',
        image_url: 'https://cdn.example.com/full.jpg',
      },
    ]);
    const { products } = await svc.parse(buf);
    const p = products[0];
    assert.equal(p.name, 'Full Product');
    assert.equal(p.brand, 'BrandX');
    assert.equal(p.price, 39.99);
    assert.equal(p.discounted_price, 29.99);
    assert.equal(p.sku, 'SKU-001');
    assert.equal(p.category, 'Protein');
    assert.deepEqual(p.image_urls, ['https://cdn.example.com/full.jpg']);
  });

  it('handles multiple rows each with their own image URL', async () => {
    const buf = makeXlsxBuffer([
      { name: 'Product A', price: 10, image_url: 'https://cdn.example.com/a.jpg' },
      { name: 'Product B', price: 20, image_url: 'https://cdn.example.com/b.png' },
      { name: 'Product C', price: 30 },
    ]);
    const { products } = await svc.parse(buf);
    assert.equal(products.length, 3);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/a.jpg']);
    assert.deepEqual(products[1].image_urls, ['https://cdn.example.com/b.png']);
    assert.equal(products[2].image_urls, undefined);
  });

  it('accepts Cloudinary URLs without a file extension', async () => {
    const buf = makeXlsxBuffer([
      {
        name: 'Cloudinary Product',
        price: 19.99,
        image_url: 'https://res.cloudinary.com/demo/image/upload/v1/product',
      },
    ]);
    const { products } = await svc.parse(buf);
    assert.deepEqual(products[0].image_urls, [
      'https://res.cloudinary.com/demo/image/upload/v1/product',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AttachPdfService — image URL extraction from text
// ---------------------------------------------------------------------------

describe('AttachPdfService — image URL extraction from text', () => {
  const svc = new TestablePdfService('tenant-1');

  it('extracts an image URL that appears on a standalone line after the product', () => {
    const text = [
      'Alpha Whey $29.99',
      'https://cdn.example.com/alpha.jpg',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/alpha.jpg']);
  });

  it('extracts an image URL embedded in a description line', () => {
    const text = [
      'Beta Mass $49.99',
      'High quality mass gainer. https://cdn.example.com/beta.png Excellent product.',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/beta.png']);
    assert.ok(products[0].description?.includes('High quality mass gainer.'));
    assert.ok(products[0].description?.includes('Excellent product.'));
  });

  it('ignores bare http URLs without an image extension', () => {
    const text = [
      'Gamma Pre $19.99',
      'See more at https://www.example.com/products',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.equal(products[0].image_urls, undefined);
    assert.ok(products[0].description?.includes('See more at'));
  });

  it('supports .png, .jpg, .jpeg, .webp, .gif, and .svg extensions', () => {
    const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
    for (const ext of extensions) {
      const text = [
        `Product ${ext.toUpperCase()} $9.99`,
        `https://cdn.example.com/img.${ext}`,
      ].join('\n');
      const products = svc.parseText(text);
      assert.equal(products.length, 1, `expected 1 product for .${ext}`);
      assert.deepEqual(
        products[0].image_urls,
        [`https://cdn.example.com/img.${ext}`],
        `expected image_urls to contain the .${ext} URL`,
      );
    }
  });

  it('handles image URLs with query-string parameters', () => {
    const text = [
      'Delta Creatine $14.99',
      'https://cdn.example.com/delta.jpg?v=2&w=800',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, [
      'https://cdn.example.com/delta.jpg?v=2&w=800',
    ]);
  });

  it('accumulates multiple image URLs for the same product', () => {
    const text = [
      'Epsilon BCAA $24.99',
      'https://cdn.example.com/front.jpg',
      'https://cdn.example.com/back.png',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, [
      'https://cdn.example.com/front.jpg',
      'https://cdn.example.com/back.png',
    ]);
  });

  it('assigns image URLs to the correct product in a multi-product document', () => {
    const text = [
      'Whey Protein $29.99',
      'Best protein powder.',
      'https://cdn.example.com/whey.jpg',
      'Creatine Mono $14.99',
      'Pure creatine monohydrate.',
      'https://cdn.example.com/creatine.png',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 2);
    assert.equal(products[0].name, 'Whey Protein');
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/whey.jpg']);
    assert.equal(products[1].name, 'Creatine Mono');
    assert.deepEqual(products[1].image_urls, ['https://cdn.example.com/creatine.png']);
  });

  it('does not set image_urls when no image URLs are present', () => {
    const text = [
      'Plain Product $9.99',
      'Just a description with no images.',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.equal(products[0].image_urls, undefined);
  });

  it('leaves description intact when only an image URL line is present', () => {
    const text = [
      'Icon Product $5.99',
      'https://cdn.example.com/icon.jpg',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    assert.deepEqual(products[0].image_urls, ['https://cdn.example.com/icon.jpg']);
    // The URL-only line should not pollute description
    assert.equal(products[0].description, undefined);
  });

  it('does not extract image URLs for a product before the first price line', () => {
    // URLs appearing before any price line are outside any current product context
    const text = [
      'https://cdn.example.com/orphan.jpg',
      'Alpha Whey $29.99',
      'Good protein.',
    ].join('\n');
    const products = svc.parseText(text);
    assert.equal(products.length, 1);
    // The orphan URL was not attached to any product
    assert.equal(products[0].image_urls, undefined);
  });
});
