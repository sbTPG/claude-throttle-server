const express = require('express');
const axios = require('axios');
const Bottleneck = require('bottleneck');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ============================================
// RATE LIMITER CONFIGURATION
// ============================================
// Tier 1: 50 requests per minute
// Adjust these if you upgrade to Tier 2+
const limiter = new Bottleneck({
  maxConcurrent: 1, // Process one at a time
  minTime: 1200,    // 1.2 seconds between requests = 50/min
  reservoir: 50,    // Start with 50 tokens
  reservoirRefreshAmount: 50, // Refill to 50
  reservoirRefreshInterval: 60 * 1000 // Every 60 seconds
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Claude Throttle Middleware',
    currentJobs: limiter.counts()
  });
});

// ============================================
// MAIN CLAUDE PROXY ENDPOINT
// ============================================
app.post('/generate-email', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Extract data from HubSpot
    const {
      sequenceStep,
      existingSubject,
      existingBodyText,
      contactData,
      priorEmails,
      priorSubjects,
      anthropicApiKey
    } = req.body;

    // Validate required fields
    if (!anthropicApiKey) {
      return res.status(400).json({ error: 'Missing anthropicApiKey' });
    }
    if (!contactData) {
      return res.status(400).json({ error: 'Missing contactData' });
    }

    // Build the prompt (same as your current code)
    const userContent = buildPrompt(sequenceStep, contactData, priorEmails, priorSubjects);

    // Use rate limiter to call Claude
    const result = await limiter.schedule(() => 
      callClaude(userContent, anthropicApiKey, sequenceStep)
    );

    // Return success
    res.json({
      success: true,
      subject: result.subject,
      bodyHtml: result.bodyHtml,
      bodyText: result.bodyText,
      processingTime: Date.now() - startTime
    });

  } catch (error) {
    console.error('Error:', error.message);
    
    // Handle rate limit errors
    if (error.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: error.response.headers['retry-after'] || 60
      });
    }

    res.status(500).json({ 
      error: error.message,
      processingTime: Date.now() - startTime
    });
  }
});

// ============================================
// CLAUDE API CALL FUNCTION
// ============================================
async function callClaude(userContent, apiKey, sequenceStep) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      temperature: 0.7,
      system: 'You write long-sequence B2B nurture emails with strict non-repetition and genuine 1:1 personalization.',
      messages: [{ role: 'user', content: userContent }]
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 30000
    }
  );

  const textBlock = (response.data?.content || [])
    .find(p => p.type === 'text')?.text || '';

  // Parse subject
  const subjectMatch = textBlock.match(/^\s*Subject:\s*(.+)\s*$/mi);
  const subject = (subjectMatch ? subjectMatch[1] : '').trim().replace(/<[^>]+>/g, '');

  // Parse body
  const bodyMatch = textBlock.match(/^\s*Body:\s*([\s\S]+)$/mi) ||
                    textBlock.match(/^\s*Subject:[\s\S]*?\n\n([\s\S]+)$/mi);
  const bodyText = (bodyMatch ? bodyMatch[1] : '').trim();

  // Convert to HTML
  const bodyHtml = bodyText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return { subject, bodyHtml, bodyText };
}

