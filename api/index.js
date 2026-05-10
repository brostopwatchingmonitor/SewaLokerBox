const express = require('express');
const { PrismaClient } = require('@prisma/client');
const app = express();
const prisma = new PrismaClient();
const midtransClient = require('midtrans-client');

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

let snap = new midtransClient.Snap({
    isProduction : false,
    serverKey : process.env.MIDTRANS_SERVER_KEY // Ambil dari Dashboard Midtrans Sandbox
});

// Endpoint untuk membuat transaksi
app.post('/api/create-payment', async (req, res) => {
    const { amount, customerName, customerEmail } = req.body;
    const orderId = `TRX-${Date.now()}`;

    let parameter = {
        "transaction_details": {
            "order_id": orderId,
            "gross_amount": amount
        },
        "credit_card": {
            "secure" : true
        },
        "customer_details": {
            "first_name": customerName,
            "email": customerEmail
        }
    };

    try {
        const transaction = await snap.createTransaction(parameter);
        // Simpan orderId ke database Prisma di sini jika perlu (status PENDING)
        res.json({ token: transaction.token, orderId: orderId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});