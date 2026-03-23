export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const { action, imageBase64, imageType, query, cartItems } = req.body;

  try {

    // ── Analyse image with Claude ──
    if (action === 'analyse') {
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured.' });
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: imageType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: `Extract all items from this shopping list or recipe image. Return ONLY valid JSON, no markdown fences, no preamble:
{"items":[{"name":"product name","quantity":1,"unit":"pcs"}]}
Be specific with names (e.g. "semi-skimmed milk" not just "milk"). Quantity must be a number. Unit is optional (pcs, kg, g, ml, loaf, bunch, etc). If no quantity visible use 1.` }
            ]
          }]
        })
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e?.error?.message || `Anthropic error ${resp.status}`);
      }
      const data = await resp.json();
      const text = data.content.map(c => c.text || '').join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return res.json({ items: parsed.items || [] });
    }

    // ── Search products in Shopify ──
    if (action === 'search') {
      if (!SHOP_DOMAIN || !ADMIN_TOKEN) return res.status(500).json({ error: 'Shopify credentials not configured.' });
      const searchRes = await fetch(
        `https://${SHOP_DOMAIN}/admin/api/2024-10/products.json?title=${encodeURIComponent(query)}&limit=1&status=active`,
        { headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' } }
      );
      const data = await searchRes.json();
      const product = data.products?.[0];
      if (!product) return res.json({ found: false });
      const variant = product.variants?.[0];
      return res.json({
        found: true,
        productId: product.id,
        title: product.title,
        variantId: variant?.id,
        price: variant?.price,
        available: variant?.inventory_quantity > 0 || variant?.inventory_management === null
      });
    }

    // ── Create draft order (cart) ──
    if (action === 'createCart') {
      if (!SHOP_DOMAIN || !ADMIN_TOKEN) return res.status(500).json({ error: 'Shopify credentials not configured.' });
      const lineItems = cartItems.map(item => ({
        variant_id: item.variantId,
        quantity: item.quantity || 1
      }));
      const draftRes = await fetch(
        `https://${SHOP_DOMAIN}/admin/api/2024-10/draft_orders.json`,
        {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_order: { line_items: lineItems } })
        }
      );
      const draftData = await draftRes.json();
      const draft = draftData.draft_order;
      if (!draft) throw new Error(JSON.stringify(draftData));
      return res.json({ success: true, checkoutUrl: draft.invoice_url, orderId: draft.id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
