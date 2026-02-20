const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =============================
// CONFIG
// =============================
const MAX_SUBJECT_RETRIES = 3;
const PROCESS_INTERVAL_MS = 6000; // 10 contacts per minute

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// =============================
// SIMPLE QUEUE
// =============================
let queue = [];
let processing = false;

// =============================
// HEALTH CHECK
// =============================
app.get("/", (req, res) => {
  res.json({ 
    status: "ok",
    queueLength: queue.length,
    processing: processing
  });
});

// =============================
// ENQUEUE FROM HUBSPOT
// =============================
app.post("/enqueue", (req, res) => {
  queue.push({ ...req.body, retries: 0 });
  res.status(200).json({ 
    status: "queued",
    queuePosition: queue.length
  });
});

// =============================
// WORKER LOOP
// =============================
setInterval(async () => {
  if (processing || queue.length === 0) return;

  processing = true;
  const job = queue.shift();

  try {
    await updateStatus(job.contactId, "IN_PROGRESS");

    const result = await runClaude(job);

    await writeResults(job.contactId, result, job.sequenceStep || 1);

    await updateStatus(job.contactId, "SENT");
    
    console.log(`✅ Completed: ${job.contactId} - Step ${job.sequenceStep}`);
  } catch (err) {
    console.error(`❌ Error for ${job.contactId}:`, err.message);
    
    if (err.response?.status === 429) {
      console.log(`⏳ Rate limited, requeuing ${job.contactId}`);
      queue.push(job);
    } else {
      job.retries++;

      if (job.retries <= 2) {
        await updateStatus(job.contactId, "RETRY_PENDING");
        queue.push(job);
      } else {
        await updateStatus(job.contactId, "FAILED");
      }
    }
  } finally {
    processing = false;
  }
}, PROCESS_INTERVAL_MS);

// =============================
// URL NORMALIZER (NEW)
// Fixes the "Invalid URL" errors by ensuring all URLs have a protocol
// =============================
function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  // Remove any accidental trailing slashes for consistent path building
  url = url.replace(/\/+$/, '');
  // Add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  // Validate by parsing
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

// =============================
// HTML STRIPPER
// =============================
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// =============================
// TITLE EXTRACTION (IMPROVED)
// - Validates URL before fetching
// - Extracts <title> and <h1>/<h2> tags directly (more reliable than regex on stripped text)
// - Falls back to year-adjacent text pattern
// =============================
async function extractTitles(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    console.log(`⚠️ Skipping invalid URL: ${url}`);
    return [];
  }

  try {
    const res = await axios.get(normalized, { 
      timeout: 7000,
      maxContentLength: 500000, // 500KB cap to avoid giant pages
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = res.data || '';

    // Strategy 1: Extract <h1> and <h2> headline text (most reliable for news/blog pages)
    const headlineMatches = [];
    const headingRegex = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length >= 20 && text.length <= 160) {
        headlineMatches.push(text);
      }
    }
    if (headlineMatches.length >= 2) {
      return headlineMatches.slice(0, 3);
    }

    // Strategy 2: Fallback — year-adjacent text on stripped page
    const text = stripHtml(html);
    const fallbackMatches = [...text.matchAll(/(.{25,120})\s+(20\d{2})/g)];
    return fallbackMatches.map(m => m[1].trim()).slice(0, 3);

  } catch (err) {
    // Provide a cleaner, more informative warning
    const reason = err.code === 'ECONNABORTED' ? 'timeout' 
      : err.response ? `HTTP ${err.response.status}` 
      : err.message;
    console.log(`⚠️ Could not fetch ${normalized}: ${reason}`);
    return [];
  }
}

// =============================
// COMPANY RESEARCH (IMPROVED)
// Tries multiple common paths and returns the best result
// =============================
async function getCompanyContent(website) {
  const baseUrl = normalizeUrl(website);
  if (!baseUrl) return { newsBlock: null, blogBlock: null };

  // Try these paths in order of priority
  const newsPaths = ['/news', '/press', '/newsroom', '/media', '/press-releases'];
  const blogPaths = ['/blog', '/insights', '/resources', '/articles', '/thought-leadership'];

  let newsBlock = null;
  let blogBlock = null;

  // Check news/press paths first
  for (const path of newsPaths) {
    const titles = await extractTitles(`${baseUrl}${path}`);
    if (titles.length >= 1) {
      newsBlock = `COMPANY NEWS & AWARDS (VERIFIED from ${baseUrl}${path}):\n` 
        + titles.map(t => `- ${t}`).join('\n');
      console.log(`📰 Found news at ${baseUrl}${path}`);
      break;
    }
  }

  // Check blog/insights paths
  for (const path of blogPaths) {
    const titles = await extractTitles(`${baseUrl}${path}`);
    if (titles.length >= 1) {
      blogBlock = `COMPANY BLOGS & PRESS (VERIFIED from ${baseUrl}${path}):\n`
        + titles.map(t => `- ${t}`).join('\n');
      console.log(`📝 Found blog at ${baseUrl}${path}`);
      break;
    }
  }

  return { newsBlock, blogBlock };
}