// ============================================
// PROMPT BUILDER (Your existing logic)
// ============================================
function buildPrompt(sequenceStep, contactData, priorEmails, priorSubjects) {
  const {
    firstName = '',
    company = '',
    jobTitle = '',
    industry = '',
    numEmployees = '',
    annualRevenue = '',
    linkedin = '',
    website = '',
    intentSignals = '',
    webTechnologies = '',
    companyDescription = ''
  } = contactData;

  const intentContext = intentSignals === 'true'
    ? 'Buyer intent signals are active for this account.'
    : 'Buyer intent signals are not active or unavailable.';

  const priorEmailsBlock = priorEmails && priorEmails.length
    ? priorEmails.map((email, i) => `EMAIL ${i + 1}:\n${email}`).join('\n\n---\n\n')
    : 'N/A';

  const priorSubjectsBlock = priorSubjects && priorSubjects.length
    ? priorSubjects.map((s, i) => `SUBJECT ${i + 1}: ${s}`).join('\n')
    : 'N/A';

  return `You are Jeff Pedowitz at The Pedowitz Group writing EMAIL ${sequenceStep} in a long-form personalized outbound nurture (10 total touches).

PROSPECT DATA:
- Name: ${firstName}
- Title: ${jobTitle}
- Company: ${company}
- Industry: ${industry}
- Employee Count: ${numEmployees}
- Annual Revenue: ${annualRevenue}
- LinkedIn: ${linkedin}
- Website: ${website}
- Intent Signals: ${intentContext}
- Web Technologies: ${webTechnologies || 'Not listed'}
- Company Description: ${companyDescription || 'Not provided'}

PRIOR EMAILS — BACKGROUND CONTEXT ONLY:
Everything below has ALREADY been sent to this contact.
${priorEmailsBlock}

ABSOLUTE NON-REPETITION RULES (HARD FAIL CONDITIONS):
- You MUST NOT repeat any idea, insight, pain point, example, framing, or analogy used in ANY prior email.
- You MUST NOT reuse sentence structure, paragraph structure, or opening style from prior emails.
- You MUST introduce a NEW perspective that advances the conversation.
- If similarity to ANY prior email exceeds a minimal level, the response is INVALID.

SUBJECT LINE NON-REPETITION REQUIREMENTS (HARD RULE):
- The subject line MUST be entirely unique and clearly distinct from all prior subject lines.
- You MUST NOT reuse, closely paraphrase, or slightly modify previous subject lines.
- If the subject line is semantically or structurally similar to any prior subject, the response is INVALID.

PRIOR SUBJECT LINES (DO NOT REUSE OR PARAPHRASE):
${priorSubjectsBlock}

WRITE EMAIL ${sequenceStep} WITH THESE REQUIREMENTS:

WRITE:
- Subject: ≤ 8 words and DIFFERENT from all prior subjects.
- Start with a salutation on its own line:
  "${firstName},"
- One blank line after salutation.
- Opening line MUST use a NEW rhetorical device not previously used.
- Body length: 120–160 words.
- Each paragraph separated by ONE blank line.
- No bullets. No signature.
- Return HTML-safe text.
- Use <a> tags only for links. No other HTML.

MESSAGING STRATEGY:
- Do NOT assume HubSpot usage.
- Reference HubSpot as a platform companies in their industry leverage.
- Position The Pedowitz Group as HubSpot Elite Partners and revenue marketing experts.
- Choose a PROBLEM DOMAIN NOT USED PREVIOUSLY
  (examples: forecasting accuracy, RevOps governance, attribution trust, data hygiene, lifecycle alignment, scale readiness).

PERSONALIZATION & 1:1 OUTREACH REQUIREMENTS (MANDATORY):
- The email MUST read like a true 1:1 sales outreach, not a marketing broadcast.
- Incorporate at least ONE specific, concrete reference to the prospect or their company using the research data provided.
- If recent news exists in research:
  - Acknowledge it naturally in 1–2 sentences.
- If no clear news:
  - Use role-specific and company-contextual personalization based on research findings.
- Personalization should feel earned, subtle, and woven into the narrative — not bolted on as a separate paragraph.
- Emails that feel templated, generic, or broadly applicable to multiple companies are INVALID.

LINKED CONTENT REQUIREMENTS:
- Include ONE paragraph with exactly ONE single-word hyperlink using this format:
  <a href="URL" style="font-weight:bold;text-decoration:underline;color:#A2CF23;">word</a>
- Randomly choose ONE:
  * https://www.pedowitzgroup.com/hubspot-main
  * https://www.pedowitzgroup.com/hubspot-move-it
  * https://www.pedowitzgroup.com/hubspot-tune-it
  * https://www.pedowitzgroup.com/hubspot-run-it
  * https://www.pedowitzgroup.com/solutions/martech/hubSpot
- Include ONE separate paragraph with a calendar CTA using:
  <a href="https://meetings.hubspot.com/jeff-pedowitz" style="font-weight:bold;text-decoration:underline;color:#A2CF23;">word</a>

COMPLIANCE:
- No dollar amounts unless public.
- No fabricated company news.
- Speak to industry patterns when specifics are unknown.

OUTPUT FORMAT (exactly):
Subject: <subject>

Body:
<body>`;
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Claude Throttle Server running on port ${PORT}`);
  console.log(`📊 Rate limit: 50 requests/minute (Tier 1)`);
});
