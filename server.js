import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = process.env.APP_VERSION || 'dev';

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from Railway!',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
