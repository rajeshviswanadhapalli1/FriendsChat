const { verifyAccessToken, verifyRefreshToken, generateAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { sendMessageNotification } = require('../config/firebase');

// Store active users (userId -> socketId)
const activeUsers = new Map();
// Store socket connections with their refresh tokens
const socketRefreshTokens = new Map();
// Store active calls (channelId -> { callerId, calleeId, callerName })
const activeCalls = new Map();

const initializeSocket = (io) => {
  // Authentication middleware for Socket.io
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      const refreshToken = socket.handshake.auth.refreshToken;

      if (!token && !refreshToken) {
        return next(new Error('Authentication error: No token provided'));
      }

      let decoded = null;
      let userId = null;

      // Try to verify access token first
      if (token) {
        decoded = verifyAccessToken(token);
        if (decoded) {
          userId = decoded.userId;
        }
      }

      // If access token is invalid/expired, try refresh token
      if (!decoded && refreshToken) {
        const refreshDecoded = verifyRefreshToken(refreshToken);
        if (refreshDecoded) {
          userId = refreshDecoded.userId;
          // Store refresh token for this socket connection
          socketRefreshTokens.set(socket.id, refreshToken);
        }
      }

      if (!userId) {
        return next(new Error('Authentication error: Invalid or expired token'));
      }

      const user = await User.findById(userId);

      if (!user || !user.isActive) {
        return next(new Error('Authentication error: User not found or inactive'));
      }

      // Verify refresh token matches user's stored refresh token
      if (refreshToken && user.refreshToken !== refreshToken) {
        return next(new Error('Authentication error: Invalid refresh token'));
      }

      socket.userId = userId;
      socket.user = user;
      
      // Store refresh token if provided
      if (refreshToken) {
        socketRefreshTokens.set(socket.id, refreshToken);
      }
      
      next();
    } catch (error) {
      next(new Error('Authentication error: ' + error.message));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.userId}`);

    // Store user's socket connection
    activeUsers.set(socket.userId.toString(), socket.id);

    // Send online status to user
    socket.emit('connected', {
      message: 'Connected to chat server',
      userId: socket.userId,
    });

    // =========================
    // Calling (Agora RTC + Socket.io signaling)
    // =========================
    // Events match frontend: call-invite, call-accept, call-reject, call-end.
    // Media goes through Agora; backend only relays signaling.

    // Caller starts call (client → server). Forward to callee.
    // Payload: { channelId, callType: 'audio'|'video', callerId, callerName, calleeId }
    socket.on('call-invite', async (data) => {
      try {
        const { channelId, callType = 'audio', callerId, callerName, calleeId } = data || {};

        if (!channelId || !callerId || !calleeId) {
          socket.emit('call-error', { message: 'channelId, callerId and calleeId are required' });
          return;
        }

        if (callerId.toString() !== socket.userId.toString()) {
          socket.emit('call-error', { message: 'callerId must match authenticated user' });
          return;
        }

        if (calleeId.toString() === socket.userId.toString()) {
          socket.emit('call-error', { message: 'Cannot call yourself' });
          return;
        }

        const callee = await User.findById(calleeId).select('_id isActive');
        if (!callee || !callee.isActive) {
          socket.emit('call-unavailable', { channelId, calleeId, message: 'User not found or inactive' });
          return;
        }

        const calleeSocketId = activeUsers.get(calleeId.toString());
        if (!calleeSocketId) {
          socket.emit('call-unavailable', { channelId, calleeId, message: 'User is offline' });
          return;
        }

        for (const [, c] of activeCalls) {
          if (
            c.callerId.toString() === socket.userId.toString() ||
            c.calleeId.toString() === socket.userId.toString() ||
            c.callerId.toString() === calleeId.toString() ||
            c.calleeId.toString() === calleeId.toString()
          ) {
            socket.emit('call-busy', { channelId, calleeId, message: 'User is busy' });
            return;
          }
        }

        const payload = {
          channelId,
          callType,
          callerId,
          callerName: callerName || '',
          calleeId,
        };
        activeCalls.set(String(channelId), {
          callerId: socket.userId,
          calleeId,
          callerName: callerName || '',
        });

        io.to(calleeSocketId).emit('call-invite', payload);
      } catch (error) {
        console.error('call-invite error:', error);
        socket.emit('call-error', { message: 'Error starting call' });
      }
    });

    // Callee accepts (client → server). Notify caller.
    // Payload: { channelId, callerId }
    socket.on('call-accept', async (data) => {
      try {
        const { channelId, callerId } = data || {};
        if (!channelId || !callerId) {
          socket.emit('call-error', { message: 'channelId and callerId are required' });
          return;
        }

        const call = activeCalls.get(String(channelId));
        if (!call) {
          socket.emit('call-error', { message: 'Call not found' });
          return;
        }

        if (call.calleeId.toString() !== socket.userId.toString()) {
          socket.emit('call-error', { message: 'Only callee can accept this call' });
          return;
        }

        const callerSocketId = activeUsers.get(callerId.toString());
        if (!callerSocketId) {
          socket.emit('call-error', { message: 'Caller is offline' });
          activeCalls.delete(String(channelId));
          return;
        }

        io.to(callerSocketId).emit('call-accepted', { channelId, callerId });
      } catch (error) {
        console.error('call-accept error:', error);
        socket.emit('call-error', { message: 'Error accepting call' });
      }
    });

    // Callee rejects (client → server). Notify caller.
    // Payload: { channelId, callerId }
    socket.on('call-reject', async (data) => {
      const { channelId, callerId } = data || {};
      if (!channelId || !callerId) return;

      const call = activeCalls.get(String(channelId));
      if (!call) return;

      const callerSocketId = activeUsers.get(callerId.toString());
      if (callerSocketId) {
        io.to(callerSocketId).emit('call-rejected', { channelId, callerId });
      }

      activeCalls.delete(String(channelId));
    });

    // Either party ends call (client → server). Notify other peer.
    // Payload: { channelId }
    socket.on('call-end', async (data) => {
      const { channelId } = data || {};
      if (!channelId) return;

      const call = activeCalls.get(String(channelId));
      if (!call) return;

      const otherUserId =
        call.callerId.toString() === socket.userId.toString() ? call.calleeId : call.callerId;
      const otherSocketId = activeUsers.get(otherUserId.toString());

      if (otherSocketId) {
        io.to(otherSocketId).emit('call-ended', { channelId });
      }

      activeCalls.delete(String(channelId));
    });

    // Handle token refresh for socket connection
    socket.on('refresh-token', async (data) => {
      try {
        const refreshToken = data.refreshToken || socketRefreshTokens.get(socket.id);

        if (!refreshToken) {
          socket.emit('token-refresh-error', { message: 'No refresh token available' });
          return;
        }

        const decoded = verifyRefreshToken(refreshToken);

        if (!decoded) {
          socket.emit('token-refresh-error', { message: 'Invalid or expired refresh token' });
          socket.disconnect();
          return;
        }

        const user = await User.findById(decoded.userId);

        if (!user || user.refreshToken !== refreshToken) {
          socket.emit('token-refresh-error', { message: 'Invalid refresh token' });
          socket.disconnect();
          return;
        }

        // Generate new access token
        const newAccessToken = generateAccessToken(user._id);

        socket.emit('token-refreshed', {
          accessToken: newAccessToken,
        });
      } catch (error) {
        console.error('Error refreshing token:', error);
        socket.emit('token-refresh-error', { message: 'Error refreshing token' });
      }
    });

    // Periodic token refresh (every 14 minutes to refresh before 15 min expiry)
    const tokenRefreshInterval = setInterval(async () => {
      try {
        const refreshToken = socketRefreshTokens.get(socket.id);

        if (!refreshToken) {
          return;
        }

        const decoded = verifyRefreshToken(refreshToken);

        if (!decoded) {
          socket.emit('token-refresh-error', { message: 'Refresh token expired' });
          socket.disconnect();
          return;
        }

        const user = await User.findById(decoded.userId);

        if (!user || user.refreshToken !== refreshToken) {
          socket.emit('token-refresh-error', { message: 'Invalid refresh token' });
          socket.disconnect();
          return;
        }

        // Generate new access token
        const newAccessToken = generateAccessToken(user._id);

        socket.emit('token-refreshed', {
          accessToken: newAccessToken,
        });
      } catch (error) {
        console.error('Error in periodic token refresh:', error);
      }
    }, 14 * 60 * 1000); // 14 minutes

    // Store interval ID for cleanup
    socket.tokenRefreshInterval = tokenRefreshInterval;

    // Handle join room (for specific chat)
    socket.on('join-chat', async (data) => {
      try {
        const { chatId } = data;

        if (!chatId) {
          socket.emit('error', { message: 'Chat ID is required' });
          return;
        }

        // Verify user is a participant in this chat
        const chat = await Chat.findById(chatId);

        if (!chat) {
          socket.emit('error', { message: 'Chat not found' });
          return;
        }

        if (!chat.participants.includes(socket.userId)) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        // Join the chat room
        socket.join(`chat:${chatId}`);
        socket.emit('joined-chat', { chatId });
      } catch (error) {
        console.error('Error joining chat:', error);
        socket.emit('error', { message: 'Error joining chat' });
      }
    });

    // Handle sending message
    socket.on('send-message', async (data) => {
      try {
        const { chatId, receiverId, message, messageType = 'text' } = data;

        // Validate required fields
        if (!receiverId || !message) {
          socket.emit('error', {
            message: 'Receiver ID and message are required',
          });
          return;
        }

        // Validate receiver exists
        const receiver = await User.findById(receiverId);
        if (!receiver) {
          socket.emit('error', { message: 'Receiver not found' });
          return;
        }

        // Validate sender is not sending to themselves
        if (socket.userId.toString() === receiverId.toString()) {
          socket.emit('error', { message: 'Cannot send message to yourself' });
          return;
        }

        let chat;

        // If chatId is provided, verify it exists and user is a participant
        if (chatId) {
          chat = await Chat.findById(chatId);

          if (!chat) {
            socket.emit('error', { message: 'Chat not found' });
            return;
          }

          if (!chat.participants.includes(socket.userId)) {
            socket.emit('error', { message: 'Access denied' });
            return;
          }

          // Verify receiver is a participant
          if (!chat.participants.includes(receiverId)) {
            socket.emit('error', { message: 'Receiver is not a participant' });
            return;
          }
        } else {
          // No chatId provided - find or create chat
          chat = await Chat.findOne({
            participants: { $all: [socket.userId, receiverId] },
          });

          if (!chat) {
            // Create new chat
            chat = await Chat.create({
              participants: [socket.userId, receiverId],
            });

            // Populate participants for response
            await chat.populate('participants', 'mobileNumber name profilePicture');
          } else {
            // Ensure participants are populated for consistent response shape
            await chat.populate('participants', 'mobileNumber name profilePicture');
          }
        }

        const effectiveChatId = chat._id;
        const isNewChat = !chatId;

        // Create message
        const newMessage = await Message.create({
          chatId: effectiveChatId,
          senderId: socket.userId,
          receiverId,
          message,
          messageType,
          isRead: false,
        });

        // Populate sender and receiver info
        await newMessage.populate('senderId', 'mobileNumber name profilePicture');
        await newMessage.populate('receiverId', 'mobileNumber name profilePicture');

        // Update chat's last message
        chat.lastMessage = newMessage._id;
        chat.lastMessageAt = newMessage.createdAt;
        await chat.save();

        // Emit message to receiver (if online)
        const receiverSocketId = activeUsers.get(receiverId.toString());
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('new-message', {
            chatId: effectiveChatId,
            message: newMessage,
          });
        }

        // Send push notification (FCM) - useful when receiver is offline or app in background
        const receiverUser = await User.findById(receiverId).select('fcmToken').lean();
        if (receiverUser?.fcmToken) {
          const senderName = socket.user?.name || socket.user?.mobileNumber || 'Someone';
          sendMessageNotification(receiverUser.fcmToken, {
            chatId: effectiveChatId,
            senderId: socket.userId,
            senderName,
            receiverId,
            message: newMessage.message,
          }).catch((err) => console.error('FCM push error:', err.message));
        }

        const otherUser =
          Array.isArray(chat.participants)
            ? chat.participants.find((p) => {
                const pid =
                  typeof p === 'object' && p !== null
                    ? (p._id ?? p).toString()
                    : p.toString();
                return pid !== socket.userId.toString();
              })
            : null;

        const otherUserNormalized =
          otherUser && typeof otherUser === 'object'
            ? {
                _id: otherUser._id,
                mobileNumber: otherUser.mobileNumber,
                name: otherUser.name,
                profilePicture: otherUser.profilePicture,
              }
            : undefined;

        // Emit message to sender (confirmation) - include chat info if new chat was created
        socket.emit('message-sent', {
          chatId: effectiveChatId,
          message: newMessage,
          chatCreated: isNewChat,
          otherUser: otherUserNormalized,
          chatListItem: {
            chatId: effectiveChatId,
            otherUser: otherUserNormalized,
            lastMessage: newMessage,
            lastMessageAt: chat.lastMessageAt,
            unreadCount: 0,
          },
          chat: isNewChat
            ? {
                _id: effectiveChatId,
                participants: chat.participants,
                createdAt: chat.createdAt,
              }
            : undefined,
        });

        // Also emit to chat room
        io.to(`chat:${effectiveChatId}`).emit('message-received', {
          chatId: effectiveChatId,
          message: newMessage,
        });
      } catch (error) {
        console.error('Error sending message:', error);
        socket.emit('error', { message: 'Error sending message', error: error.message });
      }
    });

    // Handle message read status
    socket.on('mark-read', async (data) => {
      try {
        const { chatId, messageId } = data;

        if (!chatId || !messageId) {
          socket.emit('error', { message: 'Chat ID and message ID are required' });
          return;
        }

        // Verify user is a participant
        const chat = await Chat.findById(chatId);
        if (!chat || !chat.participants.includes(socket.userId)) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        // Update message read status
        const message = await Message.findOne({
          _id: messageId,
          chatId,
          receiverId: socket.userId,
        });

        if (message && !message.isRead) {
          message.isRead = true;
          await message.save();

          // Notify sender that message was read
          const senderSocketId = activeUsers.get(message.senderId.toString());
          if (senderSocketId) {
            io.to(senderSocketId).emit('message-read', {
              chatId,
              messageId,
            });
          }
        }
      } catch (error) {
        console.error('Error marking message as read:', error);
        socket.emit('error', { message: 'Error marking message as read' });
      }
    });

    // Handle get messages via socket
    socket.on('get-messages', async (data) => {
      try {
        const { chatId, page = 1, limit = 50 } = data;

        if (!chatId) {
          socket.emit('error', { message: 'Chat ID is required' });
          return;
        }

        // Verify user is a participant
        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit('error', { message: 'Chat not found' });
          return;
        }

        if (!chat.participants.includes(socket.userId)) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        // Get pagination parameters
        const skip = (page - 1) * limit;

        // Fetch messages
        const messages = await Message.find({ chatId })
          .populate('senderId', 'mobileNumber name profilePicture')
          .populate('receiverId', 'mobileNumber name profilePicture')
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean();

        // Get total count
        const totalMessages = await Message.countDocuments({ chatId });

        // Send messages to client
        socket.emit('messages-received', {
          chatId,
          messages: messages.reverse(), // Reverse to show oldest first
          pagination: {
            page,
            limit,
            total: totalMessages,
            pages: Math.ceil(totalMessages / limit),
          },
        });
      } catch (error) {
        console.error('Error fetching messages:', error);
        socket.emit('error', { message: 'Error fetching messages' });
      }
    });

    // Handle typing indicator
    socket.on('typing', (data) => {
      const { chatId, receiverId } = data;
      const receiverSocketId = activeUsers.get(receiverId?.toString());

      if (receiverSocketId) {
        io.to(receiverSocketId).emit('user-typing', {
          chatId,
          userId: socket.userId,
          isTyping: true,
        });
      }
    });

    socket.on('stop-typing', (data) => {
      const { chatId, receiverId } = data;
      const receiverSocketId = activeUsers.get(receiverId?.toString());

      if (receiverSocketId) {
        io.to(receiverSocketId).emit('user-typing', {
          chatId,
          userId: socket.userId,
          isTyping: false,
        });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.userId}`);
      activeUsers.delete(socket.userId.toString());
      socketRefreshTokens.delete(socket.id);

      // End any active calls for this user (notify other peer with call-ended)
      for (const [channelId, call] of activeCalls) {
        if (
          call.callerId.toString() === socket.userId.toString() ||
          call.calleeId.toString() === socket.userId.toString()
        ) {
          const otherUserId =
            call.callerId.toString() === socket.userId.toString() ? call.calleeId : call.callerId;
          const otherSocketId = activeUsers.get(otherUserId.toString());
          if (otherSocketId) {
            io.to(otherSocketId).emit('call-ended', { channelId });
          }
          activeCalls.delete(channelId);
        }
      }
      
      // Clear token refresh interval
      if (socket.tokenRefreshInterval) {
        clearInterval(socket.tokenRefreshInterval);
      }
    });
  });

  return io;
};

module.exports = { initializeSocket, activeUsers, activeCalls };

