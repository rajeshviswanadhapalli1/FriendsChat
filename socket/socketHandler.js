const { verifyAccessToken, verifyRefreshToken, generateAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const CallHistory = require('../models/CallHistory');
const { sendMessageNotification, sendCallOfferNotification, sendMissedCallNotification } = require('../config/firebase');

// Store active users (userId -> socketId)
const activeUsers = new Map();
// Store socket connections with their refresh tokens
const socketRefreshTokens = new Map();
// Store active calls (channelId -> { callerId, calleeId, callerName })
const activeCalls = new Map();
// Dedupe: only one invite + one FCM per channelId
const callInviteSentForChannel = new Set();
// 3-minute ring timeout: channelId -> { timeoutId, calleeFcmToken }
const callRingTimeouts = new Map();
// After reject/end/timeout: never send invite or FCM for this channelId again
const endedOrRejectedChannels = new Set();

const RING_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

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
    // WebRTC Calling (Socket.io signaling only; media is peer-to-peer)
    // =========================
    // Events: call-invite (offer), call-accept (answer), ice-candidate, call-reject, call-end

    // Caller starts call: sends offer. Server forwards to callee once per channelId and sends one FCM; 3-min ring timeout.
    // Payload: { channelId, callType: 'audio'|'video', callerId, callerName, calleeId, offer }
    socket.on('call-invite', async (data) => {
      try {
        const { channelId, callType = 'audio', callerId, callerName, calleeId, offer } = data || {};

        if (!channelId || !callerId || !calleeId) {
          socket.emit('call-error', { message: 'channelId, callerId and calleeId are required' });
          return;
        }

        const channelIdStr = String(channelId);
        if (endedOrRejectedChannels.has(channelIdStr)) {
          socket.emit('call-ended', { channelId, message: 'Call already ended or rejected' });
          return;
        }
        if (callInviteSentForChannel.has(channelIdStr)) {
          return; // One invite + one FCM per call; ignore duplicate
        }

        // Normalize IDs for consistent lookup (client may send string or object)
        const callerIdStr = String(callerId).trim();
        const calleeIdStr = String(calleeId).trim();
        const myUserIdStr = socket.userId.toString();

        if (callerIdStr !== myUserIdStr) {
          socket.emit('call-error', { message: 'callerId must match authenticated user' });
          return;
        }

        if (calleeIdStr === myUserIdStr) {
          socket.emit('call-error', { message: 'Cannot call yourself' });
          return;
        }

        // Offer can be object { type, sdp }; ensure we have at least type and sdp for signaling
        const offerPayload = offer && (offer.sdp || offer.type)
          ? { type: offer.type || 'offer', sdp: offer.sdp || '' }
          : null;
        if (!offerPayload) {
          socket.emit('call-error', { message: 'offer with type and sdp is required' });
          return;
        }

        const callee = await User.findById(calleeIdStr).select('_id isActive fcmToken').lean();
        if (!callee || !callee.isActive) {
          socket.emit('call-unavailable', { channelId, calleeId: calleeIdStr, message: 'User not found or inactive' });
          return;
        }

        // Check busy: either user already in a call
        for (const [, c] of activeCalls) {
          if (
            c.callerId.toString() === myUserIdStr ||
            c.calleeId.toString() === myUserIdStr ||
            c.callerId.toString() === calleeIdStr ||
            c.calleeId.toString() === calleeIdStr
          ) {
            socket.emit('call-busy', { channelId, calleeId: calleeIdStr, message: 'User is busy' });
            return;
          }
        }

        callInviteSentForChannel.add(channelIdStr);

        const calleeSocketId = activeUsers.get(calleeIdStr);
        const isCalleeOnline = Boolean(calleeSocketId);

        if (isCalleeOnline) {
          const inviteSentAt = new Date();
          activeCalls.set(channelIdStr, {
            callerId: socket.userId,
            calleeId: calleeIdStr,
            callerName: callerName || '',
            callType,
            inviteSentAt,
            offer: offerPayload,
          });

          io.to(calleeSocketId).emit('call-invite', {
            channelId,
            callType,
            callerId: callerIdStr,
            callerName: callerName || '',
            calleeId: calleeIdStr,
            offer: offerPayload,
          });
          console.log('Call invite sent via socket', { channelId, callerId: callerIdStr, calleeId: calleeIdStr });
        } else {
          socket.emit('call-unavailable', { channelId, calleeId: calleeIdStr, message: 'User is offline' });
        }

        // One FCM per call: incoming call (with optional callerPhone)
        const callerUser = await User.findById(callerIdStr).select('mobileNumber').lean();
        const callerPhone = callerUser?.mobileNumber ? String(callerUser.mobileNumber) : '';

        if (callee.fcmToken) {
          sendCallOfferNotification(callee.fcmToken, {
            channelId,
            callerId: callerIdStr,
            callerName: callerName || '',
            calleeId: calleeIdStr,
            callType,
            callerPhone,
          })
            .then((ok) => {
              if (ok) console.log('Call offer push sent', { calleeId: calleeIdStr });
              else console.warn('Call offer push not sent (check FCM)', { calleeId: calleeIdStr });
            })
            .catch((err) => console.error('FCM call offer:', err.message));
        } else {
          console.log('Callee has no fcmToken, skip call push', { calleeId: calleeIdStr });
        }

        // 3-minute ring timeout: if no call-accept, end call and send missed_call FCM to callee
        const timeoutId = setTimeout(async () => {
          callRingTimeouts.delete(channelIdStr);
          endedOrRejectedChannels.add(channelIdStr);
          callInviteSentForChannel.delete(channelIdStr);
          const call = activeCalls.get(channelIdStr);
          activeCalls.delete(channelIdStr);

          const cid = call?.callerId?.toString?.() ?? callerIdStr;
          const calleeIdForEnd = call?.calleeId?.toString?.() ?? calleeIdStr;
          const callerSocketId = activeUsers.get(cid);
          const calleeSocketIdEnd = activeUsers.get(calleeIdForEnd);
          if (callerSocketId) io.to(callerSocketId).emit('call-ended', { channelId });
          if (calleeSocketIdEnd) io.to(calleeSocketIdEnd).emit('call-ended', { channelId });

          const startedAt = call?.inviteSentAt ? new Date(call.inviteSentAt) : new Date(Date.now() - RING_TIMEOUT_MS);
          const endedAt = new Date();
          try {
            await CallHistory.create({
              callerId: callerIdStr,
              calleeId: calleeIdStr,
              channelId: channelIdStr,
              callType,
              status: 'missed',
              startedAt,
              endedAt,
              durationSeconds: 0,
            });
          } catch (e) {
            console.error('CallHistory create (missed):', e.message);
          }

          if (callee.fcmToken) {
            await sendMissedCallNotification(callee.fcmToken, {
              channelId,
              callerId: callerIdStr,
              callerName: callerName || '',
              callType,
              callerPhone,
            });
          }
        }, RING_TIMEOUT_MS);
        callRingTimeouts.set(channelIdStr, { timeoutId, calleeFcmToken: callee.fcmToken });
      } catch (error) {
        console.error('call-invite error:', error);
        socket.emit('call-error', { message: 'Error starting call' });
      }
    });

    // Callee accepts: sends answer. Server forwards to caller.
    // Payload: { channelId, callerId, answer }
    socket.on('call-accept', async (data) => {
      try {
        const { channelId, callerId, answer } = data || {};
        if (!channelId || !callerId || !answer) {
          socket.emit('call-error', { message: 'channelId, callerId and answer are required' });
          return;
        }

        const channelIdStr = String(channelId);
        const call = activeCalls.get(channelIdStr);
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
          activeCalls.delete(channelIdStr);
          return;
        }

        const ringTimeout = callRingTimeouts.get(channelIdStr);
        if (ringTimeout) {
          clearTimeout(ringTimeout.timeoutId);
          callRingTimeouts.delete(channelIdStr);
        }

        call.acceptedAt = new Date();
        activeCalls.set(channelIdStr, call);

        io.to(callerSocketId).emit('call-accepted', { channelId, callerId, answer });
      } catch (error) {
        console.error('call-accept error:', error);
        socket.emit('call-error', { message: 'Error accepting call' });
      }
    });

    // Relay ICE candidate to the other peer.
    // Payload: { channelId, candidate, fromUserId }
    socket.on('ice-candidate', (data) => {
      const { channelId, candidate, fromUserId } = data || {};
      if (!channelId || !candidate || !fromUserId) return;

      const call = activeCalls.get(String(channelId));
      if (!call) return;

      const otherUserId =
        call.callerId.toString() === fromUserId.toString() ? call.calleeId : call.callerId;
      const otherSocketId = activeUsers.get(otherUserId.toString());
      if (otherSocketId) {
        io.to(otherSocketId).emit('ice-candidate', { channelId, candidate, fromUserId });
      }
    });

    // Callee rejects (client → server). Cancel ring timer, mark channel ended, then notify caller.
    // After this, no more call-invite or FCM must be sent for this channelId.
    socket.on('call-reject', async (data) => {
      const { channelId, callerId } = data || {};
      if (!channelId || !callerId) return;

      const channelIdStr = String(channelId);
      const callerIdStr = String(callerId).trim();

      // 1. Cancel 3-minute ring timer so no missed-call FCM is sent
      const ringTimeout = callRingTimeouts.get(channelIdStr);
      if (ringTimeout) {
        clearTimeout(ringTimeout.timeoutId);
        callRingTimeouts.delete(channelIdStr);
      }

      const call = activeCalls.get(channelIdStr);
      if (call) {
        const startedAt = call.inviteSentAt ? new Date(call.inviteSentAt) : new Date();
        const endedAt = new Date();
        try {
          await CallHistory.create({
            callerId: call.callerId,
            calleeId: call.calleeId,
            channelId: channelIdStr,
            callType: call.callType || 'audio',
            status: 'rejected',
            startedAt,
            endedAt,
            durationSeconds: 0,
          });
        } catch (e) {
          console.error('CallHistory create (rejected):', e.message);
        }
      }

      // 2. Mark call ended for this channelId so we never send another invite or FCM for it
      endedOrRejectedChannels.add(channelIdStr);
      callInviteSentForChannel.delete(channelIdStr);
      activeCalls.delete(channelIdStr);

      // 3. Notify both sides so both UIs end at the same time
      const callerSocketId = activeUsers.get(callerIdStr);
      if (callerSocketId) {
        io.to(callerSocketId).emit('call-rejected', { channelId });
      }
      // Callee (this socket) also gets call-ended so both users end the call together
      socket.emit('call-ended', { channelId });
    });

    // Either party ends call. Notify both sides so both UIs end at the same time.
    socket.on('call-end', async (data) => {
      const { channelId } = data || {};
      if (!channelId) return;

      const channelIdStr = String(channelId);
      const call = activeCalls.get(channelIdStr);
      if (!call) return;

      const otherUserId =
        call.callerId.toString() === socket.userId.toString() ? call.calleeId : call.callerId;
      const otherSocketId = activeUsers.get(otherUserId.toString());

      // Notify other peer
      if (otherSocketId) {
        io.to(otherSocketId).emit('call-ended', { channelId });
      }
      // Notify sender too so both users end the call together
      socket.emit('call-ended', { channelId });

      const endedAt = new Date();
      const startedAt = call.acceptedAt ? new Date(call.acceptedAt) : (call.inviteSentAt ? new Date(call.inviteSentAt) : endedAt);
      const durationSeconds = call.acceptedAt ? Math.round((endedAt - new Date(call.acceptedAt)) / 1000) : 0;
      try {
        await CallHistory.create({
          callerId: call.callerId,
          calleeId: call.calleeId,
          channelId: channelIdStr,
          callType: call.callType || 'audio',
          status: 'answered',
          startedAt,
          endedAt,
          durationSeconds,
        });
      } catch (e) {
        console.error('CallHistory create (answered):', e.message);
      }

      const ringTimeout = callRingTimeouts.get(channelIdStr);
      if (ringTimeout) {
        clearTimeout(ringTimeout.timeoutId);
        callRingTimeouts.delete(channelIdStr);
      }
      endedOrRejectedChannels.add(channelIdStr);
      callInviteSentForChannel.delete(channelIdStr);
      activeCalls.delete(channelIdStr);
    });

    // Callee can request the offer by channelId (e.g. when opening from FCM before socket got call-invite)
    socket.on('call-request-offer', (data) => {
      const { channelId } = data || {};
      if (!channelId) return;
      const channelIdStr = String(channelId);
      const call = activeCalls.get(channelIdStr);
      if (!call || !call.offer) return;
      if (call.calleeId.toString() !== socket.userId.toString()) return;
      socket.emit('call-offer', { channelId, offer: call.offer });
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

        // Send push notification (FCM) - when receiver is offline or app in background
        const receiverUser = await User.findById(receiverId).select('fcmToken').lean();
        if (receiverUser?.fcmToken) {
          const senderName = socket.user?.name || socket.user?.mobileNumber || 'Someone';
          const fcmPayload = {
            chatId: String(effectiveChatId),
            senderId: String(socket.userId),
            senderName: senderName || 'Someone',
            receiverId: String(receiverId),
            message: typeof newMessage.message === 'string' ? newMessage.message : String(newMessage.message || ''),
          };
          try {
            const sent = await sendMessageNotification(receiverUser.fcmToken, fcmPayload);
            if (!sent) {
              console.warn('FCM: Push notification was not sent (check logs above)');
            }
          } catch (err) {
            console.error('FCM: Push error:', err.message);
          }
        } else {
          console.log('FCM: Receiver has no fcmToken', { receiverId: String(receiverId) });
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
          const ringTimeout = callRingTimeouts.get(channelId);
          if (ringTimeout) {
            clearTimeout(ringTimeout.timeoutId);
            callRingTimeouts.delete(channelId);
          }
          endedOrRejectedChannels.add(channelId);
          callInviteSentForChannel.delete(channelId);
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

