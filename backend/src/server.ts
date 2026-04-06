import 'dotenv/config';
import app from './app';

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  console.log(`[server] Running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
