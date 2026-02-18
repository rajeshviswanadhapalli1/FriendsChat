const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const CallHistory = require('../models/CallHistory');

/**
 * GET /api/call/config
 * Returns WebRTC ICE servers (STUN/TURN) for RTCPeerConnection.
 * Use in both dev and production. TURN is optional but recommended for production.
 */
router.get('/config', authenticate, (req, res) => {
  try {
    const iceServers = [];

    // STUN: free, works for many dev and simple prod setups
    const stunUrl = process.env.WEBRTC_STUN_URL || 'stun:stun.l.google.com:19302';
    iceServers.push({ urls: stunUrl });

    // TURN: optional, improves connectivity behind symmetric NAT (production)
    const turnUrl = process.env.WEBRTC_TURN_URL;
    const turnUsername = process.env.WEBRTC_TURN_USERNAME;
    const turnCredential = process.env.WEBRTC_TURN_CREDENTIAL;

    if (turnUrl) {
      iceServers.push({
        urls: turnUrl,
        username: turnUsername || undefined,
        credential: turnCredential || undefined,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        iceServers,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/call/history
 * Returns call history for the authenticated user (incoming and outgoing).
 * Query: page (default 1), limit (default 20, max 50)
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [calls, total] = await Promise.all([
      CallHistory.find({
        $or: [{ callerId: userId }, { calleeId: userId }],
      })
        .sort({ endedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('callerId', 'mobileNumber name profilePicture')
        .populate('calleeId', 'mobileNumber name profilePicture')
        .lean(),
      CallHistory.countDocuments({
        $or: [{ callerId: userId }, { calleeId: userId }],
      }),
    ]);

    const list = calls.map((c) => {
      const isOutgoing = c.callerId._id.toString() === userId.toString();
      const otherUser = isOutgoing ? c.calleeId : c.callerId;
      return {
        _id: c._id,
        channelId: c.channelId,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        callType: c.callType,
        status: c.status,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        durationSeconds: c.durationSeconds,
        otherUser: otherUser
          ? {
              _id: otherUser._id,
              mobileNumber: otherUser.mobileNumber,
              name: otherUser.name,
              profilePicture: otherUser.profilePicture || '',
            }
          : null,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        calls: list,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Call history error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error fetching call history',
    });
  }
});

module.exports = router;
