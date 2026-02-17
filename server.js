require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/database');
const { initializeSocket } = require('./socket/socketHandler');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const callRoutes = require('./routes/call');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*', // Configure this for production
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds - send ping every 25 seconds
  transports: ['websocket', 'polling'], // Allow both transports
});

// Initialize Socket handlers
initializeSocket(io);

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/call', callRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  const { isFirebaseInitialized, initializeFirebase } = require('./config/firebase');
  
  // Try to initialize Firebase if not already initialized
  const firebaseAdmin = initializeFirebase();
  
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let jsonPreview = '';
  let jsonError = null;
  
  if (envJson) {
    try {
      const trimmed = envJson.trim();
      const cleaned = (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed;
      const parsed = JSON.parse(cleaned);
      jsonPreview = `Valid JSON (project_id: ${parsed.project_id || 'missing'})`;
    } catch (err) {
      jsonError = err.message;
      jsonPreview = `Invalid JSON: ${err.message.substring(0, 100)}`;
    }
  }
  
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    firebase: {
      initialized: isFirebaseInitialized(),
      hasAdmin: !!firebaseAdmin,
      envPath: !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
      envJson: !!envJson,
      envJsonLength: envJson ? envJson.length : 0,
      jsonPreview: jsonPreview || 'No JSON set',
      jsonError: jsonError || null,
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
  server.close(() => {
    process.exit(1);
  });
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});

module.exports = { app, server, io };

