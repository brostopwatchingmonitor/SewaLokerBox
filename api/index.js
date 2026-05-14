require('dotenv').config();
const express = require('express');
const midtransClient = require('midtrans-client');
const cors = require('cors');
const app = express();

// =============================================
// MIDTRANS CONFIGURATION
// =============================================
const MIDTRANS_IS_PRODUCTION = false; // Ganti true untuk production
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || 'Mid-client-3lC1WTewIIDGmaJx';

// Verifikasi konfigurasi
console.log('===========================================');
console.log('MIDTRANS CONFIGURATION');
console.log('===========================================');
console.log('Mode:', MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX');
console.log('Server Key:', MIDTRANS_SERVER_KEY ? '✓ Loaded' : '✗ MISSING');
console.log('Client Key:', MIDTRANS_CLIENT_KEY ? '✓ Loaded' : '✗ MISSING');
console.log('===========================================');

// Initialize Midtrans Snap
const snap = new midtransClient.Snap({
    isProduction: MIDTRANS_IS_PRODUCTION,
    serverKey: MIDTRANS_SERVER_KEY,
});

// =============================================
// CORS SETUP
// =============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// =============================================
// HELPER FUNCTION - Create Midtrans Token
// =============================================
async function createMidtransToken(orderId, grossAmount, itemDetails, customerDetails = {}) {
    try {
        // Parameter untuk Midtrans
        const parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: grossAmount
            },
            item_details: itemDetails,
            customer_details: {
                first_name: customerDetails.firstName || 'Customer',
                last_name: customerDetails.lastName || '',
                email: customerDetails.email || 'customer@example.com',
                phone: customerDetails.phone || '081234567890'
            },
            credit_card: {
                secure: true
            },
            callbacks: {
                finish: 'http://localhost:3000?status=success',
                error: 'http://localhost:3000?status=error',
                close: 'http://localhost:3000?status=close'
            }
        };

        console.log('Creating transaction with parameter:', JSON.stringify(parameter, null, 2));

        // Create transaction token
        const transaction = await snap.createTransaction(parameter);

        console.log('Transaction created successfully!');
        console.log('Token:', transaction.token);
        console.log('Redirect URL:', transaction.redirect_url);

        return {
            success: true,
            token: transaction.token,
            redirect_url: transaction.redirect_url
        };

    } catch (error) {
        console.error('Midtrans Token Creation Error:', error);
        console.error('Error Response:', error.response?.text || error.message);

        return {
            success: false,
            error: error.message || 'Failed to create transaction token'
        };
    }
}

// =============================================
// API ENDPOINTS
// =============================================

// 1. Get Client Key (untuk frontend)
app.get('/api/config', (req, res) => {
    res.json({
        clientKey: MIDTRANS_CLIENT_KEY,
        isProduction: MIDTRANS_IS_PRODUCTION
    });
});

// 2. Get Snap Token (Main Token Endpoint)
app.post('/api/get-snap-token', async (req, res) => {
    try {
        const {
            orderId,
            lockerSize,
            duration,
            price,
            customerName,
            customerEmail,
            customerPhone
        } = req.body;

        // Validasi input
        if (!orderId || !lockerSize || !price) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: orderId, lockerSize, price'
            });
        }

        // Format order ID
        const formattedOrderId = `LOKER-${orderId}-${Date.now()}`;

        // Item details
        const itemDetails = [{
            id: `LOKER-${lockerSize.toUpperCase()}`,
            price: parseInt(price),
            quantity: parseInt(duration) || 1,
            name: `Sewa Loker ${lockerSize} (${duration || 1}x)`
        }];

        // Customer details
        const customerDetails = {
            firstName: customerName || 'Pelanggan',
            lastName: '',
            email: customerEmail || 'customer@example.com',
            phone: customerPhone || '081234567890'
        };

        // Hitung total
        const grossAmount = parseInt(price) * (parseInt(duration) || 1);

        console.log('\n=== CREATING SNAP TOKEN ===');
        console.log('Order ID:', formattedOrderId);
        console.log('Gross Amount:', grossAmount);
        console.log('===========================\n');

        // Create token
        const result = await createMidtransToken(
            formattedOrderId,
            grossAmount,
            itemDetails,
            customerDetails
        );

        if (result.success) {
            res.json({
                success: true,
                token: result.token,
                redirect_url: result.redirect_url,
                orderId: formattedOrderId
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Deprecated - Keep for backward compatibility
app.post('/api/tokenizer', async (req, res) => {
    try {
        const { id, productName, price, quantity } = req.body;

        const orderId = `LOKER-${id}-${Date.now()}`;
        const grossAmount = parseInt(price) * parseInt(quantity);

        const itemDetails = [{
            id: id,
            price: parseInt(price),
            quantity: parseInt(quantity),
            name: productName
        }];

        const result = await createMidtransToken(orderId, grossAmount, itemDetails);

        if (result.success) {
            res.status(200).json({ token: result.token });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error("Tokenizer Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. Webhook Handler (WAJIB untuk production)
app.post('/api/webhook', async (req, res) => {
    try {
        const notification = req.body;
        console.log('Webhook received:', JSON.stringify(notification, null, 2));

        // Verify notification with Midtrans
        const statusResponse = await snap.transaction.notification(notification);

        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Transaction Status: ${orderId} - ${transactionStatus}`);

        // Handle transaction status
        let message = '';

        if (transactionStatus === 'capture') {
            if (fraudStatus === 'challenge') {
                message = 'Transaction challenged by FDS';
            } else if (fraudStatus === 'accept') {
                message = 'Transaction approved';
            }
        } else if (transactionStatus === 'settlement') {
            message = 'Payment settled successfully';
            console.log(`Payment confirmed for order: ${orderId}`);
        } else if (transactionStatus === 'deny') {
            message = 'Transaction denied';
        } else if (transactionStatus === 'cancel' || transactionStatus === 'expire') {
            message = 'Transaction cancelled/expired';
        } else if (transactionStatus === 'pending') {
            message = 'Waiting for payment';
        }

        res.status(200).json({
            success: true,
            message: message,
            orderId: orderId,
            status: transactionStatus
        });

    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 4. Check Transaction Status
app.get('/api/transaction/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const status = await snap.transaction.status(orderId);

        res.json({
            success: true,
            orderId: status.order_id,
            transactionStatus: status.transaction_status,
            grossAmount: status.gross_amount
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 5. NFC Tap Endpoint
app.post('/api/tap', async (req, res) => {
    const { nfc_uid } = req.body;
    console.log('NFC Tap received for UID:', nfc_uid);

    // Log the tap - in production, this would integrate with your hardware
    res.json({
        success: true,
        status: "TAP_RECORDED",
        message: "NFC tap recorded successfully",
        nfc_uid: nfc_uid
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Smart Locker API Running',
        timestamp: new Date().toISOString(),
        midtrans: {
            mode: MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX',
            configured: !!MIDTRANS_SERVER_KEY
        }
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <h1>Smart Locker API</h1>
        <p>Status: ✓ Running</p>
        <p>Midtrans Mode: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}</p>
        <br>
        <h3>Available Endpoints:</h3>
        <ul>
            <li>GET /api/health - Health check</li>
            <li>GET /api/config - Get Midtrans client key</li>
            <li>POST /api/get-snap-token - Create payment token</li>
            <li>POST /api/webhook - Midtrans webhook</li>
            <li>GET /api/transaction/:orderId - Check transaction status</li>
            <li>POST /api/tap - NFC tap</li>
        </ul>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Midtrans Mode: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}\n`);
});

module.exports = app;