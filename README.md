# Chat Backend Application

A complete chat backend application built with Node.js, Express, MongoDB, and Socket.io for real-time messaging.

## Features

- **Authentication**: Mobile number-based OTP authentication (Twilio)
- **JWT Tokens**: Access and refresh token implementation
- **Chat List**: Get all chats for logged-in user
- **User Search**: Search users by mobile number with `inDatabase` flag
- **Real-time Chat**: One-to-one messaging using Socket.io
- **Message History**: Fetch chat messages with pagination
- **Voice/Video Calls**: WebRTC audio/video with Socket.io signaling (see [WEBRTC_CALLING_GUIDE.md](WEBRTC_CALLING_GUIDE.md)); [FRONTEND_CALL_AND_PUSH_GUIDE.md](FRONTEND_CALL_AND_PUSH_GUIDE.md) for full frontend implementation and call push)
- **Push Notifications**: Firebase Cloud Messaging (FCM) for new message alerts (see [PUSH_NOTIFICATIONS_FCM.md](PUSH_NOTIFICATIONS_FCM.md))

## Prerequisites

- Node.js (v14 or higher)
- MongoDB Atlas account (or local MongoDB)
- npm or yarn

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/chat-app?retryWrites=true&w=majority
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_REFRESH_SECRET=your-super-secret-refresh-jwt-key-change-this-in-production
JWT_EXPIRE=15m
JWT_REFRESH_EXPIRE=7d
PORT=3000
NODE_ENV=development

# Twilio Configuration (for OTP SMS)
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
TWILIO_VERIFY_SERVICE_SID=your_twilio_verify_service_sid_here

# Optional: WebRTC (STUN/TURN for calls). Dev often works with STUN only.
WEBRTC_STUN_URL=stun:stun.l.google.com:19302
# Production: add TURN for better connectivity (e.g. Twilio TURN or coturn)
# WEBRTC_TURN_URL=turn:your-turn.example.com:3478
# WEBRTC_TURN_USERNAME=user
# WEBRTC_TURN_CREDENTIAL=secret

# Optional: Firebase (for push notifications)
FIREBASE_SERVICE_ACCOUNT_PATH=./path/to/serviceAccountKey.json
# OR: FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...} (base64 or raw JSON)
```

4. Start the server:
```bash
# Development mode (with nodemon)
npm run dev

# Production mode
npm start
```

## API Endpoints

### Authentication

#### 1. Send OTP
**POST** `/api/auth/send-otp`

Request body:
```json
{
  "mobileNumber": "1234567890"
}
```

Response:
```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

#### 2. Verify OTP and Login
**POST** `/api/auth/verify-otp`

Request body:
```json
{
  "mobileNumber": "1234567890",
  "otp": "123456"
}
```

Response:
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "_id": "user_id",
      "mobileNumber": "1234567890",
      "name": "User 1234567890",
      "profilePicture": ""
    },
    "accessToken": "jwt_access_token",
    "refreshToken": "jwt_refresh_token"
  }
}
```

#### 3. Refresh Access Token
**POST** `/api/auth/refresh-token`

Request body:
```json
{
  "refreshToken": "jwt_refresh_token"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "accessToken": "new_jwt_access_token"
  }
}
```

#### 4. Logout
**POST** `/api/auth/logout`

Headers:
```
Authorization: Bearer <access_token>
```

Response:
```json
{
  "success": true,
  "message": "Logout successful"
}
```

#### 5. Save FCM Token (Push Notifications)
**POST** `/api/auth/fcm-token`

Headers:
```
Authorization: Bearer <access_token>
```

Request body:
```json
{
  "fcmToken": "fcm_device_token_from_firebase"
}
```

Response:
```json
{
  "success": true,
  "message": "FCM token saved successfully"
}
```

#### 6. Get Current User Profile
**GET** `/api/auth/me`

Headers:
```
Authorization: Bearer <access_token>
```

Response:
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "user_id",
      "mobileNumber": "1234567890",
      "name": "User 1234567890",
      "profilePicture": ""
    }
  }
}
```

### Chat

#### 1. Get Chat List
**GET** `/api/chat/list`

Headers:
```
Authorization: Bearer <access_token>
```

Response:
```json
{
  "success": true,
  "data": {
    "chats": [
      {
        "chatId": "chat_id",
        "otherUser": {
          "_id": "user_id",
          "mobileNumber": "9876543210",
          "name": "User 9876543210",
          "profilePicture": ""
        },
        "lastMessage": {
          "_id": "message_id",
          "message": "Hello",
          "messageType": "text",
          "isRead": false,
          "createdAt": "2024-01-01T00:00:00.000Z"
        },
        "lastMessageAt": "2024-01-01T00:00:00.000Z",
        "unreadCount": 0
      }
    ]
  }
}
```

