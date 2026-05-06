export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { query, category } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `You are an intelligence analyst monitoring AST SpaceMobile (ticker: ASTS). Search the web for the latest updates. Reply with NOTHING but a single JSON array of alert objects. No preamble, no markdown, no code fences. First character must be [, last must be ]. Each object must have: "summary" (1-2 specific sentences), "source" (publication name), "category" (one of: news, stock, fcc, legal, launch, satellite, people, partners), "date" (ISO string or null). Focus on updates from the last 7 days. Return [] if nothing found.`,
        messages: [{ role: 'user', content: query }],
      }),
    });

    const data = await response.json();
    let jsonText = '';
    for (const block of data.content || []) {
      if (block.type === 'text') jsonText += block.text;
    }
    jsonText = jsonText.replace(/```json|```/g, '').trim();
    const startIdx = jsonText.indexOf('[');
    const endIdx = jsonText.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) return res.json([]);
    const parsed = JSON.parse(jsonText.slice(startIdx, endIdx + 1));
    return res.json(parsed.map((item, i) => ({
      ...item,
      category,
      id: `${category}-${Date.now()}-${i}`,
      timestamp: item.date ? new Date(item.date) : new Date(),
    })));
  } catch (e) {
    console.error('Scan error:', e);
    return res.json([]);
  }
}
