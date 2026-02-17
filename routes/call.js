const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

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

module.exports = router;
