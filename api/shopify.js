export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!SHOP_DOMAIN || !ADMIN_TOKEN) {
    return res.status(500).json({ error: 'Shopify credentials not configured on server.' });
  }

  const { action, query, cartItems } = req.body;

  try {
    // ── Search products ──
    if (action === 'search') {
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

    // ── Create cart (draft order) ──
    if (action === 'createCart') {
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