#### 2. Search User by Mobile Number
**GET** `/api/chat/search?mobileNumber=1234567890`

Headers:
```
Authorization: Bearer <access_token>
```

Response (User exists):
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "user_id",
      "mobileNumber": "1234567890",
      "name": "User 1234567890",
      "profilePicture": ""
    },
    "inDatabase": true
  }
}
```

Response (User doesn't exist):
```json
{
  "success": true,
  "data": {
    "user": {
      "mobileNumber": "1234567890"
    },
    "inDatabase": false
  }
}
```

#### 3. Create or Get Chat
**POST** `/api/chat/create`

Headers:
```
Authorization: Bearer <access_token>
```

Request body:
```json
{
  "receiverId": "receiver_user_id"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "chat": {
      "_id": "chat_id",
      "participants": [...],
      "lastMessage": null,
      "lastMessageAt": "2024-01-01T00:00:00.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

#### 4. Get Chat Messages
**GET** `/api/chat/:chatId/messages?page=1&limit=50`

Headers:
```
Authorization: Bearer <access_token>
```

Response:
```json
{
  "success": true,
  "data": {
    "messages": [
      {
        "_id": "message_id",
        "chatId": "chat_id",
        "senderId": {
          "_id": "sender_id",
          "mobileNumber": "1234567890",
          "name": "User 1234567890"
        },
        "receiverId": {
          "_id": "receiver_id",
          "mobileNumber": "9876543210",
          "name": "User 9876543210"
        },
        "message": "Hello",
        "messageType": "text",
        "isRead": false,
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 100,
      "pages": 2
    }
  }
}
```

## Socket.io Events

### Client to Server Events

#### 1. Connect
Connect to the socket server with authentication token:
```javascript
const socket = io('http://localhost:3000', {
  auth: {
    token: 'your_access_token'
  }
});
```

#### 2. Join Chat
```javascript
socket.emit('join-chat', {
  chatId: 'chat_id'
});
```

#### 3. Send Message
```javascript
socket.emit('send-message', {
  chatId: 'chat_id',
  receiverId: 'receiver_user_id',
  message: 'Hello!',
  messageType: 'text' // 'text', 'image', or 'file'
});
```

#### 4. Mark Message as Read
```javascript
socket.emit('mark-read', {
  chatId: 'chat_id',
  messageId: 'message_id'
});
```

#### 5. Typing Indicator
```javascript
// Start typing
socket.emit('typing', {
  chatId: 'chat_id',
  receiverId: 'receiver_user_id'
});

// Stop typing
socket.emit('stop-typing', {
  chatId: 'chat_id',
  receiverId: 'receiver_user_id'
});
```

### Server to Client Events

#### 1. Connected
```javascript
socket.on('connected', (data) => {
  console.log(data.message); // "Connected to chat server"
});
```

#### 2. Joined Chat
```javascript
socket.on('joined-chat', (data) => {
  console.log('Joined chat:', data.chatId);
});
```

#### 3. New Message
```javascript
socket.on('new-message', (data) => {
  console.log('New message:', data.message);
});
```

#### 4. Message Sent (Confirmation)
```javascript
socket.on('message-sent', (data) => {
  console.log('Message sent:', data.message);
});
```

#### 5. Message Received
```javascript
socket.on('message-received', (data) => {
  console.log('Message received:', data.message);
});
```

#### 6. Message Read
```javascript
socket.on('message-read', (data) => {
  console.log('Message read:', data.messageId);
});
```

#### 7. User Typing
```javascript
socket.on('user-typing', (data) => {
  console.log('User typing:', data.userId, data.isTyping);
});
```

#### 8. Error
```javascript
socket.on('error', (data) => {
  console.error('Socket error:', data.message);
});
```

## Project Structure

```
chat-backend/
├── config/
│   └── database.js          # MongoDB connection
├── middleware/
│   └── auth.js              # JWT authentication middleware
├── models/
│   ├── User.js              # User model
│   ├── Chat.js              # Chat model
│   ├── Message.js           # Message model
│   └── OTP.js               # OTP model
├── routes/
│   ├── auth.js              # Authentication routes
│   └── chat.js              # Chat routes
├── socket/
│   └── socketHandler.js     # Socket.io event handlers
├── utils/
│   ├── jwt.js               # JWT utility functions
│   └── otpGenerator.js      # OTP generation utility
├── server.js                # Main server file
├── package.json
└── .env                     # Environment variables
```

## Security Notes

1. **OTP**: In production, integrate with an SMS service (Twilio, AWS SNS, etc.) to send OTPs. Currently, OTPs are logged to console for development.

2. **JWT Secrets**: Change the JWT secrets in production to strong, random strings.

3. **CORS**: Update CORS settings in `server.js` to allow only your frontend domain in production.

4. **Environment Variables**: Never commit `.env` file to version control.

## License

ISC

