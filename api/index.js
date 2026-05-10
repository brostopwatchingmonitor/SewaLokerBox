const express = require('express');
const { PrismaClient } = require('@prisma/client');
const app = express();
const prisma = new PrismaClient();

app.use(express.json());

app.get('/', (req, res) => res.send('Smart Locker API Ready!'));

// Endpoint untuk Arduino Tapping
app.post('/api/tap', async (req, res) => {
  const { nfc_uid } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { nfc_uid } });
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ status: "SUCCESS", user: user.full_name, balance: user.balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;