const express = require('express');
const notifications = require('../../notifications/notifications');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

router.get('/', (req, res) => {
  const ACTION = 'notifications.list';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    res.json({ success: true, message: 'OK', data: { notifications: notifications.getNotifications(limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal ambil notifikasi.', code: 'NOTIFICATIONS_FAILED' });
  }
});

module.exports = router;
