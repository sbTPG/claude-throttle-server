const express = require('express');
const Bottleneck = require('bottleneck');

const app = express();
app.use(express.json());

// ============================================
// RATE LIMITER - 1 contact every 15 seconds
// ============================================
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 8000,    // 8 seconds between contacts
  reservoir: 8,      // 8 per minute
  reservoirRefreshAmount: 8,
  reservoirRefreshInterval: 60 * 1000
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Contact Throttle Service',
    rateLimit: '1 contact every 15 seconds (4 per minute)',
    queueSize: limiter.counts().QUEUED,
    running: limiter.counts().RUNNING
  });
});

// ============================================
// THROTTLE ENDPOINT
// ============================================
app.post('/throttle', async (req, res) => {
  const { contactId, contactEmail } = req.body;
  
  try {
    // Pass through the limiter (creates 15-second delay)
    await limiter.schedule(() => {
      return Promise.resolve({ 
        contactId, 
        contactEmail,
        timestamp: new Date().toISOString() 
      });
    });
    
    // Return success
    res.json({ 
      success: true,
      message: 'Contact throttled successfully',
      contactId,
      waitTime: '15 seconds'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚦 Throttle Server running on port ${PORT}`);
  console.log(`📊 Rate limit: 1 contact every 15 seconds (4 per minute)`);
});
