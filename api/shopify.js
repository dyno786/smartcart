export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const { action, imageBase64, imageType, items, cartItems } = req.body;

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
              { type: 'text', text: `Extract all items from this image (shopping list, recipe, product label, or handwritten notes). Return ONLY valid JSON, no markdown:
{"items":[{"name":"product name","quantity":1,"unit":"pcs"}]}
Be specific. Quantity must be a number. Unit is optional. If no quantity visible use 1.` }
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
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.json({ items: parsed.items || [] });
    }

    // ── AI smart match: fetch all products then let Claude match ──
    if (action === 'smartMatch') {
      if (!SHOP_DOMAIN || !ADMIN_TOKEN) return res.status(500).json({ error: 'Shopify credentials not configured.' });
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured.' });

      // Fetch all active products including images
      const shopRes = await fetch(
        `https://${SHOP_DOMAIN}/admin/api/2024-10/products.json?limit=250&status=active&fields=id,title,variants,images`,
        { headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' } }
      );
      const shopData = await shopRes.json();
      const products = shopData.products || [];

      if (!products.length) return res.json({ matches: items.map(i => ({ name: i.name, found: false })) });

      const productList = products.map(p => ({
        id: p.id,
        title: p.title,
        variantId: p.variants?.[0]?.id,
        price: p.variants?.[0]?.price,
        image: p.images?.[0]?.src || null,
        available: p.variants?.[0]?.inventory_quantity > 0 || p.variants?.[0]?.inventory_management === null
      }));

      const productCatalogue = productList.map((p, i) => `${i}: ${p.title} £${p.price}`).join('\n');
      const itemList = items.map((item, i) => `${i}: ${item.name} (qty: ${item.quantity || 1})`).join('\n');

      const matchResp = await fetch('https://api.anthropic.com/v1/messages', {
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
            content: `You are a smart beauty & haircare shopping assistant. Match each item from a shopping list to the best product in this store catalogue.

SHOPPING LIST:
${itemList}

STORE PRODUCTS:
${productCatalogue}

Be flexible and intelligent with beauty/haircare products:
- Match by brand, product type, or key ingredients
- "leave in conditioner" matches "Cantu Leave-In Conditioning Cream"
- "shea butter" matches any shea butter product
- "curl cream" matches curl defining products
Only use -1 if genuinely nothing is related.

Return ONLY valid JSON, no markdown:
{"matches":[{"itemIndex":0,"productIndex":5},{"itemIndex":1,"productIndex":-1}]}`
          }]
        })
      });

      const matchData = await matchResp.json();
      const matchText = matchData.content.map(c => c.text || '').join('');
      const matchParsed = JSON.parse(matchText.replace(/```json|```/g, '').trim());

      const results = matchParsed.matches.map(m => {
        if (m.productIndex === -1 || m.productIndex === undefined) {
          return { name: items[m.itemIndex]?.name, found: false };
        }
        const product = productList[m.productIndex];
        if (!product) return { name: items[m.itemIndex]?.name, found: false };
        return {
          name: items[m.itemIndex]?.name,
          found: true,
          matchedTitle: product.title,
          variantId: product.variantId,
          price: product.price,
          image: product.image,
          available: product.available,
          quantity: items[m.itemIndex]?.quantity || 1
        };
      });

      return res.json({ matches: results });
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
