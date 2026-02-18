const mongoose = require('mongoose');

const callHistorySchema = new mongoose.Schema({
  callerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  calleeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  channelId: {
    type: String,
    required: true,
  },
  callType: {
    type: String,
    enum: ['audio', 'video'],
    default: 'audio',
  },
  status: {
    type: String,
    enum: ['missed', 'rejected', 'answered'],
    required: true,
  },
  startedAt: {
    type: Date,
    required: true,
  },
  endedAt: {
    type: Date,
    required: true,
  },
  durationSeconds: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

callHistorySchema.index({ callerId: 1, endedAt: -1 });
callHistorySchema.index({ calleeId: 1, endedAt: -1 });

module.exports = mongoose.model('CallHistory', callHistorySchema);