// =============================
// CLAUDE LOGIC
// =============================
async function runClaude(job) {
  const SEQUENCE_STEP = job.sequenceStep || 1;
  
  const safe = v => (v ?? "").toString().trim();

  const {
    firstname = '',
    company = '',
    jobtitle = '',
    industry = '',
    numemployees = '',
    annualrevenue = '',
    hs_linkedin_url = '',
    website = '',
    hs_intent_signals_enabled = '',
    web_technologies = '',
    description = ''
  } = job;

  const IntentContext =
    hs_intent_signals_enabled === "true"
      ? "Buyer intent signals are active for this account."
      : "Buyer intent signals are not active or unavailable.";

  // PRIOR EMAILS
  let priorEmailsText = [];
  for (let i = 1; i < SEQUENCE_STEP; i++) {
    const field = job[`claude_ai_generated_email_text_${i}`];
    if (field) priorEmailsText.push(`EMAIL ${i}:\n${field}`);
  }

  const priorEmailsBlock = priorEmailsText.length
    ? priorEmailsText.join("\n\n---\n\n")
    : "N/A";

  // =============================
  // NEWS & BLOG EXTRACTION (IMPROVED)
  // =============================
  const defaultNewsBlock = `COMPANY NEWS & AWARDS (VERIFIED):\n- None found`;
  const defaultBlogBlock = `COMPANY BLOGS & PRESS (VERIFIED):\n- None found`;

  let companyNewsBlock = defaultNewsBlock;
  let companyContentBlock = defaultBlogBlock;

  if (website) {
    try {
      const { newsBlock, blogBlock } = await getCompanyContent(website);
      if (newsBlock) companyNewsBlock = newsBlock;
      if (blogBlock) companyContentBlock = blogBlock;
    } catch (err) {
      console.log(`⚠️ Content extraction failed for ${company}: ${err.message}`);
    }
  }
  // =============================
  
  const userContent = `You are Jeff Pedowitz at The Pedowitz Group writing EMAIL ${SEQUENCE_STEP} in a long-form personalized outbound nurture (10 total touches).

PROSPECT DATA:
- Name: ${firstname}
- Title: ${jobtitle}
- Company: ${company}
- Industry: ${industry}
- Employee Count: ${numemployees}
- Annual Revenue: ${annualrevenue}
- LinkedIn: ${hs_linkedin_url}
- Website: ${website}
- Intent Signals: ${IntentContext}
- Web Technologies: ${web_technologies || "Not listed"}
- Company Description: ${description || "Not provided"}

${companyNewsBlock}
${companyContentBlock}

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

NEWS & AWARDS USAGE RULE (OPTIONAL):
- If the "COMPANY NEWS & AWARDS (VERIFIED)" section contains items:
  - Consider naturally referencing ONE of them in the email if relevant to your message.

BLOG / PRESS USAGE RULE (OPTIONAL):
- If the "COMPANY BLOGS & PRESS (VERIFIED)" section contains items:
  - Consider naturally referencing ONE by title if relevant to your message.

WRITE EMAIL ${SEQUENCE_STEP} WITH THESE REQUIREMENTS:

WRITE:
- Subject: ≤ 8 words and DIFFERENT from all prior subjects.
- Start with a salutation on its own line:
  "${firstname},"
- One blank line after salutation.
- Opening line MUST use a NEW rhetorical device not previously used.
- Body length: 75–100 words (maximum 125 words).
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

  let subject = "";
  let bodyText = "";
  let attempt = 0;

  while (attempt < MAX_SUBJECT_RETRIES && !subject) {
    attempt++;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        temperature: 0.7,
        system: 'You write long-sequence B2B nurture emails with strict non-repetition and genuine 1:1 personalization.',
        messages: [{ role: "user", content: userContent }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 30000
      }
    );

    const text =
      res.data?.content?.find(p => p.type === "text")?.text || "";

    const subjectMatch = text.match(/^\s*Subject:\s*(.+)\s*$/mi);
    const bodyMatch =
      text.match(/^\s*Body:\s*([\s\S]+)$/mi) ||
      text.match(/^\s*Subject:[\s\S]*?\n\n([\s\S]+)$/mi);

    subject = subjectMatch ? subjectMatch[1].trim().replace(/<[^>]+>/g, '') : "";
    bodyText = bodyMatch ? bodyMatch[1].trim() : "";
  }

  if (!subject) {
    throw new Error("Missing subject after retries");
  }

  return { subject, bodyText };
}

// =============================
// HUBSPOT WRITE-BACK
// =============================
async function writeResults(contactId, { subject, bodyText }, sequenceStep = 1) {
  const bodyHtml = bodyText
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 16px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    {
      properties: {
        [`prospect_email_${sequenceStep}_subject_line`]: subject,
        [`prospect_email_${sequenceStep}`]: bodyHtml,
        [`claude_ai_generated_email_text_${sequenceStep}`]: bodyText
      }
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    }
  );
}

// =============================
// STATUS UPDATE
// =============================
async function updateStatus(contactId, status) {
  try {
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: { ai_email_step_status: status } },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 5000
      }
    );
  } catch (err) {
    console.error(`Status update failed for ${contactId}:`, err.message);
  }
}

// =============================
// SERVER STARTUP
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Render worker running on port ${PORT}`);
  console.log(`📊 Processing: ${Math.floor(60000 / PROCESS_INTERVAL_MS)} contacts per minute`);
});
