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
    serverKey : process.env.MIDTRANS_SERVER_KEY, // Ambil dari Dashboard Midtrans Sandbox
    clientKey: process.env.NEXT_PUBLIC_CLIENT_KEY
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
    // snap.createTransaction(parameter)
    // .then((transaction)=>{
    //     // transaction token
    //     let transactionToken = transaction.token;
    //     console.log('transactionToken:',transactionToken);
    // })

    try {
        const transaction = await snap.createTransaction(parameter);

        // window.snap.pay('TRANSACTION_TOKEN_HERE');


        // Simpan orderId ke database Prisma di sini jika perlu (status PENDING)
        res.json({ token: transaction.token, orderId: orderId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.use(express.static('public'));

app.post('/api/midtrans-webhook', async (req, res) => {
    const notification = req.body;

    try {
        // 1. Verifikasi transaksi lewat Midtrans client (opsional tapi lebih aman)
        const statusResponse = await snap.transaction.notification(notification);
        
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Transaction notification received. Order ID: ${orderId}. Status: ${transactionStatus}`);

        // 2. Logika Update Database berdasarkan status
        if (transactionStatus == 'settlement') {
            // PEMBAYARAN BERHASIL! 
            // Cari data transaksi di DB berdasarkan orderId
            // Update status menjadi 'SUCCESS'
            // Jika ini TOP-UP, tambahkan saldo ke User
            
            console.log("Pembayaran Settlement (Lunas)");
            
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            // PEMBAYARAN GAGAL
            console.log("Pembayaran Gagal/Expired");
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

app.post('/api/midtrans-webhook', async (req, res) => {
    console.log("--- WEBHOOK RECEIVED ---");
    try {
        const notification = req.body;
        console.log("Body:", JSON.stringify(notification));

        // Verifikasi status ke Midtrans
        const statusResponse = await snap.transaction.notification(notification);
        console.log("Midtrans Response:", statusResponse.transaction_status);

        // Respon cepat ke Midtrans agar tidak timeout
        res.status(200).send('OK');
    } catch (error) {
        // Ini akan muncul di Vercel Runtime Logs kamu
        console.error("DETAILED ERROR:", error.message);
        console.error("STACK TRACE:", error.stack);
        
        res.status(500).send("Internal Error");
    }
});


if (process.env.NODE_ENV !== 'production') global.prisma = prisma

module.exports = prisma
