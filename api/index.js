const express = require('express');
const { PrismaClient } = require('@prisma/client');
const midtransClient = require('midtrans-client');
const cors = require('cors');

const app = express();
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Inisialisasi Midtrans
const snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
});

// 1. Endpoint Tokenizer (Untuk memunculkan Popup)
app.post('/api/tokenizer', async (req, res) => {
    try {
        const { id, productName, price, quantity } = req.body;
        let parameter = {
            "transaction_details": {
                "order_id": `LOKER-${id}-${Date.now()}`,
                "gross_amount": parseInt(price) * parseInt(quantity)
            },
            "item_details": [{
                "id": id,
                "price": parseInt(price),
                "quantity": parseInt(quantity),
                "name": productName
            }]
        };

        const transaction = await snap.createTransaction(parameter);
        res.status(200).json({ token: transaction.token });
    } catch (error) {
        console.error("Tokenizer Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. Endpoint Webhook (PENTING: Gunakan /api/webhook agar sesuai dashboard Midtrans kamu)
app.post('/api/webhook', async (req, res) => {
    try {
        const notification = req.body;
        const statusResponse = await snap.transaction.notification(notification);
        
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;

        console.log(`Webhook Received: ${orderId} - ${transactionStatus}`);

        if (transactionStatus === 'settlement') {
            console.log(`Pembayaran ${orderId} BERHASIL.`);
            // Tambahkan logika update database Prisma di sini
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(500).send("Internal Error");
    }
});

// 3. Endpoint Arduino Tapping
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

app.get('/', (req, res) => res.send('Smart Locker API Ready!'));

module.exports = app;