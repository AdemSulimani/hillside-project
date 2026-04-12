import 'dotenv/config';
import http from 'http';
import app from './app';
import './jobs/workers';
import { initSocketServer } from './sockets';

const PORT = parseInt(process.env.PORT || '3000', 10);

const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[server] Running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
