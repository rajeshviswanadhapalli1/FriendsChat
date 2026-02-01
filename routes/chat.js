const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { authenticate } = require('../middleware/auth');

// Get chat list for logged-in user
router.get('/list', authenticate, async (req, res) => {
  try {
    const userId = req.userId;

    // Find all chats where user is a participant
    const chats = await Chat.find({
      participants: userId,
    })
      .populate('participants', 'mobileNumber name profilePicture')
      .populate('lastMessage')
      .sort({ lastMessageAt: -1 })
      .lean();

    // Format the response
    const chatList = chats.map((chat) => {
      const otherParticipant = chat.participants.find(
        (p) => p._id.toString() !== userId.toString()
      );

      return {
        chatId: chat._id,
        otherUser: {
          _id: otherParticipant._id,
          mobileNumber: otherParticipant.mobileNumber,
          name: otherParticipant.name,
          profilePicture: otherParticipant.profilePicture,
        },
        lastMessage: chat.lastMessage,
        lastMessageAt: chat.lastMessageAt,
        unreadCount: 0, // You can implement unread count logic
      };
    });

    res.status(200).json({
      success: true,
      data: {
        chats: chatList,
      },
    });
  } catch (error) {
    console.error('Error fetching chat list:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching chat list',
      error: error.message,
    });
  }
});

// Search user by mobile number and get chat info if exists
router.get('/search', authenticate, async (req, res) => {
  try {
    const { mobileNumber } = req.query;
    const userId = req.userId;

    if (!mobileNumber) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number is required',
      });
    }

    if (!/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit mobile number is required',
      });
    }

    // Don't allow searching for own number
    if (mobileNumber === req.user.mobileNumber) {
      return res.status(400).json({
        success: false,
        message: 'Cannot search for your own number',
      });
    }

    const user = await User.findOne({ mobileNumber });

    if (user) {
      // Check if chat exists between current user and searched user
      const existingChat = await Chat.findOne({
        participants: { $all: [userId, user._id] },
      })
        .populate('participants', 'mobileNumber name profilePicture')
        .populate('lastMessage')
        .lean();

      // Format chat info if exists
      let chatInfo = null;
      if (existingChat) {
        chatInfo = {
          chatId: existingChat._id,
          lastMessage: existingChat.lastMessage,
          lastMessageAt: existingChat.lastMessageAt,
          createdAt: existingChat.createdAt,
          updatedAt: existingChat.updatedAt,
        };
      }

      res.status(200).json({
        success: true,
        data: {
          user: {
            _id: user._id,
            mobileNumber: user.mobileNumber,
            name: user.name,
            profilePicture: user.profilePicture,
          },
          inDatabase: true,
          chat: chatInfo, // null if no chat exists
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: {
          user: {
            mobileNumber: mobileNumber,
          },
          inDatabase: false,
          chat: null, // No chat if user doesn't exist
        },
      });
    }
  } catch (error) {
    console.error('Error searching user:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching user',
      error: error.message,
    });
  }
});

// Get or create chat between two users
router.post('/create', authenticate, async (req, res) => {
  try {
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        message: 'Receiver ID is required',
      });
    }

    const senderId = req.userId;

    if (senderId.toString() === receiverId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot create chat with yourself',
      });
    }

    // Check if receiver exists
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Receiver not found',
      });
    }

    // Check if chat already exists
    let chat = await Chat.findOne({
      participants: { $all: [senderId, receiverId] },
    }).populate('participants', 'mobileNumber name profilePicture');

    if (!chat) {
      // Create new chat
      chat = await Chat.create({
        participants: [senderId, receiverId],
      });

      chat = await Chat.findById(chat._id).populate(
        'participants',
        'mobileNumber name profilePicture'
      );
    }

    res.status(200).json({
      success: true,
      data: {
        chat,
      },
    });
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating chat',
      error: error.message,
    });
  }
});

// Get chat messages (for a specific chat)
router.get('/:chatId/messages', authenticate, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId;

    // Verify user is a participant
    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
      });
    }

    if (!chat.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Fetch messages for this chat
    const messages = await Message.find({ chatId })
      .populate('senderId', 'mobileNumber name profilePicture')
      .populate('receiverId', 'mobileNumber name profilePicture')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    // Get total count for pagination
    const totalMessages = await Message.countDocuments({ chatId });

    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse(), // Reverse to show oldest first
        pagination: {
          page,
          limit,
          total: totalMessages,
          pages: Math.ceil(totalMessages / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching messages',
      error: error.message,
    });
  }
});

module.exports = router;

