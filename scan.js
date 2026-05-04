export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { query, category } = req.body

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `You are an intelligence analyst monitoring AST SpaceMobile (ticker: ASTS).
Search the web for the latest updates. Return ONLY a raw JSON array with no markdown, no backticks, no preamble.
Each item must have:
- "summary": 1-2 specific sentences with concrete details (dates, numbers, names)
- "source": publication or source name
- "date": ISO date string if known, else null
Focus only on genuinely new, specific, factual updates from the last 60 days. Return [] if nothing found.`,
        messages: [{ role: 'user', content: query }],
      }),
    })

    const data = await response.json()

    let jsonText = ''
    for (const block of data.content || []) {
      if (block.type === 'text') jsonText += block.text
    }

    jsonText = jsonText.replace(/```json|```/g, '').trim()
    const startIdx = jsonText.indexOf('[')
    const endIdx = jsonText.lastIndexOf(']')
    if (startIdx === -1 || endIdx === -1) return res.status(200).json([])

    const parsed = JSON.parse(jsonText.slice(startIdx, endIdx + 1))
    const results = parsed.map((item, i) => ({
      id: `${category}-${Date.now()}-${i}`,
      category,
      summary: item.summary || '',
      source: item.source || '',
      timestamp: item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
    }))

    return res.status(200).json(results)
  } catch (err) {
    console.error('Scan error:', err)
    return res.status(500).json({ error: err.message })
  }
}
